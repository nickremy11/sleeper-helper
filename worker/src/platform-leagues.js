// ════════════════════════════════════════════════════════════════════════════
// PlatformLeagues — a named entrypoint ONLY the Record Book worker can call.
//
// The Record Book (ffhistorian-worker) shows the full history of any MFL or Yahoo
// league at /l/mfl_{id} and /l/yh_{id}. Reading those leagues needs everything
// that lives here: the MFL/Yahoo → Sleeper adapters (mfl-shape.js, yahoo-shape.js),
// the player-id crosswalk (KV pidx:*), the opener's stored MFL cookie / Yahoo
// refresh token (sealed with TOKEN_ENCRYPTION_KEY), MFL's registered user agent,
// and the per-league KV caches. So the Record Book asks this class over a service
// binding (`entrypoint = "PlatformLeagues"` in its wrangler.toml) instead of
// copying any of that. A named entrypoint has no route or URL.
//
//   GET https://helper/{mfl|yahoo}/{op}/{key}[/{res}[/{arg}]]?user={userId}
//     op = league | draft | trades | seasons      (see mflForRecordBook / yahooForRecordBook)
//   → the JSON, or {error} with MFL's / Yahoo's status
//
// `user` is the account that opened the league in the Record Book; its
// credentials are used when it has them (a public MFL league needs none).
// ════════════════════════════════════════════════════════════════════════════
import { WorkerEntrypoint } from 'cloudflare:workers';
import { mflForRecordBook } from './mfl.js';
import { yahooForRecordBook } from './yahoo.js';

export class PlatformLeagues extends WorkerEntrypoint {
  async fetch(request) {
    const url = new URL(request.url);
    const out = (obj, status = 200) => new Response(JSON.stringify(obj), {
      status, headers: { 'Content-Type': 'application/json' },
    });
    const m = url.pathname.match(/^\/(mfl|yahoo)\/(league|draft|trades|seasons)\/((?:mfl|yh)_[\d_]+)(?:\/([a-z_]+)(?:\/(\d+))?)?$/);
    if (!m) return out({ error: 'Not found' }, 404);
    const [, plat, op, key, res, arg] = m;
    if ((plat === 'mfl') !== key.startsWith('mfl_')) return out({ error: 'Platform and league id disagree' }, 400);
    const userId = url.searchParams.get('user');
    let user = null;
    if (userId) {
      user = await this.env.DB.prepare('SELECT id AS user_id, email, sleeper_username FROM users WHERE id = ?')
        .bind(userId).first().catch(() => null);
    }
    try {
      const fn = plat === 'mfl' ? mflForRecordBook : yahooForRecordBook;
      return out(await fn(this.env, user, op, key, res, arg));
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error('[platform-leagues]', url.pathname, e.message);
      return out({ error: e.message }, status);
    }
  }
}
