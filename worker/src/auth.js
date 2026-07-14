/**
 * Auth module — register, login, session management, Sleeper token encryption.
 *
 * Passwords:  PBKDF2-SHA-256, 200k iterations, random salt.
 * Token enc:  AES-256-GCM with TOKEN_ENCRYPTION_KEY Worker secret (base64 32 bytes).
 * Sessions:   random 64-char hex token stored in D1, set as HttpOnly cookie sh_session.
 * Email:      6-digit OTP for signup verification + password reset, sent via the
 *             Workers `EMAIL` (Cloudflare Email Service) binding. Admin gets notified
 *             on every account created/deleted.
 */

const SESSION_TTL    = 30 * 24 * 60 * 60;      // seconds
const SESSION_TTL_MS = SESSION_TTL * 1000;

const OTP_TTL_MS       = 15 * 60 * 1000;  // code validity window
const OTP_RESEND_MS    = 45 * 1000;       // min gap between sends
const OTP_MAX_ATTEMPTS = 5;

const ADMIN_EMAIL = 'nickremy11@gmail.com';

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
  const bits   = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMat, 256);
  return { hash: btoa(String.fromCharCode(...new Uint8Array(bits))), salt: saltB64 };
}

async function verifyPassword(password, storedHash, storedSalt) {
  const salt   = Uint8Array.from(atob(storedSalt), c => c.charCodeAt(0));
  const keyMat = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits   = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, keyMat, 256);
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

// ── Email sending ─────────────────────────────────────────────────────────────

async function sendMail(env, { to, subject, html, text }) {
  await env.EMAIL.send({
    to,
    from: { email: 'noreply@ffhistorian.com', name: 'Sleeper Helper' },
    subject,
    html,
    text,
  });
}

async function notifyAdmin(env, subject, text) {
  try {
    await env.EMAIL.send({
      to: ADMIN_EMAIL,
      from: { email: 'alerts@ffhistorian.com', name: 'Sleeper Helper' },
      subject,
      text,
      html: `<p>${text}</p>`,
    });
  } catch (e) {
    console.error('notifyAdmin failed:', e);
  }
}

// ── One-time passcodes (email verification + password reset) ─────────────────

function generateOtp() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, '0');
}

