import type { ServerTable } from './design';
import type { ErModel } from './er';
import type { Snapshot } from './compare';
import type { Snapshot as MonitorSnapshot } from './monitor';
import type { Profile } from './profile';
import type {
  ServerOptions, ApplyStmt, Cell, Column, ExportFormat, ExportOptions, ColumnInfo, ConnDef, DbObjects, ExecMode, ExecResult, ForeignKeyInfo, IndexInfo, ObjectKind, Schema, Secrets, ServerInfo,
} from './types';

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
