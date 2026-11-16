// Field Guide tab

// ── 4c. Field Guide ──────────────────────────────────────────────────────────
// A one-line index of everything on the site. Data-driven rather than 17 blocks
// of markup so it stays in step with the nav — and because every entry doubles
// as a link, the guide works as navigation, not just documentation.
//   tab:  switches to that dashboard tab      href: a standalone page
//   espn: has a real ESPN code path (not just Sleeper)
//   write: writes back to Sleeper — the tag text says what it writes
// Grouped exactly like the menu (shared-nav.js SH_NAV). A tool with several views
// lists each view, so the guide also says where a merged tool went.
const GUIDE = [
  { title: 'My Leagues', note: 'Your leagues, week to week.', items: [
    { name:'Home',             tab:'home',       espn:true,
      desc:'This Week at a glance once your leagues load: which lineups need action, trade offers waiting on you (with a warning for any trade you sent that can still be accepted after a player kicks off), and your starred matchups with your projected record.' },
    { name:'League Summaries', tab:'leagues',    espn:true,
      desc:'Standings, record, all-play record and simulated playoff odds for every league on one screen. Click a league name to open it in the League Analyzer.' },
    { name:'Scoreboard',       href:'/scoreboard', espn:true,
      desc:"Every matchup this week, live: score now, projection for what's left, win %, sorted from Mortal Lock to Lost Cause. Click one for both lineups, each player tagged with his Root For Me score; star a league to pin it to the top." },
    { name:'League Analyzer',  href:'/analyzer', espn:true, newTab:true,
      desc:'Every team in one league ranked by roster value, positional strength, draft capital and starter strength. "View vs Ranks" lays one of your My Ranks boards over the league instead, and your own positional rank shows beside each player. Devy leagues show each college placeholder under its real name.' },
    { name:'Lineups',          tab:'lineups',    espn:true, write:'Sets lineups',
      desc:'Flags empty slots and hurt starters everywhere, builds the best lineup, and sets it in Sleeper in one click. Click any row to see every replacement for that slot with its PPG, projection and rank. Search an injured starter to bench him in every league he is in at once. Free-agent watch flags a pickup projected to beat your worst starter, and you can upload your weekly ranking sheet (a CSV, or a screenshot of it) to optimize by rank instead of projection.' },
    { name:'Lineups · Ranks grid', tab:'ranksgrid', espn:true,
      desc:"The second view in Lineups: your weekly ranking sheet as position columns, with one league's roster painted on it — green starting, red benched, yellow free agent." },
    { name:'Players',          tab:'rostership', espn:true,
      desc:'Look up any player to see who owns him in every league, with that team’s playoff odds and a side-by-side roster comparison. Below it, how many of your leagues each of your players is on.' },
    { name:'Waivers',          tab:'waivers',    espn:true,
      desc:'Dynasty: the best free agents left across all your leagues by FantasyCalc value. Redraft: your uploaded ranking sheet as a grid for one league, with your players in green and free agents in yellow. vs My Ranks: any of your My Ranks tier boards as a grid over one league, overall or broken out by position.' },
  ]},
  { title: 'Trades', note: 'Finding, weighing and sending trades.', items: [
    { name:'Open Trades',      tab:'trades',
      desc:'Every pending trade offer across every league in one list, with real player names instead of ID numbers.' },
    { name:'Find a Trade · By position', tab:'scout', espn:true,
      desc:"Scout every league for trade openings — where you're contending and someone's rebuilding, or who's stacked at a position." },
    { name:'Find a Trade · By player',   tab:'offers', write:'Sends trades',
      desc:'Shop one of your players to a whole league, or bid a draft pick for a player in every league he is on — review each offer, then send them all.' },
    { name:'Find a Trade · By manager',  tab:'partners',
      desc:'Pick any manager you share a league with and see every league you have in common, and who owns a given player on each side.' },
    { name:'Trade Analyzer',   href:'/trade-analyzer', espn:true, write:'Sends trades', newTab:true,
      desc:"Build a two- or three-team trade, see what it does to each roster's rank and playoff odds, and send it as an offer in Sleeper, with a DM to the other manager. Your My Ranks rank shows beside each player." },
  ]},
  { title: 'Drafts', note: 'Before and during a draft.', items: [
    { name:'Live Drafts',      tab:'drafts',
      desc:'Every draft you have running right now, and how many picks until your turn in each.' },
    { name:'Live Drafts · Draft tracker', tab:'tracker', espn:true,
      desc:"A live board with ADP, tiers and your starred targets while you're on the clock." },
    { name:'Auction Tracker',  href:'/auction',   espn:true,
      desc:'Live budgets, inflation and position scarcity while an auction runs, synced to the draft or tracked by hand.' },
    { name:'Dispersal',        href:'/dispersal',
      desc:'A shared realtime draft room for splitting up an abandoned dynasty roster.' },
  ]},
  { title: 'Other Tools', note: 'The rest of the site.', items: [
    { name:'ROI Tracker',      tab:'roi',        espn:true,
      desc:'Dues, winnings and finish for every league you have played in, year by year, with profit and ROI per season and all time. Finishes come from Sleeper and ESPN; money is entered by hand or imported once from your spreadsheet.' },
    { name:'Root For Me',      href:'/rootforme', espn:true,
      desc:"Which way to root in each NFL game, weighted by whether you're contending or rebuilding in each league — plus the Monday Night Miracle: what every live matchup needs from the players left, and the box scores that win the most $." },
    { name:'My Ranks',         href:'https://myranks.ffhistorian.com',
      desc:'Your own player and pick tiers, kept in one place and shareable with other managers.' },
    { name:'My Profile',       href:'/myprofile',
      desc:'Your account, your Sleeper auth token and your ESPN league credentials.' },
    { name:'Connecting ESPN',  href:'/espn-setup', espn:true,
      desc:'What ESPN needs to let this site read your leagues, where to find the two cookies, and what works once they are in.' },
  ]},
];

