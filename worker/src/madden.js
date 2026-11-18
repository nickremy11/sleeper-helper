// ── Ask Madden — the site's chatbot (/api/madden) ─────────────────────────────
// Signed-in only. The worker owns the model, the system prompt, the topic gate and
// the tool DEFINITIONS; the browser owns the tool IMPLEMENTATIONS. That split is
// deliberate: every answer is about data the app already loads client-side
// (Sleeper rosters, ESPN leagues through the proxy, League Summaries' odds sim,
// Scout's settings), so running the tools in the page reuses all of it instead of
// re-implementing league loading in the worker.
//
// One request = one model step. The client loop is:
//   POST {conv, messages}            → {reply} | {tool_calls:[{id,name,arguments}]} | {blocked, reply}
//   run the tools, append results    → POST again with the longer history
// The client caps that at MADDEN_MAX_STEPS-ish rounds; the worker caps history size.
//
// Every model call (gate + each step) goes through the same AI Gateway the
// ranking-sheet image reader uses, with per-user metadata so a conversation's
// calls group together in the logs. Gateway guardrails are configured on the
// gateway itself, not here.

import { getCors } from './http.js';
import { getAuthUser } from './auth.js';

// GLM-4.7-Flash ($0.06/M in, $0.40/M out), tuned for multi-turn tool calling.
// Replaced Llama 4 Scout, which ignored "of these leagues" filters, compared
// lists wrongly and once wrote a tool call as a link. On the same 9 replayed
// questions GLM got every tool choice, filter and list right, mostly in 3-6s.
export const MADDEN_MODEL   = '@cf/zai-org/glm-4.7-flash';
export const MADDEN_GATEWAY = 'sleeper-helper';
const MAX_MESSAGES   = 40;
const MAX_TOTAL_CHARS = 150_000;
const MAX_MSG_CHARS  = 24_000;   // one tool result — a list of 80+ leagues must fit
const MAX_USER_CHARS = 1_000;    // one typed question

// Answer for anything the gate turns away. Fixed text — never model output.
export const MADDEN_OFF_TOPIC =
  "I only talk about your fantasy football — your leagues, teams, players, trades and lineups. Try something like \"Which of my leagues score kick return yards?\" or \"Which leagues is Puka Nacua available in?\"";

// Answer when the AI Gateway's guardrails stop a call (error 2016 = the prompt
// was blocked, 2017 = the model's response was). Also fixed text.
export const MADDEN_GUARDRAIL =
  "The site's safety filter stopped that one, so I can't answer it. Try rephrasing — plain fantasy football questions work best.";

// Which side a guardrail blocked, from the binding's thrown error, or null when
// the error is something else (an outage, a bad request).
export function maddenGuardrailBlock(e) {
  const m = String(e?.message || e || '');
  if (/\b2017\b|response blocked/i.test(m)) return 'response';
  if (/\b2016\b|prompt blocked|blocked due to security/i.test(m)) return 'prompt';
  return null;
}
class MaddenGuardrailError extends Error {
  constructor(where, step) { super('guardrail ' + where); this.where = where; this.step = step; }
}

// The topic gate is Clef, Cloudflare's decision model: it answers typed
// questions with probabilities instead of generating text, bills input tokens
// only, and returns in ~0.2s. Full Clef rather than Clef-flash on purpose: on
// CLINC150+OOS (out-of-scope detection — this exact job) Clef scores 97.4 and
// Clef-flash 66.8.
export const MADDEN_GATE_MODEL = '@cf/cloudflare/clef';
const GATE_SELECTOR = 'clef';
// Block when P(on topic) falls below this.
export const MADDEN_GATE_THRESHOLD = 0.5;
// Worded as a plain description of the subject, on purpose. The gateway's P1
// (prompt injection) guardrail scans the WHOLE request, our text included, and
// the first version — "ONLY", "must not", a question about ignoring rules or
// revealing a system prompt — read as an injection and got every question
// blocked. Prompt injection is left to that guardrail; this asks topic only.
export const MADDEN_GATE_QUESTIONS = {
  on_topic: {
    type: 'noul',
    instructions: 'The state is a message typed into a fantasy football helper website. Is the new message about the sender\'s fantasy football (their leagues, teams, rosters, players, trades, lineups, waivers, drafts, scoring, standings or playoff odds), about NFL players as fantasy assets, about using the website, or a greeting or short follow-up to a fantasy football question? Messages about food, weather, time, travel, coding, homework, writing, other sports or betting are not.',
  },
};

