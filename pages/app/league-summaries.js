// League Summaries tab: odds, guillotine, Weekly Recap

// ── League Summaries ──────────────────────────────────────────────────────────

async function renderLeagueSummaries() {
  if (!S.leagues.length) {
    setC('<div class="empty-state"><p>No leagues found for this user</p></div>');
    return;
  }
  if (LS.loaded) { lsDrawTable(); return; }
  if (LS.loading) return;
  LS.loading = true;
  // Ensure prefs are loaded (reuse RS.prefs; rsLoadPrefs populates it)
  // Only skip if Rostership has already been visited (which sets RS.selectedLeagues).
  // Don't gate on RS.prefs being empty — ESPN entries from loadEspnLeagues can
  // populate it before we get here, causing prefs to never load for Sleeper leagues.
  if (RS.selectedLeagues === null) {
    RS.selectedLeagues = new Set(S.leagues.map(lg => lg.league_id));
    await rsLoadPrefs();
  }
  setC(loading('Loading league standings…'));
  try {
    await Promise.all([lsLoadData(), loadPlayers()]);
    LS.loaded = true;
    lsRestoreOddsCache();
  } catch(e) {
    setC(errHtml(e));
    LS.loading = false;
    return;
  }
  LS.loading = false;
  lsDrawTable();
  // A new week just finished and nothing's cached for it → generate its recap
  // odds now rather than waiting for a button press.
  if (!LS._autoOdds && !LS.oddsLoading && lsRecapNeedsOdds()) {
    LS._autoOdds = true;
    LS._oddsUseCache = true;
    lsSimulateAllLeagues();
  }
}

async function lsLoadData() {
  await getNflState();
  await loadPlayers(); // ESPN roster→Sleeper-id name matching below needs S._playersByName ready
  // loadUser() fires the league-detail fetches without awaiting them, but banked
  // weeks (median games), the recap filters and the sim all read settings.
  await Promise.all(S.leagues
    .filter(lg => lg.source !== 'espn' && !S.leagueDetails[lg.league_id])
    .map(lg => api('/league/' + lg.league_id).then(dd => { if (dd) S.leagueDetails[lg.league_id] = dd; }).catch(() => {})));
  await Promise.allSettled(S.leagues.map(async lg => {
    if (lg.source === 'espn') return lsLoadEspnLeague(lg);
    try {
      const rosters = await api('/league/' + lg.league_id + '/rosters');
      if (!rosters?.length) return;
      const mine = rosters.find(r => r.owner_id === S.userId);
      if (!mine) return;
      const numTeams = rosters.length;
      const detail = S.leagueDetails[lg.league_id];
      const playoffTeams = detail?.settings?.playoff_teams ?? Math.floor(numTeams / 2);
      // Sort by wins desc → points-for desc
      const sorted = [...rosters].sort((a, b) => {
        const wa = a.settings?.wins || 0, wb = b.settings?.wins || 0;
        if (wb !== wa) return wb - wa;
        const pfA = (a.settings?.fpts || 0) + (a.settings?.fpts_decimal || 0) / 100;
        const pfB = (b.settings?.fpts || 0) + (b.settings?.fpts_decimal || 0) / 100;
        return pfB - pfA;
      });
      const standing = sorted.findIndex(r => r.roster_id === mine.roster_id) + 1;
      const rosterPlayers = {}, rosterStats = {}, rosterOwners = {};
      for (const r of rosters) {
        rosterPlayers[r.roster_id] = r.players || [];
        rosterOwners[r.roster_id]  = r.owner_id || null;
        rosterStats[r.roster_id]   = {
          wins:  r.settings?.wins  || 0,
          fpts:  (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100,
          maxPf: sleeperMaxPf(r) || 0,  // Sleeper "potential points"
        };
      }
      // No potential points yet (Sleeper fills ppts in after scoring) → rank Max PF on PF.
      if (!Object.values(rosterStats).some(s => s.maxPf > 0)) {
        for (const s of Object.values(rosterStats)) s.maxPf = s.fpts;
      }
      const median = detail?.settings?.league_average_match === 1;
      const played = (mine.settings?.wins || 0) + (mine.settings?.losses || 0) + (mine.settings?.ties || 0);
      LS.leagueData[lg.league_id] = {
        standing, numTeams, playoffTeams,
        wins:   mine.settings?.wins   || 0,
        losses: mine.settings?.losses || 0,
        myRosterId: mine.roster_id,
        apWins: null, apLosses: null,
        rosterPlayers, rosterStats, rosterOwners,
        median,
        // Weeks already in the records — derived from the records themselves, not
        // the NFL calendar, so the sim can never re-simulate (or skip) a week that
        // Sleeper has or hasn't processed yet. A median league plays 2 games a week.
        banked: Math.round(played / (median ? 2 : 1)),
        weekly: {},
      };
    } catch(_) {}
  }));
  // Per-week results + all-play (Sleeper — ESPN builds its own in lsLoadEspnLeague
  // from the schedule it already fetched)
  await Promise.allSettled(S.leagues.map(async lg => {
    if (lg.source === 'espn') return;
    const d = LS.leagueData[lg.league_id];
    if (!d) return;
    d.weekly = await lsLoadWeekly(lg.league_id, d);
    lsApplyApTotals(d);
  }));
  lsRecapSnapshot();
}

// ESPN counterpart to the Sleeper branch above — populates LS.leagueData the
// same shape (standing/numTeams/playoffTeams/wins/losses/myRosterId/
// rosterPlayers/rosterStats) plus an `_espn` stash (settings + numeric league
// id) the playoff-odds simulation below needs. Rosters are matched to Sleeper
// player ids by name — same pattern as rsBuildRows()'s ESPN branch.
async function lsLoadEspnLeague(lg) {
  const espnId  = S.leagueDetails[lg.league_id]?._espnId;
  const season  = S.nflState?.season || new Date().getFullYear().toString();
  try {
    // mMatchupScore adds the whole season schedule (with scores) — all-play, the
    // weekly recap and the odds sim's future matchups all read it from one call.
    const r = await fetch(`/api/espn/fantasy/${espnId}?view=mRoster&view=mTeam&view=mSettings&view=mMatchupScore&seasonId=${season}`, { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    const mySWID = S.espnSettings?.swid || '';
    const teams  = d.teams || [];
    const myTeam = espnMyTeam(teams, mySWID);
    if (!myTeam) return;

    const numTeams     = teams.length;
    const playoffTeams = d.settings?.scheduleSettings?.playoffTeamCount ?? Math.floor(numTeams / 2);

    const sorted = [...teams].sort((a, b) => {
      const wa = a.record?.overall?.wins || 0, wb = b.record?.overall?.wins || 0;
      if (wb !== wa) return wb - wa;
      return (b.record?.overall?.pointsFor || 0) - (a.record?.overall?.pointsFor || 0);
    });
    const standing = sorted.findIndex(t => t.id === myTeam.id) + 1;

    const rosterPlayers = {}, rosterStats = {}, rosterNames = {};
    for (const t of teams) {
      // ESPN's modern shape is a single `name`; older payloads split it into
      // location + nickname. Scout renders these on its result cards — ESPN has
      // no /users endpoint to resolve a team id against the way Sleeper does.
      rosterNames[t.id] = t.name || [t.location, t.nickname].filter(Boolean).join(' ') || ('Team ' + t.id);
      const pids = [];
      for (const entry of (t.roster?.entries || [])) {
        const pl  = entry.playerPoolEntry?.playerPoolEntry?.player || entry.playerPoolEntry?.player;
        const pid = pl ? S._playersByName[normName(pl.fullName)] : null;
        if (pid) pids.push(pid);
      }
      rosterPlayers[t.id] = pids;
      rosterStats[t.id]   = {
        wins:  t.record?.overall?.wins || 0,
        fpts:  t.record?.overall?.pointsFor || 0,
        maxPf: t.record?.overall?.pointsFor || 0,  // ESPN exposes no potential points here — PF stands in
      };
    }

    const rec      = myTeam.record?.overall || {};
    const banked   = (rec.wins || 0) + (rec.losses || 0) + (rec.ties || 0);
    const schedule = d.schedule || [];
    const weekly   = {};
    for (let w = 1; w <= banked; w++) {
      const rows = [];
      for (const m of schedule) {
        if (m.matchupPeriodId !== w || !m.home) continue;
        const mid = m.away ? `${w}_${m.home.teamId}` : null;   // no away = bye
        rows.push({ rid: m.home.teamId, mid, pts: m.home.totalPoints || 0 });
        if (m.away) rows.push({ rid: m.away.teamId, mid, pts: m.away.totalPoints || 0 });
      }
      const res = lsWeekResult(rows, myTeam.id, false);
      if (res) weekly[w] = res;
    }

    LS.leagueData[lg.league_id] = {
      standing, numTeams, playoffTeams,
      wins:   rec.wins   || 0,
      losses: rec.losses || 0,
      myRosterId: myTeam.id,
      apWins: null, apLosses: null,
      rosterPlayers, rosterStats, rosterNames,
      median: false, banked, weekly,
      _espn: { id: espnId, settings: d.settings, schedule },
    };
    lsApplyApTotals(LS.leagueData[lg.league_id]);
  } catch (_) {}
}

// One week, one league, from my seat. `rows` = [{rid, mid, pts}] for every team
// (mid null = no opponent). Median leagues add a second game: top half wins.
// Returns null for a week that isn't scored for me yet.
function lsWeekResult(rows, myRid, median) {
  const mine = rows.find(r => r.rid === myRid);
  if (!mine || !(mine.pts > 0)) return null;
  const others = rows.filter(r => r.rid !== myRid);
  const opp = mine.mid != null ? others.find(r => r.mid === mine.mid) : null;
  const g = { pts: mine.pts, opp: opp ? opp.pts : null, w: 0, l: 0, t: 0, apW: 0, apL: 0, apT: 0 };
  if (opp) {
    if (mine.pts > opp.pts) g.w++; else if (mine.pts < opp.pts) g.l++; else g.t++;
  }
  for (const o of others) {
    if (mine.pts > o.pts) g.apW++; else if (mine.pts < o.pts) g.apL++; else g.apT++;
  }
  if (median && others.length) {
    if (g.apL < Math.floor(rows.length / 2)) g.w++; else g.l++;
  }
  return g;
}

async function lsLoadWeekly(lgId, d) {
  const weekly = {};
  const res = await Promise.allSettled(
    Array.from({ length: d.banked }, (_, i) => api('/league/' + lgId + '/matchups/' + (i + 1)))
  );
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) return;
    const rows = r.value.map(m => ({ rid: m.roster_id, mid: m.matchup_id ?? null, pts: m.points || 0 }));
    const g = lsWeekResult(rows, d.myRosterId, d.median);
    if (g) weekly[i + 1] = g;
  });
  return weekly;
}

