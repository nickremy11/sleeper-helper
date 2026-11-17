// The site menu — ONE definition, rendered into <nav id="sh-nav"> on every page.
//
// Every item is a real link (`/?tab=x`, `/analyzer`…), so middle-click, "open in
// new tab" and copying a link all work. Inside the main app (index.html, where
// window.sw exists) a plain left-click on a tab link is intercepted and switched
// in place instead of reloading the page.
//
// `also` lists the other tab keys that belong to an item — e.g. the Ranks Grid is
// a view inside Lineups, so `?tab=ranksgrid` still lights up "Lineups".
// `newTab` items open in a new browser tab: the analyzers are standalone pages,
// and opening them over the app would throw away everything it has loaded.

const SH_NAV = [
  { id: 'home',  label: 'Home',  tab: 'home' },
  { id: 'guide', label: 'Guide', tab: 'guide' },
  { id: 'my-leagues', label: 'My Leagues', items: [
    { label: 'League Summaries', tab: 'leagues' },
    { label: 'Scoreboard',       href: '/scoreboard' },
    { label: 'League Analyzer',  href: '/analyzer', newTab: true },
    { label: 'Lineups',          tab: 'lineups',    also: ['ranksgrid'] },
    { label: 'Players',          tab: 'rostership', also: ['player'] },
    { label: 'Waivers',          tab: 'waivers' },
  ] },
  { id: 'trades', label: 'Trades', items: [
    { label: 'Open Trades',    tab: 'trades' },
    { label: 'Find a Trade',   tab: 'findtrade', also: ['scout', 'offers', 'partners'] },
    { label: 'Trade Analyzer', href: '/trade-analyzer', newTab: true },
  ] },
  { id: 'drafts', label: 'Drafts', items: [
    { label: 'Live Drafts',     tab: 'drafts', also: ['tracker'] },
    { label: 'Dispersal',       href: '/dispersal' },
    { label: 'Auction Tracker', href: '/auction' },
  ] },
  { id: 'tools', label: 'Other Tools', items: [
    { label: 'ROI Tracker', tab: 'roi' },
    { label: 'Root For Me', href: '/rootforme' },
    { label: 'Monday Night Miracle', href: '/miracle' },
    { label: 'My Ranks',    href: 'https://myranks.ffhistorian.com' },
  ] },
];

// The one place the app's tab → nav-group mapping comes from (core.js reads it).
function shNavGroupOf(tab) {
  for (const g of SH_NAV) {
    if (g.tab === tab) return g.id;
    for (const it of (g.items || [])) {
      if (it.tab === tab || (it.also || []).includes(tab)) return g.id;
    }
  }
  return null;
}

function shNavInApp() {
  return typeof window.sw === 'function' && document.getElementById('content') && /^\/(index\.html)?$/.test(location.pathname);
}

function shNavHref(it) { return it.tab ? (it.tab === 'home' ? '/' : '/?tab=' + it.tab) : it.href; }

function shNavIsActive(it, tab) {
  if (it.tab) return tab != null && (it.tab === tab || (it.also || []).includes(tab));
  if (!it.href || /^https?:/.test(it.href)) return false;
  return location.pathname === it.href || location.pathname === it.href + '.html';
}

function shNavLink(it, cls, tab) {
  const active = shNavIsActive(it, tab);
  const tgt = it.newTab ? ' target="_blank" rel="noopener"' : '';
  const data = it.tab ? ` data-tab="${it.tab}"` : '';
  const ext = it.newTab ? ' <span class="tab-ext" aria-hidden="true">↗</span>' : '';
  return `<a class="${cls}${active ? ' active' : ''}" href="${shNavHref(it)}"${tgt}${data}${active ? ' aria-current="page"' : ''}>${it.label}${ext}</a>`;
}

