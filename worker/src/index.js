/**
 * Sleeper Helper — Cloudflare Worker
 *
 * Routes:
 *   POST /api/auth/register       → create account (sends OTP, no session until verified)
 *   POST /api/auth/login          → login, set session cookie (or re-issue OTP if unverified)
 *   POST /api/auth/verify-email   → confirm OTP, sets session cookie
 *   POST /api/auth/resend-code    → resend verification OTP (rate-limited)
 *   POST /api/auth/forgot-password→ email a password-reset OTP
 *   POST /api/auth/reset-password → confirm reset OTP + set new password, sets session cookie
 *   POST /api/auth/delete-account → self-delete (auth + password required)
 *   GET  /api/auth/admin/users    → list all accounts (X-Admin-Secret header or is_admin session)
 *   POST /api/auth/admin/delete-user → admin force-delete (X-Admin-Secret header or is_admin session)
 *   GET  /api/auth/me             → current user (session cookie)
 *   PATCH /api/auth/me            → update sleeper_username / stored token
 *   POST /api/auth/logout         → clear session
 *   GET  /api/players             → KV-cached player map (2h TTL)
 *   GET  /api/sleeper/*           → live proxy to api.sleeper.app (no cache)
 *   POST /api/graphql             → proxy to sleeper.com/graphql (authenticated)
 *   GET  /api/fantasycalc         → FantasyCalc values (KV-cached 24h; optional ?isDynasty=&numQbs=&ppr=&includePickValues=, default = dynasty/2QB/full-PPR)
 *   GET  /api/aggregate-adp       → JuiceBoxOne consensus ADP CSV, offense only (KV-cached 12h)
 *   GET  /api/fantasypros/ros     → FantasyPros consensus rest-of-season ranks (?scoring=half|ppr|std, KV-cached 6h)
 *   GET  /api/espn/scoreboard     → NFL week schedule: team → kickoff ISO (KV-cached 5m)
 *   GET  /api/espn/games          → NFL week games with pairings [{home,away,kickoff}] (KV-cached 5m)
 *   GET  /api/espn/settings       → get ESPN league IDs + credential status (auth required)
 *   POST /api/espn/settings       → save ESPN league IDs + credentials (auth required)
 *   GET  /api/espn/fantasy/:id    → proxy ESPN fantasy API using stored credentials (auth required)
 *   GET  /api/rootforme/prefs     → get league preferences for logged-in user
 *   POST /api/rootforme/prefs     → save league preferences for logged-in user
 *   GET  /api/roi                 → ROI Tracker ledger (leagues + seasons) for logged-in user
 *   POST /api/roi                 → upsert/delete ROI leagues + seasons
 *   GET  /api/eliteffl/picks            → all Elite FFL draft-history rows (public)
 *   POST /api/eliteffl/picks            → create one row (admin only)
 *   POST /api/eliteffl/picks/import     → bulk-insert rows for a season (admin only)
 *   POST /api/eliteffl/picks/import-ppg → merge PPG into existing rows by season + player name (admin only)
 *   PUT/DELETE /api/eliteffl/picks/:id  → edit/remove one row (admin only)
 *   GET  /api/eliteffl/keeper-options           → all keeper-options rows (public)
 *   POST /api/eliteffl/keeper-options           → create one row (admin only)
 *   POST /api/eliteffl/keeper-options/import    → bulk-insert rows (admin only)
 *   PUT/DELETE /api/eliteffl/keeper-options/:id → edit/remove one row (admin only)
 *   data.ffhistorian.com/*        → Site Lead stats explorer (page + /api/data/*), see src/data.js
 *   POST /api/dispersal           → create dispersal room
 *   *    /api/dispersal/:id/*     → forward to DispersalRoom Durable Object
 *
 * KV binding:      SLEEPER_KV
 * D1 binding:      DB
 * DO binding:      DISPERSAL_ROOM
 * Secret:          TOKEN_ENCRYPTION_KEY  (base64 AES-256 key)
 * Secret:          ADMIN_SECRET  (shared secret for /api/auth/admin/delete-user)
 * Secret:          RESEND_API_KEY  (Resend — verification/reset OTPs, admin alerts)
 */

export { DispersalRoom } from './dispersal.js';
import { handleAuth, getAuthUser, decryptStoredToken } from './auth.js';
import { handleDataSite } from './data.js';
import { handleEliteFFL } from './eliteffl.js';
import { handleProjections } from './projections.js';
import { getCors, CORS, cacheFor, jsonBody, kvCachedJson } from './http.js';

const SLEEPER_BASE  = 'https://api.sleeper.app/v1';
const SLEEPER_GQL   = 'https://sleeper.com/graphql';
// JuiceBoxOne's public consensus ADP sheet (FantasyPros/ESPN/Sleeper/Yahoo blend,
// "Average" column) — view-only Google Sheet, no auth needed for the CSV export.
// Offense only (QB/RB/WR/TE, ~200 players) — no IDP, no deep bench. Callers must
// fall back to Sleeper search_rank for anything not found in this map.
const AGGREGATE_ADP_URL = 'https://docs.google.com/spreadsheets/d/1HTixsrRtIIpnUafVkOIhET83vCFjKXSUGiG24-5jTHY/export?format=csv&gid=1840800615';
const PLAYERS_TTL   = 60 * 60 * 2;   // 2 hours
const FC_TTL        = 60 * 60 * 24;  // 24 hours
const AGG_ADP_TTL   = 60 * 60 * 12;  // 12 hours — a personal doc, refresh more often than FC in case it moves/breaks
const FP_ROS_TTL    = 60 * 60 * 6;   // 6 hours — FantasyPros re-publishes ECR through the day, not just overnight
const ESPN_TTL      = 60 * 5;        // 5 minutes (game times are stable but scores update live)
const ROOM_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Browser cache policy ──────────────────────────────────────────────────────
// Applied at individual CALL SITES, never inside jsonBody. jsonBody is shared with
// per-user handlers — handleRootformePrefs returns one account's prefs through it
// — and a max-age on those would hand one user's data to the next reader. Only
// responses that are byte-identical for every caller get a lifetime here, and
// those all use the static `*`-origin CORS block, so no Vary is needed.
//
// PLAYERS is deliberately far shorter than its 2h KV TTL: /api/players carries
// injury_status, which the lineup optimizer and Injury Swap both act on, and a
// long browser TTL would show stale inactives on a Sunday morning.
// stale-while-revalidate keeps navigation instant without widening that window.
const PLAYERS_BROWSER_TTL = 600;    // 10m
const PLAYERS_SWR         = 3600;   // then serve stale up to 1h while refreshing
const FC_BROWSER_TTL      = 3600;   // 1h, against a 24h KV TTL


