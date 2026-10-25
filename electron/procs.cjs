// Process manager: threads, open InnoDB transactions, row lock waits and metadata locks of a server, plus
// the plan of a running statement and the latest deadlock. Every source is optional: what the account cannot
// read (no PROCESS privilege, performance_schema off, MariaDB without METADATA_LOCK_INFO) is reported in
// `missing` and the rest still works. Queries carry the monitor tag so they stay out of the list.
const server = require('./server.cjs');
const { t } = require('./i18n.cjs');

const TAG = server.MONITOR_TAG;

const num = (v) => (v === null || v === undefined ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);
const get = (r, k) => r[k] ?? r[k.toLowerCase()] ?? r[k.toUpperCase()];

async function rows(p, sql, params = []) {
  return Array.from(await p.query({ sql: `${TAG} ${sql}`, rowsAsArray: false }, params));
}

/** One poll of everything the manager shows. */
async function snapshot(connId) {
  const missing = [];
  const out = { at: Date.now(), flavor: 'mysql', version: '', processes: [], trx: [], lockWaits: [], mdl: [], missing };
  await server.withConnection(connId, async (c) => {
    const [[v]] = await c.query({ sql: `${TAG} SELECT VERSION()`, rowsAsArray: true });
    out.version = v;
    out.flavor = /mariadb/i.test(v) ? 'mariadb' : 'mysql';
    let ownId = null;
    try { [[ownId]] = await c.query({ sql: `${TAG} SELECT CONNECTION_ID()`, rowsAsArray: true }); } catch { /* ignore */ }

    try {
      out.processes = (await rows(c, 'SELECT * FROM information_schema.PROCESSLIST'))
        .filter((r) => Number(get(r, 'ID')) !== Number(ownId) && !String(get(r, 'INFO') ?? '').startsWith(TAG))
        .map((r) => ({
          id: Number(get(r, 'ID')),
          user: str(get(r, 'USER')) ?? '',
          host: str(get(r, 'HOST')) ?? '',
          db: str(get(r, 'DB')),
          command: str(get(r, 'COMMAND')) ?? '',
          time: Number(get(r, 'TIME') ?? 0),
          timeMs: r.TIME_MS !== undefined ? Number(r.TIME_MS) : null,
          state: str(get(r, 'STATE')),
          info: str(get(r, 'INFO')),
          progress: r.PROGRESS !== undefined ? Number(r.PROGRESS) : null,
        }));
    } catch (err) { throw new server.DbError(err); }

    try {
      out.trx = (await rows(c, `SELECT trx_id, trx_state, trx_started, trx_wait_started, trx_mysql_thread_id, trx_query, trx_operation_state,
          trx_tables_in_use, trx_tables_locked, trx_rows_locked, trx_rows_modified, trx_isolation_level,
          TIMESTAMPDIFF(SECOND, trx_started, NOW()) AS age, TIMESTAMPDIFF(SECOND, trx_wait_started, NOW()) AS wait_age
        FROM information_schema.INNODB_TRX`)).map((r) => ({
        id: str(r.trx_id), state: str(r.trx_state), started: iso(r.trx_started), age: num(r.age), waitAge: num(r.wait_age),
        thread: num(r.trx_mysql_thread_id), query: str(r.trx_query), operation: str(r.trx_operation_state),
        tablesInUse: num(r.trx_tables_in_use), tablesLocked: num(r.trx_tables_locked), rowsLocked: num(r.trx_rows_locked),
        rowsModified: num(r.trx_rows_modified), isolation: str(r.trx_isolation_level),
      }));
    } catch (err) { missing.push({ what: 'trx', message: new server.DbError(err).message }); }

    // row lock waits: who waits for whom, on which table/index
    try {
      if (out.flavor === 'mariadb') {
        out.lockWaits = (await rows(c, `SELECT w.requesting_trx_id AS waiting, w.blocking_trx_id AS blocking,
            l.lock_table AS tbl, l.lock_index AS idx, l.lock_mode AS mode, l.lock_type AS type, l.lock_data AS data
          FROM information_schema.INNODB_LOCK_WAITS w LEFT JOIN information_schema.INNODB_LOCKS l ON l.lock_id = w.requested_lock_id`))
          .map((r) => ({ waiting: str(r.waiting), blocking: str(r.blocking), table: str(r.tbl), index: str(r.idx), mode: str(r.mode), type: str(r.type), data: str(r.data) }));
      } else {
        out.lockWaits = (await rows(c, `SELECT w.REQUESTING_ENGINE_TRANSACTION_ID AS waiting, w.BLOCKING_ENGINE_TRANSACTION_ID AS blocking,
            l.OBJECT_SCHEMA AS sch, l.OBJECT_NAME AS tbl, l.INDEX_NAME AS idx, l.LOCK_MODE AS mode, l.LOCK_TYPE AS type, l.LOCK_DATA AS data
          FROM performance_schema.data_lock_waits w LEFT JOIN performance_schema.data_locks l ON l.ENGINE_LOCK_ID = w.REQUESTING_ENGINE_LOCK_ID`))
          .map((r) => ({ waiting: str(r.waiting), blocking: str(r.blocking), table: r.sch ? `\`${r.sch}\`.\`${r.tbl}\`` : str(r.tbl), index: str(r.idx), mode: str(r.mode), type: str(r.type), data: str(r.data) }));
      }
    } catch (err) { missing.push({ what: 'locks', message: new server.DbError(err).message }); }

    // metadata locks (ALTER TABLE waiting behind an open transaction, …)
    try {
      if (out.flavor === 'mariadb') {
        out.mdl = (await rows(c, 'SELECT THREAD_ID AS thread, LOCK_MODE AS mode, LOCK_DURATION AS duration, LOCK_TYPE AS type, TABLE_SCHEMA AS sch, TABLE_NAME AS tbl FROM information_schema.METADATA_LOCK_INFO'))
          .map((r) => ({ thread: Number(r.thread), mode: str(r.mode), duration: str(r.duration), type: str(r.type), schema: str(r.sch), name: str(r.tbl), status: 'GRANTED' }));
      } else {
        out.mdl = (await rows(c, `SELECT t.PROCESSLIST_ID AS thread, m.LOCK_TYPE AS mode, m.LOCK_DURATION AS duration, m.OBJECT_TYPE AS type,
            m.OBJECT_SCHEMA AS sch, m.OBJECT_NAME AS tbl, m.LOCK_STATUS AS status
          FROM performance_schema.metadata_locks m JOIN performance_schema.threads t ON t.THREAD_ID = m.OWNER_THREAD_ID
          WHERE m.OBJECT_TYPE IN ('TABLE', 'SCHEMA', 'FUNCTION', 'PROCEDURE', 'TRIGGER', 'EVENT') AND t.PROCESSLIST_ID IS NOT NULL`))
          .map((r) => ({ thread: Number(r.thread), mode: str(r.mode), duration: str(r.duration), type: str(r.type), schema: str(r.sch), name: str(r.tbl), status: str(r.status) }));
      }
      out.mdl = out.mdl.filter((m) => m.thread !== Number(ownId));
    } catch (err) {
      missing.push({ what: 'mdl', message: out.flavor === 'mariadb'
        ? t('Senza il plugin METADATA_LOCK_INFO chi blocca un lock di metadati viene dedotto dalle transazioni aperte; per vederlo con esattezza: INSTALL SONAME \'metadata_lock_info\'.')
        : new server.DbError(err).message });
    }
  });
  return out;
}

