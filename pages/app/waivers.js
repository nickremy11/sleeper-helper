// Waivers tab

// ── 3. Waivers ────────────────────────────────────────────────────────────────
// Two modes (WV.mode — which leagues are scanned) × a few views each (WV.views):
//   dynasty: fc (FantasyCalc value table) · trending · ranks
//   redraft: trending · ranks
// Every view reads the same per-league ownership (wvLoadLeagueRosters), loaded
// once per mode; switching view never refetches rosters.

const WV_VIEWS = {
  dynasty: [['fc', 'FC Value'], ['trending', 'Trending'], ['ranks', 'vs Rankings']],
  redraft: [['trending', 'Trending'], ['ranks', 'vs Rankings']],
};
const WV_PREFS_KEY = 'wv_prefs_v2';

function wvView() {
  const v = WV.views[WV.mode];
  return WV_VIEWS[WV.mode].some(([k]) => k === v) ? v : WV_VIEWS[WV.mode][0][0];
}
// The ranking list behind the vs Rankings view — one per mode, since a dynasty
// board and a redraft board are different lists.
function wvRanks() { return WV.ranks[WV.mode]; }

function wvSavePrefs() {
  try {
    localStorage.setItem(WV_PREFS_KEY, JSON.stringify({
      mode: WV.mode, views: WV.views, trendHours: WV.trendHours,
      trendAvailOnly: WV.trendAvailOnly, rankLayout: WV.rankLayout,
      rankSrc: { dynasty: WV.ranks.dynasty.src, redraft: WV.ranks.redraft.src },
      mrSet:   { dynasty: WV.ranks.dynasty.setId, redraft: WV.ranks.redraft.setId },
    }));
  } catch {}
}

const WV_HINT = {
  'dynasty:fc':       'Dynasty leagues · free agents with FC value ≥ 100 (TE ×2)',
  'dynasty:trending': 'Dynasty leagues · Sleeper’s most-added players',
  'dynasty:ranks':    'Your ranking list against your dynasty leagues · as a grid over one league, or the top ranked players still available',
  'redraft:trending': 'Redraft leagues · Sleeper’s most-added players · guillotine leagues excluded',
  'redraft:ranks':    'Your ranking list against your redraft leagues · as a grid over one league, or the top ranked players still available · guillotine leagues excluded',
};

function renderWaivers() {
  const isDyn = WV.mode === 'dynasty';
  const view  = wvView();
  const msg   = s => `<span style="font-family:var(--font-body),serif;font-size:0.82rem;font-style:italic;color:var(--brown-light);">${s}</span>`;

  // Loads by itself on arrival (and after a mode switch) — the button is for
  // re-reading later. Flagged before the paint so it shows the loading state.
  const autoLoad = !WV.loaded && !WV.loading;
  if (autoLoad) WV.loading = true;

  setC(`<div>
    <div class="tab-header" style="margin-bottom:16px;">
      <div class="section-head" style="margin-bottom:0;flex:1;"><h2>Waivers</h2><div class="section-head-line"></div></div>
    </div>
    <div class="wv-mode-bar">
      <span class="filter-lbl-rs">Mode</span>
      <button class="pos-pill${isDyn?' active':''}" onclick="wvSetMode('dynasty')">Dynasty</button>
      <button class="pos-pill${!isDyn?' active':''}" onclick="wvSetMode('redraft')">Redraft</button>
      <span class="filter-lbl-rs" style="margin-left:14px;">View</span>
      ${WV_VIEWS[WV.mode].map(([k, label]) =>
        `<button class="pos-pill${view === k ? ' active' : ''}" onclick="wvSetView('${k}')">${label}</button>`).join('')}
    </div>
    <div style="margin:-8px 0 14px;">${msg(WV_HINT[WV.mode + ':' + view] || '')}</div>
    ${view === 'ranks' ? `<div id="wv-src-row">${wvRankSourceHtml()}</div>` : ''}
    ${view === 'trending' ? wvTrendControlsHtml() : ''}
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
      <button class="setup-btn" id="wv-load-btn" onclick="loadWaiverData()" style="height:32px;" ${WV.loading ? 'disabled' : ''}>${WV.loading ? 'Loading…' : WV.loaded ? '↻ Refresh' : 'Load'}</button>
      <span class="setup-status" id="wv-load-status" style="margin:0;"></span>
      ${WV.loaded && WV.skippedCount > 0 ? `<span class="setup-status" style="margin:0;font-style:italic;">— ${WV.skippedCount} league${WV.skippedCount > 1 ? 's' : ''} skipped (draft not yet complete)</span>` : ''}
    </div>
    <div id="wv-table-wrap">
      ${WV.loaded ? wvRenderTable() : WV.loading ? loading(isDyn ? 'Scanning dynasty leagues' : 'Loading redraft rosters') : `<div class="empty-state"><p>Click Load to pull rosters</p></div>`}
    </div>
  </div>`);

  if (autoLoad) loadWaiverData();
  if (view === 'trending') wvEnsureTrend();
  if (view === 'ranks') wvEnsureRankSource();
}

