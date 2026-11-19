// Fake SSAS XMLA endpoint (msmdpump.dll) for tests and UI checks: IIS-like Windows authentication (NTLM handshake
// with the NTLMv2 proof verified) or Basic, SOAP Discover/Execute answered in the rowset format of SSAS.
//   node tests/fixtures/xmla-server.cjs [port]   → http://localhost:<port>/olap/msmdpump.dll, user RETE\test / test
const http = require('http');
const crypto = require('crypto');
const ntlm = require('../../electron/ntlm.cjs');
const { parseXml } = require('../../electron/xml.cjs');

const CATALOG = 'cockpit_demo';
const CUBE = 'Ricavi';

const MEASURES = [
  { MEASURE_NAME: 'Importo', MEASURE_UNIQUE_NAME: '[Measures].[Importo]', MEASURE_CAPTION: 'Importo', MEASUREGROUP_NAME: 'Vendite', DEFAULT_FORMAT_STRING: '#,##0.00', MEASURE_IS_VISIBLE: true },
  { MEASURE_NAME: 'Quantita', MEASURE_UNIQUE_NAME: '[Measures].[Quantita]', MEASURE_CAPTION: 'Quantità', MEASUREGROUP_NAME: 'Vendite', DEFAULT_FORMAT_STRING: '#,##0', MEASURE_IS_VISIBLE: true },
  { MEASURE_NAME: 'Margine %', MEASURE_UNIQUE_NAME: '[Measures].[Margine %]', MEASURE_CAPTION: 'Margine %', MEASUREGROUP_NAME: '', EXPRESSION: '[Measures].[Margine]/[Measures].[Importo]', MEASURE_IS_VISIBLE: true },
];
const DIMENSIONS = [
  { DIMENSION_NAME: 'Measures', DIMENSION_UNIQUE_NAME: '[Measures]', DIMENSION_CAPTION: 'Measures', DIMENSION_TYPE: 2 },
  { DIMENSION_NAME: 'Tempo', DIMENSION_UNIQUE_NAME: '[Tempo]', DIMENSION_CAPTION: 'Tempo', DIMENSION_TYPE: 1 },
  { DIMENSION_NAME: 'Prodotto', DIMENSION_UNIQUE_NAME: '[Prodotto]', DIMENSION_CAPTION: 'Prodotto', DIMENSION_TYPE: 3 },
];
const HIERARCHIES = [
  { DIMENSION_UNIQUE_NAME: '[Tempo]', HIERARCHY_NAME: 'Anno', HIERARCHY_UNIQUE_NAME: '[Tempo].[Anno]', HIERARCHY_CAPTION: 'Anno', HIERARCHY_ORIGIN: 2 },
  { DIMENSION_UNIQUE_NAME: '[Tempo]', HIERARCHY_NAME: 'Calendario', HIERARCHY_UNIQUE_NAME: '[Tempo].[Calendario]', HIERARCHY_CAPTION: 'Calendario', HIERARCHY_ORIGIN: 1 },
  { DIMENSION_UNIQUE_NAME: '[Prodotto]', HIERARCHY_NAME: 'Categoria', HIERARCHY_UNIQUE_NAME: '[Prodotto].[Categoria]', HIERARCHY_CAPTION: 'Categoria', HIERARCHY_ORIGIN: 2 },
];
const LEVELS = [
  { HIERARCHY_UNIQUE_NAME: '[Tempo].[Anno]', LEVEL_NAME: '(All)', LEVEL_UNIQUE_NAME: '[Tempo].[Anno].[(All)]', LEVEL_CAPTION: '(All)', LEVEL_NUMBER: 0, LEVEL_TYPE: 1 },
  { HIERARCHY_UNIQUE_NAME: '[Tempo].[Anno]', LEVEL_NAME: 'Anno', LEVEL_UNIQUE_NAME: '[Tempo].[Anno].[Anno]', LEVEL_CAPTION: 'Anno', LEVEL_NUMBER: 1, LEVEL_TYPE: 0 },
  { HIERARCHY_UNIQUE_NAME: '[Tempo].[Calendario]', LEVEL_NAME: 'Mese', LEVEL_UNIQUE_NAME: '[Tempo].[Calendario].[Mese]', LEVEL_CAPTION: 'Mese', LEVEL_NUMBER: 2, LEVEL_TYPE: 0 },
  { HIERARCHY_UNIQUE_NAME: '[Tempo].[Calendario]', LEVEL_NAME: 'Anno', LEVEL_UNIQUE_NAME: '[Tempo].[Calendario].[Anno]', LEVEL_CAPTION: 'Anno', LEVEL_NUMBER: 1, LEVEL_TYPE: 0 },
  { HIERARCHY_UNIQUE_NAME: '[Prodotto].[Categoria]', LEVEL_NAME: 'Categoria', LEVEL_UNIQUE_NAME: '[Prodotto].[Categoria].[Categoria]', LEVEL_CAPTION: 'Categoria', LEVEL_NUMBER: 1, LEVEL_TYPE: 0 },
];
const withCube = (rows) => rows.map((r) => ({ CATALOG_NAME: CATALOG, CUBE_NAME: CUBE, ...r }));
const ROWSETS = {
  DISCOVER_PROPERTIES: [{ PropertyName: 'DBMSVersion', Value: '15.0.35.41' }],
  DBSCHEMA_CATALOGS: [{ CATALOG_NAME: CATALOG, DESCRIPTION: '' }, { CATALOG_NAME: 'cockpit_rel_o', DESCRIPTION: '' }],
  MDSCHEMA_CUBES: [
    { CATALOG_NAME: CATALOG, CUBE_NAME: CUBE, CUBE_TYPE: 'CUBE', CUBE_SOURCE: 1, LAST_SCHEMA_UPDATE: '2026-11-02T08:15:00', LAST_DATA_UPDATE: '2026-11-19T06:00:00', DESCRIPTION: 'Ricavi per mese e prodotto' },
    { CATALOG_NAME: CATALOG, CUBE_NAME: '$Tempo', CUBE_TYPE: 'DIMENSION', CUBE_SOURCE: 2 },
  ],
  MDSCHEMA_MEASURES: withCube(MEASURES), MDSCHEMA_DIMENSIONS: withCube(DIMENSIONS), MDSCHEMA_HIERARCHIES: withCube(HIERARCHIES), MDSCHEMA_LEVELS: withCube(LEVELS),
};