function lsApplyApTotals(d) {
  const wks = Object.values(d.weekly || {});
  d.apWins   = wks.reduce((s, g) => s + g.apW, 0);
  d.apLosses = wks.reduce((s, g) => s + g.apL, 0);
}

// ── Playoff simulation (ported from analyzer.html) ───────────────────────────

// espnRosterPositionsFromSlotCounts / crFetchEspnSchedule /
// crEspnScheduleToMatchupsByWeek now live in shared-utils.js (analyzer.html's
// own ESPN odds sim needs them too). Thin wrapper kept here so existing call
// sites below don't need to change.
async function lsFetchEspnScheduleByWeek(espnLeagueId, weeks) {
  const schedule = await crFetchEspnSchedule('/api', espnLeagueId);
  return crEspnScheduleToMatchupsByWeek(schedule, weeks);
}

// Season-over fallback: final standings (wins → PF) and final max PF, as 1/0
// maps in the same shape runSimulation returns, so the Scout tab and the recap
// can read them without a live simulation.
function lsFinalStandings(d) {
  const teams = Object.entries(d.rosterStats || {}).map(([rid, s]) => ({ rosterId: Number(rid), ...s }));
  return finalStandingOdds(teams, d.playoffTeams);
}

// Clinched outright: fewer than `playoffTeams` rivals can still reach my win
// total even by winning out. A rival who could only TIE me still counts against
// me — ties break on points, which isn't guaranteed.
function lsClinched(d, regularSeasonWeeks) {
  const me = d.rosterStats?.[d.myRosterId];
  if (!me) return false;
  const left = Math.max(0, regularSeasonWeeks - d.banked) * (d.median ? 2 : 1);
  const catchers = Object.entries(d.rosterStats)
    .filter(([rid, s]) => Number(rid) !== d.myRosterId && s.wins + left >= me.wins).length;
  return catchers < d.playoffTeams;
}

// Writes a sim result onto the league entry (mine + every roster).
function lsApplyOdds(d, res) {
  d.playoffOdds    = res.odds?.[d.myRosterId] ?? null;
  d.byeOdds        = res.bye ? (res.bye[d.myRosterId] ?? null) : null;
  d.lastPfOdds     = res.lastPf?.[d.myRosterId] ?? null;
  d.allPlayoffOdds = res.odds;    // {rosterId: frac} — every team, for the Scout tab
  d.allByeOdds     = res.bye;
  d.allLastPfOdds  = res.lastPf;
}

// Keyed to banked weeks, so a new week of results invalidates it immediately
// instead of serving last week's odds for up to 24h.
function lsOddsCacheKey(lg, d, detail) {
  const season = S.nflState?.season || String(new Date().getFullYear());
  return `ls_odds_v2_${lg.league_id}_${season}_b${d.banked ?? 0}_w${lsRegularSeasonWeeks(lg, d, detail)}`;
}

// Regular-season-length lookup shared by lsRestoreOddsCache/lsSimulateAllLeagues —
// Sleeper: detail.settings.playoff_week_start - 1. ESPN: settings.scheduleSettings.
// matchupPeriodCount is already the regular-season week count directly (no -1).
function lsRegularSeasonWeeks(lg, d, detail) {
  return lg.source === 'espn'
    ? (d?._espn?.settings?.scheduleSettings?.matchupPeriodCount ?? 14)
    : (detail?.settings?.playoff_week_start ?? 15) - 1;
}

function lsReadOddsCache(lg, d, detail) {
  try {
    const cached = JSON.parse(localStorage.getItem(lsOddsCacheKey(lg, d, detail)) || 'null');
    if (cached && Date.now() - cached.ts < 24 * 3600 * 1000 && cached.odds) return cached;
  } catch (_) {}
  return null;
}

function lsRestoreOddsCache() {
  let anyRestored = false;
  for (const lg of S.leagues) {
    const d      = LS.leagueData[lg.league_id];
    const detail = S.leagueDetails[lg.league_id];
    if (!d || (lg.source !== 'espn' && !detail)) continue;
    const cached = lsReadOddsCache(lg, d, detail);
    if (cached) { lsApplyOdds(d, cached); anyRestored = true; }
  }
  if (anyRestored) {
    LS.oddsLoaded = true;
    lsRecapSnapshot();
  }
}

