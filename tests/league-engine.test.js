// Run with: node --test tests/*.test.js
// Loads the browser scripts the way a page does (no module system) and tests the
// rules that have broken before.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pages = path.join(__dirname, '..', 'pages');
const src = ['shared-core.js', 'shared-utils.js', 'league-engine.js'].map(f => fs.readFileSync(path.join(pages, f), 'utf8')).join('\n');
const ctx = { console, URLSearchParams, location: { hostname: 'helper.ffhistorian.com' }, window: { addEventListener() {} } };
vm.createContext(ctx);
const E = vm.runInContext(`${src}\n;({ SLOT_ELIG, optimalLineupAndSigma, pickOptimalLineup, bracketByeSlots, runSimulation, finalStandingOdds, sleeperMaxPf, ownedPicks, rosterOwnerNames, getPickValue, buildPickValueMap, ESPN_POS_MAP, crNormPos, normName, csvTable, espnMyTeam, espnSlotList })`, ctx);

const plain = v => JSON.parse(JSON.stringify(v));

test('bracket byes follow the real bracket', () => {
  assert.deepStrictEqual([4, 5, 6, 7, 8, 12].map(E.bracketByeSlots), [0, 3, 2, 1, 0, 4]);
  assert.strictEqual(E.bracketByeSlots(0), 0);
});

test('every flex slot gets filled, narrowest first', () => {
  const pool = [
    { pid: 'r1', pos: 'RB', pts: 20 }, { pid: 'w1', pos: 'WR', pts: 18 },
    { pid: 'w2', pos: 'WR', pts: 15 }, { pid: 't1', pos: 'TE', pts: 12 },
    { pid: 'r2', pos: 'RB', pts: 9 },
  ];
  const { starters, bench } = E.pickOptimalLineup(pool, ['RB', 'WR', 'FLEX', 'WRRB_FLEX', 'REC_FLEX', 'BN']);
  assert.deepStrictEqual(plain(starters.map(s => [s.slot, s.pid])),
    [['RB', 'r1'], ['WR', 'w1'], ['WRRB_FLEX', 'w2'], ['REC_FLEX', 't1'], ['FLEX', 'r2']]);
  assert.strictEqual(bench.length, 0);
});

test('a lineup counts its WRRB_FLEX starter in mu', () => {
  const players = { a: { position: 'RB' }, b: { position: 'WR' } };
  const proj = { a: { x: 10 }, b: { x: 7 } };
  const { mu } = E.optimalLineupAndSigma(['a', 'b'], proj, { x: 1 }, ['RB', 'WRRB_FLEX'], players);
  assert.strictEqual(mu, 17);
});

function miniLeague(playoffTeams, opts) {
  const teams = [1, 2, 3, 4, 5, 6, 7, 8].map(r => ({ rosterId: r, wins: 0, fpts: 100, maxPf: 100 + r * 10 }));
  const games = [[1, 2], [3, 4], [5, 6], [7, 8]];
  const week = games.flatMap(([a, b], i) => [{ matchup_id: i + 1, roster_id: a }, { matchup_id: i + 1, roster_id: b }]);
  const mu = {}, sig = {};
  for (const t of teams) { mu[t.rosterId] = { 1: 100 }; sig[t.rosterId] = { 1: 10 }; }
  return E.runSimulation(teams, { 1: week }, mu, sig, [1], playoffTeams, opts, 400);
}

test('sim: bye is null when the bracket has none, and sums to the slots when it does', () => {
  assert.strictEqual(miniLeague(4).bye, null);
  const sum = Object.values(miniLeague(6).bye).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 2) < 1e-9);
});

test('sim: odds sum to the playoff field, and last place reads banked Max PF', () => {
  const r = miniLeague(6);
  assert.ok(Math.abs(Object.values(r.odds).reduce((a, b) => a + b, 0) - 6) < 1e-9);
  assert.ok(r.lastPf[1] > r.lastPf[8]);
});

test('final standings use the same bracket and Max PF rules', () => {
  const teams = [
    { rosterId: 1, wins: 9, fpts: 200, maxPf: 300 }, { rosterId: 2, wins: 8, fpts: 300, maxPf: 250 },
    { rosterId: 3, wins: 5, fpts: 150, maxPf: 400 }, { rosterId: 4, wins: 2, fpts: 100, maxPf: 280 },
  ];
  const r = plain(E.finalStandingOdds(teams, 3));
  assert.deepStrictEqual(r.odds, { 1: 1, 2: 1, 3: 1, 4: 0 });
  assert.deepStrictEqual(r.bye, { 1: 1, 2: 0, 3: 0, 4: 0 });
  assert.deepStrictEqual(r.lastPf, { 1: 0, 2: 1, 3: 0, 4: 0 });
});

