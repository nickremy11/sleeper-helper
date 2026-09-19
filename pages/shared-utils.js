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
// Per-player and per-roster scoring helpers.
//
// These once backed a "Contender Rank" column on League Summaries and the
// League Analyzer. That column is gone — playoff odds answer the same question
// ("how good is this team right now") without leaning on ADP, which moves
// around too much to compare leagues against each other. What's left has three
// live consumers:
//   • the Scout tab (index.html)         → crPlayerPpg, for positional ranks
//   • the guillotine Power Score          → crScoreRoster, projections mode only
//   • the Analyzer's Trade Targets panel  → crScoreClay / crScoreSleeper
//
// Two valuation modes survive because Scout still uses both:
//   'adp'         → aggregate consensus ADP (JuiceBoxOne sheet: FantasyPros/
//                   ESPN/Sleeper/Yahoo blend, 1000 / √rank decay), falling back
//                   to Sleeper's own search_rank for anyone the sheet doesn't
//                   cover (it's offense-only, ~200 players — no IDP, no deep bench).
//   'projections' → equal-weight average of Clay (ESPN), Sleeper season
//                   projections, and the user's own projections, each scored
//                   with the league's own scoring_settings.
//
// crScoreRoster sums a roster's best starters under a position-aware selection:
// 2 QB if SF (else 1), (RB/WR/TE slots + 1) each, then the best remaining
// flex-eligible players up to (starter_count + 3).
// ════════════════════════════════════════════════════════════════════════════

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

// Summed starter value for one roster's player ids.
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

  // ESPN models TE premium as a pointsOverride on the reception category rather
  // than a stat of its own, so it falls out of the statId loop above as a bare
  // number. Sleeper's own scoring_settings AND its projection stat lines both use
  // a `bonus_rec_te` key, so putting it back into `scoring` under that name is
  // all any consumer needs — crScoreSleeper already reads it, and
  // lsComputeProjPts is a plain dot product over the stat line. Still returned
  // separately as well, since the FantasyCalc value multipliers in analyzer.html
  // / trade-analyzer.html want the raw bonus, not a scoring key.
  if (bonusRecTe) scoring.bonus_rec_te = bonusRecTe;

  return { scoring, numQbs, ppr: scoring.rec ?? 1, bonusRecTe };
}

// POSITION_MAP-derived (see crParseEspnScoring's source comment above):
// converts ESPN's lineupSlotCounts into the same Sleeper-shaped flat
// rosterPositions array Sleeper's own roster_positions field already is
// (['QB','RB','RB',...,'FLEX','BN',...]) — used by both pages' playoff-odds
// lineup optimizers. D/ST(16) and K(17) slots are dropped — this app never
// scores kickers/defense in either sim (rsNormPos() drops them for Sleeper
// too), so it's a pre-existing, consistent gap, not new for ESPN.
const ESPN_SLOT_TO_ROSTER_POS = {
  0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE',
  3: 'FLEX', 5: 'FLEX', 23: 'FLEX', 7: 'SUPER_FLEX',
  20: 'BN', 21: 'IR',
};
function espnRosterPositionsFromSlotCounts(lineupSlotCounts) {
  const out = [];
  for (const [slotId, count] of Object.entries(lineupSlotCounts || {})) {
    const label = ESPN_SLOT_TO_ROSTER_POS[Number(slotId)];
    if (!label) continue;
    for (let i = 0; i < count; i++) out.push(label);
  }
  return out;
}

// ESPN has no per-week matchup endpoint like Sleeper's — mMatchupScore returns
// the WHOLE season's schedule in one call (data.schedule[], each entry
// {matchupPeriodId, home:{teamId,totalPoints}, away:{teamId,totalPoints}}) —
// verified against espn-api's own scoreboard()/Matchup source, not guessed.
// Fetch once per league; a bye week's entry has no `away` key.
async function crFetchEspnSchedule(apiBase, espnLeagueId) {
  const r = await fetch(`${apiBase}/espn/fantasy/${espnLeagueId}?view=mMatchupScore`, { credentials: 'include' });
  if (!r.ok) throw new Error('ESPN schedule unavailable');
  const d = await r.json();
  return d.schedule || [];
}

