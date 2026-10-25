import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQuery, groupSlowLog, normalizeSql, readQuery, tableRefs } from '../src/queryadvisor.ts';

const ix = (table, name, cols, extra = {}) => ({ table, name, unique: false, primary: false, type: 'BTREE', cardinality: null, visible: true, columns: cols.map((c) => ({ name: c, expr: null, subPart: null, nullable: false })), ...extra });
const tables = {
  orders: { name: 'orders', rows: 50000, columns: [{ name: 'id', type: 'int' }, { name: 'customer_id', type: 'int' }, { name: 'status', type: 'varchar' }, { name: 'created', type: 'datetime' }, { name: 'total', type: 'decimal' }],
    indexes: [ix('orders', 'PRIMARY', ['id'], { primary: true, unique: true })] },
  customers: { name: 'customers', rows: 2000, columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'varchar' }, { name: 'city', type: 'varchar' }, { name: 'note', type: 'text' }],
    indexes: [ix('customers', 'PRIMARY', ['id'], { primary: true, unique: true })] },
};

test('tables and aliases', () => {
  assert.deepEqual(tableRefs('SELECT * FROM orders o JOIN `customers` AS c ON c.id = o.customer_id, shop.items i WHERE x IN (SELECT y FROM z)'),
    [{ table: 'orders', alias: 'o' }, { table: 'customers', alias: 'c' }, { table: 'items', alias: 'i' }, { table: 'z', alias: 'z' }]);
  assert.deepEqual(tableRefs('UPDATE orders SET status = 1 WHERE id = 3'), [{ table: 'orders', alias: 'orders' }]);
  assert.deepEqual(tableRefs('DELETE FROM orders WHERE id = 3'), [{ table: 'orders', alias: 'orders' }]);
});

test('predicates: equality, ranges, joins, reversed, ORDER BY', () => {
  const q = readQuery("SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 'paid' AND o.created >= '2024-01-01' AND 5 < total AND c.city IN ('Roma') ORDER BY o.created DESC", tables);
  assert.deepEqual(q.preds.map((p) => `${p.table}.${p.column}:${p.kind}`), [
    'customers.id:join', 'orders.customer_id:join', 'orders.status:eq', 'orders.created:range', 'orders.total:range', 'customers.city:eq',
  ]);
  assert.deepEqual(q.order, [{ table: 'orders', column: 'created', desc: true }]);
  assert.equal(q.issues.length, 0);
});

test('lint: functions on columns, leading wildcard, implicit conversion, SELECT *, OR, NOT IN, big offsets', () => {
  const texts = readQuery("SELECT * FROM orders WHERE YEAR(created) = 2024 AND status = 5 OR customer_id = 3 AND status LIKE '%x' AND id NOT IN (SELECT id FROM customers) LIMIT 50000, 20", tables).issues.map((i) => i.text);
  assert.ok(texts.some((s) => s.startsWith('SELECT *')));
  assert.ok(texts.some((s) => s.startsWith('YEAR(created)')));
  assert.ok(texts.some((s) => /status è di tipo testo/.test(s)));
  assert.ok(texts.some((s) => /LIKE '%x' inizia con %/.test(s)));
  assert.ok(texts.some((s) => s.startsWith('NOT IN')));
  assert.ok(texts.some((s) => s.startsWith('OR tra condizioni')));
  assert.ok(texts.some((s) => /offset 50000/.test(s)));
});

test('index suggestion from a full scan: equalities first, then the range, then ORDER BY', () => {
  const plan = [{ id: 1, table: 'o', type: 'ALL', possible_keys: null, key: null, rows: 50000, extra: 'Using where; Using filesort' }];
  const r = analyzeQuery("SELECT id FROM orders o WHERE o.status = 'paid' AND o.customer_id = 7 AND o.created > '2024-01-01'", plan, tables);
  assert.deepEqual(r.suggestions.map((s) => s.sql), ['ALTER TABLE `orders` ADD INDEX `idx_orders_status_customer_id_created` (`status`, `customer_id`, `created`);']);
  assert.ok(r.issues.some((i) => /Scansione completa di orders/.test(i.text)));
  const sorted = analyzeQuery("SELECT id FROM orders WHERE status = 'paid' ORDER BY created", [{ table: 'orders', type: 'ALL', rows: 50000, extra: 'Using where; Using filesort' }], tables);
  assert.deepEqual(sorted.suggestions[0].columns, ['status', 'created']);
});

test('join without index on the inner table; existing indexes are not suggested again', () => {
  const plan = [
    { table: 'c', type: 'ALL', key: null, rows: 2000, extra: 'Using where' },
    { table: 'o', type: 'ALL', key: null, rows: 50000, extra: 'Using where; Using join buffer (flat, BNL join)' },
  ];
  const r = analyzeQuery("SELECT * FROM customers c JOIN orders o ON o.customer_id = c.id WHERE c.city = 'Roma'", plan, tables);
  assert.deepEqual(r.suggestions.map((s) => [s.table, s.columns.join()]), [['customers', 'id,city'], ['orders', 'customer_id']]);
  const withIdx = { ...tables, orders: { ...tables.orders, indexes: [...tables.orders.indexes, ix('orders', 'fk_cust', ['customer_id'])] } };
  const r2 = analyzeQuery('SELECT * FROM orders WHERE customer_id = 3', [{ table: 'orders', type: 'ALL', key: null, possible_keys: 'fk_cust', rows: 50000, extra: 'Using where' }], withIdx);
  assert.equal(r2.suggestions.length, 0);
  assert.ok(r2.issues.some((i) => /ANALYZE TABLE orders/.test(i.text)));
});

test('a good plan reports no problem', () => {
  const r = analyzeQuery('SELECT id FROM orders WHERE id = 1', [{ table: 'orders', type: 'const', key: 'PRIMARY', rows: 1, extra: 'Using index' }], tables);
  assert.equal(r.suggestions.length, 0);
  assert.ok(r.issues.every((i) => i.level === 'ok'));
});

test('slow log grouping by statement shape', () => {
  assert.equal(normalizeSql("select * from t where id = 12 and s in ('a', 'b', 3) limit 10"), 'SELECT * FROM t WHERE id = ? AND s IN (...) LIMIT ?');
  assert.equal(normalizeSql('SELECT a.b FROM x a WHERE f(a.c) > 2.5;'), 'SELECT a.b FROM x a WHERE f(a.c) > ?');
  const g = groupSlowLog([
    { at: '2026-01-01T10:00:00Z', who: 'u', ms: 1200, lockMs: 0, sent: 1, examined: 100000, db: 'd', text: 'SELECT * FROM t WHERE id = 1' },
    { at: '2026-01-01T11:00:00Z', who: 'u', ms: 3000, lockMs: 1, sent: 1, examined: 100000, db: 'd', text: 'SELECT * FROM t WHERE id = 2' },
    { at: '2026-01-01T09:00:00Z', who: 'u', ms: 500, lockMs: 0, sent: 5, examined: 5, db: 'd', text: 'SELECT 1' },
  ]);
  assert.equal(g.length, 2);
  assert.deepEqual([g[0].count, g[0].totalMs, g[0].maxMs, g[0].sample, g[0].firstSeen, g[0].lastSeen], [2, 4200, 3000, 'SELECT * FROM t WHERE id = 2', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z']);
});
