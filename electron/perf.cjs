// Performance center: server status and variables for the advisor, heaviest statements (performance_schema
// digests, or the slow query log when it is written to a table), index statistics and usage of a database,
// EXPLAIN of a query, SET GLOBAL / SET PERSIST of a variable. Analysis happens in the renderer (src/advisor.ts,
// src/indexes.ts, src/queryadvisor.ts); here only reads, with every optional source failing soft.
const server = require('./server.cjs');
const { t } = require('./i18n.cjs');

const TAG = server.MONITOR_TAG;
const SYSTEM_DBS = "('mysql', 'information_schema', 'performance_schema', 'sys')";

const num = (v) => (v === null || v === undefined ? null : Number(v));
const str = (v) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);

async function q(c, sql, params = []) {
  return Array.from(await c.query({ sql: `${TAG} ${sql}`, rowsAsArray: false }, params));
}
async function soft(c, sql, params) {
  try { return await q(c, sql, params); } catch { return null; }
}
const kv = (rows) => Object.fromEntries(rows.map((r) => [r.Variable_name, str(r.Value)]));

/** Everything the advisor looks at, in one round trip per source. */
async function overview(connId) {
  return server.withConnection(connId, async (c) => {
    try {
      const status = kv(await q(c, 'SHOW GLOBAL STATUS'));
      const variables = kv(await q(c, 'SHOW GLOBAL VARIABLES'));
      const engines = (await q(c, `SELECT ENGINE AS engine, COUNT(*) AS n, SUM(DATA_LENGTH) AS data, SUM(INDEX_LENGTH) AS idx, SUM(DATA_FREE) AS free
        FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN ${SYSTEM_DBS} GROUP BY ENGINE`))
        .map((r) => ({ engine: str(r.engine) ?? '', tables: Number(r.n), data: Number(r.data ?? 0), idx: Number(r.idx ?? 0), free: Number(r.free ?? 0) }));
      const noPk = ((await soft(c, `SELECT t.TABLE_SCHEMA AS db, t.TABLE_NAME AS name, t.ENGINE AS engine, t.TABLE_ROWS AS \`rows\`
        FROM information_schema.TABLES t LEFT JOIN information_schema.TABLE_CONSTRAINTS k
          ON k.TABLE_SCHEMA = t.TABLE_SCHEMA AND k.TABLE_NAME = t.TABLE_NAME AND k.CONSTRAINT_TYPE = 'PRIMARY KEY'
        WHERE t.TABLE_TYPE = 'BASE TABLE' AND t.TABLE_SCHEMA NOT IN ${SYSTEM_DBS} AND k.CONSTRAINT_NAME IS NULL
        ORDER BY t.TABLE_ROWS DESC LIMIT 200`)) ?? []).map((r) => ({ db: str(r.db), name: str(r.name), engine: str(r.engine), rows: num(r.rows) }));
      const fragmented = ((await soft(c, `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, ENGINE AS engine, DATA_LENGTH + INDEX_LENGTH AS size, DATA_FREE AS free
        FROM information_schema.TABLES WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN ${SYSTEM_DBS}
          AND DATA_FREE > 10485760 AND DATA_FREE > 0.2 * (DATA_LENGTH + INDEX_LENGTH + DATA_FREE)
        ORDER BY DATA_FREE DESC LIMIT 100`)) ?? []).map((r) => ({ db: str(r.db), name: str(r.name), engine: str(r.engine), size: Number(r.size), free: Number(r.free) }));
      const myisam = ((await soft(c, `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS name, DATA_LENGTH + INDEX_LENGTH AS size FROM information_schema.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' AND ENGINE = 'MyISAM' AND TABLE_SCHEMA NOT IN ${SYSTEM_DBS} ORDER BY size DESC LIMIT 100`)) ?? [])
        .map((r) => ({ db: str(r.db), name: str(r.name), size: Number(r.size) }));
      // MySQL counts deadlocks only in INNODB_METRICS (MariaDB also has Innodb_deadlocks in the status)
      const dl = await soft(c, "SELECT `COUNT` AS n FROM information_schema.INNODB_METRICS WHERE NAME = 'lock_deadlocks'");
      return { at: Date.now(), status, variables, engines, noPk, fragmented, myisam, deadlocks: dl?.length ? Number(dl[0].n) : null };
    } catch (err) { throw new server.DbError(err); }
  });
}

