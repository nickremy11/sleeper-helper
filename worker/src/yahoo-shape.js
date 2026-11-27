// ── Yahoo → Sleeper shapes (pure) ─────────────────────────────────────────────
// The Yahoo twin of mfl-shape.js: Yahoo's XML (already read by yahoo-xml.js)
// turned into the Sleeper shapes every page reads, players in Sleeper ids. No
// I/O — src/yahoo.js fetches, this reshapes, tests/yahoo.test.js runs it against
// the sample responses in Yahoo's own API docs.
//
// Ids:  league  yh_{season}_{leagueId}   (Yahoo's league key is {gameId}.l.{leagueId};
//                                          the game id changes every season)
//       roster  Yahoo's team id (1…N)
//       owner   yh:{leagueId}:{teamId}, or the caller's own Sleeper id for the
//               caller's team (saved at discovery)
//       player  the Sleeper id, else `yh_{playerId}`

import { arr, num } from './yahoo-xml.js';
import { normPlayerName } from './player-ids.js';
export { sleeperNameIndex } from './player-ids.js';

// Season ↔ Yahoo NFL game id. Yahoo's docs give 2019 = 390, 2020 = 399, 2025 = 461;
// the rest are the published values. A season missing here is looked up live
// (games;game_codes=nfl;seasons=Y) and cached.
export const YAHOO_NFL_GAME = { 2015: 348, 2016: 359, 2017: 371, 2018: 380, 2019: 390, 2020: 399, 2021: 406,
                                2022: 414, 2023: 423, 2024: 449, 2025: 461 };
export const leagueKeyOf = (gameId, lid) => `${gameId}.l.${lid}`;
export const teamIdOf = teamKey => parseInt(String(teamKey).split('.t.')[1], 10);

// Yahoo team abbreviations that differ from Sleeper's (after upper-casing).
const TEAM = { LA: 'LAR', WSH: 'WAS', JAC: 'JAX', LVR: 'LV', OAK: 'LV', SD: 'LAC', STL: 'LAR' };
export const yahooTeam = t => { const u = String(t || '').toUpperCase(); return TEAM[u] || u; };

// ── Players ──────────────────────────────────────────────────────────────────
// idx = {yahoo: {yahooId: sleeperId}, names: {"name|POS": [[sid, team], …]}}
const POS = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'DEF', DE: 'DL', DT: 'DL', DL: 'DL', LB: 'LB',
              CB: 'DB', S: 'DB', DB: 'DB' };
export const yahooPos = p => POS[String(p || '').split(',')[0].trim().toUpperCase()] || null;

export function yahooPid(idx, p) {
  const id = String(p?.player_id || '');
  if (idx?.yahoo?.[id]) return idx.yahoo[id];
  const pos = yahooPos(p?.display_position || p?.primary_position);
  const team = yahooTeam(p?.editorial_team_abbr);
  if (pos === 'DEF' && team) return team;                 // Sleeper's DEF id IS the team code
  const nm = normPlayerName(p?.name?.full || `${p?.name?.first || ''} ${p?.name?.last || ''}`);
  const hits = idx?.names?.[`${nm}|${pos}`] || [];
  if (hits.length === 1) return hits[0][0];
  const sameTeam = hits.filter(h => h[1] === team);
  if (sameTeam.length === 1) return sameTeam[0][0];
  return `yh_${id}`;
}

// ── Lineup slots ─────────────────────────────────────────────────────────────
const SLOT = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', K: 'K', DEF: 'DEF', 'W/R/T': 'FLEX', 'W/R': 'WRRB_FLEX',
               'W/T': 'REC_FLEX', 'R/T': 'FLEX', 'Q/W/R/T': 'SUPER_FLEX', D: 'IDP_FLEX', DB: 'DB', DL: 'DL', LB: 'LB',
               DE: 'DL', DT: 'DL', CB: 'DB', S: 'DB', BN: 'BN' };
const RESERVE = new Set(['IR', 'IR+', 'NA']);
const ORDER = ['QB', 'RB', 'WR', 'TE', 'WRRB_FLEX', 'REC_FLEX', 'FLEX', 'SUPER_FLEX', 'K', 'DEF', 'DL', 'LB', 'DB', 'IDP_FLEX', 'BN'];
export const yahooSlot = s => SLOT[String(s || '').toUpperCase()] || null;

