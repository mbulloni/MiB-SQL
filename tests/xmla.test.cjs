const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

// connections.cjs needs Electron: profiles and secrets come from this map instead
const profiles = new Map();
const connPath = require.resolve('../electron/connections.cjs');
require.cache[connPath] = { id: connPath, filename: connPath, loaded: true, exports: {
  get: (id) => profiles.get(id),
  secretsFor: async (def, given = {}) => ({ password: def.pw, ...given }),
  remember: async () => {},
} };

const xmla = require('../electron/xmla.cjs');
const { parseXml } = require('../electron/xml.cjs');
const fake = require(path.join(__dirname, 'fixtures/xmla-server.cjs'));

let ntlmServer, basicServer;
test.before(async () => {
  ntlmServer = await fake.start();
  basicServer = await fake.start({ auth: 'basic', user: 'olap', password: 'segreta' });
  const url = (s) => `http://127.0.0.1:${s.address().port}/olap/msmdpump.dll`;
  profiles.set('win', { id: 'win', engine: 'ssas', host: url(ntlmServer), user: 'RETE\\test', pw: 'test', database: fake.CATALOG });
  profiles.set('bad', { id: 'bad', engine: 'ssas', host: url(ntlmServer), user: 'RETE\\test', pw: 'sbagliata', database: fake.CATALOG });
  profiles.set('basic', { id: 'basic', engine: 'ssas', auth: 'basic', host: url(basicServer), user: 'olap', pw: 'segreta', database: fake.CATALOG });
});
test.after(async () => { await xmla.shutdown(); ntlmServer.close(); basicServer.close(); });

test('XML parser: entities, prefixes, quoted >, CDATA, self-closing', () => {
  const d = parseXml('<?xml version="1.0"?><a:x xmlns:a="u" t="1 &gt; 0"><y d="a>b"/><!-- c --><z>&lt;&#233;&#xE8;<![CDATA[<k>]]></z></a:x>');
  const x = d.children[0];
  assert.equal(x.name, 'x');
  assert.equal(x.attrs.t, '1 > 0');
  assert.equal(x.children[0].attrs.d, 'a>b');
  assert.equal(x.children[1].text, '<éè<k>');
});

test('Windows (NTLM) login, server version, catalogs and cubes', async () => {
  const info = await xmla.open('win');
  assert.equal(info.version, 'Analysis Services 15.0.35.41');
  assert.deepEqual(await xmla.databases('win'), ['cockpit_demo', 'cockpit_rel_o']);
  const o = await xmla.objects('win', fake.CATALOG);
  assert.deepEqual(o.tables.map((x) => [x.name, x.comment]), [['Ricavi', 'Ricavi per mese e prodotto']]);
});

test('wrong password: access denied (the renderer asks for the password again)', async () => {
  await assert.rejects(xmla.open('bad'), (err) => err.code === 'ER_ACCESS_DENIED');
});

test('Basic authentication', async () => {
  assert.match((await xmla.test(profiles.get('basic'))).version, /Analysis Services/);
  await assert.rejects(xmla.test({ ...profiles.get('basic'), pw: 'x' }), (err) => err.code === 'ER_ACCESS_DENIED');
});

test('cube structure: measures by group, dimensions without Measures, user hierarchy first, levels without (All)', async () => {
  const c = await xmla.cube('win', fake.CATALOG, fake.CUBE);
  assert.deepEqual(c.measures.map((m) => [m.name, m.group]), [['Importo', 'Vendite'], ['Quantità', 'Vendite'], ['Margine %', '']]);
  assert.deepEqual(c.dimensions.map((d) => d.name), ['Tempo', 'Prodotto']);
  assert.deepEqual(c.dimensions[0].hierarchies.map((h) => [h.name, h.user, h.levels.map((l) => l.name)]), [['Calendario', true, ['Anno', 'Mese']], ['Anno', false, ['Anno']]]);
  const s = await xmla.schema('win', fake.CATALOG);
  assert.ok(s.tables.Ricavi.columns.some((c2) => c2.name === '[Measures].[Importo]' && c2.type === 'MEASURE'));
});

test('MDX: flattened rowset with typed cells, empty cell = NULL; DAX: typed columns', async () => {
  const { id } = await xmla.openSession('win', fake.CATALOG);
  const r = await xmla.exec(id, 'SELECT {[Measures].[Importo], [Measures].[Quantita]} ON 0,\n  [Tempo].[Calendario].[Mese].MEMBERS * [Prodotto].[Categoria].[Categoria].MEMBERS ON 1\nFROM [Ricavi]\nGO\nEVALUATE SUMMARIZECOLUMNS(Prodotto[Categoria])');
  assert.equal(r.results.length, 2);
  const [mdx, dax] = r.results.map((x) => x.sets[0]);
  assert.deepEqual(mdx.columns.map((c) => [c.name, c.type]), [
    ['[Tempo].[Calendario].[Mese].[MEMBER_CAPTION]', 'VARCHAR'], ['[Prodotto].[Categoria].[Categoria].[MEMBER_CAPTION]', 'VARCHAR'],
    ['[Measures].[Importo]', 'DOUBLE'], ['[Measures].[Quantita]', 'INT']]);
  assert.equal(mdx.total, 9);
  assert.deepEqual(mdx.rows[0], ['Gennaio', 'Conti', 1000.25, 10]);
  assert.equal(mdx.rows[8][2], null);
  assert.deepEqual(dax.columns.map((c) => c.type), ['VARCHAR', 'DOUBLE', 'BIGINT']);
  assert.deepEqual(dax.rows[1], ['Carte', 25001, 80]);
  await xmla.closeSession(id);
});

test('server error text in the result; read-only connection refuses writes; other catalog via useDb', async () => {
  const { id } = await xmla.openSession('win', fake.CATALOG);
  const r = await xmla.exec(id, 'SELECT ERRORE() ON 0 FROM [Ricavi]');
  assert.match(r.results[0].error.message, /ERRORE function does not exist/);
  const w = await xmla.exec(id, 'DROP MEMBER [Measures].[x]');
  assert.match(w.results[0].error.message, /sola lettura|read-only/i);
  await xmla.useDb(id, 'inesistente');
  const e = await xmla.exec(id, 'SELECT {} ON 0 FROM [Ricavi]');
  assert.match(e.results[0].error.message, /does not exist/);
  await xmla.closeSession(id);
});

test('export stream gets every row', async () => {
  let cols = null;
  const rows = [];
  const n = await xmla.streamQuery('win', fake.CATALOG, 'EVALUATE Prodotto', (c) => { cols = c; }, async (r) => { rows.push(r); });
  assert.equal(n, 3);
  assert.equal(cols.length, 3);
  assert.equal(rows[2][0], 'Assicurazioni');
});

test('unreachable server: network error', async () => {
  await assert.rejects(xmla.test({ id: 'x', engine: 'ssas', host: 'http://127.0.0.1:9/olap/msmdpump.dll', user: 'RETE\\a' }), /irraggiungibile|unreachable/i);
});

test('a server name instead of the XMLA URL fails the connection (it must not look open)', async () => {
  profiles.set('name', { id: 'name', engine: 'ssas', host: 'DCPTHYPHPS', user: 'RETE\\test', pw: 'test' });
  await assert.rejects(xmla.open('name'), /msmdpump\.dll/);
  await assert.rejects(xmla.databases('name'), /non aperta|not open/i);
});
