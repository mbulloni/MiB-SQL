import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { newDoc, openDesigner, openObject, persist, reveal } from '../actions';
import { modelOf } from '../editor';
import { locale, t, tn } from '../i18n';
import { dataQuery, filterHits, matcher, matchLine, splitMatches, type DataHit, type ObjectHit } from '../search';
import { loadDatabases, metaKey, useStore, type MetaEntry } from '../store';
import type { Doc, EditableKind } from '../types';
import Icon from './Icon';

const SYSTEM = ['information_schema', 'performance_schema', 'mysql', 'sys'];
const KIND_ICON: Record<string, string> = { table: 'table', view: 'view', column: 'column', index: 'index', procedure: 'procedure', function: 'function', trigger: 'trigger', event: 'event', routine: 'procedure' };
const KIND_LABEL: Record<string, () => string> = {
  table: () => t('Tabella'), view: () => t('Vista'), column: () => t('Colonna'), index: () => t('Indice'), procedure: () => t('Procedura'), function: () => t('Funzione'), trigger: () => 'Trigger', event: () => t('Evento'),
};
const WHERE_LABEL: Record<string, () => string> = { name: () => t('nome'), code: () => t('codice'), comment: () => t('commento') };
const fmt = (n: number) => n.toLocaleString(locale());

function Marked({ text, re }: { text: string; re: RegExp }) {
  return <>{splitMatches(text, re).map((p, i) => (p.hit ? <mark key={i}>{p.s}</mark> : <span key={i}>{p.s}</span>))}</>;
}

