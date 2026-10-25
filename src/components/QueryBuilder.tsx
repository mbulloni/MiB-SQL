import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { newDoc, persist, runDoc } from '../actions';
import type { ErModel } from '../er';
import {
  AGGREGATES, aliasFor, autoJoins, emptyQuery, OPS, qid, toSql, type JoinType, type QbColumn, type QbFilter, type QbModel, type QbTable,
} from '../qb';
import { metaKey, useStore, type MetaEntry } from '../store';
import type { DbObjects, Doc } from '../types';
import { openMenu } from './ContextMenu';
import ResultsPanel from './ResultsPanel';
import { t as tr } from '../i18n';

const W = 210;
const HEAD = 28;
const ROW = 21;
type Tab = 'columns' | 'filters' | 'options' | 'sql';

const NAME = /^`((?:[^`]|``)+)`\.`((?:[^`]|``)+)`$/;
const unq = (s: string) => s.replace(/``/g, '`');

export default function QueryBuilder({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const db = doc.db!;
  const m = doc.qb ?? emptyQuery();
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const objects = useStore((s) => s.meta[metaKey.objects(connId, db)]) as MetaEntry<DbObjects> | undefined;
  const er = useStore((s) => s.meta[`${connId}/${db}/er`]) as MetaEntry<ErModel> | undefined;
  const [tab, setTab] = useState<Tab>('columns');
  const [drag, setDrag] = useState<{ from: { t: string; col: string }; x: number; y: number; tx: number; ty: number } | null>(null);
  const [bottom, setBottom] = useState(260);
  const canvas = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connOpen) { useStore.getState().openConn(connId); return; }
    const L = useStore.getState().loadMeta;
    L(metaKey.objects(connId, db), () => api.meta.objects(connId, db));
    L(`${connId}/${db}/er`, () => api.meta.erModel(connId, db));
  }, [connOpen]);

  const set = (next: QbModel) => {
    useStore.getState().updateDoc(doc.id, { qb: next });
    persist();
  };

  const addTable = async (tdb: string, table: string, x?: number, y?: number) => {
    const cols = await useStore.getState().loadMeta(metaKey.columns(connId, tdb, table), () => api.meta.columns(connId, tdb, table));
    const cur = useStore.getState().docs.find((d) => d.id === doc.id)?.qb ?? emptyQuery();
    const t: QbTable = {
      id: qid('t'), db: tdb, table, alias: aliasFor(table, cur.tables.map((x) => x.alias)),
      x: x ?? 20 + cur.tables.length * (W + 60), y: y ?? 20 + (cur.tables.length % 2) * 40, columns: (cols ?? []).map((c) => c.name),
    };
    const joins = tdb === db && er?.data ? autoJoins(cur, t, er.data.fks.filter((f) => !f.refDb || f.refDb === db)) : [];
    set({ ...cur, tables: [...cur.tables, t], joins: [...cur.joins, ...joins] });
  };

  const removeTable = (id: string) => set({
    ...m,
    tables: m.tables.filter((t) => t.id !== id),
    joins: m.joins.filter((j) => j.left.t !== id && j.right.t !== id),
    columns: m.columns.filter((c) => c.t !== id),
    filters: m.filters.filter((f) => f.t !== id),
  });

  const toggleColumn = (t: string, col: string) => {
    const has = m.columns.find((c) => c.t === t && c.col === col);
    set({ ...m, columns: has ? m.columns.filter((c) => c !== has) : [...m.columns, { id: qid('c'), t, col, alias: '', agg: '', sort: '', output: true }] });
  };
  const setColumn = (id: string, patch: Partial<QbColumn>) => set({ ...m, columns: m.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  const setFilter = (id: string, patch: Partial<QbFilter>) => set({ ...m, filters: m.filters.map((f) => (f.id === id ? { ...f, ...patch } : f)) });

  const point = (e: { clientX: number; clientY: number }) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + canvas.current!.scrollLeft, y: e.clientY - r.top + canvas.current!.scrollTop };
  };

  const moveTable = (e: React.MouseEvent, t: QbTable) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input')) return;
    e.preventDefault();
    const p0 = point(e);
    const start = { x: t.x, y: t.y };
    let last = m;
    const move = (ev: MouseEvent) => {
      const p = point(ev);
      last = { ...m, tables: m.tables.map((x) => (x.id === t.id ? { ...x, x: Math.max(0, start.x + p.x - p0.x), y: Math.max(0, start.y + p.y - p0.y) } : x)) };
      useStore.getState().updateDoc(doc.id, { qb: last });
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); set(last); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  /** Click toggles the column; dragging onto a column of another table draws a join. */
  const columnDown = (e: React.MouseEvent, t: string, col: string) => {
    if (e.button !== 0 || (e.target as HTMLElement).tagName === 'INPUT') return;
    e.preventDefault();
    e.stopPropagation();
    const p0 = point(e);
    let dragging = false;
    const move = (ev: MouseEvent) => {
      const p = point(ev);
      if (!dragging && Math.abs(p.x - p0.x) + Math.abs(p.y - p0.y) > 4) dragging = true;
      if (dragging) setDrag({ from: { t, col }, x: p0.x, y: p0.y, tx: p.x, ty: p.y });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDrag(null);
      if (!dragging) { toggleColumn(t, col); return; }
      const hit = (ev.target as Element).closest?.('[data-qcol]');
      const rt = hit?.getAttribute('data-qt');
      const rc = hit?.getAttribute('data-qcol');
      if (rt && rc && rt !== t) set({ ...m, joins: [...m.joins, { id: qid('j'), left: { t, col }, right: { t: rt, col: rc }, type: 'INNER' }] });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const n = NAME.exec(e.dataTransfer.getData('text/plain'));
    if (!n) return;
    const p = point(e);
    addTable(unq(n[1]), unq(n[2]), Math.max(0, p.x - W / 2), Math.max(0, p.y - 12));
  };

  const rowCenter = (t: QbTable, col: string) => ({ y: t.y + HEAD + Math.max(0, t.columns.indexOf(col)) * ROW + ROW / 2 + 1 });
  const joinPath = (a: QbTable, ac: string, b: QbTable, bc: string) => {
    const ay = rowCenter(a, ac).y;
    const by = rowCenter(b, bc).y;
    const aRight = a.x + W < b.x;
    const bRight = b.x + W < a.x;
    const x1 = aRight ? a.x + W : bRight ? a.x : a.x + W;
    const x2 = aRight ? b.x : bRight ? b.x + W : b.x + W;
    const d1 = aRight ? 1 : bRight ? -1 : 1;
    const d2 = aRight ? -1 : bRight ? 1 : 1;
    const reach = Math.max(40, Math.abs(x2 - x1) / 2);
    return { d: `M ${x1} ${ay} C ${x1 + d1 * reach} ${ay}, ${x2 + d2 * reach} ${by}, ${x2} ${by}`, mx: (x1 + x2) / 2 + (d1 === d2 ? reach * 0.75 : 0), my: (ay + by) / 2 };
  };

  const byId = new Map(m.tables.map((t) => [t.id, t]));
  const allCols = m.tables.flatMap((t) => t.columns.map((c) => ({ key: `${t.id}|${c}`, label: `${t.alias}.${c}` })));
  const extent = {
    w: Math.max(800, ...m.tables.map((t) => t.x + W + 200)),
    h: Math.max(300, ...m.tables.map((t) => t.y + HEAD + t.columns.length * ROW + 120)),
  };
  const sql = toSql(m, db);
  const tables = objects?.data?.tables.map((t) => t.name) ?? [];
  const views = objects?.data?.views.map((v) => v.name) ?? [];

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = bottom;
    const move = (ev: MouseEvent) => setBottom(Math.max(80, h0 - (ev.clientY - y0)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="qb">
      <div className="er-bar">
        <select value="" onChange={(e) => { if (e.target.value) addTable(db, e.target.value); }}>
          <option value="">{tr('+ Aggiungi tabella…')}</option>
          {tables.length > 0 && <optgroup label={tr('Tabelle')}>{tables.map((t) => <option key={t}>{t}</option>)}</optgroup>}
          {views.length > 0 && <optgroup label={tr('Viste')}>{views.map((t) => <option key={t}>{t}</option>)}</optgroup>}
        </select>
        <button className="primary" disabled={!m.tables.length || doc.running} onClick={() => runDoc('all', doc.id)}>{tr('▶ Esegui')}</button>
        <button disabled={!sql} onClick={() => newDoc({ connId, db, sql: sql + ';\n' })}>{tr('Apri nell\'editor')}</button>
        <button disabled={!m.tables.length} onClick={() => set(emptyQuery())}>{tr('Svuota')}</button>
        <div className="spacer" />
        <span className="muted">{tr('Trascina le tabelle dall\'Explorer · clic su una colonna per selezionarla · trascina una colonna su un\'altra per un join')}</span>
      </div>
      <div className="qb-canvas" ref={canvas} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
        <div style={{ width: extent.w, height: extent.h, position: 'relative' }}>
          <svg className="qb-joins" width={extent.w} height={extent.h}>
            {m.joins.map((j) => {
              const a = byId.get(j.left.t);
              const b = byId.get(j.right.t);
              if (!a || !b) return null;
              const p = joinPath(a, j.left.col, b, j.right.col);
              const menu = (e: React.MouseEvent) => openMenu(e, [
                ...(['INNER', 'LEFT', 'RIGHT'] as JoinType[]).map((type) => ({
                  label: `${j.type === type ? '✓ ' : ''}${type} JOIN${type === 'LEFT' ? tr(' (tutte le righe di {0})', a.alias) : type === 'RIGHT' ? tr(' (tutte le righe di {0})', b.alias) : ''}`,
                  action: () => set({ ...m, joins: m.joins.map((x) => (x.id === j.id ? { ...x, type } : x)) }),
                })),
                'sep' as const,
                { label: tr('Elimina join'), danger: true, action: () => set({ ...m, joins: m.joins.filter((x) => x.id !== j.id) }) },
              ]);
              return (
                <g key={j.id} className="qb-join" onClick={menu} onContextMenu={menu}>
                  <path className="hit" d={p.d} />
                  <path d={p.d} />
                  <rect x={p.mx - 22} y={p.my - 9} width="44" height="18" rx="9" />
                  <text x={p.mx} y={p.my + 4} textAnchor="middle">{j.type}</text>
                </g>
              );
            })}
            {drag && <path className="qb-drag" d={`M ${drag.x} ${drag.y} L ${drag.tx} ${drag.ty}`} />}
          </svg>
          {m.tables.map((t) => (
            <div key={t.id} className="qb-t" style={{ left: t.x, top: t.y, width: W }}>
              <div className="qb-head" onMouseDown={(e) => moveTable(e, t)} title={`${t.db}.${t.table}`}>
                <span className="name">{t.table}</span>
                <input className="alias" value={t.alias} title={tr('Alias')}
                  onChange={(e) => set({ ...m, tables: m.tables.map((x) => (x.id === t.id ? { ...x, alias: e.target.value.replace(/[^\w$]/g, '') || x.alias } : x)) })} />
                <button title={tr('Rimuovi')} onClick={() => removeTable(t.id)}>×</button>
              </div>
              {t.columns.map((c) => {
                const on = m.columns.some((x) => x.t === t.id && x.col === c);
                return (
                  <div key={c} className={`qb-col${on ? ' on' : ''}`} data-qt={t.id} data-qcol={c} onMouseDown={(e) => columnDown(e, t.id, c)}>
                    <input type="checkbox" checked={on} onChange={() => toggleColumn(t.id, c)} />
                    <span>{c}</span>
                  </div>
                );
              })}
            </div>
          ))}
          {!m.tables.length && <div className="qb-empty">{tr('Trascina qui una tabella dal Database Explorer, oppure usa «+ Aggiungi tabella…».')}</div>}
        </div>
      </div>
      <div className="qb-design">
        <div className="tabs-row">
          {([['columns', tr('Colonne ({0})', m.columns.length)], ['filters', tr('Filtri ({0})', m.filters.length)], ['options', tr('Opzioni')], ['sql', 'SQL']] as [Tab, string][]).map(([k, l]) => (
            <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
          ))}
        </div>
        <div className="qb-panel">
          {tab === 'columns' && (m.columns.length ? (
            <table className="dtable">
              <thead><tr><th>{tr('Output')}</th><th>{tr('Colonna')}</th><th>{tr('Alias')}</th><th>{tr('Aggregato')}</th><th>{tr('Ordina')}</th><th /></tr></thead>
              <tbody>
                {m.columns.map((c, i) => (
                  <tr key={c.id}>
                    <td className="c"><input type="checkbox" checked={c.output} onChange={(e) => setColumn(c.id, { output: e.target.checked })} /></td>
                    <td>{byId.get(c.t)?.alias}.{c.col}</td>
                    <td><input value={c.alias} placeholder="—" onChange={(e) => setColumn(c.id, { alias: e.target.value })} /></td>
                    <td><select value={c.agg} onChange={(e) => setColumn(c.id, { agg: e.target.value as QbColumn['agg'] })}>{AGGREGATES.map((a) => <option key={a} value={a}>{a || '—'}</option>)}</select></td>
                    <td><select value={c.sort} onChange={(e) => setColumn(c.id, { sort: e.target.value as QbColumn['sort'] })}><option value="">—</option><option>ASC</option><option>DESC</option></select></td>
                    <td className="act">
                      <button disabled={i === 0} onClick={() => { const cs = [...m.columns]; [cs[i - 1], cs[i]] = [cs[i], cs[i - 1]]; set({ ...m, columns: cs }); }}>↑</button>
                      <button disabled={i === m.columns.length - 1} onClick={() => { const cs = [...m.columns]; [cs[i + 1], cs[i]] = [cs[i], cs[i + 1]]; set({ ...m, columns: cs }); }}>↓</button>
                      <button className="danger" onClick={() => set({ ...m, columns: m.columns.filter((x) => x.id !== c.id) })}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty">{tr('Nessuna colonna selezionata: SELECT *. Spunta le colonne nelle tabelle.')}</div>)}
          {tab === 'filters' && <>
            <table className="dtable">
              <thead><tr><th>{tr('Colonna')}</th><th>{tr('Operatore')}</th><th>{tr('Valore')}</th><th title={tr('Condizione sull\'aggregato (HAVING)')}>{tr('Su aggregato')}</th><th /></tr></thead>
              <tbody>
                {m.filters.map((f) => (
                  <tr key={f.id}>
                    <td><select value={`${f.t}|${f.col}`} onChange={(e) => { const [t, col] = e.target.value.split('|'); setFilter(f.id, { t, col }); }}>
                      {allCols.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                    </select></td>
                    <td><select value={f.op} onChange={(e) => setFilter(f.id, { op: e.target.value as QbFilter['op'] })}>{OPS.map((o) => <option key={o}>{o}</option>)}</select></td>
                    <td><input value={f.value} disabled={f.op === 'IS NULL' || f.op === 'IS NOT NULL'}
                      placeholder={f.op === 'IN' || f.op === 'NOT IN' ? 'a, b, c' : f.op === 'BETWEEN' ? tr('da e a') : f.op.includes('LIKE') ? '%testo%' : 'valore'}
                      onChange={(e) => setFilter(f.id, { value: e.target.value })} /></td>
                    <td className="c"><input type="checkbox" checked={f.having} disabled={!m.columns.some((c) => c.t === f.t && c.col === f.col && c.agg)} onChange={(e) => setFilter(f.id, { having: e.target.checked })} /></td>
                    <td className="act"><button className="danger" onClick={() => set({ ...m, filters: m.filters.filter((x) => x.id !== f.id) })}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="add" disabled={!allCols.length} onClick={() => {
              const [t, col] = allCols[0].key.split('|');
              set({ ...m, filters: [...m.filters, { id: qid('f'), t, col, op: '=', value: '', having: false }] });
            }}>{tr('+ Aggiungi filtro')}</button>
          </>}
          {tab === 'options' && (
            <div className="form qb-options">
              <label className="check"><input type="checkbox" checked={m.distinct} onChange={(e) => set({ ...m, distinct: e.target.checked })} />{' '}{tr('DISTINCT (righe uniche)')}</label>
              <label>LIMIT<input value={m.limit} placeholder={tr('nessun limite')} onChange={(e) => set({ ...m, limit: e.target.value })} /></label>
            </div>
          )}
          {tab === 'sql' && <pre className="script">{sql || tr('-- Aggiungi una tabella.')}</pre>}
        </div>
      </div>
      <div className="hsplit" onMouseDown={startResize} />
      <div style={{ height: bottom }} className="bottom"><ResultsPanel doc={doc} /></div>
    </div>
  );
}
