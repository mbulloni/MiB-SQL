// Table maintenance: sizes and fragmentation from information_schema.TABLES, and ANALYZE / OPTIMIZE /
// CHECK / REPAIR / CHECKSUM TABLE run one table at a time (progress, stop between tables) with the
// server's result rows (Msg_type, Msg_text) kept as they are.
const server = require('./server.cjs');
const { t } = require('./i18n.cjs');

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';

const OPS = {
  analyze: { sql: 'ANALYZE', options: ['', 'PERSISTENT FOR ALL'], binlog: true },
  optimize: { sql: 'OPTIMIZE', options: [''], binlog: true },
  check: { sql: 'CHECK', options: ['', 'QUICK', 'FAST', 'MEDIUM', 'EXTENDED', 'CHANGED', 'FOR UPGRADE'], binlog: false },
  repair: { sql: 'REPAIR', options: ['', 'QUICK', 'EXTENDED', 'USE_FRM'], binlog: true },
  checksum: { sql: 'CHECKSUM', options: ['', 'QUICK', 'EXTENDED'], binlog: false },
};

const num = (v) => (v === null || v === undefined ? null : Number(v));
const date = (v) => (v ? new Date(v).toISOString() : null);

async function tableStats(connId, db) {
  const rows = await server.meta(connId, `SELECT TABLE_NAME AS name, ENGINE AS engine, ROW_FORMAT AS rowFormat, TABLE_ROWS AS \`rows\`,
      DATA_LENGTH AS data, INDEX_LENGTH AS idx, DATA_FREE AS free, AUTO_INCREMENT AS autoInc, TABLE_COLLATION AS collation,
      CREATE_TIME AS created, UPDATE_TIME AS updated, CHECK_TIME AS checked, TABLE_COMMENT AS comment
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE IN ('BASE TABLE', 'SYSTEM VERSIONED') ORDER BY TABLE_NAME`, [db]);
  return rows.map((r) => ({
    name: r.name, engine: r.engine, rowFormat: r.rowFormat, rows: num(r.rows), data: num(r.data), idx: num(r.idx), free: num(r.free),
    autoInc: num(r.autoInc), collation: r.collation, created: date(r.created), updated: date(r.updated), checked: date(r.checked), comment: r.comment,
  }));
}

const active = new Map(); // task id -> { stop }

/**
 * Runs op on each table. option: one of OPS[op].options; local: NO_WRITE_TO_BINLOG (not replicated).
 * @returns {{ results: { table, op, type, text, ms }[], stopped: boolean }}
 */
async function run(id, connId, db, tables, op, { option = '', local = false } = {}, onProgress = () => {}) {
  const o = OPS[op];
  if (!o) throw new Error(t('Operazione sconosciuta: {0}', op));
  if (!o.options.includes(option)) throw new Error(t('Opzione non valida per {0}: {1}', o.sql, option));
  const task = { stop: false };
  active.set(id, task);
  const results = [];
  try {
    await server.withConnection(connId, async (c) => {
      for (let n = 0; n < tables.length && !task.stop; n++) {
        const t = tables[n];
        onProgress({ done: n, total: tables.length, table: t });
        const sql = `${o.sql}${local && o.binlog ? ' NO_WRITE_TO_BINLOG' : ''} TABLE ${qi(db)}.${qi(t)}${option ? ` ${option}` : ''}`;
        const t0 = Date.now();
        try {
          const rows = Array.from(await c.query({ sql, rowsAsArray: false }));
          const ms = Date.now() - t0;
          if (op === 'checksum') results.push({ table: t, op, type: rows[0]?.Checksum === null ? 'warning' : 'checksum', text: rows[0]?.Checksum === null ? t('Tabella inesistente o non leggibile') : String(rows[0]?.Checksum), ms });
          else for (const r of rows) results.push({ table: t, op: r.Op ?? op, type: r.Msg_type, text: r.Msg_text, ms });
        } catch (err) {
          results.push({ table: t, op, type: 'error', text: new server.DbError(err).message, ms: Date.now() - t0 });
        }
      }
      onProgress({ done: tables.length, total: tables.length, table: null });
    });
  } finally {
    active.delete(id);
  }
  return { results, stopped: task.stop };
}

/** Stops after the table being processed (a running OPTIMIZE or CHECK is not interrupted). */
function stop(id) {
  const t = active.get(id);
  if (t) t.stop = true;
}

module.exports = { tableStats, run, stop, OPS };
