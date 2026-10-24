// Data compare of one table between two databases (any connections): target rows go in a map keyed by
// primary key, source rows stream past it. Produces counts, a sample of differences and the parameterized
// statements that make the target equal to the source (run with server.apply, in one transaction).
const server = require('./server.cjs');

const MAX_ROWS = 1000000;      // per side: the target is held in memory
const MAX_STATEMENTS = 200000; // beyond this the sync script is not produced
const MAX_DETAILS = 1000;

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';

/**
 * @param src/tgt {connId, db}
 * @param key primary key column names, columns compared (both sides, no generated columns)
 */
async function compareTable(src, tgt, table, key, columns) {
  const select = `SELECT ${columns.map(qi).join(', ')} FROM ${qi(table)}`;
  const keyAt = key.map((k) => columns.indexOf(k));
  const keyOf = (r) => JSON.stringify(keyAt.map((i) => r[i]));
  let binary = [];

  const target = new Map();
  await server.streamQuery(tgt.connId, tgt.db, select, (cols) => { binary = cols.map((c) => c.binary); }, (row) => {
    if (target.size >= MAX_ROWS) throw new Error(`${table}: più di ${MAX_ROWS.toLocaleString('it-IT')} righe, confronto non supportato.`);
    target.set(keyOf(row), row);
  });

  // binary values travel as 0x… hex: compared as text, written back with UNHEX
  const ph = (i) => (binary[i] ? 'UNHEX(?)' : '?');
  const val = (v, i) => (binary[i] && typeof v === 'string' && v.startsWith('0x') ? v.slice(2) : v);
  const full = `${qi(tgt.db)}.${qi(table)}`;
  const where = key.map((k) => `${qi(k)} = ${ph(columns.indexOf(k))}`).join(' AND ');
  const keyParams = (r) => keyAt.map((i) => val(r[i], i));

  const res = { table, equal: 0, diff: 0, source: 0, target: 0, details: [], statements: [], scriptTooLarge: false };
  const stmt = (s) => {
    if (res.statements.length >= MAX_STATEMENTS) { res.scriptTooLarge = true; return; }
    res.statements.push(s);
  };
  const detail = (d) => { if (res.details.length < MAX_DETAILS) res.details.push(d); };

  await server.streamQuery(src.connId, src.db, select, () => {}, (row) => {
    const k = keyOf(row);
    const t = target.get(k);
    if (!t) {
      res.source++;
      detail({ status: 'source', row, diff: [] });
      stmt({ sql: `INSERT INTO ${full} (${columns.map(qi).join(', ')}) VALUES (${columns.map((_, i) => ph(i)).join(', ')})`, params: row.map(val) });
      return;
    }
    target.delete(k);
    const changed = [];
    row.forEach((v, i) => { if (v !== t[i] && String(v) !== String(t[i])) changed.push(i); });
    if (!changed.length) { res.equal++; return; }
    res.diff++;
    detail({ status: 'diff', row, old: t, diff: changed });
    stmt({
      sql: `UPDATE ${full} SET ${changed.map((i) => `${qi(columns[i])} = ${ph(i)}`).join(', ')} WHERE ${where} LIMIT 1`,
      params: [...changed.map((i) => val(row[i], i)), ...keyParams(t)],
      expectOne: true,
    });
  });

  for (const t of target.values()) {
    res.target++;
    detail({ status: 'target', row: t, diff: [] });
    stmt({ sql: `DELETE FROM ${full} WHERE ${where} LIMIT 1`, params: keyParams(t), expectOne: true });
  }
  if (res.scriptTooLarge) res.statements = [];
  return res;
}

module.exports = { compareTable };
