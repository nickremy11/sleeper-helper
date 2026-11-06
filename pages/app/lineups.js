// Lineup Checker: optimizer, ranking sheets, Injury Swap, ESPN lineups

// ── 4. Lineup Check ──────────────────────────────────────────────────────────

// Lineups tab state — populated by renderLineupCheck, read by testSetLineup
const LU = {
  lineups: [], week: 1,
  proj: {},                 // {pid: stats} — Sleeper weekly projections
  kick: {},                 // {nflTeam: kickoffISO} — ESPN scoreboard
  ranks: null,              // parsed weekly ranking sheet — see luParseRanksCsv
  byGameTime: true,         // order interchangeable slots so flex never locks earlier than a position slot
  faOn: true,               // free-agent watch (redraft only) — see luFaUpgrades
  weekOverride: null,       // {from, to} — self-expiring manual week, see luWeekFor
  openSlot: null,           // {leagueId, slotIdx} — the one row showing its replacement options
  _cache: null,             // { at, week, lineups, proj, kick } — see LU_CACHE_TTL
};
try { LU.faOn = localStorage.getItem('lu_fa_watch') !== '0'; } catch(_) {}
try { LU.weekOverride = JSON.parse(localStorage.getItem('lu_week_override') || 'null'); } catch(_) {}

// How long a loaded lineup snapshot stays fresh before renderLineupCheck refetches.
// Revisiting the tab, hopping to the ranks grid, or re-rendering after a sheet
// upload all skip the per-league rosters+matchups fetch entirely within it.
const LU_CACHE_TTL = 5 * 60 * 1000;

const LU_WEEK_KEY = 'lu_week_override';
const LU_MAX_WEEK = 18;

// Which week the lineup tools operate on.
//
// Sleeper publishes two answers that disagree for about 24h every week:
//   leg / week    — advances once the prior week's games finish scoring
//                   (observed already flipped by Tuesday morning)
//   display_week  — holds on the just-completed week through the results-review
//                   window, rolling over around Wednesday's waiver run
//
// This tab SETS lineups, so it wants the week it is about to play, not the one
// being reviewed — that makes `leg` the right source here and leaves the Tuesday
// dead zone with no lineup to edit. display_week stays the fallback.
//
// The reverse risk — leg flipping while Monday night is still being played — is
// not real in practice: it would break Sleeper's own live scoring for everyone,
// and once MNF is final the week's lineups are moot anyway. The manual stepper
// below covers it if that assumption ever turns out to be wrong.
//
// Deliberately NOT shared with the rest of the app: League Summaries counts
// banked results and rootforme.html shows the week being played, and both are
// correct to keep following display_week.
function luAutoWeek(nflState) {
  if (!nflState) return null;
  if (nflState.season_type !== 'regular') return 1;
  return nflState.leg || nflState.display_week || 1;
}

// The override is stored as {from, to} rather than a bare week number so it
// EXPIRES ON ITS OWN: it applies only while Sleeper's own answer still reads
// `from`, so the moment display_week catches up the override stops matching and
// is dropped. A bare number would be a sticky manual week — i.e. the exact bug
// this exists to fix, one week later and with no auto-recovery.
// True while a stored override still refers to the week it was pinned against.
// The regular-season test is load-bearing, not belt-and-braces: luAutoWeek pins
// EVERY other season type to week 1, so without it a forgotten {from:1} override
// would come back from the dead in the offseason and read as a stuck week.
function luOverrideLive(nflState, ov = LU.weekOverride) {
  return !!(ov && nflState && nflState.season_type === 'regular' && ov.from === luAutoWeek(nflState));
}

function luWeekFor(nflState) {
  return luOverrideLive(nflState) ? LU.weekOverride.to : luAutoWeek(nflState);
}

function luSaveWeekOverride(ov) {
  LU.weekOverride = ov;
  try {
    if (ov) localStorage.setItem(LU_WEEK_KEY, JSON.stringify(ov));
    else    localStorage.removeItem(LU_WEEK_KEY);
  } catch(_) {}
}

// Step the manual week — now a safety valve rather than the routine path, since
// luAutoWeek follows `leg` and lands on the right week by itself. Landing back on
// Sleeper's own answer clears the override outright instead of storing a no-op,
// so the badge stops claiming "manual".
async function luStepWeek(delta) {
  if (S.nflState?.season_type !== 'regular') return;
  const auto = luAutoWeek(S.nflState);
  if (auto == null) return;
  const next = Math.max(1, Math.min(LU_MAX_WEEK, (LU.week || auto) + delta));
  if (next === LU.week) return;
  luSaveWeekOverride(next === auto ? null : { from: auto, to: next });
  await renderLineupCheck(true);
}

async function luClearWeek() {
  luSaveWeekOverride(null);
  await renderLineupCheck(true);
}

// Compact stepper for the lineup toolbar. An active override is labelled and
// gets an explicit way back to Sleeper's answer — a manual week that rendered
// identically to the automatic one would be impossible to notice, which is the
// failure mode that makes a stuck week look like a bug in the first place.
function luWeekCtlHtml(w) {
  // Nothing to step through outside the regular season — every week resolves to 1.
  if (S.nflState?.season_type !== 'regular') return '';
  const auto = luAutoWeek(S.nflState);
  const on   = luOverrideLive(S.nflState);
  return `<span style="display:inline-flex;gap:4px;align-items:center;">
      <button class="ghost-btn" style="font-size:0.5rem;" title="Previous week" onclick="luStepWeek(-1)"${w <= 1 ? ' disabled' : ''}>◀</button>
      <span style="font-size:0.55rem;white-space:nowrap;color:${on ? '#d08a30' : 'var(--brown-light)'};">Week ${w}${on ? ' · manual' : ''}</span>
      <button class="ghost-btn" style="font-size:0.5rem;" title="Next week" onclick="luStepWeek(1)"${w >= LU_MAX_WEEK ? ' disabled' : ''}>▶</button>
      ${on ? `<button class="ghost-btn" style="font-size:0.5rem;" title="Back to Sleeper's week (${auto})" onclick="luClearWeek()">✕</button>` : ''}
    </span>`;
}

// Step-1 proof: re-write a league's CURRENT starters back (a no-op set).
// Confirms the write pipe (proxy + token + mutation shape) works end-to-end
// before we let it pick optimal lineups.
async function testSetLineup(idx) {
  const fix = LU.lineups[idx];
  const out = document.getElementById('lc-result-test-' + idx);
  if (!fix || !out) return;
  out.style.color = 'var(--brown-light)';
  out.textContent = 'setting…';
  try {
    const res = await setLineup(fix.leagueId, fix.rosterId, LU.week, fix.starters);
    const echoed = res?.starters || [];
    const match  = echoed.length === fix.starters.length &&
                   echoed.every((p, i) => String(p) === String(fix.starters[i]));
    out.style.color = match ? '#5fae5f' : '#d08a30';
    out.textContent = match ? '✓ saved — starters echoed back unchanged'
                            : '⚠ saved but starters differ: ' + JSON.stringify(echoed);
  } catch (e) {
    out.style.color = '#c0504d';
    out.textContent = '✗ ' + (e.message || 'failed');
  }
}


// ── Season-to-date PPG ─────────────────────────────────────────────────────
// What a player has actually averaged this year, scored to whichever league is
// being looked at. Shared by the Lineup Checker rows, the Injury Swap chooser,
// Player Finder and Scout — so it lives here rather than inside any one of them.
// One ~1MB pull per session, and the worker gives this path a 15-minute
// browser+KV cache (PROXY_CACHE_RULES), so every tab after the first is free.
let _seasonStats = null;

async function ppgLoadStats() {
  if (_seasonStats) return _seasonStats;
  const st     = await getNflState();
  const season = st?.season || String(new Date().getFullYear());
  try { _seasonStats = await api('/stats/nfl/regular/' + season) || {}; }
  catch (_) { _seasonStats = {}; }
  return _seasonStats;
}

// Games actually played — the denominator behind the PPG, and in every tooltip
// because "14.2 over 2 games" and "14.2 over 11" are not the same claim. Note
// this is games played, NOT weeks elapsed: a player who missed three weeks shows
// the average of the games he was in, which is what PPG means and also why the
// count has to travel with the number.
function playerSeasonGp(pid) { return _seasonStats?.[pid]?.gp || 0; }

// Full PPR, used only when a caller has no league scoring to offer — Player
// Finder spans every league at once, so there is no single league's settings to
// apply. Deliberately NOT crScoreSleeper's built-in `??` defaults, which cover
// nine offensive stats and therefore price every kicker and defence at 0.
//
// These are Sleeper's OWN default PPR values, checked by scoring every played
// player's season line with this table and comparing against the `pts_ppr`
// Sleeper ships on that same line: 424 of 424 matched to the cent, offence,
// kickers and team defences alike. Two of these are easy to get wrong from
// memory and both were caught that way — `pass_int` is -1, not the -2 most
// leagues configure, and the special-teams turnover keys (def_st_*) are scored
// separately from the defensive ones.
const PPG_PPR_SCORING = {
  pass_yd: 0.04, pass_td: 4, pass_int: -1, pass_2pt: 2,
  rush_yd: 0.1,  rush_td: 6, rush_2pt: 2,
  rec: 1, rec_yd: 0.1, rec_td: 6, rec_2pt: 2,
  fum_lost: -2, fum_rec_td: 6,
  fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5,
  fgmiss: -1, xpm: 1, xpmiss: -1,
  sack: 1, int: 2, ff: 1, fum_rec: 2, safe: 2, blk_kick: 2, def_td: 6, def_st_td: 6, st_td: 6,
  def_st_ff: 1, def_st_fum_rec: 1, st_ff: 1, st_fum_rec: 1,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1,
  pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4,
};

// The PPG a player has ACTUALLY scored so far, under a league's own settings.
//
// Scored with computeProjPts — the SAME generic scorer as the projection that
// sits beside it, so the two numbers on a row are never computed on different
// rules. That genericness is also what earns K and DEF a real number: their
// season lines carry fgm_*/xpm and sack/ff/pts_allow_*, all of which are real
// scoring_settings keys, where a fixed offensive formula (crScoreSleeper) scores
// them 0. It picks up first downs, 2-pointers and fumbles lost for offence too.
//
// Safe against the season line's non-scoring fields (gp, rank_ppr, tm_off_snp,
// Sleeper's own pts_ppr) because computeProjPts only multiplies keys the
// league actually scores, and none of those is one. Team-DEF lines carry bare
// `tkl`/`sack` aggregates while individual defenders carry the `idp_`-prefixed
// versions, so an IDP league's tackle scoring cannot land on a team defence.
//
// Dividing by `gp` is what makes a season TOTAL a per-game number. Null when
// there is no line or he has not played; otherwise the figure is reported as-is,
// 0.0 and negatives included, because "he played and scored nothing" is real
// information and a defence that gave up 40 can genuinely go below zero.
//
// The one exception is the coverage guard, and it exists because of ESPN.
// crParseEspnScoring maps OFFENCE ONLY — no fgm_*/xpm, no sack/pts_allow_* — so
// an ESPN league's scoring map covers none of a kicker's or a D/ST's categories
// and this scores them a confident 0.0, which is a wrong number rather than a
// missing one. A zero under the league's map that is NON-zero under Sleeper's
// defaults means the map doesn't cover this player, so say nothing instead. A
// player who really scored nothing is zero under both and still reports 0.0.
function playerSeasonPpg(pid, scoring) {
  const line = _seasonStats?.[pid];
  if (!line || !(line.gp > 0)) return null;
  const ss  = (scoring && Object.keys(scoring).length) ? scoring : PPG_PPR_SCORING;
  const pts = computeProjPts(line, ss);
  if (pts === 0 && ss !== PPG_PPR_SCORING && computeProjPts(line, PPG_PPR_SCORING) !== 0) {
    // The map doesn't cover him — but for an ESPN league ESPN itself may have
    // said what he averages (see ESPN_SEASON_AVG), already in league scoring.
    const own = ESPN_SEASON_AVG.get(scoring)?.[String(pid)];
    return typeof own === 'number' ? own : null;
  }
  return pts / line.gp;
}

// ESPN's own season-to-date average per player (`appliedAverage` on the season
// stat line), keyed by the fixture's scoringSettings OBJECT — every caller
// already passes that object to playerSeasonPpg, so no signature changes. It's
// the fallback for exactly the players crParseEspnScoring can't price (K and
// D/ST: their statIds aren't mapped, and ESPN's points-allowed bands don't line
// up with Sleeper's, so mapping them would be wrong, not just incomplete).
const ESPN_SEASON_AVG = new WeakMap();

// The season ACTUAL line off an ESPN player: statSourceId 0 (real, not
// projected), scoringPeriodId 0 + statSplitTypeId 0 (the whole season, not a
// week), this season. appliedAverage is per game played, in league scoring.
function luEspnSeasonAvg(pl, season) {
  const st = (pl?.stats || []).find(x => x.statSourceId === 0 && Number(x.scoringPeriodId) === 0
    && Number(x.statSplitTypeId) === 0 && (x.seasonId == null || Number(x.seasonId) === Number(season)));
  return st && typeof st.appliedAverage === 'number' ? st.appliedAverage : null;
}

// The projection context for one fixture. ESPN leagues can carry ESPN's OWN
// weekly projections (`_espnProj`), which arrive already scored with that
// league's real settings; everything else scores Sleeper's stat line with the
// league's scoring_settings. Passed around in place of the bare scoring object
// so every consumer (luSortKey, the diff rows, the swap panel) prices a player
// the same way without any of them branching on ESPN.
function luPtsCtx(fix) {
  return { scoring: fix?.scoringSettings || {}, espnProj: fix?._espnProj || null };
}

function luPlayerPts(pid, pc) {
  const own = pc?.espnProj?.[String(pid)];
  if (typeof own === 'number') return own;
  return computeProjPts(LU.proj[pid], pc?.scoring || {});
}

// What a player has ACTUALLY scored this week, in this league's scoring — not a
// projection. Both loaders put it on the fixture as `_pts` (Sleeper's
// players_points off the week's matchup; ESPN's statSourceId-0 appliedTotal), so
// nothing here branches on the source. Null when the league didn't publish one,
// which is the normal state before kickoff.
function luActualPts(pid, fix) {
  const v = fix?._pts?.[String(pid)];
  return typeof v === 'number' ? v : null;
}

// Positions the lineup optimizer understands. crNormPos deliberately drops K and
// DEF (Rostership has no use for them); lineups do, so widen it here only.
function luNormPos(raw) {
  const p = crNormPos(raw);
  if (p) return p;
  const u = String(raw || '').toUpperCase();
  if (u === 'K')                  return 'K';
  if (u === 'DEF' || u === 'DST') return 'DEF';
  return null;
}

// `pc` (a luPtsCtx) makes the answer league-aware: in a TEP league, when the
// sheet carries a TEP FLEX block, the entry comes back with flexRank set to the
// TEP list's rank — so the optimizer, the rank cells, the swap chooser and its
// labels all follow the TEP ordering without any of them branching on it.
// A player missing from the TEP list gets no flex rank rather than falling back
// to the plain list, whose numbers are a different ordering.
function luRankInfo(pid, pc) {
  const r = LU.ranks?.byPid?.[String(pid)] || null;
  return r && luUseTep(pc) ? { ...r, flexRank: r.flexRankTep ?? null } : r;
}
function luIsTep(pc)  { return (pc?.scoring?.bonus_rec_te ?? 0) > 0; }
function luUseTep(pc) { return luIsTep(pc) && !!LU.ranks?.cols?.FLEX_TEP?.length; }
function luHaveRankings() { return !!(LU.ranks && Object.keys(LU.ranks.byPid || {}).length); }
function luCanOptimize(src) { return src === 'ranks' ? luHaveRankings() : luHaveProj(); }

// How much the sheet can say about a given roster slot.
function luSlotKind(slot) {
  if (slot === 'SUPER_FLEX') return 'superflex';
  if (SLOT_ELIG[slot])    return 'flex';
  return 'dedicated';
}

