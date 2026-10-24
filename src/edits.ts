// Pending grid edits and the SQL that applies them. Pure functions (no React, no IPC) so they run in tests.
import type { ApplyStmt, Cell, Column, IndexInfo } from './types';

/** Row positions: 0..n-1 are the result's rows, n+k is the k-th inserted row. */
export interface Edits {
  updates: Record<number, Record<number, Cell>>;
  deleted: number[];
  inserted: Record<number, Cell>[]; // only the columns the user set; the others get their DEFAULT
}

export interface EditTarget {
  db: string;
  table: string;
  key: number[]; // result columns of the primary (or NOT NULL unique) key
}

export const emptyEdits = (): Edits => ({ updates: {}, deleted: [], inserted: [] });

export const editCount = (e: Edits) =>
  Object.keys(e.updates).filter((r) => !e.deleted.includes(Number(r))).length + e.deleted.length + e.inserted.length;

const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';

/** Base table of a result when every column comes from it, otherwise why it cannot be edited. */
export function baseTable(columns: Column[]): { db: string; table: string } | string {
  if (!columns.length) return 'Nessuna colonna.';
  const { db, orgTable } = columns[0];
  if (!orgTable || !db) return 'Sola lettura: il risultato non proviene da una tabella.';
  if (columns.some((c) => c.orgTable !== orgTable || c.db !== db || !c.orgName)) return 'Sola lettura: colonne da più tabelle o espressioni.';
  const names = columns.map((c) => c.orgName.toLowerCase());
  if (new Set(names).size !== names.length) return 'Sola lettura: colonne ripetute.';
  return { db, table: orgTable };
}

/** Primary key, else the first unique index on NOT NULL columns, all present in the result. */
export function editTarget(columns: Column[], indexes: IndexInfo[] | undefined): EditTarget | string {
  const base = baseTable(columns);
  if (typeof base === 'string') return base;
  if (!indexes) return 'Lettura della chiave primaria…';
  const at = (name: string) => columns.findIndex((c) => c.orgName.toLowerCase() === name.toLowerCase());
  const candidates = [...indexes.filter((i) => i.primary), ...indexes.filter((i) => i.unique && !i.primary)];
  for (const ix of candidates) {
    const key = ix.columns.map(at);
    if (key.every((k) => k >= 0) && (ix.primary || key.every((k) => columns[k].notNull))) return { ...base, key };
  }
  const pk = indexes.find((i) => i.primary);
  return pk ? `Sola lettura: aggiungere al risultato la chiave primaria (${pk.columns.join(', ')}).` : 'Sola lettura: la tabella non ha una chiave primaria.';
}

/** Value shown at a row/column with pending edits applied; undefined = DEFAULT of a new row. */
export function valueAt(rows: Cell[][], e: Edits, r: number, c: number): Cell | undefined {
  if (r < rows.length) {
    const u = e.updates[r];
    return u && c in u ? u[c] : rows[r][c];
  }
  const ins = e.inserted[r - rows.length];
  return ins && c in ins ? ins[c] : undefined;
}

export const isEdited = (rows: Cell[][], e: Edits, r: number, c: number) => (r < rows.length ? !!e.updates[r] && c in e.updates[r] : !!e.inserted[r - rows.length] && c in e.inserted[r - rows.length]);

const same = (a: Cell, b: Cell) => a === b || (a !== null && b !== null && String(a) === String(b));

export function setCell(e: Edits, rows: Cell[][], r: number, c: number, v: Cell): Edits {
  if (r >= rows.length) {
    const inserted = e.inserted.map((x, k) => (k === r - rows.length ? { ...x, [c]: v } : x));
    return { ...e, inserted };
  }
  const row = { ...e.updates[r] };
  if (same(rows[r][c], v)) delete row[c]; else row[c] = v;
  const updates = { ...e.updates };
  if (Object.keys(row).length) updates[r] = row; else delete updates[r];
  return { ...e, updates };
}

export const addRow = (e: Edits): Edits => ({ ...e, inserted: [...e.inserted, {}] });

/** Marks result rows deleted (again: restored); new rows are dropped. */
export function toggleDelete(e: Edits, rows: Cell[][], positions: number[]): Edits {
  const own = positions.filter((r) => r < rows.length);
  const allDeleted = own.length > 0 && own.every((r) => e.deleted.includes(r));
  const deleted = allDeleted ? e.deleted.filter((r) => !own.includes(r)) : [...new Set([...e.deleted, ...own])];
  const drop = new Set(positions.filter((r) => r >= rows.length).map((r) => r - rows.length));
  return { ...e, deleted, inserted: e.inserted.filter((_, k) => !drop.has(k)) };
}

/** Parameterized statements: deletes, then updates, then inserts (frees unique values before reusing them). */
export function statements(t: EditTarget, columns: Column[], rows: Cell[][], e: Edits): ApplyStmt[] {
  const table = `${qi(t.db)}.${qi(t.table)}`;
  const col = (c: number) => qi(columns[c].orgName);
  const where = (r: number) => ({ sql: t.key.map((k) => `${col(k)} = ?`).join(' AND '), params: t.key.map((k) => rows[r][k]) });
  const out: ApplyStmt[] = [];
  for (const r of [...e.deleted].sort((a, b) => a - b)) {
    const w = where(r);
    out.push({ sql: `DELETE FROM ${table} WHERE ${w.sql} LIMIT 1`, params: w.params, expectOne: true });
  }
  for (const [rs, vals] of Object.entries(e.updates)) {
    const r = Number(rs);
    if (e.deleted.includes(r)) continue;
    const cs = Object.keys(vals).map(Number).sort((a, b) => a - b);
    const w = where(r);
    out.push({ sql: `UPDATE ${table} SET ${cs.map((c) => `${col(c)} = ?`).join(', ')} WHERE ${w.sql} LIMIT 1`, params: [...cs.map((c) => vals[c]), ...w.params], expectOne: true });
  }
  for (const ins of e.inserted) {
    const cs = Object.keys(ins).map(Number).sort((a, b) => a - b);
    out.push({ sql: `INSERT INTO ${table} (${cs.map(col).join(', ')}) VALUES (${cs.map(() => '?').join(', ')})`, params: cs.map((c) => ins[c]) });
  }
  return out;
}

/** SQL literal for previews and exports; numbers raw, strings quoted with MariaDB escapes. */
export function literal(v: Cell): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (/^0x[0-9A-F]+$/i.test(v)) return v;
  return "'" + v.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0') + "'";
}

/** Statement with its parameters inlined (placeholders inside backticks are left alone). */
export function inline(st: ApplyStmt): string {
  let out = '';
  let p = 0;
  let quoted = false;
  for (const ch of st.sql) {
    if (ch === '`') quoted = !quoted;
    out += ch === '?' && !quoted ? literal(st.params[p++] ?? null) : ch;
  }
  return out;
}

/** Key values that identify a row after the apply (insertId fills a single AUTO_INCREMENT key). */
export function keyAfter(t: EditTarget, columns: Column[], rows: Cell[][], e: Edits, r: number, insertId: string | null): Cell[] | null {
  const vals = t.key.map((k) => {
    const v = valueAt(rows, e, r, k);
    if (v !== undefined && v !== null) return v;
    return t.key.length === 1 && columns[k].autoIncrement && insertId ? insertId : null;
  });
  return vals.some((v) => v === null) ? null : vals;
}