export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // data.ffhistorian.com is admin-only and same-origin — it never shares the
    // CORS / OPTIONS handling below. See src/data.js.
    if (url.hostname === 'data.ffhistorian.com') {
      return handleDataSite(request, env, url);
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCors(request) });
    }

    if (url.pathname.startsWith('/api/auth/')) {
      const authResp  = await handleAuth(request, env, url);
      const cors      = getCors(request);
      const setCookie = authResp.headers.get('Set-Cookie');
      const body      = await authResp.text();
      const headers   = { ...cors, 'Content-Type': 'application/json;charset=UTF-8' };
      if (setCookie) headers['Set-Cookie'] = setCookie;
      return new Response(body, { status: authResp.status, headers });
    }

    if (url.pathname === '/api/players' && request.method === 'GET') {
      return handlePlayers(env);
    }

    if (url.pathname.startsWith('/api/sleeper/') && request.method === 'GET') {
      return handleProxy(url, env);
    }

    if (url.pathname === '/api/graphql' && request.method === 'POST') {
      return handleGraphQL(request, env);
    }

    if (url.pathname === '/api/fantasycalc' && request.method === 'GET') {
      return handleFantasyCalc(env, url);
    }

    if (url.pathname === '/api/aggregate-adp' && request.method === 'GET') {
      return handleAggregateAdp(env);
    }

    if (url.pathname === '/api/fantasypros/ros' && request.method === 'GET') {
      return handleFantasyProsRos(env, url);
    }

    if (url.pathname === '/api/espn/scoreboard' && request.method === 'GET') {
      return handleESPNScoreboard(request, env, url);
    }

    if (url.pathname === '/api/espn/games' && request.method === 'GET') {
      return handleESPNGames(request, env, url);
    }

    if (url.pathname === '/api/espn/settings') {
      return handleEspnSettings(request, env);
    }

    if (url.pathname === '/api/espn/discover' && request.method === 'POST') {
      return handleEspnDiscover(request, env, url);
    }

    if (url.pathname.startsWith('/api/espn/fantasy/') && request.method === 'GET') {
      return handleEspnFantasy(request, env, url);
    }

    if (url.pathname === '/api/rootforme/prefs') {
      return handleRootformePrefs(request, env);
    }

    if (url.pathname === '/api/roi') {
      return handleRoi(request, env);
    }

    if (url.pathname === '/api/ranks/image') {
      return handleRanksImage(request, env);
    }

    if (url.pathname.startsWith('/api/eliteffl/')) {
      return handleEliteFFL(request, env, url);
    }

    if (url.pathname.startsWith('/api/projections')) {
      return handleProjections(request, env, url);
    }

    if (url.pathname.startsWith('/api/dispersal')) {
      return handleDispersal(request, env, url);
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── FantasyCalc ───────────────────────────────────────────────────────────────

// Query params (all optional, defaults match the original fixed dynasty/2QB/
// full-PPR fetch so callers that pass nothing get unchanged behavior):
//   isDynasty (default true), numQbs (default 2), ppr (default 1),
//   includePickValues (default true), tep, numTeams, includeAdp,
//   includeRosterPercent (these four passed through only when the caller sets
//   them — FC has its own defaults otherwise)
// FantasyCalc's response includes BOTH `value` (scored to the isDynasty flag)
// and `redraftValue` (FC's own redraft valuation) on every player regardless
// of isDynasty — but redraftValue still varies with numQbs/ppr, so a redraft
// caller should still pass the league's real numQbs/ppr even with isDynasty=false.
// `tep` (none | te+ | te++) moves `value` but NOT `redraftValue` (confirmed
// live) — only meaningful for dynasty callers.
async function handleFantasyCalc(env, url) {
  const isDynasty = (url?.searchParams.get('isDynasty') ?? 'true') === 'true';
  const numQbs     = url?.searchParams.get('numQbs') || '2';
  const ppr        = url?.searchParams.get('ppr') || '1';
  const includePickValues = (url?.searchParams.get('includePickValues') ?? 'true') === 'true';
  const tep                  = url?.searchParams.get('tep') || '';
  const numTeams              = url?.searchParams.get('numTeams') || '';
  const includeAdp            = url?.searchParams.get('includeAdp') || '';
  const includeRosterPercent  = url?.searchParams.get('includeRosterPercent') || '';
  const cacheKey = `fc_values_${isDynasty}_${numQbs}_${ppr}_${includePickValues}_${tep}_${numTeams}_${includeAdp}_${includeRosterPercent}`;

  const fcParams = new URLSearchParams({ isDynasty: String(isDynasty), numQbs, ppr, includePickValues: String(includePickValues) });
  if (tep)                 fcParams.set('tep', tep);
  if (numTeams)             fcParams.set('numTeams', numTeams);
  if (includeAdp)           fcParams.set('includeAdp', includeAdp);
  if (includeRosterPercent) fcParams.set('includeRosterPercent', includeRosterPercent);
  const fcUrl = `https://api.fantasycalc.com/values/current?${fcParams.toString()}`;
  return kvCachedJson(env, cacheKey, {
    ttl: FC_TTL,
    headers: cacheFor(FC_BROWSER_TTL),
    load: async () => {
      const upstream = await fetch(fcUrl, { headers: { 'User-Agent': 'sleeper-helper/1.0' } });
      if (!upstream.ok) throw new Error('FantasyCalc upstream error');
      const body = await upstream.text();
      // A 200 with a malformed/truncated body (FC serving an HTML error page, etc.)
      // must never get cached. FC always returns a JSON array on success.
      let parsed;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      if (!Array.isArray(parsed)) throw new Error('FantasyCalc upstream returned malformed data');
      return body;
    },
  });
}

// ── Aggregate ADP (JuiceBoxOne consensus sheet) ────────────────────────────────
// Returns raw rows [{name, team, bye, pos, rank}] — name matching against Sleeper
// IDs happens client-side (crLoadAggregateAdp in shared-utils.js), same pattern
// as the Clay projections source.

async function handleAggregateAdp(env) {
  return kvCachedJson(env, 'agg_adp', {
    ttl: AGG_ADP_TTL,
    load: async () => {
      const upstream = await fetch(AGGREGATE_ADP_URL, { headers: { 'User-Agent': 'sleeper-helper/1.0' } });
      if (!upstream.ok) throw new Error('Aggregate ADP upstream error');
      return JSON.stringify(parseAggregateAdpCsv(await upstream.text()));
    },
  });
}

// Sheet columns: (blank), Name, Team, BYE, Pos, ADP, FantasyPros, ESPN Half,
// Sleeper Half, Y Half, Average, AVGvFP, Landmine, Round, Pick
function parseAggregateAdpCsv(csv) {
  const lines = csv.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length < 2) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols    = parseCsvLine(lines[i]);
    const name    = cols[1];
    const team    = cols[2];
    const bye     = Number(cols[3]) || null;
    const pos     = cols[4];
    const average = Number(cols[10]);
    if (!name || !pos || !Number.isFinite(average)) continue;
    out.push({ name, team, bye, pos, rank: average });
  }
  return out;
}