// Sort key for one player in one slot, compared lexicographically — LOWER WINS.
// Projections mode is a single band ordered by points. Ranks mode has to band,
// because a sheet's ranks are POSITIONAL (QB1 and RB1 are both rank 1) and so
// aren't comparable across positions on their own:
//   dedicated  ranked at the position → its positional rank
//   flex       ranked in the FLEX list → its FLEX rank, the sheet's own
//              cross-position ordering of RB/WR/TE
//   superflex  a ranked QB always outranks any flex player, so the slot lands on
//              the best QB still available — QB1 having already been taken by the
//              QB slot makes that your QB2 — and only falls through to the FLEX
//              list when there is no second ranked QB.
// Anyone the sheet doesn't cover lands in the last band ordered by projected
// points: below every ranked player, but still sensibly ordered among themselves.
// That last part is what quietly keeps IDP slots running on projections.
function luSortKey(pid, kind, pc, src) {
  const pts = luPlayerPts(pid, pc);
  if (src !== 'ranks') return [0, 0, -pts];
  const r = luRankInfo(pid, pc);
  if (r) {
    if (kind === 'superflex') {
      if (r.pos === 'QB' && r.posRank != null) return [0, r.posRank, 0];
      if (r.flexRank != null)                  return [1, r.flexRank, 0];
    } else if (kind === 'flex') {
      if (r.flexRank != null)                  return [0, r.flexRank, 0];
    } else if (r.posRank != null)              return [0, r.posRank, 0];
  }
  return [kind === 'superflex' ? 2 : 1, 0, -pts];
}
function luCmpKey(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// Kickoff time (ms) for a player's NFL game this week; Infinity if unknown.
function luGameTime(pid) {
  const team = S.players[pid]?.team;
  const iso  = team && LU.kick[team];
  return iso ? new Date(iso).getTime() : Infinity;
}

// A player whose NFL game has kicked off is LOCKED: he can no longer be moved out
// of a starting slot, nor moved into one. Sleeper enforces this server-side, so
// proposing such a move only produces a write that fails — but the real reason is
// that his points are already banked, so "a better player is available" stops being
// something you can act on, and a lineup that only differs in locked slots is in
// fact optimal.
//
// Everything unknown reads as NOT locked (luGameTime → Infinity): a bye week, a
// player with no NFL team, and — deliberately — a scoreboard fetch that failed.
// A missing feed switches the whole feature off rather than locking the wrong half
// of a lineup.
function luLocked(pid) {
  const t = luGameTime(pid);
  return t !== Infinity && t <= Date.now();
}

// Proposals are cached on the fixture, so they have to be invalidated when a game
// kicks off underneath them — the 5-minute data cache alone would happily keep a
// pre-kickoff proposal alive past the lock. Counting the teams already playing is a
// cheap stamp that only ever changes at a kickoff.
function luLockEpoch() {
  const now = Date.now();
  let n = 0;
  for (const iso of Object.values(LU.kick || {})) if (new Date(iso).getTime() <= now) n++;
  return n;
}

// Within each position, ensure no flex-slot player kicks off earlier than a
// same-position player in a dedicated slot — so the earliest games lock into
// their natural slot and the flex stays open longest. Score-neutral; strict
// game-time ties are left as-is.
function luOrderByGameTime(out, slots) {
  ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB'].forEach(P => {
    const dedI = [], flexI = [];
    slots.forEach((slot, i) => {
      const pid = String(out[i] || '0');
      if (pid === '0' || crNormPos(S.players[pid]?.position) !== P) return;
      if (luLocked(pid)) return;   // already playing — his slot is frozen
      if (SLOT_ELIG[slot]) flexI.push(i);
      else if (crNormPos(slot) === P) dedI.push(i);
    });
    if (!dedI.length || !flexI.length) return;
    for (let guard = 0; guard < 20; guard++) {
      const fi = flexI.reduce((a, b) => luGameTime(out[b]) < luGameTime(out[a]) ? b : a);  // earliest flex
      const di = dedI.reduce((a, b) => luGameTime(out[b]) > luGameTime(out[a]) ? b : a);    // latest dedicated
      if (luGameTime(out[fi]) < luGameTime(out[di])) { const t = out[fi]; out[fi] = out[di]; out[di] = t; }
      else break;
    }
  });
  return out;
}

// ── Weekly ranking sheet ─────────────────────────────────────────────────────
// A sheet is seven side-by-side blocks in one CSV — QB / RB / WR / TE / DEF /
// FLEX / K — each with its own independent 1..N ordering and its own length, so
// the shorter blocks pad with empty cells. FLEX is the only block that ranks
// across positions, which is why it carries the load for flex slots.
//   LU.ranks = {
//     v, week, uploadedAt, srcName,
//     byPid: {pid: {pos, posRank, flexRank, flexRankTep, tier, opp, total, matchup}},
//     cols:  {QB:[row], …}  — ordered as the sheet lists them, INCLUDING rows
//                             whose name didn't resolve to a Sleeper id, so the
//                             grid can still render the full sheet
//   }

// Real CSV split — quoted fields may contain commas — with the UTF-8 BOM stripped.

// Blocks are found by their HEADER text ("QB Rank", "FLEX Pos", "DEF Spread"…)
// rather than fixed offsets, so a reordered or partial export still parses.
// DEF names its player column "Team" (the full team name is the defense).
// FLEX_TEP is the same cross-position list re-ranked for tight-end-premium
// scoring (headers "TEP FLEX Rank"…). It lands on each player as flexRankTep,
// which luRankInfo serves in place of flexRank for a TEP league.
const LU_RANK_BLOCKS = {
  QB:       { nameCol: 'Player' },
  RB:       { nameCol: 'Player' },
  WR:       { nameCol: 'Player' },
  TE:       { nameCol: 'Player' },
  DEF:      { nameCol: 'Team'   },
  K:        { nameCol: 'Player' },
  FLEX:     { nameCol: 'Player' },   // must build after the position blocks — they
  FLEX_TEP: { nameCol: 'Player', prefix: 'TEP FLEX' },   // fill flexRank(Tep) onto their entries
};
const LU_FLEX_BLOCKS = new Set(['FLEX', 'FLEX_TEP']);
const luBlockLabel = b => b === 'FLEX_TEP' ? 'TEP FLEX' : b;

function luNum(v) { const n = parseFloat(v); return isFinite(n) ? n : null; }

// Resolve a sheet row to a Sleeper id. Name first; the team column only comes
// into play when the name-only match lands on a player from a different team,
// which means two active players share the name and search_rank picked wrong.
function luMatchRankRow(name, team) {
  const key = normName(name);
  if (!key) return null;
  const pid = S._playersByName?.[key] || null;
  const t   = team ? normTeamAbbr(team) : null;
  if (!t) return pid;
  const byTeam = S._playersByNameTeam?.[key + '|' + t] || null;
  if (byTeam && (!pid || normTeamAbbr(S.players[pid]?.team) !== t)) return byTeam;
  return pid || byTeam;
}

// Last-name fallback for sheets that list a position by surname only (kicker
// blocks often do: "Reichard, MIN"). Scoped to that position and, when the sheet
// gives one, that team — and it only answers when exactly one player fits, so a
// shared surname resolves to nothing rather than to the wrong man.
function luMatchByLastName(name, team, pos) {
  const key = normName(name);
  if (!key || key.includes(' ')) return null;          // a full name already had its chance
  const t = team ? normTeamAbbr(team) : null;
  let hit = null;
  for (const [pid, p] of Object.entries(S.players || {})) {
    if (luNormPos(p.position) !== pos || normName(p.last_name || '') !== key) continue;
    if (t && normTeamAbbr(p.team) !== t) continue;
    if (hit) return null;                                // ambiguous
    hit = pid;
  }
  return hit;
}

// Some sheets carry the tier in a block's "Projection" column instead of a Tier
// column (the K block: 1,1,1,…,2,2,…). Read it as the tier only when it looks
// like one — whole numbers, small, never going DOWN as rank goes up. A real
// points projection fails the last test straight away.
function luProjIsTier(rows, iRank, iProj) {
  const pairs = rows.slice(1)
    .map(r => [luNum(r[iRank]), luNum(r[iProj])])
    .filter(([rk, v]) => rk != null && v != null)
    .sort((a, b) => a[0] - b[0]);
  if (pairs.length < 3) return false;
  for (let i = 0; i < pairs.length; i++) {
    const v = pairs[i][1];
    if (!Number.isInteger(v) || v < 1 || v > 20) return false;
    if (i && v < pairs[i - 1][1]) return false;
  }
  return true;
}

// CSV → blocks: {QB: [{rank, name, team, opp, tier, total, matchup, pos}], …}.
// Only reads the sheet; resolving names and building byPid is luBuildRanks',
// which the image reader (luImageToBlocks) feeds the same shape.
function luCsvToBlocks(text) {
  const rows = csvRows(text);
  if (rows.length < 2) return null;
  const idx = {};
  rows[0].forEach((h, i) => { const k = String(h || '').trim().toUpperCase(); if (k) idx[k] = i; });

  const blocks = {};
  for (const [block, spec] of Object.entries(LU_RANK_BLOCKS)) {
    const at    = f => idx[((spec.prefix || block) + ' ' + f).toUpperCase()];
    const iName = at(spec.nameCol), iRank = at('Rank');
    if (iName == null || iRank == null) continue;          // block absent
    const get = (r, f) => { const i = at(f); return i == null ? '' : String(r[i] ?? '').trim(); };
    const tierCol = at('Tier') != null ? 'Tier'
                  : at('Projection') != null && luProjIsTier(rows, iRank, at('Projection')) ? 'Projection'
                  : 'Tier';
    const list = [];
    for (let ri = 1; ri < rows.length; ri++) {
      const r    = rows[ri];
      const name = String(r[iName] ?? '').trim();
      const rank = luNum(r[iRank]);
      if (!name || rank == null) continue;                 // padding cell
      list.push({
        rank, name,
        // The DEF block has no team column of its own — its name IS the team.
        team:    block === 'DEF' ? '' : get(r, 'Team'),
        opp:     get(r, 'Opponent'),
        tier:    luNum(get(r, tierCol)),
        total:   luNum(get(r, 'Total')),
        matchup: luNum(get(r, 'Matchup')),
        pos:     LU_FLEX_BLOCKS.has(block) ? get(r, 'Pos') : block,
      });
    }
    if (list.length) blocks[block] = list;
  }
  return Object.keys(blocks).length ? blocks : null;
}

function luParseRanksCsv(text) {
  const blocks = luCsvToBlocks(text);
  return blocks ? luBuildRanks(blocks) : null;
}

// Blocks → {cols, byPid, matched, total, unmatched} — the one place a sheet's
// rows become LU.ranks, whether they came from a CSV or an image.
// `opts.image` (the image path) adds an edit-distance fallback for names a
// vision model misread by a letter or two ("Tetaioa McMillan"), and keeps only
// the first read of a repeated rank (a band can repeat a row at its edge) —
// a CSV keeps its ties.
function luBuildRanks(blocks, opts = {}) {
  const cols = {}, byPid = {}, unmatched = [];
  let matched = 0, total = 0;
  // Names already resolved in a positional block. A FLEX row carries no team
  // column, so the positional block's (team-checked) answer for the same
  // spelling is the best one available — and it carries a misread over too.
  const seen = {};

  for (const block of Object.keys(LU_RANK_BLOCKS)) {
    const src = blocks[block];
    if (!src?.length) continue;
    const isFlex = LU_FLEX_BLOCKS.has(block);
    const list = [];
    const done = new Set();
    for (const raw of src) {
      if (raw.rank == null || !raw.name) continue;
      if (opts.image && done.has(raw.rank)) continue;
      done.add(raw.rank);
      const name = raw.name, team = raw.team || '';
      const pos  = isFlex ? luNormPos(raw.pos) : block;
      const key  = normName(name);
      const pid  = (isFlex && seen[key])
                || luMatchRankRow(name, team)
                || (block !== 'DEF' && !isFlex ? luMatchByLastName(name, team, block) : null)
                || (opts.image ? luFuzzyMatch(name, team, pos, isFlex) : null);
      if (pid && !isFlex) seen[key] = pid;
      total++;
      if (pid) matched++; else unmatched.push(luBlockLabel(block) + ' ' + raw.rank + '. ' + name);

      const row = {
        rank: raw.rank, name, pid,
        team:    team ? normTeamAbbr(team) : '',
        opp:     normTeamAbbr(raw.opp || '') || '',
        tier:    raw.tier ?? null,
        total:   raw.total ?? null,
        matchup: raw.matchup ?? null,
        pos:     isFlex ? String(raw.pos || '').toUpperCase() : block,
      };
      list.push(row);
      if (!pid) continue;

      const e = byPid[pid] || (byPid[pid] = { pos: null, posRank: null, flexRank: null, flexRankTep: null,
                                             tier: null, opp: '', total: null, matchup: null });
      if (block === 'FLEX')          e.flexRank    = row.rank;
      else if (block === 'FLEX_TEP') e.flexRankTep = row.rank;
      else                           { e.pos = block; e.posRank = row.rank; e.tier = row.tier; }
      if (isFlex && !e.pos)    e.pos     = row.pos;
      if (!e.opp && row.opp)   e.opp     = row.opp;
      if (e.total   == null)   e.total   = row.total;
      if (e.matchup == null)   e.matchup = row.matchup;
    }
    list.sort((a, b) => a.rank - b.rank);
    if (list.length) cols[block] = list;
  }
  return Object.keys(cols).length ? { cols, byPid, matched, total, unmatched } : null;
}

// Edit distance where swapping two adjacent letters counts as ONE edit (a
// common misread: "Szymt" for "Szmyt"), giving up (returning max+1) once every
// path exceeds max.
function luEditDist(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let pp = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let lo = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (pp && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1);
      if (cur[j] < lo) lo = cur[j];
    }
    if (lo > max) return max + 1;
    pp = prev; prev = cur;
  }
  return prev[b.length];
}

// Last resort for an image-read name: the closest active player at that
// position (and team, when the row has one) within 1 edit, or 2 for a long
// name. A tie answers nothing — a wrong match is worse than a missing one.
// Surname-only rows (kicker blocks) compare against last names.
function luFuzzyMatch(name, team, pos, flexRow) {
  const key = normName(name);
  if (!key || key.length < 4) return null;
  const t   = team ? normTeamAbbr(team) : null;
  const max = key.length >= 10 ? 2 : 1;
  const surnameOnly = !key.includes(' ');
  const posOk = pos ? (p => p === pos) : flexRow ? (p => p === 'RB' || p === 'WR' || p === 'TE') : () => true;
  let best = null, bestD = max + 1, tie = false;
  for (const [pid, p] of Object.entries(S.players || {})) {
    if (!p.team || !posOk(luNormPos(p.position))) continue;
    if (t && normTeamAbbr(p.team) !== t) continue;
    const d = luEditDist(key, normName(surnameOnly ? (p.last_name || '') : sleeperName(p)), max);
    if (d < bestD)       { best = pid; bestD = d; tie = false; }
    else if (d === bestD) tie = true;
  }
  return best && !tie ? best : null;
}

// ── Ranking sheet from an IMAGE (beta) ───────────────────────────────────────
// A screenshot of the sheet is far too dense to read in one go (~550 rows at
// 5000px wide), so it's cut at its vertical rule lines into column bands
// (~600px each) and every band is read separately by /api/ranks/image (Workers
// AI vision). Each band comes back as {tables:[{header, rows}]}; the header
// names the block, and a band with no header continues the previous band's.

// Header text → block. TEP FLEX must test before FLEX.
const LU_IMG_HEADERS = [
  [/TEP\s*FLEX/i, 'FLEX_TEP'], [/FLEX/i, 'FLEX'],
  [/quarterback|\bQB\b/i, 'QB'], [/running\s*back|\bRB\b/i, 'RB'],
  [/wide\s*receiver|\bWR\b/i, 'WR'], [/tight\s*end|\bTE\b/i, 'TE'],
  [/defen|D\/?ST|\bDEF\b/i, 'DEF'], [/kicker|\bK\b/i, 'K'],
];
const LU_IMG_POS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DST']);

// Cut points: x columns that are dark for nearly the whole sheet height — the
// rules between column groups. Runs of adjacent dark columns collapse to one cut.
function luImageCuts(ctx, w, h) {
  const y0 = Math.floor(h * 0.08), y1 = Math.floor(h * 0.95);
  const data = ctx.getImageData(0, y0, w, y1 - y0).data;
  const rowsN = y1 - y0;
  const dark = new Uint32Array(w);
  for (let y = 0; y < rowsN; y++) {
    let o = y * w * 4;
    for (let x = 0; x < w; x++, o += 4) {
      if (data[o] * 0.299 + data[o + 1] * 0.587 + data[o + 2] * 0.114 < 110) dark[x]++;
    }
  }
  const cuts = [0];
  for (let x = 0; x < w; x++) {
    if (dark[x] < rowsN * 0.85) continue;
    let e = x;
    while (e + 1 < w && dark[e + 1] >= rowsN * 0.85) e++;
    const mid = Math.round((x + e) / 2);
    if (mid - cuts[cuts.length - 1] > 40) cuts.push(mid);
    x = e;
  }
  if (w - cuts[cuts.length - 1] > 40) cuts.push(w); else cuts[cuts.length - 1] = w;
  return cuts;
}

// File → [PNG data URL] per column band. A narrow band from a small screenshot
// is upscaled (to ~600px) so the model has letters it can actually read.
async function luSliceSheetImage(file) {
  const img = await createImageBitmap(file);
  const { width: w, height: h } = img;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0);
  const cuts = luImageCuts(ctx, w, h);
  const bands = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const x = cuts[i] + (i ? 3 : 0), bw = cuts[i + 1] - x - 2;
    if (bw < 40) continue;
    const scale = Math.min(2, Math.max(1, 600 / bw));
    const out = document.createElement('canvas');
    out.width = Math.round(bw * scale); out.height = Math.round(h * scale);
    const oc = out.getContext('2d');
    oc.imageSmoothingQuality = 'high';
    oc.drawImage(cv, x, 0, bw, h, 0, 0, out.width, out.height);
    bands.push(out.toDataURL('image/png'));
  }
  return bands;
}

