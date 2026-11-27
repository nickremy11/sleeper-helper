// MFL → Sleeper shapes (worker/src/mfl-shape.js) and the player-id crosswalk
// (worker/src/player-ids.js), run against saved responses from a public MFL
// league (team names scrubbed) and the matching slice of Sleeper's player map.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const fx = n => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/mfl', n + '.json'), 'utf8'));
const shape = () => import(path.join(__dirname, '../worker/src/mfl-shape.js'));
const ids = () => import(path.join(__dirname, '../worker/src/player-ids.js'));

async function idx() {
  const { buildMflCrosswalk } = await ids();
  const x = buildMflCrosswalk(fx('sleeper-subset'), fx('players'));
  const posBySid = {};
  for (const [m, p] of Object.entries(x.mpos)) posBySid[x.map[m] || `mfl_${m}`] = p;
  return { x, idx: { mfl: x.map, posBySid } };
}

test('crosswalk: every sample player matches, defences by team code', async () => {
  const { x } = await idx();
  assert.equal(x.stats.unmatched, 0, JSON.stringify(x.unmatched));
  assert.ok(x.stats.total > 200);
  const def = fx('players').find(p => p.position === 'Def' && p.team === 'KCC');
  if (def) assert.equal(x.map[def.id], 'KC');
});

test('crosswalk: overrides win, and null means "never match"', async () => {
  const { buildMflCrosswalk } = await ids();
  const p = fx('players').find(q => q.position === 'RB');
  const a = buildMflCrosswalk(fx('sleeper-subset'), [p], [{ platform: 'mfl', ext_id: p.id, sleeper_id: '9999' }]);
  assert.equal(a.map[p.id], '9999');
  const b = buildMflCrosswalk(fx('sleeper-subset'), [p], [{ platform: 'mfl', ext_id: p.id, sleeper_id: null }]);
  assert.equal(b.map[p.id], undefined);
  assert.equal(b.unmatched.length, 0);
});

test('crosswalk: name fallback needs a unique name at the same position', async () => {
  const { buildMflCrosswalk } = await ids();
  const sl = { 1: { full_name: 'Josh Johnson', position: 'QB' }, 2: { full_name: 'Josh Johnson', position: 'WR' } };
  const r = buildMflCrosswalk(sl, [{ id: '5', name: 'Johnson, Josh', position: 'WR', team: 'FA' }]);
  assert.equal(r.map['5'], '2');
  const r2 = buildMflCrosswalk({ ...sl, 3: { full_name: 'Josh Johnson', position: 'WR' } },
                               [{ id: '5', name: 'Johnson, Josh', position: 'WR', team: 'FA' }]);
  assert.equal(r2.map['5'], undefined);
});

test('lineup ranges become slots: minimums dedicated, the rest flex', async () => {
  const { mflStartersToSlots } = await shape();
  const s = mflStartersToSlots(fx('league').league.starters, { rosterSize: 21 });
  // 9 starters: QB 1, RB 1-4, WR 1-4, TE 1-4, team kicker 1, DEF 1 → 3 flex.
  assert.deepEqual(s.roster_positions.filter(p => p !== 'BN'), ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'FLEX', 'FLEX', 'FLEX']);
  assert.equal(s.roster_positions.length, 21);
  // QB 1-2 with three flex → one SUPER_FLEX (the QB cap), two FLEX.
  const sf = mflStartersToSlots({ count: '10', position: [
    { name: 'QB', limit: '1-2' }, { name: 'RB', limit: '2-4' }, { name: 'WR', limit: '2-4' }, { name: 'TE', limit: '1-3' }, { name: 'PK', limit: '1' } ] });
  assert.deepEqual(sf.roster_positions, ['QB', 'RB', 'RB', 'WR', 'WR', 'TE', 'K', 'FLEX', 'FLEX', 'SUPER_FLEX']);
});

test('starters are laid into slots dedicated-first', async () => {
  const { orderStarters } = await shape();
  const pos = { a: 'WR', b: 'QB', c: 'RB', d: 'WR', e: 'TE' };
  assert.deepEqual(orderStarters(['a', 'b', 'c', 'd', 'e'], ['QB', 'RB', 'WR', 'TE', 'FLEX', 'BN'], p => pos[p]), ['b', 'c', 'a', 'e', 'd']);
  assert.deepEqual(orderStarters(['b'], ['QB', 'RB', 'BN'], p => pos[p]), ['b', '0']);
});

