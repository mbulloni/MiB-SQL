import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { hostOnly, idleInTrx, isSystem, latestDeadlock, rootBlockers, summary, trxByThread, waits } from '../src/procs.ts';

const proc = (id, extra = {}) => ({ id, user: 'app', host: '10.0.0.1:5000', db: 'd', command: 'Query', time: 1, timeMs: null, state: null, info: null, progress: null, ...extra });
const trx = (id, thread, extra = {}) => ({ id, state: 'RUNNING', started: null, age: 10, waitAge: null, thread, query: null, operation: null, tablesInUse: 0, tablesLocked: 0, rowsLocked: 0, rowsModified: 0, isolation: 'REPEATABLE READ', ...extra });
const snap = (extra) => ({ at: 0, flavor: 'mariadb', version: '', processes: [], trx: [], lockWaits: [], mdl: [], missing: [], ...extra });

test('row lock waits map transactions to threads and find the root blocker', () => {
  const s = snap({
    processes: [proc(1, { command: 'Sleep', time: 50 }), proc(2, { time: 8 }), proc(3, { time: 4 })],
    trx: [trx('100', 1, { age: 50 }), trx('200', 2, { state: 'LOCK WAIT', waitAge: 8 }), trx('300', 3, { state: 'LOCK WAIT', waitAge: 4 })],
    lockWaits: [
      { waiting: '200', blocking: '100', table: '`d`.`t`', index: 'PRIMARY', mode: 'X', type: 'RECORD', data: '1' },
      { waiting: '300', blocking: '200', table: '`d`.`t`', index: 'PRIMARY', mode: 'X', type: 'RECORD', data: '2' },
    ],
  });
  const ws = waits(s);
  assert.deepEqual(ws.map((w) => [w.waiter, w.blocker, w.kind, w.object, w.seconds]), [[2, 1, 'row', '`d`.`t` (PRIMARY)', 8], [3, 2, 'row', '`d`.`t` (PRIMARY)', 4]]);
  const roots = rootBlockers(ws);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].blocker, 1);
  assert.equal(roots[0].total, 2); // 2 directly, 3 through 2
  assert.equal(idleInTrx(s.processes[0], trxByThread(s)), 50);
  assert.equal(idleInTrx(s.processes[1], trxByThread(s)), null);
});

test('metadata lock waits: PENDING requests (MySQL) and inferred holders (MariaDB)', () => {
  const mysql = snap({
    flavor: 'mysql',
    processes: [proc(5, { command: 'Sleep' }), proc(6, { state: 'Waiting for table metadata lock', info: 'ALTER TABLE t ADD c INT', time: 30 })],
    mdl: [
      { thread: 5, mode: 'SHARED_READ', duration: 'TRANSACTION', type: 'TABLE', schema: 'd', name: 't', status: 'GRANTED' },
      { thread: 6, mode: 'EXCLUSIVE', duration: 'TRANSACTION', type: 'TABLE', schema: 'd', name: 't', status: 'PENDING' },
      { thread: 6, mode: 'SHARED_UPGRADABLE', duration: 'TRANSACTION', type: 'TABLE', schema: 'd', name: 't', status: 'GRANTED' },
    ],
  });
  assert.deepEqual(waits(mysql).map((w) => [w.waiter, w.blocker, w.kind, w.object]), [[6, 5, 'mdl', '`d`.`t`']]);

  // MariaDB with METADATA_LOCK_INFO: holders of a lock on a table named by the waiting statement
  const withInfo = snap({
    processes: [proc(5, { command: 'Sleep' }), proc(6, { state: 'Waiting for table metadata lock', info: 'ALTER TABLE orders ADD c INT', time: 30 })],
    mdl: [{ thread: 5, mode: 'MDL_SHARED_READ', duration: null, type: 'Table metadata lock', schema: 'd', name: 'orders', status: 'GRANTED' }],
  });
  assert.deepEqual(waits(withInfo).map((w) => [w.waiter, w.blocker, !!w.guess]), [[6, 5, false]]);

  // without lock tables: open transactions older than the wait are the suspects
  const blind = snap({
    processes: [proc(5, { command: 'Sleep' }), proc(7, { command: 'Sleep' }), proc(6, { state: 'Waiting for table metadata lock', info: 'ALTER TABLE t ADD c INT', time: 30 })],
    trx: [trx('1', 5, { age: 100 }), trx('2', 7, { age: 3 })],
  });
  assert.deepEqual(waits(blind).map((w) => [w.waiter, w.blocker, !!w.guess]), [[6, 5, true]]);
});

