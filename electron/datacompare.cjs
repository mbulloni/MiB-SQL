// Data compare of one table between two databases (any connections), in constant memory: the source is
// read in primary-key chunks (keyset pagination), and for each chunk the target rows in the same key range
// are streamed past it. Ranges are evaluated by the servers (their collations), never by JavaScript.
// Produces counts, a sample of differences and the parameterized statements that make the target equal
// to the source (run with server.apply, in one transaction).
const server = require('./server.cjs');

const CHUNK = 5000;
const MAX_STATEMENTS = 200000; // beyond this the sync script is not produced
const MAX_DETAILS = 1000;

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';

/**
 * @param src/tgt {connId, db}
 * @param key primary key column names, columns compared (both sides, no generated or spatial columns)
 * @param onProgress({ table, rows })
 */
async function compareTable(src, tgt, table, key, columns, onProgress = () => {}) {
  const keyAt = key.map((k) => columns.indexOf(k));
  const keyOf = (r) => JSON.stringify(keyAt.map((i) => r[i]));
  const list = columns.map(qi).join(', ');
  const order = key.map(qi).join(', ');
  let binary = columns.map(() => false);

  // binary values travel as 0x… hex: compared as text, bound and written back with UNHEX
  const ph = (i) => (binary[i] ? 'UNHEX(?)' : '?');
  const val = (v, i) => (binary[i] && typeof v === 'string' && v.startsWith('0x') ? v.slice(2) : v);
  const keyParams = (r) => keyAt.map((i) => val(r[i], i));
  /** (k1, k2…) > (row's key), expanded so the primary key index is used: (k1 > ?) OR (k1 = ? AND k2 > ?)… */
  const after = (r) => {
    const sql = [];
    const params = [];
    key.forEach((k, n) => {
      const conds = [];
      for (let j = 0; j < n; j++) { conds.push(`${qi(key[j])} = ${ph(keyAt[j])}`); params.push(val(r[keyAt[j]], keyAt[j])); }
      conds.push(`${qi(k)} > ${ph(keyAt[n])}`);
      params.push(val(r[keyAt[n]], keyAt[n]));
      sql.push(`(${conds.join(' AND ')})`);
    });
    return { sql: `(${sql.join(' OR ')})`, params };
  };

  const full = `${qi(tgt.db)}.${qi(table)}`;
  // built on use: which columns are binary is known only after the first chunk
  const where = () => key.map((k) => `${qi(k)} = ${ph(columns.indexOf(k))}`).join(' AND ');
  const res = { table, equal: 0, diff: 0, source: 0, target: 0, details: [], statements: [], scriptTooLarge: false };
  const stmt = (s) => {
    if (res.statements.length >= MAX_STATEMENTS) { res.scriptTooLarge = true; return; }
    res.statements.push(s);
  };
  const detail = (d) => { if (res.details.length < MAX_DETAILS) res.details.push(d); };
  const onlySource = (row) => {
    res.source++;
    detail({ status: 'source', row, diff: [] });
    stmt({ sql: `INSERT INTO ${full} (${list}) VALUES (${columns.map((_, i) => ph(i)).join(', ')})`, params: row.map(val) });
  };
  const onlyTarget = (row) => {
    res.target++;
    detail({ status: 'target', row, diff: [] });
    stmt({ sql: `DELETE FROM ${full} WHERE ${where()} LIMIT 1`, params: keyParams(row), expectOne: true });
  };
  const both = (row, t) => {
    const changed = [];
    row.forEach((v, i) => { if (v !== t[i] && String(v) !== String(t[i])) changed.push(i); });
    if (!changed.length) { res.equal++; return; }
    res.diff++;
    detail({ status: 'diff', row, old: t, diff: changed });
    stmt({
      sql: `UPDATE ${full} SET ${changed.map((i) => `${qi(columns[i])} = ${ph(i)}`).join(', ')} WHERE ${where()} LIMIT 1`,
      params: [...changed.map((i) => val(row[i], i)), ...keyParams(t)],
      expectOne: true,
    });
  };

  await server.withConnection(src.connId, (sc) => server.withConnection(tgt.connId, async (tc) => {
    const norm = (r) => r.map((v) => server.cell(v, Infinity));
    const streamTarget = async (cond, onRow) => {
      const s = tc.queryStream({ sql: `SELECT ${list} FROM ${qi(tgt.db)}.${qi(table)}${cond.sql ? ` WHERE ${cond.sql}` : ''} ORDER BY ${order}`, rowsAsArray: true }, cond.params);
      for await (const r of s) onRow(norm(r));
    };
    let last = null; // key row of the previous chunk's end
    let done = 0;
    for (;;) {
      const lo = last ? after(last) : null;
      const chunk = await sc.query({ sql: `SELECT ${list} FROM ${qi(src.db)}.${qi(table)}${lo ? ` WHERE ${lo.sql}` : ''} ORDER BY ${order} LIMIT ${CHUNK}`, rowsAsArray: true }, lo?.params ?? []);
      if (!last && chunk.meta) binary = chunk.meta.map((m) => server.column(m).binary);
      const rows = Array.from(chunk).map(norm);
      if (!rows.length) break;
      const hi = rows[rows.length - 1];
      const pending = new Map(rows.map((r) => [keyOf(r), r]));
      // target rows in (last, hi]: matched against the chunk, the others exist only in the target
      const upper = after(hi);
      const cond = lo ? { sql: `${lo.sql} AND NOT ${upper.sql}`, params: [...lo.params, ...upper.params] } : { sql: `NOT ${upper.sql}`, params: upper.params };
      await streamTarget(cond, (t) => {
        const k = keyOf(t);
        const s = pending.get(k);
        if (s) { pending.delete(k); both(s, t); } else onlyTarget(t);
      });
      for (const r of pending.values()) onlySource(r);
      done += rows.length;
      onProgress({ table, rows: done });
      last = hi;
      if (rows.length < CHUNK) break;
    }
    // what the target has after the last source key (or everything, if the source is empty)
    await streamTarget(last ? after(last) : { sql: '', params: [] }, onlyTarget);
  }));

  if (res.scriptTooLarge) res.statements = [];
  return res;
}

module.exports = { compareTable, CHUNK };
