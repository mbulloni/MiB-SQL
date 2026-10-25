// Test data generator: one generator per column, guessed from name and type (email, city, price, created_at…),
// seeded so the same settings give the same rows, unique columns kept unique, foreign keys filled with values
// that exist in the parent table, parents inserted before children. Pure functions, tests/datagen.test.mjs.
import { DATA, type DataSet } from './datagen-data.ts';
import type { ServerTable } from './design.ts';
import { t } from './i18n.ts';

export type GenKind =
  | 'skip' | 'null' | 'fixed' | 'sequence' | 'int' | 'decimal' | 'bool' | 'date' | 'datetime' | 'time' | 'year' | 'pattern' | 'words' | 'text'
  | 'firstName' | 'lastName' | 'fullName' | 'email' | 'phone' | 'city' | 'street' | 'zip' | 'country' | 'company' | 'url' | 'ip' | 'uuid'
  | 'list' | 'fk' | 'expr' | 'json' | 'hex';

export interface ColSpec {
  kind: GenKind;
  min?: number; max?: number; scale?: number; // int, decimal, year, words (word count), hex (bytes)
  start?: number; step?: number;              // sequence
  from?: string; to?: string;                 // date, datetime: YYYY-MM-DD
  value?: string;                             // fixed value, SQL expression, pattern, list (one per line or comma separated)
  truePct?: number;                           // bool
  nullPct?: number;                           // share of NULLs (nullable columns)
}

export interface GenColumn {
  name: string;
  type: string;         // COLUMN_TYPE: int(10) unsigned, varchar(80), enum('a','b')…
  nullable: boolean;
  autoIncrement: boolean;
  generated: boolean;
  hasDefault: boolean;
  unique: boolean;      // in a PRIMARY or UNIQUE index of its own
  maxLen: number | null;
  fk: { table: string; column: string; group?: string; index?: number } | null; // group: name of a composite foreign key
}

export interface GenSettings {
  seed: number;
  lang: 'it' | 'en';
  clear: 'none' | 'delete' | 'truncate';
  sel: string | null;
  tables: Record<string, { on: boolean; rows: number; specs: Record<string, ColSpec> }>;
}

export type Value = string | number | null | { hex: string } | { sql: string };

export const KINDS: { kind: GenKind; label: () => string }[] = [
  { kind: 'skip', label: () => t('(valore del server: AUTO_INCREMENT o DEFAULT)') },
  { kind: 'null', label: () => 'NULL' },
  { kind: 'fixed', label: () => t('Valore fisso') },
  { kind: 'sequence', label: () => t('Sequenza') },
  { kind: 'int', label: () => t('Intero casuale') },
  { kind: 'decimal', label: () => t('Decimale casuale') },
  { kind: 'bool', label: () => t('Sì/no (1/0)') },
  { kind: 'date', label: () => t('Data') },
  { kind: 'datetime', label: () => t('Data e ora') },
  { kind: 'time', label: () => t('Ora') },
  { kind: 'year', label: () => t('Anno') },
  { kind: 'list', label: () => t('Elenco di valori') },
  { kind: 'fk', label: () => t('Chiave esterna (valori esistenti)') },
  { kind: 'firstName', label: () => t('Nome (di persona)') },
  { kind: 'lastName', label: () => t('Cognome') },
  { kind: 'fullName', label: () => t('Nome e cognome') },
  { kind: 'email', label: () => 'Email' },
  { kind: 'phone', label: () => t('Telefono') },
  { kind: 'city', label: () => t('Città') },
  { kind: 'street', label: () => t('Indirizzo') },
  { kind: 'zip', label: () => t('CAP') },
  { kind: 'country', label: () => t('Paese') },
  { kind: 'company', label: () => t('Azienda') },
  { kind: 'url', label: () => 'URL' },
  { kind: 'ip', label: () => t('Indirizzo IP') },
  { kind: 'uuid', label: () => 'UUID' },
  { kind: 'words', label: () => t('Parole') },
  { kind: 'text', label: () => t('Testo (frasi)') },
  { kind: 'pattern', label: () => t('Modello (# cifra, ? lettera, * alfanumerico)') },
  { kind: 'json', label: () => 'JSON' },
  { kind: 'hex', label: () => t('Binario casuale') },
  { kind: 'expr', label: () => t('Espressione SQL') },
];

// ---------------------------------------------------------------- random

/** mulberry32: small, fast, seedable. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed from text (table.column), so each column has its own stream and adding a column does not change the others. */
export function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------------------------------------------------------------- column types

