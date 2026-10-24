import { create } from 'zustand';
import { api } from './api';
import type { TableDef } from './design';
import type { Edits } from './edits';
import type { Cell, Column, ConnDef, ConnState, Doc, ResultSet, Secrets, ServerInfo } from './types';

export interface MetaEntry<T = unknown> {
  data?: T;
  loading?: boolean;
  error?: string;
}

/** Table designer state per document: server definition (null = not created yet) and the edited one. */
export const designByDoc = new Map<string, { orig: TableDef | null; cur: TableDef }>();

/** Pending grid edits per result set: survive tab switches, dropped with the set (re-run, close). */
export const editsBySet = new WeakMap<ResultSet, Edits>();

export interface ExportRequest {
  columns?: Column[];
  rows?: Cell[][];
  name: string;
  table: string;
  db: string | null;
  query?: { connId: string; db: string | null; sql: string };
  total?: number;
  truncated?: boolean;
  filtered?: boolean;
}

interface PasswordRequest {
  conn: ConnDef;
  error: string;
  resolve: (s: { secrets: Secrets; remember: boolean } | null) => void;
}

interface State {
  conns: ConnDef[];
  keyring: boolean;
  connState: Record<string, ConnState>;
  meta: Record<string, MetaEntry>;
  docs: Doc[];
  activeDoc: string | null;
  selectedConn: string | null;
  connDialog: { def: Partial<ConnDef> } | null;
  passwordPrompt: PasswordRequest | null;
  exportDialog: ExportRequest | null;
  task: { kind: 'backup' | 'restore' | 'import'; connId: string; db: string | null; table?: string } | null;
  viewer: { title: string; value: string; isNull?: boolean; binary?: boolean; onSave?: (v: string | null) => void } | null;

  loadConns(): Promise<void>;
  openConn(id: string): Promise<ServerInfo | null>;
  closeConn(id: string): Promise<void>;
  loadMeta<T>(key: string, fetch: () => Promise<T>, force?: boolean): Promise<T | undefined>;
  dropMeta(prefix: string): void;
  addDoc(doc: Partial<Doc>): Doc;
  updateDoc(id: string, patch: Partial<Doc> | ((d: Doc) => Partial<Doc>)): void;
  removeDoc(id: string): void;
  set(patch: Partial<State>): void;
}

let untitled = 0;
export const nextTitle = () => `SQL${++untitled}.sql`;
export const setUntitled = (n: number) => { untitled = Math.max(untitled, n); };

const ACCESS_DENIED = /ER_ACCESS_DENIED|authentication|Access denied/i;

export const useStore = create<State>((set, get) => ({
  conns: [],
  keyring: true,
  connState: {},
  meta: {},
  docs: [],
  activeDoc: null,
  selectedConn: null,
  connDialog: null,
  passwordPrompt: null,
  exportDialog: null,
  task: null,
  viewer: null,

  async loadConns() {
    const { list, keyring } = await api.conn.list();
    set({ conns: list, keyring });
  },

  /** Opens a connection; on authentication errors asks for the password and retries. */
  async openConn(id) {
    const state = (s: ConnState) => set((st) => ({ connState: { ...st.connState, [id]: s } }));
    let secrets: Secrets | undefined;
    for (;;) {
      state({ status: 'connecting' });
      try {
        const info = await api.conn.open(id, secrets);
        state({ status: 'open', info });
        return info;
      } catch (err) {
        const msg = (err as Error).message;
        const conn = get().conns.find((c) => c.id === id);
        if (!conn || !ACCESS_DENIED.test(`${(err as { code?: string }).code ?? ''} ${msg}`)) {
          state({ status: 'error', error: msg });
          return null;
        }
        const answer = await new Promise<{ secrets: Secrets; remember: boolean } | null>((resolve) =>
          set({ passwordPrompt: { conn, error: secrets ? msg : '', resolve } }));
        set({ passwordPrompt: null });
        if (!answer) { state({ status: 'closed' }); return null; }
        if (answer.remember !== conn.savePassword) {
          const saved = await api.conn.save({ ...conn, savePassword: answer.remember }, {});
          set((st) => ({ conns: st.conns.map((c) => (c.id === id ? saved : c)) }));
        }
        secrets = answer.secrets;
      }
    }
  },

  async closeConn(id) {
    await api.conn.close(id);
    get().dropMeta(`${id}/`);
    set((st) => ({
      connState: { ...st.connState, [id]: { status: 'closed' } },
      docs: st.docs.map((d) => (d.connId === id ? { ...d, sessionId: null } : d)),
    }));
  },

  /** Cached metadata: concurrent callers share one request, errors are kept for the explorer to show. */
  async loadMeta<T>(key: string, fetch: () => Promise<T>, force = false) {
    const cur = get().meta[key];
    if (!force && cur && (cur.data !== undefined || cur.loading)) {
      if (cur.data !== undefined) return cur.data as T;
      return pending.get(key) as Promise<T>;
    }
    set((st) => ({ meta: { ...st.meta, [key]: { ...cur, loading: true, error: undefined } } }));
    const p = fetch()
      .then((data) => {
        set((st) => ({ meta: { ...st.meta, [key]: { data } } }));
        return data;
      })
      .catch((err) => {
        set((st) => ({ meta: { ...st.meta, [key]: { error: (err as Error).message } } }));
        return undefined;
      })
      .finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  },

  dropMeta(prefix) {
    set((st) => ({ meta: Object.fromEntries(Object.entries(st.meta).filter(([k]) => !k.startsWith(prefix))) }));
  },

  addDoc(partial) {
    const doc: Doc = {
      id: crypto.randomUUID(),
      kind: 'sql',
      title: partial.title ?? nextTitle(),
      connId: null,
      db: null,
      sessionId: null,
      file: null,
      dirty: false,
      running: false,
      run: null,
      messages: [],
      view: 'messages',
      ...partial,
    };
    set((st) => ({ docs: [...st.docs, doc], activeDoc: doc.id }));
    return doc;
  },

  updateDoc(id, patch) {
    set((st) => ({ docs: st.docs.map((d) => (d.id === id ? { ...d, ...(typeof patch === 'function' ? patch(d) : patch) } : d)) }));
  },

  removeDoc(id) {
    set((st) => {
      const at = st.docs.findIndex((d) => d.id === id);
      const docs = st.docs.filter((d) => d.id !== id);
      const activeDoc = st.activeDoc === id ? (docs[Math.min(at, docs.length - 1)]?.id ?? null) : st.activeDoc;
      return { docs, activeDoc };
    });
  },

  set(patch) { set(patch); },
}));

const pending = new Map<string, Promise<unknown>>();

export const metaKey = {
  databases: (c: string) => `${c}/databases`,
  objects: (c: string, db: string) => `${c}/${db}/objects`,
  columns: (c: string, db: string, t: string) => `${c}/${db}/t/${t}/columns`,
  indexes: (c: string, db: string, t: string) => `${c}/${db}/t/${t}/indexes`,
  foreignKeys: (c: string, db: string, t: string) => `${c}/${db}/t/${t}/fks`,
  schema: (c: string, db: string) => `${c}/${db}/schema`,
};

export const loadDatabases = (connId: string, force = false) =>
  useStore.getState().loadMeta(metaKey.databases(connId), () => api.meta.databases(connId), force);

export const loadSchema = (connId: string, db: string) =>
  useStore.getState().loadMeta(metaKey.schema(connId, db), () => api.meta.schema(connId, db));

export const connName = (id: string | null) => useStore.getState().conns.find((c) => c.id === id)?.name ?? '';
