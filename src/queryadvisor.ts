// Query optimizer helpers: reads a statement with the formatter's tokenizer (tables and aliases, columns used
// in WHERE / JOIN … ON / ORDER BY / GROUP BY and how they are compared), combines it with EXPLAIN and the
// existing indexes, and returns the problems found and the indexes worth adding. Also normalizes statements
// so the slow log can be grouped like performance_schema digests. Pure functions, tests/queryadvisor.test.mjs.
import { KEYWORDS, tokenize, type Tok } from './format.ts';
import { t } from './i18n.ts';
import type { Index } from './indexes.ts';

export interface TableInfo { name: string; columns: { name: string; type: string }[]; indexes: Index[]; rows: number | null }
export interface PlanRow { id?: unknown; select_type?: unknown; table?: unknown; type?: unknown; possible_keys?: unknown; key?: unknown; ref?: unknown; rows?: unknown; filtered?: unknown; extra?: unknown }
export interface Issue { level: 'warning' | 'info' | 'ok'; text: string }
export interface Suggestion { table: string; columns: string[]; name: string; sql: string; reason: string }
export interface TableRef { table: string; alias: string }
export interface Predicate { table: string; column: string; kind: 'eq' | 'range' | 'join'; clause: 'where' | 'on' }

const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';
const unq = (tk: Tok) => (tk.k === 'qid' ? tk.v.slice(1, -1).replace(/``/g, '`') : tk.v);
const up = (tk: Tok | undefined) => (tk && tk.k === 'word' ? tk.v.toUpperCase() : '');
const isName = (tk: Tok | undefined) => !!tk && (tk.k === 'qid' || (tk.k === 'word' && !KEYWORDS.has(tk.v.toUpperCase())));
const CMP = new Set(['=', '<=>', '<', '>', '<=', '>=', '<>', '!=']);
const STRING_TYPE = /char|text|enum|set|binary|blob/i;
const CLAUSES = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'ON', 'SET', 'USING', 'UNION', 'VALUES', 'INTO', 'UPDATE', 'DELETE', 'WINDOW', 'RETURNING']);
const JOIN_WORDS = new Set(['JOIN', 'STRAIGHT_JOIN']);

const significant = (sql: string) => tokenize(sql).filter((x) => x.k !== 'ws' && x.k !== 'line' && x.k !== 'block');

/** Tables of FROM / JOIN / UPDATE / DELETE … FROM with their aliases (subqueries in FROM are skipped). */
export function tableRefs(sql: string): TableRef[] {
  const tk = significant(sql);
  const out: TableRef[] = [];
  let inFrom = false;
  let depth = 0;
  const fromDepth: number[] = [];
  const read = (i: number) => {
    if (!isName(tk[i])) return i;
    let name = unq(tk[i]);
    let j = i + 1;
    if (tk[j]?.v === '.' && isName(tk[j + 1])) { name = unq(tk[j + 1]); j += 2; }
    let alias = name;
    if (up(tk[j]) === 'AS') j++;
    if (isName(tk[j]) && tk[j + 1]?.v !== '(') { alias = unq(tk[j]); j++; }
    out.push({ table: name, alias });
    return j;
  };
  for (let i = 0; i < tk.length; i++) {
    const x = tk[i];
    if (x.v === '(') { depth++; continue; }
    if (x.v === ')') { depth--; if (fromDepth.length && fromDepth[fromDepth.length - 1] > depth) { fromDepth.pop(); inFrom = fromDepth.length > 0; } continue; }
    const w = up(x);
    if (w === 'FROM' || JOIN_WORDS.has(w) || (w === 'UPDATE' && i === 0)) {
      inFrom = true;
      fromDepth.push(depth);
      const j = read(i + 1);
      if (j > i + 1) i = j - 1;
      continue;
    }
    if (inFrom && x.v === ',' && depth === fromDepth[fromDepth.length - 1]) {
      const j = read(i + 1);
      if (j > i + 1) i = j - 1;
      continue;
    }
    if (CLAUSES.has(w) && w !== 'FROM') inFrom = w === 'ON' || w === 'USING' ? inFrom : false;
  }
  return out;
}

