// Query profiler: readable plan rows from MariaDB's ANALYZE FORMAT=JSON and tuning hints from the session
// counters. Pure functions for tests.

export interface Profile {
  sql: string; start: number; end: number; ms: number; rows: number; affectedRows: number | null; db: string | null;
  error: { message: string } | null;
  stages: { stage: string; ms: number }[];
  status: { name: string; value: number; global: boolean }[];
  plan: { format: 'json'; data: Record<string, unknown> } | { format: 'tree' | 'error'; data: string } | null;
}

export interface PlanRow {
  depth: number;
  label: string;          // table name or operation (filesort, temporary table, subquery…)
  access?: string;        // ALL, ref, eq_ref, range, index…
  key?: string;
  rows?: number;          // estimated
  rRows?: number;         // real rows per loop
  loops?: number;
  filtered?: number;
  rFiltered?: number;
  ms?: number;
  condition?: string;
  warn?: boolean;         // full scan of a big table or estimate far from reality
}

type Obj = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** Depth-first rows of an ANALYZE FORMAT=JSON tree (tables, sorts, temporary tables, subqueries). */
export function planRows(plan: Obj): PlanRow[] {
  const out: PlanRow[] = [];
  const visit = (node: unknown, depth: number) => {
    if (Array.isArray(node)) { node.forEach((n) => visit(n, depth)); return; }
    if (!node || typeof node !== 'object') return;
    const o = node as Obj;
    if (o.table && typeof o.table === 'object') {
      const t = o.table as Obj;
      const rRows = num(t.r_rows);
      const rows = num(t.rows);
      const full = t.access_type === 'ALL' && (rRows ?? rows ?? 0) > 1000;
      const off = rows !== undefined && rRows !== undefined && rRows > 0 && (rows / rRows > 10 || rRows / Math.max(rows, 1) > 10);
      out.push({
        depth, label: String(t.table_name ?? '?'), access: t.access_type as string | undefined, key: t.key as string | undefined,
        rows, rRows, loops: num(t.r_loops), filtered: num(t.filtered), rFiltered: num(t.r_filtered),
        ms: num(t.r_table_time_ms) ?? num(t.r_total_time_ms), condition: (t.attached_condition as string | undefined) ?? undefined, warn: full || off,
      });
      for (const [k, v] of Object.entries(t)) if (typeof v === 'object' && k !== 'table') visit({ [k]: v }, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(o)) {
      if (k === 'filesort' || k === 'temporary_table' || k === 'subqueries' || k === 'materialized' || k === 'union_result' || k === 'duplicates_removal' || k === 'window_functions_computation') {
        const op = v as Obj;
        const label = { filesort: `ordinamento (${String((op as Obj)?.sort_key ?? '')})`, temporary_table: 'tabella temporanea', subqueries: 'sottoquery', materialized: 'materializzazione', union_result: 'UNION', duplicates_removal: 'rimozione duplicati', window_functions_computation: 'funzioni finestra' }[k];
        out.push({ depth, label, ms: num(op?.r_total_time_ms), rRows: num(op?.r_output_rows) });
        visit(v, depth + 1);
      } else if (typeof v === 'object') {
        visit(v, depth);
      }
    }
  };
  visit(plan.query_block ?? plan, 0);
  return out;
}

const get = (status: Profile['status'], k: string) => status.find((s) => s.name === k)?.value ?? 0;

/** Tuning hints, most important first. */
export function hints(p: Profile): { level: 'warn' | 'info'; text: string }[] {
  const out: { level: 'warn' | 'info'; text: string }[] = [];
  const s = p.status;
  if (get(s, 'Select_full_join')) out.push({ level: 'warn', text: 'Join senza indice (Select_full_join): aggiungere un indice sulle colonne di join.' });
  if (get(s, 'Created_tmp_disk_tables')) out.push({ level: 'warn', text: 'Tabella temporanea su disco: il risultato intermedio non sta in memoria (tmp_table_size) o contiene TEXT/BLOB.' });
  if (get(s, 'Sort_merge_passes')) out.push({ level: 'warn', text: "Ordinamento a più passaggi (Sort_merge_passes): valutare un indice sull'ORDER BY o sort_buffer_size." });
  const scanned = get(s, 'Handler_read_rnd_next');
  const returned = Math.max(1, p.rows || p.affectedRows || 1);
  if (scanned > 10000 && scanned / returned > 100) out.push({ level: 'warn', text: `Letture sequenziali: ${scanned.toLocaleString('it-IT')} righe scorse per ${returned.toLocaleString('it-IT')} restituite. Una condizione su colonna indicizzata ridurrebbe la scansione.` });
  if (p.plan?.format === 'json') {
    for (const r of planRows(p.plan.data)) {
      if (r.access === 'ALL' && (r.rRows ?? 0) > 1000) out.push({ level: 'warn', text: `Scansione completa di ${r.label} (${Math.round(r.rRows!).toLocaleString('it-IT')} righe per ciclo).` });
      else if (r.warn && r.rows !== undefined && r.rRows !== undefined) out.push({ level: 'info', text: `Stima delle righe di ${r.label} lontana dal reale (${r.rows} stimate, ${Math.round(r.rRows)} reali): ANALYZE TABLE aggiorna le statistiche.` });
    }
  }
  if (get(s, 'Created_tmp_tables') && !get(s, 'Created_tmp_disk_tables')) out.push({ level: 'info', text: 'Tabella temporanea in memoria (GROUP BY/ORDER BY/DISTINCT su colonne diverse).' });
  if (!out.length) out.push({ level: 'info', text: 'Nessun problema evidente: la query usa indici e non crea strutture temporanee su disco.' });
  return out;
}

/** Explanation of a status counter (shown next to its value). */
export const COUNTERS: Record<string, string> = {
  Handler_read_key: 'letture tramite indice',
  Handler_read_next: "righe successive lette nell'ordine dell'indice",
  Handler_read_first: 'prime voci di un indice (scansione di indice)',
  Handler_read_rnd: 'letture per posizione (dopo un ordinamento)',
  Handler_read_rnd_next: 'righe lette in scansione sequenziale',
  Handler_write: 'righe scritte (anche in tabelle temporanee)',
  Handler_update: 'righe aggiornate',
  Handler_delete: 'righe eliminate',
  Sort_rows: 'righe ordinate',
  Sort_scan: 'ordinamenti con scansione completa',
  Sort_range: 'ordinamenti su intervalli',
  Sort_merge_passes: 'passaggi di fusione dell\'ordinamento',
  Created_tmp_tables: 'tabelle temporanee in memoria',
  Created_tmp_disk_tables: 'tabelle temporanee su disco',
  Select_scan: 'scansioni complete della prima tabella',
  Select_full_join: 'join senza indice',
  Select_range: 'join con intervallo sulla prima tabella',
  Select_full_range_join: 'join con ricerca per intervallo',
  Rows_read: 'righe lette dai motori',
  Rows_sent: 'righe inviate al client',
  Rows_tmp_read: 'righe lette da tabelle temporanee',
  Bytes_sent: 'byte inviati al client',
  Innodb_rows_read: 'righe lette da InnoDB (globale)',
  Innodb_buffer_pool_read_requests: 'letture logiche del buffer pool (globale)',
  Innodb_buffer_pool_reads: 'letture da disco (globale)',
};
