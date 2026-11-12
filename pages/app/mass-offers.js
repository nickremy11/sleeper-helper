// Mass Offers tab

// ── 1b. Mass Offers ───────────────────────────────────────────────────────────
// Bulk trade offers on top of shared-utils' sleeperProposeTrade + sleeperSendTradeDm:
//   sell — one of my players, one league: the same ask sent to every other manager
//   buy  — someone else's player, every league he's rostered in: the same offer to each owner
// The pick side is "a pick of round N": the earliest season the giving team owns one,
// their own pick first, else one they acquired. Every offer is editable and
// deselectable before sending; nothing goes out without the confirm step. Sleeper only.
const MO = {
  mode: 'sell',       // 'sell' | 'buy'
  pid: null,
  lgId: null,         // sell: the league being shopped
  round: 3,
  offers: [],         // [{id, lgId, rid (their roster), assets, sel, note, status, msg, dm}]
  editId: null,
  confirm: false,
  building: false,
  sending: false, sendTotal: 0, sendDone: 0,
  err: '',
  data: {},           // {lgId: {league, rosters, users, traded, drafts}} — users/traded/drafts loaded on build
  rostersAt: 0, loadingRosters: false, _rosterP: null,
  oddsLoading: false, oddsErr: '',   // the opt-in playoff-odds load — see moLoadOdds
};
const MO_TTL          = 5 * 60 * 1000;
const MO_PICK_SEASONS = 3;     // future seasons of picks considered tradeable
const MO_SEND_GAP_MS  = 700;   // pause between sends — this is ~70 writes in a row at worst
const MO_ROUNDS       = [1, 2, 3, 4, 5];
const MO_POS_ORDER    = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'];

function moLeagues() { return S.leagues.filter(lg => lg.source !== 'espn'); }
function moOrd(n) { return n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : n + 'th'; }

// My roster in a league — owner or co-owner.
function moMyRoster(d) {
  return (d?.rosters || []).find(r => r.owner_id === S.userId || (r.co_owners || []).includes(S.userId)) || null;
}

// Why a league can't take trade offers right now, or null.
function moTradeBlock(d) {
  const lg = d?.league;
  if (!d?.rosters || !lg) return 'couldn’t load this league';
  if (lg.settings?.type === 3) return 'guillotine league';
  if (lg.status === 'complete') return 'season is over';
  if (lg.settings?.disable_trades) return 'trades are disabled';
  const dl = lg.settings?.trade_deadline, st = S.nflState;
  if (dl != null && dl < 99 && st?.season_type === 'regular' && String(lg.season) === String(st.season) && (st.leg ?? st.week) > dl) {
    return `past the week ${dl} trade deadline`;
  }
  return null;
}

// Rosters + league settings for every Sleeper league — enough to find who has a player.
function moLoadRosters(force) {
  if (!force && Date.now() - MO.rostersAt < MO_TTL) return Promise.resolve();
  if (MO._rosterP) return MO._rosterP;
  MO.loadingRosters = true;
  MO._rosterP = (async () => {
    await getNflState();
    await Promise.all(moLeagues().map(async lg => {
      const id = lg.league_id;
      const d = MO.data[id] = MO.data[id] || {};
      try {
        const [league, rosters] = await Promise.all([
          S.leagueDetails[id]?.settings ? S.leagueDetails[id] : api('/league/' + id),
          api('/league/' + id + '/rosters'),
        ]);
        d.league = league; d.rosters = rosters || [];
      } catch { d.rosters = d.rosters || null; }
    }));
    MO.rostersAt = Date.now();
  })().finally(() => { MO.loadingRosters = false; MO._rosterP = null; });
  return MO._rosterP;
}

// Users (names + the trade DM), traded picks and drafts (pick ownership) for the leagues an offer touches.
async function moLoadExtras(lgIds) {
  await Promise.all(lgIds.map(async id => {
    const d = MO.data[id];
    if (!d || (d.users && d.traded && d.drafts)) return;
    const [users, traded, drafts] = await Promise.all([
      api(`/league/${id}/users`).catch(() => null),
      api(`/league/${id}/traded_picks`).catch(() => null),
      api(`/league/${id}/drafts`).catch(() => []),
    ]);
    d.users = users; d.traded = traded; d.drafts = drafts || [];
  }));
}

