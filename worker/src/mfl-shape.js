// ── MFL → Sleeper shapes (pure) ───────────────────────────────────────────────
// Every page in the app reads leagues in Sleeper's shapes (/league, /rosters,
// /users, /matchups/{w}, /traded_picks, /drafts, /winners_bracket). These
// functions turn MFL's export responses into exactly those shapes, with players
// already translated to Sleeper ids, so the pages read an MFL league the way they
// read a Sleeper one. No I/O here — src/mfl.js fetches, this file reshapes, and
// tests/mfl.test.js runs it against saved MFL responses.
//
// Ids:  league  mfl_{year}_{mflLeagueId}  (one id per season, like Sleeper)
//       roster  the franchise id as a number ("0007" → 7)
//       owner   mfl:{leagueId}:{franchiseId}, or the caller's own id (`me`) for
//               the caller's franchise, so "my roster" works with no page changes
//       player  the Sleeper id, else `mfl_{id}` (unmatched, or a team unit)

import { MFL_POS, mflSlotPos, mflTeam, mflDisplayName } from './player-ids.js';

// MFL JSON: one element comes back as an object, several as an array; text as {$t}.
export const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]);
const txt = x => (x && typeof x === 'object' && '$t' in x ? x.$t : x);
const num = x => { const n = parseFloat(txt(x)); return Number.isFinite(n) ? n : 0; };
export const rid = fid => parseInt(fid, 10);

export function mapPid(idx, id) {
  const s = idx?.mfl?.[id];
  return s || `mfl_${id}`;
}
export const csvIds = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);

// ── Lineup rules ─────────────────────────────────────────────────────────────
// MFL states starters as a total plus a range per position ("9 starters: QB 1,
// RB 1-4, WR 1-4, TE 1-4, K 1, DEF 1"). Sleeper states them as slots. Each
// position's minimum becomes that many dedicated slots; the leftover starters
// become flex slots open to every position with room above its minimum. A flex
// that would let more QBs start than the QB maximum is a plain FLEX instead of a
// SUPER_FLEX — the one cap that changes who an optimizer starts.
const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB', 'P'];
function flexName(set) {
  const has = p => set.has(p);
  const idp = ['DL', 'LB', 'DB'].filter(has);
  const off = ['QB', 'RB', 'WR', 'TE'].filter(has);
  if (idp.length && !off.length) return 'IDP_FLEX';
  if (has('QB')) return 'SUPER_FLEX';
  if (has('RB') && has('WR') && has('TE')) return 'FLEX';
  if (has('WR') && has('TE') && !has('RB')) return 'REC_FLEX';
  if (has('RB') && has('WR')) return 'WRRB_FLEX';
  return 'FLEX';
}
export function mflStartersToSlots(starters, { rosterSize = 0, ir = 0, taxi = 0 } = {}) {
  const total = parseInt(starters?.count, 10) || 0;
  const lim = {};                                         // sleeper pos → {min, max}
  for (const p of arr(starters?.position)) {
    const pos = mflSlotPos(p.name);
    if (!pos) continue;
    const [a, b] = String(p.limit).split('-').map(n => parseInt(n, 10));
    const cur = lim[pos] || { min: 0, max: 0 };
    lim[pos] = { min: cur.min + (a || 0), max: cur.max + (Number.isFinite(b) ? b : a || 0) };
  }
  const slots = [];
  for (const pos of SLOT_ORDER) for (let i = 0; i < (lim[pos]?.min || 0); i++) slots.push(pos);
  let flex = Math.max(0, total - slots.length);
  const room = Object.keys(lim).filter(p => lim[p].max > lim[p].min);
  const qbRoom = lim.QB ? lim.QB.max - lim.QB.min : 0;
  const flexSlots = [];
  const set = new Set(room);
  for (let i = 0; i < flex; i++) {
    const s = new Set(set);
    if (s.has('QB') && i >= qbRoom) s.delete('QB');
    flexSlots.push(flexName(s));
  }
  // Narrowest first, as Sleeper lists them (SUPER_FLEX last).
  const rank = { WRRB_FLEX: 0, REC_FLEX: 1, FLEX: 2, IDP_FLEX: 3, SUPER_FLEX: 4 };
  flexSlots.sort((a, b) => rank[a] - rank[b]);
  const out = slots.concat(flexSlots);
  const bench = Math.max(0, (parseInt(rosterSize, 10) || 0) - out.length);
  for (let i = 0; i < bench; i++) out.push('BN');
  return { roster_positions: out, starterCount: out.filter(s => s !== 'BN').length,
           reserve_slots: parseInt(ir, 10) || 0, taxi_slots: parseInt(taxi, 10) || 0, limits: lim };
}

