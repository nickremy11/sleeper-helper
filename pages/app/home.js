// Home. Before your leagues load it's the welcome page; once they're in, it's
// "This Week": three cards, each linking to the tool that does the work.
//
// Every card reuses the tool's own loader and cache, so opening Home warms the
// tab you go to next instead of costing an extra fetch:
//   Lineups    — luEnsureLineupData (5-min cache) + luLineupStatus, the card badges
//   Trades     — tradesLoad (5-min cache), the Open Trades scan; offers TO me in
//                full, plus a warning for any I sent that outlive a kickoff
//   Scoreboard — the Scoreboard's own reads and maths (league-matchups.js,
//                matchup-tracker.js): projected record for the leagues I'm
//                contending in, then the favourites starred on /scoreboard

// league-matchups.js (shared with the Scoreboard) reads a global API, and its
// lmSide() names players with mnmName — both defined per page.
const API = SH_API;
function mnmName(pid) {
  const p = S.playerMap[pid];
  if (p?.position === 'DEF') return `${pid} D/ST`;
  return p?.full_name || `${p?.first_name || ''} ${p?.last_name || ''}`.trim() || pid;
}
const DASH = { games: {}, sb: null };

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
      <section class="dash-card dash-wide" id="dash-scoreboard" aria-live="polite">${dashHead('Scoreboard', 'scoreboard', '/scoreboard')}${loading('Reading this week’s matchups')}</section>
    </div>
    <p class="dash-foot">Looking for something else? <a href="/?tab=guide" data-tab="guide">Every tool, one line each, in the Guide →</a></p>
  </div>`);
  dashLineups(regular);
  dashTrades(regular);
  dashScoreboard(regular);
}

// `href` is for a card whose tool is its own page (the Scoreboard) rather than a tab.
function dashHead(title, tab, href) {
  return `<div class="dash-head"><h3>${title}</h3><a href="${href || `/?tab=${tab}`}"${href ? '' : ` data-tab="${tab}"`}>Open →</a></div>`;
}
// Fill one card's body, unless the user has already moved on.
function dashFill(id, title, tab, body, href) {
  if (S.tab !== 'home') return;
  const el = document.getElementById(id);
  if (el) el.innerHTML = dashHead(title, tab, href) + body;
}
const dashLine = (txt, cls = '') => `<div class="dash-line ${cls}">${txt}</div>`;
const dashWhen = ms => new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

// One week's NFL games (kickoff, state, clock), memoised per week — the Trades
// warning and the Scoreboard both read it, and the worker caches it for 5 min.
function dashGames(week) {
  const season = S.nflState?.season;
  return DASH.games[week] ||= fetch(`${API}/espn/games?week=${week}&season=${season}`)
    .then(r => r.ok ? r.json() : []).catch(() => []);
}

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

// Offers TO me in full (what I'd get, what I'd give, who from, when it lapses),
// then a warning for every trade I SENT that can still be accepted after one of
// its players' games kicks off — an acceptance after kickoff moves that game's
// points to the other side, which is rarely what the offer meant.
async function dashTrades(regular) {
  const fill = body => dashFill('dash-trades', 'Open Trades', 'trades', body);
  if (!S.token && !S.auth?.has_token) {
    return fill(dashLine(S.auth
      ? 'Add your Sleeper token in <a href="/myprofile">your profile</a> to see pending trades.'
      : 'Paste your Sleeper token above to see pending trades.', 'dim'));
  }
  try {
    const { all, rMaps } = await tradesLoad();
    const inc = all.filter(t => t.creator !== S.userId);
    const out = all.filter(t => t.creator === S.userId);
    const games = regular ? await dashGames(luWeekFor(S.nflState)) : [];
    const warns = dashTradeWarnings(out, games);

    const stat = `<div class="dash-stats">
      <div><b class="${inc.length ? 'warn' : ''}">${inc.length}</b><span>offered to you</span></div>
      <div><b>${out.length}</b><span>you sent</span></div>
      ${warns.length ? `<div><b class="bad">${warns.length}</b><span>sent, expiring after kickoff</span></div>` : ''}
    </div>`;

    const incHtml = inc.slice(0, 4).map(t => {
      const sides = tradeSides(t, rMaps[t._lgId] || {}, t._myRid);
      const names = s => s.items.map(i => esc(i.txt)).join(', ') || '—';
      const exp = t.settings?.expires_at ? t.settings.expires_at * 1000 : null;
      return `<div class="dash-trade">
        <div class="dash-trade-top"><span class="dash-lg">${esc(t._lgName)}</span>
          <span class="dash-sub">from ${esc(sides[1].name)}${exp ? ` · expires ${dashWhen(exp)}` : t.created ? ` · ${timeAgo(t.created)}` : ''}</span></div>
        <div class="dash-trade-row"><b>Get</b> ${names(sides[0])}</div>
        <div class="dash-trade-row"><b>Give</b> ${names(sides[1])}</div>
      </div>`;
    }).join('');
    const incMore = inc.length > 4 ? dashLine(`+ ${inc.length - 4} more in <a href="/?tab=trades" data-tab="trades">Open Trades</a>`, 'dim') : '';

    const warnHtml = warns.slice(0, 5).map(w => dashLine(
      `<span class="dash-badge bad">⚠ Expires after kickoff</span><span class="dash-lg">${esc(w.t._lgName)}</span>
       <span class="dash-sub">expires ${dashWhen(w.exp)} — ${esc(w.name)} (${esc(w.team)}) ${w.kickoff <= Date.now() ? 'already started' : 'kicks off ' + dashWhen(w.kickoff)}</span>`)).join('');
    const warnMore = warns.length > 5 ? dashLine(`+ ${warns.length - 5} more`, 'dim') : '';

    fill(stat + (incHtml ? incHtml + incMore : dashLine('Nothing waiting on you.', 'dim')) + warnHtml + warnMore);
  } catch (e) { fill(dashLine('Couldn’t scan trades: ' + esc(e.message), 'bad')); }
}

// For each trade I sent: the earliest game among its players that kicks off before
// the offer lapses. Offers with no expiry, and picks (no game), never warn.
function dashTradeWarnings(out, games) {
  const kick = {};
  for (const g of games || []) for (const tm of [g.home, g.away]) kick[tm] = g;
  const warns = [];
  for (const t of out) {
    const exp = t.settings?.expires_at ? t.settings.expires_at * 1000 : null;
    if (!exp) continue;
    let worst = null;
    for (const pid of new Set([...Object.keys(t.adds || {}), ...Object.keys(t.drops || {})])) {
      const p = S.players[pid], team = p?.team || pid, g = kick[team];
      const ko = g?.kickoff ? new Date(g.kickoff).getTime() : NaN;
      if (!(ko < exp)) continue;
      // Game over: his points are banked and the offer can't change that.
      if (g.state === 'post') continue;
      if (!worst || ko < worst.kickoff) {
        worst = { t, exp, kickoff: ko, state: g.state, team, name: p?.full_name || (p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : 'Player ' + pid) };
      }
    }
    if (worst) warns.push(worst);
  }
  return warns.sort((a, b) => a.kickoff - b.kickoff);
}

// Scoped to the leagues you're playing for this year: every redraft league plus
// the dynasty leagues tagged Contender (Root For Me / League Summaries).
// Rebuilders and untagged dynasty leagues are left out, and so are guillotine
// leagues, whose record means something else.
function dashInScope(lgId) {
  if (lsIsGuillotine(lgId)) return false;
  return rsLeagueCategory(lgId) === 'redraft' || RS.prefs[lgId]?.contender === true;
}

// Favourites starred on /scoreboard: the account's copy when signed in (the server
// wins once it has any), else this browser's — the Scoreboard's own rule (favLoad).
async function dashFavs() {
  let favs = [];
  try { favs = JSON.parse(localStorage.getItem(`sb_favs_${S.userId}`) || '[]'); } catch {}
  if (S.auth) {
    try {
      const r = await fetch(`${API}/scoreboard/favorites`, { credentials: 'include' });
      if (r.ok) { const s = (await r.json()).favs || []; if (s.length) favs = s; }
    } catch {}
  }
  return new Set(favs);
}

const DASH_SB_TTL = 2 * 60 * 1000;
const DASH_TIER_BADGE = { lock: 'ok', good: 'ok', toss: 'warn', bad: 'bad', dead: 'bad' };

// A compact read of the Scoreboard: the projected record across the leagues I'm
// contending in (a matchup counts as a win when my projection is ahead), then each
// favourite's matchup. Same reads and maths as /scoreboard — week included, which
// follows display_week there — just no lineups, filters or median odds.
async function dashScoreboard(regular) {
  const fill = body => dashFill('dash-scoreboard', 'Scoreboard', 'scoreboard', body, '/scoreboard');
  if (!regular) return fill(dashLine('No regular-season games this week.', 'dim'));
  const st = S.nflState || {};
  const week = st.display_week || st.week || 1;
  if (DASH.sb && DASH.sb.week === week && Date.now() - DASH.sb.at < DASH_SB_TTL) return fill(DASH.sb.html);
  try {
    await loadPlayers();
    try { if (RS._storedPrefs === undefined) await rsLoadPrefs(); } catch {}
    // The globals league-matchups.js reads, set to this week.
    S.season = String(st.season); S.week = week; S.playerMap = S.players; S.espnSkips = [];
    ridLoad();
    const favs = await dashFavs();
    const leagues = S.leagues.filter(l => dashInScope(l.league_id) || favs.has(l.league_id));
    const [games, proj, { results }] = await Promise.all([
      dashGames(week),
      fetch(`${API}/sleeper/projections/nfl/regular/${S.season}/${week}`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetchMatchupsFor(leagues, week),
    ]);
    S.nflGames = games || []; S.mnmProj = proj;

    const fracs = lmGameFrac();
    const rows = [];
    for (const r of results) {
      if (r.league.settings?.type === 3) continue;   // guillotine: no opponent to be ahead of
      if (!r.oppMatchup || r.myMatchup.matchup_id === null) continue;
      const my = lmSide(r.myMatchup, r, fracs), opp = lmSide(r.oppMatchup, r, fracs);
      if (!my.proj && !opp.proj && !my.now && !opp.now) continue;   // lineups not set yet
      rows.push({ lg: r.league, my, opp, ...lmEvaluate(my, opp) });
    }

    const contending = rows.filter(r => dashInScope(r.lg.league_id));
    let body;
    if (!contending.length) {
      body = dashLine('No contending matchups to project yet — lineups usually appear once the week opens.', 'dim');
    } else {
      const s = lmSummary(contending);
      const tiers = LM_TIERS.filter(t => s.tiers[t.key]).map(t => `${s.tiers[t.key]} ${t.label}`).join(' · ');
      body = `<div class="dash-stats">
          <div><b>${s.w}–${s.l}${s.t ? '–' + s.t : ''}</b><span>projected record</span></div>
          <div><b>${s.exp.toFixed(1)}</b><span>expected wins</span></div>
          ${s.started ? `<div><b>${s.upW}–${s.upL}${s.upT ? '–' + s.upT : ''}</b><span>ahead right now</span></div>` : ''}
        </div>
        ${dashLine(`${contending.length} contending matchup${contending.length === 1 ? '' : 's'} · Week ${week}${tiers ? ' · ' + tiers : ''}`, 'dim')}`;
    }

    const favRows = rows.filter(r => favs.has(r.lg.league_id)).sort((a, b) => b.p - a.p);
    const tierLabel = Object.fromEntries(LM_TIERS.map(t => [t.key, t.label]));
    body += `<div class="dash-subhead">★ Favourites</div>` + (favRows.length
      ? favRows.map(r => dashLine(
          `<span class="dash-lg">${esc(r.lg.name)}</span>
           <span class="dash-sub">${r.my.proj.toFixed(1)} – ${r.opp.proj.toFixed(1)} · ${Math.round(r.p * 100)}% to win</span>
           <span class="dash-badge ${r.final ? (r.mu > 0 ? 'ok' : 'bad') : DASH_TIER_BADGE[r.tier]}">${r.final ? (r.mu > 0 ? 'Won' : 'Lost') : tierLabel[r.tier]}</span>`)).join('')
      : dashLine(favs.size
          ? 'None of your favourites have a matchup this week.'
          : 'Star leagues on the <a href="/scoreboard">Scoreboard</a> to pin them here.', 'dim'));
    DASH.sb = { week, at: Date.now(), html: body };
    fill(body);
  } catch (e) { fill(dashLine('Couldn’t read the scoreboard: ' + esc(e.message), 'bad')); }
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
    <h2 class="home-title">Welcome to <span>League Assist</span></h2>
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
      New to FF Historian? <a href="https://ffhistorian.com/getting-started/">Getting Started</a> walks through every step and what it unlocks.
    </p>
  </div>`;
}
