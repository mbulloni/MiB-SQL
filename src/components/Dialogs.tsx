import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { ConnDef, Engine, Secrets, SshAuth } from '../types';
import { t as tr, locale } from '../i18n';

const COLORS = [
  { label: tr('Nessuno'), value: '' },
  { label: tr('Sviluppo (verde)'), value: '#2e9e44' },
  { label: tr('Test (giallo)'), value: '#e0a800' },
  { label: tr('Produzione (rosso)'), value: '#d64545' },
];

const EMPTY: Omit<ConnDef, 'id'> = {
  name: '', host: 'localhost', port: 3306, user: 'root', database: '', socket: '', ssl: false, sslVerify: false, sslCa: '',
  savePassword: true, color: '', ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', keyFile: '~/.ssh/id_ed25519' },
};

export function ConnectionDialog() {
  const dialog = useStore((s) => s.connDialog);
  const keyring = useStore((s) => s.keyring);
  const s = useStore();
  const [def, setDef] = useState<Omit<ConnDef, 'id'> & { id?: string }>(() => ({ ...EMPTY, ...dialog!.def, ssh: { ...EMPTY.ssh!, ...dialog!.def.ssh } }));
  const [secrets, setSecrets] = useState<Secrets>({});
  const [tab, setTab] = useState<'general' | 'ssl' | 'ssh' | 'advanced'>('general');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = !!def.id;

  const set = (patch: Partial<ConnDef>) => setDef((d) => ({ ...d, ...patch }));
  const setSsh = (patch: Partial<NonNullable<ConnDef['ssh']>>) => setDef((d) => ({ ...d, ssh: { ...d.ssh!, ...patch } }));
  const tds = def.engine === 'mssql';
  const entra = tds && def.auth !== 'sql';
  const name = def.name.trim() || (tds ? `${def.database || def.host.split('.')[0]}` : def.socket ? `${def.user}@socket` : `${def.user}@${def.host}`);
  const setEngine = (engine: Engine) => setDef((d) => (engine === 'mssql'
    ? { ...d, engine, auth: d.auth ?? 'entra', entra: d.entra ?? { method: 'browser' }, readOnly: d.readOnly ?? true, port: d.port === 3306 ? 1433 : d.port, host: d.host === 'localhost' ? '' : d.host, user: d.user === 'root' ? '' : d.user, socket: '' }
    : { ...d, engine: undefined, port: d.port === 1433 ? 3306 : d.port, host: d.host || 'localhost' }));
  const setEntra = (patch: Partial<NonNullable<ConnDef['entra']>>) => setDef((d) => ({ ...d, entra: { method: 'browser', ...d.entra, ...patch } }));
  const close = () => s.set({ connDialog: null });

  const test = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const info = await api.conn.test({ ...def, id: def.id ?? '' }, secrets);
      setStatus({ ok: true, text: tr('Connessione riuscita: {0} come {1}', info.version, info.user) });
    } catch (err) {
      setStatus({ ok: false, text: (err as Error).message });
    } finally { setBusy(false); }
  };

  const save = async (connect: boolean) => {
    const saved = await api.conn.save({ ...def, name, port: Number(def.port) || (tds ? 1433 : 3306) }, secrets);
    await s.loadConns();
    close();
    if (editing) await s.closeConn(saved.id);
    s.set({ selectedConn: saved.id });
    if (connect) s.openConn(saved.id);
  };

  return (
    <div className="modal-back" onMouseDown={close}>
      <div className="modal conn-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div className="modal-title">{editing ? tr('Modifica connessione') : tr('Nuova connessione')}</div>
        <div className="tabs-row">
          {(tds ? ['general', 'advanced'] as const : ['general', 'ssl', 'ssh'] as const).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{{ general: tr('Generale'), ssl: 'SSL', ssh: tr('Tunnel SSH'), advanced: tr('Avanzate') }[t]}</button>
          ))}
        </div>
        <div className="form">
          {tab === 'general' && <label>{tr('Tipo di database')}
            <select value={def.engine ?? 'mysql'} disabled={editing} onChange={(e) => { setEngine(e.target.value as Engine); setStatus(null); }}>
              <option value="mysql">MariaDB / MySQL</option>
              <option value="mssql">{tr('Microsoft Fabric Warehouse / SQL Server')}</option>
            </select>
          </label>}
          {tab === 'general' && tds && <>
            <label>{tr('Nome')}<input autoFocus value={def.name} placeholder={name} onChange={(e) => set({ name: e.target.value })} /></label>
            <div className="row">
              <label className="grow">{tr('Server (stringa di connessione SQL)')}<input value={def.host} placeholder="xxxxxxxx.datawarehouse.fabric.microsoft.com" onChange={(e) => set({ host: e.target.value.trim().replace(/^tcp:/i, '').replace(/,(\d+)$/, '') })} /></label>
              <label className="port">{tr('Porta')}<input type="number" value={def.port} onChange={(e) => set({ port: Number(e.target.value) })} /></label>
            </div>
            <label>{tr('Warehouse (database)')}<input value={def.database} placeholder={tr('nome del warehouse o del lakehouse')} onChange={(e) => set({ database: e.target.value })} /></label>
            <label>{tr('Autenticazione')}
              <select value={def.auth === 'sql' ? 'sql' : def.entra?.method === 'device' ? 'device' : 'browser'}
                onChange={(e) => { const v = e.target.value; if (v === 'sql') set({ auth: 'sql' }); else { set({ auth: 'entra' }); setEntra({ method: v as 'browser' | 'device' }); } }}>
                <option value="browser">{tr('Microsoft Entra ID: accesso nel browser (MFA)')}</option>
                <option value="device">{tr('Microsoft Entra ID: codice dispositivo')}</option>
                <option value="sql">{tr('Utente e password SQL')}</option>
              </select>
            </label>
            {entra ? <>
              <label>{tr('Account (opzionale)')}<input value={def.user} placeholder="nome.cognome@azienda.it" onChange={(e) => set({ user: e.target.value.trim() })} /></label>
              <EntraAccount id={def.id} />
            </> : <>
              <div className="row">
                <label className="grow">{tr('Utente')}<input value={def.user} onChange={(e) => set({ user: e.target.value })} /></label>
                <label className="grow">{tr('Password')}<input type="password" placeholder={editing ? '(invariata)' : ''} value={secrets.password ?? ''} onChange={(e) => setSecrets((x) => ({ ...x, password: e.target.value }))} /></label>
              </div>
              <label className="check">
                <input type="checkbox" checked={def.savePassword && keyring} disabled={!keyring} onChange={(e) => set({ savePassword: e.target.checked })} />
                {tr('Salva password nel portachiavi di sistema')}{!keyring && tr(' (non disponibile: verrà chiesta a ogni avvio)')}
              </label>
            </>}
            <label className="check"><input type="checkbox" checked={def.readOnly !== false} onChange={(e) => set({ readOnly: e.target.checked })} />{' '}{tr('Sola lettura: blocca INSERT, UPDATE, DELETE, CREATE, DROP, EXEC…')}</label>
            <label>{tr('Colore ambiente')}
              <select value={def.color} onChange={(e) => set({ color: e.target.value })}>
                {COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
          </>}
          {tab === 'advanced' && <>
            <label>{tr('Tenant (ID o dominio, opzionale)')}<input value={def.entra?.tenant ?? ''} placeholder="organizations" disabled={!entra} onChange={(e) => setEntra({ tenant: e.target.value.trim() })} /></label>
            <label>{tr('ID applicazione client (opzionale)')}<input value={def.entra?.clientId ?? ''} placeholder={tr('predefinito: client pubblico di Azure CLI')} disabled={!entra} onChange={(e) => setEntra({ clientId: e.target.value.trim() })} /></label>
            <p className="note">{tr('Servono solo se l\'azienda richiede un\'app registrata: client pubblico con URI di reindirizzamento http://localhost e permesso Azure SQL Database (user_impersonation).')}</p>
            <label className="check"><input type="checkbox" checked={!!def.trustCert} onChange={(e) => set({ trustCert: e.target.checked })} />{' '}{tr('Accetta il certificato del server senza verificarlo (solo SQL Server locale)')}</label>
          </>}
          {tab === 'general' && !tds && <>
            <label>{tr('Nome')}<input autoFocus value={def.name} placeholder={name} onChange={(e) => set({ name: e.target.value })} /></label>
            <div className="row">
              <label className="grow">{tr('Host')}<input value={def.host} disabled={!!def.socket} onChange={(e) => set({ host: e.target.value })} /></label>
              <label className="port">{tr('Porta')}<input type="number" value={def.port} disabled={!!def.socket} onChange={(e) => set({ port: Number(e.target.value) })} /></label>
            </div>
            <label>{tr('Socket Unix (opzionale)')}<input value={def.socket} placeholder="/run/mysqld/mysqld.sock" onChange={(e) => set({ socket: e.target.value })} /></label>
            <div className="row">
              <label className="grow">{tr('Utente')}<input value={def.user} onChange={(e) => set({ user: e.target.value })} /></label>
              <label className="grow">{tr('Password')}<input type="password" placeholder={editing ? '(invariata)' : ''} value={secrets.password ?? ''} onChange={(e) => setSecrets((x) => ({ ...x, password: e.target.value }))} /></label>
            </div>
            <label className="check">
              <input type="checkbox" checked={def.savePassword && keyring} disabled={!keyring} onChange={(e) => set({ savePassword: e.target.checked })} />
              {tr('Salva password nel portachiavi di sistema')}{!keyring && tr(' (non disponibile: verrà chiesta a ogni avvio)')}
            </label>
            <label>{tr('Database predefinito (opzionale)')}<input value={def.database} onChange={(e) => set({ database: e.target.value })} /></label>
            <label>{tr('Colore ambiente')}
              <select value={def.color} onChange={(e) => set({ color: e.target.value })}>
                {COLORS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </select>
            </label>
          </>}
          {tab === 'ssl' && <>
            <label className="check"><input type="checkbox" checked={!!def.ssl} onChange={(e) => set({ ssl: e.target.checked })} />{' '}{tr('Usa SSL/TLS')}</label>
            <label className="check"><input type="checkbox" disabled={!def.ssl} checked={!!def.sslVerify} onChange={(e) => set({ sslVerify: e.target.checked })} />{' '}{tr('Verifica il certificato del server')}</label>
            <label>{tr('Certificato CA (file PEM, opzionale)')}<input disabled={!def.ssl} value={def.sslCa} placeholder="/etc/ssl/certs/ca.pem" onChange={(e) => set({ sslCa: e.target.value })} /></label>
          </>}
          {tab === 'ssh' && <>
            <label className="check"><input type="checkbox" checked={!!def.ssh?.enabled} onChange={(e) => setSsh({ enabled: e.target.checked })} />{' '}{tr('Connetti tramite tunnel SSH')}</label>
            <fieldset disabled={!def.ssh?.enabled}>
              <div className="row">
                <label className="grow">{tr('Host SSH')}<input value={def.ssh!.host} onChange={(e) => setSsh({ host: e.target.value })} /></label>
                <label className="port">{tr('Porta')}<input type="number" value={def.ssh!.port} onChange={(e) => setSsh({ port: Number(e.target.value) })} /></label>
              </div>
              <label>{tr('Utente SSH')}<input value={def.ssh!.user} onChange={(e) => setSsh({ user: e.target.value })} /></label>
              <label>{tr('Autenticazione')}
                <select value={def.ssh!.auth} onChange={(e) => setSsh({ auth: e.target.value as SshAuth })}>
                  <option value="password">{tr('Password')}</option>
                  <option value="key">{tr('Chiave privata')}</option>
                  <option value="agent">{tr('ssh-agent')}</option>
                </select>
              </label>
              {def.ssh!.auth === 'password' && <label>{tr('Password SSH')}<input type="password" placeholder={editing ? '(invariata)' : ''} value={secrets.sshPassword ?? ''} onChange={(e) => setSecrets((x) => ({ ...x, sshPassword: e.target.value }))} /></label>}
              {def.ssh!.auth === 'key' && <>
                <label>{tr('File chiave privata')}<input value={def.ssh!.keyFile} onChange={(e) => setSsh({ keyFile: e.target.value })} /></label>
                <label>{tr('Passphrase (opzionale)')}<input type="password" value={secrets.passphrase ?? ''} onChange={(e) => setSecrets((x) => ({ ...x, passphrase: e.target.value }))} /></label>
              </>}
              <p className="note">{tr('Host e porta della scheda Generale sono visti dal server SSH (di solito localhost:3306).')}</p>
            </fieldset>
          </>}
        </div>
        {status && <div className={`status ${status.ok ? 'ok' : 'error'}`}>{status.text}</div>}
        <div className="modal-buttons">
          <button onClick={test} disabled={busy}>{busy ? tr('Test in corso…') : tr('Prova connessione')}</button>
          <div className="spacer" />
          <button onClick={close}>{tr('Annulla')}</button>
          <button onClick={() => save(false)}>{tr('Salva')}</button>
          <button className="primary" onClick={() => save(true)}>{tr('Salva e connetti')}</button>
        </div>
      </div>
    </div>
  );
}

