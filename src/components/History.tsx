import { useEffect, useState } from 'react';
import { api } from '../api';
import { historyEnabled, newDoc, runDoc, setHistoryEnabled } from '../actions';
import { monaco } from '../editor';
import { useStore } from '../store';
import type { Doc, HistoryEntry } from '../types';

const when = (iso: string) => new Date(iso).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const oneLine = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function Sql({ text }: { text: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => { let on = true; monaco.editor.colorize(text, 'mysql', {}).then((h) => { if (on) setHtml(h); }); return () => { on = false; }; }, [text]);
  // colorize escapes the text itself: the HTML holds only its own spans
  return html ? <pre className="hist-sql" dangerouslySetInnerHTML={{ __html: html }} /> : <pre className="hist-sql">{text}</pre>;
}

/** Query history: every executed statement with time, duration, result and connection; search and reuse. */
export default function History({ doc: _doc }: { doc: Doc }) {
  const conns = useStore((s) => s.conns);
  const tick = useStore((s) => s.historyTick);
  const [q, setQ] = useState('');
  const [connId, setConnId] = useState('');
  const [status, setStatus] = useState<'all' | 'ok' | 'error'>('all');
  const [data, setData] = useState<{ entries: HistoryEntry[]; total: number; all: number } | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(historyEnabled());
  const [error, setError] = useState<string | null>(null);

  const load = () => api.history.list({ q, connId: connId || null, status, limit: 1000 }).then((d) => { setData(d); setError(null); }).catch((err) => setError((err as Error).message));
  useEffect(() => { const t = setTimeout(load, 150); return () => clearTimeout(t); }, [q, connId, status, tick]);

  const picked = data?.entries.find((e) => e.id === sel) ?? null;
  const open = (e: HistoryEntry, run: boolean) => {
    const known = conns.some((c) => c.id === e.connId);
    const d = newDoc({ connId: known ? e.connId : undefined, db: known ? e.db : undefined, sql: e.sql.trimEnd() + (/;\s*$/.test(e.sql) ? '\n' : ';\n') });
    if (run) runDoc('all', d.id);
  };
  const remove = async () => {
    if (!picked) return;
    await api.history.remove([picked.id]);
    setSel(null);
    load();
  };
  const clear = async () => {
    if ((await api.confirm('Svuotare la cronologia?', `Verranno eliminate tutte le ${data?.all.toLocaleString('it-IT') ?? ''} istruzioni registrate, di tutte le connessioni.`, ['Svuota', 'Annulla'])) !== 0) return;
    await api.history.clear();
    setSel(null);
    load();
  };

  return (
    <div className="monitor history">
      <div className="er-bar">
        <input className="search" autoFocus placeholder="Cerca nel testo SQL, connessione, database…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={connId} onChange={(e) => setConnId(e.target.value)} title="Connessione">
          <option value="">Tutte le connessioni</option>
          {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} title="Esito">
          <option value="all">Tutti gli esiti</option>
          <option value="ok">Riuscite</option>
          <option value="error">Con errore</option>
        </select>
        <span className="muted">{data ? `${data.total.toLocaleString('it-IT')} di ${data.all.toLocaleString('it-IT')}` : ''}{data && data.total > data.entries.length ? ` (mostrate le ultime ${data.entries.length})` : ''}</span>
        <div className="spacer" />
        <label className="check" title="Registra le istruzioni eseguite dagli editor SQL (le password di CREATE/ALTER USER sono mascherate)">
          <input type="checkbox" checked={enabled} onChange={(e) => { setHistoryEnabled(e.target.checked); setEnabled(e.target.checked); }} /> Registra
        </label>
        <button className="danger" disabled={!data?.all} onClick={clear}>Svuota…</button>
      </div>
      {error && <div className="status error cmp-error">{error}</div>}
      {!enabled && <div className="status cmp-error">La registrazione è disattivata: le nuove esecuzioni non vengono salvate.</div>}
      <div className="hist-body">
        <div className="procs-table hist-list">
          <table className="dtable">
            <thead><tr><th>Quando</th><th>Durata</th><th>Risultato</th><th>Connessione</th><th>Database</th><th>SQL</th></tr></thead>
            <tbody>
              {data?.entries.map((e) => (
                <tr key={e.id} className={sel === e.id ? 'sel' : ''} onMouseDown={() => setSel(e.id)} onDoubleClick={() => open(e, false)} title="Doppio clic: apri in un nuovo documento SQL">
                  <td>{when(e.at)}</td>
                  <td className="num">{e.ms !== null ? `${e.ms.toLocaleString('it-IT')} ms` : ''}</td>
                  <td className={e.error ? 'err' : ''}>{e.error ? 'Errore' : e.rows !== null ? `${e.rows.toLocaleString('it-IT')} righe` : e.affected !== null ? `${e.affected.toLocaleString('it-IT')} modificate` : 'OK'}</td>
                  <td>{e.conn}</td>
                  <td>{e.db ?? ''}</td>
                  <td className="q">{oneLine(e.sql).slice(0, 240)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.entries.length && <div className="empty">{data.all ? 'Nessuna istruzione corrisponde ai filtri.' : 'La cronologia è vuota: le istruzioni eseguite negli editor SQL compariranno qui.'}</div>}
        </div>
        <div className="hist-detail">
          {picked ? <>
            <div className="procs-bar">
              <b>{when(picked.at)}</b>
              <span className="muted">{picked.conn}{picked.db ? ` / ${picked.db}` : ''}</span>
              <div className="spacer" />
              <button onClick={() => open(picked, false)}>Apri in un nuovo SQL</button>
              <button onClick={() => open(picked, true)}>Esegui di nuovo</button>
              <button onClick={() => navigator.clipboard.writeText(picked.sql)}>Copia</button>
              <button className="danger" onClick={remove}>Elimina voce</button>
            </div>
            {picked.error && <div className="status error hist-error">{picked.error}</div>}
            {picked.truncated && <div className="status hist-error">Testo troncato a 64 KB nella cronologia.</div>}
            <Sql text={picked.sql} />
          </> : <div className="empty">Seleziona un'istruzione per vederne il testo completo.</div>}
        </div>
      </div>
    </div>
  );
}
