// Field Guide tab

// ── 4c. Field Guide ──────────────────────────────────────────────────────────
// A one-line index of everything on the site. Data-driven rather than 17 blocks
// of markup so it stays in step with the nav — and because every entry doubles
// as a link, the guide works as navigation, not just documentation.
//   tab:  switches to that dashboard tab      href: a standalone page
//   espn: has a real ESPN code path (not just Sleeper)
//   write: writes back to Sleeper — the tag text says what it writes
const GUIDE = [
  { title: 'In the dashboard', note: 'Tabs across the top of this app.', items: [
    { name:'League Summaries', tab:'leagues',    espn:true,
      desc:'Standings, record, all-play record and simulated playoff odds for every league on one screen.' },
    { name:'Rostership',       tab:'rostership', espn:true,
      desc:'How many of your leagues each player is on, so you can see your real exposure at a glance.' },
    { name:'Lineup Checker',   tab:'lineups',    espn:true, write:'Sets lineups',
      desc:'Flags empty slots and hurt starters everywhere, builds the best lineup, and sets it in Sleeper in one click. Click any row to see every replacement for that slot with its PPG, projection and rank. Search an injured starter to bench him in every league he is in at once.' },
    { name:'Weekly Ranks Grid',tab:'ranksgrid',  espn:true,
      desc:"Your own ranking sheet as seven position columns, with one league's roster painted on it — green starting, red benched." },
    { name:'Player Finder',    tab:'player',
      desc:'Look up any player for his dynasty value and every roster in your leagues he sits on.' },
    { name:'Waivers',          tab:'waivers',    espn:true,
      desc:'Dynasty: the best free agents left across all your leagues by FantasyCalc value. Redraft: your uploaded ranking sheet as a grid for one league, with your players in green and free agents in yellow. vs My Ranks: any of your My Ranks tier boards as a grid over one league, overall or broken out by position.' },
    { name:'Open Trades',      tab:'trades',
      desc:'Every pending trade offer across every league in one list, with real player names instead of ID numbers.' },
    { name:'Trade Partners',   tab:'partners',
      desc:"Type another manager's name and see every league you share with them." },
    { name:'Scout',            tab:'scout',      espn:true,
      desc:"Hunts for trade openings — where you're contending and someone's rebuilding, or who's stacked at a position." },
    { name:'Mass Offers',      tab:'offers',     write:'Sends trades',
      desc:'Shop one of your players to a whole league, or bid a draft pick for a player in every league he is on — review each offer, then send them all.' },
    { name:'Draft Queue',      tab:'drafts',
      desc:'Every draft you have running right now, and how many picks until your turn in each.' },
    { name:'In-Draft Tracker', tab:'tracker',    espn:true,
      desc:"A live board with ADP, tiers and your starred targets while you're on the clock." },
    { name:'ROI Tracker',      tab:'roi',        espn:true,
      desc:'Dues, winnings and finish for every league you have played in, year by year, with profit and ROI per season and all time. Finishes come from Sleeper and ESPN; money is entered by hand or imported once from your spreadsheet.' },
  ]},
  { title: 'Standalone tools', note: 'Their own pages — shareable links you can send to a leaguemate.', items: [
    { name:'League Analyzer',      href:'/analyzer',        espn:true,
      desc:'Every team in one league ranked by roster value, positional strength, draft capital and starter strength. "View vs Ranks" lays one of your My Ranks boards over the league instead.' },
    { name:'Trade Analyzer',       href:'/trade-analyzer',  espn:true, write:'Sends trades',
      desc:"Build a two- or three-team trade, see what it does to each roster's rank and playoff odds, and send it as an offer in Sleeper." },
    { name:'Auction Draft Tracker',href:'/auction',         espn:true,
      desc:'Live budgets, inflation and position scarcity while an auction runs, synced to the draft or tracked by hand.' },
    { name:'Dispersal',            href:'/dispersal',
      desc:'A shared realtime draft room for splitting up an abandoned dynasty roster.' },
    { name:'Root For Me',          href:'/rootforme',       espn:true,
      desc:"Which way to root in each NFL game, weighted by whether you're contending or rebuilding in each league — plus Live Matchups, your projected record with every matchup sorted from Mortal Lock to Lost Cause, and the Monday Night Miracle: what every live matchup needs from the players left, and the box scores that win the most $." },
    { name:'My Ranks',             href:'https://myranks.ffhistorian.com',
      desc:'Your own player and pick tiers, kept in one place and shareable with other managers.' },
    { name:'My Profile',           href:'/myprofile',
      desc:'Your account, your Sleeper auth token and your ESPN league credentials.' },
    { name:'Connecting ESPN',      href:'/espn-setup',      espn:true,
      desc:'What ESPN needs to let this site read your leagues, where to find the two cookies, and what works once they are in.' },
  ]},
];

function renderGuide() {
  const count = GUIDE.reduce((n, sec) => n + sec.items.length, 0);
  const tagEspn  = '<span class="gd-tag gd-tag-espn">ESPN</span>';
  const tagWrite = txt => `<span class="gd-tag gd-tag-write">${esc(txt)}</span>`;

  const rows = sec => sec.items.map(it => {
    const target = it.tab
      ? `<button class="gd-name" onclick="sw('${esc(it.tab)}')">${esc(it.name)}</button>`
      : `<a class="gd-name" href="${esc(it.href)}">${esc(it.name)}</a>`;
    const slug = it.tab ? esc(it.name) : esc(it.href.replace(/^https?:\/\//, ''));
    return `<div class="gd-row">
      <div class="gd-slug">${slug}</div>
      <div>${target}<div class="gd-desc">${esc(it.desc)}</div></div>
      <div class="gd-tags">${it.espn ? tagEspn : ''}${it.write ? tagWrite(it.write) : ''}</div>
    </div>`;
  }).join('');

  setC(`<div>
    <div class="section-head"><h2>Field Guide</h2><div class="section-head-line"></div></div>
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
      <div class="gd-legend-foot">Browsing works without an account. Signing in is what saves your settings and lets you <a href="/espn-setup" style="color:var(--brown-mid);">connect ESPN leagues</a>.</div>
    </div>
  </div>`);
}
