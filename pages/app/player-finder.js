// Player Finder tab

// ── 2. Player Finder ──────────────────────────────────────────────────────────
function renderPlayerSearch() {
  setC(`<div>
    <div class="search-wrap">
      <div class="player-ac-wrap" id="pf-ac">
        <input type="text" id="ps" class="search-input" placeholder="Search player to target…"
          oninput="showPlayerDropdown('ps', 'pf-dropdown', 'pfSelectPlayer')" autocomplete="off" autofocus />
        <div class="player-dropdown" id="pf-dropdown" style="display:none;"></div>
      </div>
    </div>
    <div id="ps-r"><div class="empty-state"><p>Search and select a player to see where they stand across all your leagues</p></div></div>
  </div>`);
  document.addEventListener('click', _pfOutsideClick);
}

function _pfOutsideClick(e) {
  const ac = document.getElementById('pf-ac');
  if (!ac) { document.removeEventListener('click', _pfOutsideClick); return; }
  if (!ac.contains(e.target)) document.getElementById('pf-dropdown').style.display = 'none';
  const ac2 = document.getElementById('pf-ac2');
  if (ac2 && !ac2.contains(e.target)) {
    const dd2 = document.getElementById('pf-dropdown2');
    if (dd2) dd2.style.display = 'none';
  }
}

// Name search dropdown under a text box; a click calls `onPick` (a global function's name) with the pid.
async function showPlayerDropdown(inputId, dropdownId, onPick) {
  const q = document.getElementById(inputId)?.value.trim().toLowerCase();
  const dd = document.getElementById(dropdownId);
  if (!dd) return;
  if (!q || q.length < 2) { dd.style.display = 'none'; return; }
  await loadPlayers();
  const matches = Object.entries(S.players)
    .filter(([,p]) => p.full_name?.toLowerCase().includes(q))
    .sort((a,b) => {
      const aS = a[1].full_name.toLowerCase().startsWith(q) ? 0 : 1;
      const bS = b[1].full_name.toLowerCase().startsWith(q) ? 0 : 1;
      return aS - bS || a[1].full_name.localeCompare(b[1].full_name);
    }).slice(0, 12);
  if (!matches.length) { dd.style.display = 'none'; return; }
  dd.innerHTML = matches.map(([pid, p]) =>
    `<div class="player-dropdown-item" onmousedown="${onPick}('${esc(pid)}')">`+
    `${esc(p.full_name)} <span class="player-dropdown-meta">${esc(p.position||'')} · ${esc(p.team||'FA')}</span></div>`
  ).join('');
  dd.style.display = 'block';
}


function pfSelectMyPlayer(pid) {
  const dd2 = document.getElementById('pf-dropdown2');
  if (dd2) dd2.style.display = 'none';
  const p = S.players[pid];
  if (!p) return;
  const inp = document.getElementById('ps2');
  if (inp) inp.value = p.full_name;
  PF.myPid = pid;
  PF.expanded = null;
  pfRenderResults();
}

function pfClearMyPlayer() {
  PF.myPid = null;
  PF.expanded = null;
  pfRenderResults();
}

async function pfSelectPlayer(pid) {
  document.getElementById('pf-dropdown').style.display = 'none';
  const player = S.players[pid];
  if (!player) return;
  document.getElementById('ps').value = player.full_name;
  PF.targetPid = pid;
  PF.myPid = null;
  PF.expanded = null;
  const r = document.getElementById('ps-r');
  r.innerHTML = loading('Checking all leagues');
  try {
    const statsP = ppgLoadStats();
    PF.allRosterData = await Promise.all(S.leagues.map(lg =>
      Promise.all([ api('/league/' + lg.league_id + '/rosters'), api('/league/' + lg.league_id + '/users') ])
        .then(([rs, us]) => {
          const uMap = Object.fromEntries((us || []).map(u => [u.user_id, u.display_name || u.username]));
          return { lg, rs: rs || [], uMap };
        }).catch(() => null)
    ));
    await statsP;
    pfRenderResults();
    pfLoadOdds();
  } catch(e) { r.innerHTML = errHtml(e); }
}