// Which positions each Sleeper slot takes (mirrors shared-utils' SLOT_ELIG).
const ELIG = {
  QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], K: ['K'], DEF: ['DEF'], DL: ['DL'], LB: ['LB'], DB: ['DB'], P: ['P'],
  FLEX: ['RB', 'WR', 'TE'], WRRB_FLEX: ['RB', 'WR'], REC_FLEX: ['WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX: ['DL', 'LB', 'DB'],
};
// Sleeper's `starters` is aligned to roster_positions; MFL's is an unordered list.
// Fill dedicated slots first, then flex slots narrowest first. Empty slot = '0'.
export function orderStarters(pids, rosterPositions, posOf) {
  const slots = rosterPositions.filter(s => s !== 'BN');
  const out = new Array(slots.length).fill('0');
  const left = [...pids];
  const take = (i, ok) => {
    const k = left.findIndex(p => ok.includes(posOf(p)));
    if (k >= 0) { out[i] = left[k]; left.splice(k, 1); }
  };
  slots.forEach((s, i) => { if (ELIG[s]?.length === 1) take(i, ELIG[s]); });
  slots.forEach((s, i) => { if (out[i] === '0' && ELIG[s]?.length > 1) take(i, ELIG[s]); });
  // Anything that fits nowhere (an odd MFL position) goes in any empty slot, so
  // the starter count still matches.
  for (let i = 0; i < out.length && left.length; i++) if (out[i] === '0') out[i] = left.shift();
  return out;
}

// ── Scoring rules ────────────────────────────────────────────────────────────
// MFL scores events by position group, each rule a stat range and either a
// per-unit multiplier ("*.04") or a flat award ("6"). Sleeper scores stat keys
// with one value each, plus threshold bonuses and buckets. What converts
// exactly does; anything else is approximated and named in `approx`, so a page
// can say the league's scoring is approximate instead of being quietly wrong.
const BIG = 9000;
function parseRule(r) {
  const ev = txt(r.event), rg = String(txt(r.range) || '');
  const m = rg.match(/^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$/);
  const lo = m ? parseFloat(m[1]) : -BIG, hi = m ? parseFloat(m[2]) : BIG;
  const pt = String(txt(r.points) || '0').trim();
  const mult = pt.startsWith('*') ? parseFloat(pt.slice(1)) : null;
  const flat = mult == null ? parseFloat(pt) : null;
  return { ev, lo, hi, mult, flat };
}
const ruleVal = (rules, n) => rules.reduce((s, r) => (n >= r.lo && n <= r.hi ? s + (r.mult != null ? n * r.mult : r.flat) : s), 0);
// A per-unit rule starting at the bottom of the stat's range is the stat's value.
// MFL's rule rows are cumulative — a TE matched by a "QB|RB|WR|TE" row and a "TE"
// row scores both — so a position's value is the sum over every row it's in.
const linearOf = rules => { const rs = rules.filter(x => x.mult != null && x.lo <= 1); return rs.length ? rs.reduce((a, r) => a + r.mult, 0) : null; };
const flatsOnly = rules => rules.filter(x => x.flat != null);

