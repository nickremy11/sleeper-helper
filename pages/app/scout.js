// Scout tab

// ── 9. Scout — cross-league trade-opportunity finder ──────────────────────────
// Ask one question across your leagues. Two formats:
//   Dynasty  — "where's a rebuilding opponent sitting on an aging top-N WR I
//              could buy?" (top-N positional rank + young/veteran age bucket)
//   Redraft  — "which opponents are stacked at a position?" (≥K players inside
//              the top-N PPG at that position — a depth surplus to buy from / a
//              surplus of my own to sell)
// Reuses League Summaries' roster load + playoff-odds sim, and shared-utils'
// crPlayerPpg for per-league positional projection ranks.

const SCOUT_DEFAULT_SETTINGS = {
  vetAge:     { QB: 30, RB: 27, WR: 28, TE: 29 },
  contendPct: 40,   // playoff odds ≥ this % ⇒ contender
  rebuildPct: 20,   // playoff odds ≤ this % ⇒ rebuilder
  // Redraft "positional surplus": a team needs ≥ count players inside top rank.
  redraft: {
    QB: { rank: 10, count: 2 },
    RB: { rank: 24, count: 3 },
    WR: { rank: 30, count: 4 },
    TE: { rank: 10, count: 2 },
  },
};

const SC = {
  format:   'dynasty',      // 'dynasty' | 'redraft'
  mode:     'buy',          // 'buy' | 'sell'
  myStatus: 'contending',   // 'contending' | 'rebuilding'
  pos:      'WR',           // QB | RB | WR | TE
  topN:     36,             // 12 | 24 | 36 | 48  (dynasty only)
  age:      'vet',          // 'young' | 'vet'    (dynasty only)
  opp:      'either',       // 'rebuilder' | 'contender' | 'either'
  rankSrc:  'proj',         // 'proj' | 'myranks' | 'fc' — what "top N at the position" means
  settings: scoutLoadSettings(),
  showSettings: false,
  projMode: 'projections', // 'projections' | 'adp' — set by scoutRun, drives the projection fallback
  rankSet:  'primary',      // which My Ranks set — 'primary' | 'set:<id>' | '<sharedId>'
  rankSets: null,           // [{id,label}] — lazily listed by scoutLoadRankSets()
  rankSetErr: '',
  myRanks:  null,           // {pid: tier} for SC.myRanksOf, loaded on demand
  myRanksOf: null,
  fcCache:  {},             // fc param key → {pid: value}
  results:  null,           // [{lgId,name,myOdds,myClass,teams:[...],myPlayers:[...]}]
  skipNote: '',
  running:  false,
  progress: '',
  error:    null,
  rosterMeta: {},           // {lgId: {rid: teamName}}
};

function scoutLoadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('scout_settings') || 'null');
    if (s && s.vetAge) return {
      ...SCOUT_DEFAULT_SETTINGS, ...s,
      vetAge:  { ...SCOUT_DEFAULT_SETTINGS.vetAge, ...s.vetAge },
      redraft: {
        QB: { ...SCOUT_DEFAULT_SETTINGS.redraft.QB, ...s.redraft?.QB },
        RB: { ...SCOUT_DEFAULT_SETTINGS.redraft.RB, ...s.redraft?.RB },
        WR: { ...SCOUT_DEFAULT_SETTINGS.redraft.WR, ...s.redraft?.WR },
        TE: { ...SCOUT_DEFAULT_SETTINGS.redraft.TE, ...s.redraft?.TE },
      },
    };
  } catch (_) {}
  return JSON.parse(JSON.stringify(SCOUT_DEFAULT_SETTINGS));
}
function scoutSaveSettings() {
  try { localStorage.setItem('scout_settings', JSON.stringify(SC.settings)); } catch (_) {}
}

function scoutSet(key, val) { SC[key] = val; renderScout(); }
function scoutToggleSettings() { SC.showSettings = !SC.showSettings; renderScout(); }

function scoutSetVetAge(pos, val) {
  const n = parseInt(val, 10);
  if (!Number.isNaN(n) && n > 0) { SC.settings.vetAge[pos] = n; scoutSaveSettings(); }
}
function scoutSetThreshold(key, val) {
  const n = parseInt(val, 10);
  if (!Number.isNaN(n) && n >= 0 && n <= 100) { SC.settings[key] = n; scoutSaveSettings(); }
}
function scoutSetRedraft(pos, field, val) {
  const n = parseInt(val, 10);
  if (!Number.isNaN(n) && n > 0) { SC.settings.redraft[pos][field] = n; scoutSaveSettings(); }
}
// The same two numbers as above, from the inline redraft pills — always for the
// position currently selected, so the pills and the Settings panel edit one value.
function scoutSetRedraftPos(field, n) {
  SC.settings.redraft[SC.pos][field] = n;
  scoutSaveSettings();
  renderScout();
}
// Preset choices plus whatever is currently stored, so a hand-typed Settings value
// (the defaults include 30 and 10) still shows up selected rather than nowhere.
function scoutNumChoices(presets, cur) {
  return [...new Set([...presets, cur])].sort((a, b) => a - b);
}

