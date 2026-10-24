import type { ServerTable } from './design';
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
  };
  sess: {
    open(connId: string, db: string | null): Promise<{ id: string; db: string | null }>;
    close(sid: string): Promise<void>;
    use(sid: string, db: string): Promise<string>;
    exec(sid: string, text: string, opts: { mode: ExecMode; cursor?: number; selStart?: number; selEnd?: number; continueOnError?: boolean }): Promise<ExecResult>;
    cancel(sid: string): Promise<boolean>;
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
  ddl: { run(connId: string, sqls: string[]): Promise<number> };
  file: {
    open(): Promise<SqlFile[]>;
    save(content: string, path: string | null, suggested?: string): Promise<string | null>;
    onOpenArg(cb: (f: SqlFile) => void): void;
  };
  confirm(message: string, detail: string, buttons: string[]): Promise<number>;
  setTitle(t: string): void;
}

declare global {
  interface Window { api: Api }
}

export const api = window.api;