// ── Playoff odds beside every team ──
// Whether the owner is contending or selling is the first thing to know before
// making an offer, so each team listed carries League Summaries' playoff odds —
// the same per-roster map and the same Contender/Rebuilder badge Mass Offers and
// Scout show. The list renders straight away; odds paint into the .pf-odds slots
// when the sim (cached for 24h, up to a minute cold) is done, without a re-render
// that would collapse any open roster comparison.
async function pfLoadOdds() {
  const ids = [...new Set((PF.allRosterData || []).filter(Boolean).map(rd => rd.lg.league_id))];
  if (!ids.length || PF.oddsLoading) return pfPaintOdds();
  PF.oddsLoading = true; pfPaintOdds();
  try { await lsEnsureOddsFor(ids); } catch (e) { console.error('[Player Finder odds]', e); }
  PF.oddsLoading = false; pfPaintOdds();
}

function pfOddsSlot(lgId, rid) {
  return `<span class="pf-odds" data-lg="${esc(lgId)}" data-rid="${rid}"></span>`;
}

function pfPaintOdds() {
  if (S.tab !== 'player') return;
  for (const el of document.querySelectorAll('.pf-odds')) {
    const odds = moTeamOdds(el.dataset.lg, Number(el.dataset.rid));
    el.innerHTML = odds != null
      ? scoutClassBadge(scoutClassify(odds, el.dataset.lg), odds)
      : PF.oddsLoading ? '<span class="card-meta">odds…</span>' : '';
  }
}

