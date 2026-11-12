// Home. Before your leagues load it's the welcome page; once they're in, it's
// "This Week": what needs doing across every league, each card linking to the
// tool that does it.
//
// Every card reuses the tool's own loader and cache, so opening Home warms the
// tab you go to next instead of costing an extra fetch:
//   Lineups — luEnsureLineupData (5-min cache) + luLineupStatus, the card badges
//   Trades  — tradesLoad (5-min cache), the Open Trades scan
//   Drafts  — one /user/{id}/drafts call, the Draft tracker's own source
//   Leagues — whatever League Summaries has already loaded; nothing is fetched

function renderHome() {
  if (!S.userId) { setC(homeWelcomeHtml()); return; }
  const st = S.nflState || {};
  const regular = st.season_type === 'regular';
  const week = regular ? luWeekFor(st) : null;
  setC(`<div class="dash">
    <div class="section-head"><h2>This Week${week ? ' — Week ' + week : ''}</h2><div class="section-head-line"></div></div>
    <div class="dash-grid">
      <section class="dash-card" id="dash-lineups" aria-live="polite">${dashHead('Lineups', 'lineups')}${loading('Checking lineups')}</section>
      <section class="dash-card" id="dash-trades"  aria-live="polite">${dashHead('Open Trades', 'trades')}${loading('Scanning trades')}</section>
      <section class="dash-card" id="dash-drafts"  aria-live="polite">${dashHead('Drafts', 'drafts')}${loading('Checking drafts')}</section>
      <section class="dash-card" id="dash-leagues">${dashHead('Your Leagues', 'leagues')}${loading('Reading your leagues')}</section>
    </div>
    <p class="dash-foot">Looking for something else? <a href="/?tab=guide" data-tab="guide">Every tool, one line each, in the Guide →</a></p>
  </div>`);
  dashLineups(regular);
  dashTrades();
  dashDrafts();
  dashLeagues();
}

function dashHead(title, tab) {
  return `<div class="dash-head"><h3>${title}</h3><a href="/?tab=${tab}" data-tab="${tab}">Open →</a></div>`;
}
// Fill one card's body, unless the user has already moved on.
function dashFill(id, title, tab, body) {
  if (S.tab !== 'home') return;
  const el = document.getElementById(id);
  if (el) el.innerHTML = dashHead(title, tab) + body;
}
const dashLine = (txt, cls = '') => `<div class="dash-line ${cls}">${txt}</div>`;

async function dashLineups(regular) {
  const fill = body => dashFill('dash-lineups', 'Lineups', 'lineups', body);
  if (!regular) return fill(dashLine('No regular-season games this week.', 'dim'));
  try {
    const lineups = await luEnsureLineupData();
    if (!lineups.length) return fill(dashLine('No active lineups found.', 'dim'));
    const rows = lineups.map(fix => ({ fix, s: luLineupStatus(fix) }));
    const bad  = rows.filter(r => r.s.level === 'bad');
    const warn = rows.filter(r => r.s.level === 'warn');
    const ok   = rows.filter(r => r.s.level === 'ok').length;
    const stat = `<div class="dash-stats">
      <div><b class="${bad.length ? 'bad' : ''}">${bad.length}</b><span>action needed</span></div>
      <div><b class="${warn.length ? 'warn' : ''}">${warn.length}</b><span>could be better</span></div>
      <div><b>${ok}</b><span>optimal</span></div>
    </div>`;
    const list = [...bad, ...warn].slice(0, 6).map(r =>
      dashLine(`<span class="dash-lg">${esc(r.fix.leagueName)}</span><span class="dash-badge ${r.s.level}">${esc(r.s.label)}</span>${r.s.detail ? `<span class="dash-sub">${esc(r.s.detail)}</span>` : ''}`));
    const more = bad.length + warn.length > 6 ? dashLine(`+ ${bad.length + warn.length - 6} more`, 'dim') : '';
    fill(stat + (list.length ? list.join('') + more : dashLine('Every lineup is set. ✓', 'good')));
  } catch (e) { fill(dashLine('Couldn’t load lineups: ' + esc(e.message), 'bad')); }
}

async function dashTrades() {
  const fill = body => dashFill('dash-trades', 'Open Trades', 'trades', body);
  if (!S.token && !S.auth?.has_token) {
    return fill(dashLine(S.auth
      ? 'Add your Sleeper token in <a href="/myprofile">your profile</a> to see pending trades.'
      : 'Paste your Sleeper token above to see pending trades.', 'dim'));
  }
  try {
    const { all } = await tradesLoad();
    const inc = all.filter(t => t.creator !== S.userId);
    const out = all.length - inc.length;
    const stat = `<div class="dash-stats">
      <div><b class="${inc.length ? 'warn' : ''}">${inc.length}</b><span>offered to you</span></div>
      <div><b>${out}</b><span>you sent</span></div>
    </div>`;
    const list = inc.slice(0, 4).map(t => dashLine(`<span class="dash-lg">${esc(t._lgName)}</span><span class="dash-sub">${t.created ? timeAgo(t.created) : ''}</span>`));
    fill(stat + (list.length ? list.join('') : dashLine('Nothing waiting on you.', 'dim')));
  } catch (e) { fill(dashLine('Couldn’t scan trades: ' + esc(e.message), 'bad')); }
}

