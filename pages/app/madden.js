// Ask Madden — the chat panel and the tools it runs.
//
// The worker (/api/madden, worker/src/madden.js) holds the model, the prompt, the
// topic gate and the tool DEFINITIONS. This file holds the tool IMPLEMENTATIONS,
// which read the app's own state (S, RS, LS, SC) and its own loaders, so an
// answer can never disagree with the tab that shows the same thing.
//
// One question = a short loop: POST the history → the worker answers with text
// or tool calls → run them here → POST again with the results. MADDEN_MAX_STEPS
// caps the rounds. Signed-in users only; signed out, the panel asks you to sign in.

const MADDEN_MAX_STEPS   = 6;
const MADDEN_RESULT_MAX  = 9000;     // chars of JSON per tool result sent back
const MADDEN_CACHE_MS    = 5 * 60 * 1000;
const MADDEN_STORE       = 'madden_chat_v1';

const MADDEN = {
  open:    false,
  busy:    false,
  conv:    null,     // per-chat id, for grouping gateway logs
  msgs:    [],       // history in the worker's shape: {role, content, tool_calls?, tool_call_id?, name?}
  view:    [],       // what the panel shows: {who:'me'|'bot'|'note', text, links?:[{label, href, run?}]}
  status:  '',
  cache:   {},       // lgId → {at, data} — league ownership reads
};

// ── Persistence (this tab only — a chat is scratch work, not a record) ────────
function maddenSave() {
  try { sessionStorage.setItem(MADDEN_STORE, JSON.stringify({ conv: MADDEN.conv, msgs: MADDEN.msgs.slice(-40), view: MADDEN.view.slice(-60) })); } catch {}
}
function maddenRestore() {
  try {
    const s = JSON.parse(sessionStorage.getItem(MADDEN_STORE) || 'null');
    if (s?.conv) { MADDEN.conv = s.conv; MADDEN.msgs = s.msgs || []; MADDEN.view = s.view || []; }
  } catch {}
}
function maddenNewConv() {
  MADDEN.conv = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  MADDEN.msgs = []; MADDEN.view = []; MADDEN.status = '';
  maddenSave();
}

// ── Shared lookups ────────────────────────────────────────────────────────────
// Leagues load after sign-in; a question asked in the first seconds waits for them.
async function maddenNeedLeagues() {
  for (let i = 0; i < 60 && !S.userId; i++) await new Promise(r => setTimeout(r, 250));
  if (!S.userId) throw new Error('Your leagues are not loaded — add your Sleeper username on your profile.');
  await getNflState();
  await Promise.all(S.leagues
    .filter(lg => lg.source !== 'espn' && !S.leagueDetails[lg.league_id])
    .map(lg => api('/league/' + lg.league_id).then(d => { if (d) S.leagueDetails[lg.league_id] = d; }).catch(() => {})));
  if (!Object.keys(RS.prefs).length) { try { await rsLoadPrefs(); } catch {} }
}

function maddenSeason() { return S.nflState?.season || String(new Date().getFullYear()); }
function maddenIsEspn(lg) { return lg?.source === 'espn'; }

// Edit distance, for misspelled league and player names.
function maddenLev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// "dynasty league" / partial name / id → one league, or an error naming the candidates.
function maddenLeague(q) {
  const s = String(q ?? '').trim();
  if (!s) throw new Error('Which league? Pass a league name.');
  const byId = S.leagues.find(l => l.league_id === s || l.league_id === 'espn_' + s);
  if (byId) return byId;
  const n = normName(s);
  const exact = S.leagues.filter(l => normName(l.name) === n);
  if (exact.length === 1) return exact[0];
  const part = S.leagues.filter(l => normName(l.name).includes(n));
  if (part.length === 1) return part[0];
  const pool = part.length ? part : S.leagues;
  const ranked = pool.map(l => ({ l, d: maddenLev(n, normName(l.name)) })).sort((a, b) => a.d - b.d);
  if (!part.length && ranked[0] && ranked[0].d <= Math.max(2, n.length * 0.25) && (!ranked[1] || ranked[1].d > ranked[0].d)) return ranked[0].l;
  throw new Error(`"${s}" matches ${part.length ? 'several' : 'no'} leagues. Closest: ${ranked.slice(0, 6).map(x => x.l.name).join('; ')}`);
}

