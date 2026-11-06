// Draft Queue and Draft Tracker tabs

// ── 5. Draft Queue ────────────────────────────────────────────────────────────
async function renderDraftQueue(isRefresh = false) {
  if (!isRefresh) {
    setC(`<div>
      <div class="tab-header">
        <div class="section-head" style="margin-bottom:0;flex:1;"><h2>Active Drafts</h2><div class="section-head-line"></div></div>
        <button class="ghost-btn" style="margin-left:16px;" onclick="renderDraftQueue(true)">↻ Refresh</button>
      </div>
      <div id="draft-body">${loading('Loading active drafts')}</div>
    </div>`);
  } else {
    const b = document.getElementById('draft-body');
    if (b) b.innerHTML = loading('Refreshing');
  }
  try {
    const draftIds = new Set();
    await Promise.all(S.leagues.map(async lg => {
      try {
        let d = S.leagueDetails[lg.league_id];
        if (!d) { d = await api('/league/' + lg.league_id); S.leagueDetails[lg.league_id] = d; }
        if (d?.draft_id) draftIds.add(d.draft_id);
        // Also fetch all drafts for the league to catch any active draft not linked via draft_id
        const allLgDrafts = await api('/league/' + lg.league_id + '/drafts').catch(() => null);
        (allLgDrafts || []).forEach(dr => { if (dr?.draft_id) draftIds.add(dr.draft_id); });
      } catch(_) {}
    }));
    const allDrafts = await Promise.all([...draftIds].map(id => api('/draft/' + id).catch(() => null)));
    const active = allDrafts.filter(d => d?.status === 'drafting' || d?.status === 'paused');
    const target = document.getElementById('draft-body');
    if (!target) return;
    if (!active.length) { target.innerHTML = '<div class="empty-state"><p>No active drafts right now</p></div>'; return; }

    const details = await Promise.all(active.map(async d => {
      const [picks, tradedPicks] = await Promise.all([
        api('/draft/' + d.draft_id + '/picks'),
        api('/draft/' + d.draft_id + '/traded_picks'),
      ]);
      return { d, picks: picks || [], info: d, tradedPicks: tradedPicks || [] };
    }));

    const rIdByLeague = {};
    await Promise.all(details.map(async ({ info }) => {
      const lgId = info.league_id;
      if (!lgId || rIdByLeague[lgId] !== undefined) return;
      try {
        const rosters = await api('/league/' + lgId + '/rosters');
        rIdByLeague[lgId] = (rosters || []).find(r => r.owner_id === S.userId)?.roster_id ?? null;
      } catch(_) { rIdByLeague[lgId] = null; }
    }));

    target.innerHTML = `<div class="draft-grid">${details.map(({ d, picks, info, tradedPicks }) => {
      const teams = d.settings?.teams ?? 12, rounds = d.settings?.rounds ?? 5;
      const total = teams * rounds, done = picks.length;
      const pct = Math.round((done / total) * 100);
      const pos = picksUntilMyTurn(info, picks, tradedPicks, rIdByLeague[info.league_id] ?? null);
      let countHtml;
      if (pos === 0)       countHtml = `<div class="draft-count up">On The Clock</div><div class="card-meta">you're up now</div>`;
      else if (pos > 0)    countHtml = `<div style="display:flex;align-items:baseline;gap:8px;"><span class="draft-count">${pos}</span><span class="card-meta">pick${pos===1?'':'s'} until your turn</span></div>`;
      else                 countHtml = `<div class="card-meta">No more picks this draft</div>`;
      return `<div class="card">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;margin-bottom:14px;">
          <div>
            <a href="https://sleeper.com/draft/nfl/${esc(d.draft_id)}" target="_blank" class="card-link">${esc(d.metadata?.name || 'Draft')}</a>
            <div class="card-meta" style="margin-top:3px;">${teams} teams · ${rounds} rounds · ${esc(d.type||'snake')}</div>
          </div>
          <span class="badge ${d.status === 'paused' ? 'badge-yellow' : 'badge-green'}">${d.status === 'paused' ? 'Paused' : 'Live'}</span>
        </div>
        ${countHtml}
        <div style="margin-top:14px;">
          <div class="data-row"><span class="data-row-label">Picks made</span><span class="data-row-val">${done} / ${total}</span></div>
          <div class="data-row"><span class="data-row-label">Current round</span><span class="data-row-val">${Math.min(Math.floor(done/teams)+1,rounds)}</span></div>
        </div>
        <div class="draft-bar"><div class="draft-bar-fill" style="width:${pct}%"></div></div>
      </div>`;
    }).join('')}</div>`;
  } catch(e) {
    const t = document.getElementById('draft-body');
    if (t) t.innerHTML = errHtml(e);
  }
}

// Direction of a draft round, honoring Sleeper's reversal_round (3 = third-round reversal).
// Normal snake: even rounds reverse. With a reversal at round R, rounds < R snake normally,
// round R repeats round R-1's order, then snaking continues from there.
function isReversedRound(round, type, reversalRound) {
  if (type !== 'snake') return false;
  const R = reversalRound || 0;
  if (!R || round < R) return round % 2 === 0;
  const baseRev = (R - 1) % 2 === 0;                       // reversed state of round R-1
  return ((round - R) % 2 === 0) ? baseRev : !baseRev;
}

function picksUntilMyTurn(info, completedPicks, tradedPicks, myRosterId) {
  const teams = info?.settings?.teams ?? 12, rounds = info?.settings?.rounds ?? 5;
  const done = completedPicks.length, type = info?.type;
  const reversalRound = info?.settings?.reversal_round ?? 0;
  const slotToRoster = info?.slot_to_roster_id ?? {};
  const tradeMap = {};
  for (const tp of tradedPicks) tradeMap[`${tp.round}.${tp.roster_id}`] = tp.owner_id;
  for (let offset = 0; offset < teams * rounds; offset++) {
    const overall = done + offset;
    if (overall >= teams * rounds) break;
    const round = Math.floor(overall / teams) + 1;
    const pos   = overall % teams;
    const slot  = isReversedRound(round, type, reversalRound) ? teams - pos : pos + 1;
    const orig  = slotToRoster[slot] ?? slot;
    const owner = tradeMap[`${round}.${orig}`] ?? orig;
    if (owner === myRosterId) return offset;
  }
  return -1;
}

function leagueFlags(lg) {
  const sc = lg.scoring_settings||{}, st = lg.settings||{}, rp = lg.roster_positions||[];
  const flags = [];
  const numTeams = st.num_teams ?? 0;
  const starters = rp.filter(p => p !== 'BN' && p !== 'IR' && p !== 'TAXI').length;
  if (numTeams) flags.push(numTeams + 'x' + starters);
  const rec = sc.rec ?? 1;
  if (rec === 0) flags.push('Std');
  else if (rec < 1) flags.push(rec + 'PPR');
  if ((sc.bonus_rec_wr ?? 0) > 0) flags.push('+' + sc.bonus_rec_wr + 'WRP');
  if ((sc.bonus_rec_te ?? 0) > 0) flags.push('+' + sc.bonus_rec_te + 'TEP');
  if ((sc.rush_att ?? sc.rush_attempt ?? 0) > 0) flags.push('PPC');
  if ((sc.pass_td ?? 4) === 4) flags.push('4ptTD');
  if ((sc.kr_yd??0)>0||(sc.pr_yd??0)>0||(sc.kr_td??0)>0||(sc.pr_td??0)>0) flags.push('Ret');
  if (rp.filter(p => p === 'TE').length >= 2) flags.push('2xTE');
  return flags;
}

// Sleeper spells injury_status out in full ("Questionable", "Out", "PUP"), so the
// short codes alone matched almost nothing. Both spellings are accepted; anything
// that means "won't play" is red, anything in doubt is gold. Keep the red set in
// step with LU_BAD_INJ, which decides who the lineup tools refuse to start.
const INJ_BADGE = {
  // Q/D are red, not gold: a questionable starter is the thing most worth acting
  // on before kickoff, and gold read as decorative next to the red Out badge.
  // The letter still separates them — red Q is not red Out.
  Q: ['badge-red', 'Q'],   QUESTIONABLE: ['badge-red', 'Q'],
  D: ['badge-red', 'D'],   DOUBTFUL:     ['badge-red', 'D'],
  O: ['badge-red',  'Out'], OUT:          ['badge-red',  'Out'],
  IR:  ['badge-red', 'IR'],  PUP: ['badge-red', 'PUP'], SUS: ['badge-red', 'Sus'],
  NA:  ['badge-red', 'NA'],  COV: ['badge-red', 'COV'], DNR: ['badge-red', 'DNR'],
  DNP: ['badge-red', 'DNP'],
};
function injuryBadge(s) {
  const hit = INJ_BADGE[String(s || '').toUpperCase()];
  return hit ? `<span class="badge ${hit[0]}">${hit[1]}</span>` : '';
}

// ── 6. Draft Tracker ──────────────────────────────────────────────────────────
// State for tracker
const T = {
  rankings: [],       // [{rank, name, pos, team, sleeper_id, adp, tier}]
  picked: new Set(),  // sleeper_ids of picked players
  targets: new Set(), // sleeper_ids designated as targets (from CSV or click-to-toggle)
  draft: null,        // active draft object
  posFilter: 'ALL',   // position filter
  targetsOnly: false, // when true, show only targeted players
  pollTimer: null,
  myRanksSets: null,  // cached {primary, sets, sharedSets} from myranks API
  pickCount: 0,       // total picks made in the active draft
  tradedPicks: [],    // traded_picks for the active draft (Sleeper only — always [] for ESPN)
  myRosterId: null,   // this user's roster_id (Sleeper) or ESPN team id (ESPN) in the active draft's league
  espn: null,         // {id, pickOrder} — set only when T.draft._source === 'espn'; pickOrder is round-1 team-id order
  espnManualPicked: new Set(), // sleeper_ids manually marked drafted (see toggleEspnManualPick) — merged into T.picked on every ESPN sync
  reversalRound: 0,   // effective reversal round (0 = normal snake, 3 = 3RR) — toggleable
  view: 'board',      // 'board' | 'list'
  leagueAdp: null,    // {map: {sleeper_id: adp}, suffix, label, season} for the selected draft's own league format
  espnAdp: null,      // {map: {sleeper_id: adp}, count} — ESPN's own average draft position (ESPN drafts only)
  hideDrafted: false, // list view only: hide picked players instead of just crossing them off
  myProj: null,       // {map: {sleeper_id: ppg}, season} from the logged-in user's saved projections, if any
  myProjPresets: [],  // preset names available on the account (from projections.ffhistorian.com)
  myProjPreset: '',   // '' = default (whatever was active at last save); otherwise a preset name
  myProjSeason: null, // season used for the My Proj fetch, needed by the preset dropdown's onchange
};

function toggleHideDrafted() {
  T.hideDrafted = !T.hideDrafted;
  renderTrackerBody();
}

// Sleeper's own player projections payload (season-long, no week segment) carries
// per-format ADP fields keyed like "adp_std" / "adp_ppr" / "adp_dynasty_2qb" / etc.
// This mirrors the same suffix-picking logic Sleeper's own draft room uses
// (reverse-engineered from their web client bundle), but fixes a real bug there:
// their IDP roster-slot check compares e.g. "dl" against an object keyed "slots_dl"
// (never matches), so IDP leagues never actually get "idp"/"idp_1qb" client-side.
// Empirically (comparing real player order under each field): adp_idp skews
// QB-heavy (Superflex), adp_idp_1qb has no early QBs (1QB) — the reverse of what
// the names suggest, so that pairing below is trusting the data, not the naming.
function sleeperAdpSuffix(settings, scoring, rosterPositions) {
  const rp = rosterPositions || [];
  if (!settings || !rp.length) return 'std';
  const isDynasty = settings.type === 2;
  const isIdp = rp.some(p => p === 'DL' || p === 'LB' || p === 'DB' || p === 'IDP_FLEX');
  const qbSlots = rp.filter(p => p === 'QB' || p === 'SUPER_FLEX').length;
  const isSF = qbSlots >= 2;
  if (isIdp) return isSF ? 'idp' : 'idp_1qb';
  const rec = scoring?.rec ?? 0;
  let base = 'std';
  if (isSF) base = '2qb';
  else if (rec === 1) base = 'ppr';
  else if (rec === 0.5) base = 'half_ppr';
  return isDynasty ? `dynasty_${base}` : base;
}

const SLEEPER_ADP_LABELS = {
  std: 'Standard', ppr: 'PPR', half_ppr: 'Half-PPR', '2qb': 'Superflex',
  idp: 'IDP Superflex', idp_1qb: 'IDP 1QB',
  dynasty_std: 'Dynasty Standard', dynasty_ppr: 'Dynasty PPR',
  dynasty_half_ppr: 'Dynasty Half-PPR', dynasty_2qb: 'Dynasty Superflex',
};

// Fetch the selected draft's own league settings, resolve the matching Sleeper
// ADP field for that exact format, and (re)apply it to whatever rankings are
// already loaded so the list view's ADP column reflects this league, not a
// generic blended number.
async function loadDraftLeagueAdp(leagueId) {
  T.leagueAdp = null;
  if (!leagueId) { applyLeagueAdp(); return; }
  try {
    const lg = S.leagueDetails[leagueId] || await api('/league/' + leagueId);
    const season = S.nflState?.league_create_season || S.nflState?.season || new Date().getFullYear().toString();
    const suffix = sleeperAdpSuffix(lg.settings, lg.scoring_settings, lg.roster_positions);
    const key  = 'adp_' + suffix;
    const proj = await api('/projections/nfl/regular/' + season);
    const map = {};
    for (const pid in proj) {
      const v = proj[pid]?.[key];
      if (typeof v === 'number' && v < 900) map[pid] = v;
    }
    T.leagueAdp = { map, suffix, season, label: SLEEPER_ADP_LABELS[suffix] || suffix };
    const st = document.getElementById('draft-status');
    if (st && T.draft?.league_id === leagueId) {
      st.textContent += ` · ADP: ${T.leagueAdp.label} (this league's format)`;
    }
    applyLeagueAdp();
  } catch (_) {}
}

