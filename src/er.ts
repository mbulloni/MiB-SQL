// ER diagram model, automatic layout and relation paths. Pure functions (no React, no DOM) for tests.

export interface ErColumn { name: string; type: string; pk: boolean; nullable: boolean }
export interface ErTable { name: string; kind: 'table' | 'view'; rows: number | null; comment: string; columns: ErColumn[] }
export interface ErFk { name: string; table: string; columns: string[]; refDb: string; refTable: string; refColumns: string[] }
export interface ErModel { tables: ErTable[]; fks: ErFk[] }
export interface Box { x: number; y: number; w: number; h: number }
export type Positions = Record<string, { x: number; y: number }>;

export const HEADER = 28;
export const ROW = 19;
const PAD = 10;
const GAP_X = 90;
const GAP_Y = 36;
const MAX_COLUMN_H = 1600;

/** Columns drawn for a table: all, or only key columns (PK and FK) in compact mode. */
export function shownColumns(t: ErTable, fkCols: Set<string>, keysOnly: boolean) {
  return keysOnly ? t.columns.filter((c) => c.pk || fkCols.has(c.name)) : t.columns;
}

/** Foreign key columns per table (to mark them and for compact mode). */
export function fkColumns(m: ErModel) {
  const out = new Map<string, Set<string>>();
  for (const fk of m.fks) {
    const s = out.get(fk.table) ?? new Set<string>();
    fk.columns.forEach((c) => s.add(c));
    out.set(fk.table, s);
  }
  return out;
}

export function boxSize(t: ErTable, rows: number, measure: (s: string) => number) {
  const widest = Math.max(measure(t.name) + 40, ...t.columns.map((c) => measure(c.name) + measure(c.type) + 56));
  return { w: Math.ceil(Math.min(Math.max(widest, 160), 420)), h: HEADER + Math.max(rows, 1) * ROW + 6 };
}

/**
 * Layered layout: referenced (parent) tables on the left, children to the right; inside a layer tables are
 * ordered by the mean position of the tables they connect to; tall layers wrap into extra columns.
 * Tables without relations go in a grid below.
 */
export function autoLayout(m: ErModel, sizes: Record<string, { w: number; h: number }>): Positions {
  const names = new Set(m.tables.map((t) => t.name));
  const parents = new Map<string, Set<string>>();
  const linked = new Set<string>();
  for (const fk of m.fks) {
    if (fk.refTable === fk.table || !names.has(fk.refTable) || !names.has(fk.table)) continue; // callers drop cross-database keys
    (parents.get(fk.table) ?? parents.set(fk.table, new Set()).get(fk.table)!).add(fk.refTable);
    linked.add(fk.table);
    linked.add(fk.refTable);
  }
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (t: string): number => {
    if (level.has(t)) return level.get(t)!;
    if (visiting.has(t)) return 0; // cycle: break it here
    visiting.add(t);
    let l = 0;
    for (const p of parents.get(t) ?? []) l = Math.max(l, levelOf(p) + 1);
    visiting.delete(t);
    level.set(t, l);
    return l;
  };
  for (const t of linked) levelOf(t);
  // pull parents right, next to their nearest child: long edges cross fewer columns
  const children = new Map<string, string[]>();
  for (const [c, ps] of parents) for (const p of ps) (children.get(p) ?? children.set(p, []).get(p)!).push(c);
  const byLevel = [...linked].sort((a, b) => level.get(b)! - level.get(a)!);
  for (const t of byLevel) {
    const kids = children.get(t)?.filter((c) => c !== t) ?? [];
    if (kids.length) level.set(t, Math.max(level.get(t)!, Math.min(...kids.map((c) => level.get(c)!)) - 1));
  }
  const layers: string[][] = [];
  for (const t of [...linked].sort()) (layers[level.get(t)!] ??= []).push(t);

  const pos: Positions = {};
  const neighbours = (t: string) => {
    const out: string[] = [...(parents.get(t) ?? [])];
    for (const [child, ps] of parents) if (ps.has(t)) out.push(child);
    return out;
  };
  let x = 0;
  let bottom = 0;
  for (const layer of layers.filter(Boolean)) {
    // barycenter of already placed neighbours (parents are in earlier layers)
    const bary = (t: string) => {
      const ys = neighbours(t).filter((n) => pos[n]).map((n) => pos[n].y + sizes[n].h / 2);
      return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : Infinity;
    };
    const ordered = [...layer].sort((a, b) => bary(a) - bary(b) || a.localeCompare(b));
    let y = 0;
    let colW = 0;
    for (const t of ordered) {
      if (y > 0 && y + sizes[t].h > MAX_COLUMN_H) { x += colW + GAP_X / 2; y = 0; colW = 0; }
      pos[t] = { x, y };
      y += sizes[t].h + GAP_Y;
      colW = Math.max(colW, sizes[t].w);
      bottom = Math.max(bottom, y);
    }
    x += colW + GAP_X;
  }

  // isolated tables: a grid under the connected part
  const lonely = m.tables.map((t) => t.name).filter((t) => !linked.has(t)).sort();
  const width = Math.max(x - GAP_X, 900);
  let gx = 0;
  let gy = linked.size ? bottom + GAP_Y : 0;
  let rowH = 0;
  for (const t of lonely) {
    if (gx > 0 && gx + sizes[t].w > width) { gx = 0; gy += rowH + GAP_Y; rowH = 0; }
    pos[t] = { x: gx, y: gy };
    gx += sizes[t].w + GAP_X / 2;
    rowH = Math.max(rowH, sizes[t].h);
  }
  return pos;
}

