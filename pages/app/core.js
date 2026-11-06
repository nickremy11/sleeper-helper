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
    const _urlTab = new URLSearchParams(location.search).get('tab');
    if (_urlTab && document.getElementById('tab-' + _urlTab)) S.tab = _urlTab;
    render(S.tab);
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

const TAB_GROUP_MAP = {
  home: 'grp-home', guide: 'grp-guide',
  leagues: 'grp-my-leagues', rostership: 'grp-my-leagues',
  lineups: 'grp-my-leagues', player: 'grp-my-leagues', waivers: 'grp-my-leagues',
  ranksgrid: 'grp-my-leagues',
  trades: 'grp-trades', partners: 'grp-trades', scout: 'grp-trades', offers: 'grp-trades',
  drafts: 'grp-drafts', tracker: 'grp-drafts',
  roi: 'grp-tools',
};
function toggleGrp(id) {
  const grp = document.getElementById(id);
  const isOpen = grp.classList.contains('open');
  document.querySelectorAll('.tab-group').forEach(g => g.classList.remove('open'));
  if (!isOpen) grp.classList.add('open');
}
document.addEventListener('click', e => {
  if (!e.target.closest('.tab-group')) {
    document.querySelectorAll('.tab-group').forEach(g => g.classList.remove('open'));
  }
});
function sw(tab) {
  S.tab = tab;
  document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.querySelectorAll('.tab-group-btn').forEach(b => b.classList.remove('active'));
  const grpId = TAB_GROUP_MAP[tab];
  if (grpId) document.querySelector('#' + grpId + ' .tab-group-btn').classList.add('active');
  document.querySelectorAll('.tab-group').forEach(g => g.classList.remove('open'));
  if (tab !== 'tracker' && T.pollTimer) { clearInterval(T.pollTimer); T.pollTimer = null; }
  wvApplyWide(tab);
  render(tab);
}
// The ranks grid and the redraft waiver grid are the views that earn more than
// the site's 900px column. Waivers is mode-dependent, so wvSetMode re-applies it.
function wvApplyWide(tab) {
  const wide = tab === 'ranksgrid' || tab === 'roi' || (tab === 'waivers' && (WV.mode === 'redraft' || WV.mode === 'myranks'));
  document.querySelector('.main')?.classList.toggle('wide', wide);
}

function render(tab) {
  // roi gates on the account, not on a Sleeper username — renderRoi says so itself
  if (!S.userId && tab !== 'partners' && tab !== 'home' && tab !== 'guide' && tab !== 'roi') { setC('<div class="empty-state"><p>Enter your username above to get started</p></div>'); return; }
  ({ home: renderHome, leagues: renderLeagueSummaries, trades: renderTrades, player: renderPlayerSearch, lineups: renderLineupCheck, drafts: renderDraftQueue, tracker: renderDraftTracker, rostership: renderRostership, partners: renderTradePartners, waivers: renderWaivers, scout: renderScout,
    offers: renderMassOffers, ranksgrid: renderRanksGrid, guide: renderGuide, roi: renderRoi })[tab]?.();
}
function setC(html) { document.getElementById('content').innerHTML = html; }

