import { createContext, useContext, useState, type ReactNode } from 'react';
import { api } from '../api';
import { closeDoc, insertText, newDoc, openCompare, openDesigner, openEr, openQueryBuilder, qi, refreshExplorer, runDoc, selectTop, showDdl } from '../actions';
import { loadDatabases, metaKey, useStore, type MetaEntry } from '../store';
import type { ColumnInfo, ConnDef, DbObjects, ForeignKeyInfo, IndexInfo, ObjectKind } from '../types';
import { openMenu, type MenuItem } from './ContextMenu';
import Icon from './Icon';

const Tree = createContext<{ open: Set<string>; toggle: (k: string, v?: boolean) => void; filter: string }>({ open: new Set(), toggle: () => {}, filter: '' });

interface NodeProps {
  id: string;
  label: ReactNode;
  icon: string;
  depth: number;
  hint?: string;
  title?: string;
  leaf?: boolean;
  onExpand?: () => void;
  onDouble?: () => void;
  menu?: MenuItem[];
  drag?: string;
  dim?: boolean;
  children?: () => ReactNode;
}

function Node({ id, label, icon, depth, hint, title, leaf, onExpand, onDouble, menu, drag, dim, children }: NodeProps) {
  const { open, toggle } = useContext(Tree);
  const isOpen = !leaf && open.has(id);
  const flip = () => {
    if (leaf) return;
    if (!isOpen) onExpand?.();
    toggle(id);
  };
  return (
    <>
      <div className={`node${dim ? ' dim' : ''}`} style={{ paddingLeft: 4 + depth * 14 }} title={title}
        onClick={flip}
        onDoubleClick={(e) => { if (onDouble) { e.stopPropagation(); onDouble(); } }}
        onContextMenu={menu ? (e) => openMenu(e, menu) : undefined}
        draggable={!!drag}
        onDragStart={drag ? (e) => e.dataTransfer.setData('text/plain', drag) : undefined}>
        <span className={`twisty${leaf ? ' leaf' : ''}`}>{leaf ? '' : isOpen ? '▾' : '▸'}</span>
        <Icon name={icon} />
        <span className="label">{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </div>
      {isOpen && children?.()}
    </>
  );
}

function Status({ entry, depth, empty }: { entry?: MetaEntry; depth: number; empty?: boolean }) {
  const pad = { paddingLeft: 22 + depth * 14 };
  if (!entry || entry.loading) return <div className="node info" style={pad}>Caricamento…</div>;
  if (entry.error) return <div className="node info error" style={pad} title={entry.error}>{entry.error}</div>;
  if (empty) return <div className="node info" style={pad}>(vuoto)</div>;
  return null;
}

const copy = (s: string) => navigator.clipboard.writeText(s);

/** DROP / TRUNCATE after confirmation; designer tabs on a dropped table are closed. */
async function destroy(c: string, db: string, table: string, how: 'drop' | 'truncate') {
  const drop = how === 'drop';
  const ok = await api.confirm(drop ? `Eliminare la tabella ${db}.${table}?` : `Svuotare la tabella ${db}.${table}?`,
    drop ? 'La tabella e tutti i suoi dati verranno eliminati definitivamente.' : 'Tutte le righe verranno eliminate definitivamente (TRUNCATE).', [drop ? 'Elimina' : 'Svuota', 'Annulla']);
  if (ok !== 0) return;
  try {
    await api.ddl.run(c, [`${drop ? 'DROP' : 'TRUNCATE'} TABLE ${qi(db)}.${qi(table)}`]);
  } catch (err) {
    await api.confirm('Operazione non riuscita', (err as Error).message, ['OK']);
    return;
  }
  useStore.getState().dropMeta(`${c}/${db}/`);
  if (drop) {
    for (const d of useStore.getState().docs) if (d.kind === 'table' && d.connId === c && d.db === db && d.design?.table === table) { useStore.getState().updateDoc(d.id, { dirty: false }); await closeDoc(d.id); }
  }
}

function TableChildren({ c, db, t, depth, view }: { c: string; db: string; t: string; depth: number; view: boolean }) {
  const meta = useStore((s) => s.meta);
  const cols = meta[metaKey.columns(c, db, t)] as MetaEntry<ColumnInfo[]> | undefined;
  const idx = meta[metaKey.indexes(c, db, t)] as MetaEntry<IndexInfo[]> | undefined;
  const fks = meta[metaKey.foreignKeys(c, db, t)] as MetaEntry<ForeignKeyInfo[]> | undefined;
  const load = useStore((s) => s.loadMeta);
  const base = `${c}/${db}/t/${t}`;
  return (
    <>
      <Node id={`${base}/cols`} label="Colonne" icon="folder" depth={depth} onExpand={() => load(metaKey.columns(c, db, t), () => api.meta.columns(c, db, t))}>
        {() => cols?.data ? cols.data.map((col) => (
          <Node key={col.name} id={`${base}/c/${col.name}`} leaf depth={depth + 1} icon={col.key === 'PRI' ? 'key' : 'column'}
            label={col.name} hint={`${col.type}${col.nullable ? '' : ' NOT NULL'}`}
            title={[col.extra, col.def !== null ? `DEFAULT ${col.def}` : '', col.comment].filter(Boolean).join('\n') || undefined}
            drag={qi(col.name)} onDouble={() => insertText(qi(col.name))}
            menu={[{ label: 'Copia nome', action: () => copy(col.name) }, { label: 'Inserisci nell\'editor', action: () => insertText(qi(col.name)) }]} />
        )) : <Status entry={cols} depth={depth + 1} />}
      </Node>
      {!view && <>
        <Node id={`${base}/idx`} label="Indici" icon="folder" depth={depth} onExpand={() => load(metaKey.indexes(c, db, t), () => api.meta.indexes(c, db, t))}>
          {() => idx?.data ? (idx.data.length ? idx.data.map((ix) => (
            <Node key={ix.name} id={`${base}/i/${ix.name}`} leaf depth={depth + 1} icon={ix.primary ? 'key' : 'index'} label={ix.name}
              hint={`${ix.unique && !ix.primary ? 'UNIQUE ' : ''}(${ix.columns.join(', ')})`} menu={[{ label: 'Copia nome', action: () => copy(ix.name) }]} />
          )) : <Status entry={idx} depth={depth + 1} empty />) : <Status entry={idx} depth={depth + 1} />}
        </Node>
        <Node id={`${base}/fk`} label="Chiavi esterne" icon="folder" depth={depth} onExpand={() => load(metaKey.foreignKeys(c, db, t), () => api.meta.foreignKeys(c, db, t))}>
          {() => fks?.data ? (fks.data.length ? fks.data.map((fk) => (
            <Node key={fk.name} id={`${base}/f/${fk.name}`} leaf depth={depth + 1} icon="fk" label={fk.name}
              hint={`(${fk.columns.join(', ')}) → ${fk.refDb !== db ? fk.refDb + '.' : ''}${fk.refTable}(${fk.refColumns.join(', ')})`}
              title={`ON DELETE ${fk.onDelete}\nON UPDATE ${fk.onUpdate}`}
              menu={[{ label: 'Copia nome', action: () => copy(fk.name) }, { label: `Seleziona da ${fk.refTable}`, action: () => selectTop(c, fk.refDb, fk.refTable) }]} />
          )) : <Status entry={fks} depth={depth + 1} empty />) : <Status entry={fks} depth={depth + 1} />}
        </Node>
      </>}
    </>
  );
}

const FOLDERS: { key: keyof DbObjects; label: string; icon: string; kind: ObjectKind }[] = [
  { key: 'tables', label: 'Tabelle', icon: 'table', kind: 'table' },
  { key: 'views', label: 'Viste', icon: 'view', kind: 'view' },
  { key: 'procedures', label: 'Procedure', icon: 'procedure', kind: 'procedure' },
  { key: 'functions', label: 'Funzioni', icon: 'function', kind: 'function' },
  { key: 'triggers', label: 'Trigger', icon: 'trigger', kind: 'trigger' },
  { key: 'events', label: 'Eventi', icon: 'event', kind: 'event' },
];

function DbChildren({ c, db, depth }: { c: string; db: string; depth: number }) {
  const entry = useStore((s) => s.meta[metaKey.objects(c, db)]) as MetaEntry<DbObjects> | undefined;
  const { filter } = useContext(Tree);
  if (!entry?.data) return <Status entry={entry} depth={depth} />;
  const f = filter.toLowerCase();
  return (
    <>
      {FOLDERS.map((F) => {
        const items = (entry.data![F.key] as { name: string }[]).filter((o) => !f || o.name.toLowerCase().includes(f));
        return (
          <Node key={F.key} id={`${c}/${db}/${F.key}`} label={F.label} icon="folder" depth={depth} hint={String(items.length)}
            menu={F.kind === 'table' ? [{ label: 'Nuova tabella…', action: () => openDesigner(c, db, null) }] : undefined}>
            {() => items.length ? items.map((o) => {
              const qn = `${qi(db)}.${qi(o.name)}`;
              const common: MenuItem[] = [
                { label: 'Mostra DDL', action: () => showDdl(c, db, F.kind, o.name) },
                { label: 'Copia nome', action: () => copy(o.name) },
                { label: 'Inserisci nell\'editor', action: () => insertText(qn) },
              ];
              const id = `${c}/${db}/${F.key}/${o.name}`;
              if (F.kind === 'table' || F.kind === 'view') {
                const t = o as DbObjects['tables'][number];
                return (
                  <Node key={o.name} id={id} label={o.name} icon={F.icon} depth={depth + 1} drag={qn}
                    hint={t.rows !== null && t.rows !== undefined ? `~${t.rows.toLocaleString('it-IT')}` : undefined}
                    title={t.comment || undefined}
                    onDouble={() => selectTop(c, db, o.name)}
                    menu={[
                      { label: F.kind === 'table' ? 'Modifica dati (prime 1000 righe)' : 'Seleziona prime 1000 righe', action: () => selectTop(c, db, o.name) },
                      { label: 'Esporta dati…', action: () => useStore.getState().set({ exportDialog: { name: o.name, table: o.name, db, query: { connId: c, db, sql: `SELECT * FROM ${qn}` } } }) },
                      { label: 'Conta righe', action: () => runDoc('all', newDoc({ connId: c, db, sql: `SELECT COUNT(*) FROM ${qn};\n` }).id) },
                      ...(F.kind === 'table' ? [
                        { label: 'Modifica tabella…', action: () => openDesigner(c, db, o.name) },
                        'sep' as const,
                        { label: 'Svuota tabella…', danger: true, action: () => destroy(c, db, o.name, 'truncate') },
                        { label: 'Elimina tabella…', danger: true, action: () => destroy(c, db, o.name, 'drop') },
                      ] : []),
                      'sep', ...common,
                    ]}>
                    {() => <TableChildren c={c} db={db} t={o.name} depth={depth + 2} view={F.kind === 'view'} />}
                  </Node>
                );
              }
              const extra: MenuItem[] = F.kind === 'procedure' ? [{ label: 'Genera CALL', action: () => newDoc({ connId: c, db, sql: `CALL ${qn}();\n` }) }, 'sep'] : [];
              const hint = F.kind === 'trigger' ? `${(o as DbObjects['triggers'][number]).timing} ${(o as DbObjects['triggers'][number]).event} ${(o as DbObjects['triggers'][number]).table}`
                : F.kind === 'event' ? (o as DbObjects['events'][number]).status : undefined;
              return <Node key={o.name} id={id} leaf label={o.name} icon={F.icon} depth={depth + 1} hint={hint} drag={qn}
                onDouble={() => showDdl(c, db, F.kind, o.name)} menu={[...extra, ...common]} />;
            }) : <Status entry={entry} depth={depth + 1} empty />}
          </Node>
        );
      })}
    </>
  );
}

const SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function ConnNode({ conn }: { conn: ConnDef }) {
  const s = useStore();
  const state = s.connState[conn.id]?.status ?? 'closed';
  const dbs = s.meta[metaKey.databases(conn.id)] as MetaEntry<string[]> | undefined;
  const { toggle } = useContext(Tree);
  const load = s.loadMeta;

  const connect = async () => {
    s.set({ selectedConn: conn.id });
    if (state !== 'open' && !(await s.openConn(conn.id))) return false;
    loadDatabases(conn.id);
    return true;
  };
  const expandDb = (db: string) => load(metaKey.objects(conn.id, db), () => api.meta.objects(conn.id, db));
  const disconnect = () => { s.closeConn(conn.id); toggle(conn.id, false); };
  const remove = async () => {
    if ((await api.confirm(`Eliminare la connessione «${conn.name}»?`, 'La password salvata verrà rimossa dal portachiavi.', ['Elimina', 'Annulla'])) !== 0) return;
    await api.conn.remove(conn.id);
    await s.loadConns();
  };
  const menu: MenuItem[] = [
    state === 'open' ? { label: 'Disconnetti', action: disconnect } : { label: 'Connetti', action: () => { connect().then((ok) => ok && toggle(conn.id, true)); } },
    { label: 'Nuovo SQL', action: () => newDoc({ connId: conn.id, db: conn.database || null }) },
    { label: 'Aggiorna', action: () => { refreshExplorer(conn.id); if (state === 'open') loadDatabases(conn.id, true); }, disabled: state !== 'open' },
    'sep',
    { label: 'Modifica connessione…', action: () => s.set({ connDialog: { def: conn } }) },
    { label: 'Duplica', action: () => s.set({ connDialog: { def: { ...conn, id: undefined, name: `${conn.name} (copia)` } } }) },
    { label: 'Elimina', danger: true, action: remove },
  ];
  const info = s.connState[conn.id]?.info;
  const err = s.connState[conn.id]?.error;
  const where = conn.socket ? conn.socket : `${conn.user}@${conn.host}:${conn.port}${conn.ssh?.enabled ? ` via ${conn.ssh.host}` : ''}`;
  return (
    <Node id={conn.id} depth={0} icon="server"
      label={<><span className={`dot ${state}`} style={conn.color ? { outline: `2px solid ${conn.color}` } : undefined} />{conn.name}</>}
      hint={state === 'connecting' ? 'connessione…' : info ? info.version.split('-')[0] : undefined}
      title={`${where}${info ? `\n${info.version} (${info.user})` : ''}${err ? `\n${err}` : ''}`}
      onExpand={() => { connect().then((ok) => { if (!ok) toggle(conn.id, false); }); }}
      menu={menu}>
      {() => dbs?.data ? dbs.data.map((db) => (
        <Node key={db} id={`${conn.id}/${db}`} label={db} icon="database" depth={1} dim={SYSTEM_DBS.has(db)} drag={qi(db)}
          onExpand={() => expandDb(db)}
          menu={[
            { label: 'Nuovo SQL', action: () => newDoc({ connId: conn.id, db }) },
            { label: 'Nuova tabella…', action: () => openDesigner(conn.id, db, null) },
            { label: 'Diagramma ER', action: () => openEr(conn.id, db) },
            { label: 'Query Builder', action: () => openQueryBuilder(conn.id, db) },
            { label: 'Confronta con…', action: () => openCompare(conn.id, db) },
            { label: 'Aggiorna', action: () => { s.dropMeta(`${conn.id}/${db}/`); expandDb(db); } },
            { label: 'Copia nome', action: () => copy(db) },
          ]}>
          {() => <DbChildren c={conn.id} db={db} depth={2} />}
        </Node>
      )) : state === 'error' ? <Status entry={{ error: err }} depth={1} /> : <Status entry={dbs} depth={1} />}
    </Node>
  );
}

export default function Explorer() {
  const conns = useStore((s) => s.conns);
  const setStore = useStore((s) => s.set);
  const selected = useStore((s) => s.selectedConn);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const toggle = (k: string, v?: boolean) => setOpen((o) => {
    const n = new Set(o);
    if (v ?? !n.has(k)) n.add(k); else n.delete(k);
    return n;
  });

  return (
    <Tree.Provider value={{ open, toggle, filter }}>
      <div className="explorer">
        <div className="panel-title">
          Database Explorer
          <div className="spacer" />
          <button className="icon-btn" title="Nuova connessione" onClick={() => setStore({ connDialog: { def: {} } })}><Icon name="addConn" /></button>
          <button className="icon-btn" title="Aggiorna" disabled={!selected} onClick={() => { if (selected) { refreshExplorer(selected); loadDatabases(selected, true); } }}><Icon name="refresh" /></button>
        </div>
        <input className="filter" placeholder="Filtra oggetti…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="tree">
          {conns.length === 0 && (
            <div className="tree-empty">
              Nessuna connessione.
              <button onClick={() => setStore({ connDialog: { def: {} } })}>Nuova connessione…</button>
            </div>
          )}
          {conns.map((c) => <ConnNode key={c.id} conn={c} />)}
        </div>
      </div>
    </Tree.Provider>
  );
}
