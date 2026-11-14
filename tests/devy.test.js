// Devy placeholder resolution (devy* in shared-utils.js). Shapes mirror the
// real "Are You Into Devy Stuff?" sheet: a Player/College/Position/Manager
// table on the left, manager blocks headed by Sleeper usernames on the right,
// and draft tabs mapping placeholder → devy player.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const pages = path.join(__dirname, '..', 'pages');
const src = ['shared-core.js', 'shared-utils.js', 'league-engine.js'].map(f => fs.readFileSync(path.join(pages, f), 'utf8')).join('\n');
const ctx = { console, URLSearchParams, location: { hostname: 'helper.ffhistorian.com' }, window: { addEventListener() {} } };
vm.createContext(ctx);
const E = vm.runInContext(`${src}\n;({ devyParseNick, devyParseSheet, devyResolve, devyNameMatch, devyDraftYear })`, ctx);
const plain = v => JSON.parse(JSON.stringify(v));

const users = [
  { user_id: 'u1', display_name: 'alice' },
  { user_id: 'u2', display_name: 'BobTheBuilder' },
  { user_id: 'u3', display_name: 'muffdaddy1' },
];
const devyTab = [
  ',Player,College,Position,Manager,,alice,BobTheBuilder,MuffDaddy',
  ',Arch Manning,Texas,QB,MuffDaddy,,Jalen Lott,DJ Lagway,Arch Manning',
  ',DJ Lagway,Florida,QB,BobTheBuilder,,Keelon Russell,,',
  ',Jalen Lott,Oregon,WR,alice,,,,',
].join('\n');
const draftTab = [
  ',Pick,Player,Devy Player,College,Position,Manager',
  ',1.01,Yunghoe Koo,Keelon Russell,Alabama,QB,alice',   // typo in the placeholder's name
].join('\n');
const startup = [
  ',Startup Pick,Placeholder,Devy Player,College,Position,Manager',
  ',2.01,Younghoe Koo,Old Guy,Ohio State,WR,alice',      // older use of the same placeholder
  ',3.01,Ryan Succop,Oscar Delp,Georgia,TE,alice',
].join('\n');
const tabs = [{ name: 'Devy Players', csv: devyTab }, { name: '2026 Draft', csv: draftTab }, { name: 'Startup', csv: startup }];

const allPlayers = {
  k1: { position: 'K', full_name: 'Younghoe Koo' },
  k2: { position: 'K', full_name: 'Tyler Loop' },
  k3: { position: 'K', full_name: 'Ryan Succop' },
  d1: { position: 'DL', full_name: 'Kyle Van Noy' },
  d2: { position: 'LB', full_name: 'Somebody Else' },
  q1: { position: 'QB', full_name: 'Real Quarterback' },
  k4: { position: 'K', full_name: 'Tyler Bass' },
};
const rosters = [
  { roster_id: 1, owner_id: 'u1', players: ['k1', 'k2', 'k3', 'q1'], metadata: { p_nick_k2: 'Jalen Lott WR Oregon', p_nick_q1: 'Sir Dropalot' } },
  { roster_id: 2, owner_id: 'u2', players: ['d2'], metadata: {} },
  { roster_id: 3, owner_id: 'u3', players: ['d1', 'k4'], metadata: { p_nick_d1: 'DJ Lagway, UF, QB', p_nick_k4: 'Arch Manning ' } },
];

test('nicknames come in many shapes', () => {
  assert.deepStrictEqual(plain(E.devyParseNick('Nate Sheppard RB Duke')), { name: 'Nate Sheppard', pos: 'RB', school: 'Duke' });
  assert.deepStrictEqual(plain(E.devyParseNick('Devin Neal - RB Kansas')), { name: 'Devin Neal', pos: 'RB', school: 'Kansas' });
  assert.deepStrictEqual(plain(E.devyParseNick('DJ Lagway, UF, QB')), { name: 'DJ Lagway', pos: 'QB', school: 'UF' });
  assert.strictEqual(E.devyParseNick('Jojo Trader, NC State').name, 'Jojo Trader');
  assert.strictEqual(E.devyParseNick('  '), null);
});

test('fuzzy names: typos and trailing school words', () => {
  assert.ok(E.devyNameMatch('kemario taylor mississippi st', 'kamario taylor'));
  assert.ok(E.devyNameMatch('yunghoe koo', 'younghoe koo'));
  assert.ok(!E.devyNameMatch('bo nix', 'bo jackson'));
});

