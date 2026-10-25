import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { cancelDoc, closeDoc, formatDoc, openAssistant, openHistory, openServerTool, openVisual, profileDoc, requestQuit, switchLanguage, newDoc, openFiles, openSql, restore, runDoc, saveDoc, setDocTarget, visualTarget } from './actions';
import { formatOptions, loadSnippets, setFormatOptions } from './editor';
import { loadDatabases, metaKey, useStore, type MetaEntry } from './store';
import ContextMenu, { openMenu } from './components/ContextMenu';
import { ConnectionDialog, PasswordPrompt, ValueViewer } from './components/Dialogs';
import ExportDialog from './components/ExportDialog';
import { BackupDialog, ImportWizard, RestoreDialog } from './components/TaskDialogs';
import Explorer from './components/Explorer';
import Icon from './components/Icon';
import ResultsPanel from './components/ResultsPanel';
import SqlEditor from './components/SqlEditor';
import TableDesigner from './components/TableDesigner';
import ErDiagram from './components/ErDiagram';
import QueryBuilder from './components/QueryBuilder';
import CompareView from './components/CompareView';
import Monitor from './components/Monitor';
import TargetDialog from './components/TargetDialog';
import AssistantPanel from './components/AssistantPanel';
import Users from './components/Users';
import History from './components/History';
import Maint from './components/Maint';
import ProcessManager from './components/ProcessManager';
import Performance from './components/Performance';
import DataGenerator from './components/DataGenerator';
import DocGenerator from './components/DocGenerator';
import ObjectBar from './components/ObjectBar';
import SnippetsDialog from './components/SnippetsDialog';
import CallDialog from './components/CallDialog';
import logo from '../build/icons/128x128.png';
import { getLang, LANGS, t } from './i18n';
import { onThemeChange, resolvedTheme, setThemePref, themePref, type ThemePref } from './theme';

/** Splitter drag; `invert` for panels on the right, which grow when dragged left. */
function useDrag(initial: number, axis: 'x' | 'y', min: number, key: string, invert = false) {
  const [size, setSize] = useState(() => Number(localStorage.getItem(key)) || initial);
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const p0 = axis === 'x' ? e.clientX : e.clientY;
    const s0 = size;
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (ev: MouseEvent) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - p0;
      setSize(Math.max(min, axis === 'x' ? (invert ? s0 - d : s0 + d) : s0 - d));
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-x', 'resizing-y');
      setSize((v) => { try { localStorage.setItem(key, String(v)); } catch { /* ignore */ } return v; });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return [size, start] as const;
}

