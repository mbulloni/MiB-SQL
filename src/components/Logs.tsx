import { useEffect, useMemo, useState } from 'react';
import { api, type LogStatus } from '../api';
import { newDoc, openServerTool } from '../actions';
import { locale, t, tn } from '../i18n';
import { parseErrorLog, parseGeneralLog, parseSlowLog, type ErrorEntry, type GeneralEntry } from '../logs';
import { useStore } from '../store';
import type { Doc } from '../types';

type Tab = 'error' | 'slow' | 'general';
type SlowEntry = { at: string | null; who: string | null; ms: number; lockMs: number; sent: number; examined: number; db: string | null; text: string; thread?: number | null };
const SOURCE: Record<string, () => string> = {
  table: () => t('tabella'), file: () => t('file'), load_file: () => 'LOAD_FILE', journal: () => t('journal di systemd'),
};
const fmt = (n: number, d = 0) => n.toLocaleString(locale(), { maximumFractionDigits: d });
const when = (s: string | null) => (s ? (/^\d{4}-\d\d-\d\dT/.test(s) ? new Date(s).toLocaleString(locale()) : s) : '');
const secs = (v: unknown) => {
  if (typeof v === 'number') return v;
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(String(v ?? ''));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(v) || 0;
};

/** Server logs: errors, slow queries, general log; switch logs on and off, filter, open statements. */
export default function Logs({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const conn = useStore((s) => s.conns.find((c) => c.id === connId));
  const [tab, setTab] = useState<Tab>('error');
  const [status, setStatus] = useState<LogStatus | null>(null);
  const [err, setErr] = useState<{ entries: ErrorEntry[]; source: string | null; path?: string | null; reason?: string; truncated?: boolean } | null>(null);
  const [slow, setSlow] = useState<{ rows: SlowEntry[]; on: boolean; source: string | null; path?: string | null; reason?: string } | null>(null);
  const [general, setGeneral] = useState<{ rows: GeneralEntry[]; on: boolean; source: string | null; path?: string | null; reason?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [levels, setLevels] = useState({ Error: true, Warning: true, Note: true, System: true });
  const [newestFirst, setNewestFirst] = useState(true);
  const [auto, setAuto] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  const load = async () => {
    setError(null);
    try {
      if (tab === 'error') {
        const r = await api.logs.error(connId);
        setStatus(r.status);
        setErr({ entries: r.entries ?? (r.text ? parseErrorLog(r.text) : []), source: r.source, path: r.path, reason: r.reason, truncated: r.truncated });
      } else {
        const r = await api.logs.query(connId, tab);
        setStatus(r.status);
        if (tab === 'slow') {
          const rows: SlowEntry[] = r.rows
            ? r.rows.map((x) => ({ at: (x.at as string) ?? null, who: (x.who as string) ?? null, ms: secs(x.qt) * 1000, lockMs: secs(x.lt) * 1000, sent: Number(x.sent ?? 0), examined: Number(x.examined ?? 0), db: (x.db as string) ?? null, text: String(x.text ?? ''), thread: x.thread !== undefined ? Number(x.thread) : null }))
            : r.text ? parseSlowLog(r.text) : [];
          setSlow({ rows, on: r.on, source: r.source, path: r.path, reason: r.reason });
        } else {
          const rows: GeneralEntry[] = r.rows
            ? r.rows.map((x) => ({ at: (x.at as string) ?? null, thread: Number(x.thread ?? 0), command: String(x.command ?? ''), text: String(x.text ?? ''), who: (x.who as string) ?? null }))
            : r.text ? parseGeneralLog(r.text) : [];
          setGeneral({ rows, on: r.on, source: r.source, path: r.path, reason: r.reason });
        }
      }
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { if (!connOpen) { useStore.getState().openConn(connId); return; } setSel(null); load(); }, [connOpen, tab, tick]);
  useEffect(() => { if (!auto) return; const h = setInterval(() => setTick((n) => n + 1), 5000); return () => clearInterval(h); }, [auto]);

  const toggle = async (which: 'slow' | 'general', on: boolean) => {
    if (on && which === 'general' && (await api.confirm(t('Attivare il log generale?'), t('Il log generale registra ogni istruzione di ogni connessione: rallenta il server e cresce in fretta. Tienilo attivo solo il tempo necessario.'), [t('Attiva'), t('Annulla')])) !== 0) return;
    try { setStatus(await api.logs.set(connId, which, on, true)); setTick((n) => n + 1); } catch (e) { setError((e as Error).message); }
  };
  const toTable = async (which: 'slow' | 'general') => {
    const on = which === 'slow' ? !!slow?.on : !!general?.on;
    try { setStatus(await api.logs.set(connId, which, on, true)); setTick((n) => n + 1); } catch (e) { setError((e as Error).message); }
  };
  const clear = async (which: 'slow' | 'general') => {
    if ((await api.confirm(t('Svuotare il log?'), `TRUNCATE TABLE mysql.${which === 'slow' ? 'slow_log' : 'general_log'}`, [t('Svuota'), t('Annulla')])) !== 0) return;
    try { await api.logs.clear(connId, which); setTick((n) => n + 1); } catch (e) { setError((e as Error).message); }
  };

  const q = filter.toLowerCase();
  const order = <T,>(list: T[]) => (newestFirst ? [...list].reverse() : list);
  const errRows = useMemo(() => order((err?.entries ?? []).filter((e) => (levels[e.level as keyof typeof levels] ?? true) && (!q || `${e.message} ${e.subsystem ?? ''} ${e.code ?? ''}`.toLowerCase().includes(q)))), [err, levels, q, newestFirst]);
  const slowRows = useMemo(() => order((slow?.rows ?? []).filter((r) => !q || `${r.text} ${r.who ?? ''} ${r.db ?? ''}`.toLowerCase().includes(q))), [slow, q, newestFirst]);
  const genRows = useMemo(() => order((general?.rows ?? []).filter((r) => !q || `${r.text} ${r.command} ${r.who ?? ''} ${r.thread}`.toLowerCase().includes(q))), [general, q, newestFirst]);
  const counts = useMemo(() => (err?.entries ?? []).reduce((m, e) => ({ ...m, [e.level]: (m[e.level] ?? 0) + 1 }), {} as Record<string, number>), [err]);
  const cur = tab === 'error' ? err : tab === 'slow' ? slow : general;
  const output = status?.log_output ?? '';

  const sourceLine = cur && (cur.source
    ? <span className="muted">{t('Fonte')}: {SOURCE[cur.source]?.() ?? cur.source}{cur.path ? ` · ${cur.path}` : ''}{'truncated' in cur && cur.truncated ? ` · ${t('ultimi 4 MB')}` : ''}</span>
    : null);

  return (
    <div className="monitor logs">
      <div className="er-bar">
        <span className="muted">{conn?.name} · {status?.version ?? ''}{status?.local ? ` · ${t('server su questo computer')}` : ''}</span>
        <div className="spacer" />
        <input className="search" placeholder={t('Filtra…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check"><input type="checkbox" checked={newestFirst} onChange={(e) => setNewestFirst(e.target.checked)} /> {t('Più recenti in alto')}</label>
        <label className="check"><input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t('Aggiorna ogni 5 s')}</label>
        <button onClick={() => setTick((n) => n + 1)}>{t('Aggiorna')}</button>
      </div>
      <div className="tabs-row">
        <button className={tab === 'error' ? 'active' : ''} onClick={() => setTab('error')}>{t('Errori')}{counts.Error ? <span className="badge st-target"> {counts.Error}</span> : null}</button>
        <button className={tab === 'slow' ? 'active' : ''} onClick={() => setTab('slow')}>{t('Query lente')}</button>
        <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>{t('Log generale')}</button>
      </div>
      {error && <div className="status error cmp-error">{error}</div>}

      {tab === 'error' && <div className="maint-body">
        <div className="maint-actions">
          {(['Error', 'Warning', 'Note', 'System'] as const).map((l) => (
            <label key={l} className="check"><input type="checkbox" checked={levels[l]} onChange={(e) => setLevels({ ...levels, [l]: e.target.checked })} /> <span className={`lvl ${l}`}>{{ Error: t('Errori'), Warning: t('Avvisi'), Note: t('Note'), System: t('Sistema') }[l]}</span> <span className="muted">{counts[l] ?? 0}</span></label>
          ))}
          <div className="spacer" />{sourceLine}
        </div>
        {err?.reason && <div className="help-card"><p>{err.reason}</p>{status?.log_error !== undefined && <p className="muted">log_error = {status.log_error || "''"}</p>}</div>}
        {err && !err.reason && <div className="procs-table log-list">
          <table className="dtable">
            <thead><tr><th>{t('Quando')}</th><th>{t('Livello')}</th><th>Thread</th><th>{t('Codice')}</th><th>{t('Componente')}</th><th>{t('Messaggio')}</th></tr></thead>
            <tbody>{errRows.slice(0, 3000).map((e, i) => (
              <tr key={i} className={`lvl-row ${e.level}${sel === i ? ' sel' : ''}`} onMouseDown={() => setSel(i)}>
                <td className="nowrap">{when(e.at)}</td><td><span className={`lvl ${e.level}`}>{e.level}</span></td><td>{e.thread ?? ''}</td><td>{e.code ?? ''}</td><td>{e.subsystem ?? ''}</td>
                <td className="msg">{e.message}</td>
              </tr>
            ))}</tbody>
          </table>
          {!errRows.length && <div className="empty">{t('Nessuna voce con i filtri scelti.')}</div>}
        </div>}
      </div>}

      {tab === 'slow' && <div className="maint-body">
        <div className="maint-actions">
          <span>{t('Log delle query lente')}: <b>{slow?.on ? 'ON' : 'OFF'}</b>{status ? ` · long_query_time = ${status.long_query_time} s · log_output = ${output}` : ''}</span>
          <button onClick={() => toggle('slow', !slow?.on)}>{slow?.on ? t('Disattiva') : t('Attiva (su tabella)')}</button>
          {/TABLE/i.test(output) && <button onClick={() => clear('slow')}>{t('Svuota…')}</button>}
          <button onClick={() => openServerTool(connId, 'perf', { tab: 'top' })}>{t('Raggruppa in Prestazioni › Query pesanti')}</button>
          <div className="spacer" />{sourceLine}
        </div>
        {slow?.reason && <div className="help-card"><p>{slow.reason}</p><button className="link" onClick={() => toTable('slow')}>{t('Scrivi il log anche su tabella (log_output = FILE,TABLE)')}</button></div>}
        {slow && !slow.reason && <div className="procs-table log-list">
          <table className="dtable">
            <thead><tr><th>{t('Quando')}</th><th className="num">{t('Durata')}</th><th className="num">Lock</th><th className="num">{t('Righe lette')}</th><th className="num">{t('Restituite')}</th><th>{t('Utente')}</th><th>DB</th><th>{t('Istruzione')}</th></tr></thead>
            <tbody>{slowRows.slice(0, 3000).map((r, i) => (
              <tr key={i} className={sel === i ? 'sel' : ''} onMouseDown={() => setSel(i)} onDoubleClick={() => newDoc({ connId, db: r.db, sql: `${r.text.replace(/;?\s*$/, '')};\n` })}>
                <td className="nowrap">{when(r.at)}</td><td className="num">{fmt(r.ms / 1000, 3)} s</td><td className="num">{fmt(r.lockMs, 1)} ms</td><td className="num">{fmt(r.examined)}</td><td className="num">{fmt(r.sent)}</td>
                <td>{r.who ?? ''}</td><td>{r.db ?? ''}</td><td className="q" title={r.text}>{r.text.replace(/\s+/g, ' ').slice(0, 200)}</td>
              </tr>
            ))}</tbody>
          </table>
          {!slowRows.length && <div className="empty">{slow.on ? t('Nessuna query registrata.') : t('Il log delle query lente è disattivato.')}</div>}
        </div>}
      </div>}

      {tab === 'general' && <div className="maint-body">
        <div className="maint-actions">
          <span>{t('Log generale')}: <b>{general?.on ? 'ON' : 'OFF'}</b>{status ? ` · log_output = ${output}` : ''}</span>
          <button className={general?.on ? 'danger' : ''} onClick={() => toggle('general', !general?.on)}>{general?.on ? t('Disattiva') : t('Attiva (su tabella)…')}</button>
          {/TABLE/i.test(output) && <button onClick={() => clear('general')}>{t('Svuota…')}</button>}
          <div className="spacer" />{sourceLine}
        </div>
        {general?.on && <p className="note warn-text">{t('Il log generale è attivo: registra ogni istruzione e pesa sul server. Disattivalo quando hai finito.')}</p>}
        {general?.reason && <div className="help-card"><p>{general.reason}</p><button className="link" onClick={() => toTable('general')}>{t('Scrivi il log anche su tabella (log_output = FILE,TABLE)')}</button></div>}
        {general && !general.reason && <div className="procs-table log-list">
          <table className="dtable">
            <thead><tr><th>{t('Quando')}</th><th>Thread</th><th>{t('Comando')}</th><th>{t('Utente')}</th><th>{t('Testo')}</th></tr></thead>
            <tbody>{genRows.slice(0, 3000).map((r, i) => (
              <tr key={i} className={sel === i ? 'sel' : ''} onMouseDown={() => setSel(i)} onDoubleClick={() => r.command === 'Query' && newDoc({ connId, sql: `${r.text.replace(/;?\s*$/, '')};\n` })}>
                <td className="nowrap">{when(r.at)}</td><td>{r.thread}</td><td>{r.command}</td><td>{r.who ?? ''}</td><td className="q" title={r.text}>{r.text.replace(/\s+/g, ' ').slice(0, 220)}</td>
              </tr>
            ))}</tbody>
          </table>
          {!genRows.length && <div className="empty">{general.on ? t('Nessuna voce.') : t('Il log generale è disattivato.')}</div>}
        </div>}
      </div>}
      <div className="log-foot muted">{cur && 'rows' in cur ? tn(cur.rows.length, '{0} voce', '{0} voci') : err ? tn(err.entries.length, '{0} voce', '{0} voci') : ''}</div>
    </div>
  );
}