interface ColRef { table: string | null; column: string; at: number; end: number }

/** Column reference starting at token i ([alias.]column, not a function call), resolved to a table. */
function colAt(tk: Tok[], i: number, refs: TableRef[], tables: Record<string, TableInfo>): ColRef | null {
  if (!isName(tk[i]) || tk[i - 1]?.v === '.') return null;
  let qual: string | null = null;
  let name = unq(tk[i]);
  let end = i + 1;
  if (tk[i + 1]?.v === '.' && (isName(tk[i + 2]) || tk[i + 2]?.k === 'word')) {
    qual = name;
    name = unq(tk[i + 2]);
    end = i + 3;
    // db.table.column
    if (tk[i + 3]?.v === '.' && tk[i + 4]) { qual = name; name = unq(tk[i + 4]); end = i + 5; }
  }
  if (tk[end]?.v === '(') return null;
  const has = (tb: string) => tables[tb]?.columns.some((c) => c.name.toLowerCase() === name.toLowerCase());
  if (qual) {
    const ref = refs.find((r) => r.alias === qual) ?? refs.find((r) => r.table === qual);
    return ref ? { table: ref.table, column: name, at: i, end } : null;
  }
  const owners = [...new Set(refs.map((r) => r.table))].filter(has);
  return owners.length === 1 ? { table: owners[0], column: name, at: i, end } : null;
}

const typeOf = (tables: Record<string, TableInfo>, table: string, col: string) => tables[table]?.columns.find((c) => c.name.toLowerCase() === col.toLowerCase())?.type ?? '';