// "Getting started" — the setup order, each step saying what it unlocks, so a
// new user can see why a tool is empty before they go looking for a bug.
function guideStartHtml() {
  const signedIn = !!S.auth;
  const hasUser  = !!S.userId;
  const hasToken = !!S.auth?.has_token;
  const step = (done, title, body) => `<li class="gd-step${done ? ' done' : ''}">
    <div class="gd-step-title">${done ? '✓ ' : ''}${title}</div><div class="gd-step-body">${body}</div></li>`;
  return `<div class="gd-start">
    <h3>Getting started</h3>
    <p class="gd-start-lede">Four steps, in this order. Each one switches on more of the site, and you can stop after any of them.</p>
    <ol>
      ${step(hasUser, 'Load your leagues',
        'Type your Sleeper username in the box at the top of the page and press Load. That alone fills League Summaries, Players, Waivers, Scout, the Scoreboard and both analyzers with every league you are in.')}
      ${step(signedIn, 'Create a free account',
        'Use Sign in at the top right. An account remembers your username, saves your Root For Me and Scoreboard settings across devices, and is needed for ROI Tracker, ESPN and My Ranks.')}
      ${step(hasToken, 'Add your Sleeper token to make changes',
        'Without it everything still reads and previews. With it saved in <a href="/myprofile">your profile</a>, you can apply lineups, send trade offers, and see pending trades. It is stored encrypted and only used for those writes.')}
      ${step(!!S.espnSettings?.has_credentials, 'Connect ESPN (optional)',
        'Play in ESPN leagues too? Add two cookies in <a href="/myprofile">your profile</a> and your ESPN leagues join the tools tagged ESPN below. <a href="/espn-setup">The walkthrough is here.</a> ESPN is read-only: you still set those lineups in ESPN.')}
    </ol>
    <p class="gd-start-more"><strong>Then, to go further:</strong> build tiered boards in <a href="https://myranks.ffhistorian.com">My Ranks</a> to see them over any league in Waivers and the Analyzer; upload your weekly ranking sheet in Lineups to optimize by rank; star leagues on the <a href="/scoreboard">Scoreboard</a> to pin them to Home; set contender or rebuilder and your $ values in <a href="/rootforme">Root For Me</a>.</p>
  </div>`;
}

function renderGuide() {
  const count = GUIDE.reduce((n, sec) => n + sec.items.length, 0);
  const tagEspn  = '<span class="gd-tag gd-tag-espn">ESPN</span>';
  const tagWrite = txt => `<span class="gd-tag gd-tag-write">${esc(txt)}</span>`;

  const rows = sec => sec.items.map(it => {
    const target = it.tab
      ? `<a class="gd-name" href="/?tab=${esc(it.tab)}" data-tab="${esc(it.tab)}">${esc(it.name)}</a>`
      : `<a class="gd-name" href="${esc(it.href)}"${it.newTab ? ' target="_blank" rel="noopener"' : ''}>${esc(it.name)}${it.newTab ? ' ↗' : ''}</a>`;
    const slug = it.tab ? esc(it.name) : esc(it.href.replace(/^https?:\/\//, ''));
    return `<div class="gd-row">
      <div class="gd-slug">${slug}</div>
      <div>${target}<div class="gd-desc">${esc(it.desc)}</div></div>
      <div class="gd-tags">${it.espn ? tagEspn : ''}${it.write ? tagWrite(it.write) : ''}</div>
    </div>`;
  }).join('');

  setC(`<div>
    <div class="section-head"><h2>Field Guide</h2><div class="section-head-line"></div></div>
    ${guideStartHtml()}
    <p class="gd-lede">${count} tools for running a lot of fantasy teams at once. Everything here reads your live leagues — nothing is a mock-up or a spreadsheet you have to keep up by hand.</p>
    ${GUIDE.map(sec => `<div class="gd-sec">
      <div class="section-head" style="margin-bottom:14px;"><h2>${esc(sec.title)}</h2><div class="section-head-line"></div></div>
      <p class="gd-note">${esc(sec.note)}</p>
      ${rows(sec)}
    </div>`).join('')}
    <div class="gd-legend">
      <h3>Reading the tags</h3>
      <dl>
        <dt>${tagEspn}</dt>
        <dd>Works with your ESPN leagues as well as Sleeper. Untagged tools are Sleeper only.</dd>
        <dt>${tagWrite}</dt>
        <dd>Writes back to Sleeper. Everything else only ever reads. ESPN leagues are always read-only — you'll still set those lineups in ESPN.</dd>
      </dl>
      <div class="gd-legend-foot">Prefer a darker page? The ☾ Dark button in the menu switches themes on every page. Browsing works without an account. Signing in is what saves your settings and lets you <a href="/espn-setup">connect ESPN leagues</a>.</div>
    </div>
  </div>`);
}
