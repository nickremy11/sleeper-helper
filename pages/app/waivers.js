// Waivers tab

// ── 3. Waivers ────────────────────────────────────────────────────────────────

function renderWaivers() {
  const isDyn = WV.mode === 'dynasty';
  const isMR  = WV.mode === 'myranks';
  const uploadSection = (!isDyn && !isMR) ? `
    <div class="wv-upload-row">
      <span class="filter-lbl-rs">Rankings CSV</span>
      <input type="file" id="wv-file" accept=".csv,.txt" class="wv-file-input" onchange="wvUploadRankings(this)" />
      ${WV.redraftRankings.length
        ? `<span class="setup-status ok" style="margin:0;">${WV.redraftRankings.length} players loaded${WV.rankUnmatched ? ` · ${WV.rankUnmatched} unmatched` : ''}</span>`
        : `<span style="font-family:'Crimson Text',serif;font-size:0.82rem;font-style:italic;color:var(--brown-light);">CSV with a Player column (Position / Overall / Team read if present), or one name per line</span>`}
    </div>` : '';

  setC(`<div>
    <div class="tab-header" style="margin-bottom:16px;">
      <div class="section-head" style="margin-bottom:0;flex:1;"><h2>Waivers</h2><div class="section-head-line"></div></div>
    </div>
    <div class="wv-mode-bar">
      <span class="filter-lbl-rs">Mode</span>
      <button class="pos-pill${isDyn?' active':''}" onclick="wvSetMode('dynasty')">Dynasty</button>
      <button class="pos-pill${WV.mode==='redraft'?' active':''}" onclick="wvSetMode('redraft')">Redraft</button>
      <button class="pos-pill${isMR?' active':''}" onclick="wvSetMode('myranks')">vs My Ranks</button>
      <span style="font-family:'Crimson Text',serif;font-size:0.82rem;font-style:italic;color:var(--brown-light);margin-left:4px;">
        ${isDyn ? 'Scans dynasty leagues · FC value ≥ 100 (TE ×2)'
        : isMR  ? 'A My Ranks set as a grid, one league at a time · green is your roster, yellow is a free agent'
        :         'Your ranking sheet as a grid, one redraft league at a time · guillotine leagues excluded'}
      </span>
    </div>
    ${uploadSection}
    ${isMR ? '<div id="mrg-root"></div>' : `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
      <button class="setup-btn" id="wv-load-btn" onclick="loadWaiverData()" style="height:32px;">${WV.loaded ? 'Reload' : 'Load Waivers'}</button>
      <span class="setup-status" id="wv-load-status" style="margin:0;"></span>
      ${WV.loaded && WV.skippedCount > 0 ? `<span class="setup-status" style="margin:0;font-style:italic;">— ${WV.skippedCount} league${WV.skippedCount > 1 ? 's' : ''} skipped (draft not yet complete)</span>` : ''}
    </div>
    <div id="wv-table-wrap">
      ${WV.loaded ? wvRenderTable() : `<div class="empty-state"><p>${isDyn ? 'Click Load Waivers to scan all leagues for available players' : 'Click Load Waivers to pull rosters, then pick a league'}</p></div>`}
    </div>`}
  </div>`);

  // The My Ranks grid loads itself (rankings, rosters, the lot) — there's no
  // "Load Waivers" step to press. Re-entering the tab redraws what's already in
  // MRG rather than re-fetching a ranking set that hasn't changed.
  if (isMR) {
    // Same guard as the analyzer's: without shared-utils.js every reference
    // here throws and the mode renders as an empty panel with no explanation.
    const root = document.getElementById('mrg-root');
    if (typeof mrgInit !== 'function' || typeof MRG === 'undefined') {
      if (root) root.innerHTML = '<div class="err-state">The ranks grid could not start:'
        + ' <code>/shared-utils.js</code> is missing or out of date. Hard-refresh this page'
        + ' (⌘⇧R / Ctrl-F5); if it persists, that file needs redeploying.</div>';
      return;
    }
    try {
      if (MRG.rows.length && MRG.sources) mrgSetLeague(MRG.leagueId);
      else mrgOpenFromWaivers();
    } catch (e) {
      if (root) root.innerHTML = errHtml(e);
    }
  }
}

