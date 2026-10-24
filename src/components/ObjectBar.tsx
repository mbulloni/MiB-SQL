import { useEffect, useState } from 'react';
import { api } from '../api';
import { applyObject, dropObject, OBJECT_LABEL, replaceDocText } from '../actions';
import { formatText, markSaved, modelOf } from '../editor';
import { useStore } from '../store';
import type { Doc } from '../types';

const users = new Map<string, Promise<string>>(); // connection -> CURRENT_USER()
const DEFINER = /DEFINER\s*=\s*((?:'(?:[^'\\]|\\.)*'|`(?:[^`]|``)+`|"[^"]*"|[\w$.%-]+)(?:\s*@\s*(?:'(?:[^'\\]|\\.)*'|`(?:[^`]|``)+`|"[^"]*"|[\w$.%-]+))?|CURRENT_USER(?:\s*\(\s*\))?)\s+/i;
const bare = (account: string) => account.replace(/['`"]/g, '').replace(/\s*@\s*/, '@');

/** Above an object editor: what is edited, apply/reload/run/drop, DEFINER and event scheduler warnings. */
export default function ObjectBar({ doc }: { doc: Doc }) {
  const obj = doc.obj!;
  const connOpen = useStore((s) => !!doc.connId && s.connState[doc.connId]?.status === 'open');
  const [definer, setDefiner] = useState<string | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [scheduler, setScheduler] = useState<string | null>(null);

  useEffect(() => {
    const model = modelOf(doc.id);
    const read = () => { const m = DEFINER.exec(model.getValue()); setDefiner(m ? m[1] : null); };
    read();
    let t: number | undefined;
    const sub = model.onDidChangeContent(() => { clearTimeout(t); t = window.setTimeout(read, 300); });
    return () => { sub.dispose(); clearTimeout(t); };
  }, [doc.id]);
  useEffect(() => {
    if (!doc.connId || !connOpen) return;
    if (!users.has(doc.connId)) users.set(doc.connId, api.objects.currentUser(doc.connId));
    users.get(doc.connId)!.then(setMe).catch(() => users.delete(doc.connId!));
    if (obj.kind === 'event') api.data.select(doc.connId, 'SELECT @@event_scheduler', []).then((r) => setScheduler(String(r[0]?.[0] ?? ''))).catch(() => {});
  }, [doc.connId, connOpen, obj.kind]);

  const foreign = definer && me && !/^CURRENT_USER/i.test(definer) && bare(definer) !== me;
  const removeDefiner = () => {
    const text = modelOf(doc.id).getValue();
    replaceDocText(doc.id, text.replace(DEFINER, ''));
  };
  const reload = async () => {
    if (!doc.connId || !doc.db || !obj.name) return;
    if (doc.dirty && (await api.confirm(`Ricaricare ${obj.name} dal server?`, 'Le modifiche non applicate andranno perse.', ['Ricarica', 'Annulla'])) !== 0) return;
    try {
      let sql = await api.meta.ddl(doc.connId, doc.db, obj.kind, obj.name);
      if (obj.kind === 'view') sql = formatText(sql);
      modelOf(doc.id).setValue(sql);
      markSaved(doc.id);
      useStore.getState().updateDoc(doc.id, { dirty: false });
    } catch (err) { await api.confirm('Ricarica non riuscita', (err as Error).message, ['OK']); }
  };
  const routine = obj.kind === 'procedure' || obj.kind === 'function';

  return (
    <div className="obj-bar">
      <span className="obj-kind">{OBJECT_LABEL[obj.kind]}</span>
      <b>{obj.name ?? '(nuova definizione)'}</b>
      <span className="muted">{doc.db}</span>
      <button className="primary" disabled={doc.running || !doc.connId || !doc.db} onClick={() => applyObject(doc.id)}
        title={obj.name ? 'Applica la definizione al server (F5 o Ctrl+S): CREATE OR REPLACE, oppure DROP + CREATE dove non esiste' : 'Crea l\'oggetto sul server (F5 o Ctrl+S)'}>
        {obj.name ? 'Applica' : 'Crea'}
      </button>
      {obj.name && <button disabled={doc.running} onClick={reload} title="Rileggi la definizione dal server">Ricarica</button>}
      {obj.name && routine && <button onClick={() => useStore.getState().set({ callDialog: { connId: doc.connId!, db: doc.db!, kind: obj.kind as 'procedure' | 'function', name: obj.name! } })}>Esegui…</button>}
      {obj.name && <button className="danger" onClick={() => dropObject(doc.connId!, doc.db!, obj.kind, obj.name!)}>Elimina…</button>}
      {foreign && (
        <span className="obj-warn" title="Creare un oggetto con il DEFINER di un altro account richiede il privilegio SET USER (MariaDB) o SET_USER_ID/SUPER (MySQL)">
          DEFINER {bare(definer!)} diverso dal tuo utente ({me}) <button onClick={removeDefiner}>Usa il mio utente</button>
        </span>
      )}
      {obj.kind === 'event' && scheduler && scheduler !== 'ON' && <span className="obj-warn" title="SET GLOBAL event_scheduler = ON (richiede privilegi) o event_scheduler=ON nella configurazione del server">Lo scheduler degli eventi è {scheduler}: gli eventi non partono</span>}
    </div>
  );
}
