// Index advisor for one database: duplicate and redundant indexes, indexes never used since the server started,
// tables without a primary key (with the statement to add one), low-selectivity indexes and tables read
// mostly without an index. Pure functions, tested in tests/indexes.test.mjs.
import { t } from './i18n.ts';

export interface IndexCol { name: string | null; expr: string | null; subPart: number | null; nullable: boolean }
export interface Index { table: string; name: string; unique: boolean; primary: boolean; type: string; cardinality: number | null; columns: IndexCol[]; visible: boolean }
export interface IndexData {
  db: string;
  indexes: Index[];
  tables: { name: string; engine: string | null; rows: number | null; data: number | null; idx: number | null }[];
  columns: { table: string; name: string; type: string; nullable: boolean }[];
  fks: { table: string; name: string; columns: string[] }[];
  usage: { table: string; index: string | null; count: number; reads: number }[] | null;
  usageSource: 'ps' | 'userstat' | null;
  uptime: number | null;
  flavor: 'mariadb' | 'mysql';
  userstatAvailable: boolean;
  ps: boolean;
}

export interface Redundant { table: string; index: string; by: string; duplicate: boolean; sql: string; columns: string }
export interface Unused { table: string; index: string; columns: string; unique: boolean; fk: string | null; sql: string | null }
export interface NoPk { table: string; rows: number | null; candidate: string | null; sql: string }
export interface LowSelectivity { table: string; index: string; columns: string; cardinality: number; rows: number }
export interface Scan { table: string; rows: number; viaIndex: number; share: number }

const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';
const colKey = (c: IndexCol) => `${c.name ?? `(${c.expr ?? ''})`}${c.subPart ? `(${c.subPart})` : ''}`;
export const colsText = (ix: Index) => ix.columns.map(colKey).join(', ');
const sameType = (a: Index, b: Index) => a.type === b.type || ([a.type, b.type].every((x) => x === 'BTREE' || x === 'HASH'));
const strong = (ix: Index) => ix.primary || ix.unique;

/** a's columns are a leading prefix of b's (a prefix length is covered by a longer or full column). */
function isPrefix(a: Index, b: Index) {
  if (a.columns.length > b.columns.length) return false;
  return a.columns.every((c, i) => {
    const d = b.columns[i];
    if (c.name !== d.name || c.expr !== d.expr) return false;
    if (i < a.columns.length - 1) return c.subPart === d.subPart;
    return d.subPart === null || (c.subPart !== null && c.subPart <= d.subPart);
  });
}

export const dropSql = (table: string, index: string) => `ALTER TABLE ${qi(table)} DROP INDEX ${qi(index)};`;

/**
 * Indexes made useless by another one: exact duplicates, and non-unique indexes whose columns start
 * another index (which serves the same lookups). A unique index is kept unless the other enforces the same
 * uniqueness; the primary key is never dropped.
 */
export function redundantIndexes(indexes: Index[]): Redundant[] {
  const out: Redundant[] = [];
  const byTable = new Map<string, Index[]>();
  for (const ix of indexes) byTable.set(ix.table, [...(byTable.get(ix.table) ?? []), ix]);
  for (const [table, list] of byTable) {
    const dropped = new Set<string>();
    for (const a of list) {
      if (a.primary || dropped.has(a.name)) continue;
      for (const b of list) {
        if (a === b || dropped.has(b.name) || !sameType(a, b)) continue;
        const dup = a.columns.length === b.columns.length && isPrefix(a, b) && isPrefix(b, a);
        if (dup) {
          // keep the stronger one; between equals keep the first by name
          if (strong(a) && !strong(b)) continue;
          if (strong(a) === strong(b) && !b.primary && a.name.localeCompare(b.name) < 0) continue;
        } else {
          if (a.type === 'FULLTEXT' || a.type === 'SPATIAL') continue;
          if (a.unique || !isPrefix(a, b)) continue;
        }
        out.push({ table, index: a.name, by: b.name, duplicate: dup, sql: dropSql(table, a.name), columns: colsText(a) });
        dropped.add(a.name);
        break;
      }
    }
  }
  return out;
}

/** Index of the table able to serve a foreign key: one starting with the FK columns. */
function fkUsing(ix: Index, d: IndexData) {
  for (const fk of d.fks) {
    if (fk.table !== ix.table) continue;
    if (!fk.columns.every((c, i) => ix.columns[i]?.name === c)) continue;
    // another index covering the FK columns would take over: then this one is not needed for it
    const others = d.indexes.filter((o) => o !== ix && o.table === ix.table && fk.columns.every((c, i) => o.columns[i]?.name === c));
    if (!others.length) return fk.name;
  }
  return null;
}

