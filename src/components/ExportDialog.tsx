import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { ExportFormat, ExportOptions } from '../types';
import { t, locale } from '../i18n';

const FORMATS: { id: ExportFormat; label: string }[] = [
  { id: 'csv', label: 'CSV' },
  { id: 'xlsx', label: t('Excel (.xlsx)') },
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

  const n = (x: number) => x.toLocaleString(locale());
  return (
    <div className="modal-back" onMouseDown={() => !state.busy && close()}>
      <div className="modal small export" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape' && !state.busy) close(); }}>
        <div className="modal-title">{t('Esporta')}{' '}{req.name}</div>
        <div className="form">
          <div className="seg">
            {FORMATS.map((f) => <button key={f.id} className={o.format === f.id ? 'active' : ''} onClick={() => set({ format: f.id })}>{f.label}</button>)}
          </div>
          {hasRows && req.query && (
            <fieldset className="radios">
              <label className="check"><input type="radio" checked={!all} onChange={() => setAll(false)} />{' '}{t('Righe mostrate (')}{n(req.rows!.length)}{req.filtered ? ', filtrate' : ''})</label>
              <label className="check"><input type="radio" checked={all} onChange={() => setAll(true)} />{' '}{t('Tutte le righe')}{req.total !== undefined ? ` (${n(req.total)}${req.truncated ? '+' : ''})` : ''}{t(': riesegue la query')}</label>
            </fieldset>
          )}
          {hasRows && !req.query && req.truncated && <p className="note">{t('Verranno esportate le')}{' '}{n(req.rows!.length)}{' '}{t('righe caricate: per tutte le righe eseguire una SELECT.')}</p>}
          {o.format === 'csv' && <>
            <label>{t('Separatore')}
              <select value={o.delimiter} onChange={(e) => set({ delimiter: e.target.value })}>
                <option value=";">{t('Punto e virgola (;) — Excel italiano')}</option>
                <option value=",">{t('Virgola (,)')}</option>
                <option value={'\t'}>{t('Tabulazione')}</option>
                <option value="|">{t('Barra verticale (|)')}</option>
              </select>
            </label>
            <label className="check"><input type="checkbox" checked={o.header} onChange={(e) => set({ header: e.target.checked })} />{' '}{t('Riga di intestazione')}</label>
            <label className="check"><input type="checkbox" checked={o.bom} onChange={(e) => set({ bom: e.target.checked })} />{' '}{t('BOM UTF-8 (accenti corretti in Excel)')}</label>
            <label>{t('NULL come')}
              <select value={o.nullAs} onChange={(e) => set({ nullAs: e.target.value })}>
                <option value="">{t('Campo vuoto')}</option>
                <option value="NULL">NULL</option>
                <option value="\N">\N (LOAD DATA)</option>
              </select>
            </label>
          </>}
          {o.format === 'sql' && <>
            <label>{t('Tabella di destinazione')}<input value={table} onChange={(e) => setTable(e.target.value)} /></label>
            <label>{t('Righe per INSERT')}<input type="number" min={1} value={o.batch} onChange={(e) => set({ batch: Number(e.target.value) || 1 })} /></label>
          </>}
          {o.format === 'xlsx' && <p className="note">{t('Numeri come numeri (oltre 15 cifre restano testo); massimo 1.048.575 righe.')}</p>}
          {state.busy && <div className="status">{t('Esportazione in corso…')}{state.progress ? ` ${n(state.progress)} righe` : ''}</div>}
          {state.error && <div className="status error">{state.error}</div>}
          {state.done && <div className="status ok">{t('Esportate')}{' '}{n(state.done.rows)}{' '}{t('righe in')}{' '}{state.done.file}</div>}
        </div>
        <div className="modal-buttons">
          {state.done && <button onClick={() => api.showItem(state.done!.file)}>{t('Mostra nella cartella')}</button>}
          <div className="spacer" />
          <button onClick={close} disabled={state.busy}>{state.done ? t('Chiudi') : t('Annulla')}</button>
          {!state.done && <button className="primary" onClick={go} disabled={state.busy}>{t('Esporta…')}</button>}
        </div>
      </div>
    </div>
  );
}
