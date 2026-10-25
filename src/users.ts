import { t } from './i18n.ts';
// Users and privileges: parse SHOW GRANTS, edit privileges per level, produce GRANT/REVOKE. Pure, for tests.

export interface Level {
  on: string;           // *.*, `db`.*, `db`.`table`, PROCEDURE `db`.`p`
  privs: string[];      // upper case; ALL PRIVILEGES is one token
  grantOption: boolean;
}

export interface Grants { levels: Level[]; roles: string[]; other: string[] }

export const PRIV_GROUPS: { label: string; privs: string[]; global?: boolean }[] = [
  { label: t('Dati'), privs: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] },
  { label: t('Struttura'), privs: ['CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER'] },
  { label: t('Routine ed eventi'), privs: ['CREATE ROUTINE', 'ALTER ROUTINE', 'EXECUTE', 'EVENT'] },
  { label: t('Altro'), privs: ['LOCK TABLES', 'CREATE TEMPORARY TABLES'] },
  { label: t('Amministrazione'), global: true, privs: ['PROCESS', 'RELOAD', 'SHUTDOWN', 'FILE', 'SHOW DATABASES', 'CREATE USER', 'REPLICATION CLIENT', 'REPLICATION SLAVE', 'SUPER'] },
];
const TABLE_PRIVS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP', 'INDEX', 'REFERENCES', 'CREATE VIEW', 'SHOW VIEW', 'TRIGGER']);

export type LevelKind = 'global' | 'database' | 'table' | 'routine';
export function levelKind(on: string): LevelKind {
  if (/^(PROCEDURE|FUNCTION)\s/i.test(on)) return 'routine';
  if (on === '*.*') return 'global';
  if (/\.\*$/.test(on)) return 'database';
  return 'table';
}

/** Privileges that make sense at a level (the checkboxes offered). */
export function privilegesFor(kind: LevelKind): string[] {
  const all = PRIV_GROUPS.flatMap((g) => (g.global && kind !== 'global' ? [] : g.privs));
  if (kind === 'table') return all.filter((p) => TABLE_PRIVS.has(p));
  if (kind === 'routine') return ['EXECUTE', 'ALTER ROUTINE'];
  return all;
}

/** Splits a privilege list on commas outside parentheses (column privileges keep their list). */
function splitPrivs(s: string) {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((p) => (/\(/.test(p) ? p : p.toUpperCase().replace(/\s+/g, ' ')));
}

const GRANT = /^GRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(?:'[^']*'|`[^`]*`|\S+)@(?:'[^']*'|`[^`]*`|\S+)(.*)$/i;

export function parseGrants(lines: string[]): Grants {
  const levels = new Map<string, Level>();
  const roles: string[] = [];
  const other: string[] = [];
  for (const line of lines) {
    const m = GRANT.exec(line.trim());
    if (!m) {
      const role = /^GRANT\s+(`[^`]+`|'[^']+'|\S+)\s+TO\s+/i.exec(line.trim());
      if (role) roles.push(role[1].replace(/^[`']|[`']$/g, ''));
      else other.push(line);
      continue;
    }
    const on = m[2].trim();
    const privs = splitPrivs(m[1]).filter((p) => p !== 'USAGE');
    const lv = levels.get(on) ?? { on, privs: [], grantOption: false };
    lv.privs = [...new Set([...lv.privs, ...privs])];
    if (/WITH\s+GRANT\s+OPTION/i.test(m[3])) lv.grantOption = true;
    levels.set(on, lv);
  }
  return { levels: [...levels.values()], roles, other };
}

/** 'user'@'host' with MariaDB string escapes. */
export const account = (user: string, host: string) => `${lit(user)}@${lit(host)}`;
export const lit = (s: string) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

/** GRANT/REVOKE turning `before` into `after` for one account. */
export function grantStatements(acct: string, before: Level[], after: Level[]): string[] {
  const out: string[] = [];
  const old = new Map(before.map((l) => [l.on, l]));
  const now = new Map(after.map((l) => [l.on, l]));
  for (const on of new Set([...old.keys(), ...now.keys()])) {
    const a = old.get(on) ?? { on, privs: [], grantOption: false };
    const b = now.get(on) ?? { on, privs: [], grantOption: false };
    const removed = a.privs.filter((p) => !b.privs.includes(p));
    const added = b.privs.filter((p) => !a.privs.includes(p));
    if (removed.length) out.push(`REVOKE ${removed.join(', ')} ON ${on} FROM ${acct}`);
    if (a.grantOption && !b.grantOption) out.push(`REVOKE GRANT OPTION ON ${on} FROM ${acct}`);
    if (added.length || (!a.grantOption && b.grantOption)) {
      out.push(`GRANT ${added.length ? added.join(', ') : 'USAGE'} ON ${on} TO ${acct}${b.grantOption && !a.grantOption ? ' WITH GRANT OPTION' : ''}`);
    }
  }
  return out;
}

/** Hides passwords in statements shown on screen. */
export const maskPasswords = (sql: string) => sql.replace(/(IDENTIFIED BY |PASSWORD\s*\(\s*|SET PASSWORD FOR .+? = PASSWORD\s*\(\s*)'(?:[^'\\]|\\.)*'/gi, "$1'••••••'");

export function createUser(user: string, host: string, password: string) {
  return `CREATE USER ${account(user, host)}${password ? ` IDENTIFIED BY ${lit(password)}` : ''}`;
}

export function setPassword(user: string, host: string, password: string) {
  return `ALTER USER ${account(user, host)} IDENTIFIED BY ${lit(password)}`;
}

export const dropUser = (user: string, host: string) => `DROP USER ${account(user, host)}`;