/** Indexes with no reads since the server started (needs usage statistics). Unique ones are listed but not dropped. */
export function unusedIndexes(d: IndexData): Unused[] {
  if (!d.usage) return [];
  const used = new Set(d.usage.filter((u) => u.index && u.count > 0).map((u) => `${u.table}\u0000${u.index}`));
  // performance_schema has a row per index (count 0 when unused); userstat lists only the used ones
  return d.indexes
    .filter((ix) => !ix.primary && !used.has(`${ix.table}\u0000${ix.name}`))
    .map((ix) => {
      const fk = fkUsing(ix, d);
      return { table: ix.table, index: ix.name, columns: colsText(ix), unique: ix.unique, fk, sql: ix.unique || fk ? null : dropSql(ix.table, ix.name) };
    });
}

/** Tables without a primary key: promote a unique index on NOT NULL columns, or add an AUTO_INCREMENT id. */
export function tablesWithoutPk(d: IndexData): NoPk[] {
  const withPk = new Set(d.indexes.filter((ix) => ix.primary).map((ix) => ix.table));
  return d.tables.filter((tb) => !withPk.has(tb.name)).map((tb) => {
    const cand = d.indexes.find((ix) => ix.table === tb.name && ix.unique && ix.columns.every((c) => c.name && !c.nullable && !c.subPart));
    if (cand) {
      const cols = cand.columns.map((c) => qi(c.name!)).join(', ');
      return { table: tb.name, rows: tb.rows, candidate: cand.name, sql: `ALTER TABLE ${qi(tb.name)} DROP INDEX ${qi(cand.name)}, ADD PRIMARY KEY (${cols});` };
    }
    const names = new Set(d.columns.filter((c) => c.table === tb.name).map((c) => c.name.toLowerCase()));
    let col = 'id';
    for (let n = 2; names.has(col); n++) col = `id${n}`;
    return { table: tb.name, rows: tb.rows, candidate: null, sql: `ALTER TABLE ${qi(tb.name)} ADD COLUMN ${qi(col)} BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;` };
  });
}

/** Non-unique indexes whose leading column has very few distinct values on a big table (e.g. a flag). */
export function lowSelectivity(d: IndexData, minRows = 10000): LowSelectivity[] {
  const rows = new Map(d.tables.map((tb) => [tb.name, tb.rows ?? 0]));
  return d.indexes
    .filter((ix) => !ix.unique && ix.columns.length === 1 && ix.cardinality !== null && (rows.get(ix.table) ?? 0) >= minRows
      && ix.cardinality / (rows.get(ix.table) ?? 1) < 0.001 && ix.type === 'BTREE')
    .map((ix) => ({ table: ix.table, index: ix.name, columns: colsText(ix), cardinality: ix.cardinality!, rows: rows.get(ix.table)! }));
}

/** Tables whose rows were mostly read without an index (full scans), heaviest first. */
export function scannedTables(d: IndexData, minRows = 1000): Scan[] {
  if (!d.usage) return [];
  const m = new Map<string, { scan: number; idx: number }>();
  for (const u of d.usage) {
    const x = m.get(u.table) ?? { scan: 0, idx: 0 };
    if (u.index === null) x.scan += u.reads; else x.idx += u.reads;
    m.set(u.table, x);
  }
  return [...m].filter(([, x]) => x.scan >= minRows).map(([table, x]) => ({ table, rows: x.scan, viaIndex: x.idx, share: x.scan / Math.max(1, x.scan + x.idx) }))
    .sort((a, b) => b.rows - a.rows);
}

/** What is missing to see index usage, as a sentence. */
export function usageHint(d: IndexData) {
  if (d.usage) return d.usageSource === 'ps' ? t('Statistiche d\'uso da performance_schema dall\'avvio del server.') : t('Statistiche d\'uso da userstat (MariaDB) dall\'attivazione.');
  if (d.flavor === 'mariadb' && d.userstatAvailable) return t('Per sapere quali indici non vengono usati attiva userstat (SET GLOBAL userstat = ON, senza riavvio) e lascia lavorare il server per un ciclo di carico tipico, oppure performance_schema = ON (richiede il riavvio).');
  return t('Per sapere quali indici non vengono usati serve performance_schema = ON (richiede il riavvio del server).');
}