const DIGEST_COLS = `SCHEMA_NAME AS db, DIGEST AS digest, DIGEST_TEXT AS text, COUNT_STAR AS count, SUM_TIMER_WAIT AS total, MAX_TIMER_WAIT AS max,
  SUM_LOCK_TIME AS lockTime, SUM_ROWS_EXAMINED AS examined, SUM_ROWS_SENT AS sent, SUM_ROWS_AFFECTED AS affected,
  SUM_CREATED_TMP_DISK_TABLES AS tmpDisk, SUM_CREATED_TMP_TABLES AS tmp, SUM_SORT_MERGE_PASSES AS mergePasses, SUM_SELECT_FULL_JOIN AS fullJoin,
  SUM_SELECT_SCAN AS scans, SUM_NO_INDEX_USED AS noIndex, SUM_NO_GOOD_INDEX_USED AS noGoodIndex, SUM_ERRORS AS errors, FIRST_SEEN AS firstSeen, LAST_SEEN AS lastSeen`;

/** Where heavy statements can be read from, and how the slow log is configured. */
async function topSources(c) {
  const vars = kv(await q(c, "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('performance_schema', 'slow_query_log', 'log_output', 'long_query_time', 'version')"));
  const digest = vars.performance_schema === 'ON' && !!(await soft(c, 'SELECT 1 FROM performance_schema.events_statements_summary_by_digest LIMIT 1'));
  const slowTable = !!(await soft(c, 'SELECT 1 FROM mysql.slow_log LIMIT 1'));
  return {
    ps: vars.performance_schema === 'ON', digest, slowTable,
    slowLog: vars.slow_query_log === 'ON', logOutput: vars.log_output ?? '', longQueryTime: Number(vars.long_query_time ?? 10),
    flavor: /mariadb/i.test(vars.version ?? '') ? 'mariadb' : 'mysql',
  };
}

/**
 * Heaviest statements. source: 'digest' (performance_schema, normalized by the server) or 'slowlog'
 * (raw rows of mysql.slow_log, grouped in the renderer). Timer values are in picoseconds → ms.
 */
async function topQueries(connId, source, limit = 300) {
  return server.withConnection(connId, async (c) => {
    try {
      const sources = await topSources(c);
      let rows = [];
      if (source === 'digest' && sources.digest) {
        // MySQL 8 keeps a real statement per digest (QUERY_SAMPLE_TEXT), useful for EXPLAIN
        let res = await soft(c, `SELECT ${DIGEST_COLS}, QUERY_SAMPLE_TEXT AS sample FROM performance_schema.events_statements_summary_by_digest
          WHERE DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT ?`, [limit]);
        if (!res) res = await q(c, `SELECT ${DIGEST_COLS} FROM performance_schema.events_statements_summary_by_digest WHERE DIGEST_TEXT IS NOT NULL ORDER BY SUM_TIMER_WAIT DESC LIMIT ?`, [limit]);
        const ms = (v) => Number(v ?? 0) / 1e9;
        rows = res.map((r) => ({
          db: str(r.db), key: str(r.digest) ?? str(r.text), text: str(r.text) ?? '', sample: str(r.sample) ?? null, count: Number(r.count), totalMs: ms(r.total), maxMs: ms(r.max),
          lockMs: ms(r.lockTime), examined: Number(r.examined ?? 0), sent: Number(r.sent ?? 0), affected: Number(r.affected ?? 0),
          tmpDisk: Number(r.tmpDisk ?? 0), tmp: Number(r.tmp ?? 0), mergePasses: Number(r.mergePasses ?? 0), fullJoin: Number(r.fullJoin ?? 0), scans: Number(r.scans ?? 0),
          noIndex: Number(r.noIndex ?? 0) + Number(r.noGoodIndex ?? 0), errors: Number(r.errors ?? 0), firstSeen: iso(r.firstSeen), lastSeen: iso(r.lastSeen),
        }));
      } else if (source === 'slowlog' && sources.slowTable) {
        const sec = (v) => {
          if (v === null || v === undefined) return 0;
          if (typeof v === 'number') return v;
          const m = /^(-?)(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(v));
          return m ? (Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4])) * (m[1] ? -1 : 1) : Number(v) || 0;
        };
        rows = (await q(c, `SELECT start_time AS at, user_host AS who, query_time AS qt, lock_time AS lt, rows_sent AS sent, rows_examined AS examined, db, sql_text AS text
          FROM mysql.slow_log WHERE sql_text NOT LIKE '${TAG}%' ORDER BY start_time DESC LIMIT 20000`)).map((r) => ({
          at: iso(r.at), who: str(r.who), ms: sec(r.qt) * 1000, lockMs: sec(r.lt) * 1000, sent: Number(r.sent ?? 0), examined: Number(r.examined ?? 0), db: str(r.db), text: str(r.text) ?? '',
        }));
      }
      return { sources, rows };
    } catch (err) { throw new server.DbError(err); }
  });
}

