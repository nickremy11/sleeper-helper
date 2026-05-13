/**
 * Sleeper Helper — Cloudflare Worker
 *
 * Routes:
 *   GET  /api/players             → KV-cached player map (2h TTL)
 *   GET  /api/sleeper/*           → live proxy to api.sleeper.app (no cache)
 *   POST /api/graphql             → proxy to sleeper.com/graphql (authenticated)
 *   GET  /api/fantasycalc         → FantasyCalc values (KV-cached 24h)
 *   POST /api/dispersal           → create dispersal room
 *   *    /api/dispersal/:id/*     → forward to DispersalRoom Durable Object
 *
 * KV binding:      SLEEPER_KV
 * DO binding:      DISPERSAL_ROOM
 */

export { DispersalRoom } from './dispersal.js';

const SLEEPER_BASE  = 'https://api.sleeper.app/v1';
const SLEEPER_GQL   = 'https://sleeper.com/graphql';
const FC_URL        = 'https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&ppr=1&includePickValues=true';
const PLAYERS_TTL   = 60 * 60 * 2;   // 2 hours
const FC_TTL        = 60 * 60 * 24;  // 24 hours
const ROOM_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Sleeper-Graphql-Op',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/players' && request.method === 'GET') {
      return handlePlayers(env);
    }

    if (url.pathname.startsWith('/api/sleeper/') && request.method === 'GET') {
      return handleProxy(url);
    }

    if (url.pathname === '/api/graphql' && request.method === 'POST') {
      return handleGraphQL(request);
    }

    if (url.pathname === '/api/fantasycalc' && request.method === 'GET') {
      return handleFantasyCalc(env);
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

  return jsonRes({
    roomId,
    commissionerCode,
    teamSlots: teamSlots.map(({ index, name, rosterId, claimCode }) => ({
      index, name, rosterId, claimCode,
    })),
  });
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

async function handleGraphQL(request) {
  const token = request.headers.get('Authorization') || '';
  const op    = request.headers.get('X-Sleeper-Graphql-Op') || '';
  const body  = await request.text();

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