// One model row → {rank, name, team, opp, tier, pos}. Rows arrive as arrays in
// printed column order (or occasionally as objects), and the two models tested
// disagree on padding — one inserts empty cells, one invents a tier for FLEX —
// so cells are classified by what they ARE, not by where they sit:
// a position code is the pos, a small integer the tier, team codes the team
// then the opponent. FLEX and DEF print no team column, so their only team
// code is the opponent.
function luImageRow(raw, block) {
  if (raw && !Array.isArray(raw) && typeof raw === 'object') {
    raw = [raw.rank, raw.name, raw.team, raw.pos, raw.opp, raw.tier];
  }
  if (!Array.isArray(raw)) return null;
  const cells = raw.map(c => c == null ? '' : String(c).trim()).filter(Boolean);
  const rank  = parseInt(cells.shift(), 10);
  const ni    = cells.findIndex(c => /[a-z]/i.test(c) && !/^[A-Z]{1,3}$/.test(c));
  if (!isFinite(rank) || ni < 0) return null;
  const name = cells.splice(ni, 1)[0].replace(/[‐-―]/g, '-').replace(/\s+/g, ' ');
  let pos = '', tier = null;
  const abbrs = [];
  for (const c of cells) {
    const u = c.toUpperCase();
    if (LU_IMG_POS.has(u) && !pos)           pos = u;
    else if (/^\d{1,2}$/.test(c))            tier = parseInt(c, 10);
    else if (/^[A-Z]{2,3}$/i.test(c))        abbrs.push(u);
  }
  const noTeam = LU_FLEX_BLOCKS.has(block) || block === 'DEF';
  return {
    rank, name,
    team: noTeam ? '' : (abbrs[0] || ''),
    opp:  noTeam ? (abbrs[abbrs.length - 1] || '') : (abbrs[1] || ''),
    tier: LU_FLEX_BLOCKS.has(block) ? null : tier,   // FLEX prints no tier
    total: null, matchup: null,
    pos: LU_FLEX_BLOCKS.has(block) ? pos : block,
  };
}

// Every band's tables, in band order → blocks for luBuildRanks.
function luImageToBlocks(bandTables) {
  const blocks = {};
  let cur = null;
  for (const tables of bandTables) {
    for (const t of tables || []) {
      const hdr = String(t?.header || '');
      const hit = hdr && LU_IMG_HEADERS.find(([re]) => re.test(hdr));
      if (hit) cur = hit[1];
      if (!cur) continue;                              // rows before any header we know
      for (const r of t.rows || []) {
        const row = luImageRow(r, cur);
        if (row) (blocks[cur] || (blocks[cur] = [])).push(row);
      }
    }
  }
  return Object.keys(blocks).length ? blocks : null;
}

// File → parsed ranks (luBuildRanks shape). onProgress(done, total).
async function luReadSheetImage(file, onProgress) {
  const bands = await luSliceSheetImage(file);
  if (!bands.length) throw new Error('Could not find any columns in that image');
  let done = 0;
  onProgress?.(0, bands.length);
  // Groups this upload's band reads in the AI Gateway logs (with part "3/9").
  const sheet = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const readBand = async (image, part, attempt = 0) => {
    const r = await fetch('/api/ranks/image', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, sheet, part, of: bands.length }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j.tables || [];
    if (r.status === 401) throw new Error(j.error || 'Sign in to read a sheet from an image');
    if (attempt < 1) return readBand(image, part, attempt + 1);   // one retry — a bad read is often a one-off
    throw new Error(j.error || 'HTTP ' + r.status);
  };
  const results = await Promise.all(bands.map((b, i) => readBand(b, i + 1).then(t => { onProgress?.(++done, bands.length); return t; })));
  const blocks = luImageToBlocks(results);
  if (!blocks) throw new Error('No ranking tables were read from that image');
  return luBuildRanks(blocks, { image: true });
}

// Fallback for the older paste-a-list format: one player per line, best first,
// with an optional leading rank. It carries no positional information, so every
// player is ranked both at his position and in the flex list — which reproduces
// the single global ordering that format always meant.
function luParseRanksList(text) {
  const byPid = {}, unmatched = [];
  let auto = 0, matched = 0, total = 0;
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)[.):,\s]+(.*)$/);          // optional leading rank
    let rank, name;
    if (m) { rank = parseInt(m[1], 10); name = m[2]; }
    else   { rank = auto + 1; name = line; }
    auto = rank;
    name = name.replace(/\s*\([^)]*\)\s*$/, '').replace(/[,|].*$/, '').trim();  // strip trailing (TEAM POS) / ", TEAM"
    if (!name) continue;
    total++;
    const pid = S._playersByName[normName(name)];
    if (!pid) { unmatched.push(name); continue; }
    matched++;
    byPid[pid] = { pos: luNormPos(S.players[pid]?.position), posRank: rank, flexRank: rank,
                   tier: null, opp: '', total: null, matchup: null };
  }
  return matched ? { cols: {}, byPid, matched, total, unmatched } : null;
}

// Pick a parser from the content: a ranking sheet announces itself with block
// headers ("QB Rank"), anything else is treated as the flat line list.
function luParseRanks(text) {
  const head = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)[0] || '';
  if (/(^|,)\s*"?(QB|RB|WR|TE|FLEX|DEF|K)\s+(Rank|Player)"?\s*(,|$)/i.test(head)) {
    const parsed = luParseRanksCsv(text);
    if (parsed) return parsed;
  }
  return luParseRanksList(text);
}

const LU_RANKS_KEY = 'lu_rankings';

function luSaveRankings() {
  try { localStorage.setItem(LU_RANKS_KEY, JSON.stringify(LU.ranks)); } catch(_) {}
}
function luLoadRankings(week) {
  LU.ranks = null;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(LU_RANKS_KEY) || 'null'); } catch(_) {}
  if (!saved || saved.week !== week) return;
  if (saved.v === 2 && saved.byPid) { LU.ranks = saved; return; }
  // v1 — the flat {pid: overallRank} the paste-a-list upload used to store.
  // Replay it in the new shape so an existing saved list keeps working.
  if (saved.map && Object.keys(saved.map).length) {
    const byPid = {};
    for (const [pid, rank] of Object.entries(saved.map)) {
      byPid[pid] = { pos: luNormPos(S.players[pid]?.position), posRank: rank, flexRank: rank,
                     tier: null, opp: '', total: null, matchup: null };
    }
    LU.ranks = { v: 2, week, byPid, cols: {}, uploadedAt: null, srcName: 'pasted list' };
  }
}

// ESPN fixtures can carry their own projections even when Sleeper's weekly pull
// came back empty, so either source counts as "we have projections".
function luHaveProj() {
  if (LU.proj && Object.keys(LU.proj).length) return true;
  return (LU.lineups || []).some(f => f?._espnProj);
}

// A Sleeper token is needed to WRITE a lineup — nothing else. Previewing an
// optimal lineup, uploading a ranking sheet and the ranks grid are all read-only
// and must stay available without one (the ESPN cards have always proved the
// preview path works tokenless).
function luCanWrite() { return !!(S.token || S.auth?.has_token); }

function luSlotElig(slot) {
  if (SLOT_ELIG[slot]) return SLOT_ELIG[slot];
  const pos = luNormPos(slot);
  return pos ? [pos] : null;   // null → unhandled slot
}

// Optimal lineup in two phases:
//  1) greedy fill EVERY slot with the best eligible player (specific slots, then
//     flex) — a valid, optimal-value assignment that never leaves a fillable slot
//     empty;
//  2) churn reduction — eligibility-preserving, value-neutral swaps that move
//     players back toward their current slot, so cosmetic reshuffles (two FLEX
//     players trading slots) don't show as changes.
// Starters we lack data for stay untouched, as do K/DEF unless a sheet ranks them.
// `src` is 'projections' or 'ranks' and only reaches luSortKey — the two phases
// below are identical either way.
function luBuildOptimalStarters(fix, src) {
  const slots = fix.rosterPositions;       // BN/IR/TAXI already removed, in order
  const pc    = luPtsCtx(fix);

  const excluded = fix.excluded || new Set();
  const startSet = new Set(fix.starters.map(String));
  const pool = (fix.players || []).map(pid => {
    const p = S.players[pid];
    if (!p) return null;
    if (excluded.has(String(pid)) && !startSet.has(String(pid))) return null;  // skip IR/taxi (unless already starting)
    if (luLocked(pid) && !startSet.has(String(pid))) return null;              // game started — can't be started now
    const pos = luNormPos(p.position);
    if (!pos) return null;
    return { pid: String(pid), pos };
  }).filter(Boolean);
  const byId    = {}; pool.forEach(p => { byId[p.pid] = p; });
  const poolIds = new Set(pool.map(p => p.pid));

  const locked = new Array(slots.length).fill(false);
  const used   = new Set();
  slots.forEach((slot, i) => {
    const cur = String(fix.starters[i] || '0');
    if (cur !== '0' && !poolIds.has(cur)) { used.add(cur); locked[i] = true; }   // no data → lock
    // His game has started: he is neither benchable nor movable to another slot,
    // so the slot is frozen exactly as it stands.
    if (cur !== '0' && luLocked(cur)) { used.add(cur); locked[i] = true; return; }
    const elig = luSlotElig(slot);
    if (!elig) { locked[i] = true; return; }                                     // unknown slot → lock
    // K and DEF only ever move on the authority of an uploaded sheet: projections
    // mode leaves them alone, and so does ranks mode when nothing eligible on the
    // roster is actually ranked — no reason to churn a kicker on no information.
    if ((elig[0] === 'K' || elig[0] === 'DEF') &&
        (src !== 'ranks' || !pool.some(p => elig.includes(p.pos) && luRankInfo(p.pid)))) locked[i] = true;
  });

  // Phase 1 — greedy assignment, every slot filled (specific slots first, then flex)
  const assign = fix.starters.map(String);   // locked slots keep their current player
  const pick = (elig, kind) => {
    let best = null, bestKey = null;
    for (const p of pool) {
      if (used.has(p.pid) || !elig.includes(p.pos)) continue;
      const k = luSortKey(p.pid, kind, pc, src);
      if (!bestKey || luCmpKey(k, bestKey) < 0) { best = p; bestKey = k; }
    }
    if (best) { used.add(best.pid); return best.pid; }
    return '0';
  };
  // Dedicated slots resolve first, which is what makes SUPER_FLEX land on your
  // QB2 rather than your QB1 — the QB slot has already claimed him.
  slots.forEach((slot, i) => { if (!locked[i] && !SLOT_ELIG[slot]) assign[i] = pick(luSlotElig(slot), 'dedicated'); });
  slots.forEach((slot, i) => { if (!locked[i] &&  SLOT_ELIG[slot]) assign[i] = pick(SLOT_ELIG[slot], luSlotKind(slot)); });

  // Phase 2 — value-neutral swaps to match the current lineup where eligibility allows
  const cur = fix.starters.map(String);
  for (let guard = 0, improved = true; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 0; i < slots.length; i++) {
      if (locked[i]) continue;
      const ei = luSlotElig(slots[i]); if (!ei) continue;
      for (let j = i + 1; j < slots.length; j++) {
        if (locked[j]) continue;
        const ej = luSlotElig(slots[j]); if (!ej) continue;
        const pi = byId[assign[i]], pj = byId[assign[j]];
        const iIntoJ = assign[i] === '0' || (pi && ej.includes(pi.pos));   // stays eligible after swap
        const jIntoI = assign[j] === '0' || (pj && ei.includes(pj.pos));
        if (!iIntoJ || !jIntoI) continue;
        const before = (assign[i] === cur[i]) + (assign[j] === cur[j]);
        const after  = (assign[j] === cur[i]) + (assign[i] === cur[j]);
        if (after > before) { const t = assign[i]; assign[i] = assign[j]; assign[j] = t; improved = true; }
      }
    }
  }

  // Score-neutral final pass: order interchangeable slots by kickoff.
  if (LU.byGameTime && Object.keys(LU.kick).length) luOrderByGameTime(assign, slots);

  return { proposed: assign };
}

function luPlayerName(pid) {
  const p = S.players[pid];
  return sleeperName(p) || (pid && pid !== '0' ? 'Player ' + pid : 'Empty');
}

// Proposals are cached per source on the fixture, so flipping between the two
// Optimize buttons never recomputes and the summary badge — always projections —
// stays cheap. Cleared whenever the lineup or the sheet changes underneath.
function luProposal(fix, src) {
  if (!fix || !luCanOptimize(src)) return null;
  const ep = luLockEpoch();
  if (fix._propEpoch !== ep) { fix._prop = null; fix._propEpoch = ep; }   // a game kicked off
  if (!fix._prop) fix._prop = {};
  if (!fix._prop[src]) fix._prop[src] = luBuildOptimalStarters(fix, src).proposed;
  return fix._prop[src];
}
function luClearProposals(fix) { if (fix) { fix._prop = null; fix._shown = null; fix._fa = null; } }

// Injury statuses that mean a starter won't play — flagged on the card, and never
// auto-started or offered as an injury-swap replacement. Matched case-insensitively
// via luBadInj() because the same value arrives as "Out" from Sleeper and "OUT"
// from other paths; "Questionable"/"Doubtful" deliberately stay startable.
const LU_BAD_INJ = { OUT: 1, IR: 1, SUS: 1, NA: 1, PUP: 1, DNR: 1, COV: 1, DNP: 1, O: 1 };
function luBadInj(status) { return !!LU_BAD_INJ[String(status || '').toUpperCase()]; }

// Questionable/Doubtful starters. Deliberately NOT part of luLineupStatus — these
// players are still startable and there may well be nothing to do about them, so
// they must never push a card to "Action needed". This is purely a heads-up chip:
// "you have a game-time decision in here". Players whose game has already kicked
// off are dropped — the decision is behind you at that point.
const LU_DOUBT_INJ = { Q: 1, QUESTIONABLE: 1, D: 1, DOUBTFUL: 1 };
function luDoubtInj(status) { return !!LU_DOUBT_INJ[String(status || '').toUpperCase()]; }
function luQuestionableStarters(fix) {
  return fix.starters.filter(p => p && p !== '0' && luDoubtInj(S.players[p]?.injury_status) && !luLocked(p))
                     .map(p => ({ pid: p, name: luPlayerName(p), tag: String(S.players[p]?.injury_status || '').toUpperCase().startsWith('D') ? 'D' : 'Q' }));
}

// Per-league lineup health, used for the collapsed summary badge.
function luLineupStatus(fix) {
  const pc   = luPtsCtx(fix);
  const have = luHaveProj();
  const prop = luProposal(fix, 'projections') || fix.starters;
  const cur  = have ? fix.starters.reduce((s, p) => s + luPlayerPts(p, pc), 0) : null;
  const opt  = have ? prop.reduce((s, p) => s + luPlayerPts(p, pc), 0) : null;
  const gain = have ? opt - cur : 0;

  const empty   = fix.starters.filter(p => !p || p === '0').length;
  // An Out player whose game has already kicked off is a sunk zero — there is
  // nothing left to do about him, so he must not keep the card screaming
  // "Action needed" for the rest of the week.
  const injured = fix.starters.filter(p => luBadInj(S.players[p]?.injury_status) && !luLocked(p))
                              .map(p => luPlayerName(p));

  const curSet  = new Set(fix.starters.map(String));
  const propSet = new Set(prop.map(String));
  const sameSet = curSet.size === propSet.size && [...curSet].every(p => propSet.has(p));
  const arrDiff = prop.some((p, i) => String(p) !== String(fix.starters[i]));

  let level = 'na', label = '—', detail = '';
  if (empty)               { level = 'bad';  label = 'Action needed'; detail = empty + ' empty slot' + (empty > 1 ? 's' : ''); }
  else if (injured.length) { level = 'bad';  label = 'Action needed'; detail = 'Out: ' + injured.join(', '); }
  else if (!sameSet)       { level = 'warn'; label = 'Suboptimal';    detail = gain > 0.05 ? '+' + gain.toFixed(1) + ' pts available' : 'better players available'; }
  else if (arrDiff)        { level = 'warn'; label = 'Reorder';       detail = 'kickoff order'; }
  else if (luCanOptimize('projections')) { level = 'ok'; label = 'Optimal'; }
  return { level, label, detail, cur, opt, gain };
}

// ── Free-agent watch (redraft only) ──────────────────────────────────────────
// "Is anyone sitting on the wire projected to outscore what I'd be starting?"
//
// Three things make this honest rather than noisy:
//  · The baseline is the OPTIMAL lineup, not the current one. Comparing against
//    whoever happens to be in the slot would flag a free agent every time your own
//    bench already held the better player — that's an Optimize, not an add.
//  · Each free agent is paired with the WEAKEST slot he's eligible for, then the
//    pairs are taken greedily by gain with each slot and each player claimed once,
//    so five waiver-wire WRs beating the same bad starter collapse to one row.
//  · Locked slots and locked free agents are both out — a player whose game has
//    kicked off can neither be added nor benched.
// Dynasty leagues are skipped by design: a wire that deep is a different question.
const LU_FA_MIN_GAIN = 1.0;   // points of projection a pickup must clear to be worth a row
const LU_FA_MAX_ROWS = 4;

function luFaUpgrades(fix) {
  if (!LU.faOn || !fix || !fix._redraft || !fix.rostered || !luHaveProj()) return [];
  const ep = luLockEpoch();
  if (fix._fa && fix._faEpoch === ep) return fix._fa;

  const pc   = luPtsCtx(fix);
  const mine = new Set((fix.players || []).map(String));
  // On an ESPN league the projection map IS the candidate universe (roster + the
  // free agents we pulled); on Sleeper it's every player with a weekly projection.
  const universe = fix._espnProj ? Object.keys(fix._espnProj) : Object.keys(LU.proj);

  const fas = [];
  for (const raw of universe) {
    const pid = String(raw);
    if (mine.has(pid) || fix.rostered.has(pid)) continue;
    const p = S.players[pid];
    if (!p || luBadInj(p.injury_status) || luLocked(pid)) continue;
    const pos = luNormPos(p.position);
    if (!pos) continue;
    const pts = luPlayerPts(pid, pc);
    if (!(pts > 0)) continue;
    fas.push({ pid, pos, pts });
  }
  if (!fas.length) { fix._fa = []; fix._faEpoch = ep; return fix._fa; }

  const base = (luCanOptimize('projections') && luProposal(fix, 'projections')) || fix.starters;
  const pairs = [];
  fix.rosterPositions.forEach((slot, i) => {
    const cur = String(base[i] || '0');
    if (luLocked(cur)) return;                       // slot can't change any more
    const elig = luSlotElig(slot); if (!elig) return;
    const curPts = cur === '0' ? 0 : luPlayerPts(cur, pc);
    for (const f of fas) {
      if (!elig.includes(f.pos)) continue;
      const gain = f.pts - curPts;
      if (gain >= LU_FA_MIN_GAIN) pairs.push({ slotIdx: i, slot, cur, curPts, pid: f.pid, pos: f.pos, pts: f.pts, gain });
    }
  });
  pairs.sort((a, b) => b.gain - a.gain);

  const usedSlot = new Set(), usedPid = new Set(), out = [];
  for (const c of pairs) {
    if (usedSlot.has(c.slotIdx) || usedPid.has(c.pid)) continue;
    usedSlot.add(c.slotIdx); usedPid.add(c.pid); out.push(c);
    if (out.length >= LU_FA_MAX_ROWS) break;
  }
  fix._fa = out; fix._faEpoch = ep;
  return out;
}

