import test from 'node:test';
import assert from 'node:assert/strict';
import { useLang } from '../src/i18n.ts';
import { chartData, compareCell, guessChart, guessPivot, MAX_BARS, niceTicks, num, OTHER, pivot, pivotTable, time, timeTicks } from '../src/pivot.ts';

useLang('it');
const col = (name, type = 'VAR_STRING', extra = {}) => ({ name, table: 't', orgTable: 't', orgName: name, db: 'd', type, length: 0, scale: 0, binary: false, notNull: false, autoIncrement: false, ...extra });
const columns = [col('id', 'LONG', { autoIncrement: true }), col('region'), col('year', 'YEAR'), col('amount', 'NEWDECIMAL'), col('day', 'DATE')];
const rows = [
  [1, 'Nord', 2024, '10.50', '2024-01-01'],
  [2, 'Nord', 2025, '20', '2024-01-02'],
  [3, 'Sud', 2024, '5', '2024-01-02'],
  [4, 'Sud', 2024, null, '2024-01-03'],
  [5, null, 2025, '1', null],
];

test('numbers and dates from cells', () => {
  assert.equal(num('12.5'), 12.5);
  assert.equal(num(' -3e2 '), -300);
  assert.equal(num('12a'), null);
  assert.equal(num(''), null);
  assert.equal(time('2024-03-01'), Date.UTC(2024, 2, 1));
  assert.equal(time('2024-03-01 10:20:30.5'), Date.UTC(2024, 2, 1, 10, 20, 30, 500));
  assert.equal(time('10:20'), null);
});

test('natural order: numbers by value, NULL and Other last', () => {
  assert.deepEqual(['10', '9', null, OTHER, 'a10', 'a9'].sort(compareCell), ['9', '10', 'a9', 'a10', null, OTHER]);
});

test('pivot sums by row and column, totals from rows', () => {
  const p = pivot(rows, { rows: [1], cols: [2], value: 3, agg: 'sum' });
  assert.deepEqual(p.rowKeys.map((k) => k.values[0]), ['Nord', 'Sud', null]);
  assert.deepEqual(p.colKeys.map((k) => k.values[0]), [2024, 2025]);
  assert.deepEqual(p.cells, [[10.5, 20], [5, null], [null, 1]]);
  assert.deepEqual(p.rowTotals, [30.5, 5, 1]);
  assert.deepEqual(p.colTotals, [15.5, 21]);
  assert.equal(p.grand, 36.5);
});

test('averages of totals come from the rows, not from the cells', () => {
  const p = pivot(rows, { rows: [1], cols: [], value: 3, agg: 'avg' });
  assert.deepEqual(p.rowTotals, [15.25, 5, 1]);
  assert.equal(p.grand, 36.5 / 4); // NULL amount ignored
});

test('count rows, count values, distinct, min, max', () => {
  assert.deepEqual(pivot(rows, { rows: [1], cols: [], value: null, agg: 'sum' }).rowTotals, [2, 2, 1]);
  assert.deepEqual(pivot(rows, { rows: [1], cols: [], value: 3, agg: 'count' }).rowTotals, [2, 1, 1]);
  assert.deepEqual(pivot(rows, { rows: [1], cols: [], value: 2, agg: 'distinct' }).rowTotals, [2, 1, 1]);
  assert.deepEqual(pivot(rows, { rows: [], cols: [], value: 3, agg: 'min' }).rowTotals, [1]);
  assert.equal(pivot(rows, { rows: [], cols: [], value: 3, agg: 'max' }).grand, 20);
  assert.equal(pivot([], { rows: [1], cols: [], value: 3, agg: 'sum' }).grand, null);
});

test('number 1 and string "1" are different keys', () => {
  const p = pivot([[1], ['1']], { rows: [0], cols: [], value: null, agg: 'count' });
  assert.equal(p.rowKeys.length, 2);
});

test('flat table for export', () => {
  const spec = { rows: [1], cols: [2], value: 3, agg: 'sum' };
  const tab = pivotTable(pivot(rows, spec), spec, columns);
  assert.deepEqual(tab.columns.map((c) => c.name), ['region', '2024', '2025', 'Totale']);
  assert.deepEqual(tab.rows.at(-1), ['Totale', 15.5, 21, 36.5]);
  assert.deepEqual(tab.rows[2], [null, null, 1, 1]);
});

