import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { newDoc, openMaint, openServerTool } from '../actions';
import { advise, bytes, fixCnf, fixSql, score, type Finding, type Fix, type Overview, type Severity } from '../advisor';
import { DEFAULT_FORMAT, formatSql } from '../format';
import { locale, t, tn } from '../i18n';
import { lowSelectivity, redundantIndexes, scannedTables, tablesWithoutPk, unusedIndexes, usageHint, type IndexData } from '../indexes';
import { duration } from '../monitor';
import { analyzeQuery, explainable, groupSlowLog, normalizeSql, topFlags, type PlanRow, type SlowRow, type TableInfo, type TopRow } from '../queryadvisor';
import { IMPORTANT_VARS } from '../variables';
import { loadDatabases, metaKey, useStore, type MetaEntry } from '../store';
import type { Doc } from '../types';

type Tab = 'advice' | 'top' | 'indexes' | 'optimize' | 'vars';
const TABS: Tab[] = ['advice', 'top', 'indexes', 'optimize', 'vars'];
const TAB_LABEL: Record<Tab, () => string> = {
  advice: () => t('Consigli'), top: () => t('Query pesanti'), indexes: () => t('Indici'), optimize: () => t('Ottimizza query'), vars: () => t('Variabili'),
};
const SEV_LABEL: Record<Severity, () => string> = { critical: () => t('Critico'), warning: () => t('Attenzione'), info: () => t('Informazione'), ok: () => 'OK' };

const fmt = (v: number, digits = 0) => v.toLocaleString(locale(), { maximumFractionDigits: digits });
const ms = (v: number) => (v >= 1000 ? `${fmt(v / 1000, v >= 10000 ? 0 : 1)} s` : `${fmt(v, v < 10 ? 2 : 0)} ms`);
const pretty = (sql: string) => { try { return formatSql(sql, DEFAULT_FORMAT); } catch { return sql; } };
const copy = (s: string) => navigator.clipboard.writeText(s).catch(() => {});

function useDatabases(connId: string) {
  const open = useStore((s) => s.connState[connId]?.status === 'open');
  const dbs = useStore((s) => s.meta[metaKey.databases(connId)]) as MetaEntry<string[]> | undefined;
  useEffect(() => { if (open) loadDatabases(connId); }, [open]);
  return (dbs?.data ?? []).filter((d) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(d));
}

