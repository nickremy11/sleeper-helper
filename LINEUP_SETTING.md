# Setting Sleeper lineups programmatically — logic + reference code

Extracted from the NCFL Sleeper Helper (`pages/index.html`, Lineup Checker). The originals read
app globals (`S`, `LU`); the code below is the same logic with those turned into arguments, so it
runs standalone. Plain JS, no dependencies.

There are three parts: **(1)** write a lineup, **(2)** decide the best lineup, **(3)** the gotchas
that cost us time.

---

## 1. Writing a lineup

Sleeper's web app uses an undocumented GraphQL endpoint, `https://sleeper.com/graphql`. The public
REST API (`api.sleeper.app/v1`) is read-only — it cannot set lineups.

**Auth.** Send the user's Sleeper web token in the `Authorization` header (no `Bearer` prefix). It
is the token the sleeper.com web app uses; there is no official way to mint one. Treat it like a
password: store it encrypted, never log it.

**Browser vs server.** A browser page can't call sleeper.com/graphql directly (CORS, and it needs
`Origin: https://sleeper.com`). We proxy through a Cloudflare Worker that adds the headers. From a
server/script, call it directly.

```js
const SLEEPER_GQL = 'https://sleeper.com/graphql';

async function sleeperGql(op, query, token, variables = {}) {
  const r = await fetch(SLEEPER_GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'X-Sleeper-Graphql-Op': op,          // must equal the mutation's operation name
      'Origin': 'https://sleeper.com',
      'Referer': 'https://sleeper.com/',
    },
    body: JSON.stringify({ operationName: op, variables, query }),
  });
  if (!r.ok) throw new Error('GQL HTTP ' + r.status);
  const json = await r.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

// starters: array of player_id strings, ONE PER SLOT, in the league's roster_positions order
// (bench/IR/taxi excluded). '0' = empty slot. week: the NFL week being set.
async function setLineup(token, leagueId, rosterId, week, starters) {
  const query = `mutation update_matchup_leg($starters_games: Map) {
    update_matchup_leg(league_id: "${leagueId}", roster_id: ${rosterId}, leg: ${week}, round: ${week},
                       starters: ${JSON.stringify(starters.map(String))}, starters_games: $starters_games) {
      league_id leg roster_id round starters
    }
  }`;
  const data = await sleeperGql('update_matchup_leg', query, token);
  return data?.update_matchup_leg;
}

// Write, then verify Sleeper echoed back exactly what we sent.
async function putStarters(token, leagueId, rosterId, week, starters) {
  const res = await setLineup(token, leagueId, rosterId, week, starters);
  const echoed = (res?.starters || []).map(String);
  const ok = echoed.length === starters.length && echoed.every((p, i) => p === String(starters[i]));
  return { ok, starters: echoed };
}
```