/** Connection and database of the active document (dbForge's toolbar combos). */
function TargetPicker() {
  const doc = useStore((s) => s.docs.find((d) => d.id === s.activeDoc));
  const conns = useStore((s) => s.conns);
  const state = useStore((s) => (doc?.connId ? s.connState[doc.connId]?.status : undefined));
  const dbs = useStore((s) => (doc?.connId ? s.meta[metaKey.databases(doc.connId)] : undefined)) as MetaEntry<string[]> | undefined;
  useEffect(() => { if (doc?.connId && state === 'open') loadDatabases(doc.connId); }, [doc?.connId, state]);
  if (!doc) return null;
  const color = conns.find((c) => c.id === doc.connId)?.color;
  const list = dbs?.data ?? [];
  return (
    <div className="target" style={color ? { borderColor: color } : undefined}>
      <select value={doc.connId ?? ''} title={t('Connessione')}
        onChange={async (e) => {
          const id = e.target.value || null;
          await setDocTarget(doc.id, id, id ? (conns.find((c) => c.id === id)?.database || null) : null);
          if (id && useStore.getState().connState[id]?.status !== 'open') useStore.getState().openConn(id);
        }}>
        <option value="">{t('(nessuna connessione)')}</option>
        {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value={doc.db ?? ''} title="Database" disabled={!doc.connId}
        onFocus={() => { if (doc.connId && state !== 'open') useStore.getState().openConn(doc.connId); }}
        onChange={(e) => setDocTarget(doc.id, doc.connId, e.target.value || null)}>
        <option value="">{t('(nessun database)')}</option>
        {doc.db && !list.includes(doc.db) && <option value={doc.db}>{doc.db}</option>}
        {list.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </div>
  );
}

const THEME_LABEL: Record<ThemePref, string> = { light: t('Chiaro'), dark: t('Scuro'), system: t('Sistema') };

/** Light / dark / system switch at the end of the toolbar. */
function ThemeSwitch() {
  // external store: also follows changes made elsewhere (system theme, scripts) even before effects run
  const pref = useSyncExternalStore(onThemeChange, themePref);
  const next: Record<ThemePref, ThemePref> = { light: 'dark', dark: 'system', system: 'light' };
  const dark = resolvedTheme(pref) === 'dark';
  return (
    <button className="theme-switch" title={t('Tema: {0} (clic: {1})', THEME_LABEL[pref], THEME_LABEL[next[pref]])}
      onClick={() => setThemePref(next[pref])}>
      <Icon name={dark ? 'moon' : 'sun'} /><span>{THEME_LABEL[pref]}</span>
    </button>
  );
}

/** Interface language (the window reloads with the tabs kept). */
function LangSwitch() {
  const cur = getLang();
  return (
    <button className="theme-switch" title={t('Lingua dell\'interfaccia')}
      onClick={(e) => openMenu(e, LANGS.map((l) => ({ label: `${l.id === cur ? '✓' : '\u2003'} ${l.name}`, action: () => { if (l.id !== cur) switchLanguage(l.id); } })))}>
      <Icon name="lang" /><span>{cur.toUpperCase()}</span>
    </button>
  );
}

/** Keyword case, indent and list layout of the formatter (menu next to the Formatta button). */
function formatMenu(e: React.MouseEvent) {
  const o = formatOptions();
  const mark = (on: boolean, label: string) => `${on ? '✓' : '\u2003'} ${label}`;
  openMenu(e, [
    { label: mark(o.keywordCase === 'upper', t('Parole chiave MAIUSCOLE')), action: () => setFormatOptions({ keywordCase: 'upper' }) },
    { label: mark(o.keywordCase === 'lower', t('Parole chiave minuscole')), action: () => setFormatOptions({ keywordCase: 'lower' }) },
    { label: mark(o.keywordCase === 'keep', t('Maiuscole come scritte')), action: () => setFormatOptions({ keywordCase: 'keep' }) },
    'sep',
    { label: mark(o.indent === 2, t('Rientro di 2 spazi')), action: () => setFormatOptions({ indent: 2 }) },
    { label: mark(o.indent === 4, t('Rientro di 4 spazi')), action: () => setFormatOptions({ indent: 4 }) },
    'sep',
    { label: mark(o.listPerLine, t('Una colonna per riga (SELECT, SET, VALUES)')), action: () => setFormatOptions({ listPerLine: !o.listPerLine }) },
  ]);
}

/** Server and database tools, on the active document's or the explorer's connection/database. */
function toolsMenu(e: React.MouseEvent) {
  const s = useStore.getState();
  const tg = visualTarget();
  const connId = tg?.connId ?? s.selectedConn ?? (s.docs.find((d) => d.id === s.activeDoc)?.connId ?? null);
  const open = !!connId && s.connState[connId]?.status === 'open';
  const task = (kind: 'backup' | 'restore' | 'import') => () => (tg ? s.set({ task: { kind, connId: tg.connId, db: tg.db } }) : s.set({ pickTarget: { kind: 'maint' } }));
  openMenu(e, [
    { label: t('Cronologia query'), action: openHistory },
    { label: t('Snippet SQL…'), action: () => s.set({ snippetDialog: {} }) },
    { label: t('Manutenzione tabelle{0}', tg ? ` (${tg.db})` : '…'), action: () => openVisual('maint') },
    { label: `${t('Generatore di dati di test')}${tg ? ` (${tg.db})` : '…'}`, action: () => openVisual('datagen') },
    { label: `${t('Documentazione del database')}${tg ? ` (${tg.db})` : '…'}`, action: () => openVisual('docgen') },
    'sep',
    { label: t('Prestazioni e ottimizzazione'), action: () => openVisual('perf') },
    { label: t('Processi e transazioni'), action: () => openVisual('procs') },
    { label: t('Monitor sessioni'), action: () => (open ? openServerTool(connId!, 'monitor') : openVisual('monitor')) },
    { label: t('Utenti e privilegi'), action: () => (open ? openServerTool(connId!, 'users') : openVisual('users')) },
    'sep',
    { label: tg ? t('Backup di {0}…', tg.db) : t('Backup…'), disabled: !tg, action: task('backup') },
    { label: t('Ripristina / esegui file SQL…'), disabled: !tg, action: task('restore') },
    { label: t('Importa dati…'), disabled: !tg, action: task('import') },
  ]);
}

function Toolbar() {
  const doc = useStore((s) => s.docs.find((d) => d.id === s.activeDoc));
  const set = useStore((s) => s.set);
  const running = !!doc?.running;
  const sql = doc?.kind === 'sql';
  const obj = !!doc?.obj;
  const assistantOpen = useStore((s) => s.assistantOpen);
  const runnable = sql || doc?.kind === 'query';
  return (
    <div className="toolbar">
      <button title={t('Nuova connessione (Ctrl+Maiusc+N)')} onClick={() => set({ connDialog: { def: {} } })}><Icon name="addConn" /></button>
      <div className="sep" />
      <button title={t('Nuovo SQL (Ctrl+N)')} onClick={() => newDoc()}><Icon name="newSql" /><span>{t('Nuovo SQL')}</span></button>
      <button title={t('Apri (Ctrl+O)')} onClick={openFiles}><Icon name="open" /></button>
      <button title={t('Salva (Ctrl+S)')} disabled={!sql} onClick={() => saveDoc()}><Icon name="save" /></button>
      <div className="sep" />
      <button title={obj ? t('Applica la definizione al server (F5)') : t('Esegui script o selezione (F5)')} disabled={!runnable || running} onClick={() => runDoc('all')}><Icon name="play" /><span>{obj ? t('Applica') : t('Esegui')}</span></button>
      <button title={t('Esegui istruzione corrente (Ctrl+Invio)')} disabled={!runnable || running || obj} onClick={() => runDoc('current')}><Icon name="playLine" /></button>
      <button title={t('Interrompi (Maiusc+F5)')} disabled={!running} onClick={() => cancelDoc()}><Icon name="stop" /></button>
      <button title={t('Piano di esecuzione (Ctrl+E)')} disabled={!runnable || running || obj} onClick={() => runDoc('explain')}><Icon name="plan" /><span>{t('Piano')}</span></button>
      <button title={t('Profila l\'istruzione corrente (Ctrl+Maiusc+P)')} disabled={!sql || running || obj} onClick={() => profileDoc()}><Icon name="profile" /><span>{t('Profila')}</span></button>
      <div className="split-btn">
        <button title={t('Formatta lo script o la selezione (Ctrl+Maiusc+F)')} disabled={!sql} onClick={() => formatDoc()}><Icon name="format" /><span>{t('Formatta')}</span></button>
        <button className="arrow" title={t('Opzioni di formattazione')} onClick={formatMenu}>▾</button>
      </div>
      <div className="sep" />
      <button title={t('Cronologia delle query eseguite')} onClick={openHistory}><Icon name="history" /><span>{t('Cronologia')}</span></button>
      <button title={t('Snippet SQL: modelli richiamabili con prefisso + Tab')} onClick={() => set({ snippetDialog: {} })}><Icon name="snippet" /><span>{t('Snippet')}</span></button>
      <button title={t('Prestazioni: consigli sul server, query pesanti, indici, ottimizzazione delle query, variabili')} onClick={() => openVisual('perf')}><Icon name="perf" /><span className="keep">{t('Prestazioni')}</span></button>
      <button title={t('Processi: connessioni, transazioni, blocchi e deadlock; termina query e connessioni')} onClick={() => openVisual('procs')}><Icon name="procs" /><span>{t('Processi')}</span></button>
      <button title={t('Strumenti: manutenzione tabelle, monitor, utenti, backup, import')} onClick={toolsMenu}><Icon name="tools" /><span className="keep">{t('Strumenti ▾')}</span></button>
      <div className="sep" />
      <button title={t('Diagramma ER del database (editor visuale: tabelle e relazioni)')} onClick={() => openVisual('er')}><Icon name="er" /><span className="keep">{t('Diagramma ER')}</span></button>
      <button title={t('Query Builder visuale')} onClick={() => openVisual('query')}><Icon name="qb" /><span className="keep">{t('Query Builder')}</span></button>
      <button title={t('Nuova tabella nel designer visuale')} onClick={() => openVisual('table')}><Icon name="table" /><span>{t('Nuova tabella')}</span></button>
      <div className="sep" />
      <button className={assistantOpen && sql ? 'on' : ''} title={t('Assistente AI (Claude): genera, spiega, correggi e ottimizza SQL')} onClick={() => (assistantOpen && sql ? useStore.getState().setAssistantOpen(false) : openAssistant())}><Icon name="ai" /><span className="keep">{t('Assistente AI')}</span></button>
      <div className="sep" />
      {sql && <TargetPicker />}
      <div className="spacer" />
      <LangSwitch />
      <ThemeSwitch />
    </div>
  );
}

function DocTabs() {
  const docs = useStore((s) => s.docs);
  const active = useStore((s) => s.activeDoc);
  const conns = useStore((s) => s.conns);
  const set = useStore((s) => s.set);
  return (
    <div className="doc-tabs">
      {docs.map((d) => {
        const conn = conns.find((c) => c.id === d.connId);
        return (
          <div key={d.id} className={`doc-tab${d.id === active ? ' active' : ''}`} title={`${d.file ?? d.title}${conn ? `\n${conn.name}${d.db ? ` / ${d.db}` : ''}` : ''}`}
            style={conn?.color ? { borderTopColor: conn.color } : undefined}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeDoc(d.id); } else set({ activeDoc: d.id }); }}
            onContextMenu={(e) => openMenu(e, [
              { label: 'Salva', action: () => saveDoc(d.id) },
              { label: 'Salva con nome…', action: () => saveDoc(d.id, true) },
              'sep',
              { label: 'Chiudi', action: () => closeDoc(d.id) },
              { label: 'Chiudi le altre', action: async () => { for (const o of useStore.getState().docs) if (o.id !== d.id) await closeDoc(o.id); } },
            ])}>
            {d.running && <span className="spinner" />}
            {d.kind === 'table' && <Icon name="table" size={14} />}
            {d.kind === 'er' && <Icon name="fk" size={14} />}
            {d.obj && <Icon name={d.obj.kind} size={14} />}
            {d.kind === 'history' && <Icon name="history" size={14} />}
            {d.kind === 'maint' && <Icon name="maint" size={14} />}
            {(d.kind === 'perf' || d.kind === 'procs' || d.kind === 'datagen' || d.kind === 'docgen') && <Icon name={d.kind} size={14} />}
            <span className="name">{d.title}{d.dirty ? ' •' : ''}</span>
            <button className="x" onMouseDown={(e) => e.stopPropagation()} onClick={() => closeDoc(d.id)}><Icon name="close" size={12} /></button>
          </div>
        );
      })}
    </div>
  );
}

