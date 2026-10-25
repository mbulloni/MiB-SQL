import test from 'node:test';
import assert from 'node:assert/strict';
import { lowSelectivity, redundantIndexes, scannedTables, tablesWithoutPk, unusedIndexes } from '../src/indexes.ts';

const col = (name, extra = {}) => ({ name, expr: null, subPart: null, nullable: false, ...extra });
const ix = (table, name, cols, extra = {}) => ({ table, name, unique: false, primary: false, type: 'BTREE', cardinality: null, visible: true, columns: cols.map((c) => (typeof c === 'string' ? col(c) : c)), ...extra });
const data = (extra) => ({ db: 'd', indexes: [], tables: [], columns: [], fks: [], usage: null, usageSource: null, uptime: 1, flavor: 'mariadb', userstatAvailable: true, ps: false, ...extra });

test('duplicates and left-prefix redundancy', () => {
  const r = redundantIndexes([
    ix('t', 'PRIMARY', ['id'], { primary: true, unique: true }),
    ix('t', 'id_again', ['id']),                 // prefix of PRIMARY (same columns): duplicate, dropped
    ix('t', 'a', ['a']),                         // prefix of a_b
    ix('t', 'a_b', ['a', 'b']),
    ix('t', 'u_a', ['a'], { unique: true }),     // unique: kept even if a prefix of a_b
    ix('t', 'b_x', ['b', 'x']),
    ix('t', 'b_x2', ['b', 'x']),                 // duplicate of b_x: the later name goes
    ix('t', 'ft', ['a'], { type: 'FULLTEXT' }),  // other type: untouched
    ix('t', 'pfx', [col('c', { subPart: 10 })]),
    ix('t', 'full_c', ['c', 'd']),               // pfx(10) is covered by the full column c
    ix('u', 'a', ['a']),                         // other table
  ]);
  assert.deepEqual(r.map((x) => [x.table, x.index, x.by, x.duplicate]), [
    ['t', 'id_again', 'PRIMARY', true],
    ['t', 'a', 'a_b', false],
    ['t', 'b_x2', 'b_x', true],
    ['t', 'pfx', 'full_c', false],
  ]);
  assert.equal(r[1].sql, 'ALTER TABLE `t` DROP INDEX `a`;');
});

test('unused indexes keep the ones needed by foreign keys and unique constraints', () => {
  const d = data({
    indexes: [
      ix('o', 'PRIMARY', ['id'], { primary: true, unique: true }),
      ix('o', 'fk_c', ['customer_id']),
      ix('o', 'st', ['status']),
      ix('o', 'u_code', ['code'], { unique: true }),
      ix('o', 'used', ['created']),
    ],
    fks: [{ table: 'o', name: 'fk_orders_customer', columns: ['customer_id'] }],
    usage: [{ table: 'o', index: 'PRIMARY', count: 10, reads: 10 }, { table: 'o', index: 'used', count: 3, reads: 3 }, { table: 'o', index: 'st', count: 0, reads: 0 }, { table: 'o', index: null, count: 9000, reads: 9000 }],
    usageSource: 'ps',
  });
  const u = unusedIndexes(d);
  assert.deepEqual(u.map((x) => [x.index, x.fk, x.unique, x.sql]), [
    ['fk_c', 'fk_orders_customer', false, null],
    ['st', null, false, 'ALTER TABLE `o` DROP INDEX `st`;'],
    ['u_code', null, true, null],
  ]);
  assert.deepEqual(unusedIndexes(data({ indexes: d.indexes })), []);
  assert.deepEqual(scannedTables(d).map((s) => [s.table, s.rows, s.viaIndex]), [['o', 9000, 13]]);
});

test('tables without primary key', () => {
  const d = data({
    tables: [{ name: 'log', rows: 100 }, { name: 'map', rows: 5 }, { name: 'ok', rows: 1 }],
    columns: [{ table: 'log', name: 'id', type: 'int', nullable: true }, { table: 'log', name: 'msg', type: 'text', nullable: true }],
    indexes: [ix('map', 'u', ['a', 'b'], { unique: true }), ix('ok', 'PRIMARY', ['id'], { primary: true, unique: true })],
  });
  assert.deepEqual(tablesWithoutPk(d).map((x) => [x.table, x.candidate, x.sql]), [
    ['log', null, 'ALTER TABLE `log` ADD COLUMN `id2` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST;'],
    ['map', 'u', 'ALTER TABLE `map` DROP INDEX `u`, ADD PRIMARY KEY (`a`, `b`);'],
  ]);
});

test('low selectivity', () => {
  const d = data({ tables: [{ name: 't', rows: 1e6 }], indexes: [ix('t', 'flag', ['flag'], { cardinality: 2 }), ix('t', 'email', ['email'], { cardinality: 9e5 })] });
  assert.deepEqual(lowSelectivity(d).map((x) => x.index), ['flag']);
});
