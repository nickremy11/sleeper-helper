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
 *   GET  /api/fantasycalc         → FantasyCalc values (KV-cached 24h)
 *   GET  /api/espn/scoreboard     → NFL week schedule: team → kickoff ISO (KV-cached 5m)
 *   GET  /api/espn/games          → NFL week games with pairings [{home,away,kickoff}] (KV-cached 5m)
 *   GET  /api/espn/settings       → get ESPN league IDs + credential status (auth required)
 *   POST /api/espn/settings       → save ESPN league IDs + credentials (auth required)
 *   GET  /api/espn/fantasy/:id    → proxy ESPN fantasy API using stored credentials (auth required)
 *   GET  /api/rootforme/prefs     → get league preferences for logged-in user
 *   POST /api/rootforme/prefs     → save league preferences for logged-in user
 *   GET  /api/eliteffl/picks            → all Elite FFL draft-history rows (public)
 *   POST /api/eliteffl/picks            → create one row (admin only)
 *   POST /api/eliteffl/picks/import     → bulk-insert rows for a season (admin only)
 *   POST /api/eliteffl/picks/import-ppg → merge PPG into existing rows by season + player name (admin only)
 *   PUT/DELETE /api/eliteffl/picks/:id  → edit/remove one row (admin only)
 *   GET  /api/eliteffl/keeper-options           → all keeper-options rows (public)
 *   POST /api/eliteffl/keeper-options           → create one row (admin only)
 *   POST /api/eliteffl/keeper-options/import    → bulk-insert rows (admin only)
 *   PUT/DELETE /api/eliteffl/keeper-options/:id → edit/remove one row (admin only)
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
import { handleAuth, getAuthUser, decryptStoredToken, requireAdmin } from './auth.js';

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
    'Access-Control-Allow-Methods':     'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type, Authorization, X-Sleeper-Graphql-Op, X-Fantasy-Filter',
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

// ── Elite FFL — Draft History + Keeper Options ─────────────────────────────────
// Global data (not per-user) for the eliteffl.ffhistorian.com page — reads are
// public, writes require the Site Lead (requireAdmin: X-Admin-Secret header or
// an is_admin session). All years live in one table; the client filters/sorts.

async function handleEliteFFL(request, env, url) {
  const cors    = getCors(request);
  const jsonRes = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
  });
  const errRes = (msg, status = 400) => jsonRes({ error: msg }, status);

  const parts = url.pathname.replace('/api/eliteffl/', '').replace(/^\//, '').split('/').filter(Boolean);
  const [resource, idOrAction] = parts;
  const isId = /^\d+$/.test(idOrAction || '');

  if (resource === 'picks') {
    if (!idOrAction && request.method === 'GET')  return listPicks(env, jsonRes);
    if (!idOrAction && request.method === 'POST') return createPick(request, env, jsonRes, errRes);
    if (idOrAction === 'import' && request.method === 'POST') return importPicks(request, env, jsonRes, errRes);
    if (idOrAction === 'import-ppg' && request.method === 'POST') return importPpg(request, env, jsonRes, errRes);
    if (isId && request.method === 'PUT')    return updatePick(Number(idOrAction), request, env, jsonRes, errRes);
    if (isId && request.method === 'DELETE') return deletePick(Number(idOrAction), request, env, jsonRes, errRes);
  }

  if (resource === 'keeper-options') {
    if (!idOrAction && request.method === 'GET')  return listKeeperOptions(env, jsonRes);
    if (!idOrAction && request.method === 'POST') return createKeeperOption(request, env, jsonRes, errRes);
    if (idOrAction === 'import' && request.method === 'POST') return importKeeperOptions(request, env, jsonRes, errRes);
    if (isId && request.method === 'PUT')    return updateKeeperOption(Number(idOrAction), request, env, jsonRes, errRes);
    if (isId && request.method === 'DELETE') return deleteKeeperOption(Number(idOrAction), request, env, jsonRes, errRes);
  }

  return errRes('Not found', 404);
}

function pickFields(body) {
  return {
    season:      Number(body.season),
    owner:       String(body.owner || '').trim(),
    player_name: String(body.player_name || '').trim(),
    position:    String(body.position || '').trim().toUpperCase(),
    price:       Number(body.price),
    is_keeper:   body.is_keeper ? 1 : 0,
    times_kept:  body.times_kept  != null && body.times_kept  !== '' ? Number(body.times_kept)  : null,
    ppg_prev:    body.ppg_prev    != null && body.ppg_prev    !== '' ? Number(body.ppg_prev)     : null,
    ppg_this:    body.ppg_this    != null && body.ppg_this    !== '' ? Number(body.ppg_this)     : null,
    notes:       body.notes ? String(body.notes).trim() : null,
  };
}