function maddenLeagueFacts(lg) {
  const d = S.leagueDetails[lg.league_id] || {};
  const espn = maddenIsEspn(lg);
  const ss = espn ? (d._espnScoring || {}) : (d.scoring_settings || {});
  const rp = espn ? [] : (d.roster_positions || []);
  const pref = RS.prefs?.[lg.league_id];
  const ls = LS.leagueData?.[lg.league_id];
  const myOdds = ls?.playoffOdds ?? (ls?.allPlayoffOdds && ls.myRosterId != null ? ls.allPlayoffOdds[ls.myRosterId] : null);
  return {
    league_id: lg.league_id,
    name: lg.name,
    platform: espn ? 'espn' : 'sleeper',
    format: espn ? 'redraft' : leagueFormatLabel(d).toLowerCase(),
    best_ball: !espn && d.settings?.best_ball === 1,
    guillotine: !espn && typeof lsIsGuillotine === 'function' ? !!lsIsGuillotine(lg.league_id) : false,
    teams: lg.total_rosters || d.total_rosters || null,
    superflex: espn ? (d._espnSuperflex ?? null) : rp.includes('SUPER_FLEX'),
    ppr: ss.rec ?? null,
    te_premium: ss.bonus_rec_te || 0,
    role: pref ? (pref.contender ? 'contender' : 'rebuilder') : null,
    record: ls ? `${ls.wins}-${ls.losses}` : null,
    standing: ls?.standing ? `${ls.standing} of ${ls.numTeams}` : null,
    playoff_odds: myOdds != null ? Math.round(myOdds * 100) + '%' : null,
  };
}

// ── Players ───────────────────────────────────────────────────────────────────
function maddenPlayerCard(pid) {
  const p = S.players[pid];
  if (!p) return null;
  return { player_id: pid, name: sleeperName(p), pos: p.position, team: p.team || 'FA', age: p.age ?? null,
           injury: p.injury_status || null, years_exp: p.years_exp ?? null };
}

// Best guesses for a (possibly misspelled) name: exact → last-name/first-name
// edit distance, ties broken by fantasy relevance (search_rank).
function maddenFindPlayers(q, limit = 5) {
  const n = normName(q);
  if (!n) return [];
  if (S.players[q]) return [String(q)];
  const exact = S._playersByName[n];
  const qt = n.split(' ').filter(Boolean);
  const scored = [];
  for (const [pid, p] of Object.entries(S.players)) {
    const nm = normName(sleeperName(p));
    if (!nm) continue;
    const t = nm.split(' ');
    let d = maddenLev(n, nm);
    if (qt.length >= 2 && t.length >= 2) {
      // first + last compared separately catches "Dohnte" vs "Donte" and a wrong surname alike
      d = Math.min(d, maddenLev(qt[0], t[0]) + maddenLev(qt[qt.length - 1], t[t.length - 1]));
      if (qt[qt.length - 1] === t[t.length - 1]) d -= 0.5;
    } else if (qt.length === 1) {
      // one word: either name, so "bijan" and "nacua" both land
      d = Math.min(d, maddenLev(qt[0], t[t.length - 1]), maddenLev(qt[0], t[0]));
    }
    const limitD = Math.max(2, Math.ceil(n.length * 0.3));
    if (d > limitD) continue;
    const rank = (p.search_rank != null && p.search_rank < 9999999) ? p.search_rank : 99999;
    scored.push({ pid, d, rank, active: p.team ? 0 : 1 });
  }
  scored.sort((a, b) => a.d - b.d || a.active - b.active || a.rank - b.rank);
  const out = scored.slice(0, limit).map(x => x.pid);
  if (exact && !out.includes(exact)) out.unshift(exact);
  else if (exact) { out.splice(out.indexOf(exact), 1); out.unshift(exact); }
  return out.slice(0, limit);
}

function maddenResolvePlayer(q) {
  const ids = maddenFindPlayers(q, 4);
  if (!ids.length) throw new Error(`No NFL player found matching "${q}".`);
  return { pid: ids[0], alternatives: ids.slice(1).map(id => maddenPlayerCard(id)).filter(Boolean) };
}

