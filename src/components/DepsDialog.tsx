import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { newDoc, openDesigner, openObject, refreshExplorer } from '../actions';
import { renameColumnIn, renameColumnStatement, renameTableIn, routineCalls, tablesUsed, type DepWarning } from '../deps';
import { useStore, type DepsTarget } from '../store';
import { t } from '../i18n';
import type { EditableKind } from '../types';

type Found = Awaited<ReturnType<typeof api.deps.find>>;
type Obj = Found['objects'][number];
interface Dep extends Obj { ddl: string }
interface Step { label: string; ok?: boolean; error?: string }

const q = (s: string) => '`' + s.replace(/`/g, '``') + '`';
const KIND: Record<string, () => string> = {
  view: () => t('Vista'), procedure: () => t('Procedura'), function: () => t('Funzione'), trigger: () => t('Trigger'), event: () => t('Evento'),
  index: () => t('Indice'), generated: () => t('Colonna generata'), check: () => t('Vincolo CHECK'), fk: () => t('Chiave esterna'), table: () => t('Tabella'),
};

/** Dependencies / rename of an object; opened from the home page or the Tools menu it first asks which object. */
export default function DepsDialog(p: DepsTarget) {
  return p.name ? <DepsView {...p} /> : <DepsPicker {...p} />;
}

type PickKind = DepsTarget['kind'];
const LISTS: [PickKind, 'tables' | 'views' | 'procedures' | 'functions', () => string][] = [
  ['table', 'tables', () => t('Tabella')], ['view', 'views', () => t('Vista')], ['procedure', 'procedures', () => t('Procedura')], ['function', 'functions', () => t('Funzione')],
];

function DepsPicker({ connId, db }: DepsTarget) {
  const [objs, setObjs] = useState<Record<string, { name: string }[]> | null>(null);
  const [kind, setKind] = useState<PickKind>('table');
  const [name, setName] = useState('');
  const [cols, setCols] = useState<string[]>([]);
  const [column, setColumn] = useState('');
  const [mode, setMode] = useState<'deps' | 'rename'>('deps');
  const [error, setError] = useState<string | null>(null);
  const close = () => useStore.getState().set({ depsDialog: null });
  useEffect(() => { api.meta.objects(connId, db).then((o) => setObjs(o as unknown as Record<string, { name: string }[]>)).catch((e) => setError((e as Error).message)); }, []);
  useEffect(() => {
    setCols([]); setColumn('');
    if (name && (kind === 'table' || kind === 'view')) api.meta.columns(connId, db, name).then((c) => setCols(c.map((x) => x.name))).catch(() => {});
  }, [kind, name]);
  const list = objs ? objs[LISTS.find((l) => l[0] === kind)![1]] ?? [] : [];
  const canRename = kind === 'table' || (kind === 'view' && !column);
  const go = () => useStore.getState().set({ depsDialog: { connId, db, kind, name, column: column || undefined, mode: canRename ? mode : 'deps' } });
  return (
    <div className="modal-back" onMouseDown={close}>
      <form className="modal small" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') close(); }} onSubmit={(e) => { e.preventDefault(); if (name) go(); }}>
        <div className="modal-title">{t('Dipendenze e rinomina')}: {db}</div>
        <div className="form">
          {error && <div className="status error">{error}</div>}
          <label>{t('Tipo')}<select value={kind} onChange={(e) => { setKind(e.target.value as PickKind); setName(''); }}>{LISTS.map(([k, , l]) => <option key={k} value={k}>{l()}</option>)}</select></label>
          <label>{t('Oggetto')}<select value={name} autoFocus onChange={(e) => setName(e.target.value)} disabled={!objs}>
            <option value="">{objs ? t('(scegli)') : t('caricamento…')}</option>
            {list.map((o) => <option key={o.name}>{o.name}</option>)}
          </select></label>
          {(kind === 'table' || kind === 'view') && <label>{t('Colonna (facoltativa)')}<select value={column} onChange={(e) => setColumn(e.target.value)} disabled={!cols.length}>
            <option value="">{t('(tutta la tabella)')}</option>
            {cols.map((c) => <option key={c}>{c}</option>)}
          </select></label>}
          <label>{t('Operazione')}<select value={canRename ? mode : 'deps'} disabled={!canRename} onChange={(e) => setMode(e.target.value as 'deps' | 'rename')}>
            <option value="deps">{t('Mostra le dipendenze')}</option>
            {canRename && <option value="rename">{t('Rinomina')}</option>}
          </select></label>
        </div>
        <div className="modal-buttons">
          <div className="spacer" />
          <button type="button" onClick={close}>{t('Annulla')}</button>
          <button type="submit" className="primary" disabled={!name}>{t('Apri')}</button>
        </div>
      </form>
    </div>
  );
}

/** Who uses a table, view, column or routine (and what a view or routine uses); safe rename of tables, views and columns. */
function DepsView({ connId, db, kind, name, column, mode }: DepsTarget) {
  const [found, setFound] = useState<Found | null>(null);
  const [deps, setDeps] = useState<Dep[]>([]);
  const [uses, setUses] = useState<{ db: string; name: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState(column ?? name);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => useStore.getState().set({ depsDialog: null });
  const rename = mode === 'rename';
  const isRoutine = kind === 'procedure' || kind === 'function';
  const what = column ? `${name}.${column}` : name;

  // Rewrite of one object for a given new name (dry run with a placeholder to confirm the dependency).
  const rewrite = (d: Obj & { ddl: string }, to: string) => (column
    ? renameColumnIn(d.ddl, d.db, { db, table: name, column }, to, !!d.onTarget)
    : renameTableIn(d.ddl, d.db, { db, table: name }, to));

  useEffect(() => {
    (async () => {
      const f = await api.deps.find(connId, { db, name, kind, column });
      const out: Dep[] = [];
      for (const o of f.objects) {
        if (!o.readable) { out.push({ ...o, ddl: '' }); continue; }
        const ddl = await api.meta.ddl(connId, o.db, o.kind, o.name).catch(() => '');
        if (!ddl) { out.push({ ...o, readable: false, ddl: '' }); continue; }
        const d = { ...o, ddl };
        const hit = isRoutine ? routineCalls(ddl, o.db, { db, name }) > 0
          : o.onTarget || ((r) => r.changes + r.warnings.length > 0)(rewrite(d, '\u0000mibsql'));
        if (hit) out.push(d);
      }
      setFound(f);
      setDeps(out);
      if (kind === 'view' || isRoutine) {
        const own = await api.meta.ddl(connId, db, kind, name).catch(() => '');
        const objs = await api.meta.objects(connId, db);
        const known = [...objs.tables, ...objs.views].map((o) => ({ db, name: o.name }));
        setUses(own ? tablesUsed(own, db, known) : []);
      }
    })().catch((err) => setError((err as Error).message));
  }, []);

  // Rename plan: the statement on the object itself, then every dependent object rewritten.
  const plan = useMemo(() => {
    if (!rename || !found || !newName || newName === (column ?? name)) return null;
    const first = column
      ? renameColumnStatement(db, name, column, newName, found.version, found.definition ?? undefined)
      : `RENAME TABLE ${q(db)}.${q(name)} TO ${q(db)}.${q(newName)}`;
    const objs = deps.filter((d) => d.readable).map((d) => ({ d, r: rewrite(d, newName) }));
    return { first, objs };
  }, [found, deps, newName]);

  const warnings: { obj: string; w: DepWarning }[] = plan ? plan.objs.flatMap(({ d, r }) => r.warnings.map((w) => ({ obj: `${d.db}.${d.name}`, w }))) : [];
  const unreadable = deps.filter((d) => !d.readable);
  const manualExtras = found?.extras.filter((x) => !x.auto) ?? [];

  const script = () => {
    if (!plan) return '';
    const lines = [`-- ${t('Rinomina {0} in {1}', what, newName)}`, `${plan.first};`, ''];
    for (const { d, r } of plan.objs) {
      if (!r.changes) continue;
      lines.push(`-- ${KIND[d.kind]()} ${d.db}.${d.name}: ${t('{0} riferimenti aggiornati', r.changes)}`, `USE ${q(d.db)};`);
      if (d.kind === 'view') lines.push(r.text.replace(/^(\s*)CREATE\s+/i, '$1CREATE OR REPLACE '));
      else lines.push(`DROP ${d.kind.toUpperCase()} IF EXISTS ${q(d.db)}.${q(d.name)};`, r.text);
      lines.push('');
    }
    return lines.join('\n');
  };

  const run = async () => {
    if (!plan) return;
    setBusy(true);
    const log: Step[] = [{ label: plan.first }];
    setSteps([...log]);
    try {
      await api.ddl.run(connId, [plan.first]);
      log[0].ok = true;
    } catch (err) {
      log[0].ok = false; log[0].error = (err as Error).message;
      setSteps([...log]); setBusy(false); return;
    }
    for (const { d, r } of plan.objs) {
      if (!r.changes) continue;
      const s: Step = { label: `${KIND[d.kind]()} ${d.db}.${d.name}` };
      log.push(s);
      setSteps([...log]);
      try { await api.objects.apply(connId, d.db, d.kind as EditableKind, d.name, r.text); s.ok = true; } catch (err) { s.ok = false; s.error = (err as Error).message; }
      setSteps([...log]);
    }
    refreshExplorer(connId);
    setBusy(false);
  };

  const open = (k: string, odb: string, oname: string) => {
    close();
    if (k === 'table') openDesigner(connId, odb, oname);
    else openObject(connId, odb, k as EditableKind, oname);
  };
  const done = steps && !busy;
  const failed = steps?.some((s) => s.ok === false);

  return (
    <div className="modal-back" onMouseDown={close}>
      <form className="modal deps" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}
        onSubmit={(e) => { e.preventDefault(); if (rename && plan && !steps) run(); }}>
        <div className="modal-title">{rename ? t('Rinomina') : t('Dipendenze di')}{' '}<code>{db}.{what}</code></div>
        <div className="form">
          {error && <div className="status error">{error}</div>}
          {!found && !error && <p className="note">{t('Ricerca delle dipendenze…')}</p>}
          {rename && found && !steps && (
            <label className="row">{t('Nuovo nome')}<input autoFocus value={newName} onChange={(e) => setNewName(e.target.value.trim())} /></label>
          )}
          {found && !steps && <>
            <div className="props-title">{t('Usato da')}</div>
            {!found.fks.length && !deps.length && !manualExtras.length && <p className="note">{t('Nessun oggetto usa {0}.', what)}</p>}
            <table className="dtable">
              <tbody>
                {found.fks.map((fk) => (
                  <tr key={`fk/${fk.db}/${fk.table}/${fk.name}`}>
                    <td>{KIND.fk()}</td>
                    <td><a href="#" onClick={(e) => { e.preventDefault(); open('table', fk.db, fk.table); }}>{fk.db}.{fk.table}</a> <span className="muted">{fk.name} ({fk.columns.join(', ')})</span></td>
                    <td className="muted">{rename ? t('aggiornata dal server') : ''}</td>
                  </tr>
                ))}
                {deps.filter((d) => d.readable).map((d) => {
                  const r = plan?.objs.find((x) => x.d === d)?.r;
                  return (
                    <tr key={`${d.kind}/${d.db}/${d.name}`}>
                      <td>{KIND[d.kind]()}</td>
                      <td><a href="#" onClick={(e) => { e.preventDefault(); open(d.kind, d.db, d.name); }}>{d.db}.{d.name}</a>{d.table && <span className="muted"> {t('su')} {d.table}</span>}</td>
                      <td className="muted">{r ? (r.changes ? t('{0} riferimenti da aggiornare', r.changes) : t('nessuna modifica certa')) + (r.warnings.length ? ` · ${t('{0} da verificare', r.warnings.length)}` : '') : ''}</td>
                    </tr>
                  );
                })}
                {(found.extras).map((x) => (
                  <tr key={`x/${x.kind}/${x.name}`}>
                    <td>{KIND[x.kind]()}</td>
                    <td><code>{x.name}</code>{x.text && <span className="muted"> {x.text}</span>}</td>
                    <td className="muted">{x.auto ? t('aggiornato dal server') : t('da verificare dopo')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {unreadable.length > 0 && <div className="status error">{t('Codice non leggibile con questo account (definer diverso o privilegi insufficienti): {0}', unreadable.map((d) => `${d.db}.${d.name}`).join(', '))}</div>}
            {uses && <>
              <div className="props-title">{t('Usa')}</div>
              {uses.length ? <p>{uses.map((u, i) => <span key={u.name}>{i ? ', ' : ''}<a href="#" onClick={(e) => { e.preventDefault(); open('table', u.db, u.name); }}>{u.name}</a></span>)}</p>
                : <p className="note">{t('Nessuna tabella o vista dello stesso database.')}</p>}
            </>}
            {rename && warnings.length > 0 && <>
              <div className="props-title">{t('Da verificare a mano')}</div>
              <ul className="deps-warn">{warnings.map(({ obj, w }, i) => <li key={i}><code>{obj}</code> {t('riga')} {w.line}: {w.text}</li>)}</ul>
            </>}
            {rename && plan && <><div className="props-title">{t('Script')}</div><pre className="hist-sql">{script()}</pre>
              <p className="note">{t('Le istruzioni DDL non sono transazionali: se un passo fallisce, quelli precedenti restano applicati.')}</p></>}
          </>}
          {steps && <>
            <div className="props-title">{t('Esecuzione')}</div>
            <ul className="deps-steps">{steps.map((s, i) => <li key={i} className={s.ok === false ? 'error' : s.ok ? 'ok' : ''}>{s.ok === undefined ? '…' : s.ok ? '✓' : '✗'} {s.label}{s.error && <div className="status error">{s.error}</div>}</li>)}</ul>
            {done && <p className="note">{failed ? t('Alcuni passi non sono riusciti: correggi gli oggetti indicati dall\'editor.') : t('Rinomina completata.')}</p>}
          </>}
        </div>
        <div className="modal-buttons">
          <div className="spacer" />
          <button type="button" onClick={close} disabled={busy}>{done || !rename ? t('Chiudi') : t('Annulla')}</button>
          {rename && !steps && <button type="button" disabled={!plan} onClick={() => { close(); newDoc({ connId, db, sql: script(), title: t('rinomina-{0}.sql', what) }); }}>{t('Apri come script')}</button>}
          {rename && !steps && <button type="submit" className="primary" disabled={!plan}>{t('Rinomina')}</button>}
        </div>
      </form>
    </div>
  );
}
