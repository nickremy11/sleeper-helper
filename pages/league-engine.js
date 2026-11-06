// ════════════════════════════════════════════════════════════════════════════
// League engine — the one copy of everything that decides a league's numbers:
// lineups, playoff odds, pick ownership and pick value. League Summaries,
// League Analyzer and Trade Analyzer all read it, so a change here moves all
// three. Pure (no DOM, no fetch); load it after shared-utils.js.
// ════════════════════════════════════════════════════════════════════════════

// A few leagues have no playoff bracket — the champion is simply whoever scores
// the most points over the full season. No reliable Sleeper setting exists for
// this, so it's a manual allowlist.
const POINTS_ONLY_LEAGUES = new Set(['1318053615725715456']);
const POINTS_ONLY_TOP_COUNT = 3;

// ── Lineups ─────────────────────────────────────────────────────────────────

const POS_CV = { QB: 0.43, RB: 0.50, WR: 0.52, TE: 0.58, DL: 0.55, LB: 0.55, DB: 0.55 };

// Generic dot product: multiplies every stat the league scores. Safe on a stat
// line's non-scoring fields because no league scores those keys.
function computeProjPts(stats, scoring) {
  let pts = 0;
  for (const [k, v] of Object.entries(stats || {})) {
    if (typeof v === 'number' && scoring[k]) pts += v * scoring[k];
  }
  return pts;
}

// Best lineup from a pool of {pid, pos, pts}. Greedy is exact here: dedicated
// slots first, then flexes narrowest-first, and those eligibilities nest.
function pickOptimalLineup(pool, rosterPositions) {
  const slots = (rosterPositions || []).filter(s => !['BN','IR','TAXI'].includes(s));
  const dedicated = slots.filter(s => !SLOT_ELIG[s]);
  const flexes = slots.filter(s => SLOT_ELIG[s]).sort((a, b) => FLEX_ORDER.indexOf(a) - FLEX_ORDER.indexOf(b));
  const left = [...pool].sort((a, b) => b.pts - a.pts);
  const starters = [];
  for (const slot of [...dedicated, ...flexes]) {
    const elig = SLOT_ELIG[slot] || [crNormPos(slot)];
    const i = left.findIndex(p => elig.includes(p.pos));
    if (i >= 0) starters.push({ ...left.splice(i, 1)[0], slot: SLOT_ELIG[slot] ? slot : crNormPos(slot) });
  }
  return { starters, bench: left };
}

function lineupPool(playerIds, players, ptsOf) {
  return (playerIds || []).map(pid => {
    const p = players[pid];
    const pos = p && crNormPos(p.position);
    return pos ? { pid, pos, name: p.full_name || pid, pts: ptsOf(pid) } : null;
  }).filter(Boolean);
}

// Returns {mu, sigma} for a team's optimal projected lineup for one week. Sigma
// comes from the position CVs, so no historical data is needed.
function optimalLineupAndSigma(playerIds, projMap, scoring, rosterPositions, players) {
  const pool = lineupPool(playerIds, players, pid => computeProjPts(projMap?.[pid], scoring));
  let mu = 0, sigSq = 0;
  for (const pl of pickOptimalLineup(pool, rosterPositions).starters) {
    mu += pl.pts;
    sigSq += ((POS_CV[pl.pos] ?? 0.50) * pl.pts) ** 2;
  }
  return { mu, sigma: Math.max(10, Math.sqrt(sigSq)) };
}

// ── Playoff odds ────────────────────────────────────────────────────────────