// Minimal RFC-4180-ish CSV line parser (handles quoted fields with embedded
// commas/quotes) — Google Sheets' CSV export quotes any field containing a comma.
function parseCsvLine(line) {
  const out = [];
  let cur = '', inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ── FantasyPros rest-of-season consensus (ECR) ─────────────────────────────────
// The public rankings page embeds the whole board as `var ecrData = {...}` — the
// same JSON its own table renders from — so this is a JSON read, not an HTML
// scrape: no markup parsing, and it survives any redesign of the table itself.
// Returns [{name, team, pos, rank, posRank}]; name → Sleeper id matching happens
// client-side, same pattern as the Clay projections and the aggregate ADP sheet.
const FP_ROS_URLS = {
  half: 'https://www.fantasypros.com/nfl/rankings/ros-half-point-ppr-overall.php',
  ppr:  'https://www.fantasypros.com/nfl/rankings/ros-ppr-overall.php',
  std:  'https://www.fantasypros.com/nfl/rankings/ros-overall.php',
};

async function handleFantasyProsRos(env, url) {
  const scoring = (url?.searchParams.get('scoring') || 'half').toLowerCase();
  const src = FP_ROS_URLS[scoring];
  if (!src) return new Response('Unknown scoring — use half, ppr or std', { status: 400, headers: CORS });

  return kvCachedJson(env, `fp_ros_${scoring}`, {
    ttl: FP_ROS_TTL,
    load: async () => {
      const upstream = await fetch(src, { headers: { 'User-Agent': 'sleeper-helper/1.0' } });
      if (!upstream.ok) throw new Error('FantasyPros upstream error');
      let parsed;
      try {
        parsed = parseFantasyProsEcr(await upstream.text());
      } catch (e) {
        throw new Error('FantasyPros parse failed: ' + (e && e.message || e));
      }
      // An empty board means the page shape moved. Refusing to cache it keeps one
      // bad fetch from blanking every caller's delta column for 6 hours.
      if (!parsed.players.length) throw new Error('FantasyPros returned no ranked players');
      return JSON.stringify({ scoring, ...parsed });
    },
  });
}

function parseFantasyProsEcr(html) {
  const at = html.indexOf('var ecrData');
  if (at < 0) throw new Error('ecrData not found');
  const start = html.indexOf('{', at);
  if (start < 0) throw new Error('ecrData has no object');
  // Brace-match rather than regex to the next `;` — player notes are free text
  // and have carried both braces and semicolons.
  let depth = 0, end = -1, inStr = false, quote = '';
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { end = i; break; }
  }
  if (end < 0) throw new Error('ecrData object never closed');

  const data = JSON.parse(html.slice(start, end + 1));
  const players = [];
  for (const p of (data.players || [])) {
    const rank = Number(p.rank_ecr);
    if (!p.player_name || !Number.isFinite(rank)) continue;
    players.push({
      name: p.player_name,
      team: p.player_team_id || '',
      pos:  p.player_position_id || '',
      rank,
      // "RB7" → 7. FantasyPros leaves this empty for DST/K on some boards.
      posRank: Number(String(p.pos_rank || '').replace(/\D+/g, '')) || null,
    });
  }
  return {
    // Its own stamp, not ours: the useful question is how stale the ECR is,
    // which a cache-fill time would only answer by accident.
    updated: Number(data.last_updated_ts) * 1000 || null,
    experts: Number(data.total_experts) || null,
    count: players.length,
    players,
  };
}

// ── ESPN Scoreboard ───────────────────────────────────────────────────────────

// Sleeper → ESPN abbreviation overrides for teams that differ between the two
const ESPN_TO_SLEEPER = { WSH: 'WAS' };

// ESPN's WAF blocks unrecognized User-Agents outright (a custom
// "sleeper-helper/1.0" UA started returning 403 — as does an empty UA, and,
// oddly, a spoofed browser one). Known-client UAs are let through, so send a
// plain curl UA. Confirmed by probe: curl/*, okhttp/*, python-requests/*,
// Go-http-client/* all 200; sleeper-helper/1.0, node-fetch/1.0, Mozilla/* 403.
const ESPN_UA = 'curl/8.7.1';