export function yahooRosterPositions(settings) {
  const out = []; let reserve = 0; const odd = [];
  for (const r of arr(settings?.roster_positions?.roster_position)) {
    const n = parseInt(r.count, 10) || 0;
    if (RESERVE.has(String(r.position).toUpperCase())) { reserve += n; continue; }
    const s = yahooSlot(r.position);
    if (!s) { odd.push(r.position); continue; }
    for (let i = 0; i < n; i++) out.push(s);
  }
  out.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return { roster_positions: out, reserve_slots: reserve, unknown: odd };
}

// Yahoo says which slot each starter is in, so lay them in by slot; anyone left
// over goes in the first empty slot. Empty slot = '0'.
export function orderBySlot(players, rosterPositions) {
  const slots = rosterPositions.filter(s => s !== 'BN');
  const out = new Array(slots.length).fill('0');
  const left = [...players];
  slots.forEach((s, i) => {
    const k = left.findIndex(p => p.slot === s);
    if (k >= 0) { out[i] = left[k].pid; left.splice(k, 1); }
  });
  for (let i = 0; i < out.length && left.length; i++) if (out[i] === '0') out[i] = left.shift().pid;
  return out;
}

// ── Scoring ──────────────────────────────────────────────────────────────────
// Yahoo scores stat ids with one value each, plus threshold bonuses. Ids 1–57
// are stable and documented by Yahoo's sample settings; later ones are matched
// on the stat's name from the league's own stat_categories. Anything that
// doesn't land on a Sleeper key is listed in `approx`.
const BY_ID = {
  1: ['pass_att'], 2: ['pass_cmp'], 3: ['pass_inc'], 4: ['pass_yd'], 5: ['pass_td'], 6: ['pass_int'], 7: ['pass_sack'],
  8: ['rush_att'], 9: ['rush_yd'], 10: ['rush_td'], 11: ['rec'], 12: ['rec_yd'], 13: ['rec_td'],
  14: ['kr_yd', 'pr_yd'], 15: ['st_td'], 16: ['pass_2pt', 'rush_2pt', 'rec_2pt'], 17: ['fum'], 18: ['fum_lost'],
  19: ['fgm_0_19'], 20: ['fgm_20_29'], 21: ['fgm_30_39'], 22: ['fgm_40_49'], 23: ['fgm_50p'],
  24: ['fgmiss_0_19'], 25: ['fgmiss_20_29'], 26: ['fgmiss_30_39'], 27: ['fgmiss_40_49'], 28: ['fgmiss_50p'],
  29: ['xpm'], 30: ['xpmiss'], 32: ['sack'], 33: ['int'], 34: ['fum_rec'], 35: ['def_td'], 36: ['safe'], 37: ['blk_kick'],
  38: ['idp_tkl_solo'], 39: ['idp_tkl_ast'], 40: ['idp_sack'], 41: ['idp_int'], 42: ['idp_ff'], 43: ['idp_fum_rec'],
  44: ['idp_def_td'], 45: ['idp_safe'], 46: ['idp_pass_def'], 47: ['idp_blk_kick'], 49: ['def_st_td'],
  50: ['pts_allow_0'], 51: ['pts_allow_1_6'], 52: ['pts_allow_7_13'], 53: ['pts_allow_14_20'], 54: ['pts_allow_21_27'],
  55: ['pts_allow_28_34'], 56: ['pts_allow_35p'], 57: ['fum_rec_td'], 78: ['rec_tgt'],
};
const BY_NAME = [
  [/^40\+ yard completions/i, ['pass_cmp_40p']], [/^40\+ yard passing touchdowns/i, ['pass_td_40p']],
  [/^40\+ yard run/i, ['rush_40p']], [/^40\+ yard rushing touchdowns/i, ['rush_td_40p']],
  [/^40\+ yard receptions/i, ['rec_40p']], [/^40\+ yard receiving touchdowns/i, ['rec_td_40p']],
  [/pick six/i, ['pass_int_td']], [/^passing first downs/i, ['pass_fd']], [/^receiving first downs/i, ['rec_fd']],
  [/^rushing first downs/i, ['rush_fd']], [/three and outs/i, ['def_3_and_out']], [/4th down stops/i, ['def_4_and_stop']],
  [/^tackles? for loss/i, ['idp_tkl_loss']],
  [/yards allowed 0-99/i, ['yds_allow_0_100']], [/yards allowed 100-199/i, ['yds_allow_100_199']],
  [/yards allowed 200-299/i, ['yds_allow_200_299']], [/yards allowed 300-399/i, ['yds_allow_300_349', 'yds_allow_350_399']],
  [/yards allowed 400-499/i, ['yds_allow_400_449', 'yds_allow_450_499']], [/yards allowed 500\+/i, ['yds_allow_500_549', 'yds_allow_550p']],
];
const BONUS = { 4: { 300: 'bonus_pass_yd_300', 400: 'bonus_pass_yd_400' }, 9: { 100: 'bonus_rush_yd_100', 200: 'bonus_rush_yd_200' },
                12: { 100: 'bonus_rec_yd_100', 200: 'bonus_rec_yd_200' }, 2: { 25: 'bonus_pass_cmp_25' }, 8: { 20: 'bonus_rush_att_20' } };

