// Live server access: one metadata pool per open connection (explorer, completion, KILL) and one dedicated
// connection per SQL document, so USE, variables, temporary tables and transactions stay per tab like in
// dbForge. SSH tunnels are shared by the pool and the sessions of the same connection.
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const mariadb = require('mariadb');
const { Client: SshClient } = require('ssh2');
const connections = require('./connections.cjs');
const { split, statementAt } = require('./sqlsplit.cjs');

const MAX_ROWS = 50000;
const tunnels = new Map();  // connId -> { port, close }
const pools = new Map();    // connId -> mariadb pool
const sessions = new Map(); // sessionId -> { connId, conn, db, busy, cancelled }

function openTunnel(def, sec) {
  const ssh = def.ssh;
  return new Promise((resolve, reject) => {
    const client = new SshClient();
    let server;
    client
      .on('ready', () => {
        server = net.createServer((sock) => {
          client.forwardOut('127.0.0.1', sock.remotePort || 0, def.host || '127.0.0.1', Number(def.port) || 3306, (err, stream) => {
            if (err) { sock.destroy(); return; }
            sock.pipe(stream).pipe(sock);
            stream.on('close', () => sock.destroy());
            sock.on('close', () => stream.end());
          });
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => { server.close(); client.end(); } }));
      })
      .on('error', (err) => { tunnels.delete(def.id); reject(new Error(`SSH: ${err.message}`)); })
      .on('close', () => { tunnels.delete(def.id); server?.close(); });
    const opts = { host: ssh.host, port: Number(ssh.port) || 22, username: ssh.user, readyTimeout: 15000, keepaliveInterval: 30000 };
    if (ssh.auth === 'key') {
      opts.privateKey = fs.readFileSync(ssh.keyFile.replace(/^~(?=\/)/, require('os').homedir()));
      if (sec.passphrase) opts.passphrase = sec.passphrase;
    } else if (ssh.auth === 'agent') {
      opts.agent = process.env.SSH_AUTH_SOCK;
    } else {
      opts.password = sec.sshPassword ?? '';
    }
    client.connect(opts);
  });
}

/** Driver options for a profile; through an SSH tunnel when the profile asks for one. */
async function driverOptions(def, sec, { tunnel = true } = {}) {
  const base = {
    user: def.user,
    password: sec.password ?? '',
    database: def.database || undefined,
    connectTimeout: 10000,
    dateStrings: true,
    bigIntAsNumber: false,
    decimalAsNumber: false,
    insertIdAsNumber: true,
    autoJsonMap: false,
    rowsAsArray: true,
    multipleStatements: false,
    permitLocalInfile: false,
  };
  if (def.ssl) {
    base.ssl = { rejectUnauthorized: !!def.sslVerify };
    if (def.sslCa) base.ssl.ca = fs.readFileSync(def.sslCa);
  }
  if (def.socket) return { ...base, socketPath: def.socket };
  if (def.ssh?.enabled && tunnel) {
    let t = tunnels.get(def.id);
    if (!t) { t = await openTunnel(def, sec); tunnels.set(def.id, t); }
    return { ...base, host: '127.0.0.1', port: t.port };
  }
  return { ...base, host: def.host || 'localhost', port: Number(def.port) || 3306 };
}

/** Error object safe for IPC, with the server's error number and SQLSTATE. */
function errorInfo(err) {
  return { message: err.sqlMessage || err.text || err.message, code: err.code, errno: err.errno, sqlState: err.sqlState, fatal: !!err.fatal };
}

const NETWORK = {
  ENOTFOUND: (e) => `Host non trovato: ${e.hostname ?? ''}`,
  ECONNREFUSED: (e) => `Connessione rifiutata da ${e.address ?? ''}:${e.port ?? ''}: il server non è in ascolto.`,
  ETIMEDOUT: () => 'Timeout di connessione: server irraggiungibile.',
  EHOSTUNREACH: () => 'Host irraggiungibile.',
  ENOENT: (e) => `File non trovato: ${e.path ?? ''}`,
};