// ── Pick ownership ──
// First tradeable season: this season's draft while it hasn't started, else next season's.
function moFirstPickSeason(lg) {
  const yr = parseInt(lg.season);
  return lg.status === 'pre_draft' ? yr : yr + 1;
}
// Rounds in a rookie draft. A draft of more than 10 rounds is a startup, which says
// nothing about later drafts — then fall back to the deepest traded pick, then 4.
function moNumRounds(d) {
  const first = moFirstPickSeason(d.league);
  const ok = r => r && r <= 10 ? r : null;
  const drafts = d.drafts || [];
  return ok(drafts.find(x => x.season === String(first))?.settings?.rounds)
      || ok(drafts.find(x => x.season === String(d.league.season))?.settings?.rounds)
      || (d.traded || []).reduce((m, tp) => parseInt(tp.season) >= first ? Math.max(m, tp.round || 0) : m, 0)
      || 4;
}
// Future picks aren't a thing in a plain redraft league mid-season.
function moPicksAllowed(lg) {
  const t = lg.settings?.type;
  return t === 1 || t === 2 || lg.status === 'pre_draft';
}
// Picks a roster holds: [{season, round, orig}]. Every team starts with its own, then
// traded_picks (one row per moved pick, owner_id = current holder) overrides. Needs
// d.traded — null (failed load) means ownership is unknown, so nothing is offered.
function moOwnedPicks(d, rid) {
  if (!d?.league || !d.rosters || !d.traded || !moPicksAllowed(d.league)) return [];
  return ownedPicks({
    rosterId: rid, rosters: d.rosters, tradedPicks: d.traded,
    firstSeason: moFirstPickSeason(d.league), seasons: MO_PICK_SEASONS, rounds: moNumRounds(d),
    windowOnly: true, ownerNames: rosterOwnerNames(d.rosters, d.users),
  });
}
// The pick of `round` a roster would give: earliest season, their own before an acquired one.
function moChoosePick(d, rid, round) {
  return moOwnedPicks(d, rid).filter(p => p.round === round)
    .sort((a, b) => a.season.localeCompare(b.season) || (b.orig === rid) - (a.orig === rid))[0] || null;
}

// ── Labels ──
function moTeamName(d, rid) {
  const ro = (d?.rosters || []).find(r => r.roster_id === rid);
  const u = (d?.users || []).find(x => x.user_id === ro?.owner_id);
  return u?.metadata?.team_name || u?.display_name || ('Team ' + rid);
}
function moAssetLabel(d, a) {
  if (a.kind === 'player') {
    const p = S.players[a.pid];
    return p ? `${sleeperName(p)} (${p.position || '?'})` : 'Player ' + a.pid;
  }
  return `${a.season} ${moOrd(a.round)}` + (a.orig !== a.from ? ` (via ${rosterOwnerNames(d?.rosters, d?.users)[a.orig]})` : '');
}
function moAssetKey(a) {
  return a.kind === 'player' ? `p~${a.pid}~${a.from}` : `k~${a.season}~${a.round}~${a.orig}~${a.from}`;
}

// ── Who am I offering this to? ──
// Deciding which of 11 managers to shop a player to is a question about their
// season, so every offer row carries the other team's record and playoff odds.

// Record is free — it's in the roster rows moLoadRosters already has.
// A 0-0 team is preseason, where a record is noise rather than context.
function moTeamRecord(d, rid) {
  const st = (d?.rosters || []).find(r => r.roster_id === rid)?.settings;
  if (!st) return null;
  const w = st.wins || 0, l = st.losses || 0, t = st.ties || 0;
  if (!w && !l && !t) return null;
  return t ? `${w}-${l}-${t}` : `${w}-${l}`;
}

// Odds are League Summaries' simulation — its full per-roster map, the same one
// Scout reads. Present for free once Summaries or Scout has run this session (or
// its 24h cache was restored); null otherwise, which moLoadOdds is the opt-in for.
function moTeamOdds(lgId, rid) {
  const o = LS.leagueData[lgId]?.allPlayoffOdds?.[rid];
  return o == null || Number.isNaN(o) ? null : o;
}

// Contender/rebuilder wording and colour come from scoutClassify + scoutClassBadge
// so a team reads the same here as it does on a Scout card, against the same
// user-configured thresholds. Called only with real odds — "Middle —" is not context.
function moContextHtml(d, o) {
  const rec  = moTeamRecord(d, o.rid);
  const odds = moTeamOdds(o.lgId, o.rid);
  const bits = [];
  if (rec) bits.push(`<span class="mo-ctx-rec">${rec}</span>`);
  // No odds is said once, by the header's "add playoff odds" link — a row each
  // would be a dozen identical lines saying nothing about this team.
  if (odds != null) bits.push(scoutClassBadge(scoutClassify(odds, o.lgId), odds));
  return bits.length ? `<div class="mo-ctx">${bits.join('')}</div>` : '';
}

