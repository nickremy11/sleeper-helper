// ── MyFantasyLeague (MFL) ─────────────────────────────────────────────────────
// Connecting an MFL account and serving MFL leagues in Sleeper's shapes.
//
//   POST   /api/mfl/connect        {username, password} → logs in to MFL, stores the
//                                   login cookie (sealed), discovers leagues. The
//                                   password is passed to MFL once and never stored.
//   POST   /api/mfl/discover       re-read the account's leagues with the stored cookie
//   GET    /api/mfl/settings       {connected, username, leagues, hidden}
//   POST   /api/mfl/settings       {hidden: [leagueKey]} — leagues switched off
//   POST   /api/mfl/add            {league_id, year?, franchise_id?} — add a league by id
//                                   (public leagues work with no MFL account)
//   DELETE /api/mfl/settings       disconnect (forgets the cookie and the leagues)
//   GET    /api/mfl/leagues        this user's MFL leagues as Sleeper league objects
//   GET    /api/mfl/league/mfl_{year}_{id}[/rosters|users|matchups/{w}|traded_picks|
//                                   drafts|winners_bracket|losers_bracket]
//   GET    /api/mfl/draft/mfl_{year}_{id}[/picks|/traded_picks]
//
// The pages call these through their normal Sleeper reader: any /league/mfl_… path
// is sent here instead of to Sleeper (see shared-core.js). `?me=` names the caller's
// Sleeper user id, which the caller's own franchise is given as its owner id.
//
// MFL's rules (api_info): no calls from browser JavaScript on other sites (so all of
// it runs here), cache what doesn't change, space requests, don't retry a 429.
// Limits are per IP and every user shares this Worker's IPs, so everything is
// KV-cached per league. Private leagues are read with the cookie of a member, and
// what a cookie read returns is cached under its own key that only members read.

import { getAuthUser, sealSecret, openSecret } from './auth.js';
import { getCors } from './http.js';
import { getPlayerIdx, mflUserAgent, mflSeasonYear } from './player-ids.js';
import {
  arr, mflLeague, mflUsers, mflRosters, mflMatchups, mflLineups, mflTradedPicks, mflDraft, mflDraftPicks,
  mflWinnersBracket, mflHistoryIds, mflStartersToSlots, mainBracket, mflTrades, mflSeasonKeys,
} from './mfl-shape.js';

const API_HOST = 'https://api.myfantasyleague.com';
const TTL = {
  transactions: 1800, transactionsPast: 30 * 86400,
  league: 6 * 3600, rules: 6 * 3600, playoffBrackets: 6 * 3600, playoffBracket: 600, futureDraftPicks: 1800,
  rosters: 600, leagueStandings: 600, schedule: 3600, weeklyResults: 300, weeklyResultsPast: 7 * 86400,
  liveScoring: 60, draftResults: 600, draftResultsPast: 7 * 86400, status: 600, myleagues: 3600, players: 86400,
};

const json = (request, body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...getCors(request), 'Content-Type': 'application/json;charset=UTF-8', ...extra } });

export class MflError extends Error {
  constructor(msg, status = 502) { super(msg); this.status = status; }
}

// ── Raw MFL fetch ─────────────────────────────────────────────────────────────
// Redirects are followed by hand so the cookie is never sent anywhere but MFL.
async function mflFetch(env, url, { cookie, method = 'GET', body } = {}) {
  let u = url;
  for (let hop = 0; hop < 4; hop++) {
    const headers = { 'User-Agent': mflUserAgent(env), Accept: 'application/json' };
    if (cookie) headers.Cookie = `MFL_USER_ID=${encodeURIComponent(cookie)}`;
    if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
    const r = await fetch(u, { method, headers, body, redirect: 'manual' });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('Location');
      if (!loc) throw new MflError('MFL redirect without a location');
      const next = new URL(loc, u);
      if (!/(^|\.)myfantasyleague\.com$/.test(next.hostname)) throw new MflError('MFL redirected off-site');
      u = next.toString();
      continue;
    }
    if (r.status === 429) throw new MflError('MFL is rate-limiting us — try again in a minute', 429);
    if (!r.ok) throw new MflError(`MFL ${r.status}`);
    return { res: r, url: u };
  }
  throw new MflError('Too many MFL redirects');
}

