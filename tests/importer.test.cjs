const test = require('node:test');
const assert = require('node:assert/strict');
const { CsvParser, detectDelimiter, normalize, inferType, columnNames } = require('../electron/importer.cjs');

const parse = (text, d, size = text.length) => {
  const p = new CsvParser(d);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(...p.push(text.slice(i, i + size)));
  out.push(...p.end());
  return out;
};

test('CSV quoting, escaped quotes, newlines in fields, any chunk size', () => {
  const t = 'id;nome;nota\r\n1;"Rossi; Mario";"disse ""ciao""\nsu due righe"\n2;Bianchi;\n3;" spazi ";x';
  const expected = [['id', 'nome', 'nota'], ['1', 'Rossi; Mario', 'disse "ciao"\nsu due righe'], ['2', 'Bianchi', ''], ['3', ' spazi ', 'x']];
  for (const size of [1, 2, 3, 7, 100]) assert.deepEqual(parse(t, ';', size), expected);
});

test('delimiter detection ignores quoted delimiters', () => {
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('"a;b",c,d'), ',');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
});

test('normalize: NULL markers, decimal comma, dd/mm/yyyy', () => {
  assert.equal(normalize('', {}), null);
  assert.equal(normalize('NULL', { nullValues: ['', 'NULL'] }), null);
  assert.equal(normalize('1.234,56', { decimalComma: true }), '1234.56');
  assert.equal(normalize('3,5', { decimalComma: true }), '3.5');
  assert.equal(normalize('Roma, centro', { decimalComma: true }), 'Roma, centro');
  assert.equal(normalize('7/3/2025', { dmy: true }), '2025-03-07');
  assert.equal(normalize('07.03.2025 9:05', { dmy: true }), '2025-03-07 09:05:00');
  assert.equal(normalize(42), 42);
});

test('type inference', () => {
  assert.equal(inferType(['1', '22', null]), 'int');
  assert.equal(inferType(['1', '9999999999']), 'bigint');
  assert.equal(inferType(['00123', '45']), 'varchar(16)');
  assert.equal(inferType(['1.5', '22.25']), 'decimal(6,2)');
  assert.equal(inferType(['2025-01-02']), 'date');
  assert.equal(inferType(['2025-01-02 10:00:00']), 'datetime');
  assert.equal(inferType(['ciao', 'mondo']), 'varchar(16)');
  assert.equal(inferType([null, '']), 'varchar(255)');
  assert.deepEqual(columnNames(['Nome cliente', 'nome cliente', '', 'a`b']), ['Nome_cliente', 'nome_cliente_2', 'colonna_3', 'ab']);
});
