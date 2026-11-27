// Yahoo → Sleeper shapes (worker/src/yahoo-shape.js) and the XML reader
// (worker/src/yahoo-xml.js), run against the sample responses in Yahoo's own
// API docs (sports.yahoo.com/developer/docs — league 390.l.1000, 2019).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const xml = n => fs.readFileSync(path.join(__dirname, 'fixtures/yahoo', n + '.xml'), 'utf8');
const shape = () => import(path.join(__dirname, '../worker/src/yahoo-shape.js'));
const reader = () => import(path.join(__dirname, '../worker/src/yahoo-xml.js'));
const ids = () => import(path.join(__dirname, '../worker/src/player-ids.js'));
const doc = async n => (await reader()).parseXml(xml(n)).fantasy_content;

test('XML reader: lists, single elements, entities, empty elements', async () => {
  const { parseXml, arr } = await reader();
  const d = parseXml('<?xml version="1.0"?><a><b>1</b><b>2</b><c x="1">A &amp; B&#39;s</c><e/><f><g>x</g></f></a>').a;
  assert.deepEqual(d.b, ['1', '2']);
  assert.equal(d.c, "A & B's");
  assert.equal(d.e, '');
  assert.deepEqual(arr(d.f.g), ['x']);
  assert.deepEqual(arr(d.e), []);
});

test('league: slots, scoring, playoffs from the documented settings sample', async () => {
  const { yahooLeague } = await shape();
  const lg = yahooLeague({ league: (await doc('settings')).league });
  assert.equal(lg.league_id, 'yh_2019_1000');
  assert.equal(lg.status, 'complete');
  assert.deepEqual(lg.roster_positions.filter(p => p !== 'BN'), ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'FLEX', 'K', 'DEF']);
  assert.equal(lg.roster_positions.filter(p => p === 'BN').length, 6);
  assert.equal(lg.settings.reserve_slots, 1);
  assert.equal(lg.settings.playoff_teams, 4);
  assert.equal(lg.settings.playoff_week_start, 15);
  const s = lg.scoring_settings;
  assert.equal(s.pass_yd, 0.04); assert.equal(s.pass_td, 4); assert.equal(s.pass_int, -1);
  assert.equal(s.rec, 0.5); assert.equal(s.rush_yd, 0.1); assert.equal(s.fum_lost, -2);
  assert.equal(s.pass_2pt, 2); assert.equal(s.rec_2pt, 2);
  assert.equal(s.fgm_40_49, 4); assert.equal(s.xpm, 1);
  assert.equal(s.pts_allow_0, 10); assert.equal(s.pts_allow_35p, -4); assert.equal(s.def_st_td, 6);
  // "Extra Point Returned" (82) has no Sleeper key — named, not dropped silently.
  assert.ok(lg._yahoo.scoring_approx.includes('Extra Point Returned'));
});

test('scoring: yardage bonuses land on Sleeper bonus keys', async () => {
  const { yahooScoring } = await shape();
  const { scoring } = yahooScoring({ stat_modifiers: { stats: { stat: [
    { stat_id: '4', value: '0.04', bonuses: { bonus: [{ target: '300', points: '3' }, { target: '400', points: '2' }] } },
    { stat_id: '9', value: '0.1', bonuses: { bonus: { target: '100', points: '3' } } },
  ] } } });
  assert.equal(scoring.bonus_pass_yd_300, 3);
  assert.equal(scoring.bonus_pass_yd_400, 2);
  assert.equal(scoring.bonus_rush_yd_100, 3);
});

test('players: id map first, defence by team, then name + position, team breaks a tie', async () => {
  const { yahooPid } = await shape();
  const idx = { yahoo: { '30121': '4034' }, names: { 'kyler murray|QB': [['5849', 'ARI']], 'josh allen|QB': [['4984', 'BUF'], ['9999', 'FA']] } };
  assert.equal(yahooPid(idx, { player_id: '30121' }), '4034');
  assert.equal(yahooPid(idx, { player_id: '100022', display_position: 'DEF', editorial_team_abbr: 'Ari' }), 'ARI');
  assert.equal(yahooPid(idx, { player_id: '31833', name: { full: 'Kyler Murray' }, display_position: 'QB', editorial_team_abbr: 'Ari' }), '5849');
  assert.equal(yahooPid(idx, { player_id: '1', name: { full: 'Josh Allen' }, display_position: 'QB', editorial_team_abbr: 'Buf' }), '4984');
  assert.equal(yahooPid(idx, { player_id: '2', name: { full: 'Nobody Here' }, display_position: 'WR' }), 'yh_2');
});

test('rosters: records from standings, my team by my saved team id, starters by slot', async () => {
  const { yahooRosters, yahooLeague } = await shape();
  const lg = yahooLeague({ league: (await doc('settings')).league });
  const standings = (await doc('standings')).league.standings.teams.team;
  const roster = (await doc('roster')).team;
  const rs = yahooRosters({ lid: '1000', idx: { yahoo: {}, names: {} }, standingsTeams: standings, rosterTeams: [roster],
                            rosterPositions: lg.roster_positions, me: 'U1', mine: 1 });
  assert.equal(rs.length, 1);
  assert.equal(rs[0].roster_id, 1);
  assert.equal(rs[0].owner_id, 'U1');
  assert.equal(rs[0].starters.length, 9);
  assert.ok(rs[0].settings.wins + rs[0].settings.losses > 0);
  const other = yahooRosters({ lid: '1000', idx: {}, standingsTeams: standings, rosterTeams: [roster], rosterPositions: lg.roster_positions, me: 'U1', mine: 5 });
  assert.equal(other[0].owner_id, 'yh:1000:1');
});

test('matchups: pairs and scores from the scoreboard sample', async () => {
  const { yahooMatchups, yahooLeague } = await shape();
  const lg = yahooLeague({ league: (await doc('settings')).league });
  const sb = (await doc('scoreboard')).league.scoreboard;
  const ms = yahooMatchups({ idx: {}, scoreboard: sb, rosterTeams: [], rosterPositions: lg.roster_positions });
  assert.equal(ms.length, 8);
  const t1 = ms.find(m => m.roster_id === 1);
  assert.equal(t1.points, 112.82);
  assert.equal(t1._projected, 108.87);
  assert.equal(ms.filter(m => m.matchup_id === t1.matchup_id).length, 2);
});

test('playoff bracket rebuilt from playoff scoreboards', async () => {
  const { yahooWinnersBracket } = await shape();
  const sb = (await doc('scoreboard')).league.scoreboard;
  const b = yahooWinnersBracket([sb]);
  assert.ok(b.length >= 1);
  assert.equal(b[0].p, 1);
  assert.equal(b[0].w, 1);      // marky's Bold Team won 112.82–95.80
});

test('crosswalk: Sleeper yahoo_id + DynastyProcess rows, overrides win', async () => {
  const { buildYahooIdMap, sleeperNameIndex } = await ids();
  const sleeper = { 1: { yahoo_id: 30121, full_name: 'A B', position: 'RB' }, 2: { full_name: 'Kyler Murray', position: 'QB', team: 'ARI' } };
  const csv = '"yahoo_id","sleeper_id"\n"31833","2"\n"5","NA"\n';
  const m = buildYahooIdMap(sleeper, csv, [{ platform: 'yahoo', ext_id: '30121', sleeper_id: null }]);
  assert.equal(m['31833'], '2');
  assert.equal(m['30121'], undefined);
  assert.deepEqual(sleeperNameIndex(sleeper)['kyler murray|QB'], [['2', 'ARI']]);
});