async function mflExportRaw(env, { host, year, type, params = {}, cookie }) {
  const q = new URLSearchParams({ TYPE: type, ...params, JSON: '1' });
  const { res } = await mflFetch(env, `${host || API_HOST}/${year}/export?${q}`, { cookie });
  const text = await res.text();
  let d;
  try { d = JSON.parse(text); } catch { throw new MflError(`MFL ${type}: not JSON`); }
  if (d?.error) {
    const msg = String(d.error.$t || d.error || 'error');
    throw new MflError(`MFL ${type}: ${msg}`, /private|not allowed|permission|login/i.test(msg) ? 403 : 502);
  }
  return d;
}

// ── League context + cached exports ──────────────────────────────────────────
// A league id in this app: mfl_{year}_{mflId}.
export function parseMflKey(key) {
  const m = String(key || '').match(/^mfl_(\d{4})_(\d+)$/);
  return m ? { year: +m[1], lid: m[2] } : null;
}

async function userRow(env, user) {
  if (!user) return null;
  return env.DB.prepare('SELECT username, cookie, leagues, hidden FROM mfl_settings WHERE user_id = ?')
    .bind(user.user_id).first().catch(() => null);
}

// The caller's Sleeper user id, so the caller's franchise can carry it as owner_id
// and every page's "my roster" test (owner_id === my Sleeper id) just works.
async function sleeperIdFor(env, user) {
  const u = String(user?.sleeper_username || '').trim().toLowerCase();
  if (!u) return null;
  const k = `mfl:slid:${u}`;
  const hit = await env.SLEEPER_KV.get(k).catch(() => null);
  if (hit) return hit;
  const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(u)}`).catch(() => null);
  const id = r?.ok ? (await r.json().catch(() => null))?.user_id : null;
  if (id) await env.SLEEPER_KV.put(k, String(id), { expirationTtl: 30 * 86400 });
  return id || null;
}

async function leagueCtx(env, request, key) {
  const user = await getAuthUser(request, env).catch(() => null);
  return leagueCtxFor(env, user, key);
}

// `anyLeague`: use the user's cookie for any league, not only ones on their saved
// list — the Record Book reads every past season of a league (each with its own
// MFL id) with the opener's cookie, and MFL itself decides what that cookie sees.
async function leagueCtxFor(env, user, key, { anyLeague = false } = {}) {
  const k = parseMflKey(key);
  if (!k) throw new MflError('Bad MFL league id', 400);
  const row = await userRow(env, user);
  const leagues = row ? JSON.parse(row.leagues || '[]') : [];
  const entry = leagues.find(l => String(l.id) === k.lid && +l.year === k.year)
             || leagues.find(l => String(l.id) === k.lid);
  const cookie = (entry || anyLeague) && row?.cookie ? await openSecret(row.cookie, env).catch(() => '') : '';
  const host = entry?.host || (await env.SLEEPER_KV.get(`mfl:host:${k.year}:${k.lid}`)) || null;
  return { ...k, key, cookie: cookie || null, member: !!cookie, mine: anyLeague ? null : entry?.franchise_id || null, host, user };
}

// One export, KV-cached. Cookie reads and open reads never share a cache entry.
async function cachedExport(env, ctx, type, params = {}, ttl) {
  const pstr = Object.entries(params).map(([a, b]) => `${a}=${b}`).join('&');
  const kvKey = `mfl:v1:${ctx.year}:${ctx.lid}:${type}:${pstr}:${ctx.member ? 'p' : 'o'}`;
  const hit = await env.SLEEPER_KV.get(kvKey, 'json').catch(() => null);
  if (hit) return hit;
  let d;
  try {
    d = await mflExportRaw(env, { host: ctx.host, year: ctx.year, type, params: { L: ctx.lid, ...params }, cookie: ctx.cookie });
  } catch (e) {
    // A stored host can go stale (MFL moves leagues); the api host redirects.
    if (ctx.host && e.status !== 403 && e.status !== 429) {
      ctx.host = null;
      d = await mflExportRaw(env, { year: ctx.year, type, params: { L: ctx.lid, ...params }, cookie: ctx.cookie });
    } else throw e;
  }
  await env.SLEEPER_KV.put(kvKey, JSON.stringify(d), { expirationTtl: Math.max(60, ttl || 600) });
  if (type === 'league' && d?.league?.baseURL) {
    const host = String(d.league.baseURL).replace(/\/$/, '');
    ctx.host = host;
    await env.SLEEPER_KV.put(`mfl:host:${ctx.year}:${ctx.lid}`, host, { expirationTtl: 7 * 86400 });
  }
  return d;
}

async function mflStatus(env, year) {
  const k = `mfl:status:${year}`;
  const hit = await env.SLEEPER_KV.get(k, 'json').catch(() => null);
  if (hit) return hit;
  const { res } = await mflFetch(env, `${API_HOST}/fflnetdynamic${year}/mfl_status.json`);
  const d = (await res.json())?.mfl_status || {};
  await env.SLEEPER_KV.put(k, JSON.stringify(d), { expirationTtl: TTL.status });
  return d;
}

let _idxMemo = null;
async function playerIdx(env) {
  const snap = await getPlayerIdx(env);
  if (_idxMemo?.built === snap.built) return _idxMemo;
  const posBySid = {};
  for (const [mid, pos] of Object.entries(snap.mpos || {})) posBySid[snap.mfl?.[mid] || `mfl_${mid}`] = pos;
  _idxMemo = { built: snap.built, mfl: snap.mfl || {}, posBySid };
  return _idxMemo;
}

// The current season's pieces every resource needs.
async function leagueBase(env, ctx) {
  const status = await mflStatus(env, mflSeasonYear()).catch(() => ({}));
  // A finished season doesn't change. `lite` (the Record Book's past seasons) skips
  // what its pages never read — scoring rules and the future-pick list — so a
  // league's 20-odd past seasons cost MFL two fewer reads each.
  const done = pastYear(ctx);
  const skip = ctx.lite && done;
  const [league, rules, brackets, futurePicks] = await Promise.all([
    cachedExport(env, ctx, 'league', {}, done ? TTL.weeklyResultsPast : TTL.league),
    skip ? null : cachedExport(env, ctx, 'rules', {}, done ? TTL.weeklyResultsPast : TTL.rules),
    cachedExport(env, ctx, 'playoffBrackets', {}, done ? TTL.weeklyResultsPast : TTL.playoffBrackets).catch(() => null),
    skip ? null : cachedExport(env, ctx, 'futureDraftPicks', {}, TTL.futureDraftPicks).catch(() => null),
  ]);
  const hist = mflHistoryIds(league);
  const lg = mflLeague({ year: ctx.year, lid: ctx.lid, league, rules, brackets, futurePicks, status, prevId: hist[ctx.year - 1] || null });
  return { status, league, rules, brackets, futurePicks, lg };
}

const pastYear = ctx => ctx.year < mflSeasonYear();

async function resource(env, ctx, res, arg, me) {
  const idx = await playerIdx(env);
  const base = await leagueBase(env, ctx);
  const { lg, league, status } = base;
  const rp = lg.roster_positions;
  if (!res) return lg;

  if (res === 'users') return mflUsers({ lid: ctx.lid, league, mine: ctx.mine, me });

  if (res === 'rosters') {
    // `starters` = the lineup set for the week about to be played (MFL's LineupWeek),
    // else the one being played now — before anyone sets next week's, that's still
    // what each team is starting.
    const lineupWeek = parseInt(status?.weeks?.LineupWeek, 10) || 1;
    const liveWeek = parseInt(status?.weeks?.LiveScoringWeek, 10) || lineupWeek;
    const inSeason = !pastYear(ctx) && lg.status !== 'complete';
    const lineupFor = async w => {
      const wr = await cachedExport(env, ctx, 'weeklyResults', { W: String(w) }, TTL.weeklyResults).catch(() => null);
      const lu = wr ? mflLineups(wr) : {};
      return Object.values(lu).some(a => a.length) ? lu : null;
    };
    const [rosters, standings, lineup] = await Promise.all([
      cachedExport(env, ctx, 'rosters', {}, pastYear(ctx) ? TTL.weeklyResultsPast : TTL.rosters),
      cachedExport(env, ctx, 'leagueStandings', { ALL: '1' }, pastYear(ctx) ? TTL.weeklyResultsPast : TTL.leagueStandings),
      inSeason ? lineupFor(lineupWeek).then(l => l || (liveWeek !== lineupWeek ? lineupFor(liveWeek) : null)) : null,
    ]);
    return mflRosters({ lid: ctx.lid, idx, league, rosters, standings, lineup,
                        rosterPositions: rp, mine: ctx.mine, me });
  }

  if (res === 'matchups') {
    const w = parseInt(arg, 10);
    if (!(w >= 1 && w <= 22)) throw new MflError('Invalid week', 400);
    // MFL answers a week past the season's end with its last week — no such week.
    if (w > (parseInt(league?.league?.endWeek, 10) || 17)) return [];
    const done = parseInt(status?.weeks?.CompletedWeek, 10) || 0;
    const past = pastYear(ctx) || w <= done;
    if (past) {
      const results = await cachedExport(env, ctx, 'weeklyResults', { W: String(w) }, TTL.weeklyResultsPast);
      return mflMatchups({ idx, results, rosterPositions: rp });
    }
    const live = await cachedExport(env, ctx, 'liveScoring', { W: String(w), DETAILS: '1' }, TTL.liveScoring);
    return mflMatchups({ idx, live, rosterPositions: rp });
  }

  if (res === 'traded_picks') return mflTradedPicks(base.futurePicks);

  if (res === 'drafts') {
    const dr = await cachedExport(env, ctx, 'draftResults', {}, pastYear(ctx) ? TTL.draftResultsPast : TTL.draftResults).catch(() => null);
    const d = mflDraft({ year: ctx.year, lid: ctx.lid, draftResults: dr, nTeams: lg.total_rosters });
    return d ? [d] : [];
  }

  if (res === 'winners_bracket' || res === 'losers_bracket') {
    if (res === 'losers_bracket') return [];
    const b = mainBracket(base.brackets);
    if (!b) return [];
    const br = await cachedExport(env, ctx, 'playoffBracket', { BRACKET_ID: String(b.id) },
                                  pastYear(ctx) ? TTL.weeklyResultsPast : TTL.playoffBracket);
    return mflWinnersBracket(br);
  }

  throw new MflError('Unknown resource', 404);
}

async function draftResource(env, ctx, res) {
  const idx = await playerIdx(env);
  const dr = await cachedExport(env, ctx, 'draftResults', {}, pastYear(ctx) ? TTL.draftResultsPast : TTL.draftResults);
  if (!res) {
    const base = await leagueBase(env, ctx);
    return mflDraft({ year: ctx.year, lid: ctx.lid, draftResults: dr, nTeams: base.lg.total_rosters });
  }
  if (res === 'picks') {
    // MFL's own names only when a pick isn't in the crosswalk (old seasons) — the
    // player list is MFL's heaviest export.
    const unmatched = arr(arr(dr?.draftResults?.draftUnit)[0]?.draftPick).some(p => p.player && !idx.mfl[p.player]);
    const mplayers = unmatched
      ? await mflPlayerNames(env, ctx.year).catch(e => { if (ctx.lite) throw e; return {}; })   // Record Book: don't archive nameless
      : {};
    return mflDraftPicks({ idx, draftResults: dr, mplayers });
  }
  if (res === 'traded_picks') return [];
  throw new MflError('Unknown resource', 404);
}

// MFL's own player names (for picks of players Sleeper doesn't carry).
async function mflPlayerNames(env, year) {
  const k = `mfl:players:${year}`;
  const hit = await env.SLEEPER_KV.get(k, 'json').catch(() => null);
  if (hit) return hit;
  const d = await mflExportRaw(env, { year, type: 'players' });
  const out = {};
  for (const p of arr(d?.players?.player)) out[p.id] = { name: p.name, position: p.position, team: p.team };
  await env.SLEEPER_KV.put(k, JSON.stringify(out), { expirationTtl: TTL.players });
  return out;
}

// ── Account: connect / discover / settings ────────────────────────────────────
async function mflLogin(env, username, password, year) {
  const body = new URLSearchParams({ USERNAME: username, PASSWORD: password, XML: '1' }).toString();
  const { res } = await mflFetch(env, `${API_HOST}/${year}/login`, { method: 'POST', body });
  const text = await res.text();
  const m = text.match(/MFL_USER_ID="([^"]+)"/);
  if (!m) {
    const err = text.match(/<error[^>]*>([^<]*)</i);
    throw new MflError(err ? `MFL: ${err[1].trim()}` : 'MFL didn\'t accept that username and password', 401);
  }
  return m[1];
}

async function discover(env, cookie, years) {
  const out = [];
  for (const year of years) {
    const d = await mflExportRaw(env, { year, type: 'myleagues', params: { YEAR: String(year), FRANCHISE_NAMES: '1' }, cookie })
      .catch(e => { if (e.status === 429) throw e; return null; });
    for (const l of arr(d?.leagues?.league)) {
      const host = String(l.url || '').match(/^(https?:\/\/[^/]+)/)?.[1] || null;
      out.push({ id: String(l.league_id), year, name: String(l.name || ''), franchise_id: l.franchise_id || null,
                 franchise_name: l.franchise_name ? String(l.franchise_name) : null, host });
      if (host) await env.SLEEPER_KV.put(`mfl:host:${year}:${l.league_id}`, host, { expirationTtl: 7 * 86400 });
    }
  }
  return out;
}

function mergeLeagues(found, prev) {
  // Hand-added leagues (no cookie behind them) survive a re-discovery.
  const keyOf = l => `${l.year}_${l.id}`;
  const m = new Map(found.map(l => [keyOf(l), l]));
  for (const l of prev) if (l.manual && !m.has(keyOf(l))) m.set(keyOf(l), l);
  return [...m.values()];
}

async function saveRow(env, userId, patch) {
  const cur = await env.DB.prepare('SELECT username, cookie, leagues, hidden FROM mfl_settings WHERE user_id = ?').bind(userId).first();
  const next = { username: null, cookie: null, leagues: '[]', hidden: '[]', ...(cur || {}), ...patch };
  await env.DB.prepare(
    `INSERT INTO mfl_settings (user_id, username, cookie, leagues, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, cookie=excluded.cookie, leagues=excluded.leagues,
       hidden=excluded.hidden, updated_at=excluded.updated_at`
  ).bind(userId, next.username, next.cookie, next.leagues, next.hidden, Date.now()).run();
  return next;
}

const publicSettings = row => ({
  connected: !!row?.cookie, username: row?.username || null,
  leagues: row ? JSON.parse(row.leagues || '[]') : [], hidden: row ? JSON.parse(row.hidden || '[]') : [],
});

// ── Router ────────────────────────────────────────────────────────────────────
export async function handleMfl(request, env, url) {
  const p = url.pathname.replace(/^\/api\/mfl/, '');
  try {
    // League data: open to anyone for public leagues, members for private ones.
    let m = p.match(/^\/league\/(mfl_\d{4}_\d+)(?:\/([a-z_]+)(?:\/(\d+))?)?$/);
    if (m && request.method === 'GET') {
      const ctx = await leagueCtx(env, request, m[1]);
      const me = url.searchParams.get('me') || (await sleeperIdFor(env, ctx.user)) || 'me';
      return json(request, await resource(env, ctx, m[2] || null, m[3], me), 200, { 'Cache-Control': 'private, max-age=30' });
    }
    m = p.match(/^\/draft\/(mfl_\d{4}_\d+)(?:\/([a-z_]+))?$/);
    if (m && request.method === 'GET') {
      const ctx = await leagueCtx(env, request, m[1]);
      return json(request, await draftResource(env, ctx, m[2] || null), 200, { 'Cache-Control': 'private, max-age=30' });
    }

    const user = await getAuthUser(request, env).catch(() => null);
    if (!user) return json(request, { error: 'Not authenticated' }, 401);

    if (p === '/connect' && request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const username = String(b.username || '').trim(), password = String(b.password || '');
      if (!username || !password) return json(request, { error: 'Enter your MFL username and password' }, 400);
      const year = mflSeasonYear();
      const cookie = await mflLogin(env, username, password, year);
      const found = await discover(env, cookie, [year]);
      const cur = await userRow(env, user);
      const leagues = mergeLeagues(found, cur ? JSON.parse(cur.leagues || '[]') : []);
      const row = await saveRow(env, user.user_id, { username, cookie: await sealSecret(cookie, env), leagues: JSON.stringify(leagues) });
      return json(request, publicSettings(row));
    }

    if (p === '/discover' && request.method === 'POST') {
      const cur = await userRow(env, user);
      if (!cur?.cookie) return json(request, { error: 'MFL isn\'t connected' }, 400);
      const cookie = await openSecret(cur.cookie, env);
      const b = await request.json().catch(() => ({}));
      const years = Array.isArray(b.years) && b.years.length ? b.years.map(Number).filter(y => y >= 2000 && y <= 2100).slice(0, 12)
                  : [mflSeasonYear()];
      const found = await discover(env, cookie, years);
      if (!found.length && years.length === 1) {
        // An expired cookie reads as "no leagues" — say so instead of wiping the list.
        return json(request, { error: 'MFL returned no leagues — reconnect with your MFL password', ...publicSettings(cur) }, 409);
      }
      const keep = JSON.parse(cur.leagues || '[]').filter(l => !years.includes(+l.year) || l.manual);
      const row = await saveRow(env, user.user_id, { leagues: JSON.stringify(mergeLeagues([...found, ...keep], keep)) });
      return json(request, publicSettings(row));
    }

    if (p === '/add' && request.method === 'POST') {
      const b = await request.json().catch(() => ({}));
      const id = String(b.league_id || '').replace(/\D/g, '');
      const year = parseInt(b.year, 10) || mflSeasonYear();
      if (!id) return json(request, { error: 'Enter an MFL league id' }, 400);
      // Must be readable — public, or one this account's cookie can see.
      const ctx = await leagueCtx(env, request, `mfl_${year}_${id}`);
      const d = await cachedExport(env, ctx, 'league', {}, TTL.league).catch(e => {
        if (e.status === 429) throw e;
        throw new MflError(`Couldn't read MFL league ${id} for ${year} — check the id, or connect your MFL account if the league is private`, 404);
      });
      const fids = arr(d?.league?.franchises?.franchise).map(f => f.id);
      const fid = b.franchise_id ? String(b.franchise_id).padStart(4, '0') : null;
      if (fid && !fids.includes(fid)) return json(request, { error: `No franchise ${fid} in that league` }, 400);
      const cur = await userRow(env, user);
      const list = cur ? JSON.parse(cur.leagues || '[]') : [];
      const next = list.filter(l => !(String(l.id) === id && +l.year === year));
      next.push({ id, year, name: String(d.league.name || ''), franchise_id: fid, franchise_name: null,
                  host: ctx.host, manual: true });
      const row = await saveRow(env, user.user_id, { leagues: JSON.stringify(next) });
      return json(request, publicSettings(row));
    }

    if (p === '/settings') {
      if (request.method === 'GET') return json(request, publicSettings(await userRow(env, user)));
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const patch = {};
        if (Array.isArray(b.hidden)) patch.hidden = JSON.stringify(b.hidden.map(String).slice(0, 500));
        if (Array.isArray(b.remove)) {
          const cur = await userRow(env, user);
          const drop = new Set(b.remove.map(String));
          patch.leagues = JSON.stringify(JSON.parse(cur?.leagues || '[]').filter(l => !drop.has(`${l.year}_${l.id}`)));
        }
        return json(request, publicSettings(await saveRow(env, user.user_id, patch)));
      }
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM mfl_settings WHERE user_id = ?').bind(user.user_id).run();
        return json(request, publicSettings(null));
      }
    }

    // This user's MFL leagues as Sleeper league objects (the season's list).
    if (p === '/leagues' && request.method === 'GET') {
      const year = parseInt(url.searchParams.get('season'), 10) || mflSeasonYear();
      const me = url.searchParams.get('me') || (await sleeperIdFor(env, user)) || 'me';
      const cur = await userRow(env, user);
      const hidden = new Set(cur ? JSON.parse(cur.hidden || '[]') : []);
      const list = (cur ? JSON.parse(cur.leagues || '[]') : []).filter(l => +l.year === year && !hidden.has(`${l.year}_${l.id}`));
      const out = [], errors = [];
      // Two at a time: MFL asks for spacing, and a cold list is ~4 reads a league.
      let stop = false;
      const one = async l => {
        if (stop) return;
        try {
          const ctx = await leagueCtx(env, request, `mfl_${l.year}_${l.id}`);
          const lg = await resource(env, ctx, null, null, me);
          out.push({ ...lg, _mfl: { ...lg._mfl, franchise_id: l.franchise_id || null, franchise_name: l.franchise_name || null } });
        } catch (e) {
          errors.push({ id: l.id, year: l.year, name: l.name, error: e.message });
          if (e.status === 429) stop = true;
        }
      };
      for (let i = 0; i < list.length; i += 2) await Promise.all(list.slice(i, i + 2).map(one));
      const order = new Map(list.map((l, i) => [`mfl_${l.year}_${l.id}`, i]));
      out.sort((a, b) => order.get(a.league_id) - order.get(b.league_id));
      return json(request, { leagues: out, errors });
    }

    return json(request, { error: 'Not found' }, 404);
  } catch (e) {
    const status = e instanceof MflError ? e.status : 500;
    if (status >= 500) console.error('[mfl]', url.pathname, e.message);
    return json(request, { error: e.message }, status);
  }
}