export function PasswordPrompt() {
  const req = useStore((s) => s.passwordPrompt)!;
  const keyring = useStore((s) => s.keyring);
  const [secrets, setSecrets] = useState<Secrets>({});
  const [remember, setRemember] = useState(req.conn.savePassword && keyring);
  const ssh = req.conn.ssh?.enabled ? req.conn.ssh.auth : null;
  const ok = () => req.resolve({ secrets, remember });
  return (
    <div className="modal-back">
      <form className="modal small" onSubmit={(e) => { e.preventDefault(); ok(); }} onKeyDown={(e) => { if (e.key === 'Escape') req.resolve(null); }}>
        <div className="modal-title">{tr('Accesso a')}{' '}{req.conn.name}</div>
        <div className="form">
          {req.error && <div className="status error">{req.error}</div>}
          <label>{tr('Password di')}{' '}{req.conn.user}<input type="password" autoFocus value={secrets.password ?? ''} onChange={(e) => setSecrets((x) => ({ ...x, password: e.target.value }))} /></label>
          {ssh === 'password' && <label>{tr('Password SSH di')}{' '}{req.conn.ssh!.user}<input type="password" value={secrets.sshPassword ?? ''} onChange={(e) => setSecrets((x) => ({ ...x, sshPassword: e.target.value }))} /></label>}
          {ssh === 'key' && <label>{tr('Passphrase chiave SSH')}<input type="password" value={secrets.passphrase ?? ''} onChange={(e) => setSecrets((x) => ({ ...x, passphrase: e.target.value }))} /></label>}
          <label className="check"><input type="checkbox" checked={remember} disabled={!keyring} onChange={(e) => setRemember(e.target.checked)} />{' '}{tr('Salva nel portachiavi')}</label>
        </div>
        <div className="modal-buttons">
          <div className="spacer" />
          <button type="button" onClick={() => req.resolve(null)}>{tr('Annulla')}</button>
          <button type="submit" className="primary">{tr('Connetti')}</button>
        </div>
      </form>
    </div>
  );
}

