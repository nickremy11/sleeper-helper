/**
 * Sleeper Helper — Cloudflare Worker
 *
 * Routes:
 *   POST /api/auth/register       → create account
 *   POST /api/auth/login          → login, set session cookie
 *   GET  /api/auth/me             → current user (session cookie)
 *   PATCH /api/auth/me            → update sleeper_username / stored token
 *   POST /api/auth/logout         → clear session
 *   GET  /api/players             → KV-cached player map (2h TTL)
 *   GET  /api/sleeper/*           → live proxy to api.sleeper.app (no cache)
 *   POST /api/graphql             → proxy to sleeper.com/graphql (authenticated)
 *   GET  /api/fantasycalc         → FantasyCalc values (KV-cached 24h)
 *   GET  /api/espn/scoreboard     → NFL week schedule: team → kickoff ISO (KV-cached 5m)
 *   GET  /api/espn/games          → NFL week games with pairings [{home,away,kickoff}] (KV-cached 5m)
 *   GET  /api/espn/settings       → get ESPN league IDs + credential status (auth required)
 *   POST /api/espn/settings       → save ESPN league IDs + credentials (auth required)
 *   GET  /api/espn/fantasy/:id    → proxy ESPN fantasy API using stored credentials (auth required)
 *   GET  /api/rootforme/prefs     → get league preferences for logged-in user
 *   POST /api/rootforme/prefs     → save league preferences for logged-in user
 *   POST /api/dispersal           → create dispersal room
 *   *    /api/dispersal/:id/*     → forward to DispersalRoom Durable Object
 *
 * KV binding:      SLEEPER_KV
 * D1 binding:      DB
 * DO binding:      DISPERSAL_ROOM
 * Secret:          TOKEN_ENCRYPTION_KEY  (base64 AES-256 key)
 */

export { DispersalRoom } from './dispersal.js';
import { handleAuth, getAuthUser, decryptStoredToken } from './auth.js';

const SLEEPER_BASE  = 'https://api.sleeper.app/v1';
const SLEEPER_GQL   = 'https://sleeper.com/graphql';
const FC_URL        = 'https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&ppr=1&includePickValues=true';
const PLAYERS_TTL   = 60 * 60 * 2;   // 2 hours
const FC_TTL        = 60 * 60 * 24;  // 24 hours
const ESPN_TTL      = 60 * 5;        // 5 minutes (game times are stable but scores update live)
const ROOM_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days
const ALLOWED_ORIGINS = new Set([
  'https://ffhistorian.com',
  'https://helper.ffhistorian.com',
  'https://projections.ffhistorian.com',
]);
const PROJ_SEASON_DEFAULT = 2026;

function getCors(request) {
  const origin = (request && request.headers.get('Origin')) || '';
  const allow  = ALLOWED_ORIGINS.has(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin':      allow,
    'Access-Control-Allow-Credentials': allow !== '*' ? 'true' : 'false',
    'Access-Control-Allow-Methods':     'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Sleeper-Graphql-Op',
  };
}