test('sheet: manager blocks are read, the left table\'s Manager column is not', () => {
  const s = E.devyParseSheet(tabs, users);
  assert.deepStrictEqual(plain(s.owners), { u1: ['Jalen Lott', 'Keelon Russell'], u2: ['DJ Lagway'], u3: ['Arch Manning'] });
  assert.strictEqual(s.info['arch manning'].school, 'Texas');
  assert.deepStrictEqual(plain(s.log.map(l => l.year)), [2026, 0, 0]);   // newest first
});

test('resolve: nickname, draft log, conflict, fallback, missing', () => {
  const sheet = E.devyParseSheet(tabs, users);
  const r = plain(E.devyResolve({ rosters, users, allPlayers, sheet }));
  // nickname on the owner's list
  assert.deepStrictEqual([r.byPid.k2.name, r.byPid.k2.src], ['Jalen Lott', 'sheet']);
  // no nickname; the 2026 draft tab (typo'd placeholder) beats the older startup row
  assert.deepStrictEqual([r.byPid.k1.name, r.byPid.k1.src], ['Keelon Russell', 'sheet']);
  // draft tab only, not on the current sheet
  assert.deepStrictEqual([r.byPid.k3.name, r.byPid.k3.src], ['Oscar Delp', 'log']);
  // Sleeper ownership wins over the sheet, flagged
  assert.deepStrictEqual([r.byPid.d1.name, r.byPid.d1.src], ['DJ Lagway', 'other']);
  assert.match(r.byPid.d1.note, /BobTheBuilder/);
  // nothing anywhere
  assert.deepStrictEqual([r.byPid.d2.name, r.byPid.d2.src], [null, null]);
  // an offensive player is never a placeholder, nickname or not
  assert.strictEqual(r.byPid.q1, undefined);
  // the conflicted player is no longer "missing" from his sheet owner
  assert.deepStrictEqual(r.missing, {});
});

test('graduates: name + position in Sleeper\'s NFL players, college may differ', () => {
  const sheet = E.devyParseSheet(tabs, users);
  const withNfl = {
    ...allPlayers,
    n1: { position: 'TE', full_name: 'Oscar Delp', college: 'Georgia', team: 'NO' },          // k3's log name → graduated
    n2: { position: 'RB', full_name: 'Jalen Lott', college: 'Virginia Tech' },               // same name, wrong position → still devy
    n3: { position: 'QB', full_name: 'Keelon Russell' },                                     // bare stub, no college/team → still devy
  };
  const r = plain(E.devyResolve({ rosters, users, allPlayers: withNfl, sheet }));
  assert.strictEqual(r.byPid.k3.nfl, true);
  assert.ok(!r.byPid.k2.nfl);
  assert.ok(!r.byPid.k1.nfl);
});

test('typos: an adjacent swap counts as one edit ("Reuban Bain" is Rueben Bain)', () => {
  assert.ok(E.devyNameMatch('rueben bain', 'reuban bain'));
  assert.ok(!E.devyNameMatch('ruben bane', 'reuban bain jr x'));
});

test('two placeholders with the same nickname: the draft tab picks the real one', () => {
  const tabs2 = [
    { name: 'Devy Players', csv: ',Player,College,Position,Manager,,alice,BobTheBuilder\n,Duce Robinson,USC,TE,alice,,Duce Robinson,' },
    { name: 'Startup', csv: ',Startup Pick,Placeholder,Devy Player\n,1.01,Cole Murphy,Duce Robinson' },
  ];
  const ap = { a: { position: 'K', full_name: 'Stephen Hauschka' }, b: { position: 'K', full_name: 'Cole Murphy' } };
  const ro = [{ roster_id: 1, owner_id: 'u1', players: ['a', 'b'], metadata: { p_nick_a: 'Duce Robinson', p_nick_b: 'Duce Robinson' } }];
  const r = plain(E.devyResolve({ rosters: ro, users, allPlayers: ap, sheet: E.devyParseSheet(tabs2, users) }));
  assert.strictEqual(r.byPid.b.src, 'sheet');
  assert.match(r.byPid.a.note, /Duplicate: Cole Murphy/);
});

