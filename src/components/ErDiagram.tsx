import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { openDesigner, qi, selectTop, showDdl } from '../actions';
import { FK_RULES } from '../design';
import {
  autoLayout, bounds, boxSize, fkColumns, HEADER, relationPath, ROW, rowY, shownColumns, type Box, type ErModel, type Positions,
} from '../er';
import { useStore, type MetaEntry } from '../store';
import type { Doc } from '../types';
import { openMenu } from './ContextMenu';

// Styles live inside the SVG so exported files look the same as on screen.
const ER_CSS = `
.er-t rect.body { fill: var(--panel, #fff); stroke: var(--box-stroke, #b8c2cf); }
.er-t.sel rect.body { stroke: #2f6fd6; stroke-width: 2; }
.er-t rect.head { fill: #3a7bd5; }
.er-t.view rect.head { fill: #2a9d8f; }
.er-t text { font: 12px 'Noto Sans', 'Segoe UI', sans-serif; fill: var(--text, #1f2933); }
.er-t text.name { font-weight: 600; fill: #fff; font-size: 12.5px; }
.er-t text.type { fill: var(--muted, #7a8696); font-size: 11px; }
.er-t text.pk { font-weight: 600; }
.er-t text.more { fill: var(--muted, #7a8696); font-style: italic; font-size: 11px; }
.er-t .key { fill: #d4a017; font-size: 10px; font-weight: 700; }
.er-t .fk { fill: #2a9d8f; font-size: 10px; font-weight: 700; }
.er-r path { fill: none; stroke: var(--edge, #8a96a6); stroke-width: 1.4; }
.er-r.opt path.line { stroke-dasharray: 5 4; }
.er-r.hi path { stroke: #2f6fd6; stroke-width: 2; }
.er-r.dim path { stroke: var(--edge-dim, #d5dbe3); }
.er-r.picked path { stroke: #d64545; stroke-width: 2.4; }
.er-r path.hit { stroke: transparent; stroke-width: 10; }
.er-t rect.row-hit { fill: transparent; }
.linking .er-t rect.row-hit:hover { fill: rgba(47, 111, 214, .14); }
.er-link { fill: none; stroke: #2f6fd6; stroke-width: 2; stroke-dasharray: 6 4; }
`;

const FONT = "12px 'Noto Sans', 'Segoe UI', sans-serif";
let ctx: CanvasRenderingContext2D | null = null;
const measure = (s: string) => {
  ctx ??= document.createElement('canvas').getContext('2d');
  ctx!.font = FONT;
  return ctx!.measureText(s).width;
};

interface Saved { pos: Positions; keysOnly: boolean; hidden: string[] }
const storeKey = (c: string, db: string) => `mibsql.er.${c}.${db}`;
const loadSaved = (c: string, db: string): Saved => {
  try { return { pos: {}, keysOnly: false, hidden: [], ...JSON.parse(localStorage.getItem(storeKey(c, db)) ?? '{}') }; } catch { return { pos: {}, keysOnly: false, hidden: [] }; }
};

/** Crow's foot ("many") at the child end, a bar ("one") at the parent end. */
function ends(r: ReturnType<typeof relationPath>) {
  const { start: s, end: e } = r;
  const many = `M ${s.x + s.dir * 12} ${s.y} L ${s.x} ${s.y - 6} M ${s.x + s.dir * 12} ${s.y} L ${s.x} ${s.y} M ${s.x + s.dir * 12} ${s.y} L ${s.x} ${s.y + 6}`;
  const one = `M ${e.x + e.dir * 8} ${e.y - 6} L ${e.x + e.dir * 8} ${e.y + 6} M ${e.x + e.dir * 12} ${e.y - 6} L ${e.x + e.dir * 12} ${e.y + 6}`;
  return many + ' ' + one;
}

