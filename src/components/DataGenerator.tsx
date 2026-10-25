import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { newDoc, persist } from '../actions';
import { columnsOf, compositeKeys, generator, guess, insertOrder, insertParams, insertSql, KINDS, literal, type ColSpec, type GenColumn, type GenKind, type GenSettings, type Value } from '../datagen';
import type { ServerTable } from '../design';
import { getLang, locale, t, tn } from '../i18n';
import { useStore } from '../store';
import type { Doc } from '../types';

type Table = ServerTable & { rows: number | null };
const fmt = (n: number) => n.toLocaleString(locale());
const DEFAULT_ROWS = 100;
const MAX_PARAMS = 60000; // placeholders per INSERT (the protocol allows 65535)
const SCRIPT_LIMIT = 200000;

type Entry = GenSettings['tables'][string];
const entry = (s: GenSettings, name: string): Entry => s.tables[name] ?? { on: false, rows: DEFAULT_ROWS, specs: {} };
const defaults = (): GenSettings => ({ seed: Math.floor(Math.random() * 100000), lang: getLang(), clear: 'none', sel: null, tables: {} });

/** Options of one generator, inline in the column row. */
function SpecOptions({ c, spec, set, mysql }: { c: GenColumn; spec: ColSpec; set: (p: Partial<ColSpec>) => void; mysql: boolean }) {
  const num = (k: keyof ColSpec, label: string, step = 1) => (
    <label>{label}<input type="number" step={step} value={(spec[k] as number | undefined) ?? ''} onChange={(e) => set({ [k]: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>
  );
  const text = (k: keyof ColSpec, label: string, placeholder = '') => (
    <label className="grow">{label}<input value={(spec[k] as string | undefined) ?? ''} placeholder={placeholder} onChange={(e) => set({ [k]: e.target.value })} /></label>
  );
  switch (spec.kind) {
    case 'int': case 'year': return <>{num('min', t('da'))}{num('max', t('a'))}</>;
    case 'decimal': return <>{num('min', t('da'), 0.01)}{num('max', t('a'), 0.01)}{num('scale', t('decimali'))}</>;
    case 'sequence': return <>{num('start', t('inizio'))}{num('step', t('passo'))}</>;
    case 'bool': return num('truePct', t('% di 1'));
    case 'date': case 'datetime': return <>
      <label>{t('dal')}<input type="date" value={spec.from ?? ''} onChange={(e) => set({ from: e.target.value })} /></label>
      <label>{t('al')}<input type="date" value={spec.to ?? ''} onChange={(e) => set({ to: e.target.value })} /></label></>;
    case 'words': case 'text': return <>{num('min', t('parole da'))}{num('max', t('a'))}</>;
    case 'hex': return <>{num('min', t('byte da'))}{num('max', t('a'))}</>;
    case 'fixed': return text('value', t('valore'));
    case 'expr': return text('value', t('espressione'), mysql ? 'NOW()' : 'NOW() - INTERVAL RAND() * 30 DAY');
    case 'pattern': return text('value', t('modello'), 'ABC-####');
    case 'list': return <label className="grow">{t('valori (uno per riga o separati da virgola)')}<textarea rows={2} value={spec.value ?? ''} onChange={(e) => set({ value: e.target.value })} /></label>;
    case 'fk': return <span className="muted">{c.fk ? `→ ${c.fk.table}.${c.fk.column}${c.fk.group ? ` (${t('chiave composta {0}', c.fk.group)})` : ''}` : t('nessuna chiave esterna su questa colonna')}</span>;
    default: return null;
  }
}

const cellText = (v: Value) => (v === null ? 'NULL' : typeof v === 'object' ? ('hex' in v ? `0x${v.hex.slice(0, 16)}${v.hex.length > 16 ? '…' : ''}` : v.sql) : String(v));

/** Test data generator for a database: tables and row counts, a generator per column, preview, script or direct insert. */
export default function DataGenerator({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const db = doc.db!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const mysql = useStore((s) => !/mariadb/i.test(s.connState[connId]?.info?.version ?? 'mariadb'));
  const [tables, setTables] = useState<Table[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ table: string; columns: string[]; rows: Value[][] } | null>(null);
  const [progress, setProgress] = useState<{ table: string; done: number; total: number; all: number; allTotal: number; t0: number } | null>(null);
  const [filter, setFilter] = useState('');
  const stop = useRef(false);
  const g: GenSettings = doc.datagen ?? defaults();
  const update = (fn: (s: GenSettings) => GenSettings) => { useStore.getState().updateDoc(doc.id, (d) => ({ datagen: fn(d.datagen ?? g) })); persist(); };

  const load = () => api.datagen.tables(connId, db).then(setTables).catch((err) => setError((err as Error).message));
  useEffect(() => { if (!connOpen) { useStore.getState().openConn(connId); return; } load(); }, [connOpen]);
  useEffect(() => { if (!doc.datagen) update(() => g); }, []);

  const colsOf = useMemo(() => new Map((tables ?? []).map((tb) => [tb.name, columnsOf(tb)])), [tables]);
  const specsOf = (name: string) => {
    const saved = g.tables[name]?.specs ?? {};
    return Object.fromEntries((colsOf.get(name) ?? []).map((c) => [c.name, saved[c.name] ?? guess(c)]));
  };
  const chosen = Object.entries(g.tables).filter(([n, x]) => x.on && colsOf.has(n)).map(([n]) => n);
  const plan = useMemo(() => insertOrder(tables ?? [], chosen), [tables, chosen.join()]);
  const sel = g.sel && colsOf.has(g.sel) ? g.sel : chosen[0] ?? tables?.[0]?.name ?? null;
  const selCols = sel ? colsOf.get(sel) ?? [] : [];
  const selSpecs = sel ? specsOf(sel) : {};
  const totalRows = chosen.reduce((n, x) => n + (g.tables[x]?.rows ?? 0), 0);

  const setTable = (name: string, p: Partial<Entry>) => update((s) => ({ ...s, tables: { ...s.tables, [name]: { ...entry(s, name), ...p } } }));
  const setSpec = (col: string, p: Partial<ColSpec>, replace = false) => sel && update((s) => {
    const cur = entry(s, sel);
    const base = replace ? {} : specsOf(sel)[col];
    return { ...s, tables: { ...s.tables, [sel]: { ...cur, specs: { ...specsOf(sel), ...cur.specs, [col]: { ...base, ...p } as ColSpec } } } };
  });
  const changeKind = (c: GenColumn, kind: GenKind) => {
    const guessed = guess(c);
    setSpec(c.name, guessed.kind === kind ? guessed : { kind, nullPct: guessed.nullPct ?? 0, ...(kind === 'list' && guessed.value ? { value: guessed.value } : {}) }, true);
  };

  /** Values the generator needs from the server for one table: parents' keys, values already in unique columns. */
  const contextFor = async (name: string, withExisting: boolean) => {
    const cols = colsOf.get(name) ?? [];
    const specs = specsOf(name);
    const fkValues: Record<string, (string | number)[]> = {};
    const existing: Record<string, Set<string>> = {};
    const fkTuples: Record<string, (string | number | null)[][]> = {};
    const def = (tables ?? []).find((x) => x.name === name);
    for (const c of cols) {
      if (specs[c.name]?.kind === 'fk' && c.fk?.group && !fkTuples[c.fk.group]) {
        const fk = def?.foreignKeys.find((f) => f.name === c.fk!.group);
        if (fk) fkTuples[c.fk.group] = await api.datagen.rowsOf(connId, db, fk.refTable, fk.refColumns);
      } else if (specs[c.name]?.kind === 'fk' && c.fk) fkValues[c.name] = await api.datagen.values(connId, db, c.fk.table, c.fk.column, 50000);
      if (withExisting && c.unique && specs[c.name]?.kind !== 'skip') existing[c.name] = new Set((await api.datagen.values(connId, db, name, c.name, 200000)).map(String));
    }
    // adding to existing rows: a different stream each time, so the same seed does not repeat the rows already there
    const before = withExisting ? (await api.datagen.counts(connId, db, [name]))[name] : 0;
    const keys = compositeKeys((tables ?? []).find((x) => x.name === name)!);
    const existingKeys = withExisting && before ? await Promise.all(keys.map(async (k) => new Set(await api.datagen.tuples(connId, db, name, k)))) : [];
    return { seed: g.seed + before, lang: g.lang, table: name, fkValues, fkTuples, existing, keys, existingKeys };
  };

  const doPreview = async () => {
    if (!sel) return;
    try {
      const gen = generator(selCols, selSpecs, await contextFor(sel, true));
      setPreview({ table: sel, columns: gen.columns, rows: Array.from({ length: 12 }, () => gen.next()).filter((r): r is Value[] => !!r) });
      setError(null);
    } catch (err) { setError((err as Error).message); }
  };

  const doScript = async () => {
    if (!chosen.length) return;
    if (totalRows > SCRIPT_LIMIT) { setError(t('Lo script è limitato a {0} righe: per quantità maggiori usa «Genera e inserisci».', fmt(SCRIPT_LIMIT))); return; }
    try {
      const parts = [`-- ${t('Dati di test generati da MiB-SQL per {0} (seme {1})', db, g.seed)}`, `-- ${t('Ordine: {0}', plan.order.join(' → '))}`, ''];
      if (g.clear !== 'none') {
        parts.push('SET FOREIGN_KEY_CHECKS = 0;');
        for (const n of [...plan.order].reverse()) parts.push(`${g.clear === 'truncate' ? 'TRUNCATE TABLE' : 'DELETE FROM'} \`${n.replace(/`/g, '``')}\`;`);
        parts.push('SET FOREIGN_KEY_CHECKS = 1;', '');
      }
      for (const n of plan.order) {
        const gen = generator(colsOf.get(n)!, specsOf(n), await contextFor(n, g.clear === 'none'));
        const count = g.tables[n].rows;
        parts.push(`-- ${n}: ${tn(count, '{0} riga', '{0} righe')}`);
        for (let done = 0; done < count; done += 100) {
          const rows = Array.from({ length: Math.min(100, count - done) }, () => gen.next()).filter((r): r is Value[] => !!r);
          if (rows.length) parts.push(insertSql(n, gen.columns, rows));
        }
        if (gen.skipped) parts.push(`-- ${t('{0}: {1} righe non generate (combinazioni della chiave unica esaurite)', n, gen.skipped)}`);
        parts.push('');
      }
      newDoc({ connId, db, sql: parts.join('\n'), title: `${t('dati')}_${db}.sql` });
      setNotice(t('Script aperto in un nuovo documento. Le chiavi esterne usano i valori già presenti nel database: per tabelle collegate ancora vuote usa «Genera e inserisci».'));
    } catch (err) { setError((err as Error).message); }
  };

  const doInsert = async () => {
    if (!chosen.length) return;
    const lines = plan.order.map((n) => `${n}: ${fmt(g.tables[n].rows)}`).join('\n');
    const clear = g.clear === 'none' ? '' : `\n\n${g.clear === 'truncate' ? t('Le tabelle vengono prima svuotate con TRUNCATE (azzera anche AUTO_INCREMENT).') : t('Le tabelle vengono prima svuotate con DELETE.')} ${t('I dati attuali andranno persi.')}`;
    if ((await api.confirm(t('Inserire {0} righe di test in {1}?', fmt(totalRows), db), `${lines}${clear}`, [t('Inserisci'), t('Annulla')])) !== 0) return;
    stop.current = false;
    setError(null);
    setNotice(null);
    const t0 = Date.now();
    let all = 0;
    const done: string[] = [];
    const skippedNote: string[] = [];
    try {
      if (g.clear !== 'none') await api.datagen.clear(connId, db, [...plan.order].reverse(), g.clear === 'truncate');
      for (const n of plan.order) {
        const cols = colsOf.get(n)!;
        const gen = generator(cols, specsOf(n), await contextFor(n, true));
        const count = g.tables[n].rows;
        const per = Math.max(1, Math.min(1000, Math.floor(MAX_PARAMS / Math.max(1, gen.columns.length))));
        for (let k = 0; k < count && !stop.current; k += per) {
          const rows = Array.from({ length: Math.min(per, count - k) }, () => gen.next()).filter((r): r is Value[] => !!r);
          if (!rows.length) continue;
          const ins = gen.columns.length ? insertParams(n, gen.columns, rows, db) : { sql: `INSERT INTO \`${db.replace(/`/g, '``')}\`.\`${n.replace(/`/g, '``')}\` () VALUES ${rows.map(() => '()').join(', ')}`, params: [] };
          await api.data.apply(connId, [{ sql: ins.sql, params: ins.params as (string | number | null)[] }]);
          all += rows.length;
          setProgress({ table: n, done: k + rows.length, total: count, all, allTotal: totalRows, t0 });
        }
        if (stop.current) break;
        if (gen.skipped) skippedNote.push(t('{0}: {1} righe non generate (combinazioni della chiave unica esaurite)', n, gen.skipped));
        done.push(n);
      }
      const counts = await api.datagen.counts(connId, db, plan.order);
      const secs = (Date.now() - t0) / 1000;
      setNotice(`${stop.current ? t('Interrotto.') : t('Completato.')} ${(secs < 1 ? t('{0} righe inserite in {1} ms', fmt(all), Math.round(secs * 1000)) : t('{0} righe inserite in {1} s', fmt(all), secs.toLocaleString(locale(), { maximumFractionDigits: 1 })))}. ${plan.order.map((n) => `${n}: ${fmt(counts[n])}`).join(' · ')}${skippedNote.length ? ` · ${skippedNote.join(' · ')}` : ''}`);
    } catch (err) {
      setError(`${(err as Error).message}${all ? `\n${t('Righe già inserite: {0} (tabelle completate: {1}).', fmt(all), done.join(', ') || '—')}` : ''}`);
    }
    setProgress(null);
    useStore.getState().dropMeta(`${connId}/${db}/`);
    load();
  };

  const shownTables = (tables ?? []).filter((tb) => !filter || tb.name.toLowerCase().includes(filter.toLowerCase()));
  const running = !!progress;

  return (
    <div className="monitor datagen">
      <div className="er-bar">
        <b>{db}</b>
        <span className="muted">{tn(chosen.length, '{0} tabella scelta', '{0} tabelle scelte')} · {tn(totalRows, '{0} riga da generare', '{0} righe da generare')}</span>
        <div className="spacer" />
        <label className="check" title={t('Lo stesso seme con le stesse impostazioni genera gli stessi dati')}>{t('Seme')} <input className="num-input wide" type="number" value={g.seed} onChange={(e) => update((s) => ({ ...s, seed: Number(e.target.value) || 0 }))} /></label>
        <label className="check">{t('Dati')} <select value={g.lang} onChange={(e) => update((s) => ({ ...s, lang: e.target.value as 'it' | 'en' }))}><option value="it">{t('italiani')}</option><option value="en">{t('inglesi')}</option></select></label>
        <label className="check">{t('Prima')} <select value={g.clear} onChange={(e) => update((s) => ({ ...s, clear: e.target.value as GenSettings['clear'] }))}>
          <option value="none">{t('aggiungi alle righe esistenti')}</option><option value="delete">{t('svuota le tabelle (DELETE)')}</option><option value="truncate">{t('svuota e azzera AUTO_INCREMENT (TRUNCATE)')}</option></select></label>
        <button onClick={doScript} disabled={!chosen.length || running}>{t('Genera script')}</button>
        <button className="primary" onClick={doInsert} disabled={!chosen.length || running}>{t('Genera e inserisci…')}</button>
      </div>
      {error && <div className="status error cmp-error pre-line">{error}</div>}
      {notice && <div className="status ok cmp-error" onClick={() => setNotice(null)}>{notice}</div>}
      {progress && <div className="maint-progress">
        <span>{progress.table}: {fmt(progress.done)} / {fmt(progress.total)}</span>
        <progress className="progress" max={progress.allTotal} value={progress.all} />
        <span className="muted">{t('{0} righe/s', fmt(Math.round(progress.all / Math.max(0.001, (Date.now() - progress.t0) / 1000))))}</span>
        <button onClick={() => { stop.current = true; }}>{t('Interrompi')}</button>
      </div>}
      {plan.order.length > 1 && <div className="dg-order muted">{t('Ordine di inserimento')}: {plan.order.join(' → ')}
        {plan.cycle.length > 0 && <span className="warn-text"> · {t('Riferimenti circolari tra {0}: le loro chiavi esterne usano solo valori già presenti (o NULL).', plan.cycle.join(', '))}</span>}</div>}
      <div className="dg-body">
        <div className="dg-tables">
          <input className="filter" placeholder={t('Filtra tabelle…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <div className="dg-table-list">
            {shownTables.map((tb) => {
              const st = g.tables[tb.name];
              return (
                <div key={tb.name} className={`cmp-item${sel === tb.name ? ' sel' : ''}`} onMouseDown={() => update((s) => ({ ...s, sel: tb.name }))}>
                  <input type="checkbox" checked={!!st?.on} onChange={(e) => setTable(tb.name, { on: e.target.checked })} onMouseDown={(e) => e.stopPropagation()} />
                  <span className="name">{tb.name}</span>
                  <span className="muted small">{tb.rows !== null ? fmt(tb.rows) : ''}</span>
                  {st?.on && <input className="num-input" type="number" min={1} value={st.rows} onMouseDown={(e) => e.stopPropagation()} onChange={(e) => setTable(tb.name, { rows: Math.max(1, Number(e.target.value) || 1) })} />}
                </div>
              );
            })}
          </div>
          <div className="snip-actions">
            <button onClick={() => update((s) => ({ ...s, tables: Object.fromEntries((tables ?? []).map((tb) => [tb.name, { ...entry(s, tb.name), on: true }])) }))}>{t('Tutte')}</button>
            <button onClick={() => update((s) => ({ ...s, tables: Object.fromEntries(Object.entries(s.tables).map(([n, x]) => [n, { ...x, on: false }])) }))}>{t('Nessuna')}</button>
          </div>
          <p className="note">{t('Le colonne con il valore del server (AUTO_INCREMENT, DEFAULT, colonne generate) restano fuori dall\'INSERT. Le righe esistenti con la stessa chiave unica vengono evitate.')}</p>
        </div>
        <div className="dg-cols">
          {sel ? <>
            <div className="procs-bar">
              <b>{sel}</b>
              <span className="muted">{tn(selCols.length, '{0} colonna', '{0} colonne')}</span>
              <div className="spacer" />
              <button onClick={() => update((s) => ({ ...s, tables: { ...s.tables, [sel]: { ...entry(s, sel), specs: {} } } }))}>{t('Ripristina proposte')}</button>
              <button onClick={doPreview}>{t('Anteprima')}</button>
            </div>
            <div className="procs-table">
              <table className="dtable dg-grid">
                <thead><tr><th>{t('Colonna')}</th><th>{t('Tipo')}</th><th>{t('Generatore')}</th><th>{t('Opzioni')}</th><th>% NULL</th></tr></thead>
                <tbody>
                  {selCols.map((c) => {
                    const spec = selSpecs[c.name];
                    return (
                      <tr key={c.name} className={spec.kind === 'skip' ? 'off' : ''}>
                        <td><b>{c.name}</b>{c.unique && <span className="badge st-equal">{t('unica')}</span>}{c.fk && <span className="badge st-source">FK</span>}</td>
                        <td className="muted">{c.type}{c.nullable ? '' : ' NOT NULL'}{c.autoIncrement ? ' AUTO_INCREMENT' : ''}{c.generated ? ` ${t('generata')}` : ''}</td>
                        <td><select value={spec.kind} disabled={c.generated} onChange={(e) => changeKind(c, e.target.value as GenKind)}>
                          {KINDS.filter((k) => (k.kind !== 'fk' || c.fk) && (k.kind !== 'skip' || c.autoIncrement || c.hasDefault || c.nullable || c.generated) && (k.kind !== 'null' || c.nullable)).map((k) => <option key={k.kind} value={k.kind}>{k.label()}</option>)}
                        </select></td>
                        <td><div className="dg-opts"><SpecOptions c={c} spec={spec} set={(p) => setSpec(c.name, p)} mysql={mysql} /></div></td>
                        <td>{c.nullable && !['skip', 'null', 'sequence', 'fk'].includes(spec.kind) ? <input className="num-input" type="number" min={0} max={100} value={spec.nullPct ?? 0} onChange={(e) => setSpec(c.name, { nullPct: Math.min(100, Math.max(0, Number(e.target.value) || 0)) })} /> : ''}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {preview && preview.table === sel && <div className="dg-preview">
                <div className="props-title">{t('Anteprima (le prime righe generate con questo seme)')}</div>
                <table className="dtable"><thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{preview.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={v === null ? 'null' : ''} title={literal(v)}>{cellText(v)}</td>)}</tr>)}</tbody></table>
              </div>}
            </div>
          </> : <div className="empty">{tables ? t('Nessuna tabella nel database.') : t('Caricamento…')}</div>}
        </div>
      </div>
    </div>
  );
}
