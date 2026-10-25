// Monaco setup: one text model per SQL document, schema-aware completion, error markers.
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { language as mysql } from 'monaco-editor/languages/definitions/mysql/mysql';
import { api } from './api';
import { DEFAULT_FORMAT, formatSql, type FormatOptions } from './format';
import { loadDatabases, loadSchema, useStore } from './store';
import type { Schema, Snippet, StmtResult } from './types';
import { t } from './i18n.ts';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

export { monaco };

const models = new Map<string, monaco.editor.ITextModel>();
const savedVersion = new Map<string, number>(); // alternative version id at the last save/open (-1: unsaved)

export function modelOf(docId: string, initial = '', dirty = false) {
  let m = models.get(docId);
  if (!m) {
    m = monaco.editor.createModel(initial, 'mysql');
    models.set(docId, m);
    savedVersion.set(docId, dirty ? -1 : m.getAlternativeVersionId());
  }
  return m;
}

export function disposeModel(docId: string) {
  models.get(docId)?.dispose();
  models.delete(docId);
  savedVersion.delete(docId);
}

/** Dirty by version, so undoing back to the saved text makes the document clean again. */
export const isDirty = (docId: string) => !!models.get(docId) && models.get(docId)!.getAlternativeVersionId() !== savedVersion.get(docId);
export const markSaved = (docId: string) => { const m = models.get(docId); if (m) savedVersion.set(docId, m.getAlternativeVersionId()); };

export const docOfModel = (model: monaco.editor.ITextModel) => [...models].find(([, m]) => m === model)?.[0];

monaco.editor.defineTheme('mibsql', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '0000ff' },
    { token: 'predefined', foreground: 'c71585' },
    { token: 'string', foreground: 'a31515' },
    { token: 'number', foreground: '098658' },
    { token: 'comment', foreground: '008000', fontStyle: 'italic' },
    { token: 'identifier.quote', foreground: '795e26' },
  ],
  colors: { 'editor.lineHighlightBackground': '#f3f7ff' },
});

monaco.editor.defineTheme('mibsql-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword', foreground: '569cd6' },
    { token: 'predefined', foreground: 'dcdcaa' },
    { token: 'string', foreground: 'ce9178' },
    { token: 'number', foreground: 'b5cea8' },
    { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
    { token: 'identifier.quote', foreground: 'd7ba7d' },
  ],
  colors: { 'editor.background': '#1e2228', 'editor.lineHighlightBackground': '#262b33', 'editorGutter.background': '#1e2228' },
});

// ---- Completion ----