function moOfferLeagueIds() { return [...new Set(MO.offers.map(o => o.lgId))]; }
function moOddsMissing()    { return moOfferLeagueIds().filter(id => !LS.leagueData[id]?.allPlayoffOdds).length; }

// Started automatically once the offer list is built, so every row has the other
// team's odds on screen before anything is sent. The list itself never waits on
// it — rows render with their record first and the odds fill in.
async function moLoadOdds() {
  if (MO.oddsLoading || MO.sending) return;
  MO.oddsLoading = true; MO.oddsErr = ''; moDraw();
  try {
    MO.oddsErr = await lsEnsureOddsFor(moOfferLeagueIds());
  } catch (e) {
    MO.oddsErr = e.message || String(e);
  }
  MO.oddsLoading = false; moDraw();
}

// ── League lists ──
function moSellLeagues() {
  return moLeagues().map(lg => {
    const d = MO.data[lg.league_id], me = moMyRoster(d);
    if (!me || !(me.players || []).includes(MO.pid)) return null;
    return { lgId: lg.league_id, name: lg.name, teams: d.rosters.length, block: moTradeBlock(d) };
  }).filter(Boolean);
}
function moBuyLeagues() {
  const rows = []; let mine = 0, fa = 0;
  for (const lg of moLeagues()) {
    const d = MO.data[lg.league_id], me = moMyRoster(d);
    if (!me) continue;
    if ((me.players || []).includes(MO.pid)) { mine++; continue; }
    const owner = d.rosters.find(r => (r.players || []).includes(MO.pid));
    if (!owner) { fa++; continue; }
    rows.push({ lgId: lg.league_id, name: lg.name, ownerRid: owner.roster_id,
                block: owner.owner_id ? moTradeBlock(d) : 'his team has no manager' });
  }
  return { rows, mine, fa };
}

// Both teams must send something — a one-sided offer is never what a mass offer means.
function moOfferValid(o) {
  const me = moMyRoster(MO.data[o.lgId])?.roster_id;
  return me != null && o.assets.some(a => a.from === me) && o.assets.some(a => a.from === o.rid);
}
function moSendable() { return MO.offers.filter(o => o.sel && o.status !== 'sent' && moOfferValid(o)); }

// ── Build ──
async function moBuild() {
  if (!MO.pid || MO.building || MO.sending) return;
  if (MO.offers.some(o => o.status === 'sent') &&
      !confirm('Rebuild the list? Offers already sent stay live in Sleeper; only their ✓ here is cleared.')) return;
  MO.building = true; MO.offers = []; MO.editId = null; MO.confirm = false; MO.err = '';
  moDraw();
  try {
    await moLoadRosters();
    const pid = MO.pid, round = MO.round, built = [];
    if (MO.mode === 'sell') {
      const d = MO.data[MO.lgId], me = moMyRoster(d);
      if (!me || !(me.players || []).includes(pid)) throw new Error('He’s no longer on your roster in this league');
      await moLoadExtras([MO.lgId]);
      for (const ro of d.rosters) {
        if (ro.roster_id === me.roster_id || !ro.owner_id) continue;
        const pick = moChoosePick(d, ro.roster_id, round);
        const assets = [{ kind: 'player', pid, from: me.roster_id, to: ro.roster_id }];
        if (pick) assets.push({ kind: 'pick', ...pick, from: ro.roster_id, to: me.roster_id });
        built.push({ lgId: MO.lgId, rid: ro.roster_id, assets, note: pick ? '' : `No ${moOrd(round)} round pick to ask for — edit to build an offer` });
      }
    } else {
      const rows = moBuyLeagues().rows.filter(r => !r.block);
      await moLoadExtras(rows.map(r => r.lgId));
      for (const r of rows) {
        const d = MO.data[r.lgId], me = moMyRoster(d);
        const pick = moChoosePick(d, me.roster_id, round);
        const assets = [{ kind: 'player', pid, from: r.ownerRid, to: me.roster_id }];
        if (pick) assets.push({ kind: 'pick', ...pick, from: me.roster_id, to: r.ownerRid });
        built.push({ lgId: r.lgId, rid: r.ownerRid, assets, note: pick ? '' : `You have no ${moOrd(round)} round pick here — edit to build an offer` });
      }
    }
    MO.offers = built.map((o, i) => ({ id: i, status: null, msg: '', dm: null, ...o }));
    for (const o of MO.offers) o.sel = moOfferValid(o);
  } catch (e) {
    MO.err = e.message;
  }
  MO.building = false;
  moDraw();
  if (MO.offers.length && moOddsMissing()) moLoadOdds();
}

