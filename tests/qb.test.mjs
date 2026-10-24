import test from 'node:test';
import assert from 'node:assert/strict';
import { aliasFor, autoJoins, emptyQuery, toSql, value } from '../src/qb.ts';

const T = (id, table, alias, db = 'shop') => ({ id, db, table, alias, x: 0, y: 0, columns: [] });
const C = (t, col, extra = {}) => ({ id: `${t}.${col}`, t, col, alias: '', agg: '', sort: '', output: true, ...extra });
const fks = [
  { table: 'orders', columns: ['customer_id'], refTable: 'customers', refColumns: ['id'] },
  { table: 'items', columns: ['order_id'], refTable: 'orders', refColumns: ['id'] },
];

test('aliases are short and unique', () => {
  assert.equal(aliasFor('orders', []), 'o');
  assert.equal(aliasFor('order_items', []), 'oi');
  assert.equal(aliasFor('orders', ['o']), 'o2');
  assert.equal(aliasFor('2fa', []), 't2');
});

test('filter values: numbers and expressions raw, text quoted', () => {
  assert.deepEqual(['5', '-1.5', "'x'", 'now()', '(select 1)', 'NULL', "it's", 'Roma'].map(value), ['5', '-1.5', "'x'", 'now()', '(select 1)', 'NULL', "'it''s'", "'Roma'"]);
});

test('select star from a single table', () => {
  const m = { ...emptyQuery(), tables: [T('a', 'orders', 'orders')] };
  assert.equal(toSql(m, 'shop'), 'SELECT *\nFROM `orders`\nLIMIT 1000');
});

test('auto joins from foreign keys and join orientation', () => {
  const m = emptyQuery();
  m.tables.push(T('c', 'customers', 'c'));
  const o = T('o', 'orders', 'o');
  m.tables.push(o);
  m.joins.push(...autoJoins(m, o, fks));
  const i = T('i', 'items', 'i');
  m.tables.push(i);
  m.joins.push(...autoJoins(m, i, fks));
  assert.equal(m.joins.length, 2);
  m.joins[0].type = 'LEFT';
  m.columns = [C('c', 'name'), C('o', 'id', { agg: 'COUNT', alias: 'ordini', sort: 'DESC' }), C('i', 'qty', { agg: 'SUM' })];
  m.filters = [
    { id: 'f1', t: 'c', col: 'city', op: 'IN', value: 'Roma, Milano', having: false },
    { id: 'f2', t: 'o', col: 'id', op: '>', value: '3', having: true },
    { id: 'f3', t: 'o', col: 'ordered_at', op: 'BETWEEN', value: '2025-01-01 e 2025-12-31', having: false },
  ];
  m.limit = '';
  assert.equal(toSql(m, 'shop'),
    'SELECT `c`.`name`,\n  COUNT(`o`.`id`) AS `ordini`,\n  SUM(`i`.`qty`)\n' +
    'FROM `customers` AS `c`\n' +
    'LEFT JOIN `orders` AS `o` ON `c`.`id` = `o`.`customer_id`\n' +
    'INNER JOIN `items` AS `i` ON `o`.`id` = `i`.`order_id`\n' +
    "WHERE `c`.`city` IN ('Roma', 'Milano')\n  AND `o`.`ordered_at` BETWEEN '2025-01-01' AND '2025-12-31'\n" +
    'GROUP BY `c`.`name`\n' +
    'HAVING COUNT(`o`.`id`) > 3\n' +
    'ORDER BY `ordini` DESC');
});

test('join added from the new table side flips LEFT/RIGHT; unjoined tables cross join; other databases qualified', () => {
  const m = emptyQuery();
  m.tables = [T('a', 'customers', 'c'), T('b', 'orders', 'o'), T('x', 'log', 'l', 'other')];
  m.joins = [{ id: 'j', left: { t: 'b', col: 'customer_id' }, right: { t: 'a', col: 'id' }, type: 'LEFT' }];
  m.distinct = true;
  m.columns = [C('a', '*')];
  assert.equal(toSql(m, 'shop'),
    'SELECT DISTINCT `c`.*\nFROM `customers` AS `c`\nRIGHT JOIN `orders` AS `o` ON `o`.`customer_id` = `c`.`id`\nCROSS JOIN `other`.`log` AS `l`\nLIMIT 1000');
});