// ── League ownership (who has whom), with owner names ────────────────────────
async function maddenOwnership(lg) {
  const hit = MADDEN.cache[lg.league_id];
  if (hit && Date.now() - hit.at < MADDEN_CACHE_MS) return hit.data;
  let data = null;
  try {
    if (maddenIsEspn(lg)) {
      const espnId = S.leagueDetails[lg.league_id]?._espnId || lg.league_id.replace('espn_', '');
      const r = await fetch(`/api/espn/fantasy/${espnId}?view=mRoster&view=mTeam&seasonId=${maddenSeason()}`, { credentials: 'include' });
      if (r.ok) {
        const d = await r.json();
        const swid = S.espnSettings?.swid || '';
        const owner = {}, mineRid = { id: null };
        const rosters = {};
        for (const team of (d.teams || [])) {
          const isMine = espnIsMyTeam(team, swid);
          if (isMine) mineRid.id = team.id;
          const tname = team.name || [team.location, team.nickname].filter(Boolean).join(' ') || `Team ${team.id}`;
          rosters[team.id] = { name: tname, mine: isMine, players: [] };
          for (const e of (team.roster?.entries || [])) {
            const pl = e.playerPoolEntry?.playerPoolEntry?.player || e.playerPoolEntry?.player;
            const nm = pl ? (pl.fullName || `${pl.firstName || ''} ${pl.lastName || ''}`.trim()) : '';
            const pid = S._playersByName[normName(nm)] || null;
            const key = pid || 'espn:' + nm;
            owner[key] = { rid: team.id, name: tname, mine: isMine };
            rosters[team.id].players.push({ pid, name: nm, starter: e.lineupSlotId !== 20 && e.lineupSlotId !== 21 });
          }
        }
        data = { owner, rosters, myRid: mineRid.id, drafted: Object.keys(owner).length >= (d.teams?.length || 10) * 8 };
      }
    } else {
      const [rosters, users] = await Promise.all([
        RS.leagueRosters[lg.league_id]?.length && !RS.leagueRosters[lg.league_id][0]?._isEspn
          ? RS.leagueRosters[lg.league_id] : api('/league/' + lg.league_id + '/rosters'),
        leagueUsers(lg.league_id),
      ]);
      const uName = Object.fromEntries((users || []).map(u => [u.user_id, u.metadata?.team_name || u.display_name || u.username]));
      const owner = {}, out = {};
      let myRid = null, count = 0;
      for (const r of (rosters || [])) {
        const isMine = r.owner_id === S.userId || (r.co_owners || []).includes(S.userId);
        if (isMine) myRid = r.roster_id;
        const name = uName[r.owner_id] || (r.owner_id ? 'Unknown manager' : 'Orphan team');
        const starters = new Set((r.starters || []).map(String));
        out[r.roster_id] = { name, mine: isMine, players: (r.players || []).map(pid => ({ pid: String(pid), starter: starters.has(String(pid)) })),
                             wins: r.settings?.wins || 0, losses: r.settings?.losses || 0, ties: r.settings?.ties || 0,
                             pf: (r.settings?.fpts || 0) + (r.settings?.fpts_decimal || 0) / 100 };
        for (const pid of (r.players || [])) { owner[String(pid)] = { rid: r.roster_id, name, mine: isMine }; count++; }
      }
      data = { owner, rosters: out, myRid, drafted: count >= (rosters?.length || 10) * 8 };
    }
  } catch { data = null; }
  if (data) MADDEN.cache[lg.league_id] = { at: Date.now(), data };
  return data;
}

// ── Scoring vocabulary ────────────────────────────────────────────────────────
// Sleeper's scoring_settings keys, labelled so a plain-words question can find
// them. Anything not listed is labelled by expanding its abbreviations.
const MADDEN_SCORING_LABELS = {
  pass_yd: 'passing yards', pass_td: 'passing touchdown', pass_int: 'interception thrown', pass_2pt: 'passing two point conversion',
  pass_fd: 'passing first down', pass_cmp: 'pass completion', pass_att: 'pass attempt', pass_inc: 'incomplete pass', pass_sack: 'quarterback sacked',
  pass_int_td: 'pick six thrown interception returned for touchdown',
  rush_yd: 'rushing yards', rush_td: 'rushing touchdown', rush_fd: 'rushing first down', rush_att: 'rushing attempt carry', rush_2pt: 'rushing two point conversion',
  rec: 'reception ppr', rec_yd: 'receiving yards', rec_td: 'receiving touchdown', rec_fd: 'receiving first down', rec_2pt: 'receiving two point conversion',
  bonus_rec_te: 'tight end reception bonus te premium tep', bonus_rec_rb: 'running back reception bonus', bonus_rec_wr: 'wide receiver reception bonus',
  bonus_fd_qb: 'quarterback first down bonus', bonus_fd_rb: 'running back first down bonus', bonus_fd_wr: 'wide receiver first down bonus', bonus_fd_te: 'tight end first down bonus',
  fum: 'fumble', fum_lost: 'fumble lost', fum_rec_td: 'fumble recovery touchdown',
  kr_yd: 'kick return yards kickoff return yards', pr_yd: 'punt return yards', kr_td: 'kick return touchdown', pr_td: 'punt return touchdown',
  st_td: 'special teams touchdown return touchdown', st_ff: 'special teams forced fumble', st_fum_rec: 'special teams fumble recovery',
  def_st_td: 'defense special teams touchdown', def_st_ff: 'defense special teams forced fumble', def_st_fum_rec: 'defense special teams fumble recovery',
  def_kr_td: 'defense kick return touchdown', def_pr_td: 'defense punt return touchdown',
  sack: 'team defense sack', int: 'team defense interception', ff: 'team defense forced fumble', fum_rec: 'team defense fumble recovery',
  def_td: 'team defense touchdown', safe: 'safety', blk_kick: 'blocked kick', def_4_and_stop: 'fourth down stop',
  xpm: 'extra point made kicker', xpmiss: 'extra point missed kicker', fgmiss: 'field goal missed kicker', fgm: 'field goal made kicker',
  idp_tkl: 'idp tackle', idp_tkl_solo: 'idp solo tackle', idp_tkl_ast: 'idp assisted tackle', idp_tkl_loss: 'idp tackle for loss',
  idp_sack: 'idp sack', idp_qb_hit: 'idp quarterback hit', idp_int: 'idp interception', idp_ff: 'idp forced fumble', idp_fum_rec: 'idp fumble recovery',
  idp_pass_def: 'idp pass defended', idp_def_td: 'idp defensive touchdown', idp_safe: 'idp safety', idp_blk_kick: 'idp blocked kick',
};
const MADDEN_ABBR = { yd: 'yards', yds: 'yards', td: 'touchdown', rec: 'reception', fd: 'first down', kr: 'kick return', pr: 'punt return',
  st: 'special teams', idp: 'idp', tkl: 'tackle', ast: 'assisted', int: 'interception', ff: 'forced fumble', def: 'defense', pts: 'points',
  allow: 'allowed', fgm: 'field goal made', fga: 'field goal attempt', xpm: 'extra point made', bonus: 'bonus', att: 'attempt', cmp: 'completion',
  '2pt': 'two point conversion', safe: 'safety', blk: 'blocked', qb: 'quarterback', rb: 'running back', wr: 'wide receiver', te: 'tight end',
  fum: 'fumble', p: 'plus', '40p': '40 plus', '50p': '50 plus' };