export function yahooScoring(settings) {
  const cats = Object.fromEntries(arr(settings?.stat_categories?.stats?.stat).map(s => [String(s.stat_id), s]));
  const sc = {}, approx = new Set();
  for (const m of arr(settings?.stat_modifiers?.stats?.stat)) {
    const id = String(m.stat_id), v = num(m.value);
    const name = String(cats[id]?.name || '');
    const keys = BY_ID[id] || BY_NAME.find(([re]) => re.test(name))?.[1];
    if (keys) { if (v) for (const k of keys) sc[k] = v; }
    else if (v) approx.add(name || `stat ${id}`);
    for (const b of arr(m.bonuses?.bonus)) {
      const t = parseInt(b.target, 10), key = BONUS[id]?.[t];
      if (key) sc[key] = (sc[key] || 0) + num(b.points); else approx.add(`${name || 'stat ' + id} bonus ${t}`);
    }
  }
  return { scoring: sc, approx: [...approx].sort() };
}

// ── League ───────────────────────────────────────────────────────────────────
export function yahooLeague({ league, gameToSeason = {} }) {
  const L = league || {};
  const S = L.settings || {};
  const season = parseInt(L.season, 10);
  const slots = yahooRosterPositions(S);
  const { scoring, approx } = yahooScoring(S);
  const prev = String(L.renew || '').match(/^(\d+)_(\d+)$/);
  const prevSeason = prev ? (gameToSeason[prev[1]] || season - 1) : null;
  const cur = parseInt(L.current_week, 10) || 1;
  const end = parseInt(L.end_week, 10) || 17;
  const finished = String(L.is_finished) === '1';
  const status = String(L.draft_status) === 'predraft' ? 'pre_draft' : finished ? 'complete'
               : String(L.draft_status) === 'inprogress' ? 'drafting' : 'in_season';
  const divisions = arr(S.divisions?.division);
  const usesPlayoff = String(S.uses_playoff) !== '0';
  return {
    league_id: `yh_${season}_${L.league_id}`, name: String(L.name || `Yahoo ${L.league_id}`), season: String(season),
    sport: 'nfl', status, total_rosters: parseInt(L.num_teams, 10) || 0, avatar: null, source: 'yahoo',
    previous_league_id: prev ? `yh_${prevSeason}_${prev[2]}` : null,
    roster_positions: slots.roster_positions, scoring_settings: scoring,
    settings: {
      type: 0, best_ball: 0, num_teams: parseInt(L.num_teams, 10) || 0,
      playoff_teams: usesPlayoff ? parseInt(S.num_playoff_teams, 10) || 0 : 0,
      playoff_week_start: parseInt(S.playoff_start_week, 10) || end + 1, playoff_round_type: 0,
      start_week: parseInt(L.start_week, 10) || 1,
      last_scored_leg: finished ? end : Math.max(0, cur - 1), leg: Math.min(cur, end),
      divisions: divisions.length > 1 ? divisions.length : 0, reserve_slots: slots.reserve_slots, taxi_slots: 0,
      league_average_match: 0, trade_deadline: 99, draft_rounds: 0,
    },
    metadata: Object.fromEntries(divisions.map(d => [`division_${d.division_id}`, String(d.name || '')])),
    _yahoo: {
      league_key: L.league_key, id: String(L.league_id), season, url: L.url || null,
      scoring_type: String(L.scoring_type || S.scoring_type || 'head'),   // head | point | headpoint
      scoring_approx: approx, odd_slots: slots.unknown,
      uses_faab: String(S.uses_faab) === '1', trade_end_date: S.trade_end_date || null,
      renewed: L.renewed || null,
    },
  };
}

