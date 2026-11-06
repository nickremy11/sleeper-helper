// Weekly Ranks Grid tab

// ── 4b. Weekly Ranks Grid ────────────────────────────────────────────────────
// The uploaded sheet, laid out as its seven ranked lists side by side, with your
// roster in one league painted onto it: green where a player makes the starting
// lineup, red where he's rostered but doesn't. Which lineup "starting" means is
// the mode toggle — the point is to flip between ranks and projections and see
// where the two disagree.
const RG = { leagueIdx: 0, mode: 'current', _sig: null, msg: null };   // mode: current | ranks | projections; msg: {leagueId, color, text}
// K and DEF are still parsed and still drive the optimizer — they're dropped from
// the GRID only, where two short columns cost as much width as a long one and
// neither is a call you make by scanning a list.
// Third element is the MOST adjacent parts the column may be cut into — how many
// it actually gets depends on the width available (rgAllocParts). A long list
// reads better side by side than as one column you have to scan past several
// times, but only while every track stays wide enough to show a full name.
const RG_COLS = [['QB','QB'], ['RB','RB', 2], ['WR','WR', 2], ['TE','TE'], ['FLEX','FLEX', 3]];
// K and D/ST ride UNDER an existing column rather than taking tracks of their
// own — two short lists as full columns would cost as much width as a long one.
// Shown only when the uploaded sheet carries those blocks.
const RG_STACK = { QB: ['K', 'K'], TE: ['DEF', 'D/ST'] };
const RG_SPLIT_MIN = 20;   // rows per part — a shorter sheet drops to fewer parts
                           // rather than rendering stubs
const RG_TRACK_MIN = 190;  // px a track needs before names start ellipsizing
const RG_WRAP_GAP  = 10;   // must match .rg-wrap's gap
// FLEX's two extra parts are the BASELINE — the shape this grid is meant to have
// at any width, so they're granted on row count alone. WR's and RB's second parts
// are bought with screen width, in this order. Splitting FLEX unconditionally is
// deliberate: gating it on RG_TRACK_MIN too would have quietly taken the 3-way
// FLEX split away from every 1366-1440px laptop.
const RG_SPLIT_BASE = ['FLEX', 'FLEX'];
const RG_SPLIT_WIDE = ['WR', 'RB'];
const RG_MODES = [['current','Current lineup'], ['ranks','Ranked optimal'], ['projections','Projection optimal']];

async function renderRanksGrid(force = false) {
  if (force || !luCacheFresh()) setC(loading('Loading ranks grid'));
  try { await luEnsureLineupData(force); rgDraw(); }
  catch (e) { setC(errHtml(e)); }
}

function rgSetLeague(v) { RG.leagueIdx = parseInt(v, 10) || 0; RG.msg = null; rgDraw(); }
function rgSetMode(m)   { RG.mode = m; RG.msg = null; rgDraw(); }

