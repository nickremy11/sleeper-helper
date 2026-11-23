// Run with: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');
const { lmRootScores } = require('../pages/matchup-tracker.js');

const row = (id, mine, theirs, bb) => ({
  league: { league_id: id, settings: { best_ball: bb ? 1 : 0 } },
  myMatchup: bb ? { players: mine } : { starters: mine },
  oppMatchup: bb ? { players: theirs } : { starters: theirs },
});

test('root score = share of contending $ on my side', () => {
  const prefs = { a: { value: 30, contender: true }, b: { value: 10, contender: true }, c: { value: 500, contender: false } };
  const r = lmRootScores([row('a', ['1'], ['2']), row('b', ['2'], ['1']), row('c', ['2'], ['1'])], prefs);
  assert.deepStrictEqual(r['1'], { score: 75, mine: 1, theirs: 1 });   // rebuilding league c ignored
  assert.deepStrictEqual(r['2'], { score: 25, mine: 1, theirs: 1 });
});

test('no $ set: 100 if I start him anywhere, else 0; empty slots skipped', () => {
  const prefs = { a: { value: 0, contender: true } };
  const r = lmRootScores([row('a', ['1', '0', null], ['2'])], prefs);
  assert.strictEqual(r['1'].score, 100);
  assert.strictEqual(r['2'].score, 0);
  assert.strictEqual(r['0'], undefined);
});

test('best ball counts the whole roster', () => {
  const r = lmRootScores([row('a', ['1', '3'], ['2'], true)], { a: { value: 5, contender: true } });
  assert.strictEqual(r['3'].score, 100);
});

const { lmLine, lmProjectSide, lmFillOptimal } = require('../pages/matchup-tracker.js');

test('an Out player projects nothing and is neither live nor to go', () => {
  const pre = lmLine({ pid: 'a', pts: 0, proj: 15, pos: 'WR', f: 1, out: true });
  assert.strictEqual(pre.rest, 0);
  assert.strictEqual(pre.toGo, false);
  const mid = lmLine({ pid: 'a', pts: 4, proj: 15, pos: 'WR', f: 0.5, out: true, live: true });
  assert.strictEqual(mid.expFinal, 4);   // points already scored still count
  assert.strictEqual(mid.live, false);
});

test('a side counts live and to-go starters separately', () => {
  const side = lmProjectSide({ now: 10, lines: [
    lmLine({ pid: 'a', pts: 10, proj: 12, pos: 'RB', f: 0.4, live: true }),
    lmLine({ pid: 'b', pts: 0, proj: 12, pos: 'WR', f: 1, live: false }),
    lmLine({ pid: 'c', pts: 0, proj: 9, pos: 'WR', f: 1, out: true }),
    lmLine({ pid: 'd', pts: 7, proj: 9, pos: 'TE', f: 0 }),
  ] });
  assert.strictEqual(side.live, 1);
  assert.strictEqual(side.toGo, 1);
});

test('optimal fill keeps locked starters and promotes the best bench player', () => {
  const L = (pid, pos, expFinal, locked = false) => ({ pid, pos, expFinal, locked });
  const slots = [
    { elig: ['QB'], cur: L('qb', 'QB', 20, true) },
    { elig: ['WR'], cur: L('w1', 'WR', 0) },            // Out, unlocked
    { elig: ['RB', 'WR', 'TE'], cur: L('r1', 'RB', 8) },
  ];
  const bench = [L('w2', 'WR', 11), L('t1', 'TE', 9), L('w3', 'WR', 30, true)];   // w3 already played: can't come in
  const got = lmFillOptimal(slots, bench).map(l => l && l.pid);
  assert.deepStrictEqual(got, ['qb', 'w2', 't1']);
});

test('optimal fill never swaps in a bench player projected for nothing', () => {
  const L = (pid, pos, expFinal, locked = false) => ({ pid, pos, expFinal, locked });
  const got = lmFillOptimal([{ elig: ['DL'], cur: null }, { elig: ['WR'], cur: L('w1', 'WR', 0) }], [L('bye', 'DL', 0), L('w2', 'WR', 0)]);
  assert.deepStrictEqual(got.map(l => l && l.pid), [null, 'w1']);
});