// ── Users + rosters ──────────────────────────────────────────────────────────
// "Mine" comes from the caller's own saved team id (src/yahoo.js stores it at
// discovery), never from Yahoo's is_owned_by_current_login: league data is
// cached and shared between members, so that flag describes whoever's token
// fetched it, not the person reading.
const ownerOf = (lid, t, me, mine) => (mine != null && String(t.team_id) === String(mine) ? me : `yh:${lid}:${t.team_id}`);

export function yahooUsers({ lid, teams, me, mine }) {
  return arr(teams).map(t => {
    const m = arr(t.managers?.manager)[0] || {};
    return {
      user_id: ownerOf(lid, t, me, mine), display_name: String(m.nickname && m.nickname !== '--hidden--' ? m.nickname : t.name || `Team ${t.team_id}`),
      avatar: null, is_owner: String(m.is_commissioner) === '1',
      metadata: { team_name: String(t.name || ''), yahoo_team: t.team_key, avatar: arr(t.team_logos?.team_logo)[0]?.url || null },
    };
  });
}

export function yahooRosters({ lid, idx, standingsTeams, rosterTeams, rosterPositions, divisions = {}, me, mine }) {
  const st = Object.fromEntries(arr(standingsTeams).map(t => [t.team_key, t]));
  return arr(rosterTeams).map(t => {
    const s = st[t.team_key]?.team_standings || {};
    const o = s.outcome_totals || {};
    const players = arr(t.roster?.players?.player).map(p => ({
      pid: yahooPid(idx, p), sel: String(p.selected_position?.position || 'BN').toUpperCase(),
    }));
    const starters = orderBySlot(players.filter(p => p.sel !== 'BN' && !RESERVE.has(p.sel)).map(p => ({ pid: p.pid, slot: yahooSlot(p.sel) })), rosterPositions);
    const pf = num(s.points_for), pa = num(s.points_against);
    return {
      roster_id: parseInt(t.team_id, 10), owner_id: ownerOf(lid, t, me, mine), co_owners: null, league_id: null,
      players: players.map(p => p.pid),
      starters,
      reserve: players.filter(p => RESERVE.has(p.sel)).map(p => p.pid),
      taxi: [],
      settings: {
        wins: parseInt(o.wins, 10) || 0, losses: parseInt(o.losses, 10) || 0, ties: parseInt(o.ties, 10) || 0,
        fpts: Math.floor(pf), fpts_decimal: Math.round((pf % 1) * 100),
        fpts_against: Math.floor(pa), fpts_against_decimal: Math.round((pa % 1) * 100),
        division: divisions[t.division_id] || parseInt(t.division_id, 10) || 0,
        rank: parseInt(s.rank, 10) || null, playoff_seed: parseInt(s.playoff_seed, 10) || null,
      },
      metadata: { yahoo_team: t.team_key, team_name: String(t.name || '') },
    };
  });
}

// ── Matchups ─────────────────────────────────────────────────────────────────
// One week: pairs + team scores from the scoreboard, each team's lineup and
// player points from its roster for that week (with week stats when fetched).
export function yahooMatchups({ idx, scoreboard, rosterTeams, rosterPositions }) {
  const byTeam = {};
  for (const t of arr(rosterTeams)) {
    const ps = arr(t.roster?.players?.player).map(p => ({
      pid: yahooPid(idx, p), sel: String(p.selected_position?.position || 'BN').toUpperCase(),
      pts: p.player_points?.total != null ? num(p.player_points.total) : null,
    }));
    byTeam[t.team_key] = ps;
  }
  const out = [];
  arr(scoreboard?.matchups?.matchup).forEach((m, i) => {
    for (const t of arr(m.teams?.team)) {
      const ps = byTeam[t.team_key] || [];
      const start = ps.filter(p => p.sel !== 'BN' && !RESERVE.has(p.sel));
      const starters = orderBySlot(start.map(p => ({ pid: p.pid, slot: yahooSlot(p.sel) })), rosterPositions);
      const players_points = {};
      for (const p of ps) if (p.pts != null) players_points[p.pid] = p.pts;
      out.push({
        roster_id: parseInt(t.team_id, 10), matchup_id: i + 1, points: num(t.team_points?.total),
        starters, starters_points: starters.map(p => players_points[p] ?? 0),
        players: ps.map(p => p.pid), players_points, custom_points: null,
        _projected: t.team_projected_points?.total != null ? num(t.team_projected_points.total) : null,
        _playoffs: String(m.is_playoffs) === '1', _consolation: String(m.is_consolation) === '1',
        _winner: m.winner_team_key ? teamIdOf(m.winner_team_key) : null,
      });
    }
  });
  return out;
}