// /api/sleeper/{league|draft}/mfl_… — the pages' normal Sleeper reader, pointed at
// an MFL league. Same handler, so a page needs no MFL-specific URL.
export const isMflSleeperPath = pathname => /^\/api\/sleeper\/(league|draft)\/mfl_\d{4}_\d+(\/|$)/.test(pathname);
export function handleMflViaSleeper(request, env, url) {
  const u = new URL(url);
  u.pathname = url.pathname.replace(/^\/api\/sleeper\//, '/api/mfl/');
  return handleMfl(request, env, u);
}

export { mflStartersToSlots };

// ── The Record Book (PlatformLeagues entrypoint, src/platform-leagues.js) ─────
// Reads a league as `user` (the account that opened it in the Record Book), with
// no "my team" — every owner is mfl:{leagueId}:{franchiseId}.
//   op 'league'  → resource(res, arg)        op 'draft' → draftResource(res)
//   op 'trades'  → Sleeper trade transactions op 'seasons' → {seasons, name, key}
// `key` may be mfl_{year}_{id} or, for 'seasons', a bare mfl_{id}: the newest
// season the user's saved list has it in, else this season or last (public).
export async function mflForRecordBook(env, user, op, key, res, arg) {
  if (op === 'seasons') {
    let full = parseMflKey(key) ? key : null;
    if (!full) {
      const lid = (String(key).match(/^mfl_(\d+)$/) || [])[1];
      if (!lid) throw new MflError('Bad MFL league id', 400);
      const row = await userRow(env, user);
      const mine = (row ? JSON.parse(row.leagues || '[]') : []).filter(l => String(l.id) === lid).sort((a, b) => b.year - a.year)[0];
      const years = mine ? [+mine.year] : [mflSeasonYear(), mflSeasonYear() - 1];
      for (const y of years) {
        const ctx = await leagueCtxFor(env, user, `mfl_${y}_${lid}`, { anyLeague: true });
        const ok = await cachedExport(env, ctx, 'league', {}, TTL.league).then(d => !!d?.league?.franchises).catch(e => {
          if (e.status === 429) throw e;
          return false;
        });
        if (ok) { full = `mfl_${y}_${lid}`; break; }
      }
      if (!full) throw new MflError('MFL has no league with that id this season or last — or it is private and your MFL account isn’t connected', 404);
    }
    const ctx = await leagueCtxFor(env, user, full, { anyLeague: true });
    const base = await leagueBase(env, ctx);
    return { key: full, seasons: mflSeasonKeys(base.league, ctx.year, ctx.lid), league: base.lg, member: ctx.member };
  }
  const ctx = await leagueCtxFor(env, user, key, { anyLeague: true });
  ctx.lite = true;
  if (op === 'league') return resource(env, ctx, res || null, arg, null);
  if (op === 'draft') return draftResource(env, ctx, res || null);
  if (op === 'trades') {
    const [idx, tx, dr] = await Promise.all([
      playerIdx(env),
      cachedExport(env, ctx, 'transactions', { TRANS_TYPE: 'TRADE' }, pastYear(ctx) ? TTL.transactionsPast : TTL.transactions),
      cachedExport(env, ctx, 'draftResults', {}, pastYear(ctx) ? TTL.draftResultsPast : TTL.draftResults).catch(() => null),
    ]);
    const draft = mflDraft({ year: ctx.year, lid: ctx.lid, draftResults: dr, nTeams: 0 });
    const shape = { slotToRoster: draft?.slot_to_roster_id || null, snake: draft?.type === 'snake', teams: draft?.settings?.teams || 0 };
    const trades = mflTrades({ idx, transactions: tx, year: ctx.year, ...shape });
    // Names for players the crosswalk doesn't carry (old seasons, mostly) — one
    // player list per season, only when a trade needs it.
    const unnamed = trades.some(t => Object.values(t._players || {}).some(p => /^Player #/.test(p.full_name)));
    if (!unnamed) return trades;
    // A throttled name list fails the read rather than answering with "Player #…":
    // the Record Book archives a past season's answer for good.
    const mplayers = await mflPlayerNames(env, ctx.year);
    return mflTrades({ idx, transactions: tx, year: ctx.year, ...shape, mplayers });
  }
  throw new MflError('Unknown operation', 404);
}
