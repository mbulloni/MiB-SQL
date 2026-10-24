import test from 'node:test';
import assert from 'node:assert/strict';
import { hints, planRows } from '../src/profile.ts';

const plan = {
  query_block: {
    select_id: 1, r_total_time_ms: 24,
    filesort: {
      sort_key: 'sum(i.qty) desc', r_total_time_ms: 0.01, r_output_rows: 3,
      temporary_table: {
        nested_loop: [
          { table: { table_name: 'c', access_type: 'ALL', rows: 500, r_rows: 500, r_loops: 1, filtered: 100, r_filtered: 100 } },
          { table: { table_name: 'o', access_type: 'ref', key: 'fk_orders_customer', rows: 19, r_rows: 40, r_loops: 500, filtered: 100, r_filtered: 25, attached_condition: "o.`status` = 'paid'" } },
          { table: { table_name: 'i', access_type: 'ALL', rows: 5, r_rows: 36500, r_loops: 1 } },
        ],
      },
    },
  },
};

test('plan rows in execution order with operations', () => {
  const r = planRows(plan);
  assert.deepEqual(r.map((x) => [x.depth, x.label, x.access ?? '']), [[0, 'ordinamento (sum(i.qty) desc)', ''], [1, 'tabella temporanea', ''], [2, 'c', 'ALL'], [2, 'o', 'ref'], [2, 'i', 'ALL']]);
  assert.equal(r[3].condition, "o.`status` = 'paid'");
  assert.equal(r[2].warn, false);
  assert.equal(r[4].warn, true); // full scan of 36500 rows, estimate 5
});

test('hints from counters and plan', () => {
  const p = { sql: '', start: 0, end: 0, ms: 1, rows: 3, affectedRows: null, db: null, error: null, stages: [], plan: { format: 'json', data: plan },
    status: [{ name: 'Select_full_join', value: 1, global: false }, { name: 'Handler_read_rnd_next', value: 50000, global: false }, { name: 'Created_tmp_tables', value: 1, global: false }] };
  const h = hints(p).map((x) => x.text);
  assert.match(h[0], /Join senza indice/);
  assert.ok(h.some((t) => /50\.000 righe scorse per 3/.test(t)));
  assert.ok(h.some((t) => /Scansione completa di i/.test(t)));
  assert.ok(h.some((t) => /in memoria/.test(t)));
  assert.match(hints({ ...p, plan: null, status: [] })[0].text, /Nessun problema/);
});
