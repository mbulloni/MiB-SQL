// Splits a SQL script into statements the way the mysql/mariadb client does: honours quotes, backticks,
// comments and the client-side DELIMITER command. Offsets refer to the original text so the editor can
// map results and errors back to the statement that produced them. `Splitter` does the same on a stream
// (restore of large dumps): incomplete statements at the end of a chunk wait for the next one.

/**
 * True when the statement has no executable text (only whitespace and comments). A scanner, not regexes:
 * a `--` comment ends at its line, and executable comments (slash-star-bang) count as text.
 */
function isBlank(sql) {
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '#' || (ch === '-' && sql[i + 1] === '-' && (i + 2 >= n || /\s/.test(sql[i + 2])))) {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*' && sql[i + 2] !== '!') {
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Scans `text` for complete statements. With final = false the text may end mid-statement: what follows the
 * last delimiter is left as `rest` (offset) to be scanned again with more text.
 * @returns {{ stmts: { sql: string, start: number, end: number }[], rest: number, delim: string }}
 */
function scan(text, delim = ';', final = true) {
  const out = [];
  let stmtStart = 0;
  let blank = true; // only whitespace/comments since stmtStart: DELIMITER is recognised only there
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

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "'" || ch === '"' || ch === '`') {
      blank = false;
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
      if (text[i + 2] === '!') blank = false; // /*!…*/ is executable
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (blank && (ch === 'd' || ch === 'D')) {
      const eol = text.indexOf('\n', i);
      if (eol < 0 && !final && /^delimiter/i.test(text.slice(i, i + 9).padEnd(9, 'd'))) break; // wait for the whole line
      const m = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(text.slice(i, eol < 0 ? n : eol));
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
      blank = true;
      continue;
    }
    if (!/\s/.test(ch)) blank = false;
    i++;
  }
  if (final) { push(stmtStart, n); stmtStart = n; }
  return { stmts: out, rest: stmtStart, delim };
}

/**
 * @param {string} text
 * @returns {{ sql: string, start: number, end: number }[]} start/end: offsets of the trimmed statement
 */
function split(text) {
  return scan(text, ';', true).stmts;
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

/** Incremental splitter: push(chunk) returns the statements completed so far, end() the last ones. */
class Splitter {
  constructor() {
    this.buf = '';
    this.delim = ';';
  }

  push(chunk) {
    this.buf += chunk;
    // a statement can only end where the delimiter's last character appears: otherwise skip the rescan
    if (!chunk.includes(this.delim[this.delim.length - 1])) return [];
    const r = scan(this.buf, this.delim, false);
    this.buf = this.buf.slice(r.rest);
    this.delim = r.delim;
    return r.stmts.map((s) => s.sql);
  }

  end() {
    const r = scan(this.buf, this.delim, true);
    this.buf = '';
    return r.stmts.map((s) => s.sql);
  }
}

module.exports = { split, statementAt, isBlank, scan, Splitter };
