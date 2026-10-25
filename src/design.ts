import { t as tr } from './i18n.ts';
// Table designer model and DDL generation. Pure functions (no React, no IPC) so they run in tests.
// Indexes and foreign keys refer to columns by id: renaming a column does not count as an index change,
// and ALTER TABLE renames it inside indexes and foreign keys by itself.

export type IndexKind = 'PRIMARY' | 'UNIQUE' | 'INDEX' | 'FULLTEXT' | 'SPATIAL';
export const FK_RULES = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT'] as const;

export interface DColumn {
  id: string;
  orig: string | null; // name on the server; null = new column
  name: string;
  type: string;
  nullable: boolean;
  default: string | null; // SQL expression ('text', 0, current_timestamp()); null = no DEFAULT clause
  autoIncrement: boolean;
  onUpdate: string;
  collation: string; // '' = the table's
  comment: string;
  generated: { expr: string; stored: boolean } | null;
  check: string | null; // column-level CHECK (MariaDB JSON columns: json_valid)
}

export interface DCheck { id: string; orig: string | null; name: string; expr: string }

export type PartitionMethod = 'RANGE' | 'RANGE COLUMNS' | 'LIST' | 'LIST COLUMNS' | 'HASH' | 'LINEAR HASH' | 'KEY' | 'LINEAR KEY';
export const PARTITION_METHODS: PartitionMethod[] = ['RANGE', 'RANGE COLUMNS', 'LIST', 'LIST COLUMNS', 'HASH', 'LINEAR HASH', 'KEY', 'LINEAR KEY'];
export interface DPartition { id: string; orig: string | null; name: string; values: string; comment: string; rows?: number | null }
export interface Partitioning {
  method: PartitionMethod;
  expr: string;          // expression (RANGE/LIST/HASH) or column list (COLUMNS, KEY; empty KEY = primary key)
  count: number;         // HASH / KEY
  partitions: DPartition[]; // RANGE / LIST
  subpartitioned?: boolean; // shown, never altered
}
export const byList = (m: PartitionMethod) => m.startsWith('RANGE') || m.startsWith('LIST');

export interface DIndex {
  id: string;
  orig: string | null;
  name: string;
  kind: IndexKind;
  columns: { col: string; len: number | null; desc?: boolean }[];
  comment: string;
}

export interface DForeignKey {
  id: string;
  orig: string | null;
  name: string;
  columns: string[]; // column ids
  refDb: string;
  refTable: string;
  refColumns: string[]; // names in the referenced table
  onDelete: string;
  onUpdate: string;
}

export interface TableDef {
  db: string;
  name: string;
  engine: string;
  collation: string;
  comment: string;
  columns: DColumn[];
  indexes: DIndex[];
  foreignKeys: DForeignKey[];
  checks: DCheck[];
  partitioning: Partitioning | null;
  convert?: boolean; // CONVERT TO the table collation (existing text columns too)
}

/** Shape returned by the main process (explorer.tableDefinition). */
export interface ServerTable {
  name: string;
  engine: string;
  collation: string;
  comment: string;
  columns: (Omit<DColumn, 'id' | 'orig' | 'check'> & { check?: string | null })[];
  indexes: { name: string; kind: IndexKind; columns: { name: string; len: number | null; desc?: boolean }[]; comment: string }[];
  checks?: { name: string; expr: string }[];
  partitioning?: { method: string; expr: string; partitions: { name: string; values: string; comment: string; rows: number | null }[]; subpartitioned: boolean } | null;
  foreignKeys: { name: string; columns: string[]; refDb: string; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string }[];
}

let seq = 0;
export const newId = (p: string) => `${p}${++seq}_${Math.random().toString(36).slice(2, 6)}`;

