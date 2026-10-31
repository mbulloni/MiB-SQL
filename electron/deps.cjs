// Dependencies of a table, view, column or routine: foreign keys that reference it and the views, routines,
// triggers and events whose code mentions its name (LIKE on information_schema, every database the account
// can see). The candidates are confirmed token by token in the renderer (src/deps.ts), which also rewrites
// their code for a safe rename.
const server = require('./server.cjs');
const { t } = require('./i18n.cjs');

const SYSTEM = ['mysql', 'information_schema', 'performance_schema', 'sys'];
const likeOf = (text) => `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const str = (v) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/**
 * @param {{ db: string, name: string, kind: 'table'|'view'|'procedure'|'function', column?: string }} target
 * @returns {Promise<{ fks: object[], objects: object[], extras: object[], version: string, definition: string|null }>}
 *   fks: foreign keys referencing the table (or the column), objects: code candidates
 *   ({ db, kind, name, table?, readable }), extras: indexes, generated columns and CHECK constraints
 *   of the table that use the column (column targets only).
 */
async function find(connId, target) {
  const q = (sql, params) => server.meta(connId, sql, params).catch(() => []);
  const sys = SYSTEM.map(() => '?').join(', ');
  const word = target.column ?? target.name;
  const like = likeOf(word);
  const fks = [];
  if (target.kind === 'table') {
    const rows = await q(`SELECT k.CONSTRAINT_SCHEMA AS db, k.TABLE_NAME AS t, k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_COLUMN_NAME AS ref
      FROM information_schema.KEY_COLUMN_USAGE k
      WHERE k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ? ORDER BY k.CONSTRAINT_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [target.db, target.name]);
    const by = new Map();
    for (const r of rows) {
      const key = `${r.db}.${r.t}.${r.name}`;
      if (!by.has(key)) by.set(key, { db: r.db, table: r.t, name: r.name, columns: [], refColumns: [] });
      by.get(key).columns.push(r.col);
      by.get(key).refColumns.push(r.ref);
    }
    for (const fk of by.values()) if (!target.column || fk.refColumns.some((c) => c.toLowerCase() === target.column.toLowerCase())) fks.push(fk);
  }
  const objects = [];
  const add = (rows, kind, f = () => ({})) => { for (const r of rows) objects.push({ db: r.db, kind, name: r.name, readable: true, ...f(r) }); };
  add(await q(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name FROM information_schema.VIEWS
    WHERE TABLE_SCHEMA NOT IN (${sys}) AND VIEW_DEFINITION LIKE ? AND NOT (TABLE_SCHEMA = ? AND TABLE_NAME = ?)`, [...SYSTEM, like, target.db, target.name]), 'view');
  add(await q(`SELECT ROUTINE_SCHEMA AS db, ROUTINE_NAME AS name, ROUTINE_TYPE AS type, ROUTINE_DEFINITION IS NOT NULL AS readable FROM information_schema.ROUTINES
    WHERE ROUTINE_SCHEMA NOT IN (${sys}) AND (ROUTINE_DEFINITION LIKE ? OR ROUTINE_DEFINITION IS NULL)
      AND NOT (ROUTINE_SCHEMA = ? AND ROUTINE_NAME = ? AND ROUTINE_TYPE = ?)`, [...SYSTEM, like, target.db, target.name, String(target.kind).toUpperCase()]),
  'routine', (r) => ({ kind: r.type === 'FUNCTION' ? 'function' : 'procedure', readable: !!Number(r.readable) }));
  // Triggers of the table always depend on it (NEW.col / OLD.col for a column rename).
  add(await q(`SELECT TRIGGER_SCHEMA AS db, TRIGGER_NAME AS name, EVENT_OBJECT_SCHEMA AS tdb, EVENT_OBJECT_TABLE AS t FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA NOT IN (${sys}) AND (ACTION_STATEMENT LIKE ? OR (EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?))`, [...SYSTEM, like, target.db, target.name]),
  'trigger', (r) => ({ table: r.t, onTarget: r.tdb === target.db && r.t === target.name }));
  add(await q(`SELECT EVENT_SCHEMA AS db, EVENT_NAME AS name FROM information_schema.EVENTS
    WHERE EVENT_SCHEMA NOT IN (${sys}) AND EVENT_DEFINITION LIKE ?`, [...SYSTEM, like]), 'event');
  const extras = [];
  if (target.column) {
    const col = target.column;
    for (const r of await q(`SELECT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? GROUP BY INDEX_NAME`, [target.db, target.name, col])) extras.push({ kind: 'index', name: r.name, auto: true });
    for (const r of await q(`SELECT COLUMN_NAME AS name, GENERATION_EXPRESSION AS expr FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND GENERATION_EXPRESSION LIKE ?`, [target.db, target.name, likeOf(col)])) extras.push({ kind: 'generated', name: r.name, text: str(r.expr), auto: false });
    for (const r of await q(`SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS expr FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND CHECK_CLAUSE LIKE ?`, [target.db, likeOf(col)])) extras.push({ kind: 'check', name: r.name, text: str(r.expr), auto: false });
    // FKs of the table itself on the column (child side): the server renames them too.
    for (const r of await q(`SELECT CONSTRAINT_NAME AS name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`, [target.db, target.name, col])) extras.push({ kind: 'fk', name: r.name, auto: true });
  }
  const [ver] = await q('SELECT VERSION() AS v');
  const definition = target.column ? await columnDefinition(connId, target.db, target.name, target.column).catch(() => null) : null;
  return { fks, objects, extras, version: ver ? String(ver.v) : '', definition };
}

/** Column definition from SHOW CREATE TABLE, for CHANGE COLUMN on servers without RENAME COLUMN. */
async function columnDefinition(connId, db, table, column) {
  const rows = await server.meta(connId, `SHOW CREATE TABLE \`${db.replace(/`/g, '``')}\`.\`${table.replace(/`/g, '``')}\``);
  const ddl = String(Object.values(rows[0])[1]);
  const quoted = '`' + column.replace(/`/g, '``') + '`';
  const line = ddl.split('\n').map((l) => l.trim()).find((l) => l.startsWith(quoted + ' '));
  if (!line) throw new Error(t('Colonna {0} non trovata nella tabella {1}.', column, table));
  return line.slice(quoted.length + 1).replace(/,$/, '');
}

module.exports = { find, columnDefinition };
