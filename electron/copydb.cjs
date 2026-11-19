// Copy of databases to other databases, on the same server or another connection: our dump to temporary
// .sql.gz files (backup.cjs), each target database created with its source's character set, then the restore,
// which is byte-transparent. Two passes so that code reading other databases works: first the tables and data
// of every database, then views, routines, triggers and events of every database, retried while some succeed
// (views on views of another database). Progress on one channel: { phase, i, n, db, … }.
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('./server.cjs');
const backup = require('./backup.cjs');
const { t } = require('./i18n.cjs');

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';

/** Whether the target database exists and how many tables it has (to warn before replacing it). */
async function targetInfo(connId, db) {
  const [r] = await server.meta(connId, 'SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db]);
  if (!Number(r.n)) return { exists: false, tables: 0 };
  const [x] = await server.meta(connId, 'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [db]);
  return { exists: true, tables: Number(x.n) };
}

const validName = (db) => /^[^/\\.]{1,64}$/.test(db) && !/\s$/.test(db);

/** INSERT size for the target: well under its max_allowed_packet. */
async function packetBudget(connId) {
  try {
    const [r] = await server.meta(connId, 'SELECT @@GLOBAL.max_allowed_packet AS p');
    return Math.min(4 * 1024 * 1024, Math.max(64 * 1024, Math.floor(Number(r.p) / 2)));
  } catch { return 1024 * 1024; }
}

const BIG_PACKET = 1024 * 1024 * 1024; // the server maximum

/**
 * A single row cannot be split: raise the target's max_allowed_packet to 1 GB for the copy when the account may
 * (SUPER / SYSTEM_VARIABLES_ADMIN); new connections, the restore's included, get it. Returns the undo.
 */
async function raisePacket(connId) {
  try {
    const [r] = await server.meta(connId, 'SELECT @@GLOBAL.max_allowed_packet AS p');
    const before = Number(r.p);
    if (!(before < BIG_PACKET)) return async () => {};
    await server.runStatements(connId, [`SET GLOBAL max_allowed_packet = ${BIG_PACKET}`]);
    return async () => { await server.runStatements(connId, [`SET GLOBAL max_allowed_packet = ${before}`]).catch(() => {}); };
  } catch { return async () => {}; }
}

/** Server errors made actionable: a row bigger than the target's packet limit. */
function explain(message) {
  if (/max_allowed_packet|ECONNRESET|EPIPE|Connection.*(closed|reset)/i.test(message)) {
    return `${message} — ${t('una riga supera max_allowed_packet del server di destinazione e non è stato possibile aumentarlo da qui (servono i privilegi SUPER): fallo impostare a 1G (SET GLOBAL max_allowed_packet = 1073741824) e riprova.')}`;
  }
  return message;
}

const objectOf = (sql) => /\bCREATE\b[\s\S]*?\b(VIEW|FUNCTION|PROCEDURE|TRIGGER|EVENT)\s+(`(?:[^`]|``)+`|\S+)/i.exec(sql);

/**
 * items: [{ src, tgt }] copied from src.connId to tgtConn.
 * opts: { structure, data, routines, stripDefiner, tables?, limit?, ifExists: 'fail' | 'replace' | 'merge' }.
 * 'replace' drops an existing target first; 'merge' writes into it (DROP TABLE IF EXISTS per copied table).
 * Never throws for one database: each item gets { statements, ms, created } or { error }, plus `skipped`,
 * the views/routines that could not be created (for instance on a database that was not copied).
 */
async function copyMany(srcConn, items, tgtConn, opts, onProgress = () => {}) {
  const o = { structure: true, data: true, routines: true, stripDefiner: true, ifExists: 'fail', ...opts };
  const n = items.length;
  const renameDbs = Object.fromEntries(items.map((x) => [x.src, x.tgt]));
  const undoPacket = await raisePacket(tgtConn);
  const maxBytes = await packetBudget(tgtConn);
  const tmp = (kind, i) => path.join(os.tmpdir(), `mibsql-copy-${process.pid}-${Date.now()}-${i}-${kind}.sql.gz`);
  const out = items.map((x) => ({ src: x.src, tgt: x.tgt, statements: 0, ms: 0, created: false, skipped: [] }));
  const code = [];
  try {
    // pass 1: tables and data of every database
    for (const [i, x] of items.entries()) {
      const r = out[i];
      const t0 = Date.now();
      const step = (p) => onProgress({ ...p, i: i + 1, n, db: x.src, tgt: x.tgt });
      try {
        if (srcConn === tgtConn && x.src === x.tgt) throw new Error(t('Origine e destinazione coincidono.'));
        if (!validName(x.tgt)) throw new Error(t('Nome di database non valido: {0}', x.tgt));
        const info = await targetInfo(tgtConn, x.tgt);
        if (info.exists && o.ifExists === 'fail') throw new Error(t('Il database {0} esiste già sulla destinazione.', x.tgt));
        const [cs] = await server.meta(srcConn, 'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [x.src]);
        if (!cs) throw new Error(t('Database {0} non trovato.', x.src));
        const file = tmp('tables', i);
        step({ phase: 'dump', done: 0, total: 1 });
        try {
          await backup.dump(srcConn, x.src, file, { structure: o.structure, data: o.data, routines: false, stripDefiner: o.stripDefiner, dropTables: true, tables: o.tables, limit: o.limit, maxBytes, part: 'tables' }, (p) => step({ phase: 'dump', ...p }));
          if (info.exists && o.ifExists === 'replace') await server.runStatements(tgtConn, [`DROP DATABASE ${qi(x.tgt)}`]);
          if (!info.exists || o.ifExists === 'replace') {
            // the target server may not know the source collation (MySQL 8 ↔ MariaDB): fall back to the character set
            try { await server.runStatements(tgtConn, [`CREATE DATABASE ${qi(x.tgt)} CHARACTER SET ${cs.cs} COLLATE ${cs.co}`]); } catch {
              await server.runStatements(tgtConn, [`CREATE DATABASE ${qi(x.tgt)} CHARACTER SET ${cs.cs}`]);
            }
            r.created = true;
          }
          step({ phase: 'restore', bytes: 0, total: fs.statSync(file).size });
          const res = await backup.restore(tgtConn, x.tgt, file, {}, (p) => step({ phase: 'restore', ...p }));
          r.statements += res.statements;
        } finally { fs.rmSync(file, { force: true }); }
        if (o.structure && o.routines) code.push(i);
      } catch (err) {
        r.error = explain(err.message);
      }
      r.ms += Date.now() - t0;
    }

    // pass 2: views, routines, triggers, events, once every database has its tables
    const files = new Map();
    for (const i of code) {
      const x = items[i];
      const t0 = Date.now();
      try {
        const file = tmp('code', i);
        onProgress({ phase: 'code', i: i + 1, n, db: x.src, tgt: x.tgt });
        await backup.dump(srcConn, x.src, file, { structure: true, data: false, routines: true, stripDefiner: o.stripDefiner, tables: o.tables, part: 'code', renameDbs });
        files.set(i, file);
      } catch (err) { out[i].error = explain(err.message); }
      out[i].ms += Date.now() - t0;
    }
    // each round runs the whole file again (DROP … IF EXISTS before every object): stop when nothing improves
    let pending = [...files.keys()];
    let last = Infinity;
    const failures = new Map();
    for (let round = 0; pending.length && round < 6; round++) {
      let total = 0;
      for (const i of pending) {
        const x = items[i];
        const t0 = Date.now();
        onProgress({ phase: 'code', i: i + 1, n, db: x.src, tgt: x.tgt, round: round + 1 });
        try {
          const res = await backup.restore(tgtConn, x.tgt, files.get(i), { continueOnError: true });
          failures.set(i, res.errors.filter((e) => objectOf(e.sql)));
          if (round === 0) out[i].statements += res.statements;
        } catch (err) { out[i].error = explain(err.message); failures.set(i, []); }
        out[i].ms += Date.now() - t0;
        total += failures.get(i).length;
      }
      pending = pending.filter((i) => failures.get(i).length);
      if (total >= last) break;
      last = total;
    }
    for (const [i, errs] of failures) {
      out[i].skipped = errs.map((e) => { const m = objectOf(e.sql); return { kind: m[1].toUpperCase(), name: m[2].replace(/^`|`$/g, '').replace(/``/g, '`'), message: e.message }; });
    }
  } finally {
    await undoPacket();
    for (const f of fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`mibsql-copy-${process.pid}-`))) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
  }
  return out;
}

/** One database (the dialog's single-database mode and its table selection): errors are thrown. */
async function copy(src, tgt, opts, onProgress = () => {}) {
  if (src.connId === tgt.connId && src.db === tgt.db) throw new Error(t('Origine e destinazione coincidono.'));
  if (!validName(tgt.db)) throw new Error(t('Nome di database non valido: {0}', tgt.db));
  const [r] = await copyMany(src.connId, [{ src: src.db, tgt: tgt.db }], tgt.connId, opts, onProgress);
  if (r.error) throw new Error(r.error);
  return r;
}

module.exports = { copy, copyMany, targetInfo };