// ESPN's own average draft position (from kona_player_info — the same player-pool
// endpoint /auction uses), keyed name → sleeper_id so the list view's ADP column
// shows a real ESPN number for ESPN drafts instead of Sleeper's blended rank.
async function loadEspnAdp(espnId) {
  T.espnAdp = null;
  try {
    await loadPlayers();
    const filter = JSON.stringify({
      players: { limit: 4000, sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' } },
    });
    const r = await fetch(`/api/espn/fantasy/${espnId}?view=kona_player_info&scoringPeriodId=0`, {
      credentials: 'include',
      headers: { 'X-Fantasy-Filter': filter },
    });
    if (!r.ok) { applyLeagueAdp(); return; }
    const d = await r.json();
    const map = {};
    for (const entry of (d.players || [])) {
      const pl = entry.player || entry;
      const adp = pl.ownership?.averageDraftPosition;
      if (!pl.fullName || typeof adp !== 'number' || adp <= 0) continue;
      const sid = S._playersByName[normName(pl.fullName)];
      if (sid) map[sid] = Math.round(adp * 10) / 10;
    }
    const count = Object.keys(map).length;
    if (count) T.espnAdp = { map, count };
    const st = document.getElementById('draft-status');
    if (st && T.draft?._source === 'espn' && count) {
      st.textContent += ` · ADP: ESPN (${count} players)`;
    }
    applyLeagueAdp();
  } catch (_) { applyLeagueAdp(); }
}

// Backfill/upgrade the ADP column for every ranking row that didn't come with
// its own explicit ADP value (CSV column / My Rankings never carry one).
// Prefers this league's format-specific Sleeper ADP; falls back to Sleeper's
// generic blended search_rank when no draft/league format has resolved yet.
function applyLeagueAdp() {
  if (!T.rankings.length) return;
  let changed = false;
  for (const p of T.rankings) {
    if (p._adpFromFile) continue;
    const next = (T.espnAdp?.map?.[p.sleeper_id]) ?? (T.leagueAdp?.map?.[p.sleeper_id]) ?? (S.players[p.sleeper_id]?.search_rank ?? '');
    if (next !== p.adp) { p.adp = next; changed = true; }
  }
  if (changed) {
    resaveTrackerRankings();
    renderTrackerBody();
  }
}

// Pull the logged-in user's own saved projections (projections.ffhistorian.com)
// in for the list view's "My Proj" column. Only meaningful once we know the
// season, so it fires alongside the league ADP lookup when a draft is selected.
// Stays null (column omitted entirely) if the account isn't logged in or has
// no saved projections for the season/preset.
async function loadMyProjections(season, preset) {
  T.myProj = null;
  if (!S.auth) { renderTrackerBody(); return; }
  try {
    await loadPlayers();
    const presetParam = preset ? `&preset=${encodeURIComponent(preset)}` : '';
    const res = await fetch(`/api/projections/ppg?season=${season}${presetParam}`, { credentials: 'include' });
    if (!res.ok) { renderTrackerBody(); return; }
    const data = await res.json();
    const map = {};
    for (const [name, ppg] of Object.entries(data || {})) {
      const pid = S._playersByName[normName(name)];
      if (pid && typeof ppg === 'number') map[pid] = ppg;
    }
    if (Object.keys(map).length) T.myProj = { map, season, preset: preset || '' };
    renderTrackerBody();
  } catch (_) { renderTrackerBody(); }
}

// List of named scoring presets saved on the account (via the projections
// app's "Recompute for Draft Tracker" action) — powers the preset dropdown
// in the list view. Empty when logged out or no presets exist yet.
async function loadMyProjectionPresets() {
  T.myProjPresets = [];
  if (!S.auth) return;
  try {
    const res = await fetch('/api/projections/scoring-presets', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    T.myProjPresets = (data.presets || []).map(p => p.preset).filter(Boolean);
    renderTrackerBody();
  } catch (_) {}
}

function setMyProjPreset(preset, season) {
  T.myProjPreset = preset;
  loadMyProjections(season, preset);
}

const TRACKER_STORE_KEY = 'tracker_saved_rankings';

// Persist the currently loaded rankings so a page refresh (or renavigating to
// the tab) doesn't require re-uploading the CSV / re-fetching ADP every time.
function saveTrackerRankings(source, extra) {
  T._persistMeta = { source, ...extra };
  try {
    localStorage.setItem(TRACKER_STORE_KEY, JSON.stringify({
      source, rankings: T.rankings, targets: [...T.targets], ts: Date.now(), ...extra,
    }));
  } catch {}
}

// Re-persist T.rankings/targets after a target toggle or an ADP backfill,
// reusing whatever source (csv/adp/myranks) is currently loaded.
function resaveTrackerRankings() {
  if (!T._persistMeta) return;
  saveTrackerRankings(T._persistMeta.source, T._persistMeta.filename ? { filename: T._persistMeta.filename } : undefined);
}

function loadStoredTrackerRankings() {
  try { return JSON.parse(localStorage.getItem(TRACKER_STORE_KEY) || 'null'); }
  catch { return null; }
}


function renderDraftTracker() {
  setC(`<div>
    <div class="tab-header">
      <div class="section-head" style="margin-bottom:0;flex:1;"><h2>Draft Tracker</h2><div class="section-head-line"></div></div>
    </div>

    <div class="setup-card" style="margin-bottom:20px;">
      <div style="margin-bottom:14px;">
        <label class="setup-label-rye">Rankings CSV <span class="setup-label-sub">— needs a name column plus a rank and/or tier column; position, team, sleeper_id, adp, target are optional. Columns can be in any order and headers don't need to match exactly.</span></label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <input type="file" id="csv-file" accept=".csv" style="color:var(--cream);font-family:'Crimson Text',serif;font-size:0.9rem;flex:1;" onchange="loadCSV(event)" />
          <button class="setup-btn" onclick="loadSleeperADP()">Use Sleeper ADP</button>
        </div>
        <div class="setup-status" id="csv-status"></div>
      </div>
      ${S.auth ? `<hr class="setup-divider" />
      <div style="margin-bottom:14px;">
        <label class="setup-label-rye">My Rankings <span class="setup-label-sub">— select one or more saved sets; multiple sets are combined by average rank</span></label>
        <div id="myranks-tracker-picker" style="margin-top:6px;font-family:'Crimson Text',serif;font-size:0.9rem;color:var(--brown-light);">Loading…</div>
        <div class="setup-status" id="myranks-status"></div>
      </div>` : ''}
      <hr class="setup-divider" />
      <div>
        <label class="setup-label-rye">Active Draft <span class="setup-label-sub">— auto-updates picks every 15s</span></label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <select id="draft-select" class="tracker-select" onchange="selectDraft(this.value)">
            <option value="">— select a draft —</option>
          </select>
          <button class="setup-btn" onclick="refreshTrackerPicks()">↻ Refresh picks</button>
        </div>
        <div class="setup-status" id="draft-status"></div>
      </div>
    </div>

    <div id="tracker-body">
      <div class="empty-state"><p>Upload a CSV or load Sleeper ADP, then select an active draft</p></div>
    </div>
  </div>`);

  // Restore the last-loaded rankings (CSV / ADP / My Rankings) so returning to
  // this tab or refreshing the page doesn't require re-uploading every time.
  if (!T.rankings.length) {
    const stored = loadStoredTrackerRankings();
    if (stored && Array.isArray(stored.rankings) && stored.rankings.length) {
      T.rankings = stored.rankings;
      T.targets = new Set(stored.targets || []);
      T._persistMeta = { source: stored.source, filename: stored.filename };
      const st = document.getElementById('csv-status');
      if (st) {
        const label = stored.source === 'csv' ? `CSV${stored.filename ? ': ' + stored.filename : ''}`
          : stored.source === 'adp' ? 'Sleeper ADP'
          : stored.source === 'myranks' ? 'My Rankings' : 'last session';
        st.textContent = `✦ Restored ${stored.rankings.length} players from ${label} (last session) — upload a new file to change`;
        st.className = 'setup-status ok';
      }
      renderTrackerBody();
    }
  }

  // Populate draft selector with active drafts if we already have them
  populateDraftSelector();
  if (S.auth) populateMyRanksPicker();
}

async function populateDraftSelector() {
  if (!S.userId) return;
  const sel = document.getElementById('draft-select');
  if (!sel) return;
  // Unified option list across Sleeper + ESPN: {value, label, isLive, start}
  const options = [];

  try {
    // Pull all of the user's drafts for the season in one call — independent of
    // S.leagueDetails (which loads asynchronously after the leagues list).
    const season = S.nflState?.league_create_season || S.nflState?.season || new Date().getFullYear().toString();
    const userDrafts = await api('/user/' + S.userId + '/drafts/nfl/' + season).catch(() => []) || [];
    const byId = new Map();
    for (const d of userDrafts) if (d?.draft_id) byId.set(String(d.draft_id), d);
    // The user-drafts feed can miss an in-progress draft, so also pull each
    // league's own draft_id and fetch any we don't already have.
    const missing = new Set();
    for (const lg of S.leagues) {
      if (lg.source === 'espn') continue;
      const did = lg.draft_id || S.leagueDetails[lg.league_id]?.draft_id;
      if (did && !byId.has(String(did))) missing.add(String(did));
    }
    const fetched = await Promise.all([...missing].map(id => api('/draft/' + id).catch(() => null)));
    for (const d of fetched) if (d?.draft_id) byId.set(String(d.draft_id), d);

    // A live draft can report 'drafting' or (for slow drafts in a pause window)
    // 'paused'. Show everything that isn't completed.
    const isLive = d => d.status === 'drafting' || d.status === 'paused';
    const drafts = [...byId.values()].filter(d => d.status && d.status !== 'complete');
    const lgName = lid => S.leagues.find(l => l.league_id === lid)?.name;
    for (const d of drafts) {
      const base = d.metadata?.name || lgName(d.league_id) || d.draft_id;
      options.push({ value: d.draft_id, label: `${base} — ${isLive(d) ? 'LIVE' : 'scheduled'}`, isLive: isLive(d), start: d.start_time || 0 });
    }
  } catch(e) {}

  // ESPN drafts — snake/linear only; ESPN auction drafts belong on /auction,
  // which already has its own live sync and no notion of "picks until turn".
  const espnLeagues = S.leagues.filter(l => l.source === 'espn');
  if (espnLeagues.length) {
    const results = await Promise.all(espnLeagues.map(async lg => {
      const espnId = S.leagueDetails[lg.league_id]?._espnId;
      if (!espnId) return null;
      try {
        const r = await fetch(`/api/espn/fantasy/${espnId}?view=mDraftDetail&view=mSettings`, { credentials: 'include' });
        if (!r.ok) return null;
        const d = await r.json();
        if (d.settings?.draftSettings?.type === 'AUCTION') return null;
        if (d.draftDetail?.drafted) return null; // already complete
        const inProgress = !!d.draftDetail?.inProgress || (d.draftDetail?.picks?.length || 0) > 0;
        return { value: 'espn_' + espnId, label: `${lg.name} (ESPN) — ${inProgress ? 'LIVE' : 'scheduled'}`, isLive: inProgress, start: d.settings?.draftSettings?.date || 0 };
      } catch { return null; }
    }));
    options.push(...results.filter(Boolean));
  }

  if (!options.length) { sel.innerHTML = '<option value="">— no active or upcoming drafts —</option>'; return; }
  // Live drafts first, then scheduled by start time.
  options.sort((a, b) => (a.isLive !== b.isLive) ? (a.isLive ? -1 : 1) : (a.start - b.start));
  sel.innerHTML = '<option value="">— select a draft —</option>' +
    options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  // Auto-select only when there's exactly one live draft.
  const live = options.filter(o => o.isLive);
  if (live.length === 1) { sel.value = live[0].value; selectDraft(live[0].value); }
}

async function loadSleeperADP() {
  const st = document.getElementById('csv-status');
  st.textContent = 'Loading Sleeper ADP…'; st.className = 'setup-status';
  try {
    await loadPlayers();
    let ranked, sourceLabel;
    // Prefer the selected draft's own league-format ADP (SF/1QB, dynasty/redraft,
    // PPR/half/standard) over the generic blended number, when it's resolved.
    if (T.leagueAdp?.map && Object.keys(T.leagueAdp.map).length) {
      ranked = Object.entries(T.leagueAdp.map)
        .filter(([id]) => S.players[id] && ['QB','RB','WR','TE','DEF'].includes(S.players[id].position))
        .sort((a, b) => a[1] - b[1])
        .slice(0, 300)
        .map(([id, adp], i) => {
          const p = S.players[id];
          return { rank: i + 1, name: p.full_name, pos: p.position, team: p.team || 'FA', sleeper_id: id, adp, tier: '' };
        });
      sourceLabel = `this league's ${T.leagueAdp.label} ADP`;
    } else {
      ranked = Object.entries(S.players)
        .filter(([, p]) => p.active && p.search_rank && p.search_rank < 9999 && ['QB','RB','WR','TE','DEF'].includes(p.position))
        .sort((a, b) => (a[1].search_rank || 999) - (b[1].search_rank || 999))
        .slice(0, 300)
        .map(([id, p], i) => ({
          rank: i + 1, name: p.full_name, pos: p.position,
          team: p.team || 'FA', sleeper_id: id, adp: p.search_rank || '', tier: '',
        }));
      sourceLabel = 'blended Sleeper ADP (all formats — select an active draft to narrow this to its own format)';
    }
    T.rankings = ranked;
    T.posFilter = 'ALL';
    T.targets = new Set();
    // Reset file input so it can be re-selected
    const fi = document.getElementById('csv-file');
    if (fi) fi.value = '';
    st.textContent = `✦ Loaded ${ranked.length} players from ${sourceLabel}`;
    st.className = 'setup-status ok';
    saveTrackerRankings('adp');
    renderTrackerBody();
  } catch(e) { st.textContent = 'Error: ' + e.message; st.className = 'setup-status err'; }
}

// Damerau-Levenshtein edit distance (adjacent transposition counts as a single
// edit, like plain substitution/insert/delete) — used to tolerate minor
// misspellings/variants in CSV headers (e.g. "Postion", "Rnak", "Ranking")
// when an exact synonym match fails. Transposition matters here since it's
// one of the most common typo patterns (swapped adjacent letters).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
      if (i > 1 && j > 1 && a[i-1] === b[j-2] && a[i-2] === b[j-1]) {
        dp[i][j] = Math.min(dp[i][j], dp[i-2][j-2] + 1);
      }
    }
  }
  return dp[m][n];
}