// ── Draft ────────────────────────────────────────────────────────────────────
export function yahooDraft({ season, lid, league, draftResults }) {
  const picks = arr(draftResults);
  const nTeams = parseInt(league?.num_teams, 10) || 0;
  const made = picks.filter(p => p.player_key).length;
  const ds = String(league?.draft_status || '');
  const r1 = picks.filter(p => String(p.round) === '1').sort((a, b) => a.pick - b.pick).map(p => teamIdOf(p.team_key));
  const oneEach = r1.length && new Set(r1).size === r1.length;
  return {
    draft_id: `yh_${season}_${lid}`, league_id: `yh_${season}_${lid}`, season: String(season), sport: 'nfl',
    status: ds === 'predraft' ? 'pre_draft' : ds === 'inprogress' ? 'drafting' : made ? 'complete' : 'pre_draft',
    type: String(league?.settings?.is_auction_draft) === '1' ? 'auction' : 'snake',
    start_time: league?.settings?.draft_time ? parseInt(league.settings.draft_time, 10) * 1000 : null,
    settings: { rounds: Math.max(0, ...picks.map(p => parseInt(p.round, 10) || 0)), teams: nTeams },
    slot_to_roster_id: oneEach ? Object.fromEntries(r1.map((t, i) => [String(i + 1), t])) : null,
    draft_order: null, metadata: { name: 'Yahoo draft' },
  };
}

export function yahooDraftPicks({ idx, draftResults, players = {} }) {
  return arr(draftResults).filter(p => p.player_key).map(p => {
    const yid = String(p.player_key).split('.p.')[1];
    const meta = players[yid];
    const pid = meta ? yahooPid(idx, meta) : (idx?.yahoo?.[yid] || `yh_${yid}`);
    return {
      round: parseInt(p.round, 10), pick_no: parseInt(p.pick, 10), draft_slot: null, roster_id: teamIdOf(p.team_key),
      player_id: pid, picked_by: null, is_keeper: String(p.is_keeper) === '1' || null,
      metadata: meta ? { first_name: meta.name?.first || '', last_name: meta.name?.last || '',
                         position: yahooPos(meta.display_position) || '', team: yahooTeam(meta.editorial_team_abbr) } : {},
      ...(p.cost != null ? { metadata_amount: num(p.cost) } : {}),
    };
  });
}

// ── Playoffs ─────────────────────────────────────────────────────────────────
// Yahoo has no bracket resource — rebuild the championship side from each
// playoff week's scoreboard (is_playoffs and not is_consolation). Byes simply
// don't appear in the first round.
export function yahooWinnersBracket(weeks) {
  const out = [];
  const list = arr(weeks).filter(Boolean);
  list.forEach((sb, ri) => {
    const ms = arr(sb?.matchups?.matchup).filter(m => String(m.is_playoffs) === '1' && String(m.is_consolation) !== '1');
    ms.forEach((m, mi) => {
      const [a, b] = arr(m.teams?.team);
      const t1 = a ? parseInt(a.team_id, 10) : null, t2 = b ? parseInt(b.team_id, 10) : null;
      const done = String(m.status) === 'postevent';
      const w = done && m.winner_team_key ? teamIdOf(m.winner_team_key) : null;
      out.push({ r: ri + 1, m: out.length + 1, t1, t2, w, l: w == null ? null : (w === t1 ? t2 : t1),
                 ...(ri === list.length - 1 && mi === 0 ? { p: 1 } : {}) });
    });
  });
  return out;
}

// ── A user's leagues (users;use_login=1/games;game_keys=…/leagues) ───────────
export function yahooUserLeagues(doc) {
  const out = [];
  for (const u of arr(doc?.users?.user)) for (const g of arr(u.games?.game)) {
    if (String(g.code || g.game_code || 'nfl') !== 'nfl') continue;
    for (const l of arr(g.leagues?.league)) out.push({
      id: String(l.league_id), season: parseInt(l.season || g.season, 10), game_id: String(g.game_id || String(l.league_key).split('.')[0]),
      league_key: String(l.league_key), name: String(l.name || ''), url: l.url || null, num_teams: parseInt(l.num_teams, 10) || null,
    });
  }
  return out;
}
