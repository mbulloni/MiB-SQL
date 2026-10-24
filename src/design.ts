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
}

export interface DIndex {
  id: string;
  orig: string | null;
  name: string;
  kind: IndexKind;
  columns: { col: string; len: number | null }[];
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
  convert?: boolean; // CONVERT TO the table collation (existing text columns too)
}

/** Shape returned by the main process (explorer.tableDefinition). */
export interface ServerTable {
  name: string;
  engine: string;
  collation: string;
  comment: string;
  columns: Omit<DColumn, 'id' | 'orig'>[];
  indexes: { name: string; kind: IndexKind; columns: { name: string; len: number | null }[]; comment: string }[];
  foreignKeys: { name: string; columns: string[]; refDb: string; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string }[];
}

let seq = 0;
export const newId = (p: string) => `${p}${++seq}_${Math.random().toString(36).slice(2, 6)}`;

export function fromServer(db: string, t: ServerTable): TableDef {
  const columns = t.columns.map((c, i) => ({ ...c, id: `c${i}`, orig: c.name }));
  const idOf = (name: string) => columns.find((c) => c.name.toLowerCase() === name.toLowerCase())?.id ?? name;
  return {
    db,
    name: t.name,
    engine: t.engine,
    collation: t.collation,
    comment: t.comment,
    columns,
    indexes: t.indexes.map((ix, i) => ({ id: `i${i}`, orig: ix.name, name: ix.name, kind: ix.kind, comment: ix.comment, columns: ix.columns.map((c) => ({ col: idOf(c.name), len: c.len })) })),
    foreignKeys: t.foreignKeys.map((fk, i) => ({ ...fk, id: `f${i}`, orig: fk.name, columns: fk.columns.map(idOf) })),
  };
}

