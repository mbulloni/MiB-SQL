// Server logs: error log, slow query log, general log. Sources, first that works:
//  - error log: performance_schema.error_log (MySQL 8.0.22+), the file named by log_error (read directly when
//    the server is on this computer, else LOAD_FILE), the systemd journal when log_error is empty (local server);
//  - slow / general log: the mysql.slow_log / mysql.general_log tables when log_output has TABLE, else the file.
// Parsing happens in the renderer (src/logs.ts).
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const server = require('./server.cjs');
const connections = require('./connections.cjs');
const { t } = require('./i18n.cjs');

const TAG = server.MONITOR_TAG;
const MAX_BYTES = 4 * 1024 * 1024;
const str = (v) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const iso = (v) => (v ? new Date(v).toISOString() : null);

/** Connection to a server running on this computer (direct files and journal are readable then). */
function isLocal(connId) {
  const def = connections.get(connId);
  if (!def || def.ssh?.enabled) return false;
  return !!def.socket || ['localhost', '127.0.0.1', '::1'].includes(String(def.host).toLowerCase());
}

async function vars(connId) {
  const rows = await server.meta(connId, `${TAG} SHOW GLOBAL VARIABLES WHERE Variable_name IN ('log_error', 'log_output', 'slow_query_log', 'slow_query_log_file',
    'general_log', 'general_log_file', 'long_query_time', 'datadir', 'version', 'log_warnings', 'log_error_verbosity', 'secure_file_priv')`);
  return Object.fromEntries(rows.map((r) => [r.Variable_name, str(r.Value)]));
}

const resolveFile = (file, datadir) => (!file ? null : path.isAbsolute(file) ? file : path.join(datadir || '', file));

/** Last maxBytes of a file: directly when local and readable, else through LOAD_FILE (FILE privilege, secure_file_priv). */
async function tail(connId, file, local, maxBytes = MAX_BYTES) {
  if (local) {
    try {
      const st = fs.statSync(file);
      const fd = fs.openSync(file, 'r');
      const len = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      return { text: buf.toString('utf8'), source: 'file', truncated: st.size > len, size: st.size };
    } catch (err) {
      if (err.code !== 'EACCES' && err.code !== 'ENOENT' && err.code !== 'EPERM') throw err;
    }
  }
  try {
    const [r] = await server.meta(connId, `${TAG} SELECT LENGTH(LOAD_FILE(?)) AS n`, [file]);
    if (r?.n === null || r?.n === undefined) return null;
    const n = Number(r.n);
    const from = Math.max(1, n - maxBytes + 1);
    const [x] = await server.meta(connId, `${TAG} SELECT SUBSTRING(LOAD_FILE(?), ?) AS v`, [file, from]);
    return { text: str(x.v) ?? '', source: 'load_file', truncated: from > 1, size: n };
  } catch {
    return null;
  }
}

