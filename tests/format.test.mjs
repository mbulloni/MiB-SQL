import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatSql, signature } from '../src/format.ts';

const FN = new Set(['COUNT', 'SUM', 'MAX', 'COALESCE', 'CONCAT', 'VALUES', 'USER', 'DATE']);
const fmt = (sql, opts) => formatSql(sql, opts, FN);

/** Same tokens before and after, and formatting twice changes nothing. */
function invariant(sql, opts) {
  const f = fmt(sql, opts);
  assert.deepEqual(signature(f), signature(sql));
  assert.equal(fmt(f, opts), f);
  return f;
}

test('SELECT with joins, conditions and a subquery', () => {
  const f = invariant(`select o.id, c.name, sum(o.total) as tot from orders o join customers c on c.id = o.customer_id
    left join x on x.a=o.a and x.b between 1 and 2 where o.total > 100 and c.id in (select id from vip where level>3)
    group by c.name order by tot desc limit 10;`);
  assert.equal(f, [
    'SELECT',
    '  o.id,',
    '  c.name,',
    '  SUM(o.total) AS tot',
    'FROM orders o',
    'JOIN customers c ON c.id = o.customer_id',
    'LEFT JOIN x ON x.a = o.a',
    '  AND x.b BETWEEN 1 AND 2',
    'WHERE o.total > 100',
    '  AND c.id IN (',
    '    SELECT id',
    '    FROM vip',
    '    WHERE level > 3',
    '  )',
    'GROUP BY c.name',
    'ORDER BY tot DESC',
    'LIMIT 10;',
  ].join('\n'));
});

test('table names and aliases keep their case (case sensitive on Linux)', () => {
  assert.equal(fmt('select * from User u join Orders as O on O.uid = u.id'),
    'SELECT *\nFROM User u\nJOIN Orders AS O ON O.uid = u.id');
  // USER() is a function, `user` after TABLE/INTO is a table
  assert.equal(fmt('insert into user(id) select user()'), 'INSERT INTO user(id)\nSELECT USER()');
  assert.equal(fmt('select date, status from t where date(created) = 1'), 'SELECT\n  date,\n  status\nFROM t\nWHERE DATE(created) = 1');
});

test('INSERT, UPDATE, DELETE, ON DUPLICATE KEY UPDATE', () => {
  const f = invariant("insert into t (a,b) values (1,'x'),(2,'y') on duplicate key update b=values(b), a=a+1;\nupdate t set a=1, b=-2 where id=1;delete from t where id = 3");
  assert.equal(f, [
    'INSERT INTO t (a, b)',
    'VALUES',
    "  (1, 'x'),",
    "  (2, 'y')",
    'ON DUPLICATE KEY UPDATE',
    '  b = VALUES(b),',
    '  a = a + 1;',
    'UPDATE t',
    'SET',
    '  a = 1,',
    '  b = -2',
    'WHERE id = 1;',
    'DELETE FROM t',
    'WHERE id = 3',
  ].join('\n'));
});

test('CREATE TABLE definitions and ALTER TABLE specifications one per line', () => {
  const f = invariant("create table t (id int unsigned not null auto_increment, date date, primary key (id)) engine=InnoDB comment 'x';\nalter table t add column c int after id, drop index ix");
  assert.equal(f, [
    'CREATE TABLE t (',
    '  id INT UNSIGNED NOT NULL AUTO_INCREMENT,',
    '  date DATE,',
    '  PRIMARY KEY (id)',
    ") ENGINE = InnoDB COMMENT 'x';",
    'ALTER TABLE t',
    '  ADD COLUMN c INT AFTER id,',
    '  DROP INDEX ix',
  ].join('\n'));
});

test('literals, comments and spacing that matter are preserved', () => {
  // COUNT (*) with a space is a different parse for built-in functions: the space stays
  assert.equal(fmt("select x'0A', _utf8mb4'à', count (*), -1, @a:=2 from t # fine"), "SELECT\n  x'0A',\n  _utf8mb4'à',\n  count (*),\n  -1,\n  @a := 2\nFROM t # fine");
  assert.equal(fmt("select 'from where' as `select`, \"a\" -- c\nfrom t"), "SELECT\n  'from where' AS `select`,\n  \"a\" -- c\nFROM t");
  assert.equal(fmt("create definer='u'@'%' view v as select 1"), "CREATE DEFINER = 'u'@'%' VIEW v AS\nSELECT 1");
  assert.equal(fmt('select 1; -- dopo\n\n\nselect 2;\n'), 'SELECT 1; -- dopo\n\nSELECT 2;\n');
});

test('routines keep their layout, only the keyword case changes', () => {
  const src = 'DELIMITER $$\ncreate procedure p(in a int)\nbegin\n  select a   from user;\n    if a > 1 then set @x = 1; end if;\nend$$\nDELIMITER ;\nselect 1;';
  const f = invariant(src);
  assert.equal(f, 'DELIMITER $$\nCREATE PROCEDURE p(IN a INT)\nBEGIN\n  SELECT a   FROM user;\n    IF a > 1 THEN SET @x = 1; END IF;\nEND$$\nDELIMITER ;\nSELECT 1;');
});

test('options: lower case, keep, indent 4, list on one line', () => {
  assert.equal(fmt('SELECT a, b FROM t WHERE x = 1 AND y = 2', { keywordCase: 'lower', indent: 4, listPerLine: false }),
    'select a, b\nfrom t\nwhere x = 1\n    and y = 2');
  assert.equal(fmt('Select a, b From t', { keywordCase: 'keep', indent: 2, listPerLine: true }), 'Select\n  a,\n  b\nFrom t');
});

test('CTE, UNION, CASE, EXPLAIN', () => {
  assert.equal(invariant('with c as (select a from t) select * from c union all select a from d'),
    'WITH c AS (\n  SELECT a\n  FROM t\n)\nSELECT *\nFROM c\nUNION ALL\nSELECT a\nFROM d');
  assert.equal(invariant("select case when a=1 and b=2 then 'x' else 'y' end as k from t"),
    "SELECT CASE WHEN a = 1 AND b = 2 THEN 'x' ELSE 'y' END AS k\nFROM t");
  assert.equal(fmt('explain select a,b from t'), 'EXPLAIN SELECT a, b FROM t');
});

test('the demo script keeps its tokens and is stable', () => {
  invariant(readFileSync(new URL('../scripts/demo.sql', import.meta.url), 'utf8'));
});

test('T-SQL [quoted] identifiers stay untouched', () => {
  const sql = "select top (10) [order], o.[Name], [a]]b] from [sales].[Orders] o where o.[from] = 'x'";
  const out = formatSql(sql);
  for (const id of ['[order]', 'o.[Name]', '[a]]b]', '[sales].[Orders]', 'o.[from]']) assert.ok(out.includes(id), `${id} in ${out}`);
});
