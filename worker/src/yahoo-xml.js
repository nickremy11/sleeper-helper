// ── A small XML reader for Yahoo's Fantasy API ────────────────────────────────
// Yahoo answers in XML (its JSON is a different, much stranger shape, and the
// documented samples are all XML). Workers have no DOMParser, and these
// documents are simple: elements and text, a few attributes nobody needs, no
// mixed content. So: elements become objects, a text-only element becomes its
// string, an empty element becomes '', and a name that repeats under one
// parent becomes an array. A name that appears ONCE is an object, not an array
// — read lists through `arr()` (as for MFL), never assume.

const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
               : (ENT[e] ?? m));

export function parseXml(xml) {
  const src = String(xml || '');
  const root = { name: '#root', kids: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/\s*([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) top.text += m[1];
    else if (m[2]) {                       // close tag
      if (stack.length > 1) stack.pop();
    } else if (m[3]) {                     // open tag
      const node = { name: m[3].replace(/^.*:/, ''), kids: [], text: '' };
      top.kids.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] != null) top.text += decode(m[6]);
  }
  return toObj(root);
}

function toObj(node) {
  if (!node.kids.length) return node.text.trim();
  const out = {};
  for (const k of node.kids) {
    const v = toObj(k);
    if (k.name in out) {
      if (!Array.isArray(out[k.name]) || !out[`__list_${k.name}`]) { out[k.name] = [out[k.name]]; out[`__list_${k.name}`] = true; }
      out[k.name].push(v);
    } else out[k.name] = v;
  }
  for (const k of Object.keys(out)) if (k.startsWith('__list_')) delete out[k];
  return out;
}

export const arr = x => (x == null || x === '' ? [] : Array.isArray(x) ? x : [x]);
export const num = x => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
