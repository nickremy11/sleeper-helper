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

// Per-starter weekly spread as a fraction of projected points. Players are drawn
// independently, so a lineup's sigma is these combined in quadrature — which came
// out ~18-24 pts a team, tighter than real fantasy scoring. Hence the 1.3x over
// the old 0.43/0.50/0.52/0.58/0.55 values; odds were skewing too extreme.
// Checked 2026-11-22 against 60 Sleeper leagues / 8,167 team-weeks (wks 1-11):
// real misses vs projection SD 32.6, these CVs give 33.6 — calibrated. ±50 is
// a ~1-in-9 week (90th percentile), not one SD; don't widen without re-measuring.
const POS_CV = { QB: 0.56, RB: 0.65, WR: 0.68, TE: 0.75, DL: 0.72, LB: 0.72, DB: 0.72 };
const DEFAULT_CV = 0.65;
const SIGMA_FLOOR = 15;
// Sigma when a team's mu comes from the FantasyCalc fallback instead of projections.
const fallbackSigma = mu => Math.max(SIGMA_FLOOR, mu * 0.25);

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
    sigSq += ((POS_CV[pl.pos] ?? DEFAULT_CV) * pl.pts) ** 2;
  }
  return { mu, sigma: Math.max(SIGMA_FLOOR, Math.sqrt(sigSq)) };
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

// ── Playoff rules: tiebreaker + who gets in ─────────────────────────────────
//
// rules = { tiebreak: 'pf' | 'h2h', format: 'top' | 'div' | 'pf' }
//   tiebreak 'pf'  — equal records split on points for (the old, only behaviour)
//   tiebreak 'h2h' — head-to-head wins among the tied teams first, then points for
//   format 'top'   — the best N records
//   format 'div'   — every division winner, then the best remaining records
//                    (falls back to 'top' when the league has no divisions)
//   format 'pf'    — the best N-1 records, then the most points of everyone left
//   divSeed 'top'  — under 'div', division winners take the top seeds (and byes)
//   divSeed 'record' — under 'div', winners only get in; everyone is seeded by record
// h2h(a, b) = games a has won against b (a tie counts ½). division = {rid: div}.
const PLAYOFF_RULES_DEFAULT = { tiebreak: 'pf', format: 'top', divSeed: 'top' };

// Record order: wins, then the tiebreaker. Returns roster ids, best first.
function recordOrder(ids, wins, pts, rules, h2h) {
  const byPf = (a, b) => (pts[b] || 0) - (pts[a] || 0);
  const sorted = ids.slice().sort((a, b) => ((wins[b] || 0) - (wins[a] || 0)) || byPf(a, b));
  if (rules?.tiebreak !== 'h2h' || !h2h) return sorted;
  // Re-order each block of equal wins by H2H wins against the rest of the block.
  const out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && (wins[sorted[j]] || 0) === (wins[sorted[i]] || 0)) j++;
    const block = sorted.slice(i, j);
    if (block.length > 1) {
      const hw = {};
      for (const a of block) hw[a] = block.reduce((s, b) => s + (a === b ? 0 : h2h(a, b)), 0);
      block.sort((a, b) => (hw[b] - hw[a]) || byPf(a, b));
    }
    out.push(...block);
    i = j;
  }
  return out;
}