// index.html has every piece of context the grid would otherwise fetch for
// itself — player map, name index, FC values, identity — so hand them over.
function mrgOpenFromWaivers() {
  const leagues = S.leagues.map(lg => ({
    id: lg.league_id, name: lg.name || lg.league_id, espn: lg.source === 'espn',
    // Drives the grid's Auto consensus pick (FantasyCalc vs FantasyPros ROS).
    // rsLeagueCategory is this app's one definition of the split, so use it
    // rather than re-reading settings.type here.
    dynasty: rsLeagueCategory(lg.league_id) === 'dynasty',
  }));
  mrgInit({
    mount: 'mrg-root',
    apiBase: '/api',
    wideEl: '.main', wideClass: 'wide',
    leagues,
    leagueId: leagues.some(l => l.id === MRG.leagueId) ? MRG.leagueId : (leagues[0]?.id || null),
    // Empty is not "loaded" — passing {} would make the grid skip its own fetch
    // and then match nothing.
    players: Object.keys(S.players || {}).length ? S.players : null,
    byName:  Object.keys(S._playersByName || {}).length ? S._playersByName : null,
    fcMap:   Object.keys(RS.fcMap || {}).length ? RS.fcMap : null,
    sleeperUserId: S.userId || null,
    swid:    S.espnSettings?.swid || null,
    season:  S.nflState?.season || null,
    // Scoring this page already holds — Sleeper league objects, and ESPN's
    // mSettings parsed at load (_espnScoring). Anything missing the grid fetches.
    scoringFor: lgId => {
      const d = S.leagueDetails[lgId];
      return d?.source === 'espn' ? d._espnScoring : d?.scoring_settings;
    },
    ...(_seasonStats && Object.keys(_seasonStats).length ? { stats: _seasonStats } : {}),
  });
}

// Leagues this tab scans. Guillotine leagues are Sleeper type 3, which
// rsLeagueCategory buckets as 'redraft' — but there is no waiver wire to work
// in a format where losing the week removes your whole roster, so they're out
// of both modes rather than quietly padding every "# Available" count.
function wvLeagues() {
  return S.leagues.filter(lg =>
    rsLeagueCategory(lg.league_id) === WV.mode && !lsIsGuillotine(lg.league_id));
}

