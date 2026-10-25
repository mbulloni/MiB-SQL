// Database search helpers: filtering of server hits (case, whole word), the matching line of a definition with
// its number, and the SELECT that reopens the rows found in a table. Pure functions, tests/search.test.mjs.

export interface ObjectHit { kind: 'table' | 'view' | 'column' | 'index' | 'procedure' | 'function' | 'trigger' | 'event' | 'routine'; where: 'name' | 'code' | 'comment'; db: string; name: string; table?: string; text?: string | null }
export interface DataHit { db: string; table: string; key?: string[]; columns: string[]; rows: (string | number | null)[][]; more: boolean; searched?: string[]; error?: string; skipped?: boolean; estimated?: number }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const matcher = (text: string, caseSensitive: boolean, wholeWord: boolean) =>
  new RegExp(wholeWord ? `(?<![\\w$])${esc(text)}(?![\\w$])` : esc(text), caseSensitive ? 'g' : 'gi');

/** Server hits (LIKE, case insensitive by collation) narrowed to the exact options. */
export function filterHits(hits: ObjectHit[], text: string, caseSensitive: boolean, wholeWord: boolean) {
  const re = matcher(text, caseSensitive, wholeWord);
  return hits.filter((h) => {
    re.lastIndex = 0;
    const subject = h.where === 'name' ? h.name : h.text ?? '';
    return re.test(subject);
  });
}

/** First matching line of a text: 1-based line number and the line (cut around the match when long). */
export function matchLine(text: string, re: RegExp) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    re.lastIndex = 0;
    const m = re.exec(lines[i]);
    if (!m) continue;
    const line = lines[i].trim();
    if (line.length <= 160) return { line: i + 1, text: line };
    const at = line.search(re.source && new RegExp(re.source, re.flags.replace('g', '')));
    const from = Math.max(0, at - 60);
    return { line: i + 1, text: `${from ? '…' : ''}${line.slice(from, from + 160)}${from + 160 < line.length ? '…' : ''}` };
  }
  return null;
}

/** Text split around the matches, for highlighting. */
export function splitMatches(text: string, re: RegExp): { s: string; hit: boolean }[] {
  const out: { s: string; hit: boolean }[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[0].length) { re.lastIndex++; continue; }
    if (m.index > last) out.push({ s: text.slice(last, m.index), hit: false });
    out.push({ s: m[0], hit: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ s: text.slice(last), hit: false });
  return out;
}

const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';
const lit = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

/** SELECT returning the rows of a table where the searched columns contain the text. */
export function dataQuery(db: string, table: string, columns: string[], text: string, opts: { exact?: boolean; caseSensitive?: boolean; numeric?: string[] } = {}) {
  const like = lit(`%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const conds = columns.map((c) => {
    if (opts.numeric?.includes(c)) return `${qi(c)} = ${lit(text)}`;
    const col = opts.caseSensitive ? `CAST(${qi(c)} AS BINARY)` : qi(c);
    return opts.exact ? `${col} = ${lit(text)}` : `${col} LIKE ${like}`;
  });
  return `SELECT *\nFROM ${qi(db)}.${qi(table)}\nWHERE ${conds.join('\n   OR ')};\n`;
}