function journal(lines) {
  return new Promise((resolve) => {
    execFile('journalctl', ['-u', 'mariadb', '-u', 'mysql', '-u', 'mysqld', '-n', String(lines), '-o', 'short-iso', '--no-pager'], { maxBuffer: MAX_BYTES * 2 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function status(connId) {
  const v = await vars(connId);
  return { ...v, local: isLocal(connId), mariadb: /mariadb/i.test(v.version ?? '') };
}

async function errorLog(connId, limit = 3000) {
  const v = await status(connId);
  // MySQL 8.0.22+: the error log as a table
  if (!v.mariadb) {
    try {
      const rows = await server.meta(connId, `${TAG} SELECT LOGGED AS at, THREAD_ID AS thread, PRIO AS prio, ERROR_CODE AS code, SUBSYSTEM AS sub, DATA AS msg
        FROM performance_schema.error_log ORDER BY LOGGED DESC LIMIT ?`, [limit]);
      return { status: v, source: 'table', entries: rows.reverse().map((r) => ({ at: iso(r.at), thread: Number(r.thread ?? 0), level: str(r.prio), code: str(r.code), subsystem: str(r.sub), message: str(r.msg) ?? '' })) };
    } catch { /* older server or no access */ }
  }
  const file = v.log_error && v.log_error !== 'stderr' ? resolveFile(v.log_error, v.datadir) : null;
  if (file) {
    const r = await tail(connId, file, v.local);
    if (r) return { status: v, source: r.source, path: file, text: r.text, truncated: r.truncated };
  }
  if (v.local && (!v.log_error || v.log_error === 'stderr')) {
    const text = await journal(limit);
    if (text) return { status: v, source: 'journal', text };
  }
  return {
    status: v, source: null, path: file,
    reason: !v.log_error || v.log_error === 'stderr'
      ? t('Il server scrive il log degli errori sullo standard error (di solito nel journal di systemd): leggibile solo se il server è su questo computer (journalctl -u mariadb).')
      : t('Il file {0} non è leggibile: serve il privilegio FILE con secure_file_priv che lo permetta, oppure un server su questo computer con permessi di lettura sul file.', file),
  };
}

/** Slow or general log: table rows, or the file text. */
async function queryLog(connId, which, limit = 3000) {
  const v = await status(connId);
  const on = (which === 'slow' ? v.slow_query_log : v.general_log) === 'ON';
  const toTable = /TABLE/i.test(v.log_output ?? '');
  if (toTable) {
    try {
      const rows = which === 'slow'
        ? await server.meta(connId, `${TAG} SELECT start_time AS at, user_host AS who, query_time AS qt, lock_time AS lt, rows_sent AS sent, rows_examined AS examined, db, thread_id AS thread, sql_text AS text
            FROM mysql.slow_log WHERE sql_text NOT LIKE '${TAG}%' ORDER BY start_time DESC LIMIT ?`, [limit])
        : await server.meta(connId, `${TAG} SELECT event_time AS at, user_host AS who, thread_id AS thread, command_type AS command, argument AS text
            FROM mysql.general_log WHERE argument NOT LIKE '${TAG}%' ORDER BY event_time DESC LIMIT ?`, [limit]);
      return { status: v, on, source: 'table', rows: rows.reverse().map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, k === 'at' ? iso(x) : typeof x === 'bigint' ? Number(x) : Buffer.isBuffer(x) ? x.toString('utf8') : x]))) };
    } catch (err) {
      if (!/FILE/i.test(v.log_output ?? '')) throw new server.DbError(err);
    }
  }
  const file = resolveFile(which === 'slow' ? v.slow_query_log_file : v.general_log_file, v.datadir);
  const r = file ? await tail(connId, file, v.local) : null;
  if (r) return { status: v, on, source: r.source, path: file, text: r.text, truncated: r.truncated };
  return { status: v, on, source: null, path: file, reason: t('Il log è scritto nel file {0}, non leggibile da qui: scegli l\'uscita su tabella (log_output = TABLE) per vederlo.', file ?? '?') };
}

/** Turns the slow or general log on or off; toTable also adds TABLE to log_output. */
async function setLog(connId, which, on, toTable) {
  await server.withConnection(connId, async (c) => {
    try {
      if (toTable) {
        const [{ v }] = Array.from(await c.query({ sql: 'SELECT @@GLOBAL.log_output AS v', rowsAsArray: false }));
        const out = new Set(String(v).split(',').map((s) => s.trim().toUpperCase()).filter((s) => s && s !== 'NONE'));
        out.add('TABLE');
        await c.query(`SET GLOBAL log_output = '${[...out].join(',')}'`);
      }
      await c.query(`SET GLOBAL ${which === 'slow' ? 'slow_query_log' : 'general_log'} = ${on ? 'ON' : 'OFF'}`);
    } catch (err) { throw new server.DbError(err); }
  });
  return status(connId);
}

async function clear(connId, which) {
  await server.runStatements(connId, [`TRUNCATE TABLE mysql.${which === 'slow' ? 'slow_log' : 'general_log'}`]);
}

module.exports = { status, errorLog, queryLog, setLog, clear, isLocal };
