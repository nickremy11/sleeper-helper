// Rostership tab

// ── 7. Rostership ─────────────────────────────────────────────────────────────

async function renderRostership() {
  // First visit: init league selection and load prefs
  if (RS.selectedLeagues === null) {
    RS.selectedLeagues = new Set(S.leagues.map(lg => lg.league_id));
    await rsLoadPrefs();
  }
  rsDrawFull();
}

async function rsLoadPrefs() {
  const stored = await loadStoredLeaguePrefs(S.auth);
  // Kept so ESPN leagues, which finish loading after this runs, can pick up
  // their Root For Me tags (keyed espn_{id}) instead of defaulting to null.
  RS._storedPrefs = stored;
  RS.prefs = {};
  for (const lg of S.leagues) RS.prefs[lg.league_id] = stored[lg.league_id] ?? null;
}

// Full re-draw of the tab (called on tab enter, or after league list changes)
function rsDrawFull() {
  const hasPrefs = S.leagues.some(lg => RS.prefs[lg.league_id] !== null);
  const nSel     = RS.selectedLeagues.size;
  const nflSeason = S.nflState?.season || new Date().getFullYear().toString();

  const lgRows = S.leagues.map(lg => {
    const d    = S.leagueDetails[lg.league_id] || lg;
    const isBB = d.settings?.best_ball === 1;
    const isEspn = lg.source === 'espn';
    const type = leagueFormatLabel({ ...d, source: lg.source });
    const sz   = d.total_rosters || lg.total_rosters || '?';
    const chk  = RS.selectedLeagues.has(lg.league_id) ? 'checked' : '';
    const srcBadge = isEspn ? ' <span style="font-size:0.65rem;color:var(--gold);opacity:0.8;font-family:monospace;letter-spacing:0.02em;">ESPN</span>' : '';
    return `<label class="rs-lg-item">
      <span class="rs-lg-name">${esc(lg.name || 'Unnamed')}${srcBadge}</span>
      <span class="rs-lg-meta">${esc(type)} · ${sz}</span>
      <input type="checkbox" style="width:15px;height:15px;accent-color:var(--gold);flex-shrink:0;cursor:pointer;"
        ${chk} onchange="rsToggleLeague('${lg.league_id}',this.checked)" />
    </label>`;
  }).join('');

  const filterHtml = RS.loaded ? `
    <div class="rs-filter-panel">
      <div class="filter-group-rs">
        <span class="filter-lbl-rs">Position</span>
        <div style="display:flex;gap:4px;flex-wrap:wrap;" id="rs-pos-chips">
          ${['QB','RB','WR','TE','DL','LB','DB','PICK'].map(p =>
            `<button class="pos-pill${RS.filtPositions.has(p)?' active':''}" onclick="rsTogglePos('${p}')">${p}</button>`
          ).join('')}
        </div>
      </div>
      <div class="filter-group-rs">
        <span class="filter-lbl-rs">Experience (yrs)</span>
        <div style="display:flex;gap:4px;align-items:center;">
          <select class="tracker-select" id="rs-exp-op" onchange="rsReadFilters()"
            style="padding:5px 24px 5px 6px;min-width:0;width:58px;">
            <option value="">Any</option>
            <option value="="  ${RS.filtExp.op==='=' ?'selected':''}>＝</option>
            <option value=">"  ${RS.filtExp.op==='>' ?'selected':''}>＞</option>
            <option value="<"  ${RS.filtExp.op==='<' ?'selected':''}>＜</option>
            <option value=">=" ${RS.filtExp.op==='>='?'selected':''}>≥</option>
            <option value="<=" ${RS.filtExp.op==='<='?'selected':''}>≤</option>
          </select>
          <input type="number" min="0" step="1" class="tracker-select" id="rs-exp-val"
            value="${esc(RS.filtExp.val)}" placeholder="0"
            oninput="rsReadFilters()" style="width:58px;padding:5px 6px;" />
        </div>
      </div>
      <div class="filter-group-rs">
        <span class="filter-lbl-rs">FC Value</span>
        <div style="display:flex;gap:4px;align-items:center;">
          <select class="tracker-select" id="rs-val-op" onchange="rsReadFilters()"
            style="padding:5px 24px 5px 6px;min-width:0;width:58px;">
            <option value="">Any</option>
            <option value="="  ${RS.filtFCVal.op==='=' ?'selected':''}>＝</option>
            <option value=">"  ${RS.filtFCVal.op==='>' ?'selected':''}>＞</option>
            <option value="<"  ${RS.filtFCVal.op==='<' ?'selected':''}>＜</option>
            <option value=">=" ${RS.filtFCVal.op==='>='?'selected':''}>≥</option>
            <option value="<=" ${RS.filtFCVal.op==='<='?'selected':''}>≤</option>
          </select>
          <input type="number" min="0" step="100" class="tracker-select" id="rs-val-val"
            value="${esc(RS.filtFCVal.val)}" placeholder="value"
            oninput="rsReadFilters()" style="width:76px;padding:5px 6px;" />
        </div>
      </div>
      <div class="filter-group-rs">
        <span class="filter-lbl-rs">NFL Team</span>
        <select class="tracker-select" id="rs-team" onchange="rsReadFilters()">
          <option value="">All</option>
          ${[...RS._teams].sort().map(t => `<option value="${esc(t)}"${RS.filtTeam===t?' selected':''}>${esc(t)}</option>`).join('')}
        </select>
      </div>
      <div class="filter-group-rs">
        <span class="filter-lbl-rs">League Size</span>
        <select class="tracker-select" id="rs-size" onchange="rsReadFilters()">
          <option value="">Any</option>
          ${[...RS._sizes].sort((a,b)=>a-b).map(s => `<option value="${s}"${RS.filtSize===String(s)?' selected':''}>${s} teams</option>`).join('')}
        </select>
      </div>
      <div class="filter-group-rs">
        <span class="filter-lbl-rs">Lineup Type</span>
        <div style="display:flex;gap:4px;">
          <button class="pos-pill${RS.filtType==='all'      ?' active':''}" onclick="rsSetType('all')">All</button>
          <button class="pos-pill${RS.filtType==='bestball' ?' active':''}" onclick="rsSetType('bestball')">Best Ball</button>
          <button class="pos-pill${RS.filtType==='lineup'   ?' active':''}" onclick="rsSetType('lineup')">Lineup</button>
        </div>
      </div>
      <div class="filter-group-rs">
        <span class="filter-lbl-rs">League Role</span>
        <div style="display:flex;gap:4px;">
          <button class="pos-pill${RS.filtContReb==='all'       ?' active':''}" onclick="rsSetContReb('all')">All</button>
          <button class="pos-pill${RS.filtContReb==='contender' ?' active':''}" onclick="rsSetContReb('contender')" ${hasPrefs?'':'disabled title="Fill out Root For Me first"'}>Contenders</button>
          <button class="pos-pill${RS.filtContReb==='rebuilder' ?' active':''}" onclick="rsSetContReb('rebuilder')"  ${hasPrefs?'':'disabled title="Fill out Root For Me first"'}>Rebuilders</button>
        </div>
      </div>
    </div>` : '';

  setC(`<div>
    <div class="rs-lg-panel">
      <div class="rs-lg-header">
        <span class="rs-lg-title">Leagues</span>
        <span style="font-family:'Crimson Text',serif;font-size:0.85rem;font-style:italic;color:var(--brown-light);" id="rs-lg-info">${nSel}/${S.leagues.length} selected</span>
        <button class="ghost-btn" onclick="rsSelectAll()">All</button>
        <button class="ghost-btn" onclick="rsDeselectAll()">None</button>
        <button class="ghost-btn" onclick="rsSelectRedraft()">Redraft</button>
        <button class="ghost-btn" onclick="rsSelectDynasty()">Dynasty</button>
        <button class="ghost-btn" id="rs-btn-cont" ${hasPrefs?'':'disabled title="Fill out Root For Me first"'} onclick="rsSelectContenders()">Contenders</button>
        <button class="ghost-btn" id="rs-btn-reb" ${hasPrefs?'':'disabled title="Fill out Root For Me first"'} onclick="rsSelectRebuilders()">Rebuilders</button>
        <div style="flex:1;"></div>
        <button class="setup-btn" id="rs-load-btn" onclick="loadRostershipData()" style="height:32px;">${RS.loaded?'Reload':'Load Rostership'}</button>
        <span class="setup-status" id="rs-load-status" style="margin:0;"></span>
      </div>
      <div class="rs-lg-list">${lgRows}</div>
    </div>

    ${RS.loaded ? `
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;">
      <input type="text" class="search-input" id="rs-search"
        placeholder="Search player, pick, team…" oninput="rsOnSearch()" value="${esc(RS.search)}" />
    </div>` : ''}

    ${filterHtml}

    ${RS.loaded ? `
    <div class="setup-status" id="rs-result-meta" style="margin-bottom:8px;font-style:italic;min-height:18px;"></div>
    <div style="overflow-x:auto;">
      <table class="rs-table">
        <thead id="rs-thead"></thead>
        <tbody id="rs-tbody"><tr><td colspan="7" style="padding:20px;text-align:center;font-style:italic;color:var(--brown-light);">Computing…</td></tr></tbody>
      </table>
    </div>` : `<div class="empty-state"><p>Select leagues above and click Load Rostership</p></div>`}
  </div>`);

  if (RS.loaded) rsUpdateTable();
}

