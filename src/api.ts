import type { ServerTable } from './design';
import type { ErModel } from './er';
import type { Snapshot } from './compare';
import type { Snapshot as MonitorSnapshot } from './monitor';
import type { Profile } from './profile';
import type { ProcSnapshot } from './procs';
import type { Overview } from './advisor';
import type { IndexData } from './indexes';
import type { PlanRow, SlowRow, TopRow } from './queryadvisor';
import type { DataHit, ObjectHit } from './search';
import type { ErrorEntry } from './logs';
import type {
  EditableKind, HistoryEntry, MaintOp, MaintResult, Snippet, TableStat, ServerOptions, ApplyStmt, Cell, Column, ExportFormat, ExportOptions, ColumnInfo, ConnDef, DbObjects, ExecMode, ExecResult, ForeignKeyInfo, IndexInfo, ObjectKind, Schema, Secrets, ServerInfo,
} from './types';

export interface UpdateInfo { current: string; latest: string; newer: boolean; notes: string; url: string; published: string | null; mode: 'appimage' | 'deb' | 'manual'; asset: { name: string; url: string; size: number } | null }

export type LogStatus = Record<string, string | null> & { local: boolean; mariadb: boolean };

/** Microsoft Entra sign-in in progress: browser opened, device code to type, or finished. */
export type EntraPrompt =
  | { kind: 'browser'; connId: string; name: string }
  | { kind: 'device'; connId: string; name: string; url: string; code: string; message: string }
  | { kind: 'done'; connId: string };

export interface SqlFile {
  path: string;
  content: string;
}