Notes:
- `leg` and `round` are both the week number.
- `starters_games` is declared but left unset; that works.
- Interpolating ids into the query string is what the app does today. Prefer GraphQL variables if
  you can (ids are numeric strings from Sleeper, so it's safe in practice).
- **Always check the echo.** Sleeper can accept the write yet return a different lineup (e.g. it
  rejected a locked player). Treat a mismatch as a warning, not success.

### Inputs you need (all from the public REST API)
- `GET /v1/league/{id}` → `roster_positions` (e.g. `["QB","RB","RB","WR","WR","TE","FLEX","SUPER_FLEX","K","DEF","BN",...]`), `scoring_settings`
- `GET /v1/league/{id}/rosters` → each roster's `roster_id`, `owner_id`, `players`, `starters`, `reserve` (IR), `taxi`
- `GET /v1/players/nfl` → player map (`position`, `team`, `injury_status`)
- `GET /v1/projections/nfl/regular/{season}/{week}` → projected stat lines (scored with the league's `scoring_settings`)
- NFL kickoff times (we use ESPN's public scoreboard) → who is locked

Slots passed to the optimizer = `roster_positions` with `BN`, `IR`, `TAXI` removed. The starters
array is indexed by those slots.

---

## 2. Choosing the lineup

### Slot eligibility
```js
const FLEX_ELIG = {
  FLEX:       ['RB', 'WR', 'TE'],
  WRRB_FLEX:  ['RB', 'WR'],
  REC_FLEX:   ['WR', 'TE'],
  SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
  IDP_FLEX:   ['DL', 'LB', 'DB'],
};
const IDP = { DL: 'DL', DE: 'DL', DT: 'DL', LB: 'LB', DB: 'DB', CB: 'DB', S: 'DB', FS: 'DB', SS: 'DB' };

function normPos(raw) {                       // collapse Sleeper positions to our groups
  const u = String(raw || '').toUpperCase();
  if (['QB', 'RB', 'WR', 'TE', 'K'].includes(u)) return u;
  if (u === 'DEF' || u === 'DST') return 'DEF';
  return IDP[u] || null;
}
function slotElig(slot) {
  if (FLEX_ELIG[slot]) return FLEX_ELIG[slot];
  const p = normPos(slot);
  return p ? [p] : null;                      // null = unknown slot → leave it alone
}
```

### Scoring a player (projections mode)
Multiply every projected stat by whatever the league scores for that stat. Generic on purpose, so
K and DEF work too (a fixed offense-only formula prices them at 0).
```js
function projPts(statLine, scoring) {
  let pts = 0;
  for (const [k, v] of Object.entries(statLine || {})) if (typeof scoring[k] === 'number') pts += v * scoring[k];
  return pts;
}
```
(Our version also handles the league's bonus thresholds; add if you need exactness.)

### The optimizer
Inputs: `slots` (roster_positions minus BN/IR/TAXI), `starters` (current, per slot), `players`
(everyone rostered), `excluded` (IR/taxi ids), `pts(pid)`, `pos(pid)`, `locked(pid)`, `isOut(pid)`.

```js
const BAD_INJ = new Set(['OUT', 'IR', 'SUS', 'NA', 'PUP', 'DNR', 'COV', 'DNP', 'O']);
// "Questionable"/"Doubtful" deliberately stay startable.

function buildOptimalStarters({ slots, starters, players, excluded, pts, pos, locked, isOut, kickoff }) {
  const startSet = new Set(starters.map(String));

  // Candidate pool
  const pool = [];
  for (const pid of players) {
    const p = pos(pid); if (!p) continue;
    if (excluded.has(String(pid)) && !startSet.has(String(pid))) continue;   // IR/taxi can't start
    if (locked(pid) && !startSet.has(String(pid))) continue;                  // game started → can't be moved IN
    if (isOut(pid) && !startSet.has(String(pid))) continue;                   // don't start an Out player
    pool.push({ pid: String(pid), pos: p });
  }
  const byId = Object.fromEntries(pool.map(p => [p.pid, p]));
  const poolIds = new Set(pool.map(p => p.pid));

  // Freeze slots we must not touch
  const frozen = new Array(slots.length).fill(false);
  const used = new Set();
  slots.forEach((slot, i) => {
    const cur = String(starters[i] || '0');
    if (cur !== '0' && !poolIds.has(cur)) { used.add(cur); frozen[i] = true; }        // no data on him
    if (cur !== '0' && locked(cur))       { used.add(cur); frozen[i] = true; return; } // already playing
    if (!slotElig(slot)) frozen[i] = true;                                             // unknown slot
    const e = slotElig(slot);
    if (e && (e[0] === 'K' || e[0] === 'DEF')) frozen[i] = true;   // only move K/DEF if you have a ranking source
  });

  // PHASE 1 — greedy: best eligible player per slot.
  // Dedicated slots FIRST, then flex. This ordering matters: QB1 is claimed by the QB slot, so a
  // SUPER_FLEX then lands on your QB2 (or the best flex player if QB2 is worse).
  const assign = starters.map(String);
  const pick = elig => {
    let best = null, bestPts = -Infinity;
    for (const p of pool) {
      if (used.has(p.pid) || !elig.includes(p.pos)) continue;
      const v = pts(p.pid);
      if (v > bestPts) { best = p; bestPts = v; }
    }
    if (best) { used.add(best.pid); return best.pid; }
    return '0';
  };
  slots.forEach((s, i) => { if (!frozen[i] && !FLEX_ELIG[s]) assign[i] = pick(slotElig(s)); });
  slots.forEach((s, i) => { if (!frozen[i] &&  FLEX_ELIG[s]) assign[i] = pick(FLEX_ELIG[s]); });

  // PHASE 2 — churn reduction. Swap two players between slots when both stay eligible and it
  // moves more of them back to where they currently are. Value-neutral; just stops cosmetic
  // reshuffles (two FLEX guys trading slots) showing up as "changes".
  const cur = starters.map(String);
  for (let guard = 0, improved = true; improved && guard < 50; guard++) {
    improved = false;
    for (let i = 0; i < slots.length; i++) {
      if (frozen[i]) continue; const ei = slotElig(slots[i]); if (!ei) continue;
      for (let j = i + 1; j < slots.length; j++) {
        if (frozen[j]) continue; const ej = slotElig(slots[j]); if (!ej) continue;
        const pi = byId[assign[i]], pj = byId[assign[j]];
        const iToJ = assign[i] === '0' || (pi && ej.includes(pi.pos));
        const jToI = assign[j] === '0' || (pj && ei.includes(pj.pos));
        if (!iToJ || !jToI) continue;
        const before = (assign[i] === cur[i]) + (assign[j] === cur[j]);
        const after  = (assign[j] === cur[i]) + (assign[i] === cur[j]);
        if (after > before) { [assign[i], assign[j]] = [assign[j], assign[i]]; improved = true; }
      }
    }
  }

  // PHASE 3 — kickoff ordering (score-neutral). Within a position, put the player with the
  // LATEST game in the flex slot and the earliest game in the dedicated slot, so the flex
  // decision stays open as long as possible.
  if (kickoff) orderByKickoff(assign, slots, pos, kickoff, locked);
  return assign;
}

function orderByKickoff(out, slots, pos, kickoff, locked) {
  ['QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB'].forEach(P => {
    const ded = [], flex = [];
    slots.forEach((slot, i) => {
      const pid = String(out[i] || '0');
      if (pid === '0' || pos(pid) !== P || locked(pid)) return;
      if (FLEX_ELIG[slot]) flex.push(i); else if (normPos(slot) === P) ded.push(i);
    });
    if (!ded.length || !flex.length) return;
    for (let g = 0; g < 20; g++) {
      const fi = flex.reduce((a, b) => kickoff(out[b]) < kickoff(out[a]) ? b : a);  // earliest in flex
      const di = ded.reduce((a, b) => kickoff(out[b]) > kickoff(out[a]) ? b : a);   // latest in dedicated
      if (kickoff(out[fi]) < kickoff(out[di])) [out[fi], out[di]] = [out[di], out[fi]]; else break;
    }
  });
}
```
`kickoff(pid)` returns ms epoch of his game, or `Infinity` if unknown. `locked(pid)` is below.

### Kickoff locks
```js
const locked = pid => { const t = kickoff(pid); return t !== Infinity && t <= Date.now(); };
```
Once a player's game has kicked off he can't be moved out of a starting slot or into one, and his
points are banked. The optimizer freezes his slot and drops locked bench players from the pool.
**Unknown ⇒ not locked** (bye week, no team, or the schedule fetch failed). A failed fetch should
disable the feature, not freeze half a lineup.

---

## 3. Gotchas

1. **Which week to set.** Sleeper's `state/nfl` publishes `leg`/`week` and `display_week`, and they
   disagree for about a day each week. `display_week` lags (still the finished week through
   Tuesday). For *setting* lineups use `leg` (fallback `display_week`); only during
   `season_type === 'regular'`.
2. **Order of slots.** The `starters` array must line up with `roster_positions` after removing
   `BN`/`IR`/`TAXI`. Off-by-one here silently puts players in the wrong slots.
3. **Empty slot is `'0'`**, not `null`.
4. **Never start an Out player**; keep Questionable/Doubtful startable. Sleeper spells statuses out
   (`"Out"`, `"Questionable"`), so compare case-insensitively.
5. **Write one lineup at a time** with a small gap between leagues if you're bulk-applying; re-read
   the roster just before writing, since it may have changed since you computed.
6. **Verify the echo** (see `putStarters`).
7. **Ranks instead of projections.** If you rank players from a weekly sheet, ranks are
   *positional* (QB1 and RB1 are both 1), so you can't use a single scalar. We sort with a 3-tuple,
   lower wins: dedicated → `[0, posRank, 0]`; flex → `[0, flexRank, 0]` (the sheet's cross-position
   FLEX list); SUPER_FLEX → QB `[0, posRank, 0]`, else `[1, flexRank, 0]`; anyone unranked falls
   to a last band ordered by projected points. Compare tuples lexicographically.
8. **Don't mutate shared state on a failed write**; the app only updates its local lineup from
   Sleeper's echo.

## Flow summary
```
league + rosters + players + projections + kickoffs
  → slots = roster_positions − {BN, IR, TAXI}
  → buildOptimalStarters(...)        // greedy → churn swap → kickoff order
  → putStarters(token, leagueId, rosterId, week, starters)
  → compare echo to what you sent
```
