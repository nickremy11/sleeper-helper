// App shell: state, tab switching, shared helpers, Home

if (location.hostname === 'rootforme.ffhistorian.com') { location.replace('https://helper.ffhistorian.com/rootforme'); }
const IS_LOCAL    = location.protocol === 'file:' || location.hostname === 'localhost';
const SLEEPER_API    = IS_LOCAL ? 'https://api.sleeper.app/v1' : '/api/sleeper';
const PLAYERS_URL = IS_LOCAL ? 'https://api.sleeper.app/v1/players/nfl' : '/api/players';
const GQL_URL     = IS_LOCAL ? null : '/api/graphql';

const S = { userId: null, leagues: [], leagueDetails: {}, players: {}, nflState: null, token: null, tab: 'home', auth: null, espnSettings: null, _playersByName: {} };
const TP = { user1Id: null, user2Id: null, user1Leagues: [], user2Leagues: [], allLeagues: [], commonLeagues: [], u1Label: '', u2Label: '' };

// ── Rostership state ──────────────────────────────────────────────────────────
const RS = {
  selectedLeagues: null,  // Set<lgId> — null until first tab visit
  prefs:           {},    // {lgId: {contender} | null}
  fcMap:           {},    // {sleeperId: value}
  leagueRosters:   {},    // {lgId: [roster]}
  leagueDraftInfo: {},    // {lgId: {slotToRoster: {} | null}}
  allRows:         [],
  loaded:          false,
  sortCol:         'pct',
  sortDir:         1,
  search:          '',
  filtPositions:   new Set(['QB','RB','WR','TE','DL','LB','DB','PICK']),
  filtExp:         { op: '', val: '' },
  filtFCVal:       { op: '', val: '' },
  filtTeam:        '',
  filtSize:        '',
  filtType:        'all',
  filtContReb:     'all',   // 'all' | 'contender' | 'rebuilder'
  _teams:          new Set(),
  _sizes:          new Set(),
  expandedKey:     null,   // key of currently expanded player row
};

// ── League Summaries state ────────────────────────────────────────────────────
const LS = {
  leagueData: {},   // {lgId: {standing, numTeams, wins, losses, playoffTeams, apWins, apLosses, myRosterId, rosterPlayers, banked, weekly}}
  loaded:     false,
  loading:    false,
  sortCol:    null, // null = the order Sleeper lists your leagues in (ESPN appended)
  sortDir:    1,    // 1 = the column's natural direction (A-Z / best first), -1 = reversed
  recap: { week: null, fmt: 'all', role: 'all', lineup: 'all' },  // Weekly Recap — week null = latest completed
  filter:     'all', // 'all' | 'contenders' | 'rebuilders'
  search:     '',
  oddsLoaded:  false,
  oddsLoading: false,
  oddsError:   null,
  // Projection sources (Clay / Sleeper / your uploaded PPG), fetched once and
  // shared. Only the guillotine Power Score reads these now — the Contender
  // Rank column that used to be their main consumer is gone.
  projData: {
    clayMap:        {},     // sleeperId → { ppg }
    sleeperProjMap: {},     // sleeperId → { ppg }
    userProjMap:    {},     // sleeperId → { ppg }
    loaded:         false,
    loading:        false,
  },
  gz: {},   // {lgId: {loading, loaded, error, computedAtWeek, rows: [...]}} — guillotine leagues, see lsIsGuillotine()
};

// ── Player Finder state ───────────────────────────────────────────────────────
const PF = {
  targetPid:     null,   // player 1 — the player I want to acquire
  myPid:         null,   // player 2 — the player I'm filtering by (what I'd offer)
  allRosterData: null,   // [{lg, rs, uMap}] from the initial fetch
  fcMap:         null,   // FantasyCalc values (lazy-loaded on first comparison open)
  expanded:      null,   // lgId of currently expanded Trade Targets comparison panel
  expandedOther: null,   // lgId of currently expanded "On other rosters" comparison panel
  oddsLoading:   false,  // League Summaries' sim running for the listed teams' odds (pfLoadOdds)
};