// Clef documents a noul answer as the probability of "yes"; accept a bare
// number or an object carrying it, so a shape change fails open, not shut.
export function maddenNoulProb(a) {
  if (typeof a === 'number') return a;
  if (a && typeof a === 'object') {
    for (const k of ['noul', 'probability', 'p', 'yes']) if (typeof a[k] === 'number') return a[k];
  }
  return null;
}

// → {allow, onTopic}. A missing answer allows (the system prompt still keeps
// replies on topic); a present one is obeyed.
export function maddenGateDecision(out) {
  const onTopic = maddenNoulProb(out?.answers?.on_topic);
  return { allow: !(onTopic != null && onTopic < MADDEN_GATE_THRESHOLD), onTopic };
}

// Same reason as above: describe the job, don't issue commands about secrecy or
// refusals — that phrasing is what the P1 guardrail flags.
const SYSTEM_PROMPT = `You are Madden, a fantasy football helper on helper.ffhistorian.com. You help the signed-in user with their own fantasy football leagues, teams, players, trades and lineups. For other subjects, say you can only help with their fantasy football.

How to answer:
- The tools are functions you call to read the user's data. For any question about their leagues, teams, players, scoring or standings, call the matching tool first, then answer from what it returns. A tool name is a function to call, not a web page, so it never appears in a link.
- Use only leagues, players, owners, scores, records and links that a tool returned. If a tool says data is unavailable, say so.
- Follow-up questions often narrow an earlier answer, such as "of these leagues" or "cross reference with". list_leagues and player_availability accept filters (scores_stat, format, role, platform, best_ball), so a follow-up is one more tool call with the earlier question's filter added. Example: "which of these is Dohnte Meyers available in" or "cross reference where he's available with the leagues that score return yards" are both player_availability with player "Dohnte Meyers" and scores_stat "return yards".
- Answers list every item the tool returned.
- League arguments take a league name (partial is fine) or league id. Player arguments take a name; if a name looks misspelled, call find_player first and say which player you used.
- Answer in plain text with the actual list or facts. No links, except: for a Scout query, call scout_query and give its link; when the user asks to open a page, call link_to.
- Be brief and lead with the answer. Use short bullet lists for several leagues or players. No tables.
- Terms: "contender"/"rebuilder" are the user's own tags (or playoff odds). "Dynasty" vs "redraft" is the league format. "Veteran" means at or above the user's age cutoff for the position.`;
// Temperature 0: the same question should take the same path every time.
export const MADDEN_TEMPERATURE = 0;
const MADDEN_STEP_TIMEOUT_MS = 45_000;

