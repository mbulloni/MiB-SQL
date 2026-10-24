// Import wizard backend: CSV (streaming parser, delimiter detection), Excel (streaming reader) and JSON
// (array or one object per line) into a new or existing table, all rows in one transaction.
const fs = require('fs');
const ExcelJS = require('exceljs');
const server = require('./server.cjs');

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';

/** CSV parser fed by chunks (RFC 4180 quoting: "" inside quotes, newlines in quoted fields). */
class CsvParser {
  constructor(delimiter = ',', quote = '"') {
    this.d = delimiter;
    this.q = quote;
    this.field = '';
    this.row = [];
    this.quoted = false;
    this.inQuotes = false;
    this.pendingQuote = false; // a quote inside quotes: closing or the first of ""
  }

  push(text) {
    const rows = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (this.inQuotes) {
        if (this.pendingQuote) {
          this.pendingQuote = false;
          if (ch === this.q) { this.field += ch; continue; }
          this.inQuotes = false; // the quote closed the field: handle ch below
        } else if (ch === this.q) { this.pendingQuote = true; continue; } else { this.field += ch; continue; }
      }
      if (ch === this.q && this.field === '' && !this.quoted) { this.inQuotes = true; this.quoted = true; continue; }
      if (ch === this.d) { this.endField(); continue; }
      if (ch === '\n') { this.endField(); rows.push(this.row); this.row = []; continue; }
      if (ch === '\r') continue;
      this.field += ch;
    }
    return rows;
  }

  endField() {
    this.row.push(this.quoted ? this.field : this.field.trim() === '' ? '' : this.field);
    this.field = '';
    this.quoted = false;
  }

  end() {
    if (this.pendingQuote) { this.pendingQuote = false; this.inQuotes = false; }
    if (this.field !== '' || this.row.length || this.quoted) { this.endField(); const r = this.row; this.row = []; return [r]; }
    return [];
  }
}

/** Most frequent candidate outside quotes on the first line (; first: Italian Excel). */
function detectDelimiter(sample) {
  const line = sample.split('\n')[0] ?? '';
  let best = ',';
  let max = 0;
  for (const d of [';', ',', '\t', '|']) {
    let n = 0;
    let q = false;
    for (const ch of line) { if (ch === '"') q = !q; else if (!q && ch === d) n++; }
    if (n > max) { max = n; best = d; }
  }
  return best;
}

const DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Text cell → SQL value: empty/NULL markers → null, decimal comma, dd/mm/yyyy dates (opts.dmy).
 * Values already typed (Excel numbers, dates) pass through.
 */
function normalize(v, opts = {}) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') return v;
  if ((opts.nullValues ?? ['']).includes(v)) return null;
  const s = v.trim();
  if (opts.decimalComma && /^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+,\d+$/.test(s)) return s.replace(/\./g, '').replace(',', '.');
  if (opts.dmy) {
    const m = DMY.exec(s);
    if (m) {
      const date = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return m[4] ? `${date} ${m[4].padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}` : date;
    }
  }
  return v;
}

/** Column type from sample values (already normalized). */
function inferType(values) {
  const vs = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (!vs.length) return 'varchar(255)';
  if (vs.every((v) => typeof v === 'boolean')) return 'tinyint(1)';
  const str = vs.map((v) => (v instanceof Date ? v.toISOString() : String(v)));
  const len = Math.max(...str.map((s) => s.length));
  // leading zeros (postcodes, codes) are text, not numbers
  if (str.some((s) => /^-?0\d/.test(s))) return `varchar(${Math.min(1000, Math.max(16, Math.ceil(len * 1.5 / 16) * 16))})`;
  if (str.every((s) => /^-?\d+$/.test(s))) {
    if (str.every((s) => Math.abs(Number(s)) <= 2147483647)) return 'int';
    if (str.every((s) => s.replace('-', '').length < 19)) return 'bigint';
  }
  if (str.every((s) => /^-?\d+(\.\d+)?$/.test(s))) {
    const scale = Math.max(...str.map((s) => (s.split('.')[1] ?? '').length));
    const int = Math.max(...str.map((s) => s.replace('-', '').split('.')[0].length));
    return scale > 6 || int + scale > 30 ? 'double' : `decimal(${Math.max(int + scale, 1) + 2},${scale})`;
  }
  if (str.every((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))) return 'date';
  if (str.every((s) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?$/.test(s))) return 'datetime';
  return len > 1000 ? 'text' : `varchar(${Math.min(1000, Math.max(16, Math.ceil(len * 1.5 / 16) * 16))})`;
}

