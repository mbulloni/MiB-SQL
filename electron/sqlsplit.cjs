// Splits a SQL script into statements the way the mysql/mariadb client does: honours quotes, backticks,
// comments and the client-side DELIMITER command. Offsets refer to the original text so the editor can
// map results and errors back to the statement that produced them.

/** True when the statement has no executable text (only whitespace and comments). */
function isBlank(sql) {
  const stripped = sql
    .replace(/\/\*(?!!)[\s\S]*?\*\//g, '')
    .replace(/(^|\s)--(\s[^\n]*)?$/gm, '$1')
    .replace(/--(\s[^\n]*)?$/gm, '')
    .replace(/#[^\n]*/g, '');
  return stripped.trim() === '';
}

/**
 * @param {string} text
 * @returns {{ sql: string, start: number, end: number }[]} start/end: offsets of the trimmed statement
 */
function split(text) {
  const out = [];
  let delim = ';';
  let stmtStart = 0;
  let i = 0;
  const n = text.length;

  const push = (from, to) => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    const sql = text.slice(a, b);
    if (!isBlank(sql)) out.push({ sql, start: a, end: b });
  };

  // DELIMITER is only recognised as the first word of a statement, like the CLI client.
  const atStatementStart = (pos) => text.slice(stmtStart, pos).trim() === '' || isBlank(text.slice(stmtStart, pos));

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < n) {
        if (text[i] === '\\' && ch !== '`') { i += 2; continue; }
        if (text[i] === ch) {
          if (text[i + 1] === ch) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '#' || (ch === '-' && next === '-' && (i + 2 >= n || /\s/.test(text[i + 2])))) {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if ((ch === 'd' || ch === 'D') && atStatementStart(i)) {
      const m = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(text.slice(i, text.indexOf('\n', i) < 0 ? n : text.indexOf('\n', i)));
      if (m) {
        delim = m[1];
        i += m[0].length;
        stmtStart = i;
        continue;
      }
    }
    if (text.startsWith(delim, i)) {
      push(stmtStart, i);
      i += delim.length;
      stmtStart = i;
      continue;
    }
    i++;
  }
  push(stmtStart, n);
  return out;
}

/** Statement containing the cursor offset, or the closest one before it (cursor on an empty line after `;`). */
function statementAt(text, offset) {
  const all = split(text);
  if (!all.length) return null;
  let best = all[0];
  for (const s of all) {
    if (s.start <= offset) best = s;
    if (offset >= s.start && offset <= s.end) return s;
  }
  return best;
}

module.exports = { split, statementAt, isBlank };
