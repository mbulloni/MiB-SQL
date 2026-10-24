import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import type { Cell, Column } from '../types';

const RH = 22;      // row height
const NUM_W = 48;   // row number column
const NUMERIC = new Set(['TINY', 'SHORT', 'LONG', 'INT', 'INT24', 'LONGLONG', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR']);

export const isNumeric = (c: Column) => NUMERIC.has(c.type);

type Pos = [row: number, col: number];

const text = (v: Cell) => (v === null ? '' : String(v));
const display = (v: Cell) => {
  if (v === null) return null;
  const s = String(v);
  return s.length > 300 ? s.slice(0, 300) + '…' : s.replace(/[\r\n\t]+/g, ' ');
};

/** TSV like spreadsheets expect: values with tabs, newlines or quotes are quoted. */
const tsv = (v: Cell) => {
  const s = text(v);
  return /[\t\n\r"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

function initialWidths(columns: Column[], rows: Cell[][]) {
  return columns.map((c, i) => {
    let len = c.name.length + 2;
    for (let r = 0; r < Math.min(rows.length, 200); r++) {
      const v = rows[r][i];
      len = Math.max(len, v === null ? 6 : Math.min(String(v).length, 60));
    }
    return Math.max(60, Math.min(360, Math.round(len * 7.4 + 16)));
  });
}

export default function ResultGrid({ columns, rows }: { columns: Column[]; rows: Cell[][] }) {
  const box = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(300);
  const [widths, setWidths] = useState(() => initialWidths(columns, rows));
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [anchor, setAnchor] = useState<Pos | null>(null);
  const [focus, setFocus] = useState<Pos | null>(null);

  useEffect(() => {
    setWidths(initialWidths(columns, rows));
    setSort(null);
    setAnchor(null);
    setFocus(null);
    box.current?.scrollTo(0, 0);
  }, [columns, rows]);

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
      const x = rows[a][sort.col];
      const y = rows[b][sort.col];
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

  const first = Math.max(0, Math.floor(scroll / RH) - 5);
  const last = Math.min(order.length, Math.ceil((scroll + height) / RH) + 5);

  const range = () => {
    if (!anchor || !focus) return null;
    return { r0: Math.min(anchor[0], focus[0]), r1: Math.max(anchor[0], focus[0]), c0: Math.min(anchor[1], focus[1]), c1: Math.max(anchor[1], focus[1]) };
  };
  const sel = range();
  const inSel = (r: number, c: number) => !!sel && r >= sel.r0 && r <= sel.r1 && c >= sel.c0 && c <= sel.c1;

  const select = (p: Pos, extend: boolean) => {
    if (!extend || !anchor) setAnchor(p);
    setFocus(p);
    const el = box.current!;
    const top = p[0] * RH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + RH * 2 > el.scrollTop + el.clientHeight) el.scrollTop = top + RH * 2 - el.clientHeight;
    const left = lefts[p[1]];
    const right = lefts[p[1] + 1];
    if (left - NUM_W < el.scrollLeft) el.scrollLeft = left - NUM_W;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  };

  const copy = (headers: boolean) => {
    const r = sel ?? { r0: 0, r1: order.length - 1, c0: 0, c1: columns.length - 1 };
    const lines: string[] = [];
    if (headers) lines.push(columns.slice(r.c0, r.c1 + 1).map((c) => c.name).join('\t'));
    for (let i = r.r0; i <= r.r1; i++) lines.push(rows[order[i]].slice(r.c0, r.c1 + 1).map(tsv).join('\t'));
    navigator.clipboard.writeText(lines.join('\n'));
  };

  const view = (p: Pos) => {
    const v = rows[order[p[0]]][p[1]];
    let value = text(v);
    if (typeof v === 'string' && /^[[{]/.test(v)) { try { value = JSON.stringify(JSON.parse(v), null, 2); } catch { /* not JSON */ } }
    useStore.getState().set({ viewer: { title: columns[p[1]].name, value: v === null ? 'NULL' : value } });
  };

  const onKey = (e: React.KeyboardEvent) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'c') { e.preventDefault(); copy(e.shiftKey); return; }
    if (ctrl && e.key.toLowerCase() === 'a') { e.preventDefault(); setAnchor([0, 0]); setFocus([order.length - 1, columns.length - 1]); return; }
    if (!focus) return;
    const page = Math.max(1, Math.floor(height / RH) - 2);
    const moves: Record<string, Pos> = {
      ArrowDown: [focus[0] + 1, focus[1]],
      ArrowUp: [focus[0] - 1, focus[1]],
      ArrowLeft: [focus[0], focus[1] - 1],
      ArrowRight: [focus[0], focus[1] + 1],
      PageDown: [focus[0] + page, focus[1]],
      PageUp: [focus[0] - page, focus[1]],
      Home: ctrl ? [0, 0] : [focus[0], 0],
      End: ctrl ? [order.length - 1, columns.length - 1] : [focus[0], columns.length - 1],
    };
    if (e.key === 'Enter') { e.preventDefault(); view(focus); return; }
    const to = moves[e.key];
    if (!to) return;
    e.preventDefault();
    select([Math.max(0, Math.min(order.length - 1, to[0])), Math.max(0, Math.min(columns.length - 1, to[1]))], e.shiftKey);
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

  const dragFrom = useRef<boolean>(false);
  useEffect(() => {
    const up = () => { dragFrom.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const rowsOut = [];
  for (let i = first; i < last; i++) {
    const row = rows[order[i]];
    const rowSel = !!sel && i >= sel.r0 && i <= sel.r1;
    rowsOut.push(
      <div key={i} className={`grid-row${i % 2 ? ' odd' : ''}`} style={{ top: (i + 1) * RH, width: totalW }}>
        <div className={`grid-num${rowSel ? ' sel' : ''}`} style={{ width: NUM_W }}
          onMouseDown={(e) => { setAnchor([e.shiftKey && anchor ? anchor[0] : i, 0]); setFocus([i, columns.length - 1]); }}>{i + 1}</div>
        {columns.map((c, j) => {
          const v = row[j];
          const d = display(v);
          const focused = focus && focus[0] === i && focus[1] === j;
          return (
            <div key={j}
              className={`grid-cell${isNumeric(c) ? ' num' : ''}${inSel(i, j) ? ' sel' : ''}${focused ? ' focus' : ''}`}
              style={{ left: lefts[j], width: widths[j] }}
              title={typeof v === 'string' && v.length > 40 ? v.slice(0, 2000) : undefined}
              onMouseDown={(e) => { if (e.button === 0) { dragFrom.current = true; select([i, j], e.shiftKey); } }}
              onMouseEnter={() => { if (dragFrom.current) setFocus([i, j]); }}
              onDoubleClick={() => view([i, j])}>
              {d === null ? <span className="null">NULL</span> : d}
            </div>
          );
        })}
      </div>,
    );
  }

  return (
    <div className="grid" ref={box} tabIndex={0} onKeyDown={onKey} onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
      <div style={{ height: (order.length + 1) * RH, width: totalW, position: 'relative' }}>
        <div className="grid-head" style={{ width: totalW }}>
          <div className="grid-num head" style={{ width: NUM_W }} onMouseDown={() => { setAnchor([0, 0]); setFocus([order.length - 1, columns.length - 1]); }} />
          {columns.map((c, j) => (
            <div key={j} className={`grid-hcell${isNumeric(c) ? ' num' : ''}`} style={{ left: lefts[j], width: widths[j] }}
              title={`${c.orgTable ? `${c.db ? c.db + '.' : ''}${c.orgTable}.${c.orgName}` : c.name}\n${c.type}`}
              onClick={(e) => {
                if (e.shiftKey) { setAnchor([0, j]); setFocus([order.length - 1, j]); return; }
                setSort((s) => (s?.col !== j ? { col: j, dir: 1 } : s.dir === 1 ? { col: j, dir: -1 } : null));
              }}>
              <span>{c.name}</span>
              {sort?.col === j && <span className="sort">{sort.dir === 1 ? '▲' : '▼'}</span>}
              <div className="grid-resize" onMouseDown={(e) => startResize(e, j)} onClick={(e) => e.stopPropagation()} />
            </div>
          ))}
        </div>
        {rowsOut}
      </div>
    </div>
  );
}
