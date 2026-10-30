// Microsoft Fabric Warehouse (and SQL Server / Azure SQL) over TDS with the mssql driver: explorer metadata,
// SQL documents and exports, read-only by default. A Fabric endpoint serves every warehouse and lakehouse of a
// workspace as a database, so metadata pools are per connection *and* database; each document gets a pool of
// one connection (its session: temp tables, SET options). Sign-in is Microsoft Entra (entra.cjs) or SQL login.
const crypto = require('crypto');
const sql = require('mssql');
const connections = require('./connections.cjs');
const entra = require('./entra.cjs');
const { batches, statementAt, firstWrite } = require('./tsqlsplit.cjs');
const { t } = require('./i18n.cjs');

const MAX_ROWS = 50000;
const SYSTEM_DBS = new Set(['master', 'tempdb', 'model', 'msdb']);
const conns = new Map(); // connId -> { def, pools: Map<db, Promise<ConnectionPool>>, dbs: string[] | null, defaultDb }
const sessions = new Map(); // sid -> { connId, db, pool, busy, cancelled, request }

const isTds = (def) => def?.engine === 'mssql';
const isFabric = (def) => /\.(fabric|pbidedicated)\.microsoft\.com$/i.test(def.host ?? '');

/** Driver configuration of a profile on one database. */
async function config(def, sec, db, poolSize) {
  const authentication = def.auth === 'sql'
    ? { type: 'default', options: { userName: def.user, password: sec.password ?? '' } }
    : { type: 'token-credential', options: { credential: entra.credential(def, { interactive: true }) } };
  return {
    server: def.host,
    port: Number(def.port) || 1433,
    database: db || undefined,
    authentication,
    connectionTimeout: 30000,
    requestTimeout: 0, // long analytic queries: the user cancels them
    options: { encrypt: true, trustServerCertificate: !!def.trustCert, appName: 'MiB-SQL', useUTC: true, enableArithAbort: true },
    pool: { max: poolSize, min: 0, idleTimeoutMillis: poolSize === 1 ? 2147483647 : 300000 },
  };
}

/** Error with the server's error number and the batch line, worded like MariaDB's ("at line N") for the editor markers. */
class TdsError extends Error {
  constructor(err) {
    const inner = err.originalError?.errors?.at?.(-1) ?? err.originalError ?? err;
    const net = { ESOCKET: t('Server irraggiungibile: {0}', inner.message ?? ''), ETIMEOUT: t('Timeout di connessione: server irraggiungibile.') }[err.code];
    const line = err.lineNumber ?? inner.lineNumber;
    super(net ?? `${(inner.message || err.message || String(err)).replace(/\s+$/, '')}${line ? ` (at line ${line})` : ''}`);
    this.code = err.code === 'ELOGIN' ? 'ER_ACCESS_DENIED' : err.code;
    this.number = err.number ?? inner.number;
    this.state = err.state ?? inner.state;
  }
}

const errorInfo = (err) => {
  const e = err instanceof TdsError ? err : new TdsError(err);
  return { message: e.message, code: e.code, errno: e.number, sqlState: e.state !== undefined ? String(e.state) : undefined, fatal: false };
};

async function connect(def, sec, db, poolSize) {
  const pool = new sql.ConnectionPool(await config(def, sec, db, poolSize));
  pool.on('error', () => {}); // idle connections dropped by the server: the pool replaces them
  try { await pool.connect(); } catch (err) {
    pool.close().catch(() => {});
    if (err.code === 'ENTRA' || err.code === 'ENTRA_CANCELLED') throw err;
    const entraErr = err.originalError?.errors?.find?.((e) => e.code === 'ENTRA' || e.code === 'ENTRA_CANCELLED');
    if (entraErr) throw entraErr;
    const e = new TdsError(err);
    // a refused Entra login is not a wrong password: no password prompt for it
    if (def.auth !== 'sql' && e.code === 'ER_ACCESS_DENIED') e.code = 'ELOGIN';
    throw e;
  }
  return pool;
}