function maddenScoringLabel(key) {
  if (MADDEN_SCORING_LABELS[key]) return MADDEN_SCORING_LABELS[key];
  return key.split('_').map(t => MADDEN_ABBR[t] || t).join(' ');
}
// Query words → label words (plurals, slang).
const MADDEN_SYN = { yds: 'yards', yardage: 'yards', yard: 'yards', tds: 'touchdown', td: 'touchdown', touchdowns: 'touchdown', returns: 'return',
  kickoff: 'kick', kicks: 'kick', punts: 'punt', receptions: 'reception', catches: 'reception', catch: 'reception', ppr: 'reception',
  tep: 'tep', firsts: 'first', downs: 'down', sacks: 'sack', ints: 'interception', interceptions: 'interception', picks: 'interception',
  fumbles: 'fumble', tackles: 'tackle', carries: 'carry', completions: 'completion', te: 'tight', rushing: 'rushing', passing: 'passing' };
const MADDEN_STOP = new Set(['or', 'and', 'the', 'a', 'of', 'for', 'per', 'points', 'point', 'score', 'scoring', 'leagues', 'league', 'my', 'that', 'have', 'with', 'any', 'do', 'which']);

// ESPN statIds that crParseEspnScoring doesn't map (it reads offence only).
// Return ids per the espn-api stat table — not yet seen in a live league.
const MADDEN_ESPN_EXTRA = { 114: 'kr_yd', 115: 'pr_yd', 101: 'kr_td', 102: 'pr_td' };
function maddenEspnScoring(lg) {
  const d = S.leagueDetails[lg.league_id] || {};
  const out = { ...(d._espnScoring || {}) };
  for (const it of (d._espnScoringItems || [])) {
    const k = MADDEN_ESPN_EXTRA[it.statId];
    if (k) out[k] = it.points ?? 0;
  }
  return out;
}
function maddenLeagueScoring(lg) {
  return maddenIsEspn(lg) ? maddenEspnScoring(lg) : (S.leagueDetails[lg.league_id]?.scoring_settings || {});
}

function maddenMatchScoringKeys(stat, keys) {
  const words = normName(stat).split(' ').filter(w => w && !MADDEN_STOP.has(w)).map(w => MADDEN_SYN[w] || w);
  if (!words.length) return [];
  let best = 0;
  const scored = keys.map(k => {
    const label = ' ' + maddenScoringLabel(k) + ' ' + k.replace(/_/g, ' ') + ' ';
    const s = words.filter(w => label.includes(' ' + w)).length;
    best = Math.max(best, s);
    return { k, s };
  });
  if (!best) return [];
  return scored.filter(x => x.s === best).map(x => x.k);
}

// ── Links ─────────────────────────────────────────────────────────────────────
const MADDEN_PAGES = {
  league_analyzer:  { label: 'League Analyzer', path: lg => `/analyzer?league=${encodeURIComponent(lg.league_id)}`, needsLeague: true },
  trade_analyzer:   { label: 'Trade Analyzer',  path: lg => `/trade-analyzer?league=${encodeURIComponent(lg.league_id)}`, needsLeague: true },
  league_summaries: { label: 'League Summaries', path: () => '/?tab=leagues' },
  lineups:          { label: 'Lineups',          path: () => '/?tab=lineups' },
  waivers:          { label: 'Waivers',          path: () => '/?tab=waivers' },
  players:          { label: 'Players',          path: () => '/?tab=rostership' },
  open_trades:      { label: 'Open Trades',      path: () => '/?tab=trades' },
  scoreboard:       { label: 'Scoreboard',       path: () => '/scoreboard' },
  root_for_me:      { label: 'Root For Me',      path: () => '/rootforme' },
  mass_offers:      { label: 'Mass Offers',      path: () => '/?tab=offers' },
};

