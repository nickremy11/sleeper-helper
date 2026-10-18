/**
 * data.ffhistorian.com — Site Lead only player-season stats explorer.
 *
 * The whole hostname is served by this Worker (custom domain, see wrangler.toml),
 * so the is_admin check runs BEFORE any HTML or data leaves — a non-admin gets
 * the sign-in card, never the page. That is why this page lives in worker/src/
 * instead of pages/: Pages would serve the HTML to anyone.
 *
 *   GET  /                  → the explorer page (admin) / sign-in card (everyone else)
 *   GET  /api/data/rows     → every stored player-season row (?season= optional)
 *   POST /api/data/import   → upsert a chunk of rows, MERGING into existing data
 *   POST /api/data/delete   → drop one {source, season} slice
 *   GET  /api/data/nflverse → nflverse season stats CSV for ?season= (raw pass-through)
 *   POST /api/data/sumer    → SumerSports man/zone receiving table (raw pass-through)
 *
 * Same-origin only — no CORS headers, so nothing else can read these responses.
 * POSTs are protected by the session cookie's SameSite=Strict.
 */

import { requireAdmin } from './auth.js';
import DATA_PAGE_HTML from './data-page.html';

const SOURCES        = new Set(['pp', 'nflverse', 'sumer']);   // PlayerProfiler, nflverse, SumerSports
const MAX_IMPORT     = 500;                           // rows per POST — the page chunks below this
const MAX_ROW_BYTES  = 20000;

const NO_STORE = { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json;charset=UTF-8', ...NO_STORE },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status, headers: { 'Content-Type': 'text/html;charset=UTF-8', ...NO_STORE },
  });
}