// Backwards-compat alias used by static references below
const CORS = getCors(null);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
      return handleProxy(url);
    }

    if (url.pathname === '/api/graphql' && request.method === 'POST') {
      return handleGraphQL(request, env);
    }

    if (url.pathname === '/api/fantasycalc' && request.method === 'GET') {
      return handleFantasyCalc(env);
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

    if (url.pathname.startsWith('/api/espn/fantasy/') && request.method === 'GET') {
      return handleEspnFantasy(request, env, url);
    }

    if (url.pathname === '/api/rootforme/prefs') {
      return handleRootformePrefs(request, env);
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

async function handleFantasyCalc(env) {
  const cached = await env.SLEEPER_KV.getWithMetadata('fc_values', 'text');

  if (cached.value) {
    const age = cached.metadata?.cachedAt
      ? Math.floor((Date.now() - cached.metadata.cachedAt) / 1000)
      : 0;
    return jsonRes(cached.value, { 'X-Cache': 'HIT', 'X-Cache-Age': String(age) });
  }

  const upstream = await fetch(FC_URL, { headers: { 'User-Agent': 'sleeper-helper/1.0' } });
  if (!upstream.ok) {
    return new Response('FantasyCalc upstream error', { status: 502, headers: CORS });
  }

  const body = await upstream.text();
  await env.SLEEPER_KV.put('fc_values', body, {
    expirationTtl: FC_TTL,
    metadata: { cachedAt: Date.now() },
  });

  return jsonRes(body, { 'X-Cache': 'MISS' });
}

// ── ESPN Scoreboard ───────────────────────────────────────────────────────────

// Sleeper → ESPN abbreviation overrides for teams that differ between the two
const ESPN_TO_SLEEPER = { WSH: 'WAS' };

async function handleESPNScoreboard(request, env, url) {
  const week   = url.searchParams.get('week')   || '1';
  const season = url.searchParams.get('season') || '2025';
  const key    = `espn_scoreboard_${season}_${week}`;

  const cached = await env.SLEEPER_KV.getWithMetadata(key, 'text');
  if (cached.value) {
    return jsonRes(cached.value, { 'X-Cache': 'HIT' });
  }

  const espnUrl = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&dates=${season}`;
  const upstream = await fetch(espnUrl, { headers: { 'User-Agent': 'sleeper-helper/1.0' } });
  if (!upstream.ok) {
    return new Response('ESPN upstream error', { status: 502, headers: CORS });
  }

  const data = await upstream.json();

  // Reduce to { SLEEPER_ABBR: isoKickoffString } — all we need client-side
  const games = {};
  for (const event of (data.events || [])) {
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

  const body = JSON.stringify(games);
  await env.SLEEPER_KV.put(key, body, {
    expirationTtl: ESPN_TTL,
    metadata: { cachedAt: Date.now() },
  });

  return jsonRes(body, { 'X-Cache': 'MISS' });
}

// ── ESPN Games (with pairings) ────────────────────────────────────────────────

async function handleESPNGames(request, env, url) {
  const week   = url.searchParams.get('week')   || '1';
  const season = url.searchParams.get('season') || '2025';
  const key    = `espn_games_${season}_${week}`;

  const cached = await env.SLEEPER_KV.getWithMetadata(key, 'text');
  if (cached.value) {
    return jsonRes(cached.value, { 'X-Cache': 'HIT' });
  }

  const espnUrl = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${week}&seasontype=2&dates=${season}`;
  const upstream = await fetch(espnUrl, { headers: { 'User-Agent': 'sleeper-helper/1.0' } });
  if (!upstream.ok) {
    return new Response('ESPN upstream error', { status: 502, headers: CORS });
  }

  const data  = await upstream.json();
  const games = [];

  for (const event of (data.events || [])) {
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
        games.push({ home, away, kickoff });
      }
    }
  }

  const body = JSON.stringify(games);
  await env.SLEEPER_KV.put(key, body, {
    expirationTtl: ESPN_TTL,
    metadata: { cachedAt: Date.now() },
  });

  return jsonRes(body, { 'X-Cache': 'MISS' });
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
    return jsonRes(JSON.stringify({ prefs }));
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
    return jsonRes(JSON.stringify({ ok: true }));
  }

  return new Response('Method not allowed', { status: 405, headers: CORS });
}

// ── Projections (projections.ffhistorian.com) ─────────────────────────────────

async function handleProjections(request, env, url) {
  const cors = getCors(request);
  const sub  = url.pathname.replace('/api/projections', '').replace(/^\//, ''); // players | teams | ppg | sync-sheets

  // Sheets sync needs no DB/auth coupling beyond an authenticated user.
  if (sub === 'sync-sheets' && request.method === 'POST') {
    return handleProjSyncSheets(request, env, cors);
  }

  const user = await getAuthUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  const season = Number(url.searchParams.get('season')) || PROJ_SEASON_DEFAULT;

  if (sub === 'players')  return handleProjPlayers(request, env, cors, user, season);
  if (sub === 'teams')    return handleProjTeams(request, env, cors, user, season);
  if (sub === 'ppg')      return handleProjPpg(request, env, cors, user, season);

  return new Response('Not found', { status: 404, headers: cors });
}

function projJson(body, cors, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
  });
}