/** Column name usable in SQL: trimmed, spaces → _, unique. */
function columnNames(headers) {
  const seen = new Map();
  return headers.map((h, i) => {
    let n = String(h ?? '').trim().replace(/\s+/g, '_').replace(/[`]/g, '').slice(0, 64) || `colonna_${i + 1}`;
    const k = n.toLowerCase();
    if (seen.has(k)) { seen.set(k, seen.get(k) + 1); n = `${n}_${seen.get(k)}`; } else seen.set(k, 1);
    return n;
  });
}

const formatOf = (file) => (/\.xlsx$/i.test(file) ? 'xlsx' : /\.(json)$/i.test(file) ? 'json' : /\.(ndjson|jsonl)$/i.test(file) ? 'ndjson' : 'csv');

function excelValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
  if (typeof v === 'object') {
    if ('result' in v) return excelValue(v.result);
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
    if ('error' in v) return null;
    return JSON.stringify(v);
  }
  return v;
}

/** Async rows of a file (arrays), header row included when present. */
async function* readRows(file, opts) {
  const format = opts.format ?? formatOf(file);
  if (format === 'csv') {
    const parser = new CsvParser(opts.delimiter ?? ',');
    const stream = fs.createReadStream(file, { encoding: opts.encoding === 'latin1' ? 'latin1' : 'utf8' });
    let first = true;
    for await (let chunk of stream) {
      if (first) { chunk = chunk.replace(/^﻿/, ''); first = false; }
      for (const r of parser.push(chunk)) yield r;
    }
    for (const r of parser.end()) yield r;
  } else if (format === 'xlsx') {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore' });
    let index = 0;
    for await (const ws of reader) {
      if (index++ !== (opts.sheet ?? 0)) continue;
      for await (const row of ws) {
        const vals = row.values.slice(1).map(excelValue);
        yield vals;
      }
      break;
    }
  } else {
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    const objs = format === 'ndjson' ? text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : JSON.parse(text);
    const list = Array.isArray(objs) ? objs : Array.isArray(objs?.data) ? objs.data : [objs];
    const keys = [];
    for (const o of list.slice(0, 1000)) for (const k of Object.keys(o ?? {})) if (!keys.includes(k)) keys.push(k);
    yield keys;
    for (const o of list) yield keys.map((k) => { const v = o?.[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v ?? null; });
  }
}

/** First rows, column names and inferred types for the wizard. */
async function preview(file, opts = {}) {
  const format = opts.format ?? formatOf(file);
  let delimiter = opts.delimiter;
  if (format === 'csv' && !delimiter) {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    delimiter = detectDelimiter(buf.subarray(0, n).toString('utf8').replace(/^﻿/, ''));
  }
  const sheets = [];
  if (format === 'xlsx') {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(file, { worksheets: 'emit', sharedStrings: 'ignore', styles: 'ignore' });
    for await (const ws of reader) { sheets.push(ws.name ?? `Foglio ${sheets.length + 1}`); }
  }
  const rows = [];
  for await (const r of readRows(file, { ...opts, format, delimiter })) {
    rows.push(r);
    if (rows.length > 200) break;
  }
  const header = opts.header ?? true;
  const width = Math.max(0, ...rows.map((r) => r.length));
  const names = columnNames(header && rows.length ? Array.from({ length: width }, (_, i) => rows[0][i]) : Array.from({ length: width }, (_, i) => `colonna_${i + 1}`));
  const body = (header ? rows.slice(1) : rows).map((r) => Array.from({ length: width }, (_, i) => normalize(r[i], opts)));
  const types = names.map((_, i) => inferType(body.map((r) => r[i])));
  return { format, delimiter, sheets, columns: names, types, rows: body.slice(0, 100), size: fs.statSync(file).size };
}

/**
 * Imports the file. opts: { format, delimiter, encoding, sheet, header, nullValues, decimalComma, dmy,
 * db, table, createSql (new table), truncate, mode: 'insert' | 'ignore' | 'replace', mapping: [{ source, target }], batch }.
 * DDL (create, truncate) runs first; the rows go in one transaction, rolled back on the first error.
 */
async function importFile(connId, file, opts, onProgress = () => {}) {
  const batch = Math.max(1, opts.batch ?? 500);
  const map = opts.mapping.filter((m) => m.target);
  if (!map.length) throw new Error('Nessuna colonna da importare.');
  const verb = opts.mode === 'replace' ? 'REPLACE' : opts.mode === 'ignore' ? 'INSERT IGNORE' : 'INSERT';
  const head = `${verb} INTO ${qi(opts.db)}.${qi(opts.table)} (${map.map((m) => qi(m.target)).join(', ')}) VALUES `;
  const tuple = `(${map.map(() => '?').join(', ')})`;
  let rows = 0;
  let line = opts.header ? 1 : 0;
  return server.withConnection(connId, async (c) => {
    if (opts.createSql) await c.query(opts.createSql);
    if (opts.truncate) await c.query(`DELETE FROM ${qi(opts.db)}.${qi(opts.table)}`);
    await c.beginTransaction();
    let pending = [];
    const flush = async () => {
      if (!pending.length) return;
      const params = pending.flat();
      await c.query(head + pending.map(() => tuple).join(', '), params);
      rows += pending.length;
      pending = [];
      onProgress({ rows });
    };
    try {
      let skipHeader = !!opts.header;
      for await (const r of readRows(file, opts)) {
        if (skipHeader) { skipHeader = false; continue; }
        line++;
        if (!r.length || (r.length === 1 && (r[0] === '' || r[0] === null))) continue; // blank line
        pending.push(map.map((m) => normalize(r[m.source], opts) ?? null));
        if (pending.length >= batch) await flush();
      }
      await flush();
      await c.commit();
    } catch (err) {
      await c.rollback().catch(() => {});
      const e = err.sqlMessage ? new server.DbError(err) : err;
      e.message = `Importazione annullata (nessuna riga inserita): ${e.message} — blocco che termina alla riga ${line} del file.`;
      throw e;
    }
    return { rows };
  });
}

module.exports = { CsvParser, detectDelimiter, normalize, inferType, columnNames, preview, importFile, readRows };
