// SQL Server Analysis Services (cubes) through the XMLA HTTP endpoint (msmdpump.dll on IIS): SOAP Discover for the
// metadata, Execute for MDX/DAX in Tabular format (flattened rowset). Read-only. Windows authentication = NTLMv2
// handshake on a dedicated keep-alive socket per request (the handshake authenticates the connection, not the request);
// Basic for endpoints published with it over HTTPS.
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const connections = require('./connections.cjs');
const ntlm = require('./ntlm.cjs');
const { parseXml, find, findAll, attr, local, esc } = require('./xml.cjs');
const { batches, statementAt, firstWrite } = require('./tsqlsplit.cjs');
const { t } = require('./i18n.cjs');

const MAX_ROWS = 50000;
const conns = new Map(); // connId -> { def, sec, version }
const sessions = new Map(); // sid -> { connId, db, busy, cancelled, abort }

const isSsas = (def) => def?.engine === 'ssas';

// ---- rowsets ----

const unescapeName = (n) => n.replace(/_x([0-9A-Fa-f]{4})_/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const INTS = new Set(['int', 'long', 'short', 'byte', 'integer', 'unsignedInt', 'unsignedLong', 'unsignedShort', 'unsignedByte']);
const SQL_TYPES = { double: 'DOUBLE', float: 'DOUBLE', decimal: 'DECIMAL', boolean: 'BOOLEAN', dateTime: 'DATETIME', date: 'DATE', string: 'VARCHAR', int: 'INT', long: 'BIGINT', short: 'SMALLINT', unsignedInt: 'INT', unsignedLong: 'BIGINT', unsignedShort: 'SMALLINT', unsignedByte: 'TINYINT', byte: 'TINYINT', integer: 'BIGINT' };

function value(text, type) {
  if (INTS.has(type)) { const n = Number(text); return Number.isSafeInteger(n) ? n : text; }
  if (type === 'double' || type === 'float') { const n = Number(text); return Number.isFinite(n) ? n : text; }
  if (type === 'boolean') return text === 'true' || text === '1' ? 1 : 0;
  if (type === 'dateTime') return text.replace('T', ' ');
  return text;
}

/** Columns from the inline XSD (sql:field = the real name), rows with per-cell xsi:type (MDX cells carry it). */
function rowset(doc) {
  const root = findAll(doc, 'root').find((r) => r.children.some((c) => c.name === 'row' || c.name === 'schema'));
  if (!root) return { columns: [], rows: [] };
  const rowType = findAll(root, 'complexType').find((c) => c.attrs.name === 'row');
  const cols = rowType ? findAll(rowType, 'element').map((e) => ({
    key: e.attrs.name, name: attr(e, 'field') || unescapeName(e.attrs.name), type: e.attrs.type ? local(e.attrs.type) : null,
  })) : [];
  const index = new Map(cols.map((c, i) => [c.key, i]));
  const rows = [];
  for (const r of root.children) {
    if (r.name !== 'row') continue;
    const vals = new Array(cols.length).fill(null);
    for (const cell of r.children) {
      let k = index.get(cell.name);
      if (k === undefined) { k = cols.length; cols.push({ key: cell.name, name: unescapeName(cell.name), type: null }); index.set(cell.name, k); for (const p of rows) p.push(null); vals.push(null); }
      if (attr(cell, 'nil') === 'true') continue;
      const xt = attr(cell, 'type');
      const type = xt ? local(xt) : cols[k].type ?? 'string';
      if (!cols[k].type && xt) cols[k].seen ??= type;
      vals[k] = value(cell.children.length ? '' : cell.text, type);
    }
    rows.push(vals);
  }
  return { columns: cols.map((c) => ({ name: c.name, type: c.type ?? c.seen ?? 'string' })), rows };
}

/** Error text of a SOAP fault or of an XMLA exception inside the result. */
function errorOf(doc) {
  const fault = find(doc, 'Fault');
  const errors = findAll(fault ?? doc, 'Error').map((e) => e.attrs.Description).filter(Boolean);
  if (errors.length) return errors.join('\n');
  if (fault) return (find(fault, 'faultstring')?.text ?? t('Errore del server')).trim();
  return null;
}

const warningsOf = (doc) => findAll(doc, 'Warning').map((w) => ({ level: 'Warning', code: Number(w.attrs.WarningCode) || 0, message: w.attrs.Description ?? '' }));

class XmlaError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---- HTTP ----

function send(url, def, headers, body, signal) {
  const u = new URL(url);
  const lib = u.protocol === 'https:' ? https : http;
  const agent = headers.agent;
  return new Promise((resolve, reject) => {
    const req = lib.request(u, {
      method: 'POST', agent, rejectUnauthorized: !def.trustCert,
      headers: { ...headers.h, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', (err) => reject(signal?.aborted ? new XmlaError(t('Esecuzione annullata dall\'utente.')) : new XmlaError(t('Server irraggiungibile: {0}', err.message), err.code)));
    if (signal) {
      if (signal.aborted) req.destroy();
      signal.addEventListener('abort', () => req.destroy(), { once: true });
    }
    req.end(body);
  });
}

