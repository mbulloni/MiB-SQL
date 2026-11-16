// Pivot tables and chart series built from the rows of a result set. Pure functions (no React, no IPC) so they run in tests.
import type { Cell, Column } from './types';
import { t } from './i18n.ts';

export type Agg = 'count' | 'sum' | 'avg' | 'min' | 'max' | 'distinct';
export const AGGS: Agg[] = ['sum', 'count', 'avg', 'min', 'max', 'distinct'];
export const aggLabel = (a: Agg) => ({
  count: t('Conteggio'), sum: t('Somma'), avg: t('Media'), min: t('Minimo'), max: t('Massimo'), distinct: t('Valori distinti'),
})[a];

const NUMERIC = new Set(['TINY', 'SHORT', 'LONG', 'INT', 'INT24', 'LONGLONG', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR',
  'SMALLINT', 'TINYINT', 'NUMERIC', 'MONEY', 'SMALLMONEY', 'REAL']);
const TEMPORAL = new Set(['DATE', 'NEWDATE', 'DATETIME', 'DATETIME2', 'TIMESTAMP', 'TIMESTAMP2', 'SMALLDATETIME', 'DATETIMEOFFSET']);

export type Kind = 'number' | 'date' | 'text';
/** Kind of a column by its type; with the rows, text columns holding only dates (DATE_ADD on a literal, CSV imports) count as dates. */
export function kindOf(c: Column, rows?: Cell[][], i?: number): Kind {
  if (NUMERIC.has(c.type)) return 'number';
  if (TEMPORAL.has(c.type)) return 'date';
  if (!rows || i === undefined || c.binary) return 'text';
  let seen = 0;
  for (let r = 0; r < rows.length && seen < 50; r++) {
    const v = rows[r][i];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(v)) return 'text';
    seen++;
  }
  return seen ? 'date' : 'text';
}

/** Number of a cell: numbers and numeric strings (DECIMAL/BIGINT arrive as strings), otherwise null. */
export function num(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !/^\s*[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?\s*$/i.test(v)) return null;
  return Number(v);
}

/** Milliseconds of a date/datetime string, read as UTC (the server's wall clock, shown back in UTC). */
export function time(v: Cell): number | null {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?/.exec(v);
  if (!m) return null;
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  const r = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), ms);
  return Number.isNaN(r) ? null : r;
}

/** Folded tail of categories or series ("Other"); never equal to a real value. */
export const OTHER = '\u0000other';
export const label = (v: Cell) => (v === null ? '(NULL)' : v === OTHER ? t('Altro') : String(v));

