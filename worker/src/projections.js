import { getAuthUser } from './auth.js';
import { getCors } from './http.js';

const PROJ_SEASON_DEFAULT = 2026;

// ── Projections (projections.ffhistorian.com) ─────────────────────────────────

export async function handleProjections(request, env, url) {
  const cors = getCors(request);
  const sub  = url.pathname.replace('/api/projections', '').replace(/^\//, ''); // players | teams | ppg | sync-sheets

  // Sheets sync needs no DB/auth coupling beyond an authenticated user.
  if (sub === 'sync-sheets' && request.method === 'POST') {
    return handleProjSyncSheets(request, env, cors);
  }

  // External projection sets (Mike Clay etc.) are shared reference data, KV-cached,
  // no auth required — same posture as /api/fantasycalc.
  if (sub === 'external' && request.method === 'GET') {
    return handleProjExternal(request, env, cors, url);
  }

  const user = await getAuthUser(request, env);
  if (!user) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
    });
  }

  const season = Number(url.searchParams.get('season')) || PROJ_SEASON_DEFAULT;

  if (sub === 'players')          return handleProjPlayers(request, env, cors, user, season);
  if (sub === 'teams')            return handleProjTeams(request, env, cors, user, season);
  if (sub === 'ppg')              return handleProjPpg(request, env, cors, user, season, url);
  if (sub === 'scoring-presets')  return handleProjScoringPresets(request, env, cors, user);
  if (sub === 'scores')           return handleProjScores(request, env, cors, user, season, url);

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

// Without ?preset=, returns the same thing it always has: whatever scoring was
// active in the projections app the last time each player was saved. With
// ?preset=, reads the separate per-preset table instead — populated by that
// app's "Recompute" action, not by normal team saves.
async function handleProjPpg(request, env, cors, user, season, url) {
  const preset = url?.searchParams.get('preset') || '';
  const map = {};
  if (preset) {
    const rows = await env.DB.prepare(
      'SELECT player_name, calc_ppg FROM player_projection_scores WHERE user_id = ? AND season = ? AND preset = ?'
    ).bind(user.user_id, season, preset).all();
    for (const r of (rows.results || [])) {
      if (r.calc_ppg != null) map[r.player_name] = r.calc_ppg;
    }
    return projJson(map, cors);
  }
  const rows = await env.DB.prepare(
    'SELECT player_name, calc_ppg FROM player_projections WHERE user_id = ? AND season = ?'
  ).bind(user.user_id, season).all();
  for (const r of (rows.results || [])) {
    if (r.calc_ppg != null) map[r.player_name] = r.calc_ppg;
  }
  return projJson(map, cors);
}

// Named scoring presets (definitions only — weights, not computed numbers) so
// other origins (the Draft Tracker) can list what presets exist at all; these
// previously lived only in the projections app's own browser localStorage.
async function handleProjScoringPresets(request, env, cors, user) {
  if (request.method === 'GET') {
    const rows = await env.DB.prepare(
      'SELECT preset, scoring FROM scoring_presets WHERE user_id = ? ORDER BY preset'
    ).bind(user.user_id).all();
    const presets = (rows.results || []).map(r => ({ preset: r.preset, scoring: safeParse(r.scoring, {}) }));
    return projJson({ presets }, cors);
  }

  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: cors }); }
    const preset = body.preset;
    if (!preset || typeof preset !== 'string') return new Response('preset name required', { status: 400, headers: cors });
    await env.DB.prepare(
      `INSERT INTO scoring_presets (user_id, preset, scoring, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, preset) DO UPDATE SET scoring=excluded.scoring, updated_at=excluded.updated_at`
    ).bind(user.user_id, preset, JSON.stringify(body.scoring || {}), Date.now()).run();
    return projJson({ ok: true }, cors);
  }

  if (request.method === 'DELETE') {
    let body;
    try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: cors }); }
    if (!body.preset) return new Response('preset required', { status: 400, headers: cors });
    await env.DB.prepare('DELETE FROM scoring_presets WHERE user_id = ? AND preset = ?')
      .bind(user.user_id, body.preset).run();
    // Also drop any computed scores under that name (all seasons) so a deleted
    // preset doesn't leave orphaned, unlistable numbers behind.
    await env.DB.prepare('DELETE FROM player_projection_scores WHERE user_id = ? AND preset = ?')
      .bind(user.user_id, body.preset).run();
    return projJson({ ok: true }, cors);
  }

  return new Response('Method not allowed', { status: 405, headers: cors });
}