// Groups a raw schedule (from crFetchEspnSchedule) into the SAME
// {week: [{roster_id, matchup_id}, ...]} shape Sleeper's matchups endpoint
// returns, for the given weeks — so the Sleeper-shaped simulation functions in
// both pages need zero ESPN-specific branching. Byes are dropped (no win/loss
// added that week, which is the correct simulation behavior).
function crEspnScheduleToMatchupsByWeek(schedule, weeks) {
  const byWeek = {};
  for (const w of weeks) {
    byWeek[w] = [];
    for (const m of schedule) {
      if (m.matchupPeriodId !== w || !m.home || !m.away) continue;
      const mid = `${w}_${m.home.teamId}`;
      byWeek[w].push({ roster_id: m.home.teamId, matchup_id: mid });
      byWeek[w].push({ roster_id: m.away.teamId, matchup_id: mid });
    }
  }
  return byWeek;
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


// ── Sleeper trades ────────────────────────────────────────────────────────────
// A trade is a flat list of assets, each moving between two roster ids:
//   {kind:'player', pid, from, to}
//   {kind:'pick', season, round, orig, from, to}   orig = the roster the pick originally belonged to
// One shape for all three consumers: the Trades tab's "Analyze" deep link, the trade
// analyzer's "Propose in Sleeper", and (next) mass offers. Callers may hang a `label`
// on an asset for display; nothing here reads it.

// Every offer this app sends is a 2-day exploding offer. Sleeper's own "2 Days"
// option sends exactly send-time + 48h.
const SLEEPER_TRADE_EXPIRY_SECS = 2 * 86400;

// Sleeper's propose_trade, mirrored from a request captured on sleeper.com. The
// players go in variables as parallel key/value arrays (k_adds[i] lands on roster
// v_adds[i]; k_drops[i] leaves roster v_drops[i]); everything else is inlined into
// the query, as Sleeper's client does:
//   draft_picks   "orig,season,round,to,from"   — the same string the Trades tab parses
//   waiver_budget "from,to,amount"               — no FAAB support yet, so always []
//   expires_at    unix seconds
// Inlined values are validated first, so nothing but digits reaches the query text.
function sleeperProposeTradeBody(leagueId, assets, expiresAt) {
  const lg = String(leagueId);
  if (!/^\d+$/.test(lg)) throw new Error('Not a Sleeper league: ' + lg);
  const rid = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error('Bad roster id: ' + v); return n; };
  if (!assets?.length) throw new Error('Trade has no players or picks');
  const players = [], picks = [];
  for (const a of assets) {
    const from = rid(a.from), to = rid(a.to);
    if (from === to) throw new Error('An asset cannot move to the team sending it');
    if (a.kind === 'player') {
      if (!/^[A-Za-z0-9_]+$/.test(String(a.pid))) throw new Error('Bad player id: ' + a.pid);
      players.push({ pid: String(a.pid), from, to });
    } else if (a.kind === 'pick') {
      if (!/^\d{4}$/.test(String(a.season))) throw new Error('Bad pick season: ' + a.season);
      picks.push(`${rid(a.orig)},${a.season},${rid(a.round)},${to},${from}`);
    } else {
      throw new Error('Unknown trade asset: ' + a.kind);
    }
  }
  const exp = Math.floor(Number(expiresAt));
  if (!Number.isFinite(exp)) throw new Error('Bad expiry');
  const query = `mutation propose_trade($k_adds: [String], $v_adds: [Int], $k_drops: [String], $v_drops: [Int]) {
        propose_trade(league_id: "${lg}",draft_picks: ${JSON.stringify(picks)},k_adds: $k_adds,v_adds: $v_adds,k_drops: $k_drops,v_drops: $v_drops,waiver_budget: [],expires_at: ${exp}){
          adds
          consenter_ids
          created
          creator
          drops
          league_id
          leg
          metadata
          roster_ids
          settings
          status
          status_updated
          transaction_id
          draft_picks
          type
          player_map
          waiver_budget
        }
      }`;
  return {
    operationName: 'propose_trade',
    variables: {
      k_adds:  players.map(p => p.pid), v_adds:  players.map(p => p.to),
      k_drops: players.map(p => p.pid), v_drops: players.map(p => p.from),
    },
    query,
  };
}

// One Sleeper GraphQL call through the worker proxy, which uses the signed-in
// user's stored token when no `token` is passed. Resolves to `data`; throws with
// Sleeper's own error message when it refuses.
async function sleeperGql({ apiBase, op, query, variables = {}, token }) {
  const headers = { 'Content-Type': 'application/json', 'X-Sleeper-Graphql-Op': op };
  if (token) headers['Authorization'] = token;
  const r = await fetch(`${apiBase}/graphql`, {
    method: 'POST', headers, credentials: 'include',
    body: JSON.stringify({ operationName: op, variables, query }),
  });
  const json = await r.json().catch(() => null);
  if (json?.errors?.length) throw new Error(json.errors[0].message || `Sleeper refused ${op}`);
  if (!r.ok) throw new Error(`Sleeper HTTP ${r.status} (${op})`);
  return json?.data;
}

// Sends the offer. Resolves to Sleeper's transaction
// ({transaction_id, status:'proposed', settings.expires_at, …}).
async function sleeperProposeTrade({ apiBase, leagueId, assets, token, expiresAt }) {
  const exp  = expiresAt ?? Math.floor(Date.now() / 1000) + SLEEPER_TRADE_EXPIRY_SECS;
  const body = sleeperProposeTradeBody(leagueId, assets, exp);
  const data = await sleeperGql({ apiBase, op: body.operationName, query: body.query, variables: body.variables, token });
  const tx = data?.propose_trade;
  if (!tx?.transaction_id) throw new Error('Sleeper did not confirm the trade');
  return tx;
}

// ── Trade DM ──
// Proposing a trade does NOT message anyone — sleeper.com follows propose_trade
// with two more calls, mirrored here from a capture:
//   1. get_dm_by_members(members: [other user ids])  → the DM's dm_id, or nothing
//      when you've never messaged them — then create_dm(dm_type:"single") makes one
//   2. create_message(parent_type:"dm", attachment_type:"trade_dm", …) — the trade
//      card, whose attachment is a key/value list:
//        status                "proposed"
//        transactions_by_roster JSON {rosterId: {adds:[player], drops, added_picks,
//                                dropped_picks, added_budget, dropped_budget, status, user}}
//                                — everything is keyed by the roster RECEIVING it; the
//                                drops/dropped_* lists stay empty even for assets going out.
//                                added_picks: {roster_id: ORIGINAL roster, season, round,
//                                owner_id, previous_owner_id, original_owner_id} — all strings,
//                                and the *_owner_id fields are USER ids, not roster ids.
//                                added_budget: [{amount:"11"}] (no FAAB in our trades yet)
//        transaction_id / league_id
//        users_in_league_map   JSON {user_id: league user} — /league/{id}/users rows

// Player fields the card carries, in Sleeper's order.
const SLEEPER_DM_PLAYER_FIELDS = ['position','status','number','first_name','last_name','sport','team','player_id',
  'fantasy_positions','team_abbr','team_changed_at','injury_status','years_exp','news_updated'];