// Make sure League Summaries' per-roster odds (d.allPlayoffOdds) exist for these
// leagues — the one simulation, driven the way Scout drives it: lsLoadData for
// the inputs, the 24h localStorage cache reused, a re-sim only for what the
// cache didn't cover. Waits out a run already in flight (lsSimulateAllLeagues
// no-ops during one, so awaiting it directly would read as a failure). Returns
// '' on success, else a message. Used by Mass Offers and Player Finder.
async function lsEnsureOddsFor(lgIds) {
  const missing = () => lgIds.filter(id => !LS.leagueData[id]?.allPlayoffOdds).length;
  if (!LS.loaded) { await lsLoadData(); LS.loaded = true; }
  lsRestoreOddsCache();
  if (!missing()) return '';
  while (LS.oddsLoading) await new Promise(r => setTimeout(r, 500));
  lsRestoreOddsCache();
  if (missing()) { LS._oddsUseCache = true; await lsSimulateAllLeagues(); }
  return missing() ? (LS.oddsError || 'Playoff odds couldn’t be calculated for every league') : '';
}

async function lsSimulateAllLeagues() {
  if (LS.oddsLoading) return;
  LS.oddsLoading = true;
  LS.oddsError   = null;
  lsDrawTable();

  try {
    await loadPlayers();
    const nflSeason      = S.nflState?.season || String(new Date().getFullYear());

    // Collect unique future weeks across all leagues. Each league simulates from
    // its own banked weeks (what its records already include), not the calendar.
    const leagueInfos = [];
    for (const lg of S.leagues) {
      const d      = LS.leagueData[lg.league_id];
      const detail = S.leagueDetails[lg.league_id];
      if (!d || (lg.source !== 'espn' && !detail)) continue;
      const regularSeasonWeeks = lsRegularSeasonWeeks(lg, d, detail);
      const futureWeeks        = [];
      for (let w = (d.banked ?? 0) + 1; w <= regularSeasonWeeks; w++) futureWeeks.push(w);
      leagueInfos.push({ lg, lgId: lg.league_id, isEspn: lg.source === 'espn', d, detail, regularSeasonWeeks, futureWeeks });
    }

    const allFutureWeeks = [...new Set(leagueInfos.flatMap(li => li.futureWeeks))].sort((a, b) => a - b);

    // Fetch projections for each unique future week (shared across all leagues)
    let projectionsByWeek = {};
    if (allFutureWeeks.length > 0) {
      const projResults = await Promise.all(
        allFutureWeeks.map(w =>
          fetch(`/api/sleeper/projections/nfl/regular/${nflSeason}/${w}`)
            .then(r => { if (!r.ok) throw new Error(`projections week ${w} failed`); return r.json(); })
        )
      );
      allFutureWeeks.forEach((w, i) => { projectionsByWeek[w] = projResults[i] || {}; });

      // Validate projection data is non-empty
      const sampleProj = projResults.find(p => p && Object.keys(p).length > 0);
      if (!sampleProj) throw new Error('No projection data available — try again once the season begins');
    }

    // Per league: fetch future matchup schedules and run simulation
    await Promise.allSettled(leagueInfos.map(async ({ lg, lgId, isEspn, d, detail, regularSeasonWeeks, futureWeeks }) => {
      try {
        // Recalculate always re-runs; the cache only saves work within one run
        // (e.g. the ESPN backfill re-running for just the late leagues).
        const cached = LS._oddsUseCache ? lsReadOddsCache(lg, d, detail) : null;
        if (cached) { lsApplyOdds(d, cached); return; }

        if (futureWeeks.length === 0) {
          // Season is over — standings are final
          lsApplyOdds(d, lsFinalStandings(d));
          return;
        }

        // Fetch the future-weeks schedule structure (who plays whom). Sleeper
        // has one endpoint per week; ESPN returns the whole season in one call
        // (already fetched by lsLoadEspnLeague).
        let matchupsByWeek;
        if (isEspn) {
          matchupsByWeek = d._espn.schedule?.length
            ? crEspnScheduleToMatchupsByWeek(d._espn.schedule, futureWeeks)
            : await lsFetchEspnScheduleByWeek(d._espn.id, futureWeeks);
        } else {
          const matchupResults = await Promise.all(
            futureWeeks.map(w =>
              api('/league/' + lgId + '/matchups/' + w)
                .then(r => { if (!r) throw new Error(`matchups week ${w} unavailable`); return r; })
            )
          );
          matchupsByWeek = {};
          futureWeeks.forEach((w, i) => { matchupsByWeek[w] = matchupResults[i] || []; });
        }

        const scoringSettings = isEspn
          ? crParseEspnScoring(d._espn.settings).scoring
          : (detail.scoring_settings || {});
        const rosterPositions = isEspn
          ? espnRosterPositionsFromSlotCounts(d._espn.settings?.rosterSettings?.lineupSlotCounts)
          : (detail.roster_positions || []);

        // Build teams list using roster standings already stored from lsLoadData
        const teams = Object.entries(d.rosterStats).map(([ridStr, stats]) => ({
          rosterId: Number(ridStr),
          wins:     stats.wins,
          fpts:     stats.fpts,
          maxPf:    stats.maxPf,
        }));

        // Build mu/sigma per roster per future week from projections
        const muMap = {}, sigmaMap = {};
        for (const [ridStr, playerIds] of Object.entries(d.rosterPlayers)) {
          const rid = Number(ridStr);
          muMap[rid] = {}; sigmaMap[rid] = {};
          for (const week of futureWeeks) {
            const { mu, sigma } = optimalLineupAndSigma(
              playerIds, projectionsByWeek[week] || {}, scoringSettings, rosterPositions, S.players
            );
            muMap[rid][week] = mu;
            sigmaMap[rid][week] = sigma;
          }
        }

        // Validate: if all mus are near zero, projections are empty for this league
        const avgMu = teams.reduce((s, t) =>
          s + futureWeeks.reduce((ws, w) => ws + (muMap[t.rosterId]?.[w] ?? 0), 0), 0
        ) / Math.max(1, teams.length * futureWeeks.length);
        if (avgMu < 20) throw new Error('Projection data empty for this league');

        // Mirrors analyzer.html's '[Analyzer odds] week accounting' log — the two
        // pages run the same sim, so when their numbers disagree for a league
        // these are the inputs to compare first.
        console.log('[playoff odds] week accounting', {
          lgId, name: lg.name, regularSeasonWeeks, median: d.median,
          bankedWeeks: d.banked, futureWeeks,
          playoffTeams: d.playoffTeams, numTeams: d.numTeams, teams: teams.length,
        });

        const res = runSimulation(teams, matchupsByWeek, muMap, sigmaMap, futureWeeks, d.playoffTeams, { median: d.median });
        lsApplyOdds(d, res);
        delete d.playoffOddsError;

        try {
          localStorage.setItem(lsOddsCacheKey(lg, d, detail), JSON.stringify({ ts: Date.now(), ...res }));
        } catch (_) {}
      } catch (e) {
        d.playoffOddsError = e.message;
        console.error(`[playoff odds] ${lgId}:`, e);
      }
    }));

  } catch (e) {
    LS.oddsError = e.message;
  }

  LS.oddsLoading   = false;
  LS.oddsLoaded    = true;
  LS._oddsUseCache = false;
  lsRecapSnapshot();
  // ESPN leagues that finished loading mid-run missed it — run again for them
  // (everything else comes straight back out of the cache just written).
  if (LS._oddsRerun) {
    LS._oddsRerun = false;
    LS._oddsUseCache = true;
    return lsSimulateAllLeagues();
  }
  lsDrawTable();
}

