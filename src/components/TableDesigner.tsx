import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { newDoc, persist } from '../actions';
import {
  alterSql, byList, createSql, FK_RULES, fromServer, isTextType, newId, newTable, PARTITION_METHODS, removeColumn, togglePrimary, validate,
  type DColumn, type DForeignKey, type DIndex, type IndexKind, type PartitionMethod, type Partitioning, type TableDef,
} from '../design';
import { designByDoc, loadDatabases, metaKey, useStore, type MetaEntry } from '../store';
import type { ColumnInfo, DbObjects, Doc, IndexInfo, ServerOptions } from '../types';
import Icon from './Icon';
import { t, locale } from '../i18n';


const TYPES = ['int', 'int unsigned', 'bigint', 'bigint unsigned', 'tinyint(1)', 'smallint', 'mediumint', 'decimal(10,2)', 'double', 'float',
  'varchar(255)', 'char(10)', 'text', 'mediumtext', 'longtext', 'json', 'date', 'datetime', 'datetime(3)', 'timestamp', 'time', 'year',
  'blob', 'longblob', 'varbinary(255)', t('enum(\'a\',\'b\')'), t('set(\'a\',\'b\')'), 'boolean', 'uuid', 'inet6', 'geometry', 'point'];
const KINDS: IndexKind[] = ['PRIMARY', 'UNIQUE', 'INDEX', 'FULLTEXT', 'SPATIAL'];

type Tab = 'columns' | 'indexes' | 'fks' | 'checks' | 'partitions' | 'script';

/** Ordered column picker used by indexes and foreign keys: chips with removal, a select to add. */
function ColumnChips({ value, options, onChange, lengths }: {
  value: { key: string; label: string; len?: number | null; desc?: boolean }[];
  options: { key: string; label: string }[];
  onChange: (keys: { key: string; len?: number | null; desc?: boolean }[]) => void;
  lengths?: boolean;
}) {
  const keep = (x: { key: string; len?: number | null; desc?: boolean }) => ({ key: x.key, len: x.len, desc: x.desc });
  const free = options.filter((o) => !value.some((v) => v.key === o.key));
  return (
    <div className="chips">
      {value.map((v, i) => (
        <span key={v.key} className="chip">
          {v.label}
          {lengths && <input className="len" type="number" min={1} placeholder="lung." title={t('Lunghezza del prefisso')} value={v.len ?? ''}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...keep(x), len: e.target.value ? Number(e.target.value) : null } : keep(x))))} />}
          {lengths && <button title={v.desc ? t('Decrescente (DESC): clic per crescente') : t('Crescente: clic per DESC')} onClick={() => onChange(value.map((x, j) => (j === i ? { ...keep(x), desc: !x.desc } : keep(x))))}>{v.desc ? '↓' : '↑'}</button>}
          <button onClick={() => onChange(value.filter((_, j) => j !== i).map(keep))}>×</button>
        </span>
      ))}
      {free.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onChange([...value.map(keep), { key: e.target.value, len: null }])}>
          <option value="">{t('+ colonna')}</option>
          {free.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
      )}
    </div>
  );
}