class DbError extends Error {
  constructor(err) {
    const net = NETWORK[err.code] ?? NETWORK[err.cause?.code];
    super(net ? net(err.cause?.code ? err.cause : err) : err.sqlMessage || err.text || err.message);
    this.code = err.code;
  }
}

/** Test a profile without keeping anything open (the tunnel too is temporary). */
async function test(def, given) {
  const sec = await connections.secretsFor(def, given);
  let t;
  try {
    const opts = await driverOptions(def, sec, { tunnel: false });
    if (def.ssh?.enabled && !def.socket) { t = await openTunnel({ ...def, id: 'test' }, sec); opts.host = '127.0.0.1'; opts.port = t.port; }
    const conn = await mariadb.createConnection(opts);
    try {
      const [row] = await conn.query('SELECT VERSION(), CURRENT_USER()');
      return { version: row[0], user: row[1] };
    } finally { await conn.end(); }
  } catch (err) {
    throw new DbError(err);
  } finally { t?.close(); }
}

/** Opens the metadata pool of a connection (entering a password stores it as the profile asks). */
async function open(connId, given) {
  const def = connections.get(connId);
  const sec = await connections.secretsFor(def, given);
  if (pools.has(connId)) {
    if (!given) return info(connId);
    await close(connId);
  }
  try {
    // A plain connection first: it fails fast with the real error, a pool would retry until acquireTimeout.
    const opts = await driverOptions(def, sec);
    await (await mariadb.createConnection(opts)).end();
    pools.set(connId, mariadb.createPool({ ...opts, connectionLimit: 3, minimumIdle: 0, idleTimeout: 300 }));
  } catch (err) {
    tunnels.get(connId)?.close();
    tunnels.delete(connId);
    throw new DbError(err);
  }
  if (given) await connections.remember(def, sec);
  return info(connId);
}

async function info(connId) {
  const [row] = await pool(connId).query('SELECT VERSION(), CURRENT_USER(), @@version_comment');
  return { version: row[0], user: row[1], comment: row[2] };
}

async function close(connId) {
  for (const [sid, s] of sessions) if (s.connId === connId) await closeSession(sid);
  const p = pools.get(connId);
  pools.delete(connId);
  await p?.end().catch(() => {});
  tunnels.get(connId)?.close();
  tunnels.delete(connId);
}

function pool(connId) {
  const p = pools.get(connId);
  if (!p) throw new Error('Connessione non aperta.');
  return p;
}

/** Metadata query on the pool, rows as objects keyed by column name. */
async function meta(connId, sql, params = []) {
  try {
    const res = await pool(connId).query({ sql, rowsAsArray: false }, params);
    return Array.from(res);
  } catch (err) { throw new DbError(err); }
}

// ---- SQL documents ----

async function openSession(connId, db) {
  const def = connections.get(connId);
  pool(connId); // the connection must be open
  const sec = await connections.secretsFor(def);
  let conn;
  try { conn = await mariadb.createConnection({ ...(await driverOptions(def, sec)), database: db || def.database || undefined }); }
  catch (err) { throw new DbError(err); }
  const id = crypto.randomUUID();
  const s = { connId, conn, db: db || def.database || null, busy: false, cancelled: false };
  sessions.set(id, s);
  if (!s.db) s.db = (await conn.query('SELECT DATABASE()'))[0][0];
  return { id, db: s.db };
}

async function closeSession(sid) {
  const s = sessions.get(sid);
  sessions.delete(sid);
  await s?.conn.end().catch(() => s.conn.destroy());
}

/** Reopens a session whose connection dropped (server restart, timeout), back on its database. */
async function revive(s) {
  if (s.conn.isValid()) return;
  const def = connections.get(s.connId);
  s.conn = await mariadb.createConnection({ ...(await driverOptions(def, await connections.secretsFor(def))), database: s.db || undefined });
}

