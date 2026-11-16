import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { openMenu } from './ContextMenu';
import { AGGS, aggLabel, chartData, kindOf, niceTicks, timeTicks, type ChartData, type ChartSpec, type ChartType } from '../pivot';
import type { Cell, Column } from '../types';
import { t, locale } from '../i18n';

const TYPES: { id: ChartType; label: () => string }[] = [
  { id: 'column', label: () => t('Colonne') },
  { id: 'bar', label: () => t('Barre') },
  { id: 'line', label: () => t('Linee') },
  { id: 'area', label: () => t('Aree') },
  { id: 'scatter', label: () => t('Dispersione') },
];
const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
let ctx: CanvasRenderingContext2D | null = null;
const textW = (s: string) => {
  ctx ??= document.createElement('canvas').getContext('2d');
  if (!ctx) return s.length * 6.5;
  ctx.font = FONT;
  return ctx.measureText(s).width;
};
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const fmt = (v: number | null) => (v === null ? '—' : v.toLocaleString(locale(), { maximumFractionDigits: 2 }));
const compact = (v: number) => new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(v);
/** Categorical slot of a series (fixed order, never cycled); the folded tail is gray. */
const color = (i: number, other: boolean) => (other ? 'var(--viz-other)' : `var(--c${i + 1})`);

/** Bar from base to end along y (vertical) with the data end rounded; x/w across. */
function barV(x: number, w: number, base: number, end: number, cap: boolean) {
  const r = cap ? Math.min(4, w / 2, Math.abs(end - base)) : 0;
  const d = end < base ? 1 : -1;
  return `M${x},${base}L${x},${end + d * r}Q${x},${end} ${x + r},${end}L${x + w - r},${end}Q${x + w},${end} ${x + w},${end + d * r}L${x + w},${base}Z`;
}
function barH(y: number, h: number, base: number, end: number, cap: boolean) {
  const r = cap ? Math.min(4, h / 2, Math.abs(end - base)) : 0;
  const d = end > base ? -1 : 1;
  return `M${base},${y}L${end + d * r},${y}Q${end},${y} ${end},${y + r}L${end},${y + h - r}Q${end},${y + h} ${end + d * r},${y + h}L${base},${y + h}Z`;
}

/** Copy of the chart with computed colors written into it, for images that do not depend on the app's CSS. */
function standalone(svg: SVGSVGElement) {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[data-noexport]').forEach((n) => n.remove());
  const src = [svg, ...svg.querySelectorAll('*')].filter((n) => !n.closest('[data-noexport]'));
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((n, i) => {
    const cs = getComputedStyle(n);
    const el = dst[i] as SVGElement;
    for (const p of ['fill', 'stroke', 'stroke-width', 'opacity', 'fill-opacity', 'stroke-dasharray', 'font-size', 'font-family', 'font-weight']) el.style.setProperty(p, cs.getPropertyValue(p));
  });
  const w = svg.width.baseVal.value;
  const h = svg.height.baseVal.value;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', String(w));
  bg.setAttribute('height', String(h));
  bg.setAttribute('fill', getComputedStyle(svg).getPropertyValue('--panel') || '#fff');
  clone.insertBefore(bg, clone.firstChild);
  return { text: new XMLSerializer().serializeToString(clone), w, h };
}

async function png(svg: SVGSVGElement): Promise<HTMLCanvasElement> {
  const { text, w, h } = standalone(svg);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = w * 2;
  canvas.height = h * 2;
  const c = canvas.getContext('2d')!;
  c.scale(2, 2);
  c.drawImage(img, 0, 0);
  return canvas;
}

interface Tip { x: number; y: number; title: string; rows: { color: string; value: string; label: string }[] }

