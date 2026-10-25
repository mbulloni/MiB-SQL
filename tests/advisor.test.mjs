import test from 'node:test';
import assert from 'node:assert/strict';
import { advise, cnfSize, fixCnf, fixSql, score, versionOf } from '../src/advisor.ts';

const MB = 1024 * 1024;
const base = (status = {}, variables = {}, extra = {}) => ({
  at: 0,
  status: { Uptime: String(10 * 86400), ...status },
  variables: { version: '10.11.14-MariaDB', performance_schema: 'ON', slow_query_log: 'ON', long_query_time: '1', innodb_file_per_table: 'ON', innodb_flush_log_at_trx_commit: '1', ...variables },
  engines: [], noPk: [], fragmented: [], myisam: [], deadlocks: null, ...extra,
});
const ids = (fs) => fs.map((f) => `${f.id}:${f.severity}`);

test('buffer pool smaller than the InnoDB data, with a fix', () => {
  const fs = advise(base({ Innodb_buffer_pool_read_requests: '1000000', Innodb_buffer_pool_reads: '20000' }, { innodb_buffer_pool_size: String(128 * MB) },
    { engines: [{ engine: 'InnoDB', tables: 10, data: 600 * MB, idx: 200 * MB, free: 0 }] }));
  const pool = fs.find((f) => f.id === 'pool-size');
  assert.equal(pool.severity, 'warning');
  assert.deepEqual(pool.fixes, [{ variable: 'innodb_buffer_pool_size', value: String(1024 * MB), cnf: '1G', dynamic: true }]);
  assert.equal(fs.find((f) => f.id === 'pool-hit').severity, 'warning'); // 98%: between 95 and 99
  assert.equal(fs.find((f) => f.id === 'pool-hit').value.replace(/\s/g, ''), '98%');
});

test('temporary tables on disk ask for both size variables', () => {
  const fs = advise(base({ Created_tmp_tables: '1000', Created_tmp_disk_tables: '400' }, { tmp_table_size: String(16 * MB), max_heap_table_size: String(16 * MB) }));
  const f = fs.find((x) => x.id === 'tmp-disk');
  assert.equal(f.severity, 'warning');
  assert.deepEqual(f.fixes.map((x) => [x.variable, x.cnf]), [['tmp_table_size', '64M'], ['max_heap_table_size', '64M']]);
  assert.ok(!fs.some((x) => x.id === 'tmp-mismatch'));
});

test('connections near the limit, refused connections are critical', () => {
  const near = advise(base({ Max_used_connections: '140', Connections: '5000', Threads_created: '20' }, { max_connections: '151' }));
  assert.equal(near.find((f) => f.id === 'max-conn').severity, 'critical');
  assert.equal(near.find((f) => f.id === 'max-conn').fixes[0].value, '210');
  const ok = advise(base({ Max_used_connections: '10' }, { max_connections: '151' }));
  assert.equal(ok.find((f) => f.id === 'max-conn').severity, 'ok');
  const refused = advise(base({ Max_used_connections: '100', Connection_errors_max_connections: '3' }, { max_connections: '151' }));
  assert.equal(refused.find((f) => f.id === 'max-conn').severity, 'critical');
});

test('diagnostics: slow log off, performance_schema off, short uptime', () => {
  const fs = advise(base({ Uptime: '3600' }, { slow_query_log: 'OFF', performance_schema: 'OFF' }));
  assert.deepEqual(ids(fs).filter((x) => /slow-log|ps|uptime/.test(x)).sort(), ['ps:info', 'slow-log:info', 'uptime:info']);
  assert.equal(fs.find((f) => f.id === 'ps').fixes[0].dynamic, false);
  assert.ok(fs.find((f) => f.id === 'ps').advice.includes('userstat'));
});

test('redo log sized for less than an hour of writes; dynamic on MariaDB 10.9+', () => {
  const fs = advise(base({ Uptime: String(10 * 3600), Innodb_os_log_written: String(10 * 1024 * MB) }, { innodb_log_file_size: String(96 * MB) }));
  const f = fs.find((x) => x.id === 'redo');
  assert.equal(f.fixes[0].variable, 'innodb_log_file_size');
  assert.equal(f.fixes[0].cnf, '1G');
  assert.equal(f.fixes[0].dynamic, true);
  const mysql = advise(base({ Uptime: String(10 * 3600), Innodb_os_log_written: String(10 * 1024 * MB) }, { version: '8.4.3', innodb_redo_log_capacity: String(100 * MB) }));
  assert.equal(mysql.find((x) => x.id === 'redo').fixes[0].variable, 'innodb_redo_log_capacity');
});

test('schema findings list the tables; ordering and score', () => {
  const fs = advise(base({ Max_used_connections: '150', Connection_errors_max_connections: '1' }, { max_connections: '151' }, {
    noPk: [{ db: 'd', name: 'log', engine: 'InnoDB', rows: 10 }],
    fragmented: [{ db: 'd', name: 'orders', engine: 'InnoDB', size: 100 * MB, free: 50 * MB }],
  }));
  assert.deepEqual(fs.find((f) => f.id === 'no-pk').tables.map((x) => x.name), ['log']);
  assert.equal(fs[0].severity, 'critical');
  assert.equal(score(fs), 100 - 15 - 5);
});

test('helpers', () => {
  assert.deepEqual(versionOf('10.11.14-MariaDB-0ubuntu'), [10, 11, 14]);
  assert.equal(cnfSize(3 * 1024 * MB), '3G');
  assert.equal(cnfSize(96 * MB), '96M');
  assert.equal(fixSql({ variable: 'max_connections', value: '200', dynamic: true }), 'SET GLOBAL max_connections = 200;');
  assert.equal(fixSql({ variable: 'query_cache_type', value: 'OFF', dynamic: true }, true), 'SET PERSIST query_cache_type = OFF;');
  assert.equal(fixCnf([{ variable: 'a', value: '1', cnf: '1M', dynamic: true }]), '[mysqld]\na = 1M\n');
});
