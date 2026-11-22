/**
 * Federated sign-in — "Continue with Google" (OpenID Connect, authorization-code flow).
 *
 *   GET helper /api/oauth/providers        → {providers: ['google']} — only the configured ones
 *   GET ffhistorian.com/auth/google/start?next= → 302 to Google's consent screen
 *   GET ffhistorian.com/auth/google/callback    → exchanges the code, signs in, sends the browser on
 *
 * The flow lives on the ROOT domain (the account is shared by every site; helper
 * is just one tool). ffhistorian.com/api/* already belongs to the Record Book
 * worker, so these sit under /auth/* — wrangler.toml routes ffhistorian.com/auth/*
 * here. The same paths under helper's /api/oauth/ still answer, for old links.
 *
 * Off until both secrets exist (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET), so the
 * button never shows for a half-configured provider. These routes sit OUTSIDE
 * /api/auth/ on purpose: that router's wrapper rewrites every response to JSON,
 * which would swallow the redirects.
 *
 * Account matching: (provider, sub) in user_identities first. Failing that, a
 * Google-VERIFIED email that matches an existing account links to it (Google
 * has proven the mailbox, which is all our own signup proves). Otherwise a new
 * account is created with no usable password (OAUTH_NO_PASSWORD) — the user can
 * set one any time with Forgot password.
 */
import { createSession, randomHex, notifyAdmin, OAUTH_NO_PASSWORD } from './auth.js';

const SITE        = 'https://ffhistorian.com';
const CALLBACK    = `${SITE}/auth/google/callback`;
export const OAUTH_START_URL = `${SITE}/auth/google/start`;
const STATE_TTL   = 600; // seconds a sign-in attempt may take
const ALLOWED_NEXT_HOSTS = new Set([
  'ffhistorian.com', 'helper.ffhistorian.com', 'myranks.ffhistorian.com',
  'recordbook.ffhistorian.com', 'playoff.ffhistorian.com', 'projections.ffhistorian.com',
]);

export function oauthProviders(env) {
  return env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? ['google'] : [];
}

// Only send the browser back to one of our own sites.
function safeNext(raw) {
  try {
    const u = new URL(raw || '/', SITE);
    if (u.protocol === 'https:' && ALLOWED_NEXT_HOSTS.has(u.hostname)) return u.toString();
  } catch {}
  return `${SITE}/`;
}

// The session cookie is SameSite=Strict, and a redirect chain that began on
// accounts.google.com is cross-site — a 302 straight to the app would arrive
// without the cookie and the page would read as signed out. A tiny same-site
// page that navigates on its own starts a fresh, same-site navigation.
function bouncePage(target, cookie, message) {
  const t = JSON.stringify(target);
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Signing in…</title><body style="font-family:Georgia,serif;background:#f3e9d2;color:#1f3d22;padding:40px;text-align:center">
<p>${message || 'Signing you in…'}</p><p><a href=${t}>Continue</a></p>
<script>location.replace(${t})</script>`;
  const headers = { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store' };
  if (cookie) headers['Set-Cookie'] = cookie;
  return new Response(html, { status: 200, headers });
}

function failTo(next, reason) {
  const u = new URL(next);
  u.searchParams.set('signin_error', reason);
  return bouncePage(u.toString(), null, 'Sign-in did not complete.');
}

function b64urlJson(part) {
  const s = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(s + '='.repeat((4 - s.length % 4) % 4)));
}

async function googleStart(env, url) {
  if (!oauthProviders(env).includes('google')) return new Response('Google sign-in is not configured', { status: 404 });
  const state = randomHex(24);
  const nonce = randomHex(16);
  const next  = safeNext(url.searchParams.get('next'));
  await env.SLEEPER_KV.put(`oauth_state_${state}`, JSON.stringify({ nonce, next }), { expirationTtl: STATE_TTL });
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID, redirect_uri: CALLBACK, response_type: 'code',
    scope: 'openid email profile', state, nonce, prompt: 'select_account',
  }).toString();
  return Response.redirect(auth.toString(), 302);
}

async function googleCallback(env, url) {
  const state = url.searchParams.get('state') || '';
  const saved = state ? await env.SLEEPER_KV.get(`oauth_state_${state}`, 'json') : null;
  if (saved) await env.SLEEPER_KV.delete(`oauth_state_${state}`);   // single use
  const next = safeNext(saved?.next);
  if (!saved) return failTo(next, 'expired');
  if (url.searchParams.get('error')) return failTo(next, 'cancelled');
  const code = url.searchParams.get('code');
  if (!code) return failTo(next, 'cancelled');

  // The token comes straight from Google over TLS with our client secret, so
  // its ID token's claims can be read without verifying the signature (the
  // OIDC spec allows this for the code flow). aud/iss/nonce/exp still checked.
  const tr = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: CALLBACK, grant_type: 'authorization_code',
    }),
  });
  const tok = await tr.json().catch(() => ({}));
  if (!tr.ok || !tok.id_token) { console.error('[oauth google] token exchange failed', tr.status, tok.error); return failTo(next, 'google'); }

  let claims;
  try { claims = b64urlJson(tok.id_token.split('.')[1]); } catch { return failTo(next, 'google'); }
  const issOk = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
  if (!issOk || claims.aud !== env.GOOGLE_CLIENT_ID || claims.nonce !== saved.nonce || claims.exp * 1000 < Date.now()) {
    return failTo(next, 'google');
  }
  if (!claims.sub || !claims.email || claims.email_verified !== true) return failTo(next, 'unverified');

  const email = String(claims.email).toLowerCase();
  const db = env.DB;
  let userId = (await db.prepare('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?')
    .bind('google', claims.sub).first())?.user_id;

  if (!userId) {
    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
    const now = Date.now();
    if (existing) {
      userId = existing.id;
      // Google proved the mailbox — an abandoned unverified signup becomes verified.
      await db.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(userId).run();
    } else {
      userId = randomHex(16);
      const salt = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
      await db.prepare(
        `INSERT INTO users (id, email, password_hash, password_salt, name, created_at, email_verified)
         VALUES (?, ?, ?, ?, ?, ?, 1)`
      ).bind(userId, email, OAUTH_NO_PASSWORD, salt, claims.name ? String(claims.name).slice(0, 64) : null, now).run();
      await notifyAdmin(env, 'New account (Google)', `New account via Google sign-in: ${email}`);
    }
    await db.prepare(
      'INSERT OR IGNORE INTO user_identities (provider, subject, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind('google', claims.sub, userId, email, now).run();
  }

  const cookie = await createSession(userId, env);
  return bouncePage(next, cookie);
}

export async function handleOAuth(request, env, url) {
  // '/api/oauth/x' (helper) and '/auth/x' (ffhistorian.com) are the same route.
  const p = url.pathname.replace(/^\/api\/oauth\//, '/').replace(/^\/auth\//, '/');
  if (p === '/providers') {
    return new Response(JSON.stringify({ providers: oauthProviders(env) }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=300' },
    });
  }
  if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
  if (p === '/google/start')    return googleStart(env, url);
  if (p === '/google/callback') return googleCallback(env, url);
  return new Response('Not found', { status: 404 });
}