// ── Tool implementations (names match MADDEN_TOOLS in worker/src/madden.js) ───
const MADDEN_TOOL_FNS = {
  async list_leagues(a) {
    await maddenNeedLeagues();
    let rows = S.leagues.map(maddenLeagueFacts);
    if (a.format && a.format !== 'any') rows = rows.filter(r => a.format === 'dynasty' ? r.format === 'dynasty' : r.format !== 'dynasty');
    if (a.role && a.role !== 'any') rows = rows.filter(r => r.role === a.role);
    if (a.platform && a.platform !== 'any') rows = rows.filter(r => r.platform === a.platform);
    if (a.best_ball && a.best_ball !== 'any') rows = rows.filter(r => r.best_ball === (a.best_ball === 'yes'));
    return {
      count: rows.length,
      leagues: rows,
      notes: [
        LS.loaded ? null : 'Records and playoff odds appear once League Summaries has loaded.',
        Object.values(RS.prefs || {}).some(Boolean) ? null : 'No contender/rebuilder tags are set (they come from Root For Me).',
      ].filter(Boolean),
    };
  },

  async find_leagues_by_scoring(a) {
    await maddenNeedLeagues();
    const allKeys = new Set(Object.keys(MADDEN_SCORING_LABELS));
    for (const lg of S.leagues) Object.keys(maddenLeagueScoring(lg)).forEach(k => allKeys.add(k));
    const keys = maddenMatchScoringKeys(a.stat, [...allKeys]);
    if (!keys.length) return { error: `No scoring rule matches "${a.stat}". Try different words (e.g. "punt return yards", "first down", "TE premium").` };
    const scored = [], notScored = [], espnUnsure = [];
    for (const lg of S.leagues) {
      const ss = maddenLeagueScoring(lg);
      const pts = {};
      for (const k of keys) if (ss[k]) pts[maddenScoringLabel(k).split(' ').slice(0, 4).join(' ')] = ss[k];
      if (Object.keys(pts).length) scored.push({ league: lg.name, points: pts });
      else if (maddenIsEspn(lg) && !S.leagueDetails[lg.league_id]?._espnScoringItems) espnUnsure.push(lg.name);
      else notScored.push(lg.name);
    }
    return {
      matched_rules: keys.map(k => ({ key: k, label: maddenScoringLabel(k) })),
      leagues_that_score_it: scored,
      leagues_that_do_not_count: notScored.length,
      espn_leagues_not_readable: espnUnsure,
    };
  },

  async league_settings(a) {
    await maddenNeedLeagues();
    const lg = maddenLeague(a.league);
    const d = S.leagueDetails[lg.league_id] || {};
    const ss = maddenLeagueScoring(lg);
    const scoring = Object.entries(ss).filter(([, v]) => v).map(([k, v]) => `${maddenScoringLabel(k)}: ${v}`);
    return {
      ...maddenLeagueFacts(lg),
      roster_slots: maddenIsEspn(lg) ? (d._espnSlots || null) : (d.roster_positions || []),
      scoring,
      note: maddenIsEspn(lg) ? 'ESPN scoring here covers offense and return yards only; kicker/defense/IDP rules are not read.' : undefined
    };
  },

  async find_player(a) {
    await loadPlayers();
    const ids = maddenFindPlayers(a.name, 6);
    return ids.length ? { matches: ids.map(maddenPlayerCard) } : { matches: [], note: `Nothing close to "${a.name}".` };
  },

  async player_availability(a) {
    await maddenNeedLeagues();
    await loadPlayers();
    const { pid, alternatives } = maddenResolvePlayer(a.player);
    const card = maddenPlayerCard(pid);
    let leagues = S.leagues.filter(lg => !(typeof lsIsGuillotine === 'function' && lsIsGuillotine(lg.league_id)));
    if (a.format && a.format !== 'any') leagues = leagues.filter(lg => (rsLeagueCategory(lg.league_id) === 'dynasty') === (a.format === 'dynasty'));
    const res = await Promise.all(leagues.map(async lg => ({ lg, own: await maddenOwnership(lg) })));
    const mine = [], others = [], free = [], unknown = [];
    const nameKey = 'espn:' + card.name;
    for (const { lg, own } of res) {
      if (!own) { unknown.push(lg.name); continue; }
      const o = own.owner[pid] || own.owner[nameKey];
      if (o?.mine) mine.push(lg.name);
      else if (o) others.push({ league: lg.name, owner: o.name });
      else if (!own.drafted) unknown.push(lg.name + ' (not drafted yet)');
      else free.push(lg.name);
    }
    return {
      player: card,
      did_you_mean: alternatives.length ? alternatives.map(p => `${p.name} (${p.pos}, ${p.team})`) : undefined,
      free_agent_in: free, on_your_roster_in: mine, owned_by_others_in: others,
      could_not_read: unknown.length ? unknown : undefined,
    };
  },

  async my_roster(a) {
    await maddenNeedLeagues();
    await loadPlayers();
    const lg = maddenLeague(a.league);
    const own = await maddenOwnership(lg);
    if (!own) return { error: `Couldn't read rosters for ${lg.name}.` };
    const mine = Object.values(own.rosters).find(r => r.mine);
    if (!mine) return { error: `No team of yours found in ${lg.name}.` };
    const players = mine.players.map(x => {
      const c = x.pid ? maddenPlayerCard(x.pid) : null;
      return c ? { name: c.name, pos: c.pos, team: c.team, injury: c.injury || undefined, starting: x.starter }
               : { name: x.name || x.pid, starting: x.starter };
    }).sort((p, q) => (q.starting - p.starting) || String(p.pos).localeCompare(String(q.pos)));
    return { league: lg.name, team: mine.name, players };
  },

  async league_standings(a) {
    await maddenNeedLeagues();
    const lg = maddenLeague(a.league);
    const ls = LS.leagueData?.[lg.league_id];
    let teams;
    if (maddenIsEspn(lg)) {
      let d = ls;
      if (!d) { await lsLoadEspnLeague(lg); d = LS.leagueData[lg.league_id]; }
      if (!d?.rosterStats) return { error: `Couldn't read standings for ${lg.name}.` };
      teams = Object.entries(d.rosterStats).map(([rid, s]) => ({ rid: Number(rid), team: d.rosterNames?.[rid] || `Team ${rid}`, wins: s.wins, pf: Math.round(s.fpts * 10) / 10, mine: Number(rid) === d.myRosterId }));
    } else {
      const own = await maddenOwnership(lg);
      if (!own) return { error: `Couldn't read standings for ${lg.name}.` };
      teams = Object.entries(own.rosters).map(([rid, r]) => ({ rid: Number(rid), team: r.name, wins: r.wins, losses: r.losses, ties: r.ties || undefined, pf: Math.round(r.pf * 10) / 10, mine: r.mine }));
    }
    const odds = ls?.allPlayoffOdds;
    teams.sort((x, y) => (y.wins - x.wins) || (y.pf - x.pf));
    return {
      league: lg.name,
      standings: teams.map((t, i) => ({ rank: i + 1, team: t.team + (t.mine ? ' (you)' : ''),
        record: t.losses != null ? `${t.wins}-${t.losses}${t.ties ? '-' + t.ties : ''}` : `${t.wins} wins`, points_for: t.pf,
        playoff_odds: odds?.[t.rid] != null ? Math.round(odds[t.rid] * 100) + '%' : undefined })),
      note: odds ? undefined : 'Playoff odds not simulated yet — League Summaries runs them.'
    };
  },

  async scout_query(a) {
    const q = {
      format:   a.format === 'redraft' ? 'redraft' : 'dynasty',
      mode:     a.mode === 'sell' ? 'sell' : 'buy',
      pos:      ['QB', 'RB', 'WR', 'TE'].includes(String(a.position).toUpperCase()) ? String(a.position).toUpperCase() : 'WR',
      topN:     [12, 24, 36, 48].includes(Number(a.top_n)) ? Number(a.top_n) : (Number(a.top_n) > 0 ? [12, 24, 36, 48].find(n => n >= Number(a.top_n)) || 48 : 36),
      age:      a.age === 'young' ? 'young' : 'vet',
      opp:      ['rebuilder', 'contender', 'either'].includes(a.opponent) ? a.opponent : 'either',
      myStatus: 'contending',
    };
    const href = scoutQueryUrl(q, true);
    const what = q.format === 'dynasty'
      ? `${q.mode === 'buy' ? 'Opponents' : 'You'} holding top-${q.topN} ${q.age === 'vet' ? 'veteran' : 'young'} ${q.pos}s` +
        (q.mode === 'buy' ? `, opponents: ${q.opp}, you: ${q.myStatus}` : '')
      : `${q.mode === 'buy' ? 'Opponents' : 'You'} stacked at ${q.pos} (redraft surplus, thresholds from your Scout settings)`;
    return { description: what, link: href, link_label: 'Run this Scout query', note: 'The query runs when the user clicks the link (can take up to a minute the first time).' };
  },

  async link_to(a) {
    const pg = MADDEN_PAGES[a.page];
    if (!pg) return { error: 'Unknown page' };
    let lg = null;
    if (a.league) { await maddenNeedLeagues(); lg = maddenLeague(a.league); }
    if (pg.needsLeague && !lg) return { error: `${pg.label} needs a league.` };
    return { link: pg.path(lg), link_label: pg.label + (lg ? ' — ' + lg.name : '') };
  },
};

