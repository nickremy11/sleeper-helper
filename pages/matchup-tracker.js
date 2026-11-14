// ── Live Matchups engine (rootforme.html) ────────────────────────────────────
// Pure functions, no DOM. Each starter's final = what he has now + his projection
// scaled to the part of his game still to play; each side is a normal around the
// sum of those; a matchup's win % is the margin's normal CDF. A closed form on
// purpose: this reruns for ~70 leagues on every Refresh, and the question is "how
// is my week tracking", not a stat line — that's what /miracle.js's joint sim is for.
// Players are treated as independent, so a stack's swing is a little understated.
(function (root) {
'use strict';

// Weekly stdev as a share of projection. QB…DB match index.html's LS_POS_CV, so a
// player is as volatile here as in the playoff-odds sim.
const LM_POS_CV = { QB: 0.43, RB: 0.50, WR: 0.52, TE: 0.58, DL: 0.55, LB: 0.55, DB: 0.55, K: 0.55, DEF: 0.80 };
const LM_SD_FLOOR = 2;  // a 3-point flex play can still go off; pure CV says he can't

const LM_POS_NORM = { DE: 'DL', DT: 'DL', NT: 'DL', ILB: 'LB', OLB: 'LB', MLB: 'LB', CB: 'DB', S: 'DB', SS: 'DB', FS: 'DB', SAF: 'DB', DST: 'DEF' };
const lmPos = p => { const u = String(p || '').toUpperCase(); return LM_POS_NORM[u] || u; };

// Toss-up = the middle 20% of win probability.
const LM_TOSS_BAND = 0.10;
// A lock takes BOTH: the margin is 2+ stdevs of the whole matchup, and no single
// player's 3-stdev game erases it — "multiple stdevs from multiple players". The
// second test is what stops one remaining player, 2 stdevs short, reading as a lock.
const LM_LOCK_Z = 2;
const LM_LOCK_SOLO = 3;

const LM_TIERS = [
  { key: 'lock', label: 'Mortal Locks' },
  { key: 'good', label: 'Looking Good' },
  { key: 'toss', label: 'Toss-Ups' },
  { key: 'bad',  label: 'Looking Bad' },
  { key: 'dead', label: 'Lost Causes' },
];

// Abramowitz & Stegun 26.2.17.
function lmPhi(z) {
  const a = Math.abs(z), t = 1 / (1 + 0.2316419 * a);
  const d = Math.exp(-a * a / 2) / Math.sqrt(2 * Math.PI);
  const q = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - q : q;
}

// One starter. `f` is the fraction of his game left (mnmRemainingFrac). `out` only
// bites before kickoff: projections lag a late scratch, but once he's played, his
// points are his points.
function lmLine({ pid, name, pts, proj, pos, f, out }) {
  const P = lmPos(pos);
  const now = pts || 0;
  const expected = out && f >= 1 ? 0 : (proj || 0);
  // A D/ST's score carries its points-allowed bucket, so it opens the game at a
  // shutout's bonus and gives it back. Adding its projection on top would double
  // count that, so it drifts from where it is toward its projection instead.
  const rest = P === 'DEF' ? f * (expected - now) : f * expected;
  const sd = expected > 0 ? Math.max((LM_POS_CV[P] ?? 0.50) * expected, LM_SD_FLOOR) * Math.sqrt(f) : 0;
  return { pid, name, pos: P, pts: now, rest, sd, f, expFinal: now + rest, left: f > 0 && expected > 0 };
}

// Best ball scores an optimal lineup re-picked after the fact, so the projection
// has to pick one too rather than sum `starters`. Greedy is exact here: dedicated
// slots first, then flexes narrowest-first, and those eligibilities nest.
function lmBestLineup(lines, rosterPositions) {
  const slots = (rosterPositions || []).map(lmPos).filter(s => !['BN', 'IR', 'TAXI'].includes(s));
  const dedicated = slots.filter(s => !SLOT_ELIG[s]);
  const flexes = slots.filter(s => SLOT_ELIG[s]).sort((a, b) => FLEX_ORDER.indexOf(a) - FLEX_ORDER.indexOf(b));
  const pool = [...lines].sort((a, b) => b.expFinal - a.expFinal);
  const out = [];
  for (const slot of [...dedicated, ...flexes]) {
    const elig = SLOT_ELIG[slot] || [slot];
    const i = pool.findIndex(l => elig.includes(l.pos));
    if (i >= 0) out.push(pool.splice(i, 1)[0]);
  }
  return out;
}

// `now` is the platform's own team score. `lines` may carry extra display fields
// (slot, team, inj) — they ride along untouched. A lineup's final builds on it so a player
// we couldn't price still counts; best ball sums its re-picked lineup instead.
function lmProjectSide({ lines, now, bestBall, rosterPositions }) {
  const counted = bestBall ? lmBestLineup(lines, rosterPositions) : lines;
  const base = bestBall ? counted.reduce((s, l) => s + l.pts, 0) : (now || 0);
  return {
    now: now || 0,
    proj: base + counted.reduce((s, l) => s + l.rest, 0),
    sd: Math.sqrt(counted.reduce((s, l) => s + l.sd * l.sd, 0)),
    maxSd: counted.reduce((m, l) => Math.max(m, l.sd), 0),
    left: counted.filter(l => l.left).length,
    done: lines.every(l => l.f <= 0),
    lines,      // every priced line, for the click-in lineup view
    counted,    // the lines the score is built from — all of them, or best ball's re-picked lineup
  };
}

function lmTier(mu, sd, maxSd, p) {
  if (sd <= 0) return mu > 0 ? 'lock' : mu < 0 ? 'dead' : 'toss';
  if (Math.abs(p - 0.5) <= LM_TOSS_BAND) return 'toss';
  const safe = Math.abs(mu) >= LM_LOCK_Z * sd && Math.abs(mu) >= LM_LOCK_SOLO * maxSd;
  if (mu > 0) return safe ? 'lock' : 'good';
  return safe ? 'dead' : 'bad';
}

function lmEvaluate(my, opp) {
  const mu = my.proj - opp.proj;
  const sd = Math.sqrt(my.sd * my.sd + opp.sd * opp.sd);
  const p = sd > 0 ? lmPhi(mu / sd) : (mu > 0 ? 1 : mu < 0 ? 0 : 0.5);
  return { mu, sd, p, tier: lmTier(mu, sd, Math.max(my.maxSd, opp.maxSd), p), final: my.done && opp.done };
}


// P(I finish in the league's top half this week), which is what a median game pays.
// Sampled, unlike H2H: the rank of one team in a field has no tidy closed form. The
// seed is fixed so a Refresh with unchanged scores doesn't reshuffle the number.
function lmMedianOdds(teams, myIdx, sims = 2000) {
  const n = teams.length, top = Math.floor(n / 2);
  if (!top || !teams[myIdx]) return null;
  const r = mnmRng(0x4c4d);
  const z = () => { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };
  let wins = 0;
  const draw = new Array(n);
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) draw[i] = teams[i].proj + (teams[i].sd > 0 ? teams[i].sd * z() : 0);
    let above = 0;
    for (let i = 0; i < n; i++) if (i !== myIdx && draw[i] > draw[myIdx]) above++;
    if (above < top) wins++;
  }
  return wins / sims;
}

// Headline numbers for whichever rows the filters left in. A median game is its own
// W/L, so it stays out of the H2H record — exactly how the page reports the two.
function lmSummary(rows) {
  const s = { w: 0, l: 0, t: 0, exp: 0, medW: 0, medL: 0, medN: 0, medExp: 0, upW: 0, upL: 0, upT: 0, started: false, tiers: {} };
  for (const t of LM_TIERS) s.tiers[t.key] = 0;
  for (const r of rows) {
    s.tiers[r.tier]++;
    s.exp += r.p;
    if (r.mu > 0) s.w++; else if (r.mu < 0) s.l++; else s.t++;
    const gap = r.my.now - r.opp.now;
    if (gap > 0) s.upW++; else if (gap < 0) s.upL++; else s.upT++;
    if (r.my.now !== 0 || r.opp.now !== 0) s.started = true;
    if (r.medianP != null) {
      s.medN++;
      s.medExp += r.medianP;
      if (r.medianP >= 0.5) s.medW++; else s.medL++;
    }
  }
  return s;
}

const api = { LM_TIERS, lmPhi, lmLine, lmBestLineup, lmProjectSide, lmTier, lmEvaluate, lmMedianOdds, lmSummary };
Object.assign(root, api);
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