const KEYWORDS = [...new Set(mysql.keywords.map((k) => k.toUpperCase()))];
const FUNCTIONS = [...new Set(mysql.builtinFunctions.map((k) => k.toUpperCase()))];
const RESERVED = new Set(KEYWORDS);
const FUNCTION_SET = new Set(FUNCTIONS);
const NOT_ALIAS = new Set(['WHERE', 'ON', 'USING', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'SET',
  'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'VALUES', 'VALUE', 'SELECT', 'UNION', 'WINDOW', 'FOR', 'LOCK', 'PARTITION', 'USE', 'FORCE', 'IGNORE', 'AS']);

const unquote = (s: string) => (s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s);
const quote = (s: string) => (/^[A-Za-z_][\w$]*$/.test(s) && !RESERVED.has(s.toUpperCase()) ? s : '`' + s.replace(/`/g, '``') + '`');

const NAME = '(`(?:[^`]|``)+`|[\\w$]+)';

/** Tables referenced by a statement (FROM/JOIN/UPDATE/INTO and comma lists) with their aliases. */
export function tableRefs(sql: string, defaultDb: string | null) {
  const re = new RegExp(`(?:\\b(?:from|join|update|into|table)|,)\\s+${NAME}(?:\\s*\\.\\s*${NAME})?(?:\\s+(?:as\\s+)?${NAME})?`, 'gi');
  const refs: { db: string | null; table: string; alias: string | null }[] = [];
  for (const m of sql.matchAll(re)) {
    const [db, table] = m[2] ? [unquote(m[1]), unquote(m[2])] : [defaultDb, unquote(m[1])];
    const alias = m[3] && !NOT_ALIAS.has(m[3].toUpperCase()) ? unquote(m[3]) : null;
    refs.push({ db, table, alias });
  }
  return refs;
}

async function statementBefore(text: string, offset: number) {
  const stmts = await api.split(text);
  let start = 0;
  for (const s of stmts) if (s.start <= offset) start = s.start;
  const last = stmts.filter((s) => s.start <= offset).pop();
  // cursor after a delimiter that ends the last statement: a new empty statement starts there
  if (last && last.end < offset && /;|\$\$/.test(text.slice(last.end, offset))) start = offset;
  const end = stmts.find((s) => s.start === start)?.end ?? offset;
  return { before: text.slice(start, offset), whole: text.slice(start, Math.max(end, offset)) };
}

const K = monaco.languages.CompletionItemKind;

// ---- Snippets: offered by prefix in the completion list, Tab expands them ----

let snippets: Snippet[] = [];
export const setSnippets = (list: Snippet[]) => { snippets = list; };
export const loadSnippets = async () => { snippets = (await api.snippets.list()).list; return snippets; };
/** Snippet body as plain text: placeholders shown with their default. */
export const snippetPreview = (body: string) => body
  .replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\|([^,|]*)[^}]*\|\}/g, '$1').replace(/\$\d+/g, '').replace(/\\\$/g, '$');

monaco.languages.registerCompletionItemProvider('mysql', {
  triggerCharacters: ['.'],
  async provideCompletionItems(model, position) {
    const docId = docOfModel(model);
    const doc = useStore.getState().docs.find((d) => d.id === docId);
    const word = model.getWordUntilPosition(position);
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
    const items: monaco.languages.CompletionItem[] = [];
    const add = (label: string, kind: monaco.languages.CompletionItemKind, sort: string, detail?: string, insert = label) =>
      items.push({ label, kind, detail, insertText: insert, range, sortText: sort + label.toLowerCase() });

    const open = doc?.connId && useStore.getState().connState[doc.connId]?.status === 'open';
    const { before, whole } = await statementBefore(model.getValue(), model.getOffsetAt(position));
    const connId = doc?.connId ?? '';
    const schemaOf = async (db: string | null): Promise<Schema | undefined> => (open && db ? loadSchema(connId, db) : undefined);
    const refs = tableRefs(whole, doc?.db ?? null);

    const qual = new RegExp(`${NAME}\\s*\\.\\s*\`?[\\w$]*$`).exec(before);
    if (qual) {
      const q = unquote(qual[1]);
      const ref = refs.find((r) => r.alias?.toLowerCase() === q.toLowerCase()) ?? refs.find((r) => r.table.toLowerCase() === q.toLowerCase());
      const own = await schemaOf(ref?.db ?? doc?.db ?? null);
      const table = own?.tables[ref?.table ?? q];
      if (table) {
        table.columns.forEach((c, i) => add(c.name, K.Field, '0' + String(i).padStart(4, '0'), c.type, quote(c.name)));
        return { suggestions: items };
      }
      const dbs = open ? (await loadDatabases(connId)) ?? [] : [];
      const db = dbs.find((d) => d.toLowerCase() === q.toLowerCase());
      if (db) {
        const s = await schemaOf(db);
        for (const [name, t] of Object.entries(s?.tables ?? {})) add(name, t.kind === 'view' ? K.Interface : K.Struct, '0', t.kind, quote(name));
        for (const r of s?.routines ?? []) add(r.name, K.Function, '1', r.type, quote(r.name));
      }
      return { suggestions: items };
    }

    const afterTableKeyword = /\b(from|join|update|into|table|describe|desc|truncate)\s+[\w$`]*$/i.test(before) || /\bfrom\s+[^;]*,\s*[\w$`]*$/i.test(before) && !/\bwhere\b/i.test(before.slice(before.search(/\bfrom\b/i)));
    const current = await schemaOf(doc?.db ?? null);
    if (!afterTableKeyword) {
      for (const ref of refs) {
        const s = ref.db === doc?.db ? current : await schemaOf(ref.db);
        (s?.tables[ref.table]?.columns ?? []).forEach((c, i) => add(c.name, K.Field, '0' + String(i).padStart(4, '0'), `${ref.alias ?? ref.table} · ${c.type}`, quote(c.name)));
      }
    }
    for (const [name, t] of Object.entries(current?.tables ?? {})) add(name, t.kind === 'view' ? K.Interface : K.Struct, afterTableKeyword ? '0' : '1', t.kind, quote(name));
    for (const r of current?.routines ?? []) add(r.name, K.Function, '2', r.type, quote(r.name));
    if (open) for (const d of (await loadDatabases(connId)) ?? []) add(d, K.Module, '3', 'database', quote(d));
    if (!afterTableKeyword) {
      for (const sn of snippets) {
        items.push({
          label: { label: sn.prefix, description: sn.name }, kind: K.Snippet, detail: sn.name, range, sortText: '00' + sn.prefix,
          insertText: sn.body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          documentation: { value: '```sql\n' + snippetPreview(sn.body) + '\n```' },
        });
      }
      for (const k of KEYWORDS) add(k, K.Keyword, '4');
      for (const f of FUNCTIONS) add(f, K.Function, '5', 'funzione', `${f}($0)`);
      items.forEach((i) => { if (i.kind === K.Function && i.sortText?.startsWith('5')) i.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet; });
    }
    return { suggestions: items };
  },
});

// ---- Formatting (Ctrl+Maiusc+F, Maiusc+Alt+F, context menu) ----

const FORMAT_KEY = 'mibsql.format';
export function formatOptions(): FormatOptions {
  try { return { ...DEFAULT_FORMAT, ...JSON.parse(localStorage.getItem(FORMAT_KEY) ?? '{}') }; } catch { return DEFAULT_FORMAT; }
}
export function setFormatOptions(patch: Partial<FormatOptions>) {
  try { localStorage.setItem(FORMAT_KEY, JSON.stringify({ ...formatOptions(), ...patch })); } catch { /* storage unavailable */ }
}
export const formatText = (text: string) => formatSql(text, formatOptions(), FUNCTION_SET);

monaco.languages.registerDocumentFormattingEditProvider('mysql', {
  provideDocumentFormattingEdits: (model) => [{ range: model.getFullModelRange(), text: formatText(model.getValue()) }],
});
monaco.languages.registerDocumentRangeFormattingEditProvider('mysql', {
  provideDocumentRangeFormattingEdits: (model, range) => [{ range, text: formatText(model.getValueInRange(range)) }],
});

// ---- Error markers ----

/** Marks failed statements; MariaDB's "at line N" is relative to the statement. */
export function markErrors(model: monaco.editor.ITextModel, results: StmtResult[]) {
  const markers: monaco.editor.IMarkerData[] = [];
  for (const r of results) {
    if (!r.error) continue;
    const a = model.getPositionAt(r.start);
    const b = model.getPositionAt(r.end);
    const line = /at line (\d+)/.exec(r.error.message);
    const ln = line ? Math.min(a.lineNumber + Number(line[1]) - 1, b.lineNumber) : null;
    markers.push({
      severity: monaco.MarkerSeverity.Error,
      message: r.error.message,
      startLineNumber: ln ?? a.lineNumber,
      startColumn: ln && ln !== a.lineNumber ? 1 : a.column,
      endLineNumber: ln ?? b.lineNumber,
      endColumn: ln ? model.getLineMaxColumn(ln) : b.column,
    });
  }
  monaco.editor.setModelMarkers(model, 'mibsql', markers);
}

export const clearMarkers = (model: monaco.editor.ITextModel) => monaco.editor.setModelMarkers(model, 'mibsql', []);
