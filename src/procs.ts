// Process manager logic: who blocks whom (row locks and metadata locks), idle transactions, grouping and
// the latest deadlock from SHOW ENGINE INNODB STATUS. Pure functions, tested in tests/procs.test.mjs.

export interface Proc { id: number; user: string; host: string; db: string | null; command: string; time: number; timeMs: number | null; state: string | null; info: string | null; progress: number | null }
export interface Trx {
  id: string | null; state: string | null; started: string | null; age: number | null; waitAge: number | null; thread: number | null; query: string | null;
  operation: string | null; tablesInUse: number | null; tablesLocked: number | null; rowsLocked: number | null; rowsModified: number | null; isolation: string | null;
}
export interface LockWait { waiting: string | null; blocking: string | null; table: string | null; index: string | null; mode: string | null; type: string | null; data: string | null }
export interface Mdl { thread: number; mode: string | null; duration: string | null; type: string | null; schema: string | null; name: string | null; status: string | null }
export interface ProcSnapshot {
  at: number; flavor: 'mariadb' | 'mysql'; version: string;
  processes: Proc[]; trx: Trx[]; lockWaits: LockWait[]; mdl: Mdl[];
  missing: { what: 'trx' | 'locks' | 'mdl'; message: string }[];
}

export interface Wait {
  waiter: number;
  blocker: number;
  kind: 'row' | 'mdl';
  object: string | null; // table (and index) or locked object
  mode: string | null;
  seconds: number | null; // how long the waiter has been waiting
  guess?: boolean; // blocker inferred (no lock tables readable): an older open transaction
}

const SYSTEM_USERS = new Set(['system user', 'event_scheduler', 'unauthenticated user']);
const SYSTEM_COMMANDS = new Set(['Daemon', 'Binlog Dump', 'Binlog Dump GTID', 'Slave_IO', 'Slave_SQL', 'Slave_worker', 'Connect Out']);

/** Server's own threads (InnoDB purge, replication, event scheduler). */
export const isSystem = (p: Proc) => SYSTEM_USERS.has(p.user) || SYSTEM_COMMANDS.has(p.command);

/** "10.0.0.5:51234" → "10.0.0.5"; "[::1]:3306" → "[::1]". */
export const hostOnly = (h: string) => (/^\[.*\](:\d+)?$/.test(h) ? h.replace(/:\d+$/, '') : h.replace(/:\d+$/, ''));

const MDL_WAIT = /metadata lock/i;

export function trxByThread(s: ProcSnapshot) {
  const m = new Map<number, Trx>();
  for (const t of s.trx) if (t.thread !== null) m.set(t.thread, t);
  return m;
}

/** All "waiter is blocked by blocker" pairs. */
export function waits(s: ProcSnapshot): Wait[] {
  const out: Wait[] = [];
  const threadOfTrx = new Map(s.trx.filter((t) => t.id).map((t) => [t.id!, t.thread]));
  const byId = new Map(s.processes.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const add = (w: Wait) => {
    const k = `${w.waiter}>${w.blocker}:${w.kind}`;
    if (w.waiter === w.blocker || seen.has(k)) return;
    seen.add(k);
    out.push(w);
  };
  for (const lw of s.lockWaits) {
    const waiter = lw.waiting ? threadOfTrx.get(lw.waiting) : null;
    const blocker = lw.blocking ? threadOfTrx.get(lw.blocking) : null;
    if (waiter == null || blocker == null) continue;
    const trx = s.trx.find((t) => t.id === lw.waiting);
    add({ waiter, blocker, kind: 'row', object: lw.table ? `${lw.table}${lw.index ? ` (${lw.index})` : ''}` : null, mode: lw.mode, seconds: trx?.waitAge ?? byId.get(waiter)?.time ?? null });
  }
  // metadata locks: a PENDING request waits for every other thread holding a lock on the same object
  const pending = s.mdl.filter((m) => m.status === 'PENDING');
  for (const p of pending) {
    for (const g of s.mdl) {
      if (g.status !== 'GRANTED' || g.thread === p.thread || g.schema !== p.schema || g.name !== p.name || g.type !== p.type) continue;
      add({ waiter: p.thread, blocker: g.thread, kind: 'mdl', object: p.schema ? `\`${p.schema}\`.\`${p.name}\`` : p.name, mode: p.mode, seconds: byId.get(p.thread)?.time ?? null });
    }
  }
  // no PENDING rows (MariaDB lists only granted locks): threads in a metadata lock wait are blocked by the
  // holders of a lock on a table their statement names, or else by transactions older than the wait
  if (!pending.length) {
    const trx = trxByThread(s);
    for (const p of s.processes) {
      if (!p.state || !MDL_WAIT.test(p.state)) continue;
      const text = (p.info ?? '').toLowerCase();
      const holders = s.mdl.filter((m) => m.thread !== p.id && m.name && new RegExp(`\\b${m.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
      if (holders.length) {
        for (const h of holders) add({ waiter: p.id, blocker: h.thread, kind: 'mdl', object: h.schema ? `\`${h.schema}\`.\`${h.name}\`` : h.name, mode: h.mode, seconds: p.time });
        continue;
      }
      for (const [thread, tx] of trx) {
        if (thread !== p.id && (tx.age ?? 0) >= p.time) add({ waiter: p.id, blocker: thread, kind: 'mdl', object: null, mode: null, seconds: p.time, guess: true });
      }
    }
  }
  return out;
}

