const test = require('node:test');
const assert = require('node:assert/strict');
const { split, statementAt } = require('../electron/sqlsplit.cjs');

const sqls = (t) => split(t).map((s) => s.sql);

test('splits on semicolons and trims', () => {
  assert.deepEqual(sqls('select 1;\n  select 2 ;\n'), ['select 1', 'select 2']);
});

test('keeps the last statement without delimiter', () => {
  assert.deepEqual(sqls('select 1; select 2'), ['select 1', 'select 2']);
});

test('ignores delimiters inside quotes, backticks and comments', () => {
  const t = "select 'a;b', \"c;d\", `e;f` -- x;y\n, 1 /* ; */ # z;\n;select 'it''s;' , 'x\\';y'";
  assert.deepEqual(sqls(t), ["select 'a;b', \"c;d\", `e;f` -- x;y\n, 1 /* ; */ # z;", "select 'it''s;' , 'x\\';y'"]);
});

test('double dash without space is not a comment', () => {
  assert.deepEqual(sqls('select 5--1; select 2'), ['select 5--1', 'select 2']);
});

test('drops comment-only statements', () => {
  assert.deepEqual(sqls('-- header\n;/* nothing */; select 1;'), ['select 1']);
});

test('handles DELIMITER blocks', () => {
  const t = 'DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();';
  assert.deepEqual(sqls(t), ['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()']);
});

test('DELIMITER inside a statement is plain text', () => {
  assert.deepEqual(sqls("select 'x' as delimiter; select 2"), ["select 'x' as delimiter", 'select 2']);
});

test('offsets map back to the source', () => {
  const t = 'select 1;\n\nselect   2;';
  for (const s of split(t)) assert.equal(t.slice(s.start, s.end), s.sql);
});

test('statementAt picks the statement under the cursor or the previous one', () => {
  const t = 'select 1;\nselect 2;\n\n';
  assert.equal(statementAt(t, 3).sql, 'select 1');
  assert.equal(statementAt(t, 12).sql, 'select 2');
  assert.equal(statementAt(t, t.length).sql, 'select 2');
  assert.equal(statementAt('', 0), null);
});
