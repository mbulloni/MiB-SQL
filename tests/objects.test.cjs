const test = require('node:test');
const assert = require('node:assert/strict');
const { header, statementOf, orReplace } = require('../electron/objects.cjs');

test('header of CREATE statements as SHOW CREATE returns them', () => {
  assert.deepEqual(header("CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v_ordini` AS select 1 AS `a`"),
    { kind: 'view', db: null, name: 'v_ordini', definer: '`root`@`localhost`', orReplace: false, ifNotExists: false, at: 0 });
  assert.equal(header("CREATE DEFINER=`mibsql`@`%` PROCEDURE `p``x`(IN a INT)\nBEGIN END").name, 'p`x');
  const h = header("-- commento\n/* altro */ create or replace definer='u'@'h' function db1.f() returns int return 1");
  assert.deepEqual([h.kind, h.db, h.name, h.orReplace, h.definer], ['function', 'db1', 'f', true, "'u'@'h'"]);
  assert.equal(header('CREATE DEFINER=CURRENT_USER TRIGGER t1 BEFORE INSERT ON x FOR EACH ROW SET @a = 1').kind, 'trigger');
  assert.equal(header('CREATE EVENT IF NOT EXISTS e ON SCHEDULE EVERY 1 DAY DO SELECT 1').ifNotExists, true);
  assert.equal(header('CREATE TABLE t (a INT)'), null);
});

test('CREATE OR REPLACE goes right after CREATE, after leading comments', () => {
  const sql = '/* x */ CREATE DEFINER=`a`@`b` PROCEDURE p() SELECT 1';
  assert.equal(orReplace(sql, header(sql)), '/* x */ CREATE OR REPLACE DEFINER=`a`@`b` PROCEDURE p() SELECT 1');
});

test('the document must hold one CREATE of the right kind in the right database', () => {
  const doc = 'DELIMITER $$\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND$$\nDELIMITER ;\n';
  assert.equal(statementOf(doc, 'procedure', 'd').h.name, 'p');
  assert.match(statementOf(doc, 'procedure', 'd').sql, /^CREATE PROCEDURE p\(\)\nBEGIN[\s\S]*END$/);
  assert.throws(() => statementOf(doc, 'function', 'd'), /definisce una procedura, ma questo documento modifica una funzione/);
  assert.throws(() => statementOf('CREATE VIEW a AS SELECT 1; SELECT 2;', 'view', 'd'), /una sola istruzione CREATE \(ne contiene 2\)/);
  assert.throws(() => statementOf('CREATE VIEW other.v AS SELECT 1', 'view', 'd'), /restare nel database d/);
  assert.throws(() => statementOf('  ', 'view', 'd'), /vuoto/);
});

test('privileges on a routine are granted again after DROP + CREATE', () => {
  const { grantStatements } = require('../electron/objects.cjs');
  assert.deepEqual(grantStatements('d', 'p', 'procedure', [
    { user: 'app', host: '%', privs: ['Execute'] },
    { user: "o'k", host: 'localhost', privs: ['Execute', 'Alter Routine', 'Grant'] },
    { user: 'g', host: 'h', privs: ['Grant'] },
    { user: 'none', host: 'h', privs: [] },
  ]), [
    "GRANT EXECUTE ON PROCEDURE `d`.`p` TO 'app'@'%'",
    "GRANT EXECUTE, ALTER ROUTINE ON PROCEDURE `d`.`p` TO 'o''k'@'localhost' WITH GRANT OPTION",
    "GRANT USAGE ON PROCEDURE `d`.`p` TO 'g'@'h' WITH GRANT OPTION",
  ]);
});
