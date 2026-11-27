// ════════════════════════════════════════════════════════════════════════════
// EspnCookies — a named entrypoint ONLY the Record Book worker can call.
//
// The Record Book (ffhistorian-worker) builds history for any ESPN league a user
// has connected. Private ESPN leagues need that user's cookies, which live here,
// encrypted with TOKEN_ENCRYPTION_KEY. Rather than copy the key into a second
// worker, the Record Book reaches this class through a service binding
// (`entrypoint = "EspnCookies"` in its wrangler.toml). A named entrypoint is not
// reachable from any route or URL, so these cookies never leave Cloudflare.
//
//   GET https://helper/cookie?user={userId} → { espn_s2, swid } | 404
// ════════════════════════════════════════════════════════════════════════════
import { WorkerEntrypoint } from 'cloudflare:workers';
import { openSecret } from './auth.js';

export class EspnCookies extends WorkerEntrypoint {
  async fetch(request) {
    const user = new URL(request.url).searchParams.get('user');
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    if (!user) return out({ error: 'user required' }, 400);
    const row = await this.env.DB.prepare(
      'SELECT espn_s2, swid FROM espn_settings WHERE user_id = ?'
    ).bind(user).first();
    if (!row?.espn_s2 || !row?.swid) return out({ error: 'no ESPN cookies' }, 404);
    const espn_s2 = await openSecret(row.espn_s2, this.env);
    if (!espn_s2) return out({ error: 'no ESPN cookies' }, 404);
    return out({ espn_s2, swid: row.swid });
  }
}