test('sleeperMaxPf reads ppts + decimal, null before anything is scored', () => {
  assert.strictEqual(E.sleeperMaxPf({ settings: { ppts: 100, ppts_decimal: 50 } }), 100.5);
  assert.strictEqual(E.sleeperMaxPf({ settings: {} }), null);
});

test('picks: traded picks move holders and name the original OWNER, not the team', () => {
  const rosters = [{ roster_id: 1, owner_id: 'u1' }, { roster_id: 2, owner_id: 'u2' }];
  const users = [
    { user_id: 'u1', display_name: 'nick', metadata: { team_name: 'Team A' } },
    { user_id: 'u2', display_name: 'sam', metadata: { team_name: 'Team B' } },
  ];
  const tradedPicks = [{ season: '2027', round: 1, roster_id: 2, owner_id: 1 }];
  const ownerNames = E.rosterOwnerNames(rosters, users);
  const mine = plain(E.ownedPicks({ rosterId: 1, rosters, tradedPicks, firstSeason: 2027, seasons: 1, rounds: 1, ownerNames }));
  assert.deepStrictEqual(mine, [
    { season: '2027', round: 1, orig: 1, viaName: null },
    { season: '2027', round: 1, orig: 2, viaName: 'sam' },
  ]);
  const theirs = plain(E.ownedPicks({ rosterId: 2, rosters, tradedPicks, firstSeason: 2027, seasons: 1, rounds: 1, ownerNames }));
  assert.deepStrictEqual(theirs, []);
});

test('picks: the window can widen to a traded season, unless windowOnly', () => {
  const rosters = [{ roster_id: 1 }];
  const tradedPicks = [{ season: '2031', round: 1, roster_id: 1, owner_id: 1 }];
  const base = { rosterId: 1, rosters, tradedPicks, firstSeason: 2027, seasons: 1, rounds: 1 };
  assert.deepStrictEqual(plain(E.ownedPicks(base).map(p => p.season)), ['2027', '2031']);
  assert.deepStrictEqual(plain(E.ownedPicks({ ...base, windowOnly: true }).map(p => p.season)), ['2027']);
});

test('pick value: a banded entry never gets overwritten by the unqualified one', () => {
  const fc = [
    { player: { name: '2027 1st (Mid)', position: 'PI' }, value: 3070 },
    { player: { name: '2027 1st', position: 'PI' }, value: 2899 },
  ];
  const map = E.buildPickValueMap(fc);
  assert.strictEqual(map['2027_1_mid'], 3070);
  assert.strictEqual(map['2027_1'], 2899);
  assert.strictEqual(E.getPickValue('2027', 1, 1, null, 12, map, 'mid'), 3070);
  assert.strictEqual(E.getPickValue('2027', 5, 1, null, 12, map), 0);
});

test('ESPN position 16 is D/ST, so it never counts as a DB', () => {
  assert.strictEqual(E.ESPN_POS_MAP[16], 'DEF');
  assert.strictEqual(E.crNormPos(E.ESPN_POS_MAP[16]), null);
});

test('normName: one rule for punctuation, hyphens, accents, suffixes and aliases', () => {
  for (const [a, b] of [
    ['Amon-Ra St. Brown', 'Amon Ra St Brown'], ['C.J. Stroud', 'CJ Stroud'], ["Tre' Harris", 'Tre Harris'],
    ['Michael Pittman Jr.', 'Michael Pittman'], ['José Ramírez', 'Jose Ramirez'], ['Kenneth Gainwell', 'Kenny Gainwell'],
  ]) assert.strictEqual(E.normName(a), E.normName(b));
});

test('csvTable handles a quoted comma, CRLF and a BOM', () => {
  assert.deepStrictEqual(plain(E.csvTable('﻿name,tier\r\n"Smith, Jr",1\r\n\r\n Bob , 2 ')),
    [['name', 'tier'], ['Smith, Jr', '1'], ['Bob', '2']]);
});

test('ESPN "my team" matches co-owners and ignores case, but never an empty SWID', () => {
  const teams = [{ id: 1, primaryOwner: '{AAA}' }, { id: 2, primaryOwner: '{BBB}', owners: ['{BBB}', '{ccc}'] }];
  assert.strictEqual(E.espnMyTeam(teams, '{aaa}').id, 1);
  assert.strictEqual(E.espnMyTeam(teams, '{CCC}').id, 2);
  assert.strictEqual(E.espnMyTeam(teams, ''), null);
});

test('one ESPN slot table folds per tool', () => {
  const counts = { 0: 1, 3: 1, 16: 1, 20: 2 };
  assert.deepStrictEqual(plain(E.espnSlotList(counts)), ['QB', 'WRRB_FLEX', 'DEF', 'BN', 'BN']);
});