// ── Load all roster + draft data ──────────────────────────────────────────────
async function loadRostershipData() {
  const btn    = document.getElementById('rs-load-btn');
  const statEl = document.getElementById('rs-load-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
  if (statEl) statEl.textContent = '';

  try {
    // Players (reuse S.players if already loaded)
    if (statEl) statEl.textContent = 'Loading players…';
    await loadPlayers();

    // FantasyCalc values
    if (statEl) statEl.textContent = 'Loading FC values…';
    try {
      const fc = await fetch('/api/fantasycalc').then(r => r.ok ? r.json() : []);
      RS.fcMap = {};
      for (const item of (Array.isArray(fc) ? fc : [])) {
        const sid = item.player?.sleeperId || item.player?.maybeSleeperID;
        if (sid) RS.fcMap[String(sid)] = item.value ?? 0;
      }
    } catch { RS.fcMap = {}; }

    // Rosters + draft info per league (parallel)
    if (statEl) statEl.textContent = `Fetching ${S.leagues.length} leagues…`;
    await Promise.all(S.leagues.map(lg => lg.source === 'espn' ? rsLoadEspnLeague(lg) : rsLoadLeague(lg)));

    // Build rows
    RS.loaded = true;
    rsBuildRows();
    rsPopulateFilterMeta();
    rsDrawFull();           // full redraw now that RS.loaded = true
  } catch (e) {
    if (statEl) statEl.textContent = 'Error: ' + e.message;
  } finally {
    const b = document.getElementById('rs-load-btn');
    if (b) { b.disabled = false; b.textContent = RS.loaded ? 'Reload' : 'Load Rostership'; }
  }
}


async function rsLoadEspnLeague(lg) {
  const leagueId = S.leagueDetails[lg.league_id]?._espnId;
  const season   = S.nflState?.season || new Date().getFullYear().toString();
  RS.leagueDraftInfo[lg.league_id] = { ridToSlot: null, tradedPicks: [] };
  try {
    const r = await fetch(`/api/espn/fantasy/${leagueId}?view=mRoster&view=mTeam&seasonId=${season}`, { credentials: 'include' });
    if (!r.ok) { RS.leagueRosters[lg.league_id] = []; return; }
    const d      = await r.json();
    const mySWID = S.espnSettings?.swid || '';
    const myTeam = espnMyTeam(d.teams, mySWID);
    if (!myTeam) { RS.leagueRosters[lg.league_id] = []; return; }
    RS.leagueRosters[lg.league_id] = [{ _isEspn: true, _espnEntries: myTeam.roster?.entries || [] }];
  } catch { RS.leagueRosters[lg.league_id] = []; }
}

async function rsLoadLeague(lg) {
  // Rosters
  try {
    const r = await fetch(`/api/sleeper/league/${lg.league_id}/rosters`);
    RS.leagueRosters[lg.league_id] = r.ok ? await r.json() : [];
  } catch { RS.leagueRosters[lg.league_id] = []; }

  // Drafts + traded_picks in parallel
  // - drafts: for slot_to_roster_id → reverse to ridToSlot (labels 1.01, 1.02…)
  // - traded_picks: authoritative source for CURRENT pick ownership
  try {
    const nflSeason = S.nflState?.season || new Date().getFullYear().toString();
    const [draftsRes, tradedRes] = await Promise.all([
      fetch(`/api/sleeper/league/${lg.league_id}/drafts`),
      fetch(`/api/sleeper/league/${lg.league_id}/traded_picks`),
    ]);

    const drafts      = draftsRes.ok  ? (await draftsRes.json()  || []) : [];
    const tradedPicks = tradedRes.ok  ? (await tradedRes.json()  || []) : [];

    // slot resolution: slot_to_roster_id maps draft slot# → roster_id
    // reversed: roster_id → slot# so we can label picks as "2025 1.03"
    const curDraft  = drafts.find(d => d.season === nflSeason);
    const rawSlots  = curDraft?.slot_to_roster_id;
    const hasSlots  = rawSlots && Object.keys(rawSlots).length > 0;
    let ridToSlot = null;
    if (hasSlots) {
      ridToSlot = {};
      for (const [slot, rid] of Object.entries(rawSlots)) {
        ridToSlot[String(rid)] = parseInt(slot);
      }
    }

    RS.leagueDraftInfo[lg.league_id] = {
      ridToSlot,
      draftStatus: curDraft?.status,
      tradedPicks,     // store for ownedPicks()
    };
  } catch {
    RS.leagueDraftInfo[lg.league_id] = { ridToSlot: null, tradedPicks: [] };
  }
}

// Compute which picks a roster owns for the current + upcoming seasons.
// Sleeper's traded_picks contains every pick that changed hands; owner_id = current holder.
// Picks never traded are still with the original team (roster_id = owner by default).
// We build base ownership (each team owns their own), apply traded_pick overrides,
// then return entries where owner === myRosterId.
// ── Build rows from cached data ────────────────────────────────────────────────
function rsBuildRows() {
  const playerMap = {};  // pid → row
  const pickMap   = {};  // pickKey → row
  const nflSeason = S.nflState?.season || new Date().getFullYear().toString();

  for (const lg of S.leagues) {
    const rosters  = RS.leagueRosters[lg.league_id] || [];
    const myRoster = lg.source === 'espn'
      ? rosters[0]   // already filtered to user's team in rsLoadEspnLeague
      : rosters.find(r => r.owner_id === S.userId);
    if (!myRoster) continue;

    // ── Players ────────────────────────────────────────────────────────────────
    if (myRoster._isEspn) {
      // ESPN league: resolve players by name lookup into Sleeper player data
      for (const entry of (myRoster._espnEntries || [])) {
        const pData    = entry.playerPoolEntry?.playerPoolEntry?.player || entry.playerPoolEntry?.player;
        if (!pData) continue;
        const fullName = pData.fullName || `${pData.firstName || ''} ${pData.lastName || ''}`.trim();
        const espnPos  = ESPN_POS_MAP[pData.defaultPositionId];
        if (!espnPos) continue;  // K, OL, etc.
        const pos = crNormPos(espnPos);
        if (!pos) continue;

        const sleeperPid = S._playersByName[normName(fullName)];
        const sleeperP   = sleeperPid ? S.players[sleeperPid] : null;
        const rowKey     = sleeperPid || `espn_name_${fullName}`;
        const teamAbbr   = sleeperP?.team || ESPN_TEAM_MAP[pData.proTeamId] || 'FA';
        const exp        = sleeperP?.years_exp ?? null;
        const fcVal      = sleeperPid && RS.fcMap[sleeperPid] != null ? RS.fcMap[sleeperPid] : null;

        if (!playerMap[rowKey]) {
          playerMap[rowKey] = {
            key:       rowKey,
            name:      sleeperP?.full_name || fullName,
            pos:       sleeperP ? crNormPos(sleeperP.position) || pos : pos,
            team:      teamAbbr,
            exp,
            leagueSet: new Set(),
            fcVal,
            isPick:    false,
          };
        }
        playerMap[rowKey].leagueSet.add(lg.league_id);
      }
    } else {
    for (const pid of (myRoster.players || [])) {
      const player = S.players[pid];
      if (!player) continue;
      const pos = crNormPos(player.position);
      if (!pos) continue;                      // drop K, DEF, P, etc.

      if (!playerMap[pid]) {
        playerMap[pid] = {
          key:       pid,
          name:      player.full_name || player.last_name || pid,
          pos,
          team:      player.team || 'FA',
          exp:       player.years_exp ?? null,
          leagueSet: new Set(),
          fcVal:     RS.fcMap[pid] != null ? RS.fcMap[pid] : null,
          isPick:    false,
        };
      }
      playerMap[pid].leagueSet.add(lg.league_id);
    }
    }

    // ── Draft picks (1sts & 2nds only — Sleeper only, ESPN redraft has none) ────
    if (lg.source === 'espn') continue;
    // Derived from traded_picks, which is more reliable than roster.draft_picks
    // (often null/empty). Current-year picks are left out: those drafts are mostly done.
    const { tradedPicks: lgTradedPicks } = RS.leagueDraftInfo[lg.league_id] || {};
    const myPicks = ownedPicks({
      rosterId: myRoster.roster_id, rosters, tradedPicks: lgTradedPicks || [],
      firstSeason: parseInt(nflSeason) + 1, rounds: 2,
    });

    for (const pick of myPicks) {
      const { round, season } = pick;
      const pickKey = `${season} ${round === 1 ? '1st' : '2nd'}`;

      if (!pickMap[pickKey]) {
        pickMap[pickKey] = {
          key:          pickKey,
          name:         pickKey,
          pos:          'PICK',
          team:         '—',
          exp:          null,
          leagueCounts: {},   // lgId → count (>1 when holding multiple picks of same type)
          fcVal:        null,
          isPick:       true,
          season,
          round,
        };
      }
      pickMap[pickKey].leagueCounts[lg.league_id] =
        (pickMap[pickKey].leagueCounts[lg.league_id] || 0) + 1;
    }
  }

  RS.allRows = [...Object.values(playerMap), ...Object.values(pickMap)];
}

function rsPopulateFilterMeta() {
  RS._teams = new Set();
  RS._sizes = new Set();
  for (const row of RS.allRows) {
    if (row.team && row.team !== '—' && row.team !== 'FA') RS._teams.add(row.team);
  }
  for (const lg of S.leagues) {
    const d = S.leagueDetails[lg.league_id] || lg;
    const sz = d.total_rosters || lg.total_rosters;
    if (sz) RS._sizes.add(sz);
  }
}

// ── Per-row stats (selection + filter aware) ──────────────────────────────────
function rsRowStats(row) {
  const sizeFilter = RS.filtSize ? parseInt(RS.filtSize) : null;
  let shares = 0, total = 0;

  for (const lgId of RS.selectedLeagues) {
    const d     = S.leagueDetails[lgId] || S.leagues.find(l => l.league_id === lgId);
    const isBB  = d?.settings?.best_ball === 1;
    const ltype = isBB ? 'bestball' : 'lineup';
    const lsize = d?.total_rosters || 0;

    if (sizeFilter && lsize !== sizeFilter)           continue;
    if (RS.filtType !== 'all' && ltype !== RS.filtType) continue;
    if (RS.filtContReb !== 'all') {
      const pref = RS.prefs[lgId];
      if (RS.filtContReb === 'contender' && pref?.contender !== true) continue;
      if (RS.filtContReb === 'rebuilder' && !(pref !== null && pref?.contender === false)) continue;
    }

    total++;
    if (row.isPick) shares += (row.leagueCounts[lgId] || 0);
    else if (row.leagueSet.has(lgId)) shares++;
  }

  const pct = total > 0 ? (shares / total) * 100 : 0;
  return { shares, pct, total };
}

// ── Compute visible + sorted rows ─────────────────────────────────────────────
function rsComputeVisible() {
  const q = RS.search.toLowerCase();

  const visible = RS.allRows
    .filter(row => {
      if (!RS.filtPositions.has(row.pos)) return false;
      if (RS.filtTeam && row.team !== RS.filtTeam) return false;
      if (!row.isPick) {
        if (!rsCmp(row.exp,   RS.filtExp.op,   RS.filtExp.val))   return false;
        if (!rsCmp(row.fcVal, RS.filtFCVal.op, RS.filtFCVal.val)) return false;
      } else {
        // Picks have no exp; skip exp filter; skip fcVal filter
        if (RS.filtExp.op && RS.filtExp.val !== '') return false;
      }
      if (q && !row.name.toLowerCase().includes(q) && !row.team.toLowerCase().includes(q)) return false;
      const { shares } = rsRowStats(row);
      return shares > 0;
    })
    .map(row => { const { shares, pct } = rsRowStats(row); return { ...row, shares, pct }; });

  visible.sort((a, b) => {
    switch (RS.sortCol) {
      case 'name':   return RS.sortDir * a.name.localeCompare(b.name);
      case 'pos':    return RS.sortDir * a.pos.localeCompare(b.pos);
      case 'team':   return RS.sortDir * a.team.localeCompare(b.team);
      case 'shares': return RS.sortDir * (b.shares - a.shares);
      case 'pct':    return RS.sortDir * (b.pct - a.pct);
      case 'value':  return RS.sortDir * ((b.fcVal ?? -1) - (a.fcVal ?? -1));
      case 'exp':    return RS.sortDir * ((a.exp ?? -1) - (b.exp ?? -1));
      default: return 0;
    }
  });

  return visible;
}

// ── Update table only (fast — no full redraw) ─────────────────────────────────
function rsUpdateTable() {
  const visible = rsComputeVisible();
  const thead   = document.getElementById('rs-thead');
  const tbody   = document.getElementById('rs-tbody');
  const meta    = document.getElementById('rs-result-meta');
  if (!thead || !tbody) return;

  // Header
  const cols = [
    { key: 'name',   lbl: 'Player'       },
    { key: 'pos',    lbl: 'Pos'          },
    { key: 'team',   lbl: 'Team'         },
    { key: 'exp',    lbl: 'Exp'          },
    { key: 'shares', lbl: '# Shares'     },
    { key: 'pct',    lbl: 'Rostership %' },
    { key: 'value',  lbl: 'FC Value'     },
  ];
  thead.innerHTML = `<tr>${cols.map(c => {
    const sorted = RS.sortCol === c.key;
    const arr    = sorted ? (RS.sortDir === -1 ? '▼' : '▲') : '·';
    return `<th class="${sorted?'rs-sorted':''}" onclick="rsSort('${c.key}')">${c.lbl}<span class="rs-arr">${arr}</span></th>`;
  }).join('')}</tr>`;

  // Body
  if (!visible.length) {
    tbody.innerHTML = '<tr><td colspan="7"><div class="empty-state" style="margin:12px;"><p>No players match current filters</p></div></td></tr>';
    if (meta) meta.textContent = '0 results';
    return;
  }

  const maxPct = Math.max(100, ...visible.map(r => r.pct));

  tbody.innerHTML = visible.map(row => {
    const barW     = Math.min((row.pct / maxPct) * 100, 100).toFixed(1);
    const pctStr   = row.pct < 1 ? row.pct.toFixed(1) : row.pct.toFixed(row.pct >= 100 ? 0 : 1);
    const valStr   = row.fcVal != null ? Number(row.fcVal).toLocaleString() : '—';
    const expStr   = row.exp == null ? '—' : row.exp === 0 ? 'R' : `Y${row.exp}`;
    const isExpanded = RS.expandedKey === row.key;
    const safeKey  = esc(row.key);

    // Build expansion row (league list) if this row is expanded
    let expandHtml = '';
    if (isExpanded) {
      const leagueIds = row.isPick
        ? Object.keys(row.leagueCounts)
        : [...row.leagueSet];

      const tags = leagueIds.map(lgId => {
        const lg  = S.leagues.find(l => l.league_id === lgId);
        if (!lg) return '';
        const d   = S.leagueDetails[lgId] || lg;
        const isEspn = lg.source === 'espn';
        const isBB = d.settings?.best_ball === 1;
        const type = !isEspn && isBB ? 'Bestball' : leagueFormatLabel({ ...d, source: lg.source });
        const sz  = d.total_rosters || lg.total_rosters || '?';
        const cnt = row.isPick && row.leagueCounts[lgId] > 1
          ? ` ×${row.leagueCounts[lgId]}` : '';
        const espnTag = isEspn ? ' ESPN' : '';
        return `<span class="rs-expand-tag">${esc(lg.name || 'Unnamed')}<span class="rs-tag-meta">${esc(type)}${espnTag} · ${sz}${cnt}</span></span>`;
      }).filter(Boolean).join('');

      const label = row.isPick ? 'Leagues holding this pick' : 'Leagues with this player';
      expandHtml = `<tr class="rs-expand-row">
        <td colspan="7"><div class="rs-expand-inner">
          <div class="rs-expand-title">${label}</div>
          <div class="rs-expand-leagues">${tags || '<span style="font-style:italic;color:var(--brown-light);font-size:0.85rem;">None</span>'}</div>
        </div></td>
      </tr>`;
    }

    return `<tr style="${isExpanded ? 'background:rgba(201,150,42,0.06);' : ''}">
      <td><button class="rs-name-btn${isExpanded?' rs-expanded':''}" onclick="rsToggleExpand('${safeKey}')">
        ${esc(row.name)}<span class="rs-chevron">▾</span>
      </button></td>
      <td><span class="rs-pos rs-pos-${row.pos}">${row.pos}</span></td>
      <td style="font-family:'Crimson Text',serif;font-size:0.88rem;font-weight:600;letter-spacing:0.04em;color:var(--parchment);">${row.team !== '—' ? esc(row.team) : '—'}</td>
      <td style="font-family:'Crimson Text',serif;font-size:0.88rem;font-style:italic;color:var(--brown-light);">${expStr}</td>
      <td style="font-family:'Playfair Display',serif;color:var(--cream);">${row.shares}</td>
      <td><div class="rs-pct-wrap">
        <div class="rs-pct-bar"><div class="rs-pct-fill" style="width:${barW}%"></div></div>
        <span class="rs-pct-txt">${pctStr}%</span>
      </div></td>
      <td style="font-family:'Playfair Display',serif;color:var(--cream);">${valStr}</td>
    </tr>${expandHtml}`;
  }).join('');

  if (meta) meta.textContent = `${visible.length} result${visible.length!==1?'s':''} · ${RS.selectedLeagues.size} league${RS.selectedLeagues.size!==1?'s':''} selected`;
}

// ── Expand / collapse player row ─────────────────────────────────────────────
function rsToggleExpand(key) {
  RS.expandedKey = RS.expandedKey === key ? null : key;
  rsUpdateTable();
}

// ── League selector actions ───────────────────────────────────────────────────
function rsToggleLeague(lgId, checked) {
  if (checked) RS.selectedLeagues.add(lgId);
  else         RS.selectedLeagues.delete(lgId);
  const el = document.getElementById('rs-lg-info');
  if (el) el.textContent = `${RS.selectedLeagues.size}/${S.leagues.length} selected`;
  if (RS.loaded) rsUpdateTable();
}
function rsLeagueCategory(lgId) {
  return leagueIsDynasty(S.leagueDetails[lgId] || S.leagues.find(l => l.league_id === lgId)) ? 'dynasty' : 'redraft';
}

function rsSelectAll()    { S.leagues.forEach(l => RS.selectedLeagues.add(l.league_id));  rsSyncSelector(); }
function rsDeselectAll()  { RS.selectedLeagues.clear(); rsSyncSelector(); }
function rsSelectRedraft() {
  RS.selectedLeagues.clear();
  for (const lg of S.leagues) if (rsLeagueCategory(lg.league_id) === 'redraft') RS.selectedLeagues.add(lg.league_id);
  rsSyncSelector();
}
function rsSelectDynasty() {
  RS.selectedLeagues.clear();
  for (const lg of S.leagues) if (rsLeagueCategory(lg.league_id) === 'dynasty') RS.selectedLeagues.add(lg.league_id);
  rsSyncSelector();
}
function rsSelectContenders() {
  RS.selectedLeagues.clear();
  for (const lg of S.leagues) if (RS.prefs[lg.league_id]?.contender) RS.selectedLeagues.add(lg.league_id);
  rsSyncSelector();
}
function rsSelectRebuilders() {
  RS.selectedLeagues.clear();
  for (const lg of S.leagues) {
    const p = RS.prefs[lg.league_id];
    if (p !== null && p?.contender === false) RS.selectedLeagues.add(lg.league_id);
  }
  rsSyncSelector();
}
function rsSyncSelector() {
  // Update checkboxes + count without full redraw
  document.querySelectorAll('.rs-lg-list input[type=checkbox]').forEach((cb, i) => {
    if (S.leagues[i]) cb.checked = RS.selectedLeagues.has(S.leagues[i].league_id);
  });
  const el = document.getElementById('rs-lg-info');
  if (el) el.textContent = `${RS.selectedLeagues.size}/${S.leagues.length} selected`;
  if (RS.loaded) rsUpdateTable();
}

// ── Filter actions ────────────────────────────────────────────────────────────
function rsTogglePos(pos) {
  if (RS.filtPositions.has(pos)) {
    if (RS.filtPositions.size === 1) return;
    RS.filtPositions.delete(pos);
  } else {
    RS.filtPositions.add(pos);
  }
  document.querySelectorAll('#rs-pos-chips .pos-pill').forEach(btn => {
    btn.classList.toggle('active', RS.filtPositions.has(btn.textContent.trim()));
  });
  rsUpdateTable();
}
function rsSetType(type) {
  RS.filtType = type;
  document.querySelectorAll('.rs-type-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === type);
  });
  // Re-render type pills properly via direct DOM
  const pills = document.querySelectorAll('[onclick^="rsSetType"]');
  pills.forEach(b => {
    const t = b.getAttribute('onclick').match(/'(\w+)'/)?.[1];
    if (t) b.classList.toggle('active', t === type);
  });
  rsUpdateTable();
}
function rsSetContReb(val) {
  RS.filtContReb = val;
  document.querySelectorAll('[onclick^="rsSetContReb"]').forEach(b => {
    const v = b.getAttribute('onclick').match(/'(\w+)'/)?.[1];
    if (v) b.classList.toggle('active', v === val);
  });
  rsUpdateTable();
}
function rsReadFilters() {
  const get = id => document.getElementById(id);
  RS.filtExp   = { op: get('rs-exp-op')?.value || '', val: get('rs-exp-val')?.value || '' };
  RS.filtFCVal = { op: get('rs-val-op')?.value || '', val: get('rs-val-val')?.value || '' };
  RS.filtTeam  = get('rs-team')?.value || '';
  RS.filtSize  = get('rs-size')?.value || '';
  rsUpdateTable();
}
function rsOnSearch() {
  RS.search = document.getElementById('rs-search')?.value.trim() || '';
  rsUpdateTable();
}
function rsSort(col) {
  RS.sortDir = RS.sortCol === col ? RS.sortDir * -1 : (['name','pos','team'].includes(col) ? 1 : -1);
  RS.sortCol = col;
  rsUpdateTable();
}

document.getElementById('token-input').addEventListener('keydown', e => { if (e.key==='Enter') saveToken(); });