async function loadWaiverData() {
  const btn    = document.getElementById('wv-load-btn');
  const statEl = document.getElementById('wv-load-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  if (statEl) statEl.textContent = '';

  try {
    if (statEl) statEl.textContent = 'Loading players…';
    await loadPlayers();

    // Upcoming-week projections for the dynasty table — overlaps the fetches below.
    const projP = WV.mode === 'dynasty' ? wvLoadWeekProj() : null;

    // FC values — reuse RS.fcMap if Rostership already fetched it
    if (Object.keys(RS.fcMap).length > 0) {
      WV.fcMap = RS.fcMap;
    } else {
      if (statEl) statEl.textContent = 'Loading FC values…';
      try {
        const fc = await fetch('/api/fantasycalc').then(r => r.ok ? r.json() : []);
        RS.fcMap = {};
        for (const item of (Array.isArray(fc) ? fc : [])) {
          const sid = item.player?.sleeperId || item.player?.maybeSleeperID;
          if (sid) RS.fcMap[String(sid)] = item.value ?? 0;
        }
        WV.fcMap = RS.fcMap;
      } catch { WV.fcMap = {}; }
    }

    // loadUser() fires the per-league detail fetches without awaiting them, and
    // both rsLeagueCategory and lsIsGuillotine read S.leagueDetails — so settle
    // the stragglers first or a slow league gets miscategorised on a cold tab.
    await Promise.all(S.leagues
      .filter(lg => lg.source !== 'espn' && !S.leagueDetails[lg.league_id])
      .map(lg => api('/league/' + lg.league_id)
        .then(d => { if (d) S.leagueDetails[lg.league_id] = d; }).catch(() => {})));

    // Only scan leagues matching the current mode
    const allTarget = wvLeagues();

    // Filter out leagues whose startup or rookie draft isn't complete yet
    if (statEl) statEl.textContent = 'Checking draft status…';
    const nflSeason = S.nflState?.season || new Date().getFullYear().toString();
    const eligible = [];
    let skipped = 0;
    await Promise.all(allTarget.map(async lg => {
      if (lg.source === 'espn') { eligible.push(lg); return; }
      let status = RS.leagueDraftInfo[lg.league_id]?.draftStatus;
      if (status === undefined) {
        try {
          const r = await fetch(`/api/sleeper/league/${lg.league_id}/drafts`);
          const drafts = r.ok ? (await r.json() || []) : [];
          const cur = drafts.find(d => d.season === nflSeason);
          status = cur?.status;
          if (!RS.leagueDraftInfo[lg.league_id]) {
            RS.leagueDraftInfo[lg.league_id] = { ridToSlot: null, tradedPicks: [], draftStatus: status };
          }
        } catch {}
      }
      if (status === 'pre_draft' || status === 'drafting') { skipped++; }
      else { eligible.push(lg); }
    }));

    WV.rosteredByLeague = {}; WV.myByLeague = {}; // clear stale data before new load
    if (statEl) statEl.textContent = `Fetching ${eligible.length} leagues…`;
    // Season stats for the grid's per-league PPG — overlaps the roster fan-out.
    const statsP = ppgLoadStats();
    await Promise.all(eligible.map(lg => wvLoadLeagueRosters(lg)));
    await statsP;
    await projP;

    // Redraft renders one league at a time (wvGridHtml); dynasty stays a
    // cross-league table and needs the row build.
    if (WV.mode === 'dynasty') wvBuildRows();
    else if (!eligible.some(lg => lg.league_id === WV.gridLeagueId)) WV.gridLeagueId = eligible[0]?.league_id || null;
    WV.loaded = true;
    WV.skippedCount = skipped;
    renderWaivers();
  } catch(e) {
    if (statEl) statEl.textContent = 'Error: ' + e.message;
  } finally {
    const b = document.getElementById('wv-load-btn');
    if (b) { b.disabled = false; b.textContent = WV.loaded ? 'Reload' : 'Load Waivers'; }
  }
}

// Builds two sets per league: everyone rostered by ANYONE (the complement is the
// free-agent pool) and my own roster. A failed fetch stores NULL, not an empty
// Set — an empty one reads as "nobody owns anyone", which would paint the whole
// grid yellow and inflate every "# Available" count in the dynasty table.
async function wvLoadLeagueRosters(lg) {
  // crLoadLeagueOwnership (shared-utils.js) does the fetching and parsing —
  // the My Ranks grid needs exactly the same two sets, and this ESPN player
  // path is the kind of thing that drifts when it exists twice. It returns
  // null on failure, which is what these maps must store: an empty Set reads
  // as "nobody owns anyone" and would paint the grid yellow and inflate every
  // "# Available" count.
  const res = await crLoadLeagueOwnership({
    apiBase: '/api',
    leagueId: lg.league_id,
    espn: lg.source === 'espn',
    espnId: S.leagueDetails[lg.league_id]?._espnId,
    season: S.nflState?.season,
    swid: S.espnSettings?.swid,
    byName: S._playersByName,
    sleeperUserId: S.userId,
    // Rostership may already hold every team for this league — skip the refetch.
    rosters: RS.leagueRosters[lg.league_id],
  });
  WV.rosteredByLeague[lg.league_id] = res && res.owned;
  WV.myByLeague[lg.league_id]       = res && res.mine;
}

function wvBuildRows() {
  const targetLeagues = wvLeagues();

  if (WV.mode === 'dynasty') {
    const rows = [];
    for (const [pid, player] of Object.entries(S.players)) {
      const pos = crNormPos(player.position);
      if (!pos) continue;
      const fcVal  = WV.fcMap[pid] ?? 0;
      const adjVal = pos === 'TE' ? fcVal * 2 : fcVal;
      if (adjVal < 100) continue;

      const availLeagues = [];
      for (const lg of targetLeagues) {
        const rostered = WV.rosteredByLeague[lg.league_id];
        if (rostered && !rostered.has(pid)) availLeagues.push({ lgId: lg.league_id, lgName: lg.name || lg.league_id });
      }
      if (!availLeagues.length) continue;

      rows.push({ pid, name: player.full_name || pid, pos, team: player.team || 'FA', fcVal, adjVal, availCount: availLeagues.length, leagues: availLeagues });
    }
    rows.sort((a, b) => b.adjVal - a.adjVal);
    WV.rows    = rows;
    WV.sortCol = 'adjVal';
    WV.sortDir = -1;
  } else {
    // Redraft: use uploaded rankings, filter to available players
    const rows = [];
    for (const rank of WV.redraftRankings) {
      if (!rank.pid) continue;
      const player = S.players[rank.pid];
      if (!player) continue;

      const availLeagues = [];
      for (const lg of targetLeagues) {
        const rostered = WV.rosteredByLeague[lg.league_id];
        if (rostered && !rostered.has(rank.pid)) availLeagues.push({ lgId: lg.league_id, lgName: lg.name || lg.league_id });
      }
      if (!availLeagues.length) continue;

      rows.push({ pid: rank.pid, name: player.full_name || rank.name, pos: crNormPos(player.position) || rank.pos, team: player.team || 'FA', rank: rank.rank, fcVal: WV.fcMap[rank.pid] ?? 0, adjVal: WV.fcMap[rank.pid] ?? 0, availCount: availLeagues.length, leagues: availLeagues });
    }
    WV.rows    = rows;
    WV.sortCol = 'rank';
    WV.sortDir = 1;
  }
}

// ── Redraft waiver grid ──────────────────────────────────────────────────────
// One league at a time, laid out like the Weekly Ranks Grid (and reusing its
// .rg-* CSS): the uploaded sheet as side-by-side positional columns, banded by
// tier, with ownership painted on top. The cross-league table this replaced
// answered "who is free SOMEWHERE"; this answers "what should I do in THIS
// league", which is the question you actually have on a Tuesday.
//   green = on my roster · yellow = free agent · dimmed = another team owns him
const WV_GRID_COLS = [['QB','QB'], ['RB','RB', true], ['WR','WR', true], ['TE','TE'], ['DEF','D/ST'], ['K','K']];
const WV_SPLIT_MIN = 40;   // same threshold as the ranks grid — below it a split is two stubs

// The sheet is ONE flat overall list, so the columns are re-cut from it by
// position, keeping the sheet's own order within each.
function wvGridCols() {
  const cols = {};
  for (const r of WV.redraftRankings) {
    const raw = (r.pos || '').replace(/[^A-Za-z]/g, '');
    const pos = luNormPos(raw) || luNormPos(S.players[r.pid]?.position);
    if (!pos) continue;
    if (!cols[pos]) cols[pos] = [];
    cols[pos].push(r);
  }
  return cols;
}

// The league's own scoring, for season-to-date PPG. Null when it isn't known
// (an ESPN league whose mSettings didn't parse) — the grid then shows no PPG
// rather than a full-PPR number it can't label in a cell this small.
function wvLeagueScoring(lgId) {
  const d = S.leagueDetails[lgId];
  // An ESPN league whose lineup is loaded: its fixture's scoring object carries
  // ESPN's own K / D/ST season averages (ESPN_SEASON_AVG), so prefer it.
  const fix = d?.source === 'espn' ? LU.lineups.find(f => f.leagueId === lgId) : null;
  if (fix?.scoringSettings && Object.keys(fix.scoringSettings).length) return fix.scoringSettings;
  const ss = d?.source === 'espn' || String(lgId).startsWith('espn_') ? d?._espnScoring : d?.scoring_settings;
  return ss && Object.keys(ss).length ? ss : null;
}

// My rostered players the sheet doesn't put anywhere on the grid — the grid is
// the whole sheet, so they are invisible rather than merely low. `inGrid` is the
// pids the columns actually lay out (unfiltered), so a ranked IDP counts as
// missing too: from this view he is.
function wvUnrankedHtml(mine, inGrid, ppg) {
  if (!mine) return '';
  const order = ['QB','RB','WR','TE','K','DEF'];
  const rows = [...mine].map(String).filter(pid => pid !== '0' && !inGrid.has(pid)).map(pid => {
    const pos = luNormPos(S.players[pid]?.position) || crNormPos(S.players[pid]?.position) || '';
    const oi  = order.indexOf(pos);
    return { pid, pos, oi: oi < 0 ? order.length : oi, ppg: ppg(pid) };
  }).sort((a, b) => a.oi - b.oi || (b.ppg ?? -Infinity) - (a.ppg ?? -Infinity));
  if (!rows.length) return '';
  const name = e => `<span class="rg-un-p" title="${esc(e.pos)}">${esc(luPlayerName(e.pid))}`
    + (e.ppg != null ? `<em>${e.ppg.toFixed(1)}</em>` : '') + `</span>`;
  return `<div class="rg-unranked">
      <span class="rg-un-grp" title="On your roster in this league but not on the uploaded sheet, or at a position this grid does not lay out (IDP). The number is his season PPG in this league."><b>Your roster, not ranked:</b>${rows.map(name).join('<span class="rg-un-sep">·</span>')}</span>
    </div>`;
}

function wvSetGridLeague(v) {
  WV.gridLeagueId = v || null;
  const wrap = document.getElementById('wv-table-wrap');
  if (wrap) wrap.innerHTML = wvRenderTable();
}
function wvToggleFaOnly() {
  WV.gridFaOnly = !WV.gridFaOnly;
  const wrap = document.getElementById('wv-table-wrap');
  if (wrap) wrap.innerHTML = wvRenderTable();
}

function wvGridHtml() {
  if (!WV.redraftRankings.length) return `<div class="empty-state"><p>Upload a rankings CSV first, then reload</p></div>`;

  const leagues = wvLeagues().filter(lg => WV.rosteredByLeague[lg.league_id] !== undefined);
  if (!leagues.length) return `<div class="empty-state"><p>No redraft leagues loaded — every one was skipped or failed to load</p></div>`;

  const lgId  = leagues.some(lg => lg.league_id === WV.gridLeagueId) ? WV.gridLeagueId : leagues[0].league_id;
  const owned = WV.rosteredByLeague[lgId] || null;   // null = rosters didn't load; see wvLoadLeagueRosters
  const mine  = WV.myByLeague[lgId] || null;
  const scoring = wvLeagueScoring(lgId);
  const ppg   = scoring ? pid => playerSeasonPpg(pid, scoring) : () => null;

  const cols    = wvGridCols();
  const present = WV_GRID_COLS.filter(([k]) => (cols[k] || []).length);
  if (!present.length) return `<div class="empty-state"><p>None of the ${WV.redraftRankings.length} ranked rows carry a position this grid lays out (QB/RB/WR/TE/D-ST/K)</p></div>`;

  // A row's state. Unmatched rows (no Sleeper id) can't be placed on either side
  // of the ownership line, so they stay unpainted rather than guessing.
  const state = r => {
    const pid = r.pid ? String(r.pid) : null;
    if (!pid || !owned)   return 'unk';
    if (mine && mine.has(pid)) return 'mine';
    return owned.has(pid) ? 'taken' : 'fa';
  };

  let faCount = 0;
  for (const r of WV.redraftRankings) if (state(r) === 'fa') faCount++;

  const leagueSel = `<select onchange="wvSetGridLeague(this.value)" style="max-width:280px;">
      ${leagues.map(lg => `<option value="${esc(lg.league_id)}" ${lg.league_id === lgId ? 'selected' : ''}>${esc(lg.name || lg.league_id)}${lg.source === 'espn' ? ' (ESPN)' : ''}</option>`).join('')}
    </select>`;

  const note = !owned
    ? `<span style="font-size:0.6rem;color:#e08b88;">rosters didn't load for this league — nothing highlighted</span>` : '';

  const controls = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
      <span style="font-size:0.55rem;color:var(--brown-light);">League:</span>${leagueSel}
      <button class="ghost-btn rg-pill ${WV.gridFaOnly ? 'on' : ''}" style="font-size:0.5rem;" onclick="wvToggleFaOnly()">◎ Free agents only</button>
      <span style="font-size:0.6rem;color:var(--gold-light);">${faCount} ranked free agent${faCount === 1 ? '' : 's'}</span>
      ${note}
      <span style="flex:1;"></span>
      <span style="font-size:0.6rem;color:var(--brown-light);display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
        <span><span style="display:inline-block;width:9px;height:9px;background:rgba(95,174,95,0.6);border-left:3px solid #5fae5f;margin-right:4px;"></span>my roster</span>
        <span><span style="display:inline-block;width:9px;height:9px;background:rgba(235,195,55,0.75);border-left:3px solid #d6a82a;margin-right:4px;"></span>free agent</span>
        <span><span style="display:inline-block;width:9px;height:9px;background:var(--brown-dark);border:1px solid var(--brown-mid);margin-right:4px;opacity:0.45;"></span>rostered elsewhere</span>
      </span>
    </div>`;

  const navH = document.querySelector('.tab-bar')?.offsetHeight || 40;

  // Resolve every column's final row list FIRST, because --rg-tracks has to be
  // counted off the same lists that render. Splitting is decided on the FILTERED
  // length (a thinned column is exactly the two stubs WV_SPLIT_MIN exists to
  // avoid), so counting tracks off the unfiltered one leaves a dead track the
  // moment the FA filter is on.
  const built = present.map(([key, label, sp]) => {
    const full = cols[key];
    // Tier bands are computed over the FULL column before any filter or split,
    // and each row keeps its true index — otherwise the stripes restart halfway
    // down a split column, or realign every time the FA filter is toggled.
    const bands = [];
    for (let i = 0, b = 0; i < full.length; i++) {
      if (i > 0 && full[i].tier !== full[i - 1].tier) b ^= 1;
      bands.push(b);
    }
    const list = full.map((r, i) => [r, i]).filter(([r]) => !WV.gridFaOnly || state(r) === 'fa');
    return { key, label, bands, list, split: !!sp && list.length >= WV_SPLIT_MIN };
  });
  const tracks = built.reduce((n, c) => n + (c.split ? 2 : 1), 0);

  // Every pid the grid lays out, off the UNFILTERED columns — the FA filter
  // hiding my own players doesn't make them unranked.
  const inGrid = new Set();
  for (const [key] of present) for (const r of cols[key]) if (r.pid) inGrid.add(String(r.pid));

  const grid = `<div class="rg-wrap wv-grid" style="--rg-tracks:${tracks};">${built.map(({ label, bands, list, split }) => {
    if (!list.length) return `<div class="rg-col"><div class="rg-head" style="top:${navH}px;">${esc(label)} <em>0</em></div>
      <div class="rg-cell" style="color:var(--brown-light);font-style:italic;">none free</div></div>`;

    const cell = ([r, i]) => {
      const st  = state(r);
      const cls = st === 'mine' ? ' rg-on' : st === 'fa' ? ' rg-fa' : st === 'taken' ? ' wv-taken' : ' wv-unk';
      // With league scoring known, the cell carries the player's ACTUAL season
      // PPG in this league (the same helper the lineup rows and ranks grid use)
      // and the sheet's own PPG moves to the tooltip — two PPGs side by side
      // would be unreadable. Without it, the cell reads as it always did.
      const lp    = r.pid ? ppg(String(r.pid)) : null;
      const right = scoring || r.ppg == null ? esc(r.team || '') : r.ppg.toFixed(1);
      const gp    = lp != null ? playerSeasonGp(String(r.pid)) : 0;
      const tip = [r.team, r.bye ? 'bye ' + r.bye : '', r.tier ? 'tier ' + r.tier : '',
                   lp != null ? `${lp.toFixed(1)} PPG in this league over ${gp} game${gp === 1 ? '' : 's'}` : '',
                   scoring && r.ppg != null ? `sheet PPG ${r.ppg.toFixed(1)}` : '',
                   st === 'unk' ? 'no Sleeper match' : ''].filter(Boolean).join(' · ');
      return `<div class="rg-cell${bands[i] ? ' rg-tier-b' : ''}${cls}" title="${esc(tip)}">
        <span class="rg-rank">${r.posRank != null ? r.posRank : i + 1}</span>
        <span class="rg-name">${esc(r.name)}</span>
        <span class="rg-opp">${right}</span>
        ${scoring ? `<span class="rg-ppg wv-ppg">${lp != null ? lp.toFixed(1) : ''}</span>` : ''}
      </div>`;
    };
    const half = Math.ceil(list.length / 2);
    const body  = split
      ? `<div class="rg-halves"><div class="rg-half">${list.slice(0, half).map(cell).join('')}</div>`
        + `<div class="rg-half">${list.slice(half).map(cell).join('')}</div></div>`
      : list.map(cell).join('');
    return `<div class="rg-col${split ? ' rg-split' : ''}">
      <div class="rg-head" style="top:${navH}px;">${esc(label)} <em>${list.length}</em></div>${body}</div>`;
  }).join('')}</div>`;

  return controls + wvUnrankedHtml(owned ? mine : null, inGrid, ppg) + grid;
}

function wvRenderTable() {
  if (WV.mode !== 'dynasty') return wvGridHtml();
  if (!WV.rows.length) return `<div class="empty-state"><p>No available players found above value threshold (100)</p></div>`;

  const isDyn = true;
  // Season PPG + next week's projection, both scored with Sleeper's stock PPR
  // table — a cross-league row has no single league to score to. Attached to
  // the rows so they sort like any column.
  const ss = PPG_PPR_SCORING;
  for (const row of WV.rows) {
    row.seasonPpg = playerSeasonPpg(row.pid, ss);
    const line = WV.weekProj[row.pid];
    row.weekProj = line ? computeProjPts(line, ss) : null;
  }
  const ssLabel = 'Sleeper default PPR';

  const cols = isDyn
    ? [{ key:'name', label:'Player' }, { key:'pos', label:'Pos' }, { key:'adjVal', label:'FC Value' }, { key:'availCount', label:'# Available' }]
    : [{ key:'rank', label:'Rank' }, { key:'name', label:'Player' }, { key:'pos', label:'Pos' }, { key:'availCount', label:'# Available' }];
  cols.push({ key:'seasonPpg', label:'PPG', title:`Season-to-date points per game played — ${ssLabel}` });
  cols.push({ key:'weekProj', label: WV.projWeek ? `Wk ${WV.projWeek} Proj` : 'Proj', title:`Sleeper projection for week ${WV.projWeek ?? '?'} — ${ssLabel}` });

  const dash = '<span style="color:var(--brown-light);">—</span>';
  const numCell = (v, tip) => `<td style="font-family:'Playfair Display',serif;color:var(--cream);"${tip ? ` title="${esc(tip)}"` : ''}>${v != null ? v.toFixed(1) : dash}</td>`;
  const projCell = row => {
    const gp = playerSeasonGp(row.pid);
    return numCell(row.seasonPpg, row.seasonPpg != null ? `${gp} game${gp === 1 ? '' : 's'} played · ${ssLabel}` : '')
         + numCell(row.weekProj, '');
  };

  const mkTh = c => {
    const sorted = WV.sortCol === c.key;
    const arr    = sorted ? (WV.sortDir > 0 ? '▲' : '▼') : '⇅';
    return `<th onclick="wvSort('${c.key}')" class="${sorted?'rs-sorted':''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${c.label}<span class="rs-arr">${arr}</span></th>`;
  };

  const sorted = [...WV.rows].sort((a, b) => {
    const av = a[WV.sortCol], bv = b[WV.sortCol];
    if (typeof av === 'string') return WV.sortDir * av.localeCompare(bv ?? '');
    return WV.sortDir * ((av ?? 0) - (bv ?? 0));
  });

  const tbody = sorted.map(row => {
    const isExp = WV.expandedKey === row.pid;
    const posHtml = `<span class="rs-pos rs-pos-${row.pos}">${row.pos}</span>`;
    const teamHtml = `<span style="font-family:'Rye',serif;font-size:0.42rem;letter-spacing:0.1em;color:var(--brown-light);margin-left:5px;">${esc(row.team)}</span>`;
    const nameCell = `<button class="rs-name-btn${isExp?' rs-expanded':''}" onclick="wvToggle('${esc(row.pid)}')">${esc(row.name)}${teamHtml} <span class="rs-chevron">▾</span></button>`;

    const valCell = isDyn
      ? `<td style="font-family:'Playfair Display',serif;color:var(--cream);">${row.adjVal}${row.pos==='TE'?`<span style="font-size:0.75rem;color:var(--brown-light);margin-left:3px;">(${row.fcVal}×2)</span>`:''}</td>`
      : `<td style="font-family:'Playfair Display',serif;color:var(--cream);">#${row.rank}</td>`;

    const mainRow = isDyn
      ? `<tr><td>${nameCell}</td><td>${posHtml}</td>${valCell}<td style="font-family:'Playfair Display',serif;color:var(--cream);">${row.availCount}</td>${projCell(row)}</tr>`
      : `<tr><td style="font-family:'Playfair Display',serif;color:var(--cream);">#${row.rank}</td><td>${nameCell}</td><td>${posHtml}</td><td style="font-family:'Playfair Display',serif;color:var(--cream);">${row.availCount}</td>${projCell(row)}</tr>`;

    const colSpan = cols.length;
    const expandRow = isExp ? `<tr class="rs-expand-row"><td colspan="${colSpan}">
      <div class="rs-expand-inner">
        <div class="rs-expand-title">Available In</div>
        <div class="rs-expand-leagues">${row.leagues.map(l => `<span class="rs-expand-tag">${esc(l.lgName)}</span>`).join('')}</div>
      </div>
    </td></tr>` : '';

    return mainRow + expandRow;
  }).join('');

  return `<div style="overflow-x:auto;"><table class="rs-table">
    <thead><tr>${cols.map(mkTh).join('')}</tr></thead>
    <tbody>${tbody}</tbody>
  </table></div>`;
}