// Both ESPN routes below need the same week's scoreboard events, so fetch them
// once here with a fallback source. site.api is the primary; cdn.espn.com's
// core scoreboard serves the identical event objects under content.sbData and
// sits behind different edge rules, so it covers us if site.api blocks again.
async function fetchEspnEvents(week, season) {
  const sources = [
    {
      name: 'site.api',
      url: `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&dates=${season}`,
      pick: d => d?.events,
    },
    {
      name: 'cdn.espn',
      url: `https://cdn.espn.com/core/nfl/scoreboard?xhr=1&week=${week}&year=${season}&seasontype=2`,
      pick: d => d?.content?.sbData?.events,
    },
  ];

  const problems = [];
  for (const src of sources) {
    try {
      const res = await fetch(src.url, {
        headers: { 'User-Agent': ESPN_UA, 'Accept': 'application/json' },
      });
      if (!res.ok) { problems.push(`${src.name} ${res.status}`); continue; }
      const events = src.pick(await res.json());
      if (Array.isArray(events) && events.length) return { events };
      problems.push(`${src.name} empty`);
    } catch (err) {
      problems.push(`${src.name} ${err.message}`);
    }
  }
  return { events: null, error: problems.join('; ') };
}

async function handleESPNScoreboard(request, env, url) {
  const week   = url.searchParams.get('week')   || '1';
  const season = url.searchParams.get('season') || String(espnSeason());
  return kvCachedJson(env, `espn_scoreboard_${season}_${week}`, {
    ttl: ESPN_TTL,
    load: async () => {
      const { events, error } = await fetchEspnEvents(week, season);
      if (!events) throw new Error(`ESPN upstream error (${error})`);
      return JSON.stringify(espnKickoffsByTeam(events));
    },
  });
}

function espnKickoffsByTeam(events) {
  // Reduce to { SLEEPER_ABBR: isoKickoffString } — all we need client-side
  const games = {};
  for (const event of events) {
    const kickoff = event.date; // ISO 8601 UTC
    for (const competition of (event.competitions || [])) {
      for (const competitor of (competition.competitors || [])) {
        let abbr = competitor.team?.abbreviation;
        if (!abbr) continue;
        abbr = ESPN_TO_SLEEPER[abbr] || abbr;
        games[abbr] = kickoff;
      }
    }
  }
  return games;
}

// ── ESPN Games (with pairings) ────────────────────────────────────────────────

async function handleESPNGames(request, env, url) {
  const week   = url.searchParams.get('week')   || '1';
  const season = url.searchParams.get('season') || String(espnSeason());
  // v2: rows carry state/period/clock/scores (Monday Night Miracle needs to
  // know how much of each game is left). Bumped so a cached v1 row can't hide them.
  return kvCachedJson(env, `espn_games_v2_${season}_${week}`, {
    ttl: ESPN_TTL,
    load: async () => {
      const { events, error } = await fetchEspnEvents(week, season);
      if (!events) throw new Error(`ESPN upstream error (${error})`);
      return JSON.stringify(espnGameRows(events));
    },
  });
}

function espnGameRows(events) {
  const games = [];

  for (const event of events) {
    const kickoff = event.date;
    for (const competition of (event.competitions || [])) {
      const teams = (competition.competitors || []).map(c => {
        let abbr = c.team?.abbreviation || '';
        return ESPN_TO_SLEEPER[abbr] || abbr;
      });
      if (teams.length === 2) {
        const homeComp = competition.competitors.find(c => c.homeAway === 'home');
        const awayComp = competition.competitors.find(c => c.homeAway === 'away');
        let home = homeComp ? (ESPN_TO_SLEEPER[homeComp.team?.abbreviation] || homeComp.team?.abbreviation) : teams[0];
        let away = awayComp ? (ESPN_TO_SLEEPER[awayComp.team?.abbreviation] || awayComp.team?.abbreviation) : teams[1];
        const st = competition.status || event.status || {};
        games.push({
          home, away, kickoff,
          state:  st.type?.state || null,          // 'pre' | 'in' | 'post'
          period: st.period ?? null,
          clock:  st.displayClock || null,
          homeScore: homeComp?.score != null ? Number(homeComp.score) : null,
          awayScore: awayComp?.score != null ? Number(awayComp.score) : null,
        });
      }
    }
  }
  return games;
}

// ── Root For Me — League Preferences ─────────────────────────────────────────

async function handleRootformePrefs(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: CORS });
  }

  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT league_id, value, contender FROM league_preferences WHERE user_id = ?'
    ).bind(user.user_id).all();

    const prefs = {};
    for (const row of (rows.results || [])) {
      prefs[row.league_id] = { value: row.value, contender: row.contender === 1 };
    }
    return jsonBody(JSON.stringify({ prefs }));
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch {
      return new Response('Invalid JSON', { status: 400, headers: CORS });
    }

    const prefs = body.prefs || {};
    const now   = Date.now();
    const stmts = Object.entries(prefs).map(([leagueId, pref]) =>
      env.DB.prepare(
        `INSERT INTO league_preferences (user_id, league_id, value, contender, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, league_id) DO UPDATE
         SET value=excluded.value, contender=excluded.contender, updated_at=excluded.updated_at`
      ).bind(user.user_id, leagueId, pref.value || 0, pref.contender ? 1 : 0, now)
    );

    if (stmts.length) await env.DB.batch(stmts);
    return jsonBody(JSON.stringify({ ok: true }));
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
}

// ── ROI Tracker ───────────────────────────────────────────────────────────────
// One account's ledger: GET returns everything; POST upserts whole rows (the
// client holds the full state, so a row is always sent complete) and applies
// deletes. Per-user data — no-store, credentialed CORS.

const ROI_MAX_STMTS = 3000;

function roiNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function roiInt(v) { const n = roiNum(v); return n === null ? null : Math.round(n); }
function roiId(v) { const s = String(v ?? ''); return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null; }