function pfRenderResults() {
  const pid    = PF.targetPid;
  const player = S.players[pid];
  if (!player || !PF.allRosterData) return;

  const mine = [], theirs = [], free = [];
  for (const rd of PF.allRosterData) {
    if (!rd) continue;
    let found = false;
    for (const roster of rd.rs) {
      if (!roster.players?.includes(pid)) continue;
      found = true;
      if (roster.owner_id === S.userId) {
        mine.push({ lgName: rd.lg.name, lgId: rd.lg.league_id, rid: roster.roster_id, starter: roster.starters?.includes(pid) });
      } else {
        theirs.push({ lgName: rd.lg.name, lgId: rd.lg.league_id, ownerName: rd.uMap[roster.owner_id] || 'Unknown', theirRosterId: roster.roster_id });
      }
      break;
    }
    if (!found) free.push({ name: rd.lg.name, lgId: rd.lg.league_id });
  }
  // No sort: PF.allRosterData is built by mapping S.leagues, so each list already
  // reads in Sleeper's own league order (ESPN appended) — the order every other
  // league listing in the app uses. Alphabetizing here made this the odd one out.

  // Trade targets: leagues where I have player 2 AND someone else has player 1
  let tradeTargets = [];
  if (PF.myPid) {
    const myP2Leagues = new Set();
    for (const rd of PF.allRosterData) {
      if (!rd) continue;
      for (const roster of rd.rs) {
        if (roster.owner_id === S.userId && roster.players?.includes(PF.myPid)) {
          myP2Leagues.add(rd.lg.league_id);
          break;
        }
      }
    }
    tradeTargets = theirs.filter(t => myP2Leagues.has(t.lgId));
  }

  const p2 = PF.myPid ? S.players[PF.myPid] : null;

  // Season PPG in the header. This view spans every league at once, so there is
  // no one league's scoring to use — passing no scoring falls back to
  // PPG_PPR_SCORING, so the figure is LABELLED ppr rather than left to look
  // league-specific. The per-league number lives on the Lineup Checker and the
  // Injury Swap chooser, where a league is actually selected.
  const pfPpg = playerSeasonPpg(pid, {});
  const pfGp  = pfPpg === null ? 0 : playerSeasonGp(pid);

  const r = document.getElementById('ps-r');
  r.innerHTML = `<div style="margin-bottom:16px;">
    <div style="background:var(--brown-dark);border:1px solid var(--brown-mid);border-radius:2px;padding:12px 16px;margin-bottom:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <span class="card-title">${esc(player.full_name)}</span>
      <span class="card-meta">${esc(player.position||'')} · ${esc(player.team||'FA')}</span>
      ${pfPpg === null ? '' : `<span class="pf-ppg" title="Season-to-date PPG, full PPR — ${pfPpg.toFixed(1)} over ${pfGp} game${pfGp === 1 ? '' : 's'} played">${pfPpg.toFixed(1)} <em>ppg · ppr</em></span>`}
    </div>

    <div class="pf-p2-wrap">
      <div class="sect" style="margin-top:0;margin-bottom:6px;">Filter by player I'm offering</div>
      <div class="pf-p2-row">
        <div class="player-ac-wrap" id="pf-ac2" style="flex:1;min-width:180px;position:relative;">
          <input type="text" id="ps2" class="search-input"
            placeholder="Search a player I own (optional)…"
            oninput="showPlayerDropdown('ps2', 'pf-dropdown2', 'pfSelectMyPlayer')" autocomplete="off"
            value="${p2 ? esc(p2.full_name) : ''}" />
          <div class="player-dropdown" id="pf-dropdown2" style="display:none;position:absolute;top:100%;left:0;right:0;z-index:200;"></div>
        </div>
        ${p2 ? `<button class="ghost-btn" onclick="pfClearMyPlayer()" style="flex-shrink:0;">✕ Clear</button>` : ''}
      </div>
    </div>

    ${PF.myPid ? pfTradeTargetsHtml(tradeTargets, player, p2) : ''}

    ${mine.length ? `<div class="sect">On your roster</div><div class="pf-mine">${mine.map(f=>`
      <div class="data-row">
        <a href="https://sleeper.com/leagues/${esc(f.lgId)}/team" target="_blank" class="row-link">${esc(f.lgName)}</a>
        <span style="display:flex;align-items:center;gap:6px;">${pfOddsSlot(f.lgId, f.rid)}${injuryBadge(player.injury_status)}<span class="badge ${f.starter?'badge-green':'badge-outline'}">${f.starter?'Starting':'Bench'}</span></span>
      </div>`).join('')}</div>` : ''}

    ${theirs.length ? `<div class="sect">On other rosters</div><div class="pf-trade-list">${theirs.map(f => `
      <div class="pf-trade-card" id="pf-or-tc-${esc(f.lgId)}">
        <div class="pf-trade-header" onclick="pfToggleOtherRoster('${esc(f.lgId)}', ${f.theirRosterId})">
          <span class="pf-trade-chevron" id="pf-or-chev-${esc(f.lgId)}">›</span>
          <span style="font-family:'Crimson Text',serif;font-size:0.95rem;color:var(--parchment);">${esc(f.lgName)}</span>
          <span class="card-meta">${esc(f.ownerName)}</span>
          ${pfOddsSlot(f.lgId, f.theirRosterId)}
        </div>
        <div id="pf-or-compare-${esc(f.lgId)}" style="display:none;"></div>
      </div>`).join('')}</div>` : ''}

    ${free.length ? `<div class="sect">Free agent in</div><div class="pf-free">${free.map(f=>`
      <div class="data-row">
        <a href="https://sleeper.com/leagues/${esc(f.lgId)}" target="_blank" class="row-link">${esc(f.name)}</a>
        <span class="badge badge-green">Available</span>
      </div>`).join('')}</div>` : ''}

    ${!mine.length && !theirs.length ? '<div class="empty-state" style="margin-top:12px;"><p>Player not found on any roster</p></div>' : ''}
  </div>`;
  pfPaintOdds();
}

function pfTradeTargetsHtml(targets, targetPlayer, myPlayer) {
  const count = targets.length;
  const header = `<div class="sect">Trade Targets — ${count} league${count !== 1 ? 's' : ''} where I have ${esc(myPlayer.full_name)} &amp; ${esc(targetPlayer.full_name)} is available</div>`;
  if (!count) {
    return header + `<div style="font-family:'Crimson Text',serif;font-size:0.9rem;color:var(--brown-light);font-style:italic;padding:4px 0 8px;">No leagues match — you may already own ${esc(targetPlayer.full_name)}, or ${esc(myPlayer.full_name)} isn't on your roster in any league where ${esc(targetPlayer.full_name)} is owned by someone else.</div>`;
  }
  return header + `<div class="pf-trade-list">${targets.map(t => `
    <div class="pf-trade-card" id="pf-tc-${esc(t.lgId)}">
      <div class="pf-trade-header" onclick="pfToggleComparison('${esc(t.lgId)}', ${t.theirRosterId})">
        <span class="pf-trade-chevron" id="pf-chev-${esc(t.lgId)}">›</span>
        <span style="font-family:'Crimson Text',serif;font-size:0.95rem;color:var(--parchment);">${esc(t.lgName)}</span>
        <span class="card-meta">vs. ${esc(t.ownerName)}</span>
        ${pfOddsSlot(t.lgId, t.theirRosterId)}
      </div>
      <div id="pf-compare-${esc(t.lgId)}" style="display:none;"></div>
    </div>`).join('')}
  </div>`;
}

