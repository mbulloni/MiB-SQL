import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { cancelDoc, closeDoc, newDoc, openFiles, openSql, restore, runDoc, saveDoc, setDocTarget } from './actions';
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
import logo from '../build/icons/128x128.png';
import { onThemeChange, resolvedTheme, setThemePref, themePref, type ThemePref } from './theme';

function useDrag(initial: number, axis: 'x' | 'y', min: number, key: string) {
  const [size, setSize] = useState(() => Number(localStorage.getItem(key)) || initial);
  const start = (e: React.MouseEvent) => {
    e.preventDefault();
    const p0 = axis === 'x' ? e.clientX : e.clientY;
    const s0 = size;
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (ev: MouseEvent) => {
      const d = (axis === 'x' ? ev.clientX : ev.clientY) - p0;
      setSize(Math.max(min, axis === 'x' ? s0 + d : s0 - d));
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
      <select value={doc.connId ?? ''} title="Connessione"
        onChange={async (e) => {
          const id = e.target.value || null;
          await setDocTarget(doc.id, id, id ? (conns.find((c) => c.id === id)?.database || null) : null);
          if (id && useStore.getState().connState[id]?.status !== 'open') useStore.getState().openConn(id);
        }}>
        <option value="">(nessuna connessione)</option>
        {conns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value={doc.db ?? ''} title="Database" disabled={!doc.connId}
        onFocus={() => { if (doc.connId && state !== 'open') useStore.getState().openConn(doc.connId); }}
        onChange={(e) => setDocTarget(doc.id, doc.connId, e.target.value || null)}>
        <option value="">(nessun database)</option>
        {doc.db && !list.includes(doc.db) && <option value={doc.db}>{doc.db}</option>}
        {list.map((d) => <option key={d} value={d}>{d}</option>)}
      </select>
    </div>
  );
}

const THEME_LABEL: Record<ThemePref, string> = { light: 'Chiaro', dark: 'Scuro', system: 'Sistema' };

/** Light / dark / system switch at the end of the toolbar. */
function ThemeSwitch() {
  // external store: also follows changes made elsewhere (system theme, scripts) even before effects run
  const pref = useSyncExternalStore(onThemeChange, themePref);
  const next: Record<ThemePref, ThemePref> = { light: 'dark', dark: 'system', system: 'light' };
  const dark = resolvedTheme(pref) === 'dark';
  return (
    <button className="theme-switch" title={`Tema: ${THEME_LABEL[pref]} (clic: ${THEME_LABEL[next[pref]]})`}
      onClick={() => setThemePref(next[pref])}>
      <Icon name={dark ? 'moon' : 'sun'} /><span>{THEME_LABEL[pref]}</span>
    </button>
  );
}

function Toolbar() {
  const doc = useStore((s) => s.docs.find((d) => d.id === s.activeDoc));
  const set = useStore((s) => s.set);
  const running = !!doc?.running;
  const sql = doc?.kind === 'sql';
  const runnable = sql || doc?.kind === 'query';
  return (
    <div className="toolbar">
      <button title="Nuova connessione (Ctrl+Maiusc+N)" onClick={() => set({ connDialog: { def: {} } })}><Icon name="addConn" /></button>
      <div className="sep" />
      <button title="Nuovo SQL (Ctrl+N)" onClick={() => newDoc()}><Icon name="newSql" /><span>Nuovo SQL</span></button>
      <button title="Apri (Ctrl+O)" onClick={openFiles}><Icon name="open" /></button>
      <button title="Salva (Ctrl+S)" disabled={!sql} onClick={() => saveDoc()}><Icon name="save" /></button>
      <div className="sep" />
      <button title="Esegui script o selezione (F5)" disabled={!runnable || running} onClick={() => runDoc('all')}><Icon name="play" /><span>Esegui</span></button>
      <button title="Esegui istruzione corrente (Ctrl+Invio)" disabled={!runnable || running} onClick={() => runDoc('current')}><Icon name="playLine" /></button>
      <button title="Interrompi (Maiusc+F5)" disabled={!running} onClick={() => cancelDoc()}><Icon name="stop" /></button>
      <button title="Piano di esecuzione (Ctrl+E)" disabled={!runnable || running} onClick={() => runDoc('explain')}><Icon name="plan" /><span>Piano</span></button>
      <div className="sep" />
      {sql && <TargetPicker />}
      <div className="spacer" />
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
      <p>IDE per MariaDB e MySQL</p>
      <div className="start-actions">
        <button onClick={() => set({ connDialog: { def: {} } })}><Icon name="addConn" /> Nuova connessione</button>
        <button onClick={() => newDoc()}><Icon name="newSql" /> Nuovo SQL</button>
        <button onClick={openFiles}><Icon name="open" /> Apri script…</button>
      </div>
      {conns.length > 0 && <>
        <h2>Connessioni</h2>
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
      </> : <span>Nessuna connessione</span>}
      <div className="spacer" />
      {doc?.kind === 'sql' && <span>Rg {cursor[0]}, Col {cursor[1]}</span>}
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
  const [cursor, setCursor] = useState<[number, number]>([1, 1]);
  const [side, startSide] = useDrag(300, 'x', 180, 'mibsql.side');
  const [bottom, startBottom] = useDrag(320, 'y', 80, 'mibsql.bottom');
  const ready = useRef(false);

  useEffect(() => {
    if (ready.current) return;
    ready.current = true;
    useStore.getState().loadConns().then(restore);
    api.file.onOpenArg(openSql);
  }, []);

  useEffect(() => {
    api.setTitle(active ? `${active.title}${active.dirty ? ' •' : ''} — MiB-SQL` : 'MiB-SQL');
  }, [active?.title, active?.dirty]);

  // Shortcuts in the capture phase so Monaco does not see them first (Ctrl+Enter, F5…).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.connDialog || s.passwordPrompt || s.exportDialog || s.viewer || s.task) return;
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
          <div className="doc-area" style={{ display: active?.kind === 'sql' ? 'flex' : 'none' }}>
            <div className="editor-wrap"><SqlEditor onCursor={(l, c) => setCursor([l, c])} /></div>
            <div className="hsplit" onMouseDown={startBottom} />
            <div style={{ height: bottom }} className="bottom">{active?.kind === 'sql' && <ResultsPanel doc={active} />}</div>
          </div>
          {active?.kind === 'table' && <TableDesigner key={active.id} doc={active} />}
          {active?.kind === 'er' && <ErDiagram key={active.id} doc={active} />}
          {active?.kind === 'query' && <QueryBuilder key={active.id} doc={active} />}
          {active?.kind === 'compare' && <CompareView key={active.id} doc={active} />}
          {!docs.length && <StartPage />}
        </div>
      </div>
      <StatusBar cursor={cursor} />
      <ContextMenu />
      {connDialog && <ConnectionDialog key={connDialog.def.id ?? 'new'} />}
      {prompt && <PasswordPrompt key={prompt.conn.id + prompt.error} />}
      {viewer && <ValueViewer key={viewer.title + viewer.value.length} />}
      {exporting && <ExportDialog />}
      {task?.kind === 'backup' && task.db && <BackupDialog connId={task.connId} db={task.db} />}
      {task?.kind === 'restore' && <RestoreDialog connId={task.connId} db={task.db} />}
      {task?.kind === 'import' && task.db && <ImportWizard connId={task.connId} db={task.db} table={task.table} />}
    </div>
  );
}