// opts = {tx, assets, leagueId, leagueUsers, rosterOwners:{rosterId: user_id}, players:{pid: Sleeper player}}
function sleeperTradeDmAttachment({ tx, assets, leagueId, leagueUsers, rosterOwners, players }) {
  const userById = Object.fromEntries((leagueUsers || []).map(u => [u.user_id, u]));
  const rids = [...new Set(assets.flatMap(a => [a.from, a.to]))].sort((a, b) => a - b);
  const byRoster = {};
  for (const rid of rids) {
    const user = userById[rosterOwners[rid]];
    if (!user) throw new Error(`no league user for roster ${rid}`);
    const adds = assets.filter(a => a.kind === 'player' && a.to === rid).map(a => {
      const p = players[a.pid] || {};
      const out = {};
      for (const f of SLEEPER_DM_PLAYER_FIELDS) out[f] = p[f] ?? null;
      out.player_id = String(a.pid);
      return out;
    });
    const added_picks = assets.filter(a => a.kind === 'pick' && a.to === rid).map(a => ({
      roster_id: String(a.orig), season: String(a.season), round: String(a.round),
      owner_id: rosterOwners[a.to] ?? null, previous_owner_id: rosterOwners[a.from] ?? null,
      original_owner_id: rosterOwners[a.orig] ?? null,
    }));
    byRoster[rid] = { adds, drops: [], added_picks, dropped_picks: [], added_budget: [], dropped_budget: [], status: 'proposed', user };
  }
  return {
    k: ['status', 'transactions_by_roster', 'transaction_id', 'league_id', 'users_in_league_map'],
    v: ['proposed', JSON.stringify(byRoster), String(tx.transaction_id), String(leagueId), JSON.stringify(userById)],
  };
}

// Sends the trade card into the DM with the other manager(s). Call after
// sleeperProposeTrade resolves; a failure here leaves the trade itself untouched.
// opts = sleeperTradeDmAttachment's opts + {apiBase, token?, leagueName, myUserId}
async function sleeperSendTradeDm(opts) {
  const { apiBase, token, tx, assets, leagueName, leagueUsers, rosterOwners, myUserId } = opts;
  const att = sleeperTradeDmAttachment(opts);
  const me  = (leagueUsers || []).find(u => u.user_id === myUserId);
  if (!me) throw new Error('couldn’t find you in this league’s users');
  const others = [...new Set(assets.flatMap(a => [a.from, a.to]))]
    .map(rid => rosterOwners[rid]).filter(uid => uid && uid !== myUserId);
  if (!others.length || others.some(uid => !/^\d+$/.test(String(uid)))) throw new Error('couldn’t identify the other manager');

  const dmData = await sleeperGql({ apiBase, token, op: 'get_dm_by_members', query: `query get_dm_by_members {
        get_dm_by_members(members: ${JSON.stringify(others.map(String))}){
          dm_id
          dm_type
          hidden_at
          last_author_avatar
          last_author_display_name
          last_author_real_name
          last_author_id
          last_message_id
          last_message_text
          last_message_text_map
          last_message_time
          last_pinned_message_id
          last_read_id
          member_can_invite
          recent_users
          title
        }
      }` });
  let dmId = dmData?.get_dm_by_members?.dm_id;
  if (!dmId) {
    // Never messaged them — sleeper.com creates the DM here. Only the one-on-one
    // form has been captured, so a 3-team trade with no existing group DM stops.
    if (others.length !== 1) throw new Error('no existing group DM with these managers');
    const created = await sleeperGql({ apiBase, token, op: 'create_dm', query: `mutation create_dm {
        create_dm(dm_type: "single", members: ${JSON.stringify(others.map(String))}){
          dm_id
          dm_type
          last_author_avatar
          last_author_display_name
          last_author_real_name
          last_author_id
          last_message_id
          last_message_text
          last_message_text_map
          last_message_time
          last_pinned_message_id
          last_read_id
          member_can_invite
          hidden_at
          recent_users
          title
        }
      }` });
    dmId = created?.create_dm?.dm_id;
  }
  if (!dmId || !/^\d+$/.test(String(dmId))) throw new Error('Sleeper returned no DM with this manager');

  const clientId = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const data = await sleeperGql({ apiBase, token, op: 'create_message',
    variables: { text: `@${me.display_name} has proposed a trade in ${leagueName}`, k_attachment_data: att.k, v_attachment_data: att.v },
    query: `mutation create_message($text: String,$k_attachment_data: [String],$v_attachment_data: [String]) {
        create_message(parent_id: "${dmId}",client_id: "${clientId}",parent_type: "dm",text: $text,shard_min: null,shard_max: null,attachment_type: "trade_dm",k_attachment_data: $k_attachment_data,v_attachment_data: $v_attachment_data) {
          attachment
          author_avatar
          author_display_name
          author_real_name
          author_id
          author_is_bot
          author_role_id
          client_id
          created
          message_id
          parent_id
          parent_type
          pinned
          reactions
          user_reactions
          text
          text_map
        }
      }` });
  const msg = data?.create_message;
  if (!msg?.message_id) throw new Error('Sleeper did not confirm the message');
  return msg;
}

// Trade assets from a Sleeper transaction (GraphQL league_transactions_filtered or
// REST /transactions). Players: adds = where each lands, drops = where it left.
// Picks come as "orig,season,round,to,from" strings from GraphQL, or as
// {season, round, roster_id, owner_id, previous_owner_id} objects from REST.
// FAAB is ignored.
function tradeAssetsFromSleeperTx(tx) {
  const out = [];
  for (const [pid, to] of Object.entries(tx?.adds || {})) {
    const from = tx.drops?.[pid];
    if (from != null) out.push({ kind: 'player', pid: String(pid), from: Number(from), to: Number(to) });
  }
  for (const pk of (tx?.draft_picks || [])) {
    if (typeof pk === 'string') {
      const [orig, season, round, to, from] = pk.split(',');
      out.push({ kind: 'pick', season: String(season), round: Number(round), orig: Number(orig), from: Number(from), to: Number(to) });
    } else if (pk && typeof pk === 'object') {
      out.push({ kind: 'pick', season: String(pk.season), round: Number(pk.round), orig: Number(pk.roster_id),
                 from: Number(pk.previous_owner_id), to: Number(pk.owner_id) });
    }
  }
  return out;
}

