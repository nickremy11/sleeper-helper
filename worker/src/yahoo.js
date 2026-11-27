// ── Yahoo Fantasy ─────────────────────────────────────────────────────────────
// Connecting a Yahoo account and serving Yahoo leagues in Sleeper's shapes.
// READ-ONLY: Yahoo grants read access only ("Write access is not available at
// this time" — sports.yahoo.com/developer/access, 2026-11-26).
//
//   GET  ffhistorian.com/auth/yahoo/start?next=   → Yahoo's consent screen (signed-in users)
//   GET  ffhistorian.com/auth/yahoo/callback      → stores the refresh token, finds leagues
//   GET  /api/yahoo/settings     {available, connected, leagues, hidden}
//   POST /api/yahoo/settings     {hidden: [key]} · DELETE disconnects
//   POST /api/yahoo/discover     re-read this account's leagues (and teams)
//   GET  /api/yahoo/leagues      this user's Yahoo leagues for a season, as Sleeper league objects
//   GET  /api/sleeper/league/yh_{season}_{id}[/rosters|users|matchups/{w}|traded_picks|drafts|winners_bracket|losers_bracket]
//   GET  /api/sleeper/draft/yh_{season}_{id}[/picks]
//
// Off until YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET are set (wrangler secret put).
// The Yahoo app's redirect URI must be https://ffhistorian.com/auth/yahoo/callback.
//
// Tokens: Yahoo access tokens last an hour; the refresh token is sealed in D1
// (yahoo_settings.refresh), access tokens are cached in KV until just before
// expiry. Every read of a league uses a MEMBER's token: Yahoo only lets a user
// read leagues they're in (or public ones), and this app only serves a league to
// a user whose saved list contains it. League data is KV-cached per league and
// shared between that league's members, so "which team is mine" is the caller's
// saved team id, never Yahoo's per-viewer is_owned_by_current_login flag.
//
// Attribution (Yahoo's API terms): any page showing Yahoo data says "Fantasy data
// provided by Yahoo Fantasy" and links to Yahoo Fantasy — see shYahooAttribution()
// in shared-core.js.

import { getAuthUser, randomHex, sealSecret, openSecret } from './auth.js';
import { getCors } from './http.js';
import { getYahooIdx } from './player-ids.js';
import { parseXml, arr } from './yahoo-xml.js';
import {
  YAHOO_NFL_GAME, leagueKeyOf, teamIdOf, yahooLeague, yahooUsers, yahooRosters, yahooMatchups,
  yahooDraft, yahooDraftPicks, yahooWinnersBracket, yahooUserLeagues,
} from './yahoo-shape.js';

const SITE = 'https://ffhistorian.com';
const CALLBACK = `${SITE}/auth/yahoo/callback`;
const AUTH_URL = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN_URL = 'https://api.login.yahoo.com/oauth2/get_token';
const API = 'https://fantasysports.yahooapis.com/fantasy/v2';
const STATE_TTL = 600;
const TTL = { league: 6 * 3600, standings: 600, teams: 600, scoreboard: 300, scoreboardPast: 7 * 86400,
              roster: 300, rosterPast: 7 * 86400, draft: 600, draftPast: 7 * 86400, games: 30 * 86400 };
const ALLOWED_NEXT_HOSTS = new Set(['ffhistorian.com', 'helper.ffhistorian.com']);

export const yahooAvailable = env => !!(env.YAHOO_CLIENT_ID && env.YAHOO_CLIENT_SECRET);

export class YahooError extends Error {
  constructor(msg, status = 502) { super(msg); this.status = status; }
}
const json = (request, body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...getCors(request), 'Content-Type': 'application/json;charset=UTF-8', ...extra } });

const nflSeason = (d = new Date()) => (d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear());