function wvRedrawBody() {
  const wrap = document.getElementById('wv-table-wrap');
  if (wrap && WV.loaded) wrap.innerHTML = wvRenderTable();
}

function wvSetView(v) {
  if (wvView() === v) return;
  WV.views[WV.mode] = v;
  WV.expandedKey = null;
  wvSavePrefs();
  wvApplyWide('waivers');
  renderWaivers();
}

// ── Trending view ────────────────────────────────────────────────────────────
// Sleeper's most-added players across every Sleeper league
// (/players/nfl/trending/add), over the last 24 or 48 hours. Each player then
// carries how many of MY leagues (this mode) he's free in.

const WV_TREND_LIMIT = 100;   // how many signals are pulled
const WV_TREND_SHOW  = 60;    // how many rows render after the availability filter

function wvTrendKey() { return 'adds_' + WV.trendHours; }

function wvTrendControlsHtml() {
  const pill = (on, fn, label) => `<button class="pos-pill${on ? ' active' : ''}" onclick="${fn}">${label}</button>`;
  return `<div class="wv-mode-bar" style="margin-top:-4px;">
      <span class="filter-lbl-rs">Window</span>
        ${pill(WV.trendHours === 24, "wvSetTrend('hours',24)", '24h')}
        ${pill(WV.trendHours === 48, "wvSetTrend('hours',48)", '48h')}
      <span style="width:14px;"></span>
      ${pill(WV.trendAvailOnly, "wvSetTrend('avail')", '◎ Available somewhere only')}
    </div>`;
}

function wvSetTrend(what, val) {
  if (what === 'hours') WV.trendHours = val;
  else if (what === 'avail') WV.trendAvailOnly = !WV.trendAvailOnly;
  WV.expandedKey = null;
  wvSavePrefs();
  renderWaivers();
}

// Fetches the current signal once per key per page load; a failure is stored
// so the table can say so (the button redraw retries).
async function wvEnsureTrend(force) {
  const key = wvTrendKey();
  const have = WV.trend[key];
  if (have && !force && !have.error) return;
  if (have?.loading) return;
  WV.trend[key] = { loading: true };
  try {
    const res = await api(`/players/nfl/trending/add?lookback_hours=${WV.trendHours}&limit=${WV_TREND_LIMIT}`);
    if (!Array.isArray(res)) throw new Error('Sleeper trending unavailable');
    WV.trend[key] = { list: res.map(x => ({ pid: String(x.player_id), signal: x.count })) };
  } catch (e) {
    WV.trend[key] = { error: e.message || String(e) };
  }
  if (S.tab === 'waivers' && wvView() === 'trending' && wvTrendKey() === key) wvRedrawBody();
}

// {lgId, lgName} for every league of this mode where nobody rosters him, plus
// how many I own him in. Leagues whose rosters failed to load count as neither.
function wvAvailability(pid) {
  const leagues = [];
  let mine = 0;
  for (const lg of wvLeagues()) {
    const owned = WV.rosteredByLeague[lg.league_id];
    if (!owned) continue;
    if (WV.myByLeague[lg.league_id]?.has(pid)) mine++;
    else if (!owned.has(pid)) leagues.push({ lgId: lg.league_id, lgName: lg.name || lg.league_id });
  }
  return { leagues, mine };
}

