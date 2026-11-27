// ── Player-id crosswalk ───────────────────────────────────────────────────────
// One table that says which Sleeper player every other platform's id is. Sleeper
// ids are the app's currency (every page keys rosters, projections, stats and
// FantasyCalc values by them), so another platform's league is translated into
// Sleeper ids once, here, and nothing downstream has to know where it came from.
//
// Source of the other ids: MFL's own player database (export?TYPE=players&
// DETAILS=1), which carries ESPN, Sportradar ("sportsdata_id"), Rotowire, CBS and
// Fleaflicker ids beside its own. Matched against Sleeper's player map in this
// order, first hit wins:
//   team defence → team code · espn_id · sportradar_id · rotowire_id · stats_id
//   · unique name + position
// Measured 2026-11-26: 1,038 of 1,039 offensive/K/DEF and 1,249 of 1,252 IDP.
//
// Storage:
//   D1 player_ids            one row per matched MFL player (the record, queryable)
//   D1 player_id_overrides   hand fixes; always win, survive every rebuild
//   KV pidx:v1               {built, mfl: {mflId: sleeperId}, mpos: {mflId: slot position},
//                            unmatched: [...], stats}
//                            — what requests read (one get, ~60 KB)
// Rebuilt by the daily cron. MFL asks for its player list no more than once a day.

export const PIDX_KEY = 'pidx:v1';
const PIDX_TTL = 60 * 60 * 24 * 3;   // a missed cron or two keeps serving the last build
const MFL_PLAYERS_URL = y => `https://api.myfantasyleague.com/${y}/export?TYPE=players&DETAILS=1&JSON=1`;

// MFL's team codes that differ from Sleeper's (Sleeper's DEF player_id IS its code).
export const MFL_TEAM = { NEP: 'NE', JAC: 'JAX', KCC: 'KC', LVR: 'LV', GBP: 'GB', TBB: 'TB', NOS: 'NO', SFO: 'SF' };
export const mflTeam = t => MFL_TEAM[t] || t;

// MFL position → Sleeper position, for the name fallback and for display.
// TM* positions are team units ("the Bills' kicker") — no Sleeper equivalent.
export const MFL_POS = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', PK: 'K', PN: 'P', Def: 'DEF',
                         DE: 'DL', DT: 'DL', LB: 'LB', CB: 'DB', S: 'DB' };
// Team units fill the slot of the position they stand for (a TMPK starts at K).
export const MFL_UNIT_POS = { TMQB: 'QB', TMRB: 'RB', TMWR: 'WR', TMTE: 'TE', TMPK: 'K', TMPN: 'P',
                              TMDL: 'DL', TMLB: 'LB', TMDB: 'DB' };
export const mflSlotPos = p => MFL_POS[p] || MFL_UNIT_POS[p] || null;
const SLEEPER_POS_OK = { DL: ['DL', 'DE', 'DT'], DB: ['DB', 'CB', 'S', 'SS', 'FS'], LB: ['LB', 'OLB', 'ILB'] };