async function hashOtp(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

function otpEmailHtml(heading, code) {
  return `<div style="font-family:Georgia,serif;max-width:480px">
    <h2>${heading}</h2>
    <p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${code}</p>
    <p>This code expires in 15 minutes.</p>
  </div>`;
}

function otpEmailText(heading, code) {
  return `${heading}\n\nYour code: ${code}\n\nThis code expires in 15 minutes.`;
}

// Upserts a fresh code into `table` for `userId` and emails it, unless one was
// already sent within OTP_RESEND_MS (in which case it's a no-op — the previous
// code is still valid). Returns true if a new code was actually sent.
async function issueOtp(env, table, userId, email, heading) {
  const existing = await env.DB.prepare(`SELECT sent_at FROM ${table} WHERE user_id = ?`).bind(userId).first();
  const now = Date.now();
  if (existing && now - existing.sent_at < OTP_RESEND_MS) return false;

  const code     = generateOtp();
  const codeHash = await hashOtp(code);
  await env.DB.prepare(
    `INSERT INTO ${table} (user_id, code_hash, expires_at, attempts, sent_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, sent_at = excluded.sent_at`
  ).bind(userId, codeHash, now + OTP_TTL_MS, now).run();

  await sendMail(env, {
    to: email,
    subject: heading,
    html: otpEmailHtml(heading, code),
    text: otpEmailText(heading, code),
  });
  return true;
}

// Validates `code` against the pending row in `table` for `userId`. Returns an
// error message string on failure, or null on success (and consumes the row).
async function checkOtp(env, table, userId, code) {
  const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(userId).first();
  if (!row) return 'No pending code — request a new one';
  if (row.attempts >= OTP_MAX_ATTEMPTS) return 'Too many attempts — request a new code';
  if (Date.now() > row.expires_at) return 'Code expired — request a new one';

  const hash = await hashOtp(String(code || '').trim());
  if (hash !== row.code_hash) {
    await env.DB.prepare(`UPDATE ${table} SET attempts = attempts + 1 WHERE user_id = ?`).bind(userId).run();
    return 'Incorrect code';
  }
  await env.DB.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(userId).run();
  return null;
}

// ── Account deletion ───────────────────────────────────────────────────────────

async function deleteUserAccount(userId, env) {
  const user = await env.DB.prepare('SELECT email FROM users WHERE id = ?').bind(userId).first();
  if (!user) return null;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM league_preferences WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM espn_settings WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_rankings WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_tier_picks WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM named_ranking_players WHERE set_id IN (SELECT id FROM named_ranking_sets WHERE owner_user_id = ?)').bind(userId),
    env.DB.prepare('DELETE FROM named_ranking_set_shares WHERE set_id IN (SELECT id FROM named_ranking_sets WHERE owner_user_id = ?) OR shared_with_user_id = ?').bind(userId, userId),
    env.DB.prepare('DELETE FROM named_ranking_sets WHERE owner_user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM user_rankings_shares WHERE owner_user_id = ? OR shared_with_user_id = ?').bind(userId, userId),
    env.DB.prepare('DELETE FROM player_projections WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM team_projections WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM email_verifications WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId),
  ]);
  return user.email;
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
    `SELECT s.user_id, s.expires_at, u.email, u.name, u.sleeper_username, u.token_enc, u.token_iv
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
  return `sh_session=${id}; HttpOnly; Secure; SameSite=Strict; Domain=.ffhistorian.com; Max-Age=${SESSION_TTL}; Path=/`;
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function register(request, env) {
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { email, password } = body ?? {};
  if (!email || !String(email).includes('@')) return errRes('Valid email required');
  const normalizedEmail = String(email).toLowerCase();

  const pwErr = validatePassword(password);
  if (pwErr) return errRes(pwErr);

  const existing = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?')
    .bind(normalizedEmail).first();
  if (existing && existing.email_verified) return errRes('An account with that email already exists');

  const { hash, salt } = await hashPassword(String(password));
  const userId = existing ? existing.id : randomHex(16);

  if (existing) {
    // Unverified account from an abandoned signup — restart it with the new password.
    await env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?')
      .bind(hash, salt, userId).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, password_salt, created_at, email_verified) VALUES (?, ?, ?, ?, ?, 0)'
    ).bind(userId, normalizedEmail, hash, salt, Date.now()).run();
  }

  try {
    await issueOtp(env, 'email_verifications', userId, normalizedEmail, 'Verify your email');
  } catch (e) {
    return errRes('Could not send the verification email — try again shortly', 502);
  }

  if (!existing) {
    await notifyAdmin(env, 'New account registered', `New sleeper-helper account registered: ${normalizedEmail}`);
  }

  return jsonRes({ ok: true, needsVerification: true, email: normalizedEmail });
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

  if (!user.email_verified) {
    try {
      await issueOtp(env, 'email_verifications', user.id, user.email, 'Verify your email');
    } catch (e) {
      return errRes('Could not send the verification email — try again shortly', 502);
    }
    return jsonRes({ ok: true, needsVerification: true, email: user.email });
  }

  const cookie = await createSession(user.id, env);
  return jsonRes({ ok: true, user: { email: user.email, name: user.name || null, sleeper_username: user.sleeper_username } }, 200, { 'Set-Cookie': cookie });
}

async function verifyEmail(request, env) {
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { email, code } = body ?? {};
  if (!email || !code) return errRes('Email and code required');

  const user = await env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind(String(email).toLowerCase()).first();
  if (!user) return errRes('Invalid email or code');

  const err = await checkOtp(env, 'email_verifications', user.id, code);
  if (err) return errRes(err);

  await env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(user.id).run();
  const cookie = await createSession(user.id, env);
  return jsonRes({ ok: true, user: { email: user.email, name: user.name || null, sleeper_username: user.sleeper_username } }, 200, { 'Set-Cookie': cookie });
}

async function resendCode(request, env) {
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { email } = body ?? {};
  if (!email) return errRes('Email required');

  const user = await env.DB.prepare('SELECT id, email, email_verified FROM users WHERE email = ?')
    .bind(String(email).toLowerCase()).first();
  if (!user || user.email_verified) return jsonRes({ ok: true }); // don't leak account state

  try {
    const sent = await issueOtp(env, 'email_verifications', user.id, user.email, 'Verify your email');
    if (!sent) return errRes('Please wait a bit before requesting another code');
  } catch (e) {
    return errRes('Could not send the verification email — try again shortly', 502);
  }
  return jsonRes({ ok: true });
}

async function forgotPassword(request, env) {
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { email } = body ?? {};
  if (!email) return errRes('Email required');

  const user = await env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(String(email).toLowerCase()).first();
  if (user) {
    try { await issueOtp(env, 'password_resets', user.id, user.email, 'Reset your password'); }
    catch (e) { console.error('forgotPassword send failed:', e); }
  }
  // Always respond ok — don't reveal whether the email has an account.
  return jsonRes({ ok: true });
}

async function resetPassword(request, env) {
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { email, code, newPassword } = body ?? {};
  if (!email || !code || !newPassword) return errRes('Email, code, and new password required');

  const user = await env.DB.prepare('SELECT id, email, name, sleeper_username FROM users WHERE email = ?')
    .bind(String(email).toLowerCase()).first();
  if (!user) return errRes('Invalid email or code');

  const pwErr = validatePassword(String(newPassword));
  if (pwErr) return errRes(pwErr);

  const err = await checkOtp(env, 'password_resets', user.id, code);
  if (err) return errRes(err);

  const { hash, salt } = await hashPassword(String(newPassword));
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, user.id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
  ]);
  const cookie = await createSession(user.id, env);
  return jsonRes({ ok: true, user: { email: user.email, name: user.name || null, sleeper_username: user.sleeper_username } }, 200, { 'Set-Cookie': cookie });
}

async function deleteAccount(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return errRes('Not authenticated', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { password } = body ?? {};
  if (!password) return errRes('Password required');

  const fullUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.user_id).first();
  const ok = await verifyPassword(String(password), fullUser.password_hash, fullUser.password_salt);
  if (!ok) return errRes('Incorrect password');

  const email = await deleteUserAccount(user.user_id, env);
  await notifyAdmin(env, 'Account deleted', `Account deleted: ${email}`);

  const clear = 'sh_session=; HttpOnly; Secure; SameSite=Strict; Domain=.ffhistorian.com; Max-Age=0; Path=/';
  return jsonRes({ ok: true }, 200, { 'Set-Cookie': clear });
}

async function adminDeleteUser(request, env) {
  const secret = request.headers.get('X-Admin-Secret');
  if (!secret || secret !== env.ADMIN_SECRET) return errRes('Not authorized', 401);

  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { email } = body ?? {};
  if (!email) return errRes('Email required');

  const target = await env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(String(email).toLowerCase()).first();
  if (!target) return errRes('No account with that email', 404);

  const deletedEmail = await deleteUserAccount(target.id, env);
  await notifyAdmin(env, 'Account deleted (admin)', `Account deleted by admin action: ${deletedEmail}`);
  return jsonRes({ ok: true });
}

async function me(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return jsonRes({ user: null });
  return jsonRes({
    user: {
      email:            user.email,
      name:             user.name || null,
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
  if ('name' in body) {
    stmts.push(
      env.DB.prepare('UPDATE users SET name = ? WHERE id = ?')
        .bind(body.name ? String(body.name).trim().slice(0, 64) : null, user.user_id)
    );
  }
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
  const clear = 'sh_session=; HttpOnly; Secure; SameSite=Strict; Domain=.ffhistorian.com; Max-Age=0; Path=/';
  return jsonRes({ ok: true }, 200, { 'Set-Cookie': clear });
}

async function changePassword(request, env) {
  const user = await getAuthUser(request, env);
  if (!user) return errRes('Not authenticated', 401);
  let body;
  try { body = await request.json(); } catch { return errRes('Invalid JSON'); }
  const { currentPassword, newPassword } = body ?? {};
  if (!currentPassword || !newPassword) return errRes('currentPassword and newPassword required');

  const fullUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(user.user_id).first();
  const ok = await verifyPassword(String(currentPassword), fullUser.password_hash, fullUser.password_salt);
  if (!ok) return errRes('Current password is incorrect');

  const pwErr = validatePassword(String(newPassword));
  if (pwErr) return errRes(pwErr);

  const { hash, salt } = await hashPassword(String(newPassword));
  const sessionId = getSessionId(request);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').bind(hash, salt, user.user_id),
    env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.user_id, sessionId),
  ]);
  return jsonRes({ ok: true });
}

// ── Router ────────────────────────────────────────────────────────────────────

export async function handleAuth(request, env, url) {
  const p = url.pathname;
  if (p === '/api/auth/register' && request.method === 'POST')  return register(request, env);
  if (p === '/api/auth/login'    && request.method === 'POST')  return login(request, env);
  if (p === '/api/auth/verify-email'      && request.method === 'POST') return verifyEmail(request, env);
  if (p === '/api/auth/resend-code'       && request.method === 'POST') return resendCode(request, env);
  if (p === '/api/auth/forgot-password'   && request.method === 'POST') return forgotPassword(request, env);
  if (p === '/api/auth/reset-password'    && request.method === 'POST') return resetPassword(request, env);
  if (p === '/api/auth/delete-account'    && request.method === 'POST') return deleteAccount(request, env);
  if (p === '/api/auth/admin/delete-user' && request.method === 'POST') return adminDeleteUser(request, env);
  if (p === '/api/auth/me'       && request.method === 'GET')   return me(request, env);
  if (p === '/api/auth/me'       && request.method === 'PATCH') return updateMe(request, env);
  if (p === '/api/auth/logout'          && request.method === 'POST')  return logout(request, env);
  if (p === '/api/auth/change-password' && request.method === 'POST')  return changePassword(request, env);
  return errRes('Not found', 404);
}