// Optimize + Apply from the grid. The proposal is the exact one the lineup card
// would show (luProposal, cached on the fixture) and the write is the card's own
// luPutStarters, so the two views can never disagree about what "optimal" means
// or how it gets set. In Current mode the bar is just a status line per source
// whose button switches the highlight to that proposal; in an optimal mode it
// lists what changes and offers the Apply.
function rgApplyBarHtml(fix) {
  if (!fix) return '';
  const msg = RG.msg && RG.msg.leagueId === fix.leagueId
    ? `<span style="color:${RG.msg.color};">${esc(RG.msg.text)}</span>` : '';
  const pc  = luPtsCtx(fix);
  const tot = list => list.reduce((t, p) => t + luPlayerPts(p, pc), 0);
  const diff = src => {
    const prop = luProposal(fix, src);
    if (!prop) return null;
    const cur = fix.starters.map(String), nxt = prop.map(String);
    const curSet = new Set(cur), nxtSet = new Set(nxt);
    return {
      prop,
      changed: nxt.some((p, i) => p !== cur[i]),
      ins:  nxt.filter(p => p && p !== '0' && !curSet.has(p)),
      outs: cur.filter(p => p && p !== '0' && !nxtSet.has(p)),
      d:    tot(prop) - tot(fix.starters),
    };
  };
  const label = src => src === 'ranks' ? 'ranking sheet' : 'projections';

  if (RG.mode === 'current') {
    const part = src => {
      if (!luCanOptimize(src)) return '';
      const x = diff(src);
      if (!x) return '';
      const m = src === 'ranks' ? 'ranks' : 'projections';
      return x.changed
        ? `<button class="ghost-btn" style="font-size:0.5rem;" onclick="rgSetMode('${m}')">⚡ Optimize with ${src === 'ranks' ? 'Ranks' : 'Projections'}</button>`
        : `<span style="color:#5fae5f;">✓ optimal by ${label(src)}</span>`;
    };
    const parts = [part('ranks'), part('projections')].filter(Boolean);
    if (!parts.length && !msg) return '';
    return `<div class="rg-apply">${parts.join('')}${msg}</div>`;
  }

  const src = RG.mode === 'ranks' ? 'ranks' : 'projections';
  if (!luCanOptimize(src)) {
    return `<div class="rg-apply"><span style="color:#c0504d;">${src === 'ranks'
      ? 'No ranking sheet uploaded for week ' + LU.week + '.' : 'No projections for week ' + LU.week + ' yet.'}</span></div>`;
  }
  const x = diff(src);
  if (!x) return '';
  if (!x.changed) return `<div class="rg-apply"><span style="color:#5fae5f;">✓ Already optimal by ${label(src)}</span>${msg}</div>`;
  const names = list => list.map(p => esc(luPlayerName(p))).join(', ');
  // Same rule as the card: the delta is always in projections, so in ranks mode
  // a negative number is the sheet and the projections disagreeing, not a bug.
  const dc = x.d >= 0.05 ? '#5fae5f' : x.d <= -0.05 ? '#d08a30' : 'var(--brown-light)';
  const swaps = x.ins.length || x.outs.length
    ? `<span class="rg-ap-grp"><b>In</b> ${names(x.ins) || '—'}</span><span class="rg-ap-grp"><b>Out</b> ${names(x.outs) || '—'}</span>`
    : `<span class="rg-ap-grp">same players, slots reshuffled</span>`;
  const act = fix._espn ? '<span style="color:var(--brown-light);">set it in ESPN</span>'
    : luCanWrite() ? `<button class="setup-btn" style="padding:5px 12px;font-size:0.6rem;" onclick="rgApply()">Apply this lineup</button>`
    : '<span style="color:var(--brown-light);">preview only — <a href="/myprofile">add a Sleeper token</a> to apply</span>';
  return `<div class="rg-apply">
      <span class="rg-ap-grp"><b>By ${label(src)}</b></span>${swaps}
      <span class="rg-ap-grp" style="color:${dc};">${x.d >= 0 ? '+' : ''}${x.d.toFixed(1)} proj</span>
      ${act}${msg}
    </div>`;
}

async function rgApply() {
  const fix = LU.lineups[RG.leagueIdx];
  if (!fix || fix._espn || !luCanWrite() || RG.mode === 'current') return;
  const prop = luProposal(fix, RG.mode === 'ranks' ? 'ranks' : 'projections');
  if (!prop) return;
  RG.msg = { leagueId: fix.leagueId, color: 'var(--brown-light)', text: 'applying…' };
  rgDraw();
  try {
    const ok = await luPutStarters(fix, prop);
    RG.msg = { leagueId: fix.leagueId, color: ok ? '#5fae5f' : '#d08a30',
               text: ok ? '✓ lineup set' : '⚠ saved but Sleeper returned a different lineup' };
    // Back to the live lineup, so the green you now see is what Sleeper has.
    RG.mode = 'current';
  } catch (e) {
    RG.msg = { leagueId: fix.leagueId, color: '#c0504d', text: '✗ ' + (e.message || 'failed') };
  }
  if (S.tab === 'ranksgrid') rgDraw();
}

