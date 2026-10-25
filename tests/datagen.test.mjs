import test from 'node:test';
import assert from 'node:assert/strict';
import { columnsOf, enumValues, generator, guess, insertOrder, insertParams, insertSql, literal, numericRange } from '../src/datagen.ts';

const table = (name, columns, extra = {}) => ({ name, engine: 'InnoDB', collation: '', comment: '', indexes: [], foreignKeys: [], checks: [], partitioning: null,
  columns: columns.map(([n, type, opts = {}]) => ({ name: n, type, nullable: false, default: null, autoIncrement: false, onUpdate: '', collation: '', comment: '', generated: null, ...opts })), ...extra });

const customers = table('customers', [
  ['id', 'int(10) unsigned', { autoIncrement: true }], ['name', 'varchar(80)'], ['email', 'varchar(120)'], ['city', 'varchar(60)', { nullable: true }],
  ['created_at', 'datetime'], ['active', 'tinyint(1)'], ['note', 'text', { nullable: true }], ['kind', "enum('retail','b2b','vip''s')"],
], { indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', columns: [{ name: 'id', len: null }], comment: '' }, { name: 'email', kind: 'UNIQUE', columns: [{ name: 'email', len: null }], comment: '' }] });
const orders = table('orders', [
  ['id', 'bigint unsigned', { autoIncrement: true }], ['customer_id', 'int(10) unsigned'], ['total', 'decimal(12,2)'], ['qty', 'smallint'], ['code', 'char(10)'], ['payload', 'blob', { nullable: true }],
  ['total_vat', 'decimal(12,2)', { generated: { expr: 'total * 1.22', stored: false } }],
], { foreignKeys: [{ name: 'fk_c', columns: ['customer_id'], refDb: 'd', refTable: 'customers', refColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'RESTRICT' }] });

test('type helpers', () => {
  assert.deepEqual(enumValues("enum('a','b''c', 'd')"), ['a', "b'c", 'd']);
  assert.deepEqual(numericRange('tinyint(3) unsigned'), [0, 255]);
  assert.deepEqual(numericRange('smallint'), [-32768, 32767]);
  assert.equal(numericRange('decimal(5,2)')[1], 999.99);
});

test('generators guessed from names and types', () => {
  const g = Object.fromEntries([...columnsOf(customers), ...columnsOf(orders)].map((c) => [c.name, guess(c).kind]));
  assert.deepEqual(g, { id: 'skip', name: 'fullName', email: 'email', city: 'city', created_at: 'datetime', active: 'bool', note: 'text', kind: 'list',
    customer_id: 'fk', total: 'decimal', qty: 'int', code: 'pattern', payload: 'hex', total_vat: 'skip' });
  const cols = columnsOf(customers);
  assert.equal(cols.find((c) => c.name === 'email').unique, true);
  assert.equal(guess(cols.find((c) => c.name === 'kind')).value, "retail\nb2b\nvip's");
  assert.equal(guess(cols.find((c) => c.name === 'city')).nullPct, 10);
});

test('same seed, same rows; unique columns stay unique; lengths respected', () => {
  const cols = columnsOf(customers);
  const specs = Object.fromEntries(cols.map((c) => [c.name, guess(c)]));
  specs.email = { kind: 'list', value: 'a@x.it,b@x.it' }; // only two values for a unique column
  const run = () => { const g = generator(cols, specs, { seed: 7, lang: 'it', table: 'customers' }); return { cols: g.columns, rows: Array.from({ length: 50 }, () => g.next()) }; };
  const a = run();
  assert.deepEqual(a, run());
  assert.deepEqual(a.cols, ['name', 'email', 'city', 'created_at', 'active', 'note', 'kind']);
  const emails = a.rows.map((r) => r[1]);
  assert.equal(new Set(emails).size, 50);
  assert.ok(emails.every((e) => /^[ab]@x\.it(_\d+)?$/.test(e)));
  assert.ok(a.rows.some((r) => r[2] === null), 'some NULL cities');
  assert.ok(a.rows.every((r) => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(r[3])));
  assert.ok(a.rows.every((r) => r[4] === 0 || r[4] === 1));
  const short = generator([{ name: 's', type: 'varchar(5)', nullable: false, autoIncrement: false, generated: false, hasDefault: false, unique: true, maxLen: 5, fk: null }],
    { s: { kind: 'fixed', value: 'abcdefgh' } }, { seed: 1, lang: 'en', table: 't' });
  const vals = Array.from({ length: 12 }, () => short.next()[0]);
  assert.ok(vals.every((v) => v.length <= 5));
  assert.equal(new Set(vals).size, 12);
});

test('foreign keys take existing values; a missing parent is an error unless nullable', () => {
  const cols = columnsOf(orders);
  const specs = Object.fromEntries(cols.map((c) => [c.name, guess(c)]));
  const g = generator(cols, specs, { seed: 3, lang: 'en', table: 'orders', fkValues: { customer_id: [10, 20, 30] } });
  const rows = Array.from({ length: 30 }, () => g.next());
  assert.deepEqual(g.columns, ['customer_id', 'total', 'qty', 'code', 'payload']);
  assert.ok(rows.every((r) => [10, 20, 30].includes(r[0])));
  assert.ok(rows.every((r) => r[1] >= 1 && r[1] <= 1000 && Number(r[1].toFixed(2)) === r[1]));
  assert.ok(rows.every((r) => /^P-\d{6}$/.test(r[3]) || r[3] === null));
  assert.throws(() => generator(cols, specs, { seed: 3, lang: 'en', table: 'orders' }).next(), /genera prima le righe di customers/);
});

test('sequences, existing unique values, SQL output', () => {
  const col = { name: 'n', type: 'int', nullable: false, autoIncrement: false, generated: false, hasDefault: false, unique: true, maxLen: null, fk: null };
  const g = generator([col], { n: { kind: 'sequence', start: 5, step: 5 } }, { seed: 1, lang: 'it', table: 't', existing: { n: new Set(['10']) } });
  assert.deepEqual([g.next(), g.next(), g.next()].map((r) => r[0]), [5, 11, 15]);
  assert.equal(literal("l'a\\b\nc"), "'l''a\\\\b\\nc'");
  assert.equal(insertSql('t', ['a', 'b'], [[1, null], ['x', { hex: '00FF' }]]), "INSERT INTO `t` (`a`, `b`) VALUES\n  (1, NULL),\n  ('x', X'00FF');");
  assert.deepEqual(insertParams('t', ['a', 'b', 'c'], [[1, { hex: 'AB' }, { sql: 'NOW()' }], [2, null, { sql: 'NOW()' }]]),
    { sql: 'INSERT INTO `t` (`a`, `b`, `c`) VALUES (?, UNHEX(?), NOW()), (?, ?, NOW())', params: [1, 'AB', 2, null] });
});

test('insert order puts parents first and reports cycles', () => {
  const fk = (n, ref) => ({ name: n, columns: ['x'], refDb: 'd', refTable: ref, refColumns: ['id'], onDelete: '', onUpdate: '' });
  const ts = [table('items', [], { foreignKeys: [fk('a', 'orders'), fk('b', 'products')] }), table('orders', [], { foreignKeys: [fk('c', 'customers'), fk('self', 'orders')] }),
    table('customers', []), table('products', []), table('a', [], { foreignKeys: [fk('d', 'b')] }), table('b', [], { foreignKeys: [fk('e', 'a')] })];
  assert.deepEqual(insertOrder(ts, ['items', 'orders', 'customers', 'products']), { order: ['customers', 'products', 'orders', 'items'], cycle: [] });
  assert.deepEqual(insertOrder(ts, ['a', 'b', 'customers']), { order: ['customers', 'a', 'b'], cycle: ['a', 'b'] });
});

test('MariaDB JSON columns (LONGTEXT with json_valid) get JSON values', () => {
  const tb = table('p', [['attrs', 'longtext', { nullable: true, check: 'json_valid(`attrs`)' }], ['meta', 'longtext']], { checks: [{ name: 'c', expr: 'json_valid(`meta`)' }] });
  const cols = columnsOf(tb);
  assert.deepEqual(cols.map((c) => [c.type, guess(c).kind]), [['json', 'json'], ['json', 'json']]);
  const g = generator(cols, { attrs: { kind: 'json' }, meta: { kind: 'json' } }, { seed: 1, lang: 'it', table: 'p' });
  assert.doesNotThrow(() => JSON.parse(g.next()[0]));
});

test('composite keys never repeat; exhausted combinations are skipped', () => {
  const col = (name) => ({ name, type: 'int', nullable: false, autoIncrement: false, generated: false, hasDefault: false, unique: false, maxLen: null, fk: null });
  const g = generator([col('a'), col('b')], { a: { kind: 'int', min: 1, max: 3 }, b: { kind: 'int', min: 1, max: 2 } }, { seed: 5, lang: 'it', table: 't', keys: [['a', 'b']], existingKeys: [new Set(['1\u001f1'])] });
  const rows = Array.from({ length: 8 }, () => g.next());
  const made = rows.filter(Boolean).map((r) => r.join(','));
  assert.equal(made.length, 5); // 3 × 2 combinations minus the existing one
  assert.equal(new Set(made).size, 5);
  assert.ok(!made.includes('1,1'));
  assert.equal(g.skipped, 3);
});

test('binary columns respect their length', () => {
  const tb = table('b', [['uid', 'binary(16)'], ['v', 'varbinary(4)']]);
  const cols = columnsOf(tb);
  const specs = Object.fromEntries(cols.map((c) => [c.name, guess(c)]));
  assert.deepEqual([specs.uid.min, specs.uid.max, specs.v.max], [16, 16, 4]);
  const g = generator(cols, { ...specs, v: { kind: 'hex', min: 8, max: 32 } }, { seed: 2, lang: 'it', table: 'b' });
  for (let i = 0; i < 20; i++) { const [u, v] = g.next(); assert.equal(u.hex.length, 32); assert.ok(v.hex.length <= 8); }
});

test('the email follows the name generated in the same row', () => {
  const col = (name, type) => ({ name, type, nullable: false, autoIncrement: false, generated: false, hasDefault: false, unique: false, maxLen: 120, fk: null });
  const g = generator([col('name', 'varchar(80)'), col('email', 'varchar(120)')], { name: { kind: 'fullName' }, email: { kind: 'email' } }, { seed: 9, lang: 'it', table: 'p' });
  for (let i = 0; i < 20; i++) {
    const [name, email] = g.next();
    const [first, ...last] = name.split(' ');
    const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
    assert.ok(email.startsWith(`${norm(first)}.${norm(last.join(' '))}`), `${name} → ${email}`);
  }
});

test('composite foreign keys take whole parent rows', () => {
  const tb = table('lines', [['order_id', 'int'], ['ver', 'int'], ['qty', 'int']], {
    foreignKeys: [{ name: 'fk_ov', columns: ['order_id', 'ver'], refDb: 'd', refTable: 'order_versions', refColumns: ['id', 'version'], onDelete: '', onUpdate: '' }],
  });
  const cols = columnsOf(tb);
  assert.deepEqual(cols.slice(0, 2).map((c) => c.fk), [{ table: 'order_versions', column: 'id', group: 'fk_ov', index: 0 }, { table: 'order_versions', column: 'version', group: 'fk_ov', index: 1 }]);
  const specs = Object.fromEntries(cols.map((c) => [c.name, guess(c)]));
  const parents = [[1, 1], [1, 2], [2, 1]];
  const g = generator(cols, specs, { seed: 4, lang: 'it', table: 'lines', fkTuples: { fk_ov: parents } });
  for (let i = 0; i < 30; i++) {
    const [o, v] = g.next();
    assert.ok(parents.some(([a, b]) => a === o && b === v), `${o},${v}`);
  }
  assert.throws(() => generator(cols, specs, { seed: 4, lang: 'it', table: 'lines' }).next(), /genera prima le righe di order_versions/);
});