// Known header spellings per field, normalized (lowercase, alphanumeric only)
// at match time. Position/team/rank/tier/id/adp/target intentionally have no
// positional fallback if unmatched — a wrong guess (e.g. grabbing the tier
// column as rank) silently produces bogus data, so an unmatched field is left
// absent rather than guessed.
const CSV_FIELD_SYNONYMS = {
  name:     ['name','player','playername','fullname'],
  position: ['position','pos'],
  team:     ['team','tm','nflteam'],
  rank:     ['rank','rk','overallrank','overall','ranking'],
  tier:     ['tier','tiers','tierlevel'],
  id:       ['sleeperid','playerid','id'],
  adp:      ['adp'],
  target:   ['target','targets','targeted'],
};

// Maps CSV header cells to known fields regardless of column order, first by
// exact synonym match, then (for anything left unresolved) by closest fuzzy
// match — so slightly relabeled or reordered headers still get picked up.
function matchCsvColumns(headerCells) {
  const norm = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const cells = headerCells.map(norm);
  const used = new Set();
  const result = {};
  const fields = Object.keys(CSV_FIELD_SYNONYMS);
  for (const field of fields) {
    const i = cells.findIndex((c, idx) => !used.has(idx) && CSV_FIELD_SYNONYMS[field].includes(c));
    if (i >= 0) { result[field] = i; used.add(i); }
  }
  for (const field of fields) {
    if (result[field] !== undefined) continue;
    let best = -1, bestDist = Infinity;
    cells.forEach((c, idx) => {
      if (used.has(idx) || !c) return;
      for (const syn of CSV_FIELD_SYNONYMS[field]) {
        const dist = levenshtein(c, syn);
        const threshold = Math.max(1, Math.floor(syn.length / 3));
        if (dist <= threshold && dist < bestDist) { bestDist = dist; best = idx; }
      }
    });
    if (best >= 0) { result[field] = best; used.add(best); }
  }
  return result;
}

function loadCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const st = document.getElementById('csv-status');
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      await loadPlayers();
      const rows = csvTable(e.target.result);
      const headerCells = rows[0] || [];
      const m = matchCsvColumns(headerCells);
      // Name has a positional fallback (first column) since it's always
      // required; every other field is left absent (-1) if unmatched.
      const iName   = m.name ?? 0;
      const iPos    = m.position ?? -1;
      const iTeam   = m.team ?? -1;
      const iRank   = m.rank ?? -1;
      const iTier   = m.tier ?? -1;
      const iId     = m.id ?? -1;
      const iAdp    = m.adp ?? -1;
      const iTarget = m.target ?? -1;
      if (iRank < 0 && iTier < 0) {
        throw new Error("couldn't find a rank or tier column");
      }
      // Whether every row gets its own individually-meaningful rank (from the
      // file) vs. only a tier — drives whether the list view shows that raw
      // rank or falls back to a tier-averaged one (see renderTrackerListHtml).
      const hasFileRank = iRank >= 0;

      const parsed = [];
      const targets = new Set();
      for (let i = 1; i < rows.length; i++) {
        const cols = rows[i];
        if (!cols[iName]) continue;
        const team = normTeamAbbr(iTeam >= 0 ? cols[iTeam] : '');
        // Sleeper player IDs are always numeric strings — reject anything else
        // (e.g. a mis-mapped column) so it falls through to name matching.
        let sleeperId = (iId >= 0 && /^\d+$/.test(cols[iId] || '')) ? cols[iId] : '';
        // Fuzzy match by name+team if no ID. normName() strips punctuation/spacing
        // so "AJ Brown"/"A.J. Brown" and similar variants match either way.
        if (!sleeperId) {
          const nName = normName(cols[iName]);
          const teamMatch = Object.entries(S.players).find(([, p]) =>
            normName(p.full_name) === nName && (!team || normTeamAbbr(p.team) === team)
          );
          sleeperId = teamMatch ? teamMatch[0] : (S._playersByName[nName] || '');
        }
        // Prefer Sleeper's canonical spelling (e.g. "A.J. Brown") once matched,
        // rather than however the CSV happened to write the name.
        const canonicalName = sleeperId ? S.players[sleeperId]?.full_name : null;
        if (sleeperId && iTarget >= 0 && /^(1|true|yes|y|x)$/i.test(cols[iTarget] || '')) targets.add(String(sleeperId));
        // Prefer the CSV's own ADP column when present; otherwise pull the
        // selected draft's league-format ADP if one's resolved, else fall back
        // to Sleeper's blended ADP (search_rank) — so the list view's ADP
        // column isn't just blank for rankings files that don't track it.
        const csvAdp = iAdp >= 0 ? cols[iAdp] : '';
        const fallbackAdp = sleeperId ? ((T.leagueAdp?.map?.[sleeperId]) ?? (S.players[sleeperId]?.search_rank ?? '')) : '';
        const csvRank = iRank >= 0 ? parseInt(cols[iRank]) : NaN;
        parsed.push({
          rank: Number.isFinite(csvRank) ? csvRank : i,
          name: canonicalName || cols[iName],
          pos:  (iPos >= 0 ? cols[iPos] : '').toUpperCase(),
          team: team || '',
          sleeper_id: sleeperId,
          adp:  csvAdp !== '' ? csvAdp : fallbackAdp,
          _adpFromFile: csvAdp !== '',
          tier: iTier >= 0 ? cols[iTier] : '',
          _rankFromFile: hasFileRank,
        });
      }
      T.rankings = parsed;
      T.posFilter = 'ALL';
      T.targets = targets;
      st.textContent = '✦ Loaded ' + parsed.length + ' players from CSV' + (targets.size ? ' (' + targets.size + ' targets)' : '');
      st.className = 'setup-status ok';
      saveTrackerRankings('csv', { filename: file.name });
      renderTrackerBody();
    } catch(err) { st.textContent = 'Error parsing CSV: ' + err.message; st.className = 'setup-status err'; }
  };
  reader.readAsText(file);
}

