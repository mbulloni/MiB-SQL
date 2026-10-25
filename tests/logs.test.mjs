import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseErrorLog, parseGeneralLog, parseSlowLog } from '../src/logs.ts';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');

test('error log: MariaDB file, continuation lines', () => {
  const e = parseErrorLog(fx('error-mariadb.log'));
  assert.deepEqual([e[0].at, e[0].thread, e[0].level], ['2026-10-25 12:43:37', 0, 'Warning']);
  assert.match(e[0].message, /\ncreate_uring failed: falling back to libaio$/);
  assert.equal(e[2].subsystem, 'InnoDB');
});

test('error log: MySQL 8 format and journal prefix', () => {
  const e = parseErrorLog(fx('error-mysql.log'));
  assert.deepEqual([e[0].level, e[0].code, e[0].subsystem], ['System', 'MY-015017', 'Server']);
  assert.equal(e[3].subsystem, 'InnoDB');
  const j = parseErrorLog("2026-10-24T16:17:51+0200 Zeus mariadbd[2331]: 2026-10-24 16:17:51 618 [Warning] Aborted connection 618 to db: 'unconnected'\n251024 16:17:52 [ERROR] old style");
  assert.deepEqual(j.map((x) => [x.at, x.thread, x.level]), [['2026-10-24 16:17:51', 618, 'Warning'], ['2025-10-24 16:17:52', null, 'Error']]);
});

test('slow log files of both servers', () => {
  const m = parseSlowLog(fx('slow-mariadb.log'));
  const sleep = m.find((r) => r.text === 'SELECT SLEEP(0.2);');
  assert.ok(sleep);
  assert.equal(sleep.db, 't1');
  assert.equal(sleep.thread, 4);
  assert.ok(Math.abs(sleep.ms - 200.354) < 0.001);
  assert.equal(m[m.length - 1].text, 'SELECT 1,\n2;');
  const y = parseSlowLog(fx('slow-mysql.log'));
  const s2 = y.find((r) => r.text === 'SELECT SLEEP(0.2);');
  assert.ok(s2 && s2.thread === 9 && s2.ms > 190);
  assert.ok(y.some((r) => r.text === 'SELECT 1,\n2;' && r.at === '2026-10-25T12:44:03.337765Z'));
});

test('general log files of both servers', () => {
  const m = parseGeneralLog(fx('general-mariadb.log'));
  assert.ok(m.some((x) => x.command === 'Init DB' && x.text === 't1' && x.thread === 4));
  const multi = m.find((x) => x.text.startsWith('SELECT 1,'));
  assert.deepEqual([multi.at, multi.text], ['2026-10-25 12:44:03', 'SELECT 1,\n2']);
  const y = parseGeneralLog(fx('general-mysql.log'));
  assert.ok(y.some((x) => x.command === 'Query' && x.text === 'SELECT SLEEP(0.2)' && x.at === '2026-10-25T12:44:03.137473Z'));
  assert.equal(y[y.length - 1].command, 'Quit');
});
