// Backup (our own streaming dump, no mariadb-dump needed) and restore of SQL scripts of any size.
// Dumps run in UTC so TIMESTAMP values restore unchanged on any server; triggers come after the data
// (restoring rows must not fire them); routines, triggers and events are wrapped in DELIMITER ;;.
const fs = require('fs');
const zlib = require('zlib');
const server = require('./server.cjs');
const { literal } = require('./export.cjs');
const { Splitter } = require('./sqlsplit.cjs');
const { t } = require('./i18n.cjs');

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const SPATIAL = /^(geometry|point|linestring|polygon|multipoint|multilinestring|multipolygon|geometrycollection|geomcollection)$/i;
const stripDefiner = (sql) => sql.replace(/\s+DEFINER\s*=\s*(`[^`]*`|'[^']*'|\S+)@(`[^`]*`|'[^']*'|\S+)/i, '');

/** Output file, gzip when the name ends in .gz; write() waits for 'drain'. */
function output(file) {
  const fileStream = fs.createWriteStream(file);
  const out = file.endsWith('.gz') ? zlib.createGzip({ level: 6 }) : null;
  if (out) out.pipe(fileStream);
  const target = out ?? fileStream;
  let failed = null;
  target.on('error', (e) => { failed = e; });
  fileStream.on('error', (e) => { failed = e; });
  return {
    async write(s) {
      if (failed) throw failed;
      if (!target.write(s)) await new Promise((r) => target.once('drain', r));
    },
    end: () => new Promise((resolve, reject) => {
      if (failed) { reject(failed); return; }
      fileStream.once('finish', resolve);
      fileStream.once('error', reject);
      target.end();
    }),
  };
}

/** Views in dependency order (a view used by another one first). */
function orderViews(views) {
  const done = [];
  const pending = [...views];
  while (pending.length) {
    const i = pending.findIndex((v) => !pending.some((o) => o !== v && new RegExp('`' + o.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`').test(v.ddl)));
    done.push(...pending.splice(i < 0 ? 0 : i, 1));
  }
  return done;
}

/**
 * Dumps a database. opts: { structure, data, routines, dropTables, createDatabase, stripDefiner, batch, tables? }
 * onProgress({ table, rows, done, total }).
 */
async function dump(connId, db, file, opts, onProgress = () => {}) {
  const o = { structure: true, data: true, routines: true, dropTables: true, createDatabase: false, stripDefiner: true, batch: 100, ...opts };
  const out = output(file);
  const fix = (sql) => (o.stripDefiner ? stripDefiner(sql) : sql);
  try {
    await server.withConnection(connId, async (c) => {
      await c.query("SET SESSION time_zone = '+00:00'");
      try {
        const [ver] = await c.query({ sql: 'SELECT VERSION() AS v', rowsAsArray: false });
        const tables = Array.from(await c.query({
          sql: "SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", rowsAsArray: false,
        }, [db]));
        const base = tables.filter((t) => t.type !== 'VIEW' && (!o.tables || o.tables.includes(t.name)));
        const views = o.routines ? tables.filter((t) => t.type === 'VIEW' && (!o.tables || o.tables.includes(t.name))) : [];
        await out.write([
          t('-- MiB-SQL dump of {0}', db),
          t('-- Server: {0}', ver.v),
          t('-- Created: {0}', new Date().toISOString()),
          '',
          '/*!40101 SET NAMES utf8mb4 */;',
          "SET TIME_ZONE = '+00:00';",
          'SET FOREIGN_KEY_CHECKS = 0;',
          'SET UNIQUE_CHECKS = 0;',
          "SET SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO';",
          '',
          ...(o.createDatabase ? [`CREATE DATABASE IF NOT EXISTS ${qi(db)};`, `USE ${qi(db)};`, ''] : []),
        ].join('\n') + '\n');

        let done = 0;
        for (const t of base) {
          if (o.structure) {
            const [row] = await c.query(`SHOW CREATE TABLE ${qi(db)}.${qi(t.name)}`);
            await out.write(`--\n-- Table ${t.name}\n--\n${o.dropTables ? `DROP TABLE IF EXISTS ${qi(t.name)};\n` : ''}${row[1]};\n\n`);
          }
          if (o.data) {
            // generated columns cannot be inserted: dump the stored ones only
            const info = Array.from(await c.query({
              sql: "SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND (GENERATION_EXPRESSION IS NULL OR GENERATION_EXPRESSION = '') ORDER BY ORDINAL_POSITION",
              rowsAsArray: false,
            }, [db, t.name]));
            const cols = info.map((r) => r.name);
            // spatial values: the driver turns them into GeoJSON; dump them as WKB + SRID instead
            const spatial = info.map((r) => SPATIAL.test(r.type));
            const select = info.map((r, i) => (spatial[i] ? `ST_AsBinary(${qi(r.name)}), ST_SRID(${qi(r.name)})` : qi(r.name))).join(', ');
            const head = `INSERT INTO ${qi(t.name)} (${cols.map(qi).join(', ')}) VALUES\n`;
            const stream = c.queryStream({ sql: `SELECT ${select} FROM ${qi(db)}.${qi(t.name)}`, rowsAsArray: true });
            let meta = null;
            stream.on('fields', (m) => { meta = m.map(server.column); });
            let batch = [];
            let rows = 0;
            for await (const r of stream) {
              const vals = [];
              for (let i = 0, k = 0; i < cols.length; i++, k++) {
                if (spatial[i]) {
                  const wkb = r[k];
                  const srid = r[++k];
                  vals.push(wkb === null ? 'NULL' : `ST_GeomFromWKB(${server.cell(wkb, Infinity)}, ${Number(srid) || 0})`);
                } else vals.push(literal(server.cell(r[k], Infinity), meta[k]));
              }
              batch.push('(' + vals.join(', ') + ')');
              rows++;
              if (batch.length >= o.batch) { await out.write(head + batch.join(',\n') + ';\n'); batch = []; }
              if (rows % 5000 === 0) onProgress({ table: t.name, rows, done, total: base.length });
            }
            if (batch.length) await out.write(head + batch.join(',\n') + ';\n');
            if (rows) await out.write('\n');
          }
          done++;
          onProgress({ table: t.name, rows: 0, done, total: base.length });
        }

        if (o.structure && views.length) {
          const ddl = [];
          for (const v of views) {
            const [row] = await c.query(`SHOW CREATE VIEW ${qi(db)}.${qi(v.name)}`);
            ddl.push({ name: v.name, ddl: fix(String(row[1])).split(`${qi(db)}.`).join('') });
          }
          for (const v of orderViews(ddl)) await out.write(`--\n-- View ${v.name}\n--\nDROP VIEW IF EXISTS ${qi(v.name)};\n${v.ddl};\n\n`);
        }

        if (o.structure && o.routines) {
          const kinds = [
            ['FUNCTION', "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'FUNCTION'", 2],
            ['PROCEDURE', "SELECT ROUTINE_NAME AS name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = 'PROCEDURE'", 2],
            ['TRIGGER', 'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?', 2],
            ['EVENT', 'SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?', 3],
          ];
          for (const [word, sql, col] of kinds) {
            for (const r of Array.from(await c.query({ sql, rowsAsArray: false }, [db]))) {
              const [row] = await c.query(`SHOW CREATE ${word} ${qi(db)}.${qi(r.name)}`);
              const text = row[col];
              if (text === null || text === undefined) {
                await out.write(t('-- {0} {1}: definizione non leggibile (privilegi insufficienti)\n\n', word, r.name));
                continue;
              }
              await out.write(`DROP ${word} IF EXISTS ${qi(r.name)};\nDELIMITER ;;\n${fix(String(text))};;\nDELIMITER ;\n\n`);
            }
          }
        }
        await out.write('SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n-- Dump completed\n');
      } finally {
        await c.query('SET SESSION time_zone = @@global.time_zone').catch(() => {});
      }
    });
    await out.end();
  } catch (err) {
    await out.end().catch(() => {});
    fs.rmSync(file, { force: true });
    throw err.sqlMessage ? new server.DbError(err) : err;
  }
  return { file, size: fs.statSync(file).size };
}

/**
 * Runs a .sql / .sql.gz file statement by statement on one connection (optionally after USE db).
 * Byte-transparent: dumps may hold raw binary inside string literals (mariadb-dump without --hex-blob),
 * which UTF-8 decoding would corrupt. The file is read as latin1 and sent on a latin1 connection, so every
 * byte reaches the server unchanged; SET NAMES utf8mb4 then makes the server read those bytes as UTF-8.
 * opts: { continueOnError }. onProgress({ bytes, total, statements, errors }).
 */
async function restore(connId, db, file, opts = {}, onProgress = () => {}) {
  const total = fs.statSync(file).size;
  const input = fs.createReadStream(file);
  const text = file.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  text.setEncoding('latin1');
  const splitter = new Splitter();
  const errors = [];
  let statements = 0;
  let last = 0;
  const utf8 = (s) => Buffer.from(String(s), 'latin1').toString('utf8');
  await server.withDedicated(connId, { collation: 'latin1_swedish_ci', database: db || undefined }, async (c) => {
    // the driver follows SET NAMES reported by session tracking and would switch back to UTF-8: stop tracking first
    await c.query("SET SESSION session_track_system_variables = ''");
    await c.query('SET NAMES utf8mb4');
    const run = async (sql) => {
      try {
        await c.query(sql);
        statements++;
      } catch (err) {
        const message = err.sqlMessage || err.message; // the driver decodes server messages as UTF-8 already
        errors.push({ statement: statements + errors.length + 1, message, sql: utf8(sql.slice(0, 300)) });
        if (!opts.continueOnError || errors.length >= 1000) throw Object.assign(new Error(t('Istruzione {0}: {1}', statements + errors.length, message)), { partial: true });
      }
    };
    try {
      for await (const chunk of text) {
        for (const sql of splitter.push(chunk)) await run(sql);
        if (input.bytesRead - last > 256 * 1024) { last = input.bytesRead; onProgress({ bytes: input.bytesRead, total, statements, errors: errors.length }); }
      }
      for (const sql of splitter.end()) await run(sql);
    } finally {
      // the connection is closed afterwards: session settings left by the script die with it
    }
  }).catch((err) => {
    if (err.partial) { err.message += t(' ({0} istruzioni eseguite prima dell\'errore)', statements); err.statements = statements; err.errors = errors; }
    throw err;
  });
  onProgress({ bytes: total, total, statements, errors: errors.length });
  return { statements, errors };
}

module.exports = { dump, restore, stripDefiner };
