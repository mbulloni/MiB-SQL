import test from 'node:test';
import assert from 'node:assert/strict';
import { dataQuery, filterHits, matcher, matchLine, splitMatches } from '../src/search.ts';

test('server hits narrowed by case and whole word', () => {
  const hits = [
    { kind: 'table', where: 'name', db: 'd', name: 'orders' },
    { kind: 'table', where: 'name', db: 'd', name: 'order_items' },
    { kind: 'column', where: 'name', db: 'd', table: 't', name: 'Order' },
    { kind: 'view', where: 'code', db: 'd', name: 'v', text: 'select * from `orders` o' },
  ];
  assert.equal(filterHits(hits, 'order', false, false).length, 4);
  assert.deepEqual(filterHits(hits, 'order', true, false).map((h) => h.name), ['orders', 'order_items', 'v']);
  assert.deepEqual(filterHits(hits, 'order', false, true).map((h) => h.name), ['Order']);
  assert.deepEqual(filterHits(hits, 'orders', false, true).map((h) => h.name), ['orders', 'v']);
});

test('matching line and highlighting', () => {
  const re = matcher('total', false, false);
  assert.deepEqual(matchLine('BEGIN\n  SET x = 1;\n  UPDATE o SET Total = 0;\nEND', re), { line: 3, text: 'UPDATE o SET Total = 0;' });
  assert.equal(matchLine('nothing', re), null);
  const long = `${'a '.repeat(100)}total${' b'.repeat(100)}`;
  const m = matchLine(long, re);
  assert.ok(m.text.startsWith('…') && m.text.endsWith('…') && m.text.includes('total'));
  assert.deepEqual(splitMatches('a total, TOTAL', re), [{ s: 'a ', hit: false }, { s: 'total', hit: true }, { s: ', ', hit: false }, { s: 'TOTAL', hit: true }]);
});

test('query reopening the rows found', () => {
  assert.equal(dataQuery('d', 't', ['name', 'note'], "50%_o'k"), "SELECT *\nFROM `d`.`t`\nWHERE `name` LIKE '%50\\\\%\\\\_o''k%'\n   OR `note` LIKE '%50\\\\%\\\\_o''k%';\n");
  assert.equal(dataQuery('d', 't', ['id', 'code'], '42', { numeric: ['id'], exact: true }), "SELECT *\nFROM `d`.`t`\nWHERE `id` = '42'\n   OR `code` = '42';\n");
});