async function handleProjPlayers(request, env, cors, user, season) {
  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT player_name, nfl_team, position, inputs, calc_ppg, calc_pts, rank_2025
       FROM player_projections WHERE user_id = ? AND season = ?`
    ).bind(user.user_id, season).all();

    const players = (rows.results || []).map(r => ({
      player_name: r.player_name,
      nfl_team:    r.nfl_team,
      position:    r.position,
      inputs:      safeParse(r.inputs, {}),
      calc_ppg:    r.calc_ppg,
      calc_pts:    r.calc_pts,
      rank_2025:   r.rank_2025,
    }));
    return projJson({ players, season }, cors);
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: cors }); }
    const players = Array.isArray(body.players) ? body.players : [];
    const now = Date.now();

    // Optional scoped replace: when `replaceTeam` is set, clear that team's roster
    // first so removed players don't linger.
    const stmts = [];
    if (body.replaceTeam) {
      stmts.push(env.DB.prepare(
        'DELETE FROM player_projections WHERE user_id = ? AND season = ? AND nfl_team = ?'
      ).bind(user.user_id, season, body.replaceTeam));
    }

    for (const p of players) {
      if (!p.player_name || !p.position) continue;
      stmts.push(env.DB.prepare(
        `INSERT INTO player_projections
           (user_id, player_name, nfl_team, position, season, inputs, calc_ppg, calc_pts, rank_2025, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, player_name, season) DO UPDATE SET
           nfl_team=excluded.nfl_team, position=excluded.position, inputs=excluded.inputs,
           calc_ppg=excluded.calc_ppg, calc_pts=excluded.calc_pts, rank_2025=excluded.rank_2025,
           updated_at=excluded.updated_at`
      ).bind(
        user.user_id, p.player_name, p.nfl_team || '', p.position, season,
        JSON.stringify(p.inputs || {}),
        p.calc_ppg ?? null, p.calc_pts ?? null, p.rank_2025 ?? null, now
      ));
    }

    // Chunk batches to stay well under D1 limits.
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
    return projJson({ ok: true, saved: players.length }, cors);
  }

  if (request.method === 'DELETE') {
    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: cors }); }
    if (!body.player_name) return new Response('player_name required', { status: 400, headers: cors });
    await env.DB.prepare(
      'DELETE FROM player_projections WHERE user_id = ? AND season = ? AND player_name = ?'
    ).bind(user.user_id, season, body.player_name).run();
    return projJson({ ok: true }, cors);
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}

async function handleProjTeams(request, env, cors, user, season) {
  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT nfl_team, inputs FROM team_projections WHERE user_id = ? AND season = ?'
    ).bind(user.user_id, season).all();

    const teams = {};
    for (const r of (rows.results || [])) teams[r.nfl_team] = safeParse(r.inputs, {});
    return projJson({ teams, season }, cors);
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: cors }); }
    const teams = body.teams || {};
    const now = Date.now();
    const stmts = Object.entries(teams).map(([team, inputs]) =>
      env.DB.prepare(
        `INSERT INTO team_projections (user_id, nfl_team, season, inputs, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, nfl_team, season) DO UPDATE
         SET inputs=excluded.inputs, updated_at=excluded.updated_at`
      ).bind(user.user_id, team, season, JSON.stringify(inputs || {}), now)
    );
    if (stmts.length) await env.DB.batch(stmts);
    return projJson({ ok: true }, cors);
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}

async function handleProjPpg(request, env, cors, user, season) {
  const rows = await env.DB.prepare(
    'SELECT player_name, calc_ppg FROM player_projections WHERE user_id = ? AND season = ?'
  ).bind(user.user_id, season).all();
  const map = {};
  for (const r of (rows.results || [])) {
    if (r.calc_ppg != null) map[r.player_name] = r.calc_ppg;
  }
  return projJson(map, cors);
}

/**
 * Fetches a public Google Sheets tab as CSV and returns the raw text.
 * The browser can't fetch the export URL directly (cross-origin redirect to
 * googleusercontent), so the worker proxies it.
 */
const PROJ_NFL_FULL_NAMES = {
  ARI:'Arizona Cardinals', ATL:'Atlanta Falcons', BAL:'Baltimore Ravens', BUF:'Buffalo Bills',
  CAR:'Carolina Panthers', CHI:'Chicago Bears', CIN:'Cincinnati Bengals', CLE:'Cleveland Browns',
  DAL:'Dallas Cowboys', DEN:'Denver Broncos', DET:'Detroit Lions', GB:'Green Bay Packers',
  HOU:'Houston Texans', IND:'Indianapolis Colts', JAX:'Jacksonville Jaguars', KC:'Kansas City Chiefs',
  LV:'Las Vegas Raiders', LAC:'Los Angeles Chargers', LAR:'Los Angeles Rams', MIA:'Miami Dolphins',
  MIN:'Minnesota Vikings', NE:'New England Patriots', NO:'New Orleans Saints', NYG:'New York Giants',
  NYJ:'New York Jets', PHI:'Philadelphia Eagles', PIT:'Pittsburgh Steelers', SF:'San Francisco 49ers',
  SEA:'Seattle Seahawks', TB:'Tampa Bay Buccaneers', TEN:'Tennessee Titans', WAS:'Washington Commanders',
};

async function projFetchSheetTab(sheetId, tabName) {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'sleeper-helper/1.0' }, redirect: 'follow' });
    if (!r.ok) return null;
    const text = await r.text();
    if (!text || text.length < 50 || text.includes('<!DOCTYPE') || text.includes('google.visualization') || text.includes('Table has no columns')) return null;
    return text;
  } catch { return null; }
}

async function handleProjSyncSheets(request, env, cors) {
  const user = await getAuthUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: cors }); }
  if (!body.sheetId) return new Response('sheetId required', { status: 400, headers: cors });

  // Bulk fetch all 32 team tabs
  if (body.action === 'fetch-all') {
    const nameMap = body.teamNames || PROJ_NFL_FULL_NAMES;
    const results = {};
    await Promise.all(Object.entries(nameMap).map(async ([abbr, name]) => {
      const csv = await projFetchSheetTab(body.sheetId, name);
      results[abbr] = csv || null;
    }));
    return projJson({ ok: true, teams: results }, cors);
  }

  // Single tab fetch: prefer sheetName (by tab name), fall back to gid
  let csv;
  if (body.sheetName) {
    csv = await projFetchSheetTab(body.sheetId, body.sheetName);
    if (!csv) return projJson({ error: `Tab "${body.sheetName}" not found or empty` }, cors, 404);
  } else {
    const gid = body.gid != null ? String(body.gid) : '0';
    const exportUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(body.sheetId)}/export?format=csv&gid=${encodeURIComponent(gid)}`;
    const upstream = await fetch(exportUrl, { headers: { 'User-Agent': 'sleeper-helper/1.0' }, redirect: 'follow' });
    if (!upstream.ok) return projJson({ error: 'Sheet fetch failed', status: upstream.status }, cors, 502);
    csv = await upstream.text();
  }
  return projJson({ ok: true, csv }, cors);
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
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

  return jsonRes(JSON.stringify({
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
  const cached = await env.SLEEPER_KV.getWithMetadata('players_nfl', 'text');

  if (cached.value) {
    const age = cached.metadata?.cachedAt
      ? Math.floor((Date.now() - cached.metadata.cachedAt) / 1000)
      : 0;
    return jsonRes(cached.value, { 'X-Cache': 'HIT', 'X-Cache-Age': String(age) });
  }

  const upstream = await fetch(`${SLEEPER_BASE}/players/nfl`);
  if (!upstream.ok) {
    return new Response('Upstream error', { status: 502, headers: CORS });
  }

  const body = await upstream.text();
  await env.SLEEPER_KV.put('players_nfl', body, {
    expirationTtl: PLAYERS_TTL,
    metadata: { cachedAt: Date.now() },
  });

  return jsonRes(body, { 'X-Cache': 'MISS' });
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
  return new Response(text, {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8' },
  });
}

async function handleProxy(url) {
  const path     = url.pathname.replace('/api/sleeper', '');
  const upstream = await fetch(`${SLEEPER_BASE}${path}${url.search}`, {
    headers: { 'User-Agent': 'sleeper-helper/1.0 (helper.ffhistorian.com)' },
  });
  const body   = await upstream.text();
  const status = upstream.ok ? 200 : upstream.status;
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8' },
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

  const upstream = await fetch(espnUrl, {
    headers: {
      'Cookie':     `espn_s2=${row.espn_s2}; SWID=${row.swid}`,
      'User-Agent': 'sleeper-helper/1.0',
    },
  });

  const text   = await upstream.text();
  const status = upstream.ok ? 200 : upstream.status;
  return new Response(text, {
    status,
    headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
  });
}

function jsonRes(body, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8', ...extra },
  });
}
