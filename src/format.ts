// SQL formatter. Works on tokens, so strings, quoted identifiers and comments are never altered and every
// statement keeps the same tokens (tests check this). DML (SELECT/INSERT/UPDATE/DELETE, subqueries, CREATE
// VIEW … AS SELECT), CREATE TABLE definitions and ALTER TABLE specifications are re-indented; routine,
// trigger and event bodies keep their layout and only get the keyword case.
// Case is changed only on words that cannot be table names: on Linux table names and aliases are case
// sensitive, so words after FROM/JOIN/INTO/…, qualifiers and aliases keep their spelling.

export type KeywordCase = 'upper' | 'lower' | 'keep';
export interface FormatOptions { keywordCase: KeywordCase; indent: number; listPerLine: boolean }
export const DEFAULT_FORMAT: FormatOptions = { keywordCase: 'upper', indent: 2, listPerLine: true };

const words = (s: string) => new Set(s.trim().split(/\s+/));

/** MySQL 8 / MariaDB reserved words (cannot be bare identifiers) plus statement words rarely used as names. */
export const KEYWORDS = words(`
  ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN BIGINT BINARY BLOB BOTH BY CALL CASCADE CASE
  CHANGE CHAR CHARACTER CHECK COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS CUBE CURRENT_DATE
  CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR DATABASE DATABASES DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND
  DEC DECIMAL DECLARE DEFAULT DELAYED DELETE DESC DESCRIBE DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DROP DUAL EACH
  ELSE ELSEIF ENCLOSED ESCAPED EXCEPT EXISTS EXIT EXPLAIN FALSE FETCH FLOAT FOR FORCE FOREIGN FROM FULLTEXT FUNCTION
  GENERATED GET GRANT GROUP HAVING HIGH_PRIORITY HOUR_MICROSECOND HOUR_MINUTE HOUR_SECOND IF IGNORE IN INDEX INFILE INNER
  INOUT INSENSITIVE INSERT INT INTEGER INTERSECT INTERVAL INTO IS ITERATE JOIN KEY KEYS KILL LATERAL LEADING LEAVE LEFT
  LIKE LIMIT LINEAR LINES LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP LOW_PRIORITY MATCH MAXVALUE
  MEDIUMBLOB MEDIUMINT MEDIUMTEXT MINUTE_MICROSECOND MINUTE_SECOND MOD MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NULL
  NUMERIC OF OFFSET ON OPTIMIZE OPTION OPTIONALLY OR ORDER OUT OUTER OUTFILE OVER PARTITION PRECISION PRIMARY PROCEDURE
  PURGE RANGE READ READS READ_WRITE REAL RECURSIVE REFERENCES REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL
  RESTRICT RETURN RETURNING REVOKE RIGHT RLIKE ROW ROWS SCHEMA SCHEMAS SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET
  SHOW SIGNAL SMALLINT SPATIAL SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT SQL_CALC_FOUND_ROWS
  SQL_SMALL_RESULT SSL STARTING STORED STRAIGHT_JOIN TABLE TERMINATED THEN TINYBLOB TINYINT TINYTEXT TO TRAILING TRIGGER
  TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES VARBINARY VARCHAR
  VARYING VIRTUAL WHEN WHERE WHILE WINDOW WITH WRITE XOR YEAR_MONTH ZEROFILL
  ENGINE AUTO_INCREMENT CHARSET TEMPORARY VIEW EVENT ALGORITHM DEFINER INVOKER SECURITY RETURNS BEGIN END COMMIT
  ROLLBACK START TRANSACTION SAVEPOINT TRUNCATE DO HANDLER FOLLOWS PRECEDES SCHEDULE EVERY STARTS ENDS COMPLETION
  PRESERVE ENABLE DISABLE DUPLICATE ROW_FORMAT AFTER MODIFY ATOMIC SIGNED TABLES PROCESSLIST VARIABLES GLOBAL SESSION
  WORK IDENTIFIED PRIVILEGES EXTENDED SQL_NO_CACHE SQL_CACHE SQL_BUFFER_RESULT ANY SOME UNKNOWN SOUNDS
`);

