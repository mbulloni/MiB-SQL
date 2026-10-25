// Copy of a database to another database, on the same server or another connection: our dump to a temporary
// .sql.gz file (backup.cjs), the target database created with the source's character set, then the restore,
// which is byte-transparent. Two phases reported on the same progress channel.
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

/**
 * opts: { structure, data, routines, stripDefiner, tables?, ifExists: 'fail' | 'replace' | 'merge' }.
 * 'replace' drops the target database first; 'merge' writes into it (DROP TABLE IF EXISTS per copied table).
 */
async function copy(src, tgt, opts, onProgress = () => {}) {
  if (src.connId === tgt.connId && src.db === tgt.db) throw new Error(t('Origine e destinazione coincidono.'));
  if (!/^[^/\\.]{1,64}$/.test(tgt.db) || /\s$/.test(tgt.db)) throw new Error(t('Nome di database non valido: {0}', tgt.db));
  const o = { structure: true, data: true, routines: true, stripDefiner: true, ifExists: 'fail', ...opts };
  const info = await targetInfo(tgt.connId, tgt.db);
  if (info.exists && o.ifExists === 'fail') throw new Error(t('Il database {0} esiste già sulla destinazione.', tgt.db));
  const [cs] = await server.meta(src.connId, 'SELECT DEFAULT_CHARACTER_SET_NAME AS cs, DEFAULT_COLLATION_NAME AS co FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [src.db]);
  if (!cs) throw new Error(t('Database {0} non trovato.', src.db));

  const file = path.join(os.tmpdir(), `mibsql-copy-${process.pid}-${Date.now()}.sql.gz`);
  const t0 = Date.now();
  try {
    onProgress({ phase: 'dump', done: 0, total: 1 });
    await backup.dump(src.connId, src.db, file, { structure: o.structure, data: o.data, routines: o.routines, stripDefiner: o.stripDefiner, dropTables: true, tables: o.tables },
      (p) => onProgress({ phase: 'dump', ...p }));
    const ddl = [];
    if (info.exists && o.ifExists === 'replace') ddl.push(`DROP DATABASE ${qi(tgt.db)}`);
    if (!info.exists || o.ifExists === 'replace') {
      // the target server may not know the source collation (MySQL 8 ↔ MariaDB): fall back to the character set
      ddl.push(`CREATE DATABASE ${qi(tgt.db)} CHARACTER SET ${cs.cs} COLLATE ${cs.co}`);
    }
    for (const sql of ddl) {
      try { await server.runStatements(tgt.connId, [sql]); } catch (err) {
        if (!/^CREATE DATABASE/.test(sql)) throw err;
        await server.runStatements(tgt.connId, [`CREATE DATABASE ${qi(tgt.db)} CHARACTER SET ${cs.cs}`]);
      }
    }
    onProgress({ phase: 'restore', bytes: 0, total: fs.statSync(file).size });
    const r = await backup.restore(tgt.connId, tgt.db, file, {}, (p) => onProgress({ phase: 'restore', ...p }));
    return { statements: r.statements, ms: Date.now() - t0, created: !info.exists || o.ifExists === 'replace' };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

module.exports = { copy, targetInfo };