// Tool definitions. Implementations: pages/app/madden.js (MADDEN_TOOLS there must
// carry the same names). OpenAI function shape — the Workers AI binding accepts it.
const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});
const LEAGUE = { type: 'string', description: 'League name (partial ok) or league id' };
const FORMAT = { type: 'string', enum: ['dynasty', 'redraft', 'any'], description: 'League format filter' };
const ROLE   = { type: 'string', enum: ['contender', 'rebuilder', 'any'], description: "The user's contender/rebuilder tag for the league" };
const SCORES = { type: 'string', description: 'Only leagues that score this stat, in plain words (e.g. "kick or punt return yards", "TE premium")' };
const PLATFORM = { type: 'string', enum: ['sleeper', 'espn', 'any'] };
const BEST_BALL = { type: 'string', enum: ['yes', 'no', 'any'] };
export const MADDEN_TOOLS = [
  fn('list_leagues', "List the user's leagues with format, platform, size, superflex, PPR, TE premium, best ball, the user's contender/rebuilder tag, record and playoff odds when known.",
    { format: FORMAT, role: ROLE, platform: PLATFORM, best_ball: BEST_BALL, scores_stat: SCORES }),
  fn('find_leagues_by_scoring', 'Find which of the user\'s leagues score a stat (e.g. "kick return yards", "punt return yards", "first downs", "TE premium", "pick six", "sacks"), with the points each league gives.',
    { stat: { type: 'string', description: 'The stat in plain words' } }, ['stat']),
  fn('league_settings', "One league's roster slots and every non-zero scoring rule.", { league: LEAGUE }, ['league']),
  fn('find_player', 'Look up NFL players by (possibly misspelled) name. Returns the best matches with position, NFL team, age and injury status.',
    { name: { type: 'string' } }, ['name']),
  fn('player_availability', "For one player, every league of the user's: on the user's roster, owned by another manager (named), or a free agent.",
    { player: { type: 'string', description: 'Player name or Sleeper player id' }, format: FORMAT, role: ROLE, platform: PLATFORM, best_ball: BEST_BALL, scores_stat: SCORES }, ['player']),
  fn('my_roster', "The user's roster in one league: players by position with NFL team and injury status, and whether each is starting.", { league: LEAGUE }, ['league']),
  fn('league_standings', 'Standings for one league: every team\'s record, points for and playoff odds when known, with the user\'s team marked.', { league: LEAGUE }, ['league']),
  fn('scout_query', "Build a Scout query (cross-league trade finder) and return a link that runs it. Dynasty: finds teams holding top-N players at a position of an age bucket. Redraft: finds teams stacked at a position.",
    {
      format:    { type: 'string', enum: ['dynasty', 'redraft'] },
      mode:      { type: 'string', enum: ['buy', 'sell'], description: 'buy = find opponents who have them; sell = find my own' },
      position:  { type: 'string', enum: ['QB', 'RB', 'WR', 'TE'] },
      top_n:     { type: 'integer', enum: [12, 24, 36, 48], description: 'Dynasty: positional rank cutoff' },
      age:       { type: 'string', enum: ['young', 'vet'], description: 'Dynasty: young or veteran players' },
      opponent:  { type: 'string', enum: ['rebuilder', 'contender', 'either'], description: 'Dynasty: which kind of opponent to search' },
    }, ['position']),
  fn('link_to', "A link to one of the site's tools, optionally for one league.",
    { page: { type: 'string', enum: ['league_analyzer', 'trade_analyzer', 'league_summaries', 'lineups', 'waivers', 'players', 'open_trades', 'scoreboard', 'root_for_me', 'mass_offers'] }, league: LEAGUE }, ['page']),
];
const TOOL_NAMES = new Set(MADDEN_TOOLS.map(t => t.function.name));

const str = (v, n = 64) => String(v ?? '').slice(0, n);