// Compact URL form of a trade, for /trade-analyzer?league={id}&t={param}:
//   player  p{pid}~{from}~{to}
//   pick    k{season}.{round}.{orig}~{from}~{to}
// comma-joined. Unparseable tokens are dropped on read.
function tradeAssetsToParam(assets) {
  return (assets || []).map(a => a.kind === 'player'
    ? `p${a.pid}~${a.from}~${a.to}`
    : `k${a.season}.${a.round}.${a.orig}~${a.from}~${a.to}`).join(',');
}
function tradeAssetsFromParam(str) {
  const out = [];
  for (const tok of String(str || '').split(',')) {
    let m = tok.match(/^p([A-Za-z0-9_]+)~(\d+)~(\d+)$/);
    if (m) { out.push({ kind: 'player', pid: m[1], from: Number(m[2]), to: Number(m[3]) }); continue; }
    m = tok.match(/^k(\d{4})\.(\d+)\.(\d+)~(\d+)~(\d+)$/);
    if (m) out.push({ kind: 'pick', season: m[1], round: Number(m[2]), orig: Number(m[3]), from: Number(m[4]), to: Number(m[5]) });
  }
  return out;
}

// ── League ownership ─────────────────────────────────────────────────────────
// Everyone rostered by ANYONE in a league (its complement is the free-agent
// pool) plus one user's own roster — one fetch per league on either platform.
// Returns **null** when the league can't be read, never an empty pair: an empty
// `owned` reads as "nobody owns anyone", which paints a whole grid as free
// agents and inflates every availability count downstream.
//   espnId   — the NUMERIC ESPN id (not the 'espn_' prefixed one)
//   rosters  — an already-fetched Sleeper /rosters array, to skip the fetch
async function crLoadLeagueOwnership({ apiBase, leagueId, espn, espnId, season, swid,
                                       byName, sleeperUserId, rosters }) {
  try {
    const owned = new Set(), mine = new Set();
    if (espn) {
      const id = espnId || String(leagueId).replace('espn_', '');
      const yr = season || String(new Date().getFullYear());
      const r  = await fetch(`${apiBase}/espn/fantasy/${id}?view=mRoster&view=mTeam&seasonId=${yr}`, { credentials: 'include' });
      if (!r.ok) return null;
      const d = await r.json();
      for (const team of (d.teams || [])) {
        const isMine = !!swid && team.primaryOwner === swid;
        for (const entry of (team.roster?.entries || [])) {
          const pl = entry.playerPoolEntry?.playerPoolEntry?.player || entry.playerPoolEntry?.player;
          if (!pl) continue;
          const nm  = pl.fullName || `${pl.firstName || ''} ${pl.lastName || ''}`.trim();
          const pid = byName?.[normName(nm)];
          if (!pid) continue;
          owned.add(String(pid));
          if (isMine) mine.add(String(pid));
        }
      }
    } else {
      let list = rosters;
      if (!list?.length) {
        const r = await fetch(`${apiBase}/sleeper/league/${leagueId}/rosters`);
        if (!r.ok) return null;
        list = await r.json() || [];
      }
      for (const roster of list) {
        const isMine = !!sleeperUserId && roster.owner_id === sleeperUserId;
        for (const pid of (roster.players || [])) {
          owned.add(String(pid));
          if (isMine) mine.add(String(pid));
        }
      }
    }
    return { owned, mine };
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════════
// MY RANKS GRID (mrg*)
// ════════════════════════════════════════════════════════════════════════════
// A ranking set from myranks.ffhistorian.com, laid out as a grid with ONE
// league's ownership painted on it: green = on my roster, yellow = nobody in the
// league owns him, everything else plain. Lives here rather than in a page
// because two very different hosts show it — the Waivers tab (index.html) and
// the League Analyzer (analyzer.html) — and the only thing either supplies is
// context. Both already load shared-styles.css, which carries the .mrg-* rules.
//
// Two views, and the tiering is the difference between them:
//   all — every ranked player in one list, cut into as many adjacent columns as
//         the screen will hold, so the whole board reads in one screenful.
//   pos — QB / RB·RB / WR·WR / TE, each column's tiers RECALCULATED (mrgPosCols)
//         so a position's tier 1 is its own top group, not whichever overall
//         tier its best player happened to land in.
//
// My Ranks stores a TIER per player and nothing else — no ordering inside a
// tier (its API returns tier, then name). So the order within a tier here is
// FantasyCalc value, best first; without that the list would read alphabetically
// inside each band, which looks like a ranking and isn't one.

const MRG_MYRANKS_API   = 'https://myranks.ffhistorian.com';
const MRG_POS_COLS      = [['QB', 1], ['RB', 2], ['WR', 2], ['TE', 1]];   // [position, columns]
const MRG_POS_KEYS      = new Set(['QB', 'RB', 'WR', 'TE']);
const MRG_TRACK_MIN     = 170;   // px a track needs before names start ellipsizing
const MRG_GAP           = 10;    // must match .mrg-wrap's gap
const MRG_ROW_H         = 21;    // rendered height of one .mrg-cell
const MRG_ALL_MIN_ROWS  = 15;    // a part shorter than this reads as a stub, not a column
const MRG_ALL_MAX_PARTS = 10;
const MRG_LS_SOURCE     = 'mrg_source';
const MRG_LS_VIEW       = 'mrg_view';

const MRG = {
  mount: null,            // element id to render into
  apiBase: '/api',
  wideEl: null, wideClass: null,   // host's "go full width" hook (.main/wide, .az-wrap/az-wide)
  stickyTop: null,        // px the sticky column heads sit below the top of the viewport
  onClose: null,          // renders a back button when set (the analyzer's "done")

  leagues: [],            // [{id, name, espn}] — the league dropdown
  leagueId: null, leagueName: '',
  sources: null,          // [{id, label}] — the ranking-set dropdown
  sourceId: null, sourceName: '',
  view: 'all',

  rows: [],               // built by mrgBuildRows
  unmatched: 0,

  players: null, byName: null, fcMap: null,
  sleeperUserId: null, swid: null, season: null,

  rosters: {},            // lgId → {owned:Set, mine:Set} | null (null = load failed)
  loading: false, error: '',
  _idTried: false, _sig: null, _espnCfg: null,
};

// ── Entry point ──────────────────────────────────────────────────────────────
// Everything is optional but `mount`: what the host doesn't hand over, the grid
// fetches for itself, so the analyzer (which shares no state with anything) can
// open it with a mount id and a league.
async function mrgInit(opts = {}) {
  Object.assign(MRG, {
    leagues: [], leagueId: null, leagueName: '', sources: null, sourceId: null, sourceName: '',
    rows: [], unmatched: 0, error: '', _sig: null,
  }, opts);
  if (!MRG.view) MRG.view = 'all';
  try { MRG.view = localStorage.getItem(MRG_LS_VIEW) || MRG.view; } catch {}
  try { MRG.sourceId = MRG.sourceId || localStorage.getItem(MRG_LS_SOURCE); } catch {}

  mrgRender(`<div class="loading-state"><div class="spinner"></div>Loading rankings…</div>`);
  try {
    // Identity before leagues, not alongside it: the league list needs the same
    // Sleeper user id and season, and running both would fetch each twice.
    await Promise.all([mrgEnsureRefData(), mrgEnsureIdentity()]);
    await mrgEnsureLeagues();
    await mrgLoadSources();
    await mrgLoadRanks();
    await mrgEnsureRosters(MRG.leagueId);
  } catch (e) {
    MRG.error = e.message || String(e);
  }
  mrgDraw();
}

function mrgRender(html) {
  const el = document.getElementById(MRG.mount);
  if (el) el.innerHTML = html;
}

function mrgApplyWide(on) {
  if (!MRG.wideEl || !MRG.wideClass) return;
  document.querySelector(MRG.wideEl)?.classList.toggle(MRG.wideClass, on);
}

// ── Reference data ───────────────────────────────────────────────────────────
async function mrgEnsureRefData() {
  if (!MRG.players || !MRG.byName) {
    const res = await fetch(`${MRG.apiBase}/players`).then(r => r.json());
    const players = {}, byName = {};
    const rankOf = p => (p.search_rank != null && p.search_rank < 9999999) ? p.search_rank : Infinity;
    for (const [pid, p] of Object.entries(res || {})) {
      if (!MRG_POS_KEYS.has(p.position)) continue;
      players[pid] = p;
      const nm = p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim();
      if (!nm) continue;
      // Same collision rule the other name-matchers use: keep the more
      // fantasy-relevant of two players who normalize to the same name.
      const key = normName(nm);
      if (byName[key] == null || rankOf(p) < rankOf(players[byName[key]])) byName[key] = pid;
    }
    MRG.players = players;
    MRG.byName  = byName;
  }
  if (!MRG.fcMap) {
    try {
      const fc  = await fetch(`${MRG.apiBase}/fantasycalc`).then(r => r.ok ? r.json() : []);
      const map = {};
      for (const item of (fc || [])) {
        const sid = item.player?.sleeperId || item.player?.maybeSleeperID;
        if (sid) map[String(sid)] = item.value ?? 0;
      }
      MRG.fcMap = map;
    } catch { MRG.fcMap = {}; }
  }
}

// Who "my roster" is. Resolved once and cached — a failure here costs the green
// highlight, not the grid, so nothing throws.
async function mrgEnsureIdentity() {
  if (MRG._idTried) return;
  MRG._idTried = true;
  const user = window.SharedAuth?.getUser?.();
  const jobs = [];
  if (!MRG.sleeperUserId && user?.sleeper_username) {
    jobs.push(fetch(`${MRG.apiBase}/sleeper/user/${encodeURIComponent(user.sleeper_username)}`)
      .then(r => r.json()).then(u => { MRG.sleeperUserId = u?.user_id || null; }).catch(() => {}));
  }
  if (!MRG.swid || !MRG._espnCfg) {
    // Kept on MRG: mrgEnsureLeagues wants league_ids off the same response.
    jobs.push(fetch(`${MRG.apiBase}/espn/settings`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(c => { MRG._espnCfg = c || null; MRG.swid = MRG.swid || c?.swid || null; })
      .catch(() => {}));
  }
  if (!MRG.season) {
    jobs.push(fetch(`${MRG.apiBase}/sleeper/state/nfl`).then(r => r.json())
      .then(s => { MRG.season = s?.season || String(new Date().getFullYear()); }).catch(() => {}));
  }
  await Promise.all(jobs);
}

// The league dropdown. A host with its own league list (index.html's S.leagues)
// passes it in; the analyzer doesn't have one, so it's assembled here the same
// way the trade analyzer's picker does it — Sleeper via the username, ESPN via
// the saved credentials.
async function mrgEnsureLeagues() {
  if (MRG.leagues?.length) {
    MRG.leagues = MRG.leagues.map(lg => lg.id
      ? lg
      : { id: lg.league_id, name: lg.name || lg.league_id, espn: lg.source === 'espn' });
    return;
  }
  const out  = [];
  const user = window.SharedAuth?.getUser?.();
  if (MRG.sleeperUserId || user?.sleeper_username) {
    try {
      // mrgEnsureIdentity has normally resolved both of these already.
      const uid = MRG.sleeperUserId
        || (await fetch(`${MRG.apiBase}/sleeper/user/${encodeURIComponent(user.sleeper_username)}`).then(r => r.json()))?.user_id;
      const season = MRG.season || (await fetch(`${MRG.apiBase}/sleeper/state/nfl`).then(r => r.json()))?.season;
      MRG.sleeperUserId = MRG.sleeperUserId || uid || null;
      const leagues = await fetch(`${MRG.apiBase}/sleeper/user/${uid}/leagues/nfl/${season}`).then(r => r.json());
      for (const lg of (leagues || [])) out.push({ id: lg.league_id, name: lg.name || lg.league_id, espn: false });
    } catch {}
  }
  try {
    const cfg = MRG._espnCfg
      || await fetch(`${MRG.apiBase}/espn/settings`, { credentials: 'include' }).then(r => r.ok ? r.json() : null);
    if (cfg?.has_credentials && cfg.league_ids?.length) {
      const found = await Promise.all(cfg.league_ids.map(id =>
        fetch(`${MRG.apiBase}/espn/fantasy/${id}?view=mSettings&view=mTeam`, { credentials: 'include' })
          .then(r => r.ok ? r.json() : null)
          .then(d => d ? { id: 'espn_' + id, name: d.settings?.name || `ESPN ${id}`, espn: true } : null)
          .catch(() => null)));
      for (const lg of found) if (lg) out.push(lg);
    }
  } catch {}
  // The page may have been opened on a league the list doesn't carry (signed
  // out, or a league that's no longer in the Sleeper season) — it still has to
  // be selectable, since it's the one on screen.
  if (MRG.leagueId && !out.some(l => l.id === MRG.leagueId)) {
    out.unshift({ id: MRG.leagueId, name: MRG.leagueName || 'This league', espn: String(MRG.leagueId).startsWith('espn_') });
  }
  MRG.leagues = out;
  if (!MRG.leagueId && out.length) MRG.leagueId = out[0].id;
}

// ── Ranking sets ─────────────────────────────────────────────────────────────
// Same id scheme the Draft Tracker's picker uses: 'primary' | 'primary:{userId}'
// (a board shared with me) | 'set:{id}' (mine) | '{id}' (a named set shared with me).
async function mrgLoadSources() {
  const [dataRes, setsRes] = await Promise.all([
    fetch(MRG_MYRANKS_API + '/api/myranks/data',  { credentials: 'include' }),
    fetch(MRG_MYRANKS_API + '/api/myranks/sets',  { credentials: 'include' }),
  ]);
  if (!dataRes.ok || !setsRes.ok) throw new Error('Could not load your My Ranks sets — sign in at myranks.ffhistorian.com');
  const [data, sets] = await Promise.all([dataRes.json(), setsRes.json()]);

  const out = [];
  if (data.rankings?.length) out.push({ id: 'primary', label: 'My Rankings', rankings: data.rankings });
  for (const s of (sets.sets || [])) out.push({ id: 'set:' + s.id, label: s.name });
  for (const s of (sets.sharedSets || [])) {
    out.push({
      id: String(s.id),
      label: s.is_primary
        ? (s.owner_name ? `${s.owner_name}'s Rankings` : 'Shared Rankings')
        : (s.owner_name ? `${s.name} (${s.owner_name})` : s.name),
    });
  }
  MRG.sources = out;
  if (!out.some(s => s.id === MRG.sourceId)) MRG.sourceId = out[0]?.id || null;
}

async function mrgFetchRanks(id) {
  const src = (MRG.sources || []).find(s => s.id === id);
  if (src?.rankings) return src.rankings;
  const url = id.startsWith('primary:') ? `/api/myranks/data?owner_id=${encodeURIComponent(id.slice(8))}`
            : id.startsWith('set:')     ? `/api/myranks/sets/${id.slice(4)}/data`
            :                             `/api/myranks/sets/${id}/data`;
  const r = await fetch(MRG_MYRANKS_API + url, { credentials: 'include' });
  if (!r.ok) throw new Error('Could not load that ranking set');
  return (await r.json()).rankings || [];
}

async function mrgLoadRanks() {
  if (!MRG.sourceId) { MRG.rows = []; return; }
  const list = await mrgFetchRanks(MRG.sourceId);
  MRG.sourceName = (MRG.sources || []).find(s => s.id === MRG.sourceId)?.label || '';
  MRG.rows = mrgBuildRows(list);
  MRG.unmatched = MRG.rows.filter(r => !r.pid).length;
}

function mrgBuildRows(rankings) {
  const byName = MRG.byName || {}, players = MRG.players || {}, fc = MRG.fcMap || {};
  const rows = (rankings || []).map(r => {
    const pid = byName[normName(r.player_name)] || null;
    const p   = pid ? players[pid] : null;
    return {
      pid,
      name: p?.full_name || r.player_name,
      team: p?.team || r.team || '',
      pos:  crNormPos(p?.position) || crNormPos(r.position) || null,
      tier: Number(r.tier) || 0,
      fc:   pid ? (fc[String(pid)] ?? 0) : 0,
    };
  });
  rows.sort((a, b) => a.tier !== b.tier ? a.tier - b.tier
                    : b.fc   !== a.fc   ? b.fc - a.fc
                    : a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.overall = i + 1; });
  return rows;
}

// ── Columns ──────────────────────────────────────────────────────────────────
// Tiers are recalculated per position by DENSE-RANKING the overall tiers that
// actually appear at that position: if no QB sits in overall tiers 2 or 3, the
// QB from overall tier 4 is QB tier 2. Dense rather than a re-slice, because
// once the other positions are gone the gaps between a position's tiers carry
// no information — and it's the tier NUMBERS that move, never the order.
function mrgPosCols(rows) {
  const cols = {};
  for (const r of rows) {
    if (!r.pos || !MRG_POS_KEYS.has(r.pos)) continue;
    (cols[r.pos] = cols[r.pos] || []).push(r);
  }
  for (const pos in cols) {
    const seen = [...new Set(cols[pos].map(r => r.tier))].sort((a, b) => a - b);
    const map  = new Map(seen.map((t, i) => [t, i + 1]));
    cols[pos].forEach((r, i) => { r._rank = i + 1; r._tier = map.get(r.tier); });
  }
  return cols;
}

function mrgAllCol(rows) {
  rows.forEach(r => { r._rank = r.overall; r._tier = r.tier; });
  return rows;
}

// The grid's real content width — measured, not derived from window.innerWidth,
// because the host's wide cap is itself viewport-relative and the mount is
// exactly the box the grid lays out in.
function mrgWidth() {
  const w = document.getElementById(MRG.mount)?.clientWidth || 0;
  return w > 320 ? w : Math.max(320, (window.innerWidth || 1200) - 64);
}
const mrgFits = tracks => (mrgWidth() - MRG_GAP * (tracks - 1)) / tracks >= MRG_TRACK_MIN;

// How many adjacent columns the ALL list is cut into. Enough that the whole
// board fits one screenful if the viewport can hold it, capped by how many
// tracks still show a full name and floored so no part is a stub.
function mrgAllParts(n) {
  const byWidth  = Math.max(1, Math.floor((mrgWidth() + MRG_GAP) / (MRG_TRACK_MIN + MRG_GAP)));
  const perScreen = Math.max(12, Math.floor(((window.innerHeight || 900) - 240) / MRG_ROW_H));
  let parts = Math.min(byWidth, Math.max(1, Math.ceil(n / perScreen)), MRG_ALL_MAX_PARTS);
  while (parts > 1 && n / parts < MRG_ALL_MIN_ROWS) parts--;
  return parts;
}

// ── Ownership ────────────────────────────────────────────────────────────────
// Everyone rostered by ANYONE in the league (its complement is the free-agent
// pool) and my own roster. A failed fetch stores NULL, not an empty Set — an
// empty one reads as "nobody owns anyone", which would paint the whole board
// yellow.
async function mrgEnsureRosters(lgId) {
  if (!lgId || MRG.rosters[lgId] !== undefined) return;
  const lg = (MRG.leagues || []).find(l => l.id === lgId);
  MRG.rosters[lgId] = await crLoadLeagueOwnership({
    apiBase: MRG.apiBase,
    leagueId: lgId,
    espn: !!lg?.espn || String(lgId).startsWith('espn_'),
    season: MRG.season,
    swid: MRG.swid,
    byName: MRG.byName,
    sleeperUserId: MRG.sleeperUserId,
  });
}

// ── Handlers ─────────────────────────────────────────────────────────────────
function mrgSetView(v) {
  MRG.view = v;
  try { localStorage.setItem(MRG_LS_VIEW, v); } catch {}
  mrgDraw();
}
async function mrgSetLeague(id) {
  MRG.leagueId = id;
  if (MRG.rosters[id] === undefined) {
    mrgDraw('Loading rosters…');
    await mrgEnsureRosters(id);
  }
  mrgDraw();
}
async function mrgSetSource(id) {
  MRG.sourceId = id;
  try { localStorage.setItem(MRG_LS_SOURCE, id); } catch {}
  mrgDraw('Loading rankings…');
  try { MRG.error = ''; await mrgLoadRanks(); }
  catch (e) { MRG.error = e.message || String(e); }
  mrgDraw();
}
function mrgClose() {
  mrgApplyWide(false);
  MRG.onClose?.();
}

// A resize changes how many parts fit, so the ALL view has to be re-allocated —
// but only redraw when the allocation actually moved, since a redraw throws away
// the scroll position.
let mrgResizeTimer = null;
window.addEventListener('resize', () => {
  if (!document.getElementById(MRG.mount)) return;
  clearTimeout(mrgResizeTimer);
  mrgResizeTimer = setTimeout(() => {
    if (!document.getElementById(MRG.mount) || !MRG.rows.length) return;
    if (mrgSig() !== MRG._sig) mrgDraw();
  }, 150);
});
function mrgSig() {
  if (MRG.view === 'all') return 'all:' + mrgAllParts(MRG.rows.length);
  const byPos = mrgPosCols(MRG.rows);
  const wide  = mrgFits(6);
  return 'pos:' + MRG_POS_COLS.map(([pos, parts]) => {
    const n = (byPos[pos] || []).length;
    return n && wide && n >= parts * MRG_ALL_MIN_ROWS ? parts : (n ? 1 : 0);
  }).join(',');
}

// ── Draw ─────────────────────────────────────────────────────────────────────
function mrgDraw(busy = '') {
  const el = document.getElementById(MRG.mount);
  if (!el) return;
  mrgApplyWide(true);   // both views want more than the site's normal column

  const srcSel = (MRG.sources || []).length
    ? `<select class="mrg-select" onchange="mrgSetSource(this.value)">
         ${MRG.sources.map(s => `<option value="${esc(s.id)}"${s.id === MRG.sourceId ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
       </select>`
    : `<span class="mrg-note">no ranking sets found</span>`;

  const lgSel = (MRG.leagues || []).length
    ? `<select class="mrg-select" onchange="mrgSetLeague(this.value)">
         ${MRG.leagues.map(l => `<option value="${esc(l.id)}"${l.id === MRG.leagueId ? ' selected' : ''}>${esc(l.name)}${l.espn ? ' (ESPN)' : ''}</option>`).join('')}
       </select>`
    : `<span class="mrg-note">no leagues loaded</span>`;

  const viewPills = [['all', 'All'], ['pos', 'By position']].map(([v, label]) =>
    `<button class="mrg-pill${MRG.view === v ? ' on' : ''}" onclick="mrgSetView('${v}')">${label}</button>`).join('');

  const rost = MRG.leagueId ? MRG.rosters[MRG.leagueId] : undefined;
  // A league nobody has drafted yet reports almost the whole player pool as
  // free — which would paint the board yellow and mean nothing. Below this the
  // highlight switches off rather than lying.
  const drafted = !!rost && rost.owned.size >= 20;
  const owned   = drafted ? rost.owned : null;
  const mine    = drafted ? rost.mine  : null;
  const state = r => {
    const pid = r.pid ? String(r.pid) : null;
    if (!pid || !owned) return 'unk';
    if (mine.has(pid)) return 'mine';
    return owned.has(pid) ? 'taken' : 'fa';
  };

  let nMine = 0, nFa = 0;
  for (const r of MRG.rows) { const s = state(r); if (s === 'mine') nMine++; else if (s === 'fa') nFa++; }

  const note = MRG.error       ? `<span class="mrg-note err">${esc(MRG.error)}</span>`
             : rost === null   ? `<span class="mrg-note err">rosters didn't load for this league — nothing highlighted</span>`
             : rost && !drafted ? `<span class="mrg-note">this league looks undrafted — nothing highlighted</span>`
             // No green at all is a real state (a league you're not in) but far
             // more often it means we couldn't tell which team is yours, so say
             // which it is rather than showing a silently empty board.
             : drafted && !mine.size ? `<span class="mrg-note">couldn't identify your team in this league — free agents still shown</span>`
             : MRG.unmatched   ? `<span class="mrg-note">${MRG.unmatched} ranked row${MRG.unmatched === 1 ? '' : 's'} matched no Sleeper player</span>`
             : '';

  const controls = `<div class="mrg-controls">
      ${MRG.onClose ? `<button class="mrg-pill" onclick="mrgClose()">← Back</button>` : ''}
      <span class="mrg-lbl">Ranks</span>${srcSel}
      <span class="mrg-lbl">League</span>${lgSel}
      <span class="mrg-lbl">View</span>${viewPills}
      <span style="flex:1;"></span>
      <span class="mrg-legend">
        <span><i class="mrg-sw-on"></i>my roster ${nMine}</span>
        <span><i class="mrg-sw-fa"></i>free agent ${nFa}</span>
      </span>
    </div>${note ? `<div class="mrg-noterow">${note}</div>` : ''}`;

  if (busy) { el.innerHTML = controls + `<div class="loading-state"><div class="spinner"></div>${esc(busy)}</div>`; return; }
  if (!MRG.rows.length) {
    el.innerHTML = controls + `<div class="empty-state"><p>${MRG.error
      ? 'Nothing to show.'
      : 'This ranking set is empty — build one at <a href="https://myranks.ffhistorian.com" target="_blank" style="color:var(--gold);">My Ranks</a>.'}</p></div>`;
    return;
  }

  let cols;
  if (MRG.view === 'all') {
    cols = [{ key: 'ALL', label: MRG.sourceName || 'Overall', list: mrgAllCol(MRG.rows), parts: mrgAllParts(MRG.rows.length) }];
  } else {
    // The RB/WR second column is bought with screen width; below that every
    // column runs as one, which the .mrg-wrap media rules then stack.
    const byPos = mrgPosCols(MRG.rows);
    const wide  = mrgFits(6);
    cols = MRG_POS_COLS.map(([pos, parts]) => {
      const list = byPos[pos] || [];
      // Same stub rule the ALL view uses: two columns of four names read worse
      // than one column of eight, so a short position stays whole.
      const p = (wide && list.length >= parts * MRG_ALL_MIN_ROWS) ? parts : 1;
      return { key: pos, label: pos, list, parts: p };
    }).filter(c => c.list.length);
  }

  MRG._sig    = mrgSig();
  const tracks = cols.reduce((n, c) => n + Math.max(1, c.parts), 0);
  const top    = MRG.stickyTop != null ? MRG.stickyTop : (document.querySelector('.tab-bar')?.offsetHeight || 0);

  const grid = `<div class="mrg-wrap" style="--mrg-tracks:${tracks};">${cols.map(col => {
    // Bands flip on every tier change, computed over the FULL column before the
    // split so the stripes carry across parts instead of restarting — and each
    // part keeps its rows' true indices for the same reason.
    const bands = [];
    for (let i = 0, b = 0; i < col.list.length; i++) {
      if (i > 0 && col.list[i]._tier !== col.list[i - 1]._tier) b ^= 1;
      bands.push(b);
    }
    const cell = (r, i) => {
      const st  = state(r);
      const cls = st === 'mine' ? ' mrg-on' : st === 'fa' ? ' mrg-fa' : st === 'unk' ? ' mrg-unk' : '';
      const tip = [r.name, r.team, 'tier ' + r._tier,
                   // In the positional view the tier shown is the recalculated
                   // one, so name the overall tier it came from too.
                   r._tier !== r.tier ? 'overall tier ' + r.tier : '',
                   st === 'unk' ? 'no Sleeper match' : ''].filter(Boolean).join(' · ');
      return `<div class="mrg-cell${bands[i] ? ' mrg-band' : ''}${cls}" title="${esc(tip)}">
        <span class="mrg-rank">${r._rank}</span>
        <span class="mrg-name">${esc(r.name)}</span>
        <span class="mrg-team">${esc(r.team)}</span>
        <span class="mrg-tier">${r._tier}</span>
      </div>`;
    };
    const parts = Math.max(1, col.parts);
    const per   = Math.ceil(col.list.length / parts);
    const body  = parts > 1
      ? `<div class="mrg-parts">${Array.from({ length: parts }, (_, p) =>
          `<div class="mrg-part">${col.list.slice(p * per, (p + 1) * per).map((r, i) => cell(r, p * per + i)).join('')}</div>`).join('')}</div>`
      : col.list.map((r, i) => cell(r, i)).join('');
    return `<div class="mrg-col${parts > 1 ? ' mrg-split' : ''}" style="--mrg-parts:${parts};">
      <div class="mrg-head" style="top:${top}px;">${esc(col.label)} <em>${col.list.length}</em></div>${body}</div>`;
  }).join('')}</div>`;

  el.innerHTML = controls + grid;
}
