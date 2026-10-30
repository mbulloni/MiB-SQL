// Document actions shared by toolbar, shortcuts and explorer: they need both the store and the editor models.
import { api, type SqlFile } from './api';
import { clearMarkers, disposeModel, formatText, markErrors, markSaved, modelOf, monaco } from './editor';
import { editCount } from './edits';
import { emptyQuery, toSql } from './qb';
import { designByDoc, editsBySet, isTds, metaKey, SERVER_KINDS, setUntitled, useStore } from './store';
import { maskPasswords } from './users';
import { setLang, t, locale } from './i18n';
import type { Doc, EditableKind, ExecMode, Message, ObjectKind, StmtResult } from './types';

const st = () => useStore.getState();
const docById = (id: string) => st().docs.find((d) => d.id === id);
export const activeDoc = () => docById(st().activeDoc ?? '');

let editorOf: (docId: string) => monaco.editor.IStandaloneCodeEditor | null = () => null;
export const bindEditor = (fn: typeof editorOf) => { editorOf = fn; };

export const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';
const qb = (s: string) => `[${s.replace(/]/g, ']]')}]`;

/** Identifier quoted for the connection: `x` on MariaDB/MySQL, [x] on Microsoft Fabric / SQL Server. */
export const qid = (connId: string | null, s: string) => (isTds(connId) ? qb(s) : qi(s));

/**
 * Table or view name to write in a query on the connection: db.table on MariaDB/MySQL; on Fabric the tree names
 * objects schema.object and documents already run on the database, so [schema].[object].
 */
export function qtable(connId: string | null, db: string, name: string) {
  if (!isTds(connId)) return `${qi(db)}.${qi(name)}`;
  const at = name.indexOf('.');
  return at < 0 ? `[dbo].${qb(name)}` : `${qb(name.slice(0, at))}.${qb(name.slice(at + 1))}`;
}

/** Tools written for MariaDB/MySQL refuse Fabric connections with a message instead of failing on its SQL. */
export function mysqlOnly(connId: string | null | undefined) {
  if (!isTds(connId)) return true;
  api.confirm(t('Funzione non disponibile per Microsoft Fabric'), t('Con le connessioni Microsoft Fabric / SQL Server MiB-SQL offre Database Explorer, editor SQL, risultati, export, cronologia, snippet e assistente AI.'), ['OK']);
  return false;
}

export function newDoc(opts: { connId?: string | null; db?: string | null; sql?: string; title?: string; file?: string | null; obj?: Doc['obj'] } = {}) {
  const s = st();
  const connId = opts.connId !== undefined ? opts.connId : (activeDoc()?.connId ?? s.selectedConn ?? s.conns[0]?.id ?? null);
  const db = opts.db !== undefined ? opts.db : connId === activeDoc()?.connId ? (activeDoc()?.db ?? null) : (s.conns.find((c) => c.id === connId)?.database || null);
  const id = crypto.randomUUID();
  modelOf(id, opts.sql ?? ''); // model first: the editor shows it as soon as the document becomes active
  const doc = s.addDoc({ id, connId, db, file: opts.file ?? null, ...(opts.title ? { title: opts.title } : {}), ...(opts.obj ? { obj: opts.obj } : {}) });
  persist();
  return doc;
}

/** Table designer document for an existing table, or a new one (table = null). */
export function openDesigner(connId: string, db: string, table: string | null) {
  const existing = table && st().docs.find((d) => d.kind === 'table' && d.connId === connId && d.db === db && d.design?.table === table);
  if (existing) { st().set({ activeDoc: existing.id }); return existing; }
  const doc = st().addDoc({ kind: 'table', connId, db, design: { table }, title: table ?? t('Nuova tabella'), dirty: !table });
  persist();
  return doc;
}

/** ER diagram of a database (one tab per connection/database). */
export function openEr(connId: string, db: string) {
  const existing = st().docs.find((d) => d.kind === 'er' && d.connId === connId && d.db === db);
  if (existing) { st().set({ activeDoc: existing.id }); return existing; }
  const doc = st().addDoc({ kind: 'er', connId, db, title: `ER ${db}` });
  persist();
  return doc;
}

/** Server-wide tools of a connection (session monitor, users): one tab per connection and kind. */
export type ServerTool = 'monitor' | 'users' | 'procs' | 'perf' | 'search' | 'logs';
const SERVER_TOOL_TITLE: Record<ServerTool, () => string> = { monitor: () => 'Monitor', users: () => t('Utenti'), procs: () => t('Processi'), perf: () => t('Prestazioni'), search: () => t('Cerca'), logs: () => 'Log' };

