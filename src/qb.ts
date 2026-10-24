// Visual query builder model and SQL generation. Pure functions (no React, no IPC) for tests.

export type JoinType = 'INNER' | 'LEFT' | 'RIGHT';
export type Aggregate = '' | 'COUNT' | 'COUNT DISTINCT' | 'SUM' | 'AVG' | 'MIN' | 'MAX';
export type Op = '=' | '<>' | '<' | '<=' | '>' | '>=' | 'LIKE' | 'NOT LIKE' | 'IN' | 'NOT IN' | 'BETWEEN' | 'IS NULL' | 'IS NOT NULL';
export const OPS: Op[] = ['=', '<>', '<', '<=', '>', '>=', 'LIKE', 'NOT LIKE', 'IN', 'NOT IN', 'BETWEEN', 'IS NULL', 'IS NOT NULL'];
export const AGGREGATES: Aggregate[] = ['', 'COUNT', 'COUNT DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'];

export interface QbTable { id: string; db: string; table: string; alias: string; x: number; y: number; columns: string[] }
export interface QbJoin { id: string; left: { t: string; col: string }; right: { t: string; col: string }; type: JoinType }
export interface QbColumn { id: string; t: string; col: string; alias: string; agg: Aggregate; sort: '' | 'ASC' | 'DESC'; output: boolean }
export interface QbFilter { id: string; t: string; col: string; op: Op; value: string; having: boolean }
export interface QbModel { tables: QbTable[]; joins: QbJoin[]; columns: QbColumn[]; filters: QbFilter[]; distinct: boolean; limit: string }

export const emptyQuery = (): QbModel => ({ tables: [], joins: [], columns: [], filters: [], distinct: false, limit: '1000' });

const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';
let seq = 0;
export const qid = (p: string) => `${p}${++seq}_${Math.random().toString(36).slice(2, 6)}`;

/** Short unique alias from the table name (orders → o, order_items → oi, a second orders → o2). */
export function aliasFor(table: string, taken: string[]) {
  const words = table.toLowerCase().split(/[_\s]+/).filter(Boolean);
  let base = (words.length > 1 ? words.map((w) => w[0]).join('') : table.slice(0, 1).toLowerCase()).replace(/[^a-z0-9]/g, '') || 't';
  if (/^\d/.test(base)) base = 't' + base;
  let a = base;
  for (let n = 2; taken.includes(a); n++) a = `${base}${n}`;
  return a;
}

/** Literal of a filter value: numbers, quoted strings, expressions in parentheses and functions pass through. */
export function value(v: string) {
  const s = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(s) || /^'.*'$/s.test(s) || /^\(.*\)$/s.test(s) || /^[a-z_]+\(.*\)$/is.test(s) || /^(null|true|false)$/i.test(s)) return s;
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
}

function columnExpr(c: QbColumn, alias: string) {
  const ref = c.col === '*' ? `${qi(alias)}.*` : `${qi(alias)}.${qi(c.col)}`;
  if (!c.agg) return ref;
  if (c.agg === 'COUNT DISTINCT') return `COUNT(DISTINCT ${ref})`;
  return `${c.agg}(${c.col === '*' ? '*' : ref})`;
}

function condition(f: QbFilter, alias: string, agg?: QbColumn) {
  const ref = agg ? columnExpr(agg, alias) : `${qi(alias)}.${qi(f.col)}`;
  if (f.op === 'IS NULL' || f.op === 'IS NOT NULL') return `${ref} ${f.op}`;
  if (f.op === 'IN' || f.op === 'NOT IN') return `${ref} ${f.op} (${f.value.split(',').map(value).join(', ')})`;
  if (f.op === 'BETWEEN') {
    const [a, b] = f.value.split(/\s+(?:and|e)\s+|,/i);
    return `${ref} BETWEEN ${value(a ?? '')} AND ${value(b ?? '')}`;
  }
  return `${ref} ${f.op} ${value(f.value)}`;
}

/**
 * FROM with joins: starts from the first table and adds the tables joined to the ones already in, combining
 * every condition between the same pair; tables without joins become CROSS JOIN.
 */