// Links a tool returned — shown as buttons under the answer, so a link exists
// even when the model forgets to write it.
// The only paths that exist on this site. A link the model writes to anything
// else (it once linked a tool name, /find_leagues_by_scoring?…) renders as text.
const MADDEN_LINK_PATHS = ['/', '/analyzer', '/trade-analyzer', '/scoreboard', '/rootforme', '/miracle', '/auction', '/dispersal', '/myprofile', '/espn-setup'];
function maddenSiteLink(href) {
  if (typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) return false;
  const path = href.split(/[?#]/)[0].replace(/\.html$/, '');
  return MADDEN_LINK_PATHS.includes(path);
}

function maddenCollectLinks(name, result, into) {
  const add = (label, href) => {
    if (!maddenSiteLink(href)) return;
    if (into.some(l => l.href === href)) return;
    into.push({ label, href });
  };
  if (result?.link) add(result.link_label || (result.league ? result.league : 'Open'), result.link);
}

// ── The loop ──────────────────────────────────────────────────────────────────
async function maddenPost(step) {
  const r = await fetch('/api/madden', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conv: MADDEN.conv, step, messages: MADDEN.msgs, context: `Current tab: ${S.tab}. Leagues loaded: ${S.leagues.length}.` }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error || 'HTTP ' + r.status);
  return data;
}

async function maddenAsk(text) {
  text = String(text || '').trim().slice(0, 1000);
  if (!text || MADDEN.busy) return;
  if (!S.auth) { maddenDraw(); return; }
  if (!MADDEN.conv) maddenNewConv();
  MADDEN.busy = true;
  MADDEN.view.push({ who: 'me', text });
  // Everything this question adds to the history (the question, tool calls, tool
  // results) comes off again if it ends blocked, failed or unfinished, so a
  // question that never got an answer can't ride along as context for the next.
  const mark = MADDEN.msgs.length;
  const undo = () => { MADDEN.msgs.length = mark; };
  MADDEN.msgs.push({ role: 'user', content: text });
  MADDEN.status = 'Thinking…';
  maddenDraw();
  const links = [];
  try {
    for (let step = 1; step <= MADDEN_MAX_STEPS; step++) {
      const out = await maddenPost(step);
      if (out.blocked) {
        undo();
        // off_topic = Clef said it isn't fantasy football; guardrail = the AI
        // Gateway's safety filter stopped the call (its log has the category).
        MADDEN.view.push({ who: 'bot', text: out.reply, blocked: out.reason || true });
        break;
      }
      if (out.tool_calls?.length) {
        MADDEN.msgs.push({ role: 'assistant', content: out.content || '', tool_calls: out.tool_calls });
        for (const call of out.tool_calls) {
          MADDEN.status = maddenToolStatus(call.name);
          maddenDraw();
          let result;
          try {
            const f = MADDEN_TOOL_FNS[call.name];
            result = f ? await f(call.arguments || {}) : { error: 'Unknown tool' };
          } catch (e) { result = { error: e.message || String(e) }; }
          maddenCollectLinks(call.name, result, links);
          let json = JSON.stringify(result);
          if (json.length > MADDEN_RESULT_MAX) json = json.slice(0, MADDEN_RESULT_MAX) + '…(truncated)';
          MADDEN.msgs.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: json });
        }
        MADDEN.status = 'Thinking…';
        maddenDraw();
        continue;
      }
      MADDEN.msgs.push({ role: 'assistant', content: out.reply });
      MADDEN.view.push({ who: 'bot', text: out.reply, links: links.slice(0, 4) });
      break;
    }
    if (MADDEN.view[MADDEN.view.length - 1]?.who === 'me') {
      undo();
      MADDEN.view.push({ who: 'bot', text: "That took more steps than I'm allowed. Try asking a narrower question.", links });
    }
  } catch (e) {
    undo();
    MADDEN.view.push({ who: 'note', text: 'Madden hit a problem: ' + (e.message || e) });
  }
  MADDEN.busy = false;
  MADDEN.status = '';
  maddenSave();
  maddenDraw();
}