export function openServerTool(connId: string, kind: ServerTool, perf?: Doc['perf']) {
  const existing = st().docs.find((d) => d.kind === kind && d.connId === connId);
  if (existing) { st().set({ activeDoc: existing.id }); if (perf) st().updateDoc(existing.id, { perf }); return existing; }
  const name = st().conns.find((c) => c.id === connId)?.name ?? '';
  const doc = st().addDoc({ kind, connId, db: null, title: `${SERVER_TOOL_TITLE[kind]()} ${name}`, ...(perf ? { perf } : {}) });
  persist();
  return doc;
}

/** Database for the visual tools: the active document's, else the one selected in the explorer. */
export function visualTarget(): { connId: string; db: string } | null {
  const d = activeDoc();
  if (d?.connId && d.db) return { connId: d.connId, db: d.db };
  return st().selectedDb;
}

/** Opens a visual tool on the current database, or asks which database when none is selected. */
export function openVisual(kind: import('./store').VisualKind, target: { connId: string; db: string | null } | null = visualTarget()) {
  if (!mysqlOnly(target?.connId ?? activeDoc()?.connId ?? st().selectedConn)) return;
  if (SERVER_KINDS.has(kind)) {
    // server tools: the active document's or the explorer's connection when it is open, else ask
    const s = st();
    const connId = target?.connId ?? activeDoc()?.connId ?? s.selectedConn;
    if (connId && (target || s.connState[connId]?.status === 'open')) { openServerTool(connId, kind as ServerTool); return; }
    s.set({ pickTarget: { kind } });
    return;
  }
  if (!target?.db) { st().set({ pickTarget: { kind } }); return; }
  const { connId, db } = target as { connId: string; db: string };
  if (kind === 'er') openEr(connId, db);
  else if (kind === 'query') openQueryBuilder(connId, db);
  else if (kind === 'table') openDesigner(connId, db, null);
  else if (kind === 'maint') openMaint(connId, db);
  else if (kind === 'datagen' || kind === 'docgen') openDbTool(connId, db, kind);
  else if (kind === 'copy') st().set({ task: { kind: 'copy', connId, db } });
  else openCompare(connId, db);
}

/** Query history: one tab for all connections. */
export function openHistory() {
  const existing = st().docs.find((d) => d.kind === 'history');
  if (existing) { st().set({ activeDoc: existing.id }); return existing; }
  const doc = st().addDoc({ kind: 'history', title: t('Cronologia query') });
  persist();
  return doc;
}

/** Table maintenance of a database (one tab per connection/database), optionally with tables preselected. */
export function openMaint(connId: string, db: string, tables: string[] = []) {
  const existing = st().docs.find((d) => d.kind === 'maint' && d.connId === connId && d.db === db);
  if (existing) { st().updateDoc(existing.id, { maint: { tables } }); st().set({ activeDoc: existing.id }); return existing; }
  const doc = st().addDoc({ kind: 'maint', connId, db, title: t('Manutenzione {0}', db), maint: { tables } });
  persist();
  return doc;
}

/** Test data generator and documentation generator of a database (one tab per connection/database and kind). */
export function openDbTool(connId: string, db: string, kind: 'datagen' | 'docgen') {
  const existing = st().docs.find((d) => d.kind === kind && d.connId === connId && d.db === db);
  if (existing) { st().set({ activeDoc: existing.id }); return existing; }
  const doc = st().addDoc({ kind, connId, db, title: `${kind === 'datagen' ? t('Dati di test') : t('Documentazione')} ${db}` });
  persist();
  return doc;
}

/** Schema/data compare, the database as source. */
export function openCompare(connId: string, db: string) {
  const doc = st().addDoc({ kind: 'compare', connId, db, title: t('Confronto {0}', db), cmp: { src: { connId, db }, tgt: { connId, db: null } } });
  persist();
  return doc;
}

/** Visual query builder on a database. */
export function openQueryBuilder(connId: string, db: string) {
  const doc = st().addDoc({ kind: 'query', connId, db, title: `Query ${db}`, qb: emptyQuery() });
  persist();
  return doc;
}

export function openSql(f: SqlFile) {
  const existing = st().docs.find((d) => d.file === f.path);
  if (existing) { st().set({ activeDoc: existing.id }); return existing; }
  return newDoc({ sql: f.content, file: f.path, title: f.path.split('/').pop() });
}

export async function openFiles() {
  for (const f of await api.file.open()) openSql(f);
}

export async function saveDoc(id = st().activeDoc, as = false) {
  const doc = id ? docById(id) : undefined;
  if (!doc || doc.kind !== 'sql') return false;
  if (doc.obj) {
    // object editors: Save applies to the server; Save as exports the script without changing the tab
    if (!as) return applyObject(doc.id);
    return !!(await api.file.save(modelOf(doc.id).getValue(), null, `${doc.obj.name ?? doc.title}.sql`));
  }
  const file = await api.file.save(modelOf(doc.id).getValue(), as ? null : doc.file, doc.file ?? doc.title);
  if (!file) return false;
  markSaved(doc.id);
  st().updateDoc(doc.id, { file, title: file.split('/').pop()!, dirty: false });
  persist();
  return true;
}

