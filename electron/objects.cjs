// Editing views, routines, triggers and events from their CREATE statement. An existing object is replaced
// with CREATE OR REPLACE where the server has it (MariaDB; views on MySQL too); otherwise (MySQL routines,
// triggers, events) it is dropped and created again, and the previous definition is restored when the new
// one fails. Runs on a connection of its own on the object's database, so unqualified names resolve there.
const server = require('./server.cjs');
const { split } = require('./sqlsplit.cjs');

const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`';
const WORD = { view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT' };
const SHOW_COL = { view: 1, procedure: 2, function: 2, trigger: 2, event: 3 };
const LABEL = { view: 'una vista', procedure: 'una procedura', function: 'una funzione', trigger: 'un trigger', event: 'un evento' };
// routine and event names are case insensitive; views and triggers follow the table name rules
const CASE_INSENSITIVE = new Set(['procedure', 'function', 'event']);

const NAME = '(`(?:[^`]|``)+`|[\\w$]+)';
const ACCOUNT_PART = "(?:'(?:[^'\\\\]|\\\\.)*'|`(?:[^`]|``)+`|\"[^\"]*\"|[\\w$.%-]+)";
const HEAD = new RegExp(
  '^CREATE\\s+(OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*\\w+\\s+)?'
  + `(?:DEFINER\\s*=\\s*(${ACCOUNT_PART}(?:\\s*@\\s*${ACCOUNT_PART})?|CURRENT_USER(?:\\s*\\(\\s*\\))?)\\s+)?`
  + '(?:SQL\\s+SECURITY\\s+\\w+\\s+)?(?:AGGREGATE\\s+)?(VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT)\\s+(IF\\s+NOT\\s+EXISTS\\s+)?'
  + `${NAME}(?:\\s*\\.\\s*${NAME})?`, 'i');

const unq = (s) => (s && s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s);

/** Leading comments and whitespace of a statement (not executable comments). */
function skipComments(sql) {
  let i = 0;
  for (;;) {
    const m = /^(\s+|--[ \t][^\n]*|--\n|#[^\n]*|\/\*(?!!)[\s\S]*?\*\/)/.exec(sql.slice(i));
    if (!m) return i;
    i += m[0].length;
  }
}

/** What a CREATE statement defines: kind, name, schema, definer; null when it is not one of ours. */
function header(sql) {
  const at = skipComments(sql);
  const m = HEAD.exec(sql.slice(at));
  if (!m) return null;
  const [, orReplace, definer, word, ifNotExists, a, b] = m;
  return {
    kind: word.toLowerCase(),
    db: b ? unq(a) : null,
    name: unq(b ?? a),
    definer: definer ?? null,
    orReplace: !!orReplace,
    ifNotExists: !!ifNotExists,
    at,
  };
}

const orReplace = (sql, h) => `${sql.slice(0, h.at)}CREATE OR REPLACE${sql.slice(h.at + 'CREATE'.length)}`;

/** The single CREATE statement of an editor document (DELIMITER lines allowed), checked against the kind. */
function statementOf(text, kind, db) {
  const stmts = split(text);
  if (!stmts.length) throw new Error('Il documento è vuoto.');
  if (stmts.length > 1) throw new Error(`Il documento deve contenere una sola istruzione CREATE (ne contiene ${stmts.length}): sposta le altre in un documento SQL.`);
  const sql = stmts[0].sql;
  const h = header(sql);
  if (!h) throw new Error(`L'istruzione deve essere CREATE ${WORD[kind]} … (con DEFINER, ALGORITHM, SQL SECURITY facoltativi).`);
  if (h.kind !== kind) throw new Error(`L'istruzione definisce ${LABEL[h.kind]}, ma questo documento modifica ${LABEL[kind]}.`);
  if (h.db && h.db !== db) throw new Error(`L'oggetto deve restare nel database ${db}: togli il prefisso «${h.db}.» dal nome.`);
  return { sql, h };
}

const sameName = (kind, a, b) => (CASE_INSENSITIVE.has(kind) ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Applies the document. orig: current name of the object (null = new).
 * @returns {{ name: string, created: boolean, renamed: boolean, method: 'create'|'replace'|'drop-create' }}
 */
async function apply(connId, db, kind, orig, text) {
  const { sql, h } = statementOf(text, kind, db);
  const renamed = orig !== null && !sameName(kind, orig, h.name);
  return server.withDedicated(connId, { database: db }, async (c) => {
    const q = async (s) => { try { return await c.query(s); } catch (err) { throw new server.DbError(err); } };
    if (orig === null || renamed) {
      await q(sql);
      return { name: h.name, created: true, renamed, method: 'create' };
    }
    const [[version]] = await q({ sql: 'SELECT VERSION()', rowsAsArray: true });
    if (/mariadb/i.test(version) || kind === 'view') {
      await q(h.orReplace ? sql : orReplace(sql, h));
      return { name: h.name, created: false, renamed: false, method: 'replace' };
    }
    // MySQL has no CREATE OR REPLACE for these: drop, create, and put the old one back on failure
    const rows = await q({ sql: `SHOW CREATE ${WORD[kind]} ${qi(orig)}`, rowsAsArray: true });
    const prev = rows[0]?.[SHOW_COL[kind]];
    if (!prev) throw new Error('Definizione attuale non leggibile (privilegi insufficienti): modifica non applicata.');
    await q(`DROP ${WORD[kind]} ${qi(orig)}`);
    try {
      await q(sql);
    } catch (err) {
      try { await c.query(prev); } catch (again) {
        throw new Error(`${err.message}\nATTENZIONE: ripristino della definizione precedente non riuscito (${again.sqlMessage || again.message}): l'oggetto è stato eliminato. Definizione precedente:\n${prev}`);
      }
      throw new Error(`${err.message}\nLa definizione precedente è stata ripristinata.`);
    }
    return { name: h.name, created: false, renamed: false, method: 'drop-create' };
  });
}

/** Parameters of a routine, in order, and the function's return type. */
async function routineParams(connId, db, kind, name) {
  const rows = await server.meta(connId, `SELECT PARAMETER_MODE AS mode, PARAMETER_NAME AS name, DTD_IDENTIFIER AS type, ORDINAL_POSITION AS pos
    FROM information_schema.PARAMETERS WHERE SPECIFIC_SCHEMA = ? AND SPECIFIC_NAME = ? AND ROUTINE_TYPE = ? ORDER BY ORDINAL_POSITION`, [db, name, kind.toUpperCase()]);
  return {
    params: rows.filter((r) => Number(r.pos) > 0).map((r) => ({ mode: r.mode ?? 'IN', name: r.name, type: r.type })),
    returns: rows.find((r) => Number(r.pos) === 0)?.type ?? null,
  };
}

/** Account of the connection as the server sees it (user@host), to compare with a DEFINER. */
async function currentUser(connId) {
  const [r] = await server.meta(connId, 'SELECT CURRENT_USER() AS u');
  return r.u;
}

module.exports = { apply, header, statementOf, orReplace, routineParams, currentUser };