// ── Send ──
// One at a time, in list order. Rosters + traded picks are re-read once per league
// right before its first send, and any offer whose assets have moved is failed
// instead of sent. The DM is best-effort and reported beside the ✓.
async function moSendAll() {
  if (MO.sending) return;
  const batch = moSendable();
  if (!batch.length) return;
  if (!GQL_URL) { MO.err = 'Sending isn’t available in local dev'; moDraw(); return; }
  MO.confirm = false; MO.editId = null; MO.sending = true;
  MO.sendTotal = batch.length; MO.sendDone = 0;
  for (const o of batch) { o.status = 'queued'; o.msg = ''; o.dm = null; }
  moDraw();
  const apiBase = GQL_URL.replace(/\/graphql$/, '');
  const token = S.token || undefined;
  const fresh = {};
  for (const [i, o] of batch.entries()) {
    if (i) await new Promise(r => setTimeout(r, MO_SEND_GAP_MS));
    o.status = 'sending'; moDraw();
    const d = MO.data[o.lgId];
    try {
      if (!fresh[o.lgId]) {
        const [rosters, traded] = await Promise.all([api(`/league/${o.lgId}/rosters`), api(`/league/${o.lgId}/traded_picks`)]);
        fresh[o.lgId] = { ...d, rosters: rosters || [], traded: traded || [] };
      }
      const f = fresh[o.lgId];
      const stale = o.assets.filter(a => a.kind === 'player'
        ? !((f.rosters.find(r => r.roster_id === a.from)?.players) || []).includes(a.pid)
        : !moOwnedPicks(f, a.from).some(p => p.season === String(a.season) && p.round === a.round && p.orig === a.orig));
      if (stale.length) throw new Error('No longer with the team sending them: ' + stale.map(a => moAssetLabel(d, a)).join(', '));

      const tx = await sleeperProposeTrade({ apiBase, token, leagueId: o.lgId, assets: o.assets });
      o.status = 'sent'; o.sel = false;
      try {
        const rosterOwners = Object.fromEntries(f.rosters.map(r => [r.roster_id, r.owner_id]));
        rosterOwners[moMyRoster(f).roster_id] = S.userId;   // co-owned roster: I'm the proposer
        await sleeperSendTradeDm({
          apiBase, token, tx, assets: o.assets, leagueId: o.lgId,
          leagueName: d.league?.name || '', leagueUsers: d.users || [],
          rosterOwners, players: S.players, myUserId: S.userId,
        });
        o.dm = { ok: true };
      } catch (e) {
        o.dm = { ok: false, msg: e.message };
      }
    } catch (e) {
      o.status = 'fail'; o.msg = e.message;
    }
    MO.sendDone++;
    moDraw();
  }
  MO.sending = false;
  moDraw();
}

