/**
 * Sleeper Helper — Cloudflare Worker
 *
 * Routes:
 *   GET  /api/players        → KV-cached player map (2h TTL)
 *   GET  /api/sleeper/*      → live proxy to api.sleeper.app (no cache)
 *   POST /api/graphql        → proxy to sleeper.com/graphql (authenticated)
 *
 * KV binding: SLEEPER_KV  (configure id in wrangler.toml)
 */

const SLEEPER_BASE    = 'https://api.sleeper.app/v1';
const SLEEPER_GQL     = 'https://sleeper.com/graphql';
const PLAYERS_TTL     = 60 * 60 * 2;   // 2 hours
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

    return new Response('Not found', { status: 404 });
  },
};

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
  // Pull the auth token and op name from the incoming request headers
  const token = request.headers.get('Authorization') || '';
  const op    = request.headers.get('X-Sleeper-Graphql-Op') || '';
  const body  = await request.text();

  const upstream = await fetch(SLEEPER_GQL, {
    method:  'POST',
    headers: {
      'Content-Type':           'application/json',
      'Accept':                 'application/json',
      'Authorization':          token,
      'X-Sleeper-Graphql-Op':   op,
      'User-Agent':             'Mozilla/5.0 (compatible; sleeper-helper/1.0)',
      'Origin':                 'https://sleeper.com',
      'Referer':                'https://sleeper.com/',
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
  const path       = url.pathname.replace('/api/sleeper', '');
  const upstream   = await fetch(`${SLEEPER_BASE}${path}${url.search}`, {
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