// ── OAuth ─────────────────────────────────────────────────────────────────────
function safeNext(raw) {
  try {
    const u = new URL(raw || '/profile/#connections', SITE);
    if (u.protocol === 'https:' && ALLOWED_NEXT_HOSTS.has(u.hostname)) return u.toString();
  } catch {}
  return `${SITE}/profile/#connections`;
}
function bounce(target, note) {
  const t = JSON.stringify(target);
  return new Response(`<!doctype html><meta charset="utf-8"><title>Yahoo</title>
<body style="font-family:Georgia,serif;background:#f3e9d2;color:#1f3d22;padding:40px;text-align:center">
<p>${note || 'Connecting Yahoo…'}</p><p><a href=${t}>Continue</a></p><script>location.replace(${t})</script>`,
    { headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' } });
}
const withFlag = (next, k, v) => { const u = new URL(next); u.searchParams.set(k, v); return u.toString(); };
const basic = env => 'Basic ' + btoa(`${env.YAHOO_CLIENT_ID}:${env.YAHOO_CLIENT_SECRET}`);

async function tokenCall(env, params) {
  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: basic(env), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ redirect_uri: CALLBACK, ...params }).toString(),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) {
    const e = new YahooError(`Yahoo sign-in failed${d.error ? ` (${d.error})` : ''}`, d.error === 'invalid_grant' ? 401 : 502);
    e.code = d.error;
    throw e;
  }
  return d;
}

// The session cookie is SameSite=Strict, so the callback (a redirect from
// login.yahoo.com) arrives without it — the user id rides in the saved state.
async function yahooStart(request, env, url) {
  if (!yahooAvailable(env)) return new Response('Yahoo is not set up yet', { status: 404 });
  const next = safeNext(url.searchParams.get('next'));
  const user = await getAuthUser(request, env).catch(() => null);
  if (!user) return bounce(withFlag(next, 'yahoo', 'signin'), 'Sign in to FF Historian first.');
  const state = randomHex(24);
  await env.SLEEPER_KV.put(`yh_state_${state}`, JSON.stringify({ userId: user.user_id, next }), { expirationTtl: STATE_TTL });
  const u = new URL(AUTH_URL);
  u.search = new URLSearchParams({ client_id: env.YAHOO_CLIENT_ID, redirect_uri: CALLBACK, response_type: 'code', state,
                                   ...(env.YAHOO_SCOPE ? { scope: env.YAHOO_SCOPE } : {}) }).toString();
  return Response.redirect(u.toString(), 302);
}

async function yahooCallback(env, url) {
  const state = url.searchParams.get('state') || '';
  const saved = state ? await env.SLEEPER_KV.get(`yh_state_${state}`, 'json') : null;
  if (saved) await env.SLEEPER_KV.delete(`yh_state_${state}`);
  const next = safeNext(saved?.next);
  if (!saved) return bounce(withFlag(next, 'yahoo', 'expired'), 'That Yahoo sign-in expired — try again.');
  if (url.searchParams.get('error') || !url.searchParams.get('code')) return bounce(withFlag(next, 'yahoo', 'cancelled'), 'Yahoo wasn’t connected.');
  try {
    const tok = await tokenCall(env, { grant_type: 'authorization_code', code: url.searchParams.get('code') });
    await saveRow(env, saved.userId, { guid: tok.xoauth_yahoo_guid || null, refresh: await sealSecret(tok.refresh_token, env) });
    await putAccess(env, saved.userId, tok);
    const found = await discover(env, saved.userId, [nflSeason()]).catch(e => { console.error('[yahoo] discover', e.message); return null; });
    return bounce(withFlag(next, 'yahoo', found == null ? 'connected-nolist' : `connected-${found.length}`), 'Yahoo connected.');
  } catch (e) {
    console.error('[yahoo] callback', e.message);
    return bounce(withFlag(next, 'yahoo', 'failed'), 'Yahoo sign-in didn’t complete.');
  }
}

async function putAccess(env, userId, tok) {
  const ttl = Math.max(60, (parseInt(tok.expires_in, 10) || 3600) - 120);
  await env.SLEEPER_KV.put(`yh_at_${userId}`, await sealSecret(tok.access_token, env), { expirationTtl: ttl });
}