const EDITIONS = { 5: 'Azure SQL Database', 6: 'Azure Synapse', 8: 'Azure SQL Managed Instance', 9: 'Azure SQL Edge', 11: 'Azure Synapse serverless', 12: 'Microsoft Fabric' };

async function serverInfo(pool) {
  const r = await pool.request().query(`SELECT @@VERSION AS v, SUSER_SNAME() AS u, DB_NAME() AS db, CAST(SERVERPROPERTY('EngineEdition') AS int) AS ed,
    CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS pv`);
  const row = r.recordset[0];
  const product = EDITIONS[row.ed] ?? 'SQL Server';
  return { version: `${product} ${row.pv ?? ''}`.trim(), user: row.u, comment: String(row.v ?? '').split('\n')[0].trim(), db: row.db };
}

async function test(def, given) {
  const sec = await connections.secretsFor(def, given);
  const pool = await connect(def, sec, def.database, 1);
  try {
    const i = await serverInfo(pool);
    return { version: i.version, user: i.user };
  } finally { await pool.close().catch(() => {}); }
}

async function open(connId, given) {
  const def = connections.get(connId);
  const sec = await connections.secretsFor(def, given);
  if (conns.has(connId)) {
    if (!given) return info(connId);
    await close(connId);
  }
  const pool = await connect(def, sec, def.database, 3);
  const i = await serverInfo(pool);
  conns.set(connId, { def, sec, pools: new Map([[i.db, Promise.resolve(pool)]]), dbs: null, defaultDb: i.db });
  if (given) await connections.remember(def, sec);
  return { version: i.version, user: i.user, comment: i.comment };
}

function entry(connId) {
  const c = conns.get(connId);
  if (!c) throw new Error(t('Connessione non aperta.'));
  return c;
}

/** Metadata pool of a database of the workspace (opened on first use). */
function poolFor(connId, db) {
  const c = entry(connId);
  const key = db || c.defaultDb;
  if (!c.pools.has(key)) {
    const p = connect(c.def, c.sec, key, 2);
    p.catch(() => c.pools.delete(key));
    c.pools.set(key, p);
  }
  return c.pools.get(key);
}

async function info(connId) {
  const i = await serverInfo(await poolFor(connId, null));
  return { version: i.version, user: i.user, comment: i.comment };
}

async function close(connId) {
  for (const [sid, s] of sessions) if (s.connId === connId) await closeSession(sid);
  const c = conns.get(connId);
  conns.delete(connId);
  for (const p of c?.pools.values() ?? []) p.then((x) => x.close()).catch(() => {});
}

/** Metadata query, rows as objects; named parameters @p0, @p1… */
async function meta(connId, db, text, params = []) {
  try {
    const req = (await poolFor(connId, db)).request();
    params.forEach((v, i) => req.input(`p${i}`, sql.NVarChar, v));
    return (await req.query(text)).recordset;
  } catch (err) { throw err instanceof TdsError ? err : new TdsError(err); }
}

// ---- Explorer ----

async function databases(connId) {
  const c = entry(connId);
  let names;
  try {
    names = (await meta(connId, null, 'SELECT name FROM sys.databases ORDER BY name')).map((r) => r.name).filter((n) => !SYSTEM_DBS.has(n));
  } catch { names = []; }
  if (c.defaultDb && !names.includes(c.defaultDb)) names.unshift(c.defaultDb);
  c.dbs = names;
  return names;
}

// Objects are named schema.object in the tree (MiB-SQL's tree has no schema level); split back on the first dot.
const parts = (name) => { const at = name.indexOf('.'); return at < 0 ? ['dbo', name] : [name.slice(0, at), name.slice(at + 1)]; };
const qb = (s) => `[${String(s).replace(/]/g, ']]')}]`;
const qualified = (name) => parts(name).map(qb).join('.');

const OBJECT_TYPES = "('U','V','P','FN','IF','TF')";

