// GET /api/devy?league={lgId}&prev={previousLeagueId}
//
// Devy leagues hold college players on Sleeper as K / IDP placeholders, and a
// Google Sheet is the league's record of who those placeholders really are.
// This route only fetches that sheet — every tab, as raw CSV — and caches it;
// all parsing and matching happens client-side (devy* in shared-utils.js),
// where it's testable and where the Sleeper rosters already are.
//
// DEVY_SHEETS is an allowlist, not a convenience: without it this would be an
// open proxy for any Google Sheet. Sleeper mints a new league_id every season,
// so the client also sends previous_league_id — a renewed league keeps working
// for a season without a deploy (add the new id here when you get the chance).
import { CORS, kvCachedJson } from './http.js';

// sheet: the Google Sheet id. ignore: devy names to drop everywhere (out of the
// league, or graduated under a name Sleeper doesn't carry). rename: sheet
// spelling → the real name, applied to every tab before matching.
const DEVY_SHEETS = {
  '1312511402388258816': {   // Are You Into Devy Stuff?
    sheet: '1gU4VrBes8A5E18ffpTijAZ8iHJnLJtVcXMv0vQSQeUc',
    ignore: ['Maqruarius "Squirrel" White', 'Taylor Tatum', 'Trevonte Citizen', 'KJ Jefferson', 'Bru McCoy', 'Michael Sturdivant'],
    rename: { 'Sheloton Sampson Jr': 'Shelton Sampson Jr' },
  },
};

const DEVY_TTL = 600;   // 10 min — the sheet is edited by hand after trades

