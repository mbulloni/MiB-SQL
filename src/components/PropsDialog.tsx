import { useEffect, useState } from 'react';
import { api } from '../api';
import { showDdl } from '../actions';
import { isTds, useStore } from '../store';
import type { ObjectKind } from '../types';
import { t, locale } from '../i18n';

type Prop = { key: string; value: string | number | null };

const LABELS: Record<string, string> = {
  TABLE_TYPE: t('Tipo'),
  TYPE_DESC: t('Tipo'),
  ENGINE: t('Motore'),
  ROW_FORMAT: t('Formato righe'),
  TABLE_ROWS: t('Righe (stima)'),
  AVG_ROW_LENGTH: t('Lunghezza media riga'),
  DATA_LENGTH: t('Dimensione dati'),
  INDEX_LENGTH: t('Dimensione indici'),
  DATA_FREE: t('Spazio libero'),
  AUTO_INCREMENT: t('Prossimo AUTO_INCREMENT'),
  CREATE_TIME: t('Data creazione'),
  CREATED: t('Data creazione'),
  UPDATE_TIME: t('Ultima modifica dei dati'),
  LAST_ALTERED: t('Ultima modifica della definizione'),
  CHECK_TIME: t('Ultimo controllo (CHECK TABLE)'),
  LAST_EXECUTED: t('Ultima esecuzione'),
  TABLE_COLLATION: 'Collation',
  CREATE_OPTIONS: t('Opzioni'),
  TABLE_COMMENT: t('Commento'),
  ROUTINE_COMMENT: t('Commento'),
  EVENT_COMMENT: t('Commento'),
  DEFINER: 'Definer',
  SECURITY_TYPE: 'SQL SECURITY',
  ALGORITHM: 'ALGORITHM',
  CHECK_OPTION: 'CHECK OPTION',
  IS_UPDATABLE: t('Aggiornabile'),
  SQL_DATA_ACCESS: t('Accesso ai dati'),
  IS_DETERMINISTIC: 'DETERMINISTIC',
  DTD_IDENTIFIER: t('Tipo restituito'),
  SQL_MODE: 'SQL mode',
  CHARACTER_SET_CLIENT: t('Charset client'),
  COLLATION_CONNECTION: t('Collation connessione'),
  ACTION_TIMING: t('Momento'),
  EVENT_MANIPULATION: t('Evento'),
  EVENT_OBJECT_TABLE: t('Tabella'),
  ACTION_ORDER: t('Ordine'),
  STATUS: t('Stato'),
  EVENT_TYPE: t('Tipo'),
  EXECUTE_AT: t('Esecuzione alle'),
  INTERVAL_VALUE: t('Intervallo'),
  INTERVAL_FIELD: t('Unità intervallo'),
  STARTS: t('Inizio'),
  ENDS: t('Fine'),
  ON_COMPLETION: t('Al termine'),
};
const DATES = new Set(['CREATE_TIME', 'CREATED', 'UPDATE_TIME', 'LAST_ALTERED', 'CHECK_TIME', 'LAST_EXECUTED', 'EXECUTE_AT', 'STARTS', 'ENDS']);
const BYTES = new Set(['DATA_LENGTH', 'INDEX_LENGTH', 'DATA_FREE', 'AVG_ROW_LENGTH']);

function bytes(n: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString(locale(), { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

/** 'YYYY-MM-DD HH:MM:SS' as the server writes it (its time zone), in the UI's date format. */
function date(s: string) {
  const m = /^(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d):(\d\d)/.exec(s);
  if (!m) return s;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return d.toLocaleString(locale(), { dateStyle: 'full', timeStyle: 'medium' });
}

function shown(p: Prop) {
  if (p.value === null) return '—';
  if (DATES.has(p.key)) return date(String(p.value));
  if (BYTES.has(p.key)) return bytes(Number(p.value));
  if (p.key === 'TABLE_ROWS' || p.key === 'AUTO_INCREMENT') return Number(p.value).toLocaleString(locale());
  return String(p.value);
}

const KIND: Record<ObjectKind, string> = {
  table: t('Tabella'), view: t('Vista'), procedure: t('Procedura'), function: t('Funzione'), trigger: 'Trigger', event: t('Evento'),
};

/** Properties of an Explorer object: creation and change dates, size, definer and options. */
export default function PropsDialog({ connId, db, kind, name }: { connId: string; db: string; kind: ObjectKind; name: string }) {
  const [props, setProps] = useState<Prop[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const close = () => useStore.getState().set({ propsDialog: null });
  useEffect(() => { api.meta.properties(connId, db, kind, name).then(setProps, (err) => setError((err as Error).message)); }, []);

  const get = (k: string) => props?.find((p) => p.key === k);
  const notes: string[] = [];
  if (props && !isTds(connId)) {
    if (kind === 'view') notes.push(t('Il server non registra la data di creazione e di modifica delle viste.'));
    if (kind === 'table' && get('ENGINE')?.value === 'InnoDB') {
      notes.push(t('InnoDB tiene l\'ultima modifica dei dati solo in memoria: dopo un riavvio del server resta vuota finché la tabella non viene modificata. La data di creazione cambia anche con ALTER TABLE che ricostruiscono la tabella.'));
    }
    if (kind === 'trigger' && !get('CREATED')?.value) notes.push(t('Il server registra la data di creazione dei trigger solo da MariaDB 10.2.3 / MySQL 5.7.2.'));
  }
  const text = () => (props ?? []).map((p) => `${LABELS[p.key] ?? p.key}\t${shown(p)}`).join('\n');

  return (
    <div className="modal-back" onMouseDown={close}>
      <div className="modal props" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') close(); }} tabIndex={-1}>
        <div className="modal-title">{t('Proprietà')}{' '}<span className="hint">{KIND[kind]}</span>{' '}<code>{db}.{name}</code></div>
        <div className="form">
          {error && <div className="status error">{error}</div>}
          {!props && !error && <p className="note">{t('Caricamento…')}</p>}
          {props && (
            <table className="props-table">
              <tbody>
                {props.map((p) => (
                  <tr key={p.key} className={DATES.has(p.key) ? 'date' : undefined}>
                    <th>{LABELS[p.key] ?? p.key}</th>
                    <td title={p.value === null ? undefined : String(p.value)}>{shown(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {notes.map((n) => <p key={n} className="note">{n}</p>)}
        </div>
        <div className="modal-buttons">
          <button disabled={!props} onClick={() => navigator.clipboard.writeText(text())}>{t('Copia')}</button>
          <button onClick={() => { close(); showDdl(connId, db, kind, name); }}>{t('Mostra DDL')}</button>
          <div className="spacer" />
          <button className="primary" autoFocus onClick={close}>{t('Chiudi')}</button>
        </div>
      </div>
    </div>
  );
}