// ── Waivers state ─────────────────────────────────────────────────────────────
const WV = {
  mode:               'dynasty', // 'dynasty' | 'redraft' | 'myranks'
  loaded:             false,
  fcMap:              {},
  rosteredByLeague:   {},  // {lgId: Set<pid>}
  rows:               [],
  redraftRankings:    [],  // [{name, pos, rank, posRank, tier, team, ppg, bye, pid}]
  rankUnmatched:      0,   // rows in the uploaded sheet that resolved to no Sleeper id
  myByLeague:         {},  // {lgId: Set<pid>} — my own roster, for the grid's green
  gridLeagueId:       null,// redraft grid: the one league on screen (see wvGridHtml)
  gridFaOnly:         false,
  expandedKey:        null,
  sortCol:            'adjVal',
  sortDir:            -1,
  skippedCount:       0,
  weekProj:           {},  // {pid: projected stat line} — Sleeper, upcoming week (wvLoadWeekProj)
  projWeek:           null,
};

// Sleeper projections for the upcoming week (the week the Lineup Checker sets —
// luWeekFor, i.e. `leg`, not display_week). Reuses LU.proj when that tab already
// loaded the same week. Never throws; an empty map just leaves the column blank.
async function wvLoadWeekProj() {
  const st = await getNflState();
  const w  = luWeekFor(st) || 1;
  if (LU._cache?.week === w && LU.proj && Object.keys(LU.proj).length) {
    WV.weekProj = LU.proj; WV.projWeek = w; return;
  }
  try {
    const pr = await api('/projections/nfl/regular/' + (st?.season || new Date().getFullYear()) + '/' + w);
    WV.weekProj = (pr && typeof pr === 'object') ? pr : {};
  } catch { WV.weekProj = {}; }
  WV.projWeek = w;
}

// Alternate NFL team abbreviations (other sites/CSVs) → Sleeper's canonical form.
const TEAM_ABBR_ALIASES = {
  JAC:'JAX', WSH:'WAS', ARZ:'ARI', GNB:'GB', KAN:'KC', NWE:'NE', NOR:'NO',
  SFO:'SF', TAM:'TB', LA:'LAR', SD:'LAC', OAK:'LV', STL:'LAR', SDG:'LAC',
};
function normTeamAbbr(raw) {
  if (!raw) return raw;
  const t = String(raw).trim().toUpperCase();
  return TEAM_ABBR_ALIASES[t] || t;
}
function rsCmp(actual, op, valStr) {
  if (!op || valStr === '') return true;
  if (actual === null || actual === undefined) return false;
  const v = parseFloat(valStr);
  if (isNaN(v)) return true;
  switch (op) {
    case '=':  return actual === v;
    case '>':  return actual >  v;
    case '<':  return actual <  v;
    case '>=': return actual >= v;
    case '<=': return actual <= v;
  }
  return true;
}