export async function handleDevy(env, url) {
  const cfg = DEVY_SHEETS[url.searchParams.get('league')] || DEVY_SHEETS[url.searchParams.get('prev')];
  if (!cfg) {
    return new Response(JSON.stringify({ devy: false }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const sheetId = cfg.sheet;
  // The config is folded into the cache key, so a deploy that edits it isn't
  // hidden behind 10 minutes of the old response.
  const cfgTag = [...JSON.stringify([cfg.ignore, cfg.rename])].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  return kvCachedJson(env, `devy_sheet_v2_${sheetId}_${cfgTag}`, {
    ttl: DEVY_TTL,
    load: async () => {
      const base = `https://docs.google.com/spreadsheets/d/${sheetId}`;
      // Tab names + gids come from the public htmlview page; the export URL
      // needs a gid per tab. Reading the list (rather than hardcoding gids)
      // means next year's "2027 Draft" tab is picked up on its own.
      const html = await fetch(`${base}/htmlview`).then(r => {
        if (!r.ok) throw new Error(`Devy sheet not readable (${r.status}) — is it shared "anyone with the link"?`);
        return r.text();
      });
      const tabs = [...html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)",[^}]*?gid: "(-?\d+)"/g)]
        .map(m => ({ name: JSON.parse(`"${m[1]}"`), gid: m[2] }));
      if (!tabs.length) tabs.push({ name: 'Sheet1', gid: '0' });
      const withCsv = await Promise.all(tabs.map(async t => {
        const r = await fetch(`${base}/export?format=csv&gid=${t.gid}`);
        if (!r.ok) throw new Error(`Devy sheet tab "${t.name}" failed (${r.status})`);
        return { ...t, csv: await r.text() };
      }));
      return JSON.stringify({ devy: true, sheetUrl: `${base}/edit`, tabs: withCsv, ignore: cfg.ignore || [], rename: cfg.rename || {} });
    },
  });
}

// ── GET /api/devy/espn?p=[{n, pos, sch}, …] (≤ 10) ───────────────────────────
// Current position / school / class / season stats for devy players, from ESPN's
// college-football data. The sheet's school is where a player was DRAFTED from;
// transfers are routine (Nico Iamaleava: Tennessee → UCLA), so this is the live
// answer. Batched small because each player costs a search + a detail fetch.
//
// Matching (espnPickCandidate): college-football results only, name must match
// (first + last token, so "Ryan Coleman-Williams" can still be Ryan Williams),
// then the sheet's school wins; failing that (a transfer), the candidates whose
// ESPN position matches, newest ESPN id first (current players have the highest
// ids — a 2015 namesake at Mercer loses). No match → null, never a guess at a
// different position.
const ESPN_SEARCH = q => `https://site.web.api.espn.com/apis/search/v2?query=${encodeURIComponent(q)}&limit=15&type=player`;
const ESPN_ATHLETE = id => `https://site.web.api.espn.com/apis/common/v3/sports/football/college-football/athletes/${id}`;
const DEVY_ESPN_TTL_HIT = 7 * 86400, DEVY_ESPN_TTL_MISS = 86400;

const dNorm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/-/g, ' ').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().replace(/\s+(jr|sr|ii|iii|iv|v)$/, '');
const POS_GROUP = { QB: 'QB', RB: 'RB', HB: 'RB', FB: 'RB', WR: 'WR', TE: 'TE', ATH: 'ATH' };

function lev1(a, b) {   // edit distance, capped: only "≤ 1?" is ever asked
  if (Math.abs(a.length - b.length) > 1) return 2;
  let i = 0; while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i + (a.length >= b.length ? 1 : 0)) === b.slice(i + (b.length >= a.length ? 1 : 0)) ? 1 : 2;
}
export function espnNameMatch(want, got) {
  const A = dNorm(want), B = dNorm(got), a = A.split(' '), b = B.split(' ');
  if (!a[0] || !b[0]) return false;
  if (A === B || (A.length >= 8 && lev1(A, B) <= 1)) return true;     // "Eyiss" in the sheet, "Elyiss" at ESPN
  return a[0] === b[0] && a[a.length - 1] === b[b.length - 1];       // "Ryan Coleman-Williams"
}
export function espnSchoolMatch(sheetSchool, subtitle) {
  const s = dNorm(sheetSchool), t = dNorm(subtitle);
  if (!s || !t) return false;
  return t.startsWith(s + ' ') || t === s || (s.length >= 4 && t.split(' ').slice(0, 3).join(' ').includes(s));
}
export function espnCandidates(searchJson, name) {
  const out = [];
  for (const g of searchJson?.results || []) for (const c of g.contents || []) {
    if (c.defaultLeagueSlug !== 'college-football' || !espnNameMatch(name, c.displayName)) continue;
    const id = (String(c.uid || '').match(/~a:(\d+)/) || [])[1];
    if (id) out.push({ id, name: c.displayName, team: c.subtitle || '' });
  }
  return out.sort((x, y) => +y.id - +x.id);
}

function athleteInfo(a, id) {
  const stats = (a?.statsSummary?.statistics || []).slice(0, 4).map(s => `${s.displayValue} ${s.abbreviation}`).join(' · ');
  return {
    espnId: id,
    name: a?.displayName || null,
    pos: a?.position?.abbreviation || null,
    team: a?.team?.location || a?.team?.displayName || null,
    teamFull: a?.team?.displayName || null,
    cls: a?.displayExperience || null,          // Freshman / Sophomore / … (redshirt shown by ESPN as e.g. "Redshirt Junior")
    jersey: a?.jersey || null,
    active: a?.active !== false,
    stats: stats || null,
    statsLabel: a?.statsSummary?.displayName || null,
    url: `https://www.espn.com/college-football/player/_/id/${id}`,
  };
}

const SKILL = new Set(['QB', 'RB', 'WR', 'TE', 'ATH']);

async function espnLookup({ n, pos, sch }) {
  const ua = { headers: { 'User-Agent': 'Mozilla/5.0 (sleeper-helper)' } };
  const search = q => fetch(ESPN_SEARCH(q), ua).then(r => r.ok ? r.json() : null).catch(() => null);
  let res = await search(n);
  let cands = espnCandidates(res, n);
  // Nothing: try ESPN's own spelling suggestion, still held to the name match.
  if (!cands.length && res?.didYouMean && dNorm(res.didYouMean) !== dNorm(n)) cands = espnCandidates(await search(res.didYouMean), n);
  if (!cands.length) return null;
  const want = String(pos || '').toUpperCase().split(/[\/, ]+/).map(p => POS_GROUP[p] || p).filter(Boolean);
  const bySchool = cands.filter(c => espnSchoolMatch(sch, c.team));
  const lone = cands.length === 1 && dNorm(cands[0].name) === dNorm(n);
  // School match first; else up to 3 newest by id.
  const order = [...bySchool, ...cands.filter(c => !bySchool.includes(c))].slice(0, 3);
  for (const c of order) {
    const a = await fetch(ESPN_ATHLETE(c.id), ua).then(r => r.ok ? r.json() : null).then(j => j?.athlete).catch(() => null);
    if (!a) continue;
    const info = athleteInfo(a, c.id);
    const g = POS_GROUP[info.pos] || info.pos;
    const schoolHit = bySchool.includes(c);
    // How sure must we be? Same school: any skill position (he can have moved
    // TE → WR). Different school (a transfer — or a namesake): the position
    // must match exactly AND he must look like a current player (a class and
    // stats), unless he's the ONLY exact-name college player ESPN has.
    const ok = schoolHit ? SKILL.has(g)
      : lone ? SKILL.has(g) && !!info.cls
      : want.includes(g) && !!info.cls && !!info.stats;
    if (ok) return { ...info, schoolMatched: schoolHit };
  }
  return null;
}

export async function handleDevyEspn(env, url) {
  let list;
  try { list = JSON.parse(url.searchParams.get('p') || '[]'); } catch { list = []; }
  if (!Array.isArray(list) || !list.length || list.length > 10) {
    return new Response('p must be a JSON array of 1-10 {n,pos,sch}', { status: 400, headers: CORS });
  }
  const results = {};
  await Promise.all(list.map(async q => {
    if (!q?.n) return;
    const key = `devy_espn_v2_${dNorm(q.n)}|${String(q.pos || '').toUpperCase()}|${dNorm(q.sch)}`.slice(0, 480);
    const cached = await env.SLEEPER_KV.get(key, 'json');
    if (cached) { results[q.n] = cached.hit; return; }
    const hit = await espnLookup(q).catch(() => null);
    results[q.n] = hit;
    await env.SLEEPER_KV.put(key, JSON.stringify({ hit }), { expirationTtl: hit ? DEVY_ESPN_TTL_HIT : DEVY_ESPN_TTL_MISS });
  }));
  return new Response(JSON.stringify({ results }), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' },
  });
}
