// T-SQL scripts (Microsoft Fabric, SQL Server): batches separated by GO lines, statements by ';'. Strings are
// '…' with '' escapes (no backslash escapes), identifiers "…" or […]]], comments -- and nested /* */.
// Variables live for one batch, so a batch is what runs on the server; ';' only picks the statement under the cursor.

/** Ranges [start, end) of code outside strings, identifiers and comments, with the offset of each ';'. */
function scan(text) {
  const semis = [];
  const gos = []; // { start, end } of each GO line (whole line)
  let i = 0;
  let lineStart = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '\n') { i++; lineStart = i; continue; }
    if (c === '-' && d === '-') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; } else if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      i++;
      while (i < n) {
        if (text[i] === close) {
          if (text[i + 1] === close) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === ';') { semis.push(i); i++; continue; }
    // GO alone on its line (optionally with a count and a trailing comment), the batch separator of sqlcmd/SSMS
    if ((c === 'G' || c === 'g') && (d === 'O' || d === 'o') && /^\s*$/.test(text.slice(lineStart, i))) {
      const m = /^go(?:[ \t]+(\d+))?[ \t]*(?:--[^\n]*)?(?=\r?\n|$)/i.exec(text.slice(i));
      if (m) {
        let end = i + m[0].length;
        gos.push({ start: lineStart, end, count: m[1] ? Number(m[1]) : 1 });
        i = end;
        continue;
      }
    }
    i++;
  }
  return { semis, gos };
}

const trimmed = (text, start, end) => {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return { start, end };
};

/** Code only (comments removed) is blank. */
function isBlank(sql) {
  return /^\s*$/.test(sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''));
}

/** Batches of a script: { sql, start, end, count } with offsets on the original text; empty ones dropped. */
function batches(text) {
  const { gos } = scan(text);
  const out = [];
  let from = 0;
  const push = (to, count) => {
    const r = trimmed(text, from, to);
    const sql = text.slice(r.start, r.end);
    if (sql && !isBlank(sql)) out.push({ sql, start: r.start, end: r.end, count });
  };
  for (const g of gos) { push(g.start, g.count); from = g.end; }
  push(text.length, 1);
  return out;
}

/** Statement under the cursor: between the ';' around it, inside its batch (the whole batch without ';'). */
function statementAt(text, cursor) {
  const all = batches(text);
  const b = all.find((x) => cursor >= x.start && cursor <= x.end + 1) ?? all.filter((x) => x.end < cursor).pop() ?? all[0];
  if (!b) return null;
  const { semis } = scan(b.sql);
  let from = 0;
  for (const s of semis) {
    if (b.start + s + 1 <= cursor) from = s + 1;
  }
  const next = semis.find((s) => s >= from && s + 1 > from);
  let to = next !== undefined ? next : b.sql.length;
  // cursor right after the last ';' of the batch: the statement before it
  if (isBlank(b.sql.slice(from, to)) && from > 0) {
    const prev = semis.filter((s) => s < from - 1).pop();
    to = from - 1;
    from = prev !== undefined ? prev + 1 : 0;
  }
  const r = trimmed(b.sql, from, to);
  const sql = b.sql.slice(r.start, r.end);
  if (!sql || isBlank(sql)) return null;
  return { sql, start: b.start + r.start, end: b.start + r.end, count: 1 };
}

const WRITE = /^(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|deny|copy|exec|execute|into|bulk|backup|restore|dbcc|kill|shutdown|reconfigure|sp_rename)$/i;

/** First keyword that can change data or objects, outside strings and comments (read-only connections). */
function firstWrite(text) {
  const code = [];
  let last = 0;
  // blank out strings, quoted identifiers and comments, keeping offsets
  const re = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'?|"(?:[^"]|"")*"?|\[(?:[^\]]|\]\])*\]?/g;
  for (const m of text.matchAll(re)) { code.push(text.slice(last, m.index)); code.push(' '.repeat(m[0].length)); last = m.index + m[0].length; }
  code.push(text.slice(last));
  const plain = code.join('');
  for (const m of plain.matchAll(/[A-Za-z_][\w$#@]*/g)) {
    // variables (@x), temp tables (#t) and qualified names (x.update) are not keywords
    const before = plain[m.index - 1];
    if (before === '.' || before === '@' || before === '#') continue;
    if (WRITE.test(m[0])) return { word: m[0].toUpperCase(), at: m.index };
  }
  return null;
}

module.exports = { scan, batches, statementAt, firstWrite, isBlank };
