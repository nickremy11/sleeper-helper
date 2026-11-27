// ── League matchups: one week's head-to-head read, Sleeper + ESPN ────────────
// Shared by Root For Me (rootforme.html) and the Scoreboard (scoreboard.html).
// Not pure: reads the host page's global `S` (userId, season, week, playerMap,
// espnSettings, rid, espnSkips, leagues) and `API`, which both pages define the
// same way. A row is {league, myMatchup, oppMatchup, scoring, allMatchups?, oppName?};
// an ESPN side carries `line` (every starter, resolved or not) besides `starters`.

async function loadEspnLeagues() {
  if (!S.auth) return;
  await Promise.all([
    (async () => {
      try {
        const r = await fetch(`${API}/espn/settings`, { credentials: 'include' });
        if (!r.ok) return;
        const cfg = await r.json();
        S.espnSettings = cfg;
        if (!cfg.has_credentials || !cfg.league_ids?.length) return;
        await Promise.all(cfg.league_ids.map(id => loadOneEspnLeague(id)));
      } catch {}
    })(),
    loadMflLeaguesLite(),
  ]);
}

// MFL leagues: the worker serves them in Sleeper's shapes under the normal
// /sleeper/league/mfl_… paths, so after this they read like Sleeper leagues.
async function loadMflLeaguesLite() {
  try {
    const list = await shMflLeagueList(S.season);
    await Promise.all(list.map(async l => {
      if (S.leagues.some(x => x.league_id === l.league_id)) return;
      const lg = await fetch(`${API}/sleeper/league/${l.league_id}`, { credentials: 'include' }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (lg?.league_id) S.leagues.push({ ...lg, source: 'mfl' });
    }));
  } catch {}
}

async function loadOneEspnLeague(leagueId) {
  try {
    const r = await fetch(`${API}/espn/fantasy/${leagueId}?view=mSettings&view=mTeam&seasonId=${S.season}`, { credentials: 'include' });
    if (!r.ok) return;
    const d   = await r.json();
    const lgId = `espn_${leagueId}`;
    if (S.leagues.some(l => l.league_id === lgId)) return;
    const name = d.settings?.name || `ESPN ${leagueId}`;
    const size = d.teams?.length || d.settings?.size || 10;
    S.leagues.push({ league_id: lgId, name, total_rosters: size, source: 'espn' });
  } catch {}
}

// My roster_id per Sleeper league never moves within a season, so it's read once
// (from /rosters) and kept — every later load or refresh is one /matchups call.
const ridKey = () => `rfm_rid_${S.userId}_${S.season}`;
function ridLoad() {
  try { S.rid = JSON.parse(localStorage.getItem(ridKey()) || '{}') || {}; } catch { S.rid = {}; }
}
function ridSave() {
  try { localStorage.setItem(ridKey(), JSON.stringify(S.rid)); } catch {}
}

// `fresh` revalidates past the 60s browser cache on /matchups — a Refresh button
// that can hand back the score you're already looking at is no Refresh at all.
async function fetchLeagueMatchup(league, week = S.week, fresh = false) {
  if (league.source === 'espn') return fetchEspnLeagueMatchup(league, week);
  const lgId = league.league_id;
  const known = S.rid[lgId];
  const [rosters, matchups] = await Promise.all([
    known != null ? null : fetch(`${API}/sleeper/league/${lgId}/rosters`).then(r => r.json()),
    fetch(`${API}/sleeper/league/${lgId}/matchups/${week}`, fresh ? { cache: 'no-cache' } : undefined).then(r => r.json()),
  ]);

  let rid = known;
  if (rid == null) {
    rid = (rosters || []).find(r => r.owner_id === S.userId)?.roster_id;
    if (rid == null) return null;
    S.rid[lgId] = rid;
    ridSave();
  }

  const myMatchup  = (matchups || []).find(m => m.roster_id === rid);
  // A cached id that no longer finds me gets re-read from /rosters next time.
  if (!myMatchup) { if (known != null) { delete S.rid[lgId]; ridSave(); } return null; }

  const oppMatchup = (matchups || []).find(m =>
    m.matchup_id === myMatchup.matchup_id && m.roster_id !== rid
  );

  return { league, myMatchup, oppMatchup: oppMatchup || null, scoring: league.scoring_settings || {}, allMatchups: matchups || [] };
}

async function fetchEspnLeagueMatchup(league, week = S.week) {
  try {
    const espnId = league.league_id.replace('espn_', '');
    const r = await fetch(
      `${API}/espn/fantasy/${espnId}?view=mMatchup&view=mRoster&view=mTeam&view=mSettings&scoringPeriodId=${week}&seasonId=${S.season}`,
      { credentials: 'include' }
    );
    if (!r.ok) return espnSkip(league, `ESPN returned HTTP ${r.status}`);
    const d = await r.json();

    const mySWID = S.espnSettings?.swid || '';
    const myTeam = espnMyTeam(d.teams, mySWID);
    if (!myTeam) return espnSkip(league, 'could not find your team (SWID mismatch)');

    const matchup = (d.schedule || []).find(m =>
      m.matchupPeriodId === week &&
      (m.home?.teamId === myTeam.id || m.away?.teamId === myTeam.id)
    );
    if (!matchup) return espnSkip(league, `no Week ${week} matchup on the schedule`);

    const iAmHome  = matchup.home?.teamId === myTeam.id;
    const oppTeamId = iAmHome ? matchup.away?.teamId : matchup.home?.teamId;
    const oppTeam  = (d.teams || []).find(t => t.id === oppTeamId);

    // Build name → sleeperId lookup from already-loaded S.playerMap
    const byName = {};
    const rankOf = p => (p.search_rank != null && p.search_rank < 9999999) ? p.search_rank : Infinity;
    for (const [pid, p] of Object.entries(S.playerMap || {})) {
      // Sleeper's DEF entries have no full_name — index them off first+last
      // ("Los Angeles" + "Chargers") so a name match is at least possible;
      // the proTeamId path below is what actually resolves them.
      const nm = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
      if (!nm) continue;
      // Normalize names + on collisions keep the more fantasy-relevant player.
      const key = normName(nm);
      if (byName[key] == null || rankOf(p) < rankOf(S.playerMap[byName[key]])) byName[key] = pid;
    }

    const parseRoster = (team) => {
      if (!team) return { starters: [], players_points: {}, total: 0, line: [], bench: [] };
      const starters = [], players_points = {}, line = [], bench = [];
      let total = 0;
      for (const entry of (team.roster?.entries || [])) {
        // 21 = IR — never in play. 20 = Bench — kept apart, only for the
        // opponent's optimal lineup (lmOptimalSide).
        if (entry.lineupSlotId === 21) continue;
        const pData = entry.playerPoolEntry?.playerPoolEntry?.player
                   || entry.playerPoolEntry?.player;
        if (!pData) continue;
        const { pts, proj } = espnWeekLine(pData, week);
        if (entry.lineupSlotId === 20) { bench.push(espnLineOf(pData, pts, proj, entry, byName)); continue; }
        // Summed before the id match below can drop the player — the team's
        // score has to include starters we can't resolve to a Sleeper id.
        total += pts;
        const ln = espnLineOf(pData, pts, proj, entry, byName);
        line.push(ln);
        if (!ln.pid) continue;
        starters.push(ln.pid);
        players_points[ln.pid] = pts;
      }
      return { starters, players_points, total, line, bench };
    };

    const my  = parseRoster(myTeam);
    const opp = parseRoster(oppTeam);
    return {
      league,
      myMatchup:  { starters: my.starters,  players: my.starters,  players_points: my.players_points, points: my.total, line: my.line, bench: my.bench },
      oppMatchup: oppTeam ? { starters: opp.starters, players: opp.starters, players_points: opp.players_points, points: opp.total, line: opp.line, bench: opp.bench } : null,
      oppName: oppTeam ? (oppTeam.name || `${oppTeam.location || ''} ${oppTeam.nickname || ''}`.trim()) : null,
      // Offence only — miracle.js layers Sleeper's default K/DEF rules on top.
      scoring: (typeof crParseEspnScoring === 'function' ? crParseEspnScoring(d.settings)?.scoring : null) || {},
    };
  } catch (e) { return espnSkip(league, e.message || 'request failed'); }
}


// One ESPN roster entry as a lineup line. Unresolved players still project: ESPN
// gives their team and position, which is all the tracker needs.
const ESPN_POS_EXTRA = { 5: 'K', 16: 'DEF' };   // ESPN_POS_MAP is skill + IDP only
const ESPN_INJ_OK = /^(ACTIVE|NORMAL|HEALTHY)$/i;
function espnLineOf(pData, pts, proj, entry, byName) {
  const fullName = pData.fullName || `${pData.firstName || ''} ${pData.lastName || ''}`.trim();
  // D/ST never name-matches (ESPN says "Chargers D/ST", Sleeper says
  // "Los Angeles Chargers") but Sleeper's DEF player_id IS the team
  // abbreviation, so resolve it off proTeamId instead.
  const pid = pData.defaultPositionId === 16
    ? ESPN_TEAM_MAP[pData.proTeamId]
    : (fullName ? byName[normName(fullName)] : null);
  const known = !!(pid && S.playerMap[pid]);
  // The roster entry's own status can say ACTIVE while the player's says OUT, so
  // take whichever one reports something.
  const inj = [pData.injuryStatus, entry.injuryStatus].find(x => x && !ESPN_INJ_OK.test(x)) || null;
  return { pid: known ? pid : null, name: fullName, pts, proj, slotId: entry.lineupSlotId,
           team: ESPN_TEAM_MAP[pData.proTeamId] || null,
           pos: ESPN_POS_MAP[pData.defaultPositionId] || ESPN_POS_EXTRA[pData.defaultPositionId] || '', inj };
}

// One player's week off his stat lines, both already in this league's scoring:
// statSourceId 0 is actual, 1 is projected, statSplitTypeId 1 is the single week.
// NOT playerPoolEntry.appliedStatTotal: that totals every actual line in the
// response, and asking for week N returns weeks N-1 and N. So a player "started"
// at last week's score before kickoff and every team total ran far too high.
function espnWeekLine(pl, week) {
  // Split 1 is preferred, not required: index.html's luEspnProjLine learned that
  // ESPN doesn't reliably label it.
  const line = src => {
    const all = (pl.stats || []).filter(st => st.statSourceId === src
      && Number(st.scoringPeriodId) === Number(week) && typeof st.appliedTotal === 'number');
    return all.find(st => st.statSplitTypeId === 1) || all[0];
  };
  return { pts: line(0)?.appliedTotal ?? 0, proj: line(1)?.appliedTotal ?? null };
}

// Every ESPN bail-out used to `return null` silently, so a league that failed
// to load was indistinguishable from one that simply had no players playing.
// Record the reason so renderGameCards() can say so.
function espnSkip(league, reason) {
  S.espnSkips.push({ leagueId: league.league_id, name: league.name || 'ESPN league', reason });
  return null;
}

// Every league's matchup for a week. One failed read never takes the rest down:
// it lands in `skips` (ESPN bail-outs land in S.espnSkips via espnSkip()).
async function fetchMatchupsFor(leagues, week, fresh = false) {
  const skips = [];
  const res = await Promise.all(leagues.map(lg =>
    fetchLeagueMatchup(lg, week, fresh).catch(e => {
      skips.push({ name: lg.name || 'League', reason: e.message || 'request failed' });
      return null;
    })));
  return { results: res.filter(Boolean), skips };
}


// ── Projecting a side (Scoreboard + Home) ─────────────────────────────────────
// Needs matchup-tracker.js + miracle.js, and the host's S.playerMap / S.nflGames /
// S.mnmProj and an mnmName(pid).
// ESPN lineupSlotId → label, and the order a lineup reads in. Local, like
// index.html's ESPN_SLOT, because shared-utils' map folds 3/5 into FLEX and drops K/D-ST.
const LM_ESPN_SLOT = { 0: 'QB', 1: 'TQB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE', 7: 'OP', 8: 'DT', 9: 'DE',
  10: 'LB', 11: 'DL', 12: 'CB', 13: 'S', 14: 'DB', 15: 'DP', 16: 'D/ST', 17: 'K', 19: 'HC', 23: 'FLEX', 24: 'ER' };
const LM_ESPN_ORDER = [0, 1, 2, 3, 4, 5, 6, 23, 7, 16, 17, 8, 9, 11, 10, 12, 13, 14, 15, 19, 24];
const LM_SLOT_LABEL = { SUPER_FLEX: 'SF', REC_FLEX: 'W/T', WRRB_FLEX: 'W/R', IDP_FLEX: 'IDP', DEF: 'D/ST' };
// index.html's LU_BAD_INJ, plus how ESPN spells two of them.
const LM_OUT = new Set(['OUT', 'IR', 'SUS', 'NA', 'PUP', 'DNR', 'COV', 'DNP', 'O', 'SUSPENSION', 'INJURY_RESERVE']);

function lmGameFrac() {
  const now = Date.now(), byTeam = {};
  for (const g of S.nflGames) { const f = mnmRemainingFrac(g, now); byTeam[g.home] = f; byTeam[g.away] = f; }
  return byTeam;
}
// {team: 'pre' | 'in' | 'post'} — 'in' is "playing now", anything but 'pre' locks a slot.
function lmGameStates() {
  const out = {};
  for (const g of S.nflGames || []) { out[g.home] = g.state || null; out[g.away] = g.state || null; }
  return out;
}
const lmIsOut = s => LM_OUT.has(String(s || '').toUpperCase());

// The per-league context every line in a side is priced with.
function lmCtx(r, fracs) {
  const lg = r.league;
  const isEspn = lg.source === 'espn';
  const scoring = isEspn ? { ...MNM_KDEF_DEFAULT, ...(r.scoring || {}) } : (lg.scoring_settings || {});
  return { lg, isEspn, scoring, fracs, states: lmGameStates(),
           sleeperPts: pid => S.mnmProj?.[pid] ? mnmScore(S.mnmProj[pid], scoring) : 0 };
}

// A line's game state → live / locked. A player whose game we can't find but who
// has points is treated as locked: he has played, whatever the schedule says.
function lmLockOf(c, team, pts) {
  const st = team ? c.states[team] : null;
  return { live: st === 'in' ? true : st ? false : undefined, locked: st === 'in' || st === 'post' || (!st && !!pts) };
}

// One ESPN line (from espnLineOf) priced: ESPN's own projection, already in league
// scoring, falling back to Sleeper's numbers for a player ESPN published nothing on.
function lmEspnLine(c, p, slot) {
  const team = p.pid ? (S.playerMap[p.pid]?.team || p.team) : p.team;
  const f = c.fracs[team] ?? c.fracs[p.team] ?? 0;
  const lk = lmLockOf(c, team, p.pts);
  return {
    ...lmLine({ pid: p.pid, name: p.name, pts: p.pts, pos: p.pos, proj: p.proj ?? (p.pid ? c.sleeperPts(p.pid) : 0),
                f, out: lmIsOut(p.inj), live: lk.live }),
    slot, team, inj: p.inj || null, locked: lk.locked, slotId: p.slotId,
  };
}
// One Sleeper player priced under this league's scoring.
function lmSleeperLine(c, m, pid, slot, idx) {
  const pl = S.playerMap[pid];
  const pts = m.players_points?.[pid] || 0;
  const lk = lmLockOf(c, pl?.team, pts);
  return {
    ...lmLine({ pid, name: mnmName(pid), pts, pos: pl?.position, proj: c.sleeperPts(pid),
                f: c.fracs[pl?.team] ?? 0, out: lmIsOut(pl?.injury_status), live: lk.live }),
    slot, idx, team: pl?.team || null, inj: pl?.injury_status || null, locked: lk.locked,
  };
}

// One side as it's set right now. ESPN's line is already priced by ESPN; Sleeper's
// starters (or whole roster, for best ball) are priced from Sleeper's projection
// under this league's scoring.
function lmSide(m, r, fracs) {
  const c = lmCtx(r, fracs);
  const { lg } = c;
  const bestBall = lg.settings?.best_ball === 1;

  // Slot, team and injury ride along on each line for the click-in lineup view.
  const slotsOf = (lg.roster_positions || []).filter(s => !['BN', 'IR', 'TAXI'].includes(s));
  const empties = [];
  const lines = m.line
    ? [...m.line]
        .sort((a, b) => lmEspnSlotRank(a.slotId) - lmEspnSlotRank(b.slotId))
        .map(p => lmEspnLine(c, p, LM_ESPN_SLOT[p.slotId] || p.pos || ''))
    : ((bestBall ? m.players : m.starters) || []).map((pid, i) => {
        const slot = bestBall ? null : (LM_SLOT_LABEL[slotsOf[i]] || slotsOf[i] || '');
        if (!pid || pid === '0') { if (!bestBall) empties.push({ idx: i, slot }); return null; }
        const ln = lmSleeperLine(c, m, pid, slot, i);
        if (slot == null) ln.slot = S.playerMap[pid]?.position || '';
        return ln;
      }).filter(Boolean);
  const side = lmProjectSide({ lines, now: m.custom_points ?? m.points ?? 0, bestBall, rosterPositions: lg.roster_positions });
  // A cached older /matchup-tracker.js doesn't return these; the lineup view needs them.
  side.lines = side.lines || lines;
  side.counted = side.counted || (bestBall ? lmBestLineup(lines, lg.roster_positions) : lines);
  side.empties = empties;
  side.bestBall = bestBall;
  return side;
}

// ESPN lineupSlotId → the positions it takes.
const LM_ESPN_ELIG = { 0: ['QB'], 2: ['RB'], 3: ['RB', 'WR'], 4: ['WR'], 5: ['WR', 'TE'], 6: ['TE'],
  7: ['QB', 'RB', 'WR', 'TE'], 23: ['RB', 'WR', 'TE'], 16: ['DEF'], 17: ['K'],
  8: ['DL'], 9: ['DL'], 11: ['DL'], 10: ['LB'], 12: ['DB'], 13: ['DB'], 14: ['DB'], 15: ['DL', 'LB', 'DB'] };

// The side as it WOULD be with the best lineup this manager can still set, by
// projected final: locked players stay, everyone else (bench included) competes
// for the open slots. Same shape as lmSide, every line carrying `idx` so the
// lineup view lays it out by slot; a player who isn't starting now is `swapIn`.
// `unavail` (Set of pids) = IR / taxi on a Sleeper roster, never startable.
// Best ball already scores its optimal lineup, so it returns null (= use lmSide).
function lmOptimalSide(m, r, fracs, unavail) {
  const c = lmCtx(r, fracs);
  const { lg } = c;
  if (lg.settings?.best_ball === 1) return null;
  const now = m.custom_points ?? m.points ?? 0;
  let slots, bench;
  if (m.line) {
    const cur = [...m.line].sort((a, b) => lmEspnSlotRank(a.slotId) - lmEspnSlotRank(b.slotId))
      .map(p => lmEspnLine(c, p, LM_ESPN_SLOT[p.slotId] || p.pos || ''));
    slots = cur.map(l => ({ elig: LM_ESPN_ELIG[l.slotId] || [l.pos], cur: l, label: l.slot }));
    bench = (m.bench || []).map(p => lmEspnLine(c, p, 'BN'));
  } else {
    const slotsOf = (lg.roster_positions || []).filter(s => !['BN', 'IR', 'TAXI'].includes(s));
    const starters = m.starters || [];
    const inLineup = new Set(starters.filter(p => p && p !== '0'));
    slots = slotsOf.map((s, i) => {
      const pid = starters[i];
      const label = LM_SLOT_LABEL[s] || s;
      return { elig: SLOT_ELIG[s] || [lmPosNorm(s)], label,
               cur: pid && pid !== '0' ? lmSleeperLine(c, m, pid, label, i) : null };
    });
    bench = (m.players || []).filter(p => p && p !== '0' && !inLineup.has(p) && !unavail?.has(p))
      .map(pid => lmSleeperLine(c, m, pid, 'BN', null));
  }
  const filled = lmFillOptimal(slots, bench);
  const curPids = new Set(slots.map(s => s.cur && (s.cur.pid || s.cur.name)).filter(Boolean));
  const empties = [];
  const lines = [];
  filled.forEach((l, i) => {
    if (!l) { empties.push({ idx: i, slot: slots[i].label }); return; }
    lines.push({ ...l, idx: i, slot: slots[i].label, swapIn: !curPids.has(l.pid || l.name) });
  });
  // The platform's total is the current starters' points. Anyone moved out was
  // unlocked, so hadn't played — but a no-game starter with a stat correction
  // could carry points; take those off so the total matches the new lineup.
  const kept = new Set(lines.map(l => l.pid || l.name));
  const dropped = slots.reduce((t, s) => t + (s.cur && !kept.has(s.cur.pid || s.cur.name) ? s.cur.pts : 0), 0);
  const side = lmProjectSide({ lines, now: now - dropped + lines.reduce((t, l) => t + (l.swapIn ? l.pts : 0), 0), bestBall: false });
  side.lines = side.lines || lines;
  side.counted = side.counted || lines;
  side.empties = empties;
  side.bestBall = false;
  side.optimal = true;
  side.swaps = lines.filter(l => l.swapIn).length;
  return side;
}
const lmPosNorm = s => ({ DE: 'DL', DT: 'DL', CB: 'DB', S: 'DB', DST: 'DEF' })[String(s).toUpperCase()] || String(s).toUpperCase();

const lmEspnSlotRank = id => { const i = LM_ESPN_ORDER.indexOf(Number(id)); return i < 0 ? 99 : i; };