// The FA rows under a card. Deliberately advisory — there is no "add" button,
// because a pickup is a waiver claim in Sleeper's app, not a lineup write.
function luFaHtml(fix) {
  const ups = luFaUpgrades(fix);
  if (!ups.length) return '';
  return `<div style="padding:6px 16px 8px;border-top:1px dashed var(--brown-mid);">
    <div style="font-family:'Rye',serif;font-size:0.52rem;letter-spacing:0.1em;text-transform:uppercase;color:#d08a30;margin-bottom:4px;">◎ On the wire — projected to beat your best lineup</div>
    ${ups.map(u => {
      const p = S.players[u.pid] || {};
      return `<div class="diff-row">
        <span class="diff-slot">${esc(u.slot)}</span>
        <span style="color:var(--parchment);flex:1;">
          <span style="color:#d08a30;">${esc(luPlayerName(u.pid))}</span>
          <span style="color:var(--brown-light);font-size:0.75rem;"> ${esc(u.pos)}${p.team ? ' · ' + esc(p.team) : ''} · FA</span>
          <span style="color:var(--brown-light);"> over </span>${esc(luPlayerName(u.cur))}
        </span>
        <span style="color:var(--brown-light);font-size:0.8rem;white-space:nowrap;flex-shrink:0;">${u.curPts.toFixed(1)} <span style="color:#d08a30;">&rarr; ${u.pts.toFixed(1)}</span> (+${u.gain.toFixed(1)})</span>
      </div>`;
    }).join('')}
  </div>`;
}

function luToggleFa() {
  LU.faOn = !LU.faOn;
  try { localStorage.setItem('lu_fa_watch', LU.faOn ? '1' : '0'); } catch(_) {}
  LU.lineups.forEach(f => { f._fa = null; });
  luRenderLineupCards();
}

const LU_LEVEL_COLOR = { bad: '#c0504d', warn: '#d08a30', ok: '#5fae5f', na: 'var(--brown-light)' };

// Right-hand side of the card summary: reason + points + status badge.
function luSummaryMeta(fix, idx) {
  const st    = luLineupStatus(fix);
  const color = LU_LEVEL_COLOR[st.level];
  const pts = st.cur == null ? ''
    : st.gain > 0.05
      ? `<span style="font-size:0.95rem;color:var(--brown-light);white-space:nowrap;">${st.cur.toFixed(1)} <span style="color:#5fae5f;">→ ${st.opt.toFixed(1)}</span></span>`
      : `<span style="font-size:0.95rem;color:var(--brown-light);white-space:nowrap;">${st.cur.toFixed(1)} pts</span>`;
  const reason = st.detail
    ? `<span style="font-size:0.85rem;color:${color};">${esc(st.detail)}</span>` : '';
  const icon  = st.level === 'bad' ? '⚠ ' : st.level === 'ok' ? '✓ ' : '';
  const badge = `<span style="font-family:'Rye',serif;font-size:0.52rem;letter-spacing:0.1em;text-transform:uppercase;color:${color};border:1px solid ${color};border-radius:2px;padding:2px 6px;white-space:nowrap;">${icon}${esc(st.label)}</span>`;
  // Its own chip rather than folded into the status badge: a free-agent upgrade is
  // a different kind of problem from a bad lineup, and a team can easily have one
  // while already being Optimal.
  const qd  = luQuestionableStarters(fix);
  const doubt = qd.length
    ? `<span title="Game-time decisions: ${esc(qd.map(q => q.name + ' (' + q.tag + ')').join(', '))}" style="font-family:'Rye',serif;font-size:0.52rem;letter-spacing:0.1em;text-transform:uppercase;color:var(--gold);border:1px dotted var(--gold);border-radius:2px;padding:2px 6px;white-space:nowrap;">? ${qd.length} Q/D</span>`
    : '';
  const ups = luFaUpgrades(fix);
  const fa  = ups.length
    ? `<span title="Free agents projected to beat your best lineup" style="font-family:'Rye',serif;font-size:0.52rem;letter-spacing:0.1em;text-transform:uppercase;color:#d08a30;border:1px dashed #d08a30;border-radius:2px;padding:2px 6px;white-space:nowrap;">◎ ${ups.length} FA +${ups[0].gain.toFixed(1)}</span>`
    : '';
  return `<span id="lc-meta-${idx}" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">${reason}${pts}${doubt}${fa}${badge}</span>`;
}

// Render the slot rows for a card. mode 'current' shows live starters with proj
// points; mode 'diff' shows each change inline (strikethrough → replacement).
function luBodyRows(fix, mode) {
  const idx  = LU.lineups.indexOf(fix);
  const pc   = luPtsCtx(fix);
  const prop = (fix._shown && luProposal(fix, fix._shown)) || fix.starters;
  const have = luHaveProj();
  const ptsCell = pid => `<span class="diff-pts">${have ? luPlayerPts(pid, pc).toFixed(1) : '–'}</span>`;

  // Season-to-date PPG, scored to THIS league's settings — fix.scoringSettings is
  // the league's real scoring for both sources (ESPN's parsed via
  // crParseEspnScoring), so no branching is needed here any more than in
  // luPlayerPts. Carries its own "ppg" suffix because the lineup rows have no
  // header row, and two bare numbers side by side would be ambiguous. Empty for
  // anyone who hasn't played, so a bye week or a rookie yet to debut leaves the
  // gap rather than claiming 0.0.
  const ppgCell = pid => {
    const v = playerSeasonPpg(pid, pc.scoring);
    if (v === null) return '';
    const gp = playerSeasonGp(pid);
    return `<span class="diff-ppg" title="Season PPG in this league's scoring — ${v.toFixed(1)} over ${gp} game${gp === 1 ? '' : 's'} played">${v.toFixed(1)}<em>ppg</em></span>`;
  };

  // Sheet ranks, between the name and the projection. Rendered only when a sheet
  // is loaded — with no sheet every row would carry two empty columns.
  // Flex rank is genuinely absent for QB/K/DEF (the sheet's FLEX block doesn't
  // list them), so a blank there is correct rather than missing data.
  const haveRanks = luHaveRankings();
  const rankCells = pid => {
    if (!haveRanks) return '';
    const ri  = luRankInfo(pid, pc);
    const pos = luNormPos(S.players[pid]?.position) || '';
    const pr  = ri?.posRank  ? pos + ri.posRank : '–';
    const fr  = ri?.flexRank ? 'F' + ri.flexRank : '';
    return `<span class="diff-rank${ri?.posRank ? '' : ' diff-none'}" title="Position rank on the sheet">${esc(pr)}</span>`
         + `<span class="diff-rank diff-flex" title="${luUseTep(pc) ? 'TEP flex rank on the sheet (this league scores TE premium)' : 'Flex rank on the sheet'}">${esc(fr)}</span>`;
  };

  return fix.rosterPositions.map((slot, i) => {
    const cur = String(fix.starters[i] || '0');
    const pr  = String(prop[i] || '0');
    if (mode === 'diff' && cur !== pr) {
      return `<div class="diff-row" style="background:rgba(95,174,95,0.07);">
        <span class="diff-slot">${esc(slot)}</span>
        <span style="color:var(--parchment);flex:1;">
          <span style="color:#c0504d;text-decoration:line-through;">${esc(luPlayerName(cur))}</span>
          <span style="color:var(--brown-light);"> → </span>
          <span style="color:#5fae5f;">${esc(luPlayerName(pr))}</span>
        </span>
        <span style="color:var(--brown-light);font-size:0.8rem;white-space:nowrap;flex-shrink:0;">${have ? luPlayerPts(cur, pc).toFixed(1) : '–'} <span style="color:#5fae5f;">→ ${have ? luPlayerPts(pr, pc).toFixed(1) : '–'}</span></span>
      </div>`;
    }
    const pid  = mode === 'diff' ? pr : cur;
    const inj  = injuryBadge(S.players[pid]?.injury_status);
    const lock = luLocked(pid);
    // Every current-mode row opens its own replacement list. Not offered on a
    // diff row: those rows are showing a proposal, and the slot indices there
    // describe what WOULD be set, not what is.
    const click = mode !== 'diff' && idx >= 0;
    const open  = click && luSlotOpen(fix, i);
    return `<div class="diff-row${click ? ' diff-click' : ''}${open ? ' slot-open' : ''}"${lock ? ' style="opacity:0.62;"' : ''}${click ? ` onclick="luToggleSlot(${idx},${i})"` : ''}>
      <span class="diff-slot">${esc(slot)}</span>
      <span style="color:var(--parchment);flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${lock ? '<span title="Game has started — this slot is locked" style="color:var(--brown-light);">🔒 </span>' : ''}${esc(luPlayerName(pid))}${inj ? ' ' + inj : ''}</span>
      ${rankCells(pid)}
      <span style="flex:1;"></span>
      ${ppgCell(pid)}
      ${ptsCell(pid)}
      ${click ? `<span class="diff-caret" title="Show every player who could take this slot">${open ? '▾' : '▸'}</span>` : ''}
    </div>${open ? luSlotOptionsHtml(fix, idx, i) : ''}`;
  }).join('');
}

// ── Slot options: every replacement for one slot, inline on the card ─────────
// The Injury Swap answers "this player is out — fix him in all 70 leagues". This
// answers the other half of the same question: "in THIS league, what else could
// play this slot, and how do those options actually compare?" Same candidate
// generator (lswCandidates — promotions included), same numbers as the row above
// it, so the two views can never disagree about what is eligible.
function luSlotOpen(fix, slotIdx) {
  return !!LU.openSlot && LU.openSlot.leagueId === fix.leagueId && LU.openSlot.slotIdx === slotIdx;
}

function luToggleSlot(idx, slotIdx) {
  const fix = LU.lineups[idx];
  if (!fix) return;
  LU.openSlot = luSlotOpen(fix, slotIdx) ? null : { leagueId: fix.leagueId, slotIdx };
  // Only this card's body is redrawn, so an open <details> elsewhere — and the
  // injury-swap search box above the cards — is left exactly as it was.
  const body = document.getElementById('lc-body-' + idx);
  if (body) body.innerHTML = luBodyRows(fix, fix._shown ? 'diff' : 'current');
}

function luSlotOptionsHtml(fix, idx, slotIdx) {
  const pc    = luPtsCtx(fix);
  const slot  = fix.rosterPositions[slotIdx];
  const cur   = String(fix.starters[slotIdx] || '0');
  const cands = lswCandidates(fix, slotIdx);
  // Clicks inside the panel must not bubble to the row, which would close it.
  const wrap  = h => `<div class="lc-opts" onclick="event.stopPropagation()">${h}</div>`;

  if (!cands.length) {
    return wrap(`<div class="lc-opts-empty">${luLocked(cur)
      ? '🔒 His game has already started — this slot is locked and can no longer be changed.'
      : `Nobody on the bench is eligible for a ${esc(slot)} slot.`}</div>`);
  }

  const haveProj = luHaveProj();
  const canSwap  = luCanWrite() && !fix._espn;
  const num = v => v === null ? '–' : v.toFixed(1);
  const ppgOf = pid => {
    const v = playerSeasonPpg(pid, pc.scoring);
    return { v, gp: v === null ? 0 : playerSeasonGp(pid) };
  };

  // One row shape for the incumbent and the candidates alike, so the columns line
  // up and the comparison is the only thing the eye has to do.
  const row = (pid, opts) => {
    const p    = S.players[pid] || {};
    const pg   = ppgOf(pid);
    const pts  = luPlayerPts(pid, pc);
    const inj  = injuryBadge(p.injury_status);
    const lbl  = lswRankLabel(pid, opts.landSlot || slot, !!opts.mixed, pc);
    return `<div class="lc-opt${opts.cls || ''}">
      <span class="lc-opt-name">${opts.tag || ''}${esc(luPlayerName(pid))}${inj ? ' ' + inj : ''}${opts.via || ''}</span>
      <span class="lc-opt-pos">${esc(luNormPos(p.position) || '')}${p.team ? ' ' + esc(p.team) : ''}</span>
      <span class="lc-opt-rank" style="${lbl ? '' : 'color:var(--brown-mid);'}">${lbl ? esc(lbl) : '—'}</span>
      <span class="lc-opt-num" style="color:var(--parchment);"${pg.v === null ? '' : ` title="${pg.v.toFixed(1)} over ${pg.gp} game${pg.gp === 1 ? '' : 's'} played"`}>${num(pg.v)}</span>
      <span class="lc-opt-num" style="color:var(--gold-light);">${haveProj ? pts.toFixed(1) : '–'}</span>
      <span class="lc-opt-act">${opts.action || ''}</span>
    </div>`;
  };

  const head = `<div class="lc-opt hdr">
      <span class="lc-opt-name">${esc(slot)} — options</span>
      <span class="lc-opt-pos">Pos</span>
      <span class="lc-opt-rank">Rank</span>
      <span class="lc-opt-num" title="Season-to-date PPG in this league's scoring">PPG</span>
      <span class="lc-opt-num">Proj</span>
      <span class="lc-opt-act"></span>
    </div>`;

  const curRow = cur === '0' ? '' : row(cur, { cls: ' cur', tag: '<span style="color:#5fae5f;">▸ </span>' });

  const list = cands.map(c => {
    const landSlot = fix.rosterPositions[c.moves[c.moves.length - 1][0]];
    // A promotion moves two slots, so say which — otherwise an RB appearing as a
    // replacement for a TE reads as a bug rather than as the flex shuffle it is.
    const via = c.via
      ? `<span style="display:block;font-size:0.6rem;color:var(--gold-light);">↳ ${esc(luPlayerName(c.via.pid))} moves ${esc(c.via.slot)} → ${esc(slot)}</span>`
      : '';
    const action = canSwap
      ? `<button class="ghost-btn" style="font-size:0.5rem;padding:2px 6px;" title="Start him in this slot" onclick="luSlotSwap(${idx},${slotIdx},'${c.pid}')">⇄ Start</button>`
      : '';
    return row(c.pid, { via, action, landSlot, mixed: c.mixed });
  }).join('');

  // Why the numbers may not run in order, said once: the list is ordered by the
  // sheet, and PPG is what he HAS done — they are allowed to disagree.
  const note = `<div class="lc-opts-note">
      <span>${cands.length} option${cands.length === 1 ? '' : 's'} · ordered by the ranking sheet${luHaveRankings() ? '' : ' (none loaded — ordered by projection)'}</span>
      ${fix._espn ? '<span>read-only — set it in ESPN</span>'
        : luCanWrite() ? '' : '<span>preview only — <a href="/myprofile" style="color:var(--gold-light);">add a Sleeper token</a> to start one</span>'}
      ${cur === '0' ? '' : `<span style="margin-left:auto;"><a href="#lu-swap-q" style="color:var(--gold-light);" onclick="event.preventDefault();luSwapEverywhere('${cur}')">Replace him in every league →</a></span>`}
    </div>`;

  return wrap(`${head}${curRow}<div class="lc-opts-list">${list}</div>${note}
    <div id="lc-opts-msg-${idx}" style="padding:0 16px 6px;font-size:0.62rem;"></div>`);
}

