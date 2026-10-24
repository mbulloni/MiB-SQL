// Session monitor metrics: per-second rates from two status polls. Pure functions for tests.

export interface Snapshot {
  at: number;
  processes: { id: number; user: string; host: string; db: string | null; command: string; time: number; timeMs: number | null; state: string | null; info: string | null; progress: number | null }[];
  status: Record<string, number>;
  variables: Record<string, string>;
}

export interface Metrics {
  at: number;
  qps: number;
  threadsRunning: number;
  threadsConnected: number;
  connectionsPerSec: number;
  inKBs: number;
  outKBs: number;
  hitRatio: number | null; // buffer pool hits over the interval, % (null: no reads)
  slowPerMin: number;
  writesPerSec: number;
}

/** Queries the monitor itself sends per poll (they count in Questions). */
export const OWN_QUERIES = 3;

export function metrics(prev: Snapshot, cur: Snapshot): Metrics {
  const dt = Math.max(0.001, (cur.at - prev.at) / 1000);
  const d = (k: string) => Math.max(0, (cur.status[k] ?? 0) - (prev.status[k] ?? 0));
  const requests = d('Innodb_buffer_pool_read_requests');
  return {
    at: cur.at,
    qps: Math.max(0, d('Questions') - OWN_QUERIES) / dt,
    threadsRunning: Math.max(0, (cur.status.Threads_running ?? 1) - 1), // minus the monitor's own running query
    threadsConnected: cur.status.Threads_connected ?? 0,
    connectionsPerSec: d('Connections') / dt,
    inKBs: d('Bytes_received') / 1024 / dt,
    outKBs: d('Bytes_sent') / 1024 / dt,
    hitRatio: requests ? (1 - d('Innodb_buffer_pool_reads') / requests) * 100 : null,
    slowPerMin: (d('Slow_queries') / dt) * 60,
    writesPerSec: (d('Com_insert') + d('Com_update') + d('Com_delete')) / dt,
  };
}

/** "3 g 4 h", "2 h 5 min", "40 s". */
export function duration(seconds: number) {
  const s = Math.floor(seconds);
  if (s >= 86400) return `${Math.floor(s / 86400)} g ${Math.floor((s % 86400) / 3600)} h`;
  if (s >= 3600) return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
  if (s >= 60) return `${Math.floor(s / 60)} min ${s % 60} s`;
  return `${s} s`;
}

/** Upper bound of a chart axis: 1, 2, 2.5 or 5 × 10^n above the maximum. */
export function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
