import test from 'node:test';
import assert from 'node:assert/strict';
import { callScript, literal } from '../src/routines.ts';

const v = (value, extra = {}) => ({ value, isNull: false, expr: false, ...extra });

test('literals by type', () => {
  assert.equal(literal('int(11)', v('42')), '42');
  assert.equal(literal('decimal(10,2)', v('-1.5e3')), '-1.5e3');
  assert.equal(literal('int', v('4 2')), "'4 2'");
  assert.equal(literal('varchar(20)', v("l'uno \\ due")), "'l''uno \\\\ due'");
  assert.equal(literal('date', v('2026-10-24')), "'2026-10-24'");
  assert.equal(literal('int', v('', { isNull: true })), 'NULL');
  assert.equal(literal('datetime', v('NOW()', { expr: true })), 'NOW()');
});

test('procedure with IN, OUT and INOUT parameters; function', () => {
  const params = [{ mode: 'IN', name: 'id', type: 'int' }, { mode: 'OUT', name: 'tot', type: 'decimal(10,2)' }, { mode: 'INOUT', name: 'n', type: 'int' }];
  assert.equal(callScript('demo', 'procedure', 'p', params, [v('7'), v(''), v('3')]),
    'SET @tot = NULL;\nSET @n = 3;\nCALL `demo`.`p`(7, @tot, @n);\nSELECT @tot AS `tot`, @n AS `n`;\n');
  assert.equal(callScript('demo', 'procedure', 'q', [], []), 'CALL `demo`.`q`();\n');
  assert.equal(callScript('demo', 'function', 'f', [{ mode: 'IN', name: 'x', type: 'varchar(5)' }], [v('a')]), "SELECT `demo`.`f`('a') AS `f`;\n");
});