export async function closeDoc(id = st().activeDoc) {
  const doc = id ? docById(id) : undefined;
  if (!doc) return;
  if (!(await discardEdits(doc, t('Chiudere il documento')))) return;
  if (doc.kind !== 'sql' && doc.kind !== 'table' && doc.kind !== 'query') {
    st().removeDoc(doc.id);
    persist();
    return;
  }
  if (doc.kind === 'table') {
    if (doc.dirty && (await api.confirm(t('Scartare le modifiche a {0}?', doc.title), t('La struttura della tabella non è stata applicata al server.'), [t('Scarta'), t('Annulla')])) !== 0) return;
    designByDoc.delete(doc.id);
    st().removeDoc(doc.id);
    persist();
    return;
  }
  if (doc.dirty && doc.obj) {
    const r = await api.confirm(t('Applicare le modifiche a {0}?', doc.title), t('La definizione modificata non è stata applicata al server.'), [t('Applica'), t('Scarta'), t('Annulla')]);
    if (r === 2) return;
    if (r === 0 && !(await applyObject(doc.id))) return;
  } else if (doc.dirty) {
    const r = await api.confirm(t('Salvare le modifiche a {0}?', doc.title), t('Le modifiche non salvate andranno perse.'), [t('Salva'), t('Non salvare'), t('Annulla')]);
    if (r === 2) return;
    if (r === 0 && !(await saveDoc(doc.id))) return;
  }
  if (doc.running && doc.sessionId) await api.sess.cancel(doc.sessionId).catch(() => {});
  if (doc.sessionId) api.sess.close(doc.sessionId).catch(() => {});
  st().removeDoc(doc.id);
  disposeModel(doc.id);
  persist();
}

/** Binds a document to a connection/database; the session is (re)opened on the next execution. */
export async function setDocTarget(id: string, connId: string | null, db: string | null) {
  const doc = docById(id);
  if (!doc) return;
  if (doc.connId !== connId && doc.sessionId) {
    api.sess.close(doc.sessionId).catch(() => {});
    st().updateDoc(id, { sessionId: null });
  }
  st().updateDoc(id, { connId, db });
  const sid = docById(id)?.sessionId;
  if (sid && db) {
    try { await api.sess.use(sid, db); } catch (err) { logMessage(id, 'error', (err as Error).message); }
  }
  persist();
}

const now = () => new Date().toLocaleTimeString(locale());

export function logMessage(id: string, level: Message['level'], text: string, extra: Partial<Message> = {}) {
  st().updateDoc(id, (d) => ({ messages: [...d.messages, { at: now(), level, text, ...extra }].slice(-1000) }));
}