export function fromServer(db: string, t: ServerTable): TableDef {
  const columns = t.columns.map((c, i) => ({ ...c, check: c.check ?? null, id: `c${i}`, orig: c.name }));
  const idOf = (name: string) => columns.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? name;
  return {
    db,
    name: t.name,
    engine: t.engine,
    collation: t.collation,
    comment: t.comment,
    columns,
    indexes: t.indexes.map((ix, i) => ({ id: `i${i}`, orig: ix.name, name: ix.name, kind: ix.kind, comment: ix.comment, columns: ix.columns.map((c) => ({ col: idOf(c.name), len: c.len, ...(c.desc ? { desc: true } : {}) })) })),
    foreignKeys: t.foreignKeys.map((fk, i) => ({ ...fk, id: `f${i}`, orig: fk.name, columns: fk.columns.map(idOf) })),
    checks: (t.checks ?? []).map((k, i) => ({ id: `k${i}`, orig: k.name, name: k.name, expr: k.expr })),
    partitioning: t.partitioning ? {
      method: t.partitioning.method as PartitionMethod,
      expr: t.partitioning.expr,
      count: t.partitioning.partitions.length,
      partitions: byList(t.partitioning.method as PartitionMethod) ? t.partitioning.partitions.map((p, i) => ({ id: `p${i}`, orig: p.name, name: p.name, values: p.values, comment: p.comment, rows: p.rows })) : [],
      subpartitioned: t.partitioning.subpartitioned,
    } : null,
  };
}

export function newTable(db: string, engine: string, collation: string): TableDef {
  const id = newId('c');
  return {
    db, name: 'nuova_tabella', engine, collation, comment: '',
    columns: [{ id, orig: null, name: 'id', type: 'int(10) unsigned', nullable: false, default: null, autoIncrement: true, onUpdate: '', collation: '', comment: '', generated: null, check: null }],
    indexes: [{ id: newId('i'), orig: null, name: 'PRIMARY', kind: 'PRIMARY', columns: [{ col: id, len: null }], comment: '' }],
    foreignKeys: [],
    checks: [],
    partitioning: null,
  };
}

export const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';
const str = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
export const charsetOf = (collation: string) => collation.split('_')[0];
export const isTextType = (type: string) => /^\s*(var)?char|text|enum|set\b/i.test(type);

/** Type as written by the user, compared case-insensitively outside quotes (ENUM values keep their case). */
const normType = (t: string) => t.trim().replace(/\s+/g, ' ').replace(/'(?:[^']|'')*'|[^']+/g, (m) => (m.startsWith("'") ? m : m.toLowerCase()));

export function columnSql(c: DColumn): string {
  let s = `${qi(c.name)} ${normType(c.type)}`;
  if (c.collation) s += ` COLLATE ${c.collation}`;
  if (c.generated) {
    s += ` GENERATED ALWAYS AS (${c.generated.expr.trim()}) ${c.generated.stored ? 'STORED' : 'VIRTUAL'}`;
  } else {
    s += c.nullable ? ' NULL' : ' NOT NULL';
    if (c.default !== null && c.default.trim() !== '') s += ` DEFAULT ${c.default.trim()}`;
    if (c.onUpdate.trim()) s += ` ON UPDATE ${c.onUpdate.trim()}`;
    if (c.autoIncrement) s += ' AUTO_INCREMENT';
  }
  if (c.comment) s += ` COMMENT ${str(c.comment)}`;
  // a CHANGE COLUMN without it would drop the column's CHECK (MariaDB JSON columns lose json_valid)
  if (c.check) s += ` CHECK (${c.check})`;
  return s;
}

export const checkSql = (k: DCheck) => `CONSTRAINT ${qi(k.name)} CHECK (${k.expr.trim()})`;

const colName = (t: TableDef, id: string) => t.columns.find((c) => c.id === id)?.name ?? id;

export function indexSql(t: TableDef, ix: DIndex): string {
  const cols = ix.columns.map((c) => qi(colName(t, c.col)) + (c.len ? `(${c.len})` : '') + (c.desc ? ' DESC' : '')).join(', ');
  const head = ix.kind === 'PRIMARY' ? 'PRIMARY KEY' : `${ix.kind === 'INDEX' ? 'KEY' : `${ix.kind} KEY`} ${qi(ix.name)}`;
  return `${head} (${cols})${ix.comment ? ` COMMENT ${str(ix.comment)}` : ''}`;
}