function lsPlayoffChancesLabel(standing, numTeams) {
  if (standing <= 2) return { label: 'Virtual Lock',          cls: 'ls-chance-vl'    };
  if (standing <= 4) return { label: 'Looking Good',          cls: 'ls-chance-lg'    };
  if (numTeams >= 13) {
    if (standing <= 10) return { label: 'Nervy',              cls: 'ls-chance-nervy' };
    return               { label: 'Better Luck Next Year',    cls: 'ls-chance-blny'  };
  }
  if (standing <= 8)  return { label: 'Nervy',               cls: 'ls-chance-nervy' };
  return               { label: 'Better Luck Next Year',     cls: 'ls-chance-blny'  };
}

// ── Projection-scored roster helper ───────────────────────────────────────────
// Builds the ctx the shared crScoreRoster() wants. Its only caller now is the
// guillotine Power Score — the Contender Rank column this was written for has
// been removed (playoff odds answer the same question without depending on ADP,
// which moves around too much to compare leagues with).

function lsProjScoreCtx(league) {
  const pd = LS.projData;
  return {
    mode:            'projections',
    players:         S.players,
    clayMap:         pd.clayMap,
    sleeperProjMap:  pd.sleeperProjMap,
    userProjMap:     pd.userProjMap,
    scoring:         league.scoring_settings || {},
    rosterPositions: league.roster_positions || [],
  };
}

async function lsLoadProjData() {
  const pd = LS.projData;
  if (pd.loaded || pd.loading) return;
  pd.loading = true;
  pd.clayMap = {}; pd.sleeperProjMap = {}; pd.userProjMap = {};

  await loadPlayers(); // ensure S.players and S._playersByName are ready

  const season = S.nflState?.season || new Date().getFullYear();
  const { clayMap, sleeperProjMap, userProjMap } = await crLoadProjectionData({
    apiBase: '/api', season, authed: !!S.auth, byName: S._playersByName,
  });
  pd.clayMap = clayMap;
  pd.sleeperProjMap = sleeperProjMap;
  pd.userProjMap = userProjMap;

  pd.loaded  = true;
  pd.loading = false;
}

// ── Guillotine (elimination) league simulation ───────────────────────────────
// Sleeper league types: 0=redraft, 1=keeper, 2=dynasty. 3 is Sleeper's native
// elimination/guillotine format (settings.disable_elimination toggles the
// mechanic off, but type===3 is the reliable detector). Format: every week
// the lowest scorer is cut and their roster hits waivers; this repeats until
// GZ_FINAL_TEAMS remain entering week GZ_CUTOVER_WEEK, then the survivors'
// scores are summed over GZ_FINALE_WEEKS to crown a champion.
//
// There's no closed-form odds formula for sequential lowest-score elimination
// once teams have unequal/evolving strength, so this runs a Monte Carlo sim
// (same technique as bracket/survivor-pool calculators): draw a Gaussian score
// per team per remaining week, cut the lowest, repeat; tally outcomes over
// GZ_SIM_N trials.
//
// NOTE: "alive" detection (lsGzIsAlive) is a best guess made before any real
// elimination has happened this season (Sleeper is believed to empty a cut
// team's roster rather than remove it from /rosters, but that's unconfirmed).
// Re-verify against real data once Week 1 resolves and the first team is cut.
function lsIsGuillotine(lgId) {
  return S.leagueDetails[lgId]?.settings?.type === 3;
}

const GZ_FINAL_TEAMS      = 4;    // teams remaining when the finale starts
const GZ_CUTOVER_WEEK     = 15;   // finale = weeks 15–17, 3-week cumulative score
const GZ_FINALE_WEEKS     = 3;
const GZ_SIM_N            = 5000;
const GZ_DEFAULT_SIGMA_CV = 0.30; // weekly score stdev as a fraction of mean, until real weeks narrow it
const GZ_FAAB_COEF        = 0.20; // how strongly relative FAAB reserve nudges projected mean — kept small & bounded

function lsGzIsAlive(roster) {
  return !!(roster?.players && roster.players.length > 0);
}

// Fetches rosters/users/matchup history for a guillotine league and derives,
// per team: alive/weeks-survived, power score (crScoreRoster forced
// to projections mode, so it's on the same real-point scale as actual fpts),
// and FAAB reserve. Does not run the simulation — see lsGzCalculate().
async function lsGzComputeLeague(lgId) {
  const detail = S.leagueDetails[lgId];
  if (!detail) throw new Error('League details not loaded');
  const currentWeek  = S.nflState?.week || 1;
  const weeksElapsed = Math.max(0, currentWeek - 1);

  const [rosters, users] = await Promise.all([
    api('/league/' + lgId + '/rosters'),
    api('/league/' + lgId + '/users'),
  ]);
  if (!rosters?.length) throw new Error('No rosters returned');
  const uMap = Object.fromEntries((users || []).map(u =>
    [u.user_id, u.metadata?.team_name || u.display_name || u.username]));

  // Walk past weeks' matchups for each roster's realized scores, used both to
  // infer weeks-survived and to blend actual performance into the projection.
  // Treat a 0-point week as "not active" (already cut) rather than a real
  // scored week — unconfirmed until a real elimination has happened, see note above.
  const scoresByRoster = {};
  for (const r of rosters) scoresByRoster[r.roster_id] = [];
  const weekResults = await Promise.allSettled(
    Array.from({ length: weeksElapsed }, (_, i) => api('/league/' + lgId + '/matchups/' + (i + 1)))
  );
  for (const res of weekResults) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const m of res.value) {
      if (!(m.points > 0)) continue;
      (scoresByRoster[m.roster_id] = scoresByRoster[m.roster_id] || []).push(m.points);
    }
  }

  // Sleeper projections only for guillotine Power Score (per-request) — zeroing
  // out clayMap/userProjMap makes crPlayerPpg() fall through to sleeperProjMap
  // alone without touching the shared crScoreRoster formula.
  const ctx = { ...lsProjScoreCtx(detail), clayMap: {}, userProjMap: {} };
  const totalBudget = detail.settings?.waiver_budget || 0;

  const aliveRosters = rosters.filter(lsGzIsAlive);
  const remainingFaab = r => Math.max(0, totalBudget - (r.settings?.waiver_budget_used || 0));
  const avgRemainingFaab = aliveRosters.length
    ? aliveRosters.reduce((s, r) => s + remainingFaab(r), 0) / aliveRosters.length
    : 0;

  return rosters.map(r => {
    const alive         = lsGzIsAlive(r);
    const weeksSurvived = (scoresByRoster[r.roster_id] || []).length;
    const powerScore     = crScoreRoster(r.players || [], ctx); // per-game, real scoring points
    const actualFpts      = (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100;
    const actualPpg        = weeksSurvived > 0 ? actualFpts / weeksSurvived : 0;
    const blendW           = Math.min(weeksSurvived / 6, 1); // shift toward realized average as the season goes
    const mu                = alive ? (powerScore * (1 - blendW) + actualPpg * blendW) : 0;
    const sigma              = Math.max(6, mu * GZ_DEFAULT_SIGMA_CV);

    const faabRemaining = remainingFaab(r);
    const faabPct        = totalBudget > 0 ? faabRemaining / totalBudget : null;
    const faabEdge         = totalBudget > 0 && alive
      ? Math.max(-0.15, Math.min(0.15, (faabRemaining - avgRemainingFaab) / totalBudget))
      : 0;

    return {
      rosterId: r.roster_id,
      teamName: uMap[r.owner_id] || ('Team ' + r.roster_id),
      alive, weeksSurvived,
      powerScore, faabRemaining, faabPct,
      mu: mu * (1 + GZ_FAAB_COEF * faabEdge),
      sigma,
    };
  });
}