function wvSort(col) {
  if (WV.sortCol === col) {
    WV.sortDir *= -1;
  } else {
    WV.sortCol = col;
    WV.sortDir = (col === 'rank' || col === 'name' || col === 'pos' || col === 'team') ? 1 : -1;
  }
  const wrap = document.getElementById('wv-table-wrap');
  if (wrap) wrap.innerHTML = wvRenderTable();
}

function wvToggle(pid) {
  WV.expandedKey = WV.expandedKey === pid ? null : pid;
  const wrap = document.getElementById('wv-table-wrap');
  if (wrap) wrap.innerHTML = wvRenderTable();
}

function wvSetMode(mode) {
  if (WV.mode === mode) return;
  WV.mode    = mode;
  WV.loaded  = false;
  WV.rows    = [];
  WV.expandedKey = null;
  wvApplyWide('waivers');
  renderWaivers();
}

// Rankings CSV → [{name, pos, rank, pid}]. Columns are located by HEADER TEXT,
// not by position: exports differ (this app's own sheet leads with an "Overall"
// index column, a plain list leads with the name), and reading column 0 as the
// name is what silently turned every row of such a sheet into
// {name:"1", rank:NaN, pid:null} — rows loaded, nothing ever matched.
const WV_RANK_COLS = {
  name: ['PLAYER', 'NAME', 'PLAYER NAME', 'FULL NAME'],
  pos:  ['POSITION', 'POS'],
  rank: ['OVERALL', 'OVERALL RANK', 'RANK', 'RK', '#'],
  team: ['TEAM', 'NFL TEAM', 'TM'],
  // Read when present, all optional — they only decorate the redraft grid.
  posRank: ['POSITIONAL RANK', 'POS RANK', 'POSITION RANK'],
  tier: ['TIER'],
  ppg:  ['PPG', 'POINTS PER GAME'],
  bye:  ['BYE', 'BYE WEEK'],
};

