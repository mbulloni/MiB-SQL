const test = require('node:test');
const assert = require('node:assert/strict');
const { batches, statementAt, firstWrite } = require('../electron/tsqlsplit.cjs');

const sqls = (t) => batches(t).map((b) => b.sql);

test('batches split on GO lines, offsets on the original text', () => {
  const t = 'SELECT 1;\nSELECT 2\nGO\n\nSELECT 3\n go \nSELECT 4';
  const b = batches(t);
  assert.deepEqual(b.map((x) => x.sql), ['SELECT 1;\nSELECT 2', 'SELECT 3', 'SELECT 4']);
  for (const x of b) assert.equal(t.slice(x.start, x.end), x.sql);
});

test('GO with a count and a comment; GO inside text is not a separator', () => {
  const t = "INSERT INTO #t VALUES (1)\nGO 3 -- three times\nSELECT 'GO' AS go, [go]\n/*\nGO\n*/\nSELECT category FROM goods";
  const b = batches(t);
  assert.deepEqual(b.map((x) => [x.sql, x.count]), [['INSERT INTO #t VALUES (1)', 3], ["SELECT 'GO' AS go, [go]\n/*\nGO\n*/\nSELECT category FROM goods", 1]]);
});

test('strings use doubled quotes, not backslashes; brackets escape ]]', () => {
  const t = "SELECT 'C:\\', 'it''s;'; SELECT [a]];b]";
  assert.equal(statementAt(t, t.length - 2).sql, 'SELECT [a]];b]');
  assert.equal(statementAt(t, 3).sql, "SELECT 'C:\\', 'it''s;'");
});

test('nested block comments', () => {
  const t = 'SELECT 1 /* a /* b; */ c; */ AS x;\nSELECT 2';
  assert.equal(statementAt(t, 5).sql, 'SELECT 1 /* a /* b; */ c; */ AS x');
});

test('statement under the cursor stays inside its batch', () => {
  const t = 'DECLARE @x int = 1\nSELECT @x\nGO\nSELECT 2;\nSELECT 3;';
  assert.equal(statementAt(t, 3).sql, 'DECLARE @x int = 1\nSELECT @x');
  assert.equal(statementAt(t, t.indexOf('2')).sql, 'SELECT 2');
  assert.equal(statementAt(t, t.length).sql, 'SELECT 3', 'cursor after the last ;');
});

test('empty batches and comment-only scripts', () => {
  assert.deepEqual(sqls('GO\n-- nothing\nGO\n'), []);
  assert.equal(statementAt('  ', 1), null);
});

test('read-only guard finds writes outside strings, comments and names', () => {
  assert.equal(firstWrite("SELECT 'delete', [update], x.[insert] FROM t -- drop table\n/* truncate */"), null);
  assert.equal(firstWrite('SELECT o.update_date, @delete FROM #drop o'), null);
  assert.equal(firstWrite('select 1; update t set a = 1').word, 'UPDATE');
  assert.equal(firstWrite('SELECT * INTO dbo.copy FROM t').word, 'INTO');
  assert.equal(firstWrite('EXEC dbo.Refresh').word, 'EXEC');
  assert.equal(firstWrite('WITH x AS (SELECT 1 AS a) MERGE t USING x ON 1 = 0 WHEN NOT MATCHED THEN INSERT (a) VALUES (x.a);').word, 'MERGE');
});
