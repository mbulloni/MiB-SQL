import { useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { ConnDef, Secrets, SshAuth } from '../types';
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
  const [tab, setTab] = useState<'general' | 'ssl' | 'ssh'>('general');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const editing = !!def.id;

  const set = (patch: Partial<ConnDef>) => setDef((d) => ({ ...d, ...patch }));
  const setSsh = (patch: Partial<NonNullable<ConnDef['ssh']>>) => setDef((d) => ({ ...d, ssh: { ...d.ssh!, ...patch } }));
  const name = def.name.trim() || (def.socket ? `${def.user}@socket` : `${def.user}@${def.host}`);
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
    const saved = await api.conn.save({ ...def, name, port: Number(def.port) || 3306 }, secrets);
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
          {(['general', 'ssl', 'ssh'] as const).map((t) => (
            <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{{ general: tr('Generale'), ssl: 'SSL', ssh: tr('Tunnel SSH') }[t]}</button>
          ))}
        </div>
        <div className="form">
          {tab === 'general' && <>
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
