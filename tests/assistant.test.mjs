import test from 'node:test';
import assert from 'node:assert/strict';
import { inlineSegments, parseBlocks, schemaText, userMessage } from '../src/assistant.ts';

const model = {
  tables: [
    { name: 'customers', kind: 'table', rows: 500, comment: 'Clienti', columns: [{ name: 'id', type: 'int', pk: true, nullable: false }, { name: 'city', type: 'varchar(80)', pk: false, nullable: true }] },
    { name: 'orders', kind: 'table', rows: 20000, comment: '', columns: [{ name: 'id', type: 'bigint', pk: true, nullable: false }, { name: 'customer_id', type: 'int', pk: false, nullable: false }] },
    { name: 'v_sales', kind: 'view', rows: null, comment: '', columns: [{ name: 'total', type: 'decimal(12,2)', pk: false, nullable: true }] },
  ],
  fks: [{ name: 'fk', table: 'orders', columns: ['customer_id'], refDb: 'shop', refTable: 'customers', refColumns: ['id'] }],
};

test('schema description', () => {
  assert.equal(schemaText(model, 'shop', 'MariaDB 10.11'), [
    'Server: MariaDB 10.11', 'Database: shop', '',
    'TABELLA customers (id int PK NOT NULL, city varchar(80)), ~500 righe -- Clienti',
    'TABELLA orders (id bigint PK NOT NULL, customer_id int FK NOT NULL), ~20000 righe',
    'VISTA v_sales (total decimal(12,2))',
    '', 'Relazioni:', 'orders(customer_id) -> customers(id)',
  ].join('\n'));
});

test('user message carries only the chosen context', () => {
  assert.equal(userMessage(' Perché è lenta? ', {}), 'Perché è lenta?');
  const m = userMessage('Correggi', { script: 'select nope from orders', error: "Unknown column 'nope'" });
  assert.match(m, /^Correggi\n\nScript corrente nell'editor:\n```sql\nselect nope from orders\n```\n\nUltimo errore restituito dal server:\nUnknown column 'nope'$/);
});

test('reply parsing: text and code blocks, unterminated fence while streaming', () => {
  assert.deepEqual(parseBlocks('Ecco la query:\n```sql\nSELECT 1;\n```\nFatto.'), [
    { type: 'text', text: 'Ecco la query:' }, { type: 'code', lang: 'sql', text: 'SELECT 1;' }, { type: 'text', text: 'Fatto.' },
  ]);
  assert.deepEqual(parseBlocks('Prima\n```\nSELECT 2'), [{ type: 'text', text: 'Prima' }, { type: 'code', lang: 'sql', text: 'SELECT 2' }]);
  assert.deepEqual(inlineSegments('Usa **LIMIT** e `id`.'), [
    { kind: 'plain', text: 'Usa ' }, { kind: 'bold', text: 'LIMIT' }, { kind: 'plain', text: ' e ' }, { kind: 'code', text: 'id' }, { kind: 'plain', text: '.' },
  ]);
});