interface Api {
  conn: {
    list(): Promise<{ list: ConnDef[]; keyring: boolean }>;
    save(def: Omit<ConnDef, 'id'> & { id?: string }, secrets: Secrets): Promise<ConnDef>;
    remove(id: string): Promise<void>;
    test(def: Partial<ConnDef>, secrets: Secrets): Promise<ServerInfo>;
    open(id: string, secrets?: Secrets): Promise<ServerInfo>;
    close(id: string): Promise<void>;
  };
  entra: {
    account(id: string): Promise<{ username: string; name: string } | null>;
    signOut(id: string): Promise<boolean>;
    openUrl(url: string): Promise<void>;
    onPrompt(fn: (p: EntraPrompt) => void): () => void;
  };
  meta: {
    databases(id: string): Promise<string[]>;
    objects(id: string, db: string): Promise<DbObjects>;
    columns(id: string, db: string, table: string): Promise<ColumnInfo[]>;
    indexes(id: string, db: string, table: string): Promise<IndexInfo[]>;
    foreignKeys(id: string, db: string, table: string): Promise<ForeignKeyInfo[]>;
    ddl(id: string, db: string, kind: ObjectKind, name: string): Promise<string>;
    schema(id: string, db: string): Promise<Schema>;
    tableDefinition(id: string, db: string, table: string): Promise<ServerTable>;
    serverOptions(id: string, db: string): Promise<ServerOptions>;
    erModel(id: string, db: string): Promise<ErModel>;
    schemaSnapshot(id: string, db: string): Promise<Snapshot>;
    users(id: string): Promise<{ limited: boolean; users: { user: string; host: string; role: boolean }[] }>;
    grants(id: string, user: string, host: string): Promise<string[]>;
  };
  sess: {
    open(connId: string, db: string | null): Promise<{ id: string; db: string | null }>;
    close(sid: string): Promise<void>;
    use(sid: string, db: string): Promise<string>;
    exec(sid: string, text: string, opts: { mode: ExecMode; cursor?: number; selStart?: number; selEnd?: number; continueOnError?: boolean }): Promise<ExecResult>;
    cancel(sid: string): Promise<boolean>;
    profile(sid: string, text: string, cursor: number): Promise<Profile & { sets: import('./types').ResultSet[] }>;
  };
  split(text: string): Promise<{ sql: string; start: number; end: number }[]>;
  data: {
    apply(connId: string, stmts: ApplyStmt[]): Promise<{ affectedRows: number; insertId: string | null }[]>;
    select(connId: string, sql: string, params: Cell[]): Promise<Cell[][]>;
  };
  exp: {
    rows(format: ExportFormat, opts: ExportOptions, columns: Column[], rows: Cell[][], suggested: string): Promise<{ file: string; rows: number } | null>;
    query(connId: string, db: string | null, sql: string, format: ExportFormat, opts: ExportOptions, suggested: string): Promise<{ file: string; rows: number } | null>;
    onProgress(cb: (p: { file: string; rows: number }) => void): () => void;
  };
  showItem(file: string): Promise<void>;
  pickFile(kind: 'sql' | 'data'): Promise<string | null>;
  ai: {
    settings(): Promise<{ source: 'key' | 'env' | 'system'; model: string; effort: string; consent: boolean; models: string[]; efforts: string[]; keyring: boolean }>;
    saveSettings(s: { model?: string; effort?: string; key?: string | null; consent?: boolean }): Promise<{ source: 'key' | 'env' | 'system'; model: string; effort: string; consent: boolean; models: string[]; efforts: string[]; keyring: boolean }>;
    chat(id: string, req: { system: unknown; messages: unknown[] }): Promise<{ content: unknown; stopReason: string | null; stopDetails: { category?: string | null } | null; model: string; usage: unknown }>;
    cancel(id: string): Promise<void>;
    onDelta(cb: (p: { id: string; text: string }) => void): () => void;
  };
  history: {
    add(list: Omit<HistoryEntry, 'id' | 'truncated'>[]): Promise<number>;
    list(opts: { q?: string; connId?: string | null; status?: 'all' | 'ok' | 'error'; limit?: number }): Promise<{ entries: HistoryEntry[]; total: number; all: number }>;
    remove(ids: string[]): Promise<void>;
    clear(): Promise<void>;
  };
  snippets: {
    list(): Promise<{ list: Snippet[]; custom: boolean }>;
    save(list: Snippet[] | null): Promise<{ list: Snippet[]; custom: boolean }>;
  };
  objects: {
    apply(connId: string, db: string, kind: EditableKind, orig: string | null, text: string): Promise<{ name: string; created: boolean; renamed: boolean; method: 'create' | 'replace' | 'drop-create'; grants?: { unreadable: boolean; restored: number; failed: string[] } }>;
    params(connId: string, db: string, kind: 'procedure' | 'function', name: string): Promise<{ params: { mode: string; name: string; type: string }[]; returns: string | null }>;
    currentUser(connId: string): Promise<string>;
  };
  maint: {
    stats(connId: string, db: string): Promise<TableStat[]>;
    run(id: string, connId: string, db: string, tables: string[], op: MaintOp, opts: { option?: string; local?: boolean }): Promise<{ results: MaintResult[]; stopped: boolean }>;
    stop(id: string): Promise<void>;
  };
  procs: {
    snapshot(connId: string): Promise<ProcSnapshot>;
    explainFor(connId: string, id: number, flavor: 'mariadb' | 'mysql'): Promise<{ columns: string[]; rows: (string | null)[][] }>;
    kill(connId: string, ids: number[], queryOnly: boolean): Promise<{ killed: number; failed: { id: number; message: string }[] }>;
    innodbStatus(connId: string): Promise<string>;
    installMdl(connId: string): Promise<void>;
  };
  perf: {
    overview(connId: string): Promise<Overview>;
    topQueries(connId: string, source: 'digest' | 'slowlog'): Promise<{
      sources: { ps: boolean; digest: boolean; slowTable: boolean; slowLog: boolean; logOutput: string; longQueryTime: number; flavor: 'mariadb' | 'mysql' };
      rows: TopRow[] | SlowRow[];
    }>;
    resetTop(connId: string, source: 'digest' | 'slowlog'): Promise<void>;
    enableSlowLog(connId: string, seconds: number): Promise<unknown>;
    indexData(connId: string, db: string): Promise<IndexData>;
    setVariable(connId: string, name: string, value: string, persist: boolean): Promise<string | null>;
    explain(connId: string, db: string, sql: string): Promise<PlanRow[]>;
  };
  datagen: {
    tables(connId: string, db: string): Promise<(ServerTable & { rows: number | null })[]>;
    values(connId: string, db: string, table: string, column: string, limit?: number): Promise<(string | number)[]>;
    tuples(connId: string, db: string, table: string, columns: string[]): Promise<string[]>;
    rowsOf(connId: string, db: string, table: string, columns: string[]): Promise<(string | number | null)[][]>;
    clear(connId: string, db: string, tables: string[], truncate: boolean): Promise<void>;
    counts(connId: string, db: string, tables: string[]): Promise<Record<string, number>>;
  };
  search: {
    objects(connId: string, dbs: string[], text: string, opts: { names: boolean; code: boolean; comments: boolean }): Promise<ObjectHit[]>;
    data(id: string, connId: string, dbs: string[], text: string, opts: { caseSensitive: boolean; exact: boolean; maxRows: number; skipAbove: number }): Promise<{ results: DataHit[]; stopped: boolean; tables: number }>;
    stop(id: string): Promise<void>;
  };
  logs: {
    status(connId: string): Promise<LogStatus>;
    error(connId: string): Promise<{ status: LogStatus; source: 'table' | 'file' | 'load_file' | 'journal' | null; path?: string | null; text?: string; entries?: ErrorEntry[]; truncated?: boolean; reason?: string }>;
    query(connId: string, which: 'slow' | 'general'): Promise<{ status: LogStatus; on: boolean; source: 'table' | 'file' | 'load_file' | null; path?: string | null; text?: string; rows?: Record<string, unknown>[]; truncated?: boolean; reason?: string }>;
    set(connId: string, which: 'slow' | 'general', on: boolean, toTable: boolean): Promise<LogStatus>;
    clear(connId: string, which: 'slow' | 'general'): Promise<void>;
  };
  copy: {
    target(connId: string, db: string): Promise<{ exists: boolean; tables: number }>;
    run(id: string, src: { connId: string; db: string }, tgt: { connId: string; db: string }, opts: { structure: boolean; data: boolean; routines: boolean; stripDefiner: boolean; tables?: string[]; ifExists: 'fail' | 'replace' | 'merge' }): Promise<{ statements: number; ms: number; created: boolean }>;
  };
  openRelease(url: string): Promise<void>;
  update: {
    check(): Promise<UpdateInfo>;
    install(): Promise<{ done: boolean; restart?: boolean; version?: string; reason?: 'current' | 'manual' | 'installer'; file?: string }>;
    restart(): Promise<void>;
  };
  setLang(lang: string): Promise<void>;
  monitor: { snapshot(connId: string): Promise<MonitorSnapshot>; kill(connId: string, id: number, queryOnly: boolean): Promise<void> };
  tasks: {
    dump(id: string, connId: string, db: string, opts: Record<string, unknown>): Promise<{ file: string; size: number } | null>;
    restore(id: string, connId: string, db: string | null, file: string, opts: { continueOnError: boolean }): Promise<{ statements: number; errors: { statement: number; message: string; sql: string }[] }>;
    importPreview(file: string, opts: Record<string, unknown>): Promise<{ format: string; delimiter?: string; sheets: string[]; columns: string[]; types: string[]; rows: Cell[][]; size: number }>;
    importRun(id: string, connId: string, file: string, opts: Record<string, unknown>): Promise<{ rows: number }>;
    onProgress(cb: (p: { id: string } & Record<string, number | string>) => void): () => void;
  };
  ddl: { run(connId: string, sqls: string[]): Promise<number> };
  compareData(src: { connId: string; db: string }, tgt: { connId: string; db: string }, table: string, key: string[], columns: string[]): Promise<{
    table: string; equal: number; diff: number; source: number; target: number;
    details: { status: 'diff' | 'source' | 'target'; row: Cell[]; old?: Cell[]; diff: number[] }[];
    statements: ApplyStmt[]; scriptTooLarge: boolean;
  }>;
  file: {
    open(): Promise<SqlFile[]>;
    save(content: string, path: string | null, suggested?: string): Promise<string | null>;
    onOpenArg(cb: (f: SqlFile) => void): void;
    readHex(): Promise<string | null>;
    writeHex(hex: string, suggested: string): Promise<string | null>;
    saveData(data: string, base64: boolean, suggested: string, filters: { name: string; extensions: string[] }[]): Promise<string | null>;
  };
  confirm(message: string, detail: string, buttons: string[]): Promise<number>;
  setTitle(t: string): void;
  onCloseRequest(cb: () => void): void;
  confirmClose(): void;
}

declare global {
  interface Window { api: Api }
}

export const api = window.api;