// Sleeper league type 2 = dynasty/keeper; everything else (redraft, best-ball) = redraft.
// ESPN has no dynasty concept in anything this app can read, so every ESPN league
// is redraft — said explicitly rather than relying on the undefined settings.type
// falling through, since that reads as an accident.

// playoff-odds fraction (0-1) → 'contender' | 'rebuilder' | 'middle'
function scoutClassify(frac, lgId) {
  const s = SC.settings;
  if (frac != null && !Number.isNaN(frac)) {
    if (frac * 100 >= s.contendPct) return 'contender';
    if (frac * 100 <= s.rebuildPct) return 'rebuilder';
    return 'middle';
  }
  const pref = RS.prefs?.[lgId];
  if (pref) return pref.contender ? 'contender' : 'rebuilder';
  return 'middle';
}
function scoutOppMatches(cls) {
  if (cls === 'middle') return false;
  if (SC.opp === 'either') return true;
  return SC.opp === 'contender' ? cls === 'contender' : cls === 'rebuilder';
}

// age → 'young' | 'vet' | null (null = unknown age, excluded from matches)
function scoutAgeBucket(pid, pos) {
  const age = S.players[pid]?.age;
  if (age == null) return null;
  return age >= (SC.settings.vetAge[pos] ?? 99) ? 'vet' : 'young';
}

// ── Scout ranking sources ─────────────────────────────────────────────────────
// What "top 24 RBs" means is a choice, not a fact, so it's a user-facing one.
// All three produce the same {pid: {rank, ppg, tier}} shape, so nothing
// downstream of scoutPosRanks() branches on which was used.
const SCOUT_RANK_SRC = {
  proj:    { label: 'Projections', noun: 'PPG projections' },
  myranks: { label: 'My Ranks',    noun: 'My Ranks tiers' },
  fc:      { label: 'FantasyCalc', noun: 'FantasyCalc value' },
};

// My Ranks lives on its own worker + subdomain, but shares this app's session
// cookie (Domain=.ffhistorian.com) and allows helper.ffhistorian.com in its CORS
// allowlist — so a signed-in user needs no extra setup here. The set ids and the
// endpoint shapes behind them are the Draft Tracker's (loadFromMyRanks) and the
// My Ranks grid's (mrgLoadSources/mrgFetchRanks); this is the same picker, one
// selection deep. It keeps its own copy rather than calling mrgLoadSources()
// because that writes MRG.sourceId — the Waivers grid's live selection — and
// mrgFetchRanks() resolves a bare 'primary' id only out of that same state.
function scoutRankSetUrl(id) {
  if (id.startsWith('primary:')) return MYRANKS_API + '/api/myranks/data?owner_id=' + encodeURIComponent(id.slice(8));
  if (id === 'primary')          return MYRANKS_API + '/api/myranks/data';
  if (id.startsWith('set:'))     return MYRANKS_API + '/api/myranks/sets/' + id.slice(4) + '/data';
  return MYRANKS_API + '/api/myranks/sets/' + id + '/data';   // shared named set
}

