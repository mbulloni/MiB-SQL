import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import {
  account, createUser, dropUser, grantStatements, levelKind, maskPasswords, parseGrants, PRIV_GROUPS, privilegesFor, setPassword, type Level,
} from '../users';
import { loadDatabases, metaKey, useStore, type MetaEntry } from '../store';
import type { DbObjects, Doc } from '../types';

type Acct = { user: string; host: string; role: boolean };
const label = (on: string) => (on === '*.*' ? 'Globali (*.*)' : on.replace(/`/g, ''));
const ALL = 'ALL PRIVILEGES';

export default function Users({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const dbs = useStore((s) => s.meta[metaKey.databases(connId)]) as MetaEntry<string[]> | undefined;
  const [list, setList] = useState<{ limited: boolean; users: Acct[] } | null>(null);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<Acct | null>(null);
  const [raw, setRaw] = useState<string[]>([]);
  const [orig, setOrig] = useState<Level[]>([]);
  const [levels, setLevels] = useState<Level[]>([]);
  const [lvl, setLvl] = useState('*.*');
  const [password, setPw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ user: string; host: string; password: string } | null>(null);
  const [addDb, setAddDb] = useState('');
  const [addTable, setAddTable] = useState('');
  const tables = useStore((s) => (addDb ? s.meta[metaKey.objects(connId, addDb)] : undefined)) as MetaEntry<DbObjects> | undefined;

  const loadUsers = async () => {
    try { setList(await api.meta.users(connId)); } catch (err) { setError((err as Error).message); }
  };
  useEffect(() => {
    if (!connOpen) { useStore.getState().openConn(connId); return; }
    loadUsers();
    loadDatabases(connId);
  }, [connOpen]);

  const open = async (a: Acct) => {
    setSel(a);
    setError(null);
    setOk(null);
    setPw('');
    try {
      const lines = await api.meta.grants(connId, a.user, a.host);
      const g = parseGrants(lines);
      if (!g.levels.some((l) => l.on === '*.*')) g.levels.unshift({ on: '*.*', privs: [], grantOption: false });
      setRaw(lines);
      setOrig(g.levels);
      setLevels(structuredClone(g.levels));
      setLvl('*.*');
    } catch (err) { setError((err as Error).message); setRaw([]); setOrig([]); setLevels([]); }
  };

  const acct = sel ? account(sel.user, sel.host) : '';
  const statements = useMemo(() => {
    if (!sel) return [];
    return [...(password ? [setPassword(sel.user, sel.host, password)] : []), ...grantStatements(acct, orig, levels)];
  }, [sel, password, orig, levels]);

  const run = async (sqls: string[], what: string) => {
    if (!sqls.length) return false;
    if ((await api.confirm(what, sqls.map(maskPasswords).join(';\n') + ';', ['Esegui', 'Annulla'])) !== 0) return false;
    try {
      await api.ddl.run(connId, sqls);
      setOk('Modifiche applicate.');
      setError(null);
      return true;
    } catch (err) { setError((err as Error).message); return false; }
  };

  const level = levels.find((l) => l.on === lvl);
  const kind = level ? levelKind(level.on) : 'global';
  const offered = privilegesFor(kind);
  const toggle = (p: string, on: boolean) => setLevels(levels.map((l) => {
    if (l.on !== lvl) return l;
    if (p === ALL) return { ...l, privs: on ? [ALL] : [] };
    const privs = l.privs.filter((x) => x !== ALL && x !== p);
    return { ...l, privs: on ? [...privs, p] : privs };
  }));
  const shown = (list?.users ?? []).filter((u) => !filter || `${u.user}@${u.host}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="users">
      <div className="users-list">
        <div className="users-bar">
          <input className="search" placeholder="Filtra account…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button onClick={() => setCreating({ user: '', host: '%', password: '' })}>+ Nuovo</button>
        </div>
        {list?.limited && <div className="status error">Senza privilegi su mysql.user: è visibile solo l'account corrente.</div>}
        {shown.map((u) => (
          <div key={`${u.user}@${u.host}`} className={`cmp-item${sel?.user === u.user && sel?.host === u.host ? ' sel' : ''}`} onMouseDown={() => open(u)}>
            <span className="name">{u.user || '(anonimo)'}<span className="muted">@{u.host}</span></span>
            {u.role && <span className="badge st-equal">ruolo</span>}
          </div>
        ))}
      </div>
      <div className="users-detail">
        {creating ? (
          <div className="form user-new">
            <h4>Nuovo account</h4>
            <div className="row">
              <label className="grow">Utente<input autoFocus value={creating.user} onChange={(e) => setCreating({ ...creating, user: e.target.value })} /></label>
              <label>Host<input value={creating.host} title="% = qualsiasi host, localhost = solo locale" onChange={(e) => setCreating({ ...creating, host: e.target.value })} /></label>
            </div>
            <label>Password<input type="password" value={creating.password} onChange={(e) => setCreating({ ...creating, password: e.target.value })} /></label>
            {error && <div className="status error">{error}</div>}
            <div className="row">
              <button onClick={() => { setCreating(null); setError(null); }}>Annulla</button>
              <button className="primary" disabled={!creating.user} onClick={async () => {
                if (await run([createUser(creating.user, creating.host, creating.password)], `Creare ${creating.user}@${creating.host}?`)) {
                  const a = { user: creating.user, host: creating.host, role: false };
                  setCreating(null);
                  await loadUsers();
                  open(a);
                }
              }}>Crea account</button>
            </div>
          </div>
        ) : !sel ? <div className="empty">Seleziona un account.</div> : <>
          <div className="users-head">
            <h4>{sel.user}<span className="muted">@{sel.host}</span></h4>
            <label className="pw">Nuova password<input type="password" value={password} placeholder="invariata" onChange={(e) => setPw(e.target.value)} /></label>
            <div className="spacer" />
            <button className="danger" onClick={async () => { if (await run([dropUser(sel.user, sel.host)], `Eliminare l'account ${sel.user}@${sel.host}?`)) { setSel(null); loadUsers(); } }}>Elimina account</button>
          </div>
          <div className="priv-body">
            <div className="levels">
              {levels.map((l) => (
                <div key={l.on} className={`cmp-item${l.on === lvl ? ' sel' : ''}`} onMouseDown={() => setLvl(l.on)}>
                  <span className="name">{label(l.on)}</span>
                  <span className="muted">{l.privs.includes(ALL) ? 'tutti' : l.privs.length}</span>
                </div>
              ))}
              <div className="add-level">
                <select value={addDb} onChange={(e) => { setAddDb(e.target.value); setAddTable(''); if (e.target.value) useStore.getState().loadMeta(metaKey.objects(connId, e.target.value), () => api.meta.objects(connId, e.target.value)); }}>
                  <option value="">+ database…</option>
                  {(dbs?.data ?? []).map((d) => <option key={d}>{d}</option>)}
                </select>
                {addDb && <select value={addTable} onChange={(e) => setAddTable(e.target.value)}>
                  <option value="">(tutto il database)</option>
                  {(tables?.data?.tables ?? []).map((t) => <option key={t.name}>{t.name}</option>)}
                </select>}
                {addDb && <button onClick={() => {
                  const on = addTable ? `\`${addDb}\`.\`${addTable}\`` : `\`${addDb}\`.*`;
                  if (!levels.some((l) => l.on === on)) setLevels([...levels, { on, privs: [], grantOption: false }]);
                  setLvl(on);
                  setAddDb('');
                  setAddTable('');
                }}>Aggiungi</button>}
              </div>
            </div>
            <div className="privs">
              {level && <>
                <div className="priv-title">{label(level.on)}
                  <label className="check"><input type="checkbox" checked={level.privs.includes(ALL)} onChange={(e) => toggle(ALL, e.target.checked)} /> Tutti i privilegi</label>
                  <label className="check"><input type="checkbox" checked={level.grantOption} onChange={(e) => setLevels(levels.map((l) => (l.on === lvl ? { ...l, grantOption: e.target.checked } : l)))} /> GRANT OPTION</label>
                </div>
                {PRIV_GROUPS.map((g) => {
                  const privs = g.privs.filter((p) => offered.includes(p));
                  if (!privs.length) return null;
                  return (
                    <fieldset key={g.label} className="priv-group" disabled={level.privs.includes(ALL)}>
                      <legend>{g.label}</legend>
                      {privs.map((p) => <label key={p} className="check"><input type="checkbox" checked={level.privs.includes(ALL) || level.privs.includes(p)} onChange={(e) => toggle(p, e.target.checked)} /> {p}</label>)}
                    </fieldset>
                  );
                })}
                {level.privs.filter((p) => p !== ALL && !offered.includes(p)).length > 0 && <p className="note">Altri privilegi: {level.privs.filter((p) => p !== ALL && !offered.includes(p)).join(', ')}</p>}
              </>}
              <details>
                <summary>SHOW GRANTS</summary>
                <pre className="script">{raw.map(maskPasswords).join(';\n')}</pre>
              </details>
            </div>
          </div>
          <div className="designer-foot">
            {error ? <div className="status error">{error}</div> : ok ? <div className="status ok">{ok}</div> : <span className="muted">{statements.length} {statements.length === 1 ? 'istruzione' : 'istruzioni'}</span>}
            <div className="spacer" />
            <button disabled={!statements.length} onClick={() => { setLevels(structuredClone(orig)); setPw(''); }}>Annulla modifiche</button>
            <button className="primary" disabled={!statements.length} onClick={async () => { if (await run(statements, `Applicare a ${sel.user}@${sel.host}?`)) open(sel); }}>Applica</button>
          </div>
          {statements.length > 0 && <pre className="script users-preview">{statements.map(maskPasswords).join(';\n')};</pre>}
        </>}
      </div>
    </div>
  );
}
