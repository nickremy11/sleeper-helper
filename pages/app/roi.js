// ROI Tracker tab

// ── 4d. ROI Tracker ──────────────────────────────────────────────────────────
// Dues / winnings / finish per league per year, with profit and ROI per season
// and all time. Money is entered by hand (or imported once from a spreadsheet);
// finishes are read from Sleeper and ESPN. Stored per account (/api/roi), so
// this tab is signed-in only.
//
// A tracker league is NOT a platform league id: Sleeper mints a new league_id
// every season. `ROI.leagues` ids are our own, and each season row carries that
// season's platform id in `ext_id` — that is how next year's renewal (linked by
// previous_league_id) lands on the same row instead of a new one.
const ROI = {
  owner:         null,   // S.auth.email the ledger was loaded for — reset on account switch
  loaded:        false,
  leagues:       {},     // id → {id, name, platform, buy_in, hidden}
  seasons:       {},     // roiKey(id, year) → {league_id, season, ext_id, dues, winnings, finish, auto_finish, auto_of}
  cur:           null,   // the NFL season being played (nflState.season)
  syncing:       false,
  synced:        false,
  syncedSleeper: false,  // a sync that ran before loadUser() set S.userId must run again
  status:        '',
  statusErr:     false,
  sort:          'buyin',  // 'buyin' | 'name' | 'net'
  showHidden:    false,
  editId:        null,   // league open in the edit panel
  imp:           null,   // null | {stage:'input', err?} | {stage:'preview', rows, years, match:[]}
  _saveQ:        Promise.resolve(),
};
const ROI_FIRST_SEASON = 2017;   // Sleeper's first season
const ROI_FIELDS = ['dues', 'winnings', 'finish'];
const roiKey   = (lid, yr) => lid + '|' + yr;
const roiNewId = () => 'r' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const roiNorm  = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const roiFinish = s => s.finish ?? s.auto_finish ?? null;   // hand-entered beats the platform's