export function newTable(db: string, engine: string, collation: string): TableDef {
  const id = newId('c');
  return {
    db, name: 'nuova_tabella', engine, collation, comment: '',
    columns: [{ id, orig: null, name: 'id', type: 'int(10) unsigned', nullable: false, default: null, autoIncrement: true, onUpdate: '', collation: '', comment: '', generated: null }],
    indexes: [{ id: newId('i'), orig: null, name: 'PRIMARY', kind: 'PRIMARY', columns: [{ col: id, len: null }], comment: '' }],
    foreignKeys: [],
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
  return s;
}

const colName = (t: TableDef, id: string) => t.columns.find((c) => c.id === id)?.name ?? id;

export function indexSql(t: TableDef, ix: DIndex): string {
  const cols = ix.columns.map((c) => qi(colName(t, c.col)) + (c.len ? `(${c.len})` : '')).join(', ');
  const head = ix.kind === 'PRIMARY' ? 'PRIMARY KEY' : `${ix.kind === 'INDEX' ? 'KEY' : `${ix.kind} KEY`} ${qi(ix.name)}`;
  return `${head} (${cols})${ix.comment ? ` COMMENT ${str(ix.comment)}` : ''}`;
}

export function foreignKeySql(t: TableDef, fk: DForeignKey): string {
  const ref = (fk.refDb && fk.refDb !== t.db ? `${qi(fk.refDb)}.` : '') + qi(fk.refTable);
  return `CONSTRAINT ${qi(fk.name)} FOREIGN KEY (${fk.columns.map((c) => qi(colName(t, c))).join(', ')}) REFERENCES ${ref} (${fk.refColumns.map(qi).join(', ')}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`;
}

const tableOptions = (t: TableDef) =>
  [`ENGINE=${t.engine}`, `DEFAULT CHARSET=${charsetOf(t.collation)}`, `COLLATE=${t.collation}`, t.comment ? `COMMENT=${str(t.comment)}` : ''].filter(Boolean).join(' ');

export function createSql(t: TableDef): string {
  const lines = [...t.columns.map(columnSql), ...t.indexes.map((ix) => indexSql(t, ix)), ...t.foreignKeys.map((fk) => foreignKeySql(t, fk))];
  return `CREATE TABLE ${qi(t.db)}.${qi(t.name)} (\n  ${lines.join(',\n  ')}\n) ${tableOptions(t)}`;
}

// identity of an index / foreign key independent of column names
const indexKey = (ix: DIndex) => JSON.stringify([ix.kind === 'PRIMARY' ? 'PRIMARY' : ix.name, ix.kind, ix.columns, ix.comment]);
const fkKey = (fk: DForeignKey) => JSON.stringify([fk.name, fk.columns, fk.refDb, fk.refTable, fk.refColumns, fk.onDelete, fk.onUpdate]);

/** Statements turning `orig` into `cur`: drop changed foreign keys, one ALTER TABLE, rename last. */
export function alterSql(orig: TableDef, cur: TableDef): string[] {
  const table = `${qi(orig.db)}.${qi(orig.name)}`;
  const out: string[] = [];

  const curFk = new Map(cur.foreignKeys.map((f) => [f.id, f]));
  const dropFks = orig.foreignKeys.filter((f) => !curFk.has(f.id) || fkKey(curFk.get(f.id)!) !== fkKey(f));
  // separate statement: MariaDB cannot drop and re-add a foreign key with the same name in one ALTER
  if (dropFks.length) out.push(`ALTER TABLE ${table}\n  ${dropFks.map((f) => `DROP FOREIGN KEY ${qi(f.orig ?? f.name)}`).join(',\n  ')}`);

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

  if (cur.engine !== orig.engine) parts.push(`ENGINE=${cur.engine}`);
  if (cur.convert) parts.push(`CONVERT TO CHARACTER SET ${charsetOf(cur.collation)} COLLATE ${cur.collation}`);
  else if (cur.collation !== orig.collation) parts.push(`DEFAULT CHARSET=${charsetOf(cur.collation)} COLLATE=${cur.collation}`);
  if (cur.comment !== orig.comment) parts.push(`COMMENT=${str(cur.comment)}`);

  if (parts.length) out.push(`ALTER TABLE ${table}\n  ${parts.join(',\n  ')}`);
  if (cur.name !== orig.name) out.push(`RENAME TABLE ${table} TO ${qi(cur.db)}.${qi(cur.name)}`);
  return out;
}

/** Problems that would make the DDL fail or do something unintended. */
export function validate(t: TableDef): string[] {
  const errs: string[] = [];
  if (!t.name.trim()) errs.push('Nome tabella obbligatorio.');
  if (!t.columns.length) errs.push('La tabella deve avere almeno una colonna.');
  const seen = new Set<string>();
  for (const [i, c] of t.columns.entries()) {
    const label = c.name.trim() || `colonna ${i + 1}`;
    if (!c.name.trim()) errs.push(`Colonna ${i + 1}: nome obbligatorio.`);
    else if (seen.has(c.name.toLowerCase())) errs.push(`Colonna «${c.name}» ripetuta.`);
    seen.add(c.name.toLowerCase());
    if (!c.type.trim()) errs.push(`${label}: tipo obbligatorio.`);
    if (c.collation && !isTextType(c.type)) errs.push(`${label}: collation solo per tipi testo.`);
    if (c.generated && !c.generated.expr.trim()) errs.push(`${label}: espressione della colonna generata obbligatoria.`);
    if (c.autoIncrement && !t.indexes.some((ix) => ix.columns[0]?.col === c.id)) errs.push(`${label}: AUTO_INCREMENT richiede che la colonna sia la prima di un indice.`);
  }
  if (t.columns.filter((c) => c.autoIncrement).length > 1) errs.push('Una sola colonna AUTO_INCREMENT per tabella.');
  if (t.indexes.filter((ix) => ix.kind === 'PRIMARY').length > 1) errs.push('Una sola chiave primaria per tabella.');
  const ids = new Set(t.columns.map((c) => c.id));
  const names = new Set<string>();
  for (const ix of t.indexes) {
    const label = ix.kind === 'PRIMARY' ? 'Chiave primaria' : `Indice «${ix.name || '?'}»`;
    if (ix.kind !== 'PRIMARY') {
      if (!ix.name.trim()) errs.push('Indice senza nome.');
      else if (names.has(ix.name.toLowerCase())) errs.push(`${label} ripetuto.`);
      names.add(ix.name.toLowerCase());
    }
    if (!ix.columns.length) errs.push(`${label}: nessuna colonna.`);
    if (ix.columns.some((c) => !ids.has(c.col))) errs.push(`${label}: colonna eliminata.`);
    if (ix.kind === 'PRIMARY' && ix.columns.some((c) => t.columns.find((x) => x.id === c.col)?.nullable)) errs.push('Le colonne della chiave primaria devono essere NOT NULL.');
  }
  const fkNames = new Set<string>();
  for (const fk of t.foreignKeys) {
    const label = `Chiave esterna «${fk.name || '?'}»`;
    if (!fk.name.trim()) errs.push('Chiave esterna senza nome.');
    else if (fkNames.has(fk.name.toLowerCase())) errs.push(`${label} ripetuta.`);
    fkNames.add(fk.name.toLowerCase());
    if (!fk.refTable) errs.push(`${label}: tabella riferita obbligatoria.`);
    if (!fk.columns.length) errs.push(`${label}: nessuna colonna.`);
    if (fk.columns.length !== fk.refColumns.length) errs.push(`${label}: numero di colonne diverso da quelle riferite.`);
    if (fk.columns.some((c) => !ids.has(c))) errs.push(`${label}: colonna eliminata.`);
    if (fk.onDelete === 'SET NULL' || fk.onUpdate === 'SET NULL') {
      if (fk.columns.some((c) => !t.columns.find((x) => x.id === c)?.nullable)) errs.push(`${label}: SET NULL richiede colonne che ammettono NULL.`);
    }
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