/** Columns compared in WHERE and ON, ORDER BY and GROUP BY lists, plus the lint issues found on the way. */
export function readQuery(sql: string, tables: Record<string, TableInfo>) {
  const tk = significant(sql);
  const refs = tableRefs(sql);
  const preds: Predicate[] = [];
  const order: { table: string | null; column: string; desc: boolean }[] = [];
  const group: { table: string | null; column: string }[] = [];
  const issues: Issue[] = [];
  const clauseAt: string[] = []; // clause per paren depth
  let depth = 0;
  let clause = '';
  let whereOr = false;
  const literal = (x: Tok | undefined) => !!x && (x.k === 'str' || x.k === 'num' || x.k === 'var' || up(x) === 'NULL' || up(x) === 'TRUE' || up(x) === 'FALSE');

  for (let i = 0; i < tk.length; i++) {
    const x = tk[i];
    if (x.v === '(') { clauseAt[depth] = clause; depth++; continue; }
    if (x.v === ')') { depth = Math.max(0, depth - 1); clause = clauseAt[depth] ?? ''; continue; }
    const w = up(x);
    if (w === 'LIMIT' && tk[i + 1]?.k === 'num' && tk[i + 2]?.v === ',' && Number(tk[i + 1].v) >= 10000) issues.push({ level: 'info', text: t('LIMIT con offset {0}: il server legge e scarta tutte le righe precedenti. Per la paginazione usa una condizione sulla chiave (WHERE id > ultimo_id … LIMIT n).', tk[i + 1].v) });
    if (w === 'OFFSET' && tk[i + 1]?.k === 'num' && Number(tk[i + 1].v) >= 10000) issues.push({ level: 'info', text: t('OFFSET {0}: il server legge e scarta tutte le righe precedenti. Per la paginazione usa una condizione sulla chiave (WHERE id > ultimo_id … LIMIT n).', tk[i + 1].v) });
    if (CLAUSES.has(w) || JOIN_WORDS.has(w)) { clause = w === 'GROUP' || w === 'ORDER' ? w : JOIN_WORDS.has(w) ? 'FROM' : w; continue; }
    if (w === 'OR' && clause === 'WHERE' && depth === 0) whereOr = true;

    if (clause === 'SELECT' && x.v === '*' && (tk[i - 1]?.v === ',' || up(tk[i - 1]) === 'SELECT' || up(tk[i - 1]) === 'DISTINCT')) {
      if (!issues.some((s) => s.text.startsWith('SELECT *'))) issues.push({ level: 'info', text: t('SELECT *: leggi solo le colonne che servono (meno dati trasferiti, e un indice può bastare a rispondere senza leggere le righe).') });
    }
    if ((clause === 'ORDER') && w === 'RAND' && tk[i + 1]?.v === '(') issues.push({ level: 'warning', text: t('ORDER BY RAND() ordina l\'intera tabella a ogni esecuzione: per estrarre righe casuali usa un intervallo casuale sulla chiave primaria.') });
    if (w === 'NOT' && up(tk[i + 1]) === 'IN' && tk[i + 2]?.v === '(' && up(tk[i + 3]) === 'SELECT') issues.push({ level: 'info', text: t('NOT IN (SELECT …) restituisce zero righe se la sottoquery contiene un NULL e spesso è più lenta: usa NOT EXISTS.') });

    if (clause !== 'WHERE' && clause !== 'ON' && clause !== 'ORDER' && clause !== 'GROUP') continue;

    // function wrapping a column inside a comparison: WHERE YEAR(d) = 2024
    if ((clause === 'WHERE' || clause === 'ON') && x.k === 'word' && tk[i + 1]?.v === '(' && !['IN', 'EXISTS', 'NOT', 'AND', 'OR', 'ANY', 'ALL', 'SOME', 'MATCH', 'AGAINST'].includes(w)) {
      let d = 0;
      let j = i + 1;
      let inner: ColRef | null = null;
      for (; j < tk.length; j++) {
        if (tk[j].v === '(') d++;
        else if (tk[j].v === ')') { d--; if (d === 0) break; }
        else if (!inner && d === 1) inner = colAt(tk, j, refs, tables);
      }
      const after = tk[j + 1];
      if (inner && after && (CMP.has(after.v) || ['LIKE', 'BETWEEN', 'IN'].includes(up(after)))) {
        issues.push({ level: 'warning', text: t('{0}({1}) nella condizione impedisce l\'uso di un indice su {1}: confronta la colonna così com\'è (es. per le date un intervallo: {1} >= \'2024-01-01\' AND {1} < \'2025-01-01\').', x.v.toUpperCase(), inner.column) });
      }
      i = j;
      continue;
    }

    const c = colAt(tk, i, refs, tables);
    if (!c) continue;
    const next = tk[c.end];
    const prev = tk[i - 1];
    if (clause === 'ORDER') {
      order.push({ table: c.table, column: c.column, desc: up(next) === 'DESC' });
      i = c.end - 1;
      continue;
    }
    if (clause === 'GROUP') { group.push({ table: c.table, column: c.column }); i = c.end - 1; continue; }
    if (!c.table) { i = c.end - 1; continue; }
    const where = clause === 'WHERE' ? 'where' : 'on';
    const op = next?.v ?? '';
    const opWord = up(next);
    const other = tk[c.end + 1];
    // join condition a.x = b.y
    if ((op === '=' || op === '<=>') && other) {
      const oc = colAt(tk, c.end + 1, refs, tables);
      if (oc && oc.table && oc.table !== c.table) {
        preds.push({ table: c.table, column: c.column, kind: 'join', clause: where });
        preds.push({ table: oc.table, column: oc.column, kind: 'join', clause: where });
        i = oc.end - 1;
        continue;
      }
    }
    if (op === '=' || op === '<=>' || opWord === 'IN' || opWord === 'IS') {
      preds.push({ table: c.table, column: c.column, kind: 'eq', clause: where });
      if (op === '=' && other?.k === 'num' && STRING_TYPE.test(typeOf(tables, c.table, c.column))) {
        issues.push({ level: 'warning', text: t('{0} è di tipo testo ma è confrontata con il numero {1}: la conversione implicita impedisce l\'uso dell\'indice. Scrivi \'{1}\'.', c.column, other.v) });
      }
    } else if (['<', '>', '<=', '>='].includes(op) || opWord === 'BETWEEN') {
      preds.push({ table: c.table, column: c.column, kind: 'range', clause: where });
    } else if (opWord === 'LIKE' || (opWord === 'NOT' && up(tk[c.end + 1]) === 'LIKE')) {
      const pat = opWord === 'LIKE' ? other : tk[c.end + 2];
      if (pat?.k === 'str' && /^['"]%/.test(pat.v)) issues.push({ level: 'warning', text: t('LIKE {0} inizia con %: nessun indice può aiutare e la tabella viene letta per intero. Per cercare parole valuta un indice FULLTEXT e MATCH … AGAINST.', pat.v) });
      else if (opWord === 'LIKE') preds.push({ table: c.table, column: c.column, kind: 'range', clause: where });
    } else if (prev && CMP.has(prev.v) && literal(tk[i - 2])) {
      // 5 = col
      preds.push({ table: c.table, column: c.column, kind: prev.v === '=' ? 'eq' : 'range', clause: where });
    }
    i = c.end - 1;
  }
  if (whereOr) {
    const cols = new Set(preds.filter((p) => p.clause === 'where').map((p) => `${p.table}.${p.column}`));
    if (cols.size > 1) issues.push({ level: 'info', text: t('OR tra condizioni su colonne diverse spesso impedisce l\'uso degli indici: se il piano mostra una scansione, prova a dividere la query in due SELECT unite da UNION.') });
  }
  return { refs, preds, order, group, issues };
}

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

function indexName(table: string, cols: string[], existing: Set<string>) {
  let base = `idx_${table}_${cols.join('_')}`.replace(/[^\w$]/g, '_').slice(0, 60);
  let name = base;
  for (let n = 2; existing.has(name.toLowerCase()); n++) name = `${base.slice(0, 58)}_${n}`;
  return name;
}

/** Problems and index suggestions for one statement, given its EXPLAIN (null when it could not run). */
export function analyzeQuery(sql: string, plan: PlanRow[] | null, tables: Record<string, TableInfo>) {
  const q = readQuery(sql, tables);
  const issues: Issue[] = [...q.issues];
  const suggestions: Suggestion[] = [];
  const aliasTable = new Map(q.refs.map((r) => [r.alias, r.table]));
  const planOf = (alias: string) => plan?.find((r) => text(r.table) === alias);

  for (const r of plan ?? []) {
    const alias = text(r.table);
    const table = aliasTable.get(alias) ?? alias;
    const rows = Number(r.rows ?? 0);
    const extra = text(r.extra);
    const type = text(r.type);
    if (type === 'ALL' && rows > 1000) issues.push({ level: 'warning', text: t('Scansione completa di {0}: circa {1} righe lette.', table, rows.toLocaleString()) });
    else if (type === 'index' && rows > 1000 && !/Using index/.test(extra)) issues.push({ level: 'info', text: t('{0} viene letta per intero seguendo un indice (type = index), circa {1} righe.', table, rows.toLocaleString()) });
    if ((type === 'ref' || type === 'range' || type === 'index_merge') && text(r.key) && rows > 10000) issues.push({ level: 'info', text: t('{0}: l\'indice {1} seleziona ancora circa {2} righe; un indice composto con più colonne della condizione sarebbe più selettivo.', table, text(r.key), rows.toLocaleString()) });
    if (/Using join buffer/i.test(extra)) issues.push({ level: 'warning', text: t('Join senza indice su {0} (Using join buffer): ogni riga dell\'altra tabella la scorre tutta.', table) });
    if (/Using filesort/i.test(extra)) issues.push({ level: 'info', text: t('Ordinamento extra su {0} (Using filesort): un indice con le colonne di ORDER BY lo eviterebbe.', table) });
    if (/Using temporary/i.test(extra)) issues.push({ level: 'info', text: t('Tabella temporanea (Using temporary) per GROUP BY, DISTINCT o ORDER BY su {0}.', table) });
    if (text(r.possible_keys) && !text(r.key) && rows > 1000) issues.push({ level: 'info', text: t('Su {0} c\'erano indici utilizzabili ({1}) ma l\'ottimizzatore non ne ha scelto nessuno: le statistiche potrebbero essere vecchie (ANALYZE TABLE) o la condizione seleziona troppe righe.', table, text(r.possible_keys)) });
    if (/Impossible WHERE/i.test(extra)) issues.push({ level: 'info', text: t('La condizione WHERE non può essere vera per nessuna riga (Impossible WHERE).') });
    if (/Using index$|Using index;|Using index condition/.test(extra) && type !== 'ALL') issues.push({ level: 'ok', text: /Using index condition/.test(extra) ? t('{0}: la condizione viene verificata sull\'indice prima di leggere le righe (index condition pushdown).', table) : t('{0}: indice coprente, le righe non vengono lette.', table) });
  }

  for (const ref of q.refs) {
    const info = tables[ref.table];
    if (!info) continue;
    const pr = planOf(ref.alias);
    const type = text(pr?.type);
    const extra = text(pr?.extra);
    const needs = !plan || !pr || type === 'ALL' || type === 'index' || (!text(pr.key) && Number(pr.rows ?? 0) > 100) || Number(pr.rows ?? 0) > 10000 || /Using join buffer|Using filesort|Using temporary/.test(extra);
    if (!needs) continue;
    const mine = q.preds.filter((p) => p.table === ref.table);
    const eq = [...new Set(mine.filter((p) => p.kind === 'eq' || p.kind === 'join').map((p) => p.column))];
    const range = mine.find((p) => p.kind === 'range' && !eq.includes(p.column))?.column;
    let cols = [...eq];
    let reason = '';
    if (range) cols.push(range);
    else {
      const ord = q.order.length && q.order.every((o) => o.table === ref.table) && q.order.every((o) => o.desc === q.order[0].desc) ? q.order.map((o) => o.column)
        : q.group.length && q.group.every((g) => g.table === ref.table) ? q.group.map((g) => g.column) : [];
      for (const c of ord) if (!cols.includes(c)) cols.push(c);
    }
    cols = cols.filter((c) => !/blob|text|json|geometry/i.test(typeOf(tables, ref.table, c))).slice(0, 5);
    if (!cols.length) continue;
    const lower = cols.map((c) => c.toLowerCase());
    // an existing index already starting with these columns: the problem is elsewhere (statistics, selectivity)
    const covered = info.indexes.find((ix) => lower.every((c, i) => ix.columns[i]?.name?.toLowerCase() === c));
    if (covered) {
      if (pr && !text(pr.key)) issues.push({ level: 'info', text: t('L\'indice {0} su {1} copre già le colonne ({2}) ma non è stato usato: prova ANALYZE TABLE {1}.', covered.name, ref.table, cols.join(', ')) });
      continue;
    }
    if (suggestions.some((s) => s.table === ref.table && s.columns.join() === cols.join())) continue;
    const parts = [
      eq.length ? t('uguaglianze e join su {0}', eq.filter((c) => cols.includes(c)).join(', ')) : '',
      range ? t('intervallo su {0}', range) : '',
      !range && cols.length > eq.length ? t('ordinamento/raggruppamento su {0}', cols.slice(eq.length).join(', ')) : '',
    ].filter(Boolean);
    reason = parts.join('; ');
    const name = indexName(ref.table, cols, new Set(info.indexes.map((ix) => ix.name.toLowerCase())));
    suggestions.push({ table: ref.table, columns: cols, name, sql: `ALTER TABLE ${qi(ref.table)} ADD INDEX ${qi(name)} (${cols.map(qi).join(', ')});`, reason });
  }
  if (!issues.some((i) => i.level !== 'ok') && !suggestions.length) issues.push({ level: 'ok', text: t('Nessun problema evidente nel piano di esecuzione.') });
  const order: Record<Issue['level'], number> = { warning: 0, info: 1, ok: 2 };
  issues.sort((a, b) => order[a.level] - order[b.level]);
  return { issues, suggestions, refs: q.refs, preds: q.preds };
}

/** Statement shape without literals, for grouping: WHERE id = ? AND s IN (...). */
export function normalizeSql(sql: string) {
  let out = '';
  let prev: Tok | null = null;
  const tk = significant(sql);
  const emit = (v: string, glue = false) => { out += (out && !glue ? ' ' : '') + v; };
  for (let i = 0; i < tk.length; i++) {
    const x = tk[i];
    if (x.k === 'delim') continue;
    if (x.k === 'str' || x.k === 'num') {
      // a list of literals collapses to (...)
      if (prev?.v === '(') {
        let j = i;
        while (j < tk.length && (tk[j].k === 'str' || tk[j].k === 'num' || tk[j].v === ',' || up(tk[j]) === 'NULL')) j++;
        if (tk[j]?.v === ')' && j > i + 1) { emit('...', true); i = j - 1; prev = tk[j - 1]; continue; }
      }
      emit('?', prev?.v === '(' || prev?.v === '.');
    } else if (x.k === 'word') emit(KEYWORDS.has(x.v.toUpperCase()) ? x.v.toUpperCase() : x.v, prev?.v === '(' || prev?.v === '.');
    else if (x.v === '(') emit('(', !!prev && (prev.k === 'qid' || (prev.k === 'word' && !KEYWORDS.has(prev.v.toUpperCase()))));
    else if (x.v === ')' || x.v === ',' || x.v === '.') emit(x.v, true);
    else emit(x.v, prev?.v === '(' || prev?.v === '.');
    prev = x;
  }
  return out;
}

export interface SlowRow { at: string | null; who: string | null; ms: number; lockMs: number; sent: number; examined: number; db: string | null; text: string }
export interface TopRow {
  key: string; db: string | null; text: string; sample: string | null; count: number; totalMs: number; maxMs: number; lockMs: number;
  examined: number; sent: number; affected: number; tmpDisk: number; tmp: number; mergePasses: number; fullJoin: number; scans: number; noIndex: number; errors: number;
  firstSeen: string | null; lastSeen: string | null;
}

/** Slow log rows grouped by statement shape, heaviest total time first. */
export function groupSlowLog(rows: SlowRow[]): TopRow[] {
  const m = new Map<string, TopRow>();
  for (const r of rows) {
    const shape = normalizeSql(r.text);
    const key = `${r.db ?? ''}\u0000${shape}`;
    let g = m.get(key);
    if (!g) {
      g = { key, db: r.db, text: shape, sample: r.text, count: 0, totalMs: 0, maxMs: 0, lockMs: 0, examined: 0, sent: 0, affected: 0, tmpDisk: 0, tmp: 0, mergePasses: 0, fullJoin: 0, scans: 0, noIndex: 0, errors: 0, firstSeen: r.at, lastSeen: r.at };
      m.set(key, g);
    }
    g.count++;
    g.totalMs += r.ms;
    g.lockMs += r.lockMs;
    g.examined += r.examined;
    g.sent += r.sent;
    if (r.ms > g.maxMs) { g.maxMs = r.ms; g.sample = r.text; }
    if (r.at && (!g.firstSeen || r.at < g.firstSeen)) g.firstSeen = r.at;
    if (r.at && (!g.lastSeen || r.at > g.lastSeen)) g.lastSeen = r.at;
  }
  return [...m.values()].sort((a, b) => b.totalMs - a.totalMs);
}

/** Flags of a heavy statement, as short labels. */
export function topFlags(r: TopRow) {
  const out: string[] = [];
  if (r.noIndex) out.push(t('senza indice'));
  if (r.fullJoin) out.push(t('join senza indice'));
  if (r.tmpDisk) out.push(t('temporanee su disco'));
  if (r.mergePasses) out.push(t('ordinamento su disco'));
  if (r.sent > 0 && r.examined / r.sent > 100 && r.examined > 10000) out.push(t('{0} righe lette per riga restituita', Math.round(r.examined / r.sent).toLocaleString()));
  if (r.errors) out.push(t('errori'));
  return out;
}

/** A sample can be EXPLAINed when it is complete (performance_schema truncates long samples) and a DML statement. */
export const explainable = (sql: string | null) => !!sql && /^\s*(\(\s*)?(select|with|update|delete|insert|replace)\b/i.test(sql) && !/\.\.\.$/.test(sql.trim());