async function useDb(sid, db) {
  const s = sessions.get(sid);
  if (!s) throw new Error('Sessione chiusa.');
  await revive(s);
  try { await s.conn.query(`USE \`${db.replace(/`/g, '``')}\``); } catch (err) { throw new DbError(err); }
  s.db = db;
  return db;
}

// Binary values travel as hex; past 1 MB only a prefix (marked with …) so a stray LONGBLOB cannot flood the UI.
const HEX_MAX = 1024 * 1024;
const hex = (buf, max = HEX_MAX) => '0x' + buf.subarray(0, max).toString('hex').toUpperCase() + (buf.length > max ? '…' : '');

function cell(v, max) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return hex(v, max);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

const FLAG_NOT_NULL = 1;
const FLAG_AUTO_INCREMENT = 512;

function column(m) {
  return {
    name: m.name(),
    table: m.table(),
    orgTable: m.orgTable(),
    orgName: m.orgName(),
    db: m.db(),
    type: m.type,
    length: m.columnLength,
    scale: m.scale,
    binary: m.collation?.index === 63 && /BLOB|STRING|GEOMETRY/.test(m.type),
    notNull: !!(m.flags & FLAG_NOT_NULL),
    autoIncrement: !!(m.flags & FLAG_AUTO_INCREMENT),
  };
}

/** One driver result into result sets (CALL returns several) plus the final OK packet. */
function resultSets(res) {
  const isRows = (r) => Array.isArray(r) && Array.isArray(r.meta);
  if (isRows(res)) return { sets: [res], ok: null };
  if (Array.isArray(res)) return { sets: res.filter(isRows), ok: res.find((r) => !Array.isArray(r)) ?? null };
  return { sets: [], ok: res };
}

/**
 * Runs a script on a session. mode: 'all' | 'selection' | 'current' | 'explain'.
 * Every statement yields one entry: result sets, affected rows or the error; execution stops at the
 * first error unless continueOnError.
 */
async function exec(sid, text, { mode = 'all', cursor = 0, selStart = 0, selEnd = 0, continueOnError = false, maxRows = MAX_ROWS } = {}) {
  const s = sessions.get(sid);
  if (!s) throw new Error('Sessione chiusa.');
  if (s.busy) throw new Error('Una query è già in esecuzione in questo documento.');
  let stmts;
  if (mode === 'selection') stmts = split(text.slice(selStart, selEnd)).map((x) => ({ ...x, start: x.start + selStart, end: x.end + selStart }));
  else if (mode === 'current' || mode === 'explain') { const one = statementAt(text, cursor); stmts = one ? [one] : []; }
  else stmts = split(text);
  if (mode === 'explain') stmts = stmts.map((x) => ({ ...x, run: /^\s*explain\b/i.test(x.sql) ? x.sql : `EXPLAIN EXTENDED ${x.sql}` }));

  s.busy = true;
  s.cancelled = false;
  const out = [];
  try {
    await revive(s).catch((err) => { throw new DbError(err); });
    for (const st of stmts) {
      if (s.cancelled) break;
      const t0 = performance.now();
      const entry = { sql: st.sql, start: st.start, end: st.end, sets: [], affectedRows: null, insertId: null, warnings: [], ms: 0, error: null };
      try {
        const res = await s.conn.query({ sql: st.run ?? st.sql });
        entry.ms = Math.round(performance.now() - t0);
        const { sets, ok } = resultSets(res);
        entry.sets = sets.map((rs) => ({
          columns: rs.meta.map(column),
          rows: rs.slice(0, maxRows).map((r) => r.map((v) => cell(v))),
          total: rs.length,
          truncated: rs.length > maxRows,
        }));
        if (ok) { entry.affectedRows = ok.affectedRows; entry.insertId = ok.insertId || null; }
        // Result sets do not carry the warning count: ask the server only for those, OK packets have it.
        const warn = ok ? ok.warningStatus : sets.length ? Number((await s.conn.query('SELECT @@warning_count'))[0][0]) : 0;
        if (warn > 0 || mode === 'explain') {
          const w = await s.conn.query({ sql: 'SHOW WARNINGS', rowsAsArray: false });
          entry.warnings = Array.from(w).map((x) => ({ level: x.Level, code: x.Code, message: x.Message }));
        }
      } catch (err) {
        entry.ms = Math.round(performance.now() - t0);
        entry.error = errorInfo(err);
        if (s.cancelled) entry.error.message = 'Esecuzione annullata dall\'utente.';
      }
      out.push(entry);
      if (entry.error && (entry.error.fatal || !continueOnError)) break;
    }
    if (s.conn.isValid()) s.db = (await s.conn.query('SELECT DATABASE()'))[0][0];
  } finally {
    s.busy = false;
  }
  return { results: out, db: s.db, cancelled: s.cancelled };
}