// The players counted as starting under the selected mode, in slot order. The
// grid only needs the set, but the unranked-starters line needs them in lineup
// order, so both read one list rather than deriving the same thing twice.
function rgStarterList(fix, mode) {
  if (!fix) return null;
  if (mode === 'current') return fix.starters.map(String);
  const prop = luProposal(fix, mode === 'ranks' ? 'ranks' : 'projections');
  return prop ? prop.map(String) : null;
}

function rgStarterSet(fix, mode) {
  const list = rgStarterList(fix, mode);
  return list ? new Set(list) : null;
}

// Starters who appear nowhere in the grid, which is worth saying out loud: the
// grid is the whole sheet, so a starter missing from it is invisible rather than
// merely low. Two different reasons, and the line separates them because they
// mean opposite things:
//   · his game has kicked off — weekly sheets drop players once they've played,
//     so his actual score is shown in parentheses and there is nothing to do;
//   · he simply isn't on the sheet — usually a format thing (K, D/ST and IDP are
//     parsed but not laid out here; a sheet may not cover them at all), and worth
//     knowing because the grid can't tell you anything about that slot.
// `inGrid` is the pids actually rendered, not LU.ranks.byPid, so a ranked kicker
// counts as missing too — he is, from this view's point of view.
function rgUnrankedStarters(fix, mode, inGrid) {
  const list = rgStarterList(fix, mode);
  if (!fix || !list) return [];
  const seen = new Set();
  return list.map((pid, i) => ({ pid: String(pid), slot: fix.rosterPositions[i] }))
    .filter(({ pid }) => {
      if (pid === '0' || inGrid.has(pid) || seen.has(pid)) return false;
      seen.add(pid);
      return true;
    })
    .map(e => ({ ...e, played: luLocked(e.pid), pts: luActualPts(e.pid, fix) }));
}

function rgUnrankedHtml(fix, mode, inGrid) {
  const rows = rgUnrankedStarters(fix, mode, inGrid);
  if (!rows.length) return '';
  const name = e => {
    const p = S.players[e.pid] || {};
    const pos = luNormPos(p.position) || '';
    // Slot and position are the same word for a dedicated slot — say it once.
    const tip = [e.slot || '', pos === e.slot ? '' : pos].filter(Boolean).join(' · ');
    return `<span class="rg-un-p" title="${esc(tip)}">${esc(luPlayerName(e.pid))}`
      + (e.played ? `<em>${e.pts === null ? 'played' : e.pts.toFixed(1)}</em>` : '')
      + `</span>`;
  };
  const played = rows.filter(e => e.played);
  const rest   = rows.filter(e => !e.played);
  const group = (label, list, tip) => list.length
    ? `<span class="rg-un-grp" title="${esc(tip)}"><b>${label}:</b>${list.map(name).join('<span class="rg-un-sep">·</span>')}</span>`
    : '';
  return `<div class="rg-unranked">
      ${group('Already played', played, 'His game has kicked off — weekly sheets drop players once they play. The number is what he actually scored in this league.')}
      ${group('Not ranked', rest, 'Not ranked by the uploaded sheet, or a position this grid does not lay out (IDP) — usually a format difference, not a missing player.')}
    </div>`;
}

// The grid's real content width. Measured rather than derived from
// window.innerWidth, because .main.wide's own cap is viewport-relative and
// #content is exactly the box the grid will be laid out in.
function rgWidth() {
  const w = document.getElementById('content')?.clientWidth || 0;
  return w > 320 ? w : Math.max(320, (window.innerWidth || 1200) - 64);
}

