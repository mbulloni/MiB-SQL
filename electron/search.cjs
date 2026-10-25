// Database search: a text in object names (tables, columns, indexes, views, routines, triggers, events), in the
// code of views/routines/triggers/events, in comments, and in the data of text columns (one table at a time,
// with progress and stop). Matching uses LIKE on the server; whole-word and case filtering of object hits
// happens in the renderer (src/search.ts).
const server = require('./server.cjs');

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const str = (v) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const likeOf = (text) => `%${String(text).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const TEXT_TYPES = new Set(['char', 'varchar', 'tinytext', 'text', 'mediumtext', 'longtext', 'enum', 'set', 'json']);
const NUMERIC = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'integer', 'bigint', 'decimal', 'numeric', 'float', 'double']);

const inList = (dbs) => dbs.map(() => '?').join(', ');

/** Hits in names, code and comments. */
async function objects(connId, dbs, text, { names = true, code = true, comments = true } = {}) {
  if (!dbs.length || !String(text).trim()) return [];
  const like = likeOf(text);
  const out = [];
  const add = (rows, kind, where, f) => { for (const r of rows) out.push({ kind, where, ...f(r) }); };
  const q = (sql, params) => server.meta(connId, sql, params).catch(() => []);
  const D = inList(dbs);
  if (names) {
    add(await q(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${D}) AND TABLE_NAME LIKE ?`, [...dbs, like]),
      'table', 'name', (r) => ({ db: r.db, name: r.name, kind: r.type === 'VIEW' ? 'view' : 'table' }));
    add(await q(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${D}) AND COLUMN_NAME LIKE ?`, [...dbs, like]),
      'column', 'name', (r) => ({ db: r.db, table: r.t, name: r.name, text: str(r.type) }));
    add(await q(`SELECT DISTINCT TABLE_SCHEMA AS db, TABLE_NAME AS t, INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA IN (${D}) AND INDEX_NAME LIKE ?`, [...dbs, like]),
      'index', 'name', (r) => ({ db: r.db, table: r.t, name: r.name }));
    add(await q(`SELECT ROUTINE_SCHEMA AS db, ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN (${D}) AND ROUTINE_NAME LIKE ?`, [...dbs, like]),
      'routine', 'name', (r) => ({ db: r.db, name: r.name, kind: r.type === 'FUNCTION' ? 'function' : 'procedure' }));
    add(await q(`SELECT TRIGGER_SCHEMA AS db, TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (${D}) AND TRIGGER_NAME LIKE ?`, [...dbs, like]),
      'trigger', 'name', (r) => ({ db: r.db, name: r.name, table: r.t }));
    add(await q(`SELECT EVENT_SCHEMA AS db, EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA IN (${D}) AND EVENT_NAME LIKE ?`, [...dbs, like]),
      'event', 'name', (r) => ({ db: r.db, name: r.name }));
  }
  if (code) {
    add(await q(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, VIEW_DEFINITION AS code FROM information_schema.VIEWS WHERE TABLE_SCHEMA IN (${D}) AND VIEW_DEFINITION LIKE ?`, [...dbs, like]),
      'view', 'code', (r) => ({ db: r.db, name: r.name, text: str(r.code) }));
    add(await q(`SELECT ROUTINE_SCHEMA AS db, ROUTINE_NAME AS name, ROUTINE_TYPE AS type, ROUTINE_DEFINITION AS code FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN (${D}) AND ROUTINE_DEFINITION LIKE ?`, [...dbs, like]),
      'routine', 'code', (r) => ({ db: r.db, name: r.name, kind: r.type === 'FUNCTION' ? 'function' : 'procedure', text: str(r.code) }));
    add(await q(`SELECT TRIGGER_SCHEMA AS db, TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS t, ACTION_STATEMENT AS code FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (${D}) AND ACTION_STATEMENT LIKE ?`, [...dbs, like]),
      'trigger', 'code', (r) => ({ db: r.db, name: r.name, table: r.t, text: str(r.code) }));
    add(await q(`SELECT EVENT_SCHEMA AS db, EVENT_NAME AS name, EVENT_DEFINITION AS code FROM information_schema.EVENTS WHERE EVENT_SCHEMA IN (${D}) AND EVENT_DEFINITION LIKE ?`, [...dbs, like]),
      'event', 'code', (r) => ({ db: r.db, name: r.name, text: str(r.code) }));
  }
  if (comments) {
    add(await q(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, TABLE_COMMENT AS c FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${D}) AND TABLE_COMMENT LIKE ?`, [...dbs, like]),
      'table', 'comment', (r) => ({ db: r.db, name: r.name, text: str(r.c) }));
    add(await q(`SELECT TABLE_SCHEMA AS db, TABLE_NAME AS t, COLUMN_NAME AS name, COLUMN_COMMENT AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (${D}) AND COLUMN_COMMENT LIKE ?`, [...dbs, like]),
      'column', 'comment', (r) => ({ db: r.db, table: r.t, name: r.name, text: str(r.c) }));
  }
  return out;
}

const active = new Map();

/**
 * Searches the data of every base table of the databases: text columns with LIKE (numeric columns too when
 * the text is a number), at most maxRows rows per table, the primary key returned to open the row.
 * opts: { caseSensitive, exact, maxRows, skipAbove (rows) }.
 */
async function data(id, connId, dbs, text, opts = {}, onProgress = () => {}) {
  const { caseSensitive = false, exact = false, maxRows = 100, skipAbove = 0 } = opts;
  const task = { stop: false };
  active.set(id, task);
  const results = [];
  try {
    const cols = await server.meta(connId, `SELECT c.TABLE_SCHEMA AS db, c.TABLE_NAME AS t, c.COLUMN_NAME AS name, c.DATA_TYPE AS type, c.COLUMN_KEY AS k, tb.TABLE_ROWS AS n
      FROM information_schema.COLUMNS c JOIN information_schema.TABLES tb ON tb.TABLE_SCHEMA = c.TABLE_SCHEMA AND tb.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA IN (${inList(dbs)}) AND tb.TABLE_TYPE = 'BASE TABLE' ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`, dbs);
    const tables = new Map();
    for (const c of cols) {
      const k = `${c.db}\u0000${c.t}`;
      if (!tables.has(k)) tables.set(k, { db: c.db, table: c.t, rows: c.n === null ? null : Number(c.n), cols: [], pk: [] });
      const tb = tables.get(k);
      tb.cols.push({ name: c.name, type: String(c.type).toLowerCase() });
      if (c.k === 'PRI') tb.pk.push(c.name);
    }
    const isNum = /^-?\d+(\.\d+)?$/.test(String(text).trim());
    const list = [...tables.values()];
    let n = 0;
    await server.withConnection(connId, async (c) => {
      for (const tb of list) {
        if (task.stop) break;
        onProgress({ done: n++, total: list.length, table: `${tb.db}.${tb.table}` });
        const searchable = tb.cols.filter((x) => TEXT_TYPES.has(x.type) || (isNum && NUMERIC.has(x.type)));
        if (!searchable.length) continue;
        if (skipAbove && tb.rows !== null && tb.rows > skipAbove) { results.push({ db: tb.db, table: tb.table, skipped: true, rows: [], columns: [], more: false, estimated: tb.rows }); continue; }
        const conds = [];
        const params = [];
        for (const x of searchable) {
          if (NUMERIC.has(x.type)) { conds.push(`${qi(x.name)} = ?`); params.push(text); continue; }
          const col = caseSensitive ? `CAST(${qi(x.name)} AS BINARY)` : qi(x.name);
          if (exact) { conds.push(`${col} = ${caseSensitive ? 'CAST(? AS BINARY)' : '?'}`); params.push(text); }
          else { conds.push(`${col} LIKE ${caseSensitive ? 'CAST(? AS BINARY)' : '?'}`); params.push(likeOf(text)); }
        }
        const key = tb.pk.length ? tb.pk : [];
        const shown = [...new Set([...key, ...searchable.map((x) => x.name)])];
        const sql = `${server.MONITOR_TAG} SELECT ${shown.map(qi).join(', ')} FROM ${qi(tb.db)}.${qi(tb.table)} WHERE ${conds.join(' OR ')} LIMIT ${Number(maxRows) + 1}`;
        try {
          const rows = Array.from(await c.query({ sql, rowsAsArray: true }, params)).map((r) => r.map((v) => server.cell(v, 500)));
          if (!rows.length) continue;
          results.push({ db: tb.db, table: tb.table, key, columns: shown, rows: rows.slice(0, maxRows), more: rows.length > maxRows, searched: searchable.map((x) => x.name) });
        } catch (err) {
          results.push({ db: tb.db, table: tb.table, error: new server.DbError(err).message, rows: [], columns: [], more: false });
        }
      }
    });
    onProgress({ done: list.length, total: list.length, table: null });
    return { results, stopped: task.stop, tables: list.length };
  } finally {
    active.delete(id);
  }
}

function stop(id) { const t = active.get(id); if (t) t.stop = true; }

module.exports = { objects, data, stop, likeOf };
