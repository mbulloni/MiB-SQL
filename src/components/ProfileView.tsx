import { useMemo } from 'react';
import { COUNTERS, hints, planRows, type Profile } from '../profile';
import { t as tr, locale } from '../i18n';

const fmt = (v: number, d = 2) => v.toLocaleString(locale(), { maximumFractionDigits: d });

/** Profilo tab: hints, stage timeline, session counters and the real execution plan. */
export default function ProfileView({ profile: p }: { profile: Profile }) {
  const tips = useMemo(() => hints(p), [p]);
  const rows = useMemo(() => (p.plan?.format === 'json' ? planRows(p.plan.data) : []), [p]);
  const maxStage = Math.max(0.001, ...p.stages.map((s) => s.ms));
  const top = new Set([...p.stages].sort((a, b) => b.ms - a.ms).slice(0, 3).map((s) => s.stage));
  return (
    <div className="profile">
      <div className="prof-head">
        <div className="tile"><span>{tr('Tempo')}</span><b>{fmt(p.ms, 1)} ms</b></div>
        <div className="tile"><span>{p.rows ? tr('Righe restituite') : tr('Righe interessate')}</span><b>{fmt(p.rows || p.affectedRows || 0, 0)}</b></div>
        <div className="tile grow"><span>{tr('Istruzione')}</span><code>{p.sql.replace(/\s+/g, ' ').slice(0, 220)}</code></div>
      </div>
      <div className="prof-hints">
        {tips.map((t, i) => <div key={i} className={`prof-hint ${t.level}`}><span className="tag">{t.level === 'warn' ? tr('⚠ Attenzione') : tr('ℹ Nota')}</span>{t.text}</div>)}
      </div>
      <div className="prof-cols">
        <section>
          <h4>{tr('Fasi di esecuzione')}{' '}<small>SHOW PROFILE</small></h4>
          {p.stages.length ? p.stages.map((s, i) => (
            <div key={i} className={`stage${top.has(s.stage) ? ' top' : ''}`} title={`${s.stage}: ${fmt(s.ms, 3)} ms`}>
              <span className="name">{s.stage}</span>
              <span className="bar"><span style={{ width: `${Math.max(1, (s.ms / maxStage) * 100)}%` }} /></span>
              <span className="ms">{fmt(s.ms, 3)} ms</span>
            </div>
          )) : <div className="empty">{tr('Profiling non disponibile su questo server.')}</div>}
        </section>
        <section>
          <h4>{tr('Contatori di sessione')}{' '}<small>{tr('variazione durante l\'esecuzione')}</small></h4>
          <table className="dtable">
            <tbody>
              {p.status.map((s) => (
                <tr key={s.name}><td className="num">{fmt(s.value, 0)}</td><td><code>{s.name}</code></td><td className="muted">{COUNTERS[s.name] ?? ''}</td></tr>
              ))}
            </tbody>
          </table>
          {!p.status.length && <div className="empty">{tr('Nessun contatore modificato.')}</div>}
        </section>
      </div>
      {p.plan && (
        <section className="prof-plan">
          <h4>{tr('Piano reale')}{' '}<small>{p.plan.format === 'json' ? tr('ANALYZE FORMAT=JSON: la query è stata eseguita una seconda volta') : p.plan.format === 'tree' ? 'EXPLAIN ANALYZE' : ''}</small></h4>
          {p.plan.format === 'json' ? (
            <table className="dtable">
              <thead><tr><th>{tr('Operazione / tabella')}</th><th>{tr('Accesso')}</th><th>{tr('Indice')}</th><th className="num">{tr('Righe stimate')}</th><th className="num">{tr('Righe reali')}</th><th className="num">{tr('Cicli')}</th><th className="num">{tr('Filtrate %')}</th><th className="num">{tr('Tempo')}</th><th>{tr('Condizione')}</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r.warn ? 'warn' : ''}>
                    <td style={{ paddingLeft: 6 + r.depth * 16 }}>{r.access ? <b>{r.label}</b> : <i>{r.label}</i>}</td>
                    <td className={r.access === 'ALL' ? 'bad' : ''}>{r.access ?? ''}</td>
                    <td>{r.key ?? ''}</td>
                    <td className="num">{r.rows !== undefined ? fmt(r.rows, 0) : ''}</td>
                    <td className="num">{r.rRows !== undefined ? fmt(r.rRows, 1) : ''}</td>
                    <td className="num">{r.loops !== undefined ? fmt(r.loops, 0) : ''}</td>
                    <td className="num">{r.filtered !== undefined ? `${fmt(r.filtered, 0)}${r.rFiltered !== undefined ? ` / ${fmt(r.rFiltered, 0)}` : ''}` : ''}</td>
                    <td className="num">{r.ms !== undefined ? `${fmt(r.ms, 2)} ms` : ''}</td>
                    <td className="cond" title={r.condition}>{r.condition ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <pre className="script">{p.plan.data}</pre>}
        </section>
      )}
    </div>
  );
}
