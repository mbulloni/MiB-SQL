// Server log parsing: error log lines (MariaDB, MySQL, systemd journal), slow query log and general log files.
// Pure functions, tested in tests/logs.test.mjs.
import type { SlowRow } from './queryadvisor.ts';

export interface ErrorEntry { at: string | null; thread: number | null; level: string; code: string | null; subsystem: string | null; message: string }
export interface GeneralEntry { at: string | null; thread: number | null; command: string; text: string; who?: string | null }

const LEVELS: Record<string, string> = { note: 'Note', warning: 'Warning', error: 'Error', system: 'System', 'error/warning': 'Warning', info: 'Note' };
const level = (s: string) => LEVELS[s.toLowerCase()] ?? s;

/** "251024 16:17:51" (old MariaDB) → "2025-10-24 16:17:51". */
function oldStamp(s: string) {
  const m = /^(\d\d)(\d\d)(\d\d)\s+(\d{1,2}):(\d\d):(\d\d)$/.exec(s.trim());
  return m ? `20${m[1]}-${m[2]}-${m[3]} ${m[4].padStart(2, '0')}:${m[5]}:${m[6]}` : s;
}

// 2026-10-24 16:17:51 618 [Warning] message                    (MariaDB 10.x)
// 2026-10-25T08:18:13.123456Z 0 [System] [MY-010116] [Server] message   (MySQL 8)
// 251024 16:17:51 [Note] message                              (MariaDB 5.5 / 10.0)
const MARIA = /^(\d{4}-\d\d-\d\d\s+\d{1,2}:\d\d:\d\d)\s+(\d+)\s+\[([A-Za-z/]+)\]\s?(.*)$/;
const MYSQL = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)\s+(\d+)\s+\[([A-Za-z/]+)\](?:\s+\[(MY-\d+)\])?(?:\s+\[([A-Za-z]+)\])?\s?(.*)$/;
const OLD = /^(\d{6}\s+\d{1,2}:\d\d:\d\d)\s+\[([A-Za-z]+)\]\s?(.*)$/;
// journalctl -o short-iso prefix: "2026-10-24T16:17:51+0200 host mariadbd[2331]: "
const JOURNAL = /^\d{4}-\d\d-\d\dT\S+\s+\S+\s+[\w.-]+\[\d+\]:\s?/;

/** Error log entries in file order; lines without a timestamp continue the previous entry. */
export function parseErrorLog(text: string): ErrorEntry[] {
  const out: ErrorEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(JOURNAL, '');
    if (!line.trim()) continue;
    let m = MYSQL.exec(line);
    if (m) { out.push({ at: m[1], thread: Number(m[2]), level: level(m[3]), code: m[4] ?? null, subsystem: m[5] ?? null, message: m[6] }); continue; }
    m = MARIA.exec(line);
    if (m) {
      const sub = /^([A-Za-z_]+): /.exec(m[4]);
      out.push({ at: m[1].replace(/\s+/, ' '), thread: Number(m[2]), level: level(m[3]), code: null, subsystem: sub && /^(InnoDB|Aria|Plugin|mariadbd|mysqld|Slave|Event Scheduler|WSREP)$/i.test(sub[1]) ? sub[1] : null, message: m[4] });
      continue;
    }
    m = OLD.exec(line);
    if (m) { out.push({ at: oldStamp(m[1]), thread: null, level: level(m[2]), code: null, subsystem: null, message: m[3] }); continue; }
    if (out.length) out[out.length - 1].message += `\n${line}`;
    else out.push({ at: null, thread: null, level: 'Note', code: null, subsystem: null, message: line });
  }
  return out;
}

const num = (s: string | undefined) => (s === undefined ? 0 : Number(s));

