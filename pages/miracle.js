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
// Reference yardstick only — orders lines along one axis (window sweep) and
// ranks simulated nights (leverage, ranges). Never decides a matchup.
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
// Monday night = kickoff on a Monday, Eastern. A Monday doubleheader is two.
function mnmIsMonday(g) {
  const k = new Date(g?.kickoff);
  return !isNaN(k) && k.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }) === 'Mon';
}

// Only Monday-night starters are "remaining" — this tool is for the last
// game(s) of the week. A starter in some other unfinished game (opened early,
// on Sunday) is pending: counted at current score + projection, no variance,
// so the Monday picture is right but Sunday isn't simulated.
function mnmBuild({ matchups, games, players, proj, stats, now }) {
  now = now || Date.now();
  const gameOf = {};
  for (const g of games || []) {
    const f = mnmRemainingFrac(g, now);
    const gg = { ...g, f, mnf: mnmIsMonday(g), key: [g.home, g.away].sort().join('_') };
    gameOf[g.home] = gg; gameOf[g.away] = gg;
  }
  const gOf = pid => gameOf[players[pid]?.team];
  const isRem  = pid => { const g = gOf(pid); return !!g && g.mnf && g.f > 0; };
  const isPend = pid => { const g = gOf(pid); return !!g && !g.mnf && g.f > 0; };

  // Dedupe scoring maps — dozens of leagues usually share a handful.
  const scorings = [], sidOf = {};
  const sidFor = (sc, isEspn) => {
    const full = isEspn ? { ...MNM_KDEF_DEFAULT, ...(sc || {}) } : (sc || {});
    const key = JSON.stringify(full);
    if (sidOf[key] == null) { sidOf[key] = scorings.length; scorings.push(full); }
    return sidOf[key];
  };

  const rows = [];
  const relevant = new Set(), pendAll = new Set();
  for (const m of matchups) {
    const side = s => {
      if (!s) return { rem: [], pend: [], pts: {}, now: 0, base: 0 };
      const starters = (s.starters || []).filter(pid => pid && pid !== '0');
      const now = s.total || 0;
      // `base` = what the margin math starts from; pending projections are
      // added to it once scoring is known (below).
      return { rem: starters.filter(isRem), pend: starters.filter(isPend), pts: s.pts || {}, now, base: now };
    };
    const my = side(m.my), opp = side(m.opp);
    const row = { ...m, sid: sidFor(m.scoring, m.isEspn), my, opp };
    row.decided = !m.opp || (!my.rem.length && !opp.rem.length);
    // Nothing on Monday, but someone still playing earlier: not this tool's
    // question — neither live nor settled.
    row.notMonday = !!m.opp && row.decided && (my.pend.length + opp.pend.length) > 0;
    if (!row.decided) { my.rem.forEach(p => relevant.add(p)); opp.rem.forEach(p => relevant.add(p)); }
    [...my.pend, ...opp.pend].forEach(p => pendAll.add(p));
    rows.push(row);
  }

  const relGames = [];
  for (const pid of relevant) {
    const g = gOf(pid);
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
  const relSet = new Set(relList);
  const posOf = pid => players[pid]?.position || '';
  const cur = {};
  for (const pid of [...relList, ...pendAll]) cur[pid] = stats?.[pid] || {};

  const ctx = {
    rows, unit: '$', scorings, gameOf, relGames, models, relList, relSet, posOf, cur,
    players, proj, stats: stats || {}, sims: MNM_SIMS,
    mondayGames: Object.values(gameOf).filter((g, i, a) => g.mnf && a.indexOf(g) === i),
  };

  // Pending (non-Monday, unfinished) starters at current + projection.
  if (pendAll.size) {
    const { expD } = mnmSweepTools(ctx);
    for (const r of rows) {
      r.my.base  += r.my.pend.reduce((t, q) => t + expD(q, r.sid), 0);
      r.opp.base += r.opp.pend.reduce((t, q) => t + expD(q, r.sid), 0);
    }
  }
  for (const r of rows) r.gap = r.my.base - r.opp.base;

  ctx.live = rows.filter(r => !r.decided);
  const totalValue = ctx.live.reduce((s, r) => s + (r.value || 0), 0);
  // No $ set on any live matchup → count wins instead of dollars.
  ctx.unit = totalValue > 0 ? '$' : 'W';
  for (const r of rows) r.weight = ctx.unit === '$' ? (r.value || 0) : 1;
  const settled = rows.filter(r => r.decided && r.opp && !r.notMonday);
  ctx.decidedWon  = settled.filter(r => r.gap > 0).reduce((s, r) => s + r.weight, 0);
  ctx.decidedLost = settled.filter(r => r.gap < 0).reduce((s, r) => s + r.weight, 0);
  return ctx;
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
      let my = row.my.base, op = row.opp.base;
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

  // Leverage: E[$ | above his median night] − E[$ | at or below it].
  const leverage = [];
  const idx = Array.from({ length: N }, (_, i) => i);
  for (let i = 0; i < P; i++) {
    idx.sort((a, b) => refPts[a * P + i] - refPts[b * P + i]);
    const med = refPts[idx[Math.floor(N / 2)] * P + i];
    let sumHi = 0, nHi = 0, sumLo = 0, nLo = 0;
    for (let s = 0; s < N; s++) {
      if (refPts[s * P + i] > med) { sumHi += dollars[s]; nHi++; } else { sumLo += dollars[s]; nLo++; }
    }
    const pid = ctx.relList[i];
    leverage.push({
      pid, lev: nHi && nLo ? sumHi / nHi - sumLo / nLo : 0,
      p10: refPts[idx[Math.floor(N * 0.1)] * P + i], p50: med, p90: refPts[idx[Math.floor(N * 0.9)] * P + i],
      mine: live.filter(r => r.my.rem.includes(pid)).map(r => r.id),
      theirs: live.filter(r => r.opp.rem.includes(pid)).map(r => r.id),
    });
  }
  leverage.sort((a, b) => Math.abs(b.lev) - Math.abs(a.lev));

  // Tiers: distinct $ totals reached and how often.
  const tierMap = new Map();
  for (let s = 0; s < N; s++) {
    const key = Math.round(dollars[s] * 100) / 100;
    tierMap.set(key, (tierMap.get(key) || 0) + 1);
  }
  const tiers = [...tierMap].map(([usd, count]) => ({ usd, count })).sort((a, b) => b.usd - a.usd);

  const sortedUsd = Array.from(dollars).sort((a, b) => a - b);
  const atStake = live.reduce((s, r) => s + r.weight, 0);
  return {
    atStake, tiers, leverage,
    expected: sortedUsd.reduce((s, x) => s + x, 0) / N,
    p10: sortedUsd[Math.floor(N * 0.1)], p90: sortedUsd[Math.floor(N * 0.9)],
    sweepP: tiers[0].usd >= atStake - 1e-9 ? tiers[0].count / N : 0,
  };
}

// ── Optimal windows — the actual numbers ─────────────────────────────────────
// Deterministic, not sampled (the sim is for odds; this is for "what do I need
// to see"). One player's line is swept over his projected shape × t with 0–3
// TDs; every step is scored in every league it touches. Everyone else sits at
// their projected rest-of-game line — EXCEPT the players his line is tied to
// (mnmLinkAdjust), who move with him: a receiver's yards and TDs are his
// QB's; a QB's are shared out to his receivers; the offence's TDs and yards
// are the other D/ST's points/yards allowed and his kicker's PATs. That's
// what makes two players in one game read as one combined projection: Lamb's
// window already knows a big Lamb night is a big Dak night.
const MNM_T_MAX = 4;          // 4× his projected volume is the ceiling of "possible"
const MNM_T_REASONABLE = 2;   // a window past 2× is a wish, not a target
const MNM_T_STEP = 0.025;

function mnmExpectedRem(ctx, pid) {
  const p = ctx.proj[pid] || {}, team = ctx.players[pid]?.team, g = ctx.gameOf[team], f = g?.f || 0;
  const L = {};
  for (const k in p) if (typeof p[k] === 'number' && !MNM_SKIP_RE.test(k)) L[k] = p[k] * f;
  if (ctx.posOf(pid) === 'DEF' && g) {
    const o = ctx.models[g.home === team ? g.away : g.home];
    if (o) {
      L.pts_allow = ((o.passTd + o.rushTd) * 6.9 + 4.8) * f;
      L.yds_allow = (o.passYd + o.rushYd) * f;
      L.int = o.passInt * f;
    }
  }
  return L;
}

// His rest-of-game line at t× projected volume with k TDs. A QB keeps his
// expected INTs (fractional) so a swept QB isn't silently interception-free.
function mnmShape(ctx, pid, t, k) {
  const p = ctx.proj[pid] || {}, pos = ctx.posOf(pid);
  const f = ctx.gameOf[ctx.players[pid]?.team]?.f || 0;
  const L = {};
  const sc = key => Math.round((p[key] || 0) * f * t);
  if (pos === 'QB') {
    L.pass_yd = sc('pass_yd'); L.pass_att = sc('pass_att'); L.pass_cmp = sc('pass_cmp');
    L.rush_yd = sc('rush_yd'); L.rush_att = sc('rush_att'); L.pass_td = k;
    L.pass_int = (p.pass_int || 0) * f;
  } else if (pos === 'RB') {
    L.rush_yd = sc('rush_yd'); L.rush_att = sc('rush_att'); L.rec = sc('rec'); L.rec_yd = sc('rec_yd'); L.rush_td = k;
  } else {
    L.rec = sc('rec'); L.rec_yd = sc('rec_yd'); L.rec_td = k;
    if (!p.rec_yd && p.rush_yd) { L.rush_yd = sc('rush_yd'); L.rush_att = sc('rush_att'); }
  }
  // Volume-linked keys (first downs, catches by length…) follow the same t.
  return mnmScaleOthers(L, p, f * t, { rec: 1, rush: 1, pass: 1 });
}

// Rest-of-game lines for the relevant players tied to `pid`, given his swept
// rest-of-game line `rem`. Only differences from HIS projection propagate, so
// at t≈1 everyone is back at projection. K and D/ST don't drive anyone.
function mnmLinkAdjust(ctx, pid, rem, expRem) {
  const pos = ctx.posOf(pid), team = ctx.players[pid]?.team, g = ctx.gameOf[team];
  const m = ctx.models[team];
  if (!g || !m || pos === 'K' || pos === 'DEF') return {};
  const oppTeam = g.home === team ? g.away : g.home;
  const e = expRem(pid), d = k => (rem[k] || 0) - (e[k] || 0);
  const out = {};
  const bump = (q, k, v) => {
    if (q === pid || !ctx.relSet.has(q) || !v) return;
    const L = out[q] || (out[q] = { ...expRem(q) });
    L[k] = Math.max(0, (L[k] || 0) + v);
  };
  let dYds, dTd;
  if (pos === 'QB') {
    const dPY = d('pass_yd'), dPT = d('pass_td');
    m.rec.forEach((q, i) => {
      const p = ctx.proj[q], ypr = p.rec > 0 ? p.rec_yd / p.rec : 10;
      bump(q, 'rec_yd', m.recShare[i] * dPY);
      bump(q, 'rec', m.recShare[i] * dPY / ypr);
      bump(q, 'rec_td', (p.rec_td || 0) / Math.max(0.3, m.passTd) * dPT);
    });
    bump(oppTeam, 'int', d('pass_int'));
    dYds = dPY + d('rush_yd'); dTd = dPT + d('rush_td');
  } else {
    if (m.qb) {
      bump(m.qb, 'pass_yd', d('rec_yd')); bump(m.qb, 'pass_td', d('rec_td'));
      bump(m.qb, 'pass_cmp', d('rec')); bump(m.qb, 'pass_att', d('rec') / 0.65);
    }
    dYds = d('rec_yd') + d('rush_yd'); dTd = d('rec_td') + d('rush_td');
  }
  bump(oppTeam, 'pts_allow', 7 * dTd);
  bump(oppTeam, 'yds_allow', dYds);
  if (m.k) { bump(m.k, 'xpm', 0.95 * dTd); bump(m.k, 'xpa', dTd); }
  return out;
}

function mnmSweepTools(ctx) {
  if (ctx._sweepTools) return ctx._sweepTools;
  const S = ctx.scorings, posOf = ctx.posOf;
  const expMemo = {}, baseMemo = {}, expDMemo = {};
  const expRem = q => expMemo[q] || (expMemo[q] = mnmExpectedRem(ctx, q));
  const base = (q, sid) => baseMemo[q + '|' + sid] ?? (baseMemo[q + '|' + sid] = mnmScore(mnmDerive(ctx.cur[q], posOf(q)), S[sid]));
  const deltaOf = (q, rem, sid) => mnmScore(mnmDerive(mnmAdd(ctx.cur[q], rem), posOf(q)), S[sid]) - base(q, sid);
  const expD = (q, sid) => expDMemo[q + '|' + sid] ?? (expDMemo[q + '|' + sid] = deltaOf(q, expRem(q), sid));
  return (ctx._sweepTools = { expRem, deltaOf, expD });
}

// One matchup's margin (mine − theirs, final) with some players pinned:
// spec[pid] = {rem} (a rest-of-game line) or {extra} (points vs. projection,
// for K/D-ST). Pinned lines drive their teammates IN THIS MATCHUP through
// mnmLinkAdjust — a Lamb TD is a Dak TD when both start here — but never a
// pinned player (his line is what it was set to). Everyone else: projection.
function mnmRowMargin(ctx, row, spec) {
  const { expRem, deltaOf, expD } = mnmSweepTools(ctx);
  const adj = {};
  for (const pid in spec) {
    if (!spec[pid].rem) continue;
    const a = mnmLinkAdjust(ctx, pid, spec[pid].rem, expRem);
    for (const q in a) {
      if (spec[q]) continue;
      if (!adj[q]) { adj[q] = a[q]; continue; }
      const e = expRem(q), merged = { ...adj[q] };   // two drivers: add both deltas
      for (const k in a[q]) merged[k] = Math.max(0, (merged[k] || 0) + a[q][k] - (e[k] || 0));
      adj[q] = merged;
    }
  }
  const d = q => spec[q] ? (spec[q].rem ? deltaOf(q, spec[q].rem, row.sid) : expD(q, row.sid) + spec[q].extra)
    : adj[q] ? deltaOf(q, adj[q], row.sid) : expD(q, row.sid);
  let m = row.my.base - row.opp.base;
  for (const q of row.my.rem) m += d(q);
  for (const q of row.opp.rem) m -= d(q);
  return m;
}

const mnmOutcome = mg => Math.abs(mg) < 0.005 ? 1 : mg > 0 ? 2 : 0;

// Every step of one player's sweep, with the outcome of each of HIS live
// matchups. `fixed` pins other players (trade-off table); `rowId` limits it to
// one matchup. Only the unpinned whole-slate sweep is cached.
function mnmSweep(ctx, pid, { fixed = null, rowId = null } = {}) {
  const cacheable = !fixed && !rowId;
  ctx._sweeps = ctx._sweeps || {};
  if (cacheable && ctx._sweeps[pid]) return ctx._sweeps[pid];
  const { expRem } = mnmSweepTools(ctx);
  const pos = ctx.posOf(pid);
  const flatPts = pos === 'K' || pos === 'DEF' || !ctx.proj[pid];
  const rows = ctx.live.filter(r => (!rowId || r.id === rowId) && (r.my.rem.includes(pid) || r.opp.rem.includes(pid)));
  // Teammates in his matchups whose lines move with his (for the label).
  const inRows = new Set(rows.flatMap(r => [...r.my.rem, ...r.opp.rem]));
  const linked = flatPts ? [] : Object.keys(mnmLinkAdjust(ctx, pid, mnmShape(ctx, pid, 2, 2), expRem))
    .filter(q => inRows.has(q) && !(fixed && fixed[q]));
  const evals = [];
  const evalAt = (one, ref, line, k, t) => {
    const spec = { ...(fixed || {}), [pid]: one };
    const o = new Uint8Array(rows.length);
    rows.forEach((r, j) => { o[j] = mnmOutcome(mnmRowMargin(ctx, r, spec)); });
    evals.push({ o, ref, line, k, t });
  };
  if (flatPts) {
    // No box-score shape to scale — a K/D/ST's window is in points. Axis =
    // his projected full-game points (reference scoring) + the offset; the
    // same offset is added to his score in every league.
    const proj0 = mnmScore(mnmDerive(mnmAdd(ctx.cur[pid], expRem(pid)), pos), MNM_REF_SCORING);
    const now0 = mnmScore(mnmDerive(ctx.cur[pid], pos), MNM_REF_SCORING);
    // Never below what he already has (a D/ST can still lose points; a K can't).
    const lo = pos === 'DEF' ? -Math.min(12, Math.max(0, proj0 + 4)) : -(proj0 - now0);
    for (let pts = lo; pts <= 22; pts += 0.5) evalAt({ extra: pts }, proj0 + pts, null, null, null);
  } else {
    for (let k = 0; k <= 3; k++) {
      for (let t = 0; t <= MNM_T_MAX + 1e-9; t += MNM_T_STEP) {
        const rem = mnmShape(ctx, pid, t, k), line = mnmAdd(ctx.cur[pid], rem);
        evalAt({ rem }, mnmScore(mnmDerive(line, pos), MNM_REF_SCORING), line, k, t);
      }
    }
  }
  evals.sort((a, b) => a.ref - b.ref);
  const sw = { pid, flatPts, linked, rows, evals };
  if (cacheable) ctx._sweeps[pid] = sw;
  return sw;
}

// The window over a subset of the sweep's matchups (all of them for the
// player card; one for a matchup's "what it needs").
function mnmWindowOf(sw, idxs) {
  const { evals, rows } = sw;
  const usdOf = e => idxs.reduce((s, j) => s + rows[j].weight * e.o[j] / 2, 0);
  for (const e of evals) e._usd = usdOf(e);
  const max = Math.max(...evals.map(e => e._usd)), min = Math.min(...evals.map(e => e._usd));
  const best = evals.filter(e => e._usd >= max - 1e-9);
  const low = best[0], high = best[best.length - 1];
  const below = evals.filter(e => e.ref < low.ref).pop();
  const above = evals.find(e => e.ref > high.ref);
  // Per TD count: smallest → largest volume still at the max. Lines with
  // different TD counts can't be compared end to end, so this is the
  // readable form ("no TD: 132 → 174 yds · 1 TD: 92 → 138 yds").
  const byK = [];
  if (!sw.flatPts) {
    for (let k = 0; k <= 3; k++) {
      const inK = best.filter(e => e.k === k);
      if (!inK.length) continue;
      const lo = inK.reduce((a, b) => b.t < a.t ? b : a), hi = inK.reduce((a, b) => b.t > a.t ? b : a);
      byK.push({ k, lo, hi, fromZero: lo.t === 0, toCap: hi.t >= MNM_T_MAX - MNM_T_STEP / 2 });
    }
  }
  const pick = (e, f) => idxs.filter(j => f(e, j)).map(j => rows[j]);
  return {
    pid: sw.pid, flatPts: sw.flatPts, linked: sw.linked, rows: idxs.map(j => rows[j]),
    max, min, swing: max - min, flat: max - min < 1e-9, low, high, byK,
    floor: low === evals[0], unbounded: high === evals[evals.length - 1],
    wonAtBest: pick(low, (e, j) => e.o[j] === 2),
    lostBelow: below ? pick(low, (e, j) => e.o[j] === 2 && below.o[j] !== 2) : [],
    lostAbove: above ? pick(high, (e, j) => e.o[j] === 2 && above.o[j] !== 2) : [],
  };
}

function mnmWindows(ctx) {
  return ctx.relList.map(pid => {
    const sw = mnmSweep(ctx, pid);
    return sw.rows.length ? mnmWindowOf(sw, sw.rows.map((_, j) => j)) : null;
  }).filter(Boolean).sort((a, b) => b.swing - a.swing);
}

// One matchup's window for one of its remaining players.
function mnmRowWindow(ctx, rowId, pid, fixed) {
  const sw = mnmSweep(ctx, pid, { rowId, fixed });
  return sw.rows.length ? mnmWindowOf(sw, [0]) : null;
}

// Trade-off table for a matchup with 2+ Monday players: step the pivot (my
// biggest non-K/DST player by projected points here; theirs if I have none)
// through a quiet / projected / big night, plus projection + a TD, and for
// each step solve every other player's window with the pivot pinned there.
// Steps are rest-of-game scalings, so a live game's steps start from what he
// already has — 2 TDs in hand never reads as fewer.
const MNM_PIVOT_STEPS = [[0.5, 0, 'quiet'], [1, 0, 'projection'], [1.6, 0, 'big'], [1, 1, 'projection + TD']];
function mnmTradeoff(ctx, rowId) {
  const row = ctx.live.find(r => r.id === rowId);
  if (!row) return null;
  const all = [...row.my.rem, ...row.opp.rem];
  if (all.length < 2) return null;
  const { expD } = mnmSweepTools(ctx);
  const shaped = q => !['K', 'DEF'].includes(ctx.posOf(q)) && ctx.proj[q];
  const byProj = (a, b) => expD(b, row.sid) - expD(a, row.sid);
  const pivot = [...row.my.rem].filter(shaped).sort(byProj)[0] || [...row.opp.rem].filter(shaped).sort(byProj)[0];
  if (!pivot) return null;
  const others = all.filter(q => q !== pivot);
  const seen = new Set(), steps = [];
  // Mid-game, "if he does nothing else" is the row you actually watch for.
  const live = (ctx.gameOf[ctx.players[pivot]?.team]?.f ?? 1) < 1;
  for (const [t, k, label] of live ? [[0, 0, 'nothing more'], ...MNM_PIVOT_STEPS] : MNM_PIVOT_STEPS) {
    const rem = mnmShape(ctx, pivot, t, k), line = mnmAdd(ctx.cur[pivot], rem);
    const key = mnmFmtLine(line, ctx.posOf(pivot));
    if (seen.has(key)) continue;   // late in a game the steps collapse together
    seen.add(key);
    const fixed = { [pivot]: { rem } };
    steps.push({
      label, t, k, line,
      atProj: mnmOutcome(mnmRowMargin(ctx, row, fixed)),   // others at projection
      cells: others.map(q => ({ pid: q, w: mnmRowWindow(ctx, rowId, q, fixed) })),
    });
  }
  // Others whose line moves with the pivot's (same offence, same matchup).
  const linked = mnmSweep(ctx, pivot, { rowId }).linked.filter(q => others.includes(q));
  return { row, pivot, pivotMine: row.my.rem.includes(pivot), others, linked, steps };
}

// ── Formatting ────────────────────────────────────────────────────────────────
function mnmFmtLine(line, pos) {
  const n = k => Math.round(line[k] || 0);
  // Turnovers on a swept line are expected values (0.53 INT) — show whole events only.
  const w = k => Math.floor((line[k] || 0) + 1e-9);
  const td = k => n(k) ? ` ${n(k)} TD` : '';
  const parts = [];
  if (pos === 'QB') {
    parts.push(`${n('pass_cmp')}/${n('pass_att')} ${n('pass_yd')} yds${td('pass_td')}${w('pass_int') ? ` ${w('pass_int')} INT` : ''}`);
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
  if (w('fum_lost')) parts.push(`${w('fum_lost')} fum`);
  return parts.join(' · ');
}

const api = {
  MNM_SIMS, MNM_KDEF_DEFAULT, MNM_T_REASONABLE, mnmBuild, mnmRun, mnmRemainingFrac, mnmGameLabel,
  mnmWindows, mnmRowWindow, mnmTradeoff, mnmIsMonday,
  mnmFmtLine, mnmDerive, mnmScore, mnmSample,
};
Object.assign(root, api);
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