const xsdType = (v) => (typeof v === 'number' ? (Number.isInteger(v) ? 'xsd:int' : 'xsd:double') : typeof v === 'boolean' ? 'xsd:boolean' : 'xsd:string');
const xname = (n) => n.replace(/[^A-Za-z0-9]/g, (ch) => `_x${ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** columns: [{ name, type? }]; typedCells: each cell carries xsi:type, like an MDX flattened rowset. */
function rowsetXml(action, columns, rows, typedCells = false) {
  const schema = columns.map((c) => `<xsd:element sql:field="${esc(c.name).replace(/"/g, '&quot;')}" name="${xname(c.name)}"${c.type ? ` type="${c.type}"` : ''} minOccurs="0"/>`).join('');
  const body = rows.map((r) => `<row>${columns.map((c, i) => (r[i] === null || r[i] === undefined ? ''
    : `<${xname(c.name)}${typedCells ? ` xsi:type="${xsdType(r[i])}"` : ''}>${esc(r[i])}</${xname(c.name)}>`)).join('')}</row>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${action}Response xmlns="urn:schemas-microsoft-com:xml-analysis"><return>`
    + `<root xmlns="urn:schemas-microsoft-com:xml-analysis:rowset" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `<xsd:schema targetNamespace="urn:schemas-microsoft-com:xml-analysis:rowset" xmlns:sql="urn:schemas-microsoft-com:xml-sql" elementFormDefault="qualified">`
    + `<xsd:element name="root"><xsd:complexType><xsd:sequence minOccurs="0" maxOccurs="unbounded"><xsd:element name="row" type="row"/></xsd:sequence></xsd:complexType></xsd:element>`
    + `<xsd:complexType name="row"><xsd:sequence>${schema}</xsd:sequence></xsd:complexType></xsd:schema>${body}</root></return></${action}Response></soap:Body></soap:Envelope>`;
}

const fault = (msg) => `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><soap:Fault xmlns="http://schemas.xmlsoap.org/soap/envelope/">`
  + `<faultcode>XMLAnalysisError.0xc10b0003</faultcode><faultstring>${esc(msg)}</faultstring><detail><Error ErrorCode="3240034316" Description="${esc(msg)}" Source="Microsoft SQL Server 2019 Analysis Services" HelpFile=""/></detail></soap:Fault></soap:Body></soap:Envelope>`;

function discoverResponse(doc) {
  const type = doc.children.length && findText(doc, 'RequestType');
  const all = ROWSETS[type];
  if (!all) return fault(`The '${type}' request type was not recognized by the server.`);
  const restr = find(doc, 'RestrictionList');
  const rows = all.filter((r) => (restr?.children ?? []).every((x) => r[x.name] === undefined || String(r[x.name]) === x.text));
  const names = [...new Set(all.flatMap((r) => Object.keys(r)))];
  return rowsetXml('Discover', names.map((n) => ({ name: n, type: xsdType(all.find((r) => r[n] !== undefined)[n]) })), rows.map((r) => names.map((n) => r[n] ?? null)));
}

const MONTHS = ['Gennaio', 'Febbraio', 'Marzo'];
const CATS = ['Conti', 'Carte', 'Assicurazioni'];
function executeResponse(doc) {
  const stmt = findText(doc, 'Statement').trim();
  const catalog = findText(doc, 'Catalog');
  if (/ERRORE/i.test(stmt)) return fault('Query (1, 8) The ERRORE function does not exist.');
  if (catalog && catalog !== CATALOG && catalog !== 'cockpit_rel_o') return fault(`Either the user does not have access to the ${catalog} database, or the database does not exist.`);
  if (/^EVALUATE/i.test(stmt)) {
    const cols = [{ name: 'Prodotto[Categoria]', type: 'xsd:string' }, { name: '[Importo]', type: 'xsd:double' }, { name: '[Quantita]', type: 'xsd:long' }];
    return rowsetXml('Execute', cols, CATS.map((c, i) => [c, 12500.5 * (i + 1), 40 * (i + 1)]));
  }
  // MDX flattened rowset: member captions per level, measures with xsi:type on each cell
  const cols = [{ name: '[Tempo].[Calendario].[Mese].[MEMBER_CAPTION]' }, { name: '[Prodotto].[Categoria].[Categoria].[MEMBER_CAPTION]' }, { name: '[Measures].[Importo]' }, { name: '[Measures].[Quantita]' }];
  const rows = [];
  MONTHS.forEach((m, i) => CATS.forEach((c, j) => rows.push([m, c, i === 2 && j === 2 ? null : 1000.25 * (i + 1) + j * 333.1, 10 * (i + 1) + j])));
  return rowsetXml('Execute', cols, rows, true);
}

function find(el, name) { if (el.name === name) return el; for (const c of el.children) { const r = find(c, name); if (r) return r; } return null; }
const findText = (el, name) => find(el, name)?.text ?? '';

/** NTLMv2 check of an AUTHENTICATE message: recompute the proof from the blob the client sent. */
function verify(msg, user, password, challenge) {
  const field = (i) => msg.subarray(msg.readUInt32LE(16 + i * 8), msg.readUInt32LE(16 + i * 8) + msg.readUInt16LE(12 + i * 8));
  const domain = field(2).toString('utf16le');
  const name = field(3).toString('utf16le');
  const want = ntlm.splitUser(user);
  if (name.toLowerCase() !== want.user.toLowerCase() || domain.toLowerCase() !== want.domain.toLowerCase()) return false;
  const nt = field(1);
  const key = ntlm.ntowfv2(password, name, domain);
  const proof = crypto.createHmac('md5', key).update(Buffer.concat([challenge, nt.subarray(16)])).digest();
  return proof.equals(nt.subarray(0, 16));
}

function challengeMessage(challenge) {
  const av = Buffer.concat([Buffer.from([2, 0, 8, 0]), Buffer.from('RETE', 'utf16le'), Buffer.alloc(4)]);
  const m = Buffer.alloc(48);
  Buffer.from('NTLMSSP\0', 'latin1').copy(m);
  m.writeUInt32LE(2, 8);
  m.writeUInt32LE(0xa2898205, 20);
  challenge.copy(m, 24);
  m.writeUInt16LE(av.length, 40); m.writeUInt16LE(av.length, 42); m.writeUInt32LE(48, 44);
  return Buffer.concat([m, av]);
}

function start({ port = 0, user = 'RETE\\test', password = 'test', auth = 'ntlm', delay = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const h = req.headers.authorization ?? '';
      const deny = (extra) => { res.writeHead(401, { 'WWW-Authenticate': extra ?? (auth === 'basic' ? 'Basic realm="olap"' : ['Negotiate', 'NTLM']), 'Content-Length': 0 }); res.end(); };
      if (auth === 'basic') {
        if (h !== `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`) return deny();
      } else {
        const m = /^(NTLM|Negotiate) (.+)$/.exec(h);
        if (m) {
          const msg = Buffer.from(m[2], 'base64');
          const type = msg.readUInt32LE(8);
          if (type === 1) { req.socket.challenge = crypto.randomBytes(8); return deny(`${m[1]} ${challengeMessage(req.socket.challenge).toString('base64')}`); }
          if (type !== 3 || !req.socket.challenge || !verify(msg, user, password, req.socket.challenge)) return deny();
          req.socket.authed = true; // like IIS: the connection stays authenticated
        }
        if (!req.socket.authed) return deny();
      }
      const doc = parseXml(body);
      const xml = find(doc, 'Discover') ? discoverResponse(doc) : find(doc, 'Execute') ? executeResponse(doc) : fault('Bad request');
      setTimeout(() => {
        res.writeHead(xml.includes('soap:Fault') ? 500 : 200, { 'Content-Type': 'text/xml' });
        res.end(xml);
      }, delay);
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

module.exports = { start, CATALOG, CUBE };

if (require.main === module) {
  start({ port: Number(process.argv[2]) || 8089 }).then((s) => console.log(`XMLA finto: http://localhost:${s.address().port}/olap/msmdpump.dll  utente RETE\\test  password test`));
}