async function objects(connId, db) {
  const rows = await meta(connId, db, `SELECT s.name AS sch, o.name, RTRIM(o.type) AS type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.type IN ${OBJECT_TYPES} AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`);
  const of = (...types) => rows.filter((r) => types.includes(r.type)).map((r) => ({ name: `${r.sch}.${r.name}` }));
  return {
    tables: of('U').map((x) => ({ ...x, engine: null, rows: null, comment: '', system: false })),
    views: of('V'),
    procedures: of('P'),
    functions: of('FN', 'IF', 'TF'),
    triggers: [],
    events: [],
  };
}

/** Column type as written in DDL: varchar(50), nvarchar(max), decimal(18,2), datetime2(6)… */
function typeText(r) {
  const ty = String(r.type).toLowerCase();
  const len = Number(r.max_length);
  if (['varchar', 'char', 'varbinary', 'binary'].includes(ty)) return `${ty}(${len === -1 ? 'max' : len})`;
  if (['nvarchar', 'nchar'].includes(ty)) return `${ty}(${len === -1 ? 'max' : len / 2})`;
  if (['decimal', 'numeric'].includes(ty)) return `${ty}(${r.precision},${r.scale})`;
  if (['datetime2', 'time', 'datetimeoffset'].includes(ty)) return `${ty}(${r.scale})`;
  return ty;
}

const COLUMN_SQL = `SELECT c.name, TYPE_NAME(c.user_type_id) AS type, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity,
    OBJECT_DEFINITION(c.default_object_id) AS def,
    CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
      WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
  FROM sys.columns c WHERE c.object_id = OBJECT_ID(@p0) ORDER BY c.column_id`;

async function columns(connId, db, table) {
  const rows = await meta(connId, db, COLUMN_SQL, [qualified(table)]);
  return rows.map((r) => ({ name: r.name, type: typeText(r), nullable: !!r.is_nullable, key: r.pk ? 'PRI' : '', def: r.def ?? null, extra: r.is_identity ? 'IDENTITY' : '', comment: '' }));
}

async function indexes(connId, db, table) {
  const rows = await meta(connId, db, `SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS col
    FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE i.object_id = OBJECT_ID(@p0) AND i.name IS NOT NULL ORDER BY i.is_primary_key DESC, i.name, ic.key_ordinal`, [qualified(table)]).catch(() => []);
  const byName = new Map();
  for (const r of rows) {
    if (!byName.has(r.name)) byName.set(r.name, { name: r.name, unique: !!r.is_unique, primary: !!r.is_primary_key, type: r.type_desc, columns: [] });
    byName.get(r.name).columns.push(r.col);
  }
  return [...byName.values()];
}

/** CREATE statement: module definition for views and routines, rebuilt from the catalog for tables. */
async function ddl(connId, db, kind, name) {
  if (kind === 'table') {
    const cols = await columns(connId, db, name);
    const pk = cols.filter((c) => c.key === 'PRI').map((c) => qb(c.name));
    const lines = cols.map((c) => `  ${qb(c.name)} ${c.type}${c.extra ? ` ${c.extra}` : ''}${c.nullable ? ' NULL' : ' NOT NULL'}${c.def ? ` DEFAULT ${c.def}` : ''}`);
    // Fabric only has non-enforced keys; SQL Server / Azure SQL the usual ones
    if (pk.length) lines.push(isFabric(entry(connId).def) ? `  PRIMARY KEY NONCLUSTERED (${pk.join(', ')}) NOT ENFORCED` : `  PRIMARY KEY (${pk.join(', ')})`);
    return `CREATE TABLE ${qualified(name)} (\n${lines.join(',\n')}\n);\n`;
  }
  const [row] = await meta(connId, db, 'SELECT OBJECT_DEFINITION(OBJECT_ID(@p0)) AS def', [qualified(name)]);
  if (!row?.def) throw new Error(t('Definizione non disponibile: privilegi insufficienti.'));
  return `${row.def.replace(/\s+$/, '')}\nGO\n`;
}