/** Data types: cased only where a type is expected (column definitions, CAST … AS, RETURNS, DECLARE). */
export const TYPES = words(`
  INT INTEGER TINYINT SMALLINT MEDIUMINT BIGINT DECIMAL NUMERIC FLOAT DOUBLE REAL BIT BOOL BOOLEAN DATE DATETIME TIMESTAMP
  TIME YEAR CHAR VARCHAR BINARY VARBINARY TINYTEXT TEXT MEDIUMTEXT LONGTEXT TINYBLOB BLOB MEDIUMBLOB LONGBLOB ENUM SET JSON
  GEOMETRY POINT LINESTRING POLYGON MULTIPOINT MULTILINESTRING MULTIPOLYGON GEOMETRYCOLLECTION UUID INET4 INET6 SIGNED
  UNSIGNED SERIAL
`);

// the next word is a name (table, database, alias, object): never re-cased
const NAME_AFTER = words('FROM JOIN INTO UPDATE TABLE REFERENCES AS USE DATABASE SCHEMA VIEW PROCEDURE FUNCTION TRIGGER EVENT DESCRIBE EXISTS TO ON TABLES STRAIGHT_JOIN CALL');
// …unless it is one of these
const NOT_A_NAME = words('SELECT WITH VALUES VALUE IF NOT EXISTS IGNORE LOW_PRIORITY HIGH_PRIORITY QUICK DELAYED OUTFILE DUMPFILE DUPLICATE DELETE UPDATE SCHEDULE COMPLETION LATERAL RECURSIVE TEMPORARY OR');
// a FROM/JOIN list: words that are not reserved are tables or aliases
const TABLE_LIST_START = words('FROM JOIN UPDATE');
const TABLE_LIST_END = words('WHERE ON USING SET GROUP ORDER LIMIT HAVING VALUES VALUE SELECT UNION WINDOW FOR LOCK RETURNING INTO INTERSECT EXCEPT');
const RESERVED_IN_LIST = words('JOIN INNER LEFT RIGHT OUTER CROSS NATURAL STRAIGHT_JOIN AS FORCE USE IGNORE INDEX KEY FOR LATERAL PARTITION LOW_PRIORITY QUICK');
// table options and similar: keywords when followed by = or a value (COMMENT 'x', ENGINE=InnoDB)
const OPTION_WORDS = words('COMMENT ENGINE CHARSET AUTO_INCREMENT ROW_FORMAT KEY_BLOCK_SIZE STATS_PERSISTENT STATS_AUTO_RECALC COMPRESSION ENCRYPTION PAGE_COMPRESSED TRANSACTIONAL CHECKSUM DELAY_KEY_WRITE INSERT_METHOD MAX_ROWS MIN_ROWS PACK_KEYS AVG_ROW_LENGTH CONNECTION TABLESPACE');
const CAST_TYPES = words('CHAR SIGNED UNSIGNED DATE DATETIME TIME DECIMAL BINARY INTEGER INT DOUBLE FLOAT JSON NCHAR');
const SPACE_BEFORE_PAREN = words('IN AS AND OR NOT EXISTS ON USING WHEN THEN ELSE FROM JOIN WHERE SELECT ALL ANY SOME XOR');

type Kind = 'ws' | 'line' | 'block' | 'str' | 'qid' | 'num' | 'word' | 'var' | 'op' | 'delim' | 'cmd';
export interface Tok { k: Kind; v: string; nl: number }