export function ValueViewer() {
  const v = useStore((s) => s.viewer)!;
  const [value, setValue] = useState(v.value);
  const [isNull, setNull] = useState(!!v.isNull);
  const close = () => useStore.getState().set({ viewer: null });
  const save = (nv: string | null) => { v.onSave?.(nv); close(); };
  return (
    <div className="modal-back" onMouseDown={close}>
      <div className="modal viewer" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div className="modal-title">{v.title} <span className="hint">{isNull ? 'NULL' : v.binary ? tr('{0} byte (esadecimale)', Math.floor(value.replace(/^0x/i, '').length / 2).toLocaleString(locale())) : `${value.length.toLocaleString(locale())} caratteri`}</span></div>
        <textarea readOnly={!v.onSave} autoFocus value={value} placeholder={isNull ? 'NULL' : ''}
          onChange={(e) => { setValue(e.target.value); setNull(false); }} />
        <div className="modal-buttons">
          <button onClick={() => navigator.clipboard.writeText(value)}>{tr('Copia')}</button>
          {v.binary && <>
            <button disabled={!v.onSave} onClick={async () => { const hex = await api.file.readHex(); if (hex !== null) { setValue(hex); setNull(false); } }}>{tr('Carica da file…')}</button>
            <button disabled={!value || isNull} onClick={() => api.file.writeHex(value, v.title)}>{tr('Salva su file…')}</button>
          </>}
          <div className="spacer" />
          {v.onSave ? <>
            <button onClick={() => save(null)}>{tr('Imposta NULL')}</button>
            <button onClick={close}>{tr('Annulla')}</button>
            <button className="primary" disabled={isNull && value === ''} onClick={() => save(value)}>{tr('Applica')}</button>
          </> : <button className="primary" onClick={close}>{tr('Chiudi')}</button>}
        </div>
      </div>
    </div>
  );
}