// Count-of-stat events → Sleeper key (linear).
const LINEAR = {
  QB: { '#P': 'pass_td', PY: 'pass_yd', P2: 'pass_2pt', IN: 'pass_int', PA: 'pass_att', PC: 'pass_cmp', PI: 'pass_inc', SKD: 'pass_sack' },
  RB: { '#R': 'rush_td', RY: 'rush_yd', R2: 'rush_2pt', RA: 'rush_att' },
  WR: { '#C': 'rec_td', CY: 'rec_yd', C2: 'rec_2pt', CC: 'rec', TGT: 'rec_tgt' },
  ANY: { FL: 'fum_lost', FU: 'fum', '#FR': 'fum_rec_td', KY: 'kr_yd', UY: 'pr_yd', '#UT': 'st_td', '#KT': 'st_td' },
  K: { EP: 'xpm', EM: 'xpmiss' },
  DEF: { SK: 'sack', IC: 'int', FC: 'fum_rec', FF: 'ff', SF: 'safe', BLK: 'blk_kick', '#D': 'def_td', '#T': 'def_st_td',
         SF1: 'safe' },
  IDP: { TK: 'idp_tkl_solo', AS: 'idp_tkl_ast', SK: 'idp_sack', IC: 'idp_int', FF: 'idp_ff', FC: 'idp_fum_rec',
         PD: 'idp_pass_def', '#D': 'idp_def_td', SF: 'idp_safe', QH: 'idp_qb_hit', TL: 'idp_tkl_loss', BLK: 'idp_blk_kick' },
};
// Flat awards above a threshold → Sleeper bonus keys (cumulative steps).
const BONUS = {
  PY: { 300: 'bonus_pass_yd_300', 400: 'bonus_pass_yd_400' },
  RY: { 100: 'bonus_rush_yd_100', 200: 'bonus_rush_yd_200' },
  CY: { 100: 'bonus_rec_yd_100', 200: 'bonus_rec_yd_200' },
  PC: { 25: 'bonus_pass_cmp_25' },
  RA: { 20: 'bonus_rush_att_20' },
};
const TD_LEN = { PS: ['pass_td_40p', 'pass_td_50p'], RS: ['rush_td_40p', 'rush_td_50p'], CS: ['rec_td_40p', 'rec_td_50p'] };
const FG_BUCKETS = [['fgm_0_19', 0, 19, 19], ['fgm_20_29', 20, 29, 25], ['fgm_30_39', 30, 39, 35], ['fgm_40_49', 40, 49, 45], ['fgm_50p', 50, 65, 52]];
const PA_BUCKETS = [['pts_allow_0', 0, 0], ['pts_allow_1_6', 1, 6], ['pts_allow_7_13', 7, 13], ['pts_allow_14_20', 14, 20],
                    ['pts_allow_21_27', 21, 27], ['pts_allow_28_34', 28, 34], ['pts_allow_35p', 35, 70]];
const YA_BUCKETS = [['yds_allow_0_100', 0, 99], ['yds_allow_100_199', 100, 199], ['yds_allow_200_299', 200, 299],
                    ['yds_allow_300_349', 300, 349], ['yds_allow_350_399', 350, 399], ['yds_allow_400_449', 400, 449],
                    ['yds_allow_450_499', 450, 499], ['yds_allow_500_549', 500, 549], ['yds_allow_550p', 550, 800]];

function bucketize(rules, buckets, key, sc, approx, stepRep) {
  for (const [k, lo, hi, rep] of buckets) {
    const vals = [];
    for (let n = lo; n <= hi; n += stepRep || 1) vals.push(ruleVal(rules, n));
    const v = rep != null ? ruleVal(rules, rep) : vals[Math.floor(vals.length / 2)];
    if (v) sc[k] = +v.toFixed(4);
    if (vals.some(x => Math.abs(x - vals[0]) > 1e-9)) approx.add(key);
  }
}