// Playoff seeds under `rules`: {seeds: [rid…] (length ≤ playoffTeams), order}.
// Byes go to the first seeds, so division winners take them under 'div' unless
// rules.divSeed is 'record'.
function playoffSeeds(ids, wins, pts, playoffTeams, rules = PLAYOFF_RULES_DEFAULT, h2h = null, division = null) {
  const order = recordOrder(ids, wins, pts, rules, h2h);
  const n = Math.min(playoffTeams, order.length);
  const fmt = rules?.format || 'top';
  if (fmt === 'pf' && n > 1) {
    const seeds = order.slice(0, n - 1);
    const rest  = order.slice(n - 1).sort((a, b) => (pts[b] || 0) - (pts[a] || 0));
    seeds.push(rest[0]);
    return { seeds, order };
  }
  if (fmt === 'div' && division) {
    const seen = new Set(), winners = [];
    for (const rid of order) {
      const dv = division[rid];
      if (dv == null || seen.has(dv)) continue;
      seen.add(dv); winners.push(rid);
    }
    if (seen.size > 1) {
      const w = winners.slice(0, n);
      const wSet = new Set(w);
      const seeds = w.concat(order.filter(r => !wSet.has(r)).slice(0, n - w.length));
      if (rules.divSeed === 'record') {
        const rank = new Map(order.map((r, i) => [r, i]));
        seeds.sort((a, b) => rank.get(a) - rank.get(b));
      }
      return { seeds, order };
    }
  }
  return { seeds: order.slice(0, n), order };
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
// opts.rules / opts.h2h / opts.division: see playoffSeeds. opts.h2h is the
// banked {a: {b: wins}}; simulated games are added on top per sim.
//
// Returns per-roster fractions {odds, bye, lastPf}; bye is null when the bracket
// has no byes.
function runSimulation(teams, matchupsByWeek, muMap, sigmaMap, futureWeeks, playoffTeams, opts = {}, N = 5000) {
  const pointsOnly = !!opts.pointsOnly;
  const median     = !!opts.median;
  const seedSlots  = pointsOnly ? 1 : playoffTeams;
  const byeSlots   = pointsOnly ? POINTS_ONLY_TOP_COUNT : bracketByeSlots(playoffTeams);
  const rules      = opts.rules || PLAYOFF_RULES_DEFAULT;
  const useH2h     = !pointsOnly && rules.tiebreak === 'h2h';
  const bankedH2h  = opts.h2h || {};
  const ids        = teams.map(t => t.rosterId);
  const count = {}, countBye = {}, countLast = {};
  for (const t of teams) { count[t.rosterId] = 0; countBye[t.rosterId] = 0; countLast[t.rosterId] = 0; }

  for (let sim = 0; sim < N; sim++) {
    const wins = {}, pts = {}, maxPf = {};
    const simH2h = useH2h ? {} : null;
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
        const winner = sA > sB ? a.roster_id : sB > sA ? b.roster_id : null;
        if (winner != null) {
          wins[winner] = (wins[winner] || 0) + 1;
          if (simH2h) {
            const k = winner + '_' + (winner === a.roster_id ? b.roster_id : a.roster_id);
            simH2h[k] = (simH2h[k] || 0) + 1;
          }
        }
        weekScores.push([a.roster_id, sA], [b.roster_id, sB]);
      }
      if (median && weekScores.length > 1) {
        const cut = weekScores.map(x => x[1]).sort((x, y) => y - x)[Math.floor(weekScores.length / 2)];
        for (const [rid, s] of weekScores) if (s > cut) wins[rid] = (wins[rid] || 0) + 1;
      }
    }

    if (pointsOnly) {
      const ranked = ids.slice().sort((a, b) => (pts[b] || 0) - (pts[a] || 0));
      for (let i = 0; i < Math.min(seedSlots, ranked.length); i++) count[ranked[i]]++;
      for (let i = 0; i < Math.min(byeSlots, ranked.length); i++) countBye[ranked[i]]++;
    } else {
      const h2h = useH2h ? (x, y) => (bankedH2h[x]?.[y] || 0) + (simH2h[x + '_' + y] || 0) : null;
      const { seeds } = playoffSeeds(ids, wins, pts, playoffTeams, rules, h2h, opts.division);
      for (const rid of seeds) count[rid]++;
      for (let i = 0; i < Math.min(byeSlots, seeds.length); i++) countBye[seeds[i]]++;
    }

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
  let ranked;
  if (pointsOnly) ranked = [...teams].sort((a, b) => b.fpts - a.fpts);
  else {
    const wins = {}, pts = {}, byId = {};
    for (const t of teams) { wins[t.rosterId] = t.wins; pts[t.rosterId] = t.fpts; byId[t.rosterId] = t; }
    const banked = opts.h2h || {};
    const h2h = (x, y) => banked[x]?.[y] || 0;
    const { seeds, order } = playoffSeeds(teams.map(t => t.rosterId), wins, pts, playoffTeams,
      opts.rules || PLAYOFF_RULES_DEFAULT, h2h, opts.division);
    const seedSet = new Set(seeds);
    ranked = seeds.concat(order.filter(r => !seedSet.has(r))).map(r => byId[r]);
  }
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

// ── TE premium on FantasyCalc values ────────────────────────────────────────
// FantasyCalc's own `tep` setting is a flat multiplier on tight ends and moves
// nobody else (measured against the live API: te+ = ×1.149, te++ = ×1.29 on all
// 66 TEs). So it is applied here instead of asked for — the parameterised
// request was the one that intermittently came back empty.
//   bonus_rec_te 0.5 → te+, 1.0 and up → te++, anything between scaled linearly.
//   A league starting 2+ TEs takes a further ×1.2 on top.
const FC_TEP_PLUS = 1.149, FC_TEP_PLUS_PLUS = 1.29, FC_TWO_TE_MULT = 1.2;

function fcTeMult(bonusRecTe, teSlots) {
  const b = Math.max(0, Number(bonusRecTe) || 0);
  const tep = b <= 0.5 ? 1 + (FC_TEP_PLUS - 1) * (b / 0.5)
            : b <  1   ? FC_TEP_PLUS + (FC_TEP_PLUS_PLUS - FC_TEP_PLUS) * ((b - 0.5) / 0.5)
            :            FC_TEP_PLUS_PLUS;
  return tep * ((teSlots || 0) >= 2 ? FC_TWO_TE_MULT : 1);
}

// A copy of an FC value map with every tight end scaled for this league. Done
// once, to the map, so every reader on the page (roster values, My Ranks
// badges, the ranks grid) sees the same number.
function fcApplyTeMult(fcMap, players, mult) {
  if (!(mult > 0) || mult === 1) return fcMap;
  const out = {};
  for (const [pid, v] of Object.entries(fcMap || {})) {
    out[pid] = players?.[pid]?.position === 'TE' && typeof v === 'number' ? Math.round(v * mult) : v;
  }
  return out;
}

const teSlotCount = rp => (rp || []).filter(p => p === 'TE').length;

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
    // Overall = players + picks. t.overall stays players-only: the sims' empty-
    // projection fallback scales it into weekly points, and picks don't score.
    overall: rankBy(t => t.overall + (t.draft || 0)),
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

// ── Playoff power ───────────────────────────────────────────────────────────
// A 0-100 power score for the playoff weeks only, from each team's projected
// optimal lineup (mu) and its spread (sigma) per playoff week.
//
// 1. Each week's reference is THAT week's best projected team, so a team is
//    never measured against someone it outprojects — two teams that trade the
//    top spot can both read 100.
// 2. Per week: p = 2 × P(outscores that week's best) — 1 for the best team.
// 3. Weeks combine as the geometric mean of p (a bye-week hole still costs,
//    spread across the weeks counted), turned back into an effective gap in
//    swings: z = −Φ⁻¹(mean / 2).
// 4. The smallest z in the league is subtracted (the strongest team is 0), then
//    score = 100 × exp(−(z / PP_BELL)²): flat near the top so close teams stay
//    close, steep in the middle so a team ~30 pts/wk back lands near 12.
//
// Why sigma isn't inflated: measured over 60 real Sleeper leagues / 8,167
// team-weeks (2026 wks 1-11), as-set lineups missed projection by SD 32.6 pts;
// the POS_CV model gives 33.6 for the same lineups. ±50 is the ~90th-percentile
// miss (11% of team-weeks), not one standard deviation.

const PP_ALIVE_MIN = 0.05;   // playoff odds below this → no Playoff Power rank
const PP_BELL = 0.44;        // gap (in matchup swings) where the score falls to 1/e ≈ 37

// Standard normal CDF (Abramowitz–Stegun 7.1.26 erf, |error| < 1.5e-7).
function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2, t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

// Inverse of normCdf by bisection — called once per team, so speed is moot.
function normInv(p) {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -9, hi = 9;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (normCdf(m) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

// NFL weeks a league's bracket is played in. Sleeper playoff_round_type:
// 0 = one week a round, 1 = two-week championship, 2 = two weeks a round.
function playoffWeeksFor({ start, playoffTeams, roundType = 0, lastWeek = 18 }) {
  if (!start || !playoffTeams) return [];
  const rounds = Math.max(1, Math.ceil(Math.log2(Math.max(2, playoffTeams))));
  const n = roundType === 2 ? rounds * 2 : roundType === 1 ? rounds + 1 : rounds;
  const weeks = [];
  for (let w = start; w < start + n && w <= lastWeek; w++) weeks.push(w);
  return weeks;
}

// rows: [{ rid, weeks: [{mu, sigma}, …] }] — every row the same weeks, in order.
// → { rid: { score (0-100 int), ppw (projected points per playoff week), gap (z) } }
function playoffPowerScores(rows) {
  const out = {};
  const live = rows.filter(r => r.weeks?.length);
  if (!live.length) return out;
  const n = live[0].weeks.length;
  const best = Array.from({ length: n }, (_, i) =>
    live.reduce((a, r) => (r.weeks[i].mu > a.mu ? r.weeks[i] : a), live[0].weeks[i]));
  const z = {};
  for (const r of live) {
    let logP = 0;
    r.weeks.forEach((w, i) => {
      const b = best[i];
      const sd = Math.sqrt(w.sigma ** 2 + b.sigma ** 2) || 1;
      logP += Math.log(Math.max(1e-12, 2 * normCdf(-(b.mu - w.mu) / sd)));
    });
    const gm = Math.exp(logP / n);
    z[r.rid] = gm >= 1 ? 0 : -normInv(gm / 2);
  }
  const zMin = Math.min(...Object.values(z));
  for (const r of live) {
    const g = Math.max(0, z[r.rid] - zMin);
    out[r.rid] = {
      score: Math.round(100 * Math.exp(-((g / PP_BELL) ** 2))),
      ppw: r.weeks.reduce((s, w) => s + w.mu, 0) / n,
      gap: g,
    };
  }
  return out;
}
