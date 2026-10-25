// Schema compare: source vs target database, sync script for the target, line diff. Pure functions for tests.
import { alterSql, createSql, foreignKeySql, fromServer, qi, type ServerTable, type TableDef } from './design.ts';
import { t as tr } from './i18n.ts';

export type ObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event';
export type Status = 'equal' | 'diff' | 'source' | 'target';

export interface Snapshot {
  tables: Record<string, ServerTable>;
  others: { kind: Exclude<ObjectKind, 'table'>; name: string; ddl: string | null }[];
}

export interface CompareItem {
  kind: ObjectKind;
  name: string;
  status: Status;
  sourceDdl: string;
  targetDdl: string;
  sync: string[]; // statements that make the target like the source
  note?: string;
}

/**
 * Source definition with the ids of the target's matching columns, indexes and foreign keys (by name), so
 * alterSql(target, aligned) produces the changes; database names are mapped from source to target.
 */
export function alignTo(target: TableDef, source: TableDef): TableDef {
  const col = new Map(target.columns.map((c) => [c.name.toLowerCase(), c]));
  const ids = new Map<string, string>(); // source column id → target id
  const columns = source.columns.map((c) => {
    const t = col.get(c.name.toLowerCase());
    const id = t ? t.id : `s_${c.id}`;
    ids.set(c.id, id);
    return { ...c, id, orig: t ? t.name : null };
  });
  const ix = new Map(target.indexes.map((i) => [i.kind === 'PRIMARY' ? 'PRIMARY' : i.name.toLowerCase(), i]));
  const indexes = source.indexes.map((i) => {
    const t = ix.get(i.kind === 'PRIMARY' ? 'PRIMARY' : i.name.toLowerCase());
    return { ...i, id: t ? t.id : `s_${i.id}`, orig: t ? t.name : null, columns: i.columns.map((c) => ({ ...c, col: ids.get(c.col) ?? c.col })) };
  });
  const fk = new Map(target.foreignKeys.map((f) => [f.name.toLowerCase(), f]));
  const foreignKeys = source.foreignKeys.map((f) => {
    const t = fk.get(f.name.toLowerCase());
    return { ...f, id: t ? t.id : `s_${f.id}`, orig: t ? t.name : null, columns: f.columns.map((c) => ids.get(c) ?? c), refDb: f.refDb === source.db ? target.db : f.refDb };
  });
  const ck = new Map((target.checks ?? []).map((k) => [k.name.toLowerCase(), k]));
  const checks = (source.checks ?? []).map((k) => {
    const t = ck.get(k.name.toLowerCase());
    return { ...k, id: t ? t.id : `s_${k.id}`, orig: t ? t.name : null };
  });
  const pt = new Map((target.partitioning?.partitions ?? []).map((p) => [p.name.toLowerCase(), p]));
  const partitioning = source.partitioning ? {
    ...source.partitioning,
    partitions: source.partitioning.partitions.map((p) => { const t = pt.get(p.name.toLowerCase()); return { ...p, id: t ? t.id : `s_${p.id}`, orig: t ? t.name : null }; }),
  } : null;
  return { ...source, db: target.db, name: target.name, columns, indexes, foreignKeys, checks, partitioning };
}

