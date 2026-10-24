// Document actions shared by toolbar, shortcuts and explorer: they need both the store and the editor models.
import { api, type SqlFile } from './api';
import { clearMarkers, disposeModel, markErrors, markSaved, modelOf, monaco } from './editor';
import { editCount } from './edits';
import { emptyQuery, toSql } from './qb';
import { designByDoc, editsBySet, metaKey, setUntitled, useStore } from './store';
import type { Doc, ExecMode, Message, ObjectKind, StmtResult } from './types';

const st = () => useStore.getState();
const docById = (id: string) => st().docs.find((d) => d.id === id);
export const activeDoc = () => docById(st().activeDoc ?? '');

let editorOf: (docId: string) => monaco.editor.IStandaloneCodeEditor | null = () => null;
export const bindEditor = (fn: typeof editorOf) => { editorOf = fn; };

export const qi = (s: string) => '`' + s.replace(/`/g, '``') + '`';

export function newDoc(opts: { connId?: string | null; db?: string | null; sql?: string; title?: string; file?: string | null } = {}) {
  const s = st();
  const connId = opts.connId !== undefined ? opts.connId : (activeDoc()?.connId ?? s.selectedConn ?? s.conns[0]?.id ?? null);
  const db = opts.db !== undefined ? opts.db : connId === activeDoc()?.connId ? (activeDoc()?.db ?? null) : (s.conns.find((c) => c.id === connId)?.database || null);
  const id = crypto.randomUUID();
  modelOf(id, opts.sql ?? ''); // model first: the editor shows it as soon as the document becomes active
  const doc = s.addDoc({ id, connId, db, file: opts.file ?? null, ...(opts.title ? { title: opts.title } : {}) });
  persist();
  return doc;
}

/** Table designer document for an existing table, or a new one (table = null). */
export function openDesigner(connId: string, db: string, table: string | null) {
  const existing = table && st().docs.find((d) => d.kind === 'table' && d.connId === connId && d.db === db && d.design?.table === table);
  if (existing) { st().set({ activeDoc: existing.id }); return existing; }
  const doc = st().addDoc({ kind: 'table', connId, db, design: { table }, title: table ?? 'Nuova tabella', dirty: !table });
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
export function openServerTool(connId: string, kind: 'monitor' | 'users') {
  const existing = st().docs.find((d) => d.kind === kind && d.connId === connId);
  if (existing) { st().set({ activeDoc: existing.id }); return existing; }
  const name = st().conns.find((c) => c.id === connId)?.name ?? '';
  const doc = st().addDoc({ kind, connId, db: null, title: `${kind === 'monitor' ? 'Monitor' : 'Utenti'} ${name}` });
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
export function openVisual(kind: import('./store').VisualKind, target = visualTarget()) {
  if (!target) { st().set({ pickTarget: { kind } }); return; }
  const { connId, db } = target;
  if (kind === 'er') openEr(connId, db);
  else if (kind === 'query') openQueryBuilder(connId, db);
  else if (kind === 'table') openDesigner(connId, db, null);
  else openCompare(connId, db);
}

/** Schema/data compare, the database as source. */
export function openCompare(connId: string, db: string) {
  const doc = st().addDoc({ kind: 'compare', connId, db, title: `Confronto ${db}`, cmp: { src: { connId, db }, tgt: { connId, db: null } } });
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
  if (!(await discardEdits(doc, 'Chiudere il documento'))) return;
  if (doc.kind === 'er' || doc.kind === 'compare' || doc.kind === 'monitor' || doc.kind === 'users') {
    st().removeDoc(doc.id);
    persist();
    return;
  }
  if (doc.kind === 'table') {
    if (doc.dirty && (await api.confirm(`Scartare le modifiche a ${doc.title}?`, 'La struttura della tabella non è stata applicata al server.', ['Scarta', 'Annulla'])) !== 0) return;
    designByDoc.delete(doc.id);
    st().removeDoc(doc.id);
    persist();
    return;
  }
  if (doc.dirty) {
    const r = await api.confirm(`Salvare le modifiche a ${doc.title}?`, 'Le modifiche non salvate andranno perse.', ['Salva', 'Non salvare', 'Annulla']);
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

const now = () => new Date().toLocaleTimeString('it-IT');

export function logMessage(id: string, level: Message['level'], text: string, extra: Partial<Message> = {}) {
  st().updateDoc(id, (d) => ({ messages: [...d.messages, { at: now(), level, text, ...extra }].slice(-1000) }));
}

async function ensureSession(doc: Doc) {
  if (!doc.connId) throw new Error('Nessuna connessione selezionata per questo documento.');
  if (st().connState[doc.connId]?.status !== 'open' && !(await st().openConn(doc.connId))) {
    throw new Error(st().connState[doc.connId]?.error ?? 'Connessione non aperta.');
  }
  const fresh = docById(doc.id)!;
  if (fresh.sessionId) return fresh.sessionId;
  const s = await api.sess.open(doc.connId, doc.db);
  st().updateDoc(doc.id, { sessionId: s.id, db: s.db });
  return s.id;
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString('it-IT')} ${n === 1 ? one : many}`;
const DDL_RE = /^\s*(create|alter|drop|rename|truncate)\b/i;

function describe(r: StmtResult) {
  if (r.error) return `Errore ${r.error.errno ?? ''} (${r.error.sqlState ?? r.error.code ?? ''}): ${r.error.message}`;
  if (r.sets.length) return r.sets.map((s) => plural(s.total, 'riga restituita', 'righe restituite') + (s.truncated ? ` (mostrate ${s.rows.length.toLocaleString('it-IT')})` : '')).join(', ') + ` in ${r.ms} ms`;
  return `${plural(r.affectedRows ?? 0, 'riga interessata', 'righe interessate')}${r.insertId ? `, ultimo id ${r.insertId}` : ''} in ${r.ms} ms`;
}

/** Before quitting: what would be lost, and the choice to save files, quit anyway or stay. */
export async function requestQuit() {
  const docs = st().docs;
  const files = docs.filter((d) => d.kind === 'sql' && d.dirty && d.file);
  const designs = docs.filter((d) => d.kind === 'table' && d.dirty);
  const edits = docs.reduce((n, d) => n + pendingEdits(d), 0);
  if (!files.length && !designs.length && !edits) { api.confirmClose(); return; }
  const lines = [
    files.length ? `File non salvati: ${files.map((d) => d.title).join(', ')}` : '',
    designs.length ? `Strutture non applicate: ${designs.map((d) => d.title).join(', ')}` : '',
    edits ? `${edits} modifiche ai dati in griglia non applicate` : '',
  ].filter(Boolean).join('\n');
  const buttons = files.length ? ['Salva i file ed esci', 'Esci senza salvare', 'Annulla'] : ['Esci comunque', 'Annulla'];
  const r = await api.confirm('Ci sono modifiche non salvate', lines, buttons);
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
  return (await api.confirm(`${n} modifiche ai dati non applicate`, `${action} le scarta.`, ['Scarta modifiche', 'Annulla'])) === 0;
}

/** Executes the document: selection or whole script (all), statement under cursor (current) or its plan. */
export async function runDoc(mode: ExecMode, id = st().activeDoc) {
  const doc = id ? docById(id) : undefined;
  if (!doc || doc.running || (doc.kind !== 'sql' && doc.kind !== 'query')) return;
  if (doc.kind === 'query') modelOf(doc.id).setValue(toSql(doc.qb ?? emptyQuery(), doc.db ?? ''));
  if (!(await discardEdits(doc, 'Eseguire di nuovo'))) return;
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
    if (!r.results.length) logMessage(doc.id, 'info', 'Nessuna istruzione da eseguire.');
    if (r.cancelled) logMessage(doc.id, 'warning', 'Esecuzione annullata.');
    markErrors(model, r.results);
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
  if (!(await discardEdits(doc, 'Profilare'))) return;
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
    logMessage(doc.id, p.error ? 'error' : 'ok', p.error ? p.error.message : `Profilo: ${p.ms} ms, ${p.rows ? `${p.rows} righe` : `${p.affectedRows ?? 0} righe interessate`}`, { sql: p.sql, offset: p.start });
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
  const doc = newDoc({ connId, db, sql: `SELECT *\nFROM ${qi(db)}.${qi(table)}\nLIMIT ${limit};\n`, title: `${table}.sql` });
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

export const refreshExplorer = (connId: string) => st().dropMeta(`${connId}/`);
export const invalidateSchema = (connId: string, db: string) => st().dropMeta(metaKey.schema(connId, db));

// ---- Tabs survive restarts (text, binding, file), like dbForge's "restore documents" ----

const KEY = 'mibsql.docs';
let timer: number | undefined;

export function persist() {
  clearTimeout(timer);
  timer = window.setTimeout(() => {
    const { docs, activeDoc: active } = st();
    // designer tabs reopen on the server's definition: unapplied structure changes are not kept
    const data = docs.map((d) => (d.kind !== 'sql'
      ? { id: d.id, kind: d.kind, design: d.design, qb: d.qb, cmp: d.cmp, title: d.title, connId: d.connId, db: d.db, file: null, dirty: false, sql: '' }
      : { id: d.id, kind: d.kind, title: d.title, connId: d.connId, db: d.db, file: d.file, dirty: d.dirty, sql: modelOf(d.id).getValue() }))
      .filter((d) => d.kind !== 'table' || d.design?.table);
    try { localStorage.setItem(KEY, JSON.stringify({ docs: data, active })); } catch { /* storage unavailable */ }
  }, 400);
}

export function restore() {
  let saved: { docs: { id: string; kind?: Doc['kind']; design?: Doc['design']; qb?: Doc['qb']; cmp?: Doc['cmp']; title: string; connId: string | null; db: string | null; file: string | null; dirty: boolean; sql: string }[]; active: string | null } | null = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) ?? 'null'); } catch { saved = null; }
  if (!saved?.docs?.length) return;
  const known = new Set(st().conns.map((c) => c.id));
  for (const d of saved.docs) {
    if (d.kind && d.kind !== 'sql') {
      if (d.connId && known.has(d.connId) && (d.db || d.kind === 'monitor' || d.kind === 'users')) st().addDoc({ id: d.id, kind: d.kind, design: d.design, qb: d.qb, cmp: d.cmp, title: d.title, connId: d.connId, db: d.db });
      continue;
    }
    const m = /^SQL(\d+)\.sql$/.exec(d.title);
    if (m) setUntitled(Number(m[1]));
    modelOf(d.id, d.sql, d.dirty);
    st().addDoc({ id: d.id, title: d.title, connId: d.connId && known.has(d.connId) ? d.connId : null, db: d.db, file: d.file, dirty: d.dirty });
  }
  if (saved.active && st().docs.some((d) => d.id === saved!.active)) st().set({ activeDoc: saved.active });
}