async function api(path) {
  const r = await fetch(SLEEPER_API + path);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// A league's managers, fetched once per session and shared by every tool that
// needs names (Players lookup, Trade Partners' autocomplete, Open Trades…).
// A failed read isn't cached, so the next caller retries.
const _leagueUsers = {};
function leagueUsers(lgId) {
  if (!_leagueUsers[lgId]) {
    _leagueUsers[lgId] = api('/league/' + lgId + '/users').then(u => u || []).catch(() => { delete _leagueUsers[lgId]; return []; });
  }
  return _leagueUsers[lgId];
}
// normName() (cross-source name normalization) is defined in shared-utils.js.
// Display name for a Sleeper player. DEF entries carry no full_name — their
// first/last name is the city + nickname ("Los Angeles" / "Chargers"), which is
// also how a ranking sheet labels a defense.
function sleeperName(p) {
  if (!p) return '';
  return p.full_name || [p.first_name, p.last_name].filter(Boolean).join(' ');
}
async function loadPlayers() {
  if (Object.keys(S.players).length) return;
  const r = await fetch(PLAYERS_URL);
  if (!r.ok) throw new Error('Could not load player data');
  const all = await r.json();
  // K is kept for the Lineup Checker and the ranks grid only — crNormPos still
  // drops kickers, so Rostership and everything downstream of it are unaffected.
  const keep = new Set(['QB','RB','WR','TE','K','DEF','DL','LB','DB','S','CB','DE','DT','FS','SS']);
  S.players = Object.fromEntries(Object.entries(all).filter(([,p]) => keep.has(p.position)));
  S._playersByName = {};
  S._playersByNameTeam = {};
  const rankOf = p => (p.search_rank != null && p.search_rank < 9999999) ? p.search_rank : Infinity;
  for (const [id, p] of Object.entries(S.players)) {
    const nm = sleeperName(p);
    if (!nm) continue;
    const key = normName(nm);
    // On name collisions (e.g. QB Lamar Jackson vs DB Lamar Jackson) keep the
    // more fantasy-relevant player so ranking IDs match real draft picks.
    const existing = S._playersByName[key];
    if (existing == null || rankOf(p) < rankOf(S.players[existing])) {
      S._playersByName[key] = id;
    }
    // Secondary index — lets a ranking sheet's team column break a name tie that
    // search_rank alone would resolve the wrong way.
    const tk = p.team ? key + '|' + normTeamAbbr(p.team) : null;
    if (tk && S._playersByNameTeam[tk] == null) S._playersByNameTeam[tk] = id;
  }
}
async function getNflState() {
  if (S.nflState) return S.nflState;
  S.nflState = await api('/state/nfl');
  return S.nflState;
}
function saveToken() {
  const t = document.getElementById('token-input').value.trim();
  if (!t) return;
  S.token = t;
  document.getElementById('token-input').value = '';
  const st = document.getElementById('token-status');
  st.textContent = '✦ token saved for this session';
  st.className = 'setup-status ok';
  if (S.tab === 'trades' && S.userId) renderTrades();
}
async function gql(op, query) {
  if (!S.token && !S.auth?.has_token) throw new Error('no token');
  if (!GQL_URL) throw new Error('not available in local dev');
  const headers = { 'Content-Type': 'application/json', 'X-Sleeper-Graphql-Op': op };
  if (S.token) headers['Authorization'] = S.token; // explicit token takes priority; otherwise server uses stored one
  const r = await fetch(GQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operationName: op, variables: {}, query }),
  });
  if (!r.ok) throw new Error('GQL HTTP ' + r.status);
  const json = await r.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}
// Set a Sleeper starting lineup via GraphQL. Values are inlined into the query
// string (matching Sleeper's own client); starters is an ordered array of
// player_id strings matching roster_positions (BN/IR/TAXI removed). leg+round
// both = the week for the regular season. Returns the updated matchup leg.
async function setLineup(leagueId, rosterId, week, starters) {
  const sArr  = JSON.stringify(starters.map(String));
  const query = `mutation update_matchup_leg($starters_games: Map) {
    update_matchup_leg(league_id: "${leagueId}", roster_id: ${rosterId}, leg: ${week}, round: ${week}, starters: ${sArr}, starters_games: $starters_games){
      league_id leg roster_id round starters
    }
  }`;
  const data = await gql('update_matchup_leg', query);
  return data?.update_matchup_leg;
}

function timeAgo(ts) {
  const h = Math.floor((Date.now() - ts) / 36e5);
  return h < 1 ? 'just now' : h < 24 ? h + 'h ago' : Math.floor(h / 24) + 'd ago';
}

async function loadUser() {
  const u = document.getElementById('u-input').value.trim();
  if (!u) return;
  const btn = document.getElementById('load-btn');
  const st  = document.getElementById('u-status');
  btn.disabled = true; btn.textContent = 'Loading…';
  st.className = 'setup-status';
  try {
    const [nflState, user] = await Promise.all([ getNflState(), api('/user/' + u) ]);
    if (!user?.user_id) throw new Error('user not found');
    S.userId = user.user_id;
    const season = nflState.league_create_season || nflState.season || new Date().getFullYear().toString();
    S.leagues = await api('/user/' + S.userId + '/leagues/nfl/' + season) || [];
    Promise.all(S.leagues.map(lg =>
      api('/league/' + lg.league_id).then(d => { S.leagueDetails[lg.league_id] = d; }).catch(() => {})
    ));
    st.textContent = S.leagues.length + ' leagues loaded for ' + esc(user.display_name || u) + ' (' + season + ')';
    st.className = 'setup-status ok';
    // Load ESPN leagues (non-blocking — they append to S.leagues after Sleeper leagues)
    loadEspnLeagues(season);
    // Whatever tab the URL names (it tracks every switch, so this is also the
    // tab the user was on before a refresh).
    sw(new URLSearchParams(location.search).get('tab') || S.tab, { history: 'replace' });
    // Auto-save username to account when logged in
    if (S.auth && u !== S.auth.sleeper_username) {
      fetch('/api/auth/me', { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sleeper_username: u }) })
        .then(r => r.json()).then(d => { if (!d.error && S.auth) S.auth.sleeper_username = u; }).catch(() => {});
    }
  } catch(e) {
    st.textContent = 'Error: ' + e.message;
    st.className = 'setup-status err';
  }
  btn.disabled = false; btn.textContent = 'Load';
}