// ── Actions ──
function moReset() { MO.offers = []; MO.editId = null; MO.confirm = false; MO.err = ''; }
function moSetMode(m) { if (MO.sending || MO.mode === m) return; MO.mode = m; MO.pid = null; MO.lgId = null; moReset(); moDraw(); }
function moClearPlayer() {
  if (MO.sending) return;
  MO.pid = null; MO.lgId = null; moReset(); moDraw();
  document.getElementById('mo-ps')?.focus();
}
function moPickPlayer(pid) {
  if (MO.sending) return;
  MO.pid = pid; MO.lgId = null; moReset();
  moLoadRosters().then(() => {
    if (MO.pid !== pid || MO.mode !== 'sell') return;
    const open = moSellLeagues().filter(x => !x.block);
    if (open.length === 1) MO.lgId = open[0].lgId;   // only one place to shop him — skip a click
  }).catch(e => { MO.err = e.message; }).finally(moDraw);
  moDraw();
}
function moSetLeague(id) { if (MO.sending) return; MO.lgId = id; moReset(); moDraw(); }
function moSetRound(r) {
  if (MO.sending || MO.round === r) return;
  MO.round = r;
  if (!MO.offers.some(o => o.status === 'sent')) moReset();   // the list is for the old round
  moDraw();
}
function moToggleSel(id) {
  const o = MO.offers.find(x => x.id === id);
  if (!o || MO.sending || o.status === 'sent' || !moOfferValid(o)) return;
  o.sel = !o.sel;
  moDrawOffer(o);
}
function moSelectAll(on) {
  if (MO.sending) return;
  for (const o of MO.offers) if (o.status !== 'sent') o.sel = on && moOfferValid(o);
  moDraw();
}
function moToggleEdit(id) { if (MO.sending) return; MO.editId = MO.editId === id ? null : id; moDraw(); }
function moToggleAsset(id, key) {
  const o = MO.offers.find(x => x.id === id);
  if (!o || MO.sending || o.status === 'sent') return;
  const me = moMyRoster(MO.data[o.lgId]).roster_id;
  const wasValid = moOfferValid(o);
  const i = o.assets.findIndex(a => moAssetKey(a) === key);
  if (i >= 0) o.assets.splice(i, 1);
  else {
    const f = key.split('~');
    const from = Number(f[f.length - 1]), to = from === me ? o.rid : me;
    o.assets.push(f[0] === 'p'
      ? { kind: 'player', pid: f[1], from, to }
      : { kind: 'pick', season: f[1], round: +f[2], orig: +f[3], from, to });
  }
  o.note = '';
  if (o.status === 'fail') { o.status = null; o.msg = ''; }
  if (!moOfferValid(o)) o.sel = false;
  else if (!wasValid) o.sel = true;   // an offer just became sendable — assume that's why it was edited
  moDrawOffer(o);
}
function moOpenConfirm() { if (!moSendable().length || !luCanWrite() || MO.sending) return; MO.confirm = true; moDraw(); }
function moCancelConfirm() { MO.confirm = false; moDraw(); }

// Player search — in sell mode only players on one of my rosters are suggested.
async function moSearch() {
  const q = document.getElementById('mo-ps')?.value.trim().toLowerCase();
  const dd = document.getElementById('mo-dd');
  if (!dd) return;
  if (!q || q.length < 2) { dd.style.display = 'none'; return; }
  await loadPlayers();
  const counts = {};
  if (MO.rostersAt) {
    for (const lg of moLeagues()) {
      const d = MO.data[lg.league_id], me = moMyRoster(d);
      if (!me) continue;
      for (const ro of d.rosters) for (const pid of (ro.players || [])) {
        const c = counts[pid] = counts[pid] || { mine: 0, others: 0 };
        ro === me ? c.mine++ : c.others++;
      }
    }
  }
  const sell = MO.mode === 'sell';
  const matches = Object.entries(S.players)
    .filter(([pid, p]) => sleeperName(p).toLowerCase().includes(q) && (!sell || !MO.rostersAt || counts[pid]?.mine))
    .sort((a, b) => {
      const as = sleeperName(a[1]).toLowerCase().startsWith(q) ? 0 : 1, bs = sleeperName(b[1]).toLowerCase().startsWith(q) ? 0 : 1;
      return as - bs || (a[1].search_rank ?? 1e9) - (b[1].search_rank ?? 1e9);
    }).slice(0, 12);
  if (!matches.length) {
    dd.innerHTML = `<div class="player-dropdown-item" style="cursor:default;font-style:italic;">${sell && MO.rostersAt ? 'Not on any of your rosters' : 'No players found'}</div>`;
    dd.style.display = 'block';
    return;
  }
  dd.innerHTML = matches.map(([pid, p]) => {
    const c = counts[pid];
    const where = !MO.rostersAt ? '' : sell ? ` · yours in ${c.mine}` : ` · on another team in ${c?.others || 0}`;
    return `<div class="player-dropdown-item" onmousedown="moPickPlayer('${esc(pid)}')">${esc(sleeperName(p))} <span class="player-dropdown-meta">${esc(p.position || '')} · ${esc(p.team || 'FA')}${where}</span></div>`;
  }).join('');
  dd.style.display = 'block';
}

// ── Render ──
function renderMassOffers() {
  if (!moLeagues().length) { setC(viewBarHtml('findtrade', 'offers') + '<div class="empty-state"><p>No Sleeper leagues found — mass offers are Sleeper-only</p></div>'); return; }
  if (!Object.keys(S.players).length) loadPlayers().then(moDraw).catch(() => {});
  if (Date.now() - MO.rostersAt > MO_TTL && !MO.sending) moLoadRosters().catch(e => { MO.err = e.message; }).finally(moDraw);
  moDraw();
}