function maddenToolStatus(name) {
  return ({
    list_leagues: 'Checking your leagues…', find_leagues_by_scoring: 'Reading scoring settings…', league_settings: 'Reading league settings…',
    find_player: 'Looking up players…', player_availability: 'Checking every roster…', my_roster: 'Reading your roster…',
    league_standings: 'Reading standings…', scout_query: 'Building a Scout query…', link_to: 'Finding the page…',
  })[name] || 'Working…';
}

// ── Rendering ─────────────────────────────────────────────────────────────────
// A small, safe markdown: escape first, then **bold**, `code`, site-relative
// [links](/path) and "- " bullet lines. Anything that isn't a /path link stays text.
function maddenMd(src) {
  const inline = s => esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((\/(?!\/)[^)\s]*)\)/g, (all, t, h) => maddenSiteLink(h.replace(/&amp;/g, '&'))
      ? `<a href="${h}" onclick="return maddenGo(event, this.getAttribute('href'))">${t}</a>` : t);
  const lines = String(src || '').split('\n');
  let html = '', inList = false;
  for (const raw of lines) {
    const m = raw.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
    if (m) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${inline(m[1])}</li>`; continue; }
    if (inList) { html += '</ul>'; inList = false; }
    if (raw.trim()) html += `<p>${inline(raw)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

// In-app paths switch tabs in place (keeping the chat open); a Scout link also
// carries its query in the URL, which renderScout() reads and runs. Standalone
// pages (analyzer etc.) open in a new browser tab so nothing here is lost.
function maddenGo(e, href) {
  if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1)) return true;
  const u = new URL(href, location.origin);
  if (u.pathname === '/' && u.searchParams.get('tab')) {
    history.pushState({}, '', u.pathname + u.search);
    sw(u.searchParams.get('tab'), { history: 'none' });
    if (window.innerWidth < 700) maddenToggle(false);
    return false;
  }
  window.open(u.pathname + u.search, '_blank', 'noopener');
  return false;
}