async function resetTop(connId, source) {
  const sql = source === 'digest' ? 'TRUNCATE TABLE performance_schema.events_statements_summary_by_digest' : 'TRUNCATE TABLE mysql.slow_log';
  await server.runStatements(connId, [sql]);
}

/** Slow query log to a table (keeps the file output too), with the threshold in seconds. */
async function enableSlowLog(connId, seconds) {
  return server.withConnection(connId, async (c) => {
    try {
      const [{ v }] = await q(c, 'SELECT @@GLOBAL.log_output AS v');
      const out = new Set(String(v).split(',').map((s) => s.trim().toUpperCase()).filter((s) => s && s !== 'NONE'));
      out.add('TABLE');
      await c.query(`SET GLOBAL long_query_time = ${Number(seconds)}`);
      await c.query(`SET GLOBAL log_output = '${[...out].join(',')}'`);
      await c.query('SET GLOBAL slow_query_log = ON');
      return topSources(c);
    } catch (err) { throw new server.DbError(err); }
  });
}

/** Indexes, tables, foreign keys and (when the server tracks it) index usage of one database. */
async function indexData(connId, db) {
  return server.withConnection(connId, async (c) => {
    try {
      const stats = await q(c, 'SELECT * FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', [db]);
      const byKey = new Map();
      for (const r of stats) {
        const k = `${r.TABLE_NAME}\u0000${r.INDEX_NAME}`;
        let ix = byKey.get(k);
        if (!ix) {
          ix = {
            table: str(r.TABLE_NAME), name: str(r.INDEX_NAME), unique: Number(r.NON_UNIQUE) === 0, primary: r.INDEX_NAME === 'PRIMARY',
            type: str(r.INDEX_TYPE) ?? 'BTREE', cardinality: num(r.CARDINALITY), columns: [],
            visible: r.IS_VISIBLE !== undefined ? r.IS_VISIBLE === 'YES' : r.IGNORED !== undefined ? r.IGNORED !== 'YES' : true,
          };
          byKey.set(k, ix);
        }
        ix.columns.push({ name: str(r.COLUMN_NAME), expr: str(r.EXPRESSION ?? null), subPart: num(r.SUB_PART), nullable: r.NULLABLE === 'YES' });
        if (r.CARDINALITY !== null && r.CARDINALITY !== undefined) ix.cardinality = num(r.CARDINALITY);
      }
      const tables = (await q(c, `SELECT TABLE_NAME AS name, ENGINE AS engine, TABLE_ROWS AS \`rows\`, DATA_LENGTH AS data, INDEX_LENGTH AS idx
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [db]))
        .map((r) => ({ name: str(r.name), engine: str(r.engine), rows: num(r.rows), data: num(r.data), idx: num(r.idx) }));
      const columns = (await q(c, `SELECT TABLE_NAME AS t, COLUMN_NAME AS name, DATA_TYPE AS type, IS_NULLABLE AS nullable
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [db]))
        .map((r) => ({ table: str(r.t), name: str(r.name), type: str(r.type), nullable: r.nullable === 'YES' }));
      const fkRows = await q(c, `SELECT CONSTRAINT_NAME AS name, TABLE_NAME AS t, COLUMN_NAME AS col, ORDINAL_POSITION AS pos FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`, [db]);
      const fks = [];
      for (const r of fkRows) {
        const last = fks[fks.length - 1];
        if (last && last.table === r.t && last.name === r.name) last.columns.push(str(r.col));
        else fks.push({ table: str(r.t), name: str(r.name), columns: [str(r.col)] });
      }
      const vars = kv(await q(c, "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('performance_schema', 'userstat', 'version')"));
      const [{ up }] = await q(c, "SELECT VARIABLE_VALUE AS up FROM information_schema.GLOBAL_STATUS WHERE VARIABLE_NAME = 'UPTIME'").catch(() => [{ up: null }]);
      let usage = null;
      let source = null;
      if (vars.performance_schema === 'ON') {
        const r = await soft(c, `SELECT OBJECT_NAME AS t, INDEX_NAME AS i, COUNT_STAR AS n, COUNT_READ AS nread
          FROM performance_schema.table_io_waits_summary_by_index_usage WHERE OBJECT_SCHEMA = ?`, [db]);
        if (r) { usage = r.map((x) => ({ table: str(x.t), index: str(x.i), count: Number(x.n ?? 0), reads: Number(x.nread ?? 0) })); source = 'ps'; }
      }
      if (!usage && vars.userstat === 'ON') {
        const r = await soft(c, 'SELECT TABLE_NAME AS t, INDEX_NAME AS i, ROWS_READ AS n FROM information_schema.INDEX_STATISTICS WHERE TABLE_SCHEMA = ?', [db]);
        const tr = await soft(c, 'SELECT TABLE_NAME AS t, ROWS_READ AS n FROM information_schema.TABLE_STATISTICS WHERE TABLE_SCHEMA = ?', [db]);
        if (r) {
          usage = r.map((x) => ({ table: str(x.t), index: str(x.i), count: Number(x.n ?? 0), reads: Number(x.n ?? 0) }));
          // rows read through no index = table rows read minus rows read through its indexes
          for (const x of tr ?? []) {
            const viaIdx = usage.filter((u) => u.table === str(x.t)).reduce((n, u) => n + u.reads, 0);
            usage.push({ table: str(x.t), index: null, count: Math.max(0, Number(x.n ?? 0) - viaIdx), reads: Math.max(0, Number(x.n ?? 0) - viaIdx) });
          }
          source = 'userstat';
        }
      }
      return {
        db, indexes: [...byKey.values()], tables, columns, fks, usage, usageSource: source, uptime: num(up),
        flavor: /mariadb/i.test(vars.version ?? '') ? 'mariadb' : 'mysql', userstatAvailable: vars.userstat !== undefined, ps: vars.performance_schema === 'ON',
      };
    } catch (err) { throw new server.DbError(err); }
  });
}