export default function ErDiagram({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const db = doc.db!;
  const key = `${connId}/${db}/er`;
  const entry = useStore((s) => s.meta[key]) as MetaEntry<ErModel> | undefined;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const [saved, setSaved] = useState<Saved>(() => loadSaved(connId, db));
  const [view, setView] = useState({ x: 20, y: 20, k: 1 });
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const svg = useRef<SVGSVGElement>(null);
  const fitted = useRef(false);
  const [linkMode, setLinkMode] = useState(false);
  const [link, setLink] = useState<{ table: string; col: string; x: number; y: number; tx: number; ty: number } | null>(null);
  const [newFk, setNewFk] = useState<{ table: string; col: string; refTable: string; refCol: string } | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // relation key table/name

  // (re)load when the connection opens or the cache is dropped (designer apply, DDL from here)
  useEffect(() => {
    if (!connOpen) { useStore.getState().openConn(connId); return; }
    if (!entry) useStore.getState().loadMeta(key, () => api.meta.erModel(connId, db));
  }, [connOpen, entry]);

  const runDdl = async (sqls: string[]) => {
    try {
      await api.ddl.run(connId, sqls);
      useStore.getState().dropMeta(`${connId}/${db}/`);
      return true;
    } catch (err) {
      await api.confirm('Operazione non riuscita', (err as Error).message, ['OK']);
      return false;
    }
  };

  /** Diagram point of a mouse event (inverse of the view transform). */
  const toDiagram = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left - view.x) / view.k, y: (e.clientY - r.top - view.y) / view.k };
  };

  /** Link mode: drag from a column to the referenced column of another table. */
  const startLink = (e: React.MouseEvent, table: string, col: string) => {
    if (!linkMode || e.button !== 0) return;
    e.stopPropagation();
    const p = toDiagram(e);
    setLink({ table, col, x: p.x, y: p.y, tx: p.x, ty: p.y });
    const move = (ev: MouseEvent) => { const q = toDiagram(ev); setLink((l) => l && { ...l, tx: q.x, ty: q.y }); };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setLink(null);
      const hit = (ev.target as Element).closest?.('[data-col]');
      const refTable = hit?.getAttribute('data-table');
      const refCol = hit?.getAttribute('data-col');
      if (refTable && refCol && !(refTable === table && refCol === col)) setNewFk({ table, col, refTable, refCol });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const dropRelation = async (fkKey: string) => {
    const [table, name] = fkKey.split('/');
    if ((await api.confirm(`Eliminare la relazione ${name}?`, `ALTER TABLE ${table} DROP FOREIGN KEY ${name}`, ['Elimina', 'Annulla'])) !== 0) return;
    if (await runDdl([`ALTER TABLE ${qi(db)}.${qi(table)} DROP FOREIGN KEY ${qi(name)}`])) setPicked(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Delete' && picked && !(e.target as HTMLElement).closest('input, textarea, select')) dropRelation(picked);
      if (e.key === 'Escape') { setLinkMode(false); setPicked(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked]);

  const save = (s: Saved) => {
    setSaved(s);
    try { localStorage.setItem(storeKey(connId, db), JSON.stringify(s)); } catch { /* ignore */ }
  };

  const model = useMemo<ErModel | null>(() => {
    if (!entry?.data) return null;
    const hidden = new Set(saved.hidden);
    const tables = entry.data.tables.filter((t) => !hidden.has(t.name));
    const names = new Set(tables.map((t) => t.name));
    return { tables, fks: entry.data.fks.filter((f) => (!f.refDb || f.refDb === db) && names.has(f.table) && names.has(f.refTable)) };
  }, [entry?.data, saved.hidden]);

  const fkCols = useMemo(() => (model ? fkColumns(model) : new Map<string, Set<string>>()), [model]);
  const shown = useMemo(() => Object.fromEntries((model?.tables ?? []).map((t) => [t.name, shownColumns(t, fkCols.get(t.name) ?? new Set(), saved.keysOnly)])), [model, fkCols, saved.keysOnly]);
  const sizes = useMemo(() => Object.fromEntries((model?.tables ?? []).map((t) => [t.name, boxSize(t, shown[t.name].length + (saved.keysOnly && shown[t.name].length < t.columns.length ? 1 : 0), measure)])), [model, shown]);
  const pos = useMemo<Positions>(() => {
    if (!model) return {};
    const missing = model.tables.some((t) => !saved.pos[t.name]);
    return missing ? { ...autoLayout(model, sizes), ...saved.pos } : saved.pos;
  }, [model, sizes, saved.pos]);

  const fit = () => {
    if (!model || !svg.current) return;
    const b = bounds(pos, sizes, model.tables.map((t) => t.name));
    const r = svg.current.getBoundingClientRect();
    const k = Math.min(1.5, Math.max(0.1, Math.min(r.width / b.w, r.height / b.h) * 0.95));
    setView({ k, x: (r.width - b.w * k) / 2 - b.x * k, y: (r.height - b.h * k) / 2 - b.y * k });
  };
  useEffect(() => { if (model && !fitted.current) { fitted.current = true; requestAnimationFrame(fit); } }, [model]);

  const relayout = () => { if (model) { save({ ...saved, pos: autoLayout(model, sizes) }); requestAnimationFrame(fit); } };
  const zoom = (f: number, cx?: number, cy?: number) => {
    const r = svg.current!.getBoundingClientRect();
    const px = cx ?? r.width / 2;
    const py = cy ?? r.height / 2;
    setView((v) => {
      const k = Math.min(3, Math.max(0.08, v.k * f));
      return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
    });
  };

  // drag a table or pan the canvas
  const drag = (e: React.MouseEvent, table: string | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const start = table ? { ...pos[table] } : { x: view.x, y: view.y };
    const k = view.k;
    let moved = false;
    let last = pos;
    if (table) setSel(table);
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - x0;
      const dy = ev.clientY - y0;
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      if (table) {
        last = { ...pos, [table]: { x: Math.round(start.x + dx / k), y: Math.round(start.y + dy / k) } };
        setSaved((s) => ({ ...s, pos: last }));
      } else setView((v) => ({ ...v, x: start.x + dx, y: start.y + dy }));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      if (table && moved) save({ ...saved, pos: last });
      if (!table && !moved) { setSel(null); setPicked(null); }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onWheel = (e: React.WheelEvent) => {
    const r = svg.current!.getBoundingClientRect();
    zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
  };

  const find = (q: string) => {
    setSearch(q);
    const t = model?.tables.find((x) => x.name.toLowerCase().includes(q.toLowerCase()));
    if (!q || !t || !svg.current) return;
    const r = svg.current.getBoundingClientRect();
    setSel(t.name);
    setView((v) => ({ ...v, x: r.width / 2 - (pos[t.name].x + sizes[t.name].w / 2) * v.k, y: r.height / 2 - (pos[t.name].y + sizes[t.name].h / 2) * v.k }));
  };

  /** Standalone SVG of the whole diagram (used for both SVG and PNG export). */
  const exportSvg = () => {
    const b = bounds(pos, sizes, model!.tables.map((t) => t.name));
    const clone = svg.current!.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(Math.ceil(b.w)));
    clone.setAttribute('height', String(Math.ceil(b.h)));
    clone.setAttribute('viewBox', `${b.x} ${b.y} ${b.w} ${b.h}`);
    clone.querySelector('g.root')!.setAttribute('transform', ''); // exported files use the light fallbacks of ER_CSS
    clone.querySelectorAll('.sel').forEach((n) => n.classList.remove('sel'));
    clone.querySelectorAll('.hi, .dim').forEach((n) => n.classList.remove('hi', 'dim'));
    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    Object.entries({ x: b.x, y: b.y, width: b.w, height: b.h, fill: '#ffffff' }).forEach(([k, v]) => bg.setAttribute(k, String(v)));
    clone.insertBefore(bg, clone.querySelector('g.root'));
    return { text: new XMLSerializer().serializeToString(clone), w: b.w, h: b.h };
  };
  const saveSvg = () => api.file.saveData(exportSvg().text, false, `${db}-er.svg`, [{ name: 'SVG', extensions: ['svg'] }]);
  const savePng = async () => {
    const { text, w, h } = exportSvg();
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
    await img.decode();
    const scale = Math.min(2, 16000 / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(w * scale);
    canvas.height = Math.ceil(h * scale);
    const c = canvas.getContext('2d')!;
    c.scale(scale, scale);
    c.drawImage(img, 0, 0);
    await api.file.saveData(canvas.toDataURL('image/png').split(',')[1], true, `${db}-er.png`, [{ name: 'PNG', extensions: ['png'] }]);
  };

  if (!model) {
    return <div className="er"><div className="empty">{entry?.error ?? (connOpen ? 'Caricamento del modello…' : 'Connessione in corso…')}</div></div>;
  }

  const focus = hover ?? sel;
  const boxOf = (n: string): Box => ({ ...pos[n], ...sizes[n] });
  const colIndex = (table: string, col: string) => shown[table].findIndex((c) => c.name === col);

  const tableMenu = (e: React.MouseEvent, name: string, kind: 'table' | 'view') => openMenu(e, [
    ...(kind === 'table' ? [{ label: 'Modifica tabella…', action: () => openDesigner(connId, db, name) }] : []),
    { label: kind === 'table' ? 'Modifica dati (prime 1000 righe)' : 'Seleziona prime 1000 righe', action: () => selectTop(connId, db, name) },
    { label: 'Mostra DDL', action: () => showDdl(connId, db, kind, name) },
    'sep',
    { label: 'Nascondi dal diagramma', action: () => save({ ...saved, hidden: [...saved.hidden, name] }) },
    ...(kind === 'table' ? ['sep' as const, {
      label: 'Elimina tabella…', danger: true, action: async () => {
        if ((await api.confirm(`Eliminare la tabella ${db}.${name}?`, 'La tabella e tutti i suoi dati verranno eliminati definitivamente.', ['Elimina', 'Annulla'])) === 0) await runDdl([`DROP TABLE ${qi(db)}.${qi(name)}`]);
      },
    }] : []),
  ]);

  return (
    <div className="er">
      <div className="er-bar">
        <button className="primary" onClick={() => openDesigner(connId, db, null)}>+ Tabella</button>
        <button className={linkMode ? 'active' : ''} onClick={() => setLinkMode((v) => !v)} title="Trascina da una colonna alla colonna riferita di un'altra tabella">🔗 Relazione</button>
        <input className="search" placeholder="Trova tabella…" value={search} onChange={(e) => find(e.target.value)} />
        <button onClick={() => zoom(1 / 1.2)} title="Riduci">−</button>
        <span className="zoom">{Math.round(view.k * 100)}%</span>
        <button onClick={() => zoom(1.2)} title="Ingrandisci">+</button>
        <button onClick={fit}>Adatta</button>
        <button onClick={relayout} title="Disposizione automatica">Ridisponi</button>
        <label className="check"><input type="checkbox" checked={saved.keysOnly} onChange={(e) => { save({ ...saved, keysOnly: e.target.checked, pos: {} }); requestAnimationFrame(fit); }} /> Solo chiavi</label>
        {saved.hidden.length > 0 && <button onClick={() => save({ ...saved, hidden: [] })}>Mostra {saved.hidden.length} nascoste</button>}
        <div className="spacer" />
        <span className="muted">{model.tables.length} tabelle · {model.fks.length} relazioni</span>
        <button onClick={() => { useStore.getState().dropMeta(key); useStore.getState().loadMeta(key, () => api.meta.erModel(connId, db)); }}>Aggiorna</button>
        <button onClick={savePng}>Esporta PNG</button>
        <button onClick={saveSvg}>Esporta SVG</button>
      </div>
      {linkMode && <div className="er-hint">Trascina dalla colonna della tabella figlia (es. customer_id) alla colonna riferita della tabella padre (es. id). Esc per uscire.</div>}
      <svg ref={svg} className={`er-canvas${linkMode ? ' linking' : ''}`} onMouseDown={(e) => drag(e, null)} onWheel={onWheel}>
        <style>{ER_CSS}</style>
        <g className="root" transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {model.fks.map((fk) => {
            const child = boxOf(fk.table);
            const parent = boxOf(fk.refTable);
            const r = relationPath(child, rowY(child, colIndex(fk.table, fk.columns[0])), parent, rowY(parent, colIndex(fk.refTable, fk.refColumns[0])));
            const optional = fk.columns.some((c) => model.tables.find((t) => t.name === fk.table)?.columns.find((x) => x.name === c)?.nullable);
            const fkKey = `${fk.table}/${fk.name}`;
            const state = picked === fkKey ? ' picked' : !focus ? '' : fk.table === focus || fk.refTable === focus ? ' hi' : ' dim';
            return (
              <g key={fkKey} className={`er-r${optional ? ' opt' : ''}${state}`}
                onMouseDown={(e) => { e.stopPropagation(); setPicked(fkKey); }}
                onContextMenu={(e) => { setPicked(fkKey); openMenu(e, [
                  { label: `Modifica ${fk.table}…`, action: () => openDesigner(connId, db, fk.table) },
                  { label: 'Elimina relazione…', danger: true, action: () => dropRelation(fkKey) },
                ]); }}>
                <path className="hit" d={r.d} />
                <title>{`${fk.name}: ${fk.table}(${fk.columns.join(', ')}) → ${fk.refTable}(${fk.refColumns.join(', ')})`}</title>
                <path className="line" d={r.d} />
                <path d={ends(r)} />
              </g>
            );
          })}
          {model.tables.map((t) => {
            const b = boxOf(t.name);
            const cols = shown[t.name];
            const fks = fkCols.get(t.name) ?? new Set<string>();
            const typeX = b.w - 8;
            return (
              <g key={t.name} className={`er-t ${t.kind}${sel === t.name ? ' sel' : ''}`} transform={`translate(${b.x} ${b.y})`}
                onMouseDown={(e) => drag(e, t.name)} onMouseEnter={() => setHover(t.name)} onMouseLeave={() => setHover(null)}
                onDoubleClick={() => (t.kind === 'table' ? openDesigner(connId, db, t.name) : showDdl(connId, db, 'view', t.name))}
                onContextMenu={(e) => tableMenu(e, t.name, t.kind)}>
                <title>{[t.name, t.comment, t.rows !== null ? `~${t.rows.toLocaleString('it-IT')} righe` : ''].filter(Boolean).join('\n')}</title>
                <rect className="body" width={b.w} height={b.h} rx="5" />
                <rect className="head" width={b.w} height={HEADER} rx="5" />
                <rect className="head" y={HEADER - 6} width={b.w} height="6" />
                <text className="name" x="10" y={HEADER / 2 + 4.5}>{t.name}</text>
                {cols.map((c, i) => {
                  const y = HEADER + i * ROW + ROW / 2 + 7;
                  return (
                    <g key={c.name} data-table={t.name} data-col={c.name} onMouseDown={(e) => startLink(e, t.name, c.name)}>
                      <rect className="row-hit" x="1" y={HEADER + i * ROW + 1} width={b.w - 2} height={ROW} />
                      {c.pk && <text className="key" x="8" y={y}>PK</text>}
                      {!c.pk && fks.has(c.name) && <text className="fk" x="8" y={y}>FK</text>}
                      <text className={c.pk ? 'pk' : ''} x="30" y={y}>{c.name}{c.nullable ? '' : ''}</text>
                      <text className="type" x={typeX} y={y} textAnchor="end">{c.type}</text>
                    </g>
                  );
                })}
                {saved.keysOnly && cols.length < t.columns.length && <text className="more" x="30" y={HEADER + cols.length * ROW + ROW / 2 + 7}>+{t.columns.length - cols.length} colonne</text>}
              </g>
            );
          })}
          {link && <path className="er-link" d={`M ${link.x} ${link.y} L ${link.tx} ${link.ty}`} />}
        </g>
      </svg>
      {newFk && <NewRelation db={db} model={entry!.data!} fk={newFk} onClose={() => setNewFk(null)} onCreate={async (sql) => { if (await runDdl([sql])) { setNewFk(null); setLinkMode(false); } }} />}
    </div>
  );
}

/** Confirmation of a relation drawn on the diagram, with name, rules and a type check. */
function NewRelation({ db, model, fk, onClose, onCreate }: {
  db: string;
  model: ErModel;
  fk: { table: string; col: string; refTable: string; refCol: string };
  onClose: () => void;
  onCreate: (sql: string) => void;
}) {
  const [name, setName] = useState(`fk_${fk.table}_${fk.refTable}`.slice(0, 64));
  const [onDelete, setOnDelete] = useState('RESTRICT');
  const [onUpdate, setOnUpdate] = useState('RESTRICT');
  const child = model.tables.find((t) => t.name === fk.table)?.columns.find((c) => c.name === fk.col);
  const parent = model.tables.find((t) => t.name === fk.refTable)?.columns.find((c) => c.name === fk.refCol);
  const norm = (t?: string) => (t ?? '').toLowerCase().replace(/\(\d+\)/, '').replace(/\s+zerofill/, '');
  const warnings = [
    norm(child?.type) !== norm(parent?.type) ? `Tipi diversi: ${fk.col} è ${child?.type}, ${fk.refCol} è ${parent?.type}. MariaDB rifiuterà la relazione se non compatibili.` : '',
    parent && !parent.pk ? `${fk.refTable}.${fk.refCol} non è chiave primaria: serve almeno un indice su quella colonna.` : '',
    (onDelete === 'SET NULL' || onUpdate === 'SET NULL') && child && !child.nullable ? `SET NULL richiede che ${fk.col} ammetta NULL.` : '',
  ].filter(Boolean);
  const sql = `ALTER TABLE ${qi(db)}.${qi(fk.table)} ADD CONSTRAINT ${qi(name)} FOREIGN KEY (${qi(fk.col)}) REFERENCES ${qi(fk.refTable)} (${qi(fk.refCol)}) ON DELETE ${onDelete} ON UPDATE ${onUpdate}`;
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="modal-title">Nuova relazione</div>
        <div className="form">
          <p className="note"><b>{fk.table}</b>.{fk.col} → <b>{fk.refTable}</b>.{fk.refCol}</p>
          <label>Nome<input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
          <div className="row">
            <label className="grow">ON DELETE<select value={onDelete} onChange={(e) => setOnDelete(e.target.value)}>{FK_RULES.map((r) => <option key={r}>{r}</option>)}</select></label>
            <label className="grow">ON UPDATE<select value={onUpdate} onChange={(e) => setOnUpdate(e.target.value)}>{FK_RULES.map((r) => <option key={r}>{r}</option>)}</select></label>
          </div>
          {warnings.map((w) => <div key={w} className="status error">{w}</div>)}
          <pre className="sql-preview">{sql}</pre>
        </div>
        <div className="modal-buttons">
          <div className="spacer" />
          <button onClick={onClose}>Annulla</button>
          <button className="primary" disabled={!name.trim()} onClick={() => onCreate(sql)}>Crea relazione</button>
        </div>
      </div>
    </div>
  );
}