function moOfferHtml(o) {
  const d = MO.data[o.lgId], me = moMyRoster(d);
  const locked = MO.sending || o.status === 'sent';
  const lgName = S.leagues.find(l => l.league_id === o.lgId)?.name || d.league?.name || '';
  const title = MO.mode === 'buy'
    ? `${esc(lgName)} <span class="mo-meta">· ${esc(moTeamName(d, o.rid))}</span>`
    : esc(moTeamName(d, o.rid));
  const list = arr => arr.length ? arr.map(a => `<div>${esc(moAssetLabel(d, a))}</div>`).join('') : '<div class="mo-note">nothing</div>';
  const send = o.assets.filter(a => a.from === me?.roster_id), get = o.assets.filter(a => a.from !== me?.roster_id);
  const status =
      o.status === 'queued'  ? '<div class="mo-status mo-meta">Queued…</div>'
    : o.status === 'sending' ? '<div class="mo-status mo-meta">Sending…</div>'
    : o.status === 'sent'    ? `<div class="mo-status mo-ok">✓ Offer sent${o.dm?.ok ? ' · trade card DMed' : o.dm ? ` · ⚠ DM not sent (${esc(o.dm.msg)})` : ''}</div>`
    : o.status === 'fail'    ? `<div class="mo-status mo-bad">✗ ${esc(o.msg)}</div>`
    : '';
  const cls = o.status === 'sent' ? ' sent' : o.status === 'fail' ? ' fail' : o.sel ? '' : ' off';
  return `<div class="mo-offer${cls}" id="mo-offer-${o.id}">
    <div class="mo-offer-top">
      <input type="checkbox" ${o.sel ? 'checked' : ''} ${!locked && moOfferValid(o) ? '' : 'disabled'} onchange="moToggleSel(${o.id})" aria-label="Include this offer">
      <div class="mo-offer-title">${title}</div>
      ${locked ? '' : `<button class="ghost-btn" onclick="moToggleEdit(${o.id})">${MO.editId === o.id ? 'Done' : 'Edit'}</button>`}
    </div>
    ${moContextHtml(d, o)}
    <div class="mo-offer-sides">
      <div><div class="mo-side-lbl">You send</div>${list(send)}</div>
      <div><div class="mo-side-lbl">You get</div>${list(get)}</div>
    </div>
    ${o.note ? `<div class="mo-note">${esc(o.note)}</div>` : ''}
    ${status}
    ${MO.editId === o.id && !locked ? moEditorHtml(o) : ''}
  </div>`;
}

function moEditorHtml(o) {
  const d = MO.data[o.lgId], me = moMyRoster(d), them = d.rosters.find(r => r.roster_id === o.rid);
  const keys = new Set(o.assets.map(moAssetKey));
  const posIdx = p => { const i = MO_POS_ORDER.indexOf(p?.position); return i < 0 ? 99 : i; };
  const col = (ro, label) => {
    const from = ro.roster_id;
    const players = (ro.players || []).slice().sort((a, b) =>
      posIdx(S.players[a]) - posIdx(S.players[b]) || (S.players[a]?.search_rank ?? 1e9) - (S.players[b]?.search_rank ?? 1e9));
    const picks = moOwnedPicks(d, from).sort((a, b) => a.season.localeCompare(b.season) || a.round - b.round);
    const item = a => {
      const k = moAssetKey(a);
      return `<label class="mo-ed-item"><input type="checkbox" ${keys.has(k) ? 'checked' : ''} onchange="moToggleAsset(${o.id},'${esc(k)}')"> ${esc(moAssetLabel(d, a))}</label>`;
    };
    return `<div class="mo-ed-col">
      <div class="mo-side-lbl">${esc(label)}</div>
      ${players.map(pid => item({ kind: 'player', pid, from })).join('')}
      ${picks.length ? '<div class="mo-side-lbl" style="margin-top:8px;">Picks</div>' + picks.map(pk => item({ kind: 'pick', ...pk, from })).join('') : ''}
    </div>`;
  };
  return `<div class="mo-editor">${col(me, 'You send')}${col(them, moTeamName(d, o.rid) + ' sends')}</div>`;
}