test('config: ignore + rename, punters are placeholders, missing names say why', () => {
  const tabs3 = [
    { name: 'Devy Players', csv: ',Player,College,Position,Manager,,alice,BobTheBuilder\n,x,y,z,alice,,Sheloton Sampson Jr,Gone Guy\n,,,,,,Dropped Kid,\n,,,,,,Punted Pal,' },
    { name: '2026 Draft', csv: ',Pick,Player,Devy Player\n,1.01,Jared Verse,Dropped Kid\n,1.02,Brandon Wright,Punted Pal\n,1.03,Some Kicker,Sheloton Sampson Jr' },
  ];
  const ap = { p: { position: 'P', full_name: 'Brandon Wright' }, v: { position: 'DL', full_name: 'Jared Verse' }, s: { position: 'K', full_name: 'Some Kicker' } };
  const ro = [{ roster_id: 1, owner_id: 'u1', players: ['p', 's'], metadata: {} }, { roster_id: 2, owner_id: 'u2', players: [], metadata: {} }];
  const sheet = E.devyParseSheet(tabs3, users, { rename: { 'Sheloton Sampson Jr': 'Shelton Sampson Jr' } });
  const r = plain(E.devyResolve({ rosters: ro, users, allPlayers: ap, sheet, ignore: ['Gone Guy'] }));
  assert.strictEqual(r.byPid.p.name, 'Punted Pal');
  assert.strictEqual(r.byPid.s.name, 'Shelton Sampson Jr');
  assert.deepStrictEqual(r.missing[1].map(m => m.name), ['Dropped Kid']);
  assert.match(r.missing[1][0].note, /Jared Verse .*dropped/);
  assert.strictEqual(r.missing[2], undefined);   // Gone Guy ignored
});

test('ESPN matching (worker/src/devy.js): names, schools, candidates', async () => {
  const W = await import(path.join(__dirname, '..', 'worker', 'src', 'devy.js'));
  assert.ok(W.espnNameMatch('Ryan Williams', 'Ryan Coleman-Williams'));   // first + last token
  assert.ok(W.espnNameMatch('Eyiss Williams', 'Elyiss Williams'));        // sheet typo
  assert.ok(W.espnNameMatch('Eric Singleton', 'Eric Singleton Jr.'));
  assert.ok(!W.espnNameMatch('Jordan Davison', 'Jordan Marshall'));
  assert.ok(W.espnSchoolMatch('Ohio State', 'Ohio State Buckeyes'));
  const search = { results: [{ contents: [
    { displayName: 'Bo Jackson', defaultLeagueSlug: 'college-football', subtitle: 'Auburn Tigers', uid: 's:20~l:23~a:560118' },
    { displayName: 'Bo Jackson', defaultLeagueSlug: 'mlb', subtitle: 'Royals', uid: 's:1~l:10~a:1' },
    { displayName: 'Bo Jackson', defaultLeagueSlug: 'college-football', subtitle: 'Ohio State Buckeyes', uid: 's:20~l:23~a:5141517' },
  ] }] };
  const c = W.espnCandidates(search, 'Bo Jackson');
  assert.deepStrictEqual(c.map(x => x.id), ['5141517', '560118']);   // college only, newest first
});

test('draft year: three seasons out of high school, from the ESPN class', () => {
  const nov2026 = new Date(2026, 10, 13), cur = { statsLabel: '2026 season stats' };
  const y = cls => plain(E.devyDraftYear({ ...cur, cls }, nov2026));
  assert.deepStrictEqual([y('Senior').year, y('Senior').final], [2027, true]);
  assert.deepStrictEqual([y('Junior').year, y('Junior').final], [2027, false]);
  assert.strictEqual(y('Sophomore').year, 2028);
  assert.strictEqual(y('Freshman').year, 2029);
  assert.strictEqual(y('Redshirt Freshman').year, 2028);
  // ESPN's latest line is an older season: the class is aged forward.
  assert.strictEqual(E.devyDraftYear({ cls: 'Freshman', statsLabel: '2025 season stats' }, nov2026).year, 2028);
  // Spring: still the 2026 draft cycle's season until March.
  assert.strictEqual(E.devyDraftYear({ cls: 'Junior' }, new Date(2027, 0, 20)).year, 2027);
  assert.strictEqual(E.devyDraftYear({ cls: '' }, nov2026), null);
});
