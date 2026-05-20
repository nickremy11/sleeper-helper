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
  'https://rootforme.ffhistorian.com',
]);

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
      const authResp = await handleAuth(request, env, url);
      const cors     = getCors(request);
      const h        = new Headers(authResp.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(authResp.body, { status: authResp.status, headers: h });
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

    if (url.pathname === '/api/rootforme/prefs') {
      return handleRootformePrefs(request, env);
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

function jsonRes(body, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8', ...extra },
  });
}
