/**
 * Auth module — register, login, session management, Sleeper token encryption.
 *
 * Passwords:  PBKDF2-SHA-256, 200k iterations, random salt.
 * Token enc:  AES-256-GCM with TOKEN_ENCRYPTION_KEY Worker secret (base64 32 bytes).
 * Sessions:   random 64-char hex token stored in D1, set as HttpOnly cookie sh_session.
 */

const SESSION_TTL    = 30 * 24 * 60 * 60;      // seconds
const SESSION_TTL_MS = SESSION_TTL * 1000;

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Password ──────────────────────────────────────────────────────────────────

function validatePassword(pw) {
  if (!pw || pw.length < 12)    return 'Password must be at least 12 characters';
  if (!/[A-Z]/.test(pw))        return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(pw))        return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(pw))        return 'Password must contain a number';
  if (!/[^A-Za-z0-9]/.test(pw)) return 'Password must contain a symbol';
  return null;
}

async function hashPassword(password) {
  const salt   = crypto.getRandomValues(new Uint8Array(32));
  const saltB64 = btoa(String.fromCharCode(...salt));
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits   = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, keyMat, 256);
  return { hash: btoa(String.fromCharCode(...new Uint8Array(bits))), salt: saltB64 };
}

async function verifyPassword(password, storedHash, storedSalt) {
  const salt   = Uint8Array.from(atob(storedSalt), c => c.charCodeAt(0));
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits   = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' }, keyMat, 256);
  return btoa(String.fromCharCode(...new Uint8Array(bits))) === storedHash;
}

// ── Token encryption ──────────────────────────────────────────────────────────

async function importEncKey(secret) {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptToken(token, secret) {
  const key = await importEncKey(secret);
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(token));
  return {
    enc: btoa(String.fromCharCode(...new Uint8Array(enc))),
    iv:  btoa(String.fromCharCode(...iv)),
  };
}

export async function decryptStoredToken(encB64, ivB64, secret) {
  const key = await importEncKey(secret);
  const enc = Uint8Array.from(atob(encB64), c => c.charCodeAt(0));
  const iv  = Uint8Array.from(atob(ivB64),  c => c.charCodeAt(0));
  const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, enc);
  return new TextDecoder().decode(dec);
}

// ── Session helpers ───────────────────────────────────────────────────────────

function randomHex(bytes = 32) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), b => b.toString(16).padStart(2, '0')).join('');
}

function getSessionId(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match  = cookie.match(/(?:^|;\s*)sh_session=([^;]+)/);
  return match ? match[1] : null;
}

export async function getAuthUser(request, env) {
  const sessionId = getSessionId(request);
  if (!sessionId) return null;
  const row = await env.DB.prepare(
    `SELECT s.user_id, s.expires_at, u.email, u.sleeper_username, u.token_enc, u.token_iv
     FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ?`
  ).bind(sessionId).first();
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
    return null;
  }
  return row;
}

// ── Response helpers ──────────────────────────────────────────────────────────

function jsonRes(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json;charset=UTF-8', ...extra },
  });
}

function errRes(msg, status = 400) {
  return jsonRes({ error: msg }, status);
}

// ── Session creation ──────────────────────────────────────────────────────────

async function createSession(userId, env) {
  const id = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(id, userId, Date.now() + SESSION_TTL_MS).run();
  const cookie = `sh_session=${id}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL}; Path=/`;
  return jsonRes({ ok: true }, 200, { 'Set-Cookie': cookie });
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function register(request, env) {
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { email, password } = body ?? {};
  if (!email || !String(email).includes('@')) return errRes('Valid email required');

  const isAllowed = await env.SLEEPER_KV.get('allowed_email:' + String(email).toLowerCase());
  if (isAllowed === null) return errRes('This email is not authorized to register');

  const pwErr = validatePassword(password);
  if (pwErr) return errRes(pwErr);

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(String(email).toLowerCase()).first();
  if (existing) return errRes('An account with that email already exists');

  const { hash, salt } = await hashPassword(String(password));
  const id = randomHex(16);
  await env.DB.prepare('INSERT INTO users (id, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, String(email).toLowerCase(), hash, salt, Date.now()).run();
  return createSession(id, env);
}

async function login(request, env) {
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { email, password } = body ?? {};
  if (!email || !password) return errRes('Email and password required');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(String(email).toLowerCase()).first();
  if (!user) return errRes('Invalid email or password');
  const ok = await verifyPassword(String(password), user.password_hash, user.password_salt);
  if (!ok) return errRes('Invalid email or password');
  return createSession(user.id, env);
}

async function me(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return jsonRes({ user: null });
  return jsonRes({
    user: {
      email:            user.email,
      sleeper_username: user.sleeper_username,
      has_token:        !!user.token_enc,
    },
  });
}

async function updateMe(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return errRes('Not authenticated', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }

  const stmts = [];
  if ('sleeper_username' in body) {
    stmts.push(
      env.DB.prepare('UPDATE users SET sleeper_username = ? WHERE id = ?')
        .bind(body.sleeper_username || null, user.user_id)
    );
  }
  if ('token' in body) {
    if (body.token) {
      const { enc, iv } = await encryptToken(String(body.token), env.TOKEN_ENCRYPTION_KEY);
      stmts.push(
        env.DB.prepare('UPDATE users SET token_enc = ?, token_iv = ? WHERE id = ?')
          .bind(enc, iv, user.user_id)
      );
    } else {
      stmts.push(
        env.DB.prepare('UPDATE users SET token_enc = NULL, token_iv = NULL WHERE id = ?')
          .bind(user.user_id)
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return jsonRes({ ok: true });
}

async function logout(request, env) {
  const sessionId = getSessionId(request);
  if (sessionId) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run();
  const clear = 'sh_session=; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Path=/';
  return jsonRes({ ok: true }, 200, { 'Set-Cookie': clear });
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function handleAuth(request, env, url) {
  const p = url.pathname;
  if (p === '/api/auth/register' && request.method === 'POST')  return register(request, env);
  if (p === '/api/auth/login'    && request.method === 'POST')  return login(request, env);
  if (p === '/api/auth/me'       && request.method === 'GET')   return me(request, env);
  if (p === '/api/auth/me'       && request.method === 'PATCH') return updateMe(request, env);
  if (p === '/api/auth/logout'   && request.method === 'POST')  return logout(request, env);
  return errRes('Not found', 404);
}
