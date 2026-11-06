// Trades tab

// ── 1. Trades ─────────────────────────────────────────────────────────────────
async function renderTrades() {
  if (!S.token && !S.auth?.has_token) {
    if (S.auth) {
      setC(`<div class="empty-state">
        <p>Add your Sleeper auth token in <a href="/myprofile" style="color:var(--gold-light);">your profile</a> to see pending trades</p>
      </div>`);
    } else {
      setC(`<div class="empty-state">
        <p>Paste your Sleeper auth token above to see pending trades</p>
        <p style="margin-top:10px;font-size:0.85rem;color:var(--brown-light);font-family:'Crimson Text',serif;font-style:italic;">
          sleeper.com → DevTools → Network → any graphql request → Authorization header
        </p>
      </div>`);
    }
    return;
  }
  setC(loading('Scanning leagues for pending trades'));
  try {
    await loadPlayers();
    const rosterIds = {};
    await Promise.all(S.leagues.map(async lg => {
      try {
        const rosters = await api('/league/' + lg.league_id + '/rosters');
        const mine = (rosters || []).find(r => r.owner_id === S.userId);
        if (mine) rosterIds[lg.league_id] = mine.roster_id;
      } catch(_) {}
    }));

    const GQL = `query league_transactions_filtered {
      league_transactions_filtered(league_id: $LID, roster_id_filters: [$RID], type_filters: ["trade"], leg_filters: [], status_filters: []){
        adds consenter_ids created creator draft_picks drops league_id leg metadata roster_ids settings status status_updated transaction_id type waiver_budget
      }
    }`;

    const results = await Promise.allSettled(S.leagues.map(async lg => {
      const rid = rosterIds[lg.league_id];
      if (!rid) return [];
      const data = await gql('league_transactions_filtered', GQL.replace('$LID', `"${lg.league_id}"`).replace('$RID', rid));
      return (data?.league_transactions_filtered || [])
        .filter(t => t.status === 'proposed' && (!t.settings?.expires_at || t.settings.expires_at * 1000 > Date.now()))
        .map(t => ({ ...t, _lgId: lg.league_id, _lgName: lg.name, _myRid: rid }));
    }));

    const all = results.flatMap(r => r.status === 'fulfilled' ? r.value : []).sort((a,b) => b.created - a.created);
    if (!all.length) { setC('<div class="empty-state"><p>No pending trades found</p></div>'); return; }

    const lgIds = [...new Set(all.map(t => t._lgId))];
    const rMaps = {};
    await Promise.all(lgIds.map(async id => {
      try {
        const [rosters, users] = await Promise.all([ api('/league/' + id + '/rosters'), api('/league/' + id + '/users') ]);
        const uMap = Object.fromEntries((users || []).map(u => [u.user_id, u.display_name || u.username]));
        rMaps[id] = Object.fromEntries((rosters || []).map(r => [r.roster_id, uMap[r.owner_id] || 'Team ' + r.roster_id]));
      } catch(_) {}
    }));

    setC(all.map(t => {
      const rMap  = rMaps[t._lgId] || {};
      const sides = tradeSides(t, rMap, t._myRid);
      const detail = S.leagueDetails[t._lgId];
      const flags  = detail ? leagueFlags(detail) : [];
      const flagHtml = flags.length
        ? `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">${flags.map(f=>`<span class="badge badge-outline">${esc(f)}</span>`).join('')}</div>`
        : '';
      const isIncoming = t.creator !== S.userId;
      const dirBadge = `<span class="badge ${isIncoming ? 'badge-green' : 'badge-red'}" style="font-size:0.48rem;letter-spacing:0.1em;">${isIncoming ? '▼ Incoming' : '▲ Outgoing'}</span>`;
      return `<div class="card" style="border-left:3px solid ${isIncoming ? 'var(--green-light)' : 'var(--red)'};">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
          <span style="display:flex;align-items:center;gap:8px;">${dirBadge}<a href="https://sleeper.com/leagues/${esc(t._lgId)}/trades" target="_blank" class="card-link">${esc(t._lgName)}</a></span>
          <span class="badge badge-gold">${t.created ? timeAgo(t.created) : ''}</span>
        </div>
        ${flagHtml}
        <div class="trade-sides">
          <div><div class="trade-side-lbl">You receive</div>${sides[0].items.map(i=>`<div class="${i.cls}">${esc(i.txt)}</div>`).join('')}</div>
          <div class="trade-arrow">⇄</div>
          <div><div class="trade-side-lbl">${esc(sides[1].name)}</div>${sides[1].items.map(i=>`<div class="${i.cls}">${esc(i.txt)}</div>`).join('')}</div>
        </div>
        <div style="margin-top:10px;text-align:right;">
          <a class="ghost-btn" style="text-decoration:none;display:inline-block;" target="_blank"
             href="/trade-analyzer?league=${encodeURIComponent(t._lgId)}&t=${encodeURIComponent(tradeAssetsToParam(tradeAssetsFromSleeperTx(t)))}">⇄ Analyze</a>
        </div>
      </div>`;
    }).join(''));
  } catch(e) { setC(errHtml(e)); }
}

function tradeSides(t, rMap, myRid) {
  const sides = {};
  for (const [pid, rid] of Object.entries(t.adds || {})) {
    const key = String(rid);
    if (!sides[key]) sides[key] = { name: rMap[rid] || 'Team ' + rid, items: [] };
    const p = S.players[pid];
    sides[key].items.push({ cls: 'trade-player', txt: p ? p.full_name : 'Player ' + pid });
  }
  for (const pk of (t.draft_picks || [])) {
    if (typeof pk === 'string') {
      const parts = pk.split(',');
      const toRoster = parts[3], round = parts[2], season = parts[1];
      const key = String(toRoster);
      if (!sides[key]) sides[key] = { name: rMap[toRoster] || 'Team ' + toRoster, items: [] };
      const originalOwner = rMap[parts[0]] || (parts[0] !== toRoster ? 'Roster ' + parts[0] : null);
      const viaStr = originalOwner ? ` (via ${originalOwner})` : '';
      sides[key].items.push({ cls: 'trade-pick', txt: `${season} Rd ${round} pick${viaStr}` });
    } else if (pk && typeof pk === 'object') {
      const rid = String(pk.owner_id);
      if (!sides[rid]) sides[rid] = { name: rMap[pk.owner_id] || 'Team ' + pk.owner_id, items: [] };
      sides[rid].items.push({ cls: 'trade-pick', txt: `${pk.season} Rd ${pk.round} pick` });
    }
  }
  const keys = Object.keys(sides);
  const vals = Object.values(sides);
  // Always put my side first (what I receive on the left)
  if (myRid && keys.length === 2 && keys[1] === String(myRid)) {
    return [vals[1], vals[0]];
  }
  return [vals[0] || { name: '—', items: [] }, vals[1] || { name: '—', items: [] }];
}