async function ensureSession(doc: Doc) {
  if (!doc.connId) throw new Error(t('Nessuna connessione selezionata per questo documento.'));
  if (st().connState[doc.connId]?.status !== 'open' && !(await st().openConn(doc.connId))) {
    throw new Error(st().connState[doc.connId]?.error ?? t('Connessione non aperta.'));
  }
  const fresh = docById(doc.id)!;
  if (fresh.sessionId) return fresh.sessionId;
  const s = await api.sess.open(doc.connId, doc.db);
  st().updateDoc(doc.id, { sessionId: s.id, db: s.db });
  return s.id;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString(locale())} ${n === 1 ? one : many}`;
const DDL_RE = /^\s*(create|alter|drop|rename|truncate)\b/i;

function describe(r: StmtResult) {
  if (r.error) return t('Errore {0} ({1}): {2}', r.error.errno ?? '', r.error.sqlState ?? r.error.code ?? '', r.error.message);
  if (r.sets.length) return r.sets.map((s) => plural(s.total, t('riga restituita'), t('righe restituite')) + (s.truncated ? t(' (mostrate {0})', s.rows.length.toLocaleString(locale())) : '')).join(', ') + t(' in {0} ms', r.ms);
  return t('{0}{1} in {2} ms', plural(r.affectedRows ?? 0, t('riga interessata'), t('righe interessate')), r.insertId ? t(', ultimo id {0}', r.insertId) : '', r.ms);
}

/** Before quitting: what would be lost, and the choice to save files, quit anyway or stay. */
export async function requestQuit() {
  const docs = st().docs;
  const files = docs.filter((d) => d.kind === 'sql' && d.dirty && d.file && !d.obj);
  const designs = docs.filter((d) => (d.kind === 'table' || d.obj) && d.dirty);
  const edits = docs.reduce((n, d) => n + pendingEdits(d), 0);
  if (!files.length && !designs.length && !edits) { api.confirmClose(); return; }
  const lines = [
    files.length ? t('File non salvati: {0}', files.map((d) => d.title).join(', ')) : '',
    designs.length ? t('Strutture non applicate: {0}', designs.map((d) => d.title).join(', ')) : '',
    edits ? t('{0} modifiche ai dati in griglia non applicate', edits) : '',
  ].filter(Boolean).join('\n');
  const buttons = files.length ? [t('Salva i file ed esci'), t('Esci senza salvare'), t('Annulla')] : [t('Esci comunque'), t('Annulla')];
  const r = await api.confirm(t('Ci sono modifiche non salvate'), lines, buttons);
  if (r === buttons.length - 1) return;
  if (files.length && r === 0) {
    for (const d of files) if (!(await saveDoc(d.id))) return;
  }
  api.confirmClose();
}

/** Grid edits not yet applied in the document's results. */
export const pendingEdits = (doc: Doc) =>
  doc.run?.results.reduce((n, r) => n + r.sets.reduce((m, s) => m + editCount(editsBySet.get(s) ?? { updates: {}, deleted: [], inserted: [] }), 0), 0) ?? 0;

async function discardEdits(doc: Doc, action: string) {
  const n = pendingEdits(doc);
  if (!n) return true;
  return (await api.confirm(t('{0} modifiche ai dati non applicate', n), t('{0} le scarta.', action), [t('Scarta modifiche'), t('Annulla')])) === 0;
}

/** Executes the document: selection or whole script (all), statement under cursor (current) or its plan. */
export async function runDoc(mode: ExecMode, id = st().activeDoc) {
  const doc = id ? docById(id) : undefined;
  if (!doc || doc.running || (doc.kind !== 'sql' && doc.kind !== 'query')) return;
  if (doc.obj) { if (mode !== 'explain') await applyObject(doc.id); return; }
  if (doc.kind === 'query') modelOf(doc.id).setValue(toSql(doc.qb ?? emptyQuery(), doc.db ?? ''));
  if (!(await discardEdits(doc, t('Eseguire di nuovo')))) return;
  const model = modelOf(doc.id);
  const ed = editorOf(doc.id);
  const text = model.getValue();
  const sel = ed?.getSelection();
  const opts: Parameters<typeof api.sess.exec>[2] = { mode };
  if (mode === 'all' && sel && !sel.isEmpty()) {
    opts.mode = 'selection';
    opts.selStart = model.getOffsetAt(sel.getStartPosition());
    opts.selEnd = model.getOffsetAt(sel.getEndPosition());
  }
  opts.cursor = ed?.getPosition() ? model.getOffsetAt(ed.getPosition()!) : 0;
  clearMarkers(model);
  st().updateDoc(doc.id, { running: true, startedAt: Date.now() });
  const t0 = performance.now();
  try {
    const sid = await ensureSession(doc);
    const r = await api.sess.exec(sid, text, opts);
    const ms = Math.round(performance.now() - t0);
    for (const x of r.results) {
      logMessage(doc.id, x.error ? 'error' : 'ok', describe(x), { sql: x.sql, offset: x.start });
      for (const w of x.warnings) if (mode !== 'explain') logMessage(doc.id, 'warning', `${w.level} ${w.code}: ${w.message}`, { offset: x.start });
    }
    if (!r.results.length) logMessage(doc.id, 'info', t('Nessuna istruzione da eseguire.'));
    if (r.cancelled) logMessage(doc.id, 'warning', t('Esecuzione annullata.'));
    markErrors(model, r.results);
    if (mode !== 'explain') recordHistory(doc, r.results);
    const firstSet = r.results.some((x) => x.sets.length) ? 0 : 'messages';
    const failed = r.results.some((x) => x.error);
    st().updateDoc(doc.id, { run: { results: r.results, explain: mode === 'explain', ms }, db: r.db, view: failed ? 'messages' : firstSet });
    if (r.results.some((x) => !x.error && DDL_RE.test(x.sql))) refreshAfterDdl(doc.connId!);
  } catch (err) {
    logMessage(doc.id, 'error', (err as Error).message);
    st().updateDoc(doc.id, { view: 'messages' });
  } finally {
    st().updateDoc(doc.id, { running: false });
    persist();
  }
}

/** Profiles the statement under the cursor: result, stages, counters and real plan in the "Profilo" tab. */
export async function profileDoc(id = st().activeDoc) {
  const doc = id ? docById(id) : undefined;
  if (!doc || doc.running || doc.kind !== 'sql') return;
  if (!(await discardEdits(doc, t('Profilare')))) return;
  const model = modelOf(doc.id);
  const ed = editorOf(doc.id);
  const cursor = ed?.getPosition() ? model.getOffsetAt(ed.getPosition()!) : 0;
  clearMarkers(model);
  st().updateDoc(doc.id, { running: true, startedAt: Date.now() });
  try {
    const sid = await ensureSession(doc);
    const p = await api.sess.profile(sid, model.getValue(), cursor);
    const result: StmtResult = {
      sql: p.sql, start: p.start, end: p.end, sets: p.sets, affectedRows: p.affectedRows, insertId: null, warnings: [], ms: Math.round(p.ms),
      error: p.error ? { message: p.error.message, fatal: false } : null,
    };
    markErrors(model, [result]);
    recordHistory(doc, [result]);
    logMessage(doc.id, p.error ? 'error' : 'ok', p.error ? p.error.message : t('Profilo: {0} ms, {1}', p.ms, p.rows ? t('{0} righe', p.rows) : t('{0} righe interessate', p.affectedRows ?? 0)), { sql: p.sql, offset: p.start });
    st().updateDoc(doc.id, { run: { results: [result], explain: false, ms: Math.round(p.ms), profile: p }, db: p.db, view: p.error ? 'messages' : 'profile' });
  } catch (err) {
    logMessage(doc.id, 'error', (err as Error).message);
    st().updateDoc(doc.id, { view: 'messages' });
  } finally {
    st().updateDoc(doc.id, { running: false });
  }
}

export async function cancelDoc(id = st().activeDoc) {
  const doc = id ? docById(id) : undefined;
  if (doc?.running && doc.sessionId) await api.sess.cancel(doc.sessionId);
}

function refreshAfterDdl(connId: string) {
  st().dropMeta(`${connId}/`);
}

export async function selectTop(connId: string, db: string, table: string, limit = 1000) {
  const sql = isTds(connId) ? `SELECT TOP (${limit}) *\nFROM ${qtable(connId, db, table)};\n` : `SELECT *\nFROM ${qtable(connId, db, table)}\nLIMIT ${limit};\n`;
  const doc = newDoc({ connId, db, sql, title: `${table}.sql` });
  await runDoc('all', doc.id);
}

export async function showDdl(connId: string, db: string, kind: ObjectKind, name: string) {
  try {
    const sql = await api.meta.ddl(connId, db, kind, name);
    newDoc({ connId, db, sql, title: `${name}.sql` });
  } catch (err) {
    const doc = newDoc({ connId, db, title: `${name}.sql` });
    logMessage(doc.id, 'error', (err as Error).message);
  }
}

export function insertText(text: string) {
  const doc = activeDoc();
  const ed = doc ? editorOf(doc.id) : null;
  if (!ed) return;
  ed.executeEdits('mibsql', [{ range: ed.getSelection()!, text, forceMoveMarkers: true }]);
  ed.focus();
}

/** Moves the cursor to a script offset (double click on a message). */
export function reveal(docId: string, offset: number) {
  const ed = editorOf(docId);
  if (!ed) return;
  const pos = modelOf(docId).getPositionAt(offset);
  ed.setPosition(pos);
  ed.revealPositionInCenter(pos);
  ed.focus();
}

/** Replaces the whole document text as one undoable edit. */
export function replaceDocText(docId: string, text: string) {
  const ed = editorOf(docId);
  const model = modelOf(docId);
  if (ed) { ed.executeEdits('mibsql', [{ range: model.getFullModelRange(), text, forceMoveMarkers: true }]); ed.focus(); }
  else model.setValue(text);
}

/** Opens the AI assistant beside the active SQL document (a new one if none is active). */
export function openAssistant() {
  const d = activeDoc();
  if (!d || d.kind !== 'sql') {
    const t = visualTarget();
    newDoc(t ? { connId: t.connId, db: t.db } : {});
  }
  st().setAssistantOpen(true);
}

// ---- Query history ----

const HISTORY_KEY = 'mibsql.history';
export const historyEnabled = () => { try { return localStorage.getItem(HISTORY_KEY) !== '0'; } catch { return true; } };
export const setHistoryEnabled = (on: boolean) => { try { localStorage.setItem(HISTORY_KEY, on ? '1' : '0'); } catch { /* ignore */ } };

/** Executed statements go to the history (passwords in CREATE/ALTER USER masked); scripts: the first 200. */
function recordHistory(doc: Doc, results: StmtResult[]) {
  if (!historyEnabled() || !results.length) return;
  const conn = st().conns.find((c) => c.id === doc.connId)?.name ?? '';
  const at = new Date().toISOString();
  api.history.add(results.slice(0, 200).map((x) => ({
    at, connId: doc.connId, conn, db: doc.db, sql: maskPasswords(x.sql), ms: x.ms,
    rows: x.sets.length ? x.sets.reduce((n, s) => n + s.total, 0) : null,
    affected: x.sets.length || x.error ? null : x.affectedRows,
    error: x.error?.message ?? null,
  }))).then(() => st().set({ historyTick: st().historyTick + 1 })).catch(() => {});
}

// ---- Formatting ----

/** Formats the selection, or the whole document, as one undoable edit. */
export function formatDoc(id = st().activeDoc) {
  const doc = id ? docById(id) : undefined;
  const ed = doc?.kind === 'sql' ? editorOf(doc.id) : null;
  if (!doc || !ed) return;
  const model = modelOf(doc.id);
  const sel = ed.getSelection();
  const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange();
  const text = model.getValueInRange(range);
  let out: string;
  try { out = formatText(text); } catch (err) { logMessage(doc.id, 'error', t('Formattazione non riuscita: {0}', (err as Error).message)); return; }
  if (out === text) return;
  ed.pushUndoStop();
  ed.executeEdits('mibsql.format', [{ range, text: out, forceMoveMarkers: true }]);
  ed.pushUndoStop();
  ed.focus();
}

// ---- Views, routines, triggers, events edited as SQL documents ----

export const OBJECT_WORD: Record<EditableKind, string> = { view: 'VIEW', procedure: 'PROCEDURE', function: 'FUNCTION', trigger: 'TRIGGER', event: 'EVENT' };
export const OBJECT_LABEL: Record<EditableKind, string> = { view: t('vista'), procedure: t('procedura'), function: t('funzione'), trigger: 'trigger', event: t('evento') };
const FEMININE = new Set<EditableKind>(['view', 'procedure', 'function']);
const g = (kind: EditableKind, f: string, m: string) => (FEMININE.has(kind) ? f : m);
const objectTitle = (kind: EditableKind, name: string | null) => name ?? `${g(kind, t('Nuova'), t('Nuovo'))} ${OBJECT_LABEL[kind]}`;

const TEMPLATES: Record<EditableKind, (table?: string) => string> = {
  view: () => 'CREATE VIEW nuova_vista AS\nSELECT\n  1 AS colonna;\n',
  procedure: () => 'DELIMITER $$\nCREATE PROCEDURE nuova_procedura(IN p_id INT)\nBEGIN\n  SELECT p_id;\nEND$$\nDELIMITER ;\n',
  function: () => 'DELIMITER $$\nCREATE FUNCTION nuova_funzione(p INT) RETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN p * 2;\nEND$$\nDELIMITER ;\n',
  trigger: (table) => `DELIMITER $$\nCREATE TRIGGER ${table ? `${table}_before_insert` : 'nuovo_trigger'} BEFORE INSERT ON ${table ? qi(table) : 'tabella'}\nFOR EACH ROW\nBEGIN\n  -- SET NEW.colonna = …;\nEND$$\nDELIMITER ;\n`,
  event: () => 'DELIMITER $$\nCREATE EVENT nuovo_evento\nON SCHEDULE EVERY 1 DAY STARTS CURRENT_TIMESTAMP + INTERVAL 1 HOUR\nDO\nBEGIN\n  -- …\nEND$$\nDELIMITER ;\n',
};

/** Opens a view/routine/trigger/event in an editor tab with its CREATE statement (views formatted). */
export async function openObject(connId: string, db: string, kind: EditableKind, name: string) {
  const existing = st().docs.find((d) => d.obj?.kind === kind && d.obj.name === name && d.connId === connId && d.db === db);
  if (existing) { st().set({ activeDoc: existing.id }); return existing; }
  let sql: string;
  try {
    sql = await api.meta.ddl(connId, db, kind, name);
    if (kind === 'view') sql = formatText(sql);
  } catch (err) {
    const doc = newDoc({ connId, db, title: `${name}.sql` });
    logMessage(doc.id, 'error', (err as Error).message);
    return doc;
  }
  return newDoc({ connId, db, sql, title: name, obj: { kind, name } });
}

export function openNewObject(connId: string, db: string, kind: EditableKind, table?: string) {
  const doc = newDoc({ connId, db, sql: TEMPLATES[kind](table), title: objectTitle(kind, null), obj: { kind, name: null } });
  st().updateDoc(doc.id, { dirty: true });
  return doc;
}

/** Applies an object editor to the server (CREATE, CREATE OR REPLACE or DROP + CREATE: see objects.cjs). */
export async function applyObject(id = st().activeDoc) {
  const doc = id ? docById(id) : undefined;
  if (!doc?.obj || doc.running) return false;
  if (!doc.connId || !doc.db) { logMessage(doc.id, 'error', t('Scegli connessione e database dell\'oggetto.')); return false; }
  const { kind, name: orig } = doc.obj;
  const model = modelOf(doc.id);
  const text = model.getValue();
  clearMarkers(model);
  st().updateDoc(doc.id, { running: true, startedAt: Date.now() });
  const t0 = performance.now();
  try {
    if (st().connState[doc.connId]?.status !== 'open' && !(await st().openConn(doc.connId))) throw new Error(st().connState[doc.connId]?.error ?? t('Connessione non aperta.'));
    const r = await api.objects.apply(doc.connId, doc.db, kind, orig, text);
    const ms = Math.round(performance.now() - t0);
    markSaved(doc.id);
    st().updateDoc(doc.id, { obj: { kind, name: r.name }, title: r.name, dirty: false });
    const gr = r.grants;
    const grants = !gr ? '' : gr.unreadable ? t('; privilegi sulla routine non leggibili (serve SELECT su mysql.procs_priv): eventuali EXECUTE vanno riassegnati')
      : gr.restored ? t('; privilegi sulla routine riassegnati ({0})', gr.restored) : '';
    const how = r.method === 'drop-create' ? t(' ({0}: il server non ha CREATE OR REPLACE per questo oggetto{1})', g(kind, t('eliminata e ricreata'), t('eliminato e ricreato')), grants) : '';
    const label = OBJECT_LABEL[kind][0].toUpperCase() + OBJECT_LABEL[kind].slice(1);
    logMessage(doc.id, 'ok', t('{0} {1} {2} in {3} ms{4}.', label, r.name, r.created ? g(kind, t('creata'), t('creato')) : g(kind, t('aggiornata'), t('aggiornato')), ms, how));
    if (gr?.failed.length) logMessage(doc.id, 'warning', t('Privilegi non riassegnati:\n{0}', gr.failed.join('\n')));
    recordHistory(doc, [{ sql: text.trim(), start: 0, end: text.length, sets: [], affectedRows: 0, insertId: null, warnings: [], ms, error: null }]);
    if (r.renamed && orig) {
      const drop = await api.confirm(t('Eliminare {0}?', orig), t('È stato creato {0}; l\'oggetto con il vecchio nome {1} esiste ancora.', r.name, orig), [t('Elimina {0}', orig), t('Mantieni entrambi')]);
      if (drop === 0) {
        await api.ddl.run(doc.connId, [`DROP ${OBJECT_WORD[kind]} ${qi(doc.db)}.${qi(orig)}`]);
        logMessage(doc.id, 'ok', `${orig} ${g(kind, t('eliminata'), t('eliminato'))}.`);
      }
    }
    st().dropMeta(`${doc.connId}/${doc.db}/`);
    st().updateDoc(doc.id, { view: 'messages' });
    return true;
  } catch (err) {
    const message = (err as Error).message;
    logMessage(doc.id, 'error', message);
    // the server's "at line N" is relative to the CREATE statement
    const stmt = (await api.split(text).catch(() => []))[0];
    if (stmt) markErrors(model, [{ sql: stmt.sql, start: stmt.start, end: stmt.end, sets: [], affectedRows: null, insertId: null, warnings: [], ms: 0, error: { message, fatal: false } }]);
    st().updateDoc(doc.id, { view: 'messages' });
    return false;
  } finally {
    st().updateDoc(doc.id, { running: false });
    persist();
  }
}

/** Performance center › query optimizer on the selection or the statement under the cursor. */
export async function optimizeDoc(id = st().activeDoc) {
  const doc = id ? docById(id) : undefined;
  if (!doc || doc.kind !== 'sql' || !doc.connId || !mysqlOnly(doc.connId)) return;
  const ed = editorOf(doc.id);
  const model = modelOf(doc.id);
  const sel = ed?.getSelection();
  let sql = sel && !sel.isEmpty() ? model.getValueInRange(sel) : '';
  if (!sql.trim()) {
    const at = ed?.getPosition() ? model.getOffsetAt(ed.getPosition()!) : 0;
    const stmts = await api.split(model.getValue()).catch(() => []);
    sql = (stmts.find((s) => at >= s.start && at <= s.end + 1) ?? stmts[0])?.sql ?? '';
  }
  openServerTool(doc.connId, 'perf', { tab: 'optimize', sql: sql.trim(), db: doc.db });
}

/** DROP of a view/routine/trigger/event after confirmation; its editor tabs are closed. */
export async function dropObject(connId: string, db: string, kind: EditableKind, name: string) {
  if ((await api.confirm(t('Eliminare {0} {1} {2}.{3}?', g(kind, t('la'), t('il')), OBJECT_LABEL[kind], db, name), t('DROP {0} non si può annullare.', OBJECT_WORD[kind]), [t('Elimina'), t('Annulla')])) !== 0) return;
  try {
    await api.ddl.run(connId, [`DROP ${OBJECT_WORD[kind]} ${qi(db)}.${qi(name)}`]);
  } catch (err) {
    await api.confirm(t('Eliminazione non riuscita'), (err as Error).message, ['OK']);
    return;
  }
  st().dropMeta(`${connId}/${db}/`);
  for (const d of st().docs) if (d.obj?.kind === kind && d.obj.name === name && d.connId === connId && d.db === db) { st().updateDoc(d.id, { dirty: false }); markSaved(d.id); await closeDoc(d.id); }
}

export const refreshExplorer = (connId: string) => st().dropMeta(`${connId}/`);
export const invalidateSchema = (connId: string, db: string) => st().dropMeta(metaKey.schema(connId, db));

// ---- Tabs survive restarts (text, binding, file), like dbForge's "restore documents" ----

const KEY = 'mibsql.docs';
let timer: number | undefined;

export function persist(now = false) {
  clearTimeout(timer);
  const save = () => {
    const { docs, activeDoc: active } = st();
    // designer tabs reopen on the server's definition: unapplied structure changes are not kept
    const data = docs.map((d) => (d.kind !== 'sql'
      ? { id: d.id, kind: d.kind, design: d.design, qb: d.qb, cmp: d.cmp, perf: d.perf, datagen: d.datagen, search: d.search, title: d.title, connId: d.connId, db: d.db, file: null, dirty: false, sql: '' }
      : { id: d.id, kind: d.kind, obj: d.obj, title: d.title, connId: d.connId, db: d.db, file: d.file, dirty: d.dirty, sql: modelOf(d.id).getValue() }))
      .filter((d) => d.kind !== 'table' || d.design?.table);
    try { localStorage.setItem(KEY, JSON.stringify({ docs: data, active })); } catch { /* storage unavailable */ }
  };
  if (now) save(); else timer = window.setTimeout(save, 400);
}

/**
 * Switches the UI language: the window reloads (every text is translated once at load), tabs come back from
 * the saved state and the connections that were open are opened again.
 */
export async function switchLanguage(lang: import('./i18n').Lang) {
  const s = st();
  if (s.docs.some((d) => d.running) && (await api.confirm(t('Cambiare lingua?'), t('Le query in esecuzione verranno interrotte.'), [t('Cambia lingua'), t('Annulla')])) !== 0) return;
  persist(true);
  const open = Object.entries(s.connState).filter(([, c]) => c.status === 'open').map(([id]) => id);
  try { sessionStorage.setItem('mibsql.reopen', JSON.stringify(open)); } catch { /* ignore */ }
  for (const d of s.docs) if (d.sessionId) await api.sess.close(d.sessionId).catch(() => {});
  setLang(lang);
  await api.setLang(lang).catch(() => {});
  location.reload();
}

/** Title of a tool tab in the current language (saved titles were written in the language of the time). */
function toolTitle(kind: Doc['kind'], connId: string | null, db: string | null, saved: string) {
  const name = st().conns.find((c) => c.id === connId)?.name ?? '';
  switch (kind) {
    case 'history': return t('Cronologia query');
    case 'maint': return t('Manutenzione {0}', db ?? '');
    case 'compare': return t('Confronto {0}', db ?? '');
    case 'datagen': return `${t('Dati di test')} ${db}`;
    case 'docgen': return `${t('Documentazione')} ${db}`;
    case 'monitor': case 'users': case 'procs': case 'perf': case 'logs': return `${SERVER_TOOL_TITLE[kind]()} ${name}`;
    default: return saved;
  }
}

export function restore() {
  try {
    const reopen = JSON.parse(sessionStorage.getItem('mibsql.reopen') ?? '[]') as string[];
    sessionStorage.removeItem('mibsql.reopen');
    for (const id of reopen) if (st().conns.some((c) => c.id === id)) st().openConn(id);
  } catch { /* ignore */ }
  let saved: { docs: { id: string; kind?: Doc['kind']; obj?: Doc['obj']; design?: Doc['design']; qb?: Doc['qb']; cmp?: Doc['cmp']; perf?: Doc['perf']; datagen?: Doc['datagen']; search?: Doc['search']; title: string; connId: string | null; db: string | null; file: string | null; dirty: boolean; sql: string }[]; active: string | null } | null = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { saved = null; }
  if (!saved?.docs?.length) return;
  const known = new Set(st().conns.map((c) => c.id));
  for (const d of saved.docs) {
    if (d.kind && d.kind !== 'sql') {
      if (d.kind === 'history') st().addDoc({ id: d.id, kind: d.kind, title: toolTitle(d.kind, null, null, d.title) });
      else if (d.connId && known.has(d.connId) && (d.db || d.kind === 'monitor' || d.kind === 'users' || d.kind === 'procs' || d.kind === 'perf' || d.kind === 'search' || d.kind === 'logs')) st().addDoc({ id: d.id, kind: d.kind, design: d.design, qb: d.qb, cmp: d.cmp, perf: d.perf, datagen: d.datagen, search: d.search, title: toolTitle(d.kind, d.connId, d.db, d.title), connId: d.connId, db: d.db });
      continue;
    }
    const m = /^SQL(\d+)\.sql$/.exec(d.title);
    if (m) setUntitled(Number(m[1]));
    modelOf(d.id, d.sql, d.dirty);
    st().addDoc({ id: d.id, title: d.title, connId: d.connId && known.has(d.connId) ? d.connId : null, db: d.db, file: d.file, dirty: d.dirty, ...(d.obj ? { obj: d.obj } : {}) });
  }
  if (saved.active && st().docs.some((d) => d.id === saved!.active)) st().set({ activeDoc: saved.active });
}
