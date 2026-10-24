// Query history and SQL snippets, kept in <userData>: history.jsonl (one entry per executed statement,
// append-only, compacted past MAX entries) and snippets.json (absent = the built-in set).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const MAX = 5000;
const MAX_SQL = 64 * 1024;

const file = (name) => path.join(app.getPath('userData'), name);
let entries = null; // oldest first

function load() {
  if (entries) return entries;
  entries = [];
  let text = '';
  try { text = fs.readFileSync(file('history.jsonl'), 'utf8'); } catch { return entries; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* partial line from a crash: skipped */ }
  }
  return entries;
}

function rewrite() {
  fs.mkdirSync(path.dirname(file('history.jsonl')), { recursive: true });
  fs.writeFileSync(file('history.jsonl'), entries.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
}

/** Adds executed statements: { at, connId, conn, db, sql, ms, rows, affected, error }. */
function addHistory(list) {
  load();
  const added = list.map((e) => ({
    id: crypto.randomUUID(),
    at: e.at ?? new Date().toISOString(),
    connId: e.connId ?? null,
    conn: e.conn ?? '',
    db: e.db ?? null,
    sql: String(e.sql).length > MAX_SQL ? String(e.sql).slice(0, MAX_SQL) : String(e.sql),
    truncated: String(e.sql).length > MAX_SQL || undefined,
    ms: e.ms ?? null,
    rows: e.rows ?? null,
    affected: e.affected ?? null,
    error: e.error ?? null,
  }));
  entries.push(...added);
  if (entries.length > MAX * 1.2) {
    entries = entries.slice(-MAX);
    rewrite();
  } else {
    fs.mkdirSync(path.dirname(file('history.jsonl')), { recursive: true });
    fs.appendFileSync(file('history.jsonl'), added.map((e) => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
  }
  return added.length;
}

/** Newest first; q matches the SQL (all words, any case), the connection or database name. */
function listHistory({ q = '', connId = null, status = 'all', limit = 500 } = {}) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  let total = 0;
  for (let i = load().length - 1; i >= 0; i--) {
    const e = entries[i];
    if (connId && e.connId !== connId) continue;
    if (status === 'ok' && e.error) continue;
    if (status === 'error' && !e.error) continue;
    if (terms.length) {
      const hay = `${e.sql}\n${e.conn}\n${e.db ?? ''}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
    }
    total++;
    if (out.length < limit) out.push(e);
  }
  return { entries: out, total, all: entries.length };
}

function removeHistory(ids) {
  const drop = new Set(ids);
  entries = load().filter((e) => !drop.has(e.id));
  rewrite();
}

function clearHistory() {
  entries = [];
  rewrite();
}

// ---- Snippets (Monaco snippet syntax: ${1:placeholder}, ${1|a,b|}, $0) ----

const DEFAULT_SNIPPETS = [
  ['sel', 'SELECT con filtro', 'SELECT ${1:*}\nFROM ${2:tabella}\nWHERE ${3:condizione};$0'],
  ['top', 'Prime righe di una tabella', 'SELECT *\nFROM ${1:tabella}\nLIMIT ${2:1000};$0'],
  ['ins', 'INSERT', 'INSERT INTO ${1:tabella} (${2:colonne})\nVALUES (${3:valori});$0'],
  ['upd', 'UPDATE con filtro', 'UPDATE ${1:tabella}\nSET ${2:colonna} = ${3:valore}\nWHERE ${4:condizione};$0'],
  ['del', 'DELETE con filtro', 'DELETE FROM ${1:tabella}\nWHERE ${2:condizione};$0'],
  ['join', 'INNER JOIN', 'JOIN ${1:tabella} ${2:t} ON ${2:t}.${3:id} = ${4:alias}.${5:colonna}$0'],
  ['lj', 'LEFT JOIN', 'LEFT JOIN ${1:tabella} ${2:t} ON ${2:t}.${3:id} = ${4:alias}.${5:colonna}$0'],
  ['gb', 'Conteggio per gruppo', 'SELECT ${1:colonna}, COUNT(*) AS n\nFROM ${2:tabella}\nGROUP BY ${1:colonna}\nORDER BY n DESC;$0'],
  ['dup', 'Valori duplicati', 'SELECT ${1:colonna}, COUNT(*) AS n\nFROM ${2:tabella}\nGROUP BY ${1:colonna}\nHAVING COUNT(*) > 1;$0'],
  ['cte', 'Common table expression', 'WITH ${1:cte} AS (\n  ${2:SELECT 1}\n)\nSELECT *\nFROM ${1:cte};$0'],
  ['case', 'Espressione CASE', 'CASE\n  WHEN ${1:condizione} THEN ${2:valore}\n  ELSE ${3:altro}\nEND$0'],
  ['tx', 'Transazione', 'START TRANSACTION;\n$0\nCOMMIT;'],
  ['ct', 'Nuova tabella', 'CREATE TABLE ${1:nome} (\n  id INT UNSIGNED NOT NULL AUTO_INCREMENT,\n  ${2:colonna} VARCHAR(${3:100}) NOT NULL,\n  creato_il TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;$0'],
  ['idx', 'Nuovo indice', 'CREATE INDEX ${1:ix_nome} ON ${2:tabella} (${3:colonna});$0'],
  ['fk', 'Chiave esterna', 'ALTER TABLE ${1:tabella}\n  ADD CONSTRAINT ${2:fk_nome} FOREIGN KEY (${3:colonna})\n  REFERENCES ${4:tabella_riferita} (${5:id})\n  ON DELETE ${6|RESTRICT,CASCADE,SET NULL|};$0'],
  ['proc', 'Stored procedure', 'DELIMITER \\$\\$\nCREATE PROCEDURE ${1:nome}(IN ${2:p} INT)\nBEGIN\n  $0\nEND\\$\\$\nDELIMITER ;'],
  ['func', 'Funzione', 'DELIMITER \\$\\$\nCREATE FUNCTION ${1:nome}(${2:p} INT) RETURNS ${3:INT}\nDETERMINISTIC\nBEGIN\n  RETURN ${2:p};$0\nEND\\$\\$\nDELIMITER ;'],
  ['trig', 'Trigger', 'DELIMITER \\$\\$\nCREATE TRIGGER ${1:nome} ${2|BEFORE,AFTER|} ${3|INSERT,UPDATE,DELETE|} ON ${4:tabella}\nFOR EACH ROW\nBEGIN\n  $0\nEND\\$\\$\nDELIMITER ;'],
  ['size', 'Dimensione delle tabelle', "SELECT TABLE_NAME, ENGINE, TABLE_ROWS,\n  ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2) AS mb\nFROM information_schema.TABLES\nWHERE TABLE_SCHEMA = ${1:DATABASE()}\nORDER BY mb DESC;$0"],
  ['running', 'Query in esecuzione', "SELECT ID, USER, DB, TIME, STATE, INFO\nFROM information_schema.PROCESSLIST\nWHERE COMMAND <> 'Sleep'\nORDER BY TIME DESC;$0"],
].map(([prefix, name, body]) => ({ id: `builtin-${prefix}`, prefix, name, body }));

function snippets() {
  try {
    const list = JSON.parse(fs.readFileSync(file('snippets.json'), 'utf8'));
    if (Array.isArray(list)) return { list, custom: true };
  } catch { /* not saved yet */ }
  return { list: DEFAULT_SNIPPETS, custom: false };
}

/** list = null restores the built-in set. */
function saveSnippets(list) {
  if (list === null) { fs.rmSync(file('snippets.json'), { force: true }); return snippets(); }
  const clean = list.map((s) => ({ id: s.id || crypto.randomUUID(), prefix: String(s.prefix).trim(), name: String(s.name ?? '').trim(), body: String(s.body) }))
    .filter((s) => s.prefix && s.body);
  fs.mkdirSync(path.dirname(file('snippets.json')), { recursive: true });
  fs.writeFileSync(file('snippets.json'), JSON.stringify(clean, null, 2));
  return snippets();
}

module.exports = { addHistory, listHistory, removeHistory, clearHistory, snippets, saveSnippets, DEFAULT_SNIPPETS, MAX };
