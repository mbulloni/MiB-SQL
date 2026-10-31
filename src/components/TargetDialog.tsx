import { useEffect, useMemo, useState } from 'react';
import { openVisual } from '../actions';
import { t } from '../i18n';
import { loadDatabases, metaKey, SERVER_KINDS, useStore, type MetaEntry, type VisualKind } from '../store';

const TITLE: Record<VisualKind, () => string> = {
  er: () => t('Diagramma ER'), query: () => 'Query Builder', table: () => t('Nuova tabella'), compare: () => t('Confronto schema e dati'), maint: () => t('Manutenzione tabelle'),
  datagen: () => t('Generatore di dati di test'), docgen: () => t('Documentazione del database'), perf: () => t('Prestazioni'), procs: () => t('Processi'), monitor: () => t('Monitor sessioni'), users: () => t('Utenti e privilegi'), search: () => t('Cerca nel database'), logs: () => t('Log del server'), copy: () => t('Copia database'), deps: () => t('Dipendenze e rinomina'),
};

/** Which database to open a visual tool on, when none is selected in the explorer or active document. */
export default function TargetDialog({ kind }: { kind: VisualKind }) {
  const all = useStore((s) => s.conns);
  // the visual and server tools are written for MariaDB/MySQL
  const conns = useMemo(() => all.filter((c) => c.engine !== 'mssql'), [all]);
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
  const server = SERVER_KINDS.has(kind);
  const go = () => { close(); openVisual(kind, { connId, db: server ? null : db }); };
  return (
    <div className="modal-back" onMouseDown={close}>
      <form className="modal small" onMouseDown={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); if (connId && (db || server)) go(); }} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div className="modal-title">{TITLE[kind]()}: {server ? t('scegli la connessione') : t('scegli il database')}</div>
        <div className="form">
          {!conns.length ? <div className="status error">{t('Nessuna connessione: creane una dalla toolbar o dall\'Explorer.')}</div> : <>
            <label>{t('Connessione')}
              <select value={connId} onChange={(e) => { setConnId(e.target.value); setDb(''); }}>
                {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
            {!server && <label>{t('Database')}
              <select value={db} autoFocus onChange={(e) => setDb(e.target.value)} disabled={status !== 'open'}>
                <option value="">{status === 'open' ? t('(scegli)') : t('connessione in corso…')}</option>
                {(dbs?.data ?? []).map((d) => <option key={d}>{d}</option>)}
              </select>
            </label>}
            <p className="note">{t('Suggerimento: selezionando un database nell\'Explorer gli editor visuali si aprono direttamente su quello.')}</p>
          </>}
        </div>
        <div className="modal-buttons">
          <div className="spacer" />
          <button type="button" onClick={close}>{t('Annulla')}</button>
          <button type="submit" className="primary" disabled={!connId || (!db && !server)}>{t('Apri')}</button>
        </div>
      </form>
    </div>
  );
}