const GATE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Data Room</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5ead6;color:#1a1008;
       font-family:Georgia,serif;padding:16px;box-sizing:border-box}
  .c{background:#2a1a0e;border:2px solid #c9962a;padding:32px;max-width:420px;text-align:center;color:#e8d5b0}
  a{display:inline-block;margin-top:16px;background:#2d4a1e;border:2px solid #c9962a;color:#e8b84b;
    padding:10px 22px;text-decoration:none;letter-spacing:.12em;text-transform:uppercase;font-size:.8rem}
</style></head><body><div class="c">
<p>This page is restricted to the Site Lead account.</p>
<p style="opacity:.75;font-size:.9rem">Sign in on helper.ffhistorian.com, then reload this page.</p>
<a href="https://helper.ffhistorian.com/">Sign in</a>
</div></body></html>`;

export async function handleDataSite(request, env, url) {
  const isAdmin = await requireAdmin(request, env);
  const path = url.pathname;

  if (path.startsWith('/api/data/')) {
    if (!isAdmin) return json({ error: 'Not authorized' }, 401);
    if (path === '/api/data/rows'   && request.method === 'GET')  return listRows(env, url);
    if (path === '/api/data/import' && request.method === 'POST') return importRows(request, env);
    if (path === '/api/data/delete' && request.method === 'POST') return deleteSlice(request, env);
    if (path === '/api/data/nflverse' && request.method === 'GET') return nflverseCsv(url);
    if (path === '/api/data/sumer'    && request.method === 'POST') return sumerTable(request);
    return json({ error: 'Not found' }, 404);
  }

  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  if (path === '/' || path === '/index.html') {
    return isAdmin ? html(DATA_PAGE_HTML) : html(GATE_HTML, 401);
  }
  return new Response('Not found', { status: 404, headers: NO_STORE });
}

// The response is assembled by string concatenation around the stored `data`
// text rather than JSON.parse → JSON.stringify on every row: a full multi-season
// pull is several MB, and re-parsing it all is the one thing here that could
// blow a Worker CPU budget. `data` is only ever written by importRows() below,
// from JSON.stringify, so it is known-valid JSON.
async function listRows(env, url) {
  const season = parseInt(url.searchParams.get('season'), 10);
  const stmt = Number.isFinite(season)
    ? env.DB.prepare('SELECT source, season, player_key, name, position, data FROM data_player_seasons WHERE season = ?').bind(season)
    : env.DB.prepare('SELECT source, season, player_key, name, position, data FROM data_player_seasons');
  const { results } = await stmt.all();
  const body = '{"rows":[' + results.map(r =>
    '{"source":' + JSON.stringify(r.source) +
    ',"season":' + r.season +
    ',"key":'    + JSON.stringify(r.player_key) +
    ',"name":'   + JSON.stringify(r.name) +
    ',"pos":'    + JSON.stringify(r.position) +
    ',"data":'   + r.data + '}'
  ).join(',') + ']}';
  return new Response(body, { headers: { 'Content-Type': 'application/json;charset=UTF-8', ...NO_STORE } });
}

// MERGE, not replace: json_patch lays the new object over the stored one, so two
// PlayerProfiler reports for the same season (say a receiving and a rushing
// export) build up one row, and re-importing a file is idempotent. The page
// never sends empty cells, so a sparse later file can't blank out a value an
// earlier one supplied. To genuinely remove values, delete the slice and re-import.
async function importRows(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const source = body?.source;
  const rows   = body?.rows;
  if (!SOURCES.has(source)) return json({ error: 'Unknown source' }, 400);
  if (!Array.isArray(rows) || !rows.length) return json({ error: 'No rows' }, 400);
  if (rows.length > MAX_IMPORT) return json({ error: `At most ${MAX_IMPORT} rows per request` }, 400);

  const now = Date.now();
  const stmts = [];
  for (const r of rows) {
    const season = parseInt(r?.season, 10);
    const key    = typeof r?.key  === 'string' ? r.key.trim()  : '';
    const name   = typeof r?.name === 'string' ? r.name.trim() : '';
    const pos    = typeof r?.pos  === 'string' ? r.pos.trim().toUpperCase() : null;
    if (!(season >= 1999 && season <= 2100) || !key || key.length > 120 || !name || name.length > 120) {
      return json({ error: `Bad row: ${JSON.stringify(r).slice(0, 120)}` }, 400);
    }
    if (!r.data || typeof r.data !== 'object' || Array.isArray(r.data)) {
      return json({ error: `Row ${name} ${season} has no data object` }, 400);
    }
    const data = JSON.stringify(r.data);
    if (data.length > MAX_ROW_BYTES) return json({ error: `Row ${name} ${season} is too large` }, 400);
    stmts.push(env.DB.prepare(
      `INSERT INTO data_player_seasons (source, season, player_key, name, position, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, season, player_key) DO UPDATE SET
         name = excluded.name, position = excluded.position,
         data = json_patch(data_player_seasons.data, excluded.data),
         updated_at = excluded.updated_at`
    ).bind(source, season, key, name, pos, data, now));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, written: stmts.length });
}

// Raw pass-through of nflverse's per-season regular-season player stats CSV
// (~800KB). Parsed and mapped in the page (parseNflverse) so the Worker does no
// CSV work; same-origin, which is the only reason this proxy exists (GitHub's
// release downloads send no CORS headers).
async function nflverseCsv(url) {
  const season = parseInt(url.searchParams.get('season'), 10);
  if (!(season >= 1999 && season <= 2100)) return json({ error: 'Need season' }, 400);
  const src = `https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_reg_${season}.csv`;
  const r = await fetch(src, { cf: { cacheTtl: 6 * 3600, cacheEverything: true } });
  if (r.status === 404) return json({ error: `nflverse has no ${season} file` }, 404);
  if (!r.ok) return json({ error: `nflverse HTTP ${r.status}` }, 502);
  return new Response(r.body, { headers: { 'Content-Type': 'text/csv;charset=UTF-8', ...NO_STORE } });
}

// SumerSports' player tables load through a Next.js server action: a POST to
// the position page with a `next-action` header naming the action. That id is
// the one fragile part — Sumer mints a new one when it redeploys — so the page
// supplies it (pasted from a "Copy as cURL" of Sumer's own request) instead of
// it being hardcoded here. Body args, as captured from sumersports.com:
//   [page, season, limit, sort, {manZone:[VS_MAN|VS_ZONE]}, minPlays]
// minPlays 1 = everyone; the site's own default of 10 drops part-time players.
// Coverage splits exist 2022 onward; earlier seasons return no rows.
const SUMER_PAGES  = new Set(['wide-receiver', 'tight-end', 'running-back']);
const SUMER_COVS   = new Set(['VS_MAN', 'VS_ZONE']);
const SUMER_LIMIT  = 500;
async function sumerTable(request) {
  let b;
  try { b = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const season = parseInt(b?.season, 10);
  if (!SUMER_PAGES.has(b?.page) || !SUMER_COVS.has(b?.cov) || !(season >= 2000 && season <= 2100)) {
    return json({ error: 'Need page, season, cov' }, 400);
  }
  if (!/^[0-9a-f]{20,80}$/.test(b?.action || '')) return json({ error: 'Missing or malformed Sumer request id' }, 400);
  const r = await fetch(`https://sumersports.com/players/${b.page}/`, {
    method: 'POST',
    headers: {
      'accept': 'text/x-component',
      'content-type': 'text/plain;charset=UTF-8',
      'next-action': b.action,
      'origin': 'https://sumersports.com',
      'referer': `https://sumersports.com/players/${b.page}/`,
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    },
    body: JSON.stringify([b.page, season, SUMER_LIMIT, [{ receivingYards: 'DESC' }], { manZone: [b.cov] }, 1]),
  });
  const text = await r.text();
  if (!r.ok) return json({ error: `Sumer HTTP ${r.status} — the request id has probably expired` }, 502);
  return new Response(text, { headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...NO_STORE } });
}

async function deleteSlice(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad JSON' }, 400); }
  const season = parseInt(body?.season, 10);
  if (!SOURCES.has(body?.source) || !(season >= 1999 && season <= 2100)) return json({ error: 'Need source + season' }, 400);
  const res = await env.DB.prepare('DELETE FROM data_player_seasons WHERE source = ? AND season = ?')
    .bind(body.source, season).run();
  return json({ ok: true, deleted: res.meta?.changes ?? 0 });
}