function StartPage() {
  const conns = useStore((s) => s.conns);
  const set = useStore((s) => s.set);
  return (
    <div className="start">
      <h1><img src={logo} alt="" width={56} height={56} />MiB-SQL</h1>
      <p>{t('IDE per MariaDB e MySQL')}</p>
      <div className="start-actions">
        <button onClick={() => set({ connDialog: { def: {} } })}><Icon name="addConn" />{' '}{t('Nuova connessione')}</button>
        <button onClick={() => newDoc()}><Icon name="newSql" />{' '}{t('Nuovo SQL')}</button>
        <button onClick={openFiles}><Icon name="open" />{' '}{t('Apri script…')}</button>
      </div>
      <h2>{t('Editor visuali')}</h2>
      <div className="start-tiles">
        <button onClick={() => openVisual('er')}><Icon name="er" size={28} /><b>{t('Diagramma ER')}</b><span>{t('Tabelle e relazioni del database: crea tabelle, disegna le chiavi esterne trascinando le colonne')}</span></button>
        <button onClick={() => openVisual('query')}><Icon name="qb" size={28} /><b>{t('Query Builder')}</b><span>{t('Componi una SELECT trascinando tabelle e colonne, join, filtri e raggruppamenti senza scrivere SQL')}</span></button>
        <button onClick={() => openVisual('table')}><Icon name="table" size={28} /><b>{t('Designer tabelle')}</b><span>{t('Colonne, indici, chiavi esterne e vincoli in una griglia; genera CREATE/ALTER')}</span></button>
        <button onClick={() => openVisual('compare')}><Icon name="plan" size={28} /><b>{t('Confronto')}</b><span>{t('Differenze di schema e dati tra due database, con script di sincronizzazione')}</span></button>
        <button onClick={openAssistant}><Icon name="ai" size={28} /><b>{t('Assistente AI')}</b><span>{t('Chiedi query in linguaggio naturale; fai spiegare, correggere e ottimizzare SQL (Claude)')}</span></button>
      </div>
      <h2>{t('Strumenti')}</h2>
      <div className="start-tiles">
        <button onClick={openHistory}><Icon name="history" size={28} /><b>{t('Cronologia query')}</b><span>{t('Tutte le istruzioni eseguite, con durata ed esito: cerca, riapri, esegui di nuovo')}</span></button>
        <button onClick={() => set({ snippetDialog: {} })}><Icon name="snippet" size={28} /><b>{t('Snippet SQL')}</b><span>{t('Modelli richiamabili nell\'editor con prefisso + Tab (sel, ins, upd, ct, proc…); crea i tuoi')}</span></button>
        <button onClick={() => openVisual('maint')}><Icon name="maint" size={28} /><b>{t('Manutenzione tabelle')}</b><span>{t('Dimensioni e frammentazione; Analizza, Ottimizza, Controlla, Ripara, Checksum')}</span></button>
        <button onClick={() => openVisual('datagen')}><Icon name="datagen" size={28} /><b>{t('Dati di test')}</b><span>{t('Riempie le tabelle con dati verosimili (nomi, email, date, importi) rispettando tipi, chiavi esterne e valori unici')}</span></button>
        <button onClick={() => openVisual('docgen')}><Icon name="docgen" size={28} /><b>{t('Documentazione')}</b><span>{t('Documento HTML o Markdown del database: tabelle, colonne, indici, relazioni, viste e routine, con diagramma')}</span></button>
        <button onClick={() => newDoc()}><Icon name="format" size={28} /><b>{t('Formattatore SQL')}</b><span>{t('Nell\'editor: Ctrl+Maiusc+F o «Formatta» riordina parole chiave, rientri e clausole')}</span></button>
      </div>
      <h2>{t('Server')}</h2>
      <div className="start-tiles">
        <button onClick={() => openVisual('perf')}><Icon name="perf" size={28} /><b>{t('Prestazioni')}</b><span>{t('Consigli sulla configurazione, query più pesanti, indici inutili o mancanti, analisi e ottimizzazione delle query')}</span></button>
        <button onClick={() => openVisual('procs')}><Icon name="procs" size={28} /><b>{t('Processi')}</b><span>{t('Connessioni e query in corso, transazioni aperte, chi blocca chi, ultimo deadlock; termina una o più connessioni')}</span></button>
        <button onClick={() => openVisual('monitor')}><Icon name="profile" size={28} /><b>{t('Monitor')}</b><span>{t('Grafici in tempo reale: query al secondo, connessioni, rete, buffer pool')}</span></button>
        <button onClick={() => openVisual('users')}><Icon name="key" size={28} /><b>{t('Utenti e privilegi')}</b><span>{t('Account, ruoli e permessi del server')}</span></button>
      </div>
      {conns.length > 0 && <>
        <h2>{t('Connessioni')}</h2>
        <div className="start-conns">
          {conns.map((c) => (
            <button key={c.id} onClick={() => { newDoc({ connId: c.id, db: c.database || null }); useStore.getState().openConn(c.id); }}>
              <Icon name="server" /> <b>{c.name}</b> <span>{c.socket || `${c.user}@${c.host}:${c.port}`}</span>
            </button>
          ))}
        </div>
      </>}
    </div>
  );
}