// Draws a Gaussian score per alive team each remaining elimination week, cuts
// the lowest, repeats until GZ_FINAL_TEAMS remain (or scheduled elimination
// weeks run out); then sums GZ_FINALE_WEEKS more drawn scores among whoever's
// left and ranks by total. Returns {rosterId: {surviveWeekPct, advanceFinalPct, championPct}}.
function lsRunGuillotineSimulation(rows, weeksRemaining, N = GZ_SIM_N) {
  const alive = rows.filter(r => r.alive);
  const surviveWeek = {}, advanceFinal = {}, champion = {};
  for (const r of alive) { surviveWeek[r.rosterId] = 0; advanceFinal[r.rosterId] = 0; champion[r.rosterId] = 0; }
  if (!alive.length) return {};

  for (let sim = 0; sim < N; sim++) {
    let pool = alive.map(r => ({ rosterId: r.rosterId, mu: r.mu, sigma: r.sigma }));
    let firstWeekDone = false;

    for (let w = 0; w < weeksRemaining && pool.length > GZ_FINAL_TEAMS; w++) {
      const scored = pool.map(t => ({ t, s: gaussianRandom(t.mu, t.sigma) }))
        .sort((a, b) => a.s - b.s); // ascending: lowest score first
      const cutId = scored[0].t.rosterId;
      if (!firstWeekDone) {
        for (const { t } of scored) if (t.rosterId !== cutId) surviveWeek[t.rosterId]++;
        firstWeekDone = true;
      }
      pool = pool.filter(t => t.rosterId !== cutId);
    }
    if (!firstWeekDone) for (const t of pool) surviveWeek[t.rosterId]++; // already at/under final-4, no cuts left to make

    for (const t of pool) advanceFinal[t.rosterId]++;

    const totals = {};
    for (const t of pool) {
      let sum = 0;
      for (let f = 0; f < GZ_FINALE_WEEKS; f++) sum += gaussianRandom(t.mu, t.sigma);
      totals[t.rosterId] = sum;
    }
    let bestId = null, bestVal = -Infinity;
    for (const [rid, v] of Object.entries(totals)) if (v > bestVal) { bestVal = v; bestId = Number(rid); }
    if (bestId != null) champion[bestId]++;
  }

  const out = {};
  for (const r of alive) {
    out[r.rosterId] = {
      surviveWeekPct:  surviveWeek[r.rosterId]  / N,
      advanceFinalPct: advanceFinal[r.rosterId] / N,
      championPct:     champion[r.rosterId]     / N,
    };
  }
  return out;
}

async function lsGzCalculate(lgId) {
  const gz = LS.gz[lgId] || (LS.gz[lgId] = {});
  if (gz.loading) return;
  gz.loading = true;
  gz.error = null;
  lsDrawTable();
  try {
    await lsLoadProjData(); // ensures clay/sleeper/user projection maps are cached
    const currentWeek     = S.nflState?.week || 1;
    const weeksRemaining   = Math.max(0, GZ_CUTOVER_WEEK - currentWeek);
    const rows             = await lsGzComputeLeague(lgId);
    const odds             = lsRunGuillotineSimulation(rows, weeksRemaining);
    for (const r of rows) Object.assign(r, odds[r.rosterId] || {});
    gz.rows           = rows.sort((a, b) => (b.championPct ?? -1) - (a.championPct ?? -1) || (b.mu - a.mu));
    gz.computedAtWeek = currentWeek;
    gz.loaded         = true;
  } catch (e) {
    gz.error = e.message;
  }
  gz.loading = false;
  lsDrawTable();
}

function lsGzSection() {
  const gzLeagues = S.leagues.filter(lg => lsIsGuillotine(lg.league_id));
  if (!gzLeagues.length) return '';

  const pct = v => v == null ? '—' : Math.round(v * 100) + '%';
  const hue = v => v == null ? 0 : Math.round(v * 120); // 0=red, 120=green

  const cards = gzLeagues.map(lg => {
    const gz = LS.gz[lg.league_id] || {};
    let body;
    if (gz.loading) {
      body = loading('Simulating eliminations…');
    } else if (gz.error) {
      body = `<div style="color:#c0392b;font-size:0.85rem;margin-bottom:8px;">${esc(gz.error)}</div>
        <button class="ghost-btn" onclick="lsGzCalculate('${lg.league_id}')">Retry</button>`;
    } else if (!gz.loaded) {
      body = `<button class="setup-btn" onclick="lsGzCalculate('${lg.league_id}')">Calculate Elimination Odds</button>`;
    } else {
      const trs = (gz.rows || []).map(r => {
        if (!r.alive) {
          return `<tr style="opacity:0.5;">
            <td>${esc(r.teamName)}</td>
            <td colspan="5"><span class="badge badge-red">Eliminated${r.weeksSurvived ? ' — Week ' + r.weeksSurvived : ''}</span></td>
          </tr>`;
        }
        return `<tr>
          <td>${esc(r.teamName)}</td>
          <td>${r.powerScore.toFixed(1)}</td>
          <td>${r.faabPct != null ? Math.round(r.faabPct * 100) + '%' : '—'}<span style="font-size:0.7rem;color:var(--brown-light);"> ($${r.faabRemaining})</span></td>
          <td><span style="color:hsl(${hue(r.surviveWeekPct)},70%,38%)">${pct(r.surviveWeekPct)}</span></td>
          <td><span style="color:hsl(${hue(r.advanceFinalPct)},70%,38%)">${pct(r.advanceFinalPct)}</span></td>
          <td><span style="color:hsl(${hue(r.championPct)},70%,38%)">${pct(r.championPct)}</span></td>
        </tr>`;
      }).join('');
      body = `
        <div style="overflow-x:auto;">
        <table class="ls-table">
          <thead><tr>
            <th>Team</th><th>Power Score</th><th>FAAB Left</th>
            <th>Survive This Week</th><th>Advance to Final 4</th><th>Championship</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
        </div>
        <button class="ghost-btn" style="margin-top:8px;" onclick="lsGzCalculate('${lg.league_id}')">↺ Recalculate</button>`;
    }
    return `
      <div style="margin-top:20px;">
        <div class="section-head"><h2>${esc(lg.name || 'Unnamed')} <span style="font-family:'Crimson Text',serif;font-size:0.7rem;font-weight:400;text-transform:none;letter-spacing:0;color:var(--brown-light);">— Guillotine</span></h2><div class="section-head-line"></div></div>
        ${body}
      </div>`;
  }).join('');

  return `
    <div class="section-head" style="margin-top:36px;"><h2>Guillotine Leagues</h2><div class="section-head-line"></div></div>
    <p style="font-size:0.82rem;color:var(--brown-light);max-width:640px;margin:0 0 4px;">
      Lowest scorer is cut each week until ${GZ_FINAL_TEAMS} teams remain entering Week ${GZ_CUTOVER_WEEK};
      the final ${GZ_FINALE_WEEKS} weeks are decided by cumulative score. Odds are Monte Carlo estimates, not guarantees.
    </p>
    ${cards}
  `;
}


