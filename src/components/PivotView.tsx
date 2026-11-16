import { useMemo } from 'react';
import { AGGS, aggLabel, kindOf, label, pivot, pivotTable, type PivotSpec } from '../pivot';
import type { Cell, Column } from '../types';
import { t, locale } from '../i18n';

const MAX_ROWS = 2000; // rows drawn; copy and export take them all
const MAX_COLS = 200;
const fmt = (v: number | null) => (v === null ? '' : v.toLocaleString(locale(), { maximumFractionDigits: 2 }));

/** Picks an ordered list of dimension columns: chips with ×, a select to add one. */
function Dims({ name, value, columns, taken, onChange }: { name: string; value: number[]; columns: Column[]; taken: number[]; onChange: (v: number[]) => void }) {
  return (
    <span className="dims">
      <span className="dims-name">{name}</span>
      {value.map((c, i) => (
        <span key={c} className="chip">{columns[c].name}<button title={t('Rimuovi')} onClick={() => onChange(value.filter((_, j) => j !== i))}>×</button></span>
      ))}
      <select value="" onChange={(e) => e.target.value !== '' && onChange([...value, +e.target.value])} title={t('Aggiungi colonna')}>
        <option value="">+</option>
        {columns.map((c, i) => (taken.includes(i) ? null : <option key={i} value={i}>{c.name}</option>))}
      </select>
    </span>
  );
}

