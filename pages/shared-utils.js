function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Manual aliases for players whose commonly-used name differs from Sleeper's
// own full_name (nicknames, not punctuation — normName()/normalizePlayerName()
// already strip punctuation before this runs). Keys/values are pre-normalized:
// lowercase, no punctuation. Add entries here as new mismatches surface.
const NAME_ALIASES = {
  'kenneth gainwell': 'kenny gainwell',
  'nicholas singleton': 'nick singleton',
};
function applyNameAlias(key) {
  return NAME_ALIASES[key] || key;
}

// Drop a trailing generational suffix ("Jr", "Sr", "II"..."V") so sources that
// include it ("Michael Pittman Jr") match sources that don't ("Michael Pittman").
// Must run after punctuation is already stripped (so "Jr." has become "jr").
// Shared by normName() below and auction.html's normalizePlayerName().
function stripNameSuffix(key) {
  return key.replace(/\s+(jr|sr|ii|iii|iv|v)$/i, '');
}

// Normalize a player name for matching across sources. Collapses punctuation/spacing
// differences so "Amon-Ra St Brown"/"Amon-Ra St. Brown", "CJ"/"C.J.", "AJ"/"A.J.",
// "Tre Harris"/"Tre' Harris" match, drops a trailing "Jr"/"Sr"/"II"-"V" suffix
// (see stripNameSuffix above), then resolves known nickname aliases (see
// NAME_ALIASES above). Both the name→id index and every lookup against it MUST
// go through this.
function normName(s) {
  const key = (s || '')
    .toLowerCase()
    .replace(/[.,'’‘]/g, '')  // drop periods/commas/apostrophes: "st." → "st", "c.j." → "cj", "tre'" → "tre"
    .replace(/\s+/g, ' ')     // collapse whitespace
    .trim();
  return applyNameAlias(stripNameSuffix(key));
}
function errHtml(e) { return `<div class="err-state">Error: ${esc(e.message)}</div>`; }
function loading(msg = 'Loading…') { return `<div class="loading-state"><div class="spinner"></div>${esc(msg)}</div>`; }

// ════════════════════════════════════════════════════════════════════════════
// Contender scoring — single source of truth shared by League Summaries
// (index.html) and the League Analyzer (analyzer.html).
//
// Two modes:
//   'adp'         → aggregate consensus ADP (JuiceBoxOne sheet: FantasyPros/
//                   ESPN/Sleeper/Yahoo blend, 1000 / √rank decay), falling back
//                   to Sleeper's own search_rank for anyone the sheet doesn't
//                   cover (it's offense-only, ~200 players — no IDP, no deep bench).
//   'projections' → equal-weight average of Clay (ESPN), Sleeper season
//                   projections, and the user's own projections, each scored
//                   with the league's own scoring_settings.
//
// A roster's contender score = sum of its best starters under a position-aware
// selection: 2 QB if SF (else 1), (RB/WR/TE slots + 1) each, then the best
// remaining flex-eligible players up to (starter_count + 3).
//
// Results are cached per league + mode in localStorage so the analyzer can
// reference a value Summaries already computed instead of recomputing it.
// ════════════════════════════════════════════════════════════════════════════

const CR_CACHE_PREFIX = 'cr_scores_';
const CR_CACHE_TTL_MS = 2 * 3600 * 1000; // 2h — rosters change with trades

function crNormPos(raw) {
  if (!raw) return null;
  const p = String(raw).toUpperCase();
  if (['QB','RB','WR','TE'].includes(p))           return p;
  if (['DE','DT','NT','IDL','DL'].includes(p))     return 'DL';
  if (['LB','ILB','OLB','MLB'].includes(p))        return 'LB';
  if (['CB','S','SS','FS','SAF','DB'].includes(p)) return 'DB';
  return null;
}

// Per-game points from Clay's season-total stat line, scored to this league.
function crScoreClay(clay, scoring) {
  if (!clay || !clay.gm) return null;
  const pts =
    (clay.pass_yds || 0) * (scoring.pass_yd  ?? 0.04) +
    (clay.pass_td  || 0) * (scoring.pass_td  ?? 4)    +
    (clay.int      || 0) * (scoring.pass_int ?? -2)   +
    (clay.rush_yds || 0) * (scoring.rush_yd  ?? 0.1)  +
    (clay.rush_td  || 0) * (scoring.rush_td  ?? 6)    +
    (clay.rec      || 0) * (scoring.rec      ?? 1)    +
    (clay.rec_yds  || 0) * (scoring.rec_yd   ?? 0.1)  +
    (clay.rec_td   || 0) * (scoring.rec_td   ?? 6);
  return pts / clay.gm;
}

// Per-game points from Sleeper's projected stat line, scored to this league.
// Weekly projections have no gp → treat the line as already per-game.
function crScoreSleeper(proj, scoring) {
  if (!proj) return null;
  const pts =
    (proj.pass_yd  || 0) * (scoring.pass_yd  ?? 0.04) +
    (proj.pass_td  || 0) * (scoring.pass_td  ?? 4)    +
    (proj.pass_int || 0) * (scoring.pass_int ?? -2)   +
    (proj.rush_yd  || 0) * (scoring.rush_yd  ?? 0.1)  +
    (proj.rush_td  || 0) * (scoring.rush_td  ?? 6)    +
    (proj.rec      || 0) * (scoring.rec      ?? 1)    +
    (proj.rec_yd   || 0) * (scoring.rec_yd   ?? 0.1)  +
    (proj.rec_td   || 0) * (scoring.rec_td   ?? 6)    +
    (proj.bonus_rec_te || 0) * (scoring.bonus_rec_te ?? 0);
  const gp = proj.gp || 1;
  return pts / gp;
}

// A single player's value for the active mode.
// ctx = { mode, players, clayMap, sleeperProjMap, userProjMap, scoring, aggAdpMap }
function crPlayerPpg(pid, ctx) {
  if (ctx.mode === 'adp') {
    // Prefer the aggregate consensus sheet; fall back to Sleeper's own
    // search_rank for anyone it doesn't cover (IDP, deep bench).
    const rank = ctx.aggAdpMap?.[pid] ?? ctx.players?.[pid]?.search_rank;
    return rank ? 1000 / Math.sqrt(rank) : 0;
  }
  const vals = [];
  const clay = ctx.clayMap?.[pid];
  if (clay) { const v = crScoreClay(clay.stats, ctx.scoring); if (v !== null) vals.push(v); }
  const slp = ctx.sleeperProjMap?.[pid];
  if (slp) { const v = crScoreSleeper(slp, ctx.scoring); if (v !== null) vals.push(v); }
  const usr = ctx.userProjMap?.[pid];
  if (usr?.ppg != null) vals.push(usr.ppg); // pre-computed PPR; approximate
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}

// Contender score for one roster's player ids.
// ctx additionally carries { rosterPositions }.
function crScoreRoster(playerIds, ctx) {
  const starterSlots = (ctx.rosterPositions || []).filter(p => !['BN','IR','TAXI'].includes(p));
  const starterCount = starterSlots.length;

  const isSF = starterSlots.includes('SUPER_FLEX');
  const qbTarget = isSF ? 2 : 1;
  const rbTarget = starterSlots.filter(s => s === 'RB').length + 1;
  const wrTarget = starterSlots.filter(s => s === 'WR').length + 1;
  const teTarget = starterSlots.filter(s => s === 'TE').length + 1;
  const fixedCount = qbTarget + rbTarget + wrTarget + teTarget;
  const flexTarget = Math.max(0, (starterCount + 3) - fixedCount);

  const scored = (playerIds || []).map(pid => {
    const pos = crNormPos(ctx.players?.[pid]?.position);
    if (!['QB','RB','WR','TE'].includes(pos)) return null;
    return { pid, pos, ppg: crPlayerPpg(pid, ctx) };
  }).filter(Boolean);

  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  for (const p of scored) byPos[p.pos].push(p);
  for (const pos of ['QB','RB','WR','TE']) byPos[pos].sort((a, b) => b.ppg - a.ppg);

  const used = new Set();
  let total = 0;
  const take = (pos, n) => {
    let taken = 0;
    for (const p of byPos[pos]) {
      if (taken >= n) break;
      if (used.has(p.pid)) continue;
      used.add(p.pid); total += p.ppg; taken++;
    }
  };
  take('QB', qbTarget);
  take('RB', rbTarget);
  take('WR', wrTarget);
  take('TE', teTarget);

  if (flexTarget > 0) {
    const remaining = scored
      .filter(p => !used.has(p.pid) && ['RB','WR','TE'].includes(p.pos))
      .sort((a, b) => b.ppg - a.ppg);
    for (let i = 0; i < Math.min(flexTarget, remaining.length); i++) {
      total += remaining[i].ppg;
    }
  }
  return total;
}

// Fetch + index the three projection sources, keyed by Sleeper player id.
// opts = { apiBase, season, authed, byName }  (byName: lowercased name → sleeperId)
// Returns { clayMap, sleeperProjMap, userProjMap }.
async function crLoadProjectionData(opts) {
  const { apiBase, season, authed, byName } = opts;
  const clayMap = {}, sleeperProjMap = {}, userProjMap = {};

  const fetches = [
    fetch(`${apiBase}/projections/external?source=clay&season=${season}`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${apiBase}/sleeper/projections/nfl/regular/${season}/1`).then(r => r.ok ? r.json() : null).catch(() => null),
  ];
  if (authed) fetches.push(
    fetch(`${apiBase}/projections/ppg?season=${season}`, { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null)
  );
  const [clayRes, sleeperRes, userRes] = await Promise.all(fetches);

  if (clayRes?.players) {
    for (const p of clayRes.players) {
      const pid = byName[normName(p.player_name)];
      if (pid) clayMap[pid] = { stats: p };
    }
  }
  if (sleeperRes && typeof sleeperRes === 'object') {
    for (const [pid, proj] of Object.entries(sleeperRes)) {
      if (proj && typeof proj === 'object') sleeperProjMap[pid] = proj;
    }
  }
  if (userRes && typeof userRes === 'object') {
    for (const [name, ppg] of Object.entries(userRes)) {
      const pid = byName[normName(name)];
      if (pid) userProjMap[pid] = { ppg };
    }
  }
  return { clayMap, sleeperProjMap, userProjMap };
}

// ── ESPN scoring settings → Sleeper-shaped scoring_settings ───────────────────
// ESPN's league scoring (settings.scoringSettings.scoringItems) is keyed by a
// numeric statId, not field names. This maps the ones that matter for
// QB/RB/WR/TE valuation onto the SAME field names Sleeper's own scoring_settings
// (and its player stat-projection lines) use, so crScoreSleeper()/
// lsComputeProjPts() work on ESPN leagues completely unchanged — no separate
// ESPN scoring formula needed. Kicker/D-ST/return-TD categories are
// intentionally not mapped: crScoreRoster only ever scores QB/RB/WR/TE, and an
// unmapped statId is a silent no-op (crScoreSleeper only applies a
// scoring_settings key that also exists on the stat line), never a wrong number.
//
// statId source: SETTINGS_SCORING_FORMAT_MAP in the public espn-api project
// (github.com/cwendt94/espn-api/blob/master/espn_api/football/constant.py) —
// cross-checked against a real league's live scoringItems response (a
// 0.5-PPR, 1QB, no-TEP league) before trusting it: statId 53→0.5 matched the
// league's known half-PPR setting, statId 6→0.5 ("every 10 passing yards")
// and lineupSlotCounts confirmed 1QB (no slot 0 or 7... — see numQbs below).
const ESPN_STAT_TO_FIELD = {
  4: 'pass_td', 20: 'pass_int', 19: 'pass_2pt',
  25: 'rush_td', 26: 'rush_2pt',
  43: 'rec_td', 44: 'rec_2pt',
  72: 'fum_lost',
};
// Yardage categories: ESPN lets a league pick EITHER a flat per-yard rate (the
// "direct" statId) OR a bucketed "every N yards" rate (a different statId per
// N) — never both for the same category. Both normalize to a continuous
// per-yard rate (points ÷ N for the bucketed form) to match Sleeper's shape.
const ESPN_YARDAGE_STATS = {
  pass_yd: { direct: 3,  everyN: { 5: 5, 6: 10, 7: 20, 8: 25, 9: 50, 10: 100 } },
  rush_yd: { direct: 24, everyN: { 27: 5, 28: 10, 29: 20, 30: 25, 31: 50, 32: 100 } },
  rec_yd:  { direct: 42, everyN: { 47: 5, 48: 10, 49: 20, 50: 25, 51: 50, 52: 100 } },
};
// "Each reception" (53) is what ESPN's UI actually writes for the PPR dial in
// practice (confirmed live); 41 ("Receptions") is the same category under a
// slightly different label in the reference table and is mapped defensively
// in case a league is ever configured through it instead.
const ESPN_REC_STAT_IDS = [53, 41];
const ESPN_TE_POSITION_ID = 6; // POSITION_MAP: TE — pointsOverrides key for a TE-specific reception bonus (TEP)

// opts = { settings } — the `settings` object from an ESPN mSettings response.
// Returns { scoring, numQbs, ppr, bonusRecTe }.
function crParseEspnScoring(settings) {
  const items = settings?.scoringSettings?.scoringItems || [];
  const scoring = {};
  let bonusRecTe = 0;

  for (const item of items) {
    if (ESPN_REC_STAT_IDS.includes(item.statId)) {
      scoring.rec = item.points ?? 0;
      const teOverride = item.pointsOverrides?.[String(ESPN_TE_POSITION_ID)];
      if (teOverride != null) bonusRecTe = teOverride - (item.points ?? 0);
      continue;
    }
    const field = ESPN_STAT_TO_FIELD[item.statId];
    if (field) { scoring[field] = item.points ?? 0; continue; }
    for (const [ydField, cfg] of Object.entries(ESPN_YARDAGE_STATS)) {
      if (item.statId === cfg.direct) { scoring[ydField] = item.points ?? 0; break; }
      const n = cfg.everyN[item.statId];
      if (n) { scoring[ydField] = (item.points ?? 0) / n; break; }
    }
  }

  // POSITION_MAP: QB=0 (lineup slot), OP=7 (the true superflex/"any offensive
  // player" slot — NOT the generic RB/WR/TE flex slots, which are 3/5/23).
  const lineupSlots = settings?.rosterSettings?.lineupSlotCounts || {};
  const numQbs = ((lineupSlots['0'] ?? 0) >= 2 || (lineupSlots['7'] ?? 0) > 0) ? 2 : 1;

  return { scoring, numQbs, ppr: scoring.rec ?? 1, bonusRecTe };
}

// Fetch + index the aggregate consensus ADP sheet, keyed by Sleeper player id.
// opts = { apiBase, byName }. Returns { [pid]: rank }. Offense-only (~200
// players) — anyone not found here is left for crPlayerPpg's search_rank fallback.
async function crLoadAggregateAdp(opts) {
  const { apiBase, byName } = opts;
  const aggAdpMap = {};
  try {
    const res  = await fetch(`${apiBase}/aggregate-adp`);
    const rows = res.ok ? await res.json() : null;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const pid = byName[normName(row.name)];
        if (pid) aggAdpMap[pid] = row.rank;
      }
    }
  } catch (_) {}
  return aggAdpMap;
}

// localStorage handoff so the analyzer can reuse what Summaries computed.
function crCacheScores(lgId, mode, scores) {
  try {
    localStorage.setItem(CR_CACHE_PREFIX + lgId + '_' + mode,
      JSON.stringify({ ts: Date.now(), scores }));
  } catch {}
}
function crReadCachedScores(lgId, mode) {
  try {
    const c = JSON.parse(localStorage.getItem(CR_CACHE_PREFIX + lgId + '_' + mode) || 'null');
    if (c && Date.now() - c.ts < CR_CACHE_TTL_MS) return c.scores;
  } catch {}
  return null;
}