// Hand this player to the cross-league Injury Swap panel above the cards. The
// panel is rendered there and nowhere near the row that was clicked, so the
// scroll is part of the action — without it the click looks like it did nothing.
function luSwapEverywhere(pid) {
  lswPick(pid);
  document.getElementById('lu-swap-q')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Start one candidate in one slot. The same one-league write the injury-swap
// panel does (lswPlanFor → luPutStarters), minus the cross-league bookkeeping:
// the plan is rebuilt against the LIVE lineup here too, so an Optimize applied
// since the panel opened can't leave a stale slot index behind.
async function luSlotSwap(idx, slotIdx, pid) {
  const fix = LU.lineups[idx];
  if (!fix || fix._espn || !luCanWrite()) return false;
  const msg = document.getElementById('lc-opts-msg-' + idx);
  const say = (c, t) => { if (msg) msg.innerHTML = `<span style="color:${c};">${t}</span>`; };
  const plan = lswPlanFor(fix, slotIdx, pid);
  if (!plan) { say('#c0504d', '✗ ' + esc(luPlayerName(pid)) + ' is no longer an option for this slot'); return false; }
  say('var(--brown-light)', 'applying…');
  const next = fix.starters.map(String);
  plan.moves.forEach(([k, p]) => { next[k] = String(p); });
  try {
    const ok = await luPutStarters(fix, next);
    LU.openSlot = null;                       // the slot he was in is now his
    const body = document.getElementById('lc-body-' + idx);
    if (body) body.innerHTML = luBodyRows(fix, 'current');
    const meta = document.getElementById('lc-meta-' + idx);
    if (meta) meta.outerHTML = luSummaryMeta(fix, idx);
    const box = document.getElementById('lc-opt-' + idx);
    if (box) box.innerHTML = `<div style="padding:6px 16px;font-size:0.65rem;color:${ok ? '#5fae5f' : '#d08a30'};">${ok
      ? '✓ ' + esc(luPlayerName(pid)) + ' is now starting at ' + esc(fix.rosterPositions[slotIdx])
      : '⚠ saved but Sleeper returned a different lineup'}</div>`;
    return ok;
  } catch (e) {
    say('#c0504d', '✗ ' + esc(e.message || 'failed'));
    return false;
  }
}

// Show an optimal lineup as an in-place diff inside the card, plus Apply/Cancel.
// `src` is the button you pressed — 'projections' or 'ranks'. The rows and the
// points column are identical either way; only the proposal differs.
function optimizeLineup(idx, src) {
  src = src === 'ranks' ? 'ranks' : 'projections';
  const fix  = LU.lineups[idx];
  const body = document.getElementById('lc-body-' + idx);
  const box  = document.getElementById('lc-opt-' + idx);
  if (!fix || !body || !box) return;
  if (!luCanOptimize(src)) {
    box.innerHTML = `<div style="padding:6px 16px;font-size:0.65rem;color:#c0504d;">${src === 'ranks'
      ? 'No ranking sheet uploaded for week ' + LU.week + '.'
      : 'No projections for week ' + LU.week + ' yet.'}</div>`;
    return;
  }

  fix._shown = src;
  const prop    = luProposal(fix, src);
  const pc      = luPtsCtx(fix);
  const cur     = fix.starters.reduce((t, p) => t + luPlayerPts(p, pc), 0);
  const opt     = prop.reduce((t, p) => t + luPlayerPts(p, pc), 0);
  const changed = prop.some((p, i) => String(p) !== String(fix.starters[i]));
  const label   = src === 'ranks' ? 'ranking sheet' : 'projections';

  body.innerHTML = luBodyRows(fix, 'diff');
  if (!changed) {
    box.innerHTML = `<div style="padding:6px 16px;font-size:0.7rem;color:#5fae5f;">✓ Already optimal by ${label} — ${cur.toFixed(1)} proj pts</div>`;
    return;
  }
  // The points delta is always measured in Sleeper projections, so in ranks mode
  // it is informational and may be negative — that just means the sheet and the
  // projections disagree, which is the whole reason to compare the two.
  const d  = opt - cur;
  const dc = d >= 0.05 ? '#5fae5f' : d <= -0.05 ? '#d08a30' : 'var(--brown-light)';
  box.innerHTML = `<div style="padding:6px 16px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-top:1px solid var(--brown-mid);">
    <span style="font-size:0.72rem;color:var(--gold-light);">by ${label} · ${cur.toFixed(1)} → <span style="color:${dc};">${opt.toFixed(1)}</span> proj pts (<span style="color:${dc};">${d >= 0 ? '+' : ''}${d.toFixed(1)}</span>)</span>
    ${fix._espn ? '<span style="font-size:0.65rem;color:var(--brown-light);">set it in ESPN</span>'
                : luCanWrite() ? `<button class="setup-btn" onclick="applyLineup(${idx})">Apply this lineup</button>`
                : '<span style="font-size:0.65rem;color:var(--brown-light);">preview only — add a Sleeper token to apply</span>'}
    <button class="ghost-btn" style="font-size:0.5rem;" onclick="revertLineupView(${idx})">Cancel</button>
  </div>`;
}

function revertLineupView(idx) {
  const fix  = LU.lineups[idx];
  const body = document.getElementById('lc-body-' + idx);
  const box  = document.getElementById('lc-opt-' + idx);
  if (fix) fix._shown = null;
  if (body) body.innerHTML = luBodyRows(fix, 'current');
  if (box)  box.innerHTML  = '';
}

// Write one starters array to Sleeper and fold the result back into the fixture.
// Returns true when Sleeper echoed the exact lineup we sent. Shared by the card's
// Apply button and by the injury-swap panel, which builds its own starters array.
async function luPutStarters(fix, prop) {
  const res    = await setLineup(fix.leagueId, fix.rosterId, LU.week, prop);
  const echoed = (res?.starters || []).map(String);
  const ok     = echoed.length === prop.length && echoed.every((p, i) => p === String(prop[i]));
  fix.starters = echoed.length ? echoed : prop.map(String);   // reflect live lineup
  luClearProposals(fix);                                      // stale against the new starters
  return ok;
}

// Write the previewed lineup to Sleeper. Returns true on confirmed success.
async function applyLineup(idx) {
  const fix = LU.lineups[idx];
  if (!fix || fix._espn) return false;   // ESPN lineups are read-only here
  const src  = fix._shown || 'projections';
  const prop = luProposal(fix, src);
  if (!prop) return false;
  const box   = document.getElementById('lc-opt-' + idx);
  const setMsg = (c, t) => { if (box) box.innerHTML = `<div style="padding:6px 16px;font-size:0.65rem;color:${c};">${t}</div>`; };
  setMsg('var(--brown-light)', 'applying…');
  try {
    const ok = await luPutStarters(fix, prop);
    const body = document.getElementById('lc-body-' + idx); if (body) body.innerHTML = luBodyRows(fix, 'current');
    const meta = document.getElementById('lc-meta-' + idx); if (meta) meta.outerHTML = luSummaryMeta(fix, idx);
    setMsg(ok ? '#5fae5f' : '#d08a30', ok ? '✓ lineup set' : '⚠ saved but Sleeper returned a different lineup');
    return ok;
  } catch (e) {
    setMsg('#c0504d', '✗ ' + (e.message || 'failed'));
    return false;
  }
}

// The two "all" buttons stay on projections deliberately — a bulk write across
// every league is not the place to act on a sheet you just pasted in. Use the
// per-card ⚡ Optimize with Ranks to review those one at a time.
function optimizeAll() {
  LU.lineups.forEach((_, idx) => {
    const d = document.getElementById('lc-' + idx); if (d) d.open = true;
    optimizeLineup(idx, 'projections');
  });
}

async function applyAll() {
  const status = document.getElementById('lu-allstatus');
  const setS = (c, t) => { if (status) { status.style.color = c; status.textContent = t; } };
  const targets = LU.lineups.map((fix, idx) => ({ fix, idx })).filter(({ fix }) => {
    if (fix._espn) return false;         // not writable — see luLoadEspnLineup
    const prop = luProposal(fix, 'projections');
    return prop && prop.some((p, i) => String(p) !== String(fix.starters[i]));
  });
  if (!targets.length) { setS('#5fae5f', 'All lineups already optimal'); return; }
  let done = 0, fail = 0;
  for (const { fix, idx } of targets) {
    fix._shown = 'projections';
    setS('var(--brown-light)', `Applying ${done + fail + 1}/${targets.length}…`);
    const ok = await applyLineup(idx);
    if (ok) done++; else fail++;
  }
  setS(fail ? '#d08a30' : '#5fae5f', `Applied ${done} lineup${done !== 1 ? 's' : ''}${fail ? `, ${fail} failed` : ''}`);
}

function toggleCollapseAll() {
  const cards = [...document.querySelectorAll('.lineup-card')];
  const anyOpen = cards.some(c => c.open);
  cards.forEach(c => { c.open = !anyOpen; });
  const btn = document.getElementById('lu-collapse-btn');
  if (btn) btn.textContent = anyOpen ? 'Expand all' : 'Collapse all';
}

// ── Injury Swap ──────────────────────────────────────────────────────────────
// The last-minute-injury workflow: one player just got ruled out, and he is in
// the lineup in some unknown subset of your ~70 leagues. Search him once, see
// exactly which leagues are affected, and bench him everywhere in one pass.
//
// Three ways to pick the replacement, all landing in the same LSW.picks map so
// the row rendering and the Apply path don't care which you used:
//   'ranks'  — best eligible bench player by the uploaded sheet, in every league
//   'proj'   — best eligible bench player by Sleeper projections, in every league
//   'manual' — every league lists its eligible bench players in rank order with
//              projections visible, and you click the one you want
//
// A replacement is only ever slotted into the exact slot the injured player
// occupied, so eligibility is that slot's own eligibility (a dedicated RB slot
// can't take a WR). This is deliberately NOT a re-optimization — you asked to
// replace one player, so one player moves and nothing else in the lineup shifts.
const LSW = {
  q: '',            // current search text
  pid: null,        // the player being replaced, once chosen
  mode: null,       // null | 'ranks' | 'proj' | 'manual'
  targets: [],      // [{leagueId, idx, slotIdx, slot}] — snapshotted at pick time
  picks: {},        // {leagueId: replacementPid}
  done: {},         // {leagueId: 'ok' | 'fail'} — applied this session
  applied: {},      // {leagueId: [{slot, from, to}]} — what was actually sent, captured
                    // pre-write because the write overwrites fix.starters
  msg: '',          // status line under the mode buttons
  msgColor: 'var(--brown-light)',
};

// pid → [{idx, slotIdx}] for every player currently in a starting lineup.
// Built fresh on each draw: applying a swap rewrites fix.starters underneath it.
function lswStarterMap() {
  const m = {};
  LU.lineups.forEach((fix, idx) => {
    (fix.starters || []).forEach((p, slotIdx) => {
      const pid = String(p || '0');
      if (pid === '0') return;
      (m[pid] || (m[pid] = [])).push({ idx, slotIdx });
    });
  });
  return m;
}

// The leagues to work on, snapshotted once when the player is chosen. It has to be
// a snapshot rather than a live lookup: every successful write removes him from
// that league's starters, so a live list would shrink as we go — dropping rows
// mid-apply and never showing the "✓ applied" they earned.
function lswSnapshotTargets(pid) {
  return (lswStarterMap()[String(pid)] || []).map(({ idx, slotIdx }) => ({
    leagueId: LU.lineups[idx].leagueId, idx, slotIdx,
    slot: LU.lineups[idx].rosterPositions[slotIdx],
  }));
}

// Re-attach each snapshotted target to its live fixture. A Refresh rebuilds
// LU.lineups and can reorder it, so the stored index is only trusted when the
// league still matches; otherwise it's looked up by league id, and dropped if the
// league is gone entirely.
function lswTargets() {
  return LSW.targets.map(t => {
    let fix = LU.lineups[t.idx];
    if (!fix || fix.leagueId !== t.leagueId) {
      const i = LU.lineups.findIndex(f => f.leagueId === t.leagueId);
      if (i < 0) return null;
      t.idx = i; fix = LU.lineups[i];
    }
    return { ...t, fix };
  }).filter(Boolean);
}

// Bench players who could legally take over that slot. Anyone the injury column
// says won't play is dropped outright — swapping one Out player for another is
// never the answer — as are IR/taxi players, which luBuildOptimalStarters skips
// for the same reason.
// Bench players who could take over that slot — directly, or by promoting someone.
//
// The direct path alone is too narrow: a TE slot would only ever offer bench TEs.
// But if another TE is sitting in a FLEX slot he can slide up into the vacated TE
// slot, and the FLEX he leaves behind opens to any flex-eligible bench player. So
// replacing Bowers can legitimately hand you an RB — Kincaid moves FLEX→TE, the RB
// lands in the FLEX Kincaid left. That two-step is generated here as a `moves` plan
// rather than being reconstructed at apply time.
//
// Only one hop is generated, which is all the roster shapes need: the promoted
// player must himself be eligible for the vacated slot, and the only slot type more
// permissive than a dedicated one is a flex, so a second hop can never widen the
// pool further.
//
// Returns [{pid, pts, rankKey, ranked, via, moves}] where `moves` is the full list
// of [slotIndex, playerId] placements to write, and `via` names the promoted
// starter (null for a direct swap).
function lswCandidates(fix, slotIdx) {
  const slots = fix.rosterPositions;
  const elig  = luSlotElig(slots[slotIdx]);
  if (!elig) return [];
  // Once his game has kicked off the slot is frozen — there is no swap to offer.
  if (luLocked(String(fix.starters[slotIdx] || '0'))) return [];
  const starting = new Set((fix.starters || []).map(String));
  const excluded = fix.excluded || new Set();
  const pc   = luPtsCtx(fix);
  const kind = luSlotKind(slots[slotIdx]);

  const benchFor = eligList => (fix.players || []).map(String).filter(pid => {
    if (starting.has(pid) || excluded.has(pid)) return false;
    const p = S.players[pid];
    if (!p || luBadInj(p.injury_status)) return false;
    if (luLocked(pid)) return false;              // his game has started — can't be started now
    return eligList.includes(luNormPos(p.position));
  });

  // pid → best plan found for him. Direct always wins over a hop (one slot moves
  // instead of two); between two hops, prefer the one that promotes the better
  // player into the vacated slot, since that half of the swap is a real upgrade too.
  const best = {};
  const offer = (pid, via, moves, promoteKey) => {
    const prev = best[pid];
    if (prev) {
      if (!prev.via) return;                                   // direct already found
      if (via && luCmpKey(promoteKey, prev.promoteKey) >= 0) return;
    }
    best[pid] = { pid, via, moves, promoteKey };
  };

  benchFor(elig).forEach(pid => offer(pid, null, [[slotIdx, pid]], null));

  slots.forEach((slot, j) => {
    if (j === slotIdx) return;
    const cur = String(fix.starters[j] || '0');
    if (cur === '0') return;
    const p = S.players[cur];
    // The promoted player has to be able to play the vacated slot, and has to be
    // someone worth promoting — never slide an already-ruled-out starter upward.
    if (!p || luBadInj(p.injury_status)) return;
    if (luLocked(cur)) return;                    // a playing starter can't be slid to another slot
    if (!elig.includes(luNormPos(p.position))) return;
    const openElig = luSlotElig(slot);
    if (!openElig) return;
    const promoteKey = luSortKey(cur, kind, pc, 'ranks');
    benchFor(openElig).forEach(pid =>
      offer(pid, { pid: cur, fromIdx: j, slot }, [[slotIdx, cur], [j, pid]], promoteKey));
  });

  const out = Object.values(best).map(c => ({
    pid: c.pid, via: c.via, moves: c.moves,
    pts: luPlayerPts(c.pid, pc),
    ranked: !!luRankInfo(c.pid),
    // The slot this candidate actually lands in — the vacated flex on a hop, not
    // the injured player's slot.
    landKind: luSlotKind(slots[c.moves[c.moves.length - 1][0]]),
  }));

  // Once promotions are in play the list spans positions, and a positional rank
  // can't order it — TE12 and RB30 aren't the same scale. The sheet's FLEX block
  // IS a cross-position ordering, so that's what a mixed list sorts by; a
  // single-position list still sorts by that position's own rank, which is what
  // this did before hops existed.
  const mixed = new Set(out.map(c => luNormPos(S.players[c.pid]?.position))).size > 1;
  out.forEach(c => { c.mixed = mixed; c.rankKey = lswCandKey(c, mixed, pc); });
  return out.sort((a, b) => luCmpKey(a.rankKey, b.rankKey) || b.pts - a.pts);
}

function lswCandKey(c, mixed, pc) {
  const r = luRankInfo(c.pid, pc);
  if (mixed) return (r && r.flexRank != null) ? [0, r.flexRank, 0] : [1, 0, -c.pts];
  return luSortKey(c.pid, c.landKind, pc, 'ranks');
}

// The plan for a chosen replacement, recomputed against the CURRENT lineup rather
// than stored — so a card Apply that reshuffled the lineup since can't leave a
// stale set of slot indices behind.
function lswPlanFor(fix, slotIdx, replPid) {
  return lswCandidates(fix, slotIdx).find(c => c.pid === String(replPid)) || null;
}

// A target still worth writing: writable, has a replacement chosen, and hasn't
// already been applied successfully (re-sending it would just be a no-op write).
function lswPending(t) {
  return luCanWrite() && !t.fix._espn && !!LSW.picks[t.leagueId] && LSW.done[t.leagueId] !== 'ok' &&
         !luLocked(String(t.fix.starters[t.slotIdx] || '0'));
}

// How the sheet labels a candidate for this slot — "RB14", "FLEX23", "—".
// `mixed` says the surrounding list spans positions and is therefore ordered by
// FLEX rank; the label has to follow that or the Rank column stops running in
// order and reads as a bug (a direct TE21 sitting below a promoted FLEX28).
function lswRankLabel(pid, slot, mixed, pc) {
  const r = luRankInfo(pid, pc);
  if (!r) return '';
  if (mixed && r.flexRank != null) return 'FLEX' + r.flexRank;
  const kind = luSlotKind(slot);
  if (kind === 'flex' && r.flexRank != null) return 'FLEX' + r.flexRank;
  if (kind === 'superflex' && r.pos !== 'QB' && r.flexRank != null) return 'FLEX' + r.flexRank;
  if (r.pos && r.posRank != null) return r.pos + r.posRank;
  if (r.flexRank != null) return 'FLEX' + r.flexRank;
  return '';
}

// ── search ──
function lswSearch(v) {
  LSW.q = v;
  const box = document.getElementById('lu-swap-sug');
  if (!box) return;
  const key = normName(v || '');
  if (key.length < 2) { box.innerHTML = ''; box.style.display = 'none'; return; }

  const map = lswStarterMap();
  const hits = Object.keys(map)
    .map(pid => ({ pid, name: luPlayerName(pid), n: map[pid].length }))
    .filter(h => normName(h.name).includes(key))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .slice(0, 8);

  if (!hits.length) {
    box.innerHTML = `<div style="padding:6px 10px;font-size:0.65rem;color:var(--brown-light);">No starter matches “${esc(v)}”</div>`;
    box.style.display = 'block';
    return;
  }
  box.innerHTML = hits.map(h => {
    const p = S.players[h.pid] || {};
    const inj = injuryBadge(p.injury_status);
    return `<div class="lsw-sug" onclick="lswPick('${h.pid}')">
      <span style="color:var(--parchment);">${esc(h.name)}</span>
      <span style="color:var(--brown-light);font-size:0.65rem;">${esc(luNormPos(p.position) || '')}${p.team ? ' · ' + esc(p.team) : ''}</span>
      ${inj}
      <span style="margin-left:auto;color:var(--gold-light);font-size:0.65rem;white-space:nowrap;">${h.n} lineup${h.n === 1 ? '' : 's'}</span>
    </div>`;
  }).join('');
  box.style.display = 'block';
}

function lswPick(pid) {
  LSW.pid     = String(pid);
  LSW.mode    = null;
  LSW.targets = lswSnapshotTargets(pid);
  LSW.picks   = {};
  LSW.done    = {};
  LSW.applied = {};
  LSW.msg     = '';
  LSW.q       = luPlayerName(pid);
  const box = document.getElementById('lu-swap-sug');
  if (box) { box.innerHTML = ''; box.style.display = 'none'; }
  const inp = document.getElementById('lu-swap-q');
  if (inp) inp.value = LSW.q;
  lswDraw();
}

function lswClear() {
  LSW.pid = null; LSW.mode = null; LSW.targets = []; LSW.picks = {}; LSW.done = {}; LSW.applied = {}; LSW.msg = ''; LSW.q = '';
  const inp = document.getElementById('lu-swap-q'); if (inp) inp.value = '';
  const box = document.getElementById('lu-swap-sug'); if (box) { box.innerHTML = ''; box.style.display = 'none'; }
  lswDraw();
}

// ── mode selection ──
// 'ranks' and 'proj' fill every league's pick in one shot; 'manual' clears them
// and opens the per-league choosers instead.
function lswSetMode(mode) {
  LSW.mode = mode;
  LSW.msg = '';
  if (mode === 'manual') { lswDraw(); return; }
  if (mode === 'ranks' && !luHaveRankings()) {
    LSW.mode = null;
    LSW.msg = 'No ranking sheet uploaded for week ' + LU.week + '.';
    LSW.msgColor = '#c0504d';
    lswDraw();
    return;
  }
  LSW.picks = {};
  let none = 0;
  for (const { fix, slotIdx } of lswTargets()) {
    const cands = lswCandidates(fix, slotIdx);
    const best = mode === 'ranks'
      ? cands.find(c => c.ranked) || cands[0]                        // sheet first, projection fallback
      : cands.reduce((a, c) => (!a || c.pts > a.pts ? c : a), null);
    if (best) LSW.picks[fix.leagueId] = best.pid;
    else none++;
  }
  const n = Object.keys(LSW.picks).length;
  LSW.msg = `Picked a replacement in ${n} league${n === 1 ? '' : 's'}` +
            (none ? ` · ${none} with no eligible bench player` : '') + ' — review, then Apply.';
  LSW.msgColor = 'var(--gold-light)';
  lswDraw();
}

function lswChoose(leagueId, pid) {
  LSW.picks[leagueId] = String(pid);
  delete LSW.done[leagueId];
  lswDraw();
}

// ── apply ──
// One league. Writes fix.starters with just the one slot replaced.
async function lswApplyOne(idx, slotIdx) {
  const fix = LU.lineups[idx];
  if (!fix || fix._espn) return false;
  const repl = LSW.picks[fix.leagueId];
  if (!repl) return false;
  const next = fix.starters.map(String);
  // The slot index came from a snapshot, and the card's own Apply could have moved
  // the lineup around since. Re-locate him before writing rather than clobbering
  // whoever now sits in that slot.
  let si = slotIdx;
  if (next[si] !== String(LSW.pid)) {
    si = next.indexOf(String(LSW.pid));
    if (si < 0) {
      LSW.done[fix.leagueId] = 'ok';   // already out of this lineup — nothing to do
      LSW.applied[fix.leagueId] = LSW.applied[fix.leagueId] || [];
      return true;
    }
  }
  // A promotion moves two slots, so the plan is applied wholesale. Recomputed here
  // against the live lineup, which is also what re-validates the choice.
  const plan = lswPlanFor(fix, si, repl);
  if (!plan) {
    LSW.done[fix.leagueId] = 'fail';
    LSW.msg = '✗ ' + fix.leagueName + ': ' + luPlayerName(repl) + ' is no longer an option here';
    LSW.msgColor = '#c0504d';
    return false;
  }
  LSW.applied[fix.leagueId] = plan.moves.map(([k, pid]) => ({
    slot: fix.rosterPositions[k], from: luPlayerName(fix.starters[k]), to: luPlayerName(pid),
  }));
  plan.moves.forEach(([k, pid]) => { next[k] = String(pid); });
  try {
    const ok = await luPutStarters(fix, next);
    LSW.done[fix.leagueId] = ok ? 'ok' : 'fail';
    return ok;
  } catch (e) {
    LSW.done[fix.leagueId] = 'fail';
    LSW.msg = '✗ ' + fix.leagueName + ': ' + (e.message || 'failed');
    LSW.msgColor = '#c0504d';
    return false;
  }
}

async function lswApplyAll() {
  const targets = lswTargets().filter(t => lswPending(t));
  if (!targets.length) {
    LSW.msg = 'Nothing to apply — choose a replacement first.';
    LSW.msgColor = '#d08a30';
    lswDraw();
    return;
  }
  let done = 0, fail = 0;
  for (const t of targets) {
    LSW.msg = `Applying ${done + fail + 1}/${targets.length}…`;
    LSW.msgColor = 'var(--brown-light)';
    lswDraw();
    if (await lswApplyOne(t.idx, t.slotIdx)) done++; else fail++;
  }
  LSW.msg = `Applied ${done} lineup${done === 1 ? '' : 's'}${fail ? `, ${fail} failed` : ''}`;
  LSW.msgColor = fail ? '#d08a30' : '#5fae5f';
  lswDraw();
  luRefreshCardsInPlace();
}

async function lswApplySingle(idx, slotIdx) {
  LSW.msg = 'applying…';
  LSW.msgColor = 'var(--brown-light)';
  lswDraw();
  const ok = await lswApplyOne(idx, slotIdx);
  if (!LSW.msg.startsWith('✗')) {
    LSW.msg = ok ? '✓ lineup set' : '⚠ saved but Sleeper returned a different lineup';
    LSW.msgColor = ok ? '#5fae5f' : '#d08a30';
  }
  lswDraw();
  luRefreshCardsInPlace();
}

// ── render ──
function lswCandRow(t, c, chosen) {
  const p    = S.players[c.pid] || {};
  // Label him against the slot he'd actually land in — a promotion puts him in the
  // vacated flex, so his FLEX rank is the honest one to show.
  const land = t.fix.rosterPositions[c.moves[c.moves.length - 1][0]];
  const lbl  = lswRankLabel(c.pid, land, c.mixed, luPtsCtx(t.fix));
  const inj  = injuryBadge(p.injury_status);
  const via  = c.via
    ? `<span style="display:block;font-size:0.6rem;color:var(--gold-light);">↳ ${esc(luPlayerName(c.via.pid))} moves ${esc(c.via.slot)} → ${esc(t.slot)}</span>`
    : '';
  // Season PPG under this league's own scoring. Unlike the lineup rows this list
  // has a header, so the number needs no inline unit.
  const ppg = playerSeasonPpg(c.pid, t.fix.scoringSettings || {});
  const gp  = ppg === null ? 0 : playerSeasonGp(c.pid);
  return `<div class="lsw-cand${chosen ? ' chosen' : ''}" onclick="lswChoose('${t.leagueId}','${c.pid}')">
    <span style="width:14px;flex-shrink:0;color:#5fae5f;">${chosen ? '✓' : ''}</span>
    <span style="color:var(--parchment);flex:1;">${esc(luPlayerName(c.pid))}${inj ? ' ' + inj : ''}${via}</span>
    <span style="color:var(--brown-light);font-size:0.65rem;width:52px;flex-shrink:0;">${esc(luNormPos(p.position) || '')}${p.team ? ' ' + esc(p.team) : ''}</span>
    <span style="color:${lbl ? 'var(--gold-light)' : 'var(--brown-light)'};font-size:0.68rem;width:56px;text-align:right;flex-shrink:0;">${lbl ? esc(lbl) : '—'}</span>
    <span style="color:var(--parchment);font-size:0.7rem;width:44px;text-align:right;flex-shrink:0;"${ppg === null ? '' : ` title="${ppg.toFixed(1)} over ${gp} game${gp === 1 ? '' : 's'} played"`}>${ppg === null ? '–' : ppg.toFixed(1)}</span>
    <span style="color:var(--brown-light);font-size:0.7rem;width:44px;text-align:right;flex-shrink:0;">${luHaveProj() ? c.pts.toFixed(1) : '–'}</span>
  </div>`;
}

function lswLeagueBlock(t) {
  const fix    = t.fix;
  const pc     = luPtsCtx(fix);
  const cands  = lswCandidates(fix, t.slotIdx);
  const pick   = LSW.picks[t.leagueId];
  const state  = LSW.done[t.leagueId];
  const applied = state === 'ok';

  const head = `<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 12px;background:var(--brown-mid);">
      <span style="font-family:'Playfair Display',serif;font-weight:700;font-size:0.9rem;color:var(--cream);">${esc(fix.leagueName)}</span>
      ${fix._espn ? `<span style="font-family:'Rye',serif;font-size:0.45rem;letter-spacing:0.1em;color:var(--gold-light);">ESPN</span>` : ''}
      <span class="diff-slot" style="flex:0 0 auto;">${esc(t.slot)}</span>
      ${state === 'ok'   ? `<span style="font-size:0.65rem;color:#5fae5f;">✓ applied</span>` : ''}
      ${state === 'fail' ? `<span style="font-size:0.65rem;color:#c0504d;">✗ failed</span>` : ''}
      <span style="margin-left:auto;display:flex;gap:8px;align-items:center;">
        ${fix._espn
          ? `<span style="font-size:0.65rem;color:var(--parchment);">set it in ESPN</span>`
          : lswPending(t) ? `<button class="setup-btn" onclick="lswApplySingle(${t.idx},${t.slotIdx})">Apply</button>` : ''}
      </span>
    </div>`;

  if (applied) {
    // Post-write, fix.starters already holds the result, so the plan can't be
    // recomputed — LSW.applied keeps the human-readable summary of what was sent.
    const summary = LSW.applied[t.leagueId] || [];
    return `<div class="lsw-league">${head}
      ${summary.map(m => `<div class="diff-row"><span class="diff-slot">${esc(m.slot)}</span>
        <span style="color:var(--parchment);flex:1;"><span style="color:#c0504d;text-decoration:line-through;">${esc(m.from)}</span>
        <span style="color:var(--brown-light);"> → </span><span style="color:#5fae5f;">${esc(m.to)}</span></span>
      </div>`).join('')}
    </div>`;
  }

  if (!cands.length) {
    // The lock is a property of the player, not the league, so when it fires it
    // fires in every row at once — say why rather than showing 30 identical
    // "no eligible bench player" lines, which would read as a bug.
    const locked = luLocked(String(fix.starters[t.slotIdx] || '0'));
    return `<div class="lsw-league">${head}
      <div style="padding:8px 12px;font-size:0.68rem;color:#d08a30;">${locked
        ? '🔒 His game has already started — this slot is locked and can no longer be changed.'
        : `No eligible bench player for a ${esc(t.slot)} slot — nothing to swap in here.`}</div>
    </div>`;
  }

  // The chosen swap, always shown, so options 1 and 2 read as a plain diff. A
  // promotion touches two slots, so it renders as two rows — the same old → new
  // shape the lineup cards use, which keeps the second move from reading as magic.
  const plan = pick ? cands.find(c => c.pid === String(pick)) : null;
  const chosenRow = plan
    ? plan.moves.map(([k, into]) => `<div class="diff-row" style="background:rgba(95,174,95,0.07);">
         <span class="diff-slot">${esc(fix.rosterPositions[k])}</span>
         <span style="color:var(--parchment);flex:1;">
           <span style="color:#c0504d;text-decoration:line-through;">${esc(luPlayerName(fix.starters[k]))}</span>
           <span style="color:var(--brown-light);"> → </span>
           <span style="color:#5fae5f;">${esc(luPlayerName(into))}</span>
           ${lswRankLabel(into, fix.rosterPositions[k], false, pc) ? `<span style="color:var(--gold-light);font-size:0.65rem;"> ${esc(lswRankLabel(into, fix.rosterPositions[k], false, pc))}</span>` : ''}
         </span>
         <span style="color:var(--brown-light);font-size:0.8rem;white-space:nowrap;flex-shrink:0;">${luHaveProj() ? luPlayerPts(fix.starters[k], pc).toFixed(1) : '–'} <span style="color:#5fae5f;">→ ${luHaveProj() ? luPlayerPts(into, pc).toFixed(1) : '–'}</span></span>
       </div>`).join('')
    : `<div style="padding:6px 12px;font-size:0.68rem;color:var(--brown-light);">${cands.length} eligible bench player${cands.length === 1 ? '' : 's'} — pick a replacement.</div>`;

  // Manual mode opens every league's chooser; the bulk modes keep them closed but
  // one click away, since a bulk pick you disagree with in one league is the
  // normal case.
  const listOpen = LSW.mode === 'manual';
  const list = listOpen
    ? `<div class="lsw-cands">
         <div class="lsw-cand hdr">
           <span style="width:14px;flex-shrink:0;"></span>
           <span style="flex:1;">Replacement</span>
           <span style="width:52px;flex-shrink:0;">Pos</span>
           <span style="width:56px;text-align:right;flex-shrink:0;">Rank</span>
           <span style="width:44px;text-align:right;flex-shrink:0;" title="Season-to-date PPG in this league's scoring">PPG</span>
           <span style="width:44px;text-align:right;flex-shrink:0;">Proj</span>
         </div>
         ${cands.map(c => lswCandRow(t, c, String(pick) === c.pid)).join('')}
       </div>`
    : `<div style="padding:0 12px 8px;"><button class="ghost-btn" style="font-size:0.5rem;" onclick="lswSetMode('manual')">Choose a different player…</button></div>`;

  return `<div class="lsw-league">${head}${chosenRow}${list}</div>`;
}

function lswDraw() {
  const panel = document.getElementById('lu-swap-panel');
  const cards = document.getElementById('lu-cards');
  if (!panel) return;

  if (!LSW.pid) {
    panel.innerHTML = '';
    if (cards) cards.style.display = '';
    return;
  }
  if (cards) cards.style.display = 'none';   // the panel IS the filtered league list

  const p    = S.players[LSW.pid] || {};
  const rows = lswTargets();
  const pickCount = rows.filter(lswPending).length;
  const writable  = rows.filter(t => !t.fix._espn).length;
  const canRank   = luHaveRankings();
  const canProj   = luHaveProj();
  const canWrite  = luCanWrite();
  const doneCount = Object.values(LSW.done).filter(v => v === 'ok').length;

  // .setup-btn already carries a gold border, so the active mode has to be marked
  // by fill (the page's own :hover look), not by border colour.
  const modeBtn = (m, label, on, why) =>
    `<button class="setup-btn lsw-mode${LSW.mode === m ? ' on' : ''}" ${on ? '' : `disabled title="${esc(why)}"`} onclick="lswSetMode('${m}')">${label}</button>`;

  if (!rows.length) {   // he isn't starting anywhere — nothing to snapshot
    panel.innerHTML = `<div class="lsw-panel">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 12px;">
        <span style="font-family:'Playfair Display',serif;font-size:1rem;color:var(--cream);">${esc(luPlayerName(LSW.pid))}</span>
        <span style="font-size:0.7rem;color:#5fae5f;">${doneCount ? `✓ swapped out of ${doneCount} lineup${doneCount === 1 ? '' : 's'} — he is no longer starting anywhere` : 'Not in any starting lineup'}</span>
        <button class="ghost-btn" style="font-size:0.5rem;margin-left:auto;" onclick="lswClear()">✕ Done</button>
      </div>
    </div>`;
    return;
  }

  panel.innerHTML = `<div class="lsw-panel">
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-bottom:1px solid var(--brown-mid);">
      <span style="font-family:'Playfair Display',serif;font-size:1rem;color:var(--cream);">${esc(luPlayerName(LSW.pid))}</span>
      <span style="font-size:0.68rem;color:var(--brown-light);">${esc(luNormPos(p.position) || '')}${p.team ? ' · ' + esc(p.team) : ''}</span>
      ${injuryBadge(p.injury_status)}
      <span style="font-size:0.7rem;color:var(--gold-light);">starting in ${rows.length} league${rows.length === 1 ? '' : 's'}${writable !== rows.length ? ` (${rows.length - writable} ESPN, read-only)` : ''}</span>
      <button class="ghost-btn" style="font-size:0.5rem;margin-left:auto;" onclick="lswClear()">✕ Clear</button>
    </div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 12px;">
      ${modeBtn('ranks',  '⚡ Best ranked in all',     canRank, 'Upload a ranking sheet first')}
      ${modeBtn('proj',   '⚡ Best projected in all',  canProj, 'No projections for this week')}
      ${modeBtn('manual', '☰ Choose in each league',   true,    '')}
      ${canWrite && pickCount
        ? `<button class="setup-btn" onclick="lswApplyAll()">✓ Apply ${pickCount} lineup${pickCount === 1 ? '' : 's'}</button>`
        : ''}
      ${!canWrite ? `<span style="font-size:0.6rem;color:var(--brown-light);">add a Sleeper token to write lineups</span>` : ''}
    </div>
    ${LSW.msg ? `<div style="padding:0 12px 8px;font-size:0.68rem;color:${LSW.msgColor};">${esc(LSW.msg)}</div>` : ''}
    <div>${rows.map(lswLeagueBlock).join('')}</div>
  </div>`;
}

// Re-render the (hidden) cards behind the panel so their starters/badges are
// current when the panel is cleared. Cheap: no fetching, and luProposal is cached
// per fixture — luPutStarters already dropped the stale ones.
function luRefreshCardsInPlace() {
  const cards = document.getElementById('lu-cards');
  if (!cards) return;
  const hidden = cards.style.display === 'none';
  cards.innerHTML = luCardsHtml();
  cards.style.display = hidden ? 'none' : '';
}

// ── Ranking sheet upload ─────────────────────────────────────────────────────
// One-line summary of what's loaded, shown on both the Lineup Check toolbar and
// the ranks grid.
function luRanksSummary() {
  if (!luHaveRankings()) return 'No ranking sheet';
  const r = LU.ranks;
  const n = Object.keys(r.byPid).length;
  return `Ranks: ${n} player${n === 1 ? '' : 's'}${r.cols?.FLEX_TEP?.length ? ' · TEP FLEX' : ''}${r.srcName ? ' · ' + r.srcName : ''}`;
}

function openRankingsUpload() {
  document.getElementById('lu-rk-modal')?.remove();
  const ov = document.createElement('div');
  ov.id = 'lu-rk-modal';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  ov.innerHTML = `
    <div style="background:var(--brown-dark);border:1px solid var(--gold);border-radius:4px;max-width:560px;width:100%;padding:20px;max-height:88vh;overflow:auto;">
      <div style="font-family:'Playfair Display',serif;font-size:1.1rem;color:var(--cream);margin-bottom:8px;">Upload Weekly Rankings — Week ${LU.week}</div>
      <div style="font-size:0.7rem;color:var(--brown-light);margin-bottom:10px;line-height:1.5;">
        Pick a ranking-sheet CSV — the wide kind with side-by-side QB / RB / WR / TE / DEF / FLEX / K blocks — or paste a plain list, one player per line, best first. Names are matched to your league players and the team column breaks ties.
      </div>
      <input type="file" id="lu-rk-file" accept=".csv,.txt" style="color:var(--cream);font-family:'Crimson Text',serif;font-size:0.8rem;margin-bottom:10px;display:block;width:100%;" onchange="luRankFilePicked(this)" />
      <div style="border:1px dashed var(--brown-light);border-radius:3px;padding:10px;margin-bottom:10px;">
        <div style="font-size:0.75rem;color:var(--cream);margin-bottom:4px;">🖼 From a screenshot <span style="font-size:0.55rem;color:var(--gold-light);border:1px solid var(--gold);border-radius:2px;padding:0 4px;margin-left:4px;">BETA</span></div>
        <div style="font-size:0.65rem;color:var(--brown-light);margin-bottom:6px;line-height:1.5;">
          An image of the side-by-side sheet (QB / RB / WR / TE / FLEX / TEP FLEX / Defense / Kicker). It's read by an AI model, about 30 seconds, so check the unmatched list afterwards. If the sheet has a <b>TEP FLEX</b> list, leagues with a TE premium use it as their flex ranks.
        </div>
        ${S.auth
          ? `<input type="file" id="lu-rk-img" accept="image/png,image/jpeg,image/webp" style="color:var(--cream);font-family:'Crimson Text',serif;font-size:0.8rem;display:block;width:100%;" onchange="luRankImagePicked(this)" />`
          : `<div style="font-size:0.65rem;color:#d08a30;">Sign in to use this.</div>`}
      </div>
      <textarea id="lu-rk-text" style="width:100%;height:160px;background:var(--brown-mid);color:var(--parchment);border:1px solid var(--brown-light);border-radius:2px;padding:8px;font-family:monospace;font-size:0.8rem;box-sizing:border-box;" placeholder="…or paste here:&#10;Josh Allen&#10;Lamar Jackson&#10;Ja'Marr Chase"></textarea>
      <div id="lu-rk-status" style="font-size:0.7rem;margin:8px 0;color:var(--brown-light);min-height:1em;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        ${luHaveRankings() ? `<button class="ghost-btn" style="font-size:0.5rem;margin-right:auto;" onclick="clearRankings()">Clear saved</button>` : ''}
        <button class="ghost-btn" style="font-size:0.5rem;" onclick="document.getElementById('lu-rk-modal').remove()">Cancel</button>
        <button class="setup-btn" onclick="saveRankingsUpload()">Save &amp; use</button>
      </div>
    </div>`;
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  document.body.appendChild(ov);
}

// A picked file loads straight through — no reason to make you press Save too.
async function luRankFilePicked(input) {
  const f = input.files?.[0];
  if (!f) return;
  const ta = document.getElementById('lu-rk-text');
  try {
    const text = await f.text();
    if (ta) ta.value = text;
    saveRankingsUpload(f.name);
  } catch (e) {
    const st = document.getElementById('lu-rk-status');
    if (st) { st.style.color = '#c0504d'; st.textContent = 'Could not read that file: ' + (e.message || 'error'); }
  }
}

function saveRankingsUpload(srcName) {
  const ta = document.getElementById('lu-rk-text');
  const st = document.getElementById('lu-rk-status');
  if (!ta) return;
  const parsed = luParseRanks(ta.value);
  if (!parsed) {
    if (st) { st.style.color = '#c0504d'; st.textContent = 'Nothing matched — check that this is a ranking sheet or a plain list of player names.'; }
    return;
  }
  luCommitRanks(parsed, typeof srcName === 'string' ? srcName : 'pasted list');
}

// A picked screenshot: sliced, read band by band, then committed exactly like a CSV.
async function luRankImagePicked(input) {
  const f  = input.files?.[0];
  const st = document.getElementById('lu-rk-status');
  if (!f) return;
  const say = (msg, color) => { if (st) { st.style.color = color || 'var(--brown-light)'; st.textContent = msg; } };
  input.disabled = true;
  say('Slicing the image…');
  try {
    const parsed = await luReadSheetImage(f, (done, total) => say(`Reading the sheet… ${done} of ${total} columns`));
    if (!document.getElementById('lu-rk-modal')) return;   // closed while it read
    luCommitRanks(parsed, f.name + ' (image)');
  } catch (e) {
    say('Could not read that image: ' + (e.message || 'error'), '#c0504d');
    input.disabled = false;
  }
}

function luCommitRanks(parsed, srcName) {
  LU.ranks = {
    v: 2, week: LU.week, uploadedAt: Date.now(),
    srcName,
    byPid: parsed.byPid, cols: parsed.cols,
  };
  luSaveRankings();
  LU.lineups.forEach(luClearProposals);   // proposals were built against the old sheet

  // Report what landed rather than silently dropping rows — a stale export shows
  // up here as a pile of unmatched names.
  const miss = parsed.unmatched || [];
  const blocks = Object.entries(parsed.cols).map(([k, v]) => `${luBlockLabel(k)} ${v.length}`).join(' · ');
  document.getElementById('lu-rk-modal').innerHTML = `
    <div style="background:var(--brown-dark);border:1px solid var(--gold);border-radius:4px;max-width:560px;width:100%;padding:20px;max-height:88vh;overflow:auto;">
      <div style="font-family:'Playfair Display',serif;font-size:1.1rem;color:var(--cream);margin-bottom:10px;">Rankings loaded — Week ${LU.week}</div>
      <div style="font-size:0.8rem;color:#5fae5f;margin-bottom:6px;">✓ matched ${parsed.matched} of ${parsed.total} rows</div>
      ${blocks ? `<div style="font-size:0.7rem;color:var(--brown-light);margin-bottom:10px;">${esc(blocks)}</div>` : ''}
      ${miss.length ? `<div style="font-size:0.7rem;color:#d08a30;margin-bottom:6px;">${miss.length} unmatched — these are ignored:</div>
        <div style="font-size:0.7rem;color:var(--brown-light);font-family:monospace;max-height:150px;overflow:auto;background:var(--brown-mid);padding:8px;border-radius:2px;">${miss.map(esc).join('<br>')}</div>` : ''}
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
        <button class="setup-btn" onclick="document.getElementById('lu-rk-modal').remove()">Done</button>
      </div>
    </div>`;
  luRefreshRanksViews();
}

function clearRankings() {
  LU.ranks = null;
  try { localStorage.removeItem(LU_RANKS_KEY); } catch(_) {}
  LU.lineups.forEach(luClearProposals);
  document.getElementById('lu-rk-modal')?.remove();
  luRefreshRanksViews();
}

// Redraw whichever of the two ranks-aware views is on screen.
function luRefreshRanksViews() {
  if (S.tab === 'ranksgrid') rgDraw();
  else if (S.tab === 'lineups') luRenderLineupCards();
}

// ── ESPN lineups (read-only) ─────────────────────────────────────────────────
// ESPN leagues can't be written from here, but their rosters still need to reach
// the ranks grid. shared-utils' ESPN_SLOT_TO_ROSTER_POS is deliberately not
// reused: it folds slots 3 and 5 into a generic FLEX and omits K and D/ST, which
// is right for contender scoring but wrong for laying out a real lineup — and
// widening it there would move every ESPN contender score in the analyzer and the
// trade analyzer. This map is lineup-accurate and local.

// Last-resort scoring for an ESPN league whose settings we couldn't parse. The
// real path is crParseEspnScoring() below; this generic full-PPR table is only
// reached when scoringItems comes back empty, and is wrong for any league that
// isn't full PPR / 4pt-pass-TD — so it exists to keep the card rendering, not to
// be trusted.
const LU_ESPN_SCORING = { pass_yd:0.04, pass_td:4, pass_int:-2, rush_yd:0.1, rush_td:6,
                          rec:1, rec_yd:0.1, rec_td:6, fum_lost:-2 };

// ESPN publishes its OWN weekly projections, and — because kona_player_info is
// requested in the league's context — the `appliedTotal` on each projected stat
// line is already scored with that league's real settings. That's strictly
// better than re-deriving points from Sleeper's stat line through a mapped
// scoring table (it needs no statId mapping at all, and it covers K and D/ST,
// which the mapping deliberately skips), so ESPN fixtures prefer it and fall
// back to the mapped path only if this pull fails or comes back empty.
//
// statSourceId 1 = projected (0 = actual); statSplitTypeId 1 = a single week (0
// would be the season line, which rides along in the same stats array).
// filterIds keeps the response to just this roster instead of ESPN's whole
// ~4000-player pool.
// espnIdToPid maps ESPN's player id → the Sleeper id the rest of the tab uses.
//
// Returns null unless nearly the whole roster came back. A PARTIAL map would be
// worse than none: the card would price some players on ESPN's appliedTotal and
// the rest on Sleeper's mapped stat line, and comparing two different scales is
// exactly how the optimizer picks the wrong starter. All-or-nothing keeps every
// number on one card mutually comparable.
const LU_ESPN_PROJ_COVERAGE = 0.8;

// Two filter shapes are tried in order. `filterIds` is the cheap precise pull
// (espn-api drives this same view with it), but it is undocumented — if ESPN
// ignores it we silently get its default top-N slice instead, which the coverage
// gate then rejects. So a thin first attempt retries with the whole-pool shape
// auction.html already depends on, sorted by ownership so every rostered player
// is inside the limit.
const LU_ESPN_PROJ_FILTERS = [
  ids => ({ players: { filterIds: { value: ids }, limit: Math.max(ids.length, 50) } }),
  ()  => ({ players: { limit: 1200, sortPercOwned: { sortPriority: 1, sortAsc: false } } }),
];

// Diagnostics for the most recent attempt per league. Read `luEspnProjDebug` in
// the browser console when an ESPN card's points look like Sleeper's rather than
// ESPN's — the tell is K and D/ST showing 0.0, which only the mapped path can
// produce (ESPN_STAT_TO_FIELD deliberately maps no kicking/defense categories).
window.luEspnProjDebug = {};

// The stats array carries several splits at once. Take the projected
// (statSourceId 1) line for THIS week, preferring the single-week split
// (statSplitTypeId 1) over anything else that shares the period. Requiring split 1
// up front was the bug that made ESPN projections silently return nothing.
function luEspnProjLine(pl, week) {
  const proj = (pl?.stats || []).filter(st =>
    st.statSourceId === 1 && Number(st.scoringPeriodId) === Number(week));
  return proj.find(st => st.statSplitTypeId === 1) || proj[0] || null;
}

// ESPN's own projections for the league's FREE AGENTS, same kona_player_info view
// and therefore the same league-scored `appliedTotal` scale as luFetchEspnProjections.
// That shared scale is the whole point: the FA watch compares a free agent against a
// starter, so pricing one side on ESPN's numbers and the other on Sleeper's would
// invent upgrades out of thin air. Only called when the roster pull already succeeded
// — when it didn't, both sides fall back to Sleeper together and stay comparable.
async function luFetchEspnFreeAgents(espnId, season, week, seasonAvg = null) {
  const filter = { players: {
    filterStatus: { value: ['FREEAGENT', 'WAIVERS'] },
    limit: 250,
    sortPercOwned: { sortPriority: 1, sortAsc: false },
  } };
  try {
    const r = await fetch(`/api/espn/fantasy/${espnId}?view=kona_player_info&scoringPeriodId=${week}&seasonId=${season}`,
                          { credentials: 'include', headers: { 'X-Fantasy-Filter': JSON.stringify(filter) } });
    if (!r.ok) return null;
    const d = await r.json();
    const out = {};
    for (const entry of (d.players || [])) {
      const pl  = entry.player || entry;
      const pid = luEspnPid(pl);
      if (!pid) continue;
      const line = luEspnProjLine(pl, week);
      if (line && typeof line.appliedTotal === 'number') out[String(pid)] = line.appliedTotal;
      // Free-agent K / D/ST need a PPG on the ranks grid too.
      if (seasonAvg) { const avg = luEspnSeasonAvg(pl, season); if (avg != null) seasonAvg[String(pid)] = avg; }
    }
    return Object.keys(out).length ? out : null;
  } catch(_) { return null; }
}

async function luFetchEspnProjections(espnId, season, week, espnIdToPid) {
  const ids = Object.keys(espnIdToPid).map(Number).filter(n => !Number.isNaN(n));
  const dbg = { espnId, season, week, wanted: ids.length, attempts: [] };
  window.luEspnProjDebug[espnId] = dbg;
  if (!ids.length) return null;

  for (const build of LU_ESPN_PROJ_FILTERS) {
    const filter = build(ids);
    const a = { filter: Object.keys(filter.players).join('+') };
    dbg.attempts.push(a);
    try {
      const r = await fetch(`/api/espn/fantasy/${espnId}?view=kona_player_info&scoringPeriodId=${week}&seasonId=${season}`,
                            { credentials: 'include', headers: { 'X-Fantasy-Filter': JSON.stringify(filter) } });
      a.status = r.status;
      if (!r.ok) { a.body = (await r.text()).slice(0, 200); continue; }
      const d = await r.json();
      const list = d.players || [];
      a.returned = list.length;

      const out = {}, noLine = [];
      for (const entry of list) {
        const pl  = entry.player || entry;
        const pid = espnIdToPid[String(pl.id)];
        if (!pid) continue;
        const line = luEspnProjLine(pl, week);
        if (line && typeof line.appliedTotal === 'number') out[String(pid)] = line.appliedTotal;
        else noLine.push({ name: pl.fullName, splits: (pl.stats || []).map(st =>
               `src${st.statSourceId}/split${st.statSplitTypeId}/wk${st.scoringPeriodId}`) });
      }
      a.matched = Object.keys(out).length;
      if (noLine.length) a.noStatLine = noLine.slice(0, 3);
      if (a.matched >= ids.length * LU_ESPN_PROJ_COVERAGE) { dbg.used = a.filter; return out; }
    } catch (e) { a.error = String((e && e.message) || e); }
  }
  console.warn(`[lineups] ESPN ${espnId}: no usable ESPN projections, using Sleeper's — luEspnProjDebug[${espnId}]`, dbg);
  return null;
}

function luEspnRosterPositions(lineupSlotCounts) {
  return espnSlotList(lineupSlotCounts, n => (n === 'BN' || n === 'IR') ? null : n);
}

// A D/ST is "Chargers D/ST" on ESPN and "Los Angeles Chargers" on Sleeper, so
// names never match — but Sleeper's DEF player_id IS the team abbreviation, which
// proTeamId gives us directly.
function luEspnPid(pl) {
  if (!pl) return null;
  if (pl.defaultPositionId === 16) {
    const abbr = normTeamAbbr(ESPN_TEAM_MAP[pl.proTeamId] || '');
    return S.players[abbr] ? abbr : null;
  }
  return S._playersByName[normName(pl.fullName || '')] || null;
}

async function luLoadEspnLineup(lg, week) {
  const espnId = S.leagueDetails[lg.league_id]?._espnId;
  if (!espnId) return null;
  const season = S.nflState?.season || new Date().getFullYear().toString();
  const r = await fetch(`/api/espn/fantasy/${espnId}?view=mRoster&view=mTeam&view=mSettings&seasonId=${season}`,
                        { credentials: 'include' });
  if (!r.ok) return null;
  const d      = await r.json();
  const myTeam = espnMyTeam(d.teams, S.espnSettings?.swid);
  if (!myTeam) return null;

  const rosterPositions = luEspnRosterPositions(d.settings?.rosterSettings?.lineupSlotCounts);
  if (!rosterPositions.length) return null;

  // mRoster returns every team's roster, so the league-wide owned set is free here
  // the same way it is on the Sleeper side.
  const rostered = new Set();
  const seasonAvg = {};   // pid → ESPN's own season PPG (see ESPN_SEASON_AVG)
  for (const t of (d.teams || [])) {
    for (const e of (t.roster?.entries || [])) {
      const pl  = e.playerPoolEntry?.playerPoolEntry?.player || e.playerPoolEntry?.player;
      const pid = luEspnPid(pl);
      if (!pid) continue;
      rostered.add(String(pid));
      const avg = luEspnSeasonAvg(pl, season);
      if (avg != null) seasonAvg[String(pid)] = avg;
    }
  }

  const players = [], inSlot = [], espnIdToPid = {};
  // What each player has actually scored this week. Same shape as Sleeper's
  // players_points, read off the stat line mRoster already carries — statSourceId
  // 0 is REAL (1 is the projection luEspnProjLine reads), and appliedTotal is
  // already scored with this league's settings. Best-effort: a view that omits
  // `stats` just leaves the map empty, which reads as "no score yet".
  const weekPts = {};
  for (const e of (myTeam.roster?.entries || [])) {
    const pl  = e.playerPoolEntry?.playerPoolEntry?.player || e.playerPoolEntry?.player;
    const pid = luEspnPid(pl);
    if (!pid) continue;
    players.push(String(pid));
    if (pl?.id != null) espnIdToPid[String(pl.id)] = String(pid);
    const act = (pl?.stats || []).find(st =>
      st.statSourceId === 0 && Number(st.scoringPeriodId) === Number(week) && typeof st.appliedTotal === 'number');
    if (act) weekPts[String(pid)] = act.appliedTotal;
    const slot = ESPN_SLOT[e.lineupSlotId];
    if (slot && slot !== 'BN' && slot !== 'IR') inSlot.push({ slot, pid: String(pid) });
  }

  // Lay the live starters onto rosterPositions: exact slot label first, then any
  // slot the player is merely eligible for (ESPN can seat a player in a slot our
  // map spells differently). Anything left over stays '0' — an empty slot, which
  // is exactly what the card's "Action needed" badge is for.
  const starters = rosterPositions.map(() => '0');
  const taken    = new Array(rosterPositions.length).fill(false);
  const place = (pid, want) => {
    let i = rosterPositions.findIndex((rp, k) => !taken[k] && rp === want);
    if (i < 0) {
      const pos = luNormPos(S.players[pid]?.position);
      i = rosterPositions.findIndex((rp, k) => !taken[k] && (luSlotElig(rp) || []).includes(pos));
    }
    if (i >= 0) { taken[i] = true; starters[i] = pid; }
  };
  inSlot.forEach(({ slot, pid }) => place(pid, slot));

  // The league's REAL scoring, via the same shared parser the playoff-odds sim,
  // the analyzer and the trade analyzer already use — TE premium included (see
  // crParseEspnScoring). Only used when ESPN's own projections aren't available.
  const parsedScoring = crParseEspnScoring(d.settings).scoring;
  // A copy of the generic table, never the shared constant: the season-average
  // WeakMap below is keyed by this object, and two leagues must not share one.
  const scoringSettings = Object.keys(parsedScoring).length ? parsedScoring : { ...LU_ESPN_SCORING };

  // Free agents join the SAME projection map as the roster, so luPlayerPts prices
  // everyone off one scale with no caller branching. Skipped entirely when the
  // roster pull fell back to Sleeper's numbers (_espnProj null) — then the FA watch
  // reads Sleeper projections for both sides, which is equally comparable.
  const espnProj = await luFetchEspnProjections(espnId, season, week, espnIdToPid);
  if (espnProj) Object.assign(espnProj, (await luFetchEspnFreeAgents(espnId, season, week, seasonAvg)) || {});
  ESPN_SEASON_AVG.set(scoringSettings, seasonAvg);

  return {
    leagueName: lg.name, leagueId: lg.league_id, rosterId: myTeam.id,
    starters, rosterPositions, players,
    excluded: new Set(),
    scoringSettings,
    // Same pre-draft guard as the Sleeper side: a league that hasn't drafted would
    // report most of the NFL as available.
    rostered: rostered.size >= (d.teams || []).length * 8 ? rostered : null,
    _redraft: true,            // ESPN has no dynasty concept here
    _pts: Object.keys(weekPts).length ? weekPts : null,
    _espnProj: espnProj,
    _espn: true,               // read-only: never written back, never bulk-applied
  };
}

// True while the in-memory snapshot can be reused as-is.
function luCacheFresh() {
  const expectWeek = luWeekFor(S.nflState);
  return !!(LU._cache && LU._cache.week === expectWeek && Date.now() - LU._cache.at < LU_CACHE_TTL);
}

// Load (or reuse) the week's lineup snapshot into LU without rendering anything.
// Split out of renderLineupCheck so the ranks grid shares the same fetch and the
// same 5-minute cache — the per-league rosters+matchups loop is the slow part.
async function luEnsureLineupData(force = false) {
  // Season-to-date PPG for the rows. Started here and awaited at the end so the
  // ~1MB pull overlaps the per-league fan-out rather than delaying it — and it's
  // memoised per session, so the cache path below pays nothing for it.
  const statsP = ppgLoadStats();

  if (!force && luCacheFresh()) {
    LU.lineups = LU._cache.lineups;
    LU.proj    = LU._cache.proj;
    LU.kick    = LU._cache.kick;
    LU.week    = LU._cache.week;
    luLoadRankings(LU.week);
    await statsP;
    return LU.lineups;
  }

  await loadPlayers();
  const nflState = await getNflState();
  // Drop a spent override before resolving — once Sleeper's own week moves off
  // the one the override was pinned against it has served its purpose.
  if (LU.weekOverride && !luOverrideLive(nflState)) luSaveWeekOverride(null);
  const w = luWeekFor(nflState) || 1;

  // Per-league fetches run in parallel — done sequentially this loop was the
  // main source of the delay (2 round-trips × every league, one after another).
  const settled = await Promise.all(S.leagues.map(async (lg) => {
    try {
      if (lg.source === 'espn') return await luLoadEspnLineup(lg, w);
      const detail          = S.leagueDetails[lg.league_id];
      if (detail?.settings?.best_ball === 1) return null;
      const rosterPositions = (detail?.roster_positions || []).filter(p => p !== 'BN' && p !== 'IR' && p !== 'TAXI');

      const rosters = await api('/league/' + lg.league_id + '/rosters');
      const mine    = (rosters || []).find(r => r.owner_id === S.userId);
      if (!mine) return null;

      // Every player owned by anyone in the league — the complement is the free
      // agent pool, which the redraft FA watch scans. Costs nothing: /rosters is
      // already in hand. A league whose draft hasn't finished would report almost
      // the whole NFL as "available", so a thin roster set disables the scan
      // rather than flooding the card.
      const rostered = new Set();
      for (const r of (rosters || [])) for (const p of (r.players || [])) rostered.add(String(p));

      // The week's matchup is the source of truth for what update_matchup_leg writes.
      // mine.starters (from /rosters) is the generic roster lineup and can lag a
      // week-specific change — so prefer the matchup starters for week w.
      let starters = mine.starters || [];
      // players_points rides along on that same matchup object — what each player
      // has ACTUALLY scored this week, already in the league's own scoring. Free,
      // and the only place this app can read a live weekly score.
      let weekPts = null;
      try {
        const matchups = await api('/league/' + lg.league_id + '/matchups/' + w + '?_=' + Date.now());
        const mm = matchups?.find(m => m.roster_id === mine.roster_id);
        if (mm?.starters?.length === rosterPositions.length) starters = mm.starters;
        if (mm?.players_points && typeof mm.players_points === 'object') weekPts = mm.players_points;
      } catch(_) {}
      if (!starters.length || starters.length !== rosterPositions.length) return null;

      return {
        leagueName: lg.name, leagueId: lg.league_id, rosterId: mine.roster_id,
        starters, rosterPositions,
        players: mine.players || [],
        excluded: new Set([...(mine.reserve || []), ...(mine.taxi || [])].map(String)),  // IR + taxi — never auto-start
        scoringSettings: detail?.scoring_settings || {},
        rostered: rostered.size >= (rosters || []).length * 8 ? rostered : null,
        _redraft: rsLeagueCategory(lg.league_id) === 'redraft',
        _pts: weekPts,             // {pid: points scored this week} — see luActualPts
      };
    } catch(_) { return null; }
  }));
  const lineups = settled.filter(Boolean);

  // Week projections for the optimizer (pid → stats); league scoring applied per-team.
  LU.proj = {};
  try {
    const season = nflState.league_create_season || nflState.season;
    const pr = await api('/projections/nfl/regular/' + season + '/' + w);
    if (pr && typeof pr === 'object') LU.proj = pr;
  } catch(_) {}

  // Kickoff times per NFL team (for game-time ordering).
  LU.kick = {};
  try {
    const kr = await fetch('/api/espn/scoreboard?week=' + w + '&season=' + (nflState.season), { credentials: 'include' })
      .then(r => r.ok ? r.json() : {});
    if (kr && typeof kr === 'object') LU.kick = kr;
  } catch(_) {}

  // Restore any uploaded rankings for this week.
  luLoadRankings(w);

  await statsP;

  LU.lineups = lineups;
  LU.week    = w;
  LU._cache  = { at: Date.now(), week: w, lineups, proj: LU.proj, kick: LU.kick };
  return lineups;
}

async function renderLineupCheck(force = false) {
  if (force || !luCacheFresh()) setC(loading('Loading lineups'));
  try {
    const lineups = await luEnsureLineupData(force);
    if (!lineups.length) { setC('<div class="empty-state"><p>No active lineups found</p></div>'); return; }
    luRenderLineupCards();
  } catch(e) { setC(errHtml(e)); }
}

// Just the <details> cards, so the injury-swap panel can re-render them in place
// after a write without redrawing the whole tab (which would blow away the search
// box the user is standing in).
function luCardsHtml() {
  const lineups  = LU.lineups;
  const canWrite = luCanWrite();
  const canProj  = luCanOptimize('projections');
  const canRank  = luCanOptimize('ranks');

  // Precompute each league's projection-optimal lineup so the collapsed card
  // can show a status badge without opening. Ranks proposals stay lazy — you
  // only pay for them on the leagues whose Ranks button you actually press.
  if (canProj) lineups.forEach(fix => luProposal(fix, 'projections'));

  return lineups.map((fix, idx) => {
      const optBtns = `<button class="setup-btn" ${canProj ? '' : 'disabled title="No projections for this week"'} onclick="event.preventDefault();optimizeLineup(${idx},'projections')">⚡ Optimize with Projections</button>
             <button class="setup-btn" ${canRank ? '' : 'disabled title="Upload a ranking sheet first"'} onclick="event.preventDefault();optimizeLineup(${idx},'ranks')">⚡ Optimize with Ranks</button>`;
      // Every card gets the Optimize buttons — they only ever preview. What varies
      // is the trailing note: ESPN can't be written at all, and a Sleeper league
      // without a token can be previewed but not applied.
      const note = fix._espn
        ? `<span style="font-size:0.55rem;color:var(--brown-light);">preview only — set this lineup in ESPN</span>`
        : canWrite
        ? `<button class="ghost-btn" style="font-size:0.5rem;" onclick="event.preventDefault();testSetLineup(${idx})">↻ Re-set current (test)</button>
           <span id="lc-result-test-${idx}" style="font-size:0.55rem;color:var(--brown-light);"></span>`
        : `<span style="font-size:0.55rem;color:var(--brown-light);">preview only — <a href="/myprofile" style="color:var(--gold-light);">add a Sleeper token</a> to apply</span>`;
      const actions = `<div style="margin:4px 0;padding:0 16px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
             ${optBtns}
             ${note}
           </div>
           <div id="lc-opt-${idx}"></div>`;

    return `<details class="lineup-card" id="lc-${idx}">
      <summary>
        <span style="font-family:'Playfair Display',serif;font-weight:700;font-size:0.95rem;color:var(--cream);flex-shrink:0;margin-right:12px;">${esc(fix.leagueName)}${fix._espn ? ' <span style="font-family:\'Rye\',serif;font-size:0.45rem;letter-spacing:0.1em;color:var(--brown-light);">ESPN</span>' : ''}</span>
        ${luSummaryMeta(fix, idx)}
      </summary>
      <div id="lc-body-${idx}">${luBodyRows(fix, 'current')}</div>
      ${luFaHtml(fix)}
      ${actions}
    </details>`;
  }).join('');
}

// Render the lineup cards + toolbar from whatever is currently in LU (fresh load
// or a restored cache). Split out so the cache path renders without any fetching.
function luRenderLineupCards() {
  try {
    const w        = LU.week;
    const canWrite = luCanWrite();
    const canProj  = luCanOptimize('projections');
    const canRank  = luCanOptimize('ranks');
    const cardsHtml = luCardsHtml();

    // "Optimize all" / "Apply all" are projections-only on purpose — see the
    // comment above optimizeAll().
    // Only "Apply all" is a write. Optimize all, the sheet upload and the ranks
    // grid are read-only, so the whole toolbar used to vanish for tokenless users
    // for no reason — including the upload they need before ranks work at all.
    const toolbar = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
           <button class="setup-btn" ${canProj ? '' : 'disabled'} onclick="optimizeAll()">⚡ Optimize all</button>
           ${canWrite ? `<button class="setup-btn" ${canProj ? '' : 'disabled'} onclick="applyAll()">✓ Apply all</button>` : ''}
           <button class="ghost-btn" id="lu-collapse-btn" style="font-size:0.5rem;" onclick="toggleCollapseAll()">Expand all</button>
           <span style="width:1px;height:18px;background:var(--brown-mid);"></span>
           ${luWeekCtlHtml(w)}
           <span style="width:1px;height:18px;background:var(--brown-mid);"></span>
           <span style="font-size:0.55rem;color:${canRank ? 'var(--gold-light)' : 'var(--brown-light)'};">${esc(luRanksSummary())}</span>
           <button class="ghost-btn" style="font-size:0.5rem;" onclick="openRankingsUpload()">⬆ Upload rankings</button>
           <button class="ghost-btn" style="font-size:0.5rem;" onclick="sw('ranksgrid')">▦ View as ranks grid</button>
           <button class="ghost-btn" style="font-size:0.5rem;${LU.faOn ? 'color:#d08a30;border-color:#d08a30;' : ''}" title="Flag free agents projected to beat your best lineup (redraft leagues only)" onclick="luToggleFa()">◎ FA watch: ${LU.faOn ? 'on' : 'off'}</button>
           <span id="lu-allstatus" style="font-size:0.6rem;color:var(--brown-light);width:100%;text-align:right;"></span>
         </div>`;

    const cachedAgo = LU._cache
      ? (() => {
          const m = Math.floor((Date.now() - LU._cache.at) / 60000);
          return m < 1 ? 'just now' : `${m}m ago`;
        })()
      : '';
    const refreshBar = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
        <span style="font-size:0.55rem;color:var(--brown-light);">Updated ${cachedAgo}</span>
        <button class="ghost-btn" style="font-size:0.5rem;" onclick="renderLineupCheck(true)">↻ Refresh</button>
      </div>`;

    setC(`<div>
      <div class="tab-header" style="margin-bottom:16px;align-items:flex-start;">
        <div class="section-head" style="margin-bottom:0;flex:1;"><h2>Lineup Check — Week ${w}</h2><div class="section-head-line"></div></div>
        <div style="display:flex;flex-direction:column;gap:8px;align-items:flex-end;">
          ${refreshBar}
          ${toolbar}
        </div>
      </div>
      ${luSwapBarHtml()}
      <div id="lu-cards" style="border:1px solid var(--brown-mid);border-radius:2px;overflow:hidden;background:var(--brown-dark);">${cardsHtml}</div>
    </div>`);
    lswDraw();     // restore an in-progress swap across a tab re-render
  } catch(e) { setC(errHtml(e)); }
}

// The injury-swap search row. Lives above the cards and owns #lu-swap-panel,
// which lswDraw() fills; the input itself is never re-rendered from JS so typing
// survives every panel redraw.
function luSwapBarHtml() {
  return `<div style="margin-bottom:14px;">
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <span style="font-size:0.62rem;color:var(--gold-light);font-family:'Rye',serif;letter-spacing:0.08em;">🚑 Injury swap</span>
      <div style="position:relative;flex:1;min-width:220px;max-width:340px;">
        <input id="lu-swap-q" type="text" autocomplete="off" placeholder="Search a starter to replace everywhere…"
               value="${esc(LSW.q)}" oninput="lswSearch(this.value)"
               onblur="setTimeout(() => { const b = document.getElementById('lu-swap-sug'); if (b) b.style.display = 'none'; }, 180)"
               style="width:100%;box-sizing:border-box;background:var(--brown-mid);color:var(--parchment);border:1px solid var(--brown-light);border-radius:2px;padding:5px 8px;font-family:'Crimson Text',serif;font-size:0.8rem;" />
        <div id="lu-swap-sug" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:50;background:var(--brown-dark);border:1px solid var(--gold);border-radius:2px;max-height:260px;overflow:auto;"></div>
      </div>
      <span style="font-size:0.55rem;color:var(--brown-light);">finds every league where he's in your starting lineup</span>
    </div>
    <div id="lu-swap-panel" style="margin-top:10px;"></div>
  </div>`;
}