// The Workers AI binding answers in the OpenAI shape for some models and the
// classic {response, tool_calls:[{name, arguments}]} shape for others.
export function maddenParseOutput(out) {
  const msg = out?.choices?.[0]?.message;
  const rawCalls = msg?.tool_calls || out?.tool_calls || [];
  const calls = [];
  for (const [i, c] of rawCalls.entries()) {
    const name = c?.function?.name ?? c?.name;
    let args = c?.function?.arguments ?? c?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args || '{}'); } catch { args = {}; } }
    if (!TOOL_NAMES.has(name)) continue;
    calls.push({ id: str(c?.id || `call_${Date.now().toString(36)}_${i}`, 80), name, arguments: args && typeof args === 'object' ? args : {} });
  }
  let text = msg?.content ?? out?.response ?? '';
  if (typeof text !== 'string') text = text == null ? '' : JSON.stringify(text);
  // Llama 4 Scout has written a tool call as a fake link instead —
  // "[Find leagues by scoring](/find_leagues_by_scoring?stat=return+yardage)".
  // The path and query say exactly which call it meant, so make that call.
  if (!calls.length) {
    const fake = maddenFakeToolLink(text);
    if (fake) { calls.push(fake); text = ''; }
  }
  // Some Llama builds print a tool call as JSON text instead of using tool_calls.
  if (!calls.length) {
    const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (t.startsWith('{') && t.endsWith('}')) {
      try {
        const j = JSON.parse(t);
        if (TOOL_NAMES.has(j?.name)) {
          const a = j.parameters || j.arguments || {};
          calls.push({ id: `call_${Date.now().toString(36)}`, name: j.name, arguments: typeof a === 'object' ? a : {} });
          text = '';
        }
      } catch { /* leave as text */ }
    }
  }
  return { text: text.trim(), calls };
}

// "[label](/tool_name?arg=value&…)" anywhere in the text → that tool call, or null.
export function maddenFakeToolLink(text) {
  const m = String(text || '').match(/\]\(\/([a-z_]+)(?:\?([^)\s]*))?\)/);
  if (!m || !TOOL_NAMES.has(m[1])) return null;
  const args = {};
  for (const [k, v] of new URLSearchParams(m[2] || '')) args[k] = /^\d+$/.test(v) ? Number(v) : v;
  return { id: `call_${Date.now().toString(36)}_link`, name: m[1], arguments: args };
}

// Only the shapes the client legitimately sends; anything else is dropped.
export function maddenCleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = [];
  for (const m of raw.slice(-MAX_MESSAGES)) {
    if (m?.role === 'user') msgs.push({ role: 'user', content: str(m.content, MAX_USER_CHARS) });
    else if (m?.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls.filter(c => TOOL_NAMES.has(c?.name)).map(c => ({
        id: str(c.id, 80), type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}).slice(0, 2000) },
      })) : [];
      msgs.push(calls.length
        ? { role: 'assistant', content: str(m.content, 4000) || '', tool_calls: calls }
        : { role: 'assistant', content: str(m.content, 4000) });
    } else if (m?.role === 'tool') {
      msgs.push({ role: 'tool', tool_call_id: str(m.tool_call_id, 80), name: str(m.name, 40), content: str(m.content, MAX_MSG_CHARS) });
    }
  }
  // History must start with a user turn (a trimmed window can cut mid-exchange).
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  const total = msgs.reduce((n, m) => n + (m.content?.length || 0), 0);
  if (!msgs.length || total > MAX_TOTAL_CHARS) return null;
  return msgs;
}

// → {allow, onTopic}. Throws MaddenGuardrailError when the gateway's guardrails
// block the call — that is a block, not an outage, so it must not fail open.
async function gate(env, msgs, metadata) {
  // The question plus the previous user turn, so "what about RBs?" has context.
  const users = msgs.filter(m => m.role === 'user').slice(-2).map(m => m.content);
  const state = users.length > 1 ? { previous_message: users[0], new_message: users[1] } : { new_message: users[0] };
  let out;
  try {
    out = await env.AI.run(MADDEN_GATE_MODEL, { model: GATE_SELECTOR, state, questions: MADDEN_GATE_QUESTIONS },
      { gateway: { id: MADDEN_GATEWAY, skipCache: true, metadata: { ...metadata, step: 'gate' } } });
  } catch (e) {
    const where = maddenGuardrailBlock(e);
    if (where) throw new MaddenGuardrailError(where, 'gate');
    // A Clef outage shouldn't take the chat down; the system prompt still keeps replies on topic.
    console.error('[madden gate] failed open:', e?.message || e);
    return { allow: true, onTopic: null };
  }
  return maddenGateDecision(out);
}

