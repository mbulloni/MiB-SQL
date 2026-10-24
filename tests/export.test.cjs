const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeRows, literal } = require('../electron/export.cjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mibsql-export-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const columns = [
  { name: 'id', type: 'INT' },
  { name: 'txt', type: 'VAR_STRING' },
  { name: 'amount', type: 'NEWDECIMAL' },
  { name: 'bin', type: 'BLOB', binary: true },
];
const rows = [
  [1, 'a;b "c"\nd', '12.50', '0x00FF'],
  [2, null, '12345678901234567890.5', null],
];

test('CSV quotes delimiters, quotes and newlines; NULL as chosen', async () => {
  const f = path.join(dir, 'a.csv');
  await writeRows('csv', f, { delimiter: ';', nullAs: 'NULL' }, columns, rows);
  assert.equal(fs.readFileSync(f, 'utf8'), 'id;txt;amount;bin\r\n1;"a;b ""c""\nd";12.50;0x00FF\r\n2;NULL;12345678901234567890.5;NULL\r\n');
});

test('CSV with BOM and no header', async () => {
  const f = path.join(dir, 'b.csv');
  await writeRows('csv', f, { bom: true, header: false }, columns, rows.slice(1));
  assert.equal(fs.readFileSync(f, 'utf8'), '﻿2,,12345678901234567890.5,\r\n');
});

test('JSON keeps big decimals as strings', async () => {
  const f = path.join(dir, 'a.json');
  await writeRows('json', f, {}, columns, rows);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), [
    { id: 1, txt: 'a;b "c"\nd', amount: 12.5, bin: '0x00FF' },
    { id: 2, txt: null, amount: '12345678901234567890.5', bin: null },
  ]);
  const empty = path.join(dir, 'e.json');
  await writeRows('json', empty, {}, columns, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(empty, 'utf8')), []);
});

test('SQL INSERT batches and literals', async () => {
  const f = path.join(dir, 'a.sql');
  await writeRows('sql', f, { table: 'dest', batch: 1 }, columns, rows);
  assert.equal(fs.readFileSync(f, 'utf8'),
    "INSERT INTO `dest` (`id`, `txt`, `amount`, `bin`) VALUES\n(1, 'a;b \"c\"\\nd', 12.50, 0x00FF);\n" +
    'INSERT INTO `dest` (`id`, `txt`, `amount`, `bin`) VALUES\n(2, NULL, 12345678901234567890.5, NULL);\n');
  assert.equal(literal("it's \\", columns[1]), "'it''s \\\\'");
  assert.equal(literal('1e5', columns[2]), '1e5');
  assert.equal(literal('0x', columns[3]), "''");
});