// ── Ranking sheet from an image (Lineup Checker, beta) ──────────────────────
// The client slices a screenshot of a weekly ranking sheet into its vertical
// column bands and posts ONE band per request; this reads it with a Workers AI
// vision model and hands back the raw tables. All the interpretation (which
// block a header is, which cell is the team vs the opponent, name matching)
// happens client-side, next to the CSV parser it shares a builder with.
//
// Model choice was measured on a real 9-band sheet: Llama 4 Scout and Mistral
// Small 3.1 both returned every row of every table (~25s a band) with only a
// couple of misspelled names, which the client's fuzzy match absorbs. Gemma 4
// was as accurate but ~5x slower. JSON-schema mode was WORSE — both models
// started dropping the optional pos/opp fields — so the output is free-form
// JSON with rows as arrays in printed column order.
const RANKS_IMAGE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const RANKS_IMAGE_MAX   = 4_000_000;   // data-URL chars — one band is ~400KB
// AI Gateway this app's model calls log through (account Nick Lab). Created with
// collect_logs on, cache off, and a gateway-wide 120 req/min sliding rate limit
// as a cost guard — a full sheet is ~9 requests.
const RANKS_IMAGE_GATEWAY = 'sleeper-helper';
const RANKS_IMAGE_PROMPT = `This image is a vertical strip cut from a fantasy football weekly rankings sheet. It holds one or more ranked tables. Each table starts with a header row such as "Rank Quarterback Team Opp Tier", "Rank FLEX Pos Opp", "Rank TEP FLEX Pos Opp", "Rank Defense Opp Tier" or "Rank Kicker Team Opp Tier".
Transcribe EVERY data row exactly as printed, top to bottom, spelling names exactly as printed. Output ONLY JSON, no prose:
{"tables":[{"header":"<header row text, or null if this strip starts mid-table>","rows":[[rank, "name", "team or pos", "opp", tier]]}]}
Each row lists its cells in the order the columns are printed. Use null for a missing cell. Tier is the small number at the right edge (null if the table has no Tier column).`;

async function handleRanksImage(request, env) {
  const cors = getCors(request);
  const res  = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
  if (request.method !== 'POST') return res({ error: 'Method not allowed' }, 405);
  // Every call costs Workers AI usage, so it's for signed-in accounts only.
  const user = await getAuthUser(request, env);
  if (!user) return res({ error: 'Sign in to read a sheet from an image' }, 401);
  if (!env.AI) return res({ error: 'Workers AI is not bound on this worker' }, 500);

  let body;
  try { body = await request.json(); } catch { return res({ error: 'Invalid JSON' }, 400); }
  const image = String(body?.image || '');
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(image)) return res({ error: 'Expected a PNG/JPEG/WebP data URL' }, 400);
  if (image.length > RANKS_IMAGE_MAX) return res({ error: 'Image part too large' }, 413);

  // Routed through the `sleeper-helper` AI Gateway so every read is logged with
  // who made it. Gateway metadata takes at most 5 keys, scalar values only.
  // `sheet` is a per-upload id from the client, so one sheet's ~9 band reads
  // can be found together in the logs; `part` is "3/9".
  const str = (v, n = 64) => String(v ?? '').slice(0, n);
  const metadata = {
    user_id:  user.user_id,
    email:    str(user.email, 120),
    sleeper:  str(user.sleeper_username),
    sheet:    str(body.sheet, 40),
    part:     Number.isInteger(body.part) && Number.isInteger(body.of) ? `${body.part}/${body.of}` : '',
  };

  let out;
  try {
    out = await env.AI.run(RANKS_IMAGE_MODEL, {
      messages: [{ role: 'user', content: [
        { type: 'text', text: RANKS_IMAGE_PROMPT },
        { type: 'image_url', image_url: { url: image } },
      ] }],
      max_tokens: 8000,
      temperature: 0,
    }, {
      // No caching: a retry after a bad read must reach the model again.
      gateway: { id: RANKS_IMAGE_GATEWAY, skipCache: true, metadata },
    });
  } catch (e) {
    return res({ error: 'Image model failed: ' + (e?.message || e) }, 502);
  }

  // The binding has answered in both the OpenAI shape and the classic
  // {response} shape depending on the model, and `response` may already be
  // parsed. Fenced or prose-wrapped JSON is unwrapped to the outermost braces.
  const choice = out?.choices?.[0];
  if (choice?.finish_reason === 'length') return res({ error: 'The model ran out of room reading this part' }, 502);
  const content = choice?.message?.content ?? out?.response;
  let parsed = content && typeof content === 'object' ? content : null;
  if (!parsed && typeof content === 'string') {
    const a = content.indexOf('{'), b = content.lastIndexOf('}');
    try { if (a >= 0 && b > a) parsed = JSON.parse(content.slice(a, b + 1)); } catch { /* fall through */ }
  }
  if (!Array.isArray(parsed?.tables)) {
    return res({ error: 'Could not read a table from this part of the image', raw: String(content || '').slice(0, 300) }, 502);
  }
  return res({ tables: parsed.tables });
}