/** Threads that block others without waiting themselves (the ones to look at first), with everyone they hold up. */
export function rootBlockers(ws: Wait[]) {
  const waiting = new Set(ws.map((w) => w.waiter));
  const direct = new Map<number, Wait[]>();
  for (const w of ws) direct.set(w.blocker, [...(direct.get(w.blocker) ?? []), w]);
  const reach = (id: number, seen = new Set<number>()): Set<number> => {
    for (const w of direct.get(id) ?? []) if (!seen.has(w.waiter)) { seen.add(w.waiter); reach(w.waiter, seen); }
    return seen;
  };
  return [...direct.keys()]
    .filter((id) => !waiting.has(id))
    .map((id) => ({ blocker: id, waits: direct.get(id)!, total: reach(id).size }))
    .sort((a, b) => b.total - a.total || a.blocker - b.blocker);
}

/** Seconds a sleeping connection has kept its transaction open (null: none, or the thread is working). */
export function idleInTrx(p: Proc, trx: Map<number, Trx>) {
  const t = trx.get(p.id);
  return t && p.command === 'Sleep' ? (t.age ?? p.time) : null;
}

export type GroupKey = 'user' | 'host' | 'db' | 'command' | 'state';

/** Thread counts by user, host, database, command or state; "active" = not sleeping. */
export function summary(ps: Proc[], key: GroupKey) {
  const m = new Map<string, { value: string; count: number; active: number; maxTime: number }>();
  for (const p of ps) {
    const raw = key === 'host' ? hostOnly(p.host) : p[key];
    const value = raw ?? '';
    const g = m.get(value) ?? { value, count: 0, active: 0, maxTime: 0 };
    g.count++;
    if (p.command !== 'Sleep') { g.active++; g.maxTime = Math.max(g.maxTime, p.time); }
    m.set(value, g);
  }
  return [...m.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

export interface Deadlock {
  at: string | null;
  text: string;
  transactions: { n: number; thread: number | null; account: string | null; query: string; holds: string; waits: string; conflicts: string }[];
  victim: number | null;
}

/**
 * "LATEST DETECTED DEADLOCK" section of SHOW ENGINE INNODB STATUS, split by transaction. MySQL numbers every
 * part ("*** (1) HOLDS THE LOCK(S):"); MariaDB writes "*** WAITING FOR THIS LOCK…" and "*** CONFLICTING WITH:"
 * after its "(n) TRANSACTION" part.
 */
export function latestDeadlock(status: string): Deadlock | null {
  const m = /-+\nLATEST (?:DETECTED )?DEADLOCK\n-+\n([\s\S]*?)\n-+\n[A-Z][A-Z /]+\n-+\n/.exec(status);
  if (!m) return null;
  const text = m[1].trimEnd();
  const at = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)/.exec(text)?.[1] ?? null;
  const trx: Deadlock['transactions'] = [];
  let cur: Deadlock['transactions'][number] | null = null;
  let victim: number | null = null;
  for (const part of text.split(/^\*\*\* /m).slice(1)) {
    const v = /^WE ROLL BACK TRANSACTION \((\d+)\)/.exec(part);
    if (v) { victim = Number(v[1]); continue; }
    const head = /^(?:\((\d+)\) )?(TRANSACTION|HOLDS THE LOCK\(S\)|WAITING FOR THIS LOCK TO BE GRANTED|CONFLICTING WITH):[^\n]*\n?([\s\S]*)$/.exec(part);
    if (!head) continue;
    const n: number = head[1] ? Number(head[1]) : cur?.n ?? 0;
    if (!cur || cur.n !== n) {
      cur = trx.find((x) => x.n === n) ?? null;
      if (!cur) { cur = { n, thread: null, account: null, query: '', holds: '', waits: '', conflicts: '' }; trx.push(cur); }
    }
    const body = head[3].trimEnd();
    if (head[2] === 'TRANSACTION') {
      const th = /(?:MySQL|MariaDB) thread id (\d+), OS thread handle \S+, query id \d+ ?(.*)$/m.exec(body);
      if (th) {
        cur.thread = Number(th[1]);
        cur.account = th[2].trim() || null;
        // the statement follows the "thread id" line
        cur.query = body.slice(body.indexOf(th[0]) + th[0].length).trim();
      }
    } else if (head[2].startsWith('HOLDS')) cur.holds = body;
    else if (head[2].startsWith('WAITING')) cur.waits = body;
    else cur.conflicts = body;
  }
  return { at, text, transactions: trx.sort((a, b) => a.n - b.n), victim };
}