async function loadEspnLeagues(season) {
  if (!S.auth) return;
  try {
    const r = await fetch('/api/espn/settings', { credentials: 'include' });
    if (!r.ok) return;
    const cfg = await r.json();
    S.espnSettings = cfg;
    if (!cfg.has_credentials || !cfg.league_ids?.length) return;
    await Promise.all(cfg.league_ids.map(id => loadOneEspnLeague(id, season)));
    // Update the status text to reflect ESPN leagues
    const st = document.getElementById('u-status');
    if (st && st.className.includes('ok')) {
      const sleeperCount = S.leagues.filter(l => !l.source).length;
      const espnCount    = S.leagues.filter(l => l.source === 'espn').length;
      if (espnCount > 0) st.textContent = st.textContent.replace(/^\d+ leagues/, `${sleeperCount} Sleeper + ${espnCount} ESPN leagues`);
    }
    // If rostership has already been rendered, refresh the league panel
    if (S.tab === 'rostership' && RS.selectedLeagues !== null) {
      const newEspnIds = S.leagues.filter(l => l.source === 'espn').map(l => l.league_id);
      for (const id of newEspnIds) RS.selectedLeagues.add(id);
      rsDrawFull();
    }
    // Draft Tracker's selector is built at tab-render time — ESPN leagues load
    // asynchronously after that, so re-populate it if the tab is already open.
    if (S.tab === 'tracker') populateDraftSelector();
    // League Summaries is the default landing tab, so it usually renders (and
    // calls lsLoadData()) before this async load appends ESPN leagues to
    // S.leagues — leaving LS.leagueData never populated for them (blank
    // standing/record/odds) until now. Backfill just the new ESPN leagues and
    // redraw; Sleeper leagues are unaffected (already loaded synchronously
    // before render() was ever called).
    if (LS.loaded) {
      const newEspnLeagues = S.leagues.filter(l => l.source === 'espn' && !LS.leagueData[l.league_id]);
      if (newEspnLeagues.length) {
        await Promise.all(newEspnLeagues.map(lg => lsLoadEspnLeague(lg)));
        lsRestoreOddsCache();
        lsRecapSnapshot();
        // Odds already ran (or are running) without these — cover them too.
        const missing = newEspnLeagues.some(l => LS.leagueData[l.league_id] && LS.leagueData[l.league_id].playoffOdds == null);
        if (missing && LS.oddsLoading) LS._oddsRerun = true;
        else if (missing && LS.oddsLoaded) { LS._oddsUseCache = true; lsSimulateAllLeagues(); }
        lsDrawTable();
      }
    }
  } catch {}
}

