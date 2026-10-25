// Result export: CSV, JSON, SQL INSERT and Excel writers fed one row at a time, so a whole table can be
// streamed from the server (server.streamQuery) as well as the rows already shown in a grid.
const fs = require('fs');
const ExcelJS = require('exceljs');
const { t, locale } = require('./i18n.cjs');

const NUMERIC = new Set(['TINY', 'SHORT', 'LONG', 'INT', 'INT24', 'LONGLONG', 'BIGINT', 'FLOAT', 'DOUBLE', 'DECIMAL', 'NEWDECIMAL', 'YEAR']);
const XLSX_MAX_ROWS = 1048575;

const EXT = { csv: 'csv', json: 'json', sql: 'sql', xlsx: 'xlsx' };
// a function: the module loads before the renderer reports the language
const FILTERS = () => ({
  csv: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
  json: [{ name: 'JSON', extensions: ['json'] }],
  sql: [{ name: t('Script SQL'), extensions: ['sql'] }],
  xlsx: [{ name: 'Excel', extensions: ['xlsx'] }],
});

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';

/** SQL literal of a cell: numbers and binary hex stay raw, strings are quoted with MariaDB escapes. */
function literal(v, col) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  const s = String(v);
  if (col.binary && /^0x[0-9A-F]*$/i.test(s)) return s.length > 2 ? s : "''";
  if (NUMERIC.has(col.type) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(s)) return s;
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\x1a/g, '\\Z') + "'";
}

/** Number for spreadsheets when it survives the round trip (BIGINT/DECIMAL beyond 15 digits stay text). */
function asNumber(v, col) {
  if (typeof v === 'number' || v === null) return v;
  const s = String(v);
  if (!NUMERIC.has(col.type) || !/^-?\d+(\.\d+)?$/.test(s)) return v;
  const digits = s.replace(/^-/, '').replace('.', '').replace(/^0+/, '').length;
  return digits <= 15 ? Number(s) : v;
}

/** File stream whose write() waits for 'drain', so streaming exports keep memory flat. */
function fileStream(file) {
  const out = fs.createWriteStream(file);
  let failed = null;
  out.on('error', (err) => { failed = err; });
  return {
    async write(s) {
      if (failed) throw failed;
      if (!out.write(s)) await new Promise((r) => out.once('drain', r));
    },
    end: () => new Promise((resolve, reject) => { if (failed) reject(failed); else out.end((err) => (err ? reject(err) : resolve())); }),
  };
}

function csvWriter(file, opts, columns) {
  const out = fileStream(file);
  const d = opts.delimiter ?? ',';
  const field = (v) => {
    if (v === null || v === undefined) return opts.nullAs ?? '';
    const s = String(v);
    return s.includes(d) || /["\r\n]/.test(s) || s !== s.trim() ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  let started = false;
  const start = async () => {
    started = true;
    if (opts.bom) await out.write('﻿');
    if (opts.header !== false) await out.write(columns.map((c) => field(c.name)).join(d) + '\r\n');
  };
  return {
    async row(r) { if (!started) await start(); await out.write(r.map(field).join(d) + '\r\n'); },
    async end() { if (!started) await start(); await out.end(); },
  };
}

function jsonWriter(file, opts, columns) {
  const out = fileStream(file);
  let n = 0;
  return {
    async row(r) {
      const obj = {};
      columns.forEach((c, i) => { obj[c.name] = opts.typed === false ? r[i] : asNumber(r[i], c); });
      await out.write((n++ ? ',\n  ' : '[\n  ') + JSON.stringify(obj));
    },
    async end() { await out.write(n ? '\n]\n' : '[]\n'); await out.end(); },
  };
}

function sqlWriter(file, opts, columns) {
  const out = fileStream(file);
  const batch = Math.max(1, Number(opts.batch) || 100);
  const head = `INSERT INTO ${opts.db ? qi(opts.db) + '.' : ''}${qi(opts.table || 'risultato')} (${columns.map((c) => qi(c.name)).join(', ')}) VALUES\n`;
  let pending = [];
  const flush = async () => {
    if (!pending.length) return;
    await out.write(head + pending.join(',\n') + ';\n');
    pending = [];
  };
  return {
    async row(r) {
      pending.push('(' + r.map((v, i) => literal(v, columns[i])).join(', ') + ')');
      if (pending.length >= batch) await flush();
    },
    async end() { await flush(); await out.end(); },
  };
}

function xlsxWriter(file, opts, columns) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useStyles: true });
  // the streaming writer takes views only here: assigning ws.views later is ignored
  const ws = wb.addWorksheet((opts.sheet || t('Dati')).slice(0, 31).replace(/[\\/?*[\]:]/g, '_'), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.name, key: c.name, width: Math.min(50, Math.max(10, c.name.length + 2)) }));
  ws.getRow(1).font = { bold: true };
  let n = 0;
  return {
    async row(r) {
      if (++n > XLSX_MAX_ROWS) throw new Error(t('Excel ammette al massimo {0} righe: usare CSV.', XLSX_MAX_ROWS.toLocaleString(locale())));
      ws.addRow(r.map((v, i) => asNumber(v, columns[i]))).commit();
    },
    async end() { ws.commit(); await wb.commit(); },
  };
}

const WRITERS = { csv: csvWriter, json: jsonWriter, sql: sqlWriter, xlsx: xlsxWriter };

function writer(format, file, opts, columns) {
  const make = WRITERS[format];
  if (!make) throw new Error(t('Formato non supportato: {0}', format));
  return make(file, opts, columns);
}

/** Rows already in memory (grid export). */
async function writeRows(format, file, opts, columns, rows) {
  const w = writer(format, file, opts, columns);
  for (const r of rows) await w.row(r);
  await w.end();
  return rows.length;
}

module.exports = { writer, writeRows, literal, EXT, FILTERS };