export function mflRulesToScoring(rulesExport) {
  const groups = arr(rulesExport?.rules?.positionRules).map(g => ({
    pos: String(g.positions || '').split('|').map(p => mflSlotPos(p) || p),
    rules: arr(g.rule).map(parseRule),
  }));
  const forPos = pos => groups.filter(g => g.pos.includes(pos)).flatMap(g => g.rules);
  const byEv = (rules, ev) => rules.filter(r => r.ev === ev);
  const sc = {}, approx = new Set(), seen = new Set();

  const linear = (rules, table) => {
    for (const [ev, key] of Object.entries(table)) {
      const rs = byEv(rules, ev);
      if (!rs.length) continue;
      seen.add(ev);
      const m = linearOf(rs);
      if (m != null && !sc[key]) sc[key] = m;
      const steps = flatsOnly(rs);
      const bonusFor = BONUS[ev];
      if (steps.length && bonusFor) {
        let prev = 0;
        const ts = [...new Set(steps.map(r => r.lo).filter(t => t > 0))].sort((a, b) => a - b);
        for (const t of ts) {
          const v = ruleVal(steps, t);
          if (bonusFor[t]) sc[bonusFor[t]] = +(v - prev).toFixed(4); else approx.add(ev);
          prev = v;
        }
      } else if (steps.length || rs.some(r => r.mult != null && r.lo > 1)) approx.add(ev);
    }
  };
  linear(forPos('QB'), LINEAR.QB);
  linear(forPos('RB'), LINEAR.RB);
  linear(forPos('WR'), LINEAR.WR);
  linear(forPos('RB').length ? forPos('RB') : forPos('WR'), LINEAR.ANY);
  linear(forPos('K'), LINEAR.K);
  linear(forPos('DEF'), LINEAR.DEF);
  const idp = forPos('LB').length ? forPos('LB') : forPos('DL').length ? forPos('DL') : forPos('DB');
  linear(idp, LINEAR.IDP);

  // Position-specific reception values → Sleeper's per-position reception bonus.
  const recOf = pos => linearOf(byEv(forPos(pos), 'CC')) || 0;
  const baseRec = sc.rec || 0;
  for (const [pos, key] of [['TE', 'bonus_rec_te'], ['RB', 'bonus_rec_rb'], ['WR', 'bonus_rec_wr']]) {
    const d = recOf(pos) - baseRec;
    if (forPos(pos).length && Math.abs(d) > 1e-9) sc[key] = +d.toFixed(4);
  }
  // Any other stat a position scores differently from the base can't be said in
  // Sleeper's keys — flag it.
  for (const ev of ['#P', 'PY', '#R', 'RY', '#C', 'CY']) {
    const vals = ['QB', 'RB', 'WR', 'TE'].filter(p => forPos(p).length).map(p => linearOf(byEv(forPos(p), ev)) || 0);
    if (new Set(vals.filter(v => v)).size > 1) approx.add(ev);
  }

  // Per-play distance rules.
  for (const [ev, [k40, k50]] of Object.entries(TD_LEN)) {
    const rs = byEv(forPos(ev === 'PS' ? 'QB' : ev === 'RS' ? 'RB' : 'WR'), ev);
    if (!rs.length) continue;
    seen.add(ev);
    const v40 = ruleVal(rs, 40), v50 = ruleVal(rs, 50);
    if (v40) sc[k40] = v40;
    if (v50 - v40) sc[k50] = +(v50 - v40).toFixed(4);
    if (ruleVal(rs, 10) || ruleVal(rs, 45) !== v40 || ruleVal(rs, 60) !== v50) approx.add(ev);
  }
  const fg = byEv(forPos('K'), 'FG');
  if (fg.length) { seen.add('FG'); bucketize(fg, FG_BUCKETS, 'FG', sc, approx); }
  const mg = byEv(forPos('K'), 'MG');
  if (mg.length) {
    seen.add('MG');
    sc.fgmiss = ruleVal(mg, 35);
    if ([20, 45, 55].some(d => ruleVal(mg, d) !== sc.fgmiss)) approx.add('MG');
  }
  const tpa = byEv(forPos('DEF'), 'TPA');
  if (tpa.length) { seen.add('TPA'); bucketize(tpa, PA_BUCKETS, 'TPA', sc, approx); }
  const tya = byEv(forPos('DEF'), 'TYA');
  if (tya.length) { seen.add('TYA'); bucketize(tya, YA_BUCKETS, 'TYA', sc, approx, 10); }

  for (const g of groups) for (const r of g.rules) if (!seen.has(r.ev)) approx.add(r.ev);
  return { scoring: sc, approx: [...approx].sort() };
}

// ── League ───────────────────────────────────────────────────────────────────
function mainBracket(brackets) {
  const list = arr(brackets?.playoffBrackets?.playoffBracket);
  return list.find(b => !/consol|toilet|loser|3rd|third|place/i.test(b.name || '')) || list[0] || null;
}