async function selectDraft(draftId) {
  if (T.pollTimer) { clearInterval(T.pollTimer); T.pollTimer = null; }
  if (!draftId) {
    T.draft = null; T.espn = null; T.espnManualPicked = new Set(); T.picked.clear(); T.espnAdp = null; loadDraftLeagueAdp(null);
    T.myProj = null; T.myProjPresets = []; T.myProjPreset = ''; T.myProjSeason = null;
    renderTrackerBody();
    return;
  }
  if (draftId.startsWith('espn_')) { await selectEspnDraft(draftId.slice(5)); return; }
  const st = document.getElementById('draft-status');
  st.textContent = 'Loading picks…'; st.className = 'setup-status';
  try {
    T.draft = await api('/draft/' + draftId);
    T.espn = null; T.espnManualPicked = new Set(); T.espnAdp = null;
    T.reversalRound = T.draft?.settings?.reversal_round ?? 0;
    T.tradedPicks = await api('/draft/' + draftId + '/traded_picks').catch(() => []) || [];
    const mySlot = T.draft?.draft_order?.[S.userId];
    T.myRosterId = (mySlot != null) ? (T.draft?.slot_to_roster_id?.[mySlot] ?? null) : null;
    await syncPicks(draftId);
    st.textContent = '✦ Synced — auto-refreshing every 15s';
    st.className = 'setup-status ok';
    // Poll every 15 seconds for new picks
    T.pollTimer = setInterval(() => syncPicks(draftId), 15000);
    renderTrackerBody();
    // Fire-and-forget: resolves this league's exact ADP format (SF/1QB,
    // dynasty/redraft, PPR/half/standard) and backfills T.rankings' ADP
    // column once it lands — doesn't block the pick sync above.
    loadDraftLeagueAdp(T.draft?.league_id);
    // Same trigger point: also pull the logged-in user's own saved projections
    // for the list view's "My Proj" column, if any exist for this season.
    const projSeason = T.draft?.season || S.nflState?.league_create_season || S.nflState?.season || new Date().getFullYear().toString();
    T.myProjSeason = projSeason;
    T.myProjPreset = '';
    loadMyProjections(projSeason);
    loadMyProjectionPresets();
  } catch(e) { st.textContent = 'Error: ' + e.message; st.className = 'setup-status err'; }
}

async function syncPicks(draftId) {
  try {
    const picks = await api('/draft/' + draftId + '/picks');
    T.pickCount = (picks || []).length;
    T.picked.clear();
    for (const pick of (picks || [])) {
      if (pick.player_id) T.picked.add(String(pick.player_id));
    }
    renderTrackerBody();
  } catch(_) {}
}

// ── ESPN draft support ──────────────────────────────────────────────────────
// ESPN has no per-draft id — the draft lives inside the league itself — so
// espnId here is the numeric ESPN league id (from the 'espn_{id}' select value).
// T.draft is normalized to the same shape selectDraft() builds for Sleeper
// ({settings:{teams,rounds}, type, _source}) so renderTrackerBody()/the board
// and list views need no ESPN-specific branching at all.
async function selectEspnDraft(espnId) {
  const st = document.getElementById('draft-status');
  st.textContent = 'Loading picks…'; st.className = 'setup-status';
  try {
    await loadPlayers(); // needed for the name → sleeper_id lookup in applyEspnRosterPicks()
    const lg = S.leagues.find(l => l.league_id === 'espn_' + espnId);
    const r = await fetch(`/api/espn/fantasy/${espnId}?view=mDraftDetail&view=mSettings&view=mRoster&view=mTeam`, { credentials: 'include' });
    if (!r.ok) throw new Error(`ESPN returned ${r.status}`);
    const d = await r.json();
    // Total roster spots (starters + bench + IR) = number of draft rounds —
    // lineupSlotCounts is keyed by ESPN slot id but every value counts toward it.
    const rounds = Object.values(d.settings?.rosterSettings?.lineupSlotCounts || {}).reduce((a, b) => a + b, 0) || 16;
    const teamsN = (d.teams || []).length || d.settings?.draftSettings?.pickOrder?.length || 12;
    T.draft = { league_id: 'espn_' + espnId, name: lg?.name, settings: { teams: teamsN, rounds }, type: 'snake', _source: 'espn' };
    T.tradedPicks = [];
    T.reversalRound = 0; // ESPN has no 3rd-round-reversal setting to auto-detect; toggle manually if needed
    const mySWID = S.espnSettings?.swid || '';
    const myTeam = espnMyTeam(d.teams, mySWID);
    T.myRosterId = myTeam ? myTeam.id : null;
    T.espn = { id: espnId, pickOrder: d.settings?.draftSettings?.pickOrder || [] };
    T.espnManualPicked = loadEspnManualPicks(espnId);
    applyEspnRosterPicks(d);
    st.textContent = '✦ Synced — auto-refreshing every 15s';
    st.className = 'setup-status ok';
    T.pollTimer = setInterval(() => syncEspnPicks(espnId), 15000);
    renderTrackerBody();
    // ESPN leagues have no Sleeper-format ADP to resolve — use ESPN's own ADP,
    // falling back to Sleeper's blended rank for anyone ESPN hasn't priced.
    T.leagueAdp = null;
    T.espnAdp = null;
    applyLeagueAdp();
    loadEspnAdp(espnId);
    const projSeason = S.nflState?.league_create_season || S.nflState?.season || new Date().getFullYear().toString();
    T.myProjSeason = projSeason;
    T.myProjPreset = '';
    loadMyProjections(projSeason);
    loadMyProjectionPresets();
  } catch(e) { st.textContent = 'Error: ' + e.message; st.className = 'setup-status err'; }
}

// Derives the picked-player set + pick count from the mDraftDetail/mRoster
// payload already fetched by the caller (selectEspnDraft or syncEspnPicks).
// Reading who's picked off team rosters (rather than the picks[] array's
// player nesting, which is less consistently shaped) reuses the same
// entry.playerPoolEntry(.playerPoolEntry)?.player path Rostership uses — the
// mRoster view nests it one level shallower than mDraftDetail, so try both.
function applyEspnRosterPicks(d) {
  const picked = new Set();
  for (const team of (d.teams || [])) {
    for (const entry of (team.roster?.entries || [])) {
      const pData = entry.playerPoolEntry?.playerPoolEntry?.player || entry.playerPoolEntry?.player;
      if (!pData) continue;
      const fullName = pData.fullName || `${pData.firstName || ''} ${pData.lastName || ''}`.trim();
      const sid = S._playersByName[normName(fullName)];
      if (sid) picked.add(String(sid));
    }
  }
  // Merge in manual overrides (toggleEspnManualPick) — ESPN's roster-entries
  // view has been observed to lag well behind real draft-room picks (live
  // testing found it can go a full session without updating), so a manual
  // mark fills that gap immediately. A synced pick naturally takes over once
  // ESPN's data catches up since it's added to the same set either way.
  for (const sid of T.espnManualPicked) picked.add(sid);
  T.picked = picked;
  // Drives trackerPicksUntilTurn()'s snake-order math — must be actual picks
  // made so far. draftDetail.picks.length is *not* that: ESPN pre-populates
  // every slot for the whole draft (drafted or not, playerId:-1 until filled),
  // so that length is always teams*rounds regardless of progress.
  T.pickCount = picked.size;
  renderTrackerBody();
}

// Manual drafted-marking for ESPN drafts, so a pick made in ESPN's own draft
// room can be reflected here immediately rather than waiting on (possibly
// unreliable) live sync — see applyEspnRosterPicks. Persisted per-league so a
// refresh mid-draft doesn't lose your manual marks.
function toggleEspnManualPick(sleeperId) {
  if (!sleeperId || T.draft?._source !== 'espn') return;
  if (T.espnManualPicked.has(sleeperId)) { T.espnManualPicked.delete(sleeperId); T.picked.delete(sleeperId); }
  else { T.espnManualPicked.add(sleeperId); T.picked.add(sleeperId); }
  saveEspnManualPicks();
  renderTrackerBody();
}

function saveEspnManualPicks() {
  if (!T.espn?.id) return;
  try { localStorage.setItem('espn_manual_picks_' + T.espn.id, JSON.stringify([...T.espnManualPicked])); } catch {}
}