const VAR_NAME = /^[a-z][a-z0-9_]*$/i;

/** SET GLOBAL (or SET PERSIST on MySQL 8) of one variable; returns the value the server now reports. */
async function setVariable(connId, name, value, persist) {
  if (!VAR_NAME.test(name)) throw new Error(t('Nome di variabile non valido: {0}', name));
  const v = String(value).trim();
  const literal = /^-?\d+(\.\d+)?$/.test(v) ? v : /^(ON|OFF|DEFAULT|TRUE|FALSE)$/i.test(v) ? v.toUpperCase() : `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
  return server.withConnection(connId, async (c) => {
    try {
      await c.query(`SET ${persist ? 'PERSIST' : 'GLOBAL'} ${name} = ${literal}`);
      const [r] = await q(c, `SHOW GLOBAL VARIABLES LIKE ?`, [name]);
      return str(r?.Value);
    } catch (err) { throw new server.DbError(err); }
  });
}

/** EXPLAIN of a statement on the given database (EXPLAIN never runs it). */
async function explain(connId, db, sql) {
  return server.withDedicated(connId, db ? { database: db } : {}, async (c) => {
    try {
      const res = await c.query({ sql: `EXPLAIN ${sql}`, rowsAsArray: false });
      return Array.from(res).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), typeof v === 'bigint' ? Number(v) : v])));
    } catch (err) { throw new server.DbError(err); }
  });
}

module.exports = { overview, topQueries, resetTop, enableSlowLog, indexData, setVariable, explain };
