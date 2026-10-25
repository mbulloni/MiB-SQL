// Test data generator, server side: table definitions with row counts, existing values of a column (foreign
// keys, unique columns) and emptying tables before generating. Rows are generated in the renderer
// (src/datagen.ts) and inserted in batches with server.apply, one transaction per batch.
const server = require('./server.cjs');
const explorer = require('./explorer.cjs');

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const plain = (v) => (typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : String(v)) : Buffer.isBuffer(v) ? v.toString('utf8') : v instanceof Date ? v.toISOString() : v);

async function tables(connId, db) {
  const defs = [...(await explorer.tableDefinitions(connId, db)).values()].map(({ _ix, _fk, ...t }) => t);
  const rows = await server.meta(connId, "SELECT TABLE_NAME AS name, TABLE_ROWS AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [db]);
  const count = new Map(rows.map((r) => [r.name, r.n === null ? null : Number(r.n)]));
  return defs.map((t) => ({ ...t, rows: count.get(t.name) ?? null }));
}

/** Distinct values of a column (at most limit), for foreign keys and unique columns. */
async function values(connId, db, table, column, limit = 50000) {
  const rows = await server.meta(connId, `SELECT DISTINCT ${qi(column)} AS v FROM ${qi(db)}.${qi(table)} WHERE ${qi(column)} IS NOT NULL LIMIT ${Number(limit)}`);
  return rows.map((r) => plain(r.v));
}

/** Empties the tables (children first) with foreign key checks off on one connection. */
async function clear(connId, db, list, truncate) {
  await server.withConnection(connId, async (c) => {
    try {
      await c.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const t of list) await c.query(`${truncate ? 'TRUNCATE TABLE' : 'DELETE FROM'} ${qi(db)}.${qi(t)}`);
    } catch (err) {
      throw new server.DbError(err);
    } finally {
      await c.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
    }
  });
}

/** Existing tuples of a composite key, values joined by \u001f (the generator's format). */
async function tuples(connId, db, table, columns, limit = 500000) {
  const rows = await server.meta(connId, `SELECT CONCAT_WS(CHAR(31), ${columns.map(qi).join(', ')}) AS k FROM ${qi(db)}.${qi(table)} LIMIT ${Number(limit)}`);
  return rows.map((r) => plain(r.k));
}

async function counts(connId, db, list) {
  const out = {};
  for (const t of list) {
    const [r] = await server.meta(connId, `SELECT COUNT(*) AS n FROM ${qi(db)}.${qi(t)}`);
    out[t] = Number(r.n);
  }
  return out;
}

module.exports = { tables, values, tuples, clear, counts };