function maddenDraw() {
  const box = document.getElementById('madden-panel');
  if (!box) return;
  box.hidden = !MADDEN.open;
  document.getElementById('madden-fab')?.classList.toggle('on', MADDEN.open);
  if (!MADDEN.open) return;
  const log = document.getElementById('madden-log');
  const form = document.getElementById('madden-form');
  if (!S.auth) {
    log.innerHTML = `<div class="madden-empty"><p>Madden answers questions about your leagues, teams and players.</p>
      <button class="setup-btn" onclick="SharedAuth.openModal()">Sign in to ask Madden</button></div>`;
    form.hidden = true;
    return;
  }
  form.hidden = false;
  const examples = ['What leagues of mine have kick or punt return yards?',
    'Run a scout query against rebuilders that have top 24 veteran RBs',
    'Which leagues is Puka Nacua available in?',
    'Which of my dynasty leagues am I contending in?'];
  const body = MADDEN.view.length ? MADDEN.view.map(m => {
    if (m.who === 'me') return `<div class="madden-msg me">${esc(m.text)}</div>`;
    if (m.who === 'note') return `<div class="madden-msg note">${esc(m.text)}</div>`;
    const links = (m.links || []).map(l => `<a class="madden-link" href="${esc(l.href)}" onclick="return maddenGo(event, this.getAttribute('href'))">${esc(l.label)} →</a>`).join('');
    const tag = m.blocked === 'guardrail' ? '<div class="madden-tag">Blocked by the safety filter</div>' : '';
    return `<div class="madden-msg bot${m.blocked ? ' blocked' : ''}">${tag}${maddenMd(m.text)}${links ? `<div class="madden-links">${links}</div>` : ''}</div>`;
  }).join('') : `<div class="madden-empty"><p>Ask about your leagues, teams and players. For example:</p>
      ${examples.map(x => `<button class="madden-ex" onclick="maddenAsk(${jsArg(x)})">${esc(x)}</button>`).join('')}</div>`;
  log.innerHTML = body + (MADDEN.busy ? `<div class="madden-msg status"><span class="spinner madden-spin"></span>${esc(MADDEN.status || 'Thinking…')}</div>` : '');
  log.scrollTop = log.scrollHeight;
  const inp = document.getElementById('madden-input');
  const btn = document.getElementById('madden-send');
  if (inp) inp.disabled = MADDEN.busy;
  if (btn) btn.disabled = MADDEN.busy;
}

function maddenToggle(force) {
  MADDEN.open = typeof force === 'boolean' ? force : !MADDEN.open;
  try { sessionStorage.setItem('madden_open', MADDEN.open ? '1' : ''); } catch {}
  maddenDraw();
  if (MADDEN.open) setTimeout(() => document.getElementById('madden-input')?.focus(), 30);
}

function maddenSubmit(e) {
  e.preventDefault();
  const inp = document.getElementById('madden-input');
  const v = inp.value;
  inp.value = '';
  maddenAsk(v);
  return false;
}

function maddenReset() {
  if (MADDEN.busy) return;
  maddenNewConv();
  maddenDraw();
}

function maddenMount() {
  if (document.getElementById('madden-fab')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button id="madden-fab" class="madden-fab" onclick="maddenToggle()" aria-controls="madden-panel" title="Ask Madden">🏈 Ask Madden</button>
    <section id="madden-panel" class="madden-panel" hidden aria-label="Ask Madden">
      <header class="madden-head">
        <span class="madden-title">Ask Madden</span>
        <button class="madden-hbtn" onclick="maddenReset()" title="Start a new chat">New chat</button>
        <button class="madden-hbtn" onclick="maddenToggle(false)" aria-label="Close">✕</button>
      </header>
      <div id="madden-log" class="madden-log" aria-live="polite"></div>
      <form id="madden-form" class="madden-form" onsubmit="return maddenSubmit(event)">
        <input id="madden-input" maxlength="1000" autocomplete="off" placeholder="Ask about your leagues…">
        <button id="madden-send" class="setup-btn" type="submit">Ask</button>
      </form>
      <div class="madden-foot">Answers about your own leagues only. Chats are logged.</div>
    </section>`;
  document.body.append(...wrap.children);
  maddenRestore();
  try { MADDEN.open = sessionStorage.getItem('madden_open') === '1'; } catch {}
  // /?madden=1 (the Field Guide's link) opens the panel once.
  const u = new URL(location.href);
  if (u.searchParams.get('madden') === '1') {
    MADDEN.open = true;
    u.searchParams.delete('madden');
    history.replaceState(history.state, '', u);
  }
  maddenDraw();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', maddenMount);
else maddenMount();