function validatePick(p) {
  if (!p.season || !Number.isFinite(p.season)) return 'season is required';
  if (!p.owner)                                return 'owner is required';
  if (!p.player_name)                          return 'player_name is required';
  if (!p.position)                             return 'position is required';
  if (!Number.isFinite(p.price))               return 'price is required';
  return null;
}

async function listPicks(env, jsonRes) {
  const { results } = await env.DB.prepare(
    `SELECT id, season, owner, player_name, position, price, is_keeper, times_kept, ppg_prev, ppg_this, notes
     FROM eliteffl_draft_picks ORDER BY season DESC, price DESC`
  ).all();
  return jsonRes({ picks: results || [] });
}

async function createPick(request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const p   = pickFields(body);
  const err = validatePick(p);
  if (err) return errRes(err);
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO eliteffl_draft_picks (season, owner, player_name, position, price, is_keeper, times_kept, ppg_prev, ppg_this, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(p.season, p.owner, p.player_name, p.position, p.price, p.is_keeper, p.times_kept, p.ppg_prev, p.ppg_this, p.notes, now).run();
  return jsonRes({ ok: true, id: res.meta.last_row_id });
}

async function updatePick(id, request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const p   = pickFields(body);
  const err = validatePick(p);
  if (err) return errRes(err);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE eliteffl_draft_picks SET season=?, owner=?, player_name=?, position=?, price=?, is_keeper=?, times_kept=?, ppg_prev=?, ppg_this=?, notes=?, updated_at=? WHERE id=?`
  ).bind(p.season, p.owner, p.player_name, p.position, p.price, p.is_keeper, p.times_kept, p.ppg_prev, p.ppg_this, p.notes, now, id).run();
  return jsonRes({ ok: true });
}

async function deletePick(id, request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  await env.DB.prepare('DELETE FROM eliteffl_draft_picks WHERE id=?').bind(id).run();
  return jsonRes({ ok: true });
}

async function importPicks(request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const rows = Array.isArray(body.picks) ? body.picks : [];
  if (!rows.length) return errRes('No rows to import');

  const now    = Date.now();
  const stmts  = [];
  const errors = [];
  rows.forEach((row, i) => {
    const p   = pickFields(row);
    const err = validatePick(p);
    if (err) { errors.push(`Row ${i + 1}: ${err}`); return; }
    stmts.push(env.DB.prepare(
      `INSERT INTO eliteffl_draft_picks (season, owner, player_name, position, price, is_keeper, times_kept, ppg_prev, ppg_this, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(p.season, p.owner, p.player_name, p.position, p.price, p.is_keeper, p.times_kept, p.ppg_prev, p.ppg_this, p.notes, now));
  });
  if (errors.length) return errRes(`Import failed — ${errors.length} bad row(s): ${errors.slice(0, 5).join('; ')}`);

  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  return jsonRes({ ok: true, imported: stmts.length });
}

// Merges PPG into already-imported rows for a season, matched by player name
// (case-insensitive) — for the common "picks now, PPG later" workflow so a
// second paste doesn't require hand-editing every row. Leaving a value blank
// on a row keeps whatever's already stored (COALESCE), so a partial paste
// (say, just PPG This) doesn't clobber a PPG Prev value entered separately.
async function importPpg(request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const season = Number(body.season);
  const rows   = Array.isArray(body.rows) ? body.rows : [];
  if (!season)     return errRes('season is required');
  if (!rows.length) return errRes('No rows to import');

  const { results: existing } = await env.DB.prepare(
    'SELECT id, player_name FROM eliteffl_draft_picks WHERE season = ?'
  ).bind(season).all();
  const byName = new Map();
  (existing || []).forEach(r => {
    const k = r.player_name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r.id);
  });

  const now       = Date.now();
  const stmts     = [];
  const unmatched = [];
  rows.forEach(row => {
    const name = String(row.player_name || '').trim();
    if (!name) return;
    const ids = byName.get(name.toLowerCase());
    if (!ids || !ids.length) { unmatched.push(name); return; }
    const ppgPrev = row.ppg_prev != null && row.ppg_prev !== '' ? Number(row.ppg_prev) : null;
    const ppgThis = row.ppg_this != null && row.ppg_this !== '' ? Number(row.ppg_this) : null;
    ids.forEach(id => {
      stmts.push(env.DB.prepare(
        'UPDATE eliteffl_draft_picks SET ppg_prev = COALESCE(?, ppg_prev), ppg_this = COALESCE(?, ppg_this), updated_at = ? WHERE id = ?'
      ).bind(ppgPrev, ppgThis, now, id));
    });
  });

  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  return jsonRes({ ok: true, matched: stmts.length, unmatched });
}

