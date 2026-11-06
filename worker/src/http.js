// Response helpers shared by every helper Worker route.

const ALLOWED_ORIGINS = new Set([
  'https://ffhistorian.com',
  'https://helper.ffhistorian.com',
  'https://projections.ffhistorian.com',
  'https://myranks.ffhistorian.com',
]);

export function getCors(request) {
  const origin = (request && request.headers.get('Origin')) || '';
  const allow  = ALLOWED_ORIGINS.has(origin) ? origin : '*';
  return {
    'Access-Control-Allow-Origin':      allow,
    'Access-Control-Allow-Credentials': allow !== '*' ? 'true' : 'false',
    'Access-Control-Allow-Methods':     'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Sleeper-Graphql-Op, X-Fantasy-Filter',
  };
}

// The static *-origin block, for responses that are identical for every caller.
export const CORS = getCors(null);

export function cacheFor(maxAge, swr = 0) {
  return { 'Cache-Control': `public, max-age=${maxAge}${swr ? `, stale-while-revalidate=${swr}` : ''}` };
}

// A response whose body is already a JSON string.
export function jsonBody(body, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8', ...extra },
  });
}

// Serve one shared upstream feed out of KV. `load` returns the body string to
// cache, or throws to answer 502 without caching anything, so one bad fetch can't
// break every caller for the whole TTL. `headers` go on hits and misses alike.
export async function kvCachedJson(env, key, { ttl, headers = {}, load }) {
  const cached = await env.SLEEPER_KV.getWithMetadata(key, 'text');
  if (cached.value) {
    const age = cached.metadata?.cachedAt ? Math.floor((Date.now() - cached.metadata.cachedAt) / 1000) : 0;
    return jsonBody(cached.value, { 'X-Cache': 'HIT', 'X-Cache-Age': String(age), ...headers });
  }
  let body;
  try {
    body = await load();
  } catch (e) {
    return new Response(e?.message || 'Upstream error', { status: 502, headers: CORS });
  }
  await env.SLEEPER_KV.put(key, body, { expirationTtl: ttl, metadata: { cachedAt: Date.now() } });
  return jsonBody(body, { 'X-Cache': 'MISS', ...headers });
}