async function handleRoi(request, env) {
  const cors = getCors(request);
  const res  = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
  const user = await getAuthUser(request, env);
  if (!user) return res({ error: 'Not authenticated' }, 401);
  const uid = user.user_id;

  if (request.method === 'GET') {
    const [lg, ss] = await env.DB.batch([
      env.DB.prepare('SELECT id, name, platform, buy_in, hidden FROM roi_leagues WHERE user_id = ?').bind(uid),
      env.DB.prepare('SELECT league_id, season, ext_id, dues, winnings, finish, auto_finish, auto_of FROM roi_seasons WHERE user_id = ?').bind(uid),
    ]);
    return res({ leagues: lg.results || [], seasons: ss.results || [] });
  }

  if (request.method !== 'POST') return res({ error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return res({ error: 'Invalid JSON' }, 400); }
  const now   = Date.now();
  const stmts = [];

  for (const id of (body.deleteLeagues || [])) {
    const lid = roiId(id);
    if (!lid) continue;
    stmts.push(env.DB.prepare('DELETE FROM roi_seasons WHERE user_id = ? AND league_id = ?').bind(uid, lid));
    stmts.push(env.DB.prepare('DELETE FROM roi_leagues WHERE user_id = ? AND id = ?').bind(uid, lid));
  }
  for (const d of (body.deleteSeasons || [])) {
    const lid = roiId(d?.league_id), yr = roiInt(d?.season);
    if (!lid || yr === null) continue;
    stmts.push(env.DB.prepare('DELETE FROM roi_seasons WHERE user_id = ? AND league_id = ? AND season = ?').bind(uid, lid, yr));
  }
  for (const l of (body.leagues || [])) {
    const id = roiId(l?.id);
    if (!id) continue;
    const name     = String(l.name || '').trim().slice(0, 120) || 'Untitled league';
    const platform = l.platform === 'sleeper' || l.platform === 'espn' ? l.platform : null;
    stmts.push(env.DB.prepare(
      `INSERT INTO roi_leagues (user_id, id, name, platform, buy_in, hidden, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, id) DO UPDATE SET name=excluded.name, platform=excluded.platform,
         buy_in=excluded.buy_in, hidden=excluded.hidden, updated_at=excluded.updated_at`
    ).bind(uid, id, name, platform, roiNum(l.buy_in), l.hidden ? 1 : 0, now));
  }
  for (const s of (body.seasons || [])) {
    const lid = roiId(s?.league_id), yr = roiInt(s?.season);
    if (!lid || yr === null || yr < 1990 || yr > 2100) continue;
    const ext = s.ext_id ? String(s.ext_id).slice(0, 64) : null;
    stmts.push(env.DB.prepare(
      `INSERT INTO roi_seasons (user_id, league_id, season, ext_id, dues, winnings, finish, auto_finish, auto_of, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, league_id, season) DO UPDATE SET ext_id=excluded.ext_id, dues=excluded.dues,
         winnings=excluded.winnings, finish=excluded.finish, auto_finish=excluded.auto_finish,
         auto_of=excluded.auto_of, updated_at=excluded.updated_at`
    ).bind(uid, lid, yr, ext, roiNum(s.dues), roiNum(s.winnings), roiInt(s.finish), roiInt(s.auto_finish), roiInt(s.auto_of), now));
  }

  if (stmts.length > ROI_MAX_STMTS) return res({ error: 'Too many rows in one save' }, 413);
  for (let i = 0; i < stmts.length; i += 100) await env.DB.batch(stmts.slice(i, i + 100));
  return res({ ok: true, written: stmts.length });
}

// ── Dispersal ─────────────────────────────────────────────────────────────────

async function handleDispersal(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  // ['api', 'dispersal']            → create
  // ['api', 'dispersal', id]        → get / delete
  // ['api', 'dispersal', id, action]→ claim / ws

  if (parts.length === 2 && request.method === 'POST') {
    return handleCreateRoom(request, env);
  }

  if (parts.length >= 3) {
    const roomId = parts[2];
    const doId   = env.DISPERSAL_ROOM.idFromName(roomId);
    const stub   = env.DISPERSAL_ROOM.get(doId);
    const res    = await stub.fetch(request);

    // WebSocket upgrade — pass through without modification
    if (res.status === 101) return res;

    // Attach CORS headers to all other DO responses
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }

  return new Response('Not found', { status: 404, headers: CORS });
}

async function handleCreateRoom(request, env) {
  let body;
  try { body = await request.json(); } catch {
    return new Response('Invalid JSON', { status: 400, headers: CORS });
  }

  const roomId          = randId(8);
  const commissionerCode = randId(8);

  const teamSlots = (body.teamSlots || []).map((slot, i) => ({
    ...slot,
    index:        i,
    claimCode:    randId(6),
    sessionToken: null,
    claimed:      false,
  }));

  const room = {
    id:               roomId,
    createdAt:        Date.now(),
    expiresAt:        Date.now() + ROOM_TTL_MS,
    commissionerCode,
    leagueId:         body.leagueId,
    leagueName:       body.leagueName,
    numTeams:         teamSlots.length,
    draftOrder:       body.draftOrder,     // [slotIndex, ...] for round 1
    teamSlots,
    assets:           body.assets,         // sorted by fcValue desc
    rosterPositions:  body.rosterPositions,
    picks:            [],
    currentOverallPick: 1,
    status:           'active',
  };

  const doId = env.DISPERSAL_ROOM.idFromName(roomId);
  const stub = env.DISPERSAL_ROOM.get(doId);
  const initRes = await stub.fetch(new Request('https://do/init', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(room),
  }));

  if (!initRes.ok) {
    return new Response('Failed to initialize room', { status: 500, headers: CORS });
  }

  return jsonBody(JSON.stringify({
    roomId,
    commissionerCode,
    teamSlots: teamSlots.map(({ index, name, rosterId, claimCode }) => ({
      index, name, rosterId, claimCode,
    })),
  }));
}

/** Generates a random alphanumeric ID (no 0/O/I/1 to avoid confusion). */
function randId(len) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(len)))
    .map(b => chars[b % chars.length]).join('');
}

// ── Existing handlers (unchanged) ─────────────────────────────────────────────

async function handlePlayers(env) {
  return kvCachedJson(env, 'players_nfl', {
    ttl: PLAYERS_TTL,
    headers: cacheFor(PLAYERS_BROWSER_TTL, PLAYERS_SWR),
    load: async () => {
      const upstream = await fetch(`${SLEEPER_BASE}/players/nfl`);
      if (!upstream.ok) throw new Error('Upstream error');
      return upstream.text();
    },
  });
}

async function handleGraphQL(request, env) {
  let token  = request.headers.get('Authorization') || '';
  const op   = request.headers.get('X-Sleeper-Graphql-Op') || '';
  const body = await request.text();

  // Fall back to user's stored (encrypted) token when no Authorization header provided
  if (!token && env?.DB && env?.TOKEN_ENCRYPTION_KEY) {
    try {
      const user = await getAuthUser(request, env);
      if (user?.token_enc && user?.token_iv) {
        token = await decryptStoredToken(user.token_enc, user.token_iv, env.TOKEN_ENCRYPTION_KEY);
      }
    } catch(_) {}
  }

  const upstream = await fetch(SLEEPER_GQL, {
    method:  'POST',
    headers: {
      'Content-Type':         'application/json',
      'Accept':               'application/json',
      'Authorization':        token,
      'X-Sleeper-Graphql-Op': op,
      'User-Agent':           'Mozilla/5.0 (compatible; sleeper-helper/1.0)',
      'Origin':               'https://sleeper.com',
      'Referer':              'https://sleeper.com/',
    },
    body,
  });

  const text   = await upstream.text();
  const status = upstream.ok ? 200 : upstream.status;
  // Per-request CORS: a signed-in caller on the ffhistorian.com apex sends its
  // session cookie cross-origin, which the static `*` origin would reject.
  return new Response(text, {
    status,
    headers: { ...getCors(request), 'Content-Type': 'application/json;charset=UTF-8' },
  });
}

