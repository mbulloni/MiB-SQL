import test from 'node:test';
import assert from 'node:assert/strict';
import { alterSql, createSql, fromServer, newTable, removeColumn, togglePrimary, validate } from '../src/design.ts';

const col = (name, type, extra = {}) => ({ name, type, nullable: false, default: null, autoIncrement: false, onUpdate: '', collation: '', comment: '', generated: null, ...extra });
const server = {
  name: 'items',
  engine: 'InnoDB',
  collation: 'utf8mb4_unicode_ci',
  comment: '',
  columns: [
    col('id', 'int(10) unsigned', { autoIncrement: true }),
    col('code', 'varchar(20)'),
    col('cat_id', 'int(11)', { nullable: true, default: 'NULL' }),
    col('price', 'decimal(10,2)', { default: '0.00' }),
  ],
  indexes: [
    { name: 'PRIMARY', kind: 'PRIMARY', columns: [{ name: 'id', len: null }], comment: '' },
    { name: 'uq_code', kind: 'UNIQUE', columns: [{ name: 'code', len: null }], comment: '' },
  ],
  foreignKeys: [{ name: 'fk_cat', columns: ['cat_id'], refDb: 'shop', refTable: 'cats', refColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'RESTRICT' }],
};
const load = () => fromServer('shop', structuredClone(server));
const edit = (t, f) => { const c = structuredClone(t); f(c); return c; };

test('create table with columns, keys and options', () => {
  assert.equal(createSql(load()),
    'CREATE TABLE `shop`.`items` (\n' +
    '  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,\n' +
    '  `code` varchar(20) NOT NULL,\n' +
    '  `cat_id` int(11) NULL DEFAULT NULL,\n' +
    '  `price` decimal(10,2) NOT NULL DEFAULT 0.00,\n' +
    '  PRIMARY KEY (`id`),\n' +
    '  UNIQUE KEY `uq_code` (`code`),\n' +
    '  CONSTRAINT `fk_cat` FOREIGN KEY (`cat_id`) REFERENCES `cats` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT\n' +
    ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci');
});

test('no changes, no statements; type case does not count', () => {
  assert.deepEqual(alterSql(load(), load()), []);
  assert.deepEqual(alterSql(load(), edit(load(), (t) => { t.columns[1].type = 'VARCHAR(20)'; })), []);
  const e = edit(load(), (t) => { t.columns[1].type = "ENUM('A','b')"; });
  assert.match(alterSql(load(), e)[0], /enum\('A','b'\)/);
});

test('renaming a column keeps its indexes and foreign keys', () => {
  const cur = edit(load(), (t) => { t.columns[1].name = 'sku'; t.columns[2].name = 'category_id'; });
  assert.deepEqual(alterSql(load(), cur), [
    'ALTER TABLE `shop`.`items`\n  CHANGE COLUMN `code` `sku` varchar(20) NOT NULL,\n  CHANGE COLUMN `cat_id` `category_id` int(11) NULL DEFAULT NULL',
  ]);
});

test('add, move and drop columns with positions', () => {
  const cur = edit(load(), (t) => {
    const price = t.columns.pop();
    t.columns.splice(1, 0, price); // price after id
    t.columns.push({ ...col('note', 'text', { nullable: true }), id: 'n1', orig: null });
    t.columns.splice(0, 0, { ...col('ver', 'int'), id: 'n2', orig: null }); // first
  });
  assert.deepEqual(alterSql(load(), cur), [
    'ALTER TABLE `shop`.`items`\n' +
    '  ADD COLUMN `ver` int NOT NULL FIRST,\n' +
    '  CHANGE COLUMN `price` `price` decimal(10,2) NOT NULL DEFAULT 0.00 AFTER `id`,\n' +
    '  ADD COLUMN `note` text NULL AFTER `cat_id`',
  ]);
  const dropped = removeColumn(load(), 'c1');
  assert.deepEqual(alterSql(load(), dropped), ['ALTER TABLE `shop`.`items`\n  DROP INDEX `uq_code`,\n  DROP COLUMN `code`']);
  assert.equal(dropped.indexes.length, 1);
});

test('changed foreign key is dropped in its own statement, then re-added; rename goes last', () => {
  const cur = edit(load(), (t) => { t.foreignKeys[0].onDelete = 'CASCADE'; t.name = 'products'; t.comment = "it's"; });
  assert.deepEqual(alterSql(load(), cur), [
    'ALTER TABLE `shop`.`items`\n  DROP FOREIGN KEY `fk_cat`',
    "ALTER TABLE `shop`.`items`\n  ADD CONSTRAINT `fk_cat` FOREIGN KEY (`cat_id`) REFERENCES `cats` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT,\n  COMMENT='it''s'",
    'RENAME TABLE `shop`.`items` TO `shop`.`products`',
  ]);
});

test('index changes: primary key rebuilt, prefix length, table options', () => {
  const cur = edit(load(), (t) => {
    t.indexes[0].columns.push({ col: 'c1', len: null });
    t.indexes.push({ id: 'x', orig: null, name: 'ix_code', kind: 'INDEX', columns: [{ col: 'c1', len: 5 }], comment: '' });
    t.engine = 'Aria';
    t.collation = 'utf8mb4_bin';
    t.convert = true;
  });
  assert.deepEqual(alterSql(load(), cur), [
    'ALTER TABLE `shop`.`items`\n  DROP PRIMARY KEY,\n  ADD PRIMARY KEY (`id`, `code`),\n  ADD KEY `ix_code` (`code`(5)),\n  ENGINE=Aria,\n  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
  ]);
});

test('validation', () => {
  assert.deepEqual(validate(load()), []);
  assert.deepEqual(validate(newTable('shop', 'InnoDB', 'utf8mb4_general_ci')), []);
  const bad = edit(load(), (t) => {
    t.name = '';
    t.columns[1].name = 'ID';
    t.columns[3].collation = 'utf8mb4_bin';
    t.indexes = t.indexes.filter((i) => i.kind !== 'PRIMARY'); // id AUTO_INCREMENT without key
    t.foreignKeys[0].columns = ['c3'];
    t.foreignKeys[0].refColumns = ['id', 'x'];
  });
  assert.deepEqual(validate(bad), [
    'Nome tabella obbligatorio.',
    'id: AUTO_INCREMENT richiede che la colonna sia la prima di un indice.',
    'Colonna «ID» ripetuta.',
    'price: collation solo per tipi testo.',
    'Chiave esterna «fk_cat»: numero di colonne diverso da quelle riferite.',
    'Chiave esterna «fk_cat»: SET NULL richiede colonne che ammettono NULL.',
  ]);
});

test('primary key checkbox', () => {
  let t = togglePrimary(load(), 'c2');
  assert.deepEqual(t.indexes[0].columns.map((c) => c.col), ['c0', 'c2']);
  assert.equal(t.columns[2].nullable, false);
  t = togglePrimary(togglePrimary(t, 'c2'), 'c0');
  assert.equal(t.indexes.some((i) => i.kind === 'PRIMARY'), false);
});