/** Plan of the statement a thread is running (SHOW EXPLAIN FOR on MariaDB, EXPLAIN FOR CONNECTION on MySQL). */
async function explainFor(connId, id, flavor) {
  const sql = flavor === 'mariadb' ? `SHOW EXPLAIN FOR ${Number(id)}` : `EXPLAIN FOR CONNECTION ${Number(id)}`;
  return server.withConnection(connId, async (c) => {
    try {
      const res = await c.query({ sql: `${TAG} ${sql}`, rowsAsArray: true });
      return { columns: res.meta.map((m) => m.name()), rows: Array.from(res).map((r) => r.map((v) => str(v))) };
    } catch (err) { throw new server.DbError(err); }
  });
}

/** KILL [QUERY] of several threads; returns the ones that failed with the reason. */
async function kill(connId, ids, queryOnly) {
  const failed = [];
  await server.withConnection(connId, async (c) => {
    for (const id of ids) {
      try { await c.query(`KILL ${queryOnly ? 'QUERY ' : ''}${Number(id)}`); } catch (err) { failed.push({ id, message: new server.DbError(err).message }); }
    }
  });
  return { killed: ids.length - failed.length, failed };
}

/** SHOW ENGINE INNODB STATUS text (needs PROCESS). */
async function innodbStatus(connId) {
  const [r] = await server.meta(connId, `${TAG} SHOW ENGINE INNODB STATUS`);
  return str(r?.Status) ?? '';
}

/** MariaDB: the plugin that lists metadata locks (information_schema.METADATA_LOCK_INFO). */
async function installMdlPlugin(connId) {
  await server.runStatements(connId, ["INSTALL SONAME 'metadata_lock_info'"]);
}

module.exports = { snapshot, explainFor, kill, innodbStatus, installMdlPlugin };
