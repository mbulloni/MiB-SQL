import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { newDoc } from '../actions';
import { duration, metrics, niceMax, type Metrics, type Snapshot } from '../monitor';
import { useStore } from '../store';
import type { Doc } from '../types';
import { t, locale } from '../i18n';

const HISTORY = 90;
const fmt = (v: number, digits = 1) => v.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const clock = (t: number) => new Date(t).toLocaleTimeString(locale());

/** One series over time: area + 2px line, y from zero, crosshair tooltip on hover; the title names the series. */
function TrendChart({ title, unit, points, digits = 1, max }: { title: string; unit: string; points: { t: number; v: number | null }[]; digits?: number; max?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(300);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => setW(box.current!.clientWidth));
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);
  const H = 86;
  const padL = 34;
  const padB = 4;
  const values = points.map((p) => p.v).filter((v): v is number => v !== null);
  const top = max ?? niceMax(Math.max(0, ...values));
  const last = values.length ? values[values.length - 1] : null;
  const x = (i: number) => padL + (i / Math.max(1, HISTORY - 1)) * (w - padL - 4);
  const offset = HISTORY - points.length;
  const y = (v: number) => 6 + (1 - v / top) * (H - 6 - padB);
  let line = '';
  let area = '';
  points.forEach((p, i) => {
    if (p.v === null) return;
    const px = x(offset + i);
    line += `${line ? 'L' : 'M'} ${px.toFixed(1)} ${y(p.v).toFixed(1)} `;
  });
  const firstIdx = points.findIndex((p) => p.v !== null);
  if (line && firstIdx >= 0) {
    const lastIdx = points.length - 1 - [...points].reverse().findIndex((p) => p.v !== null);
    area = `${line} L ${x(offset + lastIdx).toFixed(1)} ${y(0)} L ${x(offset + firstIdx).toFixed(1)} ${y(0)} Z`;
  }
  const h = hover !== null ? points[hover] : null;
  const onMove = (e: React.MouseEvent) => {
    const r = box.current!.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left - padL) / (w - padL - 4)) * (HISTORY - 1)) - offset;
    setHover(i >= 0 && i < points.length ? i : null);
  };
  return (
    <div className="trend" ref={box}>
      <div className="trend-head"><span className="t">{title}</span><span className="v">{last === null ? '—' : `${fmt(last, digits)} ${unit}`}</span></div>
      <svg width={w} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid" x1={padL} x2={w - 4} y1={y(top * f)} y2={y(top * f)} />
            <text className="axis" x={padL - 5} y={y(top * f) + 3.5} textAnchor="end">{fmt(top * f, top * f < 10 ? 1 : 0)}</text>
          </g>
        ))}
        {area && <path className="area" d={area} />}
        {line && <path className="line" d={line} />}
        {h && h.v !== null && <>
          <line className="cross" x1={x(offset + hover!)} x2={x(offset + hover!)} y1={4} y2={H - padB} />
          <circle className="dot" cx={x(offset + hover!)} cy={y(h.v)} r="4" />
        </>}
      </svg>
      {h && <div className="tip" style={{ left: Math.min(w - 120, Math.max(0, x(offset + hover!) - 60)) }}>{clock(h.t)} · <b>{h.v === null ? '—' : `${fmt(h.v, digits)} ${unit}`}</b></div>}
      {!values.length && <div className="trend-empty">{t('In attesa di dati…')}</div>}
    </div>
  );
}

