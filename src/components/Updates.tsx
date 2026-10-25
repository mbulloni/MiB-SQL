import { useEffect, useState } from 'react';
import { api } from '../api';
import { persist } from '../actions';
import { locale, t } from '../i18n';
import { useStore } from '../store';

// Update check preferences: automatic check at startup (at most every 12 hours), a version the user skipped.
const KEY = 'mibsql.updates';
interface Prefs { auto: boolean; last: number; skip: string | null }
export function updatePrefs(): Prefs {
  try { return { auto: true, last: 0, skip: null, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { auto: true, last: 0, skip: null }; }
}
export function setUpdatePrefs(p: Partial<Prefs>) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...updatePrefs(), ...p })); } catch { /* ignore */ }
}

/** Checks for a newer release; quiet = startup check (respects the interval and the skipped version). */
export async function checkUpdates(quiet: boolean) {
  const p = updatePrefs();
  if (quiet && (!p.auto || Date.now() - p.last < 12 * 3600 * 1000)) return null;
  try {
    const info = await api.update.check();
    setUpdatePrefs({ last: Date.now() });
    if (info.newer && (!quiet || p.skip !== info.latest)) useStore.getState().set({ update: info });
    if (!quiet) useStore.getState().set({ update: info, updateDialog: true, updateError: null });
    return info;
  } catch (err) {
    if (!quiet) useStore.getState().set({ update: null, updateDialog: true, updateError: (err as Error).message });
    return null;
  }
}

