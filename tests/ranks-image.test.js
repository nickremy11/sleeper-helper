// /api/ranks/image: reading the model's one-line-per-row answer (worker/src/ranks-image.js).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const load = () => import(path.join(__dirname, '../worker/src/ranks-image.js'));

test('headers start tables, rows keep printed cell order', async () => {
  const { parseRankLines } = await load();
  const t = parseRankLines([
    '# Rank Quarterback Team Opp Tier',
    '1|Josh Allen|BUF|MIA|1',
    '2|Joe Burrow|CIN|WAS|1',
    '# Rank Tight End Team Opp Tier',
    '1|Trey McBride|ARI|KC|1',
  ].join('\n'));
  assert.deepStrictEqual(t, [
    { header: 'Rank Quarterback Team Opp Tier', rows: [['1', 'Josh Allen', 'BUF', 'MIA', '1'], ['2', 'Joe Burrow', 'CIN', 'WAS', '1']] },
    { header: 'Rank Tight End Team Opp Tier', rows: [['1', 'Trey McBride', 'ARI', 'KC', '1']] },
  ]);
});

test('the " | " format the prompt asks for is trimmed', async () => {
  const { parseRankLines } = await load();
  const t = parseRankLines('# Rank FLEX | Pos | Opp\n1 | Emmett Johnson | RB | ARI\n2 | Ja\'Marr Chase | WR | WAS');
  assert.deepStrictEqual(t, [{ header: 'Rank FLEX Pos Opp', rows: [['1', 'Emmett Johnson', 'RB', 'ARI'], ['2', "Ja'Marr Chase", 'WR', 'WAS']] }]);
});

test('a header written with | separators is still one header (seen from Mistral)', async () => {
  const { parseRankLines } = await load();
  const t = parseRankLines('# Rank Defense|Opp|Tier\n1|Kansas City Chiefs|ARI|1');
  assert.strictEqual(t[0].header, 'Rank Defense Opp Tier');
  assert.deepStrictEqual(t[0].rows, [['1', 'Kansas City Chiefs', 'ARI', '1']]);
});

test('a strip that starts mid-table gets a null header; blanks become null', async () => {
  const { parseRankLines } = await load();
  const t = parseRankLines('51|Keon Coleman|BUF|MIA|\n52|Khalil Shakir|BUF|MIA|10');
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].header, null);
  assert.deepStrictEqual(t[0].rows[0], ['51', 'Keon Coleman', 'BUF', 'MIA', null]);
});

test('prose, code fences and lines without a leading rank are ignored', async () => {
  const { parseRankLines } = await load();
  const t = parseRankLines('Here are the rows:\n```\n# Rank Kicker Team Opp Tier\n|1|Tyler Bass|BUF|MIA|1|\nRank|Name\n```');
  assert.deepStrictEqual(t, [{ header: 'Rank Kicker Team Opp Tier', rows: [['1', 'Tyler Bass', 'BUF', 'MIA', '1']] }]);
});

test('no rows at all → nothing', async () => {
  const { parseRankLines } = await load();
  assert.deepStrictEqual(parseRankLines('{"tables":[]}'), []);
  assert.deepStrictEqual(parseRankLines(''), []);
});