/** Natural order of key values: numbers and dates by value, text with numeric collation, NULL and "Other" last. */
export function compareCell(a: Cell, b: Cell): number {
  const rank = (v: Cell) => (v === OTHER ? 2 : v === null ? 1 : 0);
  if (rank(a) || rank(b)) return rank(a) - rank(b);
  const x = num(a);
  const y = num(b);
  if (x !== null && y !== null) return x - y;
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

class Acc {
  rows = 0;
  n = 0;
  sum = 0;
  min = Infinity;
  max = -Infinity;
  seen: Set<string> | null = null;

  add(v: Cell, counted: boolean, agg: Agg) {
    this.rows++;
    if (!counted || v === null) return;
    if (agg === 'distinct') { (this.seen ??= new Set()).add(typeof v === 'number' ? 'n' + v : 's' + v); return; }
    if (agg === 'count') { this.n++; return; }
    const x = num(v);
    if (x === null) return;
    this.n++;
    this.sum += x;
    if (x < this.min) this.min = x;
    if (x > this.max) this.max = x;
  }

  value(agg: Agg, counted: boolean): number | null {
    if (!counted) return this.rows;
    switch (agg) {
      case 'count': return this.n;
      case 'distinct': return this.seen?.size ?? 0;
      case 'sum': return this.n ? this.sum : null;
      case 'avg': return this.n ? this.sum / this.n : null;
      case 'min': return this.n ? this.min : null;
      case 'max': return this.n ? this.max : null;
    }
  }
}

export interface PivotSpec {
  rows: number[]; // dimension columns down the side
  cols: number[]; // dimension columns across the top
  value: number | null; // null = count rows
  agg: Agg;
}

export interface PivotKey { id: string; values: Cell[] }

export interface Pivot {
  rowKeys: PivotKey[];
  colKeys: PivotKey[];
  cells: (number | null)[][]; // [row][col]
  rowTotals: (number | null)[];
  colTotals: (number | null)[];
  grand: number | null;
}

const keyId = (vs: Cell[]) => vs.map((v) => (v === null ? '\u0000n' : typeof v === 'number' ? 'n' + v : 's' + v)).join('\u0001');
const sortKeys = (keys: Map<string, Cell[]>): PivotKey[] =>
  [...keys].map(([id, values]) => ({ id, values })).sort((a, b) => {
    for (let i = 0; i < a.values.length; i++) {
      const c = compareCell(a.values[i], b.values[i]);
      if (c) return c;
    }
    return 0;
  });

/** Groups rows by the row and column dimensions; totals are aggregated from the rows, not from the cells (averages stay right). */
export function pivot(rows: Cell[][], spec: PivotSpec): Pivot {
  const counted = spec.value !== null;
  const agg = counted ? spec.agg : 'count';
  const rowKeys = new Map<string, Cell[]>();
  const colKeys = new Map<string, Cell[]>();
  const cells = new Map<string, Acc>();
  const rowAcc = new Map<string, Acc>();
  const colAcc = new Map<string, Acc>();
  const all = new Acc();
  const acc = (m: Map<string, Acc>, k: string) => { let a = m.get(k); if (!a) m.set(k, a = new Acc()); return a; };
  for (const r of rows) {
    const rv = spec.rows.map((c) => r[c] ?? null);
    const cv = spec.cols.map((c) => r[c] ?? null);
    const rk = keyId(rv);
    const ck = keyId(cv);
    if (!rowKeys.has(rk)) rowKeys.set(rk, rv);
    if (!colKeys.has(ck)) colKeys.set(ck, cv);
    const v = counted ? r[spec.value!] ?? null : null;
    acc(cells, rk + '\u0002' + ck).add(v, counted, agg);
    acc(rowAcc, rk).add(v, counted, agg);
    acc(colAcc, ck).add(v, counted, agg);
    all.add(v, counted, agg);
  }
  const rk = sortKeys(rowKeys);
  const ck = sortKeys(colKeys);
  return {
    rowKeys: rk,
    colKeys: ck,
    cells: rk.map((r) => ck.map((c) => cells.get(r.id + '\u0002' + c.id)?.value(agg, counted) ?? null)),
    rowTotals: rk.map((r) => rowAcc.get(r.id)!.value(agg, counted)),
    colTotals: ck.map((c) => colAcc.get(c.id)!.value(agg, counted)),
    grand: rows.length ? all.value(agg, counted) : null,
  };
}

const synthetic = (name: string, numeric: boolean): Column => ({
  name, table: '', orgTable: '', orgName: name, db: '', type: numeric ? 'DOUBLE' : 'VAR_STRING', length: 0, scale: 0, binary: false, notNull: false, autoIncrement: false,
});

/** Flat table of a pivot (dimensions, one column per column key, total) for copy and export. */
export function pivotTable(p: Pivot, spec: PivotSpec, columns: Column[]): { columns: Column[]; rows: Cell[][] } {
  const value = spec.value === null ? t('Righe') : `${aggLabel(spec.agg)} ${columns[spec.value].name}`;
  const head = spec.cols.length ? p.colKeys.map((k) => k.values.map(label).join(' / ')) : [value];
  const cols = [
    ...spec.rows.map((c) => synthetic(columns[c].name, false)),
    ...head.map((h) => synthetic(h, true)),
    ...(spec.cols.length ? [synthetic(t('Totale'), true)] : []),
  ];
  const out: Cell[][] = p.rowKeys.map((k, i) => [
    ...k.values.map((v) => (v === null ? null : String(v))),
    ...(spec.cols.length ? [...p.cells[i], p.rowTotals[i]] : [p.rowTotals[i]]),
  ]);
  if (spec.rows.length) out.push([t('Totale'), ...spec.rows.slice(1).map(() => null), ...(spec.cols.length ? [...p.colTotals, p.grand] : [p.grand])]);
  return { columns: cols, rows: out };
}

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'scatter';

export interface ChartSpec {
  type: ChartType;
  x: number;
  y: number | null; // null = count rows
  series: number | null;
  agg: Agg;
  stacked: boolean;
  sort: 'x' | 'value';
}

export interface Series { label: string; other: boolean; values: (number | null)[] }

export interface ChartData {
  scale: 'band' | 'linear' | 'time';
  categories: { label: string; raw: Cell; pos: number }[]; // pos = index (band), number or ms (linear/time)
  series: Series[];
  points: { x: number; y: number; s: number }[]; // scatter only
  folded: { categories: number; series: number }; // how many were folded into "Other"
  dropped: number; // rows without a usable x (or y for scatter)
  sampled: number; // scatter: points left out above MAX_POINTS
}

export const MAX_SERIES = 8; // categorical palette slots; past it the tail folds into "Other"
export const MAX_SCATTER_SERIES = 3; // all-pairs forms validate only the first three slots
export const MAX_BARS = 50;
export const MAX_POINTS = 5000;

/** Keeps the `keep` most important keys, the others become OTHER. `weight` ranks them (bigger first). */
function topKeys(keys: Cell[], weight: (k: Cell) => number, keep: number): Set<Cell> | null {
  if (keys.length <= keep) return null;
  return new Set([...keys].sort((a, b) => weight(b) - weight(a) || compareCell(a, b)).slice(0, keep - 1));
}

export function chartData(rows: Cell[][], columns: Column[], spec: ChartSpec): ChartData {
  const xKind = kindOf(columns[spec.x], rows, spec.x);
  const empty: ChartData = { scale: 'band', categories: [], series: [], points: [], folded: { categories: 0, series: 0 }, dropped: 0, sampled: 0 };
  // triples [x, series, y]
  let data: Cell[][] = rows.map((r) => [r[spec.x] ?? null, spec.series === null ? '' : r[spec.series] ?? null, spec.y === null ? null : r[spec.y] ?? null]);
  const seriesCount = new Map<Cell, number>();
  for (const d of data) seriesCount.set(d[1], (seriesCount.get(d[1]) ?? 0) + 1);
  const seriesKeep = topKeys([...seriesCount.keys()], (k) => seriesCount.get(k)!, spec.type === 'scatter' ? MAX_SCATTER_SERIES + 1 : MAX_SERIES);
  const foldedSeries = seriesKeep ? seriesCount.size - seriesKeep.size : 0;
  if (seriesKeep) data = data.map((d) => (seriesKeep.has(d[1]) ? d : [d[0], OTHER, d[2]]));

  if (spec.type === 'scatter') {
    const keys = [...new Set(data.map((d) => d[1]))].sort(compareCell);
    const index = new Map(keys.map((k, i) => [k, i]));
    const xs = (v: Cell) => (xKind === 'date' ? time(v) : num(v));
    const pts: ChartData['points'] = [];
    let dropped = 0;
    for (const d of data) {
      const x = xs(d[0]);
      const y = num(d[2]);
      if (x === null || y === null) { dropped++; continue; }
      pts.push({ x, y, s: index.get(d[1])! });
    }
    const step = Math.max(1, pts.length / MAX_POINTS);
    const points = step > 1 ? Array.from({ length: MAX_POINTS }, (_, i) => pts[Math.floor(i * step)]) : pts;
    return {
      ...empty,
      scale: xKind === 'date' ? 'time' : 'linear',
      series: keys.map((k) => ({ label: spec.series === null ? (spec.y === null ? '' : columns[spec.y].name) : label(k), other: k === OTHER, values: [] })),
      points, folded: { categories: 0, series: foldedSeries }, dropped, sampled: pts.length - points.length,
    };
  }

  const continuous = (spec.type === 'line' || spec.type === 'area') && xKind !== 'text';
  const pos = (v: Cell) => (xKind === 'date' ? time(v) : num(v));
  let dropped = 0;
  if (continuous) {
    const before = data.length;
    data = data.filter((d) => pos(d[0]) !== null);
    dropped = before - data.length;
  }
  const spec2: PivotSpec = { rows: [0], cols: [1], value: spec.y === null ? null : 2, agg: spec.agg };
  let p = pivot(data, spec2);
  let foldedCats = 0;
  if (!continuous && p.rowKeys.length > MAX_BARS) {
    const weight = new Map(p.rowKeys.map((k, i) => [k.values[0], Math.abs(p.rowTotals[i] ?? 0)]));
    const keep = topKeys(p.rowKeys.map((k) => k.values[0]), (k) => weight.get(k)!, MAX_BARS)!;
    foldedCats = p.rowKeys.length - keep.size;
    p = pivot(data.map((d) => (keep.has(d[0]) ? d : [OTHER, d[1], d[2]])), spec2);
  }
  let order = p.rowKeys.map((_, i) => i);
  if (!continuous && spec.sort === 'value') {
    order.sort((a, b) => {
      const ka = p.rowKeys[a].values[0] === OTHER;
      const kb = p.rowKeys[b].values[0] === OTHER;
      return ka !== kb ? (ka ? 1 : -1) : (p.rowTotals[b] ?? -Infinity) - (p.rowTotals[a] ?? -Infinity);
    });
  }
  if (continuous) order = order.sort((a, b) => pos(p.rowKeys[a].values[0])! - pos(p.rowKeys[b].values[0])!);
  const categories = order.map((i, n) => {
    const raw = p.rowKeys[i].values[0];
    return { label: label(raw), raw, pos: continuous ? pos(raw)! : n };
  });
  const series = p.colKeys.map((k, j) => ({
    label: spec.series === null ? (spec.y === null ? t('Righe') : `${aggLabel(spec.agg)} ${columns[spec.y].name}`) : label(k.values[0]),
    other: k.values[0] === OTHER,
    values: order.map((i) => p.cells[i][j]),
  }));
  return { ...empty, scale: continuous ? (xKind === 'date' ? 'time' : 'linear') : 'band', categories, series, folded: { categories: foldedCats, series: foldedSeries }, dropped };
}

const idLike = (c: Column) => /^id$|_id$|^id_/i.test(c.name) || c.autoIncrement;

/** First guess of a chart for a result: dates → line, text → columns, only numbers → scatter. */
export function guessChart(columns: Column[], rows?: Cell[][]): ChartSpec {
  const kinds = columns.map((c, i) => kindOf(c, rows, i));
  const nums = columns.map((_, i) => i).filter((i) => kinds[i] === 'number' && !idLike(columns[i]));
  const date = kinds.indexOf('date');
  const text = columns.findIndex((c, i) => kinds[i] === 'text' && !c.binary);
  if (date < 0 && text < 0 && nums.length >= 2) {
    return { type: 'scatter', x: nums[0], y: nums[1], series: null, agg: 'sum', stacked: false, sort: 'x' };
  }
  const x = date >= 0 ? date : text >= 0 ? text : 0;
  const y = nums.find((i) => i !== x) ?? null;
  return { type: date >= 0 ? 'line' : 'column', x, y, series: null, agg: y === null ? 'count' : 'sum', stacked: false, sort: 'x' };
}

export function guessPivot(columns: Column[], rows?: Cell[][]): PivotSpec {
  const c = guessChart(columns, rows);
  return { rows: [c.type === 'scatter' ? 0 : c.x], cols: [], value: c.y, agg: c.agg };
}

/** "Nice" axis ticks covering [min, max]: steps of 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { if (min === 0) return [0, 1]; const d = Math.abs(min) / 2; min -= d; max += d; }
  const raw = (max - min) / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw)!;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : Number(v.toPrecision(12)));
  return out;
}

const DAY = 86400000;
/** Ticks of a time axis at calendar-friendly steps, with the format that fits the span. */
export function timeTicks(min: number, max: number, count = 6): { ticks: number[]; fmt: Intl.DateTimeFormatOptions } {
  const span = Math.max(1, max - min);
  const utc = { timeZone: 'UTC' } as const;
  if (span > 3 * 365 * DAY) {
    const step = Math.max(1, Math.ceil(span / (365.25 * DAY) / count));
    const y0 = new Date(min).getUTCFullYear();
    const ticks = [];
    for (let y = Math.ceil(y0 / step) * step; Date.UTC(y, 0, 1) <= max; y += step) if (Date.UTC(y, 0, 1) >= min) ticks.push(Date.UTC(y, 0, 1));
    return { ticks, fmt: { ...utc, year: 'numeric' } };
  }
  if (span > 60 * DAY) {
    const months = span / (30.44 * DAY);
    const step = [1, 2, 3, 6, 12].find((m) => months / m <= count) ?? 12;
    const d = new Date(min);
    const ticks = [];
    for (let y = d.getUTCFullYear(), m = Math.ceil(d.getUTCMonth() / step) * step; Date.UTC(y, m, 1) <= max; m += step) if (Date.UTC(y, m, 1) >= min) ticks.push(Date.UTC(y, m, 1));
    return { ticks, fmt: { ...utc, month: 'short', year: 'numeric' } };
  }
  if (span > 2 * DAY) {
    const step = [1, 2, 7, 14].find((s) => span / (s * DAY) <= count) ?? 14;
    const ticks = [];
    for (let v = Math.ceil(min / DAY) * DAY; v <= max; v += step * DAY) ticks.push(v);
    return { ticks, fmt: { ...utc, day: 'numeric', month: 'short' } };
  }
  const hour = 3600000;
  const step = [1, 2, 3, 6, 12].map((h) => h * hour).find((s) => span / s <= count) ?? 12 * hour;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) ticks.push(v);
  return { ticks, fmt: span > DAY ? { ...utc, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' } : { ...utc, hour: '2-digit', minute: '2-digit' } };
}