export function mflLeague({ year, lid, league, rules, brackets, futurePicks, status, prevId }) {
  const L = league?.league || {};
  const slots = mflStartersToSlots(L.starters, { rosterSize: L.rosterSize, ir: L.injuredReserve, taxi: L.taxiSquad });
  const { scoring, approx } = mflRulesToScoring(rules);
  const nTeams = arr(L.franchises?.franchise).length;
  const b = mainBracket(brackets);
  const lastReg = parseInt(L.lastRegularSeasonWeek, 10) || 14;
  const endWeek = parseInt(L.endWeek, 10) || 17;
  const hasFuture = arr(futurePicks?.futureDraftPicks?.franchise).some(f => arr(f.futureDraftPick).length);
  const nflYear = parseInt(status?.year, 10) || year;
  const completed = parseInt(status?.weeks?.CompletedWeek, 10) || 0;
  const live = parseInt(status?.weeks?.LiveScoringWeek, 10) || 0;
  let st = 'in_season';
  if (year < nflYear || (year === nflYear && completed >= endWeek)) st = 'complete';
  else if (year > nflYear || live < (parseInt(L.startWeek, 10) || 1)) st = 'pre_draft';
  const divisions = arr(L.divisions?.division);
  const copies = parseInt(L.rostersPerPlayer, 10) || 1;
  return {
    league_id: `mfl_${year}_${lid}`, name: L.name || `MFL ${lid}`, season: String(year), sport: 'nfl', status: st,
    total_rosters: nTeams, avatar: null, source: 'mfl',
    previous_league_id: prevId ? `mfl_${year - 1}_${prevId}` : null,
    roster_positions: slots.roster_positions, scoring_settings: scoring,
    settings: {
      type: hasFuture ? 2 : 0,                 // MFL has no dynasty flag; tradeable future picks are the tell
      best_ball: String(L.bestLineup).toLowerCase() === 'yes' ? 1 : 0,
      num_teams: nTeams,
      playoff_teams: b ? parseInt(b.teamsInvolved, 10) || 0 : 0,
      playoff_week_start: b ? parseInt(b.startWeek, 10) : lastReg + 1,
      playoff_round_type: 0,
      start_week: parseInt(L.startWeek, 10) || 1,
      last_scored_leg: year < nflYear ? endWeek : Math.min(completed, endWeek),
      leg: Math.min(live || completed + 1, endWeek),
      divisions: divisions.length > 1 ? divisions.length : 0,
      reserve_slots: slots.reserve_slots, taxi_slots: slots.taxi_slots,
      league_average_match: 0,
      trade_deadline: 99,
      draft_rounds: 0,
    },
    metadata: Object.fromEntries(divisions.map((d, i) => [`division_${i + 1}`, d.name])),
    // MFL-only facts the pages may use.
    _mfl: {
      id: lid, year, host: L.baseURL || null, copies, scoring_approx: approx,
      lineup_limits: slots.limits, h2h: String(L.h2h || '').toUpperCase() !== 'NO',
      salaries: String(L.usesSalaries || '') === '1' || /yes/i.test(String(L.usesSalaries || '')),
      lockout: L.lockout || null, history: arr(L.history?.league).map(h => ({ year: +h.year, url: h.url })),
    },
  };
}

// MFL's history list gives each season's own league id (it changes now and then).
export function mflHistoryIds(league) {
  const out = {};
  for (const h of arr(league?.league?.history?.league)) {
    const m = String(h.url || '').match(/\/(\d{4})\/home\/(\d+)/);
    if (m) out[+m[1]] = m[2];
  }
  return out;
}

// ── Users + rosters ──────────────────────────────────────────────────────────
const ownerId = (lid, fid, mine, me) => (mine && fid === mine ? me : `mfl:${lid}:${fid}`);

export function mflUsers({ lid, league, mine, me }) {
  return arr(league?.league?.franchises?.franchise).map(f => ({
    user_id: ownerId(lid, f.id, mine, me),
    display_name: f.owner_name ? String(f.owner_name) : String(f.name || `Team ${rid(f.id)}`),
    avatar: null,
    is_owner: false,
    metadata: { team_name: String(f.name || ''), mfl_franchise: f.id, avatar: f.icon || null },
  }));
}

