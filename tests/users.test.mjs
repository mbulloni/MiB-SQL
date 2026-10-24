import test from 'node:test';
import assert from 'node:assert/strict';
import { account, createUser, grantStatements, levelKind, maskPasswords, parseGrants, privilegesFor } from '../src/users.ts';

test('parses SHOW GRANTS of MariaDB and MySQL', () => {
  const g = parseGrants([
    "GRANT USAGE ON *.* TO `app`@`%` IDENTIFIED BY PASSWORD '*ABC'",
    'GRANT SELECT, INSERT, UPDATE (`a`, `b`) ON `shop`.* TO `app`@`%` WITH GRANT OPTION',
    "GRANT ALL PRIVILEGES ON `shop`.`orders` TO 'app'@'%'",
    'GRANT EXECUTE ON PROCEDURE `shop`.`p1` TO `app`@`%`',
    'GRANT `reporting` TO `app`@`%`',
  ]);
  assert.deepEqual(g.levels, [
    { on: '*.*', privs: [], grantOption: false },
    { on: '`shop`.*', privs: ['SELECT', 'INSERT', 'UPDATE (`a`, `b`)'], grantOption: true },
    { on: '`shop`.`orders`', privs: ['ALL PRIVILEGES'], grantOption: false },
    { on: 'PROCEDURE `shop`.`p1`', privs: ['EXECUTE'], grantOption: false },
  ]);
  assert.deepEqual(g.roles, ['reporting']);
  assert.deepEqual(g.levels.map((l) => levelKind(l.on)), ['global', 'database', 'table', 'routine']);
  assert.ok(privilegesFor('global').includes('SUPER') && !privilegesFor('database').includes('SUPER'));
  assert.ok(!privilegesFor('table').includes('EXECUTE'));
});

test('grant/revoke statements by difference', () => {
  const acct = account('app', '%');
  const before = [{ on: '`shop`.*', privs: ['SELECT', 'INSERT'], grantOption: true }, { on: '`old`.*', privs: ['SELECT'], grantOption: false }];
  const after = [{ on: '`shop`.*', privs: ['SELECT', 'DELETE'], grantOption: false }, { on: '*.*', privs: ['PROCESS'], grantOption: false }];
  assert.deepEqual(grantStatements(acct, before, after), [
    "REVOKE INSERT ON `shop`.* FROM 'app'@'%'",
    "REVOKE GRANT OPTION ON `shop`.* FROM 'app'@'%'",
    "GRANT DELETE ON `shop`.* TO 'app'@'%'",
    "REVOKE SELECT ON `old`.* FROM 'app'@'%'",
    "GRANT PROCESS ON *.* TO 'app'@'%'",
  ]);
  assert.deepEqual(grantStatements(acct, [{ on: '*.*', privs: [], grantOption: false }], [{ on: '*.*', privs: [], grantOption: true }]), ["GRANT USAGE ON *.* TO 'app'@'%' WITH GRANT OPTION"]);
});

test('accounts and passwords', () => {
  assert.equal(account("o'neil", 'localhost'), "'o\\'neil'@'localhost'");
  const sql = createUser('app', '%', "pa'ss");
  assert.equal(sql, "CREATE USER 'app'@'%' IDENTIFIED BY 'pa\\'ss'");
  assert.equal(maskPasswords(sql), "CREATE USER 'app'@'%' IDENTIFIED BY '••••••'");
});