/** Chart of the visible rows of a result: settings bar, then an SVG with title, legend, axes and a hover readout. */
export default function ChartView({ columns, rows, spec, onSpec, name, note }: {
  columns: Column[]; rows: Cell[][]; spec: ChartSpec; onSpec: (s: ChartSpec) => void; name: string; note?: string;
}) {
  const body = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 600, h: 300 });
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [tip, setTip] = useState<Tip | null>(null);
  const [hl, setHl] = useState<number | null>(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => body.current && setSize({ w: body.current.clientWidth, h: body.current.clientHeight }));
    ro.observe(body.current!);
    return () => ro.disconnect();
  }, []);
  const data = useMemo(() => chartData(rows, columns, spec), [rows, columns, spec]);
  const set = (p: Partial<ChartSpec>) => { setHidden(new Set()); setTip(null); onSpec({ ...spec, ...p }); };

  const yName = spec.y === null ? t('Righe') : columns[spec.y].name;
  const measure = spec.y === null ? t('Numero di righe') : `${aggLabel(spec.agg)} ${t('di')} ${yName}`;
  const title = spec.type === 'scatter'
    ? t('{0} rispetto a {1}', yName, columns[spec.x].name)
    : spec.series === null ? t('{0} per {1}', measure, columns[spec.x].name) : t('{0} per {1} e {2}', measure, columns[spec.x].name, columns[spec.series].name);
  const notes = [
    note,
    data.folded.categories > 0 && t('{0} categorie minori raggruppate in «Altro»', data.folded.categories),
    data.folded.series > 0 && t('{0} serie minori raggruppate in «Altro»', data.folded.series),
    data.dropped > 0 && t('{0} righe senza valore sull\'asse X escluse', data.dropped),
    data.sampled > 0 && t('mostrati {0} punti su {1}', data.points.length, data.points.length + data.sampled),
  ].filter(Boolean).join(' · ');

  const save = async (kind: 'png' | 'svg') => {
    if (!svgRef.current) return;
    const base = (name || 'grafico').replace(/[^\w.-]+/g, '_');
    if (kind === 'svg') await api.file.saveData(standalone(svgRef.current).text, false, `${base}.svg`, [{ name: 'SVG', extensions: ['svg'] }]);
    else await api.file.saveData((await png(svgRef.current)).toDataURL('image/png').split(',')[1], true, `${base}.png`, [{ name: 'PNG', extensions: ['png'] }]);
  };
  const copyImage = async () => {
    if (!svgRef.current) return;
    const canvas = await png(svgRef.current);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    try {
      if (blob) await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (err) {
      await api.confirm(t('Copia non riuscita'), (err as Error).message, ['OK']);
    }
  };

  const colOptions = columns.map((c, i) => <option key={i} value={i}>{c.name}</option>);
  const stackable = spec.type === 'column' || spec.type === 'bar';
  const empty = !rows.length ? t('Nessuna riga da mostrare.')
    : spec.type === 'scatter' ? (!data.points.length ? t('Servono valori numerici sia in X sia in Y.') : null)
      : !data.series.some((s) => s.values.some((v) => v !== null)) ? t('Nessun valore numerico in «{0}»: scegli un\'altra colonna o il conteggio.', yName) : null;

  return (
    <div className="viz">
      <div className="viz-bar">
        <div className="seg">
          {TYPES.map((x) => <button key={x.id} className={spec.type === x.id ? 'active' : ''} onClick={() => set({ type: x.id })}>{x.label()}</button>)}
        </div>
        <label>{t('Asse X')}{' '}<select value={spec.x} onChange={(e) => set({ x: +e.target.value, series: spec.series === +e.target.value ? null : spec.series })}>{colOptions}</select></label>
        <label>{t('Valore')}{' '}<select value={spec.y ?? -1} onChange={(e) => { const y = +e.target.value; set({ y: y < 0 ? null : y, agg: y < 0 ? 'count' : spec.agg === 'count' && kindOf(columns[y]) === 'number' ? 'sum' : spec.agg }); }}>
          {spec.type !== 'scatter' && <option value={-1}>{t('(numero di righe)')}</option>}
          {colOptions}
        </select></label>
        {spec.type !== 'scatter' && <select value={spec.y === null ? 'count' : spec.agg} disabled={spec.y === null} onChange={(e) => set({ agg: e.target.value as ChartSpec['agg'] })} title={t('Aggregazione')}>
          {AGGS.map((a) => <option key={a} value={a}>{aggLabel(a)}</option>)}
        </select>}
        <label>{t('Serie')}{' '}<select value={spec.series ?? -1} onChange={(e) => set({ series: +e.target.value < 0 ? null : +e.target.value })}>
          <option value={-1}>{t('(nessuna)')}</option>
          {columns.map((c, i) => (i === spec.x ? null : <option key={i} value={i}>{c.name}</option>))}
        </select></label>
        {stackable && spec.series !== null && <label className="check"><input type="checkbox" checked={spec.stacked} onChange={(e) => set({ stacked: e.target.checked })} />{t('Impila')}</label>}
        {stackable && <select value={spec.sort} onChange={(e) => set({ sort: e.target.value as ChartSpec['sort'] })} title={t('Ordine')}>
          <option value="x">{t('Ordina per X')}</option>
          <option value="value">{t('Ordina per valore')}</option>
        </select>}
        <div className="spacer" />
        <button disabled={!!empty} onClick={(e) => openMenu(e, [
          { label: t('Copia immagine'), action: copyImage },
          { label: t('Salva come PNG…'), action: () => save('png') },
          { label: t('Salva come SVG…'), action: () => save('svg') },
        ])}>{t('Immagine')} ▾</button>
      </div>
      {notes && <div className="viz-note">{notes}</div>}
      <div className="viz-body" ref={body} onMouseLeave={() => { setTip(null); setHl(null); }}>
        {empty ? <div className="empty">{empty}</div> : (
          <Plot data={data} spec={spec} title={title} measure={measure} xName={columns[spec.x].name} yName={yName} size={size} hidden={hidden}
            onToggle={(i) => setHidden((h) => { const n = new Set(h); if (n.has(i)) n.delete(i); else n.add(i); return n; })}
            svgRef={svgRef} hl={hl} setHl={setHl} setTip={setTip} />
        )}
        {tip && (
          <div className="viz-tip" style={{ left: Math.max(4, Math.min(tip.x + 14, size.w - 220)), top: Math.max(4, tip.y - 10) }}>
            <div className="viz-tip-title">{tip.title}</div>
            {tip.rows.map((r, i) => (
              <div key={i} className="viz-tip-row"><span className="key" style={{ background: r.color }} /><b>{r.value}</b><span>{r.label}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Plot({ data, spec, title, measure, xName, yName, size, hidden, onToggle, svgRef, hl, setHl, setTip }: {
  data: ChartData; spec: ChartSpec; title: string; measure: string; xName: string; yName: string; size: { w: number; h: number };
  hidden: Set<number>; onToggle: (i: number) => void; svgRef: React.RefObject<SVGSVGElement | null>;
  hl: number | null; setHl: (i: number | null) => void; setTip: (t: Tip | null) => void;
}) {
  const W = Math.max(320, size.w);
  const series = data.series.map((s, i) => ({ ...s, i, color: color(i, s.other) })).filter((s) => !hidden.has(s.i));
  const cats = data.categories;
  const horizontal = spec.type === 'bar';
  const stacked = (spec.type === 'column' || spec.type === 'bar') && spec.stacked || spec.type === 'area';

  // title and legend (inside the SVG so images carry them)
  const legendItems = data.series.length >= 2 ? data.series.map((s, i) => ({ label: clip(s.label, 40), i, color: color(i, s.other) })) : [];
  const legendPos: { x: number; y: number }[] = [];
  let lx = 8;
  let ly = 0;
  for (const it of legendItems) {
    const w = 22 + textW(it.label) + 14;
    if (lx + w > W - 8 && lx > 8) { lx = 8; ly++; }
    legendPos.push({ x: lx, y: ly });
    lx += w;
  }
  const legendRows = legendItems.length ? ly + 1 : 0;
  const top = 26 + legendRows * 18 + 8;

  // value domain
  let lo = Infinity;
  let hi = -Infinity;
  if (spec.type === 'scatter') {
    for (const p of data.points) if (!hidden.has(p.s)) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
  } else if (stacked) {
    cats.forEach((_, c) => {
      let pos = 0;
      let neg = 0;
      for (const s of series) { const v = s.values[c] ?? 0; if (v >= 0) pos += v; else neg += v; }
      lo = Math.min(lo, neg);
      hi = Math.max(hi, pos);
    });
  } else {
    for (const s of series) for (const v of s.values) if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  }
  if (lo === Infinity) { lo = 0; hi = 1; }
  if (spec.type === 'column' || spec.type === 'bar' || spec.type === 'area') { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  const vTicks = niceTicks(lo, hi, horizontal ? Math.max(2, Math.floor(W / 110)) : 5);
  const v0 = vTicks[0];
  const v1 = vTicks[vTicks.length - 1];
  const vLabel = (v: number) => (Math.abs(v) >= 10000 ? compact(v) : fmt(v));

  // x domain for continuous axes
  const continuous = data.scale !== 'band';
  let x0 = 0;
  let x1 = 1;
  if (spec.type === 'scatter') {
    const xs = data.points.filter((p) => !hidden.has(p.s)).map((p) => p.x);
    x0 = Math.min(...xs);
    x1 = Math.max(...xs);
  } else if (continuous) {
    x0 = cats[0]?.pos ?? 0;
    x1 = cats[cats.length - 1]?.pos ?? 1;
  }
  let xTicks: number[] = [];
  let xFmt = (v: number) => vLabel(v);
  if (continuous) {
    if (data.scale === 'time') {
      if (x0 === x1) { x0 -= 7 * 86400000; x1 += 7 * 86400000; } // one date: a week each side, so ticks are days
      const tt = timeTicks(x0, x1, Math.max(2, Math.floor(W / 120)));
      const f = new Intl.DateTimeFormat(locale(), tt.fmt);
      xTicks = tt.ticks;
      xFmt = (v) => f.format(v);
    } else {
      xTicks = niceTicks(x0, x1, Math.max(2, Math.floor(W / 100)));
      x0 = Math.min(x0, xTicks[0]);
      x1 = Math.max(x1, xTicks[xTicks.length - 1]);
    }
  }

  // direct labels at line ends (2-4 series)
  const directLabels = (spec.type === 'line' || spec.type === 'area') && series.length >= 2 && series.length <= 4;
  const padR = directLabels ? Math.min(130, 14 + Math.max(...series.map((s) => textW(clip(s.label, 18))))) : 14;

  // left margin and category labels
  const catLabels = cats.map((c) => clip(c.label, horizontal ? 28 : 20));
  const padL = horizontal
    ? Math.min(220, 12 + Math.max(0, ...catLabels.map(textW)))
    : 12 + Math.max(...vTicks.map((v) => textW(vLabel(v))));
  const plotW = W - padL - padR;
  const band = !horizontal && !continuous && spec.type !== 'scatter' ? plotW / Math.max(1, cats.length) : 0;
  const widest = Math.max(0, ...catLabels.map(textW));
  const rotate = band > 0 && widest + 8 > band;
  const every = rotate ? Math.max(1, Math.ceil(14 / band)) : 1;
  const padB = horizontal ? 26 : rotate ? Math.min(120, widest * 0.72 + 18) : 26;
  const H = horizontal ? Math.max(size.h, top + padB + cats.length * Math.max(16, 8 + series.length * (stacked ? 10 : 6))) : Math.max(220, size.h);
  const plotH = H - top - padB;

  const vy = (v: number) => top + (1 - (v - v0) / (v1 - v0 || 1)) * plotH; // vertical value scale
  const vx = (v: number) => padL + ((v - v0) / (v1 - v0 || 1)) * plotW; // horizontal value scale
  const cx = (i: number) => (continuous || spec.type === 'scatter'
    ? padL + ((i - x0) / (x1 - x0 || 1)) * plotW
    : padL + (i + 0.5) * (plotW / Math.max(1, cats.length)));
  const xOf = (c: number) => cx(continuous ? cats[c].pos : c);

  const tipFor = (c: number, x: number, y: number) => setTip({
    x, y, title: cats[c].label,
    rows: series.map((s) => ({ color: s.color, value: fmt(s.values[c]), label: data.series.length > 1 ? s.label : measure })),
  });
  const local = (e: React.MouseEvent) => {
    const r = (e.currentTarget as Element).closest('.viz-body')!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top + (e.currentTarget as Element).closest('.viz-body')!.scrollTop };
  };

  const marks: React.ReactNode[] = [];
  const hits: React.ReactNode[] = [];
  if (spec.type === 'column' || spec.type === 'bar') {
    const n = Math.max(1, cats.length);
    const step = (horizontal ? plotH : plotW) / n;
    const inner = step * (n === 1 ? 0.5 : 0.78);
    const k = stacked ? 1 : Math.max(1, series.length);
    const bw = inner / k;
    cats.forEach((_, c) => {
      const start = (horizontal ? top : padL) + c * step + (step - inner) / 2;
      let pos = 0;
      let neg = 0;
      const lastPos = stacked ? series.map((s) => s.values[c] ?? 0).findLastIndex((v) => v > 0) : -1;
      const lastNeg = stacked ? series.map((s) => s.values[c] ?? 0).findLastIndex((v) => v < 0) : -1;
      series.forEach((s, j) => {
        const v = s.values[c];
        if (v === null || v === 0) return;
        let base = 0;
        if (stacked) { base = v > 0 ? pos : neg; if (v > 0) pos += v; else neg += v; }
        const cap = !stacked || j === (v > 0 ? lastPos : lastNeg);
        const off = start + (stacked ? 0 : j * bw);
        marks.push(<path key={`${c}-${s.i}`} className="viz-rect" style={{ fill: s.color }}
          d={horizontal ? barH(off, bw, vx(base), vx(base + v), cap) : barV(off, bw, vy(base), vy(base + v), cap)} />);
      });
      hits.push(<rect key={c} data-noexport className={`viz-hit${hl === c ? ' on' : ''}`}
        x={horizontal ? padL : padL + c * step} y={horizontal ? top + c * step : top} width={horizontal ? plotW : step} height={horizontal ? step : plotH}
        onMouseMove={(e) => { setHl(c); const p = local(e); tipFor(c, p.x, p.y); }} />);
    });
  } else if (spec.type === 'line' || spec.type === 'area') {
    const acc = cats.map(() => 0);
    const paths = series.map((s) => {
      let line = '';
      let gap = true;
      const upper: [number, number][] = [];
      const lower: [number, number][] = [];
      s.values.forEach((v, c) => {
        if (spec.type === 'area') {
          const b = acc[c];
          const e = b + (v ?? 0);
          lower.push([xOf(c), vy(b)]);
          upper.push([xOf(c), vy(e)]);
          acc[c] = e;
          line += `${c ? 'L' : 'M'}${xOf(c).toFixed(1)},${vy(e).toFixed(1)}`;
          return;
        }
        if (v === null) { gap = true; return; }
        line += `${gap ? 'M' : 'L'}${xOf(c).toFixed(1)},${vy(v).toFixed(1)}`;
        gap = false;
      });
      const area = spec.type === 'area' && upper.length
        ? 'M' + upper.map((p) => p.map((n) => n.toFixed(1)).join(',')).join('L') + 'L' + lower.reverse().map((p) => p.map((n) => n.toFixed(1)).join(',')).join('L') + 'Z'
        : '';
      return { s, line, area, end: spec.type === 'area' ? upper[upper.length - 1]?.[1] : undefined };
    });
    for (const p of paths) if (p.area) marks.push(<path key={'a' + p.s.i} className="viz-area" style={{ fill: p.s.color }} d={p.area} />);
    for (const p of paths) marks.push(<path key={'l' + p.s.i} className="viz-line" style={{ stroke: p.s.color }} d={p.line} />);
    if (cats.length <= 40 && spec.type === 'line') {
      for (const s of series) s.values.forEach((v, c) => { if (v !== null) marks.push(<circle key={`d${s.i}-${c}`} className="viz-dot" cx={xOf(c)} cy={vy(v)} r={3} style={{ fill: s.color }} />); });
    }
    if (directLabels) {
      const ends = paths.map((p) => {
        const c = p.s.values.findLastIndex((v) => v !== null);
        return { s: p.s, y: p.end ?? (c >= 0 ? vy(p.s.values[c]!) : NaN), x: c >= 0 ? xOf(spec.type === 'area' ? cats.length - 1 : c) : NaN };
      }).filter((e) => !Number.isNaN(e.y)).sort((a, b) => a.y - b.y);
      for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 12);
      for (const e of ends) marks.push(<text key={'dl' + e.s.i} className="viz-direct" x={W - padR + 6} y={e.y + 4}>{clip(e.s.label, 18)}</text>);
    }
    if (hl !== null && cats[hl]) {
      hits.push(<line key="cross" data-noexport className="viz-cross" x1={xOf(hl)} x2={xOf(hl)} y1={top} y2={top + plotH} />);
      let a = 0;
      for (const s of series) {
        const v = s.values[hl];
        if (v === null && spec.type === 'line') continue;
        a += v ?? 0;
        hits.push(<circle key={'h' + s.i} data-noexport className="viz-dot hover" cx={xOf(hl)} cy={vy(spec.type === 'area' ? a : v!)} r={4.5} style={{ fill: s.color }} />);
      }
    }
    hits.push(<rect key="hit" data-noexport className="viz-hit" x={padL} y={top} width={plotW} height={plotH} onMouseMove={(e) => {
      const p = local(e);
      const box = (e.currentTarget as Element).getBoundingClientRect();
      const px = e.clientX - box.left + padL;
      let best = 0;
      cats.forEach((_, c) => { if (Math.abs(xOf(c) - px) < Math.abs(xOf(best) - px)) best = c; });
      setHl(best);
      tipFor(best, p.x, p.y);
    }} />);
  } else {
    const pts = data.points.filter((p) => !hidden.has(p.s));
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      marks.push(<circle key={i} className="viz-point" cx={cx(p.x)} cy={vy(p.y)} r={4} style={{ fill: color(p.s, data.series[p.s].other) }} />);
    }
    const xf = (v: number) => (data.scale === 'time' ? xFmt(v) : fmt(v));
    if (hl !== null && pts[hl]) hits.push(<circle key="hp" data-noexport className="viz-point hover" cx={cx(pts[hl].x)} cy={vy(pts[hl].y)} r={6} style={{ fill: color(pts[hl].s, data.series[pts[hl].s].other) }} />);
    hits.push(<rect key="hit" data-noexport className="viz-hit" x={padL} y={top} width={plotW} height={plotH} onMouseMove={(e) => {
      const box = (e.currentTarget as Element).getBoundingClientRect();
      const mx = e.clientX - box.left + padL;
      const my = e.clientY - box.top + top;
      let best = -1;
      let dist = 24 * 24; // hit radius 24px around each point
      for (let i = 0; i < pts.length; i++) {
        const d = (cx(pts[i].x) - mx) ** 2 + (vy(pts[i].y) - my) ** 2;
        if (d < dist) { dist = d; best = i; }
      }
      setHl(best < 0 ? null : best);
      if (best < 0) { setTip(null); return; }
      const p = local(e);
      const q = pts[best];
      setTip({ x: p.x, y: p.y, title: data.series[q.s].label || `${yName}`, rows: [
        { color: color(q.s, data.series[q.s].other), value: xf(q.x), label: xName },
        { color: color(q.s, data.series[q.s].other), value: fmt(q.y), label: yName },
      ] });
    }} />);
  }

  // axes
  const axis: React.ReactNode[] = [];
  if (horizontal) {
    vTicks.forEach((v) => axis.push(
      <line key={'g' + v} className={v === 0 ? 'viz-base' : 'viz-grid'} x1={vx(v)} x2={vx(v)} y1={top} y2={top + plotH} />,
      <text key={'t' + v} className="viz-axis" x={vx(v)} y={top + plotH + 16} textAnchor="middle">{vLabel(v)}</text>));
    const step = plotH / Math.max(1, cats.length);
    catLabels.forEach((l, c) => axis.push(<text key={'c' + c} className="viz-axis" x={padL - 6} y={top + (c + 0.5) * step + 4} textAnchor="end">{l}</text>));
  } else {
    vTicks.forEach((v) => axis.push(
      <line key={'g' + v} className={v === 0 && spec.type !== 'line' && spec.type !== 'scatter' ? 'viz-base' : 'viz-grid'} x1={padL} x2={padL + plotW} y1={vy(v)} y2={vy(v)} />,
      <text key={'t' + v} className="viz-axis" x={padL - 6} y={vy(v) + 4} textAnchor="end">{vLabel(v)}</text>));
    if (continuous || spec.type === 'scatter') {
      xTicks.forEach((v) => axis.push(<text key={'x' + v} className="viz-axis" x={cx(v)} y={top + plotH + 16} textAnchor="middle">{xFmt(v)}</text>));
    } else {
      catLabels.forEach((l, c) => {
        if (c % every) return;
        const x = cx(c);
        axis.push(rotate
          ? <text key={'c' + c} className="viz-axis" transform={`translate(${x + 3},${top + plotH + 10}) rotate(-45)`} textAnchor="end">{l}</text>
          : <text key={'c' + c} className="viz-axis" x={x} y={top + plotH + 16} textAnchor="middle">{l}</text>);
      });
    }
  }

  return (
    <svg ref={svgRef} className="viz-svg" width={W} height={H} role="img" aria-label={title}>
      <text className="viz-title" x={8} y={17}>{title}</text>
      {legendItems.map((it, n) => (
        <g key={it.i} className={`viz-legend${hidden.has(it.i) ? ' off' : ''}`} transform={`translate(${legendPos[n].x},${26 + legendPos[n].y * 18})`} onClick={() => onToggle(it.i)}>
          <title>{t('Clic per mostrare o nascondere')}</title>
          {spec.type === 'line' ? <line x1={0} x2={14} y1={6} y2={6} style={{ stroke: it.color }} className="viz-line" />
            : spec.type === 'scatter' ? <circle cx={7} cy={6} r={4} style={{ fill: it.color }} />
              : <rect x={1} y={1} width={12} height={10} rx={2} style={{ fill: it.color }} />}
          <text className="viz-legend-text" x={20} y={10}>{it.label}</text>
        </g>
      ))}
      {axis}
      {marks}
      {hits}
    </svg>
  );
}