// tab = the main app's current tab (null on standalone pages).
function shNavRender(tab) {
  const el = document.getElementById('sh-nav');
  if (!el) return;
  el.classList.add('tab-bar');
  el.setAttribute('aria-label', 'Site');
  const groups = SH_NAV.map(g => {
    if (!g.items) {
      const active = shNavIsActive(g, tab);
      return `<div class="tab-group${active ? ' active' : ''}" id="grp-${g.id}">${shNavLink(g, 'tab-group-btn tab-btn', tab)}</div>`;
    }
    const active = g.items.some(it => shNavIsActive(it, tab));
    return `<div class="tab-group${active ? ' active' : ''}" id="grp-${g.id}">
      <button type="button" class="tab-group-btn${active ? ' active' : ''}" aria-haspopup="true" aria-expanded="false"
        aria-controls="grp-${g.id}-menu" onclick="shNavToggle('grp-${g.id}')">${g.label} <span class="tab-group-arrow" aria-hidden="true">▾</span></button>
      <div class="tab-group-dropdown" id="grp-${g.id}-menu">${g.items.map(it => shNavLink(it, 'tab-btn', tab)).join('')}</div>
    </div>`;
  }).join('');
  // Second row: the tools inside the group you are in, so moving between them
  // is one click instead of opening the dropdown again.
  const cur = SH_NAV.find(g => g.items && g.items.some(it => shNavIsActive(it, tab)));
  const sub = cur
    ? `<div class="sub-bar" role="navigation" aria-label="${cur.label}"><div class="sub-bar-inner">${cur.items.map(it => shNavLink(it, 'sub-link', tab)).join('')}</div></div>`
    : '';
  el.classList.toggle('has-sub', !!cur);
  const dark = shThemeIsDark();
  const theme = `<button type="button" class="theme-btn" onclick="shThemeSet(!shThemeIsDark())" aria-pressed="${dark}" title="Switch to ${dark ? 'light' : 'dark'} mode">${dark ? '☀ Light' : '☾ Dark'}</button>`;
  el.innerHTML = `<div class="tab-bar-inner">${groups}${theme}</div>${sub}`;
}

// Light / dark. The choice is a cookie on .ffhistorian.com (so every ffhistorian
// site can read it) plus localStorage for hosts where that cookie can't be set.
// Each page's <head> applies it before first paint; this is the switch.
function shThemeIsDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
function shThemeSet(dark) {
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  const v = dark ? 'dark' : 'light';
  try { localStorage.setItem('sh_theme', v); } catch (e) {}
  const dom = /(^|\.)ffhistorian\.com$/.test(location.hostname) ? '; Domain=.ffhistorian.com' : '';
  document.cookie = 'sh_theme=' + v + '; Path=/; Max-Age=31536000; SameSite=Lax' + dom;
  const b = document.querySelector('#sh-nav .theme-btn');
  if (b) { b.textContent = dark ? '☀ Light' : '☾ Dark'; b.setAttribute('aria-pressed', String(dark)); b.title = 'Switch to ' + (dark ? 'light' : 'dark') + ' mode'; }
}

function shNavCloseAll(except) {
  document.querySelectorAll('#sh-nav .tab-group.open').forEach(g => {
    if (g.id === except) return;
    g.classList.remove('open');
    g.querySelector('.tab-group-btn')?.setAttribute('aria-expanded', 'false');
  });
}
function shNavToggle(id) {
  const grp = document.getElementById(id);
  if (!grp) return;
  const open = !grp.classList.contains('open');
  shNavCloseAll(id);
  grp.classList.toggle('open', open);
  grp.querySelector('.tab-group-btn')?.setAttribute('aria-expanded', String(open));
  if (open) grp.querySelector('.tab-group-dropdown a')?.focus();
}

document.addEventListener('click', e => {
  if (!e.target.closest('#sh-nav .tab-group')) shNavCloseAll();
  // In the app, an in-app tab link switches in place. Modified clicks (new tab,
  // new window) fall through to the browser.
  const a = e.target.closest('a[data-tab]');
  if (!a || !shNavInApp() || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  shNavCloseAll();
  window.sw(a.dataset.tab);
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('#sh-nav .tab-group.open');
  if (!open) return;
  shNavCloseAll();
  open.querySelector('.tab-group-btn')?.focus();
});

// Standalone pages: render as soon as the DOM is there. index.html renders it
// itself from sw(), so it can mark the active tab.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { if (!shNavInApp()) shNavRender(null); });
else if (!shNavInApp()) shNavRender(null);