export function mflRosters({ lid, idx, league, rosters, standings, lineup, rosterPositions, mine, me }) {
  const L = league?.league || {};
  const div = Object.fromEntries(arr(L.divisions?.division).map((d, i) => [d.id, i + 1]));
  const fr = Object.fromEntries(arr(L.franchises?.franchise).map(f => [f.id, f]));
  const st = Object.fromEntries(arr(standings?.leagueStandings?.franchise).map(f => [f.id, f]));
  const posOf = p => idx.posBySid?.[p] || null;
  return arr(rosters?.rosters?.franchise).map(f => {
    const ps = arr(f.player);
    const ids = s => ps.filter(p => s.includes(String(p.status).toUpperCase())).map(p => mapPid(idx, p.id));
    const s = st[f.id] || {};
    const pf = num(s.pf), pa = num(s.pa), pp = num(s.pp);
    const wlt = String(s.h2hwlt || '').split('-').map(Number);
    const starters = lineup?.[f.id] ? orderStarters(lineup[f.id].map(id => mapPid(idx, id)), rosterPositions, posOf) : [];
    return {
      roster_id: rid(f.id), owner_id: ownerId(lid, f.id, mine, me), co_owners: null, league_id: null,
      players: ps.map(p => mapPid(idx, p.id)),
      starters,
      reserve: ids(['INJURED_RESERVE', 'IR']),
      taxi: ids(['TAXI_SQUAD', 'TS']),
      settings: {
        wins: s.h2hw != null ? parseInt(s.h2hw, 10) : wlt[0] || 0,
        losses: s.h2hl != null ? parseInt(s.h2hl, 10) : wlt[1] || 0,
        ties: s.h2ht != null ? parseInt(s.h2ht, 10) : wlt[2] || 0,
        fpts: Math.floor(pf), fpts_decimal: Math.round((pf % 1) * 100),
        fpts_against: Math.floor(pa), fpts_against_decimal: Math.round((pa % 1) * 100),
        ...(pp ? { ppts: Math.floor(pp), ppts_decimal: Math.round((pp % 1) * 100) } : {}),
        division: div[fr[f.id]?.division] || 0,
      },
      metadata: { mfl_franchise: f.id, team_name: String(fr[f.id]?.name || '') },
    };
  });
}

// ── Matchups ─────────────────────────────────────────────────────────────────
// One week in Sleeper's /matchups/{w} shape, from weeklyResults (played weeks) or
// liveScoring (the week in progress). Teams with no opponent get matchup_id null.
export function mflMatchups({ idx, results, live, rosterPositions }) {
  const posOf = p => idx.posBySid?.[p] || null;
  const out = [];
  const add = (f, mid) => {
    let starters = [], bench = [], pts = {};
    if (f.starters != null || f.nonstarters != null) {
      starters = csvIds(f.starters); bench = csvIds(f.nonstarters);
      for (const p of arr(f.player)) if (p.score != null) pts[p.id] = num(p.score);
    } else {
      for (const p of arr(f.players?.player || f.player)) {
        (String(p.status).toLowerCase() === 'starter' ? starters : bench).push(p.id);
        if (p.score != null) pts[p.id] = num(p.score);
      }
    }
    const st = orderStarters(starters.map(id => mapPid(idx, id)), rosterPositions, posOf);
    const players_points = {};
    for (const [id, v] of Object.entries(pts)) players_points[mapPid(idx, id)] = v;
    out.push({
      roster_id: rid(f.id), matchup_id: mid, points: num(f.score),
      starters: st, starters_points: st.map(p => players_points[p] ?? 0),
      players: [...starters, ...bench].map(id => mapPid(idx, id)), players_points,
      custom_points: null,
      ...(f.gameSecondsRemaining != null ? { _secs_left: parseInt(f.gameSecondsRemaining, 10) } : {}),
    });
  };
  const src = live?.liveScoring || results?.weeklyResults || {};
  arr(src.matchup).forEach((m, i) => arr(m.franchise).forEach(f => add(f, i + 1)));
  for (const f of arr(src.franchise)) add(f, null);        // points-only leagues / byes
  return out;
}

// The lineup each franchise has set for a week (weeklyResults lists starters
// before the games are played).
export function mflLineups(results) {
  const out = {};
  const src = results?.weeklyResults || {};
  const all = [...arr(src.matchup).flatMap(m => arr(m.franchise)), ...arr(src.franchise)];
  for (const f of all) {
    out[f.id] = f.starters != null ? csvIds(f.starters)
      : arr(f.player).filter(p => String(p.status).toLowerCase() === 'starter').map(p => p.id);
  }
  return out;
}

// ── Picks ────────────────────────────────────────────────────────────────────
export function mflTradedPicks(futurePicks) {
  const out = [];
  for (const f of arr(futurePicks?.futureDraftPicks?.franchise)) {
    for (const p of arr(f.futureDraftPick)) {
      if (p.originalPickFor === f.id) continue;
      out.push({ season: String(p.year), round: parseInt(p.round, 10), roster_id: rid(p.originalPickFor),
                 owner_id: rid(f.id), previous_owner_id: null });
    }
  }
  return out;
}

