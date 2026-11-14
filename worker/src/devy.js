// GET /api/devy?league={lgId}&prev={previousLeagueId}
//
// Devy leagues hold college players on Sleeper as K / IDP placeholders, and a
// Google Sheet is the league's record of who those placeholders really are.
// This route only fetches that sheet — every tab, as raw CSV — and caches it;
// all parsing and matching happens client-side (devy* in shared-utils.js),
// where it's testable and where the Sleeper rosters already are.
//
// DEVY_SHEETS is an allowlist, not a convenience: without it this would be an
// open proxy for any Google Sheet. Sleeper mints a new league_id every season,
// so the client also sends previous_league_id — a renewed league keeps working
// for a season without a deploy (add the new id here when you get the chance).
import { CORS, kvCachedJson } from './http.js';

// sheet: the Google Sheet id. ignore: devy names to drop everywhere (out of the
// league, or graduated under a name Sleeper doesn't carry). rename: sheet
// spelling → the real name, applied to every tab before matching.
const DEVY_SHEETS = {
  '1312511402388258816': {   // Are You Into Devy Stuff?
    sheet: '1gU4VrBes8A5E18ffpTijAZ8iHJnLJtVcXMv0vQSQeUc',
    ignore: ['Maqruarius "Squirrel" White', 'Taylor Tatum', 'Trevonte Citizen', 'KJ Jefferson', 'Bru McCoy', 'Michael Sturdivant'],
    rename: { 'Sheloton Sampson Jr': 'Shelton Sampson Jr' },
  },
};

const DEVY_TTL = 600;   // 10 min — the sheet is edited by hand after trades

export async function handleDevy(env, url) {
  const cfg = DEVY_SHEETS[url.searchParams.get('league')] || DEVY_SHEETS[url.searchParams.get('prev')];
  if (!cfg) {
    return new Response(JSON.stringify({ devy: false }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }
  const sheetId = cfg.sheet;
  // The config is folded into the cache key, so a deploy that edits it isn't
  // hidden behind 10 minutes of the old response.
  const cfgTag = [...JSON.stringify([cfg.ignore, cfg.rename])].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
  return kvCachedJson(env, `devy_sheet_v2_${sheetId}_${cfgTag}`, {
    ttl: DEVY_TTL,
    load: async () => {
      const base = `https://docs.google.com/spreadsheets/d/${sheetId}`;
      // Tab names + gids come from the public htmlview page; the export URL
      // needs a gid per tab. Reading the list (rather than hardcoding gids)
      // means next year's "2027 Draft" tab is picked up on its own.
      const html = await fetch(`${base}/htmlview`).then(r => {
        if (!r.ok) throw new Error(`Devy sheet not readable (${r.status}) — is it shared "anyone with the link"?`);
        return r.text();
      });
      const tabs = [...html.matchAll(/items\.push\(\{name: "((?:[^"\\]|\\.)*)",[^}]*?gid: "(-?\d+)"/g)]
        .map(m => ({ name: JSON.parse(`"${m[1]}"`), gid: m[2] }));
      if (!tabs.length) tabs.push({ name: 'Sheet1', gid: '0' });
      const withCsv = await Promise.all(tabs.map(async t => {
        const r = await fetch(`${base}/export?format=csv&gid=${t.gid}`);
        if (!r.ok) throw new Error(`Devy sheet tab "${t.name}" failed (${r.status})`);
        return { ...t, csv: await r.text() };
      }));
      return JSON.stringify({ devy: true, sheetUrl: `${base}/edit`, tabs: withCsv, ignore: cfg.ignore || [], rename: cfg.rename || {} });
    },
  });
}