test('scoring: the sample league converts, with its odd rules flagged', async () => {
  const { mflRulesToScoring } = await shape();
  const { scoring: s, approx } = mflRulesToScoring(fx('rules'));
  assert.equal(s.pass_td, 4); assert.equal(s.pass_yd, 0.04);
  assert.equal(s.rush_td, 6); assert.equal(s.rush_yd, 0.1);
  assert.equal(s.rec, 1); assert.equal(s.rec_yd, 0.1); assert.equal(s.rec_td, 6);
  assert.equal(s.xpm, 1); assert.equal(s.sack, 1); assert.equal(s.int, 1); assert.equal(s.safe, 2);
  // TPA: 0 → 10, 1-10 → 6, 11-20 → 3. Sleeper's 7-13 bucket straddles 10, so it's flagged.
  assert.equal(s.pts_allow_0, 10); assert.equal(s.pts_allow_1_6, 6); assert.equal(s.pts_allow_14_20, 3);
  assert.ok(approx.includes('TPA'));
  // FG 1-30 flat 3, 31+ 0.1/yd: bucketed by representative distance, flagged.
  assert.equal(s.fgm_20_29, 3); assert.equal(s.fgm_40_49, 4.5);
  assert.ok(approx.includes('FG'));
});

test('scoring: TE premium and yardage bonuses', async () => {
  const { mflRulesToScoring } = await shape();
  const r = (ev, range, points) => ({ event: { $t: ev }, range: { $t: range }, points: { $t: points } });
  const { scoring: s, approx } = mflRulesToScoring({ rules: { positionRules: [
    { positions: 'QB|RB|WR|TE', rule: [r('CC', '0-99', '*1'), r('PY', '-50-999', '*.04'), r('PY', '300-399', '3'), r('PY', '400-999', '5')] },
    { positions: 'TE', rule: r('CC', '0-99', '*.5') },   // rows add up: a TE gets 1 + 0.5
  ] } });
  assert.equal(s.rec, 1); assert.equal(s.bonus_rec_te, 0.5);
  assert.equal(s.bonus_pass_yd_300, 3); assert.equal(s.bonus_pass_yd_400, 2);
  assert.deepEqual(approx, []);
});

test('league object: dynasty from future picks, bracket, divisions', async () => {
  const { mflLeague } = await shape();
  const lg = mflLeague({ year: 2025, lid: '10005', league: fx('league'), rules: fx('rules'), brackets: fx('playoffBrackets'),
                         futurePicks: fx('futureDraftPicks'), status: { year: '2026', weeks: { CompletedWeek: '11', LiveScoringWeek: '12' } },
                         prevId: '10005' });
  assert.equal(lg.league_id, 'mfl_2025_10005');
  assert.equal(lg.previous_league_id, 'mfl_2024_10005');
  assert.equal(lg.status, 'complete');
  assert.equal(lg.settings.type, 2);
  assert.equal(lg.settings.playoff_teams, 6);
  assert.equal(lg.settings.playoff_week_start, 15);
  assert.equal(lg.settings.divisions, 2);
  assert.equal(lg.total_rosters, 10);
});

test('rosters: records, points, my franchise gets my id, players in Sleeper ids', async () => {
  const { mflRosters, mflStartersToSlots } = await shape();
  const { idx: ix } = await idx();
  const rp = mflStartersToSlots(fx('league').league.starters, { rosterSize: 21 }).roster_positions;
  const rs = mflRosters({ lid: '10005', idx: ix, league: fx('league'), rosters: fx('rosters'), standings: fx('leagueStandings'),
                          rosterPositions: rp, mine: '0008', me: 'U1' });
  assert.equal(rs.length, 10);
  const me = rs.find(r => r.roster_id === 8);
  assert.equal(me.owner_id, 'U1');
  assert.equal(rs.find(r => r.roster_id === 1).owner_id, 'mfl:10005:0001');
  assert.equal(me.settings.wins, 11); assert.equal(me.settings.losses, 3);
  assert.equal(me.settings.fpts + me.settings.fpts_decimal / 100, 2358.94);
  // Only MFL team units (a whole team's kicker, "TMPK") have no Sleeper player.
  const unmapped = rs.flatMap(r => r.players).filter(p => p.startsWith('mfl_')).map(p => p.slice(4));
  const units = new Set(fx('players').filter(p => /^TM/.test(p.position)).map(p => p.id));
  assert.ok(unmapped.every(id => units.has(id)), unmapped.join(','));
});

test('matchups: a played week in Sleeper shape, starters laid into slots', async () => {
  const { mflMatchups, mflStartersToSlots } = await shape();
  const { idx: ix } = await idx();
  const rp = mflStartersToSlots(fx('league').league.starters, { rosterSize: 21 }).roster_positions;
  const ms = mflMatchups({ idx: ix, results: fx('weeklyResults'), rosterPositions: rp });
  assert.equal(ms.length, 10);
  const a = ms.find(m => m.roster_id === 5);
  assert.equal(a.points, 79.2);
  assert.equal(a.starters.length, 9);
  assert.ok(ms.filter(m => m.matchup_id === a.matchup_id).length === 2);
  const sum = a.starters_points.reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(sum - a.points) < 0.05, `${sum} vs ${a.points}`);
});

