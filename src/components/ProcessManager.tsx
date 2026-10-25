import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { newDoc } from '../actions';
import { formatSql, DEFAULT_FORMAT } from '../format';
import { locale, t, tn } from '../i18n';
import { duration } from '../monitor';
import { hostOnly, idleInTrx, isSystem, latestDeadlock, rootBlockers, summary, trxByThread, waits, type Deadlock, type GroupKey, type Proc, type ProcSnapshot, type Wait } from '../procs';
import { useStore } from '../store';
import type { Doc } from '../types';

type Tab = 'procs' | 'trx' | 'locks' | 'summary' | 'deadlock';
type SortKey = 'id' | 'user' | 'host' | 'db' | 'command' | 'time' | 'state' | 'info';

const fmt = (v: number, digits = 1) => v.toLocaleString(locale(), { maximumFractionDigits: digits });
const secs = (p: Proc) => (p.timeMs !== null && p.time < 60 ? `${fmt(p.timeMs / 1000)} s` : duration(p.time));
const oneLine = (s: string | null, n = 220) => (s ?? '').replace(/\s+/g, ' ').slice(0, n);
const pretty = (sql: string) => { try { return formatSql(sql, DEFAULT_FORMAT); } catch { return sql; } };

const SORT: Record<SortKey, (p: Proc) => number | string> = {
  id: (p) => p.id, user: (p) => p.user.toLowerCase(), host: (p) => p.host, db: (p) => p.db ?? '', command: (p) => p.command,
  time: (p) => (p.timeMs ?? p.time * 1000), state: (p) => p.state ?? '', info: (p) => p.info ?? '',
};

