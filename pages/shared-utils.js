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