function fromClause(m: QbModel, defaultDb: string) {
  if (!m.tables.length) return '';
  const byId = new Map(m.tables.map((t) => [t.id, t]));
  const name = (t: QbTable) => `${t.db && t.db !== defaultDb ? qi(t.db) + '.' : ''}${qi(t.table)}${t.alias !== t.table ? ` AS ${qi(t.alias)}` : ''}`;
  const included = new Set([m.tables[0].id]);
  let sql = `FROM ${name(m.tables[0])}`;
  const pending = m.tables.slice(1);
  while (pending.length) {
    const next = pending.findIndex((t) => m.joins.some((j) => (j.left.t === t.id && included.has(j.right.t)) || (j.right.t === t.id && included.has(j.left.t))));
    const t = pending.splice(next < 0 ? 0 : next, 1)[0];
    const js = m.joins.filter((j) => (j.left.t === t.id && included.has(j.right.t)) || (j.right.t === t.id && included.has(j.left.t)));
    if (!js.length) {
      sql += `\nCROSS JOIN ${name(t)}`;
    } else {
      // the join type is written for left → right; flip it when the new table is the left side
      const first = js[0];
      const type = first.right.t === t.id ? first.type : first.type === 'LEFT' ? 'RIGHT' : first.type === 'RIGHT' ? 'LEFT' : 'INNER';
      const on = js.map((j) => `${qi(byId.get(j.left.t)!.alias)}.${qi(j.left.col)} = ${qi(byId.get(j.right.t)!.alias)}.${qi(j.right.col)}`).join(' AND ');
      sql += `\n${type} JOIN ${name(t)} ON ${on}`;
    }
    included.add(t.id);
  }
  return sql;
}

export function toSql(m: QbModel, defaultDb: string): string {
  if (!m.tables.length) return '';
  const alias = (id: string) => m.tables.find((t) => t.id === id)?.alias ?? '?';
  const cols = m.columns.filter((c) => m.tables.some((t) => t.id === c.t));
  const out = cols.filter((c) => c.output);
  const select = out.length
    ? out.map((c) => columnExpr(c, alias(c.t)) + (c.alias ? ` AS ${qi(c.alias)}` : '')).join(',\n  ')
    : '*';
  const parts = [`SELECT ${m.distinct ? 'DISTINCT ' : ''}${select}`, fromClause(m, defaultDb)];
  const filters = m.filters.filter((f) => m.tables.some((t) => t.id === f.t));
  const where = filters.filter((f) => !f.having).map((f) => condition(f, alias(f.t)));
  if (where.length) parts.push(`WHERE ${where.join('\n  AND ')}`);
  const aggregated = out.some((c) => c.agg);
  if (aggregated) {
    const group = out.filter((c) => !c.agg && c.col !== '*').map((c) => `${qi(alias(c.t))}.${qi(c.col)}`);
    if (group.length) parts.push(`GROUP BY ${group.join(', ')}`);
  }
  const having = filters.filter((f) => f.having).map((f) => {
    const agg = out.find((c) => c.t === f.t && c.col === f.col && c.agg);
    return condition(f, alias(f.t), agg);
  });
  if (having.length) parts.push(`HAVING ${having.join('\n  AND ')}`);
  const order = cols.filter((c) => c.sort).map((c) => `${c.output && c.alias ? qi(c.alias) : columnExpr(c, alias(c.t))} ${c.sort}`);
  if (order.length) parts.push(`ORDER BY ${order.join(', ')}`);
  if (/^\d+$/.test(m.limit.trim())) parts.push(`LIMIT ${m.limit.trim()}`);
  return parts.join('\n');
}

/** Joins implied by foreign keys between a newly added table and the tables already on the canvas. */
export function autoJoins(m: QbModel, added: QbTable, fks: { table: string; columns: string[]; refTable: string; refColumns: string[] }[]): QbJoin[] {
  const out: QbJoin[] = [];
  for (const other of m.tables) {
    if (other.id === added.id) continue;
    for (const fk of fks) {
      fk.columns.forEach((col, i) => {
        const ref = fk.refColumns[i];
        // the table already on the canvas is the left side, the added one the right side
        if (fk.table === added.table && fk.refTable === other.table) out.push({ id: qid('j'), left: { t: other.id, col: ref }, right: { t: added.id, col }, type: 'INNER' });
        else if (fk.table === other.table && fk.refTable === added.table) out.push({ id: qid('j'), left: { t: other.id, col }, right: { t: added.id, col: ref }, type: 'INNER' });
      });
    }
  }
  return out;
}