/** Tables and columns for completion and the assistant; keyed by bare name, schema.name when two schemas share it. */
async function schema(connId, db) {
  const c = entry(connId);
  // a qualifier that is not a database of the workspace (dbo.Sales parsed as db.table): nothing to connect to
  const known = c.dbs ?? (await databases(connId));
  if (!known.includes(db)) return { tables: {}, routines: [] };
  const rows = await meta(connId, db, `SELECT s.name AS sch, o.name AS tbl, RTRIM(o.type) AS kind, c.name, TYPE_NAME(c.user_type_id) AS type, c.max_length, c.precision, c.scale
    FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
    WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name, c.column_id`);
  const routines = await meta(connId, db, `SELECT o.name, RTRIM(o.type) AS type FROM sys.objects o WHERE o.type IN ('P','FN','IF','TF') AND o.is_ms_shipped = 0`);
  const schemasOf = new Map(); // table name -> schemas having it
  for (const r of rows) schemasOf.set(r.tbl, (schemasOf.get(r.tbl) ?? new Set()).add(r.sch));
  const tables = {};
  for (const r of rows) {
    const key = schemasOf.get(r.tbl).size > 1 && r.sch !== 'dbo' ? `${r.sch}.${r.tbl}` : r.tbl;
    tables[key] ??= { kind: r.kind === 'V' ? 'view' : 'table', columns: [] };
    tables[key].columns.push({ name: r.name, type: typeText(r) });
  }
  return { tables, routines: routines.map((r) => ({ name: r.name, type: r.type === 'P' ? 'procedure' : 'function' })) };
}

/** Tables, columns, keys and (not enforced) foreign keys of a database: the AI assistant's schema. */
async function erModel(connId, db) {
  const [cols, fks] = await Promise.all([
    meta(connId, db, `SELECT s.name AS sch, o.name AS tbl, RTRIM(o.type) AS kind, c.name, TYPE_NAME(c.user_type_id) AS type, c.max_length, c.precision, c.scale, c.is_nullable,
        CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
      FROM sys.columns c JOIN sys.objects o ON o.object_id = c.object_id JOIN sys.schemas s ON s.schema_id = o.schema_id
      WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name, c.column_id`),
    meta(connId, db, `SELECT fk.name, OBJECT_SCHEMA_NAME(fk.parent_object_id) AS sch, OBJECT_NAME(fk.parent_object_id) AS tbl, pc.name AS col,
        OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS rsch, OBJECT_NAME(fk.referenced_object_id) AS rtbl, rc.name AS rcol
      FROM sys.foreign_keys fk JOIN sys.foreign_key_columns k ON k.constraint_object_id = fk.object_id
      JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id
      JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id
      ORDER BY fk.name, k.constraint_column_id`).catch(() => []),
  ]);
  const tables = new Map();
  for (const r of cols) {
    const name = `${r.sch}.${r.tbl}`;
    if (!tables.has(name)) tables.set(name, { name, kind: r.kind === 'V' ? 'view' : 'table', rows: null, comment: '', columns: [] });
    tables.get(name).columns.push({ name: r.name, type: typeText(r), pk: !!r.pk, nullable: !!r.is_nullable });
  }
  const byFk = new Map();
  for (const r of fks) {
    if (!byFk.has(r.name)) byFk.set(r.name, { name: r.name, table: `${r.sch}.${r.tbl}`, columns: [], refDb: db, refTable: `${r.rsch}.${r.rtbl}`, refColumns: [] });
    byFk.get(r.name).columns.push(r.col);
    byFk.get(r.name).refColumns.push(r.rcol);
  }
  return { tables: [...tables.values()], fks: [...byFk.values()] };
}

// ---- Cells and columns ----

const HEX_MAX = 1024 * 1024;
const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * Date/time values as text from the UTC fields (useUTC: values arrive as written in the database), with as many
 * fractional digits as the column declares; tedious keeps the digits past the millisecond in nanosecondsDelta.
 */