async function dashDrafts() {
  const fill = body => dashFill('dash-drafts', 'Drafts', 'drafts', body);
  try {
    const season = S.nflState?.league_create_season || S.nflState?.season || String(new Date().getFullYear());
    const drafts = await api('/user/' + S.userId + '/drafts/nfl/' + season) || [];
    const live = drafts.filter(d => d.status === 'drafting' || d.status === 'paused');
    const soon = drafts.filter(d => d.status === 'pre_draft' && d.start_time && d.start_time > Date.now());
    const name = d => d.metadata?.name || S.leagues.find(l => l.league_id === d.league_id)?.name || 'Draft';
    const list = live.slice(0, 4).map(d => dashLine(
      `<span class="dash-lg">${esc(name(d))}</span><span class="dash-badge ${d.status === 'paused' ? 'warn' : 'ok'}">${d.status === 'paused' ? 'Paused' : 'Live'}</span>
       <button class="ghost-btn dash-act" onclick="trackDraft(${jsArg(String(d.draft_id))})">Track →</button>`));
    const next = soon.sort((a, b) => a.start_time - b.start_time)[0];
    fill(`<div class="dash-stats">
        <div><b class="${live.length ? 'warn' : ''}">${live.length}</b><span>live now</span></div>
        <div><b>${soon.length}</b><span>scheduled</span></div>
      </div>
      ${list.join('') || dashLine('No drafts in progress.', 'dim')}
      ${next ? dashLine(`Next: <span class="dash-lg">${esc(name(next))}</span> <span class="dash-sub">${new Date(next.start_time).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>`) : ''}`);
  } catch (e) { fill(dashLine('Couldn’t check drafts: ' + esc(e.message), 'bad')); }
}

// Scoped to the leagues you're playing for this year: every redraft league plus
// the dynasty leagues tagged Contender (Root For Me / League Summaries).
// Rebuilders and untagged dynasty leagues are left out, and so are guillotine
// leagues, whose record means something else. Standings and odds are League
// Summaries' — shown if it has run this session, never fetched from here; the
// only read is the contender tags (one call, skipped once anything has loaded them).
function dashInScope(lgId) {
  if (lsIsGuillotine(lgId)) return false;
  return rsLeagueCategory(lgId) === 'redraft' || RS.prefs[lgId]?.contender === true;
}
async function dashLeagues() {
  const fill = body => dashFill('dash-leagues', 'Your Leagues', 'leagues', body);
  try { if (RS._storedPrefs === undefined) await rsLoadPrefs(); } catch {}
  const scoped = S.leagues.filter(l => dashInScope(l.league_id));
  const redraft = scoped.filter(l => rsLeagueCategory(l.league_id) === 'redraft').length;
  const counts = dashLine(`<span class="dash-lg">${scoped.length}</span> of ${S.leagues.length} leagues
    <span class="dash-sub">contenders + redraft · ${scoped.length - redraft} contending dynasty, ${redraft} redraft</span>`);
  const data = scoped.map(l => LS.leagueData?.[l.league_id]).filter(Boolean);
  if (!LS.loaded || !data.length) {
    return fill(counts + dashLine('Standings, records and playoff odds are in League Summaries.', 'dim'));
  }
  let w = 0, l = 0, inPo = 0, haveOdds = 0;
  for (const d of data) {
    w += d.wins || 0; l += d.losses || 0;
    if (d.playoffOdds != null) { haveOdds++; if (d.playoffOdds > 0.5) inPo++; }
  }
  fill(counts + `<div class="dash-stats" style="margin-top:10px;">
      <div><b>${w}–${l}</b><span>combined record</span></div>
      ${haveOdds ? `<div><b>${inPo}</b><span>of ${haveOdds} likely in the playoffs</span></div>` : ''}
    </div>`);
}

// ── Welcome (no leagues loaded yet) ─────────────────────────────────────────────
const HOME_TILES = [
  ['leagues', 'League Summaries', 'Standings, records & playoff odds'],
  ['lineups', 'Lineups',          'Optimal lineups & start/sit'],
  ['rostership', 'Players',       'Who you own everywhere, and who owns the rest'],
  ['trades', 'Open Trades',       'Pending trades across leagues'],
  ['findtrade', 'Find a Trade',   'Partners by position, player or manager'],
  ['drafts', 'Drafts',            'Live drafts & the draft tracker'],
];
function homeWelcomeHtml() {
  return `<div class="home-welcome">
    <img src="/assets/ffhistorianlogo.png" alt="FF Historian" class="home-logo" />
    <h2 class="home-title">Welcome to the <span>FF Historian</span></h2>
    <div class="home-rule"></div>
    <p class="home-lede">Explore all the tools to help you manage your leagues</p>
    <div class="home-tiles">${HOME_TILES.map(([tab, name, desc]) =>
      `<a class="home-tile" href="/?tab=${tab}" data-tab="${tab}"><span class="home-tile-name">${name}</span><span class="home-tile-desc">${desc}</span></a>`).join('')}
    </div>
    <div class="home-rule wide"></div>
    <p class="home-note">
      ${S.auth
        ? 'Add your Sleeper username in <a href="/myprofile">your profile</a> to load your leagues and get started.'
        : 'Enter your Sleeper username above to load your leagues and get started.'}
      Play in ESPN leagues too? <a href="/espn-setup">Here’s how to connect them.</a>
    </p>
  </div>`;
}