/** Pivot of the visible rows of a result; double-click on a cell filters the grid to its rows. */
export default function PivotView({ columns, rows, spec, onSpec, heat, onHeat, onDrill, onChart, onExport, note }: {
  columns: Column[]; rows: Cell[][]; spec: PivotSpec; onSpec: (s: PivotSpec) => void;
  heat: boolean; onHeat: (v: boolean) => void;
  onDrill: (filters: { col: number; value: Cell }[]) => void; onChart: () => void;
  onExport: (table: { columns: Column[]; rows: Cell[][] }) => void; note?: string;
}) {
  const p = useMemo(() => pivot(rows, spec), [rows, spec]);
  const taken = [...spec.rows, ...spec.cols];
  const colKeys = p.colKeys.slice(0, MAX_COLS);
  const rowKeys = p.rowKeys.slice(0, MAX_ROWS);
  const hasCols = spec.cols.length > 0;
  // sequential shading of the cells (not of the totals), one hue from light to dark
  let max = 0;
  for (const r of p.cells) for (const v of r) if (v !== null && Math.abs(v) > max) max = Math.abs(v);
  const shade = (v: number | null) => (heat && v !== null && max > 0 ? { background: `color-mix(in srgb, var(--c1) ${Math.round((Math.abs(v) / max) * 42)}%, transparent)` } : undefined);
  const value = spec.value === null ? t('Righe') : `${aggLabel(spec.agg)} ${t('di')} ${columns[spec.value].name}`;

  const copy = () => {
    const tab = pivotTable(p, spec, columns);
    const lines = [tab.columns.map((c) => c.name).join('\t'), ...tab.rows.map((r) => r.map((v) => (v === null ? '' : String(v))).join('\t'))];
    navigator.clipboard.writeText(lines.join('\n'));
  };
  const drill = (r: number | null, c: number | null) => onDrill([
    ...(r === null ? [] : spec.rows.map((col, i) => ({ col, value: p.rowKeys[r].values[i] }))),
    ...(c === null ? [] : spec.cols.map((col, i) => ({ col, value: p.colKeys[c].values[i] }))),
  ]);
  const notes = [
    note,
    p.rowKeys.length > MAX_ROWS && t('mostrate {0} righe su {1} (copia ed esportazione le includono tutte)', MAX_ROWS.toLocaleString(locale()), p.rowKeys.length.toLocaleString(locale())),
    p.colKeys.length > MAX_COLS && t('mostrate {0} colonne su {1}', MAX_COLS, p.colKeys.length.toLocaleString(locale())),
  ].filter(Boolean).join(' · ');

  return (
    <div className="viz">
      <div className="viz-bar">
        <Dims name={t('Righe')} value={spec.rows} columns={columns} taken={taken} onChange={(v) => onSpec({ ...spec, rows: v })} />
        <Dims name={t('Colonne')} value={spec.cols} columns={columns} taken={taken} onChange={(v) => onSpec({ ...spec, cols: v })} />
        <label>{t('Valore')}{' '}<select value={spec.value ?? -1} onChange={(e) => { const v = +e.target.value; onSpec({ ...spec, value: v < 0 ? null : v, agg: v >= 0 && spec.agg === 'count' && kindOf(columns[v]) === 'number' ? 'sum' : spec.agg }); }}>
          <option value={-1}>{t('(numero di righe)')}</option>
          {columns.map((c, i) => <option key={i} value={i}>{c.name}</option>)}
        </select></label>
        <select value={spec.value === null ? 'count' : spec.agg} disabled={spec.value === null} onChange={(e) => onSpec({ ...spec, agg: e.target.value as PivotSpec['agg'] })} title={t('Aggregazione')}>
          {AGGS.map((a) => <option key={a} value={a}>{aggLabel(a)}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={heat} onChange={(e) => onHeat(e.target.checked)} />{t('Scala di colore')}</label>
        <div className="spacer" />
        <button onClick={onChart} disabled={!spec.rows.length} title={t('Grafico con le stesse righe, colonne e valore')}>{t('Grafico')}</button>
        <button onClick={copy}>{t('Copia')}</button>
        <button onClick={() => onExport(pivotTable(p, spec, columns))}>{t('Esporta…')}</button>
      </div>
      {notes && <div className="viz-note">{notes}</div>}
      <div className="pivot-wrap">
        {!rows.length ? <div className="empty">{t('Nessuna riga da mostrare.')}</div> : (
          <table className="pivot">
            <thead>
              {(hasCols ? spec.cols : [null]).map((dim, level) => (
                <tr key={level}>
                  {level === 0 && spec.rows.map((c) => <th key={c} className="dim" rowSpan={Math.max(1, spec.cols.length)}>{columns[c].name}</th>)}
                  {level === 0 && !spec.rows.length && <th className="dim" rowSpan={Math.max(1, spec.cols.length)} />}
                  {dim === null ? <th className="num">{value}</th>
                    : colKeys.map((k, j) => <th key={j} className="num" title={spec.cols.slice(0, level + 1).map((c, i) => `${columns[c].name} = ${label(k.values[i])}`).join('\n')}>{label(k.values[level])}</th>)}
                  {hasCols && level === 0 && <th className="num total" rowSpan={spec.cols.length}>{t('Totale')}</th>}
                </tr>
              ))}
            </thead>
            <tbody>
              {rowKeys.map((k, i) => (
                <tr key={k.id}>
                  {spec.rows.length ? k.values.map((v, d) => <th key={d} className={v === null ? 'dim null' : 'dim'}>{label(v)}</th>) : <th className="dim">{t('Tutte')}</th>}
                  {hasCols && colKeys.map((_, j) => (
                    <td key={j} className="num" style={shade(p.cells[i][j])} onDoubleClick={() => drill(i, j)}>{fmt(p.cells[i][j])}</td>
                  ))}
                  <td className={`num${hasCols ? ' total' : ''}`} style={hasCols ? undefined : shade(p.rowTotals[i])} onDoubleClick={() => drill(i, null)}>{fmt(p.rowTotals[i])}</td>
                </tr>
              ))}
            </tbody>
            {spec.rows.length > 0 && (
              <tfoot>
                <tr>
                  <th className="dim total" colSpan={spec.rows.length}>{t('Totale')}</th>
                  {hasCols && colKeys.map((_, j) => <td key={j} className="num total" onDoubleClick={() => drill(null, j)}>{fmt(p.colTotals[j])}</td>)}
                  <td className="num total grand">{fmt(p.grand)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        )}
      </div>
      <div className="viz-hint">{t('Doppio clic su una cella: mostra nella griglia le righe che la compongono.')}</div>
    </div>
  );
}
