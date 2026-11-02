import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Cell, Column } from '../types';
import { t } from '../i18n';

const RH = 22;      // row height
const LH = 17;      // line height of taller rows (text wrapped, newlines kept)
const FIT_MAX = 600; // tallest row "fit to content" makes; taller content scrolls inside the cell
const TEXT_MAX = 20000; // characters a taller cell shows
const NUM_W = 48;   // row number column
const NUMERIC = new Set(['TINY', 'SHORT', 'LONG', 'INT', 'INT24', 'LONGLONG', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR',
  // T-SQL (Microsoft Fabric / SQL Server) result columns
  'SMALLINT', 'TINYINT', 'NUMERIC', 'MONEY', 'SMALLMONEY', 'REAL']);

export const isNumeric = (c: Column) => NUMERIC.has(c.type);

/** A grid cell: undefined is the DEFAULT of a row not yet inserted. */
export type GridCell = Cell | undefined;
export type RowState = 'new' | 'deleted' | undefined;

/** Editing hooks; row indices are positions in the `rows` prop (before the grid's own sorting). */
export interface GridEditing {
  canEdit(col: number, row: number): boolean;
  edited(row: number, col: number): boolean;
  state(row: number): RowState;
  onEdit(row: number, col: number, value: Cell): void;
  onDeleteRows(rows: number[]): void;
}

export interface GridSelection {
  rows: number[];
  cols: number[];
  focus: { row: number; col: number } | null;
}

type Pos = [row: number, col: number];

const text = (v: GridCell) => (v === null || v === undefined ? '' : String(v));
const display = (v: GridCell, tall: boolean) => {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (tall) return s.length > TEXT_MAX ? s.slice(0, TEXT_MAX) + '…' : s;
  return (s.length > 2000 ? s.slice(0, 2000) + '…' : s).replace(/[\r\n\t]+/g, ' ');
};

let canvas: CanvasRenderingContext2D | null = null;
/** Text width in the grid font (bold for headers). */
function measure(s: string, bold = false) {
  canvas ??= document.createElement('canvas').getContext('2d')!;
  const font = `${bold ? '600 ' : ''}12.5px ${getComputedStyle(document.body).fontFamily}`;
  if (canvas.font !== font) canvas.font = font;
  return canvas.measureText(s).width;
}
const tabs = (s: string) => s.replace(/\t/g, '    ');

/** Lines a value takes when wrapped at `avail` px, like white-space: pre-wrap. Stops at `cap`. */
function wrappedLines(s: string, avail: number, cap: number) {
  let n = 0;
  for (const raw of s.slice(0, TEXT_MAX).split(/\r?\n/)) {
    if (n >= cap) break;
    const line = tabs(raw);
    n++;
    if (line.length * 12 <= avail || measure(line) <= avail) continue;
    let x = 0;
    for (const word of line.split(/(?<= )/)) {
      const w = measure(word);
      if (x + w <= avail || word.trim() === '') { x += w; continue; }
      if (x > 0) n++;
      n += Math.ceil(w / avail) - 1; // a word longer than the cell breaks anywhere
      x = w % avail;
    }
  }
  return Math.min(n, cap);
}

/** Width that shows the longest line of the column (header included). */
function fitWidth(col: Column, rows: GridCell[][], j: number) {
  let w = measure(col.name, true) + 20;
  for (let r = 0; r < Math.min(rows.length, 5000); r++) {
    const v = rows[r][j];
    if (v === null || v === undefined) { w = Math.max(w, 40); continue; }
    for (const line of String(v).slice(0, 2000).split(/\r?\n/)) w = Math.max(w, measure(tabs(line)));
  }
  return Math.max(40, Math.min(2000, Math.ceil(w + 14)));
}