const OPS = ['<=>', '->>', '<=', '>=', '<>', '!=', ':=', '||', '&&', '<<', '>>', '->'];
const WORD = /[A-Za-z_$\u0080-￿][\w$\u0080-￿]*/y;
const NUM = /(?:0x[0-9a-f]+|0b[01]+|\d+\.?\d*(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?)/iy;

/** Tokens of a script, with DELIMITER lines (`cmd`) and statement delimiters (`delim`) like the mariadb client. */
export function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  const n = text.length;
  let delim = ';';
  let blank = true; // only whitespace/comments since the last delimiter: DELIMITER is recognised only there
  let i = 0;
  const push = (k: Kind, from: number, nl = 0) => out.push({ k, v: text.slice(from, i), nl });
  const sticky = (re: RegExp) => { re.lastIndex = i; return re.exec(text)?.[0] ?? null; };
  while (i < n) {
    const a = i;
    const ch = text[i];
    if (/\s/.test(ch)) {
      let nl = 0;
      while (i < n && /\s/.test(text[i])) { if (text[i] === '\n') nl++; i++; }
      push('ws', a, nl);
      continue;
    }
    if (ch === '#' || (ch === '-' && text[i + 1] === '-' && (i + 2 >= n || /\s/.test(text[i + 2])))) {
      while (i < n && text[i] !== '\n') i++;
      push('line', a);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (text[i + 2] === '!') blank = false;
      i = close < 0 ? n : close + 2;
      push('block', a);
      continue;
    }
    if (blank && (ch === 'd' || ch === 'D')) {
      const eol = text.indexOf('\n', i);
      const m = /^delimiter[ \t]+(\S+)[^\n]*/i.exec(text.slice(i, eol < 0 ? n : eol));
      if (m) { i += m[0].length; push('cmd', a); delim = m[1]; continue; }
    }
    if (text.startsWith(delim, i)) { i += delim.length; push('delim', a); blank = true; continue; }
    blank = false;
    if (ch === "'" || ch === '"' || ch === '`') {
      i++;
      while (i < n) {
        if (text[i] === '\\' && ch !== '`') { i += 2; continue; }
        if (text[i] === ch) { if (text[i + 1] === ch) { i += 2; continue; } break; }
        i++;
      }
      i = Math.min(i + 1, n);
      push(ch === '`' ? 'qid' : 'str', a);
      continue;
    }
    if (ch === '@') {
      i++;
      if (text[i] === '@') i++;
      const q = text[i];
      if (q === "'" || q === '"' || q === '`') {
        i++;
        while (i < n && text[i] !== q) i++;
        i = Math.min(i + 1, n);
      } else while (i < n && /[\w$.\u0080-￿]/.test(text[i])) i++;
      push('var', a);
      continue;
    }
    const num = /[\d.]/.test(ch) ? sticky(NUM) : null;
    if (num && num !== '.') {
      i += num.length;
      if (i < n && /[A-Za-z_$]/.test(text[i]) && !/^0x|^0b/i.test(num)) { while (i < n && /[\w$]/.test(text[i])) i++; push('word', a); } // 1abc is a name
      else push('num', a);
      continue;
    }
    let w = sticky(WORD);
    if (w) {
      const cut = w.indexOf(delim, 1); // END$$: the client ends the statement even inside a word
      if (cut > 0) w = w.slice(0, cut);
      i += w.length;
      push('word', a);
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    i += op ? op.length : 1;
    push('op', a);
  }
  return out;
}

interface Sig { t: Tok; v: string; kw: boolean; gap: boolean; nlBefore: number; unary?: boolean }

const applyCase = (v: string, c: KeywordCase) => (c === 'upper' ? v.toUpperCase() : c === 'lower' ? v.toLowerCase() : v);

/**
 * Case of each word of a statement. `kw` marks words used as keywords (also when the case is kept), which
 * the layout uses to recognise clauses.
 */
function caseWords(sig: Sig[], kwCase: KeywordCase, functions: Set<string>, stmtWord: string) {
  const ddl = /^(CREATE|ALTER|DECLARE)$/.test(stmtWord);
  let list = false;
  const stack: boolean[] = [];
  let depth = 0;
  for (let i = 0; i < sig.length; i++) {
    const s = sig[i];
    if (s.t.k === 'op') {
      if (s.t.v === ';') list = false;
      else if (s.t.v === '(') { stack.push(list); list = false; depth++; }
      else if (s.t.v === ')') { list = stack.pop() ?? false; depth = Math.max(0, depth - 1); }
      continue;
    }
    if (s.t.k !== 'word') continue;
    const W = s.t.v.toUpperCase();
    const prev = sig[i - 1];
    const next = sig[i + 1];
    const tightParen = next?.t.v === '(' && !next.gap;
    const prevName = prev && (prev.t.k === 'qid' || (prev.t.k === 'word' && !prev.kw));
    let kw = false;
    if (prev?.t.v === '.' || next?.t.v === '.') kw = false; // qualifier or qualified name
    else if (prev?.kw && NAME_AFTER.has(prev.t.v.toUpperCase()) && !NOT_A_NAME.has(W)
      && !(prev.t.v.toUpperCase() === 'AS' && depth > 0 && CAST_TYPES.has(W))) kw = false;
    else if (list && !RESERVED_IN_LIST.has(W) && !TABLE_LIST_END.has(W)) kw = false;
    else if (TYPES.has(W) && (tightParen || (prevName && ddl) || prev?.t.v.toUpperCase() === 'RETURNS' || (prev?.t.v.toUpperCase() === 'AS' && depth > 0))) kw = true;
    else if (KEYWORDS.has(W)) kw = !(TYPES.has(W) && !KEYWORDS.has(W));
    else if (functions.has(W) && tightParen) kw = true;
    else if (OPTION_WORDS.has(W) && (next?.t.v === '=' || next?.t.k === 'str')) kw = true;
    s.kw = kw;
    s.v = kw ? applyCase(s.t.v, kwCase) : s.t.v;
    if (kw && TABLE_LIST_START.has(W)) list = true;
    else if (kw && TABLE_LIST_END.has(W)) list = false;
  }
}

class Out {
  lines: string[] = [];
  cur = '';
  indent = 0;
  fresh = true;
  unit: string;
  constructor(unit: string) { this.unit = unit; }
  nl(level: number) {
    if (this.cur.trim()) this.lines.push(this.cur.trimEnd());
    this.cur = this.unit.repeat(Math.max(0, level));
    this.indent = Math.max(0, level);
    this.fresh = true;
  }
  blank() {
    if (this.cur.trim()) this.lines.push(this.cur.trimEnd());
    this.lines.push('');
    this.cur = this.unit.repeat(this.indent);
    this.fresh = true;
  }
  put(s: string, space: boolean) {
    if (!this.fresh && space) this.cur += ' ';
    this.cur += s;
    this.fresh = false;
  }
  text() { if (this.cur.trim()) this.lines.push(this.cur.trimEnd()); return this.lines.join('\n'); }
}

interface Frame { kind: 'stmt' | 'sub' | 'paren' | 'defs'; base: number; closeAt: number; dml: boolean; clause: string; list: boolean; between: number; cases: number; seenClause: boolean }

const DML_START = words('SELECT WITH INSERT REPLACE UPDATE DELETE');
const SELECT_MODS = words('DISTINCT ALL DISTINCTROW HIGH_PRIORITY STRAIGHT_JOIN SQL_CALC_FOUND_ROWS SQL_NO_CACHE SQL_CACHE SQL_SMALL_RESULT SQL_BIG_RESULT SQL_BUFFER_RESULT');
const JOIN_WORDS = words('LEFT RIGHT INNER CROSS NATURAL FULL OUTER STRAIGHT_JOIN JOIN');
const LOOKAHEAD_STOP = words('FROM WHERE GROUP ORDER HAVING LIMIT UNION INTERSECT EXCEPT WINDOW RETURNING ON INTO FOR LOCK');
const EXPLAIN_WORDS = words('EXPLAIN ANALYZE DESCRIBE DESC');

function needSpace(p: Sig | null, s: Sig) {
  if (!p) return false;
  const v = s.t.v;
  if (s.t.k === 'delim' || v === ',' || v === ';' || v === ')' || v === '.') return false;
  if (p.t.v === '(' || p.t.v === '.' || p.unary) return false;
  if (v === '(' && (p.t.k === 'word' || p.t.k === 'qid' || p.t.k === 'var') && !s.gap) return p.kw && SPACE_BEFORE_PAREN.has(p.t.v.toUpperCase());
  if (s.t.k === 'str' && p.t.k === 'word' && !s.gap) return false; // x'0A', _utf8mb4'…', N'…'
  if (s.t.k === 'var' && (p.t.k === 'qid' || p.t.k === 'str' || p.t.k === 'word') && !s.gap) return false; // 'user'@'host'
  return true;
}

const isUnary = (p: Sig | null, s: Sig) => ['-', '+', '~', '!'].includes(s.t.v) && s.t.k === 'op'
  && (!p || (p.t.k === 'op' && p.t.v !== ')') || (p.t.k === 'word' && p.kw));

/** Re-indents one statement (sig: tokens without whitespace, comments included). */
function layout(sig: Sig[], opts: FormatOptions, stmtWord: string) {
  const out = new Out(' '.repeat(opts.indent));
  const W = (i: number) => (sig[i]?.t.k === 'word' && sig[i].kw ? sig[i].t.v.toUpperCase() : '');
  const createTable = stmtWord === 'CREATE' && sig.slice(0, 6).some((_, i) => W(i) === 'TABLE');
  const alterTable = stmtWord === 'ALTER' && W(nextSig(sig, 0)) === 'TABLE';
  const stack: Frame[] = [{ kind: 'stmt', base: 0, closeAt: 0, dml: DML_START.has(stmtWord), clause: '', list: false, between: 0, cases: 0, seenClause: false }];
  let defsDone = false;
  let pendingNl: number | null = null;
  let hold = 0; // tokens that stay on the current line despite a pending break (GROUP BY, SELECT DISTINCT…)
  let alterName = 0; // ALTER TABLE: 1 waiting for the table name, 2 done
  let prev: Sig | null = null;

  const emit = (s: Sig, space = needSpace(prev, s)) => {
    if (hold) hold--;
    else if (pendingNl !== null) { out.nl(pendingNl); pendingNl = null; }
    s.unary = isUnary(prev, s);
    out.put(s.v, space);
    prev = s;
  };
  const commasAhead = (from: number) => {
    let depth = 0;
    let n = 0;
    for (let j = from + 1; j < sig.length; j++) {
      const v = sig[j].t.v;
      if (sig[j].t.k === 'delim') break;
      if (v === '(') depth++;
      else if (v === ')') { if (!depth) break; depth--; }
      else if (!depth && v === ',') n++;
      else if (!depth && LOOKAHEAD_STOP.has(W(j))) break;
    }
    return n;
  };

  for (let i = 0; i < sig.length; i++) {
    const s = sig[i];
    const f = stack[stack.length - 1];
    // blank lines after a comment (a comment block above a statement) are kept
    const last = prev as Sig | null; // assigned inside emit(): not narrowed
    if (s.nlBefore >= 2 && (last?.t.k === 'line' || last?.t.k === 'block')) out.blank();
    if (s.t.k === 'line') { emit(s, !out.fresh); pendingNl = out.indent; continue; }
    if (s.t.k === 'block') { if (s.nlBefore && !out.fresh) out.nl(out.indent); emit(s, !out.fresh); if (s.t.v.includes('\n')) pendingNl = out.indent; continue; }
    if (s.t.k === 'delim') { emit(s, false); continue; }
    const v = s.t.v;
    if (s.t.k === 'op' && v === '(') {
      const nx = W(nextSig(sig, i));
      emit(s);
      if (nx === 'SELECT' || nx === 'WITH') {
        stack.push({ kind: 'sub', base: out.indent + 1, closeAt: out.indent, dml: true, clause: '', list: false, between: 0, cases: 0, seenClause: false });
        pendingNl = out.indent + 1;
      } else if (createTable && !defsDone && f.kind === 'stmt') {
        defsDone = true;
        stack.push({ kind: 'defs', base: 1, closeAt: 0, dml: false, clause: '', list: false, between: 0, cases: 0, seenClause: false });
        pendingNl = 1;
      } else stack.push({ kind: 'paren', base: f.base, closeAt: f.base, dml: false, clause: '', list: false, between: 0, cases: 0, seenClause: false });
      continue;
    }
    if (s.t.k === 'op' && v === ')') {
      const top = stack.length > 1 ? stack.pop()! : f;
      if (top.kind === 'sub' || top.kind === 'defs') { pendingNl = null; out.nl(top.closeAt); }
      emit(s, false);
      continue;
    }
    if (s.t.k === 'op' && v === ',') {
      emit(s, false);
      if (f.kind === 'defs') pendingNl = f.base;
      else if ((f.kind === 'stmt' || f.kind === 'sub') && f.list && !f.cases) pendingNl = f.base + 1;
      else if (alterTable && f.kind === 'stmt') pendingNl = 1;
      continue;
    }
    const w = W(i);
    if (alterTable && alterName === 0 && w === 'TABLE') { alterName = 1; emit(s); continue; }
    if (alterName === 1 && (s.t.k === 'word' || s.t.k === 'qid') && !/^(TABLE|IF|EXISTS|ONLINE|IGNORE)$/.test(w)) {
      emit(s);
      if (sig[i + 1]?.t.v !== '.') { alterName = 2; pendingNl = 1; }
      continue;
    }
    if (!w || (f.kind !== 'stmt' && f.kind !== 'sub')) { emit(s); continue; }

    if (w === 'CASE') { f.cases++; emit(s); continue; }
    if (w === 'END' && f.cases) { f.cases--; emit(s); continue; }
    if (f.cases) { emit(s); continue; }
    // SELECT/WITH after CREATE VIEW … AS, INSERT … SELECT: DML from here on
    if (!f.dml && (w === 'SELECT' || w === 'WITH') && !(EXPLAIN_WORDS.has(stmtWord) && !f.seenClause)) f.dml = true;
    if (!f.dml) { emit(s); continue; }

    if (w === 'BETWEEN') { f.between++; emit(s); continue; }
    if (w === 'AND' || w === 'OR' || w === 'XOR') {
      if (w === 'AND' && f.between) { f.between--; emit(s); continue; }
      if (/^(WHERE|HAVING|ON)$/.test(f.clause)) { pendingNl = null; out.nl(f.base + 1); }
      emit(s);
      continue;
    }
    if (w === 'ON') {
      if (W(nextSig(sig, i)) === 'DUPLICATE') { clause(i, 'ON DUPLICATE KEY UPDATE', true); continue; }
      f.clause = 'ON';
      emit(s);
      continue;
    }
    const nx = W(nextSig(sig, i));
    const joinStart = JOIN_WORDS.has(w) && !JOIN_WORDS.has(W(prevSig(sig, i))) && (w === 'JOIN' || w === 'STRAIGHT_JOIN' || joinAhead(sig, i));
    if (joinStart) { f.list = false; f.clause = 'JOIN'; pendingNl = null; out.nl(f.base); emit(s); continue; }
    if ((w === 'GROUP' || w === 'ORDER') && nx === 'BY') { clause(i, w, false); continue; }
    if (w === 'SELECT' || w === 'SET' || (w === 'VALUES' && !(sig[i + 1]?.t.v === '(' && !sig[i + 1].gap && f.clause === 'ON DUPLICATE KEY UPDATE'))) {
      clause(i, w, true);
      continue;
    }
    if (w === 'FROM' && /^(DELETE|LOW_PRIORITY|QUICK|IGNORE)$/.test(W(prevSig(sig, i)))) { f.clause = 'FROM'; f.seenClause = true; emit(s); continue; }
    if (/^(FROM|WHERE|HAVING|LIMIT|WINDOW|RETURNING)$/.test(w)) { clause(i, w, false); continue; }
    if (/^(UNION|INTERSECT|EXCEPT)$/.test(w)) { f.list = false; f.clause = w; pendingNl = null; out.nl(f.base); emit(s); continue; }
    if (pendingNl !== null && f.clause === 'SELECT' && SELECT_MODS.has(w) && prev && (W(prevSig(sig, i)) === 'SELECT' || SELECT_MODS.has(W(prevSig(sig, i))))) hold = 1;
    emit(s);
  }
  return out.text();

  function clause(i: number, name: string, isList: boolean) {
    const f = stack[stack.length - 1];
    // EXPLAIN SELECT …: the SELECT stays on the EXPLAIN line
    const inline = name === 'SELECT' && f.kind === 'stmt' && !f.seenClause && EXPLAIN_WORDS.has(stmtWord);
    f.clause = name;
    f.seenClause = true;
    f.between = 0;
    f.list = isList && opts.listPerLine && commasAhead(i) > 0;
    pendingNl = null;
    if (!inline) out.nl(f.base);
    emit(sig[i], inline);
    // the other words of the clause stay on its line
    hold = name === 'ON DUPLICATE KEY UPDATE' ? 3 : name === 'GROUP' || name === 'ORDER' ? 1 : 0;
    if (f.list || hold) pendingNl = f.list ? f.base + 1 : null;
    if (!f.list) hold = 0;
  }
}

function nextSig(sig: Sig[], i: number) {
  for (let j = i + 1; j < sig.length; j++) if (sig[j].t.k !== 'line' && sig[j].t.k !== 'block') return j;
  return -1;
}
function prevSig(sig: Sig[], i: number) {
  for (let j = i - 1; j >= 0; j--) if (sig[j].t.k !== 'line' && sig[j].t.k !== 'block') return j;
  return -1;
}
function joinAhead(sig: Sig[], i: number) {
  for (let j = i; j >= 0 && j < sig.length && j < i + 4; j = nextSig(sig, j)) {
    const w = sig[j].t.k === 'word' ? sig[j].t.v.toUpperCase() : '';
    if (w === 'JOIN') return true;
    if (!JOIN_WORDS.has(w)) return false;
  }
  return false;
}

/** Routine, trigger and event definitions and compound blocks keep their own layout. */
function isCompound(sig: Sig[]) {
  const w = sig.filter((s) => s.t.k === 'word').slice(0, 10).map((s) => s.t.v.toUpperCase());
  if (w[0] === 'CREATE' && w.some((x) => /^(PROCEDURE|FUNCTION|TRIGGER|EVENT)$/.test(x))) return true;
  if (w[0] === 'ALTER' && w[1] === 'EVENT') return true;
  return sig.some((s, i) => s.t.k === 'word' && /^BEGIN$/i.test(s.t.v) && !/^(WORK|;)$/i.test(sig[i + 1]?.t.v ?? ';') && sig[i + 1]?.t.k !== 'delim');
}

/**
 * Formats a script. `functions`: built-in function names (upper case) cased like keywords when called.
 */
export function formatSql(text: string, opts: FormatOptions = DEFAULT_FORMAT, functions: Set<string> = new Set()) {
  const toks = tokenize(text);
  const pieces: string[] = [];
  let sepNl = 0; // newlines seen since the last piece
  let buf: Tok[] = [];
  const flush = (delim: Tok | null) => {
    const all = delim ? [...buf, delim] : buf;
    buf = [];
    if (!all.some((t) => t.k !== 'ws')) return;
    const lead = all.findIndex((t) => t.k !== 'ws');
    const leadNl = all.slice(0, lead).reduce((n, t) => n + t.nl, 0) + sepNl;
    sepNl = 0;
    const sig: Sig[] = [];
    let gap = false;
    let nlBefore = 0;
    for (const t of all.slice(lead)) {
      if (t.k === 'ws') { gap = true; nlBefore += t.nl; continue; }
      sig.push({ t, v: t.v, kw: false, gap, nlBefore });
      gap = false;
      nlBefore = 0;
    }
    const stmtWord = sig.find((s) => s.t.k === 'word')?.t.v.toUpperCase() ?? '';
    caseWords(sig, opts.keywordCase, functions, stmtWord);
    let body: string;
    if (isCompound(sig)) {
      // original spacing, re-cased words
      const rest = all.slice(lead);
      let k = 0;
      body = rest.map((t) => (t.k === 'ws' ? t.v : sig[k++].v)).join('').trimEnd();
    } else body = layout(sig, opts, stmtWord);
    pieces.push((pieces.length ? (leadNl === 0 && /^(--|#|\/\*)/.test(sig[0].t.v) ? ' ' : leadNl >= 2 ? '\n\n' : '\n') : '') + body);
  };
  for (const t of toks) {
    if (t.k === 'cmd') {
      flush(null);
      pieces.push((pieces.length ? (sepNl >= 2 ? '\n\n' : '\n') : '') + t.v.trim());
      sepNl = 0;
      continue;
    }
    if (t.k === 'delim') { flush(t); continue; }
    buf.push(t);
  }
  flush(null);
  return pieces.join('') + (/\n\s*$/.test(text) ? '\n' : '');
}

/** The non-whitespace tokens of a script, words upper-cased: formatting must not change them. */
export const signature = (text: string) => tokenize(text).filter((t) => t.k !== 'ws').map((t) => (t.k === 'word' ? t.v.toUpperCase() : t.v));