// Populates the ranking-set <select> after renderScout() has written it.
async function scoutLoadRankSets() {
  const sel = document.getElementById('scout-rankset');
  if (!sel) return;
  if (!SC.rankSets) {
    try {
      const [dataRes, setsRes] = await Promise.all([
        fetch(MYRANKS_API + '/api/myranks/data', { credentials: 'include' }),
        fetch(MYRANKS_API + '/api/myranks/sets', { credentials: 'include' }),
      ]);
      if (!dataRes.ok || !setsRes.ok) throw new Error(dataRes.status === 401 ? 'Sign in to use My Ranks' : 'Could not load My Ranks');
      const [data, sets] = await Promise.all([dataRes.json(), setsRes.json()]);
      const opts = [];
      if (data.rankings?.length) opts.push({ id: 'primary', label: 'My Rankings' });
      for (const st of (sets.sets || [])) opts.push({ id: 'set:' + st.id, label: st.name });
      for (const st of (sets.sharedSets || [])) opts.push({
        id: String(st.id),
        label: st.is_primary ? (st.owner_name ? st.owner_name + "'s Rankings" : 'Shared Rankings')
                             : (st.owner_name ? `${st.name} (${st.owner_name})` : st.name),
      });
      SC.rankSets = opts;
    } catch (e) { SC.rankSets = []; SC.rankSetErr = e.message; }
  }
  if (!SC.rankSets.length) {
    sel.outerHTML = `<span style="font-family:'Crimson Text',serif;font-style:italic;color:var(--brown-light);font-size:0.85rem;">${esc(SC.rankSetErr || 'No ranking sets found')} — set them up at <a href="https://myranks.ffhistorian.com" target="_blank" style="color:var(--gold);">My Ranks</a></span>`;
    return;
  }
  if (!SC.rankSets.some(o => o.id === SC.rankSet)) SC.rankSet = SC.rankSets[0].id;
  sel.innerHTML = SC.rankSets.map(o => `<option value="${esc(o.id)}"${o.id === SC.rankSet ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
}
function scoutSetRankSet(id) { SC.rankSet = id; SC.myRanks = null; }

async function scoutLoadMyRanks() {
  if (SC.myRanks && SC.myRanksOf === SC.rankSet) return SC.myRanks;
  let r;
  try { r = await fetch(scoutRankSetUrl(SC.rankSet), { credentials: 'include' }); }
  catch (_) { throw new Error('Could not reach My Ranks (myranks.ffhistorian.com).'); }
  if (r.status === 401) throw new Error('Sign in to rank by My Ranks.');
  if (!r.ok) throw new Error('Could not load My Ranks (HTTP ' + r.status + ').');
  const data = await r.json();
  const map = {};
  for (const row of (data.rankings || [])) {
    const pid  = luMatchRankRow(row.player_name, row.team);
    const tier = Number(row.tier);
    if (!pid || !(tier > 0)) continue;
    if (map[pid] == null || tier < map[pid]) map[pid] = tier;
  }
  if (!Object.keys(map).length) throw new Error('That ranking set has no tiers this app could match to Sleeper players.');
  SC.myRanks = map;
  SC.myRanksOf = SC.rankSet;
  return map;
}

// FantasyCalc params derived from the league — superflex and PPR, and dynasty vs
// redraft so the dynasty tab prices players the way that format actually values
// them. Deliberately NOT team count: that would fan ~70 leagues out into ~70
// upstream pulls for a difference that never reorders a position. Six keys, max.
function scoutFcKey(lg) {
  const rp  = lg?.roster_positions || [];
  const sf  = rp.includes('SUPER_FLEX') || rp.filter(p => p === 'QB').length >= 2;
  const rec = Number(lg?.scoring_settings?.rec ?? 1);
  const ppr = rec >= 0.75 ? '1' : rec >= 0.25 ? '0.5' : '0';
  return `${lg?.settings?.type === 2}|${sf ? 2 : 1}|${ppr}`;
}
async function scoutLoadFc(key) {
  if (SC.fcCache[key]) return SC.fcCache[key];
  const [dyn, numQbs, ppr] = key.split('|');
  const base = SH_API;
  const r = await fetch(`${base}/fantasycalc?isDynasty=${dyn}&numQbs=${numQbs}&ppr=${ppr}&includePickValues=false`);
  if (!r.ok) throw new Error('FantasyCalc unavailable (HTTP ' + r.status + ').');
  const rows  = await r.json();
  const field = dyn === 'true' ? 'value' : 'redraftValue';
  const map   = {};
  for (const item of (rows || [])) {
    const sid = item.player?.sleeperId || item.player?.maybeSleeperID;
    const val = item[field] ?? item.value;
    if (sid && val > 0) map[String(sid)] = val;
  }
  SC.fcCache[key] = map;
  return map;
}

// One league → the two format facts every ranking source needs: the scoring map
// PPG is computed under, and the FantasyCalc key. Sleeper reads its league
// detail; ESPN's equivalents come out of crParseEspnScoring — the same parser
// the playoff-odds sim, the analyzer and the trade analyzer already use, so a
// TE-premium or superflex ESPN league ranks the way it actually scores. ESPN is
// always redraft, hence the hardcoded `false` in the FC key.
function scoutLeagueCtx(lg) {
  if (lg.source === 'espn') {
    const p   = crParseEspnScoring(LS.leagueData[lg.league_id]?._espn?.settings);
    const rec = Number(p.ppr ?? 1);
    return {
      scoring: p.scoring || {},
      fcKey:   `false|${p.numQbs >= 2 ? 2 : 1}|${rec >= 0.75 ? '1' : rec >= 0.25 ? '0.5' : '0'}`,
    };
  }
  const detail = S.leagueDetails[lg.league_id];
  return { scoring: detail?.scoring_settings || {}, fcKey: scoutFcKey(detail) };
}

// Per-league positional ranks: {pid: {rank, ppg, tier}} for QB/RB/WR/TE.
// Three orderings, one shape:
//   proj    — projected PPG under this league's scoring_settings (crPlayerPpg)
//   myranks — your My Ranks tier; the tier is all My Ranks stores, so projected
//             PPG breaks ties inside one (otherwise a 15-player tier would cut
//             off alphabetically at "top 24")
//   fc      — FantasyCalc value for the league's format
// `ppg` is ALWAYS the season-to-date actual, scored to the league — it's the
// number you'd quote in a trade DM, so it has to read the same whichever
// ordering surfaced the player.
function scoutPosRanks(scoring, opts) {
  const ctx = { ...opts.projCtx, mode: opts.mode, scoring: scoring || {}, players: S.players };
  const src = opts.rankSrc;
  const byPos = { QB: [], RB: [], WR: [], TE: [] };
  for (const [pid, p] of Object.entries(S.players)) {
    const pos = (p.position || '').toUpperCase();
    if (!byPos[pos]) continue;
    const proj = src === 'fc' ? 0 : crPlayerPpg(pid, ctx);   // unused by the FC ordering
    const tier = opts.myRanks?.[pid] ?? null;
    const fc   = opts.fcMap?.[pid] ?? 0;
    if (src === 'myranks' ? !(tier > 0) : src === 'fc' ? !(fc > 0) : !(proj > 0)) continue;
    byPos[pos].push({ pid, proj, tier, fc });
  }
  const cmp = src === 'myranks' ? (a, b) => (a.tier - b.tier) || (b.proj - a.proj)
            : src === 'fc'      ? (a, b) => b.fc - a.fc
            :                     (a, b) => b.proj - a.proj;
  const rank = {};
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    byPos[pos].sort(cmp);
    byPos[pos].forEach((e, i) => { rank[e.pid] = { rank: i + 1, ppg: playerSeasonPpg(e.pid, scoring), tier: e.tier }; });
  }
  return rank;
}

async function renderScout() {
  if (!S.leagues.length) { setC(viewBarHtml('findtrade', 'scout') + '<div class="empty-state"><p>No leagues found for this user</p></div>'); return; }

  const modeLbl = SC.mode === 'buy' ? 'looking to buy' : 'trying to sell';
  const pill = (cur, val, txt, onclick) =>
    `<button class="ls-mode-pill${cur === val ? ' active' : ''}" onclick="${onclick}">${txt}</button>`;

  const grp = (label, html) => `
    <div style="margin-bottom:14px;">
      <div class="setup-label-rye" style="margin-bottom:6px;">${label}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${html}</div>
    </div>`;

  const posGrp = grp(
    SC.mode === 'buy' ? 'Position you want' : 'Position you’re selling',
    ['QB', 'RB', 'WR', 'TE'].map(p => pill(SC.pos, p, p, `scoutSet('pos','${p}')`)).join('')
  );
  const srcNoun = SCOUT_RANK_SRC[SC.rankSrc].noun;
  const setPicker = SC.rankSrc === 'myranks'
    ? `<select id="scout-rankset" class="scout-select" onchange="scoutSetRankSet(this.value)"><option>Loading…</option></select>`
    : '';
  const srcGrp = grp('Rank players by',
    Object.entries(SCOUT_RANK_SRC).map(([k, v]) => pill(SC.rankSrc, k, v.label, `scoutSet('rankSrc','${k}')`)).join('') + setPicker
  );
  const topGrp = grp('Top in ' + srcNoun,
    [12, 24, 36, 48].map(n => pill(SC.topN, n, 'Top ' + n, `scoutSet('topN',${n})`)).join('')
  );
  const ageGrp = grp('Player age',
    pill(SC.age, 'young', 'Young', "scoutSet('age','young')") +
    pill(SC.age, 'vet', 'Veteran', "scoutSet('age','vet')")
  );
  const myGrp = grp('Your situation (which leagues to search)',
    pill(SC.myStatus, 'contending', 'Contending', "scoutSet('myStatus','contending')") +
    pill(SC.myStatus, 'rebuilding', 'Rebuilding', "scoutSet('myStatus','rebuilding')")
  );
  const oppGrp = grp(SC.mode === 'buy' ? 'From an opponent who is' : 'To an opponent who is',
    pill(SC.opp, 'rebuilder', 'Rebuilder', "scoutSet('opp','rebuilder')") +
    pill(SC.opp, 'contender', 'Contender', "scoutSet('opp','contender')") +
    pill(SC.opp, 'either', 'Either', "scoutSet('opp','either')")
  );

  const rd = SC.settings.redraft[SC.pos];
  // Redraft's two numbers ("≥ count inside top rank") are the whole question this
  // format asks, so they're pills up front rather than only inside Settings.
  const rdRankGrp = grp(`Counted as a top ${SC.pos} (by ${srcNoun})`,
    scoutNumChoices([12, 24, 36, 48], rd.rank).map(n => pill(rd.rank, n, 'Top ' + n, `scoutSetRedraftPos('rank',${n})`)).join('')
  );
  const rdCountGrp = grp(`How many ${SC.pos}s make a surplus`,
    scoutNumChoices([2, 3, 4, 5], rd.count).map(n => pill(rd.count, n, '≥ ' + n, `scoutSetRedraftPos('count',${n})`)).join('')
  );
  const formatTabs = `
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <button class="ghost-btn${SC.format === 'dynasty' ? ' active' : ''}" style="${SC.format === 'dynasty' ? 'border-color:var(--gold);color:var(--gold);' : ''}" onclick="scoutSet('format','dynasty')">Dynasty</button>
      <button class="ghost-btn${SC.format === 'redraft' ? ' active' : ''}" style="${SC.format === 'redraft' ? 'border-color:var(--gold);color:var(--gold);' : ''}" onclick="scoutSet('format','redraft')">Redraft</button>
    </div>`;
  const subTabs = `
    <div style="display:flex;gap:8px;margin-bottom:18px;">
      <button class="ghost-btn${SC.mode === 'buy' ? ' active' : ''}" style="${SC.mode === 'buy' ? 'border-color:var(--gold);color:var(--gold);' : ''}" onclick="scoutSet('mode','buy')">Buying</button>
      <button class="ghost-btn${SC.mode === 'sell' ? ' active' : ''}" style="${SC.mode === 'sell' ? 'border-color:var(--gold);color:var(--gold);' : ''}" onclick="scoutSet('mode','sell')">Selling</button>
    </div>`;

  const s = SC.settings;
  const numInput = (val, oninput, w = 52) =>
    `<input type="number" value="${val}" oninput="${oninput}" style="width:${w}px;background:rgba(255,255,255,0.06);border:1px solid var(--brown-mid);color:var(--cream);font-family:'Crimson Text',serif;font-size:0.9rem;padding:4px 6px;border-radius:2px;" />`;

  const dynSettings = `
      <div class="setup-label-rye" style="margin-bottom:10px;">Dynasty — veteran age cutoff (age ≥ value = veteran)</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;">
        ${['QB', 'RB', 'WR', 'TE'].map(p => `<label style="font-family:'Crimson Text',serif;color:var(--parchment);font-size:0.9rem;">${p} ${numInput(s.vetAge[p], `scoutSetVetAge('${p}',this.value)`)}</label>`).join('')}
      </div>`;
  const rdSettings = `
      <div class="setup-label-rye" style="margin-bottom:10px;">Redraft — positional surplus (≥ count players inside top rank, by the ranking source above)</div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-bottom:16px;">
        ${['QB', 'RB', 'WR', 'TE'].map(p => `<label style="font-family:'Crimson Text',serif;color:var(--parchment);font-size:0.9rem;">${p}: ≥ ${numInput(s.redraft[p].count, `scoutSetRedraft('${p}','count',this.value)`, 44)} in top ${numInput(s.redraft[p].rank, `scoutSetRedraft('${p}','rank',this.value)`, 48)}</label>`).join('')}
      </div>`;
  const settingsPanel = SC.showSettings ? `
    <div style="background:var(--brown-dark);border:1px solid var(--brown-mid);border-radius:2px;padding:14px 18px;margin-bottom:18px;">
      ${dynSettings}${rdSettings}
      <div class="setup-label-rye" style="margin-bottom:10px;">Playoff-odds thresholds</div>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center;">
        <label style="font-family:'Crimson Text',serif;color:var(--parchment);font-size:0.9rem;">Contending ≥ ${numInput(s.contendPct, "scoutSetThreshold('contendPct',this.value)")}%</label>
        <label style="font-family:'Crimson Text',serif;color:var(--parchment);font-size:0.9rem;">Rebuilding ≤ ${numInput(s.rebuildPct, "scoutSetThreshold('rebuildPct',this.value)")}%</label>
      </div>
      <div style="font-family:'Crimson Text',serif;font-style:italic;color:var(--brown-light);font-size:0.82rem;margin-top:10px;">Teams between the two thresholds count as neither and are skipped.</div>
    </div>` : '';

  const runBtn = SC.running
    ? `<button class="setup-btn" disabled style="opacity:0.6;">Working…</button>`
    : `<button class="setup-btn" onclick="scoutRun()">Run</button>`;

  const summary = SC.format === 'dynasty'
    ? `Find <strong>dynasty</strong> leagues where you are <strong>${SC.myStatus}</strong> and, ${modeLbl}, there’s a
       top-${SC.topN} ${SC.age === 'vet' ? 'veteran' : 'young'} ${SC.pos} by ${srcNoun}
       ${SC.mode === 'buy' ? 'on' : 'you could move to'} a ${SC.opp === 'either' ? 'rebuilding or contending' : SC.opp} opponent.`
    : `Find <strong>redraft</strong> leagues where
       ${SC.mode === 'buy'
         ? `an opponent is stacked at ${SC.pos} (≥ ${rd.count} in the top ${rd.rank} by ${srcNoun}) — a surplus to buy from.`
         : `you are stacked at ${SC.pos} (≥ ${rd.count} in the top ${rd.rank} by ${srcNoun}) — a surplus to sell from.`}`;

  setC(`
    ${viewBarHtml('findtrade', 'scout')}
    <div class="section-head"><h2>Scout</h2><div class="section-head-line"></div></div>
    ${formatTabs}
    <div style="font-family:'Crimson Text',serif;font-style:italic;color:var(--brown-light);font-size:0.9rem;margin-bottom:16px;">${summary}</div>
    ${subTabs}
    ${SC.format === 'dynasty' ? myGrp : ''}${posGrp}${srcGrp}${SC.format === 'dynasty' ? topGrp + ageGrp + oppGrp : rdRankGrp + rdCountGrp}
    <div style="display:flex;gap:12px;align-items:center;margin:6px 0 4px;">
      ${runBtn}
      <button class="ghost-btn" onclick="scoutToggleSettings()">${SC.showSettings ? 'Hide' : 'Settings'}</button>
      ${SC.progress ? `<span style="font-family:'Crimson Text',serif;font-style:italic;color:var(--brown-light);font-size:0.85rem;">${esc(SC.progress)}</span>` : ''}
    </div>
    ${settingsPanel}
    ${SC.error ? errHtml(new Error(SC.error)) : ''}
    <div id="scout-results" style="margin-top:18px;"></div>
  `);
  scoutDrawResults();
  if (SC.rankSrc === 'myranks') scoutLoadRankSets();
}

async function scoutRun() {
  if (SC.running) return;
  SC.running = true;
  SC.error = null;
  SC.progress = 'Loading leagues & rosters…';
  renderScout();

  try {
    await getNflState();
    if (!LS.loaded) {
      if (RS.selectedLeagues === null) {
        RS.selectedLeagues = new Set(S.leagues.map(lg => lg.league_id));
        await rsLoadPrefs();
      } else if (!Object.keys(RS.prefs).length) {
        await rsLoadPrefs();
      }
      await Promise.all([lsLoadData(), loadPlayers()]);
      LS.loaded = true;
      lsRestoreOddsCache();
    } else {
      await loadPlayers();
    }

    // Ensure league_details (scoring + settings.type) are in for every Sleeper
    // league — the initial load fires these off without awaiting, and Scout needs
    // settings.type to tell dynasty from redraft.
    await Promise.all(S.leagues
      .filter(lg => lg.source !== 'espn' && !S.leagueDetails[lg.league_id])
      .map(lg => api('/league/' + lg.league_id).then(dd => { if (dd) S.leagueDetails[lg.league_id] = dd; }).catch(() => {})));

    // ESPN leagues are appended to S.leagues asynchronously by loadEspnLeagues(),
    // so one can arrive after lsLoadData() already ran and have no LS.leagueData
    // entry at all. Same backfill League Summaries does for itself.
    await Promise.all(S.leagues
      .filter(lg => lg.source === 'espn' && !LS.leagueData[lg.league_id])
      .map(lg => lsLoadEspnLeague(lg)));

    // Playoff odds — run the shared sim if any league still lacks a per-roster
    // odds map (lsDrawTable is a no-op while this tab is active). ESPN leagues
    // are simulated by the same code path off their real ESPN schedule.
    const needsOdds = S.leagues.some(lg =>
      LS.leagueData[lg.league_id] && !LS.leagueData[lg.league_id].allPlayoffOdds
    );
    if (needsOdds) {
      SC.progress = 'Simulating playoff odds — up to a minute the first time, instant afterward…';
      renderScout();
      LS._oddsUseCache = true;
      await lsSimulateAllLeagues();
    }

    SC.progress = 'Ranking players by ' + SCOUT_RANK_SRC[SC.rankSrc].noun + '…';
    renderScout();

    const season = S.nflState?.season || String(new Date().getFullYear());
    const projCtx = await crLoadProjectionData({
      apiBase: SH_API,
      season, authed: !!S.auth, byName: S._playersByName,
    });
    let mode = 'projections';
    const anyProj = Object.keys(projCtx.clayMap).length || Object.keys(projCtx.sleeperProjMap).length || Object.keys(projCtx.userProjMap).length;
    if (!anyProj) {
      mode = 'adp';
      SC.progress = 'Projections unavailable — ranking by ADP…';
      renderScout();
      projCtx.aggAdpMap = await crLoadAggregateAdp({
        apiBase: SH_API,
        byName: S._playersByName,
      }).catch(() => ({}));
    }

    SC.projMode = mode;

    // Season-to-date actuals back the PPG shown on every row, whichever source
    // ordered the players. The ranking source's own data loads once, up front —
    // the per-league loop below is synchronous.
    await ppgLoadStats();
    let myRanksMap = null;
    if (SC.rankSrc === 'myranks') {
      SC.progress = 'Loading My Ranks…';
      renderScout();
      myRanksMap = await scoutLoadMyRanks();
    } else if (SC.rankSrc === 'fc') {
      SC.progress = 'Loading FantasyCalc values…';
      renderScout();
      const keys = [...new Set(S.leagues.map(lg => scoutLeagueCtx(lg).fcKey))];
      await Promise.all(keys.map(k => scoutLoadFc(k)));
    }

    const results = [];
    const ranksCache = {};   // mode + source + scoring_settings → pos-rank map (many leagues share a config)
    let noOddsCount = 0, unreadCount = 0, otherFormatCount = 0;
    const rdCfg = SC.settings.redraft[SC.pos];   // redraft surplus config for the chosen position
    for (const lg of S.leagues) {
      const d = LS.leagueData[lg.league_id];
      if (!d || !d.rosterPlayers) { unreadCount++; continue; }
      if (rsLeagueCategory(lg.league_id) !== SC.format) { otherFormatCount++; continue; }

      // Contender/rebuilder only gates DYNASTY. In redraft every team is playing for
      // this year, so the tags carry no signal about who'd move a surplus — odds are
      // still computed and shown on the cards, they just don't filter anything out.
      const myOdds  = d.allPlayoffOdds?.[d.myRosterId];
      const myClass = scoutClassify(myOdds, lg.league_id);
      if (SC.format === 'dynasty') {
        if (myOdds == null && !RS.prefs?.[lg.league_id]) noOddsCount++;
        const want = SC.myStatus === 'contending' ? 'contender' : 'rebuilder';
        if (myClass !== want) continue;
      }

      const lgCtx   = scoutLeagueCtx(lg);
      const scoring = lgCtx.scoring;
      const fcKey   = SC.rankSrc === 'fc' ? lgCtx.fcKey : '';
      const ckey    = [mode, SC.rankSrc, fcKey, JSON.stringify(scoring)].join('|');
      const ranks   = ranksCache[ckey] || (ranksCache[ckey] = scoutPosRanks(scoring, {
        projCtx, mode, rankSrc: SC.rankSrc, myRanks: myRanksMap, fcMap: SC.fcCache[fcKey],
      }));
      const posOf   = pid => (S.players[pid]?.position || '').toUpperCase();
      const mkPlayer = pid => ({
        pid, name: S.players[pid]?.full_name || pid,
        rank: ranks[pid].rank, ppg: ranks[pid].ppg, tier: ranks[pid].tier,
        age: S.players[pid]?.age ?? null, team: S.players[pid]?.team || 'FA',
      });

      // Which of a roster's players at the chosen position count as a "hit".
      // Dynasty: top-N rank + young/veteran age bucket. Redraft: inside top rank
      // (the count threshold is applied per-team below). Both read whichever
      // ordering SC.rankSrc selected — rank means the same thing either way.
      const hitsFor = pids => (pids || []).filter(pid => {
        if (posOf(pid) !== SC.pos) return false;
        const r = ranks[pid];
        if (!r) return false;
        return SC.format === 'dynasty'
          ? (r.rank <= SC.topN && scoutAgeBucket(pid, SC.pos) === SC.age)
          : (r.rank <= rdCfg.rank);
      });
      const teamQualifies = hits => SC.format === 'dynasty' ? hits.length > 0 : hits.length >= rdCfg.count;

      if (SC.mode === 'buy') {
        const teams = [];
        for (const [ridStr, pids] of Object.entries(d.rosterPlayers)) {
          const rid = Number(ridStr);
          if (rid === d.myRosterId) continue;
          const cls = scoutClassify(d.allPlayoffOdds?.[rid], lg.league_id);
          if (SC.format === 'dynasty' && !scoutOppMatches(cls)) continue;
          const hits = hitsFor(pids);
          if (teamQualifies(hits)) teams.push({ rid, cls, odds: d.allPlayoffOdds?.[rid] ?? null, players: hits.map(mkPlayer).sort((a, b) => a.rank - b.rank) });
        }
        if (teams.length) results.push({ lgId: lg.league_id, name: lg.name || 'Unnamed', isEspn: lg.source === 'espn', myOdds, myClass, teams, myPlayers: [] });
      } else {
        const mine = hitsFor(d.rosterPlayers[d.myRosterId]);
        if (!teamQualifies(mine)) continue;
        const teams = [];
        for (const [ridStr] of Object.entries(d.rosterPlayers)) {
          const rid = Number(ridStr);
          if (rid === d.myRosterId) continue;
          const cls = scoutClassify(d.allPlayoffOdds?.[rid], lg.league_id);
          if (SC.format === 'dynasty' && !scoutOppMatches(cls)) continue;
          teams.push({ rid, cls, odds: d.allPlayoffOdds?.[rid] ?? null, players: [] });
        }
        if (teams.length) results.push({ lgId: lg.league_id, name: lg.name || 'Unnamed', isEspn: lg.source === 'espn', myOdds, myClass, teams, myPlayers: mine.map(mkPlayer).sort((a, b) => a.rank - b.rank) });
      }
    }

    // Team names for just the leagues we're showing.
    SC.progress = 'Fetching team names…';
    renderScout();
    await Promise.all(results.map(async res => {
      if (SC.rosterMeta[res.lgId]) return;
      // ESPN publishes no /users equivalent — the team names came down with the
      // roster load, so there is nothing to fetch here.
      if (res.isEspn) { SC.rosterMeta[res.lgId] = LS.leagueData[res.lgId]?.rosterNames || {}; return; }
      try {
        const users = await api('/league/' + res.lgId + '/users') || [];
        const byUser = {};
        for (const u of users) byUser[u.user_id] = u.metadata?.team_name || u.display_name || 'Team';
        const owners = LS.leagueData[res.lgId]?.rosterOwners || {};
        const map = {};
        for (const [rid, oid] of Object.entries(owners)) map[rid] = byUser[oid] || ('Roster ' + rid);
        SC.rosterMeta[res.lgId] = map;
      } catch (_) { SC.rosterMeta[res.lgId] = {}; }
    }));

    SC.results = results;
    SC.skipNote = [
      otherFormatCount ? `${otherFormatCount} ${SC.format === 'dynasty' ? 'redraft' : 'dynasty'} league${otherFormatCount !== 1 ? 's' : ''} not searched (switch format above)` : '',
      noOddsCount ? `${noOddsCount} league${noOddsCount !== 1 ? 's' : ''} skipped (no playoff odds yet — set a Root For Me pref or wait for projections)` : '',
      unreadCount ? `${unreadCount} league${unreadCount !== 1 ? 's' : ''} skipped (couldn’t read your team — check credentials for ESPN leagues)` : '',
      SC.rankSrc !== 'fc' && mode === 'adp' ? 'projections unavailable — ranked by ADP instead' : '',
    ].filter(Boolean).join(' · ');
    SC.progress = '';
  } catch (e) {
    SC.error = e.message || String(e);
    console.error('[scout]', e);
  }
  SC.running = false;
  renderScout();
}

function scoutClassBadge(cls, odds) {
  const pct = odds != null ? Math.round(odds * 100) + '%' : '—';
  if (cls === 'contender') return `<span class="badge badge-green">Contender ${pct}</span>`;
  if (cls === 'rebuilder') return `<span class="badge badge-red">Rebuilder ${pct}</span>`;
  return `<span class="badge badge-outline">Middle ${pct}</span>`;
}

function scoutPlayerLine(p) {
  const bits = [`${SC.pos}${p.rank}`];
  if (SC.rankSrc === 'myranks' && p.tier != null) bits.push('tier ' + p.tier);
  if (SC.format === 'dynasty' && p.age != null) bits.push('age ' + p.age);
  if (p.ppg > 0) bits.push(p.ppg.toFixed(1) + ' PPG');
  bits.push(p.team);
  return `<span style="font-family:'Crimson Text',serif;color:var(--parchment);font-size:0.92rem;">
    <strong>${esc(p.name)}</strong>
    <span style="color:var(--brown-light);font-style:italic;"> — ${bits.join(' · ')}</span>
  </span>`;
}

function scoutDrawResults() {
  const el = document.getElementById('scout-results');
  if (!el) return;
  if (SC.running && !SC.results) { el.innerHTML = loading(SC.progress || 'Working…'); return; }
  if (!SC.results) { el.innerHTML = ''; return; }
  const skip = SC.skipNote
    ? `<div style="font-family:'Crimson Text',serif;color:var(--brown-light);font-style:italic;font-size:0.8rem;margin-bottom:10px;">${esc(SC.skipNote)}</div>`
    : '';
  if (!SC.results.length) {
    el.innerHTML = skip + '<div class="empty-state"><p>No leagues matched — try loosening the filters or adjusting the thresholds in Settings.</p></div>';
    return;
  }

  const cards = SC.results.map(res => {
    const names = SC.rosterMeta[res.lgId] || {};
    const teamName = rid => names[rid] || ('Roster ' + rid);
    const head = `
      <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">
        <a href="/analyzer?league=${encodeURIComponent(res.lgId)}" target="_blank" rel="noopener" class="card-link">${esc(res.name)}</a>
        ${res.isEspn ? '<span class="badge badge-outline">ESPN</span>' : ''}
        ${scoutClassBadge(res.myClass, res.myOdds)}
      </div>`;

    let body;
    if (SC.mode === 'sell') {
      const selling = res.myPlayers.map(p => scoutPlayerLine(p)).join('<br>');
      const sellLbl = SC.format === 'redraft'
        ? `Your ${SC.pos} surplus (${res.myPlayers.length})`
        : 'You could sell';
      body = `
        <div class="sect">${sellLbl}</div>
        <div style="margin-bottom:10px;">${selling}</div>
        <div class="sect">Buyers</div>
        ${res.teams.map(t => `
          <div class="data-row" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span style="font-family:'Crimson Text',serif;color:var(--parchment);font-size:0.92rem;font-weight:600;">${esc(teamName(t.rid))}</span>
            ${scoutClassBadge(t.cls, t.odds)}
            <a class="ghost-btn" style="text-decoration:none;" target="_blank" rel="noopener" href="/trade-analyzer?league=${encodeURIComponent(res.lgId)}&b=${t.rid}">Analyze ⇄</a>
          </div>`).join('')}`;
    } else {
      body = res.teams.map(t => `
        <div class="data-row" style="padding:8px 0;">
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:4px;">
            <span style="font-family:'Crimson Text',serif;color:var(--parchment);font-size:0.92rem;font-weight:600;">${esc(teamName(t.rid))}</span>
            ${scoutClassBadge(t.cls, t.odds)}
            ${SC.format === 'redraft' ? `<span class="badge badge-outline">${t.players.length} ${SC.pos} surplus</span>` : ''}
            <a class="ghost-btn" style="text-decoration:none;" target="_blank" rel="noopener" href="/trade-analyzer?league=${encodeURIComponent(res.lgId)}&b=${t.rid}">Analyze ⇄</a>
          </div>
          <div>${t.players.map(p => scoutPlayerLine(p)).join('<br>')}</div>
        </div>`).join('');
    }

    return `<div style="background:var(--brown-dark);border:1px solid var(--brown-mid);border-radius:2px;padding:14px 18px;margin-bottom:10px;">${head}${body}</div>`;
  }).join('');

  el.innerHTML = skip + `<div style="font-family:'Crimson Text',serif;color:var(--brown-light);font-style:italic;font-size:0.85rem;margin-bottom:10px;">${SC.results.length} league${SC.results.length !== 1 ? 's' : ''} matched</div>${cards}`;
}
