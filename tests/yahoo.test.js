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

// ── Record Book: trades, season links, title path ──
test('trades: players + picks in Sleeper trade shape; vetoed trades skipped', async () => {
  const { yahooTrades } = await shape();
  const tx = (await doc('trades')).league.transactions.transaction;
  const t = yahooTrades({ idx: { yahoo: { 6762: '2133' }, names: {} }, transactions: tx, season: 2019, slotToRoster: { 7: 3 } });
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].roster_ids.sort(), [1, 2]);
  assert.equal(t[0].adds['2133'], 2);
  assert.equal(t[0].adds.yh_99999, 1);
  assert.deepEqual(t[0]._players, { yh_99999: { full_name: 'Nobody Known', position: 'RB' } });
  assert.deepEqual(t[0].draft_picks, [{ season: '2019', round: 4, roster_id: 3, owner_id: 1, previous_owner_id: 2, _slot: 7 }]);
  assert.equal(t[0].status_updated, 1568000000000);
});

test('season links from renew / renewed', async () => {
  const { yahooLinks } = await shape();
  const l = yahooLinks({ season: '2019', renew: '380_555', renewed: '399_777' }, { 380: 2018 });
  assert.equal(l.prev.key, 'yh_2018_555');
  assert.equal(l.prev.league_key, '380.l.555');
  assert.equal(l.next.key, 'yh_2020_777');
  assert.equal(yahooLinks({ season: '2019', renew: '' }).prev, null);
});

test('bracket: a game between knocked-out teams is placement, not the title path', async () => {
  const { yahooWinnersBracket } = await shape();
  const g = (a, b, w) => ({ is_playoffs: '1', is_consolation: '0', status: 'postevent', winner_team_key: `x.l.1.t.${w}`,
                            teams: { team: [{ team_id: String(a) }, { team_id: String(b) }] } });
  const b = yahooWinnersBracket([{ matchups: { matchup: [g(1, 4, 1), g(2, 3, 2)] } },
                                 { matchups: { matchup: [g(3, 4, 3), g(1, 2, 2)] } }]);
  assert.equal(b.find(x => x.t1 === 3 && x.t2 === 4).p, 3);
  assert.equal(b.find(x => x.t1 === 1 && x.t2 === 2).p, 1);
  assert.equal(b.filter(x => x.r === 1).every(x => x.p == null), true);
});

test('users carry the manager guid when Yahoo sends one', async () => {
  const { yahooUsers } = await shape();
  const u = yahooUsers({ lid: '1', teams: [{ team_id: '2', name: 'T', managers: { manager: { nickname: 'n', guid: 'ABC' } } }] });
  assert.equal(u[0].metadata.yahoo_guid, 'ABC');
});

// ── The Record Book read path (yahooForRecordBook) against a mocked Yahoo API ──
// No live Yahoo access yet, so this runs the real fetch → parse → shape plumbing
// over the doc fixtures: a two-season chain linked by renew/renewed, and trades.
test('record book: season chain via renew/renewed, trades read with the opener\'s token', async () => {
  const { yahooForRecordBook } = await import(path.join(__dirname, '../worker/src/yahoo.js'));
  const kvStore = new Map([
    ['yh_at_u1', 'plain-token'],                       // an access token in KV (openSecret passes unsealed values through)
    ['pidx:yahoo:v1', JSON.stringify({ yahoo: { 6762: '2133' }, names: {} })],
  ]);
  const env = {
    YAHOO_CLIENT_ID: 'x', YAHOO_CLIENT_SECRET: 'y',
    SLEEPER_KV: {
      get: async (k, t) => { const v = kvStore.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; },
      put: async (k, v) => { kvStore.set(k, v); }, delete: async k => { kvStore.delete(k); },
    },
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ leagues: JSON.stringify([{ id: '1000', season: 2019, game_id: '390', league_key: '390.l.1000' }]) }) }) }) },
  };
  const settings = xml('settings');
  const settings2018 = settings.replace(/390\.l\.1000/g, '380.l.555').replace('<league_id>1000</league_id>', '<league_id>555</league_id>')
    .replace('<season>2019</season>', '<season>2018</season>').replace('<renewed/>', '<renewed>390_1000</renewed>');
  const seen = [];
  const realFetch = global.fetch;
  global.fetch = async url => {
    const u = String(url); seen.push(u);
    const body = u.includes('/league/390.l.1000/settings') ? settings.replace('<renew/>', '<renew>380_555</renew>')
      : u.includes('/league/380.l.555/settings') ? settings2018
      : u.includes('/league/390.l.1000/transactions;type=trade') ? xml('trades')
      : u.includes('/draftresults') ? '<fantasy_content><league><draft_results count="0"/></league></fantasy_content>'
      : null;
    return new Response(body || '<error><description>not mocked</description></error>', { status: body ? 200 : 404 });
  };
  try {
    const user = { user_id: 'u1' };
    const s = await yahooForRecordBook(env, user, 'seasons', 'yh_1000');
    assert.deepEqual(s.seasons, { 2018: 'yh_2018_555', 2019: 'yh_2019_1000' });
    assert.equal(s.key, 'yh_2019_1000');
    const t = await yahooForRecordBook(env, user, 'trades', 'yh_2019_1000');
    assert.equal(t.length, 1);
    assert.equal(t[0].adds['2133'], 2);
    assert.ok(seen.every(u => u.startsWith('https://fantasysports.yahooapis.com/fantasy/v2/')));
    await assert.rejects(yahooForRecordBook({ ...env, YAHOO_CLIENT_ID: '' }, user, 'seasons', 'yh_1000'), /set up/);
  } finally { global.fetch = realFetch; }
});