// Parts per column for the width we actually have. Every column that exists
// starts at one and takes its RG_SPLIT_BASE extras outright; the RG_SPLIT_WIDE
// ones are then granted only while every track still clears RG_TRACK_MIN. So the
// same sheet reads QB/RB/WR/TE/FLEX·FLEX·FLEX up to about 1700px of viewport,
// QB/RB/WR·WR/TE/FLEX·FLEX·FLEX from ~1728px, and the full nine tracks —
// QB/RB·RB/WR·WR/TE/FLEX·FLEX·FLEX — from ~1920px up.
function rgAllocParts(cols, width) {
  const parts = {};
  let tracks = 0;
  // A track exists for its own list OR for the K / D/ST list stacked in it.
  for (const [k] of RG_COLS) if ((cols[k] || []).length || (cols[RG_STACK[k]?.[0]] || []).length) { parts[k] = 1; tracks++; }
  // Stubby parts read worse than one continuous column, so a short sheet stops
  // splitting on its own rather than being forced into the shape below.
  const room = key => {
    const max = RG_COLS.find(([k]) => k === key)?.[2] || 1;
    const now = (cols[key] || []).length ? parts[key] : 0;
    return !!now && now < max && (cols[key] || []).length >= (now + 1) * RG_SPLIT_MIN;
  };
  const take = key => { parts[key]++; tracks++; };
  for (const key of RG_SPLIT_BASE) if (room(key)) take(key);
  const fits = t => (width - RG_WRAP_GAP * (t - 1)) / t >= RG_TRACK_MIN;
  for (const key of RG_SPLIT_WIDE) {
    if (!room(key)) continue;
    // Each part costs exactly one track, so once one doesn't fit none will.
    if (!fits(tracks + 1)) break;
    take(key);
  }
  return { parts, tracks };
}

// A resize — or the window dragged onto another monitor — changes what fits, so
// the split has to be re-allocated. Redraw only when the allocation actually
// moved: redrawing on every resize event would throw away the scroll position
// for nothing.
const rgPartsSig = parts => RG_COLS.map(([k]) => `${k}${parts[k] || 0}`).join('|');
let rgResizeTimer = null;
window.addEventListener('resize', () => {
  if (S.tab !== 'ranksgrid') return;
  clearTimeout(rgResizeTimer);
  rgResizeTimer = setTimeout(() => {
    if (S.tab !== 'ranksgrid') return;
    const sig = rgPartsSig(rgAllocParts(LU.ranks?.cols || {}, rgWidth()).parts);
    if (sig !== RG._sig) rgDraw();
  }, 150);
});