/** Database search: object names, code of views/routines/triggers/events, comments and data. */
export default function Search({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const dbs = useStore((s) => s.meta[metaKey.databases(connId)]) as MetaEntry<string[]> | undefined;
  useEffect(() => { if (!connOpen) { useStore.getState().openConn(connId); return; } loadDatabases(connId); }, [connOpen]);
  // scope sent from the explorer (Cerca nel database… on a database)
  useEffect(() => { if (doc.search && doc.search.db !== undefined) setScope(doc.search.db ?? ''); }, [doc.search?.db]);
  const userDbs = (dbs?.data ?? []).filter((d) => !SYSTEM.includes(d));
  const [text, setText] = useState(doc.search?.text ?? '');
  const [scope, setScope] = useState<string>(doc.search?.db ?? doc.db ?? '');
  const [opts, setOpts] = useState({ names: true, code: true, comments: true, data: false, caseSensitive: false, wholeWord: false, exact: false, maxRows: 100, skipAbove: 0 });
  const [hits, setHits] = useState<ObjectHit[] | null>(null);
  const [data, setData] = useState<{ results: DataHit[]; stopped: boolean; tables: number } | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number; table: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState<{ text: string; caseSensitive: boolean; wholeWord: boolean } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const taskId = useRef(crypto.randomUUID());
  useEffect(() => api.tasks.onProgress((p) => { if (p.id === taskId.current) setProgress({ done: Number(p.done), total: Number(p.total), table: (p.table as string) ?? null }); }), []);

  const run = async () => {
    const q = text.trim();
    if (!q) return;
    const list = scope ? [scope] : userDbs;
    setBusy(true); setError(null); setHits(null); setData(null); setProgress(null);
    setSearched({ text: q, caseSensitive: opts.caseSensitive, wholeWord: opts.wholeWord });
    useStore.getState().updateDoc(doc.id, { search: { text: q, db: scope || null }, title: `${t('Cerca')} «${q.slice(0, 20)}»` });
    persist();
    try {
      if (opts.names || opts.code || opts.comments) {
        const h = await api.search.objects(connId, list, q, { names: opts.names, code: opts.code, comments: opts.comments });
        setHits(filterHits(h, q, opts.caseSensitive, opts.wholeWord));
      }
      if (opts.data) {
        taskId.current = crypto.randomUUID();
        setData(await api.search.data(taskId.current, connId, list, q, { caseSensitive: opts.caseSensitive, exact: opts.exact, maxRows: opts.maxRows, skipAbove: opts.skipAbove }));
      }
    } catch (err) { setError((err as Error).message); }
    setBusy(false); setProgress(null);
  };

  const re = useMemo(() => (searched ? matcher(searched.text, searched.caseSensitive, searched.wholeWord) : null), [searched]);
  const openHit = async (h: ObjectHit) => {
    if (h.kind === 'table' || h.kind === 'column' || h.kind === 'index') { openDesigner(connId, h.db, h.kind === 'table' ? h.name : h.table!); return; }
    const kind = (h.kind === 'routine' ? 'procedure' : h.kind) as EditableKind;
    await openObject(connId, h.db, kind, h.name);
    // jump to the match in the opened definition
    const d = useStore.getState().docs.find((x) => x.obj?.kind === kind && x.obj.name === h.name && x.db === h.db);
    if (d && searched) {
      const m = modelOf(d.id).getValue();
      const i = searched.caseSensitive ? m.indexOf(searched.text) : m.toLowerCase().indexOf(searched.text.toLowerCase());
      if (i >= 0) setTimeout(() => reveal(d.id, i), 100);
    }
  };
  const grouped = useMemo(() => {
    const m = new Map<string, ObjectHit[]>();
    for (const h of hits ?? []) {
      const k = h.kind === 'routine' ? 'procedure' : h.kind;
      m.set(k, [...(m.get(k) ?? []), h]);
    }
    return [...m];
  }, [hits]);
  const dataFound = (data?.results ?? []).filter((r) => r.rows.length);
  const totalRows = dataFound.reduce((n, r) => n + r.rows.length, 0);

  return (
    <div className="monitor search">
      <div className="er-bar search-bar">
        <input className="search-input" autoFocus placeholder={t('Testo da cercare…')} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') run(); }} />
        <select value={scope} onChange={(e) => setScope(e.target.value)} title={t('Dove cercare')}>
          <option value="">{t('Tutti i database ({0})', userDbs.length)}</option>
          {userDbs.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button className="primary" disabled={busy || !text.trim()} onClick={run}>{busy ? t('Ricerca…') : t('Cerca')}</button>
        {busy && opts.data && <button onClick={() => api.search.stop(taskId.current)}>{t('Interrompi')}</button>}
      </div>
      <div className="maint-actions">
        <span className="muted">{t('In')}:</span>
        {(['names', 'code', 'comments', 'data'] as const).map((k) => (
          <label key={k} className="check"><input type="checkbox" checked={opts[k]} onChange={(e) => setOpts({ ...opts, [k]: e.target.checked })} />{' '}
            {{ names: t('nomi degli oggetti'), code: t('codice di viste, routine, trigger, eventi'), comments: t('commenti'), data: t('dati delle tabelle') }[k]}</label>
        ))}
        <span className="sep" />
        <label className="check"><input type="checkbox" checked={opts.caseSensitive} onChange={(e) => setOpts({ ...opts, caseSensitive: e.target.checked })} /> {t('maiuscole/minuscole')}</label>
        <label className="check"><input type="checkbox" checked={opts.wholeWord} onChange={(e) => setOpts({ ...opts, wholeWord: e.target.checked })} /> {t('parola intera')}</label>
        {opts.data && <>
          <label className="check" title={t('Nei dati: valore uguale invece di «contiene»')}><input type="checkbox" checked={opts.exact} onChange={(e) => setOpts({ ...opts, exact: e.target.checked })} /> {t('valore esatto')}</label>
          <label className="check">{t('righe per tabella')} <input className="num-input" type="number" min={1} max={10000} value={opts.maxRows} onChange={(e) => setOpts({ ...opts, maxRows: Math.max(1, Number(e.target.value) || 1) })} /></label>
          <label className="check" title={t('0 = cerca in tutte le tabelle')}>{t('salta tabelle oltre')} <input className="num-input wide" type="number" min={0} step={100000} value={opts.skipAbove} onChange={(e) => setOpts({ ...opts, skipAbove: Math.max(0, Number(e.target.value) || 0) })} /> {t('righe')}</label>
        </>}
      </div>
      {progress && <div className="maint-progress"><span>{progress.table ?? ''}</span><progress className="progress" max={progress.total} value={progress.done} /><span className="muted">{progress.done}/{progress.total}</span></div>}
      {error && <div className="status error cmp-error">{error}</div>}
      <div className="perf-body">
        {!searched && <p className="note">{t('Cerca un testo nei nomi di tabelle, colonne, indici, viste, routine, trigger ed eventi, nel loro codice, nei commenti e, se scelto, nei dati delle colonne di testo (e numeriche quando il testo è un numero). La ricerca nei dati legge ogni tabella: su database grandi può richiedere tempo.')}</p>}
        {hits && searched && re && <section className="idx-section">
          <h3>{t('Oggetti')} <span className="muted">({hits.length})</span></h3>
          {!hits.length && <p className="note">{t('Nessun oggetto trovato.')}</p>}
          {grouped.map(([kind, list]) => (
            <div key={kind} className="search-group">
              <div className="props-title"><Icon name={KIND_ICON[kind]} size={14} /> {KIND_LABEL[kind]?.() ?? kind} ({list.length})</div>
              <table className="dtable"><tbody>
                {list.map((h, i) => {
                  const m = h.where === 'code' && h.text ? matchLine(h.text, re) : null;
                  return (
                    <tr key={i} className="clickable" onDoubleClick={() => openHit(h)}>
                      <td className="nowrap"><span className="muted">{h.db}.</span>{h.table ? <span className="muted">{h.table}.</span> : null}<b>{h.where === 'name' ? <Marked text={h.name} re={re} /> : h.name}</b></td>
                      <td className="muted nowrap">{WHERE_LABEL[h.where]()}{m ? ` · ${t('riga {0}', m.line)}` : ''}</td>
                      <td className="q">{h.where === 'code' && m ? <Marked text={m.text} re={re} /> : h.where === 'comment' && h.text ? <Marked text={h.text} re={re} /> : <span className="muted">{h.kind === 'column' ? h.text : ''}</span>}</td>
                      <td className="act"><button onClick={() => openHit(h)}>{t('Apri')}</button></td>
                    </tr>
                  );
                })}
              </tbody></table>
            </div>
          ))}
        </section>}
        {data && searched && re && <section className="idx-section">
          <h3>{t('Dati')} <span className="muted">({tn(dataFound.length, '{0} tabella', '{0} tabelle')}, {tn(totalRows, '{0} riga', '{0} righe')}{data.stopped ? `, ${t('interrotta')}` : ''})</span></h3>
          {!dataFound.length && <p className="note">{t('Nessun valore trovato in {0} tabelle.', data.tables)}</p>}
          {dataFound.map((r) => {
            const k = `${r.db}.${r.table}`;
            const show = open.has(k);
            return (
              <div key={k} className="search-group">
                <div className="procs-bar">
                  <button className="link" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })}>{show ? '▾' : '▸'} <b>{k}</b></button>
                  <span className="muted">{r.more ? t('più di {0} righe', fmt(r.rows.length)) : tn(r.rows.length, '{0} riga', '{0} righe')}</span>
                  <div className="spacer" />
                  <button onClick={() => newDoc({ connId, db: r.db, sql: dataQuery(r.db, r.table, r.searched ?? r.columns, searched.text, { exact: opts.exact, caseSensitive: searched.caseSensitive }) })}>{t('Apri query')}</button>
                </div>
                {show && <div className="procs-table"><table className="dtable">
                  <thead><tr>{r.columns.map((c) => <th key={c}>{c}{r.key?.includes(c) ? ' 🔑' : ''}</th>)}</tr></thead>
                  <tbody>{r.rows.map((row, i) => <tr key={i}>{row.map((v, j) => <td key={j} className="q">{v === null ? <i className="muted">NULL</i> : <Marked text={String(v)} re={re} />}</td>)}</tr>)}</tbody>
                </table></div>}
              </div>
            );
          })}
          {(data.results.filter((r) => r.error || r.skipped)).map((r) => <p key={`${r.db}.${r.table}`} className="note">{r.db}.{r.table}: {r.skipped ? t('saltata (circa {0} righe)', fmt(r.estimated ?? 0)) : r.error}</p>)}
        </section>}
      </div>
    </div>
  );
}
