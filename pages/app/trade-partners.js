// Trade Partners tab

// ── 8. Trade Partners ─────────────────────────────────────────────────────────

function renderTradePartners() {
  const u1IsFixed = !!S.auth?.sleeper_username;
  const inputStyle = 'max-width:220px;';
  const user1Field = u1IsFixed
    ? `<span class="search-input" style="${inputStyle}display:inline-block;cursor:default;">${esc(S.auth.sleeper_username)}</span>`
    : `<input id="tp-u1" class="search-input" placeholder="User 1 username…" style="${inputStyle}" onkeydown="if(event.key==='Enter')doTradePartners()" />`;
  setC(`<div>
    <div class="section-head"><h2>Trade Partners</h2><div class="section-head-line"></div></div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px;">
      ${user1Field}
      <span style="color:var(--brown-light);font-family:'Rye',serif;font-size:0.6rem;">vs</span>
      <input id="tp-u2" class="search-input" placeholder="User 2 username…" style="${inputStyle}"
        onkeydown="if(event.key==='Enter')doTradePartners()" />
      <button class="setup-btn" onclick="doTradePartners()">Find</button>
    </div>
    <div id="tp-results"></div>
  </div>`);
}

async function doTradePartners() {
  const u1 = S.auth?.sleeper_username || document.getElementById('tp-u1')?.value.trim();
  const u2 = document.getElementById('tp-u2').value.trim();
  const r  = document.getElementById('tp-results');
  if (!u1 || !u2) { r.innerHTML = errHtml(new Error('Enter both usernames')); return; }
  r.innerHTML = loading('Looking up users…');
  try {
    const nflState = await getNflState();
    const season = nflState.league_create_season || nflState.season;
    const [usr1, usr2] = await Promise.all([api('/user/' + u1), api('/user/' + u2)]);
    if (!usr1?.user_id) throw new Error('User "' + u1 + '" not found');
    if (!usr2?.user_id) throw new Error('User "' + u2 + '" not found');
    TP.user1Id = usr1.user_id;
    TP.user2Id = usr2.user_id;

    const [lgs1, lgs2] = await Promise.all([
      api('/user/' + TP.user1Id + '/leagues/nfl/' + season),
      api('/user/' + TP.user2Id + '/leagues/nfl/' + season),
    ]);
    TP.user1Leagues = lgs1 || [];
    TP.user2Leagues = lgs2 || [];

    const set2 = new Set((lgs2 || []).map(l => l.league_id));
    const common = (lgs1 || []).filter(l => set2.has(l.league_id));

    const allMap = {};
    [...TP.user1Leagues, ...TP.user2Leagues].forEach(l => { allMap[l.league_id] = l; });
    TP.allLeagues = Object.values(allMap);
    TP.commonLeagues = common;

    const commonHtml = common.length
      ? `<div class="pf-theirs">${common.map(l => `<div class="data-row">
          <a href="/trade-analyzer?league=${encodeURIComponent(l.league_id)}" class="row-link">${esc(l.name)}</a>
          <span class="card-meta">${l.total_rosters} teams</span>
        </div>`).join('')}</div>`
      : '<div class="empty-state" style="padding:12px;"><p>No leagues in common</p></div>';

    TP.u1Label = usr1.display_name || u1;
    TP.u2Label = usr2.display_name || u2;
    r.innerHTML = `
      <div class="section-head" style="margin-bottom:12px;">
        <h2>Common Leagues (${common.length})</h2><div class="section-head-line"></div>
      </div>
      <div style="margin-bottom:24px;">${commonHtml}</div>
      <div class="section-head" style="margin-bottom:12px;">
        <h2>Player Search</h2><div class="section-head-line"></div>
      </div>
      <div style="margin-bottom:12px;">
        <div class="player-ac-wrap" id="tp-ac">
          <input id="tp-ps" class="search-input" placeholder="Search player name…"
            oninput="showPlayerDropdown('tp-ps', 'tp-dropdown', 'tpSelectPlayer')" autocomplete="off" />
          <div class="player-dropdown" id="tp-dropdown" style="display:none;"></div>
        </div>
      </div>
      <div id="tp-ps-r"><div class="empty-state"><p>Search and select a player to see who has them</p></div></div>
    `;
    document.addEventListener('click', _tpOutsideClick);
  } catch(e) { r.innerHTML = errHtml(e); }
}

function _tpOutsideClick(e) {
  const ac = document.getElementById('tp-ac');
  if (!ac) { document.removeEventListener('click', _tpOutsideClick); return; }
  if (!ac.contains(e.target)) document.getElementById('tp-dropdown').style.display = 'none';
}


async function tpSelectPlayer(pid) {
  document.getElementById('tp-dropdown').style.display = 'none';
  const player = S.players[pid];
  if (!player) return;
  document.getElementById('tp-ps').value = player.full_name;
  const r = document.getElementById('tp-ps-r');
  r.innerHTML = loading('Checking rosters…');

  const none = `<span style="font-style:italic;color:var(--brown-light);font-size:0.9rem;">Not owned</span>`;

  try {
    const rData = await Promise.all(TP.commonLeagues.map(lg =>
      api('/league/' + lg.league_id + '/rosters').then(rs => ({ lg, rs: rs || [] })).catch(() => null)
    ));

    const u1Has = [], u2Has = [];
    for (const rd of rData) {
      if (!rd) continue;
      const r1 = rd.rs.find(ro => ro.owner_id === TP.user1Id);
      const r2 = rd.rs.find(ro => ro.owner_id === TP.user2Id);
      if (r1?.players?.includes(pid)) u1Has.push({ name: rd.lg.name, id: rd.lg.league_id });
      if (r2?.players?.includes(pid)) u2Has.push({ name: rd.lg.name, id: rd.lg.league_id });
    }
    if (!u1Has.length && !u2Has.length) {
      r.innerHTML = '<div class="empty-state"><p>Neither user has that player in shared leagues</p></div>'; return;
    }

    const colStyle = 'min-width:0;';
    const mkRows = arr => arr.map(l => `<div class="data-row"><a href="/trade-analyzer?league=${encodeURIComponent(l.id)}" class="row-link">${esc(l.name)}</a></div>`).join('');
    r.innerHTML = `<div style="margin-bottom:14px;background:var(--brown-dark);border:1px solid var(--brown-mid);border-radius:2px;padding:12px 16px;">
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <span class="card-title">${esc(player.full_name)}</span>
        <span class="card-meta">${esc(player.position||'')} · ${esc(player.team||'FA')}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div style="${colStyle}"><div class="sect">${esc(TP.u1Label)}</div>${u1Has.length ? mkRows(u1Has) : none}</div>
        <div style="${colStyle}"><div class="sect">${esc(TP.u2Label)}</div>${u2Has.length ? mkRows(u2Has) : none}</div>
      </div>
    </div>`;
  } catch(e) { r.innerHTML = errHtml(e); }
}
