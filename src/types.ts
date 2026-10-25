export type SshAuth = 'password' | 'key' | 'agent';

export interface ConnDef {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  database?: string;
  socket?: string;
  ssl?: boolean;
  sslVerify?: boolean;
  sslCa?: string;
  savePassword: boolean;
  color?: string;
  ssh?: { enabled: boolean; host: string; port: number; user: string; auth: SshAuth; keyFile?: string };
}

export interface Secrets {
  password?: string;
  sshPassword?: string;
  passphrase?: string;
}

export interface ServerInfo {
  version: string;
  user: string;
  comment?: string;
}

export interface ConnState {
  status: 'closed' | 'connecting' | 'open' | 'error';
  info?: ServerInfo;
  error?: string;
}

export interface Column {
  name: string;
  table: string;
  orgTable: string;
  orgName: string;
  db: string;
  type: string;
  length: number;
  scale: number;
  binary: boolean;
  notNull: boolean;
  autoIncrement: boolean;
}

export type Cell = string | number | null;

export interface ResultSet {
  columns: Column[];
  rows: Cell[][];
  total: number;
  truncated: boolean;
}

export interface SqlError {
  message: string;
  code?: string;
  errno?: number;
  sqlState?: string;
  fatal: boolean;
}

export interface StmtResult {
  sql: string;
  start: number;
  end: number;
  sets: ResultSet[];
  affectedRows: number | null;
  insertId: number | null;
  warnings: { level: string; code: number; message: string }[];
  ms: number;
  error: SqlError | null;
}

export interface ExecResult {
  results: StmtResult[];
  db: string | null;
  cancelled: boolean;
}

export type ExecMode = 'all' | 'selection' | 'current' | 'explain';

export interface Message {
  at: string;
  level: 'info' | 'ok' | 'warning' | 'error';
  text: string;
  sql?: string;
  offset?: number;
}

export interface HistoryEntry {
  id: string;
  at: string;
  connId: string | null;
  conn: string;
  db: string | null;
  sql: string;
  truncated?: boolean;
  ms: number | null;
  rows: number | null;
  affected: number | null;
  error: string | null;
}

export interface Snippet { id: string; prefix: string; name: string; body: string }

export type EditableKind = 'view' | 'procedure' | 'function' | 'trigger' | 'event';

export interface TableStat {
  name: string; engine: string | null; rowFormat: string | null; rows: number | null; data: number | null; idx: number | null; free: number | null;
  autoInc: number | null; collation: string | null; created: string | null; updated: string | null; checked: string | null; comment: string;
}

export type MaintOp = 'analyze' | 'optimize' | 'check' | 'repair' | 'checksum';
export interface MaintResult { table: string; op: string; type: string; text: string; ms: number }

export interface Doc {
  id: string;
  kind: 'sql' | 'table' | 'er' | 'query' | 'compare' | 'monitor' | 'users' | 'history' | 'maint' | 'procs' | 'perf' | 'datagen' | 'docgen' | 'search' | 'logs';
  search?: { text: string; db: string | null }; // database search: last text and scope (null = every database)
  perf?: { tab?: string; sql?: string; db?: string | null };
  datagen?: import('./datagen').GenSettings; // test data generator: tables, row counts, column generators // performance center: tab to show, query to analyze
  obj?: { kind: EditableKind; name: string | null }; // SQL document editing a view/routine/trigger/event (name null = new)
  maint?: { tables: string[] }; // table maintenance: tables preselected when opened
  qb?: import('./qb').QbModel;
  cmp?: { src: { connId: string | null; db: string | null }; tgt: { connId: string | null; db: string | null } };
  design?: { table: string | null }; // table designer: existing table or null for a new one
  title: string;
  connId: string | null;
  db: string | null;
  sessionId: string | null;
  file: string | null;
  dirty: boolean;
  running: boolean;
  startedAt?: number;
  run: { results: StmtResult[]; explain: boolean; ms: number; profile?: import('./profile').Profile } | null;
  messages: Message[];
  view: number | 'messages' | 'profile';
}

export interface DbObjects {
  tables: { name: string; engine: string | null; rows: number | null; comment: string; system: boolean }[];
  views: { name: string }[];
  procedures: { name: string }[];
  functions: { name: string }[];
  triggers: { name: string; table: string; timing: string; event: string }[];
  events: { name: string; status: string }[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  key: string;
  def: string | null;
  extra: string;
  comment: string;
}

export interface IndexInfo {
  name: string;
  unique: boolean;
  primary: boolean;
  type: string;
  columns: string[];
}

export interface ForeignKeyInfo {
  name: string;
  refDb: string;
  refTable: string;
  onUpdate: string;
  onDelete: string;
  columns: string[];
  refColumns: string[];
}

export interface Schema {
  tables: Record<string, { kind: 'table' | 'view'; columns: { name: string; type: string }[] }>;
  routines: { name: string; type: 'procedure' | 'function' }[];
}

export type ObjectKind = 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'event';

export interface ServerOptions {
  engines: string[];
  defaultEngine: string;
  collations: { name: string; charset: string; isDefault: boolean }[];
  defaultCollation: string;
}

export type ExportFormat = 'csv' | 'json' | 'sql' | 'xlsx';

export interface ExportOptions {
  delimiter?: string;
  header?: boolean;
  nullAs?: string;
  bom?: boolean;
  table?: string;
  db?: string;
  batch?: number;
  sheet?: string;
}

export interface ApplyStmt {
  sql: string;
  params: Cell[];
  expectOne?: boolean;
}
