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

/**
 * Everything the table designer edits. COLUMN_DEFAULT is an SQL expression on MariaDB ('text', 0,
 * current_timestamp()); MySQL reports bare values, quoted here unless numeric or an expression.
 */
async function tableDefinition(connId, db, table) {
  const [[t], cols, stats, fks, [ver]] = await Promise.all([
    server.meta(connId, `SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment, TABLE_TYPE AS type
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`, [db, table]),
    server.meta(connId, `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS def, EXTRA AS extra,
        COLLATION_NAME AS collation, GENERATION_EXPRESSION AS genExpr, COLUMN_COMMENT AS comment, DATA_TYPE AS dataType
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [db, table]),
    server.meta(connId, `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col, SUB_PART AS len, INDEX_TYPE AS type, INDEX_COMMENT AS comment
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`, [db, table]),
    foreignKeys(connId, db, table),
    server.meta(connId, 'SELECT VERSION() AS v'),
  ]);
  if (!t) throw new Error(`Tabella ${db}.${table} non trovata.`);
  if (t.type === 'VIEW') throw new Error(`${table} è una vista: il designer modifica solo tabelle.`);
  const mariadb = /mariadb/i.test(ver.v);
  const defaultOf = (c) => {
    if (c.def === null || c.def === undefined) return null;
    if (mariadb) return c.def;
    if (/DEFAULT_GENERATED/i.test(c.extra)) return /^current_timestamp/i.test(c.def) ? c.def : `(${c.def})`;
    if (/int|dec|float|double|bit|year/i.test(c.dataType) && /^-?\d+(\.\d+)?$/.test(c.def)) return c.def;
    return "'" + c.def.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
  };
  const indexes = new Map();
  for (const r of stats) {
    if (!indexes.has(r.name)) {
      const kind = r.name === 'PRIMARY' ? 'PRIMARY' : r.type === 'FULLTEXT' ? 'FULLTEXT' : r.type === 'SPATIAL' ? 'SPATIAL' : Number(r.nonUnique) === 0 ? 'UNIQUE' : 'INDEX';
      indexes.set(r.name, { name: r.name, kind, columns: [], comment: r.comment || '' });
    }
    indexes.get(r.name).columns.push({ name: r.col, len: r.len === null ? null : Number(r.len) });
  }
  return {
    name: table,
    engine: t.engine,
    collation: t.collation,
    comment: t.comment,
    columns: cols.map((c) => {
      const gen = c.genExpr ? { expr: c.genExpr, stored: /STORED/i.test(c.extra) } : null;
      const onUpdate = /on update (\S+)/i.exec(c.extra)?.[1] ?? '';
      return {
        name: c.name,
        type: c.type,
        nullable: c.nullable === 'YES',
        default: gen ? null : defaultOf(c),
        autoIncrement: /auto_increment/i.test(c.extra),
        onUpdate,
        collation: c.collation && c.collation !== t.collation ? c.collation : '',
        comment: c.comment,
        generated: gen,
      };
    }),
    indexes: [...indexes.values()],
    foreignKeys: fks,
  };
}

/** Engines, collations and the database defaults for the designer's selects. */
async function serverOptions(connId, db) {
  const [engines, collations, [schema]] = await Promise.all([
    server.meta(connId, "SELECT ENGINE AS name, SUPPORT AS support FROM information_schema.ENGINES WHERE SUPPORT IN ('YES', 'DEFAULT') ORDER BY ENGINE"),
    server.meta(connId, 'SELECT COLLATION_NAME AS name, CHARACTER_SET_NAME AS charset, IS_DEFAULT AS isDefault FROM information_schema.COLLATIONS ORDER BY CHARACTER_SET_NAME, COLLATION_NAME'),
    server.meta(connId, 'SELECT DEFAULT_COLLATION_NAME AS collation FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db]),
  ]);
  return {
    engines: engines.map((e) => e.name),
    defaultEngine: engines.find((e) => e.support === 'DEFAULT')?.name ?? 'InnoDB',
    collations: collations.filter((c) => c.charset).map((c) => ({ name: c.name, charset: c.charset, isDefault: c.isDefault === 'Yes' })),
    defaultCollation: schema?.collation ?? 'utf8mb4_general_ci',
  };
}

/** Tables, columns and foreign keys of a whole database for the ER diagram (three queries). */
async function erModel(connId, db) {
  const [tables, cols, fks] = await Promise.all([
    server.meta(connId, `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, TABLE_ROWS AS \`rows\`, TABLE_COMMENT AS comment
      FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`, [db]),
    server.meta(connId, `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_TYPE AS type, COLUMN_KEY AS \`key\`, IS_NULLABLE AS nullable
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]),
    server.meta(connId, `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS t, COLUMN_NAME AS col, REFERENCED_TABLE_SCHEMA AS refDb,
        REFERENCED_TABLE_NAME AS refTable, REFERENCED_COLUMN_NAME AS refCol
      FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL
      ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [db]),
  ]);
  const byTable = new Map(tables.map((t) => [t.name, {
    name: t.name, kind: t.type === 'VIEW' ? 'view' : 'table', rows: t.rows === null ? null : Number(t.rows), comment: t.comment, columns: [],
  }]));
  for (const c of cols) byTable.get(c.t)?.columns.push({ name: c.name, type: c.type, pk: c.key === 'PRI', nullable: c.nullable === 'YES' });
  const fkMap = new Map();
  for (const r of fks) {
    const k = `${r.t}/${r.name}`;
    if (!fkMap.has(k)) fkMap.set(k, { name: r.name, table: r.t, columns: [], refDb: r.refDb, refTable: r.refTable, refColumns: [] });
    fkMap.get(k).columns.push(r.col);
    fkMap.get(k).refColumns.push(r.refCol);
  }
  return { tables: [...byTable.values()], fks: [...fkMap.values()] };
}

module.exports = { erModel, tableDefinition, serverOptions, databases, objects, columns, indexes, foreignKeys, ddl, schema };
