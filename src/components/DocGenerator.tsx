import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { DEFAULT_DOC, docHtml, docMarkdown, type DocModel, type DocOptions, type DocTable } from '../docgen';
import { locale, t, tn } from '../i18n';
import { useStore } from '../store';
import type { Doc } from '../types';

let canvas: CanvasRenderingContext2D | null = null;
const measure = (s: string) => {
  canvas ??= document.createElement('canvas').getContext('2d');
  canvas!.font = "12px 'Noto Sans', 'Segoe UI', sans-serif";
  return canvas!.measureText(s).width;
};

const KEY = 'mibsql.docgen';
const savedOptions = (): Partial<DocOptions> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } };

/** Documentation of a database: options, live preview, save as HTML or Markdown. */
export default function DocGenerator({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const db = doc.db!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const info = useStore((s) => s.connState[connId]?.info);
  const [model, setModel] = useState<DocModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [opts, setOpts] = useState<DocOptions>(() => ({ ...DEFAULT_DOC, ...savedOptions(), tables: null, title: t('Documentazione del database {0}', db) }));
  const set = (p: Partial<DocOptions>) => setOpts((o) => {
    const n = { ...o, ...p };
    try { const { tables: _t, title: _x, ...keep } = n; localStorage.setItem(KEY, JSON.stringify(keep)); } catch { /* ignore */ }
    return n;
  });

  const load = async () => {
    setError(null);
    try {
      const [snap, er, stats, objs] = await Promise.all([api.meta.schemaSnapshot(connId, db), api.meta.erModel(connId, db), api.maint.stats(connId, db), api.meta.objects(connId, db)]);
      const st = new Map(stats.map((x) => [x.name, x]));
      const tables: DocTable[] = Object.values(snap.tables).map((tb) => ({ ...tb, rows: st.get(tb.name)?.rows ?? null, data: st.get(tb.name)?.data ?? null, idx: st.get(tb.name)?.idx ?? null }));
      const trg = new Map(objs.triggers.map((x) => [x.name, x]));
      const ev = new Map(objs.events.map((x) => [x.name, x]));
      setModel({
        db, server: info?.version ?? '', generated: new Date().toLocaleString(locale()), tables, er,
        objects: snap.others.map((o) => ({ ...o, ...(o.kind === 'trigger' ? { table: trg.get(o.name)?.table, timing: trg.get(o.name)?.timing, event: trg.get(o.name)?.event } : {}), ...(o.kind === 'event' ? { status: ev.get(o.name)?.status } : {}) })),
      });
    } catch (err) { setError((err as Error).message); }
  };
  useEffect(() => { if (!connOpen) { useStore.getState().openConn(connId); return; } load(); }, [connOpen]);

  const html = useMemo(() => (model && opts.format === 'html' ? docHtml(model, opts, measure) : ''), [model, opts]);
  const md = useMemo(() => (model && opts.format === 'md' ? docMarkdown(model, opts) : ''), [model, opts]);
  const names = (model?.tables ?? []).map((x) => x.name).sort();
  const picked = opts.tables ?? names;

  const save = async () => {
    const text = opts.format === 'html' ? html : md;
    const ext = opts.format === 'html' ? 'html' : 'md';
    try {
      const file = await api.file.saveData(text, false, `${db}-${t('documentazione')}.${ext}`, [{ name: opts.format === 'html' ? 'HTML' : 'Markdown', extensions: [ext] }]);
      if (file) setNotice(t('Salvato in {0}', file));
    } catch (err) { setError((err as Error).message); }
  };
  const check = (k: keyof DocOptions, label: string) => <label className="check"><input type="checkbox" checked={!!opts[k]} onChange={(e) => set({ [k]: e.target.checked })} /> {label}</label>;

  return (
    <div className="monitor docgen">
      <div className="er-bar">
        <b>{db}</b>
        <span className="muted">{model ? tn(picked.length, '{0} tabella', '{0} tabelle') : t('Caricamento…')}</span>
        <div className="spacer" />
        <label className="check">{t('Formato')} <select value={opts.format} onChange={(e) => set({ format: e.target.value as DocOptions['format'] })}>
          <option value="html">{t('HTML (pagina unica con indice e diagramma)')}</option><option value="md">Markdown</option></select></label>
        <button onClick={load}>{t('Rileggi')}</button>
        {opts.format === 'md' && <button disabled={!md} onClick={() => navigator.clipboard.writeText(md)}>{t('Copia')}</button>}
        <button className="primary" disabled={!model} onClick={save}>{t('Salva…')}</button>
      </div>
      {error && <div className="status error cmp-error">{error}</div>}
      {notice && <div className="status ok cmp-error" onClick={() => setNotice(null)}>{notice}</div>}
      <div className="dg-body">
        <div className="dg-tables doc-opts">
          <div className="form">
            <label>{t('Titolo')}<input value={opts.title} onChange={(e) => set({ title: e.target.value })} /></label>
            <div className="props-title">{t('Contenuto')}</div>
            {check('columns', t('Colonne'))}
            {check('indexes', t('Indici'))}
            {check('fks', t('Chiavi esterne, riferimenti e vincoli CHECK'))}
            {check('triggers', 'Trigger')}
            {check('ddl', t('Istruzione CREATE TABLE'))}
            {opts.format === 'html' && check('diagram', t('Diagramma delle relazioni'))}
            {check('views', t('Viste'))}
            {check('routines', t('Procedure e funzioni'))}
            {check('events', t('Eventi'))}
            <div className="props-title">{t('Tabelle')} <span className="muted">({picked.length}/{names.length})</span></div>
            <div className="snip-actions">
              <button onClick={() => set({ tables: null })}>{t('Tutte')}</button>
              <button onClick={() => set({ tables: [] })}>{t('Nessuna')}</button>
            </div>
          </div>
          <div className="dg-table-list">
            {names.map((n) => (
              <label key={n} className="cmp-item">
                <input type="checkbox" checked={picked.includes(n)} onChange={(e) => set({ tables: e.target.checked ? [...picked, n] : picked.filter((x) => x !== n) })} />
                <span className="name">{n}</span>
              </label>
            ))}
          </div>
        </div>
        <div className="doc-preview">
          {!model ? <div className="empty">{t('Caricamento…')}</div>
            : opts.format === 'html' ? <iframe title={t('Anteprima')} sandbox="" srcDoc={html} />
              : <pre className="hist-sql">{md}</pre>}
        </div>
      </div>
    </div>
  );
}
