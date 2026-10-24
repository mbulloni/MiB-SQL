import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { selectTop } from '../actions';
import { createSql, newId, type TableDef } from '../design';
import { loadDatabases, metaKey, useStore, type MetaEntry } from '../store';
import type { Cell, Column, ColumnInfo, DbObjects } from '../types';
import ResultGrid from './ResultGrid';

const n = (x: number) => x.toLocaleString('it-IT');
const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);
const close = () => useStore.getState().set({ task: null });

function useProgress(id: string) {
  const [p, setP] = useState<Record<string, number | string>>({});
  useEffect(() => api.tasks.onProgress((x) => { if (x.id === id) setP(x); }), [id]);
  return p;
}

function Modal({ title, busy, children, buttons, wide }: { title: string; busy?: boolean; children: React.ReactNode; buttons: React.ReactNode; wide?: boolean }) {
  return (
    <div className="modal-back" onMouseDown={() => !busy && close()}>
      <div className={`modal ${wide ? 'wizard' : 'small'}`} onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape' && !busy) close(); }}>
        <div className="modal-title">{title}</div>
        <div className="form">{children}</div>
        <div className="modal-buttons">{buttons}</div>
      </div>
    </div>
  );
}

export function BackupDialog({ connId, db }: { connId: string; db: string }) {
  const [id] = useState(() => newId('task'));
  const p = useProgress(id);
  const objects = useStore((s) => s.meta[metaKey.objects(connId, db)]) as MetaEntry<DbObjects> | undefined;
  useEffect(() => { useStore.getState().loadMeta(metaKey.objects(connId, db), () => api.meta.objects(connId, db)); }, []);
  const [o, setO] = useState({ structure: true, data: true, routines: true, dropTables: true, createDatabase: false, stripDefiner: true, gzip: false, batch: 100 });
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [state, setState] = useState<{ busy?: boolean; done?: { file: string; size: number }; error?: string }>({});
  const tables = objects?.data?.tables.map((t) => t.name) ?? [];
  const set = (k: keyof typeof o) => (e: React.ChangeEvent<HTMLInputElement>) => setO({ ...o, [k]: e.target.type === 'number' ? Number(e.target.value) || 1 : e.target.checked });
  const run = async () => {
    setState({ busy: true });
    try {
      const r = await api.tasks.dump(id, connId, db, { ...o, tables: skip.size ? tables.filter((t) => !skip.has(t)) : undefined });
      setState(r ? { done: r } : {});
    } catch (err) { setState({ error: (err as Error).message }); }
  };
  return (
    <Modal title={`Backup di ${db}`} busy={state.busy} buttons={<>
      {state.done && <button onClick={() => api.showItem(state.done!.file)}>Mostra nella cartella</button>}
      <div className="spacer" />
      <button onClick={close} disabled={state.busy}>{state.done ? 'Chiudi' : 'Annulla'}</button>
      {!state.done && <button className="primary" disabled={state.busy || (!o.structure && !o.data)} onClick={run}>Esegui backup…</button>}
    </>}>
      <div className="cols2">
        <label className="check"><input type="checkbox" checked={o.structure} onChange={set('structure')} /> Struttura (CREATE TABLE)</label>
        <label className="check"><input type="checkbox" checked={o.data} onChange={set('data')} /> Dati (INSERT)</label>
        <label className="check"><input type="checkbox" checked={o.routines} disabled={!o.structure} onChange={set('routines')} /> Viste, routine, trigger, eventi</label>
        <label className="check"><input type="checkbox" checked={o.dropTables} disabled={!o.structure} onChange={set('dropTables')} /> DROP prima di CREATE</label>
        <label className="check"><input type="checkbox" checked={o.createDatabase} onChange={set('createDatabase')} /> CREATE DATABASE e USE</label>
        <label className="check"><input type="checkbox" checked={o.stripDefiner} onChange={set('stripDefiner')} /> Rimuovi DEFINER (portabile)</label>
        <label className="check"><input type="checkbox" checked={o.gzip} onChange={set('gzip')} /> Comprimi (.sql.gz)</label>
        <label>Righe per INSERT<input type="number" min={1} value={o.batch} onChange={set('batch')} /></label>
      </div>
      {tables.length > 0 && (
        <details>
          <summary>Tabelle ({tables.length - skip.size} di {tables.length})</summary>
          <div className="table-pick">
            {tables.map((t) => (
              <label key={t} className="check"><input type="checkbox" checked={!skip.has(t)} onChange={(e) => { const s = new Set(skip); if (e.target.checked) s.delete(t); else s.add(t); setSkip(s); }} /> {t}</label>
            ))}
          </div>
        </details>
      )}
      {state.busy && <div className="status">Backup in corso… {p.total ? `tabella ${p.done}/${p.total}${p.table ? ` (${p.table}${p.rows ? `, ${n(Number(p.rows))} righe` : ''})` : ''}` : ''}</div>}
      {state.error && <div className="status error">{state.error}</div>}
      {state.done && <div className="status ok">Backup completato: {state.done.file} ({size(state.done.size)})</div>}
    </Modal>
  );
}