// Bulk upsert of PPG/points computed under one named preset — the projections
// app's "Recompute" action re-runs its existing calc engine over already-saved
// team/player inputs with that preset's scoring swapped in, then posts the
// results here in one shot rather than requiring every team to be re-saved.
async function handleProjScores(request, env, cors, user, season, url) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  let body;
  try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400, headers: cors }); }
  const preset = body.preset;
  const scores = Array.isArray(body.scores) ? body.scores : [];
  if (!preset || typeof preset !== 'string') return new Response('preset name required', { status: 400, headers: cors });

  const now = Date.now();
  const stmts = scores.filter(s => s.player_name).map(s => env.DB.prepare(
    `INSERT INTO player_projection_scores (user_id, player_name, season, preset, calc_ppg, calc_pts, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, player_name, season, preset) DO UPDATE SET
       calc_ppg=excluded.calc_ppg, calc_pts=excluded.calc_pts, updated_at=excluded.updated_at`
  ).bind(user.user_id, s.player_name, season, preset, s.calc_ppg ?? null, s.calc_pts ?? null, now));

  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  return projJson({ ok: true, saved: stmts.length }, cors);
}

// ── External projection sets (PDF scrapers) ───────────────────────────────────

const PROJ_EXTERNAL_SOURCES = {
  clay: {
    name: 'Mike Clay (ESPN)',
    kind: 'espn-pdf',
    url:  'https://g.espncdn.com/s/ffldraftkit/26/NFLDK2026_CS_ClayProjections2026.pdf',
  },
};

// ESPN draft-kit team-projection pages are alphabetical by location. The PDF has
// no team name in the page text (logos are images), so team identity comes purely
// from page order. Index here = order of the 32 team pages in the PDF.
const PROJ_TEAM_ORDER = [
  'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB',
  'HOU','IND','JAX','KC','LV','LAC','LAR','MIA','MIN','NE','NO','NYG',
  'NYJ','PHI','PIT','SF','SEA','TB','TEN','WAS',
];

const PROJ_EXT_TTL = 60 * 60 * 24; // 24 hours

async function handleProjExternal(request, env, cors, url) {
  const source = (url.searchParams.get('source') || 'clay').toLowerCase();
  const season = Number(url.searchParams.get('season')) || PROJ_SEASON_DEFAULT;
  const refresh = url.searchParams.get('refresh') === '1';

  const src = PROJ_EXTERNAL_SOURCES[source];
  if (!src) return projJson({ error: `Unknown source "${source}"` }, cors, 400);

  const key = `proj_ext_${source}_${season}`;
  if (!refresh) {
    const cached = await env.SLEEPER_KV.get(key, 'text');
    if (cached) {
      return new Response(cached, {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'X-Cache': 'HIT' },
      });
    }
  }

  let players;
  try {
    const upstream = await fetch(src.url, { headers: { 'User-Agent': 'sleeper-helper/1.0' } });
    if (!upstream.ok) return projJson({ error: 'Upstream fetch failed', status: upstream.status }, cors, 502);
    const buf = await upstream.arrayBuffer();
    players = await parseClayPdf(buf);
  } catch (e) {
    return projJson({ error: 'Parse failed: ' + (e && e.message || e) }, cors, 502);
  }

  if (!players || !players.length) {
    return projJson({ error: 'No players parsed from source' }, cors, 502);
  }

  const body = JSON.stringify({ source, name: src.name, season, updated: Date.now(), players });
  await env.SLEEPER_KV.put(key, body, { expirationTtl: PROJ_EXT_TTL });
  return new Response(body, {
    status: 200,
    headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'X-Cache': 'MISS' },
  });
}