test('picks, draft, bracket', async () => {
  const { mflTradedPicks, mflDraft, mflDraftPicks, mflWinnersBracket } = await shape();
  const { idx: ix } = await idx();
  const tp = mflTradedPicks(fx('futureDraftPicks'));
  assert.ok(tp.every(p => p.roster_id !== p.owner_id));
  const d = mflDraft({ year: 2025, lid: '10005', draftResults: fx('draftResults'), nTeams: 10 });
  assert.equal(d.status, 'complete');
  // One slot per team, or no map at all (a traded first-rounder puts a team in two slots).
  if (d.slot_to_roster_id) assert.equal(new Set(Object.values(d.slot_to_roster_id)).size, 10);
  const picks = mflDraftPicks({ idx: ix, draftResults: fx('draftResults') });
  assert.equal(picks[0].pick_no, 1);
  const wb = mflWinnersBracket(fx('playoffBracket'));
  const final = wb.find(g => g.p === 1);
  assert.equal(final.w, 8);   // 134.78 beat 87.36
  assert.equal(wb.length, 5);
});

// ── Record Book: trades + season list ──
test('trades: players, future picks and current-year picks in Sleeper trade shape', async () => {
  const { mflTrades } = await shape();
  const idx = { mfl: { 14832: '4984' } };
  const t = mflTrades({ idx, transactions: fx('transactions-trade'), year: 2025, slotToRoster: { 3: 6 },
                        mplayers: { 16627: { name: 'Doe, John', position: 'WR' } } });
  assert.equal(t.length, 8);
  assert.ok(t.every((x, i) => !i || x.status_updated >= t[i - 1].status_updated), 'oldest first');
  const a = t.find(x => x.status_updated === 1762584470000);
  assert.deepEqual(a.roster_ids, [4, 1]);
  assert.equal(a.adds['4984'], 1);                 // 0004 gave up 14832 → franchise 1
  assert.equal(a.adds.mfl_16627, 4);
  assert.equal(a.drops.mfl_16627, 1);
  assert.deepEqual(a.draft_picks, [{ season: '2027', round: 1, roster_id: 1, owner_id: 4, previous_owner_id: 1 }]);
  assert.deepEqual(a._players.mfl_16627, { full_name: 'John Doe', position: 'WR' });
  assert.equal(a._players['4984'], undefined);
  // DP_2_4 (0-based) = round 3, slot 5; unknown slot owner → the team that gave it up
  const b = t.find(x => x.status_updated === 1751558329000);
  assert.deepEqual(b.draft_picks, [{ season: '2025', round: 3, roster_id: 6, owner_id: 3, previous_owner_id: 6, _slot: 5 }]);
  // DP_2_2 → slot 3, whose original owner is known from the slot map
  const c = t.find(x => x.status_updated === 1753481260000);
  assert.equal(c.draft_picks[0]._slot, 3);
  assert.equal(c.draft_picks[0].roster_id, 6);
});

test('season keys: every year of the history list with its own league id', async () => {
  const { mflSeasonKeys, slotOrder } = await shape();
  const league = { league: { history: { league: [
    { year: '2025', url: 'https://www48.myfantasyleague.com/2025/home/10005' },
    { year: '2004', url: 'https://www43.myfantasyleague.com/2004/home/30571' },
    { year: '2017', url: 'http://www47.myfantasyleague.com/2017/home/10005' },
  ] } } };
  const s = mflSeasonKeys(league, 2026, '10005');
  assert.deepEqual(Object.keys(s), ['2004', '2017', '2025', '2026']);
  assert.equal(s[2004], 'mfl_2004_30571');
  assert.equal(s[2026], 'mfl_2026_10005');
  assert.deepEqual(slotOrder({ 1: 7, 2: 3 }), { 7: 1, 3: 2 });
});

test('trades: a snake draft\'s even-round DP pick resolves to its column', async () => {
  const { mflTrades } = await shape();
  const tx = { transactions: { transaction: { type: 'TRADE', franchise: '0001', franchise2: '0002', timestamp: '1700000000',
    franchise1_gave_up: 'DP_1_0,', franchise2_gave_up: 'DP_0_0,' } } };
  const t = mflTrades({ idx: {}, transactions: tx, year: 2025, snake: true, teams: 10 });
  assert.deepEqual(t[0].draft_picks.map(p => [p.round, p._slot]), [[2, 10], [1, 1]]);
});
