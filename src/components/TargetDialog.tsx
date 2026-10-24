import { useEffect, useState } from 'react';
import { openVisual } from '../actions';
import { loadDatabases, metaKey, useStore, type MetaEntry, type VisualKind } from '../store';

const TITLE: Record<VisualKind, string> = { er: 'Diagramma ER', query: 'Query Builder', table: 'Nuova tabella', compare: 'Confronto schema e dati' };

/** Which database to open a visual tool on, when none is selected in the explorer or active document. */
export default function TargetDialog({ kind }: { kind: VisualKind }) {
  const conns = useStore((s) => s.conns);
  const [connId, setConnId] = useState(conns[0]?.id ?? '');
  const [db, setDb] = useState('');
  const status = useStore((s) => (connId ? s.connState[connId]?.status : undefined));
  const dbs = useStore((s) => (connId ? s.meta[metaKey.databases(connId)] : undefined)) as MetaEntry<string[]> | undefined;
  const close = () => useStore.getState().set({ pickTarget: null });
  useEffect(() => {
    if (!connId) return;
    if (status !== 'open') { if (status !== 'connecting') useStore.getState().openConn(connId); return; }
    loadDatabases(connId);
  }, [connId, status]);
  const conn = conns.find((c) => c.id === connId);
  useEffect(() => { if (!db && conn?.database) setDb(conn.database); }, [connId]);
  const go = () => { close(); openVisual(kind, { connId, db }); };
  return (
    <div className="modal-back" onMouseDown={close}>
      <form className="modal small" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (connId && db) go(); }} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div className="modal-title">{TITLE[kind]}: scegli il database</div>
        <div className="form">
          {!conns.length ? <div className="status error">Nessuna connessione: creane una dalla toolbar o dall'Explorer.</div> : <>
            <label>Connessione
              <select value={connId} onChange={(e) => { setConnId(e.target.value); setDb(''); }}>
                {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            <label>Database
              <select value={db} autoFocus onChange={(e) => setDb(e.target.value)} disabled={status !== 'open'}>
                <option value="">{status === 'open' ? '(scegli)' : 'connessione in corso…'}</option>
                {(dbs?.data ?? []).map((d) => <option key={d}>{d}</option>)}
              </select>
            </label>
            <p className="note">Suggerimento: selezionando un database nell'Explorer gli editor visuali si aprono direttamente su quello.</p>
          </>}
        </div>
        <div className="modal-buttons">
          <div className="spacer" />
          <button type="button" onClick={close}>Annulla</button>
          <button type="submit" className="primary" disabled={!connId || !db}>Apri</button>
        </div>
      </form>
    </div>
  );
}