/** Process manager of a server: threads, transactions, lock waits, grouping, latest deadlock; kill one or many. */
export default function ProcessManager({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const conn = useStore((s) => s.conns.find((c) => c.id === connId));
  const [tab, setTab] = useState<Tab>('procs');
  const [every, setEvery] = useState(2000);
  const [snap, setSnap] = useState<ProcSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [hideSleep, setHideSleep] = useState(false);
  const [hideSystem, setHideSystem] = useState(true);
  const [filter, setFilter] = useState('');
  const [slowAfter, setSlowAfter] = useState(10);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'time', desc: true });
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [sel, setSel] = useState<number | null>(null);
  const [plan, setPlan] = useState<{ id: number; columns: string[]; rows: (string | null)[][] } | { id: number; error: string } | null>(null);
  const [group, setGroup] = useState<GroupKey>('user');
  const [deadlock, setDeadlock] = useState<{ d: Deadlock | null; raw: string; error?: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!connOpen) { useStore.getState().openConn(connId); return; }
    let stop = false;
    const poll = async () => {
      try {
        const s = await api.procs.snapshot(connId);
        if (stop) return;
        setSnap(s);
        setError(null);
      } catch (err) { if (!stop) setError((err as Error).message); }
    };
    poll();
    if (!every) return () => { stop = true; };
    const h = setInterval(poll, every);
    return () => { stop = true; clearInterval(h); };
  }, [connOpen, every, tick]);

  const trx = useMemo(() => (snap ? trxByThread(snap) : new Map()), [snap]);
  const ws = useMemo(() => (snap ? waits(snap) : []), [snap]);
  const roots = useMemo(() => rootBlockers(ws), [ws]);
  const waitingFor = useMemo(() => {
    const m = new Map<number, Wait[]>();
    for (const w of ws) m.set(w.waiter, [...(m.get(w.waiter) ?? []), w]);
    return m;
  }, [ws]);
  const blocking = useMemo(() => {
    const m = new Map<number, number[]>();
    for (const w of ws) m.set(w.blocker, [...(m.get(w.blocker) ?? []), w.waiter]);
    return m;
  }, [ws]);

  const all = snap?.processes ?? [];
  const procs = useMemo(() => {
    const q = filter.toLowerCase();
    const k = SORT[sort.key];
    return all
      .filter((p) => (!hideSleep || p.command !== 'Sleep' || trx.has(p.id)) && (!hideSystem || !isSystem(p))
        && (!q || [p.id, p.user, p.host, p.db, p.command, p.state, p.info].some((x) => String(x ?? '').toLowerCase().includes(q))))
      .sort((a, b) => {
        const x = k(a);
        const y = k(b);
        return (x < y ? -1 : x > y ? 1 : 0) * (sort.desc ? -1 : 1);
      });
  }, [all, filter, hideSleep, hideSystem, sort, trx]);
  const picked = all.find((p) => p.id === sel) ?? null;
  const checkedList = all.filter((p) => checked.has(p.id));
  const allShown = procs.length > 0 && procs.every((p) => checked.has(p.id));

  const toggle = (id: number, on: boolean) => setChecked((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });
  const header = (key: SortKey, label: string) => (
    <th onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key === 'time' }))}>{label}{sort.key === key ? (sort.desc ? ' ▾' : ' ▴') : ''}</th>
  );

  const kill = async (list: Proc[], queryOnly: boolean) => {
    if (!list.length) return;
    const p = list[0];
    const message = list.length === 1
      ? (queryOnly ? t('Terminare la query del thread {0}?', p.id) : t('Terminare la connessione {0} ({1}@{2})?', p.id, p.user, hostOnly(p.host)))
      : (queryOnly ? t('Terminare le query di {0} thread?', list.length) : t('Terminare {0} connessioni?', list.length));
    const detail = list.length === 1
      ? oneLine(p.info, 300) || (queryOnly ? '' : t('Le transazioni aperte della connessione vengono annullate (rollback).'))
      : `${list.slice(0, 12).map((x) => `${x.id} ${x.user}@${hostOnly(x.host)}${x.info ? ` · ${oneLine(x.info, 60)}` : ''}`).join('\n')}${list.length > 12 ? '\n…' : ''}`
        + (queryOnly ? '' : `\n\n${t('Le transazioni aperte delle connessioni vengono annullate (rollback).')}`);
    if ((await api.confirm(message, detail, [t('Termina'), t('Annulla')])) !== 0) return;
    try {
      const r = await api.procs.kill(connId, list.map((x) => x.id), queryOnly);
      setNotice(r.failed.length
        ? `${tn(r.killed, '{0} thread terminato', '{0} thread terminati')}; ${t('non riuscito')}: ${r.failed.map((f) => `${f.id} (${f.message})`).join('; ')}`
        : tn(r.killed, '{0} thread terminato', '{0} thread terminati'));
      setChecked(new Set());
      setTick((n) => n + 1);
    } catch (err) { setError((err as Error).message); }
  };

  const explain = async (p: Proc) => {
    try {
      const r = await api.procs.explainFor(connId, p.id, snap!.flavor);
      setPlan({ id: p.id, ...r });
    } catch (err) { setPlan({ id: p.id, error: (err as Error).message }); }
  };

  const installMdl = async () => {
    if ((await api.confirm(t('Installare il plugin METADATA_LOCK_INFO?'), t('INSTALL SONAME \'metadata_lock_info\' aggiunge la tabella information_schema.METADATA_LOCK_INFO: chi blocca una tabella diventa esatto. Serve il privilegio INSERT su mysql.plugin; il plugin resta installato anche dopo il riavvio.'), [t('Installa'), t('Annulla')])) !== 0) return;
    try {
      await api.procs.installMdl(connId);
      setNotice(t('Plugin installato.'));
      setTick((n) => n + 1);
    } catch (err) { setError((err as Error).message); }
  };

  const loadDeadlock = async () => {
    try {
      const raw = await api.procs.innodbStatus(connId);
      setDeadlock({ d: latestDeadlock(raw), raw });
    } catch (err) { setDeadlock({ d: null, raw: '', error: (err as Error).message }); }
  };
  useEffect(() => { if (tab === 'deadlock' && !deadlock && connOpen) loadDeadlock(); }, [tab, connOpen]);

  const selectIdle = () => {
    const ids = procs.filter((p) => p.command === 'Sleep' && p.time >= slowAfter && !isSystem(p)).map((p) => p.id);
    setChecked(new Set(ids));
    setNotice(ids.length ? tn(ids.length, '{0} connessione inattiva selezionata', '{0} connessioni inattive selezionate') : t('Nessuna connessione inattiva da almeno {0} s.', slowAfter));
  };

  const procOf = (id: number) => all.find((p) => p.id === id);
  const who = (id: number) => { const p = procOf(id); return p ? `${id} · ${p.user}@${hostOnly(p.host)}` : String(id); };
  const missing = snap?.missing ?? [];

  const rowClass = (p: Proc) => [
    sel === p.id ? 'sel' : '',
    blocking.has(p.id) ? 'blocker' : waitingFor.has(p.id) ? 'waiting' : '',
    idleInTrx(p, trx) !== null && (idleInTrx(p, trx) ?? 0) >= slowAfter ? 'idle-trx' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className="monitor procman">
      <div className="er-bar">
        <span className="muted">{conn?.name} · {snap?.version ?? ''}</span>
        <span className="muted">{snap ? t('{0} thread, {1} attivi, {2} transazioni, {3} in attesa', all.length, all.filter((p) => p.command !== 'Sleep' && !isSystem(p)).length, snap.trx.length, waitingFor.size) : t('Caricamento…')}</span>
        <div className="spacer" />
        <label className="check"><input type="checkbox" checked={hideSleep} onChange={(e) => setHideSleep(e.target.checked)} /> {t('Nascondi inattive')}</label>
        <label className="check"><input type="checkbox" checked={hideSystem} onChange={(e) => setHideSystem(e.target.checked)} /> {t('Nascondi thread di sistema')}</label>
        <input className="search" placeholder={t('Filtra processi…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check" title={t('Soglia per evidenziare query lente e transazioni inattive')}>{t('Soglia')} <input className="num-input" type="number" min={1} value={slowAfter} onChange={(e) => setSlowAfter(Math.max(1, Number(e.target.value) || 1))} /> s</label>
        <select value={every} onChange={(e) => setEvery(Number(e.target.value))} title={t('Aggiornamento automatico')}>
          <option value={0}>{t('manuale')}</option>
          {[1000, 2000, 5000, 10000].map((v) => <option key={v} value={v}>{t('ogni {0} s', v / 1000)}</option>)}
        </select>
        <button onClick={() => setTick((n) => n + 1)}>{t('Aggiorna')}</button>
      </div>
      {error && <div className="status error cmp-error">{error}</div>}
      {notice && <div className="status ok cmp-error" onClick={() => setNotice(null)}>{notice}</div>}
      <div className="tabs-row">
        <button className={tab === 'procs' ? 'active' : ''} onClick={() => setTab('procs')}>{t('Processi')} ({procs.length})</button>
        <button className={tab === 'trx' ? 'active' : ''} onClick={() => setTab('trx')}>{t('Transazioni')} ({snap?.trx.length ?? 0})</button>
        <button className={`${tab === 'locks' ? 'active' : ''}${roots.length ? ' alert' : ''}`} onClick={() => setTab('locks')}>{t('Blocchi')} ({waitingFor.size})</button>
        <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}>{t('Riepilogo')}</button>
        <button className={tab === 'deadlock' ? 'active' : ''} onClick={() => setTab('deadlock')}>{t('Ultimo deadlock')}</button>
      </div>

      {tab === 'procs' && <div className="maint-body">
        <div className="maint-actions">
          <span className="muted">{tn(checkedList.length, '{0} selezionato', '{0} selezionati')}</span>
          <button disabled={!checkedList.some((p) => p.command !== 'Sleep')} onClick={() => kill(checkedList.filter((p) => p.command !== 'Sleep'), true)}>{t('Termina query')}</button>
          <button className="danger" disabled={!checkedList.length} onClick={() => kill(checkedList, false)}>{t('Termina connessioni')}</button>
          <span className="sep" />
          <button onClick={selectIdle} title={t('Seleziona le connessioni inattive (Sleep) da almeno la soglia')}>{t('Seleziona inattive da ≥ {0} s', slowAfter)}</button>
          <button disabled={!checked.size} onClick={() => setChecked(new Set())}>{t('Deseleziona')}</button>
          <div className="spacer" />
          <span className="legend"><i className="lg blocker" /> {t('blocca altri')} <i className="lg waiting" /> {t('in attesa')} <i className="lg idle-trx" /> {t('transazione aperta inattiva')}</span>
        </div>
        <div className="procs-table proc-list">
          <table className="dtable">
            <thead><tr>
              <th className="c"><input type="checkbox" checked={allShown} onChange={(e) => setChecked(e.target.checked ? new Set([...checked, ...procs.map((p) => p.id)]) : new Set())} /></th>
              {header('id', 'ID')}{header('user', t('Utente'))}{header('host', 'Host')}{header('db', 'DB')}{header('command', t('Comando'))}{header('time', t('Tempo'))}{header('state', t('Stato'))}
              <th>{t('Transazione')}</th><th>{t('Blocchi')}</th>{header('info', 'Query')}
            </tr></thead>
            <tbody>
              {procs.map((p) => {
                const tx = trx.get(p.id);
                const idle = idleInTrx(p, trx);
                const wf = waitingFor.get(p.id);
                const bl = blocking.get(p.id);
                return (
                  <tr key={p.id} className={rowClass(p)} onMouseDown={() => { setSel(p.id); if (plan && plan.id !== p.id) setPlan(null); }}
                    onDoubleClick={() => p.info && useStore.getState().set({ viewer: { title: t('Thread {0}', p.id), value: p.info } })}>
                    <td className="c" onMouseDown={(e) => e.stopPropagation()}><input type="checkbox" checked={checked.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} /></td>
                    <td>{p.id}</td><td>{p.user}</td><td>{p.host}</td><td>{p.db ?? ''}</td><td>{p.command}</td>
                    <td className={p.command !== 'Sleep' && !isSystem(p) && p.time >= slowAfter ? 'slow' : ''}>{secs(p)}</td>
                    <td>{p.state ?? ''}{p.progress ? ` (${fmt(p.progress, 0)}%)` : ''}</td>
                    <td className={idle !== null && idle >= slowAfter ? 'slow' : ''}>{tx ? (idle !== null ? t('inattiva da {0}', duration(idle)) : `${tx.state ?? ''} · ${duration(tx.age ?? 0)}`) : ''}</td>
                    <td>{bl ? t('blocca {0}', bl.join(', ')) : wf ? t('attende {0}', wf.map((w) => w.blocker).join(', ')) : ''}</td>
                    <td className="q" title={p.info ?? ''}>{oneLine(p.info)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!procs.length && <div className="empty">{snap ? t('Nessun processo con i filtri scelti.') : t('Caricamento…')}</div>}
        </div>
        {picked && <div className="proc-detail">
          <div className="procs-bar">
            <b>{t('Thread {0}', picked.id)}</b>
            <span className="muted">{picked.user}@{picked.host}{picked.db ? ` · ${picked.db}` : ''} · {picked.command} · {secs(picked)}{picked.state ? ` · ${picked.state}` : ''}</span>
            <div className="spacer" />
            <button disabled={!picked.info || picked.command === 'Sleep'} onClick={() => explain(picked)} title={snap?.flavor === 'mariadb' ? 'SHOW EXPLAIN FOR' : 'EXPLAIN FOR CONNECTION'}>{t('Piano di esecuzione')}</button>
            <button disabled={!picked.info} onClick={() => newDoc({ connId, db: picked.db, sql: `${pretty(picked.info!)};\n` })}>{t("Apri nell'editor")}</button>
            <button disabled={picked.command === 'Sleep'} onClick={() => kill([picked], true)}>{t('Termina query')}</button>
            <button className="danger" onClick={() => kill([picked], false)}>{t('Termina connessione')}</button>
          </div>
          <div className="proc-detail-body">
            {trx.get(picked.id) && (() => {
              const tx = trx.get(picked.id)!;
              return <p className="note">{t('Transazione {0}: {1}, aperta da {2}, {3} righe bloccate, {4} modificate, {5} tabelle bloccate, isolamento {6}.', tx.id ?? '', tx.state ?? '', duration(tx.age ?? 0), tx.rowsLocked ?? 0, tx.rowsModified ?? 0, tx.tablesLocked ?? 0, tx.isolation ?? '')}
                {idleInTrx(picked, trx) !== null && <b className="warn-text"> {t('La connessione è inattiva con la transazione aperta: trattiene i lock finché non esegue COMMIT/ROLLBACK.')}</b>}</p>;
            })()}
            {waitingFor.get(picked.id)?.map((w) => <p key={`w${w.blocker}`} className="note warn-text">{w.guess ? t('Probabilmente in attesa del thread {0} (transazione aperta da prima dell\'attesa).', who(w.blocker)) : t('In attesa del thread {0}: lock {1} {2}.', who(w.blocker), w.kind === 'mdl' ? t('di metadati') : t('di riga'), `${w.mode ?? ''} ${w.object ?? ''}`.trim())}</p>)}
            {blocking.get(picked.id) && <p className="note err-text">{t('Blocca i thread {0}.', blocking.get(picked.id)!.join(', '))}</p>}
            {picked.info ? <pre className="hist-sql">{pretty(picked.info)}</pre> : <p className="note">{t('Nessuna istruzione in esecuzione.')}</p>}
            {plan && plan.id === picked.id && ('error' in plan
              ? <div className="status error">{plan.error}</div>
              : <table className="dtable plan-table"><thead><tr>{plan.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{plan.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j}>{v ?? ''}</td>)}</tr>)}</tbody></table>)}
          </div>
        </div>}
      </div>}

      {tab === 'trx' && <div className="maint-body"><div className="procs-table">
        <table className="dtable">
          <thead><tr><th>{t('Transazione')}</th><th>Thread</th><th>{t('Utente')}</th><th>{t('Stato')}</th><th>{t('Aperta da')}</th><th>{t('Righe bloccate')}</th><th>{t('Righe modificate')}</th><th>{t('Tabelle')}</th><th>{t('Isolamento')}</th><th>Query</th><th /></tr></thead>
          <tbody>
            {[...(snap?.trx ?? [])].sort((a, b) => (b.age ?? 0) - (a.age ?? 0)).map((tx) => {
              const p = tx.thread !== null ? procOf(tx.thread) : undefined;
              const idle = p ? idleInTrx(p, trx) : null;
              return (
                <tr key={tx.id ?? tx.thread} className={idle !== null && idle >= slowAfter ? 'idle-trx' : tx.state === 'LOCK WAIT' ? 'waiting' : ''}>
                  <td>{tx.id}</td><td>{tx.thread}</td><td>{p ? `${p.user}@${hostOnly(p.host)}` : ''}</td>
                  <td>{tx.state}{tx.state === 'LOCK WAIT' && tx.waitAge !== null ? ` (${duration(tx.waitAge)})` : ''}</td>
                  <td className={(tx.age ?? 0) >= slowAfter ? 'slow' : ''}>{duration(tx.age ?? 0)}</td>
                  <td>{tx.rowsLocked}</td><td>{tx.rowsModified}</td><td>{tx.tablesLocked}</td><td>{tx.isolation}</td>
                  <td className="q" title={tx.query ?? p?.info ?? ''}>{tx.query ? oneLine(tx.query) : idle !== null ? <i className="muted">{t('inattiva da {0}', duration(idle))}</i> : ''}</td>
                  <td className="act">{p && <button className="danger" onClick={() => kill([p], false)}>{t('Termina')}</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {snap && !snap.trx.length && <div className="empty">{missing.some((m) => m.what === 'trx') ? missing.find((m) => m.what === 'trx')!.message : t('Nessuna transazione InnoDB aperta.')}</div>}
      </div></div>}

      {tab === 'locks' && <div className="maint-body lock-body">
        {!roots.length && <div className="empty">{t('Nessun thread in attesa di lock.')}</div>}
        {roots.map((r) => {
          const p = procOf(r.blocker);
          const tx = trx.get(r.blocker);
          return (
            <div key={r.blocker} className="lock-card">
              <div className="procs-bar">
                <b>{t('Thread {0} blocca {1}', who(r.blocker), tn(r.total, '{0} thread', '{0} thread'))}</b>
                <span className="muted">{p ? `${p.command} · ${secs(p)}` : ''}{tx ? ` · ${t('transazione aperta da {0}', duration(tx.age ?? 0))}` : ''}</span>
                <div className="spacer" />
                {p && <button className="danger" onClick={() => kill([p], false)}>{t('Termina il bloccante')}</button>}
              </div>
              {p?.info ? <pre className="hist-sql">{oneLine(p.info, 600)}</pre> : <p className="note">{p?.command === 'Sleep' ? t('Inattivo: la transazione aperta trattiene i lock (manca COMMIT o ROLLBACK).') : ''}</p>}
              <table className="dtable">
                <thead><tr><th>{t('In attesa')}</th><th>{t('Da')}</th><th>{t('Lock')}</th><th>{t('Oggetto')}</th><th>Query</th></tr></thead>
                <tbody>
                  {onePerWaiter(ws.filter((w) => w.blocker === r.blocker || [...reachFrom(r.blocker, ws)].includes(w.blocker)), r.blocker).map((w) => (
                    <tr key={`${w.waiter}-${w.blocker}-${w.kind}`}>
                      <td>{who(w.waiter)}{w.blocker !== r.blocker ? <span className="muted"> ({t('dietro a {0}', w.blocker)})</span> : null}</td>
                      <td>{w.seconds !== null ? duration(w.seconds) : ''}</td>
                      <td>{w.kind === 'mdl' ? t('metadati') : t('riga')}{w.mode ? ` ${w.mode}` : ''}{w.guess ? ` (${t('presunto')})` : ''}</td>
                      <td>{w.object ?? ''}</td>
                      <td className="q">{oneLine(procOf(w.waiter)?.info ?? null, 160)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
        {missing.filter((m) => m.what !== 'trx').map((m) => <p key={m.what} className="note">{m.what === 'locks' ? t('Lock di riga non leggibili: {0}', m.message) : m.message}</p>)}
        {snap?.flavor === 'mariadb' && missing.some((m) => m.what === 'mdl') && <button className="link" onClick={installMdl}>{t('Installa il plugin METADATA_LOCK_INFO…')}</button>}
      </div>}

      {tab === 'summary' && <div className="maint-body">
        <div className="maint-actions">
          <span>{t('Raggruppa per')}</span>
          {(['user', 'host', 'db', 'command', 'state'] as GroupKey[]).map((k) => (
            <button key={k} className={group === k ? 'on' : ''} onClick={() => setGroup(k)}>{{ user: t('Utente'), host: 'Host', db: 'Database', command: t('Comando'), state: t('Stato') }[k]}</button>
          ))}
        </div>
        <div className="procs-table">
          <table className="dtable summary-table">
            <thead><tr><th>{{ user: t('Utente'), host: 'Host', db: 'Database', command: t('Comando'), state: t('Stato') }[group]}</th><th className="num">{t('Thread')}</th><th className="num">{t('Attivi')}</th><th className="num">{t('Query più lunga')}</th><th /></tr></thead>
            <tbody>
              {summary(all.filter((p) => !hideSystem || !isSystem(p)), group).map((g) => (
                <tr key={g.value}>
                  <td>{g.value || <i className="muted">{t('(nessuno)')}</i>}</td>
                  <td className="num"><span className="bar" style={{ width: `${(g.count / Math.max(1, all.length)) * 100}%` }} />{g.count}</td>
                  <td className="num">{g.active}</td>
                  <td className="num">{g.active ? duration(g.maxTime) : ''}</td>
                  <td className="act"><button onClick={() => { setFilter(g.value); setTab('procs'); }}>{t('Mostra')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>}

      {tab === 'deadlock' && <div className="maint-body lock-body">
        <div className="maint-actions">
          <button onClick={loadDeadlock}>{t('Rileggi')}</button>
          <span className="muted">SHOW ENGINE INNODB STATUS</span>
          <div className="spacer" />
          {deadlock?.raw && <button onClick={() => useStore.getState().set({ viewer: { title: 'SHOW ENGINE INNODB STATUS', value: deadlock.raw } })}>{t('Stato InnoDB completo')}</button>}
        </div>
        {deadlock?.error && <div className="status error">{deadlock.error}</div>}
        {deadlock && !deadlock.error && !deadlock.d && <div className="empty">{t('Nessun deadlock dall\'avvio del server.')}</div>}
        {deadlock?.d && <>
          <p className="note">{t('Deadlock del {0}: InnoDB ha annullato la transazione {1}.', deadlock.d.at ?? '?', deadlock.d.victim ?? '?')}</p>
          {deadlock.d.transactions.map((x) => (
            <div key={x.n} className={`lock-card${x.n === deadlock.d!.victim ? ' victim' : ''}`}>
              <div className="procs-bar"><b>{t('Transazione {0}', x.n)}</b><span className="muted">{x.thread !== null ? `thread ${x.thread}` : ''}{x.account ? ` · ${x.account}` : ''}</span>
                {x.n === deadlock.d!.victim && <span className="badge st-target">{t('annullata (vittima)')}</span>}</div>
              <pre className="hist-sql">{x.query}</pre>
              {x.holds && <><div className="props-title">{t('Lock posseduti')}</div><pre className="lock-text">{x.holds}</pre></>}
              {x.waits && <><div className="props-title">{t('Lock atteso')}</div><pre className="lock-text">{x.waits}</pre></>}
              {x.conflicts && <><div className="props-title">{t('In conflitto con')}</div><pre className="lock-text">{x.conflicts}</pre></>}
            </div>
          ))}
          <p className="note">{t('Per evitare i deadlock: accedi alle righe sempre nello stesso ordine, tieni brevi le transazioni, usa indici che limitino le righe bloccate; l\'applicazione deve ripetere la transazione annullata.')}</p>
        </>}
      </div>}
    </div>
  );
}

/** One row per waiting thread: the direct wait on the root blocker first, else the first one found. */
function onePerWaiter(list: Wait[], root: number) {
  const m = new Map<number, Wait>();
  for (const w of list) if (!m.has(w.waiter) || (w.blocker === root && m.get(w.waiter)!.blocker !== root)) m.set(w.waiter, w);
  return [...m.values()];
}

function reachFrom(id: number, ws: Wait[], seen = new Set<number>()) {
  for (const w of ws) if (w.blocker === id && !seen.has(w.waiter)) { seen.add(w.waiter); reachFrom(w.waiter, ws, seen); }
  return seen;
}