// Per-path cache policy for the Sleeper proxy. The default is, and must remain,
// "no cache" — rosters, trades, drafts, users and state all depend on this route
// being a live passthrough. A path opts in only when its content is provably
// slow-moving, and a request carrying ANY query string opts straight back out:
// that's either a cache-buster (lsEnsureLineupData appends ?_=Date.now() to its
// matchup fetches for exactly this reason) or a variant this table doesn't model,
// and ignoring it would also let two different queries collide on one KV key.
const PROXY_CACHE_RULES = [
  // Weekly projections drift as news breaks, but nothing reads them live — every
  // caller here is scoring a whole season at once. Worth a KV copy as well: this
  // is ~70KB x 13 weeks on a cold analyzer load, the second-biggest cost after
  // the player map.
  { re: /^\/projections\/nfl\/[a-z]+\/\d{4}\/\d+$/, browser: 21600, kv: 21600 },
  // Matchups carry in-progress scores, so browser-only and short: long enough
  // that hopping between pages costs nothing, short enough that a live score is
  // never more than a minute behind. No KV copy — it would outlive that window.
  { re: /^\/league\/\d+\/matchups\/\d+$/,           browser: 60 },
  // Season-to-date actual stats — ~1MB of every player's totals, pulled once per
  // Scout run to price players on real PPG rather than projections. It moves only
  // as games finish, so 15 minutes is well inside "current" while keeping a cold
  // run from re-fetching a megabyte per tab.
  { re: /^\/stats\/nfl\/[a-z]+\/\d{4}$/,              browser: 900, kv: 900 },
];

function proxyCacheRule(path) {
  return PROXY_CACHE_RULES.find(r => r.re.test(path)) || null;
}

function isJsonBody(s) {
  try { JSON.parse(s); return true; } catch (_) { return false; }
}

async function handleProxy(url, env) {
  const path = url.pathname.replace('/api/sleeper', '');
  const rule = url.search ? null : proxyCacheRule(path);
  const key  = rule?.kv ? `proxy_${path}` : null;

  if (key && env?.SLEEPER_KV) {
    const hit = await env.SLEEPER_KV.get(key, 'text');
    if (hit) return jsonBody(hit, { 'X-Cache': 'HIT', ...cacheFor(rule.browser, rule.swr || 0) });
  }

  const upstream = await fetch(`${SLEEPER_BASE}${path}${url.search}`, {
    headers: { 'User-Agent': 'sleeper-helper/1.0 (helper.ffhistorian.com)' },
  });
  const body   = await upstream.text();
  const status = upstream.ok ? 200 : upstream.status;

  // Never store a body that isn't the JSON we expect. A 200 carrying an HTML
  // error page would otherwise pin the broken response for the whole TTL — the
  // same trap handleFantasyCalc already guards against.
  if (key && upstream.ok && env?.SLEEPER_KV && isJsonBody(body)) {
    await env.SLEEPER_KV.put(key, body, { expirationTtl: rule.kv });
  }

  return new Response(body, {
    status,
    headers: {
      ...CORS,
      'Content-Type': 'application/json;charset=UTF-8',
      // An error response must never carry a cache lifetime.
      ...(rule && upstream.ok ? cacheFor(rule.browser, rule.swr || 0) : {}),
    },
  });
}

// ── ESPN Fantasy League Settings ──────────────────────────────────────────────