function koFields(body) {
  return {
    owner:          String(body.owner || '').trim(),
    player_name:    String(body.player_name || '').trim(),
    position:       String(body.position || '').trim().toUpperCase(),
    times_kept:     Number(body.times_kept) || 0,
    original_price: body.original_price != null && body.original_price !== '' ? Number(body.original_price) : null,
    keeper_cost:    body.keeper_cost    != null && body.keeper_cost    !== '' ? Number(body.keeper_cost)    : null,
    ppg:            body.ppg            != null && body.ppg            !== '' ? Number(body.ppg)            : null,
    espn_value:     body.espn_value     != null && body.espn_value     !== '' ? Number(body.espn_value)     : null,
    notes:          body.notes ? String(body.notes).trim() : null,
    sort_order:     Number(body.sort_order) || 0,
  };
}

async function listKeeperOptions(env, jsonRes) {
  const { results } = await env.DB.prepare(
    `SELECT id, owner, player_name, position, times_kept, original_price, keeper_cost, ppg, espn_value, notes, sort_order
     FROM eliteffl_keeper_options ORDER BY owner, sort_order, player_name`
  ).all();
  return jsonRes({ options: results || [] });
}

async function createKeeperOption(request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const k = koFields(body);
  if (!k.owner || !k.player_name) return errRes('owner and player_name are required');
  const now = Date.now();
  const res = await env.DB.prepare(
    `INSERT INTO eliteffl_keeper_options (owner, player_name, position, times_kept, original_price, keeper_cost, ppg, espn_value, notes, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(k.owner, k.player_name, k.position, k.times_kept, k.original_price, k.keeper_cost, k.ppg, k.espn_value, k.notes, k.sort_order, now).run();
  return jsonRes({ ok: true, id: res.meta.last_row_id });
}

async function importKeeperOptions(request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const rows = Array.isArray(body.options) ? body.options : [];
  if (!rows.length) return errRes('No rows to import');

  const now    = Date.now();
  const stmts  = [];
  const errors = [];
  rows.forEach((row, i) => {
    const k = koFields(row);
    if (!k.owner || !k.player_name) { errors.push(`Row ${i + 1}: owner and player_name are required`); return; }
    stmts.push(env.DB.prepare(
      `INSERT INTO eliteffl_keeper_options (owner, player_name, position, times_kept, original_price, keeper_cost, ppg, espn_value, notes, sort_order, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(k.owner, k.player_name, k.position, k.times_kept, k.original_price, k.keeper_cost, k.ppg, k.espn_value, k.notes, k.sort_order, now));
  });
  if (errors.length) return errRes(`Import failed — ${errors.length} bad row(s): ${errors.slice(0, 5).join('; ')}`);

  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  return jsonRes({ ok: true, imported: stmts.length });
}

async function updateKeeperOption(id, request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const k = koFields(body);
  if (!k.owner || !k.player_name) return errRes('owner and player_name are required');
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE eliteffl_keeper_options SET owner=?, player_name=?, position=?, times_kept=?, original_price=?, keeper_cost=?, ppg=?, espn_value=?, notes=?, sort_order=?, updated_at=? WHERE id=?`
  ).bind(k.owner, k.player_name, k.position, k.times_kept, k.original_price, k.keeper_cost, k.ppg, k.espn_value, k.notes, k.sort_order, now, id).run();
  return jsonRes({ ok: true });
}

async function deleteKeeperOption(id, request, env, jsonRes, errRes) {
  if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
  await env.DB.prepare('DELETE FROM eliteffl_keeper_options WHERE id=?').bind(id).run();
  return jsonRes({ ok: true });
}

// ── Projections (projections.ffhistorian.com) ─────────────────────────────────

async function handleProjections(request, env, url) {
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

function jsonRes(body, extra = {}) {
  return new Response(body, {
    status: 200,
    headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8', ...extra },
  });
}