// Higher key = better team. sortDir 1 (a column's first click) = best first,
// or A-Z for the name column. Rows with no value sink to the bottom either way.
const LS_SORT_KEYS = {
  standing:  r => r.hasData ? -r.standing : null,
  record:    r => r.hasData && (r.wins + r.losses) ? r.wins / (r.wins + r.losses) + r.wins * 1e-4 : null,
  allplay:   r => r.apWins != null && (r.apWins + r.apLosses) ? r.apWins / (r.apWins + r.apLosses) : null,
  // No odds yet → below every league that has them, in standing order
  chances:   r => r.playoffOdds != null ? r.playoffOdds : (r.hasData ? -1 - r.standing / 1000 : null),
};

function lsSortRows(rows) {
  if (!LS.sortCol) return rows;   // already in S.leagues (Sleeper) order
  const key = LS_SORT_KEYS[LS.sortCol];
  return [...rows].sort((a, b) => {
    if (LS.sortCol === 'name') return a.name.localeCompare(b.name) * LS.sortDir;
    const ka = key(a), kb = key(b);
    if (ka == null || kb == null) return ((ka == null) - (kb == null)) || a.name.localeCompare(b.name);
    return ((kb - ka) * LS.sortDir) || a.name.localeCompare(b.name);
  });
}

function lsSetFilter(f) {
  LS.filter = f;
  lsDrawTable();
}

function lsOnSearch() {
  const inp = document.getElementById('ls-search');
  const pos = inp ? inp.selectionStart : null;
  LS.search = inp?.value || '';
  lsDrawTable();
  const inp2 = document.getElementById('ls-search');
  if (inp2) {
    inp2.focus();
    if (pos != null) inp2.setSelectionRange(pos, pos);
  }
}

function lsSort(col) {
  LS.sortDir = LS.sortCol === col ? LS.sortDir * -1 : 1;
  LS.sortCol = col;
  lsDrawTable();
}

// ── Weekly Recap ──────────────────────────────────────────────────────────────
// Record / all-play / margin are recomputed live from d.weekly for any week.
// The forward-looking half (playoff/bye/last-in-max-PF odds, clinched) can't be —
// rosters and schedules move on — so it's snapshotted per completed week into
// localStorage whenever odds exist while that week is the latest result, and a
// past week's card reads the snapshot back.

const RC_HEADLINES = [[0.75, 'Gold Rush'], [0.6, 'Striking Gold'], [0.5, 'Holding the Fort'], [0.4, 'Dust Storm'], [0, 'Rough Ride']];

function lsRecapKey() {
  const season = S.nflState?.season || String(new Date().getFullYear());
  return `ls_recap_v1_${S.userId}_${season}`;
}
function lsRecapStore() {
  try { return JSON.parse(localStorage.getItem(lsRecapKey()) || '{}') || {}; } catch (_) { return {}; }
}

// Regular season only — once playoffs start there's no "from here on out" left.
function lsRecapInSeason(lg) {
  const d = LS.leagueData[lg.league_id];
  if (!d || !d.banked || lsIsGuillotine(lg.league_id)) return false;
  return d.banked <= lsRegularSeasonWeeks(lg, d, S.leagueDetails[lg.league_id]);
}

function lsRecapSnapshot() {
  if (!S.userId) return;
  const store = lsRecapStore();
  let dirty = false;
  for (const lg of S.leagues) {
    if (!lsRecapInSeason(lg)) continue;
    const d    = LS.leagueData[lg.league_id];
    const wk   = store[d.banked] || (store[d.banked] = {});
    const prev = wk[lg.league_id] || {};
    const snap = {
      clinched: lsClinched(d, lsRegularSeasonWeeks(lg, d, S.leagueDetails[lg.league_id])),
      hasBye:   bracketByeSlots(d.playoffTeams) > 0,
      po:   d.playoffOdds ?? prev.po   ?? null,
      bye:  d.byeOdds     ?? prev.bye  ?? null,
      // ESPN leagues are redraft — no draft-pick stakes in finishing last, so they
      // stay out of the Max PF watch (explicit null also clears older snapshots).
      last: lg.source === 'espn' ? null : (d.lastPfOdds ?? prev.last ?? null),
    };
    if (JSON.stringify(prev) !== JSON.stringify(snap)) { wk[lg.league_id] = snap; dirty = true; }
  }
  if (dirty) { try { localStorage.setItem(lsRecapKey(), JSON.stringify(store)); } catch (_) {} }
}

function lsRecapNeedsOdds() {
  return S.leagues.some(lg => {
    if (!lsRecapInSeason(lg)) return false;
    const d = LS.leagueData[lg.league_id];
    return d.playoffOdds == null && !d.playoffOddsError;
  });
}

// Contender / rebuilder for filtering — straight from Root For Me (Sleeper and
// ESPN alike); an untagged league is neither. Guillotine leagues are excluded by callers.
function lsLeagueRole(lgId) {
  const pref = RS.prefs[lgId];
  if (pref?.contender === true)  return 'contender';
  if (pref && pref.contender === false) return 'rebuilder';
  return null;
}

function lsRecapMatches(lg) {
  const R = LS.recap, id = lg.league_id;
  if (R.fmt !== 'all' && rsLeagueCategory(id) !== R.fmt) return false;
  if (R.role !== 'all' && lsLeagueRole(id) !== R.role) return false;
  const type = S.leagueDetails[id]?.settings?.best_ball === 1 ? 'bestball' : 'lineup';
  if (R.lineup !== 'all' && type !== R.lineup) return false;
  return true;
}

function lsRecapSet(key, val) {
  LS.recap[key] = val;
  lsDrawTable();
}

// cumulative: every scored week ≤ `week`; otherwise just `week`.
function lsRecapTally(leagues, week, cumulative, snaps) {
  const t = { n: 0, w: 0, l: 0, t: 0, apW: 0, apL: 0, apT: 0, marg: [],
              po: [0, 0], bye: [0, 0], clinched: [0, 0], last: [0, 0] };
  for (const lg of leagues) {
    const weekly = LS.leagueData[lg.league_id]?.weekly || {};
    const games  = cumulative
      ? Object.entries(weekly).filter(([w]) => Number(w) <= week).map(([, g]) => g)
      : (weekly[week] ? [weekly[week]] : []);
    if (!games.length) continue;
    t.n++;
    for (const g of games) {
      t.w += g.w; t.l += g.l; t.t += g.t;
      t.apW += g.apW; t.apL += g.apL; t.apT += g.apT;
      if (g.opp != null) t.marg.push(g.pts - g.opp);
    }
    const s = snaps?.[lg.league_id];
    if (!s) continue;
    t.clinched[1]++; if (s.clinched) t.clinched[0]++;
    if (s.po != null)                { t.po[1]++;   if (s.po   > 0.5) t.po[0]++;   }
    if (s.hasBye && s.bye != null)   { t.bye[1]++;  if (s.bye  > 0.3) t.bye[0]++;  }
    if (s.last != null)              { t.last[1]++; if (s.last > 0.3) t.last[0]++; }
  }
  return t;
}