export default function TableDesigner({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const db = doc.db!;
  const existing = doc.design?.table ?? null;
  const [state, setStateRaw] = useState(() => designByDoc.get(doc.id) ?? null);
  const [tab, setTab] = useState<Tab>('columns');
  const [sel, setSel] = useState(0);
  const [status, setStatus] = useState<{ ok?: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const optsKey = `${connId}/${db}/serverOptions`;
  const opts = useStore((s) => s.meta[optsKey]) as MetaEntry<ServerOptions> | undefined;
  const objects = useStore((s) => s.meta[metaKey.objects(connId, db)]) as MetaEntry<DbObjects> | undefined;
  const dbs = useStore((s) => s.meta[metaKey.databases(connId)]) as MetaEntry<string[]> | undefined;
  const meta = useStore((s) => s.meta);

  const setState = (next: { orig: TableDef | null; cur: TableDef }) => {
    designByDoc.set(doc.id, next);
    setStateRaw(next);
    const dirty = !next.orig || alterSql(next.orig, next.cur).length > 0;
    if (dirty !== doc.dirty) useStore.getState().updateDoc(doc.id, { dirty });
  };
  const cur = state?.cur;
  const update = (fn: (t: TableDef) => TableDef) => state && setState({ ...state, cur: fn(state.cur) });

  const load = async (table: string | null) => {
    setStatus(null);
    try {
      const o = await useStore.getState().loadMeta(optsKey, () => api.meta.serverOptions(connId, db));
      if (table) {
        const def = fromServer(db, await api.meta.tableDefinition(connId, db, table));
        setState({ orig: def, cur: structuredClone(def) });
      } else {
        setState({ orig: null, cur: newTable(db, o?.defaultEngine ?? 'InnoDB', o?.defaultCollation ?? 'utf8mb4_general_ci') });
      }
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    }
  };

  useEffect(() => {
    if (!connOpen) { useStore.getState().openConn(connId); return; }
    if (!state) load(existing);
    useStore.getState().loadMeta(metaKey.objects(connId, db), () => api.meta.objects(connId, db));
    loadDatabases(connId);
  }, [connOpen]);

  const errors = useMemo(() => (cur ? validate(cur) : []), [cur]);
  const script = useMemo(() => (!state ? [] : state.orig ? alterSql(state.orig, state.cur) : [createSql(state.cur)]), [state]);

  // referenced tables' columns for the foreign key pickers
  useEffect(() => {
    for (const fk of cur?.foreignKeys ?? []) {
      if (fk.refTable) useStore.getState().loadMeta(metaKey.columns(connId, fk.refDb || db, fk.refTable), () => api.meta.columns(connId, fk.refDb || db, fk.refTable));
    }
  }, [cur?.foreignKeys.length]);

  const collations = opts?.data?.collations;
  const byCharset = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const c of collations ?? []) m.set(c.charset, [...(m.get(c.charset) ?? []), c.name]);
    return [...m];
  }, [collations]);

  if (!cur) {
    return <div className="designer"><div className="empty">{status?.text ?? (connOpen ? t('Caricamento della struttura…') : t('Connessione in corso…'))}</div></div>;
  }

  const col = cur.columns[Math.min(sel, cur.columns.length - 1)];
  const pk = cur.indexes.find((ix) => ix.kind === 'PRIMARY');
  const setCol = (id: string, patch: Partial<DColumn>) => update((t) => ({ ...t, columns: t.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  const setIx = (id: string, patch: Partial<DIndex>) => update((t) => ({ ...t, indexes: t.indexes.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const setFk = (id: string, patch: Partial<DForeignKey>) => update((t) => ({ ...t, foreignKeys: t.foreignKeys.map((x) => (x.id === id ? { ...x, ...patch } : x)) }));
  const move = (i: number, d: number) => {
    update((t) => {
      const columns = [...t.columns];
      const [c] = columns.splice(i, 1);
      columns.splice(i + d, 0, c);
      return { ...t, columns };
    });
    setSel(i + d);
  };
  const addColumn = () => {
    const at = Math.min(sel + 1, cur.columns.length);
    update((t) => {
      const columns = [...t.columns];
      let n = columns.length + 1;
      while (columns.some((c) => c.name === `colonna${n}`)) n++;
      columns.splice(at, 0, { id: newId('c'), orig: null, name: `colonna${n}`, type: 'varchar(255)', nullable: true, default: null, autoIncrement: false, onUpdate: '', collation: '', comment: '', generated: null, check: null });
      return { ...t, columns };
    });
    setSel(at);
  };
  const colOptions = cur.columns.map((c) => ({ key: c.id, label: c.name || '?' }));
  const colLabel = (id: string) => cur.columns.find((c) => c.id === id)?.name ?? t('(eliminata)');

  // referenced table: its columns and primary key come from the explorer cache
  const refColumns = (fk: DForeignKey) => {
    const key = metaKey.columns(connId, fk.refDb || db, fk.refTable);
    return (meta[key] as MetaEntry<ColumnInfo[]> | undefined)?.data;
  };
  const chooseRefTable = async (fk: DForeignKey, refDb: string, refTable: string) => {
    setFk(fk.id, { refDb, refTable, refColumns: [] });
    if (!refTable) return;
    const L = useStore.getState().loadMeta;
    await L(metaKey.columns(connId, refDb, refTable), () => api.meta.columns(connId, refDb, refTable));
    const ix = await L(metaKey.indexes(connId, refDb, refTable), () => api.meta.indexes(connId, refDb, refTable)) as IndexInfo[] | undefined;
    const refPk = ix?.find((i) => i.primary)?.columns ?? [];
    if (refPk.length === fk.columns.length || !fk.columns.length) setFk(fk.id, { refDb, refTable, refColumns: refPk.slice(0, Math.max(fk.columns.length, refPk.length)) });
  };

  const collationSelect = (value: string, onChange: (v: string) => void, inherit?: string) => (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {inherit !== undefined && <option value="">{inherit}</option>}
      {value && !(collations ?? []).some((c) => c.name === value) && <option value={value}>{value}</option>}
      {byCharset.map(([cs, names]) => <optgroup key={cs} label={cs}>{names.map((n) => <option key={n} value={n}>{n}</option>)}</optgroup>)}
    </select>
  );

  const apply = async () => {
    if (!script.length || errors.length) return;
    const text = script.join('\n');
    const drops = text.match(/DROP COLUMN `(?:[^`]|``)+`/g) ?? [];
    const dropParts = /DROP PARTITION (.+)/.exec(text)?.[1];
    const rewrite = /PARTITION BY|REORGANIZE PARTITION|REMOVE PARTITIONING/.test(text);
    if (drops.length || (state!.orig && cur.convert) || dropParts || (state!.orig && rewrite)) {
      const what = [
        drops.length ? t('Colonne eliminate: {0} (i dati vanno persi).', drops.map((d) => d.slice(12)).join(', ')) : '',
        cur.convert ? t('Conversione dei dati testuali esistenti alla nuova collation.') : '',
        dropParts ? t('Partizioni eliminate: {0} (le righe che contengono vanno perse).', dropParts) : '',
        rewrite ? t('Le righe vengono ridistribuite tra le partizioni: su tabelle grandi può richiedere tempo.') : '',
      ].filter(Boolean).join('\n');
      if ((await api.confirm(`Applicare le modifiche a ${state!.orig!.name}?`, what, ['Applica', 'Annulla'])) !== 0) return;
    }
    setBusy(true);
    setStatus(null);
    try {
      await api.ddl.run(connId, script);
      useStore.getState().dropMeta(`${connId}/${db}/`);
      useStore.getState().updateDoc(doc.id, { title: cur.name, design: { table: cur.name }, dirty: false });
      designByDoc.delete(doc.id);
      await load(cur.name);
      setStatus({ ok: true, text: state!.orig ? t('Tabella {0} modificata.', cur.name) : t('Tabella {0} creata.', cur.name) });
      persist();
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
      // a failed ALTER may have half-applied (DDL is not transactional): the server's state wins on reload
    } finally {
      setBusy(false);
    }
  };

  const tables = objects?.data?.tables.map((t) => t.name) ?? [];
  const tabLabel: Record<Tab, string> = { columns: t('Colonne ({0})', cur.columns.length), indexes: t('Indici ({0})', cur.indexes.length), fks: t('Chiavi esterne ({0})', cur.foreignKeys.length), checks: t('Vincoli CHECK ({0})', cur.checks.length), partitions: cur.partitioning ? t('Partizioni ({0})', byList(cur.partitioning.method) ? cur.partitioning.partitions.length : cur.partitioning.count) : t('Partizioni'), script: t('Script') };

  return (
    <div className="designer">
      <div className="designer-head form">
        <div className="row">
          <label className="grow">{t('Nome tabella')}<input value={cur.name} onChange={(e) => update((t) => ({ ...t, name: e.target.value }))} /></label>
          <label>{t('Engine')}
            <select value={cur.engine} onChange={(e) => update((t) => ({ ...t, engine: e.target.value }))}>
              {!(opts?.data?.engines ?? []).includes(cur.engine) && <option>{cur.engine}</option>}
              {(opts?.data?.engines ?? []).map((e) => <option key={e}>{e}</option>)}
            </select>
          </label>
          <label>{t('Collation')}{collationSelect(cur.collation, (v) => update((t) => ({ ...t, collation: v })))}</label>
          <label className="grow">{t('Commento')}<input value={cur.comment} onChange={(e) => update((t) => ({ ...t, comment: e.target.value }))} /></label>
        </div>
        {state!.orig && cur.collation !== state!.orig.collation && (
          <label className="check"><input type="checkbox" checked={!!cur.convert} onChange={(e) => update((t) => ({ ...t, convert: e.target.checked }))} />
            {t('Converti anche le colonne esistenti (CONVERT TO): senza, cambia solo il predefinito per le nuove colonne')}</label>
        )}
      </div>
      <div className="tabs-row">
        {(Object.keys(tabLabel) as Tab[]).map((t) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{tabLabel[t]}</button>)}
      </div>

      <div className="designer-body">
        {tab === 'columns' && <>
          <div className="dtable-wrap">
            <table className="dtable">
              <thead><tr><th>#</th><th>{t('Nome')}</th><th>{t('Tipo')}</th><th title={t('Chiave primaria')}>PK</th><th title="NOT NULL">{t('Not null')}</th><th title="AUTO_INCREMENT">AI</th><th>{t('Predefinito')}</th><th>{t('Commento')}</th><th /></tr></thead>
              <tbody>
                {cur.columns.map((c, i) => (
                  <tr key={c.id} className={`${col?.id === c.id ? 'sel' : ''}${c.orig === null ? ' new' : ''}`} onMouseDown={() => setSel(i)}>
                    <td className="n">{pk?.columns.some((x) => x.col === c.id) ? <Icon name="key" /> : i + 1}</td>
                    <td><input value={c.name} onChange={(e) => setCol(c.id, { name: e.target.value, ...(c.check ? { check: c.check.split('`' + c.name + '`').join('`' + e.target.value + '`') } : {}) })} /></td>
                    <td><input list="mib-types" value={c.type} onChange={(e) => setCol(c.id, { type: e.target.value })} /></td>
                    <td className="c"><input type="checkbox" checked={!!pk?.columns.some((x) => x.col === c.id)} onChange={() => update((t) => togglePrimary(t, c.id))} /></td>
                    <td className="c"><input type="checkbox" checked={!c.nullable} disabled={!!c.generated} onChange={(e) => setCol(c.id, { nullable: !e.target.checked, default: !e.target.checked ? c.default : c.default === 'NULL' ? null : c.default })} /></td>
                    <td className="c"><input type="checkbox" checked={c.autoIncrement} disabled={!!c.generated} onChange={(e) => setCol(c.id, { autoIncrement: e.target.checked, default: e.target.checked ? null : c.default })} /></td>
                    <td><input value={c.generated ? '' : c.default ?? ''} disabled={!!c.generated || c.autoIncrement} placeholder={c.generated ? 'generata' : c.nullable ? 'NULL' : ''}
                      title={t('Espressione SQL: \'testo\', 0, current_timestamp(), NULL')}
                      onChange={(e) => setCol(c.id, { default: e.target.value === '' ? null : e.target.value })} /></td>
                    <td><input value={c.comment} onChange={(e) => setCol(c.id, { comment: e.target.value })} /></td>
                    <td className="act">
                      <button title={t('Su')} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                      <button title={t('Giù')} disabled={i === cur.columns.length - 1} onClick={() => move(i, 1)}>↓</button>
                      <button title={t('Elimina colonna')} className="danger" onClick={() => { update((t) => removeColumn(t, c.id)); setSel(Math.max(0, i - 1)); }}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <datalist id="mib-types">{TYPES.map((t) => <option key={t} value={t} />)}</datalist>
            <button className="add" onClick={addColumn}>{t('+ Aggiungi colonna')}</button>
          </div>
          {col && (
            <div className="col-props form">
              <div className="props-title">{t('Proprietà di «')}{col.name}»</div>
              <label>{t('Collation')}
                {isTextType(col.type) ? collationSelect(col.collation, (v) => setCol(col.id, { collation: v }), t('(della tabella: {0})', cur.collation)) : <input disabled value={t('solo per tipi testo')} />}
              </label>
              <label>ON UPDATE<input value={col.onUpdate} disabled={!!col.generated} placeholder={t('es. current_timestamp()')} onChange={(e) => setCol(col.id, { onUpdate: e.target.value })} /></label>
              <label>{t('CHECK di colonna')}<input value={col.check ?? ''} placeholder={t('es. `prezzo` >= 0')} title={col.check?.startsWith('json_valid') ? t('Colonna JSON di MariaDB: la verifica json_valid va mantenuta') : undefined}
                onChange={(e) => setCol(col.id, { check: e.target.value.trim() ? e.target.value : null })} /></label>
              <label className="check"><input type="checkbox" checked={!!col.generated}
                onChange={(e) => setCol(col.id, e.target.checked ? { generated: { expr: '', stored: false }, default: null, autoIncrement: false, onUpdate: '', nullable: true } : { generated: null })} />{' '}{t('Colonna generata')}</label>
              {col.generated && <>
                <label>{t('Espressione')}<input value={col.generated.expr} placeholder={t('es. concat(nome, \' \', cognome)')} onChange={(e) => setCol(col.id, { generated: { ...col.generated!, expr: e.target.value } })} /></label>
                <label className="check"><input type="checkbox" checked={col.generated.stored} onChange={(e) => setCol(col.id, { generated: { ...col.generated!, stored: e.target.checked } })} />{' '}{t('STORED (salvata su disco, indicizzabile ovunque)')}</label>
              </>}
            </div>
          )}
        </>}

        {tab === 'indexes' && (
          <div className="dtable-wrap">
            <table className="dtable">
              <thead><tr><th>{t('Nome')}</th><th>{t('Tipo')}</th><th>{t('Colonne')}</th><th>{t('Commento')}</th><th /></tr></thead>
              <tbody>
                {cur.indexes.map((ix) => (
                  <tr key={ix.id} className={ix.orig === null ? 'new' : ''}>
                    <td><input value={ix.kind === 'PRIMARY' ? 'PRIMARY' : ix.name} disabled={ix.kind === 'PRIMARY'} onChange={(e) => setIx(ix.id, { name: e.target.value })} /></td>
                    <td><select value={ix.kind} onChange={(e) => {
                      const kind = e.target.value as IndexKind;
                      if (kind === 'PRIMARY' && pk && pk !== ix) return;
                      setIx(ix.id, { kind, name: kind === 'PRIMARY' ? 'PRIMARY' : ix.name === 'PRIMARY' ? `ix_${cur.name}_${colLabel(ix.columns[0]?.col ?? '')}` : ix.name });
                    }}>{KINDS.map((k) => <option key={k} disabled={k === 'PRIMARY' && !!pk && pk !== ix}>{k}</option>)}</select></td>
                    <td><ColumnChips lengths options={colOptions}
                      value={ix.columns.map((c) => ({ key: c.col, label: colLabel(c.col), len: c.len, desc: c.desc }))}
                      onChange={(v) => setIx(ix.id, { columns: v.map((x) => ({ col: x.key, len: x.len ?? null, ...(x.desc ? { desc: true } : {}) })) })} /></td>
                    <td><input value={ix.comment} onChange={(e) => setIx(ix.id, { comment: e.target.value })} /></td>
                    <td className="act"><button className="danger" title={t('Elimina indice')} onClick={() => update((t) => ({ ...t, indexes: t.indexes.filter((x) => x.id !== ix.id) }))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="add" onClick={() => {
              const first = cur.columns[Math.min(sel, cur.columns.length - 1)];
              update((t) => ({ ...t, indexes: [...t.indexes, { id: newId('i'), orig: null, name: `ix_${t.name}_${first?.name ?? ''}`, kind: 'INDEX', columns: first ? [{ col: first.id, len: null }] : [], comment: '' }] }));
            }}>{t('+ Aggiungi indice')}</button>
          </div>
        )}

        {tab === 'fks' && (
          <div className="dtable-wrap">
            <table className="dtable">
              <thead><tr><th>{t('Nome')}</th><th>{t('Colonne')}</th><th>{t('Database')}</th><th>{t('Tabella riferita')}</th><th>{t('Colonne riferite')}</th><th>ON DELETE</th><th>ON UPDATE</th><th /></tr></thead>
              <tbody>
                {cur.foreignKeys.map((fk) => {
                  const refCols = refColumns(fk);
                  const refDb = fk.refDb || db;
                  const refTables = refDb === db ? tables : ((meta[metaKey.objects(connId, refDb)] as MetaEntry<DbObjects> | undefined)?.data?.tables.map((t) => t.name) ?? []);
                  return (
                    <tr key={fk.id} className={fk.orig === null ? 'new' : ''}>
                      <td><input value={fk.name} onChange={(e) => setFk(fk.id, { name: e.target.value })} /></td>
                      <td><ColumnChips options={colOptions} value={fk.columns.map((c) => ({ key: c, label: colLabel(c) }))} onChange={(v) => setFk(fk.id, { columns: v.map((x) => x.key) })} /></td>
                      <td><select value={refDb} onChange={(e) => {
                        const d = e.target.value;
                        useStore.getState().loadMeta(metaKey.objects(connId, d), () => api.meta.objects(connId, d));
                        setFk(fk.id, { refDb: d, refTable: '', refColumns: [] });
                      }}>{(dbs?.data ?? [db]).map((d) => <option key={d}>{d}</option>)}</select></td>
                      <td><select value={fk.refTable} onChange={(e) => chooseRefTable(fk, refDb, e.target.value)}>
                        <option value="">—</option>
                        {fk.refTable && !refTables.includes(fk.refTable) && <option>{fk.refTable}</option>}
                        {refTables.map((t) => <option key={t}>{t}</option>)}
                      </select></td>
                      <td><ColumnChips options={(refCols ?? fk.refColumns.map((n) => ({ name: n }))).map((c) => ({ key: c.name, label: c.name }))}
                        value={fk.refColumns.map((n) => ({ key: n, label: n }))} onChange={(v) => setFk(fk.id, { refColumns: v.map((x) => x.key) })} /></td>
                      <td><select value={fk.onDelete} onChange={(e) => setFk(fk.id, { onDelete: e.target.value })}>{FK_RULES.map((r) => <option key={r}>{r}</option>)}</select></td>
                      <td><select value={fk.onUpdate} onChange={(e) => setFk(fk.id, { onUpdate: e.target.value })}>{FK_RULES.map((r) => <option key={r}>{r}</option>)}</select></td>
                      <td className="act"><button className="danger" title={t('Elimina chiave esterna')} onClick={() => update((t) => ({ ...t, foreignKeys: t.foreignKeys.filter((x) => x.id !== fk.id) }))}>✕</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <button className="add" onClick={() => {
              const first = cur.columns[Math.min(sel, cur.columns.length - 1)];
              let n = cur.foreignKeys.length + 1;
              while (cur.foreignKeys.some((f) => f.name === `fk_${cur.name}_${n}`)) n++;
              update((t) => ({ ...t, foreignKeys: [...t.foreignKeys, { id: newId('f'), orig: null, name: `fk_${t.name}_${n}`, columns: first ? [first.id] : [], refDb: db, refTable: '', refColumns: [], onDelete: 'RESTRICT', onUpdate: 'RESTRICT' }] }));
            }}>{t('+ Aggiungi chiave esterna')}</button>
          </div>
        )}

        {tab === 'checks' && (
          <div className="dtable-wrap">
            <table className="dtable">
              <thead><tr><th>{t('Nome')}</th><th>{t('Espressione')}</th><th /></tr></thead>
              <tbody>
                {cur.checks.map((k) => (
                  <tr key={k.id} className={k.orig === null ? 'new' : ''}>
                    <td style={{ width: 240 }}><input value={k.name} onChange={(e) => update((t) => ({ ...t, checks: t.checks.map((x) => (x.id === k.id ? { ...x, name: e.target.value } : x)) }))} /></td>
                    <td><input value={k.expr} placeholder={t('es. `prezzo` > 0 AND `prezzo` < 10000')} onChange={(e) => update((t) => ({ ...t, checks: t.checks.map((x) => (x.id === k.id ? { ...x, expr: e.target.value } : x)) }))} /></td>
                    <td className="act"><button className="danger" title={t('Elimina vincolo')} onClick={() => update((t) => ({ ...t, checks: t.checks.filter((x) => x.id !== k.id) }))}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="add" onClick={() => {
              let n = cur.checks.length + 1;
              while (cur.checks.some((k) => k.name === `ck_${cur.name}_${n}`)) n++;
              update((t) => ({ ...t, checks: [...t.checks, { id: newId('k'), orig: null, name: `ck_${t.name}_${n}`, expr: '' }] }));
            }}>{t('+ Aggiungi vincolo CHECK')}</button>
            <p className="note">{t('I vincoli di colonna (come json_valid delle colonne JSON di MariaDB) si modificano nelle proprietà della colonna.')}</p>
          </div>
        )}

        {tab === 'partitions' && (() => {
          const p = cur.partitioning;
          const setP = (patch: Partial<Partitioning> | null) => update((t) => ({ ...t, partitioning: patch === null ? null : { ...(t.partitioning ?? { method: 'RANGE', expr: '', count: 4, partitions: [] }), ...patch } as Partitioning }));
          const setPart = (id: string, patch: Partial<Partitioning['partitions'][number]>) => p && setP({ partitions: p.partitions.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
          const hint = !p ? '' : p.method.startsWith('RANGE') ? t('valore limite superiore escluso, es. 2026 o MAXVALUE (solo ultima)') : t('elenco di valori, es. 1,2,3 oppure \'LO\',\'PI\'');
          return (
            <div className="dtable-wrap">
              <div className="form part-head">
                <label className="check"><input type="checkbox" checked={!!p} disabled={p?.subpartitioned}
                  onChange={(e) => setP(e.target.checked ? { method: 'RANGE', expr: '', count: 4, partitions: [{ id: newId('p'), orig: null, name: 'p0', values: 'MAXVALUE', comment: '' }] } : null)} />{' '}{t('Tabella partizionata')}</label>
                {p && <div className="row">
                  <label>{t('Metodo')}<select value={p.method} disabled={p.subpartitioned} onChange={(e) => setP({ method: e.target.value as PartitionMethod })}>{PARTITION_METHODS.map((m) => <option key={m}>{m}</option>)}</select></label>
                  <label className="grow">{p.method.includes('COLUMNS') || p.method.endsWith('KEY') ? t('Colonne') : t('Espressione')}
                    <input value={p.expr} disabled={p.subpartitioned} placeholder={p.method.endsWith('KEY') ? t('vuoto = chiave primaria') : p.method.includes('COLUMNS') ? 'es. `regione`' : 'es. YEAR(`data`)'} onChange={(e) => setP({ expr: e.target.value })} /></label>
                  {!byList(p.method) && <label className="port">{t('Partizioni')}<input type="number" min={1} max={8192} value={p.count} disabled={p.subpartitioned} onChange={(e) => setP({ count: Number(e.target.value) || 1 })} /></label>}
                </div>}
                {p?.subpartitioned && <div className="status error">{t('Tabella con sottopartizioni: qui sono solo mostrate, lo script non le modifica.')}</div>}
                {p && <p className="note">{t('Le colonne usate devono far parte di ogni chiave primaria/univoca. Cambiare metodo, espressione, numero o confini ridistribuisce le righe; eliminare una partizione RANGE/LIST elimina le sue righe.')}</p>}
              </div>
              {p && byList(p.method) && <>
                <table className="dtable">
                  <thead><tr><th>{t('Nome')}</th><th>{t('Valori')}{' '}<span className="muted">({hint})</span></th><th>{t('Commento')}</th><th className="num">{t('Righe (stima)')}</th><th /></tr></thead>
                  <tbody>
                    {p.partitions.map((x, i) => (
                      <tr key={x.id} className={x.orig === null ? 'new' : ''}>
                        <td style={{ width: 200 }}><input value={x.name} disabled={p.subpartitioned} onChange={(e) => setPart(x.id, { name: e.target.value })} /></td>
                        <td><input value={x.values} disabled={p.subpartitioned} onChange={(e) => setPart(x.id, { values: e.target.value })} /></td>
                        <td><input value={x.comment} disabled={p.subpartitioned} onChange={(e) => setPart(x.id, { comment: e.target.value })} /></td>
                        <td className="num muted">{x.rows !== undefined && x.rows !== null ? x.rows.toLocaleString(locale()) : ''}</td>
                        <td className="act">
                          <button disabled={i === 0 || p.subpartitioned} onClick={() => { const ps = [...p.partitions]; [ps[i - 1], ps[i]] = [ps[i], ps[i - 1]]; setP({ partitions: ps }); }}>↑</button>
                          <button disabled={i === p.partitions.length - 1 || p.subpartitioned} onClick={() => { const ps = [...p.partitions]; [ps[i + 1], ps[i]] = [ps[i], ps[i + 1]]; setP({ partitions: ps }); }}>↓</button>
                          <button className="danger" disabled={p.subpartitioned} onClick={() => setP({ partitions: p.partitions.filter((y) => y.id !== x.id) })}>✕</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!p.subpartitioned && <button className="add" onClick={() => {
                  let n = p.partitions.length;
                  while (p.partitions.some((x) => x.name === `p${n}`)) n++;
                  const last = p.partitions[p.partitions.length - 1];
                  const item = { id: newId('p'), orig: null, name: `p${n}`, values: '', comment: '' };
                  // a new RANGE partition goes before a final MAXVALUE one
                  const ps = p.method.startsWith('RANGE') && last && /^maxvalue$/i.test(last.values.trim()) ? [...p.partitions.slice(0, -1), item, last] : [...p.partitions, item];
                  setP({ partitions: ps });
                }}>{t('+ Aggiungi partizione')}</button>}
              </>}
            </div>
          );
        })()}

        {tab === 'script' && (
          <pre className="script">{script.length ? script.join(';\n\n') + ';' : t('-- Nessuna modifica.')}</pre>
        )}
      </div>

      <div className="designer-foot">
        {errors.length > 0 ? <div className="status error" title={errors.join('\n')}>{errors[0]}{errors.length > 1 ? ` (+${errors.length - 1})` : ''}</div>
          : status ? <div className={`status ${status.ok ? 'ok' : 'error'}`}>{status.text}</div>
            : <div className="muted">{script.length ? t('{0} {1} da eseguire', script.length, script.length === 1 ? 'istruzione' : 'istruzioni') : t('Nessuna modifica')}</div>}
        <div className="spacer" />
        {state!.orig && <button onClick={() => { designByDoc.delete(doc.id); load(cur.name === state!.orig!.name ? cur.name : state!.orig!.name); }} disabled={busy}>{t('Ricarica')}</button>}
        <button disabled={!script.length} onClick={() => newDoc({ connId, db, sql: script.join(';\n\n') + ';\n', title: `${cur.name}.sql` })}>{t('Apri script nell\'editor')}</button>
        <button className="primary" disabled={!script.length || errors.length > 0 || busy} onClick={apply}>
          {busy ? t('Applicazione…') : state!.orig ? t('Applica modifiche') : t('Crea tabella')}
        </button>
      </div>
    </div>
  );
}