/** Y of a column's row inside its box (header when the column is hidden in compact mode). */
export function rowY(box: Box, index: number) {
  return index < 0 ? box.y + HEADER / 2 : box.y + HEADER + index * ROW + ROW / 2 + 3;
}

/**
 * Path from the child's FK row to the parent's key row: sides facing each other, horizontal tangents;
 * boxes overlapping horizontally (or a self reference) loop out on the right.
 */
export function relationPath(child: Box, cy: number, parent: Box, py: number) {
  let x1: number;
  let x2: number;
  let d1: number;
  let d2: number;
  if (parent.x + parent.w + 20 < child.x) { x1 = child.x; d1 = -1; x2 = parent.x + parent.w; d2 = 1; }
  else if (child.x + child.w + 20 < parent.x) { x1 = child.x + child.w; d1 = 1; x2 = parent.x; d2 = -1; }
  else { x1 = child.x + child.w; d1 = 1; x2 = parent.x + parent.w; d2 = 1; }
  const reach = Math.max(40, Math.abs(x2 - x1) / 2);
  const loop = d1 === d2 ? Math.max(40, Math.abs(cy - py) / 3) + Math.abs(x2 - x1) : 0;
  const c1 = x1 + d1 * (d1 === d2 ? loop + 20 : reach);
  const c2 = x2 + d2 * (d1 === d2 ? 20 + Math.max(0, x1 - x2) + 40 : reach);
  return { d: `M ${x1} ${cy} C ${c1} ${cy}, ${c2} ${py}, ${x2} ${py}`, start: { x: x1, y: cy, dir: d1 }, end: { x: x2, y: py, dir: d2 } };
}

export function bounds(pos: Positions, sizes: Record<string, { w: number; h: number }>, names: string[]) {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const n of names) {
    const p = pos[n];
    if (!p) continue;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x + sizes[n].w); y1 = Math.max(y1, p.y + sizes[n].h);
  }
  return Number.isFinite(x0) ? { x: x0 - PAD, y: y0 - PAD, w: x1 - x0 + PAD * 2, h: y1 - y0 + PAD * 2 } : { x: 0, y: 0, w: 100, h: 100 };
}