test('system threads, hosts and grouping', () => {
  assert.equal(isSystem(proc(1, { user: 'system user', command: 'Daemon' })), true);
  assert.equal(isSystem(proc(1, { user: 'event_scheduler', command: 'Daemon' })), true);
  assert.equal(isSystem(proc(1)), false);
  assert.equal(hostOnly('10.0.0.5:51234'), '10.0.0.5');
  assert.equal(hostOnly('localhost'), 'localhost');
  assert.equal(hostOnly('[::1]:3306'), '[::1]');
  const g = summary([proc(1), proc(2, { command: 'Sleep' }), proc(3, { user: 'web', time: 9 })], 'user');
  assert.deepEqual(g, [{ value: 'app', count: 2, active: 1, maxTime: 1 }, { value: 'web', count: 1, active: 1, maxTime: 9 }]);
  assert.deepEqual(summary([proc(1), proc(2, { host: '10.0.0.1:6000' })], 'host').map((x) => [x.value, x.count]), [['10.0.0.1', 2]]);
});

test('latest deadlock from MariaDB InnoDB status', () => {
  const d = latestDeadlock(readFileSync(new URL('./fixtures/innodb-status-mariadb.txt', import.meta.url), 'utf8'));
  assert.ok(d);
  assert.equal(d.at, '2026-10-25 08:18:13');
  assert.equal(d.victim, 2);
  assert.deepEqual(d.transactions.map((x) => [x.n, x.thread, x.account, x.query]), [
    [1, 939, 'localhost root Updating', 'UPDATE dl SET v=2 WHERE id=1'],
    [2, 938, 'localhost root Updating', 'UPDATE dl SET v=1 WHERE id=2'],
  ]);
  assert.match(d.transactions[0].waits, /lock_mode X locks rec but not gap waiting/);
  assert.match(d.transactions[0].conflicts, /trx id 73956/);
  assert.equal(latestDeadlock('no deadlock here'), null);
});

test('latest deadlock in MySQL 8 format', () => {
  const status = `------------------------
LATEST DETECTED DEADLOCK
------------------------
2026-10-25 08:30:00 140000000000000
*** (1) TRANSACTION:
TRANSACTION 1847, ACTIVE 3 sec starting index read
mysql tables in use 1, locked 1
MySQL thread id 12, OS thread handle 1400, query id 99 172.17.0.1 root updating
UPDATE dl SET v=2 WHERE id=1

*** (1) HOLDS THE LOCK(S):
RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table \`lab\`.\`dl\` trx id 1847 lock_mode X locks rec but not gap

*** (1) WAITING FOR THIS LOCK TO BE GRANTED:
RECORD LOCKS space id 2 page no 4 n bits 72 index PRIMARY of table \`lab\`.\`dl\` trx id 1847 lock_mode X locks rec but not gap waiting

*** (2) TRANSACTION:
TRANSACTION 1846, ACTIVE 4 sec starting index read
MySQL thread id 11, OS thread handle 1401, query id 98 172.17.0.1 root updating
UPDATE dl SET v=1 WHERE id=2

*** (2) HOLDS THE LOCK(S):
lock held

*** (2) WAITING FOR THIS LOCK TO BE GRANTED:
lock wanted

*** WE ROLL BACK TRANSACTION (2)
------------
TRANSACTIONS
------------
`;
  const d = latestDeadlock(status);
  assert.equal(d.victim, 2);
  assert.deepEqual(d.transactions.map((x) => [x.n, x.thread, x.query, x.holds, x.waits]).slice(1), [[2, 11, 'UPDATE dl SET v=1 WHERE id=2', 'lock held', 'lock wanted']]);
  assert.match(d.transactions[0].holds, /lock_mode X locks rec but not gap$/);
});
