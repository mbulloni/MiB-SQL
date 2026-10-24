import test from 'node:test';
import assert from 'node:assert/strict';
import { addRow, editCount, editTarget, emptyEdits, inline, keyAfter, setCell, statements, toggleDelete, valueAt } from '../src/edits.ts';

const col = (name, extra = {}) => ({ name, table: 't', orgTable: 'items', orgName: name, db: 'shop', type: 'VAR_STRING', length: 0, scale: 0, binary: false, notNull: false, autoIncrement: false, ...extra });
const columns = [col('id', { type: 'INT', notNull: true, autoIncrement: true }), col('name'), col('price', { type: 'NEWDECIMAL' })];
const rows = [[1, 'a', '1.50'], [2, 'b', null]];
const pk = [{ name: 'PRIMARY', unique: true, primary: true, type: 'BTREE', columns: ['id'] }];

test('edit target needs one table and its key', () => {
  assert.deepEqual(editTarget(columns, pk), { db: 'shop', table: 'items', key: [0] });
  assert.match(editTarget(columns.slice(1), pk), /chiave primaria \(id\)/);
  assert.match(editTarget([...columns, col('x', { orgTable: 'other' })], pk), /più tabelle/);
  assert.match(editTarget([col('n', { orgTable: '', orgName: '' })], pk), /non proviene/);
  assert.match(editTarget(columns, []), /non ha una chiave/);
  const uq = [{ name: 'uq', unique: true, primary: false, type: 'BTREE', columns: ['name'] }];
  assert.match(editTarget(columns, uq), /non ha una chiave/); // nullable unique column is not a key
  assert.deepEqual(editTarget([col('id'), col('name', { notNull: true })], uq), { db: 'shop', table: 'items', key: [1] });
});

test('setting a value back to the original clears the edit', () => {
  let e = setCell(emptyEdits(), rows, 0, 1, 'z');
  assert.equal(valueAt(rows, e, 0, 1), 'z');
  assert.equal(editCount(e), 1);
  e = setCell(e, rows, 0, 1, 'a');
  assert.deepEqual(e.updates, {});
  assert.equal(setCell(emptyEdits(), rows, 0, 2, '1.50').updates[0], undefined);
});

test('statements: delete, update by original key, insert with only set columns', () => {
  let e = setCell(emptyEdits(), rows, 0, 1, "it's");
  e = setCell(e, rows, 0, 0, 10); // key change: WHERE uses the original id
  e = toggleDelete(e, rows, [1]);
  e = addRow(e);
  e = setCell(e, rows, 2, 1, 'new');
  e = addRow(e);
  const st = statements(editTarget(columns, pk), columns, rows, e);
  assert.deepEqual(st.map(inline), [
    'DELETE FROM `shop`.`items` WHERE `id` = 2 LIMIT 1',
    "UPDATE `shop`.`items` SET `id` = 10, `name` = 'it''s' WHERE `id` = 1 LIMIT 1",
    "INSERT INTO `shop`.`items` (`name`) VALUES ('new')",
    'INSERT INTO `shop`.`items` () VALUES ()',
  ]);
  assert.deepEqual(st[1].params, [10, "it's", 1]);
  assert.equal(st[0].expectOne, true);
  assert.equal(st[2].expectOne, undefined);
});

test('updates of deleted rows are skipped; toggling restores; new rows are dropped', () => {
  let e = setCell(emptyEdits(), rows, 1, 1, 'x');
  e = toggleDelete(e, rows, [1]);
  assert.equal(statements(editTarget(columns, pk), columns, rows, e).length, 1);
  e = toggleDelete(e, rows, [1]);
  assert.deepEqual(e.deleted, []);
  e = toggleDelete(addRow(e), rows, [2]);
  assert.equal(e.inserted.length, 0);
});

test('new rows show DEFAULT until set and get their key from insertId', () => {
  const e = addRow(emptyEdits());
  assert.equal(valueAt(rows, e, 2, 1), undefined);
  const t = editTarget(columns, pk);
  assert.deepEqual(keyAfter(t, columns, rows, e, 2, '7'), ['7']);
  assert.equal(keyAfter(t, columns, rows, e, 2, null), null);
});

test('inline escapes and ignores ? inside identifiers', () => {
  assert.equal(inline({ sql: 'UPDATE `a?b` SET `c` = ? WHERE `d` = ?', params: ['x\\y\n', null] }), "UPDATE `a?b` SET `c` = 'x\\\\y\\n' WHERE `d` = NULL");
});

test('binary columns go through UNHEX, also in the key', () => {
  const bcols = [col('uid', { type: 'STRING', binary: true, notNull: true }), col('data', { type: 'BLOB', binary: true }), col('name')];
  const bpk = [{ name: 'PRIMARY', unique: true, primary: true, type: 'BTREE', columns: ['uid'] }];
  const brows = [['0x0102', '0xDEAD', 'a']];
  let e = setCell(emptyEdits(), brows, 0, 1, '0xBEEF');
  e = addRow(e);
  e = setCell(e, brows, 1, 0, '0xFF00');
  const st = statements(editTarget(bcols, bpk), bcols, brows, e);
  assert.deepEqual(st.map(inline), [
    "UPDATE `shop`.`items` SET `data` = UNHEX('BEEF') WHERE `uid` = UNHEX('0102') LIMIT 1",
    "INSERT INTO `shop`.`items` (`uid`) VALUES (UNHEX('FF00'))",
  ]);
});
