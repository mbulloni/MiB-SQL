import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { newDoc, persist } from '../actions';
import { compareSchemas, lineDiff, scriptText, syncStatements, type CompareItem, type Snapshot, type Status } from '../compare';
import { inline } from '../edits';
import { loadDatabases, metaKey, useStore, type MetaEntry } from '../store';
import type { ApplyStmt, Cell, Column, Doc } from '../types';
import ResultGrid, { type GridEditing } from './ResultGrid';
import Icon from './Icon';

type Side = { connId: string | null; db: string | null };
interface DataResult {
  table: string; equal: number; diff: number; source: number; target: number;
  details: { status: 'diff' | 'source' | 'target'; row: Cell[]; old?: Cell[]; diff: number[] }[];
  statements: ApplyStmt[]; scriptTooLarge: boolean; columns: string[];
}

const SPATIAL = /^(geometry|point|linestring|polygon|multi\w+|geometrycollection|geomcollection)\b/i;
const STATUS: Record<Status, string> = { equal: 'Uguale', diff: 'Diverso', source: 'Solo in origine', target: 'Solo in destinazione' };
const KIND_ICON: Record<string, string> = { table: 'table', view: 'view', procedure: 'procedure', function: 'function', trigger: 'trigger', event: 'event' };

function SidePicker({ label, side, onChange }: { label: string; side: Side; onChange: (s: Side) => void }) {
  const conns = useStore((s) => s.conns);
  const open = useStore((s) => (side.connId ? s.connState[side.connId]?.status === 'open' : false));
  const dbs = useStore((s) => (side.connId ? s.meta[metaKey.databases(side.connId)] : undefined)) as MetaEntry<string[]> | undefined;
  useEffect(() => {
    if (!side.connId) return;
    if (!open) useStore.getState().openConn(side.connId);
    else loadDatabases(side.connId);
  }, [side.connId, open]);
  return (
    <div className="cmp-side">
      <span className="lbl">{label}</span>
      <select value={side.connId ?? ''} onChange={(e) => onChange({ connId: e.target.value || null, db: null })}>
        <option value="">(connessione)</option>
        {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value={side.db ?? ''} disabled={!side.connId} onChange={(e) => onChange({ ...side, db: e.target.value || null })}>
        <option value="">(database)</option>
        {side.db && !(dbs?.data ?? []).includes(side.db) && <option>{side.db}</option>}
        {(dbs?.data ?? []).map((d) => <option key={d}>{d}</option>)}
      </select>
    </div>
  );
}

export default function CompareView({ doc }: { doc: Doc }) {
  const cmp = doc.cmp ?? { src: { connId: doc.connId, db: doc.db }, tgt: { connId: doc.connId, db: null } };
  const setSides = (next: { src: Side; tgt: Side }) => { useStore.getState().updateDoc(doc.id, { cmp: next }); persist(); };
  const [tab, setTab] = useState<'schema' | 'data'>('schema');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snap, setSnap] = useState<{ src: Snapshot; tgt: Snapshot } | null>(null);
  const [items, setItems] = useState<CompareItem[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [show, setShow] = useState<Record<Status, boolean>>({ diff: true, source: true, target: true, equal: false });
  const [data, setData] = useState<Record<string, DataResult | { error: string } | 'running'>>({});
  const [dataPicked, setDataPicked] = useState<Set<string>>(new Set());
  const [dataSel, setDataSel] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, number>>({});
  useEffect(() => api.tasks.onProgress((p) => {
    if (typeof p.id === 'string' && p.id.startsWith('compare:')) setProgress((x) => ({ ...x, [String(p.table)]: Number(p.rows) }));
  }), []);
  const conns = useStore((s) => s.conns);
  const ready = !!(cmp.src.connId && cmp.src.db && cmp.tgt.connId && cmp.tgt.db);
  const sameDb = cmp.src.connId === cmp.tgt.connId && cmp.src.db === cmp.tgt.db;
  const tgtName = `${conns.find((c) => c.id === cmp.tgt.connId)?.name ?? '?'} / ${cmp.tgt.db}`;
  const key = (i: { kind: string; name: string }) => `${i.kind}/${i.name}`;

  const compare = async () => {
    if (!ready) return;
    setBusy('Lettura degli schemi…');
    setError(null);
    try {
      const [src, tgt] = await Promise.all([
        api.meta.schemaSnapshot(cmp.src.connId!, cmp.src.db!),
        api.meta.schemaSnapshot(cmp.tgt.connId!, cmp.tgt.db!),
      ]);
      const res = compareSchemas(src, tgt, cmp.src.db!, cmp.tgt.db!);
      setSnap({ src, tgt });
      setItems(res);
      // drops are opt-in: only what the source has is selected by default
      setPicked(new Set(res.filter((i) => i.status === 'diff' || i.status === 'source').filter((i) => i.sync.length).map(key)));
      setSel(res.find((i) => i.status !== 'equal') ? key(res.find((i) => i.status !== 'equal')!) : null);
      setData({});
      setDataPicked(new Set());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const chosen = items.filter((i) => picked.has(key(i)));
  const script = useMemo(() => syncStatements(chosen, cmp.tgt.db ?? ''), [chosen, cmp.tgt.db]);
  const current = items.find((i) => key(i) === sel);
  const diff = useMemo(() => (current ? lineDiff(current.targetDdl, current.sourceDdl) : []), [current]);

  const syncSchema = async () => {
    if (!script.length) return;
    const drops = chosen.filter((i) => i.status === 'target').length;
    const ok = await api.confirm(`Modificare la struttura di ${tgtName}?`,
      `${script.length - 1} istruzioni DDL${drops ? `, ${drops} oggetti eliminati (i dati delle tabelle eliminate vanno persi)` : ''}. Le istruzioni DDL non sono transazionali.`, ['Sincronizza', 'Annulla']);
    if (ok !== 0) return;
    setBusy('Sincronizzazione dello schema…');
    try {
      await api.ddl.run(cmp.tgt.connId!, script);
      useStore.getState().dropMeta(`${cmp.tgt.connId}/${cmp.tgt.db}/`);
      setBusy(null);
      await compare();
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  // data compare: tables in both databases with the same primary key
  const dataTables = useMemo(() => {
    if (!snap) return [];
    return Object.keys(snap.src.tables).filter((t) => snap.tgt.tables[t]).sort().map((t) => {
      const s = snap.src.tables[t];
      const d = snap.tgt.tables[t];
      const pk = (x: typeof s) => x.indexes.find((i) => i.kind === 'PRIMARY')?.columns.map((c) => c.name) ?? [];
      // spatial columns arrive as GeoJSON: not comparable/syncable as values, left out
      const columns = s.columns.filter((c) => !c.generated && !SPATIAL.test(c.type) && d.columns.some((x) => x.name === c.name && !x.generated)).map((c) => c.name);
      const key = pk(s);
      const reason = !key.length ? 'senza chiave primaria' : JSON.stringify(key) !== JSON.stringify(pk(d)) ? 'chiave primaria diversa' : '';
      return { table: t, key, columns, reason };
    });
  }, [snap]);

  const compareData = async (tables: string[]) => {
    for (const t of tables) {
      const info = dataTables.find((x) => x.table === t)!;
      setData((d) => ({ ...d, [t]: 'running' }));
      try {
        const r = await api.compareData({ connId: cmp.src.connId!, db: cmp.src.db! }, { connId: cmp.tgt.connId!, db: cmp.tgt.db! }, t, info.key, info.columns);
        setData((d) => ({ ...d, [t]: { ...r, columns: info.columns } }));
        if (r.statements.length) setDataPicked((p) => new Set([...p, t]));
      } catch (err) {
        setData((d) => ({ ...d, [t]: { error: (err as Error).message } }));
      }
    }
  };

  const dataStmts = [...dataPicked].flatMap((t) => { const r = data[t]; return r && typeof r === 'object' && 'statements' in r ? r.statements : []; });
  const syncData = async () => {
    if (!dataStmts.length) return;
    if ((await api.confirm(`Modificare i dati di ${tgtName}?`, `${dataStmts.length.toLocaleString('it-IT')} istruzioni INSERT/UPDATE/DELETE in un'unica transazione.`, ['Sincronizza', 'Annulla'])) !== 0) return;
    setBusy('Sincronizzazione dei dati…');
    try {
      await api.data.apply(cmp.tgt.connId!, dataStmts);
      const tables = [...dataPicked];
      setDataPicked(new Set());
      setBusy(null);
      await compareData(tables);
    } catch (err) {
      setError((err as Error).message);
      setBusy(null);
    }
  };

  const openScript = (text: string, title: string) => newDoc({ connId: cmp.tgt.connId, db: cmp.tgt.db, sql: text, title });

  const detail = dataSel ? data[dataSel] : undefined;
  const detailGrid = useMemo(() => {
    if (!detail || typeof detail !== 'object' || !('details' in detail)) return null;
    const columns: Column[] = detail.columns.map((n) => ({ name: n, table: '', orgTable: '', orgName: n, db: '', type: 'VAR_STRING', length: 0, scale: 0, binary: false, notNull: false, autoIncrement: false }));
    const rows: Cell[][] = [];
    const states: ('new' | 'deleted' | undefined)[] = [];
    const edited = new Set<string>();
    for (const d of detail.details) {
      rows.push(d.row);
      states.push(d.status === 'source' ? 'new' : d.status === 'target' ? 'deleted' : undefined);
      d.diff.forEach((c) => edited.add(`${rows.length - 1}/${c}`));
    }
    const editing: GridEditing = { canEdit: () => false, edited: (r, c) => edited.has(`${r}/${c}`), state: (r) => states[r], onEdit: () => {}, onDeleteRows: () => {} };
    return { columns, rows, editing };
  }, [detail]);

  const counts = (s: Status) => items.filter((i) => i.status === s).length;
  const visible = items.filter((i) => show[i.status]);

  return (
    <div className="cmp">
      <div className="er-bar cmp-bar">
        <SidePicker label="Origine" side={cmp.src} onChange={(s) => setSides({ ...cmp, src: s })} />
        <button title="Inverti origine e destinazione" onClick={() => setSides({ src: cmp.tgt, tgt: cmp.src })}>⇄</button>
        <SidePicker label="Destinazione" side={cmp.tgt} onChange={(s) => setSides({ ...cmp, tgt: s })} />
        <button className="primary" disabled={!ready || sameDb || !!busy} onClick={compare}>Confronta</button>
        <div className="spacer" />
        {busy ? <span className="muted">{busy}</span> : sameDb && ready ? <span className="muted">Origine e destinazione coincidono</span> : null}
      </div>
      {error && <div className="status error cmp-error">{error}<button onClick={() => setError(null)}>×</button></div>}
      <div className="tabs-row">
        <button className={tab === 'schema' ? 'active' : ''} onClick={() => setTab('schema')}>Schema</button>
        <button className={tab === 'data' ? 'active' : ''} onClick={() => setTab('data')} disabled={!snap}>Dati</button>
      </div>

      {!snap && <div className="empty">Scegli origine e destinazione, poi «Confronta». Lo script rende la destinazione uguale all'origine.</div>}

      {snap && tab === 'schema' && <>
        <div className="cmp-body">
          <div className="cmp-list">
            <div className="cmp-filters">
              {(['diff', 'source', 'target', 'equal'] as Status[]).map((s) => (
                <label key={s} className={`check st-${s}`}><input type="checkbox" checked={show[s]} onChange={(e) => setShow({ ...show, [s]: e.target.checked })} /> {STATUS[s]} ({counts(s)})</label>
              ))}
            </div>
            {visible.map((i) => (
              <div key={key(i)} className={`cmp-item${sel === key(i) ? ' sel' : ''}`} onMouseDown={() => setSel(key(i))}>
                <input type="checkbox" disabled={!i.sync.length} checked={picked.has(key(i))}
                  onChange={(e) => { const p = new Set(picked); if (e.target.checked) p.add(key(i)); else p.delete(key(i)); setPicked(p); }} />
                <Icon name={KIND_ICON[i.kind]} />
                <span className="name">{i.name}</span>
                <span className={`badge st-${i.status}`}>{STATUS[i.status]}</span>
              </div>
            ))}
            {!visible.length && <div className="empty">Nessun oggetto con i filtri scelti.</div>}
          </div>
          <div className="cmp-diff">
            {current ? <>
              <div className="cmp-diff-head"><span className="del">− {tgtName}</span><span className="add">+ origine</span>{current.note && <span className="warn">{current.note}</span>}</div>
              <pre>{diff.map((l, n) => <div key={n} className={`dl ${l.type}`}>{l.type === 'add' ? '+ ' : l.type === 'del' ? '− ' : '  '}{l.text}</div>)}</pre>
              {current.sync.length > 0 && <><div className="cmp-diff-head">Istruzioni per la destinazione</div><pre className="sync">{scriptText(current.sync)}</pre></>}
            </> : <div className="empty">Seleziona un oggetto.</div>}
          </div>
        </div>
        <div className="designer-foot">
          <span className="muted">{chosen.length} oggetti selezionati · {Math.max(0, script.length - 1)} istruzioni</span>
          <div className="spacer" />
          <button disabled={!script.length} onClick={() => openScript(scriptText(script), `sync-${cmp.tgt.db}.sql`)}>Apri script nell'editor</button>
          <button className="primary" disabled={!script.length || !!busy} onClick={syncSchema}>Sincronizza destinazione</button>
        </div>
      </>}

      {snap && tab === 'data' && <>
        <div className="cmp-body">
          <div className="cmp-list data">
            <div className="cmp-filters">
              <button disabled={!!busy} onClick={() => compareData(dataTables.filter((t) => !t.reason).map((t) => t.table))}>Confronta tutte</button>
            </div>
            <table className="dtable">
              <thead><tr><th /><th>Tabella</th><th title="Uguali">=</th><th title="Diverse">≠</th><th title="Solo in origine">+</th><th title="Solo in destinazione">−</th></tr></thead>
              <tbody>
                {dataTables.map((t) => {
                  const r = data[t.table];
                  const done = r && typeof r === 'object' && 'statements' in r ? r : null;
                  return (
                    <tr key={t.table} className={dataSel === t.table ? 'sel' : ''} onMouseDown={() => setDataSel(t.table)}>
                      <td className="c"><input type="checkbox" disabled={!done?.statements.length} checked={dataPicked.has(t.table)}
                        onChange={(e) => { const p = new Set(dataPicked); if (e.target.checked) p.add(t.table); else p.delete(t.table); setDataPicked(p); }} /></td>
                      <td>{t.table}{t.reason && <span className="muted"> · {t.reason}</span>}</td>
                      {r === 'running' ? <td colSpan={4} className="muted">confronto… {progress[t.table] ? `${progress[t.table].toLocaleString('it-IT')} righe` : ''}</td>
                        : r && 'error' in r ? <td colSpan={4} className="err" title={r.error}>errore</td>
                          : done ? <><td>{done.equal}</td><td className={done.diff ? 'st-diff' : ''}>{done.diff}</td><td className={done.source ? 'st-source' : ''}>{done.source}</td><td className={done.target ? 'st-target' : ''}>{done.target}</td></>
                            : <td colSpan={4}>{!t.reason && <button className="mini" onClick={() => compareData([t.table])}>Confronta</button>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="cmp-diff">
            {detail && typeof detail === 'object' && 'error' in detail && <div className="status error">{detail.error}</div>}
            {detailGrid ? <>
              <div className="cmp-diff-head">
                <span className="add">verde: solo in origine</span><span className="del">rosso: solo in destinazione</span><span className="warn">giallo: valori diversi (dell'origine)</span>
                {detailGrid.rows.length === 1000 && <span className="muted">prime 1000 differenze</span>}
                {(detail as DataResult).scriptTooLarge && <span className="warn">troppe differenze per uno script</span>}
              </div>
              {detailGrid.rows.length ? <ResultGrid columns={detailGrid.columns} rows={detailGrid.rows} editing={detailGrid.editing} /> : <div className="empty">Dati identici.</div>}
            </> : !detail && <div className="empty">Confronta una tabella e selezionala per vedere le differenze.</div>}
          </div>
        </div>
        <div className="designer-foot">
          <span className="muted">{dataPicked.size} tabelle · {dataStmts.length.toLocaleString('it-IT')} istruzioni</span>
          <div className="spacer" />
          <button disabled={!dataStmts.length} onClick={() => openScript(`START TRANSACTION;\n${dataStmts.map((s) => inline(s) + ';').join('\n')}\nCOMMIT;\n`, `sync-dati-${cmp.tgt.db}.sql`)}>Apri script nell'editor</button>
          <button className="primary" disabled={!dataStmts.length || !!busy} onClick={syncData}>Sincronizza dati</button>
        </div>
      </>}
    </div>
  );
}