/** KILL QUERY on the session's thread from the metadata pool. */
async function cancel(sid) {
  const s = sessions.get(sid);
  if (!s || !s.busy) return false;
  s.cancelled = true;
  await pool(s.connId).query(`KILL QUERY ${Number(s.conn.threadId)}`).catch(() => {});
  return true;
}

/**
 * Grid edits: statements run in one transaction on a pool connection (not the document's session, so an
 * open transaction there is not committed by accident). expectOne guards UPDATE/DELETE by primary key:
 * no matched row means someone else changed or deleted it, and everything is rolled back.
 */
async function apply(connId, stmts) {
  const c = await pool(connId).getConnection();
  let at = 0;
  try {
    await c.beginTransaction();
    const out = [];
    for (; at < stmts.length; at++) {
      const st = stmts[at];
      const r = await c.query({ sql: st.sql, rowsAsArray: false }, st.params);
      if (st.expectOne && r.affectedRows !== 1) {
        throw new Error(`${r.affectedRows} righe trovate invece di 1: la riga è stata modificata o eliminata da un altro utente.`);
      }
      out.push({ affectedRows: r.affectedRows, insertId: r.insertId ? String(r.insertId) : null });
    }
    await c.commit();
    return out;
  } catch (err) {
    await c.rollback().catch(() => {});
    const e = new DbError(err);
    e.message = `Istruzione ${at + 1}: ${e.message.replace(/[.\s]*$/, '.')} Nessuna modifica applicata.`;
    throw e;
  } finally {
    c.release();
  }
}

/** Rows of a parameterized SELECT, normalized like the grid's (re-reading edited rows after an apply). */
async function selectRows(connId, sql, params) {
  try {
    const res = await pool(connId).query({ sql, rowsAsArray: true }, params);
    return Array.from(res).map((r) => r.map((v) => cell(v)));
  } catch (err) { throw new DbError(err); }
}

/** Streams a query from a pool connection (exports): columns first, then rows with full binary values. */
async function streamQuery(connId, db, sql, onColumns, onRow) {
  const c = await pool(connId).getConnection();
  try {
    if (db) await c.query(`USE \`${db.replace(/`/g, '``')}\``);
    const stream = c.queryStream({ sql, rowsAsArray: true });
    let columns = null;
    stream.on('fields', (meta) => { columns = meta.map(column); onColumns(columns); });
    let n = 0;
    for await (const row of stream) {
      if (!columns) throw new Error('La query non restituisce righe.');
      await onRow(row.map((v) => cell(v, Infinity)), ++n);
    }
    if (!columns) throw new Error('La query non restituisce righe.');
    return n;
  } catch (err) {
    throw err instanceof DbError || !err.sqlMessage ? err : new DbError(err);
  } finally {
    c.release();
  }
}

async function shutdown() {
  for (const id of [...pools.keys()]) await close(id);
}

module.exports = { test, open, close, info, meta, openSession, closeSession, useDb, exec, cancel, apply, selectRows, streamQuery, shutdown, split };