async function handleEspnSettings(request, env) {
  const cors = getCors(request);
  const user = await getAuthUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: cors });
  }

  if (request.method === 'GET') {
    const row = await env.DB.prepare(
      'SELECT league_ids, espn_s2, swid FROM espn_settings WHERE user_id = ?'
    ).bind(user.user_id).first();

    return new Response(JSON.stringify({
      league_ids:      row ? JSON.parse(row.league_ids || '[]') : [],
      has_credentials: !!(row?.espn_s2 && row?.swid),
      // SWID is a per-account identifier used client-side to match `team.primaryOwner`
      // and find "my team" (index.html, analyzer.html, trade-analyzer.html) — safe to
      // return to the authenticated owner of this row, unlike espn_s2 (the real auth
      // cookie), which never leaves the server.
      swid:            row?.swid || null,
    }), { status: 200, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' } });
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch {
      return new Response('Invalid JSON', { status: 400, headers: cors });
    }

    const league_ids = JSON.stringify(Array.isArray(body.league_ids) ? body.league_ids : []);
    const now = Date.now();

    // Only update credentials if non-empty values provided; otherwise preserve existing
    if (body.espn_s2 && body.swid) {
      await env.DB.prepare(
        `INSERT INTO espn_settings (user_id, league_ids, espn_s2, swid, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE
         SET league_ids=excluded.league_ids, espn_s2=excluded.espn_s2, swid=excluded.swid, updated_at=excluded.updated_at`
      ).bind(user.user_id, league_ids, body.espn_s2, body.swid, now).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO espn_settings (user_id, league_ids, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE
         SET league_ids=excluded.league_ids, updated_at=excluded.updated_at`
      ).bind(user.user_id, league_ids, now).run();
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}

// ── ESPN League Discovery (auto-pull the user's leagues) ──────────────────────
//
// ESPN has no documented "list my leagues" endpoint, but the site's own Fan API
// (fan.api.espn.com/apis/v2/fans/{SWID}) returns every fantasy entry the account
// follows — that's what powers the "My Teams" rail on espn.com. Its response
// shape is undocumented and has changed before, so we don't parse it strictly:
// we scrape every numeric `groupId` out of the JSON (that's the league id), then
// VALIDATE each candidate against the real football endpoint. Anything that
// isn't an FFL league for this season, or that these cookies can't read, drops
// out — which also filters basketball/baseball entries for free.
//
// POST /api/espn/discover        body: {espn_s2?, swid?}   ?season=YYYY
//   Credentials come from the body when present (so the profile page can test a
//   freshly pasted pair before saving), else from the stored row.
// → { season, leagues: [{id, name, size, scoringType}], candidates, verified }

async function handleEspnDiscover(request, env, url) {
  const cors = getCors(request);
  const jres = (obj, status = 200) => new Response(JSON.stringify(obj), {
    status, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
  });

  const user = await getAuthUser(request, env);
  if (!user) return jres({ error: 'Not authenticated' }, 401);

  let body = {};
  try { body = await request.json(); } catch {}

  let s2   = (body.espn_s2 || '').trim();
  let swid = (body.swid    || '').trim();
  if (!s2 || !swid) {
    const row = await env.DB.prepare(
      'SELECT espn_s2, swid FROM espn_settings WHERE user_id = ?'
    ).bind(user.user_id).first();
    s2   = s2   || row?.espn_s2 || '';
    swid = swid || row?.swid    || '';
  }
  if (!s2 || !swid) return jres({ error: 'ESPN credentials not configured' }, 400);

  // ESPN writes SWID with braces; people paste it both ways.
  const braced = swid.startsWith('{') ? swid : `{${swid}}`;
  const season = Number(url.searchParams.get('season')) || espnSeason();
  const cookie = `espn_s2=${s2}; SWID=${braced}`;

  // 1. Ask the Fan API what this account follows.
  const fanUrl = `https://fan.api.espn.com/apis/v2/fans/${encodeURIComponent(braced)}`
    + '?featureFlags=expandAthlete&displayEvents=false&displayNow=false&recLimit=0';

  let fan;
  try {
    const r = await fetch(fanUrl, { headers: { Cookie: cookie, Accept: 'application/json' } });
    if (!r.ok) {
      // 404 here is ESPN's "fan not found" — a syntactically fine SWID it has
      // never seen, i.e. almost always a mistyped or partially copied value.
      const msg =
        (r.status === 401 || r.status === 403)
          ? 'ESPN rejected these cookies — they may be expired. Grab a fresh espn_s2 and SWID.'
        : r.status === 404
          ? 'ESPN does not recognize that SWID. Recopy it (braces included) from your browser cookies.'
        : `ESPN returned ${r.status} while listing your leagues.`;
      return jres({ error: msg, status: r.status }, 502);
    }
    fan = await r.json();
  } catch {
    return jres({ error: 'Could not reach ESPN to list your leagues.' }, 502);
  }

  const candidates = [...collectEspnGroupIds(fan)].slice(0, 60);
  if (!candidates.length) return jres({ season, leagues: [], candidates: 0, verified: 0 });

  // 2. Keep only the ones that are readable FFL leagues this season.
  const checks = await Promise.all(candidates.map(async id => {
    try {
      const r = await fetch(
        `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}`
        + `/segments/0/leagues/${id}?view=mSettings`,
        { headers: { Cookie: cookie, 'User-Agent': 'sleeper-helper/1.0' } }
      );
      if (!r.ok) return null;
      const d = await r.json();
      const name = d?.settings?.name;
      if (!name) return null;
      return {
        id:          String(id),
        name,
        size:        d?.settings?.size ?? null,
        scoringType: d?.settings?.scoringSettings?.scoringType || null,
      };
    } catch { return null; }
  }));

  const leagues = checks.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  return jres({ season, leagues, candidates: candidates.length, verified: leagues.length });
}

// Recursively pull every plausible league id out of the Fan API blob, without
// depending on where ESPN nests it this month. Bounded depth/size so a cyclic or
// pathological payload can't spin the worker.
function collectEspnGroupIds(node, out = new Set(), depth = 0) {
  if (!node || depth > 8 || out.size > 200) return out;
  if (Array.isArray(node)) {
    for (const v of node) collectEspnGroupIds(v, out, depth + 1);
    return out;
  }
  if (typeof node !== 'object') return out;
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'groupId' || k === 'leagueId') && (typeof v === 'number' || typeof v === 'string')) {
      const n = Number(v);
      if (Number.isInteger(n) && n > 0) out.add(n);
    } else if (v && typeof v === 'object') {
      collectEspnGroupIds(v, out, depth + 1);
    }
  }
  return out;
}

// ESPN's fantasy football season rolls over with the NFL year, not the calendar
// year — January through May still belongs to the previous season's leagues.
function espnSeason(now = new Date()) {
  return now.getMonth() < 5 ? now.getFullYear() - 1 : now.getFullYear();
}


// ── ESPN Fantasy Proxy (uses stored credentials) ───────────────────────────────

async function handleEspnFantasy(request, env, url) {
  const cors = getCors(request);
  const user = await getAuthUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: cors });
  }

  const row = await env.DB.prepare(
    'SELECT espn_s2, swid FROM espn_settings WHERE user_id = ?'
  ).bind(user.user_id).first();

  if (!row?.espn_s2 || !row?.swid) {
    return new Response(JSON.stringify({ error: 'ESPN credentials not configured' }), { status: 400, headers: cors });
  }

  // /api/espn/fantasy/{leagueId} → lm-api-reads.fantasy.espn.com/.../{leagueId}
  const leagueId = url.pathname.replace('/api/espn/fantasy/', '').split('/')[0];
  const espnUrl  = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${url.searchParams.get('seasonId') || new Date().getFullYear()}/segments/0/leagues/${leagueId}?${url.searchParams.toString()}`;

  // ESPN's player-pool views (e.g. kona_player_info) only return a small
  // default slice unless a client-provided filter header narrows/expands it.
  const fantasyFilter = request.headers.get('X-Fantasy-Filter');

  const upstream = await fetch(espnUrl, {
    headers: {
      'Cookie':     `espn_s2=${row.espn_s2}; SWID=${row.swid}`,
      'User-Agent': 'sleeper-helper/1.0',
      ...(fantasyFilter ? { 'x-fantasy-filter': fantasyFilter } : {}),
    },
  });

  const text   = await upstream.text();
  const status = upstream.ok ? 200 : upstream.status;
  return new Response(text, {
    status,
    headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
  });
}