// Inflate a zlib (RFC1950 / FlateDecode) stream using the platform DecompressionStream.
// The caller must pass exactly the compressed bytes (sliced via the stream's /Length);
// a spec-compliant DecompressionStream errors on any trailing bytes, and workerd
// discards buffered output when that happens.
async function inflateDeflate(bytes) {
  const s = new Response(bytes).body.pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Extract pipe-delimited text cells from a decoded PDF content stream.
// Handles both `(...) Tj` and `[ (...) ... ] TJ` text-showing operators, then
// splits each shown string on '|' into individual table cells.
function pdfFlatTokens(text) {
  const out = [];
  // [ ... ] TJ  — concatenate the inner (...) string parts
  const tjArr = /\[((?:[^\[\]]|\\.)*)\]\s*TJ/g;
  let m;
  while ((m = tjArr.exec(text)) !== null) {
    const parts = m[1].match(/\((?:[^()\\]|\\.)*\)/g) || [];
    out.push(parts.map(p => p.slice(1, -1)).join(''));
  }
  // (...) Tj
  const tjOne = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
  while ((m = tjOne.exec(text)) !== null) out.push(m[1]);

  const flat = [];
  for (const t of out) {
    for (const cell of t.split('|')) {
      const c = cell.trim();
      if (c) flat.push(c);
    }
  }
  return flat;
}

// Parse the 32 team-projection pages of the ESPN/Clay PDF into offensive players.
// Each team page is detected by the presence of a "QB Total" token. Within a page,
// an offensive player block is `<QB|RB|WR|TE> <name> <16 numeric cells>`:
//   Gm, PassAtt, Comp, PassYds, PassTD, INT, Sk, RushAtt, RushYds, RushTD,
//   Tgt, Rec, RecYds, RecTD, Pts, Rk
// A strict numeric guard (all 16 cells numeric, Gm in 1..18) prevents the walker
// from spilling into the page's special-teams/returns/IDP block.
async function parseClayPdf(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  // Decode raw bytes as latin-1 so byte offsets line up for stream extraction.
  let raw = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }

  // Find each `stream\r?\n … endstream` block and inflate it. The latin-1 decode keeps
  // char offsets == byte offsets, so regex indices slice `bytes` directly. Each stream's
  // exact compressed length is the `/Length N` in the object dictionary immediately
  // preceding it — slicing to that avoids trailing bytes that break DecompressionStream.
  // Skip the "stream" inside "endstream" (preceded by "end").
  const teamPages = [];
  const re = /stream\r?\n/g;
  const lenRe = /\/Length\s+(\d+)/g;
  let sm;
  while ((sm = re.exec(raw)) !== null) {
    if (raw.slice(sm.index - 3, sm.index) === 'end') continue;
    const start = sm.index + sm[0].length;
    // Only flate-decode content streams; skip image/other filters quickly.
    const pre = raw.slice(Math.max(0, sm.index - 280), sm.index);
    if (pre.indexOf('FlateDecode') < 0) continue;
    // Take the /Length nearest the stream keyword (last match in the dict).
    let len = -1, lm;
    lenRe.lastIndex = 0;
    while ((lm = lenRe.exec(pre)) !== null) len = +lm[1];
    if (len <= 0) continue;
    const slice = bytes.subarray(start, start + len);
    let dec;
    try { dec = await inflateDeflate(slice); }
    catch { continue; }
    if (!dec.length) continue;
    // decode inflated content as latin-1
    let txt = '';
    for (let i = 0; i < dec.length; i += 0x8000) {
      txt += String.fromCharCode.apply(null, dec.subarray(i, i + 0x8000));
    }
    if (txt.indexOf('BT') < 0) continue;
    const flat = pdfFlatTokens(txt);
    if (flat.includes('QB Total')) teamPages.push(flat);
  }

  const COLS = ['gm','pass_att','comp','pass_yds','pass_td','int','sk','rush_att','rush_yds',
                'rush_td','tgt','rec','rec_yds','rec_td','clay_pts','clay_rk'];
  const OFF = new Set(['QB','RB','WR','TE']);
  const NUM = /^-?\d+(\.\d+)?$/;
  const players = [];

  const nTeams = Math.min(teamPages.length, PROJ_TEAM_ORDER.length);
  for (let t = 0; t < nTeams; t++) {
    const team = PROJ_TEAM_ORDER[t];
    const flat = teamPages[t];
    let i = 0;
    while (i < flat.length) {
      if (OFF.has(flat[i]) && i + 1 < flat.length && !OFF.has(flat[i + 1])) {
        const name = flat[i + 1];
        const nums = flat.slice(i + 2, i + 2 + 16);
        const ok = nums.length === 16 && nums.every(x => NUM.test(x))
          && +nums[0] >= 1 && +nums[0] <= 18;
        if (ok) {
          const p = { player_name: name, nfl_team: team, position: flat[i] };
          COLS.forEach((c, ci) => { p[c] = +nums[ci]; });
          delete p.sk; // sacks unused by fantasy scoring
          players.push(p);
          i += 18;
          continue;
        }
      }
      i += 1;
    }
  }
  return players;
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