test('chart: categories by x, one series per value of the series column', () => {
  const d = chartData(rows, columns, { type: 'column', x: 1, y: 3, series: 2, agg: 'sum', stacked: false, sort: 'x' });
  assert.equal(d.scale, 'band');
  assert.deepEqual(d.categories.map((c) => c.label), ['Nord', 'Sud', '(NULL)']);
  assert.deepEqual(d.series.map((s) => [s.label, s.values]), [['2024', [10.5, 5, null]], ['2025', [20, null, 1]]]);
});

test('chart: sort by value keeps Other last', () => {
  const many = Array.from({ length: MAX_BARS + 10 }, (_, i) => ['c' + i, i]);
  const cols = [col('c'), col('v', 'LONG')];
  const d = chartData(many, cols, { type: 'column', x: 0, y: 1, series: null, agg: 'sum', stacked: false, sort: 'value' });
  assert.equal(d.categories.length, MAX_BARS);
  assert.equal(d.categories.at(-1).raw, OTHER);
  assert.equal(d.categories[0].label, 'c59');
  assert.equal(d.folded.categories, 11);
  assert.equal(d.series[0].values.at(-1), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].reduce((a, b) => a + b));
});

test('chart: series past eight fold into Other', () => {
  const r = Array.from({ length: 12 }, (_, i) => ['x', 's' + i, i < 3 ? 2 : 1]).flatMap((x, i) => (i < 3 ? [x, x] : [x]));
  const d = chartData(r, [col('x'), col('s'), col('v', 'LONG')], { type: 'column', x: 0, y: 2, series: 1, agg: 'sum', stacked: false, sort: 'x' });
  assert.equal(d.series.length, 8);
  assert.equal(d.series.at(-1).other, true);
  assert.equal(d.series.at(-1).label, 'Altro');
  assert.equal(d.folded.series, 5);
});

test('chart: dates make a time axis, rows without a date are dropped', () => {
  const d = chartData(rows, columns, { type: 'line', x: 4, y: 3, series: null, agg: 'sum', stacked: false, sort: 'x' });
  assert.equal(d.scale, 'time');
  assert.deepEqual(d.categories.map((c) => c.pos), [Date.UTC(2024, 0, 1), Date.UTC(2024, 0, 2), Date.UTC(2024, 0, 3)]);
  assert.deepEqual(d.series[0].values, [10.5, 25, null]);
  assert.equal(d.dropped, 1);
});

test('chart: scatter points with three series and Other', () => {
  const r = Array.from({ length: 10 }, (_, i) => [i, i * 2, 'g' + (i % 5)]);
  const d = chartData(r, [col('a', 'LONG'), col('b', 'LONG'), col('g')], { type: 'scatter', x: 0, y: 1, series: 2, agg: 'sum', stacked: false, sort: 'x' });
  assert.equal(d.points.length, 10);
  assert.equal(d.series.length, 4);
  assert.equal(d.series[3].other, true);
});

test('guesses: dates → line, text → columns, ids skipped', () => {
  assert.deepEqual(guessChart(columns), { type: 'line', x: 4, y: 2, series: null, agg: 'sum', stacked: false, sort: 'x' });
  assert.equal(guessChart([col('id', 'LONG', { autoIncrement: true }), col('name')]).y, null);
  assert.equal(guessChart([col('a', 'DOUBLE'), col('b', 'DOUBLE')]).type, 'scatter');
  assert.deepEqual(guessPivot([col('name'), col('n', 'LONG')]), { rows: [0], cols: [], value: 1, agg: 'sum' });
});

test('nice ticks', () => {
  assert.deepEqual(niceTicks(0, 97), [0, 20, 40, 60, 80, 100]);
  assert.deepEqual(niceTicks(-3, 7, 5), [-4, -2, 0, 2, 4, 6, 8]);
  assert.deepEqual(niceTicks(5, 5), [2, 3, 4, 5, 6, 7, 8]);
  const tt = timeTicks(Date.UTC(2020, 0, 15), Date.UTC(2026, 5, 1));
  assert.deepEqual(tt.ticks.map((x) => new Date(x).getUTCFullYear()), [2022, 2024, 2026]);
  assert.equal(timeTicks(Date.UTC(2024, 0, 1), Date.UTC(2024, 11, 31)).ticks.length, 6);
});

test('text columns holding only dates are dates', () => {
  const cols = [col('m'), col('v', 'LONG')];
  const r = [['2024-01-01', 1], [null, 2], ['2024-02-01', 3]];
  assert.equal(guessChart(cols, r).type, 'line');
  assert.equal(chartData(r, cols, { type: 'line', x: 0, y: 1, series: null, agg: 'sum', stacked: false, sort: 'x' }).scale, 'time');
  assert.equal(guessChart(cols, [['2024-01-01', 1], ['abc', 2]]).type, 'column');
});
