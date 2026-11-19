// Minimal XML reading for the XMLA (SOAP) responses of Analysis Services.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e] ?? m));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const local = (name) => name.slice(name.indexOf(':') + 1);

/** Minimal XML parser: elements { name (no prefix), attrs (as written), children, text }. */
function parseXml(s) {
  const root = { name: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    const top = stack[stack.length - 1];
    if (lt < 0) { top.text += decode(s.slice(i)); break; }
    if (lt > i) top.text += decode(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) { i = s.indexOf('-->', lt) + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) { const e = s.indexOf(']]>', lt); top.text += s.slice(lt + 9, e); i = e + 3; continue; }
    if (s[lt + 1] === '?' || s[lt + 1] === '!') { i = s.indexOf('>', lt) + 1; continue; }
    // tag end, skipping '>' inside quoted attribute values
    let j = lt + 1;
    let q = null;
    for (; j < s.length; j++) {
      const ch = s[j];
      if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break;
    }
    const body = s.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const self = body.endsWith('/');
    const m = /^([^\s/>]+)/.exec(body);
    const el = { name: local(m[1]), attrs: {}, children: [], text: '' };
    for (const a of body.slice(m[1].length).matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) el.attrs[a[1]] = decode(a[2] ?? a[3]);
    top.children.push(el);
    if (!self) stack.push(el);
  }
  return root;
}

function find(el, name) {
  if (el.name === name) return el;
  for (const c of el.children) { const r = find(c, name); if (r) return r; }
  return null;
}
const findAll = (el, name, out = []) => { if (el.name === name) out.push(el); for (const c of el.children) findAll(c, name, out); return out; };
const attr = (el, name) => { for (const [k, v] of Object.entries(el.attrs)) if (local(k) === name) return v; return undefined; };

module.exports = { parseXml, find, findAll, attr, local, esc, decode };
