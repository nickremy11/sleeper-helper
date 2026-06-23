function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Normalize a player name for matching across sources. Collapses punctuation/spacing
// differences so "Amon-Ra St Brown"/"Amon-Ra St. Brown", "CJ"/"C.J.", "AJ"/"A.J." match.
// Both the name→id index and every lookup against it MUST go through this.
function normName(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[.,]/g, '')   // drop periods/commas: "st." → "st", "c.j." → "cj"
    .replace(/\s+/g, ' ')   // collapse whitespace
    .trim();
}
function errHtml(e) { return `<div class="err-state">Error: ${esc(e.message)}</div>`; }
function loading(msg = 'Loading…') { return `<div class="loading-state"><div class="spinner"></div>${esc(msg)}</div>`; }

// ════════════════════════════════════════════════════════════════════════════
// Contender scoring — single source of truth shared by League Summaries
// (index.html) and the League Analyzer (analyzer.html).
//
// Two modes:
//   'adp'         → players ranked by Sleeper search_rank (1000 / √rank decay)
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
// ctx = { mode, players, clayMap, sleeperProjMap, userProjMap, scoring }
function crPlayerPpg(pid, ctx) {
  if (ctx.mode === 'adp') {
    const rank = ctx.players?.[pid]?.search_rank;
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