async function loadOneEspnLeague(leagueId, season) {
  try {
    const r = await fetch(`/api/espn/fantasy/${leagueId}?view=mSettings&view=mTeam&seasonId=${season}`, { credentials: 'include' });
    if (!r.ok) return;
    const d   = await r.json();
    const lgId = `espn_${leagueId}`;
    if (S.leagues.some(l => l.league_id === lgId)) return; // already loaded
    const name = d.settings?.name || `ESPN ${leagueId}`;
    const size = d.teams?.length || d.settings?.size || 10;
    const lg = { league_id: lgId, name, total_rosters: size, source: 'espn' };
    S.leagues.push(lg);
    // mSettings is already in hand, so keep the league's parsed scoring — the
    // waiver grid's per-league PPG needs it and would otherwise refetch.
    let espnScoring = null;
    try { espnScoring = crParseEspnScoring(d.settings).scoring; } catch {}
    S.leagueDetails[lgId] = { ...lg, settings: { type: 0, best_ball: 0 }, _espnId: leagueId, _espnScoring: espnScoring };
    RS.prefs[lgId] = RS._storedPrefs?.[lgId] ?? null;  // Root For Me tags ESPN leagues too (espn_{id})
  } catch {}
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
// The tab lives in the URL (?tab=x), so Refresh keeps you where you were, Back
// and Forward step through tabs, and any tab can be bookmarked or opened in a new
// browser tab. The menu itself is shared-nav.js (SH_NAV).

const RENDERERS = {
  home: () => renderHome(), guide: () => renderGuide(), leagues: () => renderLeagueSummaries(),
  trades: () => renderTrades(), lineups: () => renderLineupCheck(), ranksgrid: () => renderRanksGrid(),
  drafts: () => renderDraftQueue(), tracker: () => renderDraftTracker(), rostership: () => renderRostership(),
  partners: () => renderTradePartners(), waivers: () => renderWaivers(), scout: () => renderScout(),
  offers: () => renderMassOffers(), roi: () => renderRoi(),
};
// Tabs that render with no Sleeper username loaded.
const TABS_WITHOUT_USER = new Set(['home', 'guide', 'partners', 'roi']);

// Tabs that are now views inside another tool. Old links and bookmarks still work.
//  · player    — Player Finder is the lookup at the top of Players (Rostership)
//  · findtrade — the menu's "Find a Trade": whichever of its three modes you used last
const FT_MODES = ['scout', 'offers', 'partners'];
function swResolve(tab) {
  if (tab === 'player') return 'rostership';
  if (tab === 'findtrade') {
    let last = null;
    try { last = localStorage.getItem('ft_last'); } catch {}
    return FT_MODES.includes(last) ? last : 'scout';
  }
  return RENDERERS[tab] ? tab : 'home';
}

function swUrlFor(tab) {
  const u = new URL(location.href);
  if (tab === 'home') u.searchParams.delete('tab'); else u.searchParams.set('tab', tab);
  return u;
}

// opts.history: 'push' (default — a user click), 'replace' (start-up / redirects),
// 'none' (Back/Forward, where the browser already moved the URL).
function sw(tab, opts = {}) {
  tab = swResolve(tab);
  S.tab = tab;
  if (FT_MODES.includes(tab)) { try { localStorage.setItem('ft_last', tab); } catch {} }
  const mode = opts.history || 'push';
  if (mode !== 'none') {
    const u = swUrlFor(tab);
    if (u.href !== location.href) history[mode === 'replace' ? 'replaceState' : 'pushState']({ tab }, '', u);
  }
  shNavRender(tab);
  if (tab !== 'tracker' && T.pollTimer) { clearInterval(T.pollTimer); T.pollTimer = null; }
  wvApplyWide(tab);
  render(tab);
  if (mode === 'push') window.scrollTo(0, 0);
}
window.addEventListener('popstate', () => {
  sw(new URLSearchParams(location.search).get('tab') || 'home', { history: 'none' });
});

// The view switch at the top of a tool that's really several tabs in one —
// rendered as real links, so shared-nav.js's click handler switches in place.
const VIEW_GROUPS = {
  lineups:   [['lineups', 'Lineup cards'], ['ranksgrid', 'Ranks grid']],
  findtrade: [['scout', 'By position', 'Scout'], ['offers', 'By player', 'Mass offers'], ['partners', 'By manager', 'Shared leagues']],
  drafts:    [['drafts', 'Live drafts'], ['tracker', 'Draft tracker']],
};
function viewBarHtml(group, active) {
  return `<nav class="view-bar" aria-label="Views">${VIEW_GROUPS[group].map(([tab, label, sub]) =>
    `<a href="/?tab=${tab}" data-tab="${tab}"${tab === active ? ' class="active" aria-current="page"' : ''}>${label}${sub ? `<span class="view-sub">${sub}</span>` : ''}</a>`
  ).join('')}</nav>`;
}

// The ranks grid and the redraft waiver grid are the views that earn more than
// the site's 900px column. Waivers is mode-dependent, so wvSetMode re-applies it.
function wvApplyWide(tab) {
  const wide = tab === 'ranksgrid' || tab === 'roi' || (tab === 'waivers' && (WV.mode === 'redraft' || WV.mode === 'myranks'));
  document.querySelector('.main')?.classList.toggle('wide', wide);
}

function render(tab) {
  if (!S.userId && !TABS_WITHOUT_USER.has(tab)) {
    // A signed-in user's leagues load on their own — say so rather than asking
    // for a username they already gave us.
    setC(S.auth?.sleeper_username
      ? loading('Loading your leagues')
      : '<div class="empty-state"><p>Enter your Sleeper username above to get started</p></div>');
    return;
  }
  RENDERERS[tab]?.();
}
function setC(html) { document.getElementById('content').innerHTML = html; }
