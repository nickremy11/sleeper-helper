// The small set of helpers every page on every site can load, including My Ranks
// (cross-origin, the same way it loads shared-auth.js). Load it first.

// API roots. A page on the helper host calls the Worker same-origin; every other
// host (the apex site, My Ranks, local files) has to name it.
const SH_API = (location.hostname === 'helper.ffhistorian.com' || location.hostname.endsWith('.pages.dev'))
  ? '/api'
  : 'https://helper.ffhistorian.com/api';
const MYRANKS_API = 'https://myranks.ffhistorian.com';

function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// A value as a JS argument inside an on*="…" attribute, safe for any text
// ("Nick's Team"). esc() alone isn't: the browser decodes the attribute first.
function jsArg(v) { return esc(JSON.stringify(v ?? '')); }
function errHtml(e) { return `<div class="err-state">Error: ${esc(e.message)}</div>`; }
function loading(msg = 'Loading…') { return `<div class="loading-state"><div class="spinner"></div>${esc(msg)}</div>`; }

// ── Player names ────────────────────────────────────────────────────────────

// Manual aliases for players whose commonly-used name differs from Sleeper's own
// full_name (nicknames, not punctuation — normName() handles that first). Keys and
// values are pre-normalized. Add entries here as new mismatches surface.
const NAME_ALIASES = {
  'kenneth gainwell': 'kenny gainwell',
  'nicholas singleton': 'nick singleton',
  'bam knight': 'zonovan knight',
};

// Normalize a player name for matching across sources: lowercase, accents folded,
// a hyphen becomes a space ("Amon-Ra" = "Amon Ra"), all other punctuation dropped
// ("St." = "St", "C.J." = "CJ", "Tre'" = "Tre"), a trailing Jr/Sr/II-V dropped, then
// known aliases applied. Both a name→id index and every lookup against it MUST go
// through this. Checked against Sleeper's full player list: the hyphen rule
// creates no new name collisions.
function normName(s) {
  const key = (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/-/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+(jr|sr|ii|iii|iv|v)$/, '');
  return NAME_ALIASES[key] || key;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

// Rows of raw cells: quoted fields (commas and newlines inside them), "" escapes,
// CRLF and a UTF-8 BOM all handled.
function csvRows(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  const t = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    }
    else if (c === '"')  q = true;
    else if (c === ',')  { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// The same rows with every cell trimmed and blank rows dropped.
function csvTable(text) {
  return csvRows(text).map(r => r.map(c => c.trim())).filter(r => r.some(Boolean));
}