function lsRecapCard(t, { kicker, scope, cumulative, oddsNote }) {
  if (!t.n) {
    return `<div class="rc-card">
      <div class="rc-kicker">${kicker}</div>
      <div class="rc-headline">Quiet Out West</div>
      <div class="rc-scope">${scope}</div>
      <div class="rc-foot">No league in this scope has a scored game ${cumulative ? 'yet' : 'this week'}.</div>
    </div>`;
  }
  const fmt3 = p => p >= 1 ? '1.000' : p.toFixed(3).replace(/^0/, '');
  const rec  = (w, l, tt) => `${w}–${l}${tt ? '–' + tt : ''}`;
  const bar  = (w, l, tt) => {
    const n = (w + l + tt) || 1;
    return `<div class="rc-bar"><span class="w" style="width:${w / n * 100}%"></span><span class="t" style="width:${tt / n * 100}%"></span><span class="l" style="width:${l / n * 100}%"></span></div>`;
  };
  const games  = t.w + t.l + t.t;
  const pct    = games ? (t.w + t.t / 2) / games : 0;
  const apN    = t.apW + t.apL + t.apT;
  const apPct  = apN ? (t.apW + t.apT / 2) / apN : 0;
  const avg    = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  const mAll   = avg(t.marg);
  const mWin   = avg(t.marg.filter(v => v > 0));
  const mLoss  = avg(t.marg.filter(v => v < 0));
  const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
  const head   = RC_HEADLINES.find(([min]) => pct >= min)[1];
  const stampColor = pct >= 0.5 ? 'var(--green-light)' : 'var(--red)';

  const meter = (label, [hit, of], sub, bad) => {
    if (!of) return `<div><div class="rc-stat-lbl">${label}</div><div class="rc-mid">—</div><div class="rc-sub">${sub}</div></div>`;
    const p = Math.round(hit / of * 100);
    return `<div>
      <div class="rc-stat-lbl">${label}</div>
      <div class="rc-mid">${p}% <span class="rc-sub">${hit} of ${of}</span></div>
      <div class="rc-bar"><span class="fill${bad ? ' bad' : ''}" style="width:${p}%"></span></div>
      <div class="rc-sub">${sub}</div>
    </div>`;
  };

  return `<div class="rc-card">
    <div class="rc-stamp" style="color:${stampColor}"><b>${fmt3(pct)}</b><span>Win Pct</span></div>
    <div class="rc-kicker">${kicker}</div>
    <div class="rc-headline">${head}</div>
    <div class="rc-scope">${scope} — ${t.n} league${t.n === 1 ? '' : 's'}</div>

    <div class="rc-rule">${cumulative ? 'Season to Date' : 'The Week'}</div>
    <div class="rc-row">
      <div>
        <div class="rc-stat-lbl">Record</div>
        <div class="rc-big">${rec(t.w, t.l, t.t)}</div>
        ${bar(t.w, t.l, t.t)}
      </div>
      <div>
        <div class="rc-stat-lbl">All-Play</div>
        <div class="rc-mid">${rec(t.apW, t.apL, t.apT)}</div>
        ${bar(t.apW, t.apL, t.apT)}
        <div class="rc-sub">${fmt3(apPct)}</div>
      </div>
      <div>
        <div class="rc-stat-lbl">Avg Margin</div>
        <div class="rc-mid ${mAll > 0 ? 'rc-pos' : mAll < 0 ? 'rc-neg' : ''}">${mAll == null ? '—' : signed(mAll)}</div>
        <div class="rc-sub">${mWin != null ? `W by ${mWin.toFixed(1)}` : ''}${mWin != null && mLoss != null ? ' · ' : ''}${mLoss != null ? `L by ${Math.abs(mLoss).toFixed(1)}` : ''}</div>
      </div>
    </div>

    <div class="rc-rule">From Here On Out</div>
    <div class="rc-row4">
      ${meter('Playoff Odds &gt; 50%', t.po, 'of leagues simulated')}
      ${meter('Bye Odds &gt; 30%', t.bye, 'of leagues with byes')}
      <div>
        <div class="rc-stat-lbl">Clinched Playoffs</div>
        <div class="rc-mid">${t.clinched[1] ? t.clinched[0] : '—'} ${t.clinched[1] ? `<span class="rc-sub">of ${t.clinched[1]}</span>` : ''}</div>
        <div class="rc-sub">mathematically locked in</div>
      </div>
      ${meter('Last in Max PF &gt; 30%', t.last, 'the rebuilder watch', true)}
    </div>
    ${oddsNote ? `<div class="rc-foot">${oddsNote}</div>` : ''}
  </div>`;
}

function lsRecapHtml() {
  const head = `<div class="section-head" style="margin-bottom:10px;"><h2>Weekly Recap</h2><div class="section-head-line"></div></div>`;
  const pool = S.leagues.filter(lg => !lsIsGuillotine(lg.league_id) && LS.leagueData[lg.league_id]);
  const maxWeek = Math.max(0, ...pool.flatMap(lg => Object.keys(LS.leagueData[lg.league_id].weekly || {}).map(Number)));
  if (!maxWeek) return `<div class="rc-wrap">${head}<div class="rc-empty">The first recap posts once Week 1 is final.</div></div>`;

  const W = Math.min(LS.recap.week ?? maxWeek, maxWeek);
  const roles = new Set(pool.map(lg => lsLeagueRole(lg.league_id)));
  const controls = LEAGUE_SCOPE_FILTERS.map(f => `<div class="ls-mode-bar">
    <span class="ls-mode-label">${f.lbl}</span>
    ${f.opts.map(([v, l]) => {
      const off = f.key === 'role' && v !== 'all' && !roles.has(v);
      return `<button class="ls-mode-pill${LS.recap[f.key] === v ? ' active' : ''}" onclick="lsRecapSet('${f.key}','${v}')"${off ? ' disabled title="Fill out Root For Me first"' : ''}>${l}</button>`;
    }).join('')}
  </div>`).join('');
  // The latest week is stored as null so the view rolls forward when a new week posts.
  const weeks = Array.from({ length: maxWeek }, (_, i) => i + 1).map(w =>
    `<button class="ls-mode-pill rc-week-pill${w === W ? ' active' : ''}" onclick="lsRecapSet('week',${w === maxWeek ? 'null' : w})">Wk ${w}</button>`
  ).join('');

  const scopeParts = LEAGUE_SCOPE_FILTERS.map(f => LS.recap[f.key] === 'all' ? null : f.opts.find(o => o[0] === LS.recap[f.key])[1]).filter(Boolean);
  const scope   = scopeParts.length ? scopeParts.join(' · ') : 'Every league';
  const leagues = pool.filter(lsRecapMatches);
  const snaps   = lsRecapStore()[W] || null;

  let oddsNote = '';
  if (!snaps || !Object.values(snaps).some(s => s.po != null)) {
    oddsNote = W !== maxWeek
      ? `No odds were run while Week ${W} was the latest result, so its outlook wasn't saved.`
      : LS.oddsLoading
        ? 'Simulating the rest of the season…'
        : `Outlook not calculated yet — <button onclick="lsSimulateAllLeagues()">run the odds</button>.`;
  } else {
    oddsNote = `Outlook as of the end of Week ${W}: banked records + a simulated rest of season.`;
  }

  const weekly = lsRecapTally(leagues, W, false, snaps);
  const cum    = lsRecapTally(leagues, W, true, snaps);
  return `<div class="rc-wrap">
    ${head}
    <div class="rc-controls">${controls}</div>
    <div class="rc-weeks"><span class="ls-mode-label">Week</span>${weeks}</div>
    <div class="rc-cards">
      ${lsRecapCard(weekly, { kicker: `Week ${W} Dispatch`, scope, cumulative: false, oddsNote })}
      ${lsRecapCard(cum,    { kicker: `Season Ledger · Thru Week ${W}`, scope, cumulative: true, oddsNote })}
    </div>
  </div>`;
}