export function RestoreDialog({ connId, db }: { connId: string; db: string | null }) {
  const [id] = useState(() => newId('task'));
  const p = useProgress(id);
  const dbs = useStore((s) => s.meta[metaKey.databases(connId)]) as MetaEntry<string[]> | undefined;
  useEffect(() => { loadDatabases(connId); }, []);
  const [target, setTarget] = useState(db ?? '');
  const [file, setFile] = useState<string | null>(null);
  const [cont, setCont] = useState(false);
  const [state, setState] = useState<{ busy?: boolean; done?: { statements: number; errors: { statement: number; message: string; sql: string }[] }; error?: string }>({});
  const run = async () => {
    if (!file) return;
    if ((await api.confirm(`Eseguire ${file.split('/').pop()}${target ? ` su ${target}` : ''}?`, 'Lo script può creare, modificare o eliminare oggetti e dati. Le istruzioni DDL non si possono annullare.', ['Esegui', 'Annulla'])) !== 0) return;
    setState({ busy: true });
    try {
      const r = await api.tasks.restore(id, connId, target || null, file, { continueOnError: cont });
      setState({ done: r });
    } catch (err) { setState({ error: (err as Error).message }); }
    useStore.getState().dropMeta(`${connId}/`);
  };
  const pct = p.total ? Math.round((Number(p.bytes) / Number(p.total)) * 100) : 0;
  return (
    <Modal title="Ripristina / esegui file SQL" busy={state.busy} buttons={<>
      <div className="spacer" />
      <button onClick={close} disabled={state.busy}>{state.done ? 'Chiudi' : 'Annulla'}</button>
      {!state.done && <button className="primary" disabled={!file || state.busy} onClick={run}>Esegui</button>}
    </>}>
      <label>File (.sql o .sql.gz)
        <div className="row"><input readOnly value={file ?? ''} placeholder="nessun file" className="grow" /><button type="button" onClick={async () => setFile(await api.pickFile('sql'))}>Sfoglia…</button></div>
      </label>
      <label>Database di destinazione
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">(quello indicato nello script)</option>
          {(dbs?.data ?? []).map((d) => <option key={d}>{d}</option>)}
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={cont} onChange={(e) => setCont(e.target.checked)} /> Continua dopo un errore (fino a 1000)</label>
      {state.busy && <><div className="progress"><div style={{ width: `${pct}%` }} /></div><div className="note">{pct}% · {n(Number(p.statements ?? 0))} istruzioni{Number(p.errors) ? ` · ${p.errors} errori` : ''}</div></>}
      {state.error && <div className="status error">{state.error}</div>}
      {state.done && <div className={`status ${state.done.errors.length ? 'error' : 'ok'}`}>Eseguite {n(state.done.statements)} istruzioni{state.done.errors.length ? `, ${state.done.errors.length} errori` : ''}.</div>}
      {!!state.done?.errors.length && <div className="errors">{state.done.errors.slice(0, 20).map((e) => <div key={e.statement}><b>#{e.statement}</b> {e.message}<code>{e.sql.slice(0, 120)}</code></div>)}</div>}
    </Modal>
  );
}

interface Preview { format: string; delimiter?: string; sheets: string[]; columns: string[]; types: string[]; rows: Cell[][]; size: number }

export function ImportWizard({ connId, db, table }: { connId: string; db: string; table?: string }) {
  const [id] = useState(() => newId('task'));
  const p = useProgress(id);
  const objects = useStore((s) => s.meta[metaKey.objects(connId, db)]) as MetaEntry<DbObjects> | undefined;
  useEffect(() => { useStore.getState().loadMeta(metaKey.objects(connId, db), () => api.meta.objects(connId, db)); }, []);
  const [step, setStep] = useState(1);
  const [file, setFile] = useState<string | null>(null);
  const [opts, setOpts] = useState({ delimiter: '', encoding: 'utf8', header: true, sheet: 0, decimalComma: false, dmy: false, nulls: '' });
  const [pv, setPv] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'new' | 'existing'>(table ? 'existing' : 'new');
  const [name, setName] = useState('');
  const [existing, setExisting] = useState(table ?? '');
  const [addId, setAddId] = useState(true);
  const [map, setMap] = useState<{ target: string; type: string }[]>([]);
  const [insertMode, setInsertMode] = useState<'insert' | 'ignore' | 'replace'>('insert');
  const [truncate, setTruncate] = useState(false);
  const [state, setState] = useState<{ busy?: boolean; done?: number; error?: string }>({});
  const targetCols = useStore((s) => (existing ? s.meta[metaKey.columns(connId, db, existing)] : undefined)) as MetaEntry<ColumnInfo[]> | undefined;

  const readOpts = () => ({
    delimiter: opts.delimiter || undefined, encoding: opts.encoding, header: opts.header, sheet: opts.sheet,
    decimalComma: opts.decimalComma, dmy: opts.dmy, nullValues: ['', ...opts.nulls.split(',').map((x) => x.trim()).filter(Boolean)],
  });
  const load = async (f = file) => {
    if (!f) return;
    setError(null);
    try {
      const r = await api.tasks.importPreview(f, readOpts());
      setPv(r);
      if (!opts.delimiter && r.delimiter) setOpts((o) => ({ ...o, delimiter: r.delimiter! }));
      setMap(r.columns.map((c, i) => ({ target: c, type: r.types[i] })));
      if (!name) setName(f.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/[^\w]+/g, '_').toLowerCase().slice(0, 60));
    } catch (err) { setError((err as Error).message); setPv(null); }
  };
  useEffect(() => { if (file) load(); }, [opts.delimiter, opts.encoding, opts.header, opts.sheet, opts.decimalComma, opts.dmy]);

  // existing table: map by name (case-insensitive), the rest ignored
  useEffect(() => {
    if (mode !== 'existing' || !existing || !pv) return;
    useStore.getState().loadMeta(metaKey.columns(connId, db, existing), () => api.meta.columns(connId, db, existing)).then((cols) => {
      const names = (cols ?? []).map((c) => c.name);
      setMap(pv.columns.map((c, i) => ({ target: names.find((x) => x.toLowerCase() === c.toLowerCase()) ?? '', type: pv.types[i] })));
    });
  }, [mode, existing, pv]);

  const grid = useMemo(() => pv && {
    columns: pv.columns.map((c, i): Column => ({ name: `${c} · ${pv.types[i]}`, table: '', orgTable: '', orgName: c, db: '', type: /int|dec|double/.test(pv.types[i]) ? 'DECIMAL' : 'VAR_STRING', length: 0, scale: 0, binary: false, notNull: false, autoIncrement: false })),
    rows: pv.rows,
  }, [pv]);

  const newTableDef = (): TableDef => {
    const cols = map.filter((m) => m.target).map((m) => ({ id: newId('c'), orig: null, name: m.target, type: m.type, nullable: true, default: null, autoIncrement: false, onUpdate: '', collation: '', comment: '', generated: null, check: null }));
    const id = addId ? [{ id: 'idcol', orig: null, name: 'id', type: 'int unsigned', nullable: false, default: null, autoIncrement: true, onUpdate: '', collation: '', comment: '', generated: null, check: null }] : [];
    return {
      db, name, engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', comment: '',
      columns: [...id, ...cols], indexes: addId ? [{ id: 'pk', orig: null, name: 'PRIMARY', kind: 'PRIMARY', columns: [{ col: 'idcol', len: null }], comment: '' }] : [], foreignKeys: [], checks: [], partitioning: null,
    };
  };
  const tables = objects?.data?.tables.map((t) => t.name) ?? [];
  const nameTaken = mode === 'new' && tables.includes(name);
  const ready = pv && (mode === 'new' ? name && !nameTaken && map.some((m) => m.target) : existing && map.some((m) => m.target));

  const run = async () => {
    if (!pv || !file) return;
    if (truncate && (await api.confirm(`Svuotare ${existing} prima dell'importazione?`, 'Tutte le righe attuali verranno eliminate.', ['Svuota e importa', 'Annulla'])) !== 0) return;
    setState({ busy: true });
    try {
      const r = await api.tasks.importRun(id, connId, file, {
        ...readOpts(), format: pv.format, delimiter: pv.delimiter, db, table: mode === 'new' ? name : existing,
        createSql: mode === 'new' ? createSql(newTableDef()) : undefined, truncate: mode === 'existing' && truncate, mode: insertMode,
        mapping: map.map((m, i) => ({ source: i, target: m.target })),
      });
      setState({ done: r.rows });
      useStore.getState().dropMeta(`${connId}/${db}/`);
    } catch (err) { setState({ error: (err as Error).message }); }
  };

  const finalTable = mode === 'new' ? name : existing;
  return (
    <Modal wide title={`Importa dati in ${db}`} busy={state.busy} buttons={<>
      {step > 1 && !state.busy && state.done === undefined && <button onClick={() => setStep(step - 1)}>Indietro</button>}
      <div className="spacer" />
      <button onClick={close} disabled={state.busy}>{state.done !== undefined ? 'Chiudi' : 'Annulla'}</button>
      {state.done !== undefined && <button className="primary" onClick={() => { close(); selectTop(connId, db, finalTable); }}>Apri {finalTable}</button>}
      {step === 1 && <button className="primary" disabled={!pv} onClick={() => setStep(2)}>Avanti</button>}
      {step === 2 && state.done === undefined && <button className="primary" disabled={!ready || state.busy} onClick={run}>{state.busy ? 'Importazione…' : 'Importa'}</button>}
    </>}>
      <div className="steps"><span className={step === 1 ? 'on' : ''}>1 · File</span><span className={step === 2 ? 'on' : ''}>2 · Destinazione e colonne</span></div>
      {step === 1 && <>
        <label>File (CSV, Excel, JSON)
          <div className="row"><input readOnly className="grow" value={file ?? ''} placeholder="nessun file" />
            <button type="button" onClick={async () => { const f = await api.pickFile('data'); if (f) { setFile(f); setOpts((o) => ({ ...o, delimiter: '' })); setName(''); load(f); } }}>Sfoglia…</button></div>
        </label>
        {pv && <div className="row wrap">
          {pv.format === 'csv' && <>
            <label>Separatore<select value={opts.delimiter} onChange={(e) => setOpts({ ...opts, delimiter: e.target.value })}>
              <option value=";">;</option><option value=",">,</option><option value={'\t'}>Tab</option><option value="|">|</option>
            </select></label>
            <label>Codifica<select value={opts.encoding} onChange={(e) => setOpts({ ...opts, encoding: e.target.value })}><option value="utf8">UTF-8</option><option value="latin1">Latin-1 (Windows)</option></select></label>
          </>}
          {pv.format === 'xlsx' && pv.sheets.length > 1 && <label>Foglio<select value={opts.sheet} onChange={(e) => setOpts({ ...opts, sheet: Number(e.target.value) })}>{pv.sheets.map((s, i) => <option key={i} value={i}>{s}</option>)}</select></label>}
          <label className="check"><input type="checkbox" checked={opts.header} onChange={(e) => setOpts({ ...opts, header: e.target.checked })} /> Prima riga = intestazioni</label>
          <label className="check"><input type="checkbox" checked={opts.decimalComma} onChange={(e) => setOpts({ ...opts, decimalComma: e.target.checked })} /> Virgola decimale (1.234,56)</label>
          <label className="check"><input type="checkbox" checked={opts.dmy} onChange={(e) => setOpts({ ...opts, dmy: e.target.checked })} /> Date gg/mm/aaaa</label>
          <label>Altri valori NULL<input value={opts.nulls} placeholder="es. NULL, \N, -" onBlur={() => load()} onChange={(e) => setOpts({ ...opts, nulls: e.target.value })} /></label>
        </div>}
        {error && <div className="status error">{error}</div>}
        {grid && <div className="preview-grid"><ResultGrid columns={grid.columns} rows={grid.rows} /></div>}
        {pv && <p className="note">{pv.format.toUpperCase()} · {size(pv.size)} · {pv.columns.length} colonne · anteprima di {pv.rows.length} righe; i tipi sono dedotti dal campione.</p>}
      </>}
      {step === 2 && pv && <>
        <div className="row wrap">
          <label className="check"><input type="radio" checked={mode === 'new'} onChange={() => setMode('new')} /> Nuova tabella</label>
          <label className="check"><input type="radio" checked={mode === 'existing'} onChange={() => setMode('existing')} /> Tabella esistente</label>
          {mode === 'new'
            ? <><label className="grow">Nome<input value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label className="check"><input type="checkbox" checked={addId} onChange={(e) => setAddId(e.target.checked)} /> Aggiungi id AUTO_INCREMENT</label></>
            : <><label className="grow">Tabella<select value={existing} onChange={(e) => setExisting(e.target.value)}><option value="">—</option>{tables.map((t) => <option key={t}>{t}</option>)}</select></label>
              <label>Righe già presenti<select value={insertMode} onChange={(e) => setInsertMode(e.target.value as typeof insertMode)}>
                <option value="insert">Errore se duplicate</option><option value="ignore">Ignora duplicate (INSERT IGNORE)</option><option value="replace">Sostituisci (REPLACE)</option>
              </select></label>
              <label className="check"><input type="checkbox" checked={truncate} onChange={(e) => setTruncate(e.target.checked)} /> Svuota prima</label></>}
        </div>
        {nameTaken && <div className="status error">Esiste già una tabella {name}: scegli «Tabella esistente» o un altro nome.</div>}
        <datalist id="mib-import-types">{['int', 'bigint', 'decimal(12,2)', 'double', 'varchar(255)', 'text', 'date', 'datetime', 'tinyint(1)', 'json'].map((t) => <option key={t} value={t} />)}</datalist>
        <div className="map-wrap">
          <table className="dtable">
            <thead><tr><th>Colonna del file</th><th>Esempio</th><th>{mode === 'new' ? 'Colonna nuova' : 'Colonna di destinazione'}</th>{mode === 'new' && <th>Tipo</th>}</tr></thead>
            <tbody>
              {pv.columns.map((c, i) => (
                <tr key={i}>
                  <td>{c}</td>
                  <td className="muted">{String(pv.rows.find((r) => r[i] !== null && r[i] !== '')?.[i] ?? '').slice(0, 40)}</td>
                  <td>{mode === 'new'
                    ? <input value={map[i]?.target ?? ''} placeholder="(non importare)" onChange={(e) => setMap(map.map((m, j) => (j === i ? { ...m, target: e.target.value } : m)))} />
                    : <select value={map[i]?.target ?? ''} onChange={(e) => setMap(map.map((m, j) => (j === i ? { ...m, target: e.target.value } : m)))}>
                      <option value="">— non importare —</option>{(targetCols?.data ?? []).map((t) => <option key={t.name} value={t.name}>{t.name} ({t.type})</option>)}
                    </select>}</td>
                  {mode === 'new' && <td><input list="mib-import-types" value={map[i]?.type ?? ''} onChange={(e) => setMap(map.map((m, j) => (j === i ? { ...m, type: e.target.value } : m)))} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {state.busy && <div className="status">Importazione… {p.rows ? `${n(Number(p.rows))} righe` : ''}</div>}
        {state.error && <div className="status error">{state.error}</div>}
        {state.done !== undefined && <div className="status ok">Importate {n(state.done)} righe in {finalTable}.</div>}
      </>}
    </Modal>
  );
}
