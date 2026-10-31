// Dependencies and safe rename (pure): finds the references to a table, view, column or routine in the code
// of views, routines, triggers and events and rewrites them, token by token with the formatter's tokenizer,
// so strings, comments and the rest of the text stay byte for byte. Only certain references are rewritten:
// qualified names (db.table, table.column, alias.column) and names in table position (FROM, JOIN, UPDATE,
// INTO…). Anything else that matches is reported as a warning with its line and left unchanged.
import { tokenize, type Tok } from './format.ts';
import { t as tr } from './i18n.ts';

export interface DepWarning { line: number; text: string }
export interface Rewrite { text: string; changes: number; warnings: DepWarning[] }
export interface TableTarget { db: string; table: string }
export interface ColumnTarget extends TableTarget { column: string }

const ident = (t: Tok | undefined): string | null =>
  !t ? null : t.k === 'word' ? t.v : t.k === 'qid' && t.v.startsWith('`') ? t.v.slice(1, -1).replace(/``/g, '`') : null;
const isOp = (t: Tok | undefined, v: string) => !!t && t.k === 'op' && t.v === v;
const isWord = (t: Tok | undefined, ...ws: string[]) => !!t && t.k === 'word' && ws.includes(t.v.toUpperCase());

// Words after which a name is a table (or view) in a FROM/JOIN list, an UPDATE, an INSERT/REPLACE INTO…
const TABLE_BEFORE = ['FROM', 'JOIN', 'STRAIGHT_JOIN', 'UPDATE', 'INTO', 'TABLE', 'REFERENCES'];
const LIST_START = new Set(['FROM', 'JOIN', 'STRAIGHT_JOIN', 'UPDATE']);
const LIST_END = new Set(['WHERE', 'ON', 'USING', 'SET', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'SELECT', 'VALUES', 'WINDOW', 'INTERSECT', 'EXCEPT', 'RETURNING']);
// Words that can follow a table name and are not its alias
const NOT_ALIAS = new Set(['AS', 'WHERE', 'ON', 'USING', 'SET', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'UNION', 'JOIN', 'INNER', 'LEFT', 'RIGHT',
  'OUTER', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'FORCE', 'USE', 'IGNORE', 'PARTITION', 'VALUES', 'VALUE', 'SELECT', 'WINDOW', 'FOR', 'LOCK',
  'INTERSECT', 'EXCEPT', 'RETURNING', 'READ', 'WRITE', 'LOW_PRIORITY', 'BEFORE', 'AFTER', 'FOLLOWS', 'PRECEDES', 'DUPLICATE']);
const RESERVED = new Set(['ADD', 'ALL', 'ALTER', 'AND', 'AS', 'ASC', 'BETWEEN', 'BY', 'CASE', 'CHECK', 'COLUMN', 'CONSTRAINT', 'CREATE', 'CROSS',
  'DATABASE', 'DEFAULT', 'DELETE', 'DESC', 'DISTINCT', 'DROP', 'ELSE', 'END', 'EXISTS', 'FOR', 'FOREIGN', 'FROM', 'GROUP', 'HAVING', 'IF', 'IN',
  'INDEX', 'INSERT', 'INTERVAL', 'INTO', 'IS', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'LIMIT', 'NOT', 'NULL', 'ON', 'OR', 'ORDER', 'PRIMARY', 'REFERENCES',
  'RIGHT', 'SELECT', 'SET', 'TABLE', 'THEN', 'TO', 'UNION', 'UNIQUE', 'UPDATE', 'USE', 'USING', 'VALUES', 'WHEN', 'WHERE', 'WITH', 'RANK', 'ROWS']);