export function mflDraft({ year, lid, draftResults, nTeams }) {
  const unit = arr(draftResults?.draftResults?.draftUnit)[0];
  const picks = arr(unit?.draftPick);
  if (!picks.length) return null;
  const rounds = Math.max(...picks.map(p => parseInt(p.round, 10) || 0));
  const r1 = picks.filter(p => parseInt(p.round, 10) === 1).sort((a, b) => a.pick - b.pick);
  // Sleeper's slot map is each slot's ORIGINAL owner. MFL's results say who made
  // the pick, so a traded first-rounder would put one team in two slots — only
  // keep the map when it's one slot per team.
  const r1Teams = r1.map(p => rid(p.franchise));
  const slot_to_roster_id = new Set(r1Teams).size === r1Teams.length
    ? Object.fromEntries(r1Teams.map((t, i) => [String(i + 1), t])) : null;
  const made = picks.filter(p => p.player).length;
  const r2 = picks.filter(p => parseInt(p.round, 10) === 2).sort((a, b) => a.pick - b.pick);
  const snake = r2.length && r1.length && r2[0].franchise === r1[r1.length - 1].franchise;
  return {
    draft_id: `mfl_${year}_${lid}`, league_id: `mfl_${year}_${lid}`, season: String(year), sport: 'nfl',
    status: made === 0 ? 'pre_draft' : made < picks.length ? 'drafting' : 'complete',
    type: snake ? 'snake' : 'linear',
    start_time: picks.length ? parseInt(picks[0].timestamp, 10) * 1000 || null : null,
    settings: { rounds, teams: nTeams || r1.length },
    slot_to_roster_id, draft_order: null, metadata: { name: 'MFL draft' },
  };
}

export function mflDraftPicks({ idx, draftResults, mplayers }) {
  const unit = arr(draftResults?.draftResults?.draftUnit)[0];
  const picks = arr(unit?.draftPick).filter(p => p.player);
  const perRound = Math.max(1, ...arr(unit?.draftPick).map(p => parseInt(p.pick, 10) || 0));
  return picks.map(p => {
    const round = parseInt(p.round, 10), pick = parseInt(p.pick, 10);
    const sid = mapPid(idx, p.player);
    const mp = mplayers?.[p.player];
    const [first, ...rest] = mp ? mflDisplayName(mp.name).split(' ') : [''];
    return {
      round, pick_no: (round - 1) * perRound + pick, draft_slot: pick, roster_id: rid(p.franchise),
      player_id: sid, picked_by: null, is_keeper: null,
      metadata: mp ? { first_name: first, last_name: rest.join(' '), position: MFL_POS[mp.position] || mp.position,
                       team: mflTeam(mp.team) } : {},
    };
  });
}

// ── Playoffs ─────────────────────────────────────────────────────────────────
// The championship bracket in Sleeper's winners_bracket shape.
export function mflWinnersBracket(bracket) {
  const rounds = arr(bracket?.playoffBracket?.playoffRound);
  const out = [];
  const winnerOf = {};
  rounds.forEach((rd, ri) => {
    for (const g of arr(rd.playoffGame)) {
      const h = g.home || {}, a = g.away || {};
      const hp = h.points != null ? num(h.points) : null, ap = a.points != null ? num(a.points) : null;
      const t1 = h.franchise_id ? rid(h.franchise_id) : null, t2 = a.franchise_id ? rid(a.franchise_id) : null;
      const done = hp != null && ap != null && (hp || ap);
      const w = done ? (hp >= ap ? t1 : t2) : null, l = done ? (hp >= ap ? t2 : t1) : null;
      winnerOf[g.game_id] = w;
      out.push({
        r: ri + 1, m: parseInt(g.game_id, 10), t1, t2, w, l,
        ...(h.winner_of_game ? { t1_from: { w: parseInt(h.winner_of_game, 10) } } : {}),
        ...(a.winner_of_game ? { t2_from: { w: parseInt(a.winner_of_game, 10) } } : {}),
        ...(ri === rounds.length - 1 && arr(rd.playoffGame).length === 1 ? { p: 1 } : {}),
      });
    }
  });
  return out;
}

export { mainBracket };