// A row is the header iff it carries a recognizable NAME column — that is the
// one field the parser can't work without.
function wvRankHeaderIdx(row) {
  const idx = {};
  (row || []).forEach((h, i) => {
    const k = String(h || '').trim().toUpperCase();
    for (const field in WV_RANK_COLS) {
      if (idx[field] === undefined && WV_RANK_COLS[field].includes(k)) idx[field] = i;
    }
  });
  return idx.name === undefined ? null : idx;
}

async function wvUploadRankings(input) {
  const file = input.files[0];
  if (!file) return;
  const text = await file.text();
  await loadPlayers();

  // Real CSV split (quoted fields, BOM stripped) — shared with the weekly sheet.
  const rows = csvRows(text).filter(r => r.some(c => String(c || '').trim()));
  const idx  = rows.length ? wvRankHeaderIdx(rows[0]) : null;
  const col  = idx || { name: 0, pos: 1, rank: 2 };   // bare "Name, Position, Rank" fallback
  let body   = idx ? rows.slice(1) : rows;
  // Unrecognized header on the fallback path: test the PARSED cell, not the raw
  // line — a quoted first field ("Player") never matched the old raw-line regex.
  if (!idx && body.length && /^(rank|player|name|pos|overall)$/i.test(String(body[0][0] || '').trim())) body = body.slice(1);

  const rankings = [];
  let unmatched = 0, autoRank = 1;
  for (const r of body) {
    const cell = k => (col[k] === undefined ? '' : String(r[col[k]] ?? '').trim());
    const name = cell('name');
    if (!name) continue;
    const n   = parseInt(cell('rank'), 10);
    const pid = luMatchRankRow(name, cell('team'));
    if (!pid) unmatched++;
    rankings.push({
      name, pos: cell('pos'), rank: isFinite(n) ? n : autoRank, pid: pid || null,
      posRank: luNum(cell('posRank')), tier: cell('tier') || null,
      team: cell('team'), ppg: luNum(cell('ppg')), bye: cell('bye'),
    });
    autoRank++;
  }

  WV.redraftRankings = rankings;
  WV.rankUnmatched   = unmatched;
  WV.loaded = false;
  WV.rows   = [];
  renderWaivers();
}