export async function handleMadden(request, env) {
  const cors = getCors(request);
  const res  = (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { ...cors, 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' },
  });
  if (request.method !== 'POST') return res({ error: 'Method not allowed' }, 405);
  const user = await getAuthUser(request, env);
  if (!user) return res({ error: 'Sign in to ask Madden' }, 401);
  if (!env.AI) return res({ error: 'Workers AI is not bound on this worker' }, 500);

  let body;
  try { body = await request.json(); } catch { return res({ error: 'Invalid JSON' }, 400); }
  const msgs = maddenCleanMessages(body?.messages);
  if (!msgs) return res({ error: 'Conversation is empty or too long — start a new chat' }, 400);

  // Gateway metadata: at most 5 keys, scalars only. `conv` groups one chat's
  // calls; `step` is "gate" or the step number within the question.
  const metadata = {
    user_id: user.user_id,
    email:   str(user.email, 120),
    sleeper: str(user.sleeper_username),
    conv:    str(body.conv, 40),
  };
  const step = Number.isInteger(body.step) ? body.step : 0;

  try {
    // Gate only on a fresh question (last message is the user's), not on the
    // tool-result rounds that follow it.
    if (msgs[msgs.length - 1].role === 'user') {
      const g = await gate(env, msgs, metadata);
      if (!g.allow) {
        console.log('[madden] off topic', JSON.stringify({ conv: metadata.conv, on_topic: g.onTopic }));
        return res({ blocked: true, reason: 'off_topic', on_topic: g.onTopic, reply: MADDEN_OFF_TOPIC });
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const input = (history) => ({
      messages: [{ role: 'system', content: SYSTEM_PROMPT + `\nToday is ${today}.` + (body.context ? `\nApp context: ${str(body.context, 400)}` : '') }, ...history],
      tools: MADDEN_TOOLS,
      max_tokens: 900,
      temperature: MADDEN_TEMPERATURE,
    });
    const opts = { gateway: { id: MADDEN_GATEWAY, skipCache: true, metadata: { ...metadata, step: String(step) } } };
    // One call took 121s and came back 408 with no tokens processed. So: fail
    // fast when the model is busy (rejectIfBusy), give each attempt
    // MADDEN_STEP_TIMEOUT_MS, and retry the SAME request once. (An earlier
    // fallback resent the history as plain text, and the model copied that
    // "[called tool(...)]" text back as its answer.)
    const once = () => Promise.race([
      env.AI.run(MADDEN_MODEL, input(msgs), { ...opts, rejectIfBusy: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), MADDEN_STEP_TIMEOUT_MS)),
    ]);
    let out;
    for (let attempt = 1; ; attempt++) {
      try { out = await once(); break; }
      catch (e) {
        const where = maddenGuardrailBlock(e);
        if (where) throw new MaddenGuardrailError(where, step);
        console.error('[madden] model attempt', attempt, 'failed:', e?.message || e);
        if (attempt >= 2) throw new Error('the model is slow or busy right now — try again in a minute');
        await new Promise(r => setTimeout(r, 1500));
      }
    }
    const { text, calls } = maddenParseOutput(out);
    if (calls.length) return res({ tool_calls: calls.slice(0, 4), content: text });
    return res({ reply: text || "Sorry — I couldn't come up with an answer to that." });
  } catch (e) {
    if (e instanceof MaddenGuardrailError) {
      // The gateway log has the category (guardrails.prompt / .response, e.g. P1);
      // the binding's error doesn't carry it, so point at the log instead.
      console.log('[madden] guardrail', JSON.stringify({ conv: metadata.conv, where: e.where, step: e.step, log_id: env.AI.aiGatewayLogId || null }));
      return res({ blocked: true, reason: 'guardrail', where: e.where, step: String(e.step), reply: MADDEN_GUARDRAIL });
    }
    return res({ error: 'Madden is unavailable: ' + (e?.message || e) }, 502);
  }
}