/** Slow query log file → rows like mysql.slow_log (ms, rows, user@host, db, statement). */
export function parseSlowLog(text: string): (SlowRow & { thread: number | null })[] {
  const out: (SlowRow & { thread: number | null })[] = [];
  let time: string | null = null;
  let db: string | null = null;
  let cur: (SlowRow & { thread: number | null }) | null = null;
  let sql: string[] = [];
  const flush = () => {
    if (cur) {
      const text = sql.join('\n').trim();
      if (text) { cur.text = text; cur.db = cur.db ?? db; out.push(cur); }
    }
    cur = null;
    sql = [];
  };
  for (const line of text.split(/\r?\n/)) {
    let m: RegExpExecArray | null;
    if ((m = /^# Time:\s*(.+)$/.exec(line))) {
      flush();
      const v = m[1].trim();
      time = /^\d{6}\s/.test(v) ? oldStamp(v) : v;
      continue;
    }
    if ((m = /^# User@Host:\s*(.*?)(?:\s+Id:\s*(\d+))?\s*$/.exec(line))) {
      flush();
      cur = { at: time, who: m[1].trim(), ms: 0, lockMs: 0, sent: 0, examined: 0, db: null, text: '', thread: m[2] ? Number(m[2]) : null };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith('#')) {
      const q = /Query_time:\s*([\d.]+)\s+Lock_time:\s*([\d.]+)\s+Rows_sent:\s*(\d+)\s+Rows_examined:\s*(\d+)/.exec(line);
      if (q) { cur.ms = num(q[1]) * 1000; cur.lockMs = num(q[2]) * 1000; cur.sent = num(q[3]); cur.examined = num(q[4]); }
      const th = /Thread_id:\s*(\d+)/.exec(line);
      if (th) cur.thread = Number(th[1]);
      const sch = /Schema:\s*(\S+)/.exec(line);
      if (sch) cur.db = sch[1];
      continue;
    }
    const use = /^use\s+`?([^`;]+)`?;\s*$/i.exec(line);
    if (use && !sql.length) { db = use[1]; cur.db = use[1]; continue; }
    const ts = /^SET timestamp=(\d+);\s*$/.exec(line);
    if (ts && !sql.length) { if (!cur.at || /^\d{6}/.test(cur.at)) cur.at = new Date(Number(ts[1]) * 1000).toISOString(); continue; }
    sql.push(line);
  }
  flush();
  return out;
}

const COMMANDS = /^(Connect|Query|Quit|Init DB|Prepare|Execute|Close stmt|Reset stmt|Field List|Statistics|Ping|Killed|Change user|Long Data|Set option|Fetch|Binlog Dump|Refresh|Shutdown|Processlist|Debug|Daemon|Create DB|Drop DB|Sleep|Table Dump|Delayed insert|Register Slave|Error)$/;

/** General log file (tab separated: time, "id Command", argument; MariaDB omits a repeated time). */
export function parseGeneralLog(text: string): GeneralEntry[] {
  const out: GeneralEntry[] = [];
  let time: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length >= 2) {
      // the "id Command" field is the first non-empty one after the time (MariaDB repeats tabs instead of the time)
      const idx = parts.findIndex((p, i) => i > 0 && /^\s*\d+\s+\S/.test(p));
      if (idx > 0) {
        const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(parts[idx]);
        if (m && COMMANDS.test(m[2])) {
          const stamp = parts.slice(0, idx).join('').trim();
          if (stamp) time = /^\d{6}\s/.test(stamp) ? oldStamp(stamp) : stamp;
          out.push({ at: time, thread: Number(m[1]), command: m[2], text: parts.slice(idx + 1).join('\t') });
          continue;
        }
      }
    }
    // file header lines, or the continuation of a multi-line statement
    if (/^(\/\S+|Tcp port:|Time\s+Id\s+Command)/.test(line)) continue;
    if (out.length) out[out.length - 1].text += `\n${line}`;
  }
  return out;
}

export const LEVEL_ORDER: Record<string, number> = { Error: 0, Warning: 1, System: 2, Note: 3 };