export function foreignKeySql(t: TableDef, fk: DForeignKey): string {
  const ref = (fk.refDb && fk.refDb !== t.db ? `${qi(fk.refDb)}.` : '') + qi(fk.refTable);
  return `CONSTRAINT ${qi(fk.name)} FOREIGN KEY (${fk.columns.map((c) => qi(colName(t, c))).join(', ')}) REFERENCES ${ref} (${fk.refColumns.map(qi).join(', ')}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
}

const tableOptions = (t: TableDef) =>
  [`ENGINE=${t.engine}`, `DEFAULT CHARSET=${charsetOf(t.collation)}`, `COLLATE=${t.collation}`, t.comment ? `COMMENT=${str(t.comment)}` : ''].filter(Boolean).join(' ');

export function partitionSql(m: PartitionMethod, p: DPartition) {
  const v = p.values.trim();
  const values = m.startsWith('RANGE')
    ? (/^maxvalue$/i.test(v) ? (m === 'RANGE' ? 'LESS THAN MAXVALUE' : 'LESS THAN (MAXVALUE)') : `LESS THAN (${v})`)
    : `IN (${v})`;
  return `PARTITION ${qi(p.name)} VALUES ${values}${p.comment ? ` COMMENT ${str(p.comment)}` : ''}`;
}

/** PARTITION BY clause (CREATE TABLE tail or ALTER TABLE … PARTITION BY). */
export function partitionBySql(p: Partitioning) {
  const head = `PARTITION BY ${p.method} (${p.expr.trim()})`;
  if (!byList(p.method)) return `${head} PARTITIONS ${p.count}`;
  return `${head} (\n  ${p.partitions.map((x) => partitionSql(p.method, x)).join(',\n  ')}\n)`;
}

export function createSql(t: TableDef): string {
  const lines = [...t.columns.map(columnSql), ...t.indexes.map((ix) => indexSql(t, ix)), ...t.foreignKeys.map((fk) => foreignKeySql(t, fk)), ...(t.checks ?? []).map(checkSql)];
  const parts = t.partitioning && !t.partitioning.subpartitioned ? `\n${partitionBySql(t.partitioning)}` : '';
  return `CREATE TABLE ${qi(t.db)}.${qi(t.name)} (\n  ${lines.join(',\n  ')}\n) ${tableOptions(t)}${parts}`;
}

const normPart = (s: string) => s.replace(/`/g, '').replace(/\s+/g, '').toLowerCase();
const partKey = (p: DPartition) => JSON.stringify([p.name, normPart(p.values), p.comment]);

/**
 * Partition changes, each its own ALTER (MariaDB allows one partition operation per statement): switch
 * on/off, full PARTITION BY when method/expression/count change, else DROP and ADD at the end, or
 * REORGANIZE of every partition for any other change (values, order, names).
 */
export function partitionStatements(table: string, a: Partitioning | null, b: Partitioning | null): string[] {
  if (a?.subpartitioned) return [];
  if (!a && !b) return [];
  if (!b) return [`ALTER TABLE ${table} REMOVE PARTITIONING`];
  if (!a || a.method !== b.method || normPart(a.expr) !== normPart(b.expr) || (!byList(b.method) && a.count !== b.count)) {
    return [`ALTER TABLE ${table} ${partitionBySql(b)}`];
  }
  if (!byList(b.method)) return [];
  const keptA = a.partitions.filter((p) => b.partitions.some((q) => q.id === p.id));
  const dropped = a.partitions.filter((p) => !b.partitions.some((q) => q.id === p.id));
  const sameKept = keptA.every((p, i) => b.partitions[i]?.id === p.id && partKey(b.partitions[i]) === partKey(p));
  const added = b.partitions.slice(keptA.length);
  if (sameKept && added.every((p) => p.orig === null || !a.partitions.some((q) => q.id === p.id))) {
    const out: string[] = [];
    if (dropped.length) out.push(`ALTER TABLE ${table} DROP PARTITION ${dropped.map((p) => qi(p.orig ?? p.name)).join(', ')}`);
    if (added.length) out.push(`ALTER TABLE ${table} ADD PARTITION (\n  ${added.map((p) => partitionSql(b.method, p)).join(',\n  ')}\n)`);
    return out;
  }
  return [`ALTER TABLE ${table} REORGANIZE PARTITION ${a.partitions.map((p) => qi(p.orig ?? p.name)).join(', ')} INTO (\n  ${b.partitions.map((p) => partitionSql(b.method, p)).join(',\n  ')}\n)`];
}