/** Release notes (GitHub Markdown) as plain blocks: headings, bullets, code fences and paragraphs. */
function notesView(md: string) {
  const out: React.ReactNode[] = [];
  let code: string[] | null = null;
  md.replace(/\r/g, '').split('\n').forEach((line, i) => {
    if (line.startsWith('```')) { if (code) { out.push(<pre key={i}>{code.join('\n')}</pre>); code = null; } else code = []; return; }
    if (code) { code.push(line); return; }
    const plain = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    if (/^#{1,6}\s/.test(line)) out.push(<b key={i} className="rn-h">{plain.replace(/^#+\s*/, '')}</b>);
    else if (/^\s*[-*]\s/.test(line)) out.push(<div key={i} className="rn-li">• {plain.replace(/^\s*[-*]\s/, '')}</div>);
    else if (/^-{3,}$/.test(line.trim())) out.push(<hr key={i} />);
    else if (line.trim()) out.push(<p key={i}>{plain}</p>);
  });
  return out.length ? out : '—';
}

/** Strip under the toolbar when a newer release exists. */
export function UpdateBanner() {
  const u = useStore((s) => s.update);
  const dialog = useStore((s) => s.updateDialog);
  if (!u?.newer || dialog) return null;
  return (
    <div className="update-banner">
      <b>{t('È disponibile MiB-SQL {0}', u.latest)}</b>
      <span className="muted">{t('(installata {0})', u.current)}</span>
      <div className="spacer" />
      <button className="primary" onClick={() => useStore.getState().set({ updateDialog: true })}>{t('Novità e aggiornamento…')}</button>
      <button onClick={() => useStore.getState().set({ update: null })}>{t('Più tardi')}</button>
      <button onClick={() => { setUpdatePrefs({ skip: u.latest }); useStore.getState().set({ update: null }); }}>{t('Salta questa versione')}</button>
    </div>
  );
}

/** Release notes, download progress, restart. */
export function UpdateDialog() {
  const u = useStore((s) => s.update);
  const checkError = useStore((s) => s.updateError);
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: boolean; bytes?: number; total?: number; installing?: boolean; note?: string }>({});
  const [auto, setAuto] = useState(updatePrefs().auto);
  useEffect(() => api.tasks.onProgress((p) => {
    if (p.id !== 'update') return;
    if (p.phase === 'install') setState((s) => ({ ...s, installing: true }));
    else setState((s) => ({ ...s, bytes: Number(p.bytes), total: Number(p.total) }));
  }), []);
  const close = () => useStore.getState().set({ updateDialog: false, updateError: null });
  const install = async () => {
    setState({ busy: true });
    try {
      const r = await api.update.install();
      if (r.done) setState({ done: true });
      else if (r.reason === 'installer') setState({ note: t('Installazione automatica non riuscita: si è aperto il programma di installazione del sistema con il file {0}.', r.file ?? '') });
      else if (r.reason === 'manual') setState({ note: t('Questa copia non è un AppImage né un pacchetto .deb: si è aperta la pagina della release per scaricarla.') });
      else setState({ note: t('Nessun aggiornamento da installare.') });
    } catch (err) { setState({ error: (err as Error).message }); }
  };
  const restart = async () => {
    const dirty = useStore.getState().docs.filter((d) => d.dirty && !d.obj && d.kind === 'sql' && d.file);
    if (dirty.length && (await api.confirm(t('Riavviare ora?'), t('File non salvati: {0}. Il testo resta nelle schede, ma i file su disco non vengono aggiornati.', dirty.map((d) => d.title).join(', ')), [t('Riavvia'), t('Annulla')])) !== 0) return;
    persist(true);
    setTimeout(() => api.update.restart(), 450);
  };
  const pct = state.total ? Math.round(((state.bytes ?? 0) / state.total) * 100) : 0;
  const mb = (n?: number) => ((n ?? 0) / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1 });
  return (
    <div className="modal-back" onMouseDown={() => !state.busy && close()}>
      <div className="modal wizard update-dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape' && !state.busy) close(); }}>
        <div className="modal-title">{u?.newer ? t('Aggiornamento a MiB-SQL {0}', u.latest) : t('Aggiornamenti')}</div>
        <div className="form">
          {checkError && <div className="status error">{checkError}</div>}
          {u && !u.newer && <div className="status ok">{t('Hai già l\'ultima versione ({0}).', u.current)}</div>}
          {u?.newer && <>
            <p className="note">{t('Versione installata {0} · nuova {1}{2}', u.current, u.latest, u.published ? ` · ${new Date(u.published).toLocaleDateString(locale())}` : '')}</p>
            <div className="props-title">{t('Novità')}</div>
            <div className="release-notes">{notesView(u.notes)}</div>
            <p className="note">{u.mode === 'appimage' ? t('Verrà scaricato {0} ({1} MB) e sostituito l\'AppImage in uso; poi l\'app si riavvia.', u.asset?.name ?? '', mb(u.asset?.size))
              : u.mode === 'deb' ? t('Verrà scaricato {0} ({1} MB) e installato con apt: il sistema chiede la password di amministratore.', u.asset?.name ?? '', mb(u.asset?.size))
                : t('Copia non installata da AppImage o .deb: verrà aperta la pagina della release.')}</p>
          </>}
          {state.busy && !state.done && <div className="maint-progress"><span>{state.installing ? t('Installazione…') : t('Download {0} / {1} MB', mb(state.bytes), mb(state.total))}</span><progress className="progress" max={100} value={state.installing ? 100 : pct} /></div>}
          {state.done && <div className="status ok">{t('Aggiornamento installato: riavvia per usare la nuova versione. Le schede aperte vengono ripristinate.')}</div>}
          {state.note && <div className="status ok">{state.note}</div>}
          {state.error && <div className="status error">{state.error}</div>}
          <label className="check"><input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setUpdatePrefs({ auto: e.target.checked }); }} /> {t('Controlla gli aggiornamenti all\'avvio (GitHub, nessun dato inviato)')}</label>
        </div>
        <div className="modal-buttons">
          {u?.url && <button onClick={() => api.openRelease(u.url)}>{t('Pagina della release')}</button>}
          <div className="spacer" />
          <button onClick={close} disabled={state.busy && !state.done && !state.error && !state.note}>{t('Chiudi')}</button>
          {u?.newer && !state.done && <button className="primary" disabled={state.busy && !state.error && !state.note} onClick={install}>{t('Aggiorna ora')}</button>}
          {state.done && <button className="primary" onClick={restart}>{t('Riavvia ora')}</button>}
        </div>
      </div>
    </div>
  );
}
