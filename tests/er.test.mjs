import test from 'node:test';
import assert from 'node:assert/strict';
import { autoLayout, bounds, boxSize, fkColumns, relationPath, shownColumns } from '../src/er.ts';

const t = (name, cols) => ({ name, kind: 'table', rows: 0, comment: '', columns: cols.map((c, i) => ({ name: c, type: 'int', pk: i === 0, nullable: false })) });
const model = {
  tables: [t('customers', ['id', 'name']), t('orders', ['id', 'customer_id']), t('items', ['order_id', 'product_id', 'qty']), t('products', ['id']), t('log', ['id']), t('emp', ['id', 'boss_id'])],
  fks: [
    { name: 'f1', table: 'orders', columns: ['customer_id'], refDb: 'x', refTable: 'customers', refColumns: ['id'] },
    { name: 'f2', table: 'items', columns: ['order_id'], refDb: 'x', refTable: 'orders', refColumns: ['id'] },
    { name: 'f3', table: 'items', columns: ['product_id'], refDb: 'x', refTable: 'products', refColumns: ['id'] },
    { name: 'f4', table: 'emp', columns: ['boss_id'], refDb: 'x', refTable: 'emp', refColumns: ['id'] },
  ],
};
const sizes = Object.fromEntries(model.tables.map((x) => [x.name, boxSize(x, x.columns.length, (s) => s.length * 7)]));

test('parents left of children, isolated and self-referencing tables in the grid below', () => {
  const p = autoLayout(model, sizes);
  assert.ok(p.customers.x < p.orders.x && p.orders.x < p.items.x);
  assert.ok(p.products.x < p.items.x);
  assert.equal(p.products.x, p.orders.x); // parent pulled next to its only child
  const connectedBottom = Math.max(...['customers', 'orders', 'items', 'products'].map((n) => p[n].y + sizes[n].h));
  assert.ok(p.log.y >= connectedBottom && p.emp.y >= connectedBottom);
  for (const a of Object.keys(p)) for (const b of Object.keys(p)) {
    if (a >= b) continue;
    const overlap = p[a].x < p[b].x + sizes[b].w && p[b].x < p[a].x + sizes[a].w && p[a].y < p[b].y + sizes[b].h && p[b].y < p[a].y + sizes[a].h;
    assert.ok(!overlap, `${a} overlaps ${b}`);
  }
});

test('cycles do not loop forever', () => {
  const m = { tables: [t('a', ['id', 'b']), t('b', ['id', 'a'])], fks: [
    { name: 'x', table: 'a', columns: ['b'], refDb: '', refTable: 'b', refColumns: ['id'] },
    { name: 'y', table: 'b', columns: ['a'], refDb: '', refTable: 'a', refColumns: ['id'] },
  ] };
  const p = autoLayout(m, { a: { w: 100, h: 60 }, b: { w: 100, h: 60 } });
  assert.notEqual(p.a.x, p.b.x);
});

test('compact mode keeps keys only', () => {
  const fk = fkColumns(model);
  assert.deepEqual(shownColumns(model.tables[2], fk.get('items'), true).map((c) => c.name), ['order_id', 'product_id']);
  assert.equal(shownColumns(model.tables[2], fk.get('items'), false).length, 3);
});

test('relation path picks facing sides', () => {
  const parent = { x: 0, y: 0, w: 100, h: 80 };
  const child = { x: 300, y: 50, w: 100, h: 80 };
  const r = relationPath(child, 90, parent, 40);
  assert.deepEqual([r.start.x, r.end.x], [300, 100]);
  const self = relationPath(child, 90, child, 70);
  assert.equal(self.start.x, 400);
  assert.equal(self.end.x, 400);
  assert.deepEqual(bounds({ a: { x: 10, y: 20 } }, { a: { w: 50, h: 30 } }, ['a']), { x: 0, y: 10, w: 70, h: 50 });
});