const DROP: Record<ObjectKind, string> = { table: 'TABLE', view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT' };
const ORDER: ObjectKind[] = ['table', 'view', 'function', 'procedure', 'trigger', 'event'];

/** CREATE of a view/routine for the target database (views become CREATE OR REPLACE). */
function createOther(kind: ObjectKind, ddl: string) {
  return kind === 'view' ? ddl.replace(/^CREATE\s+(OR\s+REPLACE\s+)?/i, 'CREATE OR REPLACE ') : ddl;
}

export function compareSchemas(source: Snapshot, target: Snapshot, sourceDb: string, targetDb: string): CompareItem[] {
  const out: CompareItem[] = [];
  const names = new Set([...Object.keys(source.tables), ...Object.keys(target.tables)]);
  for (const name of [...names].sort()) {
    const s = source.tables[name];
    const t = target.tables[name];
    const sd = s ? fromServer(sourceDb, s) : null;
    const td = t ? fromServer(targetDb, t) : null;
    // the source as it would be created in the target (database and FK references mapped)
    const mapped = sd ? alignTo({ ...sd, db: targetDb, columns: [], indexes: [], foreignKeys: [], checks: [], partitioning: null }, sd) : null;
    const sourceDdl = mapped ? createSql(mapped) : '';
    const targetDdl = td ? createSql(td) : '';
    if (mapped && !td) {
      // created without foreign keys, added later with FK checks on (see syncStatements)
      const fks = mapped.foreignKeys.map((f) => `ADD ${foreignKeySql(mapped, f)}`);
      const sync = [createSql({ ...mapped, foreignKeys: [] }), ...(fks.length ? [`ALTER TABLE ${qi(targetDb)}.${qi(name)}\n  ${fks.join(',\n  ')}`] : [])];
      out.push({ kind: 'table', name, status: 'source', sourceDdl, targetDdl, sync });
    } else if (!sd && td) {
      out.push({ kind: 'table', name, status: 'target', sourceDdl, targetDdl, sync: [`DROP TABLE ${qi(targetDb)}.${qi(name)}`] });
    } else if (sd && td) {
      const sync = alterSql(td, alignTo(td, sd));
      out.push({ kind: 'table', name, status: sync.length ? 'diff' : 'equal', sourceDdl, targetDdl, sync });
    }
  }
  const key = (o: { kind: string; name: string }) => `${o.kind}/${o.name}`;
  const tgt = new Map(target.others.map((o) => [key(o), o]));
  const src = new Map(source.others.map((o) => [key(o), o]));
  for (const k of [...new Set([...src.keys(), ...tgt.keys()])].sort()) {
    const s = src.get(k);
    const t = tgt.get(k);
    const kind = (s ?? t)!.kind;
    const name = (s ?? t)!.name;
    const drop = `DROP ${DROP[kind]} IF EXISTS ${qi(targetDb)}.${qi(name)}`;
    const unreadable = tr('Definizione non leggibile: servono i privilegi sul definer (o SHOW_ROUTINE/SELECT su mysql.proc).');
    if (s && !t) out.push({ kind, name, status: 'source', sourceDdl: s.ddl ?? '', targetDdl: '', sync: s.ddl ? [createOther(kind, s.ddl)] : [], ...(s.ddl ? {} : { note: unreadable }) });
    else if (!s && t) out.push({ kind, name, status: 'target', sourceDdl: '', targetDdl: t.ddl ?? '', sync: [drop] });
    else if (s && t) {
      const same = (s.ddl ?? '') === (t.ddl ?? '');
      out.push({ kind, name, status: same ? 'equal' : 'diff', sourceDdl: s.ddl ?? '', targetDdl: t.ddl ?? '', sync: same || !s.ddl ? [] : kind === 'view' ? [createOther(kind, s.ddl)] : [drop, s.ddl], ...(!s.ddl || !t.ddl ? { note: unreadable } : {}) });
    }
  }
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
}

/**
 * Statements for the chosen items. DROP/CREATE TABLE run with FK checks off (any order works); every ALTER,
 * foreign keys included, runs with checks back on: MariaDB stores RESTRICT rules added while
 * FOREIGN_KEY_CHECKS = 0 as NO ACTION. Then views, routines, triggers, events.
 */
export function syncStatements(items: CompareItem[], targetDb: string): string[] {
  const chosen = [...items].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const all = chosen.flatMap((i) => i.sync);
  if (!all.length) return [];
  const createDrop = all.filter((s) => /^(CREATE|DROP) TABLE\b/i.test(s));
  const rest = all.filter((s) => !/^(CREATE|DROP) TABLE\b/i.test(s));
  return [
    `USE ${qi(targetDb)}`,
    ...(createDrop.length ? ['SET FOREIGN_KEY_CHECKS = 0', ...createDrop, 'SET FOREIGN_KEY_CHECKS = 1'] : []),
    ...rest,
  ];
}

/** Script text: routines/triggers/events need DELIMITER when opened in the SQL editor. */
export function scriptText(stmts: string[]): string {
  return stmts.map((s) => (/^CREATE\s+(?:DEFINER\s*=\s*\S+\s+)?(PROCEDURE|FUNCTION|TRIGGER|EVENT)\b/i.test(s) ? `DELIMITER $$\n${s}$$\nDELIMITER ;` : `${s};`)).join('\n\n') + '\n';
}

export interface DiffLine { type: 'same' | 'add' | 'del'; text: string }

/** Line diff (LCS) from `a` (target) to `b` (source): del = only in target, add = only in source. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a ? a.split('\n') : [];
  const y = b ? b.split('\n') : [];
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push({ type: 'same', text: x[i] }); i++; j++; }
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) { out.push({ type: 'add', text: y[j] }); j++; }
    else { out.push({ type: 'del', text: x[i] }); i++; }
  }
  return out;
}