/** TSV like spreadsheets expect: values with tabs, newlines or quotes are quoted. */
const tsv = (v: GridCell) => {
  const s = text(v);
  return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function initialWidths(columns: Column[], rows: GridCell[][]) {
  return columns.map((c, i) => {
    let len = c.name.length + 2;
    for (let r = 0; r < Math.min(rows.length, 200); r++) {
      const v = rows[r][i];
      len = Math.max(len, v === null || v === undefined ? 6 : Math.min(String(v).length, 60));
    }
    return Math.max(60, Math.min(360, Math.round(len * 7.4 + 16)));
  });
}

/** Size actions for the context menu; rows are indices in the `rows` prop, like GridSelection. */
export interface GridLayout {
  fitColumns(cols: number[]): void;
  fitRows(rows: number[]): void;
  reset(): void;
}

interface Props {
  columns: Column[];
  rows: GridCell[][];
  editing?: GridEditing;
  /** Every row as tall as its content (wrapped text, newlines and tabs kept). */
  expand?: boolean;
  onMenu?: (e: React.MouseEvent, sel: GridSelection, layout: GridLayout) => void;
}

export default function ResultGrid({ columns, rows, editing, expand, onMenu }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(300);
  const [widths, setWidths] = useState(() => initialWidths(columns, rows));
  // heights set by hand or by "fit", per row of `rows`; they win over `expand`
  const [heights, setHeights] = useState<Map<number, number>>(() => new Map());
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [focus, setFocus] = useState<Pos | null>(null);
  const [edit, setEdit] = useState<{ pos: Pos; value: string } | null>(null);

  // New result: fresh layout. Edits and filters only change `rows`, so widths and sorting stay.
  useEffect(() => {
    setWidths(initialWidths(columns, rows));
    setHeights(new Map());
    setSort(null);
    setAnchor(null);
    setFocus(null);
    setEdit(null);
    box.current?.scrollTo(0, 0);
  }, [columns]);

  useLayoutEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const order = useMemo(() => {
    const idx = rows.map((_, i) => i);
    if (!sort) return idx;
    const num = isNumeric(columns[sort.col]);
    return idx.sort((a, b) => {
      const x = rows[a][sort.col] ?? null;
      const y = rows[b][sort.col] ?? null;
      if (x === y) return 0;
      if (x === null) return -sort.dir;
      if (y === null) return sort.dir;
      const c = num ? Number(x) - Number(y) : String(x).localeCompare(String(y), 'it', { numeric: true });
      return c * sort.dir;
    });
  }, [rows, columns, sort]);

  const lefts = useMemo(() => {
    const out = [NUM_W];
    for (const w of widths) out.push(out[out.length - 1] + w);
    return out;
  }, [widths]);
  const totalW = lefts[lefts.length - 1];

  const fitRow = (src: number) => {
    let lines = 1;
    columns.forEach((_, j) => {
      const v = rows[src][j];
      if (v === null || v === undefined) return;
      const s = String(v);
      const avail = widths[j] - 12;
      if (s.length * 12 > avail || /[\r\n]/.test(s)) lines = Math.max(lines, wrappedLines(s, avail, Math.floor(FIT_MAX / LH)));
    });
    return lines > 1 ? Math.min(FIT_MAX, lines * LH + 6) : RH;
  };

  // tops[i] = y of display row i (after the header); tops[n] = content height
  const tops = useMemo(() => {
    const out = new Float64Array(order.length + 1);
    out[0] = RH;
    for (let i = 0; i < order.length; i++) out[i + 1] = out[i] + (heights.get(order[i]) ?? (expand ? fitRow(order[i]) : RH));
    return out;
  }, [order, heights, expand, expand && widths, expand && rows]);
  const rowAt = (y: number) => {
    let lo = 0, hi = order.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tops[mid + 1] <= y) lo = mid + 1; else hi = mid; }
    return lo;
  };

  const first = Math.max(0, rowAt(scroll) - 5);
  const last = Math.min(order.length, rowAt(scroll + height) + 5);
  const maxRow = order.length - 1;

  const sel = anchor && focus
    ? { r0: Math.min(anchor[0], focus[0]), r1: Math.min(maxRow, Math.max(anchor[0], focus[0])), c0: Math.min(anchor[1], focus[1]), c1: Math.max(anchor[1], focus[1]) }
    : null;
  const inSel = (r: number, c: number) => !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;

  const selection = (): GridSelection => {
    if (!sel) return { rows: [], cols: [], focus: null };
    const rs: number[] = [];
    for (let i = sel.r0; i <= sel.r1; i++) rs.push(order[i]);
    const cs: number[] = [];
    for (let j = sel.c0; j <= sel.c1; j++) cs.push(j);
    return { rows: rs, cols: cs, focus: focus && focus[0] <= maxRow ? { row: order[focus[0]], col: focus[1] } : null };
  };

  const reveal = (p: Pos) => {
    const el = box.current!;
    const top = tops[p[0]] - RH;
    const bottom = tops[p[0] + 1];
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = Math.min(top, bottom - el.clientHeight);
    const left = lefts[p[1]];
    const right = lefts[p[1] + 1];
    if (left - NUM_W < el.scrollLeft) el.scrollLeft = left - NUM_W;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  };

  const select = (p: Pos, extend: boolean) => {
    if (!extend || !anchor) setAnchor(p);
    setFocus(p);
    reveal(p);
  };

  const copy = (headers: boolean) => {
    const r = sel ?? { r0: 0, r1: maxRow, c0: 0, c1: columns.length - 1 };
    const lines: string[] = [];
    if (headers) lines.push(columns.slice(r.c0, r.c1 + 1).map((c) => c.name).join('\t'));
    for (let i = r.r0; i <= r.r1; i++) lines.push(rows[order[i]].slice(r.c0, r.c1 + 1).map(tsv).join('\t'));
    navigator.clipboard.writeText(lines.join('\n'));
  };

  const editable = (p: Pos) => !!editing && p[0] <= maxRow && editing.canEdit(p[1], order[p[0]]) && editing.state(order[p[0]]) !== 'deleted';

  /** Value viewer; for editable cells it edits too (long texts, JSON). */
  const view = (p: Pos) => {
    const v = rows[order[p[0]]][p[1]];
    let value = text(v);
    if (typeof v === 'string' && /^[[{]/.test(v)) { try { value = JSON.stringify(JSON.parse(v), null, 2); } catch { /* not JSON */ } }
    const row = order[p[0]];
    useStore.getState().set({
      viewer: {
        title: columns[p[1]].name,
        value: v === null ? '' : v === undefined ? '' : value,
        isNull: v === null,
        binary: columns[p[1]].binary,
        onSave: editable(p) ? (nv) => editing!.onEdit(row, p[1], nv) : undefined,
      },
    });
  };

  const startEdit = (p: Pos, initial?: string) => {
    if (!editable(p)) return false;
    if (columns[p[1]].binary) { view(p); return true; } // hex and file upload live in the value viewer
    setEdit({ pos: p, value: initial ?? text(rows[order[p[0]]][p[1]]) });
    return true;
  };

  const commit = (move?: Pos) => {
    if (!edit) return;
    const [i, j] = edit.pos;
    const before = rows[order[i]][j];
    // an untouched NULL/DEFAULT stays as it was: leaving the editor empty does not turn it into ''
    const unchanged = before === null || before === undefined ? edit.value === '' : edit.value === text(before);
    if (!unchanged) editing!.onEdit(order[i], j, edit.value);
    setEdit(null);
    box.current?.focus();
    if (move) select([Math.max(0, Math.min(maxRow, move[0])), Math.max(0, Math.min(columns.length - 1, move[1]))], false);
  };

  const setNull = () => {
    if (!editing || !sel) return;
    for (let i = sel.r0; i <= sel.r1; i++) {
      for (let j = sel.c0; j <= sel.c1; j++) if (editable([i, j])) editing.onEdit(order[i], j, null);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 'c') { e.preventDefault(); copy(e.shiftKey); return; }
    if (ctrl && k === 'a') { e.preventDefault(); setAnchor([0, 0]); setFocus([maxRow, columns.length - 1]); return; }
    if (ctrl && e.shiftKey && k === 'n') { e.preventDefault(); setNull(); return; }
    if (e.key === 'Delete' && editing && sel) { e.preventDefault(); editing.onDeleteRows(selection().rows); return; }
    if (!focus || focus[0] > maxRow) return;
    if (e.key === 'F2') { e.preventDefault(); startEdit(focus); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey || !startEdit(focus)) view(focus);
      return;
    }
    if (!ctrl && !e.altKey && e.key.length === 1 && editable(focus)) { e.preventDefault(); startEdit(focus, e.key); return; }
    const page = Math.max(1, Math.floor(height / RH) - 2);
    const moves: Record<string, Pos> = {
      ArrowDown: [focus[0] + 1, focus[1]],
      ArrowUp: [focus[0] - 1, focus[1]],
      ArrowLeft: [focus[0], focus[1] - 1],
      ArrowRight: [focus[0], focus[1] + 1],
      Tab: [focus[0], focus[1] + (e.shiftKey ? -1 : 1)],
      PageDown: [focus[0] + page, focus[1]],
      PageUp: [focus[0] - page, focus[1]],
      Home: ctrl ? [0, 0] : [focus[0], 0],
      End: ctrl ? [maxRow, columns.length - 1] : [focus[0], columns.length - 1],
    };
    const to = moves[e.key];
    if (!to) return;
    e.preventDefault();
    select([Math.max(0, Math.min(maxRow, to[0])), Math.max(0, Math.min(columns.length - 1, to[1]))], e.shiftKey && e.key !== 'Tab');
  };

  const onEditKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (!edit) return;
    const [i, j] = edit.pos;
    if (e.key === 'Escape') { e.preventDefault(); setEdit(null); box.current?.focus(); }
    else if (e.key === 'Enter' && e.altKey) {
      // Alt+Enter: new line inside the value, like spreadsheets
      e.preventDefault();
      const el = e.currentTarget;
      const a = el.selectionStart, b = el.selectionEnd;
      setEdit({ ...edit, value: edit.value.slice(0, a) + '\n' + edit.value.slice(b) });
      requestAnimationFrame(() => el.setSelectionRange(a + 1, a + 1));
    }
    else if (e.key === 'Enter') { e.preventDefault(); commit([i + (e.shiftKey ? -1 : 1), j]); }
    else if (e.key === 'Tab') { e.preventDefault(); commit([i, j + (e.shiftKey ? -1 : 1)]); }
    else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); editing!.onEdit(order[i], j, null); setEdit(null); box.current?.focus(); }
  };

  const startResize = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[i];
    const move = (ev: MouseEvent) => setWidths((ws) => ws.map((w, j) => (j === i ? Math.max(40, w0 + ev.clientX - x0) : w)));
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  /** Drag the bottom edge of a row number: that row, or every selected row when it is one of them. */
  const startRowResize = (e: React.MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    const y0 = e.clientY;
    const h0 = tops[i + 1] - tops[i];
    const targets = sel && i >= sel.r0 && i <= sel.r1 ? selection().rows : [order[i]];
    const move = (ev: MouseEvent) => {
      const h = Math.max(RH, Math.min(5000, h0 + ev.clientY - y0));
      setHeights((hs) => { const m = new Map(hs); for (const r of targets) m.set(r, h); return m; });
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const layout: GridLayout = {
    fitColumns: (cols) => setWidths((ws) => ws.map((w, j) => (cols.includes(j) ? fitWidth(columns[j], rows, j) : w))),
    fitRows: (rs) => setHeights((hs) => { const m = new Map(hs); for (const r of rs) m.set(r, fitRow(r)); return m; }),
    reset: () => { setWidths(initialWidths(columns, rows)); setHeights(new Map()); },
  };
  const fitRowAt = (i: number) => layout.fitRows(sel && i >= sel.r0 && i <= sel.r1 ? selection().rows : [order[i]]);
  const menu = onMenu && ((e: React.MouseEvent) => onMenu(e, selection(), layout));

  const dragging = useRef(false);
  useEffect(() => {
    const up = () => { dragging.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const rowsOut = [];
  for (let i = first; i < last; i++) {
    const src = order[i];
    const row = rows[src];
    const rowSel = !!sel && i >= sel.r0 && i <= sel.r1;
    const state = editing?.state(src);
    const h = tops[i + 1] - tops[i];
    const tall = h > RH;
    rowsOut.push(
      <div key={i} className={`grid-row${i % 2 ? ' odd' : ''}${state ? ' ' + state : ''}`} style={{ top: tops[i], width: totalW, height: h }}>
        <div className={`grid-num${rowSel ? ' sel' : ''}`} style={{ width: NUM_W, height: h }}
          onMouseDown={(e) => { if (e.button !== 0 && rowSel) return; setAnchor([e.shiftKey && anchor ? anchor[0] : i, 0]); setFocus([i, columns.length - 1]); }}
          onContextMenu={menu}>
          {state === 'new' ? '*' : i + 1}
          <div className="grid-rresize" title={t('Trascina per cambiare l\'altezza, doppio clic per adattarla al contenuto')}
            onMouseDown={(e) => startRowResize(e, i)} onDoubleClick={(e) => { e.stopPropagation(); fitRowAt(i); }} />
        </div>
        {columns.map((c, j) => {
          const v = row[j];
          const d = display(v, tall);
          const focused = focus && focus[0] === i && focus[1] === j;
          return (
            <div key={j}
              className={`grid-cell${isNumeric(c) ? ' num' : ''}${tall ? ' tall' : ''}${inSel(i, j) ? ' sel' : ''}${focused ? ' focus' : ''}${editing?.edited(src, j) ? ' edited' : ''}`}
              style={{ left: lefts[j], width: widths[j], height: h }}
              title={!tall && typeof v === 'string' && v.length > 40 ? v.slice(0, 2000) : undefined}
              onMouseDown={(e) => {
                if (e.button === 2 && inSel(i, j)) return; // right click keeps a multi-cell selection for the menu
                if (e.button !== 1) { dragging.current = e.button === 0; select([i, j], e.shiftKey); }
              }}
              onMouseEnter={() => { if (dragging.current) setFocus([i, j]); }}
              onDoubleClick={() => { if (!startEdit([i, j])) view([i, j]); }}
              onContextMenu={menu}>
              {v === undefined ? <span className="null">{t('(predefinito)')}</span> : d === null ? <span className="null">NULL</span> : d}
            </div>
          );
        })}
      </div>,
    );
  }

  return (
    <div className="grid" ref={box} tabIndex={0} onKeyDown={onKey} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      <div style={{ height: tops[order.length], width: totalW, position: 'relative' }}>
        <div className="grid-head" style={{ width: totalW }}>
          <div className="grid-num head" style={{ width: NUM_W }} onMouseDown={() => { setAnchor([0, 0]); setFocus([maxRow, columns.length - 1]); }} />
          {columns.map((c, j) => (
            <div key={j} className={`grid-hcell${isNumeric(c) ? ' num' : ''}`} style={{ left: lefts[j], width: widths[j] }}
              title={`${c.orgTable ? `${c.db ? c.db + '.' : ''}${c.orgTable}.${c.orgName}` : c.name}\n${c.type}${c.notNull ? ' NOT NULL' : ''}${c.autoIncrement ? ' AUTO_INCREMENT' : ''}`}
              onClick={(e) => {
                if (e.shiftKey) { setAnchor([0, j]); setFocus([maxRow, j]); return; }
                setSort((s) => (s?.col !== j ? { col: j, dir: 1 } : s.dir === 1 ? { col: j, dir: -1 } : null));
              }}>
              <span>{c.name}</span>
              {sort?.col === j && <span className="sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
              <div className="grid-resize" title={t('Trascina per cambiare la larghezza, doppio clic per adattarla al contenuto')}
                onMouseDown={(e) => startResize(e, j)} onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => { e.stopPropagation(); layout.fitColumns(sel && j >= sel.c0 && j <= sel.c1 ? selection().cols : [j]); }} />
            </div>
          ))}
        </div>
        {rowsOut}
        {edit && (() => {
          const rh = tops[edit.pos[0] + 1] - tops[edit.pos[0]];
          const multi = rh > RH || edit.value.includes('\n');
          const lines = edit.value.split('\n').length;
          return (
          <textarea className={`grid-editor${multi ? ' tall' : ''}`} autoFocus value={edit.value} wrap={multi ? 'soft' : 'off'} spellCheck={false}
            title={t('Invio conferma, Alt+Invio va a capo')}
            style={{ top: tops[edit.pos[0]], left: lefts[edit.pos[1]], width: Math.max(widths[edit.pos[1]], multi ? 240 : 120), height: multi ? Math.max(rh, Math.min(300, lines * LH + 8)) : RH }}
            onChange={(e) => setEdit({ ...edit, value: e.target.value })}
            onKeyDown={onEditKey}
            onBlur={() => commit()} />
          );
        })()}
      </div>
    </div>
  );
}