function moBarHtml() {
  const n = moSendable().length, s = n === 1 ? '' : 's';
  if (MO.sending) {
    return `<div class="mo-bar" id="mo-bar"><span class="mo-meta">Sending ${MO.sendDone} of ${MO.sendTotal}… keep this tab open.</span></div>`;
  }
  if (MO.confirm) {
    return `<div class="mo-bar mo-bar-confirm" id="mo-bar">
      <div class="mo-offer-title">Send ${n} offer${s} in Sleeper?</div>
      <div class="mo-meta">Each is a real 2-day exploding offer with a trade card DMed to the manager, who is notified right away. To take one back, withdraw it in Sleeper.${MO.mode === 'sell' ? ' Once one is accepted, he’s no longer yours to trade in the rest.' : ''}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button class="setup-btn" style="min-height:34px;" onclick="moSendAll()">✓ Send ${n} offer${s}</button>
        <button class="ghost-btn" onclick="moCancelConfirm()">Cancel</button>
      </div>
    </div>`;
  }
  const canWrite = luCanWrite();
  const sent = MO.offers.filter(o => o.status === 'sent').length;
  return `<div class="mo-bar" id="mo-bar">
    <span class="mo-meta">${n} selected${sent ? ` · ${sent} sent` : ''}</span>
    <button class="setup-btn" style="min-height:34px;" onclick="moOpenConfirm()" ${n && canWrite ? '' : 'disabled'}>Send ${n} offer${s}</button>
    ${canWrite ? '' : `<span class="mo-meta">${S.auth
      ? 'Add your Sleeper token in <a href="/myprofile" style="color:var(--gold-light);">your profile</a> to send'
      : 'Paste your Sleeper token above to send'}</span>`}
  </div>`;
}

// Redraws one offer row + the bar, keeping the editor's scroll position — a full
// redraw on every checkbox would jump a 30-player list back to the top.
function moDrawOffer(o) {
  const row = document.getElementById('mo-offer-' + o.id);
  if (!row || S.tab !== 'offers') { moDraw(); return; }
  const scrolls = [...row.querySelectorAll('.mo-ed-col')].map(c => c.scrollTop);
  row.outerHTML = moOfferHtml(o);
  document.querySelectorAll(`#mo-offer-${o.id} .mo-ed-col`).forEach((c, i) => { c.scrollTop = scrolls[i] || 0; });
  const bar = document.getElementById('mo-bar');
  if (bar) bar.outerHTML = moBarHtml();
}