async function pfLoadComparisonData(lgId, theirRosterId) {
  await loadPlayers();

  // Lazy-load FC values
  if (!PF.fcMap) {
    const fc = await fetch('/api/fantasycalc').then(r => r.ok ? r.json() : []);
    PF.fcMap = {};
    for (const item of (Array.isArray(fc) ? fc : [])) {
      const sid = item.player?.sleeperId || item.player?.maybeSleeperID;
      if (sid) PF.fcMap[String(sid)] = item.value ?? 0;
    }
  }

  const rd = PF.allRosterData?.find(d => d?.lg?.league_id === lgId);
  if (!rd) throw new Error('League data not found');

  const myRoster    = rd.rs.find(r => r.owner_id === S.userId);
  const theirRoster = rd.rs.find(r => r.roster_id === theirRosterId);
  if (!myRoster || !theirRoster) throw new Error('Could not locate rosters');

  const nflSeason = S.nflState?.season || new Date().getFullYear().toString();
  let tradedPicks = [], ridToSlot = null;
  try {
    const [draftsRes, tradedRes] = await Promise.all([
      fetch(`/api/sleeper/league/${lgId}/drafts`),
      fetch(`/api/sleeper/league/${lgId}/traded_picks`),
    ]);
    tradedPicks = tradedRes.ok  ? (await tradedRes.json()  || []) : [];
    const drafts = draftsRes.ok ? (await draftsRes.json() || []) : [];
    const curDraft = drafts.find(d => d.season === nflSeason);
    const rawSlots = curDraft?.slot_to_roster_id;
    if (rawSlots && Object.keys(rawSlots).length > 0) {
      ridToSlot = {};
      for (const [slot, rid] of Object.entries(rawSlots)) ridToSlot[String(rid)] = parseInt(slot);
    }
  } catch { /* picks won't be shown */ }

  const myData    = pfBuildRosterData(myRoster,    rd.rs, tradedPicks, ridToSlot, nflSeason);
  const theirData = pfBuildRosterData(theirRoster, rd.rs, tradedPicks, ridToSlot, nflSeason);
  const theirName = rd.uMap[theirRoster.owner_id] || 'Opponent';

  return { myData, theirData, theirName };
}

// Expand one roster comparison under a Player Finder row, closing the open one.
// `stateKey` is the PF field remembering it, `prefix` the element-id family.
async function pfToggleRosterPanel(lgId, theirRosterId, stateKey, prefix) {
  const container = document.getElementById(`${prefix}compare-${lgId}`);
  const chevron   = document.getElementById(`${prefix}chev-${lgId}`);
  if (!container) return;

  if (PF[stateKey] === lgId) {
    PF[stateKey] = null;
    container.style.display = 'none';
    if (chevron) { chevron.textContent = '›'; chevron.classList.remove('open'); }
    return;
  }

  // Close previously expanded panel
  if (PF[stateKey]) {
    const prev = document.getElementById(`${prefix}compare-${PF[stateKey]}`);
    const prevChev = document.getElementById(`${prefix}chev-${PF[stateKey]}`);
    if (prev) prev.style.display = 'none';
    if (prevChev) { prevChev.textContent = '›'; prevChev.classList.remove('open'); }
  }

  PF[stateKey] = lgId;
  container.style.display = 'block';
  if (chevron) { chevron.textContent = '›'; chevron.classList.add('open'); }
  container.innerHTML = `<div class="pf-compare-wrap">${loading('Loading rosters…')}</div>`;

  try {
    const { myData, theirData, theirName } = await pfLoadComparisonData(lgId, theirRosterId);
    container.innerHTML = pfCompareHtml(myData, theirData, theirName, lgId, theirRosterId);
  } catch(e) {
    container.innerHTML = `<div class="pf-compare-wrap">${errHtml(e)}</div>`;
  }
}
function pfToggleComparison(lgId, theirRosterId)  { return pfToggleRosterPanel(lgId, theirRosterId, 'expanded', 'pf-'); }
function pfToggleOtherRoster(lgId, theirRosterId) { return pfToggleRosterPanel(lgId, theirRosterId, 'expandedOther', 'pf-or-'); }