/** `name` written like the token it replaces: quoted if that was quoted or if a bare word would not be a name. */
function nameLike(orig: Tok, name: string): string {
  if (orig.k === 'word' && /^[A-Za-z_$][\w$]*$/.test(name) && !RESERVED.has(name.toUpperCase())) return name;
  return '`' + name.replace(/`/g, '``') + '`';
}

interface Prepared { toks: Tok[]; sig: number[]; line: number[]; segs: [number, number][] }

/** Tokens, indexes of the significant ones, line of each token, statements as ranges of `sig`. */
function prepare(text: string): Prepared {
  const toks = tokenize(text);
  const sig: number[] = [];
  const line: number[] = [];
  let ln = 1;
  toks.forEach((t, i) => {
    line.push(ln);
    for (const ch of t.v) if (ch === '\n') ln++;
    if (t.k !== 'ws' && t.k !== 'line' && t.k !== 'block') sig.push(i);
  });
  const segs: [number, number][] = [];
  let from = 0;
  sig.forEach((ti, p) => {
    const t = toks[ti];
    if (t.k === 'delim' || t.k === 'cmd' || isOp(t, ';')) { if (p > from) segs.push([from, p]); from = p + 1; }
  });
  if (sig.length > from) segs.push([from, sig.length]);
  return { toks, sig, line, segs };
}

interface TableRef { p: number; db: string | null; name: string; alias: string | null }

/** Table references of a statement: names in table position, with database and alias. */
function tableRefs(P: Prepared, [a, b]: [number, number]): TableRef[] {
  const T = (p: number) => (p >= a && p < b ? P.toks[P.sig[p]] : undefined);
  const out: TableRef[] = [];
  let inList = false;
  for (let p = a; p < b; p++) {
    const t = T(p)!;
    const up = t.k === 'word' ? t.v.toUpperCase() : '';
    if (LIST_START.has(up)) { inList = true; continue; }
    if (LIST_END.has(up)) { inList = false; continue; }
    const name = ident(t);
    if (!name) continue;
    const prev = T(p - 1);
    // second part of db.table: handled with the first part
    if (isOp(prev, '.')) continue;
    const triggerOn = isWord(prev, 'ON') && isWord(T(p - 2), 'INSERT', 'UPDATE', 'DELETE');
    const position = isWord(prev, ...TABLE_BEFORE) || triggerOn || (inList && (isOp(prev, ',') || isOp(prev, '(')));
    if (!position) continue;
    let db: string | null = null;
    let tbl = name;
    let end = p;
    if (isOp(T(p + 1), '.') && ident(T(p + 2))) { db = name; tbl = ident(T(p + 2))!; end = p + 2; }
    let alias: string | null = null;
    const n1 = T(end + 1);
    if (isWord(n1, 'AS') && ident(T(end + 2))) alias = ident(T(end + 2));
    else if (n1 && ident(n1) && !(n1.k === 'word' && NOT_ALIAS.has(n1.v.toUpperCase())) && !isOp(T(end + 2), '.') && !isOp(T(end + 2), '(')) alias = ident(n1);
    out.push({ p, db, name: tbl, alias });
  }
  return out;
}

function rebuild(P: Prepared, repl: Map<number, string>): string {
  return P.toks.map((t, i) => repl.get(i) ?? t.v).join('');
}

/** References to a table or view renamed to `newName`, in the code of an object of database `objDb`. */
export function renameTableIn(text: string, objDb: string, target: TableTarget, newName: string): Rewrite {
  const P = prepare(text);
  const repl = new Map<number, string>();
  const warnings: DepWarning[] = [];
  for (const seg of P.segs) {
    const refs = tableRefs(P, seg);
    const T = (p: number) => (p >= seg[0] && p < seg[1] ? P.toks[P.sig[p]] : undefined);
    // aliases that are spelled like the table do not count as references to it
    const aliases = new Set(refs.filter((r) => !(r.name === target.table && (r.db ?? objDb) === target.db)).map((r) => r.alias).filter(Boolean));
    for (let p = seg[0]; p < seg[1]; p++) {
      const t = T(p)!;
      if (ident(t) !== target.table) continue;
      const prev = T(p - 1);
      const ti = P.sig[p];
      if (isOp(prev, '.')) {
        // db.table (also db.table.column): only when db is the target's
        if (ident(T(p - 2)) === target.db && !isOp(T(p - 3), '.')) repl.set(ti, nameLike(t, newName));
        continue;
      }
      if (objDb !== target.db) continue; // an unqualified name resolves in the object's database
      if (isWord(prev, 'AS') || aliases.has(target.table)) continue;
      const ref = refs.find((r) => r.p === p && r.db === null);
      if (ref || isOp(T(p + 1), '.')) { repl.set(ti, nameLike(t, newName)); continue; }
      warnings.push({ line: P.line[ti], text: tr('«{0}» non è in una posizione di tabella: verifica a mano', t.v) });
    }
  }
  return { text: rebuild(P, repl), changes: repl.size, warnings };
}

/**
 * References to a column renamed to `newName`. `onTarget`: the object is a trigger of the target table
 * (NEW.column and OLD.column). Unqualified names are rewritten only in statements that read no other table.
 */
export function renameColumnIn(text: string, objDb: string, target: ColumnTarget, newName: string, onTarget = false): Rewrite {
  const P = prepare(text);
  const repl = new Map<number, string>();
  const warnings: DepWarning[] = [];
  const col = target.column.toLowerCase();
  for (const seg of P.segs) {
    const refs = tableRefs(P, seg);
    const T = (p: number) => (p >= seg[0] && p < seg[1] ? P.toks[P.sig[p]] : undefined);
    const isTarget = (r: TableRef) => r.name === target.table && (r.db ?? objDb) === target.db;
    const mine = refs.filter(isTarget);
    const others = refs.filter((r) => !isTarget(r));
    const aliases = new Set<string>(mine.map((r) => (r.alias ?? r.name).toLowerCase()));
    if (objDb === target.db) aliases.add(target.table.toLowerCase());
    if (onTarget) { aliases.add('new'); aliases.add('old'); }
    for (const o of others) if (o.alias) aliases.delete(o.alias.toLowerCase());
    for (let p = seg[0]; p < seg[1]; p++) {
      const t = T(p)!;
      const id = ident(t);
      if (!id || id.toLowerCase() !== col) continue;
      const prev = T(p - 1);
      const next = T(p + 1);
      const ti = P.sig[p];
      if (isOp(prev, '.')) {
        const q = ident(T(p - 2));
        if (!q) continue;
        if (isOp(T(p - 3), '.')) {
          // db.table.column
          if (q === target.table && ident(T(p - 4)) === target.db) repl.set(ti, nameLike(t, newName));
        } else if (aliases.has(q.toLowerCase())) repl.set(ti, nameLike(t, newName));
        continue;
      }
      if (isOp(next, '.') || isOp(next, '(')) continue; // a qualifier or a function with the same name
      if (isWord(prev, 'AS')) continue; // output alias of a view or a query: its interface stays the same
      if (refs.some((r) => r.p === p)) continue; // a table with the same name
      if (!mine.length) {
        if (onTarget && !refs.length) warnings.push({ line: P.line[ti], text: tr('«{0}» senza NEW./OLD.: verifica a mano', t.v) });
        continue;
      }
      if (!others.length) { repl.set(ti, nameLike(t, newName)); continue; }
      warnings.push({ line: P.line[ti], text: tr('«{0}» senza tabella davanti in un\'istruzione con più tabelle: verifica a mano', t.v) });
    }
  }
  return { text: rebuild(P, repl), changes: repl.size, warnings };
}

/** Calls of a routine (CALL name / name(…)) in some code; used only to confirm a dependency. */
export function routineCalls(text: string, objDb: string, target: { db: string; name: string }): number {
  const P = prepare(text);
  let n = 0;
  for (let p = 0; p < P.sig.length; p++) {
    const t = P.toks[P.sig[p]];
    const id = ident(t);
    if (!id || id.toLowerCase() !== target.name.toLowerCase()) continue;
    const prev = P.toks[P.sig[p - 1]];
    const qualified = isOp(prev, '.');
    const db = qualified ? ident(P.toks[P.sig[p - 2]]) : objDb;
    if (db !== target.db) continue;
    const before = qualified ? P.toks[P.sig[p - 3]] : prev;
    if (isWord(before, 'CALL') || isOp(P.toks[P.sig[p + 1]], '(')) n++;
  }
  return n;
}

/** Tables and views an object reads or writes (in table position), among the `known` ones. */
export function tablesUsed(text: string, objDb: string, known: { db: string; name: string }[]): { db: string; name: string }[] {
  const P = prepare(text);
  const out = new Map<string, { db: string; name: string }>();
  for (const seg of P.segs) {
    for (const r of tableRefs(P, seg)) {
      const db = r.db ?? objDb;
      if (known.some((k) => k.db === db && k.name === r.name)) out.set(`${db}.${r.name}`, { db, name: r.name });
    }
  }
  return [...out.values()];
}

/** ALTER TABLE … RENAME COLUMN where the server has it (MariaDB 10.5+, MySQL 8.0+), else CHANGE COLUMN. */
export function renameColumnStatement(db: string, table: string, column: string, newName: string, version: string, definition?: string): string {
  const q = (s: string) => '`' + s.replace(/`/g, '``') + '`';
  const m = /^(\d+)\.(\d+)/.exec(version);
  const [maj, min] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  const maria = /mariadb/i.test(version);
  const modern = maria ? maj > 10 || (maj === 10 && min >= 5) : maj >= 8;
  if (modern || !definition) return `ALTER TABLE ${q(db)}.${q(table)} RENAME COLUMN ${q(column)} TO ${q(newName)}`;
  return `ALTER TABLE ${q(db)}.${q(table)} CHANGE COLUMN ${q(column)} ${q(newName)} ${definition}`;
}
