import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DOC, docHtml, docMarkdown, erSvg } from '../src/docgen.ts';

const col = (name, type, o = {}) => ({ name, type, nullable: false, default: null, autoIncrement: false, onUpdate: '', collation: '', comment: '', generated: null, ...o });
const model = {
  db: 'shop', server: 'MariaDB 10.11', generated: '2026-10-25 10:00',
  tables: [
    { name: 'customers', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', comment: 'Clienti <B2C>', rows: 500, data: 65536, idx: 16384, checks: [], partitioning: null,
      columns: [col('id', 'int(10) unsigned', { autoIncrement: true }), col('email', 'varchar(120)', { comment: 'login | contatto' })],
      indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', columns: [{ name: 'id', len: null }], comment: '' }, { name: 'email', kind: 'UNIQUE', columns: [{ name: 'email', len: null }], comment: '' }], foreignKeys: [] },
    { name: 'orders', engine: 'InnoDB', collation: 'utf8mb4_unicode_ci', comment: '', rows: 20000, data: 1048576, idx: 524288, checks: [{ name: 'chk_total', expr: '`total` >= 0' }], partitioning: null,
      columns: [col('id', 'bigint unsigned', { autoIncrement: true }), col('customer_id', 'int(10) unsigned'), col('total', 'decimal(12,2)', { default: '0.00' })],
      indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', columns: [{ name: 'id', len: null }], comment: '' }, { name: 'fk_c', kind: 'INDEX', columns: [{ name: 'customer_id', len: null }], comment: '' }],
      foreignKeys: [{ name: 'fk_c', columns: ['customer_id'], refDb: 'shop', refTable: 'customers', refColumns: ['id'], onDelete: 'RESTRICT', onUpdate: 'CASCADE' }] },
  ],
  objects: [
    { kind: 'view', name: 'v_sales', ddl: 'CREATE VIEW `v_sales` AS select 1' },
    { kind: 'trigger', name: 'trg_o', ddl: 'CREATE TRIGGER trg_o BEFORE INSERT ON orders FOR EACH ROW SET NEW.total = ABS(NEW.total)', table: 'orders', timing: 'BEFORE', event: 'INSERT' },
    { kind: 'procedure', name: 'sp_x', ddl: null },
  ],
  er: {
    tables: [
      { name: 'customers', kind: 'table', rows: 500, comment: '', columns: [{ name: 'id', type: 'int', pk: true, nullable: false }, { name: 'email', type: 'varchar(120)', pk: false, nullable: false }] },
      { name: 'orders', kind: 'table', rows: 20000, comment: '', columns: [{ name: 'id', type: 'bigint', pk: true, nullable: false }, { name: 'customer_id', type: 'int', pk: false, nullable: false }] },
      { name: 'v_sales', kind: 'view', rows: null, comment: '', columns: [] },
    ],
    fks: [{ name: 'fk_c', table: 'orders', columns: ['customer_id'], refDb: 'shop', refTable: 'customers', refColumns: ['id'] }],
  },
};
const opts = { ...DEFAULT_DOC, title: 'Shop' };

test('HTML: contents, escaping, keys, relations both ways, objects, diagram', () => {
  const h = docHtml(model, { ...opts, ddl: true });
  assert.match(h, /^<!doctype html>/);
  assert.ok(h.includes('Clienti &lt;B2C&gt;'));
  assert.ok(h.includes('<span class="badge PK">PK</span><b>id</b>'));
  assert.ok(h.includes('<span class="badge UQ">UQ</span><b>email</b>'));
  assert.ok(h.includes('<span class="badge FK">FK</span><b>customer_id</b>'));
  assert.ok(h.includes('href="#t-customers">customers</a> (<code>id</code>)'));
  assert.match(h, /Riferita da[\s\S]*href="#t-orders">orders<\/a>/);
  assert.ok(h.includes('chk_total'));
  assert.ok(h.includes('BEFORE INSERT'));
  assert.ok(h.includes('CREATE TABLE `shop`.`orders`'));
  assert.ok(h.includes('id="v-v_sales"'));
  assert.ok(h.includes('Definizione non leggibile'));
  assert.ok(h.includes('<svg xmlns="http://www.w3.org/2000/svg"'));
  assert.equal((h.match(/<g class="r/g) ?? []).length, 1);
});

test('selected tables and sections only', () => {
  const h = docHtml(model, { ...opts, tables: ['customers'], diagram: false, views: false, routines: false });
  assert.ok(!h.includes('id="t-orders"'));
  assert.ok(!h.includes('<svg'));
  assert.ok(!h.includes('v_sales'));
});

test('Markdown tables escape pipes', () => {
  const md = docMarkdown(model, opts);
  assert.ok(md.startsWith('# Shop'));
  assert.ok(md.includes('| 2 | **UQ** email | `varchar(120)` | no |  |  | login \\| contatto |'));
  assert.ok(md.includes('**Riferita da**: orders(customer_id)'));
  assert.ok(md.includes('```sql\nCREATE VIEW `v_sales` AS select 1\n```'));
});

test('diagram keeps only relations between shown tables', () => {
  assert.equal((erSvg(model.er, ['orders']).match(/class="r/g) ?? []).length, 0);
});