// identity of an index / foreign key independent of column names
const indexKey = (ix: DIndex) => JSON.stringify([ix.kind === 'PRIMARY' ? 'PRIMARY' : ix.name, ix.kind, ix.columns.map((c) => [c.col, c.len, !!c.desc]), ix.comment]);
const normExpr = (s: string) => s.trim().replace(/^\((.*)\)$/s, '$1').replace(/\s+/g, ' ');
const fkKey = (fk: DForeignKey) => JSON.stringify([fk.name, fk.columns, fk.refDb, fk.refTable, fk.refColumns, fk.onDelete, fk.onUpdate]);

/** Statements turning `orig` into `cur`: drop changed foreign keys, one ALTER TABLE, rename last. */
export function alterSql(orig: TableDef, cur: TableDef): string[] {
  const table = `${qi(orig.db)}.${qi(orig.name)}`;
  const out: string[] = [];

  const curFk = new Map(cur.foreignKeys.map((f) => [f.id, f]));
  const dropFks = orig.foreignKeys.filter((f) => !curFk.has(f.id) || fkKey(curFk.get(f.id)!) !== fkKey(f));
  const curCk = new Map((cur.checks ?? []).map((k) => [k.id, k]));
  const ckChanged = (k: DCheck) => { const n = curCk.get(k.id); return !n || n.name !== k.name || normExpr(n.expr) !== normExpr(k.expr); };
  const dropChecks = (orig.checks ?? []).filter(ckChanged);
  // separate statement: MariaDB cannot drop and re-add a foreign key (or constraint) with the same name in one ALTER
  const drops = [...dropFks.map((f) => `DROP FOREIGN KEY ${qi(f.orig ?? f.name)}`), ...dropChecks.map((k) => `DROP CONSTRAINT ${qi(k.orig ?? k.name)}`)];
  if (drops.length) out.push(`ALTER TABLE ${table}\n  ${drops.join(',\n  ')}`);

  const parts: string[] = [];
  const curIx = new Map(cur.indexes.map((i) => [i.id, i]));
  const origIx = new Map(orig.indexes.map((i) => [i.id, i]));
  for (const ix of orig.indexes) {
    const now = curIx.get(ix.id);
    if (!now || indexKey(now) !== indexKey(ix)) parts.push(ix.kind === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${qi(ix.orig ?? ix.name)}`);
  }

  const curIds = new Set(cur.columns.map((c) => c.id));
  for (const c of orig.columns) if (!curIds.has(c.id)) parts.push(`DROP COLUMN ${qi(c.orig ?? c.name)}`);

  // replay positions in order, as the server applies the clauses
  const origById = new Map(orig.columns.map((c) => [c.id, c]));
  const order = orig.columns.filter((c) => curIds.has(c.id)).map((c) => c.id);
  cur.columns.forEach((c, i) => {
    const prev = i ? cur.columns[i - 1].id : null;
    const at = order.indexOf(c.id);
    const before = at > 0 ? order[at - 1] : null;
    const pos = prev ? ` AFTER ${qi(cur.columns[i - 1].name)}` : ' FIRST';
    if (at < 0) {
      order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, c.id);
      parts.push(`ADD COLUMN ${columnSql(c)}${pos}`);
      return;
    }
    const moved = before !== prev;
    if (moved) {
      order.splice(at, 1);
      order.splice(prev ? order.indexOf(prev) + 1 : 0, 0, c.id);
    }
    const o = origById.get(c.id)!;
    if (moved || columnSql(o) !== columnSql(c)) parts.push(`CHANGE COLUMN ${qi(o.name)} ${columnSql(c)}${moved ? pos : ''}`);
  });

  for (const ix of cur.indexes) {
    const was = origIx.get(ix.id);
    if (!was || indexKey(was) !== indexKey(ix)) parts.push(`ADD ${indexSql(cur, ix)}`);
  }
  const origFk = new Map(orig.foreignKeys.map((f) => [f.id, f]));
  for (const fk of cur.foreignKeys) {
    const was = origFk.get(fk.id);
    if (!was || fkKey(was) !== fkKey(fk)) parts.push(`ADD ${foreignKeySql(cur, fk)}`);
  }

  const origCk = new Map((orig.checks ?? []).map((k) => [k.id, k]));
  for (const k of cur.checks ?? []) {
    const was = origCk.get(k.id);
    if (!was || ckChanged(was)) parts.push(`ADD ${checkSql(k)}`);
  }

  if (cur.engine !== orig.engine) parts.push(`ENGINE=${cur.engine}`);
  if (cur.convert) parts.push(`CONVERT TO CHARACTER SET ${charsetOf(cur.collation)} COLLATE ${cur.collation}`);
  else if (cur.collation !== orig.collation) parts.push(`DEFAULT CHARSET=${charsetOf(cur.collation)} COLLATE=${cur.collation}`);
  if (cur.comment !== orig.comment) parts.push(`COMMENT=${str(cur.comment)}`);

  if (parts.length) out.push(`ALTER TABLE ${table}\n  ${parts.join(',\n  ')}`);
  out.push(...partitionStatements(table, orig.partitioning ?? null, cur.partitioning ?? null));
  if (cur.name !== orig.name) out.push(`RENAME TABLE ${table} TO ${qi(cur.db)}.${qi(cur.name)}`);
  return out;
}

/** Problems that would make the DDL fail or do something unintended. */
export function validate(t: TableDef): string[] {
  const errs: string[] = [];
  if (!t.name.trim()) errs.push(tr('Nome tabella obbligatorio.'));
  if (!t.columns.length) errs.push(tr('La tabella deve avere almeno una colonna.'));
  const seen = new Set<string>();
  for (const [i, c] of t.columns.entries()) {
    const label = c.name.trim() || `colonna ${i + 1}`;
    if (!c.name.trim()) errs.push(tr('Colonna {0}: nome obbligatorio.', i + 1));
    else if (seen.has(c.name.toLowerCase())) errs.push(tr('Colonna «{0}» ripetuta.', c.name));
    seen.add(c.name.toLowerCase());
    if (!c.type.trim()) errs.push(tr('{0}: tipo obbligatorio.', label));
    if (c.collation && !isTextType(c.type)) errs.push(tr('{0}: collation solo per tipi testo.', label));
    if (c.generated && !c.generated.expr.trim()) errs.push(tr('{0}: espressione della colonna generata obbligatoria.', label));
    if (c.autoIncrement && !t.indexes.some((ix) => ix.columns[0]?.col === c.id)) errs.push(tr('{0}: AUTO_INCREMENT richiede che la colonna sia la prima di un indice.', label));
  }
  if (t.columns.filter((c) => c.autoIncrement).length > 1) errs.push(tr('Una sola colonna AUTO_INCREMENT per tabella.'));
  if (t.indexes.filter((ix) => ix.kind === 'PRIMARY').length > 1) errs.push(tr('Una sola chiave primaria per tabella.'));
  const ids = new Set(t.columns.map((c) => c.id));
  const names = new Set<string>();
  for (const ix of t.indexes) {
    const label = ix.kind === 'PRIMARY' ? tr('Chiave primaria') : tr('Indice «{0}»', ix.name || '?');
    if (ix.kind !== 'PRIMARY') {
      if (!ix.name.trim()) errs.push(tr('Indice senza nome.'));
      else if (names.has(ix.name.toLowerCase())) errs.push(`${label} ripetuto.`);
      names.add(ix.name.toLowerCase());
    }
    if (!ix.columns.length) errs.push(tr('{0}: nessuna colonna.', label));
    if (ix.columns.some((c) => !ids.has(c.col))) errs.push(tr('{0}: colonna eliminata.', label));
    if (ix.kind === 'PRIMARY' && ix.columns.some((c) => t.columns.find((x) => x.id === c.col)?.nullable)) errs.push(tr('Le colonne della chiave primaria devono essere NOT NULL.'));
  }
  const fkNames = new Set<string>();
  for (const fk of t.foreignKeys) {
    const label = tr('Chiave esterna «{0}»', fk.name || '?');
    if (!fk.name.trim()) errs.push(tr('Chiave esterna senza nome.'));
    else if (fkNames.has(fk.name.toLowerCase())) errs.push(`${label} ripetuta.`);
    fkNames.add(fk.name.toLowerCase());
    if (!fk.refTable) errs.push(tr('{0}: tabella riferita obbligatoria.', label));
    if (!fk.columns.length) errs.push(tr('{0}: nessuna colonna.', label));
    if (fk.columns.length !== fk.refColumns.length) errs.push(tr('{0}: numero di colonne diverso da quelle riferite.', label));
    if (fk.columns.some((c) => !ids.has(c))) errs.push(tr('{0}: colonna eliminata.', label));
    if (fk.onDelete === 'SET NULL' || fk.onUpdate === 'SET NULL') {
      if (fk.columns.some((c) => !t.columns.find((x) => x.id === c)?.nullable)) errs.push(tr('{0}: SET NULL richiede colonne che ammettono NULL.', label));
    }
  }
  const p = t.partitioning;
  if (p && !p.subpartitioned) {
    if (!p.expr.trim() && !p.method.endsWith('KEY')) errs.push(tr('Partizioni: espressione obbligatoria.'));
    if (byList(p.method)) {
      if (!p.partitions.length) errs.push(tr('Partizioni: serve almeno una partizione.'));
      const names = new Set<string>();
      p.partitions.forEach((x, i) => {
        if (!x.name.trim()) errs.push(tr('Partizione {0}: nome obbligatorio.', i + 1));
        else if (names.has(x.name.toLowerCase())) errs.push(tr('Partizione «{0}» ripetuta.', x.name));
        names.add(x.name.toLowerCase());
        if (!x.values.trim()) errs.push(tr('Partizione «{0}»: valori obbligatori.', x.name || i + 1));
        if (p.method.startsWith('RANGE') && /^maxvalue$/i.test(x.values.trim()) && i !== p.partitions.length - 1) errs.push(tr('Partizioni: MAXVALUE solo nell\'ultima partizione.'));
      });
    } else if (!(p.count >= 1 && p.count <= 8192)) errs.push(tr('Partizioni: numero tra 1 e 8192.'));
  }
  const ckNames = new Set<string>();
  for (const k of t.checks ?? []) {
    if (!k.name.trim()) errs.push(tr('Vincolo CHECK senza nome.'));
    else if (ckNames.has(k.name.toLowerCase())) errs.push(tr('Vincolo CHECK «{0}» ripetuto.', k.name));
    ckNames.add(k.name.toLowerCase());
    if (!k.expr.trim()) errs.push(tr('Vincolo CHECK «{0}»: espressione obbligatoria.', k.name || '?'));
  }
  return errs;
}

/** Removing a column also removes it from indexes and foreign keys (empty ones are dropped). */
export function removeColumn(t: TableDef, id: string): TableDef {
  return {
    ...t,
    columns: t.columns.filter((c) => c.id !== id),
    indexes: t.indexes.map((ix) => ({ ...ix, columns: ix.columns.filter((c) => c.col !== id) })).filter((ix) => ix.columns.length),
    foreignKeys: t.foreignKeys.filter((fk) => !fk.columns.includes(id)),
  };
}

/** Primary key checkbox of a column: adds it to (or removes it from) the PRIMARY index. */
export function togglePrimary(t: TableDef, id: string): TableDef {
  const pk = t.indexes.find((ix) => ix.kind === 'PRIMARY');
  if (pk?.columns.some((c) => c.col === id)) {
    const rest = pk.columns.filter((c) => c.col !== id);
    return { ...t, indexes: rest.length ? t.indexes.map((ix) => (ix === pk ? { ...ix, columns: rest } : ix)) : t.indexes.filter((ix) => ix !== pk) };
  }
  const columns = t.columns.map((c) => (c.id === id ? { ...c, nullable: false } : c));
  if (pk) return { ...t, columns, indexes: t.indexes.map((ix) => (ix === pk ? { ...ix, columns: [...ix.columns, { col: id, len: null }] } : ix)) };
  return { ...t, columns, indexes: [{ id: newId('i'), orig: null, name: 'PRIMARY', kind: 'PRIMARY', columns: [{ col: id, len: null }], comment: '' }, ...t.indexes] };
}
