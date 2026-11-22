/**
 * POST /api/feedback — Help & Feedback form (profile → Help tab, and any page).
 *
 * Body: {kind: 'help'|'feedback'|'bug', message, email?, page?}
 * Mails ADMIN_EMAIL through the EMAIL binding with Reply-To set to the sender,
 * so answering is just hitting Reply. Signed-in users send their account email;
 * signed-out users must give one (otherwise there's no way to answer).
 * Rate-limited per account / IP in KV: FEEDBACK_MAX messages per hour.
 */
import { getAuthUser } from './auth.js';
import { getCors } from './http.js';

const KINDS = { help: 'Help request', feedback: 'Feedback', bug: 'Bug report' };
const FEEDBACK_MAX = 5;
const MSG_MAX = 5000;

const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function handleFeedback(request, env) {
  const cors = getCors(request);
  const out = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8' },
  });
  if (request.method !== 'POST') return out({ error: 'Method not allowed' }, 405);
  if (!env.ADMIN_EMAIL) return out({ error: 'Feedback is not set up yet' }, 503);

  let body;
  try { body = await request.json(); } catch { return out({ error: 'Invalid JSON' }, 400); }
  const kind    = KINDS[body?.kind] ? body.kind : 'feedback';
  const message = String(body?.message || '').trim();
  if (message.length < 5) return out({ error: 'Write a little more so we can help' }, 400);
  if (message.length > MSG_MAX) return out({ error: `Keep it under ${MSG_MAX} characters` }, 400);

  const user  = await getAuthUser(request, env).catch(() => null);
  const email = user?.email || String(body?.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return out({ error: 'Add an email address so we can reply' }, 400);

  const who = user ? `u_${user.user_id}` : `ip_${request.headers.get('CF-Connecting-IP') || 'unknown'}`;
  const rlKey = `feedback_rl_${who}`;
  const count = Number(await env.SLEEPER_KV.get(rlKey)) || 0;
  if (count >= FEEDBACK_MAX) return out({ error: 'That is a lot of messages in one hour — try again later' }, 429);
  await env.SLEEPER_KV.put(rlKey, String(count + 1), { expirationTtl: 3600 });

  const page = String(body?.page || '').slice(0, 300);
  const meta = [
    `From: ${email}${user ? ' (signed in)' : ' (signed out)'}`,
    user?.sleeper_username ? `Sleeper: ${user.sleeper_username}` : '',
    page ? `Page: ${page}` : '',
    `Browser: ${(request.headers.get('User-Agent') || '').slice(0, 200)}`,
  ].filter(Boolean);
  const subject = `[League Assist] ${KINDS[kind]} from ${email}`;
  try {
    await env.EMAIL.send({
      to: env.ADMIN_EMAIL,
      from: { email: 'support@ffhistorian.com', name: 'League Assist Support' },
      replyTo: email,
      subject,
      text: `${message}\n\n—\n${meta.join('\n')}`,
      html: `<div style="white-space:pre-wrap;font-family:Georgia,serif">${escHtml(message)}</div>
<hr><div style="color:#666;font-size:12px">${meta.map(escHtml).join('<br>')}</div>`,
    });
  } catch (e) {
    console.error('[feedback] send failed', e.code, e.message);
    return out({ error: 'Could not send right now — try again shortly' }, 502);
  }
  return out({ ok: true });
}
