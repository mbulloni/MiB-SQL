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

test('CHECK constraints and DESC index columns', () => {
  const srv = structuredClone(server);
  srv.columns.push({ ...col('attrs', 'longtext', { nullable: true, default: 'NULL' }), check: 'json_valid(`attrs`)' });
  srv.checks = [{ name: 'ck_price', expr: '`price` >= 0' }];
  srv.indexes.push({ name: 'ix_p', kind: 'INDEX', columns: [{ name: 'price', len: null, desc: true }, { name: 'id', len: null }], comment: '' });
  const t = fromServer('shop', srv);
  const sql = createSql(t);
  assert.match(sql, /`attrs` longtext NULL DEFAULT NULL CHECK \(json_valid\(`attrs`\)\)/);
  assert.match(sql, /KEY `ix_p` \(`price` DESC, `id`\)/);
  assert.match(sql, /CONSTRAINT `ck_price` CHECK \(`price` >= 0\)/);
  assert.deepEqual(alterSql(t, structuredClone(t)), []);
  // moving the JSON column keeps its CHECK; the table CHECK is dropped first, re-added in the main ALTER
  const cur = edit(t, (x) => {
    const a = x.columns.pop(); x.columns.splice(1, 0, a);
    x.checks[0].expr = '`price` > 0';
    x.checks.push({ id: 'k9', orig: null, name: 'ck_code', expr: "`code` <> ''" });
    x.indexes[2].columns[0].desc = false;
  });
  assert.deepEqual(alterSql(t, cur), [
    'ALTER TABLE `shop`.`items`\n  DROP CONSTRAINT `ck_price`',
    'ALTER TABLE `shop`.`items`\n  DROP INDEX `ix_p`,\n  CHANGE COLUMN `attrs` `attrs` longtext NULL DEFAULT NULL CHECK (json_valid(`attrs`)) AFTER `id`,\n' +
    "  ADD KEY `ix_p` (`price`, `id`),\n  ADD CONSTRAINT `ck_price` CHECK (`price` > 0),\n  ADD CONSTRAINT `ck_code` CHECK (`code` <> '')",
  ]);
  assert.deepEqual(validate(edit(t, (x) => { x.checks.push({ id: 'z', orig: null, name: 'CK_PRICE', expr: '' }); })), ['Vincolo CHECK «CK_PRICE» ripetuto.', 'Vincolo CHECK «CK_PRICE»: espressione obbligatoria.']);
});

test('partitions: create, add/drop at the end, reorganize, repartition, remove', () => {
  const srv = structuredClone(server);
  srv.partitioning = { method: 'RANGE', expr: 'year(`d`)', subpartitioned: false, partitions: [
    { name: 'p2024', values: '2025', comment: '', rows: 0 }, { name: 'p2025', values: '2026', comment: 'corrente', rows: 0 }] };
  const t = fromServer('shop', srv);
  assert.match(createSql(t), /\nPARTITION BY RANGE \(year\(`d`\)\) \(\n  PARTITION `p2024` VALUES LESS THAN \(2025\),\n  PARTITION `p2025` VALUES LESS THAN \(2026\) COMMENT 'corrente'\n\)$/);
  assert.deepEqual(alterSql(t, structuredClone(t)), []);
  const T = '`shop`.`items`';
  // append MAXVALUE and drop the first: two statements
  let cur = edit(t, (x) => { x.partitioning.partitions.shift(); x.partitioning.partitions.push({ id: 'n', orig: null, name: 'pmax', values: 'MAXVALUE', comment: '' }); });
  assert.deepEqual(alterSql(t, cur), [`ALTER TABLE ${T} DROP PARTITION \`p2024\``, `ALTER TABLE ${T} ADD PARTITION (\n  PARTITION \`pmax\` VALUES LESS THAN MAXVALUE\n)`]);
  // changing a bound reorganizes; expression typed differently but equal does not repartition
  cur = edit(t, (x) => { x.partitioning.partitions[0].values = '2024'; x.partitioning.expr = 'YEAR(d)'; });
  assert.deepEqual(alterSql(t, cur), [`ALTER TABLE ${T} REORGANIZE PARTITION \`p2024\`, \`p2025\` INTO (\n  PARTITION \`p2024\` VALUES LESS THAN (2024),\n  PARTITION \`p2025\` VALUES LESS THAN (2026) COMMENT 'corrente'\n)`]);
  cur = edit(t, (x) => { x.partitioning = { method: 'HASH', expr: '`id`', count: 4, partitions: [] }; });
  assert.deepEqual(alterSql(t, cur), [`ALTER TABLE ${T} PARTITION BY HASH (\`id\`) PARTITIONS 4`]);
  assert.deepEqual(alterSql(t, edit(t, (x) => { x.partitioning = null; })), [`ALTER TABLE ${T} REMOVE PARTITIONING`]);
  assert.deepEqual(validate(edit(t, (x) => { x.partitioning.partitions[0].values = 'MAXVALUE'; x.partitioning.partitions[1].name = 'P2024'; })),
    ['Partizioni: MAXVALUE solo nell\'ultima partizione.', 'Partizione «P2024» ripetuta.']);
  const list = fromServer('shop', { ...structuredClone(server), partitioning: { method: 'LIST COLUMNS', expr: '`code`', subpartitioned: false, partitions: [{ name: 'a', values: "'X','Y'", comment: '', rows: 0 }] } });
  assert.match(createSql(list), /PARTITION BY LIST COLUMNS \(`code`\) \(\n  PARTITION `a` VALUES IN \('X','Y'\)\n\)/);
  const sub = fromServer('shop', { ...structuredClone(server), partitioning: { method: 'RANGE', expr: 'id', subpartitioned: true, partitions: [{ name: 'a', values: '10', comment: '', rows: 0 }] } });
  assert.deepEqual(alterSql(sub, edit(sub, (x) => { x.partitioning = null; })), []); // subpartitioned: never touched
});