const challengeHeader = (res, scheme) => [].concat(res.headers['www-authenticate'] ?? [])
  .flatMap((h) => h.split(/,\s*(?=[A-Za-z]+\b)/)).map((h) => h.trim()).find((h) => h.toLowerCase().startsWith(scheme.toLowerCase() + ' '));

/** POST of a SOAP body; Windows authentication answers the 401 with the NTLM handshake on the same socket. */
async function post(c, action, body, signal) {
  const { def, sec } = c;
  if (!/^https?:\/\//i.test(def.host ?? '')) throw new XmlaError(t('Indirizzo XMLA non valido: serve http(s)://…/msmdpump.dll'), 'EURL');
  const lib = /^https:/i.test(def.host) ? https : http;
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 1 });
  const h = { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"urn:schemas-microsoft-com:xml-analysis:${action}"`, 'Accept-Encoding': 'identity' };
  if (def.auth === 'basic') h.Authorization = `Basic ${Buffer.from(`${def.user}:${sec.password ?? ''}`).toString('base64')}`;
  try {
    let res = await send(def.host, def, { h, agent }, body, signal);
    if (res.status === 401 && def.auth !== 'basic') {
      const offered = [].concat(res.headers['www-authenticate'] ?? []).join(',');
      const scheme = /\bNTLM\b/i.test(offered) ? 'NTLM' : /\bNegotiate\b/i.test(offered) ? 'Negotiate' : null;
      if (!scheme) throw new XmlaError(t('Il server non offre l\'autenticazione Windows (NTLM): {0}', offered || '—'), 'ER_ACCESS_DENIED');
      const r1 = await send(def.host, def, { h: { ...h, Authorization: `${scheme} ${ntlm.negotiate().toString('base64')}` }, agent }, '', signal);
      const ch = challengeHeader(r1, scheme);
      if (r1.status !== 401 || !ch) throw new XmlaError(t('Autenticazione Windows rifiutata dal server (HTTP {0}).', r1.status), 'ER_ACCESS_DENIED');
      const msg = ntlm.authenticate(Buffer.from(ch.slice(scheme.length + 1).trim(), 'base64'), def.user, sec.password ?? '', require('os').hostname().toUpperCase());
      res = await send(def.host, def, { h: { ...h, Authorization: `${scheme} ${msg.toString('base64')}` }, agent }, body, signal);
    }
    if (res.status === 401 || res.status === 403) throw new XmlaError(t('Accesso negato (HTTP {0}): authentication failed.', res.status), 'ER_ACCESS_DENIED');
    const doc = /xml/i.test(res.headers['content-type'] ?? '') || res.body.trimStart().startsWith('<') ? parseXml(res.body) : null;
    const err = doc && errorOf(doc);
    if (err) throw new XmlaError(err);
    if (res.status >= 400 || !doc) throw new XmlaError(t('Risposta HTTP {0} dal server XMLA.', res.status), 'EHTTP');
    return doc;
  } finally { agent.destroy(); }
}

const envelope = (inner) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${inner}</soap:Body></soap:Envelope>`;
const props = (catalog, extra = {}) => `<Properties><PropertyList>${Object.entries({ ...(catalog ? { Catalog: catalog } : {}), ...extra })
  .map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('')}</PropertyList></Properties>`;

async function discover(c, type, restrictions = {}, catalog = null) {
  const r = Object.entries(restrictions).map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join('');
  const doc = await post(c, 'Discover', envelope(`<Discover xmlns="urn:schemas-microsoft-com:xml-analysis"><RequestType>${type}</RequestType>`
    + `<Restrictions><RestrictionList>${r}</RestrictionList></Restrictions>${props(catalog, { Format: 'Tabular' })}</Discover>`));
  const { columns, rows } = rowset(doc);
  return rows.map((v) => Object.fromEntries(columns.map((col, i) => [col.name, v[i]])));
}

async function execute(c, statement, catalog, signal) {
  const doc = await post(c, 'Execute', envelope(`<Execute xmlns="urn:schemas-microsoft-com:xml-analysis"><Command><Statement>${esc(statement)}</Statement></Command>`
    + `${props(catalog, { Format: 'Tabular', Content: 'SchemaData' })}</Execute>`), signal);
  return { ...rowset(doc), warnings: warningsOf(doc) };
}

// ---- connections and metadata ----

async function serverInfo(c) {
  let version = '';
  try {
    const [p] = await discover(c, 'DISCOVER_PROPERTIES', { PropertyName: 'DBMSVersion' });
    version = String(p?.Value ?? '');
  } catch (err) { if (err.code || !(err instanceof XmlaError)) throw err; } // a fault only: the server answers, the property is missing
  return { version: `Analysis Services ${version}`.trim(), user: c.def.user || t('utente Windows'), comment: c.def.database || '' };
}

async function test(def, given) {
  const i = await serverInfo({ def, sec: await connections.secretsFor(def, given) });
  return { version: i.version, user: i.user };
}

async function open(connId, given) {
  const def = connections.get(connId);
  const sec = await connections.secretsFor(def, given);
  if (conns.has(connId)) {
    if (!given) return info(connId);
    await close(connId);
  }
  const c = { def, sec };
  const i = await serverInfo(c);
  conns.set(connId, { ...c, info: i });
  if (given) await connections.remember(def, sec);
  return i;
}

function entry(connId) {
  const c = conns.get(connId);
  if (!c) throw new Error(t('Connessione non aperta.'));
  return c;
}

async function info(connId) { return entry(connId).info; }

async function close(connId) {
  for (const [sid, s] of sessions) if (s.connId === connId) await closeSession(sid);
  conns.delete(connId);
}

async function databases(connId) {
  const c = entry(connId);
  const names = (await discover(c, 'DBSCHEMA_CATALOGS')).map((r) => String(r.CATALOG_NAME));
  // catalog names are case-insensitive on the server: the profile's spelling must not add a duplicate
  if (c.def.database && !names.some((x) => x.toLowerCase() === c.def.database.toLowerCase())) names.unshift(c.def.database);
  return names;
}

const isCube = (r) => !String(r.CUBE_NAME).startsWith('$') && (r.CUBE_SOURCE === undefined || Number(r.CUBE_SOURCE) === 1);

/** Cubes go in the tree's table slot; the Explorer draws them with their own folders. */
async function objects(connId, db) {
  const cubes = (await discover(entry(connId), 'MDSCHEMA_CUBES', { CATALOG_NAME: db }, db)).filter(isCube);
  return {
    tables: cubes.map((r) => ({ name: String(r.CUBE_NAME), engine: null, rows: null, comment: String(r.DESCRIPTION ?? ''), system: false })),
    views: [], procedures: [], functions: [], triggers: [], events: [],
  };
}

/** Measures (by measure group) and dimensions → hierarchies → levels of one cube. */
async function cube(connId, db, name) {
  const c = entry(connId);
  const r = { CATALOG_NAME: db, CUBE_NAME: name };
  const [ms, dims, hiers, levels] = await Promise.all(['MDSCHEMA_MEASURES', 'MDSCHEMA_DIMENSIONS', 'MDSCHEMA_HIERARCHIES', 'MDSCHEMA_LEVELS'].map((x) => discover(c, x, r, db)));
  const lv = new Map();
  for (const l of levels) {
    if (Number(l.LEVEL_TYPE) === 1) continue; // (All)
    const k = l.HIERARCHY_UNIQUE_NAME;
    if (!lv.has(k)) lv.set(k, []);
    lv.get(k).push({ name: String(l.LEVEL_CAPTION ?? l.LEVEL_NAME), unique: String(l.LEVEL_UNIQUE_NAME), n: Number(l.LEVEL_NUMBER) });
  }
  const hs = new Map();
  for (const h of hiers) {
    const k = h.DIMENSION_UNIQUE_NAME;
    if (!hs.has(k)) hs.set(k, []);
    hs.get(k).push({ name: String(h.HIERARCHY_CAPTION ?? h.HIERARCHY_NAME), unique: String(h.HIERARCHY_UNIQUE_NAME), user: (Number(h.HIERARCHY_ORIGIN) & 1) === 1,
      levels: (lv.get(h.HIERARCHY_UNIQUE_NAME) ?? []).sort((a, b) => a.n - b.n).map(({ name, unique }) => ({ name, unique })) });
  }
  return {
    measures: ms.filter((m) => m.MEASURE_IS_VISIBLE !== 0).map((m) => ({ name: String(m.MEASURE_CAPTION ?? m.MEASURE_NAME), unique: String(m.MEASURE_UNIQUE_NAME),
      group: String(m.MEASUREGROUP_NAME ?? ''), format: String(m.DEFAULT_FORMAT_STRING ?? ''), expression: String(m.EXPRESSION ?? '') })),
    dimensions: dims.filter((d) => Number(d.DIMENSION_TYPE) !== 2).map((d) => ({ name: String(d.DIMENSION_CAPTION ?? d.DIMENSION_NAME), unique: String(d.DIMENSION_UNIQUE_NAME),
      hierarchies: (hs.get(d.DIMENSION_UNIQUE_NAME) ?? []).sort((a, b) => Number(b.user) - Number(a.user) || a.name.localeCompare(b.name)) })),
  };
}

/** For completion and the assistant: each cube with its measures and hierarchies as columns. */
async function schema(connId, db) {
  const c = entry(connId);
  const [cubes, ms, hs] = await Promise.all([
    discover(c, 'MDSCHEMA_CUBES', { CATALOG_NAME: db }, db),
    discover(c, 'MDSCHEMA_MEASURES', { CATALOG_NAME: db }, db),
    discover(c, 'MDSCHEMA_HIERARCHIES', { CATALOG_NAME: db }, db),
  ]).catch(() => [[], [], []]);
  const tables = {};
  for (const cb of cubes.filter(isCube)) tables[cb.CUBE_NAME] = { kind: 'table', columns: [] };
  for (const m of ms) tables[m.CUBE_NAME]?.columns.push({ name: String(m.MEASURE_UNIQUE_NAME), type: 'MEASURE' });
  for (const h of hs) tables[h.CUBE_NAME]?.columns.push({ name: String(h.HIERARCHY_UNIQUE_NAME), type: 'HIERARCHY' });
  return { tables, routines: [] };
}

async function properties(connId, db, kind, name) {
  const [r] = await discover(entry(connId), 'MDSCHEMA_CUBES', { CATALOG_NAME: db, CUBE_NAME: name }, db);
  if (!r) throw new Error(t('Oggetto non trovato: {0}.', `${db}.${name}`));
  return ['CUBE_TYPE', 'LAST_SCHEMA_UPDATE', 'LAST_DATA_UPDATE', 'DESCRIPTION'].filter((k) => r[k] !== null && r[k] !== undefined && r[k] !== '')
    .map((k) => ({ key: k, value: String(r[k]) }));
}

const unavailable = () => { throw new Error(t('Non disponibile per Analysis Services.')); };
const columns = async () => [];
const indexes = async () => [];
const erModel = async () => ({ tables: [], fks: [] });
const ddl = async () => unavailable();

// ---- documents ----

function column(c) {
  const type = SQL_TYPES[c.type] ?? 'VARCHAR';
  return { name: c.name, table: '', orgTable: '', orgName: c.name, db: '', type, length: 0, scale: 0, binary: false, notNull: false, autoIncrement: false };
}

async function openSession(connId, db) {
  const c = entry(connId);
  const id = crypto.randomUUID();
  const target = db || c.def.database || null;
  sessions.set(id, { connId, db: target, busy: false, cancelled: false, abort: null });
  return { id, db: target };
}

async function closeSession(sid) {
  sessions.get(sid)?.abort?.abort();
  sessions.delete(sid);
}

async function useDb(sid, db) {
  const s = sessions.get(sid);
  if (!s) throw new Error(t('Sessione chiusa.'));
  s.db = db;
  return db;
}

/** Statements split like T-SQL batches (lines with GO); each one is an XMLA Execute. */
async function exec(sid, text, { mode = 'all', cursor = 0, selStart = 0, selEnd = 0, continueOnError = false, maxRows = MAX_ROWS } = {}) {
  const s = sessions.get(sid);
  if (!s) throw new Error(t('Sessione chiusa.'));
  if (s.busy) throw new Error(t('Una query è già in esecuzione in questo documento.'));
  if (mode === 'explain') throw new Error(t('Non disponibile per Analysis Services.'));
  let stmts;
  if (mode === 'selection') stmts = batches(text.slice(selStart, selEnd)).map((x) => ({ ...x, start: x.start + selStart, end: x.end + selStart }));
  else if (mode === 'current') { const one = statementAt(text, cursor); stmts = one ? [one] : []; }
  else stmts = batches(text);
  const c = entry(s.connId);
  s.busy = true;
  s.cancelled = false;
  const out = [];
  try {
    for (const st of stmts) {
      if (s.cancelled) break;
      const t0 = performance.now();
      const res = { sql: st.sql, start: st.start, end: st.end, sets: [], affectedRows: null, insertId: null, warnings: [], ms: 0, error: null };
      const write = c.def.readOnly !== false ? firstWrite(st.sql) : null;
      if (write) res.error = { message: t('Connessione in sola lettura: {0} non è consentito (si può cambiare nelle proprietà della connessione).', write.word), fatal: false };
      else {
        s.abort = new AbortController();
        try {
          const r = await execute(c, st.sql, s.db, s.abort.signal);
          res.sets.push({ columns: r.columns.map(column), rows: r.rows.slice(0, maxRows), total: r.rows.length, truncated: r.rows.length > maxRows });
          res.warnings.push(...r.warnings);
        } catch (err) {
          res.error = { message: s.cancelled ? t('Esecuzione annullata dall\'utente.') : err.message, code: err.code, fatal: false };
        } finally { s.abort = null; }
      }
      res.ms = Math.round(performance.now() - t0);
      out.push(res);
      if (res.error && !continueOnError) break;
    }
  } finally { s.busy = false; }
  return { results: out, db: s.db, cancelled: s.cancelled };
}

async function cancel(sid) {
  const s = sessions.get(sid);
  if (!s || !s.busy) return false;
  s.cancelled = true;
  s.abort?.abort();
  return true;
}

async function streamQuery(connId, db, text, onColumns, onRow) {
  const c = entry(connId);
  if (c.def.readOnly !== false) {
    const w = firstWrite(text);
    if (w) throw new Error(t('Connessione in sola lettura: {0} non è consentito (si può cambiare nelle proprietà della connessione).', w.word));
  }
  const r = await execute(c, text, db);
  if (!r.columns.length) throw new Error(t('La query non restituisce righe.'));
  onColumns(r.columns.map(column));
  let n = 0;
  for (const row of r.rows) await onRow(row, ++n);
  return n;
}

async function shutdown() {
  for (const id of [...conns.keys()]) await close(id);
}

const hasSession = (sid) => sessions.has(sid);
const isOpen = (connId) => conns.has(connId);

module.exports = {
  isSsas, test, open, close, info, databases, objects, cube, columns, indexes, ddl, schema, erModel, properties,
  openSession, closeSession, useDb, exec, cancel, streamQuery, shutdown, hasSession, isOpen,
  rowset, errorOf, discover, execute,
};