function pfBuildRosterData(roster, allRosters, tradedPicks, ridToSlot, nflSeason) {
  const starters = new Set(roster.starters || []);
  const groups   = { QB: [], RB: [], WR: [], TE: [], PICK: [] };

  for (const pid of (roster.players || [])) {
    const player = S.players[pid];
    if (!player) continue;
    const pos = crNormPos(player.position);
    if (!['QB','RB','WR','TE'].includes(pos)) continue;
    groups[pos].push({
      name:      player.full_name || player.last_name || pid,
      fcVal:     PF.fcMap?.[String(pid)] ?? null,
      isStarter: starters.has(pid),
    });
  }
  for (const pos of ['QB','RB','WR','TE']) {
    groups[pos].sort((a,b) => (b.fcVal ?? -1) - (a.fcVal ?? -1));
  }

  const picks = ownedPicks({ rosterId: roster.roster_id, rosters: allRosters, tradedPicks, firstSeason: parseInt(nflSeason) + 1, rounds: 2 });
  for (const pick of picks) {
    const { round, season } = pick;
    const roundStr = round === 1 ? '1st' : '2nd';
    let label;
    if (ridToSlot) {
      const slot = ridToSlot[String(pick.orig)];
      label = slot ? `${season} ${round}.${String(slot).padStart(2,'0')}` : `${season} ${roundStr}`;
    } else {
      label = `${season} ${roundStr}`;
    }
    groups.PICK.push({ name: label, fcVal: null, isStarter: false });
  }
  groups.PICK.sort((a,b) => a.name.localeCompare(b.name));

  return { groups };
}

function pfCompareHtml(myData, theirData, theirName, lgId, theirRosterId) {
  const POS_ORDER = ['QB','RB','WR','TE','PICK'];
  const posColorClass = { QB:'rs-pos-QB', RB:'rs-pos-RB', WR:'rs-pos-WR', TE:'rs-pos-TE', PICK:'rs-pos-PICK' };

  const renderSide = (groups, pos) => {
    const items = groups[pos] || [];
    if (!items.length) return `<div class="pf-empty-pos">None</div>`;
    return items.map(item => {
      const valStr = item.fcVal != null ? Number(item.fcVal).toLocaleString() : '—';
      return `<div class="pf-player-row${item.isStarter ? ' starter' : ''}">
        ${item.isStarter ? `<span style="color:var(--gold);font-size:0.7rem;flex-shrink:0;">★</span>` : ''}
        <span class="pf-player-name">${esc(item.name)}</span>
        <span class="pf-player-val">${valStr}</span>
      </div>`;
    }).join('');
  };

  const sections = POS_ORDER.map(pos => `
    <div class="pf-pos-section">
      <div class="pf-pos-label-row"><span class="rs-pos ${posColorClass[pos]}">${pos}</span></div>
      <div class="pf-pos-content-row">
        <div class="pf-compare-col">${renderSide(myData.groups, pos)}</div>
        <div class="pf-compare-col">${renderSide(theirData.groups, pos)}</div>
      </div>
    </div>`).join('');

  return `<div class="pf-compare-wrap">
    <div class="pf-compare-header-row">
      <div class="pf-compare-col-header">My Roster</div>
      <div class="pf-compare-col-header">${esc(theirName)}'s Roster</div>
    </div>
    ${sections}
    <div class="pf-compare-footer">
      <a href="https://sleeper.com/leagues/${esc(lgId)}" target="_blank" class="pf-compare-link">View League on Sleeper</a>
      <a href="/trade-analyzer?league=${encodeURIComponent(lgId)}&b=${theirRosterId}" target="_blank" class="pf-compare-link">Open in Trade Analyzer ⇄</a>
    </div>
  </div>`;
}