/** Performance center of a server: advisor, heaviest statements, index advisor, query optimizer, variables. */
export default function Performance({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const conn = useStore((s) => s.conns.find((c) => c.id === connId));
  const tab = (TABS.includes(doc.perf?.tab as Tab) ? doc.perf!.tab : 'advice') as Tab;
  const setTab = (tb: Tab, extra: Partial<NonNullable<Doc['perf']>> = {}) => useStore.getState().updateDoc(doc.id, (d) => ({ perf: { ...d.perf, tab: tb, ...extra } }));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const dbs = useDatabases(connId);
  const db = doc.perf?.db ?? (conn?.database || dbs[0] || null);
  const setDb = (v: string) => useStore.getState().updateDoc(doc.id, (d) => ({ perf: { ...d.perf, db: v } }));

  const load = async () => {
    setLoading(true);
    try { setOverview(await api.perf.overview(connId)); setError(null); } catch (err) { setError((err as Error).message); }
    setLoading(false);
  };
  useEffect(() => { if (!connOpen) { useStore.getState().openConn(connId); return; } load(); }, [connOpen]);
  const mysql8 = !/mariadb/i.test(overview?.variables.version ?? 'mariadb') && Number((overview?.variables.version ?? '0').split('.')[0]) >= 8;

  return (
    <div className="monitor perf">
      <div className="er-bar">
        <span className="muted">{conn?.name} · {overview?.variables.version ?? ''}{overview ? ` · ${t('attivo da {0}', duration(Number(overview.status.Uptime ?? 0)))}` : ''}</span>
        <div className="spacer" />
        {(tab === 'indexes' || tab === 'optimize') && <label className="check">Database
          <select value={db ?? ''} onChange={(e) => setDb(e.target.value)}>{dbs.map((d) => <option key={d}>{d}</option>)}</select></label>}
        <button onClick={load} disabled={loading}>{loading ? t('Analisi…') : t('Aggiorna')}</button>
      </div>
      {error && <div className="status error cmp-error">{error}</div>}
      <div className="tabs-row">
        {TABS.map((tb) => <button key={tb} className={tab === tb ? 'active' : ''} onClick={() => setTab(tb)}>{TAB_LABEL[tb]()}</button>)}
      </div>
      {tab === 'advice' && <Advice connId={connId} overview={overview} reload={load} mysql8={mysql8} go={(l) => {
        if (l === 'procs') openServerTool(connId, 'procs');
        else if (l === 'maint') { if (db) openMaint(connId, db); }
        else setTab(l);
      }} />}
      {tab === 'top' && <TopQueries connId={connId} analyze={(sql, d) => setTab('optimize', { sql, db: d ?? db })} />}
      {tab === 'indexes' && db && <Indexes key={db} connId={connId} db={db} />}
      {tab === 'optimize' && db && <Optimize key={`${db}`} connId={connId} db={db} doc={doc} />}
      {tab === 'vars' && <Variables connId={connId} overview={overview} reload={load} mysql8={mysql8} />}
    </div>
  );
}

// ---------------------------------------------------------------- advisor

function Advice({ connId, overview, reload, mysql8, go }: { connId: string; overview: Overview | null; reload: () => void; mysql8: boolean; go: (l: 'procs' | 'top' | 'indexes' | 'maint') => void }) {
  const [showOk, setShowOk] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const findings = useMemo(() => (overview ? advise(overview) : []), [overview]);
  if (!overview) return <div className="empty">{t('Caricamento…')}</div>;
  const sc = score(findings);
  const count = (s: Severity) => findings.filter((f) => f.severity === s).length;
  const shown = findings.filter((f) => showOk || f.severity !== 'ok');

  const apply = async (fixes: Fix[], persist: boolean) => {
    const sql = fixes.map((f) => fixSql(f, persist)).join('\n');
    if ((await api.confirm(t('Applicare la modifica al server?'), `${sql}\n\n${persist ? t('SET PERSIST la conserva anche dopo il riavvio.') : t('SET GLOBAL vale fino al riavvio: per renderla permanente aggiungila anche al file di configurazione.')}`, [t('Applica'), t('Annulla')])) !== 0) return;
    try {
      for (const f of fixes) await api.perf.setVariable(connId, f.variable, f.value, persist);
      setMsg({ ok: true, text: t('Applicato: {0}', fixes.map((f) => `${f.variable} = ${f.cnf ?? f.value}`).join(', ')) });
      reload();
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  };

  return (
    <div className="perf-body">
      <div className="perf-summary">
        <div className={`score ${sc >= 85 ? 'good' : sc >= 60 ? 'mid' : 'bad'}`}><b>{sc}</b><span>/100</span></div>
        <div className="sev-counts">
          <span className="sev critical">{tn(count('critical'), '{0} critico', '{0} critici')}</span>
          <span className="sev warning">{tn(count('warning'), '{0} da sistemare', '{0} da sistemare')}</span>
          <span className="sev info">{tn(count('info'), '{0} informazione', '{0} informazioni')}</span>
          <span className="sev ok">{count('ok')} OK</span>
        </div>
        <p className="note">{t('Controlli su contatori e variabili globali del server (cumulativi dall\'avvio). Le modifiche proposte con SET GLOBAL valgono fino al riavvio: copia le righe per il file di configurazione per renderle permanenti.')}</p>
        <label className="check"><input type="checkbox" checked={showOk} onChange={(e) => setShowOk(e.target.checked)} /> {t('Mostra anche i controlli superati')}</label>
      </div>
      {msg && <div className={`status ${msg.ok ? 'ok' : 'error'}`} onClick={() => setMsg(null)}>{msg.text}</div>}
      {shown.map((f) => <FindingCard key={f.id} f={f} mysql8={mysql8} apply={apply} go={go} />)}
      {!shown.length && <div className="empty">{t('Nessun problema rilevato.')}</div>}
    </div>
  );
}

function FindingCard({ f, mysql8, apply, go }: { f: Finding; mysql8: boolean; apply: (fx: Fix[], persist: boolean) => void; go: (l: 'procs' | 'top' | 'indexes' | 'maint') => void }) {
  const [more, setMore] = useState(false);
  const dynamic = f.fixes?.filter((x) => x.dynamic) ?? [];
  const LINK: Record<string, () => string> = { procs: () => t('Apri Processi'), top: () => t('Vai a Query pesanti'), indexes: () => t('Vai a Indici'), maint: () => t('Apri Manutenzione tabelle') };
  return (
    <div className={`finding ${f.severity}`}>
      <div className="finding-head">
        <span className={`sev ${f.severity}`}>{SEV_LABEL[f.severity]()}</span>
        <span className="muted">{f.area}</span>
        <b>{f.title}</b>
        <span className="finding-value">{f.value}</span>
      </div>
      <p>{f.detail}</p>
      {f.advice && <p className="advice">{f.advice}</p>}
      {f.fixes && <div className="fix">
        <pre>{f.fixes.map((x) => (x.dynamic ? fixSql(x) : `-- ${t('non modificabile a caldo: solo nel file di configurazione')}\n-- ${x.variable} = ${x.cnf ?? x.value}`)).join('\n')}</pre>
        <div className="fix-actions">
          {dynamic.length > 0 && <button onClick={() => apply(dynamic, false)}>{t('Applica ora (SET GLOBAL)')}</button>}
          {dynamic.length > 0 && mysql8 && <button onClick={() => apply(dynamic, true)} title={t('MySQL 8: scrive anche mysqld-auto.cnf, resta dopo il riavvio')}>{t('Applica e rendi permanente (SET PERSIST)')}</button>}
          <button onClick={() => copy(fixCnf(f.fixes!))}>{t('Copia per my.cnf')}</button>
        </div>
      </div>}
      {f.tables && <div className="finding-tables">
        {(more ? f.tables : f.tables.slice(0, 8)).map((x, i) => <span key={i}><code>{x.db ? `${x.db}.` : ''}{x.name}</code>{x.note ? ` ${x.note}` : ''}</span>)}
        {f.tables.length > 8 && <button className="link" onClick={() => setMore(!more)}>{more ? t('meno') : t('altre {0}…', f.tables.length - 8)}</button>}
      </div>}
      {f.link && <button className="link" onClick={() => go(f.link!)}>{LINK[f.link]()} →</button>}
    </div>
  );
}

// ---------------------------------------------------------------- heaviest statements

/** Statements of tools and drivers (SHOW, SET, @@variables, catalog queries), hidden by default. */
const isService = (sql: string) => /^\s*(?:SELECT\s+(?:@@|VERSION\s*\(|CONNECTION_ID|DATABASE\s*\()|(?:SHOW|SET|USE|COMMIT|ROLLBACK|BEGIN|START\s+TRANSACTION|KILL|EXPLAIN|TRUNCATE)\b)/i.test(sql)
  || /`?\b(?:information_schema|performance_schema|mysql|sys)\b`?\s*\./i.test(sql);

type TopSort = 'total' | 'avg' | 'count' | 'max' | 'examined';

function TopQueries({ connId, analyze }: { connId: string; analyze: (sql: string, db: string | null) => void }) {
  const [source, setSource] = useState<'digest' | 'slowlog' | null>(null);
  const [data, setData] = useState<{ sources: Awaited<ReturnType<typeof api.perf.topQueries>>['sources']; rows: TopRow[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<TopSort>('total');
  const [hideAdmin, setHideAdmin] = useState(true);
  const [filter, setFilter] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(1);

  const load = async (src = source) => {
    try {
      let r = await api.perf.topQueries(connId, src ?? 'digest');
      let used = src ?? 'digest';
      // first load: performance_schema when it can be read, else the slow log table
      if (!src && !r.sources.digest) { used = 'slowlog'; if (r.sources.slowTable) r = await api.perf.topQueries(connId, 'slowlog'); }
      const ok = used === 'digest' ? r.sources.digest : r.sources.slowTable;
      setSource(ok ? used : null);
      setData({ sources: r.sources, rows: !ok ? [] : used === 'slowlog' ? groupSlowLog(r.rows as SlowRow[]) : (r.rows as TopRow[]).map((x) => ({ ...x, text: normalizeSql(x.text) })) });
      setError(null);
    } catch (err) { setError((err as Error).message); }
  };
  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    const q = filter.toLowerCase();
    const key: Record<TopSort, (r: TopRow) => number> = { total: (r) => r.totalMs, avg: (r) => r.totalMs / Math.max(1, r.count), count: (r) => r.count, max: (r) => r.maxMs, examined: (r) => r.examined };
    return (data?.rows ?? [])
      .filter((r) => (!hideAdmin || !isService(r.text))
        && (!q || r.text.toLowerCase().includes(q) || (r.db ?? '').toLowerCase().includes(q)))
      .sort((a, b) => key[sort](b) - key[sort](a));
  }, [data, sort, hideAdmin, filter]);
  const totalMs = rows.reduce((n, r) => n + r.totalMs, 0);
  const picked = rows.find((r) => r.key === sel) ?? null;
  const s = data?.sources;

  const reset = async () => {
    if (!source) return;
    if ((await api.confirm(t('Azzerare le statistiche delle query?'), source === 'digest' ? 'TRUNCATE TABLE performance_schema.events_statements_summary_by_digest' : 'TRUNCATE TABLE mysql.slow_log', [t('Azzera'), t('Annulla')])) !== 0) return;
    try { await api.perf.resetTop(connId, source); load(); } catch (err) { setError((err as Error).message); }
  };
  const enableSlow = async () => {
    try { await api.perf.enableSlowLog(connId, threshold); await load('slowlog'); } catch (err) { setError((err as Error).message); }
  };
  const header = (k: TopSort, label: string) => <th className="num" onClick={() => setSort(k)}>{label}{sort === k ? ' ▾' : ''}</th>;

  return (
    <div className="maint-body">
      <div className="maint-actions">
        <span>{t('Fonte')}</span>
        <button className={source === 'digest' ? 'on' : ''} disabled={!s?.digest} onClick={() => load('digest')} title={s?.ps ? '' : t('performance_schema non attivo')}>performance_schema</button>
        <button className={source === 'slowlog' ? 'on' : ''} disabled={!s?.slowTable} onClick={() => load('slowlog')}>{t('Log query lente')}</button>
        <span className="sep" />
        <label className="check"><input type="checkbox" checked={hideAdmin} onChange={(e) => setHideAdmin(e.target.checked)} /> {t('Nascondi comandi di servizio e query sui cataloghi di sistema')}</label>
        <input className="search" placeholder={t('Filtra…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="spacer" />
        <button onClick={() => load()}>{t('Aggiorna')}</button>
        <button disabled={!source} onClick={reset}>{t('Azzera statistiche…')}</button>
      </div>
      {error && <div className="status error">{error}</div>}
      {s && !s.digest && (
        <div className="help-card">
          <b>{t('Come raccogliere le statistiche delle query')}</b>
          {!s.ps && <p>{t('performance_schema è disattivato: aggiungi performance_schema = ON nella sezione [mysqld] del file di configurazione e riavvia il server. È la fonte migliore: raggruppa ogni istruzione con tempi, righe lette, tabelle temporanee e uso degli indici.')}</p>}
          {s.slowTable && s.slowLog && /TABLE/i.test(s.logOutput)
            ? <p>{t('Log delle query lente attivo su tabella (soglia {0} s): sotto ci sono le istruzioni registrate, raggruppate per forma.', s.longQueryTime)}</p>
            : <p>{t('Senza riavvio puoi attivare il log delle query lente su tabella (mysql.slow_log): vengono registrate le istruzioni oltre la soglia.')}
              <span className="inline-form"> {t('Soglia')} <input className="num-input" type="number" min={0} step={0.1} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} /> s
                <button onClick={enableSlow}>{t('Attiva log query lente')}</button></span>
              <br /><span className="muted">{t('Serve il privilegio SUPER o SYSTEM_VARIABLES_ADMIN. La soglia vale per le connessioni aperte dopo la modifica.')}</span></p>}
        </div>
      )}
      {source && <>
        <div className="procs-table top-list">
          <table className="dtable">
            <thead><tr><th>{t('Istruzione')}</th><th>DB</th>{header('count', t('Esecuzioni'))}{header('total', t('Tempo totale'))}<th className="num">%</th>{header('avg', t('Medio'))}{header('max', t('Massimo'))}{header('examined', t('Righe lette'))}<th className="num">{t('Restituite')}</th><th>{t('Segnali')}</th></tr></thead>
            <tbody>
              {rows.slice(0, 300).map((r) => (
                <tr key={r.key} className={sel === r.key ? 'sel' : ''} onMouseDown={() => setSel(r.key)} onDoubleClick={() => analyze(r.sample && explainable(r.sample) ? r.sample : r.text, r.db)}>
                  <td className="q" title={r.text}>{r.text.slice(0, 160)}</td>
                  <td>{r.db ?? ''}</td>
                  <td className="num">{fmt(r.count)}</td>
                  <td className="num">{ms(r.totalMs)}</td>
                  <td className="num"><span className="bar" style={{ width: `${totalMs ? (r.totalMs / totalMs) * 100 : 0}%` }} />{totalMs ? fmt((r.totalMs / totalMs) * 100, 1) : 0}</td>
                  <td className="num">{ms(r.totalMs / Math.max(1, r.count))}</td>
                  <td className="num">{ms(r.maxMs)}</td>
                  <td className="num">{fmt(r.examined)}</td>
                  <td className="num">{fmt(r.sent)}</td>
                  <td>{topFlags(r).map((x) => <span key={x} className="badge st-diff">{x}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <div className="empty">{t('Nessuna istruzione registrata.')}</div>}
        </div>
        {picked && <div className="proc-detail">
          <div className="procs-bar">
            <b>{t('{0} esecuzioni', fmt(picked.count))}</b>
            <span className="muted">{picked.firstSeen ? t('dal {0} al {1}', new Date(picked.firstSeen).toLocaleString(locale()), new Date(picked.lastSeen ?? picked.firstSeen).toLocaleString(locale())) : ''}</span>
            <div className="spacer" />
            <button onClick={() => analyze(picked.sample && explainable(picked.sample) ? picked.sample : picked.text, picked.db)}>{t('Analizza e ottimizza')}</button>
            <button onClick={() => newDoc({ connId, db: picked.db, sql: `${pretty(picked.sample ?? picked.text)};\n` })}>{t("Apri nell'editor")}</button>
            <button onClick={() => copy(picked.sample ?? picked.text)}>{t('Copia')}</button>
          </div>
          <div className="proc-detail-body">
            <pre className="hist-sql">{pretty(picked.text)}</pre>
            {picked.sample && picked.sample !== picked.text && <><div className="props-title">{t('Esempio reale')}</div><pre className="hist-sql">{picked.sample}</pre></>}
            {!picked.sample && <p className="note">{t('Il testo normalizzato ha ? al posto dei valori: per il piano di esecuzione sostituiscili con valori reali.')}</p>}
          </div>
        </div>}
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- index advisor

function Indexes({ connId, db }: { connId: string; db: string }) {
  const [d, setD] = useState<IndexData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const load = () => api.perf.indexData(connId, db).then((x) => { setD(x); setError(null); }).catch((err) => setError((err as Error).message));
  useEffect(() => { load(); }, []);
  if (error) return <div className="maint-body"><div className="status error">{error}</div></div>;
  if (!d) return <div className="empty">{t('Caricamento…')}</div>;
  const red = redundantIndexes(d.indexes);
  const unused = unusedIndexes(d).filter((u) => !red.some((r) => r.table === u.table && r.index === u.index));
  const nopk = tablesWithoutPk(d);
  const low = lowSelectivity(d);
  const scans = scannedTables(d);
  const toggle = (sql: string, on: boolean) => setPick((p) => { const n = new Set(p); if (on) n.add(sql); else n.delete(sql); return n; });
  const script = () => newDoc({ connId, db, sql: `-- ${t('Script generato da MiB-SQL › Prestazioni › Indici ({0})', db)}\n-- ${t('Controlla ogni istruzione prima di eseguirla: ALTER TABLE ricostruisce o blocca la tabella.')}\n\n${[...pick].join('\n')}\n` });
  const enableUserstat = async () => {
    try { await api.perf.setVariable(connId, 'userstat', 'ON', false); load(); } catch (err) { setError((err as Error).message); }
  };
  const check = (sql: string | null) => sql ? <input type="checkbox" checked={pick.has(sql)} onChange={(e) => toggle(sql, e.target.checked)} /> : null;

  return (
    <div className="perf-body">
      <div className="maint-actions sticky">
        <span className="muted">{tn(d.indexes.length, '{0} indice', '{0} indici')} · {tn(d.tables.length, '{0} tabella', '{0} tabelle')}</span>
        <div className="spacer" />
        <span className="muted">{tn(pick.size, '{0} istruzione scelta', '{0} istruzioni scelte')}</span>
        <button disabled={!pick.size} onClick={script}>{t('Apri script nell\'editor')}</button>
        <button onClick={load}>{t('Aggiorna')}</button>
      </div>

      <section className="idx-section">
        <h3>{t('Indici duplicati o ridondanti')} <span className="muted">({red.length})</span></h3>
        <p className="note">{t('Un indice le cui colonne sono l\'inizio di un altro indice è inutile per le ricerche e rallenta ogni scrittura. Gli indici UNIQUE e la chiave primaria vengono tenuti.')}</p>
        {red.length ? <table className="dtable"><thead><tr><th className="c" /><th>{t('Tabella')}</th><th>{t('Indice')}</th><th>{t('Colonne')}</th><th>{t('Coperto da')}</th><th>SQL</th></tr></thead>
          <tbody>{red.map((r) => <tr key={r.table + r.index}><td className="c">{check(r.sql)}</td><td>{r.table}</td><td>{r.index}</td><td>{r.columns}</td><td>{r.by}{r.duplicate ? ` (${t('duplicato')})` : ''}</td><td><code>{r.sql}</code></td></tr>)}</tbody></table>
          : <p className="ok-text">{t('Nessuno.')}</p>}
      </section>

      <section className="idx-section">
        <h3>{t('Indici mai usati')} {d.usage && <span className="muted">({unused.length})</span>}</h3>
        <p className="note">{usageHint(d)}{d.usage && d.uptime !== null ? ` ${t('Server attivo da {0}: un indice usato solo da elaborazioni mensili o annuali qui risulta inutilizzato.', duration(d.uptime))}` : ''}</p>
        {!d.usage && d.flavor === 'mariadb' && d.userstatAvailable && <button onClick={enableUserstat}>{t('Attiva userstat (SET GLOBAL userstat = ON)')}</button>}
        {d.usage && (unused.length ? <table className="dtable"><thead><tr><th className="c" /><th>{t('Tabella')}</th><th>{t('Indice')}</th><th>{t('Colonne')}</th><th>{t('Nota')}</th><th>SQL</th></tr></thead>
          <tbody>{unused.map((u) => <tr key={u.table + u.index}><td className="c">{check(u.sql)}</td><td>{u.table}</td><td>{u.index}</td><td>{u.columns}</td>
            <td>{u.fk ? t('serve alla chiave esterna {0}', u.fk) : u.unique ? t('UNIQUE: garantisce l\'unicità anche se non usato per leggere') : ''}</td><td>{u.sql ? <code>{u.sql}</code> : ''}</td></tr>)}</tbody></table>
          : <p className="ok-text">{t('Tutti gli indici sono stati usati.')}</p>)}
      </section>

      <section className="idx-section">
        <h3>{t('Tabelle senza chiave primaria')} <span className="muted">({nopk.length})</span></h3>
        {nopk.length ? <table className="dtable"><thead><tr><th className="c" /><th>{t('Tabella')}</th><th className="num">{t('Righe')}</th><th>{t('Proposta')}</th></tr></thead>
          <tbody>{nopk.map((x) => <tr key={x.table}><td className="c">{check(x.sql)}</td><td>{x.table}</td><td className="num">{x.rows !== null ? fmt(x.rows) : ''}</td>
            <td><code>{x.sql}</code>{x.candidate ? <span className="muted"> — {t('promuove l\'indice UNIQUE {0}', x.candidate)}</span> : null}</td></tr>)}</tbody></table>
          : <p className="ok-text">{t('Tutte le tabelle hanno una chiave primaria.')}</p>}
      </section>

      {d.usage && <section className="idx-section">
        <h3>{t('Tabelle lette senza indice')} <span className="muted">({scans.length})</span></h3>
        <p className="note">{t('Righe lette con scansioni complete invece che tramite un indice: cerca in Query pesanti le istruzioni su queste tabelle e analizzale.')}</p>
        {scans.length ? <table className="dtable"><thead><tr><th>{t('Tabella')}</th><th className="num">{t('Righe lette senza indice')}</th><th className="num">{t('Con indice')}</th><th className="num">%</th></tr></thead>
          <tbody>{scans.map((x) => <tr key={x.table}><td>{x.table}</td><td className="num">{fmt(x.rows)}</td><td className="num">{fmt(x.viaIndex)}</td><td className="num">{fmt(x.share * 100, 1)}</td></tr>)}</tbody></table>
          : <p className="ok-text">{t('Nessuna.')}</p>}
      </section>}

      {low.length > 0 && <section className="idx-section">
        <h3>{t('Indici poco selettivi')} <span className="muted">({low.length})</span></h3>
        <p className="note">{t('Indici su colonne con pochissimi valori distinti (es. un flag sì/no): l\'ottimizzatore li usa raramente, ma pesano su ogni scrittura. Possono servire come prima colonna di un indice composto. Le cardinalità sono stime: ANALYZE TABLE le aggiorna.')}</p>
        <table className="dtable"><thead><tr><th>{t('Tabella')}</th><th>{t('Indice')}</th><th>{t('Colonne')}</th><th className="num">{t('Valori distinti')}</th><th className="num">{t('Righe')}</th></tr></thead>
          <tbody>{low.map((x) => <tr key={x.table + x.index}><td>{x.table}</td><td>{x.index}</td><td>{x.columns}</td><td className="num">{fmt(x.cardinality)}</td><td className="num">{fmt(x.rows)}</td></tr>)}</tbody></table>
      </section>}
    </div>
  );
}

// ---------------------------------------------------------------- query optimizer

function Optimize({ connId, db, doc }: { connId: string; db: string; doc: Doc }) {
  const [sql, setSql] = useState(doc.perf?.sql ?? '');
  const [result, setResult] = useState<{ plan: PlanRow[] | null; planError: string | null; analysis: ReturnType<typeof analyzeQuery> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // a query sent from the editor or from Query pesanti: show it and analyze it at once
  useEffect(() => { if (doc.perf?.sql) { setSql(doc.perf.sql); run(doc.perf.sql); } }, [doc.perf?.sql]);

  const run = async (text = sql) => {
    const stmt = text.trim().replace(/;\s*$/, '');
    if (!stmt) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const data = await api.perf.indexData(connId, db);
      const tables: Record<string, TableInfo> = {};
      for (const tb of data.tables) tables[tb.name] = { name: tb.name, rows: tb.rows, columns: [], indexes: [] };
      for (const c of data.columns) tables[c.table]?.columns.push({ name: c.name, type: c.type });
      for (const ix of data.indexes) tables[ix.table]?.indexes.push(ix);
      let plan: PlanRow[] | null = null;
      let planError: string | null = null;
      try { plan = await api.perf.explain(connId, db, stmt); } catch (err) { planError = (err as Error).message; }
      setResult({ plan, planError, analysis: analyzeQuery(stmt, plan, tables) });
    } catch (err) { setError((err as Error).message); }
    setBusy(false);
  };

  const create = async (s: { sql: string; table: string }) => {
    if ((await api.confirm(t('Creare l\'indice su {0}?', s.table), `${s.sql}\n\n${t('Su InnoDB l\'indice si crea senza bloccare le letture e le scritture, ma su tabelle grandi richiede tempo e spazio su disco.')}`, [t('Crea indice'), t('Annulla')])) !== 0) return;
    try {
      await api.ddl.run(connId, [s.sql.replace(/^ALTER TABLE /, `ALTER TABLE \`${db.replace(/`/g, '``')}\`.`).replace(/;$/, '')]);
      useStore.getState().dropMeta(`${connId}/${db}/`);
      setMsg(t('Indice creato. Piano ricalcolato:'));
      run();
    } catch (err) { setError((err as Error).message); }
  };

  const cols = result?.plan?.length ? Object.keys(result.plan[0]) : [];
  return (
    <div className="perf-body">
      <p className="note">{t('Incolla una SELECT, UPDATE o DELETE: viene letto il piano di esecuzione (EXPLAIN, la query non viene eseguita) e confrontato con gli indici esistenti di {0}.', db)}</p>
      <textarea className="opt-sql" spellCheck={false} value={sql} onChange={(e) => setSql(e.target.value)} placeholder="SELECT … FROM … WHERE …"
        onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } }} />
      <div className="fix-actions">
        <button className="primary" disabled={busy || !sql.trim()} onClick={() => run()}>{busy ? t('Analisi…') : t('Analizza (Ctrl+Invio)')}</button>
        <button disabled={!sql.trim()} onClick={() => setSql(pretty(sql))}>{t('Formatta')}</button>
        <button disabled={!sql.trim()} onClick={() => newDoc({ connId, db, sql: `${sql.trim()}\n` })}>{t("Apri nell'editor")}</button>
      </div>
      {error && <div className="status error">{error}</div>}
      {msg && <div className="status ok">{msg}</div>}
      {result && <>
        <h3>{t('Problemi rilevati')}</h3>
        <ul className="issues">
          {result.analysis.issues.map((i, n) => <li key={n} className={i.level}>{i.text}</li>)}
        </ul>
        <h3>{t('Indici suggeriti')}</h3>
        {result.analysis.suggestions.length ? result.analysis.suggestions.map((s) => (
          <div key={s.sql} className="finding info">
            <div className="finding-head"><b>{s.table}</b><span className="muted">{s.reason}</span></div>
            <div className="fix"><pre>{s.sql}</pre>
              <div className="fix-actions">
                <button onClick={() => create(s)}>{t('Crea indice…')}</button>
                <button onClick={() => newDoc({ connId, db, sql: `${s.sql}\n` })}>{t("Apri nell'editor")}</button>
                <button onClick={() => copy(s.sql)}>{t('Copia')}</button>
              </div></div>
          </div>
        )) : <p className="ok-text">{t('Nessun indice da aggiungere.')}</p>}
        <h3>{t('Piano di esecuzione')}</h3>
        {result.planError ? <div className="status error">{result.planError}</div> : (
          <div className="procs-table"><table className="dtable plan-table">
            <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
            <tbody>{result.plan!.map((r, i) => <tr key={i} className={r.type === 'ALL' && Number(r.rows) > 1000 ? 'waiting' : ''}>{cols.map((c) => <td key={c}>{String((r as Record<string, unknown>)[c] ?? '')}</td>)}</tr>)}</tbody>
          </table></div>
        )}
        <p className="note">{t('Le stime di EXPLAIN si basano sulle statistiche delle tabelle; per i tempi reali usa «Profila» nell\'editor SQL.')}</p>
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- variables

function Variables({ connId, overview, reload, mysql8 }: { connId: string; overview: Overview | null; reload: () => void; mysql8: boolean }) {
  const [filter, setFilter] = useState('');
  const [onlyImportant, setOnlyImportant] = useState(true);
  const [edit, setEdit] = useState<{ name: string; value: string } | null>(null);
  const [persist, setPersist] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!overview) return <div className="empty">{t('Caricamento…')}</div>;
  const vars = overview.variables;
  const q = filter.toLowerCase();
  const important = new Map(IMPORTANT_VARS.map((v) => [v.name, v]));
  const names = (onlyImportant ? IMPORTANT_VARS.map((v) => v.name).filter((n) => n in vars) : Object.keys(vars).sort())
    .filter((n) => !q || n.toLowerCase().includes(q) || String(vars[n] ?? '').toLowerCase().includes(q) || (important.get(n)?.desc() ?? '').toLowerCase().includes(q));
  const save = async () => {
    if (!edit) return;
    try {
      const v = await api.perf.setVariable(connId, edit.name, edit.value, persist);
      setMsg({ ok: true, text: t('{0} = {1}', edit.name, v ?? '') });
      setEdit(null);
      reload();
    } catch (err) { setMsg({ ok: false, text: (err as Error).message }); }
  };
  const show = (n: string, v: string | null) => {
    const def = important.get(n);
    if (def?.size && v !== null && /^\d+$/.test(v) && Number(v) >= 1024) return `${v} (${bytes(Number(v))})`;
    return v ?? '';
  };
  return (
    <div className="maint-body">
      <div className="maint-actions">
        <label className="check"><input type="checkbox" checked={onlyImportant} onChange={(e) => setOnlyImportant(e.target.checked)} /> {t('Solo le più importanti per le prestazioni')}</label>
        <input className="search" placeholder={t('Filtra variabili…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="spacer" />
        {mysql8 && <label className="check" title={t('MySQL 8: SET PERSIST conserva il valore dopo il riavvio')}><input type="checkbox" checked={persist} onChange={(e) => setPersist(e.target.checked)} /> SET PERSIST</label>}
        <span className="muted">{tn(names.length, '{0} variabile', '{0} variabili')}</span>
      </div>
      {msg && <div className={`status ${msg.ok ? 'ok' : 'error'}`} onClick={() => setMsg(null)}>{msg.text}</div>}
      <div className="procs-table">
        <table className="dtable vars-table">
          <thead><tr><th>{t('Variabile')}</th><th>{t('Valore')}</th><th>{t('Descrizione')}</th><th /></tr></thead>
          <tbody>
            {names.map((n) => (
              <tr key={n}>
                <td><code>{n}</code></td>
                <td>{edit?.name === n
                  ? <input autoFocus value={edit.value} onChange={(e) => setEdit({ name: n, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEdit(null); }} />
                  : show(n, vars[n])}</td>
                <td className="desc">{important.get(n)?.desc() ?? ''}{important.get(n)?.dynamic === false ? <span className="muted"> {t('(richiede il riavvio)')}</span> : null}</td>
                <td className="act">{edit?.name === n
                  ? <><button onClick={save}>{t('Applica')}</button><button onClick={() => setEdit(null)}>{t('Annulla')}</button></>
                  : <button onClick={() => setEdit({ name: n, value: vars[n] ?? '' })} disabled={important.get(n)?.dynamic === false}>{t('Modifica')}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