function wvTrendHtml() {
  const key = wvTrendKey();
  const t = WV.trend[key];
  if (!t || t.loading) return loading('Loading Sleeper trending adds');
  if (t.error) return `<div class="err-state">${esc(t.error)} — <a href="#" onclick="wvEnsureTrend(true);return false;">retry</a></div>`;

  const ss = PPG_PPR_SCORING;
  const all = [];
  for (const [i, x] of t.list.entries()) {
    const p = S.players[x.pid];
    if (!p) continue;
    const pos = crNormPos(p.position) || luNormPos(p.position) || p.position || '';
    // Dynasty leagues rarely start a K or D/ST, and their adds are week-to-week streaming.
    if (WV.mode === 'dynasty' && (pos === 'K' || pos === 'DEF')) continue;
    const av = wvAvailability(x.pid);
    const line = WV.weekProj[x.pid];
    all.push({
      pid: x.pid, trendRank: i + 1, name: p.full_name || sleeperName(p) || x.pid, pos, team: p.team || 'FA',
      signal: x.signal, fcVal: WV.fcMap[x.pid] ?? null,
      availCount: av.leagues.length, leagues: av.leagues, mine: av.mine,
      seasonPpg: playerSeasonPpg(x.pid, ss), weekProj: line ? computeProjPts(line, ss) : null,
    });
  }
  const rows = (WV.trendAvailOnly ? all.filter(r => r.availCount > 0) : all).slice(0, WV_TREND_SHOW);

  const signalLabel = `Adds ${WV.trendHours}h`;
  const note = `Adds across every Sleeper league in the last ${WV.trendHours} hours, not just yours.`;
  const hidden = all.length - rows.length;

  if (!rows.length) return `<p class="wv-note">${note}</p><div class="empty-state"><p>${WV.trendAvailOnly ? 'None of these players is free in any of your leagues' : 'Nothing trending right now'}</p></div>`;

  const cols = [
    { key: 'trendRank', label: '#' },
    { key: 'name', label: 'Player' },
    { key: 'pos', label: 'Pos' },
    { key: 'signal', label: signalLabel, title: note },
    ...(WV.mode === 'dynasty' ? [{ key: 'fcVal', label: 'FC Value' }] : []),
    { key: 'availCount', label: '# Available', title: 'How many of your leagues in this mode have him on waivers' },
    { key: 'mine', label: 'Mine', title: 'How many of your leagues in this mode you already roster him in' },
    { key: 'seasonPpg', label: 'PPG', title: 'Season-to-date points per game played — Sleeper default PPR' },
    { key: 'weekProj', label: WV.projWeek ? `Wk ${WV.projWeek} Proj` : 'Proj', title: 'Sleeper projection — Sleeper default PPR' },
  ];
  if (!cols.some(c => c.key === WV.sortCol)) { WV.sortCol = 'trendRank'; WV.sortDir = 1; }
  const sorted = wvSortRows(rows);
  const num = (v, dp = 1) => `<td class="wv-num">${v != null ? (dp ? v.toFixed(dp) : v.toLocaleString()) : '<span style="color:var(--brown-light);">—</span>'}</td>`;

  const tbody = sorted.map(r => {
    const sig = r.signal.toLocaleString();
    const cells = `<td class="wv-num">${r.trendRank}</td><td>${wvNameCell(r)}</td><td><span class="rs-pos rs-pos-${esc(r.pos)}">${esc(r.pos)}</span></td>`
      + `<td class="wv-num" style="color:var(--c-green);">${sig}</td>`
      + (WV.mode === 'dynasty' ? num(r.fcVal, 0) : '')
      + `<td class="wv-num">${r.availCount}</td><td class="wv-num">${r.mine || ''}</td>`
      + num(r.seasonPpg) + num(r.weekProj);
    return `<tr>${cells}</tr>` + wvExpandRow(r, cols.length);
  }).join('');

  return `<p class="wv-note">${note}${hidden > 0 && WV.trendAvailOnly ? ` ${hidden} rostered everywhere hidden.` : ''}</p>
    <div style="overflow-x:auto;"><table class="rs-table">
    <thead><tr>${cols.map(wvTh).join('')}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

// ── Shared table pieces (FC Value + Trending) ────────────────────────────────
function wvTh(c) {
  const sorted = WV.sortCol === c.key;
  const arr = sorted ? (WV.sortDir > 0 ? '▲' : '▼') : '⇅';
  return `<th onclick="wvSort('${c.key}')" class="${sorted ? 'rs-sorted' : ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}<span class="rs-arr">${arr}</span></th>`;
}
function wvSortRows(rows) {
  return [...rows].sort((a, b) => {
    const av = a[WV.sortCol], bv = b[WV.sortCol];
    if (typeof av === 'string') return WV.sortDir * av.localeCompare(bv ?? '');
    // Missing numbers sink in both directions.
    if (av == null || bv == null) return (av == null) - (bv == null);
    return WV.sortDir * (av - bv);
  });
}
function wvNameCell(row) {
  const isExp = WV.expandedKey === row.pid;
  const team = `<span style="font-family:var(--font-display),serif;font-size:0.61rem;letter-spacing:0.1em;color:var(--brown-light);margin-left:5px;">${esc(row.team)}</span>`;
  return `<button class="rs-name-btn${isExp ? ' rs-expanded' : ''}" onclick="wvToggle(${jsArg(row.pid)})">${esc(row.name)}${team} <span class="rs-chevron">▾</span></button>`;
}
function wvExpandRow(row, colSpan) {
  if (WV.expandedKey !== row.pid) return '';
  return `<tr class="rs-expand-row"><td colspan="${colSpan}">
      <div class="rs-expand-inner">
        <div class="rs-expand-title">Available In</div>
        <div class="rs-expand-leagues">${row.leagues.length
          ? row.leagues.map(l => `<span class="rs-expand-tag">${esc(l.lgName)}</span>`).join('')
          : '<span style="font-style:italic;color:var(--brown-light);">rostered in every league</span>'}</div>
      </div>
    </td></tr>`;
}

