/**
 * Sleeper Helper — Cloudflare Worker
 *
 * Routes:
 *   GET /api/players        → KV-cached player map (2h TTL)
 *   GET /api/sleeper/*      → live proxy to api.sleeper.app (no cache)
 *
 * KV binding: SLEEPER_KV  (configure id in wrangler.toml)
 */

const SLEEPER_BASE  = 'https://api.sleeper.app/v1';
const PLAYERS_TTL   = 60 * 60 * 2;   // 2 hours — player names/teams change rarely
const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (url.pathname === '/api/players') {
      return handlePlayers(env);
    }

    if (url.pathname.startsWith('/api/sleeper/')) {
      return handleProxy(url);
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
