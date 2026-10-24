import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { ExportFormat, ExportOptions } from '../types';

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'xlsx', label: 'Excel (.xlsx)' },
  { id: 'json', label: 'JSON' },
  { id: 'sql', label: 'SQL (INSERT)' },
];
const KEY = 'mibsql.export';

interface Saved { format: ExportFormat; delimiter: string; header: boolean; nullAs: string; bom: boolean; batch: number }
const DEFAULTS: Saved = { format: 'csv', delimiter: ';', header: true, nullAs: '', bom: true, batch: 100 };

function load(): Saved {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return DEFAULTS; }
}

export default function ExportDialog() {
  const req = useStore((s) => s.exportDialog)!;
  const close = () => useStore.getState().set({ exportDialog: null });
  const [o, setO] = useState<Saved>(load);
  const [table, setTable] = useState(req.table);
  const hasRows = !!req.rows;
  // all rows: only by re-running a read-only query; default when the grid holds only part of them
  const [all, setAll] = useState(!hasRows || (!!req.truncated && !req.filtered && !!req.query));
  const [state, setState] = useState<{ busy?: boolean; progress?: number; done?: { file: string; rows: number }; error?: string }>({});

  useEffect(() => api.exp.onProgress((p) => setState((s) => ({ ...s, progress: p.rows }))), []);

  const set = (patch: Partial<Saved>) => setO((x) => ({ ...x, ...patch }));
  const go = async () => {
    try { localStorage.setItem(KEY, JSON.stringify(o)); } catch { /* ignore */ }
    const opts: ExportOptions = { delimiter: o.delimiter, header: o.header, nullAs: o.nullAs, bom: o.bom, table, batch: o.batch, sheet: req.name };
    setState({ busy: true });
    try {
      const r = all && req.query
        ? await api.exp.query(req.query.connId, req.query.db, req.query.sql, o.format, opts, req.name)
        : await api.exp.rows(o.format, opts, req.columns!, req.rows!, req.name);
      setState(r ? { done: r } : {});
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };

  const n = (x: number) => x.toLocaleString('it-IT');
  return (
    <div className="modal-back" onMouseDown={() => !state.busy && close()}>
      <div className="modal small export" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape' && !state.busy) close(); }}>
        <div className="modal-title">Esporta {req.name}</div>
        <div className="form">
          <div className="seg">
            {FORMATS.map((f) => <button key={f.id} className={o.format === f.id ? 'active' : ''} onClick={() => set({ format: f.id })}>{f.label}</button>)}
          </div>
          {hasRows && req.query && (
            <fieldset className="radios">
              <label className="check"><input type="radio" checked={!all} onChange={() => setAll(false)} /> Righe mostrate ({n(req.rows!.length)}{req.filtered ? ', filtrate' : ''})</label>
              <label className="check"><input type="radio" checked={all} onChange={() => setAll(true)} /> Tutte le righe{req.total !== undefined ? ` (${n(req.total)}${req.truncated ? '+' : ''})` : ''}: riesegue la query</label>
            </fieldset>
          )}
          {hasRows && !req.query && req.truncated && <p className="note">Verranno esportate le {n(req.rows!.length)} righe caricate: per tutte le righe eseguire una SELECT.</p>}
          {o.format === 'csv' && <>
            <label>Separatore
              <select value={o.delimiter} onChange={(e) => set({ delimiter: e.target.value })}>
                <option value=";">Punto e virgola (;) — Excel italiano</option>
                <option value=",">Virgola (,)</option>
                <option value={'\t'}>Tabulazione</option>
                <option value="|">Barra verticale (|)</option>
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={o.header} onChange={(e) => set({ header: e.target.checked })} /> Riga di intestazione</label>
            <label className="check"><input type="checkbox" checked={o.bom} onChange={(e) => set({ bom: e.target.checked })} /> BOM UTF-8 (accenti corretti in Excel)</label>
            <label>NULL come
              <select value={o.nullAs} onChange={(e) => set({ nullAs: e.target.value })}>
                <option value="">Campo vuoto</option>
                <option value="NULL">NULL</option>
                <option value="\N">\N (LOAD DATA)</option>
              </select>
            </label>
          </>}
          {o.format === 'sql' && <>
            <label>Tabella di destinazione<input value={table} onChange={(e) => setTable(e.target.value)} /></label>
            <label>Righe per INSERT<input type="number" min={1} value={o.batch} onChange={(e) => set({ batch: Number(e.target.value) || 1 })} /></label>
          </>}
          {o.format === 'xlsx' && <p className="note">Numeri come numeri (oltre 15 cifre restano testo); massimo 1.048.575 righe.</p>}
          {state.busy && <div className="status">Esportazione in corso…{state.progress ? ` ${n(state.progress)} righe` : ''}</div>}
          {state.error && <div className="status error">{state.error}</div>}
          {state.done && <div className="status ok">Esportate {n(state.done.rows)} righe in {state.done.file}</div>}
        </div>
        <div className="modal-buttons">
          {state.done && <button onClick={() => api.showItem(state.done!.file)}>Mostra nella cartella</button>}
          <div className="spacer" />
          <button onClick={close} disabled={state.busy}>{state.done ? 'Chiudi' : 'Annulla'}</button>
          {!state.done && <button className="primary" onClick={go} disabled={state.busy}>Esporta…</button>}
        </div>
      </div>
    </div>
  );
}
