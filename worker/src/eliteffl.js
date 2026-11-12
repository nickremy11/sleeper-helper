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

  if (resource === 'sync' && request.method === 'POST') {
    if (!(await requireAdmin(request, env))) return errRes('Not authorized', 401);
    try { return jsonRes(await syncEliteFFL(env, { dryRun: url.searchParams.get('dry') === '1' })); }
    catch (e) { return errRes(e.message, 502); }
  }
  if (resource === 'sync' && request.method === 'GET') {
    return jsonRes(JSON.parse(await env.SLEEPER_KV.get('eliteffl:last_sync') || 'null'));
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

// ── ESPN sync (cron + POST /api/eliteffl/sync) ─────────────────────────────────
// Keeps two things current without a hand import, using the Site Lead's stored
// ESPN cookies (espn_settings row of the is_admin user):
//
//  1. Draft history — once the season's draft is done, its picks are inserted
//     (only when that season has no rows yet, so hand edits are never re-written).
//  2. Keeper options — the chart for NEXT year's draft, rebuilt from current rosters.
//     Eligible = drafted this season (keepers included), never dropped this season,
//     still rostered, not K or D/ST. Verified against the hand-built 2026 chart:
//     176/176 players agree. The chart's draft year lives in KV (KO_YEAR_KEY):
//       - year changed (a new draft happened) → the table is replaced, old rows backed
//         up to KV first;
//       - same year → diff only: new eligible players inserted, ineligible ones
//         deleted, an owner moved on a trade. Existing rows otherwise untouched, so
//         notes, ESPN $, PPG and any hand-set keeper_cost survive.
//     Cost steps from what he cost THIS year (price + 5·2^n for the n-th keep so far),
//     which matches the chart's own figures — a one-off surcharge carries forward.
//
// Does nothing before the season's draft is complete, so last year's chart stays
// up through keeper decisions.
const ELITEFFL_ESPN_ID = 330437;
const KO_YEAR_KEY      = 'eliteffl:ko_draft_year';
const ELITEFFL_NICKS = {
  '{2B505271-9363-4C64-9457-A4961AE871A7}': 'Bass',
  '{969CD6AD-35BE-4494-917C-6634B005F24A}': 'Jeremy',
  '{EE435FB1-4583-4A3B-93E1-7043550783A1}': 'Nathan',
  '{2BA44886-18D3-4188-B900-0A6D78249655}': 'Remy',
  '{3775649E-8A08-4B15-8B36-4DAD52A699C8}': 'Colin',
  '{C718779A-E6B6-4C8F-9877-9AE6B62C8FFB}': 'Austin',
  '{F96A2BED-2824-48F0-8D82-ECC916989A35}': 'Zajdel',
  '{C8BE2BA4-D0F7-4191-9915-39F2BF00BC3F}': 'Joe',
  '{D7809CB9-0105-4BE6-AFBA-C77D5C6EEDEB}': 'Hickey',
  '{96348A5E-C3CD-4A00-8EFB-13EF889BFEAD}': 'Cullen',
  '{701BAD9E-7DAB-4E82-AAB4-65979E3EC94A}': 'Brooks',
  '{B488FA27-6CB0-4BF3-88FA-276CB0ABF3E8}': 'Brooks', // Patriotsfan22 → same person
  '{DDF16D17-6A6D-4AA1-974D-2B730ACAE43D}': 'Schnupper',
};
const ELITEFFL_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };

function eliteSeason(d = new Date()) {
  return d.getUTCMonth() < 7 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

export async function syncEliteFFL(env, { dryRun = false } = {}) {
  const cred = await env.DB.prepare(
    `SELECT e.espn_s2, e.swid FROM espn_settings e JOIN users u ON u.id = e.user_id
     WHERE u.is_admin = 1 AND e.espn_s2 IS NOT NULL AND e.swid IS NOT NULL LIMIT 1`
  ).first();
  if (!cred) throw new Error('No Site Lead ESPN cookies stored');
  const season = eliteSeason();
  const base   = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${ELITEFFL_ESPN_ID}`;
  const espn   = async (q, filter) => {
    const headers = { Cookie: `espn_s2=${cred.espn_s2}; SWID=${cred.swid}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' };
    if (filter) headers['X-Fantasy-Filter'] = JSON.stringify(filter);
    const r = await fetch(`${base}?${q}`, { headers });
    if (!r.ok) throw new Error(`ESPN ${r.status} (${q.slice(0, 40)})`);
    return r.json();
  };

  const lg = await espn('view=mDraftDetail&view=mTeam&view=mRoster');
  const picks = lg.draftDetail?.picks || [];
  if (!lg.draftDetail?.drafted || !picks.length) return { season, skipped: 'draft not complete' };

  const ownerOf = {};
  (lg.teams || []).forEach(t => { ownerOf[t.id] = ELITEFFL_NICKS[t.primaryOwner] || t.name || `Team ${t.id}`; });

  // Names for every drafted player (some are no longer rostered anywhere).
  const kona = await espn('view=kona_player_info', { players: { filterIds: { value: picks.map(p => p.playerId) } } });
  const info = {};
  (kona.players || []).forEach(p => { info[p.id] = { name: p.player.fullName, pos: ELITEFFL_POS[p.player.defaultPositionId] || '?' }; });
  (lg.teams || []).forEach(t => (t.roster?.entries || []).forEach(e => {
    const pl = e.playerPoolEntry?.player;
    if (pl && !info[pl.id]) info[pl.id] = { name: pl.fullName, pos: ELITEFFL_POS[pl.defaultPositionId] || '?' };
  }));
  const missing = picks.filter(p => !info[p.playerId]);
  if (missing.length) throw new Error(`No name for ${missing.length} drafted player(s)`);

  const { results: hist } = await env.DB.prepare(
    'SELECT season, player_name, price, is_keeper, times_kept FROM eliteffl_draft_picks WHERE season >= ? ORDER BY season'
  ).bind(season - 6).all();
  const histBy = new Map(); // lower name → {season: row}
  (hist || []).forEach(r => {
    const k = r.player_name.toLowerCase();
    if (!histBy.has(k)) histBy.set(k, {});
    histBy.get(k)[r.season] = r;
  });
  const { results: koRows } = await env.DB.prepare('SELECT * FROM eliteffl_keeper_options').all();
  const koYear = Number(await env.SLEEPER_KV.get(KO_YEAR_KEY)) || season; // unset = the chart for this draft
  const koBy   = new Map((koRows || []).map(r => [r.player_name.toLowerCase(), r]));

  const out = { season, draftInserted: 0, chartYear: season + 1 };
  const now = Date.now();

  // ── 1. Draft history ──
  const have = await env.DB.prepare('SELECT COUNT(*) n FROM eliteffl_draft_picks WHERE season = ?').bind(season).first();
  const keepN = {}; // playerId → which keep this season's was (keepers only)
  picks.filter(p => p.keeper).forEach(p => {
    const k = info[p.playerId].name.toLowerCase();
    const own   = histBy.get(k)?.[season];                    // already inserted on an earlier run
    const chart = koYear === season ? koBy.get(k) : null;     // the chart this draft was kept from
    const prev  = histBy.get(k)?.[season - 1];
    keepN[p.playerId] = (own?.is_keeper && own.times_kept) || chart?.times_kept
      || (prev?.is_keeper ? (prev.times_kept || 1) + 1 : 1);
  });
  if (!have.n) {
    const stmts = picks.map(p => env.DB.prepare(
      `INSERT INTO eliteffl_draft_picks (season, owner, player_name, position, price, is_keeper, times_kept, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(season, ownerOf[p.teamId], info[p.playerId].name, info[p.playerId].pos, p.bidAmount,
           p.keeper ? 1 : 0, p.keeper ? keepN[p.playerId] : null, now));
    out.draftInserted = stmts.length;
    if (!dryRun) for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  }

  // ── 2. Keeper options for next year's draft ──
  const periods = await Promise.all(Array.from({ length: 19 }, (_, sp) =>
    espn(`view=mTransactions2&scoringPeriodId=${sp}`).then(d => d.transactions || []).catch(e => {
      if (sp === 0) throw e;
      return [];
    })));
  const dropped = new Set();
  periods.flat().forEach(t => {
    if (t.status !== 'EXECUTED') return;
    (t.items || []).forEach(it => { if (it.type === 'DROP') dropped.add(it.playerId); });
  });
  const pickBy = new Map(picks.map(p => [p.playerId, p]));
  const want = new Map(); // lower name → row
  (lg.teams || []).forEach(t => (t.roster?.entries || []).forEach(e => {
    const id = e.playerId ?? e.playerPoolEntry?.player?.id;
    const p  = pickBy.get(id);
    if (!p || dropped.has(id)) return;
    const { name, pos } = info[id];
    if (pos === 'K' || pos === 'DST') return;
    const n = p.keeper ? keepN[id] : 0;  // keeps so far, counting this season's
    // Original price: walk back through consecutive kept seasons to the price he was first bought at.
    let orig = p.bidAmount;
    if (p.keeper) {
      const h = histBy.get(name.toLowerCase()) || {};
      let y = season - 1;
      while (h[y]?.is_keeper) y--;
      orig = h[y]?.price ?? (p.bidAmount - 5 * (2 ** n - 1));
    }
    want.set(name.toLowerCase(), {
      owner: ownerOf[t.id], player_name: name, position: pos,
      times_kept: n + 1, original_price: orig, keeper_cost: p.bidAmount + 5 * 2 ** n,
    });
  }));

  const ins = r => env.DB.prepare(
    `INSERT INTO eliteffl_keeper_options (owner, player_name, position, times_kept, original_price, keeper_cost, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).bind(r.owner, r.player_name, r.position, r.times_kept, r.original_price, r.keeper_cost, now);
  const stmts = [];
  if (koYear !== season + 1) {
    // New draft year → replace the chart, backing the old one up first.
    out.replaced = (koRows || []).length;
    if (!dryRun && koRows?.length) await env.SLEEPER_KV.put(`eliteffl:ko_backup:${koYear}`, JSON.stringify(koRows));
    stmts.push(env.DB.prepare('DELETE FROM eliteffl_keeper_options'));
    want.forEach(r => stmts.push(ins(r)));
    out.added = want.size;
  } else {
    out.added = 0; out.removed = 0; out.moved = 0;
    want.forEach((r, k) => {
      const cur = koBy.get(k);
      if (!cur) { stmts.push(ins(r)); out.added++; }
      else if (cur.owner !== r.owner) {
        stmts.push(env.DB.prepare('UPDATE eliteffl_keeper_options SET owner = ?, updated_at = ? WHERE id = ?').bind(r.owner, now, cur.id));
        out.moved++;
      }
    });
    (koRows || []).forEach(cur => {
      if (!want.has(cur.player_name.toLowerCase())) {
        stmts.push(env.DB.prepare('DELETE FROM eliteffl_keeper_options WHERE id = ?').bind(cur.id));
        out.removed++;
      }
    });
  }
  out.chartRows = want.size;
  if (!dryRun) {
    // One batch = one transaction, so a replace can never leave the chart half-empty.
    if (stmts.length) await env.DB.batch(stmts);
    await env.SLEEPER_KV.put(KO_YEAR_KEY, String(season + 1));
    await env.SLEEPER_KV.put('eliteffl:last_sync', JSON.stringify({ at: now, ...out }));
  } else {
    out.preview = [...want.values()];
  }
  return out;
}