export default function Monitor({ doc }: { doc: Doc }) {
  const connId = doc.connId!;
  const connOpen = useStore((s) => s.connState[connId]?.status === 'open');
  const conn = useStore((s) => s.conns.find((c) => c.id === connId));
  const [interval, setIntervalMs] = useState(2000);
  const [paused, setPaused] = useState(false);
  const [hideSleep, setHideSleep] = useState(true);
  const [filter, setFilter] = useState('');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<Metrics[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<number | null>(null);
  const prev = useRef<Snapshot | null>(null);

  useEffect(() => {
    if (!connOpen) { useStore.getState().openConn(connId); return; }
    if (paused) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.monitor.snapshot(connId);
        if (stop) return;
        if (prev.current) {
          const m = metrics(prev.current, s);
          setHistory((h) => [...h, m].slice(-HISTORY));
        }
        prev.current = s;
        setSnap(s);
        setError(null);
      } catch (err) { if (!stop) setError((err as Error).message); }
    };
    tick();
    const t = setInterval(tick, interval);
    return () => { stop = true; clearInterval(t); };
  }, [connOpen, paused, interval]);

  const procs = useMemo(() => {
    const q = filter.toLowerCase();
    return (snap?.processes ?? []).filter((p) => (!hideSleep || p.command !== 'Sleep') && (!q || [p.user, p.host, p.db, p.info, p.state].some((x) => String(x ?? '').toLowerCase().includes(q))));
  }, [snap, hideSleep, filter]);
  const picked = snap?.processes.find((p) => p.id === sel) ?? null;

  const killIt = async (queryOnly: boolean) => {
    if (!picked) return;
    const what = queryOnly ? t('la query del thread {0}', picked.id) : t('la connessione {0} ({1}@{2})', picked.id, picked.user, picked.host);
    if ((await api.confirm(t('Terminare {0}?', what), picked.info ? picked.info.slice(0, 300) : '', [t('Termina'), t('Annulla')])) !== 0) return;
    try { await api.monitor.kill(connId, picked.id, queryOnly); } catch (err) { setError((err as Error).message); }
  };

  const series = (k: keyof Metrics) => history.map((m) => ({ t: m.at, v: m[k] as number | null }));
  const st = snap?.status ?? {};
  const maxConn = Number(snap?.variables.max_connections ?? 0);

  return (
    <div className="monitor">
      <div className="er-bar">
        <span className="muted">{conn?.name} · {snap?.variables.version ?? ''}</span>
        <div className="spacer" />
        <label className="check"><input type="checkbox" checked={hideSleep} onChange={(e) => setHideSleep(e.target.checked)} />{' '}{t('Nascondi inattive')}</label>
        <input className="search" placeholder={t('Filtra processi…')} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select value={interval} onChange={(e) => setIntervalMs(Number(e.target.value))} title={t('Aggiornamento')}>
          {[1000, 2000, 5000, 10000].map((v) => <option key={v} value={v}>{t('ogni')}{' '}{v / 1000} s</option>)}
        </select>
        <button className={paused ? 'active' : ''} onClick={() => setPaused((p) => !p)}>{paused ? t('▶ Riprendi') : t('❚❚ Pausa')}</button>
      </div>
      {error && <div className="status error cmp-error">{error}</div>}
      <div className="mon-body">
        <div className="tiles">
          <div className="tile"><span>{t('Attivo da')}</span><b>{st.Uptime ? duration(st.Uptime) : '—'}</b></div>
          <div className="tile"><span>{t('Connessioni')}</span><b>{st.Threads_connected ?? '—'}{maxConn ? <small> / {maxConn}</small> : null}</b></div>
          <div className="tile"><span>{t('Picco connessioni')}</span><b>{st.Max_used_connections ?? '—'}</b></div>
          <div className="tile"><span>{t('Query lente (totale)')}</span><b>{st.Slow_queries !== undefined ? fmt(st.Slow_queries, 0) : '—'}</b></div>
          <div className="tile"><span>{t('Tabelle temporanee su disco')}</span><b>{st.Created_tmp_disk_tables !== undefined ? fmt(st.Created_tmp_disk_tables, 0) : '—'}</b></div>
        </div>
        <div className="charts">
          <TrendChart title={t('Query al secondo')} unit="q/s" points={series('qps')} />
          <TrendChart title={t('Thread in esecuzione')} unit="" points={series('threadsRunning')} digits={0} />
          <TrendChart title={t('Connessioni aperte')} unit="" points={series('threadsConnected')} digits={0} />
          <TrendChart title={t('Scritture al secondo')} unit="op/s" points={series('writesPerSec')} />
          <TrendChart title={t('Rete in entrata')} unit="KB/s" points={series('inKBs')} />
          <TrendChart title={t('Rete in uscita')} unit="KB/s" points={series('outKBs')} />
          <TrendChart title={t('Hit ratio buffer pool')} unit="%" points={series('hitRatio')} max={100} />
          <TrendChart title={t('Query lente al minuto')} unit="/min" points={series('slowPerMin')} />
        </div>
        <div className="procs">
          <div className="procs-bar">
            <b>{t('Processi')}</b><span className="muted">{procs.length}{' '}{t('di')}{' '}{snap?.processes.length ?? 0}</span>
            <div className="spacer" />
            <button disabled={!picked?.info} onClick={() => picked && useStore.getState().set({ viewer: { title: `Thread ${picked.id}`, value: picked.info ?? '' } })}>{t('Mostra query')}</button>
            <button disabled={!picked?.info} onClick={() => picked && newDoc({ connId, db: picked.db, sql: `${picked.info};\n` })}>{t('Apri nell\'editor')}</button>
            <button disabled={!picked || picked.command === 'Sleep'} onClick={() => killIt(true)}>{t('Termina query')}</button>
            <button className="danger" disabled={!picked} onClick={() => killIt(false)}>{t('Termina connessione')}</button>
          </div>
          <div className="procs-table">
            <table className="dtable">
              <thead><tr><th>ID</th><th>{t('Utente')}</th><th>{t('Host')}</th><th>DB</th><th>{t('Comando')}</th><th>{t('Tempo')}</th><th>{t('Stato')}</th><th>{t('Query')}</th></tr></thead>
              <tbody>
                {procs.map((p) => (
                  <tr key={p.id} className={sel === p.id ? 'sel' : ''} onMouseDown={() => setSel(p.id)}
                    onDoubleClick={() => p.info && useStore.getState().set({ viewer: { title: `Thread ${p.id}`, value: p.info } })}>
                    <td>{p.id}</td><td>{p.user}</td><td>{p.host}</td><td>{p.db ?? ''}</td><td>{p.command}</td>
                    <td className={p.command !== 'Sleep' && p.time >= 10 ? 'slow' : ''}>{p.timeMs !== null && p.time < 60 ? `${fmt(p.timeMs / 1000, 1)} s` : duration(p.time)}</td>
                    <td>{p.state ?? ''}{p.progress ? ` (${fmt(p.progress, 0)}%)` : ''}</td>
                    <td className="q" title={p.info ?? ''}>{(p.info ?? '').replace(/\s+/g, ' ').slice(0, 200)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!procs.length && <div className="empty">{t('Nessun processo con i filtri scelti.')}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