/** Account signed in for an Entra profile, with sign-out (the next connection asks to sign in again). */
function EntraAccount({ id }: { id?: string }) {
  const [account, setAccount] = useState<{ username: string } | null | undefined>(undefined);
  useEffect(() => { if (id) api.entra.account(id).then(setAccount, () => setAccount(null)); }, [id]);
  if (!id || account === undefined) return <p className="note">{tr('Alla prima connessione si apre il browser per l\'accesso Microsoft (anche con MFA); poi l\'accesso resta valido finché il token non scade.')}</p>;
  return (
    <div className="row note">
      <span className="grow">{account ? tr('Accesso effettuato come {0}', account.username) : tr('Nessun accesso salvato: verrà chiesto alla connessione.')}</span>
      {account && <button type="button" onClick={async () => {
        await api.entra.signOut(id);
        await useStore.getState().closeConn(id);
        setAccount(null);
      }}>{tr('Esci dall\'account')}</button>}
    </div>
  );
}

/** Microsoft Entra sign-in in progress: the browser is open, or a device code to type on another device. */
export function EntraPromptDialog() {
  const p = useStore((s) => s.entraPrompt);
  if (!p || p.kind === 'done') return null;
  const close = () => useStore.getState().set({ entraPrompt: null });
  return (
    <div className="modal-back">
      <div className="modal small" onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div className="modal-title">{tr('Accesso Microsoft per {0}', p.name)}</div>
        <div className="form">
          {p.kind === 'browser' ? <p>{tr('Completa l\'accesso nella finestra del browser che si è aperta. La connessione prosegue da sola appena l\'accesso è riuscito.')}</p> : <>
            <p>{tr('Apri {0} e inserisci il codice:', p.url)}</p>
            <div className="device-code">{p.code}</div>
          </>}
        </div>
        <div className="modal-buttons">
          {p.kind === 'device' && <>
            <button onClick={() => navigator.clipboard.writeText(p.code)}>{tr('Copia codice')}</button>
            <button onClick={() => { navigator.clipboard.writeText(p.code); api.entra.openUrl(p.url); }}>{tr('Copia e apri la pagina')}</button>
          </>}
          <div className="spacer" />
          <button onClick={close}>{tr('Nascondi')}</button>
        </div>
      </div>
    </div>
  );
}