function roiMoney(n, signed) {
  if (n == null) return '';
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
  return (n < 0 ? '−' : signed && n > 0 ? '+' : '') + '$' + abs;
}
function roiPct(net, dues) {
  if (!(dues > 0)) return '—';
  const p = Math.round(net / dues * 100);
  return (p > 0 ? '+' : p < 0 ? '−' : '') + Math.abs(p) + '%';
}
function roiSignCls(n) { return n > 0 ? 'roi-pos' : n < 0 ? 'roi-neg' : ''; }
function roiOrd(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
// Blank, "-" and "x" mean "not paid / nothing" → null. 0 is a real amount.
// Anything else unreadable is NaN, so the caller can refuse it.
function roiParseMoney(raw) {
  const t = String(raw ?? '').trim();
  if (!t || /^[-–—x]$/i.test(t)) return null;
  const digits = t.replace(/[^0-9.]/g, '');
  if (!digits) return NaN;
  const neg = /^[-−(]/.test(t);
  return neg ? -Number(digits) : Number(digits);
}
function roiParseFinish(raw) {
  const t = String(raw ?? '').trim();
  if (!t || /^[-–—x]$/i.test(t)) return null;
  const m = t.match(/\d+/);
  return m ? parseInt(m[0], 10) : NaN;
}
function roiEnsureSeason(lid, yr) {
  return ROI.seasons[roiKey(lid, yr)] ||= { league_id: lid, season: yr, ext_id: null, dues: null, winnings: null, finish: null, auto_finish: null, auto_of: null };
}
function roiIndex() {   // {leagueId: {year: season}}
  const by = {};
  for (const s of Object.values(ROI.seasons)) (by[s.league_id] ||= {})[s.season] = s;
  return by;
}
function roiTally(list) {
  let dues = 0, won = 0, unpaid = 0, titles = 0;
  for (const s of list) {
    dues += s.dues || 0; won += s.winnings || 0;
    if (s.dues == null) unpaid++;
    if (roiFinish(s) === 1) titles++;
  }
  return { n: list.length, dues, won, net: won - dues, unpaid, titles };
}

// ── load / save ──
async function roiLoad() {
  const r = await fetch('/api/roi', { credentials: 'include' });
  if (!r.ok) throw new Error(r.status === 401 ? 'Your session expired — sign in again' : 'Could not load your ledger (HTTP ' + r.status + ')');
  const d = await r.json();
  ROI.leagues = {}; ROI.seasons = {};
  for (const l of d.leagues || []) ROI.leagues[l.id] = { ...l, hidden: !!l.hidden };
  for (const s of d.seasons || []) ROI.seasons[roiKey(s.league_id, s.season)] = s;
  ROI.loaded = true;
}
// Saves run one at a time, in order, so a quick run of edits can't land out of
// order. Resolves true/false — never rejects; a failure is shown in the status line.
function roiSave({ leagues = [], seasons = [], deleteLeagues = [], deleteSeasons = [] }) {
  const body = JSON.stringify({ leagues: leagues.map(l => ({ ...l, hidden: l.hidden ? 1 : 0 })), seasons, deleteLeagues, deleteSeasons });
  ROI._saveQ = ROI._saveQ.then(async () => {
    try {
      const r = await fetch('/api/roi', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
      return true;
    } catch (e) {
      roiSetStatus("Couldn't save: " + e.message + ' — reload the page before editing more.', true);
      return false;
    }
  });
  return ROI._saveQ;
}
function roiSetStatus(msg, err) {
  ROI.status = msg; ROI.statusErr = !!err;
  const el = document.getElementById('roi-status');
  if (el) { el.textContent = msg; el.className = 'roi-status' + (err ? ' err' : ''); }
}

// ── sync: find every league-season, read finishes ──
async function roiPool(items, n, fn) {
  let i = 0;
  const worker = async () => { while (i < items.length) { const it = items[i++]; try { await fn(it); } catch {} } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function roiSync() {
  if (ROI.syncing) return;
  ROI.syncing = true;
  ROI.syncedSleeper = !!S.userId;
  roiSetStatus('Reading your league history…');
  const ctx = { extIndex: {}, L: new Set(), S: new Set(), created: 0, finishes: 0, espnFail: 0, errs: [] };
  ctx.touch = s => ctx.S.add(roiKey(s.league_id, s.season));
  for (const s of Object.values(ROI.seasons)) if (s.ext_id) ctx.extIndex[s.ext_id] = s.league_id;
  try {
    await Promise.all([
      roiSyncSleeper(ctx).catch(e => ctx.errs.push('Sleeper: ' + e.message)),
      roiSyncEspn(ctx).catch(e => ctx.errs.push('ESPN: ' + e.message)),
    ]);
    if (ctx.espnFail) ctx.errs.push(`${ctx.espnFail} ESPN league${ctx.espnFail === 1 ? '' : 's'} couldn't be read — check your cookies in your profile`);
    if (!S.userId) ctx.errs.push('no Sleeper username on your profile, so Sleeper leagues were skipped');
    const leagues = [...ctx.L].map(id => ROI.leagues[id]).filter(Boolean);
    const seasons = [...ctx.S].map(k => ROI.seasons[k]).filter(Boolean);
    const ok = (leagues.length || seasons.length) ? await roiSave({ leagues, seasons }) : true;
    if (ok) {
      const bits = [];
      if (ctx.created)  bits.push(ctx.created + ' new league' + (ctx.created === 1 ? '' : 's'));
      if (ctx.finishes) bits.push(ctx.finishes + ' finish' + (ctx.finishes === 1 ? '' : 'es') + ' pulled');
      roiSetStatus('Synced' + (bits.length ? ' — ' + bits.join(', ') : ', nothing new') + (ctx.errs.length ? ' · ' + ctx.errs.join(' · ') : ''), ctx.errs.length > 0);
    }
  } finally {
    ROI.syncing = false;
    ROI.synced  = true;
  }
  if (S.tab === 'roi') roiRedrawWhenIdle();
}

// Every league I was in, every season since 2017. /user/{id}/leagues lists only
// leagues I was actually in that year, so membership is free — and a renewal's
// previous_league_id only links to a season that's also in the list, so a chain
// starts the year I joined rather than the year the league was founded.
async function roiSyncSleeper(ctx) {
  if (!S.userId) return;
  const st   = await getNflState();
  const last = Number(st.league_create_season || st.season);
  const yrs  = [];
  for (let y = ROI_FIRST_SEASON; y <= last; y++) yrs.push(y);
  const lists = await Promise.all(yrs.map(y => api(`/user/${S.userId}/leagues/nfl/${y}`).catch(() => null)));
  if (lists.every(x => x == null)) throw new Error("couldn't read your leagues");
  const byId = {};
  for (const lg of lists.flat()) if (lg?.league_id) byId[lg.league_id] = lg;
  const rootOf = id => {
    const seen = new Set();
    while (byId[byId[id]?.previous_league_id] && !seen.has(id)) { seen.add(id); id = byId[id].previous_league_id; }
    return id;
  };
  const chains = {};
  for (const id of Object.keys(byId)) (chains[rootOf(id)] ||= []).push(byId[id]);

  const jobs = [];
  for (const chain of Object.values(chains)) {
    chain.sort((a, b) => a.season - b.season);
    let lid = chain.map(lg => ctx.extIndex[lg.league_id]).find(id => id && ROI.leagues[id]);
    if (!lid) {
      lid = roiNewId();
      ROI.leagues[lid] = { id: lid, name: chain[chain.length - 1].name || 'Sleeper league', platform: 'sleeper', buy_in: null, hidden: false };
      ctx.L.add(lid); ctx.created++;
    }
    for (const lg of chain) {
      const s = roiEnsureSeason(lid, Number(lg.season));
      if (!s.ext_id) { s.ext_id = lg.league_id; ctx.touch(s); }   // never re-point a season someone merged
      ctx.extIndex[lg.league_id] = lid;
      if (s.ext_id === lg.league_id && s.auto_finish == null && lg.status === 'complete') jobs.push({ s, lg });
    }
  }
  let done = 0;
  await roiPool(jobs, 6, async ({ s, lg }) => {
    const f = await roiSleeperFinish(lg);
    if (f) { s.auto_finish = f.finish; s.auto_of = f.of; ctx.touch(s); ctx.finishes++; }
    roiSetStatus(`Reading finishes from Sleeper… ${++done} of ${jobs.length}`);
  });
}

// Playoff teams take their bracket placing; everyone else their regular-season
// rank (wins, then points for — Sleeper's own standings order).
async function roiSleeperFinish(lg) {
  const [rosters, bracket] = await Promise.all([
    api(`/league/${lg.league_id}/rosters`),
    api(`/league/${lg.league_id}/winners_bracket`).catch(() => []),
  ]);
  const me = (rosters || []).find(r => r.owner_id === S.userId || (r.co_owners || []).includes(S.userId));
  if (!me) return null;
  const st  = r => r.settings || {};
  const win = r => (st(r).wins || 0) + (st(r).ties || 0) / 2;
  const pts = r => (st(r).fpts || 0) + (st(r).fpts_decimal || 0) / 100;
  let finish = [...rosters].sort((a, b) => win(b) - win(a) || pts(b) - pts(a)).indexOf(me) + 1;
  // Placement games carry p (1 = title game, 3 = 3rd-place game, …): winner takes p, loser p+1
  for (const m of bracket || []) {
    if (!m.p) continue;
    if (m.w === me.roster_id) finish = m.p;
    else if (m.l === me.roster_id) finish = m.p + 1;
  }
  return { finish, of: rosters.length };
}

async function roiEspnRead(id, yr) {
  const r = await fetch(`/api/espn/fantasy/${id}?view=mTeam&view=mSettings&view=mStatus&seasonId=${yr}`, { credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
// null = I had no team that season. rankCalculatedFinal is 0 until the season
// is decided, so an in-progress season reports a member with no finish yet.
function roiEspnFinish(d, swid) {
    const teams = d.teams || [];
  const team  = espnMyTeam(teams, swid);
  if (!team) return null;
  const final = team.rankCalculatedFinal || 0;
  const seed  = team.playoffSeed || 0;
  const cut   = d.settings?.scheduleSettings?.playoffTeamCount || 0;
  return { finish: !final ? null : (cut && seed > cut ? seed : final), of: teams.length };
}
// ESPN keeps one league id for life, so every season shares ext_id espn_{id}.
// Past seasons come from the current season's status.previousSeasons.
async function roiSyncEspn(ctx) {
  await loadEspnSettings();
  const cfg = S.espnSettings;
  if (!cfg?.has_credentials || !cfg.league_ids?.length) return;
  const cur = Number((await getNflState()).season);
  await roiPool(cfg.league_ids, 4, async id => {
    const ext = 'espn_' + id;
    let curD;
    try { curD = await roiEspnRead(id, cur); } catch { ctx.espnFail++; return; }
    let lid = ROI.leagues[ctx.extIndex[ext]] ? ctx.extIndex[ext] : null;
    const take = (yr, d) => {
      const f = roiEspnFinish(d, cfg.swid);
      if (!f) return;
      if (!lid) {
        lid = roiNewId();
        ROI.leagues[lid] = { id: lid, name: curD.settings?.name || d.settings?.name || 'ESPN league ' + id, platform: 'espn', buy_in: null, hidden: false };
        ctx.L.add(lid); ctx.created++; ctx.extIndex[ext] = lid;
      }
      const s = roiEnsureSeason(lid, yr);
      if (!s.ext_id) { s.ext_id = ext; ctx.touch(s); }
      if (s.ext_id === ext && f.finish != null && s.auto_finish == null) { s.auto_finish = f.finish; s.auto_of = f.of; ctx.touch(s); ctx.finishes++; }
    };
    take(cur, curD);
    const past = (curD.status?.previousSeasons || []).map(Number).filter(y => y >= 2018 && y < cur);
    for (const yr of past) {
      if (lid && ROI.seasons[roiKey(lid, yr)]?.auto_finish != null) continue;
      try { take(yr, await roiEspnRead(id, yr)); } catch {}
    }
  });
}

// ── render ──
async function renderRoi() {
  const head = '<div class="section-head"><h2>ROI Tracker</h2><div class="section-head-line"></div></div>';
  if (!S.auth) {
    setC(head + '<div class="empty-state"><p>Sign in to track dues, winnings and finishes — your ledger is saved to your account.</p></div>');
    return;
  }
  if (ROI.owner !== S.auth.email) {
    Object.assign(ROI, { owner: S.auth.email, loaded: false, synced: false, syncedSleeper: false, editId: null, imp: null, status: '', statusErr: false });
  }
  if (!ROI.loaded) {
    setC(head + loading('Loading your ledger…'));
    try {
      const st = await getNflState();
      ROI.cur = Number(st.season) || new Date().getFullYear();
      await roiLoad();
    } catch (e) { setC(head + errHtml(e)); return; }
    if (S.tab !== 'roi') return;
  }
  if (!ROI.syncing && (!ROI.synced || (S.userId && !ROI.syncedSleeper))) roiSync();
  roiDraw();
}

// A sync can finish while someone is typing in a cell; a full redraw then would
// throw their cursor away, so it waits until focus leaves the table.
function roiRedrawWhenIdle() {
  const wrap = document.getElementById('roi-wrap');
  if (!wrap || !wrap.contains(document.activeElement)) { roiDraw(); return; }
  wrap.addEventListener('focusout', function h(e) {
    if (e.relatedTarget && wrap.contains(e.relatedTarget)) return;
    wrap.removeEventListener('focusout', h);
    setTimeout(roiDraw, 0);
  });
}

function roiYears(by, leagues) {
  let lo = ROI.cur, hi = ROI.cur + 1;   // next season is always open — dues get paid ahead
  for (const l of leagues) for (const y of Object.keys(by[l.id] || {})) { lo = Math.min(lo, +y); hi = Math.max(hi, +y); }
  const out = [];
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}
function roiShownLeagues(by) {
  const ls   = Object.values(ROI.leagues).filter(l => ROI.showHidden || !l.hidden);
  const name = (a, b) => a.name.localeCompare(b.name);
  if (ROI.sort === 'name') return ls.sort(name);
  if (ROI.sort === 'net') {
    const net = {};
    for (const l of ls) net[l.id] = roiTally(Object.values(by[l.id] || {})).net;
    return ls.sort((a, b) => net[b.id] - net[a.id] || name(a, b));
  }
  return ls.sort((a, b) => (b.buy_in ?? -1) - (a.buy_in ?? -1) || name(a, b));
}

// Value, placeholder, colour and tooltip for one cell — shared by the first
// render and roiEdit(), which restyles the input in place so Tab keeps working.
function roiCellAttrs(l, s, f) {
  const v = s[f];
  const a = { value: f === 'finish' ? String(v ?? '') : roiMoney(v), ph: '', cls: 'roi-in', title: '' };
  if (f === 'dues') {
    a.ph = '–';
    if (v == null && s.season >= ROI.cur) {
      a.cls += ' roi-owed';
      a.title = 'Not paid yet' + (l.buy_in != null ? ' · buy-in ' + roiMoney(l.buy_in) : '');
    }
  } else if (f === 'winnings') {
    if (v > 0) a.cls += ' roi-won';
  } else {
    if (s.auto_finish != null) {
      const src = String(s.ext_id || '').startsWith('espn_') ? 'ESPN' : 'Sleeper';
      a.ph = String(s.auto_finish);
      a.title = `${src}: ${roiOrd(s.auto_finish)}${s.auto_of ? ' of ' + s.auto_of : ''}`
        + (v == null ? ' · type to override' : v !== s.auto_finish ? ` · you entered ${roiOrd(v)}` : '');
    }
    if (roiFinish(s) === 1) a.cls += ' roi-champ';
  }
  return a;
}
function roiInputHtml(l, s, f) {
  const a = roiCellAttrs(l, s, f);
  return `<input class="${a.cls}" type="text" inputmode="decimal" value="${esc(a.value)}" placeholder="${esc(a.ph)}" title="${esc(a.title)}"
    data-lid="${l.id}" data-yr="${s.season}" data-f="${f}" onchange="roiEdit(this)" onkeydown="if(event.key==='Enter')this.blur()">`;
}

function roiTotVals(t) {
  const c = roiSignCls(t.net);
  return [roiMoney(t.dues), roiMoney(t.won), `<span class="${c}">${roiMoney(t.net, true)}</span>`, `<span class="${c}">${roiPct(t.net, t.dues)}</span>`];
}
function roiTotCells(t, pre) {
  return roiTotVals(t).map((h, i) => `<td class="roi-tot roi-t${i + 1}"${pre ? ` id="${pre}-${i + 1}"` : ''}>${h}</td>`).join('');
}

function roiRowHtml(l, ys, years) {
  const src = l.platform === 'sleeper' ? 'Sleeper' : l.platform === 'espn' ? 'ESPN' : 'Manual';
  const cells = years.map(y => {
    const s = ys[y];
    if (!s) return `<td colspan="3" class="roi-off roi-ys"><button class="roi-add" onclick="roiAddSeason('${l.id}',${y})" title="I was in this league in ${y}">+ ${y}</button></td>`;
    return ROI_FIELDS.map((f, i) => `<td class="${f === 'finish' ? 'roi-cf' : 'roi-c'}${i === 0 ? ' roi-ys' : ''}">${roiInputHtml(l, s, f)}</td>`).join('');
  }).join('');
  return `<tr class="${l.hidden ? 'roi-hid' : ''}">
    <td class="roi-name"><div class="roi-nm"><span class="roi-nm-t" title="${esc(l.name)}">${esc(l.name)}</span><button class="roi-ed" onclick="roiOpenEdit('${l.id}')" title="Rename, buy-in, hide, merge">✎</button></div><div class="roi-src">${src}${l.hidden ? ' · hidden' : ''}</div></td>
    <td class="roi-buy">${roiMoney(l.buy_in)}</td>
    ${cells}
    ${roiTotCells(roiTally(Object.values(ys)), 'roi-t-' + l.id)}
  </tr>`;
}

// Totals never include hidden leagues, even while "Show hidden" lists them.
function roiCounted() { return Object.values(ROI.leagues).filter(l => !l.hidden); }
function roiFootHtml(by, years) {
  const counted = roiCounted();
  const cells = years.map(y => {
    const t = roiTally(counted.map(l => by[l.id]?.[y]).filter(Boolean));
    return `<td class="roi-ys">${t.n ? roiMoney(t.dues) : ''}</td><td>${t.n ? roiMoney(t.won) : ''}</td>`
      + `<td title="${t.titles ? t.titles + ' title' + (t.titles > 1 ? 's' : '') : ''}">${t.titles ? '★' + t.titles : ''}</td>`;
  }).join('');
  const all = roiTally(counted.flatMap(l => Object.values(by[l.id] || {})));
  return `<tr><td class="roi-name">Total</td><td class="roi-buy"></td>${cells}${roiTotCells(all)}</tr>`;
}
function roiSummaryHtml(by) {
  const byYear = {};
  for (const l of roiCounted()) for (const s of Object.values(by[l.id] || {})) (byYear[s.season] ||= []).push(s);
  const ys = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  if (!ys.length) return '<p class="roi-hint">Nothing to total yet.</p>';
  const row = (label, t, tag, cls = '') => `<tr class="${cls}">
    <td>${label}${tag ? `<span class="roi-tag">${tag}</span>` : ''}</td>
    <td class="r">${t.n}</td><td class="r">${t.unpaid || ''}</td>
    <td class="r">${roiMoney(t.dues)}</td><td class="r">${roiMoney(t.won)}</td>
    <td class="r ${roiSignCls(t.net)}">${roiMoney(t.net, true)}</td><td class="r ${roiSignCls(t.net)}">${roiPct(t.net, t.dues)}</td>
    <td class="r">${t.titles || ''}</td></tr>`;
  return `<div style="overflow-x:auto;"><table class="ls-table roi-sum"><thead><tr>
      <th>Season</th><th class="r">Leagues</th><th class="r">Unpaid</th><th class="r">Dues</th><th class="r">Winnings</th><th class="r">Profit</th><th class="r">ROI</th><th class="r">Titles</th>
    </tr></thead><tbody>
    ${ys.map(y => row(y, roiTally(byYear[y]), y === ROI.cur ? 'in progress' : y > ROI.cur ? 'upcoming' : '')).join('')}
    ${row('All time', roiTally(Object.values(byYear).flat()), '', 'roi-all')}
  </tbody></table></div>`;
}

function roiDraw() {
  if (S.tab !== 'roi' || !ROI.loaded) return;
  const prevScroll = document.getElementById('roi-wrap')?.scrollLeft;
  const by      = roiIndex();
  const rows    = roiShownLeagues(by);
  const years   = roiYears(by, rows);
  const hiddenN = Object.values(ROI.leagues).filter(l => l.hidden).length;
  const pill    = (k, label) => `<button class="roi-pill${ROI.sort === k ? ' on' : ''}" onclick="roiSetSort('${k}')">${label}</button>`;
  const head1 = years.map(y => `<th colspan="3" class="roi-ys${y === ROI.cur ? ' roi-now' : ''}">${y}${y === ROI.cur ? ' · now' : ''}</th>`).join('');
  const head2 = years.map(() => '<th class="roi-c roi-ys">Dues</th><th class="roi-c">Won</th><th class="roi-cf">Fin</th>').join('');
  const busy  = ROI.syncing ? ' disabled title="Waiting for the league sync to finish"' : '';

  setC(`<div class="section-head"><h2>ROI Tracker</h2><div class="section-head-line"></div></div>
    ${roiEditHtml()}${roiImportHtml()}
    <div class="roi-bar">
      ${pill('buyin', 'Buy-in')}${pill('name', 'Name')}${pill('net', 'Net')}
      <span class="roi-sp"></span>
      ${hiddenN ? `<button class="roi-pill${ROI.showHidden ? ' on' : ''}" onclick="roiToggleHidden()">Show hidden (${hiddenN})</button>` : ''}
      <button class="ghost-btn" onclick="roiAddLeague()">+ League</button>
      <button class="ghost-btn" onclick="roiOpenImport()"${busy}>⬆ Import sheet</button>
      <button class="ghost-btn" onclick="roiSync(); roiDraw();"${busy}>↻ Sync</button>
    </div>
    <div class="roi-status${ROI.statusErr ? ' err' : ''}" id="roi-status">${esc(ROI.status)}</div>
    ${rows.length ? `<div class="roi-wrap" id="roi-wrap"><table class="roi-table">
      <thead>
        <tr class="roi-yr"><th rowspan="2" class="roi-name">League</th><th rowspan="2" class="roi-buy">Buy-in</th>${head1}<th colspan="4" class="roi-tot roi-tall">All time</th></tr>
        <tr>${head2}<th class="roi-tot roi-t1">Dues</th><th class="roi-tot roi-t2">Won</th><th class="roi-tot roi-t3">Net</th><th class="roi-tot roi-t4">ROI</th></tr>
      </thead>
      <tbody>${rows.map(l => roiRowHtml(l, by[l.id] || {}, years)).join('')}</tbody>
      <tfoot id="roi-foot">${roiFootHtml(by, years)}</tfoot>
    </table></div>` : `<div class="empty-state"><p>${ROI.syncing ? 'Finding your leagues…' : 'No leagues yet — sync, import your sheet, or add one.'}</p></div>`}
    <p class="roi-hint">Blank dues = not paid yet (red for this season and later); $0 is a real amount. Faded finishes came from Sleeper/ESPN — type over one to correct it, clear it to go back. Striped years are seasons you weren't in; hover one to add it. Hidden leagues stay out of every total.</p>
    <div class="roi-sub">
      <div class="section-head"><h2>By Season</h2><div class="section-head-line"></div></div>
      <div id="roi-sum">${roiSummaryHtml(by)}</div>
    </div>`);

  const wrap = document.getElementById('roi-wrap');
  if (wrap) wrap.scrollLeft = prevScroll ?? wrap.scrollWidth;   // first view lands on the latest seasons
}
// Totals after a single cell edit — patched in place, never a full redraw, so
// the cursor can Tab straight on to the next cell.
function roiDrawTotals(lid) {
  const by = roiIndex();
  roiTotVals(roiTally(Object.values(by[lid] || {}))).forEach((h, i) => {
    const el = document.getElementById(`roi-t-${lid}-${i + 1}`);
    if (el) el.innerHTML = h;
  });
  const foot = document.getElementById('roi-foot');
  if (foot) foot.innerHTML = roiFootHtml(by, roiYears(by, roiShownLeagues(by)));
  const sum = document.getElementById('roi-sum');
  if (sum) sum.innerHTML = roiSummaryHtml(by);
}

// ── edits ──
function roiEdit(el) {
  const { lid, f } = el.dataset, yr = +el.dataset.yr;
  const l = ROI.leagues[lid], s = ROI.seasons[roiKey(lid, yr)];
  if (!l || !s) return;
  const v = f === 'finish' ? roiParseFinish(el.value) : roiParseMoney(el.value);
  if (Number.isNaN(v)) {
    roiSetStatus(`"${el.value}" isn't ${f === 'finish' ? 'a placing' : 'a dollar amount'} — left it as it was.`, true);
  } else if (v !== s[f]) {
    s[f] = v;
    roiSave({ seasons: [s] });
    roiDrawTotals(lid);
    if (ROI.statusErr) roiSetStatus('');
  }
  const a = roiCellAttrs(l, s, f);
  el.value = a.value; el.placeholder = a.ph; el.className = a.cls; el.title = a.title;
}
function roiSetSort(k) { ROI.sort = k; roiDraw(); }
function roiToggleHidden() { ROI.showHidden = !ROI.showHidden; roiDraw(); }
function roiAddSeason(lid, yr) {
  const s = roiEnsureSeason(lid, yr);
  roiSave({ seasons: [s] });
  roiDraw();
}
function roiAddLeague() {
  const id = roiNewId();
  const l = ROI.leagues[id] = { id, name: 'New league', platform: null, buy_in: null, hidden: false };
  const s = roiEnsureSeason(id, ROI.cur);
  roiSave({ leagues: [l], seasons: [s] });
  roiOpenEdit(id);
}

// ── edit panel: rename, buy-in, hide, merge, delete ──
function roiOpenEdit(id) {
  ROI.editId = id; ROI.imp = null;
  roiDraw();
  const el = document.getElementById('roi-e-name');
  if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus(); el.select(); }
}
function roiCloseEdit() { ROI.editId = null; roiDraw(); }
function roiEditHtml() {
  const l = ROI.leagues[ROI.editId];
  if (!l) return '';
  const manualYrs = Object.values(ROI.seasons).filter(s => s.league_id === l.id && !s.ext_id).map(s => s.season).sort((a, b) => a - b);
  const others = Object.values(ROI.leagues).filter(o => o.id !== l.id).sort((a, b) => a.name.localeCompare(b.name));
  const srcName = l.platform === 'espn' ? 'ESPN' : 'Sleeper';
  return `<div class="roi-panel">
    <h3>Edit league</h3>
    <div class="roi-row">
      <label>Name <input type="text" id="roi-e-name" value="${esc(l.name)}" size="30"></label>
      <label>Buy-in <input type="text" id="roi-e-buy" value="${esc(roiMoney(l.buy_in))}" size="7" placeholder="$"></label>
      <label><input type="checkbox" id="roi-e-hide"${l.hidden ? ' checked' : ''}> Hide — leave out of every total</label>
      <button class="ghost-btn" onclick="roiSaveEdit()">Save</button>
      <button class="ghost-btn" onclick="roiCloseEdit()">Close</button>
    </div>
    ${manualYrs.length ? `<div class="roi-row"><span>Seasons added by hand:</span>${manualYrs.map(y => `<span class="roi-chip">${y}<button title="Remove ${y}" onclick="roiRemoveSeason('${l.id}',${y})">✕</button></span>`).join('')}</div>` : ''}
    <div class="roi-row">
      <label>Merge into <select id="roi-e-merge"><option value="">— the league this really is —</option>${others.map(o => `<option value="${o.id}">${esc(o.name)}${o.platform ? '' : ' (manual)'}</option>`).join('')}</select></label>
      <button class="ghost-btn" onclick="roiMerge()">Merge</button>
    </div>
    <p class="roi-note">Merge moves every season of this row into the league you pick (only filling its empty cells), then removes this row. Use it when a league restarted under a new id, or a sheet row landed on its own line.</p>
    <div class="roi-row">${l.platform
      ? `<span class="roi-note">Synced from ${srcName} — deleting it would bring it straight back on the next sync, so hide it instead.</span>`
      : `<button class="ghost-btn roi-danger" onclick="roiDeleteLeague()">Delete league</button>`}</div>
  </div>`;
}
function roiSaveEdit() {
  const l = ROI.leagues[ROI.editId];
  if (!l) return;
  const name = document.getElementById('roi-e-name').value.trim();
  const buy  = roiParseMoney(document.getElementById('roi-e-buy').value);
  if (Number.isNaN(buy)) { roiSetStatus('Buy-in should be a dollar amount.', true); return; }
  if (name) l.name = name;
  l.buy_in = buy;
  l.hidden = document.getElementById('roi-e-hide').checked;
  roiSave({ leagues: [l] });
  ROI.editId = null;
  roiSetStatus('Saved ' + l.name + '.');
  roiDraw();
}
function roiRemoveSeason(lid, yr) {
  const s = ROI.seasons[roiKey(lid, yr)];
  if (!s) return;
  if ((s.dues != null || s.winnings != null || s.finish != null) && !confirm(`Remove ${yr} and the numbers entered for it?`)) return;
  delete ROI.seasons[roiKey(lid, yr)];
  roiSave({ deleteSeasons: [{ league_id: lid, season: yr }] });
  roiDraw();
}
function roiMerge() {
  const src = ROI.leagues[ROI.editId];
  const dst = ROI.leagues[document.getElementById('roi-e-merge').value];
  if (!src || !dst) { roiSetStatus('Pick the league to merge into first.', true); return; }
  if (!confirm(`Merge "${src.name}" into "${dst.name}"? "${src.name}" will be removed.`)) return;
  const moved = [];
  for (const s of Object.values(ROI.seasons).filter(s => s.league_id === src.id)) {
    delete ROI.seasons[roiKey(src.id, s.season)];
    const t = ROI.seasons[roiKey(dst.id, s.season)];
    if (t) {
      for (const f of ['ext_id', 'dues', 'winnings', 'finish']) if (t[f] == null) t[f] = s[f];
      if (t.auto_finish == null) { t.auto_finish = s.auto_finish; t.auto_of = s.auto_of; }
      moved.push(t);
    } else {
      const n = ROI.seasons[roiKey(dst.id, s.season)] = { ...s, league_id: dst.id };
      moved.push(n);
    }
  }
  if (dst.buy_in == null) dst.buy_in = src.buy_in;
  dst.platform ||= src.platform;   // a sheet row merged into a synced league becomes synced
  delete ROI.leagues[src.id];
  roiSave({ leagues: [dst], seasons: moved, deleteLeagues: [src.id] });
  ROI.editId = null;
  roiSetStatus(`Merged into ${dst.name}.`);
  roiDraw();
}
function roiDeleteLeague() {
  const l = ROI.leagues[ROI.editId];
  if (!l || !confirm(`Delete "${l.name}" and every season entered for it?`)) return;
  for (const k of Object.keys(ROI.seasons)) if (ROI.seasons[k].league_id === l.id) delete ROI.seasons[k];
  delete ROI.leagues[l.id];
  roiSave({ deleteLeagues: [l.id] });
  ROI.editId = null;
  roiSetStatus('Deleted ' + l.name + '.');
  roiDraw();
}

// ── spreadsheet import ──
// Read by HEADER TEXT, never by position: a row of years (a merged year cell
// exports into its first column, so each year is carried right until the next),
// and under each year a Buy in / Payout / Finish column. A year written into the
// header itself ("2025 Buy in") works too. A buy-in column before the first year
// is the league's usual price. Only the first column of each kind per year is
// used, so a trailing "Total Buy In" can't overwrite a real season.
function roiSheetRows(text) {
  const t = String(text || '').replace(/^﻿/, '');
  // A copy-paste out of Sheets is tab-separated, and its "$2,160" cells carry commas
  if ((t.split('\n')[0] || '').includes('\t')) return t.split(/\r?\n/).map(l => l.split('\t'));
  return csvRows(t);
}
function roiHeaderKind(h) {
  h = String(h || '').toLowerCase();
  if (!h || /total|sum/.test(h)) return null;
  if (/buy|due|entry|fee/.test(h)) return 'dues';
  if (/pay ?out|winning|won|prize|earn/.test(h)) return 'winnings';
  if (/finish|place|standing|rank/.test(h)) return 'finish';
  return null;
}
function roiParseSheet(text) {
  const rows = roiSheetRows(text).map(r => r.map(c => String(c ?? '').trim()));
  const hi = rows.findIndex((r, i) => i < 15 && r.filter(roiHeaderKind).length >= 2);
  if (hi < 0) throw new Error("Couldn't find the header row — expected columns like Buy in / Payout / Finish.");
  const head   = rows[hi];
  const yrRow  = rows.slice(0, hi).reverse().find(r => r.some(c => /^(19|20)\d{2}$/.test(c)));
  const nameAt = head.findIndex(h => /^(league|league name|name)$/i.test(h));
  const nameCol = nameAt >= 0 ? nameAt : 0;
  const colYear = [];
  let carry = null;
  head.forEach((h, c) => {
    const y = yrRow?.[c]?.match(/^((?:19|20)\d{2})$/)?.[1];
    if (y) carry = +y;
    const own = h.match(/\b((?:19|20)\d{2})\b/)?.[1];
    colYear[c] = own ? +own : carry;
  });
  const map = {};
  let buyCol = -1;
  head.forEach((h, c) => {
    if (c === nameCol) return;
    const k = roiHeaderKind(h);
    if (!k) return;
    if (colYear[c] == null) { if (k === 'dues' && buyCol < 0) buyCol = c; return; }
    const key = colYear[c] + '|' + k;
    if (!(key in map)) map[key] = c;
  });
  const years = [...new Set(Object.keys(map).map(k => +k.split('|')[0]))].sort((a, b) => a - b);
  if (!years.length) throw new Error('No year columns found — put the year in a row above the headers, or in the header ("2025 Buy in").');

  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const name = r[nameCol] || '';
    if (!name || /^totals?$/i.test(name)) continue;
    const buy = buyCol >= 0 ? roiParseMoney(r[buyCol]) : null;
    const entry = { name, buyIn: Number.isNaN(buy) ? null : buy, years: {} };
    for (const y of years) {
      const v = {};
      for (const k of ROI_FIELDS) {
        const c = map[y + '|' + k];
        if (c == null) continue;
        const val = k === 'finish' ? roiParseFinish(r[c]) : roiParseMoney(r[c]);
        if (val != null && !Number.isNaN(val)) v[k] = val;
      }
      if (Object.keys(v).length) entry.years[y] = v;
    }
    if (Object.keys(entry.years).length || entry.buyIn != null) out.push(entry);
  }
  if (!out.length) throw new Error('Found the headers but no league rows under them.');
  return { rows: out, years };
}
// Exact name first, then a unique "one contains the other" — "$100 Jarwin
// Invitational" in a sheet vs "Jarwin Invitational" on Sleeper.
function roiGuessMatch(name) {
  const n = roiNorm(name);
  if (!n) return 'new';
  const ls = Object.values(ROI.leagues);
  const exact = ls.filter(l => roiNorm(l.name) === n);
  if (exact.length === 1) return exact[0].id;
  const part = ls.filter(l => { const m = roiNorm(l.name); return m.length > 3 && (m.includes(n) || n.includes(m)); });
  return part.length === 1 ? part[0].id : 'new';
}
function roiOpenImport() { ROI.imp = { stage: 'input' }; ROI.editId = null; roiDraw(); }
function roiCloseImport() { ROI.imp = null; roiDraw(); }
function roiImpFile(input) {
  const file = input.files?.[0];
  if (!file) return;
  const rd = new FileReader();
  rd.onload = () => { document.getElementById('roi-imp-text').value = rd.result; roiImpPreview(); };
  rd.readAsText(file);
}
function roiImpPreview() {
  const text = document.getElementById('roi-imp-text')?.value || '';
  try {
    const p = roiParseSheet(text);
    ROI.imp = { stage: 'preview', ...p, match: p.rows.map(r => roiGuessMatch(r.name)) };
  } catch (e) {
    ROI.imp = { stage: 'input', err: e.message };
    roiDraw();
    document.getElementById('roi-imp-text').value = text;
    return;
  }
  roiDraw();
}
function roiImpCountText() {
  const m = ROI.imp.match;
  const skip = m.filter(x => x === 'skip').length, fresh = m.filter(x => x === 'new').length;
  return `${m.length - skip - fresh} matched to your leagues · ${fresh} new · ${skip} skipped`;
}
function roiImpSet(i, v) {
  ROI.imp.match[i] = v;
  const el = document.getElementById('roi-imp-count');
  if (el) el.textContent = roiImpCountText();
}
function roiImportHtml() {
  const p = ROI.imp;
  if (!p) return '';
  if (p.stage === 'input') return `<div class="roi-panel">
    <h3>Import your spreadsheet</h3>
    <p>Download the sheet as CSV (File → Download → .csv) and pick it, or select the whole sheet, copy, and paste it below.
      It's read by header text: a row of years, and under each year a <b>Buy in</b>, <b>Payout</b> and <b>Finish</b> column.
      A buy-in column before the first year becomes each league's buy-in. Empty cells are skipped, so they never wipe out a value already here.</p>
    <div class="roi-row"><input type="file" accept=".csv,.tsv,.txt,text/csv" onchange="roiImpFile(this)"></div>
    <textarea id="roi-imp-text" placeholder="…or paste the sheet here"></textarea>
    <div class="roi-row" style="margin-top:8px;">
      <button class="ghost-btn" onclick="roiImpPreview()">Preview</button>
      <button class="ghost-btn" onclick="roiCloseImport()">Cancel</button>
      ${p.err ? `<span style="color:var(--red);">${esc(p.err)}</span>` : ''}
    </div>
  </div>`;

  const opts = Object.values(ROI.leagues).sort((a, b) => a.name.localeCompare(b.name));
  const sel = i => {
    const o = (v, label) => `<option value="${v}"${p.match[i] === v ? ' selected' : ''}>${esc(label)}</option>`;
    return `<select onchange="roiImpSet(${i}, this.value)">${o('new', '＋ New league')}${o('skip', 'Skip this row')}${
      opts.map(l => o(l.id, l.name + (l.platform === 'espn' ? ' · ESPN' : l.platform === 'sleeper' ? ' · Sleeper' : ''))).join('')}</select>`;
  };
  const yrs = r => Object.keys(r.years).join(', ') || '—';
  return `<div class="roi-panel">
    <h3>Check where each row goes</h3>
    <p>Found ${p.rows.length} leagues across ${p.years[0]}–${p.years[p.years.length - 1]}. Each row was matched to a league by name — fix any that are wrong.
      Filled cells overwrite what's here for that year; empty cells leave it alone.</p>
    <div style="overflow-x:auto;"><table class="roi-imp-table">
      <thead><tr><th>In your sheet</th><th>Buy-in</th><th>Years with data</th><th>Goes to</th></tr></thead>
      <tbody>${p.rows.map((r, i) => `<tr><td>${esc(r.name)}</td><td>${roiMoney(r.buyIn)}</td><td>${yrs(r)}</td><td>${sel(i)}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="roi-row">
      <button class="ghost-btn" onclick="roiImpApply()">Import</button>
      <button class="ghost-btn" onclick="roiOpenImport()">Back</button>
      <button class="ghost-btn" onclick="roiCloseImport()">Cancel</button>
      <span class="roi-note" id="roi-imp-count">${roiImpCountText()}</span>
    </div>
  </div>`;
}
async function roiImpApply() {
  const p = ROI.imp;
  if (!p?.rows) return;
  const L = new Map(), Ss = new Map();
  p.rows.forEach((r, i) => {
    const m = p.match[i];
    if (m === 'skip') return;
    let l = m !== 'new' && ROI.leagues[m];
    if (!l) { const id = roiNewId(); l = ROI.leagues[id] = { id, name: r.name, platform: null, buy_in: null, hidden: false }; }
    if (r.buyIn != null) l.buy_in = r.buyIn;
    L.set(l.id, l);
    for (const [y, v] of Object.entries(r.years)) {
      const s = roiEnsureSeason(l.id, +y);
      Object.assign(s, v);
      Ss.set(roiKey(l.id, +y), s);
    }
  });
  ROI.imp = null;
  roiSetStatus(`Importing ${L.size} leagues…`);
  roiDraw();
  if (await roiSave({ leagues: [...L.values()], seasons: [...Ss.values()] })) {
    roiSetStatus(`Imported ${L.size} league${L.size === 1 ? '' : 's'} (${Ss.size} seasons) from your sheet.`);
  }
}
