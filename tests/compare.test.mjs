import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSchemas, lineDiff, scriptText, syncStatements } from '../src/compare.ts';

const col = (name, type, extra = {}) => ({ name, type, nullable: false, default: null, autoIncrement: false, onUpdate: '', collation: '', comment: '', generated: null, ...extra });
const table = (name, columns, extra = {}) => ({ name, engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', comment: '', columns, indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', columns: [{ name: columns[0].name, len: null }], comment: '' }], foreignKeys: [], ...extra });

const source = {
  tables: {
    customers: table('customers', [col('id', 'int(11)', { autoIncrement: true }), col('name', 'varchar(100)'), col('email', 'varchar(150)', { nullable: true, default: 'NULL' })]),
    orders: table('orders', [col('id', 'int(11)'), col('customer_id', 'int(11)')], {
      foreignKeys: [{ name: 'fk_c', columns: ['customer_id'], refDb: 'dev', refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: 'RESTRICT' }],
    }),
    same: table('same', [col('id', 'int(11)')]),
  },
  others: [
    { kind: 'view', name: 'v1', ddl: 'CREATE VIEW `v1` AS select 2 AS `x`' },
    { kind: 'procedure', name: 'p1', ddl: 'CREATE PROCEDURE `p1`() BEGIN SELECT 1; END' },
  ],
};
const target = {
  tables: {
    customers: table('customers', [col('id', 'int(11)', { autoIncrement: true }), col('name', 'varchar(50)')]),
    same: table('same', [col('id', 'int(11)')]),
    old: table('old', [col('id', 'int(11)')]),
  },
  others: [{ kind: 'view', name: 'v1', ddl: 'CREATE VIEW `v1` AS select 1 AS `x`' }],
};

test('statuses and sync statements per object', () => {
  const r = compareSchemas(source, target, 'dev', 'prod');
  const by = Object.fromEntries(r.map((i) => [`${i.kind}/${i.name}`, i]));
  assert.equal(by['table/same'].status, 'equal');
  assert.equal(by['table/old'].status, 'target');
  assert.deepEqual(by['table/old'].sync, ['DROP TABLE `prod`.`old`']);
  assert.equal(by['table/customers'].status, 'diff');
  assert.deepEqual(by['table/customers'].sync, ['ALTER TABLE `prod`.`customers`\n  CHANGE COLUMN `name` `name` varchar(100) NOT NULL,\n  ADD COLUMN `email` varchar(150) NULL DEFAULT NULL AFTER `name`']);
  assert.equal(by['table/orders'].status, 'source');
  assert.match(by['table/orders'].sync[0], /^CREATE TABLE `prod`\.`orders`/);
  assert.doesNotMatch(by['table/orders'].sync[0], /CONSTRAINT/);
  assert.match(by['table/orders'].sync[1], /^ALTER TABLE `prod`\.`orders`\n  ADD CONSTRAINT `fk_c` FOREIGN KEY \(`customer_id`\) REFERENCES `customers` \(`id`\) ON DELETE CASCADE/); // source db mapped to target
  assert.match(by['table/orders'].sourceDdl, /CONSTRAINT `fk_c`/);
  assert.deepEqual(by['view/v1'].sync, ['CREATE OR REPLACE VIEW `v1` AS select 2 AS `x`']);
  assert.deepEqual(by['procedure/p1'].sync, ['CREATE PROCEDURE `p1`() BEGIN SELECT 1; END']);
  assert.deepEqual(r.map((i) => i.kind), ['table', 'table', 'table', 'table', 'view', 'procedure']);
});

test('script wraps routines in DELIMITER and disables FK checks', () => {
  const r = compareSchemas(source, target, 'dev', 'prod').filter((i) => i.status !== 'equal');
  const st = syncStatements(r, 'prod');
  assert.equal(st[0], 'USE `prod`');
  assert.equal(st[1], 'SET FOREIGN_KEY_CHECKS = 0');
  const on = st.indexOf('SET FOREIGN_KEY_CHECKS = 1');
  assert.ok(st.slice(2, on).every((x) => /^(CREATE|DROP) TABLE/.test(x)));
  assert.ok(st.slice(on + 1).some((x) => /ADD CONSTRAINT `fk_c`/.test(x)));
  assert.match(scriptText(st), /DELIMITER \$\$\nCREATE PROCEDURE `p1`\(\) BEGIN SELECT 1; END\$\$\nDELIMITER ;/);
  assert.deepEqual(syncStatements([], 'prod'), []);
});

test('line diff', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nx\nc').map((l) => l.type + l.text), ['samea', 'addx', 'delb', 'samec']);
  assert.deepEqual(lineDiff('', 'a').map((l) => l.type), ['add']);
});