function gaussianRandom(mu, sigma) {
  let u, v;
  do { u = Math.random(); } while (!u);
  do { v = Math.random(); } while (!v);
  return Math.max(0, mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
}

// Teams that skip round one of a single-elimination bracket: 6-team playoffs → 2,
// 7 → 1, 4 or 8 → 0.
function bracketByeSlots(playoffTeams) {
  if (!(playoffTeams > 1)) return 0;
  let p = 1;
  while (p < playoffTeams) p *= 2;
  return p - playoffTeams;
}

// Sleeper's own "potential points" (Max PF). Null until Sleeper has scored a
// week, so callers fall back to points for.
function sleeperMaxPf(roster) {
  const whole = roster?.settings?.ppts;
  return whole ? whole + (roster.settings.ppts_decimal || 0) / 100 : null;
}

// Starts every team from its banked wins / PF / Max PF and plays out futureWeeks.
// Teams are {rosterId, wins, fpts, maxPf?}. Scores are drawn around each roster's
// optimal lineup, so the simulated points add directly to Max PF.
//
// opts.median: the league plays a second game each week against the median, so
// the top half earn a second win. Sleeper's banked `wins` already count both, so
// this must always be on for a median league — never add one half without the other.
// opts.pointsOnly: rank by total points instead of record. `odds` is then "finishes
// #1 in points", `bye` is "finishes top 3" and `lastPf` is fewest points scored.
//
// Returns per-roster fractions {odds, bye, lastPf}; bye is null when the bracket
// has no byes.
function runSimulation(teams, matchupsByWeek, muMap, sigmaMap, futureWeeks, playoffTeams, opts = {}, N = 5000) {
  const pointsOnly = !!opts.pointsOnly;
  const median     = !!opts.median;
  const seedSlots  = pointsOnly ? 1 : playoffTeams;
  const byeSlots   = pointsOnly ? POINTS_ONLY_TOP_COUNT : bracketByeSlots(playoffTeams);
  const count = {}, countBye = {}, countLast = {};
  for (const t of teams) { count[t.rosterId] = 0; countBye[t.rosterId] = 0; countLast[t.rosterId] = 0; }

  for (let sim = 0; sim < N; sim++) {
    const wins = {}, pts = {}, maxPf = {};
    for (const t of teams) { wins[t.rosterId] = t.wins; pts[t.rosterId] = t.fpts; maxPf[t.rosterId] = t.maxPf ?? t.fpts; }

    for (const week of futureWeeks) {
      const groups = {};
      for (const m of (matchupsByWeek[week] || [])) {
        if (!m.matchup_id) continue;
        (groups[m.matchup_id] = groups[m.matchup_id] || []).push(m);
      }
      const weekScores = [];
      for (const pair of Object.values(groups)) {
        if (pair.length !== 2) continue;
        const [a, b] = pair;
        const sA = gaussianRandom(muMap[a.roster_id]?.[week] ?? 100, sigmaMap[a.roster_id]?.[week] ?? 20);
        const sB = gaussianRandom(muMap[b.roster_id]?.[week] ?? 100, sigmaMap[b.roster_id]?.[week] ?? 20);
        pts[a.roster_id]   = (pts[a.roster_id]   || 0) + sA;
        pts[b.roster_id]   = (pts[b.roster_id]   || 0) + sB;
        maxPf[a.roster_id] = (maxPf[a.roster_id] || 0) + sA;
        maxPf[b.roster_id] = (maxPf[b.roster_id] || 0) + sB;
        if      (sA > sB) wins[a.roster_id] = (wins[a.roster_id] || 0) + 1;
        else if (sB > sA) wins[b.roster_id] = (wins[b.roster_id] || 0) + 1;
        weekScores.push([a.roster_id, sA], [b.roster_id, sB]);
      }
      if (median && weekScores.length > 1) {
        const cut = weekScores.map(x => x[1]).sort((x, y) => y - x)[Math.floor(weekScores.length / 2)];
        for (const [rid, s] of weekScores) if (s > cut) wins[rid] = (wins[rid] || 0) + 1;
      }
    }

    const ranked = teams.slice().sort((a, b) => {
      if (pointsOnly) return (pts[b.rosterId] || 0) - (pts[a.rosterId] || 0);
      const wd = (wins[b.rosterId] || 0) - (wins[a.rosterId] || 0);
      return wd !== 0 ? wd : (pts[b.rosterId] || 0) - (pts[a.rosterId] || 0);
    });
    for (let i = 0; i < Math.min(seedSlots, ranked.length); i++) count[ranked[i].rosterId]++;
    for (let i = 0; i < Math.min(byeSlots, ranked.length); i++) countBye[ranked[i].rosterId]++;

    const lastBy = pointsOnly ? pts : maxPf;
    let last = teams[0];
    for (const t of teams) if (lastBy[t.rosterId] < lastBy[last.rosterId]) last = t;
    if (last) countLast[last.rosterId]++;
  }

  const odds = {}, bye = byeSlots ? {} : null, lastPf = {};
  for (const t of teams) {
    odds[t.rosterId]   = count[t.rosterId] / N;
    lastPf[t.rosterId] = countLast[t.rosterId] / N;
    if (bye) bye[t.rosterId] = countBye[t.rosterId] / N;
  }
  return { odds, bye, lastPf };
}

// Season over: the same shape as runSimulation, read straight off the standings.
function finalStandingOdds(teams, playoffTeams, opts = {}) {
  const pointsOnly = !!opts.pointsOnly;
  const seedSlots  = pointsOnly ? 1 : playoffTeams;
  const byeSlots   = pointsOnly ? POINTS_ONLY_TOP_COUNT : bracketByeSlots(playoffTeams);
  const ranked = [...teams].sort((a, b) => pointsOnly ? b.fpts - a.fpts : (b.wins - a.wins) || (b.fpts - a.fpts));
  const lastVal = t => pointsOnly ? t.fpts : (t.maxPf ?? t.fpts);
  const low = Math.min(...teams.map(lastVal));
  const lastTeams = teams.filter(t => lastVal(t) === low);
  const odds = {}, bye = byeSlots ? {} : null, lastPf = {};
  ranked.forEach((t, i) => {
    odds[t.rosterId]   = i < seedSlots ? 1 : 0;
    lastPf[t.rosterId] = lastTeams.includes(t) ? 1 / lastTeams.length : 0;
    if (bye) bye[t.rosterId] = i < byeSlots ? 1 : 0;
  });
  return { odds, bye, lastPf };
}

// ── Picks: who owns them ────────────────────────────────────────────────────

// Roster id → the owner's Sleeper display name. Picks are always attributed to
// the person, never the team name, which changes far more often.
function rosterOwnerNames(rosters, users) {
  const byUser = {};
  for (const u of (users || [])) byUser[u.user_id] = u.display_name || u.username;
  const out = {};
  for (const r of (rosters || [])) out[r.roster_id] = byUser[r.owner_id] || `Roster ${r.roster_id}`;
  return out;
}

// The picks one roster holds: every team starts with its own, then traded_picks
// (one row per moved pick, roster_id = original slot, owner_id = current holder)
// overrides. Returns [{season, round, orig, viaName}], where viaName is the
// original owner's name on an acquired pick and null on the team's own.
//
// firstSeason:  earliest season to include (next season, or this one pre-draft).
// seasons:      how many seasons the window spans.
// windowOnly:   ignore a traded pick beyond the window instead of widening to it.
function ownedPicks({ rosterId, rosters, tradedPicks, firstSeason, rounds, seasons = 3, windowOnly = false, ownerNames = {} }) {
  const first = parseInt(firstSeason);
  const seasonSet = new Set();
  for (let y = first; y < first + seasons; y++) seasonSet.add(String(y));
  if (!windowOnly) {
    for (const tp of (tradedPicks || [])) if (parseInt(tp.season) >= first) seasonSet.add(String(tp.season));
  }
  const holder = {};
  for (const r of (rosters || [])) {
    for (const season of seasonSet) {
      for (let round = 1; round <= rounds; round++) holder[`${season}_${round}_${r.roster_id}`] = r.roster_id;
    }
  }
  for (const tp of (tradedPicks || [])) {
    const key = `${tp.season}_${tp.round}_${tp.roster_id}`;
    if (key in holder) holder[key] = tp.owner_id;
  }
  const picks = [];
  for (const [key, ownerId] of Object.entries(holder)) {
    if (String(ownerId) !== String(rosterId)) continue;
    const [season, round, orig] = key.split('_');
    const origId = parseInt(orig);
    picks.push({
      season, round: parseInt(round), orig: origId,
      viaName: String(origId) !== String(rosterId) ? (ownerNames[origId] || `Roster ${origId}`) : null,
    });
  }
  return picks;
}

// ── Picks: what they're worth ───────────────────────────────────────────────

// FC pick values: {year_round_qualifier: value} for a banded entry ("2027 1st
// (Mid)"), {year_round: value} for FC's unqualified entry ("2027 1st"). They stay
// separate on purpose: defaulting the unqualified one to `mid` overwrote the real
// Mid value, and letting the bare key hold the max made it silently mean Early.
function buildPickValueMap(fcRes) {
  const map = {};
  // FC marks picks with position "PI"; fall back to no-sleeperId for older formats.
  const isPickItem = item => {
    const pos = (item.player?.position || '').toUpperCase();
    if (pos === 'PI' || pos === 'PICK') return true;
    const sid = item.player?.sleeperId || item.player?.maybeSleeperID;
    return !sid || String(sid) === '0';
  };
  for (const item of (fcRes || [])) {
    if (!isPickItem(item)) continue;
    const name = (item.player?.name || '').toLowerCase();
    if (!name) continue;
    const yearM = name.match(/20(\d\d)/);
    if (!yearM) continue;
    const year = '20' + yearM[1];
    let round = 0;
    if      (/\b1(st)?\b/.test(name) || /first/.test(name))  round = 1;
    else if (/\b2(nd)?\b/.test(name) || /second/.test(name)) round = 2;
    else if (/\b3(rd)?\b/.test(name) || /third/.test(name))  round = 3;
    else if (/\b4(th)?\b/.test(name) || /fourth/.test(name)) round = 4;
    else if (/\b5(th)?\b/.test(name) || /fifth/.test(name))  round = 5;
    else if (/\b6(th)?\b/.test(name) || /sixth/.test(name))  round = 6;
    if (!round) continue;
    const q = /early/.test(name)   ? 'early'
            : /late/.test(name)    ? 'late'
            : /\bmid\b/.test(name) ? 'mid'
            : null;
    if (q) map[`${year}_${round}_${q}`] = item.value;
    else   map[`${year}_${round}`]      = item.value;
  }
  return map;
}

// Playoff odds → the slot band that team's own pick is likely to land in.
const pickQualForOdds = o => (o >= 0.70 ? 'late' : o >= 0.30 ? 'mid' : 'early');

// Does FC publish Early/Mid/Late for this season yet? It only does so for the
// upcoming rookie class; everything further out is one flat price per round.
const fcHasQuals = (fcPickMap, season) =>
  ['early', 'mid', 'late'].some(q => fcPickMap[`${season}_1_${q}`] != null);

// qualOverride forces the band instead of deriving it from the CURRENT season's
// draft order, which says nothing about a future season.
function getPickValue(season, round, origRosterId, ridToSlot, numTeams, fcPickMap, qualOverride) {
  if (round > 4) return 0;
  let q = qualOverride || null;
  if (!q) {
    q = 'mid';
    const slot = ridToSlot?.[String(origRosterId)];
    if (slot && numTeams > 0) {
      const third = Math.ceil(numTeams / 3);
      if (slot <= third) q = 'early';
      else if (slot > numTeams - third) q = 'late';
    }
  }
  // Real banded value first, then FC's own unqualified price for the round, then
  // the remaining bands as a last resort.
  return fcPickMap[`${season}_${round}_${q}`]
      || fcPickMap[`${season}_${round}`]
      || fcPickMap[`${season}_${round}_mid`]
      || fcPickMap[`${season}_${round}_early`]
      || 0;
}

// Next-year picks are re-valued off the ORIGINAL team's playoff odds (bad team →
// likely early pick → worth more). This re-READS FC's price for the implied band;
// the ×2.0/×1.4/×1.0 multiplier survives only for a season FC hasn't banded, since
// it overshoots FC's own "(Early)" ceiling. Updates pick.val and team.draft in place.
function revaluePicksByOdds(teams, oddsByRoster, { nextSeason, ridToSlot, numTeams, fcPickMap }) {
  const banded = fcHasQuals(fcPickMap, nextSeason);
  for (const t of teams) {
    let total = 0;
    for (const pick of t.pickList) {
      const o = pick.season === nextSeason && pick.originalRosterId != null ? oddsByRoster[pick.originalRosterId] : null;
      if (o != null) {
        if (banded) {
          const val = getPickValue(pick.season, pick.round, pick.originalRosterId, ridToSlot, numTeams, fcPickMap, pickQualForOdds(o));
          if (val > 0) pick.val = val;
        } else {
          pick.val = Math.round(pick.val * (o >= 0.70 ? 1.0 : o >= 0.30 ? 1.4 : 2.0));
        }
      }
      total += pick.val;
    }
    t.draft = Math.round(total);
  }
}

// ── Maps and shared labels ──────────────────────────────────────────────────

// opts.redraft reads FC's redraftValue instead of its dynasty value. FC returns
// both either way, but numQbs/ppr on the request must still match the league.
function buildFcMap(fcRes, opts = {}) {
  const map = {};
  const key = opts.redraft ? 'redraftValue' : 'value';
  for (const item of (fcRes || [])) {
    const sid = item.player?.sleeperId || item.player?.maybeSleeperID;
    if (sid) map[String(sid)] = item[key];
  }
  return map;
}

function buildPlayerMap(playersRes) {
  const KEEP = new Set(['QB','RB','WR','TE','DEF','DL','LB','DB','S','CB','DE','DT','FS','SS','IDL','OLB','ILB','MLB','SAF','NT']);
  const players = {}, byName = {};
  const rankOf = p => (p.search_rank != null && p.search_rank < 9999999) ? p.search_rank : Infinity;
  for (const [pid, p] of Object.entries(playersRes || {})) {
    if (!KEEP.has(p.position)) continue;
    players[pid] = p;
    if (!p.full_name) continue;
    // On a name collision keep the more fantasy-relevant player.
    const key = normName(p.full_name);
    if (byName[key] == null || rankOf(p) < rankOf(players[byName[key]])) byName[key] = pid;
  }
  return { players, byName };
}

function computeRanks(teams) {
  const rankBy = getter => {
    const map = {};
    [...teams].sort((a, b) => getter(b) - getter(a)).forEach((t, i) => { map[t.rosterId] = i + 1; });
    return map;
  };
  return {
    overall: rankBy(t => t.overall), contender: rankBy(t => t.contender ?? 0),
    QB: rankBy(t => t.posValues.QB), RB: rankBy(t => t.posValues.RB),
    WR: rankBy(t => t.posValues.WR), TE: rankBy(t => t.posValues.TE),
    DL: rankBy(t => t.posValues.DL), draft: rankBy(t => t.draft),
  };
}

function rankColor(rank, total) {
  const hue = Math.round(120 * (1 - (rank - 1) / Math.max(total - 1, 1)));
  return `hsl(${hue}, 62%, 38%)`;
}

function buildFormatFlags(lg) {
  const sc = lg.scoring_settings || {}, rp = lg.roster_positions || [];
  const flags = [];
  const starters = rp.filter(p => !['BN','IR','TAXI'].includes(p)).length;
  if (starters) flags.push({ label: starters + ' Starters', hi: false });
  flags.push(rp.includes('SUPER_FLEX') ? { label: 'SF', hi: false } : { label: '1QB', hi: false });
  const rec = sc.rec ?? 1;
  if (rec === 0)    flags.push({ label: 'Std',       hi: false });
  else if (rec < 1) flags.push({ label: rec + 'PPR', hi: true  });
  else              flags.push({ label: 'PPR',       hi: true  });
  if ((sc.bonus_rec_te ?? 0) > 0) flags.push({ label: '+' + sc.bonus_rec_te + 'TEP', hi: true });
  if ((sc.bonus_rec_wr ?? 0) > 0) flags.push({ label: '+' + sc.bonus_rec_wr + 'WRP', hi: true });
  if (rp.filter(p => p === 'TE').length >= 2) flags.push({ label: '2xTE', hi: false });
  if ((sc.bonus_rec_fd  ?? 0) > 0) flags.push({ label: '+' + sc.bonus_rec_fd + 'FD', hi: true });
  if ((sc.bonus_rush_fd ?? sc.rush_fd ?? 0) > 0) flags.push({ label: '+' + (sc.bonus_rush_fd ?? sc.rush_fd) + 'RFD', hi: true });
  if ((sc.rush_att ?? sc.rush_attempt ?? 0) > 0) flags.push({ label: 'PPC', hi: true });
  if ((sc.pass_td ?? 4) !== 4) flags.push({ label: (sc.pass_td ?? 4) + 'ptTD', hi: true });
  if ((sc.bonus_rush_yd_100 ?? sc.bonus_rec_yd_100 ?? 0) > 0) flags.push({ label: 'BigPlay', hi: true });
  if ((sc.kr_yd ?? sc.pr_yd ?? sc.kr_td ?? sc.pr_td ?? 0) > 0) flags.push({ label: 'Ret', hi: true });
  return flags;
}

// Writes a sim or final-standings result onto a page's team objects.
function applyOddsToTeams(teams, { odds, bye, lastPf }) {
  for (const t of teams) {
    t.playoffOdds   = odds[t.rosterId] ?? null;
    t.byeOdds       = bye?.[t.rosterId] ?? null;
    t.lastPlaceOdds = lastPf[t.rosterId] ?? null;
  }
}
