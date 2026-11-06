import { requireAdmin } from './auth.js';
import { getCors } from './http.js';

// ── Elite FFL — Draft History + Keeper Options ─────────────────────────────────
// Global data (not per-user) for the eliteffl.ffhistorian.com page — reads are
// public, writes require the Site Lead (requireAdmin: X-Admin-Secret header or
// an is_admin session). All years live in one table; the client filters/sorts.

export async function handleEliteFFL(request, env, url) {
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