function moDraw() {
  if (S.tab !== 'offers') return;
  const sell = MO.mode === 'sell', busy = MO.sending;
  const p = MO.pid ? S.players[MO.pid] : null;
  const pname = p ? sleeperName(p) : '';
  const modeBtn = (val, txt) =>
    `<button class="ghost-btn" style="${MO.mode === val ? 'border-color:var(--gold);color:var(--gold);' : ''}" onclick="moSetMode('${val}')" ${busy ? 'disabled' : ''}>${txt}</button>`;
  const step = (n, label, body) => `<div class="mo-step"><span class="setup-label-rye">${n} · ${label}</span>${body}</div>`;

  let html = `${viewBarHtml('findtrade', 'offers')}<div class="section-head"><h2>Mass Offers</h2><div class="section-head-line"></div></div>
    <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">${modeBtn('sell', 'Sell to a league')}${modeBtn('buy', 'Buy in every league')}</div>
    <div class="mo-intro">${sell
      ? 'Offer one of your players to every other manager in a league, each for a draft pick of the round you choose.'
      : 'Offer a draft pick of the round you choose to every manager who has a player, in every league he’s rostered in.'}
      Every offer is a 2-day exploding offer with a trade card DM, and you review each one before anything sends.</div>`;

  // 1 · player
  html += step(1, sell ? 'Player you’re selling' : 'Player you want', MO.pid
    ? `<div class="mo-chosen"><span class="mo-chosen-name">${esc(pname || 'Player ' + MO.pid)}</span>
         <span class="mo-meta">${esc(p?.position || '')} · ${esc(p?.team || 'FA')}</span>
         <button class="ghost-btn" style="margin-left:auto;" onclick="moClearPlayer()" ${busy ? 'disabled' : ''}>Change</button></div>`
    : `<div class="player-ac-wrap">
         <input type="text" id="mo-ps" class="search-input" placeholder="${sell ? 'Search your players…' : 'Search any player…'}" autocomplete="off"
           oninput="moSearch()" onblur="setTimeout(() => { const d = document.getElementById('mo-dd'); if (d) d.style.display = 'none'; }, 150)" />
         <div class="player-dropdown" id="mo-dd" style="display:none;"></div>
       </div>`);

  if (MO.pid) {
    if (!MO.rostersAt) {
      html += loading('Checking rosters in every league…');
    } else if (sell) {
      // 2 · league
      const lgs = moSellLeagues();
      html += step(2, 'League to shop him in', lgs.length
        ? `<div class="mo-list">${lgs.map(x => x.block
            ? `<div class="mo-lg blocked"><span class="mo-lg-name">${esc(x.name)}</span><span class="mo-meta">${esc(x.block)}</span></div>`
            : `<button class="mo-lg${MO.lgId === x.lgId ? ' active' : ''}" onclick="moSetLeague('${esc(x.lgId)}')" ${busy ? 'disabled' : ''}>
                 <span class="mo-lg-name">${esc(x.name)}</span><span class="mo-meta">${x.teams} teams</span></button>`).join('')}</div>`
        : `<div class="mo-note">You don’t have ${esc(pname)} on a roster in any of your Sleeper leagues.</div>`);
    } else {
      // 2 · leagues he's in
      const { rows, mine, fa } = moBuyLeagues();
      const open = rows.filter(r => !r.block).length;
      const extra = [mine ? `already yours in ${mine}` : '', fa ? `free agent in ${fa}` : ''].filter(Boolean).join(' · ');
      html += step(2, 'Leagues where another manager has him', rows.length
        ? `<div class="mo-meta" style="margin-bottom:6px;">${open} league${open === 1 ? '' : 's'} open to offers${extra ? ' · ' + extra : ''}</div>
           <div class="mo-list">${rows.map(r => `<div class="mo-lg${r.block ? ' blocked' : ''}" style="cursor:default;">
             <span class="mo-lg-name">${esc(r.name)}</span>${r.block ? `<span class="mo-meta">${esc(r.block)}</span>` : ''}</div>`).join('')}</div>`
        : `<div class="mo-note">No other manager has ${esc(pname)} in your Sleeper leagues${extra ? ' (' + extra + ')' : ''}.</div>`);
    }

    // 3 · the pick
    const ready = MO.rostersAt && (sell ? !!MO.lgId : moBuyLeagues().rows.some(r => !r.block));
    if (ready) {
      html += step(3, sell ? 'Ask each manager for' : 'Offer each owner', `
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          ${MO_ROUNDS.map(r => `<button class="ls-mode-pill${MO.round === r ? ' active' : ''}" onclick="moSetRound(${r})" ${busy ? 'disabled' : ''}>${moOrd(r)} round pick</button>`).join('')}
          <button class="setup-btn" style="min-height:32px;margin-left:6px;" onclick="moBuild()" ${busy || MO.building ? 'disabled' : ''}>${MO.offers.length ? 'Rebuild offers' : 'Build offers'}</button>
        </div>
        <div class="mo-intro" style="margin:6px 0 0;">${sell ? 'Each manager’s' : 'Your'} earliest ${moOrd(MO.round)}: ${sell ? 'their' : 'your'} own pick if ${sell ? 'they' : 'you'} still have it, otherwise one acquired from another team.</div>`);
    }

    // 4 · review
    if (MO.building) {
      html += loading('Building offers…');
    } else if (MO.offers.length) {
      // Each row carries the other manager's record and playoff odds. Odds load on
      // their own after a build (moLoadOdds); the link is only the retry.
      const missing = moOddsMissing();
      const oddsCtl = MO.oddsLoading
        ? ' · <span class="mo-meta">simulating playoff odds — up to a minute the first time…</span>'
        : missing && !MO.sending
          ? ` · <a href="#" onclick="moLoadOdds();return false;">retry playoff odds</a>`
          : '';
      html += step(4, 'Review and send', `
        <div class="mo-intro" style="margin:0 0 8px;">${MO.offers.length} offer${MO.offers.length === 1 ? '' : 's'} ·
          <a href="#" onclick="moSelectAll(true);return false;">select all</a> ·
          <a href="#" onclick="moSelectAll(false);return false;">none</a>${oddsCtl}
          ${MO.oddsErr ? `<span class="mo-bad"> · ${esc(MO.oddsErr)}</span>` : ''}</div>
        <div class="mo-list">${MO.offers.map(moOfferHtml).join('')}</div>
        ${moBarHtml()}`);
    }
  }
  if (MO.err) html += errHtml(new Error(MO.err));

  // Background loads redraw the tab — keep whatever is half-typed in the search box.
  const inp = document.getElementById('mo-ps');
  const typed = inp?.value || '', focused = inp && document.activeElement === inp;
  setC(html);
  const inp2 = document.getElementById('mo-ps');
  if (inp2 && typed) { inp2.value = typed; if (focused) { inp2.focus(); moSearch(); } }
}
