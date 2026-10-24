import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { Doc, MaintOp, MaintResult, TableStat } from '../types';

const REPAIRABLE = new Set(['MyISAM', 'Aria', 'ARCHIVE', 'CSV']);
const OP_LABEL: Record<MaintOp, string> = { analyze: 'Analizza', optimize: 'Ottimizza', check: 'Controlla', repair: 'Ripara', checksum: 'Checksum' };

export function bytes(n: number | null) {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('it-IT', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
}
const total = (t: TableStat) => (t.data ?? 0) + (t.idx ?? 0);
/** Share of the table's space that is allocated but free (reclaimable with OPTIMIZE). */
export const fragmentation = (t: TableStat) => {
  const all = total(t) + (t.free ?? 0);
  return all && t.free ? (t.free / all) * 100 : 0;
};
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' }) : '');

type SortKey = 'name' | 'engine' | 'rows' | 'data' | 'idx' | 'total' | 'free' | 'frag' | 'updated';
const KEY: Record<SortKey, (t: TableStat) => number | string> = {
  name: (t) => t.name.toLowerCase(), engine: (t) => t.engine ?? '', rows: (t) => t.rows ?? -1, data: (t) => t.data ?? -1, idx: (t) => t.idx ?? -1,
  total, free: (t) => t.free ?? -1, frag: fragmentation, updated: (t) => t.updated ?? '',
};

/** Table maintenance: sizes and fragmentation, ANALYZE / OPTIMIZE / CHECK / REPAIR / CHECKSUM with the server's messages. */
export default function Maint({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const db = doc.db!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const mariadb = useStore((s) => /mariadb/i.test(s.connState[connId]?.info?.version ?? ''));
  const [stats, setStats] = useState<TableStat[] | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set(doc.maint?.tables ?? []));
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'total', desc: true });
  const [checkOption, setCheckOption] = useState('');
  const [persistent, setPersistent] = useState(false);
  const [local, setLocal] = useState(false);
  const [running, setRunning] = useState<{ id: string; op: MaintOp; done: number; total: number; table: string | null } | null>(null);
  const [results, setResults] = useState<MaintResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.maint.stats(connId, db).then((s) => { setStats(s); setError(null); }).catch((err) => setError((err as Error).message));
  useEffect(() => { if (!connOpen) { useStore.getState().openConn(connId); return; } load(); }, [connOpen]);
  // tables picked from the explorer when the tab was (re)opened
  useEffect(() => { if (doc.maint?.tables.length) setSel(new Set(doc.maint.tables)); }, [doc.maint]);
  useEffect(() => api.tasks.onProgress((p) => {
    setRunning((r) => (r && p.id === r.id ? { ...r, done: Number(p.done), total: Number(p.total), table: (p.table as string) ?? null } : r));
  }), []);

  const shown = useMemo(() => {
    const f = filter.toLowerCase();
    const list = (stats ?? []).filter((t) => !f || t.name.toLowerCase().includes(f));
    const k = KEY[sort.key];
    return [...list].sort((a, b) => {
      const x = k(a);
      const y = k(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
    });
  }, [stats, filter, sort]);
  const picked = (stats ?? []).filter((t) => sel.has(t.name));
  const sums = (stats ?? []).reduce((a, t) => ({ data: a.data + (t.data ?? 0), idx: a.idx + (t.idx ?? 0), free: a.free + (t.free ?? 0) }), { data: 0, idx: 0, free: 0 });
  const allShown = shown.length > 0 && shown.every((t) => sel.has(t.name));
  const toggle = (name: string, on: boolean) => setSel((s) => { const n = new Set(s); if (on) n.add(name); else n.delete(name); return n; });
  const header = (key: SortKey, label: string, num = false) => (
    <th className={num ? 'num' : ''} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== 'name' && key !== 'engine' }))}>
      {label}{sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}
    </th>
  );

  const run = async (op: MaintOp) => {
    const tables = picked.map((t) => t.name);
    if (!tables.length) return;
    const size = bytes(picked.reduce((n, t) => n + total(t), 0));
    const what = tables.length === 1 ? `la tabella ${tables[0]}` : `${tables.length} tabelle`;
    if (op === 'optimize' && (await api.confirm(`Ottimizzare ${what} (${size})?`,
      'OPTIMIZE ricostruisce ogni tabella per recuperare lo spazio libero e riordinare dati e indici. Su InnoDB equivale ad ALTER TABLE … FORCE: '
      + 'richiede spazio su disco pari alla tabella e su tabelle grandi può durare a lungo. Le tabelle vengono elaborate una alla volta.', ['Ottimizza', 'Annulla'])) !== 0) return;
    if (op === 'repair' && (await api.confirm(`Riparare ${what}?`, 'REPAIR TABLE può eliminare le righe che non riesce a recuperare: fai prima un backup. Vale solo per MyISAM, Aria, ARCHIVE e CSV.', ['Ripara', 'Annulla'])) !== 0) return;
    const option = op === 'check' ? checkOption : op === 'analyze' && persistent ? 'PERSISTENT FOR ALL' : '';
    const id = crypto.randomUUID();
    setRunning({ id, op, done: 0, total: tables.length, table: tables[0] });
    setError(null);
    try {
      const r = await api.maint.run(id, connId, db, tables, op, { option, local });
      setResults(r.results);
      if (r.stopped) setError(`Interrotto: elaborate ${new Set(r.results.map((x) => x.table)).size} tabelle su ${tables.length}.`);
    } catch (err) { setError((err as Error).message); }
    setRunning(null);
    load();
  };

  const repairable = picked.length > 0 && picked.every((t) => REPAIRABLE.has(t.engine ?? ''));
  const problems = results.filter((r) => r.type === 'error' || (r.type === 'status' && !/^(OK|Table is already up to date)$/i.test(r.text)) || r.type === 'warning').length;

  return (
    <div className="monitor maint">
      <div className="er-bar">
        <b>{db}</b>
        <span className="muted">{stats ? `${stats.length} tabelle · dati ${bytes(sums.data)} · indici ${bytes(sums.idx)} · libero ${bytes(sums.free)}` : 'Caricamento…'}</span>
        <div className="spacer" />
        <input className="search" placeholder="Filtra tabelle…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <button onClick={load} disabled={!!running}>Aggiorna</button>
      </div>
      <div className="maint-actions">
        <span className="muted">{picked.length === 1 ? '1 selezionata' : `${picked.length} selezionate`}</span>
        <button disabled={!picked.length || !!running} onClick={() => run('analyze')} title="ANALYZE TABLE: aggiorna le statistiche degli indici usate dall'ottimizzatore">Analizza</button>
        {mariadb && <label className="check" title="ANALYZE TABLE … PERSISTENT FOR ALL: raccoglie anche gli istogrammi delle colonne (statistiche indipendenti dall'engine); più lento"><input type="checkbox" checked={persistent} onChange={(e) => setPersistent(e.target.checked)} /> con istogrammi</label>}
        <span className="sep" />
        <button disabled={!picked.length || !!running} onClick={() => run('optimize')} title="OPTIMIZE TABLE: ricostruisce la tabella, recupera lo spazio libero">Ottimizza…</button>
        <span className="sep" />
        <button disabled={!picked.length || !!running} onClick={() => run('check')} title="CHECK TABLE: verifica la tabella e gli indici">Controlla</button>
        <select value={checkOption} onChange={(e) => setCheckOption(e.target.value)} title="Profondità del controllo">
          <option value="">standard</option>
          <option value="QUICK">QUICK (senza leggere le righe)</option>
          <option value="FAST">FAST (solo se non chiuse correttamente)</option>
          <option value="MEDIUM">MEDIUM</option>
          <option value="EXTENDED">EXTENDED (completo, lento)</option>
          <option value="CHANGED">CHANGED (modificate dall'ultimo controllo)</option>
          <option value="FOR UPGRADE">FOR UPGRADE (compatibilità di versione)</option>
        </select>
        <span className="sep" />
        <button disabled={!repairable || !!running} onClick={() => run('repair')} title={repairable ? 'REPAIR TABLE' : 'REPAIR TABLE vale solo per MyISAM, Aria, ARCHIVE e CSV: per InnoDB usa Ottimizza o un ripristino da backup'}>Ripara…</button>
        <button disabled={!picked.length || !!running} onClick={() => run('checksum')} title="CHECKSUM TABLE: impronta dei dati, per confrontare la stessa tabella su due server">Checksum</button>
        <div className="spacer" />
        <label className="check" title="NO_WRITE_TO_BINLOG: ANALYZE, OPTIMIZE e REPAIR non vengono replicati sulle repliche"><input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} /> Non replicare (binlog)</label>
      </div>
      {running && (
        <div className="maint-progress">
          <span>{OP_LABEL[running.op]}: {running.table ?? 'completato'} ({running.done + (running.table ? 1 : 0)} di {running.total})</span>
          <div className="progress"><div style={{ width: `${(running.done / Math.max(1, running.total)) * 100}%` }} /></div>
          <button onClick={() => api.maint.stop(running.id)} title="Si ferma dopo la tabella in corso">Interrompi</button>
        </div>
      )}
      {error && <div className="status error cmp-error">{error}</div>}
      <div className="maint-body">
        <div className="procs-table">
          <table className="dtable maint-table">
            <thead>
              <tr>
                <th className="c"><input type="checkbox" checked={allShown} title="Seleziona tutte le tabelle mostrate" onChange={(e) => setSel((s) => { const n = new Set(s); for (const t of shown) if (e.target.checked) n.add(t.name); else n.delete(t.name); return n; })} /></th>
                {header('name', 'Tabella')}{header('engine', 'Engine')}{header('rows', 'Righe (stima)', true)}{header('data', 'Dati', true)}{header('idx', 'Indici', true)}
                {header('total', 'Totale', true)}{header('free', 'Libero', true)}{header('frag', 'Frammentazione', true)}{header('updated', 'Ultima modifica')}
                <th>Ultimo controllo</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => {
                const frag = fragmentation(t);
                const heavy = frag >= 20 && (t.free ?? 0) >= 10 * 1024 * 1024;
                return (
                  <tr key={t.name} className={sel.has(t.name) ? 'sel' : ''} onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'INPUT') setSel(e.ctrlKey || e.metaKey ? (() => { const n = new Set(sel); if (n.has(t.name)) n.delete(t.name); else n.add(t.name); return n; })() : new Set([t.name])); }}>
                    <td className="c"><input type="checkbox" checked={sel.has(t.name)} onChange={(e) => toggle(t.name, e.target.checked)} /></td>
                    <td title={t.comment || undefined}>{t.name}</td>
                    <td>{t.engine ?? ''}{t.rowFormat ? <span className="muted"> {t.rowFormat}</span> : null}</td>
                    <td className="num">{t.rows?.toLocaleString('it-IT') ?? ''}</td>
                    <td className="num">{bytes(t.data)}</td>
                    <td className="num">{bytes(t.idx)}</td>
                    <td className="num"><b>{bytes(total(t))}</b></td>
                    <td className="num">{bytes(t.free)}</td>
                    <td className={`num${heavy ? ' warn' : ''}`} title={heavy ? 'Molto spazio inutilizzato: Ottimizza lo recupera' : undefined}>{frag ? `${frag.toLocaleString('it-IT', { maximumFractionDigits: 1 })} %` : ''}</td>
                    <td>{day(t.updated)}</td>
                    <td>{day(t.checked)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {stats && !shown.length && <div className="empty">{stats.length ? 'Nessuna tabella corrisponde al filtro.' : 'Il database non ha tabelle.'}</div>}
        </div>
        {results.length > 0 && (
          <div className="procs maint-results">
            <div className="procs-bar">
              <b>Risultati</b>
              <span className="muted">{new Set(results.map((r) => r.table)).size} tabelle · {problems ? `${problems} da verificare` : 'nessun problema'}</span>
              <div className="spacer" />
              <button onClick={() => setResults([])}>Chiudi</button>
            </div>
            <div className="procs-table">
              <table className="dtable">
                <thead><tr><th>Tabella</th><th>Operazione</th><th>Tipo</th><th>Messaggio</th><th className="num">Tempo</th></tr></thead>
                <tbody>
                  {results.map((r, i) => (
                    <tr key={i}>
                      <td>{r.table}</td>
                      <td>{r.op}</td>
                      <td className={r.type === 'error' ? 'err' : r.type === 'warning' ? 'warn' : ''}>{r.type}</td>
                      <td className="q" title={r.text}>{r.text}{/doing recreate \+ analyze/i.test(r.text) ? <span className="muted"> — normale per InnoDB: la tabella viene ricostruita e poi analizzata</span> : null}</td>
                      <td className="num">{r.ms.toLocaleString('it-IT')} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
