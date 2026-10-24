import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { newDoc, runDoc } from '../actions';
import { callScript, type ParamValue, type RoutineParam } from '../routines';
import { useStore } from '../store';

/** Values for a routine's parameters, then CALL (procedure) or SELECT (function) in a new SQL document. */
export default function CallDialog({ connId, db, kind, name }: { connId: string; db: string; kind: 'procedure' | 'function'; name: string }) {
  const [params, setParams] = useState<RoutineParam[] | null>(null);
  const [returns, setReturns] = useState<string | null>(null);
  const [values, setValues] = useState<ParamValue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const close = () => useStore.getState().set({ callDialog: null });

  useEffect(() => {
    api.objects.params(connId, db, kind, name).then((r) => {
      setParams(r.params);
      setReturns(r.returns);
      setValues(r.params.map(() => ({ value: '', isNull: false, expr: false })));
    }).catch((err) => setError((err as Error).message));
  }, []);

  const sql = useMemo(() => (params ? callScript(db, kind, name, params, values) : ''), [params, values]);
  const set = (i: number, p: Partial<ParamValue>) => setValues((v) => v.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const go = (run: boolean) => {
    close();
    const d = newDoc({ connId, db, sql, title: `${name}.sql` });
    if (run) runDoc('all', d.id);
  };

  return (
    <div className="modal-back" onMouseDown={close}>
      <form className="modal call" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (params) go(true); }} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div className="modal-title">Esegui {kind === 'procedure' ? 'la procedura' : 'la funzione'} {db}.{name}{returns && <span className="hint">restituisce {returns}</span>}</div>
        <div className="form">
          {error && <div className="status error">{error}</div>}
          {params && !params.length && <p className="note">Nessun parametro.</p>}
          {params && params.length > 0 && (
            <table className="dtable">
              <thead><tr><th>Modo</th><th>Parametro</th><th>Tipo</th><th>Valore</th><th>NULL</th><th title="Il valore è un'espressione SQL (es. NOW(), @variabile), non un testo da quotare">Espr.</th></tr></thead>
              <tbody>
                {params.map((p, i) => {
                  const out = p.mode.toUpperCase() === 'OUT';
                  return (
                    <tr key={p.name}>
                      <td>{p.mode}</td>
                      <td><code>{p.name}</code></td>
                      <td className="muted">{p.type}</td>
                      <td><input autoFocus={i === 0} disabled={out || values[i]?.isNull} placeholder={out ? 'valore restituito' : ''} value={values[i]?.value ?? ''} onChange={(e) => set(i, { value: e.target.value })} /></td>
                      <td className="c"><input type="checkbox" disabled={out} checked={!!values[i]?.isNull} onChange={(e) => set(i, { isNull: e.target.checked })} /></td>
                      <td className="c"><input type="checkbox" disabled={out || values[i]?.isNull} checked={!!values[i]?.expr} onChange={(e) => set(i, { expr: e.target.checked })} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {params && <><div className="props-title">Script</div><pre className="hist-sql">{sql}</pre></>}
        </div>
        <div className="modal-buttons">
          <div className="spacer" />
          <button type="button" onClick={close}>Annulla</button>
          <button type="button" disabled={!params} onClick={() => go(false)}>Apri nell'editor</button>
          <button type="submit" className="primary" disabled={!params}>Esegui</button>
        </div>
      </form>
    </div>
  );
}
