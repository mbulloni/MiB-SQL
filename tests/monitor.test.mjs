import test from 'node:test';
import assert from 'node:assert/strict';
import { duration, metrics, niceMax } from '../src/monitor.ts';

const snap = (at, status) => ({ at, processes: [], variables: {}, status });

test('rates per second from two polls, minus the monitor own queries', () => {
  const a = snap(0, { Questions: 100, Threads_running: 1, Threads_connected: 5, Connections: 10, Bytes_received: 0, Bytes_sent: 0, Innodb_buffer_pool_read_requests: 1000, Innodb_buffer_pool_reads: 10, Slow_queries: 0, Com_insert: 0, Com_update: 0, Com_delete: 0 });
  const b = snap(2000, { Questions: 123, Threads_running: 3, Threads_connected: 6, Connections: 14, Bytes_received: 4096, Bytes_sent: 20480, Innodb_buffer_pool_read_requests: 2000, Innodb_buffer_pool_reads: 20, Slow_queries: 1, Com_insert: 4, Com_update: 2, Com_delete: 0 });
  const m = metrics(a, b);
  assert.equal(m.qps, 10);
  assert.equal(m.threadsRunning, 2);
  assert.equal(m.connectionsPerSec, 2);
  assert.equal(m.inKBs, 2);
  assert.equal(m.outKBs, 10);
  assert.equal(m.hitRatio, 99);
  assert.equal(m.slowPerMin, 30);
  assert.equal(m.writesPerSec, 3);
  assert.equal(metrics(a, { ...a, at: 1000 }).hitRatio, null);
});

test('durations and axis bounds', () => {
  assert.equal(duration(40), '40 s');
  assert.equal(duration(125), '2 min 5 s');
  assert.equal(duration(7500), '2 h 5 min');
  assert.equal(duration(90000), '1 g 1 h');
  assert.deepEqual([0, 0.3, 3, 7, 12, 99].map(niceMax), [1, 0.5, 5, 10, 20, 100]);
});
