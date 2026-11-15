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
