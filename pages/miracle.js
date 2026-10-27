// ── Monday Night Miracle engine (rootforme.html) ─────────────────────────────
// Pure functions, no DOM: given every live matchup, the week's game states, the
// players still to play and their projections, simulate the rest of the week's
// unfinished games jointly and score every simulated game in every league with
// that league's own scoring. Results are weighted by the Root For Me $ values.
//
// Why a joint sim and not per-player distributions: tonight's players are
// correlated (Dak's yards ARE Lamb's yards; the PHI D/ST's INTs are Dak's INTs,
// its points allowed is DAL's score), and the same player can sit on my side in
// one league and the opponent's in another. Only a whole-game sample keeps the
// stat lines consistent with each other, which is what makes the "script" for a
// given outcome a believable box score rather than a wish list.
(function (root) {
'use strict';

const MNM_SIMS = 6000;
const MNM_SEED = 0x4d4e4d; // fixed: re-rendering never reshuffles the answer

// Sleeper's default K / DEF scoring. ESPN leagues need it because
// crParseEspnScoring maps offence only — without this a kicker would score 0
// in every simulated game, which reads as "doesn't matter" rather than "unknown".
const MNM_KDEF_DEFAULT = {
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5, xpm: 1, fgmiss: -1, xpmiss: -1,
  sack: 1, int: 2, fum_rec: 2, def_td: 6, safe: 2, blk_kick: 2, ff: 1, def_st_td: 6,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};
// Plausibility yardstick only (ranking how ordinary a sampled line is) — never
// used to decide a matchup.
const MNM_REF_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, rush_yd: 0.1, rush_td: 6,
  rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, ...MNM_KDEF_DEFAULT,
};

// Keys the sim models itself; everything else in a projection line is scaled.
const MNM_CORE = new Set([
  'pass_yd','pass_td','pass_int','pass_att','pass_cmp','pass_inc',
  'rush_yd','rush_td','rush_att','rec','rec_yd','rec_td','fum_lost',
  'fgm','fga','fgmiss','xpm','xpa','xpmiss','fgm_yds',
  'fgm_0_19','fgm_20_29','fgm_30_39','fgm_40_49','fgm_50p','fgm_50_59','fgm_60p',
  'fgmiss_0_19','fgmiss_20_29','fgmiss_30_39','fgmiss_40_49','fgmiss_50p','fgmiss_50_59','fgmiss_60p',
  'sack','int','fum_rec','ff','def_td','safe','pts_allow','yds_allow',
]);
// Never carried into a line: ranks, ADP, pre-scored totals, rates, and every
// key mnmDerive() recomputes from the counting stats.
const MNM_SKIP_RE = /^(gp|gs|gms_active|cmp_pct|pos_|rank|adp|pts_|fan_|bonus_|yds_allow_|tm_)|_lng$|_ypr$|_ypa$|_ypc$|_ypt$|_pct$|_snp$/;
const MNM_PTS_ALLOW_RE = /^pts_allow_/;

const FG_BUCKETS = [['fgm_0_19', 18], ['fgm_20_29', 25], ['fgm_30_39', 35], ['fgm_40_49', 45], ['fgm_50p', 53]];
const FG_MISS_BUCKETS = ['fgmiss_0_19', 'fgmiss_20_29', 'fgmiss_30_39', 'fgmiss_40_49', 'fgmiss_50p'];

// ── RNG ───────────────────────────────────────────────────────────────────────
function mnmRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rNormal(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function rPoisson(r, lam) {
  if (!(lam > 0)) return 0;
  const L = Math.exp(-lam); let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}
function rGamma(r, k) {
  if (!(k > 0)) return 0;
  if (k < 1) return rGamma(r, k + 1) * Math.pow(r() || 1e-12, 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = rNormal(r); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = r();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function rPick(r, weights) {
  let tot = 0; for (const w of weights) tot += w;
  if (!(tot > 0)) return -1;
  let x = r() * tot;
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
  return weights.length - 1;
}
function rBinom(r, n, p) { let k = 0; for (let i = 0; i < n; i++) if (r() < p) k++; return k; }

// Acklam's inverse normal CDF — turns a sample's percentile into a z-score.
function invNorm(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
  const pl = 0.02425;
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1); }
  const q = p - 0.5, rr = q * q;
  return (((((a[0]*rr+a[1])*rr+a[2])*rr+a[3])*rr+a[4])*rr+a[5])*q / (((((b[0]*rr+b[1])*rr+b[2])*rr+b[3])*rr+b[4])*rr+1);
}

// ── Game state ────────────────────────────────────────────────────────────────
// Fraction of the game still to be played. `state` comes from the worker's
// /api/espn/games (pre | in | post); a cached response from before that field
// existed has none, so fall back to the kickoff clock.
function mnmRemainingFrac(g, now) {
  if (g.state === 'post') return 0;
  if (g.state === 'pre') return 1;
  if (g.state === 'in') {
    const per = +g.period || 1;
    if (per > 4) return 0.05;                       // overtime: a possession or two
    const [m, s] = String(g.clock || '15:00').split(':').map(Number);
    const left = (4 - per) * 15 + (m || 0) + (s || 0) / 60;
    return Math.max(0.02, Math.min(1, left / 60));
  }
  const k = new Date(g.kickoff).getTime();
  if (!k) return 1;
  const el = ((now || Date.now()) - k) / 60000;
  if (el < 0) return 1;
  if (el > 210) return 0;
  return Math.max(0.02, 1 - el / 190);
}

function mnmGameLabel(g) {
  if (g.state === 'in') {
    const q = +g.period > 4 ? 'OT' : `Q${g.period}`;
    return `${q} ${g.clock || ''} · ${g.away} ${g.awayScore ?? ''} – ${g.home} ${g.homeScore ?? ''}`.trim();
  }
  if (g.state === 'post') return 'Final';
  const k = new Date(g.kickoff);
  return isNaN(k) ? 'Not started' : k.toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

// ── Scoring ───────────────────────────────────────────────────────────────────
// Rebuilds every threshold/bucket/position key from the counting stats, so a
// line that crosses 100 yards mid-sim picks up the bonus the league pays.
// Sleeper's actual lines don't reliably carry these keys, and a summed
// (current + rest-of-game) line would carry stale ones.
function mnmDerive(line, pos) {
  const L = {};
  for (const k in line) {
    if (k.startsWith('bonus_') || k.startsWith('yds_allow_') || MNM_PTS_ALLOW_RE.test(k)) continue;
    L[k] = line[k];
  }
  const rec = L.rec || 0, recYd = L.rec_yd || 0, rushYd = L.rush_yd || 0, passYd = L.pass_yd || 0;
  if (pos === 'TE') L.bonus_rec_te = rec;
  else if (pos === 'RB') L.bonus_rec_rb = rec;
  else if (pos === 'WR') L.bonus_rec_wr = rec;
  if (recYd >= 100) L.bonus_rec_yd_100 = 1;
  if (recYd >= 200) L.bonus_rec_yd_200 = 1;
  if (rushYd >= 100) L.bonus_rush_yd_100 = 1;
  if (rushYd >= 200) L.bonus_rush_yd_200 = 1;
  if (rushYd + recYd >= 100) L.bonus_rush_rec_yd_100 = 1;
  if (rushYd + recYd >= 200) L.bonus_rush_rec_yd_200 = 1;
  if (passYd >= 300) L.bonus_pass_yd_300 = 1;
  if (passYd >= 400) L.bonus_pass_yd_400 = 1;
  if ((L.pass_cmp || 0) >= 25) L.bonus_pass_cmp_25 = 1;
  if ((L.rush_att || 0) >= 20) L.bonus_rush_att_20 = 1;
  const fd = (L.rush_fd || 0) + (L.rec_fd || 0);
  if (fd && pos) L['bonus_fd_' + pos.toLowerCase()] = fd;
  // Buckets only once the key exists: a D/ST that hasn't played has no
  // pts_allow, and reading that as 0 would bank a shutout's 10 points into its
  // baseline before kickoff.
  if (pos === 'DEF' && L.pts_allow != null) {
    const pa = L.pts_allow;
    L[pa <= 0 ? 'pts_allow_0' : pa <= 6 ? 'pts_allow_1_6' : pa <= 13 ? 'pts_allow_7_13' : pa <= 20 ? 'pts_allow_14_20'
      : pa <= 27 ? 'pts_allow_21_27' : pa <= 34 ? 'pts_allow_28_34' : 'pts_allow_35p'] = 1;
  }
  if (pos === 'DEF' && L.yds_allow != null) {
    const ya = L.yds_allow;
    L[ya < 100 ? 'yds_allow_0_100' : ya < 200 ? 'yds_allow_100_199' : ya < 300 ? 'yds_allow_200_299'
      : ya < 350 ? 'yds_allow_300_349' : ya < 400 ? 'yds_allow_350_399' : ya < 450 ? 'yds_allow_400_449'
      : ya < 500 ? 'yds_allow_450_499' : ya < 550 ? 'yds_allow_500_549' : 'yds_allow_550p'] = 1;
  }
  return L;
}

// Same rule as index.html's lsComputeProjPts: multiply only the keys the league
// scores, so the many non-scoring fields on a line are inert.
function mnmScore(line, sc) {
  let pts = 0;
  for (const k in line) { const w = sc[k]; if (w) pts += line[k] * w; }
  return pts;
}

function mnmAdd(a, b) {
  const out = { ...a };
  for (const k in b) if (typeof b[k] === 'number') out[k] = (out[k] || 0) + b[k];
  return out;
}

// ── Team model ────────────────────────────────────────────────────────────────
function mnmTeamModel(team, pids, proj, players) {
  let qb = null, k = null;
  const rec = [], rush = [];
  for (const pid of pids) {
    const p = proj[pid]; if (!p) continue;
    const pos = players[pid]?.position;
    if (pos === 'DEF') continue;
    if (pos === 'K') { if (!k || (p.fga || 0) > (proj[k].fga || 0)) k = pid; continue; }
    if ((p.pass_att || 0) > 5 && (!qb || p.pass_att > proj[qb].pass_att)) qb = pid;
    if ((p.rec_yd || 0) > 0.5) rec.push(pid);
    if ((p.rush_yd || 0) > 0.5) rush.push(pid);
  }
  const q = qb ? proj[qb] : {};
  const passYd = q.pass_yd || 215;
  const sumRecYd = rec.reduce((s, pid) => s + proj[pid].rec_yd, 0);
  // Projections for a team's receivers don't sum to exactly the QB's yards;
  // shares are of the QB's total, normalised down when they over-claim.
  const norm = Math.max(1, sumRecYd / (passYd * 0.95));
  const recShare = rec.map(pid => proj[pid].rec_yd / passYd / norm);
  const recOther = Math.max(0.05, 1 - recShare.reduce((s, x) => s + x, 0));
  const rushYd = rush.reduce((s, pid) => s + proj[pid].rush_yd, 0) || 95;
  const rushShare = rush.map(pid => proj[pid].rush_yd / rushYd * 0.95);
  const recTdSum = rec.reduce((s, pid) => s + (proj[pid].rec_td || 0), 0);
  return {
    team, qb, k, rec, rush, recShare, recOther, rushShare,
    passYd, passTd: q.pass_td ?? 1.4, passInt: q.pass_int ?? 0.8,
    rushYd, rushTd: rush.reduce((s, pid) => s + (proj[pid].rush_td || 0), 0) || 0.7,
    otherPassTd: Math.max(0.08, (q.pass_td ?? 1.4) - recTdSum),
  };
}

// Projection keys the sim doesn't model, scaled by how the player's volume came
// out (receiving first downs follow receptions, etc.). Fractional on purpose:
// they're expected values riding on a sampled line, only ever fed to a scorer.
function mnmScaleOthers(line, p, f, ratios) {
  for (const k in p) {
    if (MNM_CORE.has(k) || MNM_SKIP_RE.test(k) || typeof p[k] !== 'number') continue;
    const ratio = k.startsWith('rec_') ? ratios.rec : k.startsWith('rush_') ? ratios.rush
      : k.startsWith('pass_') ? ratios.pass : 1;
    const v = p[k] * f * ratio;
    if (v) line[k] = (line[k] || 0) + v;
  }
  return line;
}

// One team's offence + kicker for the rest of the game.
function mnmSimTeam(r, m, f, proj) {
  const lines = {};
  const get = pid => (lines[pid] ||= {});
  const zT = rNormal(r);
  const mP = Math.exp(0.30 * (0.6 * zT + 0.8 * rNormal(r)) - 0.045);
  const mR = Math.exp(0.35 * (0.5 * zT + 0.866 * rNormal(r)) - 0.061);
  const PY = m.passYd * f * mP, RY = m.rushYd * f * mR;
  const passTd = rPoisson(r, m.passTd * f * mP);
  const rushTd = rPoisson(r, m.rushTd * f * mR);
  const ints = rPoisson(r, m.passInt * f);

  // Receiving: Dirichlet split of the QB's yards (concentration 7), the rest
  // to receivers nobody rosters. A TD goes where the yards went.
  const wRec = m.recShare.map(s => rGamma(r, 7 * s));
  const wOther = rGamma(r, 7 * m.recOther);
  const wSum = wRec.reduce((s, x) => s + x, wOther) || 1;
  m.rec.forEach((pid, i) => {
    const p = proj[pid], L = get(pid);
    const yd = Math.round(PY * wRec[i] / wSum);
    const ypr = p.rec > 0 ? p.rec_yd / p.rec : 10;
    L.rec_yd = yd;
    L.rec = yd < 1 ? 0 : Math.max(1, Math.round(yd / ypr * Math.exp(0.2 * rNormal(r) - 0.02)));
    L.rec_td = 0;
  });
  const tdW = m.rec.map((pid, i) => (proj[pid].rec_td || 0.01) * (wRec[i] / wSum) / Math.max(0.01, m.recShare[i]));
  tdW.push(m.otherPassTd * (wOther / wSum) / m.recOther);
  for (let t = 0; t < passTd; t++) { const i = rPick(r, tdW); if (i >= 0 && i < m.rec.length) lines[m.rec[i]].rec_td++; }

  // Rushing: same split over the team's projected rushers (QB included).
  const wRush = m.rushShare.map(s => rGamma(r, 5 * s));
  const wRushOther = rGamma(r, 0.25);
  const wrSum = wRush.reduce((s, x) => s + x, wRushOther) || 1;
  m.rush.forEach((pid, i) => {
    const p = proj[pid], L = get(pid);
    const yd = Math.round(RY * wRush[i] / wrSum);
    const ypc = p.rush_att > 0 ? p.rush_yd / p.rush_att : 4.2;
    L.rush_yd = yd;
    L.rush_att = Math.max(yd > 0 ? 1 : 0, Math.round(yd / ypc * Math.exp(0.15 * rNormal(r) - 0.011)));
    L.rush_td = 0;
  });
  const rtdW = m.rush.map((pid, i) => (proj[pid].rush_td || 0.01) * (wRush[i] / wrSum) / Math.max(0.01, m.rushShare[i]));
  rtdW.push(0.05);
  for (let t = 0; t < rushTd; t++) { const i = rPick(r, rtdW); if (i >= 0 && i < m.rush.length) lines[m.rush[i]].rush_td++; }

  if (m.qb) {
    const q = proj[m.qb], L = get(m.qb);
    const vol = q.pass_att > 0 ? Math.pow(mP, 0.6) : 1;
    L.pass_yd = Math.round(PY); L.pass_td = passTd; L.pass_int = ints;
    L.pass_att = Math.round((q.pass_att || 0) * f * vol);
    L.pass_cmp = Math.min(L.pass_att, Math.round(L.pass_att * ((q.pass_cmp || 0) / (q.pass_att || 1)) * Math.exp(0.08 * rNormal(r))));
    L.pass_inc = L.pass_att - L.pass_cmp;
  }

  // Volume ratios + fumbles + every unmodelled projection key.
  for (const pid of new Set([...m.rec, ...m.rush, ...(m.qb ? [m.qb] : [])])) {
    const p = proj[pid], L = get(pid);
    L.fum_lost = rPoisson(r, (p.fum_lost || 0) * f);
    mnmScaleOthers(L, p, f, {
      rec:  p.rec > 0 && f > 0 ? (L.rec || 0) / (p.rec * f) : 1,
      rush: p.rush_att > 0 && f > 0 ? (L.rush_att || 0) / (p.rush_att * f) : 1,
      pass: p.pass_att > 0 && f > 0 ? (L.pass_att || 0) / (p.pass_att * f) : 1,
    });
  }

  // Kicker: field goals follow how the offence moved; PATs follow its TDs.
  const tds = passTd + rushTd;
  const drive = Math.sqrt((PY + RY) / Math.max(1, (m.passYd + m.rushYd) * f));
  let fgm, xpm;
  if (m.k) {
    const p = proj[m.k], L = get(m.k);
    fgm = rPoisson(r, (p.fgm || 1.6) * f * drive);
    const bw = FG_BUCKETS.map(([k]) => p[k] || 0);
    if (!bw.some(Boolean)) bw.splice(0, bw.length, 0.05, 0.25, 0.3, 0.25, 0.15);
    L.fgm = fgm; L.fgm_yds = 0;
    for (let i = 0; i < fgm; i++) { const b = rPick(r, bw); L[FG_BUCKETS[b][0]] = (L[FG_BUCKETS[b][0]] || 0) + 1; L.fgm_yds += FG_BUCKETS[b][1]; }
    const miss = rPoisson(r, Math.max(0, (p.fga || 0) - (p.fgm || 0)) * f);
    L.fgmiss = miss; L.fga = fgm + miss;
    const mw = FG_MISS_BUCKETS.map(k => p[k] || 0);
    for (let i = 0; i < miss; i++) { const b = rPick(r, mw.some(Boolean) ? mw : [0, 0, 0.3, 0.4, 0.3]); L[FG_MISS_BUCKETS[b]] = (L[FG_MISS_BUCKETS[b]] || 0) + 1; }
    xpm = rBinom(r, tds, p.xpa > 0 ? p.xpm / p.xpa : 0.95);
    L.xpa = tds; L.xpm = xpm; L.xpmiss = tds - xpm;
    mnmScaleOthers(L, p, f, { rec: 1, rush: 1, pass: 1 });
  } else {
    fgm = rPoisson(r, 1.6 * f * drive);
    xpm = rBinom(r, tds, 0.95);
  }

  return { lines, pts: 6 * tds + xpm + 3 * fgm, yds: Math.round(PY + RY), ints };
}

// A D/ST's line is mostly the OTHER offence's night — the INTs it catches are
// that QB's INTs, its points allowed is that team's score.
function mnmSimDef(r, team, p, f, opp) {
  p = p || {};
  const L = {
    sack: rPoisson(r, (p.sack || 2.3) * f),
    int: opp.ints,
    fum_rec: rPoisson(r, (p.fum_rec || 0.5) * f),
    def_td: rPoisson(r, ((p.def_td || 0) || 0.1) * f),
    safe: rPoisson(r, (p.safe || 0.03) * f),
    blk_kick: rPoisson(r, (p.blk_kick || 0.04) * f),
    pts_allow: opp.pts,
    yds_allow: opp.yds,
  };
  L.ff = L.fum_rec + rPoisson(r, Math.max(0, (p.ff || 0.6) - (p.fum_rec || 0.5)) * f);
  return mnmScaleOthers(L, p, f, { rec: 1, rush: 1, pass: 1 });
}

// ── Build ─────────────────────────────────────────────────────────────────────
// matchups: [{id, name, value, scoring, isEspn,
//             my:{total, starters:[pid], pts:{pid:n}}, opp: same | null}]
// games:    /api/espn/games rows (home, away, kickoff, state?, period?, clock?)
function mnmBuild({ matchups, games, players, proj, stats, now }) {
  now = now || Date.now();
  const gameOf = {};
  for (const g of games || []) {
    const f = mnmRemainingFrac(g, now);
    const gg = { ...g, f, key: [g.home, g.away].sort().join('_') };
    gameOf[g.home] = gg; gameOf[g.away] = gg;
  }
  const fracOf = pid => gameOf[players[pid]?.team]?.f || 0;

  // Dedupe scoring maps — dozens of leagues usually share a handful.
  const scorings = [], sidOf = {};
  const sidFor = (sc, isEspn) => {
    const full = isEspn ? { ...MNM_KDEF_DEFAULT, ...(sc || {}) } : (sc || {});
    const key = JSON.stringify(full);
    if (sidOf[key] == null) { sidOf[key] = scorings.length; scorings.push(full); }
    return sidOf[key];
  };

  const rows = [];
  const relevant = new Set();
  for (const m of matchups) {
    const side = s => {
      if (!s) return { total: 0, banked: 0, rem: [], now: 0 };
      const starters = (s.starters || []).filter(pid => pid && pid !== '0');
      const rem = starters.filter(pid => fracOf(pid) > 0);
      const remNow = rem.reduce((t, pid) => t + (s.pts?.[pid] || 0), 0);
      return { total: s.total || 0, banked: (s.total || 0) - remNow, rem, pts: s.pts || {}, now: s.total || 0 };
    };
    const my = side(m.my), opp = side(m.opp);
    const decided = !m.opp || (!my.rem.length && !opp.rem.length);
    const row = { ...m, sid: sidFor(m.scoring, m.isEspn), my, opp, decided, gap: my.now - opp.now };
    if (!decided) { my.rem.forEach(p => relevant.add(p)); opp.rem.forEach(p => relevant.add(p)); }
    rows.push(row);
  }

  const live = rows.filter(r => !r.decided);
  const totalValue = live.reduce((s, r) => s + (r.value || 0), 0);
  // No $ set on any live matchup → count wins instead of dollars.
  const unit = totalValue > 0 ? '$' : 'W';
  for (const r of rows) r.weight = unit === '$' ? (r.value || 0) : 1;

  const relGames = [];
  for (const pid of relevant) {
    const g = gameOf[players[pid]?.team];
    if (g && !relGames.includes(g)) relGames.push(g);
  }
  relGames.sort((a, b) => (a.kickoff || '').localeCompare(b.kickoff || '') || a.key.localeCompare(b.key));

  // Team → projected pids, for every team in a game that matters tonight.
  const teamPids = {};
  for (const g of relGames) { teamPids[g.home] = []; teamPids[g.away] = []; }
  for (const pid in proj) {
    const t = players[pid]?.team;
    if (teamPids[t]) teamPids[t].push(pid);
  }
  const models = {};
  for (const t in teamPids) models[t] = mnmTeamModel(t, teamPids[t], proj, players);

  const relList = [...relevant];
  const posOf = pid => players[pid]?.position || '';
  const cur = {};
  for (const pid of relList) cur[pid] = stats?.[pid] || {};

  return {
    rows, live, unit, scorings, gameOf, relGames, models, relList, posOf, cur,
    players, proj, stats: stats || {}, sims: MNM_SIMS,
    decidedWon: rows.filter(r => r.decided && r.opp && r.gap > 0).reduce((s, r) => s + r.weight, 0),
    decidedLost: rows.filter(r => r.decided && r.opp && r.gap < 0).reduce((s, r) => s + r.weight, 0),
  };
}

// Rest-of-game line for every relevant player in one sample. Deterministic per
// sample index, so a "script" can be regenerated for display without storing
// every simulated box score.
function mnmSample(ctx, s) {
  const r = mnmRng(MNM_SEED + Math.imul(s + 1, 2654435761));
  const out = {};
  for (const g of ctx.relGames) {
    const H = mnmSimTeam(r, ctx.models[g.home], g.f, ctx.proj);
    const A = mnmSimTeam(r, ctx.models[g.away], g.f, ctx.proj);
    Object.assign(out, H.lines, A.lines);
    out[g.home] = mnmSimDef(r, g.home, ctx.proj[g.home], g.f, A);
    out[g.away] = mnmSimDef(r, g.away, ctx.proj[g.away], g.f, H);
  }
  for (const pid of ctx.relList) {
    // Rostered but outside the model (IDP, a WR projected for nothing): carry
    // his expected remaining line, so he's priced but adds no variance.
    if (!out[pid]) out[pid] = mnmScaleOthers({}, ctx.proj[pid] || {}, ctx.gameOf[ctx.players[pid]?.team]?.f || 0, { rec: 1, rush: 1, pass: 1 });
  }
  return out;
}

function mnmFinalLine(ctx, pid, rem) {
  return mnmDerive(mnmAdd(ctx.cur[pid], rem || {}), ctx.posOf(pid));
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function mnmRun(ctx, onProgress) {
  const N = ctx.sims, live = ctx.live, P = ctx.relList.length, S = ctx.scorings.length;
  const pidIdx = {}; ctx.relList.forEach((p, i) => { pidIdx[p] = i; });

  // Baseline: what each player's CURRENT line scores in each scoring. The sim
  // adds (final − current) to the league's own published points, so a live
  // score is never second-guessed by this scorer.
  const base = new Float64Array(P * S);
  ctx.relList.forEach((pid, i) => {
    const L = mnmDerive(ctx.cur[pid], ctx.posOf(pid));
    for (let k = 0; k < S; k++) base[i * S + k] = mnmScore(L, ctx.scorings[k]);
  });

  const dollars = new Float64Array(N);
  const outcome = new Uint8Array(N * live.length);   // 0 loss · 1 tie · 2 win
  const refPts = new Float64Array(N * P);
  const delta = new Float64Array(P * S);
  const sidUsed = [...new Set(live.map(r => r.sid))];

  for (let s = 0; s < N; s++) {
    const rem = mnmSample(ctx, s);
    for (let i = 0; i < P; i++) {
      const pid = ctx.relList[i];
      const L = mnmFinalLine(ctx, pid, rem[pid]);
      for (const k of sidUsed) delta[i * S + k] = mnmScore(L, ctx.scorings[k]) - base[i * S + k];
      refPts[s * P + i] = mnmScore(L, MNM_REF_SCORING);
    }
    let usd = 0;
    live.forEach((row, j) => {
      let my = row.my.now, op = row.opp.now;
      for (const pid of row.my.rem) my += delta[pidIdx[pid] * S + row.sid];
      for (const pid of row.opp.rem) op += delta[pidIdx[pid] * S + row.sid];
      const o = Math.abs(my - op) < 0.005 ? 1 : my > op ? 2 : 0;
      outcome[s * live.length + j] = o;
      usd += row.weight * o / 2;
    });
    dollars[s] = usd;
    if (s % 400 === 399) { onProgress?.((s + 1) / N); await new Promise(res => setTimeout(res, 0)); }
  }
  return mnmSummarise(ctx, { dollars, outcome, refPts, N, P });
}

function mnmSummarise(ctx, { dollars, outcome, refPts, N, P }) {
  const live = ctx.live, M = live.length;

  // Per matchup: win probability.
  live.forEach((row, j) => {
    let w = 0;
    for (let s = 0; s < N; s++) w += outcome[s * M + j];
    row.winP = w / (2 * N);
  });

  // Plausibility: each player's sampled night as a percentile of his own
  // simulated distribution → z-score. A script's cost is Σz², so "the most
  // plausible way to win $X" is the sample at $X with the most ordinary box
  // score — not the single most extreme one.
  const plaus = new Float64Array(N);
  const leverage = [];
  const idx = Array.from({ length: N }, (_, i) => i);
  for (let i = 0; i < P; i++) {
    idx.sort((a, b) => refPts[a * P + i] - refPts[b * P + i]);
    let lo = 0, sumHi = 0, nHi = 0, sumLo = 0, nLo = 0;
    while (lo < N) {
      let hi = lo; const v = refPts[idx[lo] * P + i];
      while (hi + 1 < N && refPts[idx[hi + 1] * P + i] === v) hi++;
      const pct = ((lo + hi) / 2 + 0.5) / N, z = invNorm(pct);
      for (let t = lo; t <= hi; t++) {
        const s = idx[t];
        plaus[s] += z * z;
        // Leverage: E[$ | above his median night] − E[$ | below it].
        if (pct > 0.5) { sumHi += dollars[s]; nHi++; } else { sumLo += dollars[s]; nLo++; }
      }
      lo = hi + 1;
    }
    const pid = ctx.relList[i];
    const sorted = idx.map(s => refPts[s * P + i]);
    leverage.push({
      pid, lev: nHi && nLo ? sumHi / nHi - sumLo / nLo : 0,
      p10: sorted[Math.floor(N * 0.1)], p50: sorted[Math.floor(N * 0.5)], p90: sorted[Math.floor(N * 0.9)],
      mine: live.filter(r => r.my.rem.includes(pid)).map(r => r.id),
      theirs: live.filter(r => r.opp.rem.includes(pid)).map(r => r.id),
    });
  }
  leverage.sort((a, b) => Math.abs(b.lev) - Math.abs(a.lev));

  // Tiers: distinct $ totals reached, each with its most plausible sample.
  const tierMap = new Map();
  for (let s = 0; s < N; s++) {
    const key = Math.round(dollars[s] * 100) / 100;
    const t = tierMap.get(key);
    if (!t) tierMap.set(key, { usd: key, count: 1, best: s });
    else { t.count++; if (plaus[s] < plaus[t.best]) t.best = s; }
  }
  const tiers = [...tierMap.values()].sort((a, b) => b.usd - a.usd);
  let cum = 0;
  for (const t of tiers) { cum += t.count; t.pAtLeast = cum / N; }

  const sortedUsd = Array.from(dollars).sort((a, b) => a - b);
  const median = sortedUsd[Math.floor(N / 2)];
  const medTier = tiers.reduce((b, t) => Math.abs(t.usd - median) < Math.abs(b.usd - median) ? t : b, tiers[0]);
  const expected = sortedUsd.reduce((s, x) => s + x, 0) / N;
  const atStake = live.reduce((s, r) => s + r.weight, 0);

  const script = (label, tier) => tier && {
    label, usd: tier.usd, freq: tier.count / N, pAtLeast: tier.pAtLeast, sample: tier.best,
    results: live.map((row, j) => ({ row, o: outcome[tier.best * M + j] })),
  };
  const scripts = [script('miracle', tiers[0])];
  if (medTier !== tiers[0]) scripts.push(script('typical', medTier));
  if (tiers[tiers.length - 1] !== medTier && tiers.length > 1) scripts.push(script('nightmare', tiers[tiers.length - 1]));

  return {
    atStake, expected, median, tiers, scripts, leverage,
    p10: sortedUsd[Math.floor(N * 0.1)], p90: sortedUsd[Math.floor(N * 0.9)],
    sweepP: tiers[0].usd >= atStake - 1e-9 ? tiers[0].count / N : 0,
  };
}

// The full box score for one player in one stored sample (current + rest).
function mnmScriptLine(ctx, s, pid) {
  const rem = mnmSample(ctx, s);
  return mnmAdd(ctx.cur[pid], rem[pid] || {});
}
function mnmScriptLines(ctx, s) {
  const rem = mnmSample(ctx, s), out = {};
  for (const pid of ctx.relList) out[pid] = mnmAdd(ctx.cur[pid], rem[pid] || {});
  return out;
}
// Each matchup's final score in a stored sample.
function mnmScriptScores(ctx, s, lines) {
  const sc = {};
  for (const row of ctx.live) {
    const S = ctx.scorings[row.sid];
    const d = pid => mnmScore(mnmDerive(lines[pid], ctx.posOf(pid)), S) - mnmScore(mnmDerive(ctx.cur[pid], ctx.posOf(pid)), S);
    sc[row.id] = {
      my: row.my.now + row.my.rem.reduce((t, p) => t + d(p), 0),
      opp: row.opp.now + row.opp.rem.reduce((t, p) => t + d(p), 0),
    };
  }
  return sc;
}

// ── "What it takes" — points → a box score, in one league's scoring ─────────
// Scales the player's projected rest-of-game shape (rec/yds, or carries/yds,
// or passing yds) up or down and adds TDs, finding the smallest line that
// clears `need` points under that league's rules — bonuses included, which is
// why it searches rather than dividing.
function mnmShape(ctx, pid, t, k) {
  const p = ctx.proj[pid] || {}, pos = ctx.posOf(pid);
  const f = ctx.gameOf[ctx.players[pid]?.team]?.f || 0;
  const L = {};
  const sc = key => Math.round((p[key] || 0) * f * t);
  if (pos === 'QB') {
    L.pass_yd = sc('pass_yd'); L.pass_att = sc('pass_att'); L.pass_cmp = sc('pass_cmp');
    L.rush_yd = sc('rush_yd'); L.rush_att = sc('rush_att'); L.pass_td = k;
  } else if (pos === 'RB') {
    L.rush_yd = sc('rush_yd'); L.rush_att = sc('rush_att'); L.rec = sc('rec'); L.rec_yd = sc('rec_yd'); L.rush_td = k;
  } else {
    L.rec = sc('rec'); L.rec_yd = sc('rec_yd'); L.rec_td = k;
    if (!p.rec_yd && p.rush_yd) { L.rush_yd = sc('rush_yd'); L.rush_att = sc('rush_att'); }
  }
  // Volume-linked keys (first downs, catches by length…) follow the same t.
  return mnmScaleOthers(L, p, f * t, { rec: 1, rush: 1, pass: 1 });
}
function mnmShapeDelta(ctx, pid, sid, t, k) {
  const S = ctx.scorings[sid], pos = ctx.posOf(pid);
  return mnmScore(mnmDerive(mnmAdd(ctx.cur[pid], mnmShape(ctx, pid, t, k)), pos), S)
       - mnmScore(mnmDerive(ctx.cur[pid], pos), S);
}
const MNM_T_MAX = 4;   // 4× his projection is the ceiling of "possible"
function mnmMinT(ctx, pid, sid, k, need) {
  if (mnmShapeDelta(ctx, pid, sid, 0, k) >= need) return 0;
  if (mnmShapeDelta(ctx, pid, sid, MNM_T_MAX, k) < need) return null;
  let lo = 0, hi = MNM_T_MAX;
  for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; if (mnmShapeDelta(ctx, pid, sid, mid, k) >= need) hi = mid; else lo = mid; }
  return hi;
}
// [{k, line, stretch}] — up to two ways to get there, fewest TDs first, but
// only lines within 2× his projected volume lead: "510 yds, no TD" is a true
// answer and a useless one when "1 TD + 260 yds" also gets there.
const MNM_T_REASONABLE = 2;
function mnmNeedOptions(ctx, pid, sid, need) {
  const pos = ctx.posOf(pid);
  if (pos === 'K' || pos === 'DEF' || !ctx.proj[pid]) return [];
  const all = [];
  for (let k = 0; k <= 3; k++) {
    const t = mnmMinT(ctx, pid, sid, k, need);
    if (t == null) continue;
    all.push({ k, t, line: mnmAdd(ctx.cur[pid], mnmShape(ctx, pid, t, k)) });
    if (t === 0) break;   // the TDs alone do it — another TD says nothing new
  }
  const ok = all.filter(o => o.t <= MNM_T_REASONABLE);
  if (ok.length) return ok.slice(0, 2);
  return all.length ? [{ ...all.reduce((a, b) => b.t < a.t ? b : a), stretch: true }] : [];
}
// For an opponent's lone player: the biggest TD-less line he can have while
// staying under `cushion`, and whether a single TD alone sinks me.
function mnmHoldUnder(ctx, pid, sid, cushion) {
  const pos = ctx.posOf(pid);
  if (pos === 'K' || pos === 'DEF' || !ctx.proj[pid]) return null;
  const tdKills = mnmShapeDelta(ctx, pid, sid, 0, 1) >= cushion;
  const t = mnmMinT(ctx, pid, sid, 0, cushion);
  return { tdKills, line: t == null ? null : mnmAdd(ctx.cur[pid], mnmShape(ctx, pid, t, 0)), unreachable: t == null };
}

// ── Formatting ────────────────────────────────────────────────────────────────
function mnmFmtLine(line, pos) {
  const n = k => Math.round(line[k] || 0);
  const td = k => n(k) ? ` ${n(k)} TD` : '';
  const parts = [];
  if (pos === 'QB') {
    parts.push(`${n('pass_cmp')}/${n('pass_att')} ${n('pass_yd')} yds${td('pass_td')}${n('pass_int') ? ` ${n('pass_int')} INT` : ''}`);
    if (n('rush_yd') || n('rush_td')) parts.push(`${n('rush_yd')} rush yds${td('rush_td')}`);
  } else if (pos === 'K') {
    const fg = FG_BUCKETS.flatMap(([k, d]) => Array(n(k)).fill(d < 20 ? '<20' : d < 50 ? `${Math.floor(d / 10)}0s` : '50+'));
    parts.push(`${n('fgm')} FG${fg.length ? ` (${fg.join(', ')})` : ''}`, `${n('xpm')} XP`);
    if (n('fgmiss')) parts.push(`${n('fgmiss')} miss`);
  } else if (pos === 'DEF') {
    parts.push(`${n('pts_allow')} pts allowed`, `${n('sack')} sk`, `${n('int')} INT`, `${n('fum_rec')} FR`);
    if (n('def_td')) parts.push(`${n('def_td')} TD`);
  } else {
    const rush = `${n('rush_att')} car ${n('rush_yd')} yds${td('rush_td')}`;
    const rec = `${n('rec')} rec ${n('rec_yd')} yds${td('rec_td')}`;
    if (pos === 'RB') { parts.push(rush); if (n('rec') || n('rec_td')) parts.push(rec); }
    else { parts.push(rec); if (n('rush_yd') || n('rush_td')) parts.push(rush); }
  }
  if (n('fum_lost')) parts.push(`${n('fum_lost')} fum`);
  return parts.join(' · ');
}

const api = {
  MNM_SIMS, MNM_KDEF_DEFAULT, mnmBuild, mnmRun, mnmRemainingFrac, mnmGameLabel,
  mnmScriptLines, mnmScriptLine, mnmScriptScores, mnmNeedOptions, mnmHoldUnder,
  mnmFmtLine, mnmDerive, mnmScore, mnmSample,
};
Object.assign(root, api);
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