function loadEspnManualPicks(espnId) {
  try {
    const raw = localStorage.getItem('espn_manual_picks_' + espnId);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

async function syncEspnPicks(espnId) {
  try {
    await loadPlayers();
    const r = await fetch(`/api/espn/fantasy/${espnId}?view=mDraftDetail&view=mRoster&view=mTeam`, { credentials: 'include' });
    if (!r.ok) return;
    const d = await r.json();
    applyEspnRosterPicks(d);
  } catch(_) {}
}

async function refreshTrackerPicks() {
  if (!T.draft) return;
  if (T.draft._source === 'espn') { await syncEspnPicks(T.espn.id); return; }
  await syncPicks(T.draft.draft_id);
}

// Split a name into (at most) two display lines at the last space, so cards
// break cleanly between first/last name instead of wrapping wherever the
// browser finds room (which at these card widths meant mid-word breaks).
function trackerNameLines(name) {
  const s = name || '';
  const i = s.lastIndexOf(' ');
  return i === -1 ? [s] : [s.slice(0, i), s.slice(i + 1)];
}

function renderTrackerBody() {
  const body = document.getElementById('tracker-body');
  if (!body) return;
  if (!T.rankings.length) {
    body.innerHTML = '<div class="empty-state"><p>Upload a CSV or load Sleeper ADP to begin</p></div>';
    return;
  }

  const SKIP_POS = new Set(['K']);
  const teams    = T.draft?.settings?.teams ?? 12;
  const type     = T.draft?.type ?? 'snake';
  const hasTiers = T.rankings.some(p => p.tier && p.tier !== '');
  const hasFileRank = T.rankings.some(p => p._rankFromFile);

  const posClass = p => ({ QB:'pos-qb', RB:'pos-rb', WR:'pos-wr', TE:'pos-te', DEF:'pos-def' })[p] || '';

  const visible   = T.rankings.filter(p => !SKIP_POS.has(p.pos) && (T.posFilter === 'ALL' || p.pos === T.posFilter) && (!T.targetsOnly || T.targets.has(String(p.sleeper_id))));
  const positions = ['ALL', ...new Set(T.rankings.filter(p => !SKIP_POS.has(p.pos)).map(p => p.pos).filter(Boolean))];
  const pickedCount = T.picked.size;
  const available   = T.rankings.filter(p => !SKIP_POS.has(p.pos) && !T.picked.has(String(p.sleeper_id))).length;
  const targetsLeft = [...T.targets].filter(id => !T.picked.has(String(id))).length;

  const viewToggleHtml = `<div class="tracker-view-toggle" style="margin-bottom:12px;">
    <button class="${T.view==='board'?'active':''}" onclick="setTrackerView('board')">Board</button>
    <button class="${T.view==='list'?'active':''}" onclick="setTrackerView('list')">List</button>
  </div>`;

  const posFilterHtml = `<div class="tracker-filter">
    ${positions.map(pos => `<button class="pos-pill ${T.posFilter===pos?'active':''}" onclick="setTrackerPos('${pos}')">${pos}</button>`).join('')}
    <button class="pos-pill ${T.targetsOnly?'active':''}" onclick="toggleTargetsOnly()" title="Show only targeted players">★ Targets${T.targets.size ? ' (' + T.targets.size + ')' : ''}</button>
  </div>`;

  const pu = trackerPicksUntilTurn();
  let puHtml = '';
  if (pu === 0)      puHtml = `<span class="card-meta" style="color:var(--gold);font-weight:600;">⏱ You're on the clock</span>`;
  else if (pu > 0)   puHtml = `<span class="card-meta" style="color:var(--gold);">⏱ ${pu} pick${pu===1?'':'s'} until your turn</span>`;

  const rrToggle = (T.draft && type === 'snake') ? `<label class="card-meta" style="display:flex;align-items:center;gap:5px;cursor:pointer;">
    <input type="checkbox" ${T.reversalRound ? 'checked' : ''} onchange="toggleReversal(this.checked)" style="accent-color:var(--gold);cursor:pointer;" />3rd Rd Reversal
  </label>` : '';

  const statsHtml = `<div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin-bottom:14px;">
    <span class="card-meta">${pickedCount} picked · ${available} available</span>
    ${T.targets.size ? `<span class="card-meta">★ ${targetsLeft} target${targetsLeft===1?'':'s'} left</span>` : ''}
    ${T.draft ? `<span class="card-meta">Round ${Math.floor(pickedCount/teams)+1} · Pick ${(pickedCount%teams)+1} of ${teams}</span>` : ''}
    ${puHtml}
    ${rrToggle}
  </div>
  ${T.draft?._source === 'espn' ? `<div class="card-meta" style="margin:-6px 0 14px;color:var(--gold-light);font-style:italic;">ESPN auto-sync can lag — click any card to mark it drafted yourself (☆ toggles a target)</div>` : ''}`;

  const isEspn = T.draft?._source === 'espn';
  const playerTile = (p, pickLabel) => {
    const isPicked  = T.picked.has(String(p.sleeper_id));
    const isTarget  = p.sleeper_id && T.targets.has(String(p.sleeper_id));
    const pc        = posClass(p.pos);
    const tierNum   = parseInt(p.tier) || 0;
    const tierCls   = hasTiers && tierNum && tierNum % 2 === 0 ? 'tier-even' : '';
    // ESPN drafts: the card itself marks/unmarks drafted (manual fallback for
    // unreliable live sync — see toggleEspnManualPick); targeting moves to a
    // dedicated star so it's still reachable. Everywhere else, unchanged —
    // click targets, star is a display-only indicator.
    const clickable = !p.sleeper_id ? '' : isEspn
      ? `onclick="toggleEspnManualPick('${esc(String(p.sleeper_id))}')" title="Click to ${isPicked?'un-mark':'mark'} ${esc(p.name)} as drafted"`
      : `onclick="toggleTarget('${esc(String(p.sleeper_id))}')" title="Click to ${isTarget?'un-target':'target'} ${esc(p.name)}"`;
    const starHtml = !p.sleeper_id ? (isTarget ? ' <span class="tp-star">★</span>' : '') : isEspn
      ? ` <span class="tp-star" onclick="event.stopPropagation();toggleTarget('${esc(String(p.sleeper_id))}')" style="cursor:pointer;" title="${isTarget?'Un-target':'Target'} ${esc(p.name)}">${isTarget?'★':'☆'}</span>`
      : (isTarget ? ' <span class="tp-star">★</span>' : '');
    const nameHtml  = trackerNameLines(p.name).map(l => `<span class="tp-name-line">${esc(l)}</span>`).join('');
    return `<div class="tracker-player ${isPicked?'picked':''} ${pc} ${tierCls} ${isTarget?'targeted':''}" ${clickable}>
      ${pickLabel ? `<span class="tp-pick">${esc(pickLabel)}</span>` : ''}
      <span class="tp-pos">${esc(p.pos)}${starHtml}</span>
      <span class="tp-name">${nameHtml}</span>
      ${p.team ? `<span class="tp-team">${esc(p.team)}</span>` : ''}
    </div>`;
  };

  let mainHtml = '';

  if (T.view === 'list') {
    mainHtml = renderTrackerListHtml(visible, hasTiers, SKIP_POS, hasFileRank);
  } else if (T.posFilter === 'ALL' && !T.targetsOnly && T.draft) {
    // Snake grid: rows of `teams`, each row's flow direction spelled out
    const rows = [];
    let row = [];
    for (const p of visible) {
      row.push(p);
      if (row.length === teams) { rows.push(row); row = []; }
    }
    if (row.length) rows.push(row);

    mainHtml = `<div class="tracker-snake" style="grid-template-columns:repeat(${teams},minmax(0,1fr));">`;
    rows.forEach((rowPlayers, roundIdx) => {
      const round = roundIdx + 1;
      const isReversed = type === 'snake' && isReversedRound(round, type, T.reversalRound);
      const dirCls  = isReversed ? 'dir-rtl' : 'dir-ltr';
      const chev    = isReversed ? '◀ ◀ ◀' : '▶ ▶ ▶';
      const dirText = isReversed ? 'picks run right → left' : 'picks run left → right';
      // Display columns stay fixed (col 1 = team 1); on a reversed round the row
      // is flipped so the tile in col 1 is that round's *last* pick.
      const orderedRow = isReversed ? [...rowPlayers].reverse() : rowPlayers;
      mainHtml += `<div class="tracker-round-label ${dirCls}" style="grid-column:1/-1;">
        <span class="trl-round">Round ${round}</span>
        <span class="trl-chev">${chev}</span>
        <span class="trl-dir">${dirText}</span>
      </div>`;
      mainHtml += orderedRow.map((p, i) => {
        const pickInRound = isReversed ? (rowPlayers.length - i) : (i + 1);
        return playerTile(p, `${round}.${String(pickInRound).padStart(2, '0')}`);
      }).join('');
    });
    mainHtml += '</div>';
  } else {
    // Position-filtered view: simple responsive grid, no snake ordering
    mainHtml = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:3px;">
      ${visible.map(p => playerTile(p)).join('')}
    </div>`;
  }

  body.innerHTML = viewToggleHtml + posFilterHtml + statsHtml + mainHtml;
}

function setTrackerView(view) {
  T.view = view;
  renderTrackerBody();
}

// Position badge colors shared with the board view's left-border accents.
const TL_POS_COLORS = { QB:'#e05252', RB:'#5cb85c', WR:'#5bc0de', TE:'#e8734b', DEF:'#9b59b6' };

// List view: every loaded player as a row (position, team, tier, aggregate
// rank, Sleeper ADP, position rank, position ADP, and a colored my-rank-vs-ADP
// indicator), still crossed off as they're drafted.
function renderTrackerListHtml(visible, hasTiers, SKIP_POS, hasFileRank) {
  const numRank = p => { const n = parseFloat(p.rank); return Number.isFinite(n) ? n : Infinity; };
  const numAdp  = p => { const n = parseFloat(p.adp);  return Number.isFinite(n) ? n : null; };
  const rowKey  = p => p.sleeper_id || p.name;

  // Aggregate rank: within a tier, every player shares that tier's average raw
  // rank (rounded) rather than their own individual rank — computed over the
  // full rankings list so it doesn't shift as filters change. Skipped entirely
  // when the CSV supplied its own per-player rank (hasFileRank) — that rank is
  // already individually meaningful, so it's shown as-is; only the tier
  // shading (not the displayed number) is tier-based in that case.
  const tierAvg = {};
  if (hasTiers && !hasFileRank) {
    const groups = {};
    for (const p of T.rankings) {
      const t = (p.tier ?? '').toString().trim();
      if (!t) continue;
      (groups[t] = groups[t] || []).push(numRank(p));
    }
    for (const t in groups) {
      const arr = groups[t].filter(Number.isFinite);
      tierAvg[t] = arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    }
  }
  const aggRank = p => {
    if (hasFileRank) return Number.isFinite(numRank(p)) ? numRank(p) : null;
    const t = (p.tier ?? '').toString().trim();
    if (hasTiers && t && tierAvg[t] != null) return tierAvg[t];
    return Number.isFinite(numRank(p)) ? numRank(p) : null;
  };

  // Position rank (my rankings) and position ADP rank — also computed over the
  // full pool so switching the position filter pills doesn't renumber anyone.
  const byPos = {};
  for (const p of T.rankings) {
    if (SKIP_POS.has(p.pos)) continue;
    (byPos[p.pos] = byPos[p.pos] || []).push(p);
  }
  const posRankMap = {}, posAdpRankMap = {};
  for (const pos in byPos) {
    const list = byPos[pos];
    [...list].sort((a, b) => numRank(a) - numRank(b)).forEach((p, i) => { posRankMap[rowKey(p)] = i + 1; });
    const withAdp = list.filter(p => numAdp(p) != null);
    [...withAdp].sort((a, b) => numAdp(a) - numAdp(b)).forEach((p, i) => { posAdpRankMap[rowKey(p)] = i + 1; });
  }

  const draftedCount = visible.filter(p => T.picked.has(String(p.sleeper_id))).length;
  const rowsSource = T.hideDrafted ? visible.filter(p => !T.picked.has(String(p.sleeper_id))) : visible;
  const isEspn = T.draft?._source === 'espn';

  // "My Proj" only appears once the account actually has saved projections —
  // otherwise the column is omitted entirely rather than shown empty.
  const showMyProj = !!(T.myProj?.map && Object.keys(T.myProj.map).length);
  const colCount = showMyProj ? 10 : 9;
  // ADP column reflects its real source: ESPN's own ADP for ESPN drafts (once
  // loadEspnAdp resolves), this league's Sleeper-format ADP, or blended Sleeper.
  const adpLabel = (isEspn && T.espnAdp) ? 'ESPN ADP' : (T.leagueAdp ? T.leagueAdp.label + ' ADP' : 'ADP');

  const rows = [...rowsSource].sort((a, b) => (aggRank(a) ?? Infinity) - (aggRank(b) ?? Infinity)).map(p => {
    const isPicked = T.picked.has(String(p.sleeper_id));
    const isTarget = p.sleeper_id && T.targets.has(String(p.sleeper_id));
    const tierNum  = parseInt(p.tier) || 0;
    const tierCls  = hasTiers && tierNum && tierNum % 2 === 0 ? 'tl-tier-even' : '';
    const rowCls   = [isPicked ? 'tl-picked' : '', tierCls, isTarget ? 'tl-target' : ''].filter(Boolean).join(' ');
    // See the board view's playerTile for why ESPN rows behave differently.
    const clickable = !p.sleeper_id ? '' : isEspn
      ? `onclick="toggleEspnManualPick('${esc(String(p.sleeper_id))}')" title="Click to ${isPicked?'un-mark':'mark'} ${esc(p.name)} as drafted"`
      : `onclick="toggleTarget('${esc(String(p.sleeper_id))}')" title="Click to ${isTarget?'un-target':'target'} ${esc(p.name)}"`;
    const starPrefix = !p.sleeper_id ? (isTarget ? '<span class="tp-star">★</span> ' : '') : isEspn
      ? `<span class="tp-star" onclick="event.stopPropagation();toggleTarget('${esc(String(p.sleeper_id))}')" style="cursor:pointer;" title="${isTarget?'Un-target':'Target'} ${esc(p.name)}">${isTarget?'★':'☆'}</span> `
      : (isTarget ? '<span class="tp-star">★</span> ' : '');
    const posColor = TL_POS_COLORS[p.pos] || 'inherit';
    const rk     = aggRank(p);
    const adpNum = numAdp(p);
    const pr     = posRankMap[rowKey(p)];
    const par    = posAdpRankMap[rowKey(p)];
    // Rounded to the nearest tenth so it never shows more than 1 decimal place.
    const d = (rk != null && adpNum != null) ? Math.round((adpNum - rk) * 10) / 10 : null;
    const diffHtml = d == null ? '<span class="tl-diff-even">—</span>'
      : d === 0 ? '<span class="tl-diff-even">even</span>'
      : d > 0 ? `<span class="tl-diff-better">▲ +${d.toFixed(1)}</span>`
      : `<span class="tl-diff-worse">▼ ${d.toFixed(1)}</span>`;
    const myProjVal = T.myProj?.map?.[p.sleeper_id];
    const myProjTd = showMyProj ? `<td>${typeof myProjVal === 'number' ? myProjVal.toFixed(1) : '—'}</td>` : '';
    return `<tr class="${rowCls}" ${clickable}>
      <td class="tl-name">${starPrefix}${esc(p.name)}</td>
      <td style="color:${posColor};font-weight:600;">${esc(p.pos || '—')}</td>
      <td>${esc(p.team || '—')}</td>
      <td>${p.tier ? esc(String(p.tier)) : '—'}</td>
      <td>${rk != null ? rk : '—'}</td>
      <td>${adpNum != null ? adpNum : '—'}</td>
      ${myProjTd}
      <td>${pr ? esc(p.pos) + pr : '—'}</td>
      <td>${par ? esc(p.pos) + par : '—'}</td>
      <td>${diffHtml}</td>
    </tr>`;
  }).join('');

  // Only worth showing once the account actually has named presets to pick
  // from (via the projections app's "Recompute for Draft Tracker" action).
  const presetPickerHtml = T.myProjPresets.length ? `<div style="display:flex;align-items:center;gap:6px;">
    <span class="card-meta">My Proj:</span>
    <select class="tracker-select" style="padding:5px 24px 5px 8px;" onchange="setMyProjPreset(this.value, '${esc(String(T.myProjSeason || ''))}')">
      <option value="" ${T.myProjPreset === '' ? 'selected' : ''}>Default</option>
      ${T.myProjPresets.map(p => `<option value="${esc(p)}" ${T.myProjPreset === p ? 'selected' : ''}>${esc(p)}</option>`).join('')}
    </select>
  </div>` : '<div></div>';

  const hideToggleHtml = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
    ${presetPickerHtml}
    <div style="display:flex;align-items:center;gap:8px;">
      ${draftedCount ? `<span class="card-meta">${draftedCount} drafted ${T.hideDrafted ? 'hidden' : 'shown'}</span>` : ''}
      <button class="pos-pill ${T.hideDrafted?'active':''}" onclick="toggleHideDrafted()">${T.hideDrafted ? 'Show Drafted' : 'Hide Drafted'}</button>
    </div>
  </div>`;

  return `${hideToggleHtml}<div style="overflow-x:auto;">
    <table class="tl-table">
      <thead><tr>
        <th>Player</th><th>Pos</th><th>Team</th><th>Tier</th><th>Rank</th><th>${esc(adpLabel)}</th>${showMyProj ? '<th>My Proj</th>' : ''}<th>Pos Rank</th><th>Pos ADP</th><th>vs ADP</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="${colCount}" style="text-align:center;font-style:italic;color:var(--brown-light);padding:16px;">No players match the current filters</td></tr>`}</tbody>
    </table>
  </div>`;
}

function setTrackerPos(pos) {
  T.posFilter = pos;
  renderTrackerBody();
}

function toggleTarget(sleeperId) {
  if (!sleeperId) return;
  if (T.targets.has(sleeperId)) T.targets.delete(sleeperId);
  else T.targets.add(sleeperId);
  resaveTrackerRankings();
  renderTrackerBody();
}

function toggleTargetsOnly() {
  T.targetsOnly = !T.targetsOnly;
  renderTrackerBody();
}

function toggleReversal(on) {
  T.reversalRound = on ? 3 : 0;
  renderTrackerBody();
}

// Picks remaining until this user's next turn in the active draft.
// 0 = on the clock, -1 = no more picks / unknown roster, null = not applicable.
function trackerPicksUntilTurn() {
  const d = T.draft;
  if (!d || T.myRosterId == null) return null;
  const teams = d.settings?.teams ?? 12, rounds = d.settings?.rounds ?? 5;
  const done = T.pickCount || 0;
  if (d._source === 'espn') {
    // No traded-picks concept here — ESPN pre-draft pick trading isn't
    // exposed by this endpoint, so slot order is assumed to match pickOrder.
    const order = T.espn?.pickOrder || [];
    const myIdx = order.indexOf(T.myRosterId);
    if (myIdx < 0) return -1;
    for (let offset = 0; offset < teams * rounds; offset++) {
      const overall = done + offset;
      if (overall >= teams * rounds) break;
      const round = Math.floor(overall / teams) + 1;
      const pos   = overall % teams;
      const slotIdx = isReversedRound(round, d.type, T.reversalRound) ? teams - 1 - pos : pos;
      if (slotIdx === myIdx) return offset;
    }
    return -1;
  }
  const slotToRoster = d.slot_to_roster_id ?? {};
  const tradeMap = {};
  for (const tp of (T.tradedPicks || [])) tradeMap[`${tp.round}.${tp.roster_id}`] = tp.owner_id;
  for (let offset = 0; offset < teams * rounds; offset++) {
    const overall = done + offset;
    if (overall >= teams * rounds) break;
    const round = Math.floor(overall / teams) + 1;
    const pos   = overall % teams;
    const slot  = isReversedRound(round, d.type, T.reversalRound) ? teams - pos : pos + 1;
    const orig  = slotToRoster[slot] ?? slot;
    const owner = tradeMap[`${round}.${orig}`] ?? orig;
    if (owner === T.myRosterId) return offset;
  }
  return -1;
}


async function populateMyRanksPicker() {
  const div = document.getElementById('myranks-tracker-picker');
  if (!div) return;
  try {
    const [dataRes, setsRes] = await Promise.all([
      fetch(MYRANKS_API + '/api/myranks/data', { credentials: 'include' }),
      fetch(MYRANKS_API + '/api/myranks/sets', { credentials: 'include' }),
    ]);
    if (!dataRes.ok || !setsRes.ok) throw new Error('Failed to load');
    const [data, setsData] = await Promise.all([dataRes.json(), setsRes.json()]);
    T.myRanksSets = { primary: data.rankings || [], sets: setsData.sets || [], sharedSets: setsData.sharedSets || [] };

    const options = [];
    if (data.rankings?.length) options.push({ id: 'primary', label: 'My Rankings' });
    for (const s of (setsData.sets || [])) options.push({ id: 'set:' + s.id, label: s.name });
    for (const s of (setsData.sharedSets || [])) {
      const label = s.is_primary
        ? (s.owner_name ? `${s.owner_name}'s Rankings` : 'Shared Rankings')
        : (s.owner_name ? `${s.name} (${s.owner_name})` : s.name);
      options.push({ id: String(s.id), label });
    }

    if (!options.length) {
      div.innerHTML = `<span>No ranking sets found — create some at <a href="https://myranks.ffhistorian.com" target="_blank" style="color:var(--gold);">My Ranks</a></span>`;
      return;
    }

    div.innerHTML = `<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;">
      ${options.map(o => `<label style="display:flex;align-items:center;gap:4px;cursor:pointer;color:var(--cream);font-family:'Crimson Text',serif;font-size:0.9rem;white-space:nowrap;">
        <input type="checkbox" value="${esc(o.id)}" onchange="updateMyRanksLoadBtn()" style="accent-color:var(--gold);cursor:pointer;" />
        ${esc(o.label)}
      </label>`).join('')}
      <button class="setup-btn" id="myranks-load-btn" disabled onclick="loadFromMyRanks()">Load</button>
    </div>`;
  } catch(e) {
    if (div) div.innerHTML = '<span>Error loading ranking sets</span>';
  }
}