function lsDrawTable() {
  // lsSimulateAllLeagues() redraws as it progresses; when the Scout tab drives
  // the simulation there is no Summaries table on screen.
  if (S.tab !== 'leagues') return;
  const roles = new Set(S.leagues.filter(lg => !lsIsGuillotine(lg.league_id)).map(lg => lsLeagueRole(lg.league_id)));

  // Build rows (guillotine leagues get their own section below — standing/record/
  // playoff-chances/all-play don't mean anything under elimination rules)
  let rows = S.leagues.filter(lg => !lsIsGuillotine(lg.league_id)).map(lg => {
    const d    = LS.leagueData[lg.league_id];
    const pref = RS.prefs[lg.league_id];
    return {
      lgId:       lg.league_id,
      name:       lg.name || 'Unnamed',
      prefContender: pref?.contender === true,   // explicit Root For Me pick — drives the gold name
      role:       lsLeagueRole(lg.league_id),    // redraft = contender; drives the filter
      hasData:    !!d,
      standing:   d?.standing   ?? 999,
      numTeams:   d?.numTeams   ?? 0,
      playoffTeams: d?.playoffTeams ?? 0,
      wins:       d?.wins       ?? 0,
      losses:     d?.losses     ?? 0,
      apWins:          d?.apWins,
      apLosses:        d?.apLosses,
      playoffOdds:     d?.playoffOdds,
      byeOdds:         d?.byeOdds,
      playoffOddsError: d?.playoffOddsError,
    };
  });

  // Apply filter
  if (LS.filter === 'contenders') rows = rows.filter(r => r.role === 'contender');
  if (LS.filter === 'rebuilders') rows = rows.filter(r => r.role === 'rebuilder');
  if (LS.search) {
    const q = LS.search.toLowerCase();
    rows = rows.filter(r => r.name.toLowerCase().includes(q));
  }

  rows = lsSortRows(rows);

  // Arrow shows the visual order: A-Z reads ↑, best-first reads ↓.
  const arr = (col) => {
    if (LS.sortCol !== col) return '<span class="ls-arr">⇅</span>';
    const natural = col === 'name' ? '↑' : '↓', reversed = col === 'name' ? '↓' : '↑';
    return `<span class="ls-arr">${LS.sortDir === 1 ? natural : reversed}</span>`;
  };
  const thCls = (col) => LS.sortCol === col ? 'ls-sorted' : '';

  const cols = [
    { key: 'name',      lbl: 'League'         },
    { key: 'standing',  lbl: 'Standing'       },
    { key: 'record',    lbl: 'Record'         },
    { key: 'allplay',   lbl: 'All-Play'       },
    { key: 'chances',   lbl: 'Playoff Chances'},
  ];

  const thead = `<thead><tr>${cols.map(c =>
    `<th class="${thCls(c.key)}" onclick="lsSort('${c.key}')">${c.lbl}${arr(c.key)}</th>`
  ).join('')}</tr></thead>`;

  const tbody = `<tbody id="ls-tbody">${rows.map(row => {
    // League name cell
    const nameCls = row.prefContender ? ' ls-contender-name' : '';
    const nameCell = `<td><a href="/analyzer?league=${row.lgId}" class="row-link${nameCls}">${esc(row.name)}</a></td>`;

    // Standing cell
    let standingCell;
    if (!row.hasData) {
      standingCell = '<td>—</td>';
    } else {
      const inPlayoffs = row.standing <= row.playoffTeams;
      if (inPlayoffs) {
        standingCell = `<td><span class="ls-po-v2">${row.standing}</span> <span style="font-size:0.72rem;color:var(--brown-light);">of ${row.numTeams}</span></td>`;
      } else {
        standingCell = `<td>${row.standing} <span style="font-size:0.72rem;color:var(--brown-light);">of ${row.numTeams}</span></td>`;
      }
    }

    // Record cell
    const recordCell = row.hasData
      ? `<td>${row.wins}-${row.losses}</td>`
      : '<td>—</td>';

    // All-play cell
    let apCell;
    if (!row.hasData || row.apWins === null) {
      apCell = '<td>—</td>';
    } else {
      apCell = `<td>${row.apWins}-${row.apLosses}</td>`;
    }

    // Playoff chances cell
    let chancesCell;
    if (!row.hasData) {
      chancesCell = '<td>—</td>';
    } else if (row.playoffOdds !== undefined && row.playoffOdds !== null) {
      const pct  = Math.round(row.playoffOdds * 100);
      const hue  = Math.round(pct * 1.2); // 0→red, 100→green
      const byeHtml = row.byeOdds != null
        ? `<span class="ls-bye-pct">${Math.round(row.byeOdds * 100)}% bye</span>` : '';
      chancesCell = `<td><span class="ls-odds-pct" style="color:hsl(${hue},70%,38%)">${pct}%</span>${byeHtml}</td>`;
    } else if (row.playoffOddsError) {
      chancesCell = `<td><span style="color:var(--brown-light);font-size:0.8rem;" title="${esc(row.playoffOddsError)}">— ⚠︎</span></td>`;
    } else {
      const { label, cls } = lsPlayoffChancesLabel(row.standing, row.numTeams);
      chancesCell = `<td><span class="${cls}">${label}</span></td>`;
    }

    return `<tr>${nameCell}${standingCell}${recordCell}${apCell}${chancesCell}</tr>`;
  }).join('')}</tbody>`;

  const filterBtns = `
    <div class="ls-filter-bar">
      <span class="ls-filter-label">Filter</span>
      <button class="ghost-btn${LS.filter==='all'?' active':''}" onclick="lsSetFilter('all')" style="${LS.filter==='all'?'border-color:var(--gold);color:var(--gold);':''}">All</button>
      <button class="ghost-btn${LS.filter==='contenders'?' active':''}" onclick="lsSetFilter('contenders')"
        style="${LS.filter==='contenders'?'border-color:var(--gold);color:var(--gold);':''}"
        ${roles.has('contender')?'':'disabled title="Fill out Root For Me first"'}>Contenders</button>
      <button class="ghost-btn${LS.filter==='rebuilders'?' active':''}" onclick="lsSetFilter('rebuilders')"
        style="${LS.filter==='rebuilders'?'border-color:var(--gold);color:var(--gold);':''}"
        ${roles.has('rebuilder')?'':'disabled title="Tag a league as rebuilding in Root For Me"'}>Rebuilders</button>
      <input type="text" class="search-input" id="ls-search" placeholder="Search leagues…"
        oninput="lsOnSearch()" value="${esc(LS.search)}" style="max-width:180px;margin-left:4px;" />
      ${LS.sortCol ? `<button class="ls-reset-sort" onclick="lsSort(null)">Sleeper order</button>` : ''}
    </div>`;

  const oddsBtn = LS.oddsLoading
    ? `<button class="ghost-btn" disabled style="opacity:0.6;">Calculating odds…</button>`
    : LS.oddsLoaded
      ? `<button class="ghost-btn" onclick="lsSimulateAllLeagues()" title="Recalculate playoff odds">↺ Recalculate Odds</button>`
      : `<button class="ghost-btn" onclick="lsSimulateAllLeagues()">Calculate Playoff Odds</button>`;

  const oddsErr = LS.oddsError
    ? `<div style="color:#c0392b;font-size:0.82rem;margin:8px 0 4px;">${esc(LS.oddsError)}</div>`
    : '';

  setC(`
    ${lsRecapHtml()}
    <div class="section-head"><h2>League Summaries</h2><div class="section-head-line"></div></div>
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
      ${filterBtns}
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
        ${oddsBtn}
      </div>
    </div>
    ${oddsErr}
    <div style="overflow-x:auto;">
      <table class="ls-table">${thead}${tbody}</table>
    </div>
    ${rows.length === 0 ? '<div class="empty-state" style="margin-top:12px;"><p>No leagues match the current filter</p></div>' : ''}
    ${lsGzSection()}
  `);
}
