// Database Explorer and completion metadata, read from information_schema on the connection's pool.
const server = require('./server.cjs');

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';

async function databases(connId) {
  const rows = await server.meta(connId, 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME');
  return rows.map((r) => r.name);
}

/** Every object of a database grouped by kind, for the folders under a database node. */
async function objects(connId, db) {
  const [tables, routines, triggers, events] = await Promise.all([
    server.meta(connId, `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS \`rows\`, TABLE_COMMENT AS comment
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]),
    server.meta(connId, `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
      WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`, [db]),
    server.meta(connId, `SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS \`table\`, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
      FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME`, [db]),
    server.meta(connId, `SELECT EVENT_NAME AS name, STATUS AS status FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME`, [db]),
  ]);
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    tables: tables.filter((t) => t.type !== 'VIEW').map((t) => ({ name: t.name, engine: t.engine, rows: num(t.rows), comment: t.comment, system: t.type === 'SYSTEM VIEW' })),
    views: tables.filter((t) => t.type === 'VIEW').map((t) => ({ name: t.name })),
    procedures: routines.filter((r) => r.type === 'PROCEDURE').map((r) => ({ name: r.name })),
    functions: routines.filter((r) => r.type === 'FUNCTION').map((r) => ({ name: r.name })),
    triggers: triggers.map((t) => ({ name: t.name, table: t.table, timing: t.timing, event: t.event })),
    events: events.map((e) => ({ name: e.name, status: e.status })),
  };
}

async function columns(connId, db, table) {
  const rows = await server.meta(connId, `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS \`key\`,
      COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_COMMENT AS comment
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]);
  return rows.map((r) => ({ ...r, nullable: r.nullable === 'YES' }));
}

async function indexes(connId, db, table) {
  const rows = await server.meta(connId, `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col, INDEX_TYPE AS type
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`, [db, table]);
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, { name: r.name, unique: Number(r.nonUnique) === 0, primary: r.name === 'PRIMARY', type: r.type, columns: [] });
    byName.get(r.name).columns.push(r.col);
  }
  return [...byName.values()];
}

async function foreignKeys(connId, db, table) {
  const rows = await server.meta(connId, `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS refDb,
      k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol, r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [db, table]);
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, { name: r.name, refDb: r.refDb, refTable: r.refTable, onUpdate: r.onUpdate, onDelete: r.onDelete, columns: [], refColumns: [] });
    const fk = byName.get(r.name);
    fk.columns.push(r.col);
    fk.refColumns.push(r.refCol);
  }
  return [...byName.values()];
}

const DDL = {
  table: ['TABLE', 1],
  view: ['VIEW', 1],
  procedure: ['PROCEDURE', 2],
  function: ['FUNCTION', 2],
  trigger: ['TRIGGER', 2],
  event: ['EVENT', 3],
};

/** CREATE statement of an object (SHOW CREATE …), with DELIMITER around routine bodies. */
async function ddl(connId, db, kind, name) {
  const [word, col] = DDL[kind];
  const rows = await server.meta(connId, `SHOW CREATE ${word} ${qi(db)}.${qi(name)}`);
  const text = Object.values(rows[0])[col];
  if (text === null || text === undefined) throw new Error('Definizione non disponibile: privilegi insufficienti.');
  return ['procedure', 'function', 'trigger', 'event'].includes(kind) ? `DELIMITER $$\n${text}$$\nDELIMITER ;\n` : `${text};\n`;
}

/** Tables, columns and routines of one database for autocompletion. */
async function schema(connId, db) {
  const [cols, routines] = await Promise.all([
    server.meta(connId, `SELECT c.TABLE_NAME AS t, c.COLUMN_NAME AS c, c.COLUMN_TYPE AS type, t.TABLE_TYPE AS kind
      FROM information_schema.COLUMNS c JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = ? ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`, [db]),
    server.meta(connId, 'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?', [db]),
  ]);
  const tables = {};
  for (const r of cols) {
    tables[r.t] ??= { kind: r.kind === 'VIEW' ? 'view' : 'table', columns: [] };
    tables[r.t].columns.push({ name: r.c, type: r.type });
  }
  return { tables, routines: routines.map((r) => ({ name: r.name, type: r.type.toLowerCase() })) };
}

module.exports = { databases, objects, columns, indexes, foreignKeys, ddl, schema };