export function normPlayerName(n) {
  return String(n || '').toLowerCase()
    .replace(/[.'’-]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// MFL writes names "Last, First".
export function mflDisplayName(n) {
  const s = String(n || '');
  const i = s.indexOf(', ');
  return i < 0 ? s : `${s.slice(i + 2)} ${s.slice(0, i)}`;
}

// Pure: (sleeper player map, MFL player array, overrides) → {map, rows, unmatched, stats}.
export function buildMflCrosswalk(sleeper, mflPlayers, overrides = []) {
  const idx = key => {
    const o = new Map();
    for (const [id, p] of Object.entries(sleeper)) {
      const v = p?.[key];
      if (v != null && v !== '' && !o.has(String(v))) o.set(String(v), id);
    }
    return o;
  };
  const byEspn = idx('espn_id'), bySr = idx('sportradar_id'), byRw = idx('rotowire_id'), byStats = idx('stats_id');
  const byName = new Map();
  for (const [id, p] of Object.entries(sleeper)) {
    const nm = normPlayerName(p.full_name || `${p.first_name || ''} ${p.last_name || ''}`);
    if (!nm) continue;
    (byName.get(nm) || byName.set(nm, []).get(nm)).push(id);
  }
  const ovr = new Map(overrides.filter(o => o.platform === 'mfl').map(o => [String(o.ext_id), o.sleeper_id || null]));

  const map = {}, mpos = {}, rows = [], unmatched = [];
  const stats = { total: 0, override: 0, def: 0, espn: 0, sportradar: 0, rotowire: 0, stats: 0, name: 0, unmatched: 0, team_unit: 0 };
  for (const p of mflPlayers || []) {
    const slot = mflSlotPos(p.position);
    if (slot) mpos[p.id] = slot;                         // every player, matched or not: lineups need it
    const pos = MFL_POS[p.position];
    if (!pos || pos === 'P') {                          // team units, coaches, punters: nothing to map to
      if (/^TM|^Off$|^ST$|^Coach$/.test(p.position)) stats.team_unit++;
      continue;
    }
    stats.total++;
    let sid = null, how = null;
    if (ovr.has(String(p.id))) { sid = ovr.get(String(p.id)); how = 'override'; }
    if (!how && pos === 'DEF') { const t = mflTeam(p.team); if (sleeper[t]) { sid = t; how = 'def'; } }
    if (!how && p.espn_id && byEspn.has(p.espn_id))           { sid = byEspn.get(p.espn_id); how = 'espn'; }
    if (!how && p.sportsdata_id && bySr.has(p.sportsdata_id)) { sid = bySr.get(p.sportsdata_id); how = 'sportradar'; }
    if (!how && p.rotowire_id && byRw.has(p.rotowire_id))     { sid = byRw.get(p.rotowire_id); how = 'rotowire'; }
    if (!how && p.stats_id && p.stats_id !== '0' && byStats.has(p.stats_id)) { sid = byStats.get(p.stats_id); how = 'stats'; }
    if (!how) {
      const ok = SLEEPER_POS_OK[pos] || [pos];
      const hits = (byName.get(normPlayerName(mflDisplayName(p.name))) || [])
        .filter(id => ok.includes(sleeper[id]?.position) || (sleeper[id]?.fantasy_positions || []).some(x => ok.includes(x)));
      if (hits.length === 1) { sid = hits[0]; how = 'name'; }
    }
    if (how && sid) {
      stats[how]++;
      map[p.id] = sid;
      rows.push({ mfl_id: p.id, sleeper_id: sid, espn_id: p.espn_id || null, fleaflicker_id: p.fleaflicker_id || null,
                  cbs_id: p.cbs_id || null, sportradar_id: p.sportsdata_id || null,
                  name: mflDisplayName(p.name), position: pos, team: mflTeam(p.team), how });
    } else {
      if (how === 'override') stats.override++;          // an override to null = "never match this one"
      else { stats.unmatched++; unmatched.push({ mfl_id: p.id, name: mflDisplayName(p.name), position: pos, team: mflTeam(p.team) }); }
    }
  }
  return { map, mpos, rows, unmatched, stats };
}

// Sleeper's full player map: the same KV entry /api/players serves, else upstream.
async function loadSleeperPlayers(env) {
  const cached = await env.SLEEPER_KV.get('players_nfl', 'json').catch(() => null);
  if (cached) return cached;
  const r = await fetch('https://api.sleeper.app/v1/players/nfl');
  if (!r.ok) throw new Error(`Sleeper players ${r.status}`);
  return r.json();
}

export function mflSeasonYear(d = new Date()) {
  // MFL's season runs into January–February of the next calendar year, and the new
  // season's player database opens in the spring.
  return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

export async function rebuildPlayerIds(env) {
  const year = mflSeasonYear();
  const [sleeper, mflRes, ovr] = await Promise.all([
    loadSleeperPlayers(env),
    fetch(MFL_PLAYERS_URL(year), { headers: { 'User-Agent': mflUserAgent(env) } }),
    env.DB.prepare('SELECT platform, ext_id, sleeper_id FROM player_id_overrides').all().then(r => r.results || []).catch(() => []),
  ]);
  if (!mflRes.ok) throw new Error(`MFL players ${mflRes.status}`);
  const mfl = [].concat((await mflRes.json())?.players?.player || []);
  if (mfl.length < 500) throw new Error(`MFL players: only ${mfl.length} rows`);   // never replace a good build with a broken one
  const out = buildMflCrosswalk(sleeper, mfl, ovr);

  const now = Date.now();
  const stmts = [env.DB.prepare("DELETE FROM player_ids WHERE platform = 'mfl'")];
  const ins = env.DB.prepare(
    `INSERT OR REPLACE INTO player_ids (platform, ext_id, sleeper_id, espn_id, fleaflicker_id, cbs_id, sportradar_id, name, position, team, how, updated_at)
     VALUES ('mfl', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of out.rows) stmts.push(ins.bind(r.mfl_id, r.sleeper_id, r.espn_id, r.fleaflicker_id, r.cbs_id, r.sportradar_id, r.name, r.position, r.team, r.how, now));
  for (let i = 0; i < stmts.length; i += 400) await env.DB.batch(stmts.slice(i, i + 400));

  const snap = { built: now, year, mfl: out.map, mpos: out.mpos, unmatched: out.unmatched, stats: out.stats };
  await env.SLEEPER_KV.put(PIDX_KEY, JSON.stringify(snap), { expirationTtl: PIDX_TTL });
  return out.stats;
}

// What the MFL adapter reads. Builds on first use when the snapshot is missing.
let _inflight = null;
export async function getPlayerIdx(env) {
  const snap = await env.SLEEPER_KV.get(PIDX_KEY, 'json').catch(() => null);
  if (snap?.mfl) return snap;
  if (!_inflight) _inflight = rebuildPlayerIds(env).finally(() => { _inflight = null; });
  await _inflight;
  return (await env.SLEEPER_KV.get(PIDX_KEY, 'json')) || { mfl: {}, unmatched: [] };
}

export function mflUserAgent(env) {
  // Set MFL_USER_AGENT to the name registered on MFL's API Client Registration page;
  // registered clients get ~2.5x the request allowance.
  return env.MFL_USER_AGENT || 'ffhistorian/1.0 (+https://ffhistorian.com)';
}