async function accessToken(env, userId) {
  const hit = await env.SLEEPER_KV.get(`yh_at_${userId}`).catch(() => null);
  if (hit) return openSecret(hit, env);
  const row = await getRow(env, userId);
  if (!row?.refresh) throw new YahooError('Yahoo isn’t connected', 401);
  try {
    const tok = await tokenCall(env, { grant_type: 'refresh_token', refresh_token: await openSecret(row.refresh, env) });
    if (tok.refresh_token) await saveRow(env, userId, { refresh: await sealSecret(tok.refresh_token, env) });
    await putAccess(env, userId, tok);
    return tok.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') {   // revoked at Yahoo, or expired after long disuse
      await saveRow(env, userId, { refresh: null });
      throw new YahooError('Yahoo needs you to connect again', 401);
    }
    throw e;
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────────
async function yget(env, userId, path, retried = false) {
  const token = await accessToken(env, userId);
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/xml' } });
  const text = await r.text();
  if (r.status === 401 && !retried) {
    await env.SLEEPER_KV.delete(`yh_at_${userId}`);
    return yget(env, userId, path, true);
  }
  if (r.status === 429 || r.status === 999) throw new YahooError('Yahoo is rate-limiting us — try again in a minute', 429);
  const doc = parseXml(text);
  if (!r.ok || doc.error) {
    const msg = doc.error?.description || `Yahoo ${r.status}`;
    throw new YahooError(`Yahoo: ${msg}`, r.status === 403 || r.status === 401 ? 403 : r.status === 404 ? 404 : 502);
  }
  return doc.fantasy_content || {};
}

// Cached per league; only ever served to that league's members (checked by caller).
async function cached(env, userId, kvKey, path, ttl) {
  const hit = await env.SLEEPER_KV.get(kvKey, 'json').catch(() => null);
  if (hit) return hit;
  const d = await yget(env, userId, path);
  await env.SLEEPER_KV.put(kvKey, JSON.stringify(d), { expirationTtl: Math.max(60, ttl) });
  return d;
}

async function gameIdFor(env, userId, season) {
  if (YAHOO_NFL_GAME[season]) return String(YAHOO_NFL_GAME[season]);
  const k = `yh_game_${season}`;
  const hit = await env.SLEEPER_KV.get(k).catch(() => null);
  if (hit) return hit;
  const d = await yget(env, userId, `/games;game_codes=nfl;seasons=${season}`);
  const id = String(arr(d.games?.game)[0]?.game_id || '');
  if (!id) throw new YahooError(`No Yahoo NFL game for ${season}`, 404);
  await env.SLEEPER_KV.put(k, id, { expirationTtl: TTL.games });
  return id;
}
const gameToSeason = () => Object.fromEntries(Object.entries(YAHOO_NFL_GAME).map(([s, g]) => [String(g), +s]));

// ── Account rows ──────────────────────────────────────────────────────────────
async function getRow(env, userId) {
  return env.DB.prepare('SELECT guid, refresh, leagues, hidden FROM yahoo_settings WHERE user_id = ?').bind(userId).first().catch(() => null);
}
async function saveRow(env, userId, patch) {
  const cur = await getRow(env, userId);
  const next = { guid: null, refresh: null, leagues: '[]', hidden: '[]', ...(cur || {}), ...patch };
  await env.DB.prepare(
    `INSERT INTO yahoo_settings (user_id, guid, refresh, leagues, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET guid=excluded.guid, refresh=excluded.refresh, leagues=excluded.leagues,
       hidden=excluded.hidden, updated_at=excluded.updated_at`
  ).bind(userId, next.guid, next.refresh, next.leagues, next.hidden, Date.now()).run();
  return next;
}
const publicSettings = (env, row) => ({
  available: yahooAvailable(env), connected: !!row?.refresh,
  leagues: row ? JSON.parse(row.leagues || '[]') : [], hidden: row ? JSON.parse(row.hidden || '[]') : [],
});

// The leagues (and this user's team in each) for some seasons.
async function discover(env, userId, seasons) {
  const keys = [];
  for (const s of seasons) keys.push(await gameIdFor(env, userId, s).catch(() => null));
  const gk = keys.filter(Boolean).join(',');
  if (!gk) return [];
  const [lg, tm] = await Promise.all([
    yget(env, userId, `/users;use_login=1/games;game_keys=${gk}/leagues`),
    yget(env, userId, `/users;use_login=1/games;game_keys=${gk}/teams`),
  ]);
  const teamOf = {};
  for (const u of arr(tm.users?.user)) for (const g of arr(u.games?.game)) for (const t of arr(g.teams?.team)) {
    const lk = String(t.team_key).split('.t.')[0];
    teamOf[lk] = { team_id: teamIdOf(t.team_key), team_name: String(t.name || '') };
  }
  const found = yahooUserLeagues(lg).map(l => ({ ...l, ...(teamOf[l.league_key] || {}) }));
  const row = await getRow(env, userId);
  const keep = row ? JSON.parse(row.leagues || '[]').filter(l => !seasons.includes(+l.season)) : [];
  await saveRow(env, userId, { leagues: JSON.stringify([...keep, ...found]) });
  return found;
}

// ── League context ────────────────────────────────────────────────────────────
export function parseYahooKey(key) {
  const m = String(key || '').match(/^yh_(\d{4})_(\d+)$/);
  return m ? { season: +m[1], lid: m[2] } : null;
}

async function sleeperIdFor(env, user) {
  const u = String(user?.sleeper_username || '').trim().toLowerCase();
  if (!u) return null;
  const k = `mfl:slid:${u}`;   // shared with mfl.js
  const hit = await env.SLEEPER_KV.get(k).catch(() => null);
  if (hit) return hit;
  const r = await fetch(`https://api.sleeper.app/v1/user/${encodeURIComponent(u)}`).catch(() => null);
  const id = r?.ok ? (await r.json().catch(() => null))?.user_id : null;
  if (id) await env.SLEEPER_KV.put(k, String(id), { expirationTtl: 30 * 86400 });
  return id || null;
}

async function leagueCtx(env, request, key) {
  const k = parseYahooKey(key);
  if (!k) throw new YahooError('Bad Yahoo league id', 400);
  if (!yahooAvailable(env)) throw new YahooError('Yahoo isn’t set up yet', 503);
  const user = await getAuthUser(request, env).catch(() => null);
  if (!user) throw new YahooError('Sign in to read Yahoo leagues', 401);
  const row = await getRow(env, user.user_id);
  const entry = (row ? JSON.parse(row.leagues || '[]') : []).find(l => l.id === k.lid && +l.season === k.season);
  if (!entry) throw new YahooError('That Yahoo league isn’t on your account — find your leagues again on your profile', 403);
  const gameId = entry.game_id || await gameIdFor(env, user.user_id, k.season);
  return { ...k, key, user, userId: user.user_id, gameId, lkey: entry.league_key || leagueKeyOf(gameId, k.lid), mine: entry.team_id ?? null };
}

const past = ctx => ctx.season < nflSeason();
const kv = (ctx, part) => `yh:v1:${ctx.lkey}:${part}`;

async function leagueBase(env, ctx) {
  const d = await cached(env, ctx.userId, kv(ctx, 'settings'), `/league/${ctx.lkey}/settings`, TTL.league);
  const L = d.league || {};
  return { L, lg: yahooLeague({ league: L, gameToSeason: gameToSeason() }) };
}

async function rosterTeams(env, ctx, week, withStats) {
  const path = withStats
    ? `/league/${ctx.lkey}/teams/roster;week=${week}/players/stats;type=week;week=${week}`
    : `/league/${ctx.lkey}/teams/roster;week=${week}`;
  const ttl = past(ctx) ? TTL.rosterPast : TTL.roster;
  const d = await cached(env, ctx.userId, kv(ctx, `roster:${week}:${withStats ? 's' : 'n'}`), path, ttl).catch(async e => {
    if (!withStats) throw e;
    // If Yahoo won't chain stats under a league's rosters, fall back to lineups only.
    return cached(env, ctx.userId, kv(ctx, `roster:${week}:n`), `/league/${ctx.lkey}/teams/roster;week=${week}`, ttl);
  });
  return arr(d.league?.teams?.team);
}

async function resource(env, ctx, res, arg, me) {
  const idx = await getYahooIdx(env);
  const { L, lg } = await leagueBase(env, ctx);
  const rp = lg.roster_positions;
  const cur = parseInt(L.current_week, 10) || 1;
  if (!res) return lg;

  if (res === 'users' || res === 'rosters') {
    const st = await cached(env, ctx.userId, kv(ctx, 'standings'), `/league/${ctx.lkey}/standings`, past(ctx) ? TTL.scoreboardPast : TTL.standings);
    const sTeams = arr(st.league?.standings?.teams?.team);
    if (res === 'users') return yahooUsers({ lid: ctx.lid, teams: sTeams, me, mine: ctx.mine });
    const week = Math.min(cur, parseInt(L.end_week, 10) || cur);
    const rTeams = await rosterTeams(env, ctx, week, false);
    const divisions = Object.fromEntries(arr(L.settings?.divisions?.division).map((d, i) => [String(d.division_id), i + 1]));
    return yahooRosters({ lid: ctx.lid, idx, standingsTeams: sTeams, rosterTeams: rTeams, rosterPositions: rp, divisions, me, mine: ctx.mine });
  }

  if (res === 'matchups') {
    const w = parseInt(arg, 10);
    if (!(w >= 1 && w <= 22)) throw new YahooError('Invalid week', 400);
    const done = past(ctx) || w < cur;
    const sb = await cached(env, ctx.userId, kv(ctx, `sb:${w}`), `/league/${ctx.lkey}/scoreboard;week=${w}`, done ? TTL.scoreboardPast : TTL.scoreboard);
    const rTeams = await rosterTeams(env, ctx, w, true);
    return yahooMatchups({ idx, scoreboard: sb.league?.scoreboard, rosterTeams: rTeams, rosterPositions: rp });
  }

  if (res === 'traded_picks') return [];   // Yahoo has no future draft picks to trade

  if (res === 'drafts') {
    const dr = await cached(env, ctx.userId, kv(ctx, 'draft'), `/league/${ctx.lkey}/draftresults`, past(ctx) ? TTL.draftPast : TTL.draft);
    return [yahooDraft({ season: ctx.season, lid: ctx.lid, league: L, draftResults: dr.league?.draft_results?.draft_result })];
  }

  if (res === 'winners_bracket') {
    const start = lg.settings.playoff_week_start, end = parseInt(L.end_week, 10) || start;
    if (!lg.settings.playoff_teams || cur < start) return [];
    const weeks = [];
    for (let w = start; w <= Math.min(end, cur); w++) {
      const sb = await cached(env, ctx.userId, kv(ctx, `sb:${w}`), `/league/${ctx.lkey}/scoreboard;week=${w}`, past(ctx) || w < cur ? TTL.scoreboardPast : TTL.scoreboard);
      weeks.push(sb.league?.scoreboard);
    }
    return yahooWinnersBracket(weeks);
  }
  if (res === 'losers_bracket') return [];

  throw new YahooError('Unknown resource', 404);
}

async function draftResource(env, ctx, res) {
  const idx = await getYahooIdx(env);
  const { L } = await leagueBase(env, ctx);
  const dr = await cached(env, ctx.userId, kv(ctx, 'draft'), `/league/${ctx.lkey}/draftresults`, past(ctx) ? TTL.draftPast : TTL.draft);
  const results = dr.league?.draft_results?.draft_result;
  if (!res) return yahooDraft({ season: ctx.season, lid: ctx.lid, league: L, draftResults: results });
  if (res === 'picks') {
    // Names/teams for the drafted players, 25 per request (Yahoo's page size).
    const keys = [...new Set(arr(results).map(p => p.player_key).filter(Boolean))];
    const players = {};
    for (let i = 0; i < keys.length; i += 25) {
      const part = keys.slice(i, i + 25);
      const d = await cached(env, ctx.userId, kv(ctx, `dp:${i}`), `/league/${ctx.lkey}/players;player_keys=${part.join(',')}`,
                             past(ctx) ? TTL.draftPast : TTL.draft).catch(() => null);
      for (const p of arr(d?.league?.players?.player)) players[String(p.player_id)] = p;
    }
    return yahooDraftPicks({ idx, draftResults: results, players });
  }
  if (res === 'traded_picks') return [];
  throw new YahooError('Unknown resource', 404);
}

// ── Router ────────────────────────────────────────────────────────────────────
export async function handleYahooAuth(request, env, url, p) {
  if (p === '/yahoo/start') return yahooStart(request, env, url);
  if (p === '/yahoo/callback') return yahooCallback(env, url);
  return null;
}

export const isYahooSleeperPath = pathname => /^\/api\/sleeper\/(league|draft)\/yh_\d{4}_\d+(\/|$)/.test(pathname);

export async function handleYahoo(request, env, url) {
  const p = url.pathname.replace(/^\/api\/(yahoo|sleeper)/, '');
  try {
    let m = p.match(/^\/league\/(yh_\d{4}_\d+)(?:\/([a-z_]+)(?:\/(\d+))?)?$/);
    if (m && request.method === 'GET') {
      const ctx = await leagueCtx(env, request, m[1]);
      const me = url.searchParams.get('me') || (await sleeperIdFor(env, ctx.user)) || 'me';
      return json(request, await resource(env, ctx, m[2] || null, m[3], me), 200, { 'Cache-Control': 'private, max-age=30' });
    }
    m = p.match(/^\/draft\/(yh_\d{4}_\d+)(?:\/([a-z_]+))?$/);
    if (m && request.method === 'GET') {
      const ctx = await leagueCtx(env, request, m[1]);
      return json(request, await draftResource(env, ctx, m[2] || null), 200, { 'Cache-Control': 'private, max-age=30' });
    }

    const user = await getAuthUser(request, env).catch(() => null);
    if (p === '/settings' && request.method === 'GET' && !user) return json(request, { available: yahooAvailable(env), connected: false, leagues: [], hidden: [] });
    if (!user) return json(request, { error: 'Not authenticated' }, 401);

    if (p === '/settings') {
      if (request.method === 'GET') return json(request, publicSettings(env, await getRow(env, user.user_id)));
      if (request.method === 'POST') {
        const b = await request.json().catch(() => ({}));
        const patch = {};
        if (Array.isArray(b.hidden)) patch.hidden = JSON.stringify(b.hidden.map(String).slice(0, 500));
        return json(request, publicSettings(env, await saveRow(env, user.user_id, patch)));
      }
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM yahoo_settings WHERE user_id = ?').bind(user.user_id).run();
        await env.SLEEPER_KV.delete(`yh_at_${user.user_id}`);
        return json(request, publicSettings(env, null));
      }
    }

    if (p === '/discover' && request.method === 'POST') {
      if (!yahooAvailable(env)) return json(request, { error: 'Yahoo isn’t set up yet' }, 503);
      const b = await request.json().catch(() => ({}));
      const seasons = Array.isArray(b.seasons) && b.seasons.length
        ? b.seasons.map(Number).filter(y => y >= 2001 && y <= 2100).slice(0, 15) : [nflSeason()];
      await discover(env, user.user_id, seasons);
      return json(request, publicSettings(env, await getRow(env, user.user_id)));
    }

    if (p === '/leagues' && request.method === 'GET') {
      if (!yahooAvailable(env)) return json(request, { leagues: [], errors: [] });
      const season = parseInt(url.searchParams.get('season'), 10) || nflSeason();
      const me = url.searchParams.get('me') || (await sleeperIdFor(env, user)) || 'me';
      const row = await getRow(env, user.user_id);
      if (!row?.refresh) return json(request, { leagues: [], errors: [] });
      const hidden = new Set(JSON.parse(row.hidden || '[]'));
      const list = JSON.parse(row.leagues || '[]').filter(l => +l.season === season && !hidden.has(`${l.season}_${l.id}`));
      const out = [], errors = [];
      let stop = false;
      for (let i = 0; i < list.length && !stop; i += 3) {
        await Promise.all(list.slice(i, i + 3).map(async l => {
          try {
            const ctx = await leagueCtx(env, request, `yh_${l.season}_${l.id}`);
            const lg = await resource(env, ctx, null, null, me);
            out.push({ ...lg, _yahoo: { ...lg._yahoo, team_id: l.team_id ?? null, team_name: l.team_name || null } });
          } catch (e) {
            errors.push({ id: l.id, season: l.season, name: l.name, error: e.message });
            if (e.status === 429 || e.status === 401) stop = true;
          }
        }));
      }
      const order = new Map(list.map((l, i) => [`yh_${l.season}_${l.id}`, i]));
      out.sort((a, b) => order.get(a.league_id) - order.get(b.league_id));
      return json(request, { leagues: out, errors });
    }

    return json(request, { error: 'Not found' }, 404);
  } catch (e) {
    const status = e instanceof YahooError ? e.status : 500;
    if (status >= 500) console.error('[yahoo]', url.pathname, e.message);
    return json(request, { error: e.message }, status);
  }
}