// ── 0. Home ───────────────────────────────────────────────────────────────────
function renderHome() {
  setC(`
    <div style="text-align:center; padding: 48px 24px 64px; max-width: 700px; margin: 0 auto;">
      <img src="/assets/ffhistorianlogo.png" alt="FF Historian" style="width: clamp(120px, 28vw, 200px); height: auto; display: block; margin: 0 auto 28px; filter: drop-shadow(0 4px 12px rgba(0,0,0,0.35));" />
      <h2 style="font-family: 'Rye', serif; font-size: clamp(1.4rem, 4vw, 2.2rem); color: var(--brown-dark); line-height: 1.15; margin-bottom: 14px; letter-spacing: 0.04em;">
        Welcome to the <span style="color: var(--green);">FF Historian</span>
      </h2>
      <div style="height: 2px; width: 80px; background: linear-gradient(to right, transparent, var(--gold), transparent); margin: 0 auto 20px;"></div>
      <p style="font-family: 'Playfair Display', serif; font-style: italic; font-size: clamp(1rem, 2.5vw, 1.2rem); color: var(--brown-light); line-height: 1.6; margin-bottom: 40px;">
        Explore all the tools to help you manage your leagues
      </p>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; text-align: left; margin-bottom: 40px;">
        <button onclick="sw('leagues')" style="background: var(--brown-dark); border: 1px solid var(--brown-mid); border-radius: 2px; padding: 16px 18px; cursor: pointer; transition: border-color 0.2s; text-align: left;" onmouseover="this.style.borderColor='var(--gold)'" onmouseout="this.style.borderColor='var(--brown-mid)'">
          <div style="font-family: 'Rye', serif; font-size: 0.52rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); margin-bottom: 6px;">League Summaries</div>
          <div style="font-family: 'Crimson Text', serif; font-size: 0.88rem; color: var(--brown-light); font-style: italic;">Standings, records &amp; playoff odds</div>
        </button>
        <button onclick="sw('rostership')" style="background: var(--brown-dark); border: 1px solid var(--brown-mid); border-radius: 2px; padding: 16px 18px; cursor: pointer; transition: border-color 0.2s; text-align: left;" onmouseover="this.style.borderColor='var(--gold)'" onmouseout="this.style.borderColor='var(--brown-mid)'">
          <div style="font-family: 'Rye', serif; font-size: 0.52rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); margin-bottom: 6px;">Rostership</div>
          <div style="font-family: 'Crimson Text', serif; font-size: 0.88rem; color: var(--brown-light); font-style: italic;">Cross-league player ownership</div>
        </button>
        <button onclick="sw('trades')" style="background: var(--brown-dark); border: 1px solid var(--brown-mid); border-radius: 2px; padding: 16px 18px; cursor: pointer; transition: border-color 0.2s; text-align: left;" onmouseover="this.style.borderColor='var(--gold)'" onmouseout="this.style.borderColor='var(--brown-mid)'">
          <div style="font-family: 'Rye', serif; font-size: 0.52rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); margin-bottom: 6px;">Open Trades</div>
          <div style="font-family: 'Crimson Text', serif; font-size: 0.88rem; color: var(--brown-light); font-style: italic;">Pending trades across leagues</div>
        </button>
        <button onclick="sw('player')" style="background: var(--brown-dark); border: 1px solid var(--brown-mid); border-radius: 2px; padding: 16px 18px; cursor: pointer; transition: border-color 0.2s; text-align: left;" onmouseover="this.style.borderColor='var(--gold)'" onmouseout="this.style.borderColor='var(--brown-mid)'">
          <div style="font-family: 'Rye', serif; font-size: 0.52rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); margin-bottom: 6px;">Player Finder</div>
          <div style="font-family: 'Crimson Text', serif; font-size: 0.88rem; color: var(--brown-light); font-style: italic;">Dynasty values &amp; roster lookup</div>
        </button>
        <button onclick="sw('lineups')" style="background: var(--brown-dark); border: 1px solid var(--brown-mid); border-radius: 2px; padding: 16px 18px; cursor: pointer; transition: border-color 0.2s; text-align: left;" onmouseover="this.style.borderColor='var(--gold)'" onmouseout="this.style.borderColor='var(--brown-mid)'">
          <div style="font-family: 'Rye', serif; font-size: 0.52rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); margin-bottom: 6px;">Lineup Checker</div>
          <div style="font-family: 'Crimson Text', serif; font-size: 0.88rem; color: var(--brown-light); font-style: italic;">Optimal lineup &amp; start/sit</div>
        </button>
        <button onclick="sw('drafts')" style="background: var(--brown-dark); border: 1px solid var(--brown-mid); border-radius: 2px; padding: 16px 18px; cursor: pointer; transition: border-color 0.2s; text-align: left;" onmouseover="this.style.borderColor='var(--gold)'" onmouseout="this.style.borderColor='var(--brown-mid)'">
          <div style="font-family: 'Rye', serif; font-size: 0.52rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--gold); margin-bottom: 6px;">Draft Queue</div>
          <div style="font-family: 'Crimson Text', serif; font-size: 0.88rem; color: var(--brown-light); font-style: italic;">Upcoming drafts at a glance</div>
        </button>
      </div>
      <div style="height: 1px; background: linear-gradient(to right, transparent, var(--brown-mid), transparent); margin-bottom: 24px;"></div>
      <p style="font-family: 'Crimson Text', serif; font-size: 0.85rem; color: var(--brown-light); font-style: italic;">
        ${S.auth
          ? 'Add your Sleeper username in <a href="/myprofile" style="color:var(--gold);">your profile</a> to load your leagues and get started.'
          : 'Enter your Sleeper username above to load your leagues and get started.'}
        Play in ESPN leagues too? <a href="/espn-setup" style="color:var(--gold);">Here's how to connect them.</a>
      </p>
    </div>
  `);
}