function rgDraw() {
  const week   = LU.week;
  const fix    = LU.lineups[RG.leagueIdx] || null;
  // A TEP league reads the sheet's TEP FLEX list in the FLEX column — the same
  // list the optimizer uses for that league (luRankInfo).
  const rgTep  = luUseTep(luPtsCtx(fix));
  const cols   = rgTep ? { ...LU.ranks.cols, FLEX: LU.ranks.cols.FLEX_TEP } : (LU.ranks?.cols || {});
  const hasCol = RG_COLS.some(([k]) => (cols[k] || []).length);

  const head = `<div class="tab-header" style="margin-bottom:16px;align-items:flex-start;">
      <div class="section-head" style="margin-bottom:0;flex:1;"><h2>Weekly Ranks — Week ${week}</h2><div class="section-head-line"></div></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">
        <span style="font-size:0.55rem;color:${luHaveRankings() ? 'var(--gold-light)' : 'var(--brown-light)'};">${esc(luRanksSummary())}</span>
        <button class="ghost-btn" style="font-size:0.5rem;" onclick="openRankingsUpload()">⬆ Upload rankings</button>
        <button class="ghost-btn" style="font-size:0.5rem;" onclick="sw('lineups')">← Lineup Checker</button>
      </div>
    </div>`;

  if (!hasCol) {
    // A pasted list parses into byPid but has no columns — there's nothing to lay
    // out in a grid, so say so rather than showing seven empty columns.
    const pasted = luHaveRankings();
    setC(`<div>${head}<div class="empty-state"><p>${pasted
      ? 'The rankings loaded for this week came from a pasted list, which has no positional columns to lay out. Upload a ranking-sheet CSV to use this view.'
      : 'No ranking sheet uploaded for week ' + week + ' yet.'}</p>
      <button class="setup-btn" style="margin-top:12px;" onclick="openRankingsUpload()">⬆ Upload rankings</button></div></div>`);
    return;
  }

  const starters = rgStarterSet(fix, RG.mode);
  const rostered = fix ? new Set((fix.players || []).map(String)) : new Set();
  // Season-to-date PPG, scored to the SELECTED league — the same helper and the
  // same league scoring the lineup rows use, so a player reads identically in
  // both views. With no league loaded luPtsCtx hands back an empty map, which
  // playerSeasonPpg falls back to full PPR for; the grid's own cells are too
  // small to label that, so the column is simply dropped in that case rather
  // than showing a number scored to nobody's league.
  const rgPc  = luPtsCtx(fix);
  const rgPpg = fix ? pid => playerSeasonPpg(pid, rgPc.scoring) : () => null;
  // Every player owned by ANYONE in the league — the complement is the free-agent
  // pool. Already on the fixture (the FA watch uses the same set), and null when
  // the league looks pre-draft, which switches the highlight off rather than
  // painting most of the sheet yellow.
  const leagueOwned = fix?.rostered || null;
  // Sticky column headers sit exactly under the sticky nav — measured rather
  // than guessed, since the bar's height moves with the font.
  const navH = document.querySelector('.tab-bar')?.offsetHeight || 40;

  const leagueSel = LU.lineups.length
    ? `<select onchange="rgSetLeague(this.value)" style="max-width:280px;">
         ${LU.lineups.map((f, i) => `<option value="${i}" ${i === RG.leagueIdx ? 'selected' : ''}>${esc(f.leagueName)}${f._espn ? ' (ESPN)' : ''}</option>`).join('')}
       </select>`
    : `<span style="font-size:0.7rem;color:var(--brown-light);">No leagues loaded</span>`;

  const modePills = RG_MODES.map(([m, label]) =>
    `<button class="ghost-btn rg-pill ${RG.mode === m ? 'on' : ''}" style="font-size:0.5rem;" onclick="rgSetMode('${m}')">${label}</button>`).join('');

  const controls = `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
      <span style="font-size:0.55rem;color:var(--brown-light);">League:</span>${leagueSel}
      <span style="width:1px;height:18px;background:var(--brown-mid);"></span>
      <span style="font-size:0.55rem;color:var(--brown-light);">Highlight:</span>${modePills}
      <span style="flex:1;"></span>
      <span style="font-size:0.6rem;color:var(--brown-light);display:flex;gap:12px;align-items:center;">
        <span><span style="display:inline-block;width:9px;height:9px;background:rgba(95,174,95,0.6);border-left:3px solid #5fae5f;margin-right:4px;"></span>starting</span>
        <span><span style="display:inline-block;width:9px;height:9px;background:rgba(192,80,77,0.6);border-left:3px solid #c0504d;margin-right:4px;"></span>rostered, benched</span>
        <span><span style="display:inline-block;width:9px;height:9px;background:rgba(235,195,55,0.75);border-left:3px solid #d6a82a;margin-right:4px;"></span>free agent</span>
      </span>
    </div>`;

  // How many grid tracks the row actually needs — a split column takes one per
  // part. Driven by the measured width and the real list lengths, so a sheet with
  // a short block doesn't leave an empty track. Passed as a custom property
  // rather than an inline grid-template-columns, which would outrank the
  // responsive overrides.
  // Every pid the grid actually renders — the basis for "which of my starters
  // aren't here", and deliberately taken from the columns rather than from
  // LU.ranks.byPid, which also holds the K and DEF blocks RG_COLS leaves out.
  const inGrid = new Set();
  const gridKeys = RG_COLS.flatMap(([k]) => RG_STACK[k] ? [k, RG_STACK[k][0]] : [k]);
  for (const key of gridKeys) for (const r of (cols[key] || [])) if (r.pid) inGrid.add(String(r.pid));

  const alloc = rgAllocParts(cols, rgWidth());
  const tracks = alloc.tracks;
  RG._sig = rgPartsSig(alloc.parts);

  const colHtml = (key, label, parts) => {
    const list = cols[key] || [];
    if (!list.length) return '';
    // Flip the band every time the tier changes. Computed over the FULL list
    // before any split, so the stripes carry on correctly across the two halves
    // instead of restarting. A sheet with no Tier column leaves every row null,
    // so nothing ever flips and the grid looks exactly as it did.
    const bands = [];
    for (let i = 0, b = 0; i < list.length; i++) {
      if (i > 0 && list[i].tier !== list[i - 1].tier) b ^= 1;
      bands.push(b);
    }
    const cell = (r, i) => {
      const pid = r.pid ? String(r.pid) : null;
      // A flex-eligible player is listed twice by the sheet — in his position
      // column and again in FLEX — so he lights up in both. Same player.
      const cls = pid && starters?.has(pid)                    ? ' rg-on'
                : pid && rostered.has(pid)                     ? ' rg-off'
                : pid && leagueOwned && !leagueOwned.has(pid)  ? ' rg-fa' : '';
      // Empty for anyone who hasn't played — a bye-week row or an undrafted rookie
      // leaves the gap rather than claiming 0.0, exactly as on a lineup card.
      const ppg = pid ? rgPpg(pid) : null;
      const gp  = ppg === null ? 0 : playerSeasonGp(pid);
      return `<div class="rg-cell${bands[i] ? ' rg-tier-b' : ''}${cls}">
        <span class="rg-rank">${r.rank}</span>
        <span class="rg-name">${esc(r.name)}</span>
        ${ppg === null ? '' : `<span class="rg-ppg" title="Season PPG in this league's scoring — ${ppg.toFixed(1)} over ${gp} game${gp === 1 ? '' : 's'} played">${ppg.toFixed(1)}</span>`}
        <span class="rg-opp">${esc(r.opp || '')}</span>
      </div>`;
    };
    const per   = Math.ceil(list.length / parts);
    // Every part after the first must keep its true index or both the banding and
    // the cut points would restart at zero.
    const body  = parts > 1
      ? `<div class="rg-halves">${Array.from({ length: parts }, (_, p) =>
          `<div class="rg-half">${list.slice(p * per, (p + 1) * per).map((r, i) => cell(r, p * per + i)).join('')}</div>`).join('')}</div>`
      : list.map((r, i) => cell(r, i)).join('');
    return `<div class="rg-col${parts > 1 ? ' rg-split' : ''}" style="--rg-parts:${parts};">
      <div class="rg-head" style="top:${navH}px;">${esc(label)} <em>${list.length}</em></div>${body}</div>`;
  };

  const grid = `<div class="rg-wrap" style="--rg-tracks:${tracks};">${RG_COLS.map(([key, label]) => {
    const main  = colHtml(key, key === 'FLEX' && rgTep ? 'TEP FLEX' : label, alloc.parts[key] || 1);
    const stack = RG_STACK[key] ? colHtml(RG_STACK[key][0], RG_STACK[key][1], 1) : '';
    // One grid item, so the stacked list sits in the same track and costs no width.
    return main && stack ? `<div class="rg-stack">${main}${stack}</div>` : main || stack;
  }).join('')}</div>`;

  setC(`<div>${head}${controls}${rgApplyBarHtml(fix)}${rgUnrankedHtml(fix, RG.mode, inGrid)}${grid}</div>`);
}
