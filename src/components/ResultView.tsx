import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { logMessage, newDoc } from '../actions';
import {
  addRow, editCount, editTarget, emptyEdits, inline, isEdited, keyAfter, setCell, statements, toggleDelete, valueAt, type Edits,
} from '../edits';
import { editsBySet, metaKey, useStore, type MetaEntry } from '../store';
import type { Cell, Doc, IndexInfo, ResultSet } from '../types';
import { openMenu, type MenuItem } from './ContextMenu';
import ResultGrid, { type GridCell, type GridEditing, type GridSelection } from './ResultGrid';

interface Filter { col: number; op: 'eq' | 'ne'; value: Cell }

const shown = (v: Cell) => (v === null ? 'NULL' : String(v).length > 30 ? String(v).slice(0, 30) + '…' : String(v));
const INTEGER = new Set(['TINY', 'SHORT', 'LONG', 'INT', 'INT24', 'YEAR']);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const READ_ONLY_SQL = /^\s*(\(\s*)?(select|with|show|table|values|desc|describe|explain)\b/i;

/** Grid of one result set with filtering, editing (single table with key) and export. */
export default function ResultView({ doc, set, sql, at }: { doc: Doc; set: ResultSet; sql: string; at: [number, number] }) {
  const [edits, setEditsState] = useState<Edits>(() => editsBySet.get(set) ?? emptyEdits());
  const [filters, setFilters] = useState<Filter[]>([]);
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setEdits = (e: Edits) => { editsBySet.set(set, e); setEditsState(e); };
  // after an apply the set is replaced: start from its own (empty) edits, keep the filters
  useEffect(() => { setEditsState(editsBySet.get(set) ?? emptyEdits()); }, [set]);

  const columns = set.columns;
  const rows = set.rows;
  const connId = doc.connId;
  const first = columns[0];
  const indexKey = connId && first?.orgTable && first.db ? metaKey.indexes(connId, first.db, first.orgTable) : null;
  const indexes = useStore((s) => (indexKey ? s.meta[indexKey] : undefined)) as MetaEntry<IndexInfo[]> | undefined;
  const connOpen = useStore((s) => (connId ? s.connState[connId]?.status === 'open' : false));
  useEffect(() => {
    if (indexKey && connOpen) useStore.getState().loadMeta(indexKey, () => api.meta.indexes(connId!, first.db, first.orgTable));
  }, [indexKey, connOpen]);
  const target = editTarget(columns, indexes?.error ? [] : indexes?.data);
  const canEdit = typeof target !== 'string' && connOpen;
  const pending = editCount(edits);

  // positions shown: result rows (not filtered out) then new rows, always visible
  const ids = useMemo(() => {
    const q = search.trim().toLowerCase();
    const out: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      const v = (c: number) => valueAt(rows, edits, r, c) ?? null;
      if (filters.some((f) => (f.op === 'eq') !== (v(f.col) === f.value || (v(f.col) !== null && f.value !== null && String(v(f.col)) === String(f.value))))) continue;
      if (q && !columns.some((_, c) => String(v(c) ?? '').toLowerCase().includes(q))) continue;
      out.push(r);
    }
    for (let k = 0; k < edits.inserted.length; k++) out.push(rows.length + k);
    return out;
  }, [rows, edits, filters, search, columns]);

  const gridRows = useMemo<GridCell[][]>(() => ids.map((r) => columns.map((_, c) => valueAt(rows, edits, r, c))), [ids, rows, edits, columns]);

  const editing: GridEditing | undefined = canEdit ? {
    canEdit: (c) => !columns[c].binary, // hex text would be written as text: binary editing is not supported yet
    edited: (i, c) => isEdited(rows, edits, ids[i], c),
    state: (i) => (ids[i] >= rows.length ? 'new' : edits.deleted.includes(ids[i]) ? 'deleted' : undefined),
    onEdit: (i, c, v) => setEdits(setCell(editsBySet.get(set) ?? edits, rows, ids[i], c, typed(c, v))),
    onDeleteRows: (is) => setEdits(toggleDelete(edits, rows, is.map((i) => ids[i]))),
  } : undefined;

  // integers typed in the grid go as numbers (previews without quotes); DECIMAL/BIGINT stay strings for precision
  const typed = (c: number, v: Cell): Cell => (typeof v === 'string' && INTEGER.has(columns[c].type) && /^-?\d{1,15}$/.test(v.trim()) ? Number(v) : v);

  const stmts = () => statements(target as Exclude<typeof target, string>, columns, rows, edits);

  /** Applies in one transaction, then re-reads the touched rows (DEFAULTs, triggers, ON UPDATE). */
  const apply = async () => {
    if (typeof target === 'string' || !connId || !pending) return;
    setBusy(true);
    setPreview(null);
    try {
      const st = stmts();
      const res = await api.data.apply(connId, st);
      const inserts = res.slice(st.length - edits.inserted.length);
      const cols = columns.map((c) => '`' + c.orgName.replace(/`/g, '``') + '`').join(', ');
      const from = '`' + target.db.replace(/`/g, '``') + '`.`' + target.table.replace(/`/g, '``') + '`';
      const where = target.key.map((k) => '`' + columns[k].orgName.replace(/`/g, '``') + '` = ?').join(' AND ');
      const reread = async (key: Cell[] | null, fallback: Cell[]) => {
        if (!key) return fallback;
        try { return (await api.data.select(connId, `SELECT ${cols} FROM ${from} WHERE ${where} LIMIT 1`, key))[0] ?? fallback; } catch { return fallback; }
      };
      const merged = (r: number) => columns.map((_, c) => valueAt(rows, edits, r, c) ?? null);
      const next: Cell[][] = [];
      for (let r = 0; r < rows.length; r++) {
        if (edits.deleted.includes(r)) continue;
        next.push(edits.updates[r] ? await reread(keyAfter(target, columns, rows, edits, r, null), merged(r)) : rows[r]);
      }
      for (let k = 0; k < edits.inserted.length; k++) {
        const r = rows.length + k;
        next.push(await reread(keyAfter(target, columns, rows, edits, r, inserts[k]?.insertId ?? null), merged(r)));
      }
      const updated = Object.keys(edits.updates).filter((r) => !edits.deleted.includes(Number(r))).length;
      const counts = [
        updated && plural(updated, 'aggiornata', 'aggiornate'),
        edits.inserted.length && plural(edits.inserted.length, 'inserita', 'inserite'),
        edits.deleted.length && plural(edits.deleted.length, 'eliminata', 'eliminate'),
      ].filter(Boolean).join(', ');
      const nextSet: ResultSet = { ...set, rows: next, total: set.total - edits.deleted.length + edits.inserted.length };
      editsBySet.delete(set);
      useStore.getState().updateDoc(doc.id, (d) => ({
        run: d.run && {
          ...d.run,
          results: d.run.results.map((x, i) => (i !== at[0] ? x : { ...x, sets: x.sets.map((s, j) => (j === at[1] ? nextSet : s)) })),
        },
      }));
      logMessage(doc.id, 'ok', `Modifiche applicate a ${target.table}, righe: ${counts}.`);
    } catch (err) {
      logMessage(doc.id, 'error', (err as Error).message);
      await api.confirm('Modifiche non applicate', (err as Error).message, ['OK']);
    } finally {
      setBusy(false);
    }
  };

  const copy = (sel: GridSelection, headers: boolean) => {
    const lines = headers ? [sel.cols.map((c) => columns[c].name).join('\t')] : [];
    for (const i of sel.rows) lines.push(sel.cols.map((c) => { const v = gridRows[i][c]; return v === null || v === undefined ? '' : String(v); }).join('\t'));
    navigator.clipboard.writeText(lines.join('\n'));
  };

  const menu = (e: React.MouseEvent, sel: GridSelection) => {
    const f = sel.focus;
    const v = f ? gridRows[f.row][f.col] ?? null : null;
    const items: MenuItem[] = [
      { label: 'Copia', action: () => copy(sel, false), disabled: !sel.rows.length },
      { label: 'Copia con intestazioni', action: () => copy(sel, true), disabled: !sel.rows.length },
    ];
    if (f) {
      items.push('sep',
        { label: `Filtra per «${shown(v)}»`, action: () => setFilters((fs) => [...fs, { col: f.col, op: 'eq', value: v }]) },
        { label: `Escludi «${shown(v)}»`, action: () => setFilters((fs) => [...fs, { col: f.col, op: 'ne', value: v }]) });
    }
    if (filters.length) items.push({ label: 'Rimuovi filtri', action: () => setFilters([]) });
    if (editing) {
      const deleted = sel.rows.length > 0 && sel.rows.every((i) => editing.state(i) === 'deleted');
      items.push('sep',
        { label: 'Imposta NULL', action: () => { let x = editsBySet.get(set) ?? edits; for (const i of sel.rows) for (const c of sel.cols) if (editing.state(i) !== 'deleted') x = setCell(x, rows, ids[i], c, null); setEdits(x); }, disabled: !sel.rows.length },
        { label: 'Aggiungi riga', action: () => setEdits(addRow(edits)) },
        { label: deleted ? 'Ripristina righe' : 'Elimina righe', danger: !deleted, action: () => editing.onDeleteRows(sel.rows), disabled: !sel.rows.length });
    }
    openMenu(e, items);
  };

  const exportData = () => {
    const visible = ids.filter((r) => !edits.deleted.includes(r)).map((r) => columns.map((_, c) => valueAt(rows, edits, r, c) ?? null));
    const base = typeof target === 'string' ? (first?.orgTable || null) : target.table;
    useStore.getState().set({
      exportDialog: {
        columns,
        rows: visible,
        name: base || 'risultato',
        table: base || 'risultato',
        db: first?.db || null,
        query: connId && READ_ONLY_SQL.test(sql) ? { connId, db: doc.db, sql } : undefined,
        total: set.total,
        truncated: set.truncated,
        filtered: visible.length !== rows.length,
      },
    });
  };

  const discard = () => setEdits(emptyEdits());

  return (
    <div className="result-view">
      <div className="result-bar">
        <input className="search" placeholder="Filtra righe…" value={search} onChange={(e) => setSearch(e.target.value)} />
        {filters.map((f, i) => (
          <span key={i} className="chip">
            {columns[f.col].name} {f.op === 'eq' ? '=' : '≠'} {shown(f.value)}
            <button onClick={() => setFilters((fs) => fs.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
        {(search || filters.length > 0) && <span className="muted">{ids.length.toLocaleString('it-IT')} di {(rows.length + edits.inserted.length).toLocaleString('it-IT')}</span>}
        <div className="spacer" />
        {canEdit ? <>
          <button onClick={() => setEdits(addRow(edits))} title="Aggiungi riga">+ Riga</button>
          {pending > 0 && <>
            <span className="pending">{pending} {pending === 1 ? 'modifica' : 'modifiche'}</span>
            <button onClick={() => setPreview(stmts().map(inline).join(';\n') + ';')}>Anteprima SQL</button>
            <button onClick={discard} disabled={busy}>Annulla</button>
            <button className="primary" onClick={apply} disabled={busy}>{busy ? 'Applico…' : 'Applica'}</button>
          </>}
        </> : <span className="muted" title={typeof target === 'string' ? target : 'Connessione non aperta'}>🔒 {connOpen ? target as string : 'Sola lettura'}</span>}
        <button onClick={exportData} title="Esporta">Esporta…</button>
      </div>
      <ResultGrid columns={columns} rows={gridRows} editing={editing} onMenu={menu} />
      {preview !== null && (
        <div className="modal-back" onMouseDown={() => setPreview(null)}>
          <div className="modal viewer" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') setPreview(null); }}>
            <div className="modal-title">Anteprima modifiche <span className="hint">eseguite in un'unica transazione</span></div>
            <textarea readOnly autoFocus value={preview} />
            <div className="modal-buttons">
              <button onClick={() => navigator.clipboard.writeText(preview)}>Copia</button>
              <button onClick={() => { newDoc({ connId, db: doc.db, sql: `START TRANSACTION;\n${preview}\nCOMMIT;\n` }); setPreview(null); }}>Apri nell'editor</button>
              <div className="spacer" />
              <button onClick={() => setPreview(null)}>Chiudi</button>
              <button className="primary" onClick={apply} disabled={busy}>Applica</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