const INT_MAX: Record<string, [number, number]> = {
  tinyint: [127, 255], smallint: [32767, 65535], mediumint: [8388607, 16777215], int: [2147483647, 4294967295], integer: [2147483647, 4294967295], bigint: [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
};

export const baseType = (type: string) => /^\s*([a-z]+)/i.exec(type)?.[1].toLowerCase() ?? '';
const lengthOf = (type: string) => { const m = /^\s*\w+\s*\((\d+)/.exec(type); return m ? Number(m[1]) : null; };

/** Values of enum('a','b') / set('x','y'). */
export function enumValues(type: string): string[] {
  const m = /^\s*(?:enum|set)\s*\(([\s\S]*)\)\s*$/i.exec(type);
  if (!m) return [];
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let x: RegExpExecArray | null;
  while ((x = re.exec(m[1]))) out.push(x[1].replace(/''/g, "'"));
  return out;
}

/** Largest and smallest value a numeric column accepts. */
export function numericRange(type: string): [number, number] {
  const b = baseType(type);
  const unsigned = /unsigned/i.test(type);
  if (INT_MAX[b]) { const [s, u] = INT_MAX[b]; return unsigned ? [0, u] : [-s - 1, s]; }
  const m = /^\s*(?:decimal|numeric|dec|fixed)\s*\((\d+)(?:\s*,\s*(\d+))?\)/i.exec(type);
  if (m) { const p = Number(m[1]); const s = Number(m[2] ?? 0); const max = 10 ** (p - s) - 10 ** -s; return [unsigned ? 0 : -max, max]; }
  return [unsigned ? 0 : -1e9, 1e9];
}

const scaleOf = (type: string) => { const m = /^\s*(?:decimal|numeric|dec|fixed|float|double|real)\s*\(\d+\s*,\s*(\d+)\)/i.exec(type); return m ? Number(m[1]) : /float|double|real/i.test(type) ? 2 : 0; };

/** PRIMARY / UNIQUE keys on more than one column (single-column ones are handled per column). */
export const compositeKeys = (tb: ServerTable) => tb.indexes.filter((ix) => (ix.kind === 'PRIMARY' || ix.kind === 'UNIQUE') && ix.columns.length > 1).map((ix) => ix.columns.map((c) => c.name));

/** Generator columns of a table from its definition (FKs and single-column unique indexes resolved). */
export function columnsOf(tb: ServerTable): GenColumn[] {
  const uniqueCols = new Set(tb.indexes.filter((ix) => (ix.kind === 'PRIMARY' || ix.kind === 'UNIQUE') && ix.columns.length === 1).map((ix) => ix.columns[0].name.toLowerCase()));
  return tb.columns.map((c) => {
    const fk = tb.foreignKeys.find((f) => f.columns.some((x) => x.toLowerCase() === c.name.toLowerCase()));
    const fkAt = fk ? fk.columns.findIndex((x) => x.toLowerCase() === c.name.toLowerCase()) : -1;
    // MariaDB stores JSON as LONGTEXT with a json_valid() check
    const json = /json_valid/i.test(c.check ?? '') || (tb.checks ?? []).some((k) => new RegExp(`json_valid\\(\\s*\`?${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\s*\\)`, 'i').test(k.expr));
    const b = baseType(c.type);
    return {
      name: c.name, type: json ? 'json' : c.type, nullable: c.nullable, autoIncrement: c.autoIncrement, generated: !!c.generated, hasDefault: c.default !== null,
      unique: uniqueCols.has(c.name.toLowerCase()),
      maxLen: /char|binary/.test(b) ? lengthOf(c.type) : b === 'tinytext' || b === 'tinyblob' ? 255 : b === 'text' || b === 'blob' ? 65535 : null,
      fk: fk ? { table: fk.refTable, column: fk.refColumns[fkAt], ...(fk.columns.length > 1 ? { group: fk.name, index: fkAt } : {}) } : null,
    };
  });
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const yearsAgo = (n: number) => { const d = new Date(); d.setFullYear(d.getFullYear() - n); return iso(d); };

/** Generator guessed from the column name and type. */
export function guess(c: GenColumn): ColSpec {
  const n = c.name.toLowerCase();
  const b = baseType(c.type);
  const nullPct = c.nullable && !c.unique ? 10 : 0;
  const s = (spec: ColSpec): ColSpec => ({ nullPct, ...spec });
  if (c.generated) return { kind: 'skip' };
  if (c.autoIncrement) return { kind: 'skip' };
  if (c.fk) return s({ kind: 'fk' });
  if (b === 'enum' || b === 'set') return s({ kind: 'list', value: enumValues(c.type).join('\n') });
  const isText = /char|text/.test(b);
  const isInt = !!INT_MAX[b];
  const isDec = /decimal|numeric|dec|fixed|float|double|real/.test(b);
  if (isText || b === '') {
    if (/e-?mail/.test(n)) return s({ kind: 'email' });
    if (/^(first_?name|firstname|nome|given_?name|name_first)$/.test(n)) return s({ kind: 'firstName' });
    if (/^(last_?name|lastname|surname|cognome|family_?name)$/.test(n)) return s({ kind: 'lastName' });
    if (/(full_?name|^name$|^nome$|customer|cliente|contact|contatto|person|persona|owner|author|autore|user_?name|nominativo)/.test(n)) return s({ kind: /user_?name/.test(n) ? 'pattern' : 'fullName', ...(/user_?name/.test(n) ? { value: 'user####' } : {}) });
    if (/(city|citta|città|comune|town|localita)/.test(n)) return s({ kind: 'city' });
    if (/(address|indirizzo|street|via$|^via|strada)/.test(n)) return s({ kind: 'street' });
    if (/(zip|cap$|^cap|postal|postcode)/.test(n)) return s({ kind: 'zip' });
    if (/(country|paese|nazione|stato_?estero|nation)/.test(n)) return s({ kind: 'country' });
    if (/(phone|tel|mobile|cell|fax)/.test(n)) return s({ kind: 'phone' });
    if (/(company|azienda|ditta|societa|società|organization|ragione_?sociale|vendor|fornitore|supplier)/.test(n)) return s({ kind: 'company' });
    if (/(url|website|sito|link|homepage)/.test(n)) return s({ kind: 'url' });
    if (/(^ip$|_ip$|ip_?addr)/.test(n)) return s({ kind: 'ip' });
    if (/(uuid|guid)/.test(n)) return s({ kind: 'uuid' });
    if (/(sku|code|codice|cod_|serial|matricola|barcode|ean)/.test(n)) return s({ kind: 'pattern', value: c.maxLen && c.maxLen < 8 ? '?'.repeat(Math.min(3, c.maxLen)) : 'P-######' });
    if (/(color|colore)/.test(n)) return s({ kind: 'list', value: t('rosso\nverde\nblu\nnero\nbianco\ngiallo') });
    if (/(status|stato|state|type|tipo|category|categoria|level|livello)/.test(n)) return s({ kind: 'list', value: t('attivo\nsospeso\nchiuso') });
    if (b === 'text' || b === 'mediumtext' || b === 'longtext' || /(desc|note|comment|message|messaggio|body|testo|content|bio)/.test(n)) return s({ kind: 'text', min: 5, max: 30 });
    if (/(title|titolo|subject|oggetto|label|etichetta|^name|nome)/.test(n)) return s({ kind: 'words', min: 2, max: 4 });
    return s({ kind: 'words', min: 1, max: 3 });
  }
  if (b === 'uuid') return s({ kind: 'uuid' });
  if (b === 'inet4' || b === 'inet6') return s({ kind: 'ip' });
  if (b === 'json') return s({ kind: 'json' });
  if (b === 'date') return s({ kind: 'date', from: /birth|nascita|dob/.test(n) ? '1950-01-01' : yearsAgo(2), to: /birth|nascita|dob/.test(n) ? '2005-12-31' : iso(new Date()) });
  if (b === 'datetime' || b === 'timestamp') return s({ kind: 'datetime', from: yearsAgo(2), to: iso(new Date()) });
  if (b === 'time') return s({ kind: 'time' });
  if (b === 'year') return s({ kind: 'year', min: 2000, max: new Date().getFullYear() });
  if (b === 'bit' || b === 'bool' || b === 'boolean' || (b === 'tinyint' && lengthOf(c.type) === 1) || /^(is_|has_|flag|attivo|active|enabled|abilitato)/.test(n)) return s({ kind: 'bool', truePct: 70 });
  if (/blob|binary/.test(b)) {
    // BINARY(n) is fixed length, VARBINARY(n) at most n bytes
    const n = c.maxLen ?? 32;
    return s({ kind: 'hex', min: b === 'binary' ? n : Math.min(8, n), max: Math.min(32, n) });
  }
  if (/geometry|point|polygon|linestring/.test(b)) return { kind: 'null' };
  if (isInt) {
    const [lo, hi] = numericRange(c.type);
    if (c.unique) return { kind: 'sequence', start: 1, step: 1 };
    if (/(qty|quantity|quantita|quantità|qta|pezzi|count|numero|num_)/.test(n)) return s({ kind: 'int', min: 1, max: 20 });
    if (/(age|eta|età)/.test(n)) return s({ kind: 'int', min: 18, max: 90 });
    if (/(stock|giacenza|scorta)/.test(n)) return s({ kind: 'int', min: 0, max: 500 });
    if (/(year|anno)/.test(n)) return s({ kind: 'int', min: 2000, max: new Date().getFullYear() });
    return s({ kind: 'int', min: Math.max(lo, 0), max: Math.min(hi, 1000) });
  }
  if (isDec) {
    const [lo, hi] = numericRange(c.type);
    const scale = scaleOf(c.type);
    if (/(price|prezzo|amount|importo|total|totale|cost|costo|salary|stipendio|fee|imponibile)/.test(n)) return s({ kind: 'decimal', min: Math.max(lo, 1), max: Math.min(hi, 1000), scale: Math.min(scale, 2) || 2 });
    if (/(discount|sconto|rate|tasso|percent|perc|iva|vat|tax)/.test(n)) return s({ kind: 'decimal', min: 0, max: Math.min(hi, 30), scale: Math.min(scale, 2) });
    return s({ kind: 'decimal', min: Math.max(lo, 0), max: Math.min(hi, 1000), scale });
  }
  return s({ kind: 'words', min: 1, max: 2 });
}

// ---------------------------------------------------------------- generation

const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const parseDay = (s: string | undefined, fallback: string) => { const d = new Date(`${(s || fallback).slice(0, 10)}T00:00:00Z`); return Number.isNaN(d.getTime()) ? new Date(`${fallback}T00:00:00Z`) : d; };
export const listValues = (v: string | undefined) => (v ?? '').split(/\r?\n|,/).map((x) => x.trim()).filter((x) => x !== '');

export interface GenContext {
  seed: number;
  lang: 'it' | 'en';
  table: string;
  fkValues?: Record<string, (string | number)[]>;   // column → values of the referenced column
  fkTuples?: Record<string, (string | number | null)[][]>; // composite foreign key → rows of the referenced columns
  existing?: Record<string, Set<string>>;          // unique column → values already in the table
  keys?: string[][];                               // composite unique keys (column names)
  existingKeys?: Set<string>[];                    // per key: tuples already in the table (values joined by \u001f)
}

/** Rows generator for the chosen columns (kind 'skip' columns are left out of the INSERT). */
export function generator(cols: GenColumn[], specs: Record<string, ColSpec>, ctx: GenContext) {
  const data: DataSet = DATA[ctx.lang];
  const used = cols.filter((c) => (specs[c.name]?.kind ?? 'skip') !== 'skip');
  let row = 0;
  // names generated in the current row, so the email of the same row matches the person
  const person: { first?: string; last?: string } = {};
  const tuples: Record<string, (string | number | null)[] | null> = {}; // composite foreign keys: one parent row per row
  const gens = used.map((c) => {
    const spec = specs[c.name];
    const r = rng(hash(`${ctx.seed}:${ctx.table}.${c.name}`));
    const int = (lo: number, hi: number) => Math.floor(lo + r() * (hi - lo + 1));
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
    const seen = new Set<string>(ctx.existing?.[c.name] ?? []);
    let counter = 0;
    const fit = (v: string) => (c.maxLen && v.length > c.maxLen ? v.slice(0, c.maxLen) : v);
    const words = (lo: number, hi: number) => Array.from({ length: int(lo, hi) }, () => pick(data.words)).join(' ');
    const pattern = (p: string) => p.replace(/\\(.)|[#?*]/g, (m, lit) => lit ?? (m === '#' ? String(int(0, 9)) : m === '?' ? String.fromCharCode(65 + int(0, 25)) : '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[int(0, 35)]));
    const list = listValues(spec.value);
    const fks = ctx.fkValues?.[c.name] ?? [];
    const one = (): Value => {
      switch (spec.kind) {
        case 'null': return null;
        case 'fixed': return spec.value ?? '';
        case 'expr': return { sql: spec.value || 'NULL' };
        case 'sequence': return (spec.start ?? 1) + row * (spec.step ?? 1);
        case 'int': { const lo = Math.ceil(spec.min ?? 0); const hi = Math.floor(spec.max ?? 1000); return int(Math.min(lo, hi), Math.max(lo, hi)); }
        case 'decimal': {
          const lo = spec.min ?? 0; const hi = spec.max ?? 1000; const sc = spec.scale ?? 2;
          return Number((lo + r() * (hi - lo)).toFixed(sc));
        }
        case 'bool': return r() * 100 < (spec.truePct ?? 50) ? 1 : 0;
        case 'date': case 'datetime': {
          const a = parseDay(spec.from, '2020-01-01').getTime();
          const b = parseDay(spec.to, '2025-12-31').getTime() + (spec.kind === 'datetime' ? 86399000 : 0);
          const d = new Date(a + r() * Math.max(0, b - a));
          const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
          return spec.kind === 'date' ? day : `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
        }
        case 'time': return `${pad(int(0, 23))}:${pad(int(0, 59))}:${pad(int(0, 59))}`;
        case 'year': return int(spec.min ?? 2000, spec.max ?? 2030);
        case 'list': return list.length ? pick(list) : null;
        case 'fk':
          if (c.fk?.group) {
            const all = ctx.fkTuples?.[c.fk.group] ?? [];
            if (!(c.fk.group in tuples)) tuples[c.fk.group] = all.length ? pick(all) : null;
            const tu = tuples[c.fk.group];
            if (tu) return tu[c.fk.index ?? 0];
            if (c.nullable) return null;
            throw new Error(t('Nessun valore in {0}.{1} per riempire la chiave esterna {2}: genera prima le righe di {0}.', c.fk.table, c.fk.column, c.fk.group));
          }
          if (!fks.length) {
            if (c.nullable) return null;
            throw new Error(t('Nessun valore in {0}.{1} per riempire la chiave esterna {2}: genera prima le righe di {0}.', c.fk?.table ?? '?', c.fk?.column ?? '?', c.name));
          }
          return pick(fks);
        case 'firstName': return (person.first = pick(data.first));
        case 'lastName': return (person.last = pick(data.last));
        case 'fullName': person.first = pick(data.first); person.last = pick(data.last); return `${person.first} ${person.last}`;
        case 'email': return `${ascii(person.first ?? pick(data.first))}.${ascii(person.last ?? pick(data.last))}${int(1, 99)}@${pick(data.domains)}`;
        case 'phone': return pattern(data.phone);
        case 'city': return pick(data.cities);
        case 'street': { const st = pick(data.streets); const no = int(1, 200); return ctx.lang === 'it' ? `${st}, ${no}` : `${no} ${st}`; }
        case 'zip': return pattern(data.zip);
        case 'country': return pick(data.countries);
        case 'company': return `${pick(data.last)} ${pick(data.companySuffix)}`;
        case 'url': return `https://www.${ascii(pick(data.words))}${ascii(pick(data.words))}.${pick(data.domains).split('.').pop()}/${ascii(pick(data.words))}`;
        case 'ip': return /inet6/i.test(c.type) ? `2001:db8::${int(1, 65535).toString(16)}` : `${int(10, 223)}.${int(0, 255)}.${int(0, 255)}.${int(1, 254)}`;
        case 'uuid': {
          const h = () => Math.floor(r() * 16).toString(16);
          const x = Array.from({ length: 32 }, h);
          x[12] = '4';
          x[16] = '89ab'[Math.floor(r() * 4)];
          const j = x.join('');
          return `${j.slice(0, 8)}-${j.slice(8, 12)}-${j.slice(12, 16)}-${j.slice(16, 20)}-${j.slice(20)}`;
        }
        case 'words': return cap(words(spec.min ?? 1, spec.max ?? 3));
        case 'text': {
          const total = int(spec.min ?? 5, spec.max ?? 30);
          const parts: string[] = [];
          for (let left = total; left > 0;) { const k = Math.min(left, int(4, 10)); parts.push(`${cap(words(k, k))}.`); left -= k; }
          return parts.join(' ');
        }
        case 'pattern': return pattern(spec.value || '####');
        case 'json': return JSON.stringify({ [pick(data.words)]: pick(data.words), n: int(1, 1000), ok: r() < 0.5 });
        case 'hex': return { hex: Array.from({ length: Math.min(int(spec.min ?? 8, spec.max ?? 32), c.maxLen ?? Infinity) }, () => int(0, 255).toString(16).padStart(2, '0')).join('').toUpperCase() };
        default: return null;
      }
    };
    return () => {
      if (spec.kind !== 'sequence' && spec.kind !== 'fk' && c.nullable && spec.nullPct && r() * 100 < spec.nullPct) return null;
      let v = one();
      if (typeof v === 'string') v = fit(v);
      if (!c.unique || v === null || typeof v === 'object') return v;
      // unique column: retry, then make the value distinct
      for (let i = 0; i < 30 && seen.has(String(v)); i++) { v = one(); if (typeof v === 'string') v = fit(v); }
      if (seen.has(String(v))) {
        if (typeof v === 'number') { while (seen.has(String(v))) v = (v as number) + 1; }
        else {
          const base = String(v);
          do { counter++; const suffix = `_${counter}`; v = c.maxLen && base.length + suffix.length > c.maxLen ? base.slice(0, Math.max(0, c.maxLen - suffix.length)) + suffix : base + suffix; } while (seen.has(String(v)));
        }
      }
      seen.add(String(v));
      return v;
    };
  });
  // composite keys: a row repeating a key already generated (or in the table) is generated again, then dropped
  const names = used.map((c) => c.name);
  const keys = (ctx.keys ?? []).map((k, i) => ({ at: k.map((n) => names.indexOf(n)), seen: new Set(ctx.existingKeys?.[i] ?? []) })).filter((k) => k.at.every((x) => x >= 0));
  const keyOf = (r: Value[], at: number[]) => at.map((x) => (r[x] !== null && typeof r[x] === 'object' ? JSON.stringify(r[x]) : String(r[x]))).join('\u001f');
  let skipped = 0;
  return {
    columns: names,
    get skipped() { return skipped; },
    /** Next row, or null when no row with new key values could be made. */
    next(): Value[] | null {
      for (let attempt = 0; attempt < 50; attempt++) {
        delete person.first;
        delete person.last;
        for (const k of Object.keys(tuples)) delete tuples[k];
        const out = gens.map((g) => g());
        row++;
        if (keys.every((k) => !k.seen.has(keyOf(out, k.at)))) {
          for (const k of keys) k.seen.add(keyOf(out, k.at));
          return out;
        }
      }
      skipped++;
      return null;
    },
  };
}

// ---------------------------------------------------------------- SQL

const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';

export function literal(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') return 'hex' in v ? `X'${v.hex}'` : v.sql;
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\0/g, '\\0')}'`;
}

/** Multi-row INSERT with literals (for the script). */
export function insertSql(table: string, columns: string[], rows: Value[][], db?: string) {
  return `INSERT INTO ${db ? `${qi(db)}.` : ''}${qi(table)} (${columns.map(qi).join(', ')}) VALUES\n${rows.map((r) => `  (${r.map(literal).join(', ')})`).join(',\n')};`;
}

/** Multi-row INSERT with placeholders (for direct execution): binaries as UNHEX(?), expressions inline. */
export function insertParams(table: string, columns: string[], rows: Value[][], db?: string) {
  const params: (string | number | null)[] = [];
  const tuples = rows.map((r) => `(${r.map((v) => {
    if (v !== null && typeof v === 'object') {
      if ('hex' in v) { params.push(v.hex); return 'UNHEX(?)'; }
      return v.sql;
    }
    params.push(v);
    return '?';
  }).join(', ')})`);
  return { sql: `INSERT INTO ${db ? `${qi(db)}.` : ''}${qi(table)} (${columns.map(qi).join(', ')}) VALUES ${tuples.join(', ')}`, params };
}

/**
 * Insert order: referenced tables first. Self references do not count; tables in a cycle come last, in name
 * order, and are reported (their foreign keys must be nullable or point to existing rows).
 */
export function insertOrder(tables: ServerTable[], chosen: string[]) {
  const set = new Set(chosen);
  const deps = new Map(chosen.map((n) => [n, new Set((tables.find((x) => x.name === n)?.foreignKeys ?? []).map((f) => f.refTable).filter((r) => r !== n && set.has(r)))]));
  const order: string[] = [];
  const left = new Set(chosen);
  while (left.size) {
    const ready = [...left].filter((n) => [...deps.get(n)!].every((d) => !left.has(d))).sort();
    if (!ready.length) break;
    for (const n of ready) { order.push(n); left.delete(n); }
  }
  const cycle = [...left].sort();
  return { order: [...order, ...cycle], cycle };
}