function updateMyRanksLoadBtn() {
  const div = document.getElementById('myranks-tracker-picker');
  if (!div) return;
  const n = div.querySelectorAll('input[type=checkbox]:checked').length;
  const btn = document.getElementById('myranks-load-btn');
  if (!btn) return;
  btn.disabled = !n;
  btn.textContent = n > 1 ? `Load (avg of ${n})` : 'Load';
}

async function loadFromMyRanks() {
  const div = document.getElementById('myranks-tracker-picker');
  const st = document.getElementById('myranks-status');
  if (!div) return;
  const checked = [...div.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
  if (!checked.length) return;
  if (st) { st.textContent = 'Loading…'; st.className = 'setup-status'; }
  try {
    await loadPlayers();
    const fetches = checked.map(id => {
      if (id === 'primary') return Promise.resolve(T.myRanksSets.primary);
      // shared primary: id looks like "primary:userId"
      if (id.startsWith('primary:')) {
        const ownerId = id.slice(8);
        return fetch(MYRANKS_API + '/api/myranks/data?owner_id=' + encodeURIComponent(ownerId), { credentials: 'include' })
          .then(r => r.json()).then(d => d.rankings || []);
      }
      // named set: id looks like "set:123"
      if (id.startsWith('set:')) {
        const setId = id.slice(4);
        return fetch(MYRANKS_API + '/api/myranks/sets/' + setId + '/data', { credentials: 'include' })
          .then(r => r.json()).then(d => d.rankings || []);
      }
      // shared named set: plain numeric id (from sharedSets list)
      return fetch(MYRANKS_API + '/api/myranks/sets/' + id + '/data', { credentials: 'include' })
        .then(r => r.json()).then(d => d.rankings || []);
    });
    const lists = await Promise.all(fetches);
    const combined = combineRankingLists(lists);
    T.rankings = combined;
    T.posFilter = 'ALL';
    T.targets = new Set();
    const fi = document.getElementById('csv-file');
    if (fi) fi.value = '';
    const csvSt = document.getElementById('csv-status');
    if (csvSt) { csvSt.textContent = ''; csvSt.className = 'setup-status'; }
    if (st) {
      const desc = checked.length > 1 ? `${checked.length} sets combined (average rank)` : '1 ranking set';
      st.textContent = `✦ Loaded ${combined.length} players from ${desc}`;
      st.className = 'setup-status ok';
    }
    saveTrackerRankings('myranks');
    renderTrackerBody();
  } catch(e) {
    if (st) { st.textContent = 'Error: ' + e.message; st.className = 'setup-status err'; }
  }
}

function combineRankingLists(lists) {
  // Each list is [{player_name, position, team, tier}] already in rank order (tier asc, then name)
  // Build rank maps per list: playerName.toLowerCase() → 1-based rank
  const rankMaps = lists.map(list => {
    const map = {};
    list.forEach((p, i) => { map[p.player_name.toLowerCase()] = i + 1; });
    return { map, size: list.length };
  });

  // Collect all unique players
  const playerData = {};
  for (const list of lists) {
    for (const p of list) {
      const key = p.player_name.toLowerCase();
      if (!playerData[key]) playerData[key] = p;
    }
  }

  // Average rank; players missing from a list get penalized with size+1
  const players = Object.entries(playerData).map(([key, p]) => {
    const avg = rankMaps.reduce((sum, { map, size }) => sum + (map[key] ?? size + 1), 0) / rankMaps.length;
    return { key, p, avg };
  });

  players.sort((a, b) => a.avg - b.avg);

  const singleList = lists.length === 1;
  return players.map(({ key, p }, i) => {
    const sleeperId = S._playersByName?.[normName(p.player_name)] || '';
    return {
      rank: i + 1,
      name: (sleeperId && S.players[sleeperId]?.full_name) || p.player_name,
      pos:  (p.position || '').toUpperCase(),
      team: p.team || '',
      sleeper_id: sleeperId,
      adp:  sleeperId ? ((T.leagueAdp?.map?.[sleeperId]) ?? (S.players[sleeperId]?.search_rank ?? '')) : '',
      _adpFromFile: false,
      tier: singleList ? String(p.tier ?? '') : '',
    };
  });
}