function dateText(d, type, scale) {
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const digits = type === 'DATETIME' ? 3 : type === 'SMALLDATETIME' ? 0 : Math.min(Number(scale) || 0, 7);
  const frac = d.getUTCMilliseconds() / 1000 + (d.nanosecondsDelta || 0);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${digits ? frac.toFixed(digits).slice(1) : ''}`;
  if (type === 'DATE') return date;
  if (type === 'TIME') return time;
  if (type === 'DATETIMEOFFSET') return `${date} ${time} +00:00`;
  return `${date} ${time}`;
}

const DECIMAL = new Set(['DECIMAL', 'NUMERIC', 'MONEY', 'SMALLMONEY']);

/** Cell value for the grid; meta = { type, scale } of the column. */
function cell(v, { type, scale } = {}, max = HEX_MAX) {
  if (v === null || v === undefined) return null;
  // tedious reads DECIMAL as a JS number: written back with the column's scale (1250.50), as text like MariaDB's
  if (typeof v === 'number' && DECIMAL.has(type)) return v.toFixed(type.endsWith('MONEY') ? 4 : Number(scale) || 0);
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return '0x' + v.subarray(0, max).toString('hex').toUpperCase() + (v.length > max ? '…' : '');
  if (v instanceof Date) return dateText(v, type, scale);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

const typeName = (c) => String(c.type?.declaration ?? c.type?.name ?? 'unknown').toUpperCase();
const cellMeta = (c) => ({ type: typeName(c), scale: c.scale });

function column(c) {
  const type = typeName(c);
  return {
    name: c.name, table: '', orgTable: '', orgName: c.name, db: '',
    type, length: c.length, scale: c.scale ?? 0,
    binary: ['VARBINARY', 'BINARY', 'IMAGE'].includes(type),
    notNull: !c.nullable, autoIncrement: !!c.identity,
  };
}

// ---- SQL documents ----

async function openSession(connId, db) {
  const c = entry(connId);
  const target = db || c.def.database || c.defaultDb;
  const pool = await connect(c.def, c.sec, target, 1);
  const id = crypto.randomUUID();
  sessions.set(id, { connId, db: target, pool, busy: false, cancelled: false, request: null });
  return { id, db: target };
}

async function closeSession(sid) {
  const s = sessions.get(sid);
  sessions.delete(sid);
  await s?.pool.close().catch(() => {});
}

/** T-SQL has no portable USE on Fabric: the session reconnects on the other database (temp tables are lost). */
async function useDb(sid, db) {
  const s = sessions.get(sid);
  if (!s) throw new Error(t('Sessione chiusa.'));
  if (db === s.db) return db;
  const c = entry(s.connId);
  const pool = await connect(c.def, c.sec, db, 1);
  await s.pool.close().catch(() => {});
  s.pool = pool;
  s.db = db;
  return db;
}

/** One batch streamed: every result set (at most maxRows rows kept, all counted), rows affected, PRINT messages. */
function runBatch(s, text, maxRows) {
  return new Promise((resolve) => {
    const req = s.pool.request();
    req.stream = true;
    req.arrayRowMode = true;
    s.request = req;
    const sets = [];
    const metas = [];
    let affected = null;
    let error = null;
    const warnings = [];
    req.on('recordset', (cols) => { sets.push({ columns: cols.map(column), rows: [], total: 0, truncated: false }); metas.push(cols.map(cellMeta)); });
    req.on('row', (row) => {
      const cur = sets[sets.length - 1];
      const types = metas[metas.length - 1];
      if (!cur) return;
      cur.total++;
      if (cur.rows.length < maxRows) cur.rows.push(row.map((v, i) => cell(v, types[i])));
      else cur.truncated = true;
    });
    req.on('rowsaffected', (n) => { affected = (affected ?? 0) + n; });
    req.on('info', (m) => warnings.push({ level: m.class > 10 ? 'Warning' : 'Note', code: m.number, message: m.message }));
    req.on('error', (err) => { error ??= err; });
    req.on('done', () => { s.request = null; resolve({ sets, affected, error, warnings }); });
    req.query(text);
  });
}

async function exec(sid, text, { mode = 'all', cursor = 0, selStart = 0, selEnd = 0, continueOnError = false, maxRows = MAX_ROWS } = {}) {
  const s = sessions.get(sid);
  if (!s) throw new Error(t('Sessione chiusa.'));
  if (s.busy) throw new Error(t('Una query è già in esecuzione in questo documento.'));
  if (mode === 'explain') throw new Error(t('Il piano di esecuzione non è disponibile per Microsoft Fabric.'));
  let stmts;
  if (mode === 'selection') stmts = batches(text.slice(selStart, selEnd)).map((x) => ({ ...x, start: x.start + selStart, end: x.end + selStart }));
  else if (mode === 'current') { const one = statementAt(text, cursor); stmts = one ? [one] : []; }
  else stmts = batches(text);
  const readOnly = entry(s.connId).def.readOnly !== false;

  s.busy = true;
  s.cancelled = false;
  const out = [];
  try {
    for (const st of stmts) {
      if (s.cancelled) break;
      const t0 = performance.now();
      const res = { sql: st.sql, start: st.start, end: st.end, sets: [], affectedRows: null, insertId: null, warnings: [], ms: 0, error: null };
      const write = readOnly ? firstWrite(st.sql) : null;
      if (write) {
        res.error = { message: t('Connessione in sola lettura: {0} non è consentito (si può cambiare nelle proprietà della connessione).', write.word), fatal: false };
      } else {
        for (let k = 0; k < (st.count || 1) && !res.error && !s.cancelled; k++) {
          const r = await runBatch(s, st.sql, maxRows);
          res.sets.push(...r.sets);
          res.warnings.push(...r.warnings);
          if (r.affected !== null && !r.sets.length) res.affectedRows = (res.affectedRows ?? 0) + r.affected;
          if (r.error) res.error = errorInfo(r.error);
        }
        if (s.cancelled && res.error) res.error.message = t('Esecuzione annullata dall\'utente.');
      }
      res.ms = Math.round(performance.now() - t0);
      out.push(res);
      if (res.error && !continueOnError) break;
    }
  } finally {
    s.busy = false;
  }
  return { results: out, db: s.db, cancelled: s.cancelled };
}

async function cancel(sid) {
  const s = sessions.get(sid);
  if (!s || !s.busy) return false;
  s.cancelled = true;
  s.request?.cancel();
  return true;
}

/** Whole query to an export writer, with backpressure: the stream pauses while the writer is busy. */
async function streamQuery(connId, db, text, onColumns, onRow) {
  const pool = await poolFor(connId, db);
  if (entry(connId).def.readOnly !== false) {
    const w = firstWrite(text);
    if (w) throw new Error(t('Connessione in sola lettura: {0} non è consentito (si può cambiare nelle proprietà della connessione).', w.word));
  }
  return new Promise((resolve, reject) => {
    const req = pool.request();
    req.stream = true;
    req.arrayRowMode = true;
    let types = null;
    let n = 0;
    let chain = Promise.resolve();
    let failed = null;
    let queued = 0;
    req.on('recordset', (cols) => { if (!types) { types = cols.map(cellMeta); onColumns(cols.map(column)); } });
    req.on('row', (row) => {
      if (failed || !types) return;
      const values = row.map((v, i) => cell(v, types[i], Infinity));
      const k = ++n;
      queued++;
      if (queued > 500) req.pause();
      chain = chain.then(() => onRow(values, k)).then(() => { if (--queued < 100) req.resume(); }, (err) => { failed ??= err; req.cancel(); });
    });
    req.on('error', (err) => { failed ??= err instanceof TdsError ? err : new TdsError(err); });
    req.on('done', () => {
      chain.then(() => {
        if (failed) reject(failed);
        else if (!types) reject(new Error(t('La query non restituisce righe.')));
        else resolve(n);
      });
    });
    req.query(text);
  });
}

async function shutdown() {
  for (const id of [...conns.keys()]) await close(id);
}

const hasSession = (sid) => sessions.has(sid);
const isOpen = (connId) => conns.has(connId);

module.exports = { isTds, erModel, test, open, close, info, databases, objects, columns, indexes, ddl, schema, openSession, closeSession, useDb, exec, cancel, streamQuery, shutdown, hasSession, isOpen, cell, typeText };