function StatusBar({ cursor }: { cursor: [number, number] }) {
  const doc = useStore((s) => s.docs.find((d) => d.id === s.activeDoc));
  const conn = useStore((s) => s.conns.find((c) => c.id === doc?.connId));
  const st = useStore((s) => (doc?.connId ? s.connState[doc.connId] : undefined));
  return (
    <div className="statusbar" style={conn?.color ? { background: conn.color } : undefined}>
      {conn ? <>
        <span className={`dot ${st?.status ?? 'closed'}`} />
        <span>{conn.name}</span>
        {st?.info && <span>{st.info.version}</span>}
        {st?.info && <span>{st.info.user}</span>}
        {doc?.db && <span>{doc.db}</span>}
      </> : <span>{t('Nessuna connessione')}</span>}
      <div className="spacer" />
      {doc?.kind === 'sql' && <span>Rg {cursor[0]}{t(', Col')}{' '}{cursor[1]}</span>}
    </div>
  );
}

export default function App() {
  const docs = useStore((s) => s.docs);
  const active = useStore((s) => s.docs.find((d) => d.id === s.activeDoc));
  const connDialog = useStore((s) => s.connDialog);
  const prompt = useStore((s) => s.passwordPrompt);
  const viewer = useStore((s) => s.viewer);
  const exporting = useStore((s) => s.exportDialog);
  const task = useStore((s) => s.task);
  const pickTarget = useStore((s) => s.pickTarget);
  const snippetDialog = useStore((s) => s.snippetDialog);
  const callDialog = useStore((s) => s.callDialog);
  const [cursor, setCursor] = useState<[number, number]>([1, 1]);
  const [side, startSide] = useDrag(300, 'x', 180, 'mibsql.side');
  const [bottom, startBottom] = useDrag(320, 'y', 80, 'mibsql.bottom');
  const [aiWidth, startAi] = useDrag(420, 'x', 300, 'mibsql.aiWidth', true);
  const assistantOpen = useStore((s) => s.assistantOpen);
  const ready = useRef(false);

  useEffect(() => {
    if (ready.current) return;
    ready.current = true;
    useStore.getState().loadConns().then(restore);
    loadSnippets().catch(() => {});
    api.file.onOpenArg(openSql);
    api.onCloseRequest(requestQuit);
  }, []);

  useEffect(() => {
    api.setTitle(active ? `${active.title}${active.dirty ? ' •' : ''} — MiB-SQL` : 'MiB-SQL');
  }, [active?.title, active?.dirty]);

  // Shortcuts in the capture phase so Monaco does not see them first (Ctrl+Enter, F5…).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.connDialog || s.passwordPrompt || s.exportDialog || s.viewer || s.task || s.pickTarget || s.snippetDialog || s.callDialog) return;
      // the grid has its own Ctrl+Maiusc+N (NULL) and text inputs keep their keys
      const t = e.target as HTMLElement;
      if (t.closest?.('.grid, .result-bar') && (t.tagName === 'INPUT' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n'))) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      const run = (fn: () => void) => { e.preventDefault(); e.stopPropagation(); fn(); };
      if (e.key === 'F5' && e.shiftKey) run(() => cancelDoc());
      else if (e.key === 'F5' || (ctrl && e.shiftKey && k === 'enter')) run(() => runDoc('all'));
      else if (ctrl && k === 'enter') run(() => runDoc('current'));
      else if (ctrl && k === 'e') run(() => runDoc('explain'));
      else if (ctrl && e.shiftKey && k === 'p') run(() => profileDoc());
      else if (ctrl && e.shiftKey && k === 'f') run(() => formatDoc());
      else if (ctrl && e.shiftKey && k === 'n') run(() => useStore.getState().set({ connDialog: { def: {} } }));
      else if (ctrl && k === 'n') run(() => newDoc());
      else if (ctrl && k === 'o') run(openFiles);
      else if (ctrl && k === 's') run(() => saveDoc(undefined, e.shiftKey));
      else if (ctrl && k === 'w') run(() => closeDoc());
      else if (ctrl && e.key === 'Tab') run(() => {
        const { docs: ds, activeDoc: a } = useStore.getState();
        if (ds.length < 2) return;
        const i = ds.findIndex((d) => d.id === a);
        useStore.getState().set({ activeDoc: ds[(i + (e.shiftKey ? -1 : 1) + ds.length) % ds.length].id });
      });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="app">
      <Toolbar />
      <div className="main">
        <div style={{ width: side }} className="side"><Explorer /></div>
        <div className="vsplit" onMouseDown={startSide} />
        <div className="work">
          <DocTabs />
          <div className="doc-row" style={{ display: active?.kind === 'sql' ? 'flex' : 'none' }}>
            <div className="doc-area" style={{ display: 'flex' }}>
              {active?.obj && <ObjectBar key={active.id} doc={active} />}
              <div className="editor-wrap"><SqlEditor onCursor={(l, c) => setCursor([l, c])} /></div>
              <div className="hsplit" onMouseDown={startBottom} />
              <div style={{ height: bottom }} className="bottom">{active?.kind === 'sql' && <ResultsPanel doc={active} />}</div>
            </div>
            {active?.kind === 'sql' && assistantOpen && <><div className="vsplit" onMouseDown={startAi} /><div style={{ width: aiWidth }} className="ai-side"><AssistantPanel key={active.id} doc={active} /></div></>}
          </div>
          {active?.kind === 'table' && <TableDesigner key={active.id} doc={active} />}
          {active?.kind === 'er' && <ErDiagram key={active.id} doc={active} />}
          {active?.kind === 'query' && <QueryBuilder key={active.id} doc={active} />}
          {active?.kind === 'compare' && <CompareView key={active.id} doc={active} />}
          {active?.kind === 'monitor' && <Monitor key={active.id} doc={active} />}
          {active?.kind === 'users' && <Users key={active.id} doc={active} />}
          {active?.kind === 'history' && <History key={active.id} doc={active} />}
          {active?.kind === 'maint' && <Maint key={active.id} doc={active} />}
          {active?.kind === 'procs' && <ProcessManager key={active.id} doc={active} />}
          {active?.kind === 'perf' && <Performance key={active.id} doc={active} />}
          {active?.kind === 'datagen' && <DataGenerator key={active.id} doc={active} />}
          {active?.kind === 'docgen' && <DocGenerator key={active.id} doc={active} />}
          {!docs.length && <StartPage />}
        </div>
      </div>
      <StatusBar cursor={cursor} />
      <ContextMenu />
      {connDialog && <ConnectionDialog key={connDialog.def.id ?? 'new'} />}
      {prompt && <PasswordPrompt key={prompt.conn.id + prompt.error} />}
      {viewer && <ValueViewer key={viewer.title + viewer.value.length} />}
      {exporting && <ExportDialog />}
      {pickTarget && <TargetDialog kind={pickTarget.kind} />}
      {snippetDialog && <SnippetsDialog body={snippetDialog.body} />}
      {callDialog && <CallDialog key={callDialog.name} {...callDialog} />}
      {task?.kind === 'backup' && task.db && <BackupDialog connId={task.connId} db={task.db} />}
      {task?.kind === 'restore' && <RestoreDialog connId={task.connId} db={task.db} />}
      {task?.kind === 'import' && task.db && <ImportWizard connId={task.connId} db={task.db} table={task.table} />}
    </div>
  );
}