// ── vs Rankings: where the list comes from ───────────────────────────────────
// A CSV upload or one of your My Ranks sets — both become the same flat
// [{name, pos, rank, posRank, tier, team, pid}] list the grid lays out.

function wvRankSourceHtml() {
  const R = wvRanks();
  const pill = (k, label) => `<button class="pos-pill${R.src === k ? ' active' : ''}" onclick="wvSetRankSrc('${k}')">${label}</button>`;
  const status = R.rows.length
    ? `<span class="setup-status ok" style="margin:0;">${R.rows.length} players · ${esc(R.label || '')}${R.unmatched ? ` · ${R.unmatched} unmatched` : ''}</span>`
    : '';
  let pick;
  if (R.src === 'csv') {
    pick = `<input type="file" id="wv-file" accept=".csv,.txt" class="wv-file-input" onchange="wvUploadRankings(this)" />
      ${R.rows.length && R.label ? '' : `<span style="font-family:var(--font-body),serif;font-size:0.82rem;font-style:italic;color:var(--brown-light);">CSV with a Player column (Position / Overall / Team / Tier read if present), or one name per line</span>`}`;
  } else if (!S.auth) {
    pick = `<span style="font-style:italic;color:var(--brown-light);font-size:0.85rem;">Sign in to use your My Ranks sets</span>`;
  } else if (WV.mrError) {
    pick = `<span style="color:var(--c-red);font-size:0.85rem;">${esc(WV.mrError)}</span>`;
  } else if (!WV.mrSources) {
    pick = `<span style="font-style:italic;color:var(--brown-light);font-size:0.85rem;">Loading your sets…</span>`;
  } else if (!WV.mrSources.length) {
    pick = `<span style="font-size:0.85rem;">No ranking sets yet — build one at <a href="https://myranks.ffhistorian.com" target="_blank" rel="noopener">My Ranks</a></span>`;
  } else {
    pick = `<select onchange="wvPickMyRanks(this.value)" style="max-width:300px;">
        <option value="">Choose a set…</option>
        ${WV.mrSources.map(s => `<option value="${esc(s.id)}"${s.id === R.setId ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}
      </select>${R.loading ? ' <span style="font-style:italic;color:var(--brown-light);font-size:0.85rem;">loading…</span>' : ''}`;
  }
  return `<div class="wv-upload-row">
      <span class="filter-lbl-rs">Rankings</span>${pill('myranks', 'My Ranks')}${pill('csv', 'CSV')}
      <span style="width:6px;"></span>${pick} ${status}
    </div>`;
}

function wvRedrawSource() {
  const el = document.getElementById('wv-src-row');
  if (el) el.innerHTML = wvRankSourceHtml();
}

function wvSetRankSrc(src) {
  const R = wvRanks();
  if (R.src === src) return;
  // The list on screen belongs to the source that made it.
  Object.assign(R, { src, rows: [], unmatched: 0, label: null });
  wvSavePrefs();
  renderWaivers();
}

// Loads the set list (once), then the remembered set for this mode if any.
async function wvEnsureRankSource() {
  const R = wvRanks();
  if (R.src !== 'myranks' || !S.auth) return;
  if (!WV.mrSources && !WV.mrLoading) {
    WV.mrLoading = true;
    try { WV.mrSources = await mrbFetchSources(); WV.mrError = null; }
    catch (e) { WV.mrError = e.message || String(e); }
    WV.mrLoading = false;
    if (S.tab === 'waivers') wvRedrawSource();
  }
  if (WV.mrSources && R.setId && !R.rows.length && !R.loading
      && WV.mrSources.some(s => s.id === R.setId)) wvPickMyRanks(R.setId);
}

async function wvPickMyRanks(id) {
  const mode = WV.mode, R = WV.ranks[mode];
  R.setId = id || null;
  wvSavePrefs();
  if (!id) { Object.assign(R, { rows: [], unmatched: 0, label: null }); wvRedrawSource(); wvRedrawBody(); return; }
  R.loading = true; wvRedrawSource();
  try {
    await loadPlayers();
    const raw = await mrbFetchRanksFor(id, WV.mrSources);
    if (R.setId !== id) return;   // picked another set meanwhile
    // The one ordering rule for a My Ranks set (tier → FantasyCalc → name),
    // shared with the badges, so a set reads the same everywhere.
    const ranked = mrbRankRows(raw, { players: S.players, byName: S._playersByName, fcMap: RS.fcMap || WV.fcMap });
    R.rows = ranked.map(r => ({
      name: r.name, pos: r.pos || '', rank: r.overall, posRank: r.posRank,
      tier: r.tier || null, team: r.team || '', pid: r.pid ? String(r.pid) : null, ppg: null, bye: '',
    }));
    R.unmatched = ranked.filter(r => !r.pid).length;
    R.label = WV.mrSources.find(s => s.id === id)?.label || 'My Ranks';
  } catch (e) {
    Object.assign(R, { rows: [], unmatched: 0, label: null });
    WV.mrError = e.message || String(e);
  }
  R.loading = false;
  if (S.tab === 'waivers' && WV.mode === mode) { wvRedrawSource(); wvRedrawBody(); }
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
  // A mode switch mid-load bumps loadSeq; this run then drops its results.
  const seq = WV.loadSeq = (WV.loadSeq || 0) + 1;
  WV.loading = true;
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  if (statEl) statEl.textContent = '';

  try {
    if (statEl) statEl.textContent = 'Loading players…';
    await loadPlayers();

    // Upcoming-week projections for the FC and Trending tables — overlaps the fetches below.
    const projP = wvLoadWeekProj();

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

    // The FC Value table is cross-league and needs the row build; the grid
    // renders one league at a time and keeps its league if it's still loaded.
    if (seq !== WV.loadSeq) return;
    if (WV.mode === 'dynasty') wvBuildRows();
    if (!eligible.some(lg => lg.league_id === WV.gridLeagueId)) WV.gridLeagueId = eligible[0]?.league_id || null;
    // Refresh re-reads the trending signal too.
    if (wvView() === 'trending' && WV.loaded) wvEnsureTrend(true);
    WV.loaded = true;
    WV.loading = false;
    WV.skippedCount = skipped;
    if (S.tab === 'waivers') renderWaivers();
  } catch(e) {
    const st = document.getElementById('wv-load-status');
    if (st && seq === WV.loadSeq) st.textContent = 'Error: ' + e.message;
  } finally {
    if (seq === WV.loadSeq) {
      WV.loading = false;
      const b = document.getElementById('wv-load-btn');
      if (b) { b.disabled = false; b.textContent = WV.loaded ? '↻ Refresh' : 'Load'; }
    }
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

// Dynasty FC Value table: every player FantasyCalc values ≥ 100 (TE ×2) who is
// free in at least one of this mode's leagues.
function wvBuildRows() {
  const targetLeagues = wvLeagues();
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
  WV.rows = rows;
}

// ── vs Rankings: Grid | Top available ────────────────────────────────────────
// Two layouts of the same ranking list. Grid = the whole list over one league,
// ownership painted on. Top available = only the free agents, in the list's
// order, with season PPG and next week's projection — one league, or every
// league of this mode at once (then with a # Available count).

const WV_LIST_PAGE = 50;
const WV_LIST_ALL  = '__all';
const WV_LIST_POS  = ['ALL', 'QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

function wvSetRankLayout(l) {
  if (WV.rankLayout === l) return;
  WV.rankLayout = l;
  WV.expandedKey = null;
  wvSavePrefs();
  wvApplyWide('waivers');
  wvRedrawBody();
}
function wvSetListLeague(v) { WV.listLeagueId = v || WV_LIST_ALL; WV.listShown = WV_LIST_PAGE; WV.expandedKey = null; wvRedrawBody(); }
function wvSetListPos(p)    { WV.listPos = p; WV.listShown = WV_LIST_PAGE; wvRedrawBody(); }
function wvListMore()       { WV.listShown += WV_LIST_PAGE; wvRedrawBody(); }

function wvRanksHtml() {
  const pill = (k, label) => `<button class="pos-pill${WV.rankLayout === k ? ' active' : ''}" onclick="wvSetRankLayout('${k}')">${label}</button>`;
  const bar = `<div class="wv-mode-bar" style="margin-bottom:12px;"><span class="filter-lbl-rs">Layout</span>${pill('grid', 'Grid')}${pill('list', 'Top available')}</div>`;
  return bar + (WV.rankLayout === 'list' ? wvRankListHtml() : wvGridHtml());
}

function wvRankListHtml() {
  const ranks = wvRanks().rows;
  if (!ranks.length) return `<div class="empty-state"><p>${wvRanks().src === 'csv' ? 'Upload a rankings CSV above' : 'Pick one of your My Ranks sets above'}</p></div>`;
  const leagues = wvLeagues().filter(lg => WV.rosteredByLeague[lg.league_id] !== undefined);
  if (!leagues.length) return `<div class="empty-state"><p>No ${WV.mode} leagues loaded — every one was skipped or failed to load</p></div>`;

  const all  = WV.listLeagueId === WV_LIST_ALL || !leagues.some(lg => lg.league_id === WV.listLeagueId);
  const lgId = all ? null : WV.listLeagueId;
  // One league: its own scoring. Every league: Sleeper's stock PPR, labelled.
  const lgSs = lgId ? wvLeagueScoring(lgId) : null;
  const ss   = lgSs || PPG_PPR_SCORING;
  const ssLabel = lgSs ? 'this league’s scoring' : 'Sleeper default PPR';
  const owned = lgId ? WV.rosteredByLeague[lgId] : null;

  const rows = [];
  const posN = {};   // positional rank from list order, when the list carries none
  for (const r of ranks) {
    const p = r.pid ? S.players[String(r.pid)] : null;
    const pos = luNormPos(String(r.pos || '').replace(/[^A-Za-z]/g, '')) || luNormPos(p?.position) || crNormPos(p?.position) || r.pos || '';
    const posRank = r.posRank ?? (posN[pos] = (posN[pos] || 0) + 1);
    if (!r.pid) continue;
    const pid = String(r.pid);
    if (WV.listPos !== 'ALL' && pos !== WV.listPos) continue;
    let leagues;
    if (lgId) {
      if (!owned || owned.has(pid)) continue;
      leagues = [];
    } else {
      leagues = wvAvailability(pid).leagues;
      if (!leagues.length) continue;
    }
    const line = WV.weekProj[pid];
    rows.push({
      pid, rank: r.rank, posRank, tier: r.tier ?? null,
      name: p?.full_name || r.name, pos, team: p?.team || r.team || 'FA',
      availCount: leagues.length, leagues,
      seasonPpg: playerSeasonPpg(pid, ss), weekProj: line ? computeProjPts(line, ss) : null,
    });
  }

  const leagueSel = `<select onchange="wvSetListLeague(this.value)" style="max-width:300px;">
      <option value="${WV_LIST_ALL}"${all ? ' selected' : ''}>All ${WV.mode} leagues (${leagues.length})</option>
      ${leagues.map(lg => `<option value="${esc(lg.league_id)}"${lg.league_id === lgId ? ' selected' : ''}>${esc(lg.name || lg.league_id)}${lg.source === 'espn' ? ' (ESPN)' : ''}</option>`).join('')}
    </select>`;
  const posPills = WV_LIST_POS.map(k => `<button class="pos-pill${WV.listPos === k ? ' active' : ''}" onclick="wvSetListPos('${k}')">${k === 'ALL' ? 'All' : k === 'DEF' ? 'D/ST' : k}</button>`).join('');
  const controls = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
      <span style="font-size:0.65rem;color:var(--brown-light);">League:</span>${leagueSel}
      <span style="width:8px;"></span>${posPills}
    </div>`;
  const note = `<p class="wv-note">${rows.length} ranked player${rows.length === 1 ? '' : 's'} free${all ? ' in at least one league' : ' in this league'}${lgId && !owned ? ' — rosters didn’t load for this league' : ''}. PPG and projection use ${ssLabel}.</p>`;
  if (!rows.length) return controls + note;

  const cols = [
    { key: 'rank', label: 'Rank' },
    { key: 'name', label: 'Player' },
    { key: 'pos', label: 'Pos' },
    { key: 'posRank', label: 'Pos Rk' },
    { key: 'tier', label: 'Tier' },
    ...(all ? [{ key: 'availCount', label: '# Available', title: 'How many of your leagues in this mode have him on waivers' }] : []),
    { key: 'seasonPpg', label: 'PPG', title: 'Season-to-date points per game played — ' + ssLabel },
    { key: 'weekProj', label: WV.projWeek ? `Wk ${WV.projWeek} Proj` : 'Proj', title: 'Sleeper projection for the upcoming week — ' + ssLabel },
  ];
  if (!cols.some(c => c.key === WV.sortCol)) { WV.sortCol = 'rank'; WV.sortDir = 1; }
  const shown = wvSortRows(rows).slice(0, WV.listShown);
  const num = (v, dp = 1) => `<td class="wv-num">${v != null && v !== '' ? (dp ? Number(v).toFixed(dp) : esc(String(v))) : '<span style="color:var(--brown-light);">—</span>'}</td>`;

  const tbody = shown.map(r => {
    const name = all ? wvNameCell(r)
      : `<span style="font-family:var(--font-body),serif;">${esc(r.name)}</span><span style="font-family:var(--font-display),serif;font-size:0.61rem;letter-spacing:0.1em;color:var(--brown-light);margin-left:5px;">${esc(r.team)}</span>`;
    return `<tr>${num(r.rank, 0)}<td>${name}</td><td><span class="rs-pos rs-pos-${esc(r.pos)}">${esc(r.pos)}</span></td>`
      + num(r.posRank, 0) + num(r.tier, 0)
      + (all ? `<td class="wv-num">${r.availCount}</td>` : '')
      + num(r.seasonPpg) + num(r.weekProj) + `</tr>` + (all ? wvExpandRow(r, cols.length) : '');
  }).join('');

  return controls + note + `<div style="overflow-x:auto;"><table class="rs-table">
      <thead><tr>${cols.map(wvTh).join('')}</tr></thead><tbody>${tbody}</tbody></table></div>`
    + (rows.length > shown.length ? `<div style="text-align:center;margin-top:10px;"><button class="setup-btn" onclick="wvListMore()">Show ${Math.min(WV_LIST_PAGE, rows.length - shown.length)} more</button></div>` : '');
}

// ── vs Rankings grid ──────────────────────────────────────────────────────
// One league at a time, laid out like the Weekly Ranks Grid (and reusing its
// .rg-* CSS): the uploaded sheet as side-by-side positional columns, banded by
// tier, with ownership painted on top. The cross-league table this replaced
// answered "who is free SOMEWHERE"; this answers "what should I do in THIS
// league", which is the question you actually have on a Tuesday.
//   green = on my roster · yellow = free agent · dimmed = another team owns him
const WV_GRID_COLS = [['QB','QB'], ['RB','RB', true], ['WR','WR', true], ['TE','TE'], ['DEF','D/ST'], ['K','K']];
const WV_SPLIT_MIN = 40;   // same threshold as the ranks grid — below it a split is two stubs

// The list is ONE flat overall list, so the columns are re-cut from it by
// position, keeping the list's own order within each.
function wvGridCols() {
  const cols = {};
  for (const r of wvRanks().rows) {
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
  wvRedrawBody();
}
function wvToggleFaOnly() {
  WV.gridFaOnly = !WV.gridFaOnly;
  wvRedrawBody();
}

function wvGridHtml() {
  const ranks = wvRanks().rows;
  if (!ranks.length) return `<div class="empty-state"><p>${wvRanks().src === 'csv' ? 'Upload a rankings CSV above' : 'Pick one of your My Ranks sets above'}</p></div>`;

  const leagues = wvLeagues().filter(lg => WV.rosteredByLeague[lg.league_id] !== undefined);
  if (!leagues.length) return `<div class="empty-state"><p>No ${WV.mode} leagues loaded — every one was skipped or failed to load</p></div>`;

  const lgId  = leagues.some(lg => lg.league_id === WV.gridLeagueId) ? WV.gridLeagueId : leagues[0].league_id;
  const owned = WV.rosteredByLeague[lgId] || null;   // null = rosters didn't load; see wvLoadLeagueRosters
  const mine  = WV.myByLeague[lgId] || null;
  const scoring = wvLeagueScoring(lgId);
  const ppg   = scoring ? pid => playerSeasonPpg(pid, scoring) : () => null;

  const cols    = wvGridCols();
  const present = WV_GRID_COLS.filter(([k]) => (cols[k] || []).length);
  if (!present.length) return `<div class="empty-state"><p>None of the ${ranks.length} ranked rows carry a position this grid lays out (QB/RB/WR/TE/D-ST/K)</p></div>`;

  // A row's state. Unmatched rows (no Sleeper id) can't be placed on either side
  // of the ownership line, so they stay unpainted rather than guessing.
  const state = r => {
    const pid = r.pid ? String(r.pid) : null;
    if (!pid || !owned)   return 'unk';
    if (mine && mine.has(pid)) return 'mine';
    return owned.has(pid) ? 'taken' : 'fa';
  };

  let faCount = 0;
  for (const r of ranks) if (state(r) === 'fa') faCount++;

  const leagueSel = `<select onchange="wvSetGridLeague(this.value)" style="max-width:280px;">
      ${leagues.map(lg => `<option value="${esc(lg.league_id)}" ${lg.league_id === lgId ? 'selected' : ''}>${esc(lg.name || lg.league_id)}${lg.source === 'espn' ? ' (ESPN)' : ''}</option>`).join('')}
    </select>`;

  const note = !owned
    ? `<span style="font-size:0.6rem;color:var(--c-red);">rosters didn't load for this league — nothing highlighted</span>` : '';

  const controls = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
      <span style="font-size:0.65rem;color:var(--brown-light);">League:</span>${leagueSel}
      <button class="ghost-btn rg-pill ${WV.gridFaOnly ? 'on' : ''}" style="font-size:0.64rem;" onclick="wvToggleFaOnly()">◎ Free agents only</button>
      <span style="font-size:0.6rem;color:var(--gold-light);">${faCount} ranked free agent${faCount === 1 ? '' : 's'}</span>
      ${note}
      <span style="flex:1;"></span>
      <span class="rg-legend">
        <span><i class="rg-sw-on"></i>my roster</span>
        <span><i class="rg-sw-fa"></i>free agent</span>
        <span><i class="rg-sw-plain"></i>rostered elsewhere</span>
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
  const view = wvView();
  if (view === 'ranks') return wvRanksHtml();
  if (view === 'trending') return wvTrendHtml();
  if (!WV.rows.length) return `<div class="empty-state"><p>No available players found above value threshold (100)</p></div>`;
  if (!['name','pos','adjVal','availCount','seasonPpg','weekProj'].includes(WV.sortCol)) { WV.sortCol = 'adjVal'; WV.sortDir = -1; }

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
  const numCell = (v, tip) => `<td style="font-family:var(--font-head),serif;color:var(--cream);"${tip ? ` title="${esc(tip)}"` : ''}>${v != null ? v.toFixed(1) : dash}</td>`;
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
    const teamHtml = `<span style="font-family:var(--font-display),serif;font-size:0.61rem;letter-spacing:0.1em;color:var(--brown-light);margin-left:5px;">${esc(row.team)}</span>`;
    const nameCell = `<button class="rs-name-btn${isExp?' rs-expanded':''}" onclick="wvToggle('${esc(row.pid)}')">${esc(row.name)}${teamHtml} <span class="rs-chevron">▾</span></button>`;

    const valCell = isDyn
      ? `<td style="font-family:var(--font-head),serif;color:var(--cream);">${row.adjVal}${row.pos==='TE'?`<span style="font-size:0.75rem;color:var(--brown-light);margin-left:3px;">(${row.fcVal}×2)</span>`:''}</td>`
      : `<td style="font-family:var(--font-head),serif;color:var(--cream);">#${row.rank}</td>`;

    const mainRow = isDyn
      ? `<tr><td>${nameCell}</td><td>${posHtml}</td>${valCell}<td style="font-family:var(--font-head),serif;color:var(--cream);">${row.availCount}</td>${projCell(row)}</tr>`
      : `<tr><td style="font-family:var(--font-head),serif;color:var(--cream);">#${row.rank}</td><td>${nameCell}</td><td>${posHtml}</td><td style="font-family:var(--font-head),serif;color:var(--cream);">${row.availCount}</td>${projCell(row)}</tr>`;

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
    WV.sortDir = (col === 'trendRank' || col === 'rank' || col === 'posRank' || col === 'tier' || col === 'name' || col === 'pos' || col === 'team') ? 1 : -1;
  }
  wvRedrawBody();
}

function wvToggle(pid) {
  WV.expandedKey = WV.expandedKey === pid ? null : pid;
  wvRedrawBody();
}

function wvSetMode(mode) {
  if (WV.mode === mode) return;
  WV.mode    = mode;
  WV.loaded  = false;
  WV.loading = false;
  WV.loadSeq = (WV.loadSeq || 0) + 1;   // orphan any load still running for the old mode
  WV.rows    = [];
  WV.expandedKey = null;
  wvSavePrefs();
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
  // Read when present, all optional — they only decorate the grid.
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

  const R = wvRanks();
  Object.assign(R, { rows: rankings, unmatched, label: file.name });
  wvRedrawSource();
  wvRedrawBody();
}
