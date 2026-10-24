import { useEffect, useRef } from 'react';
import { reveal } from '../actions';
import { useStore } from '../store';
import type { Doc, ResultSet } from '../types';
import ResultView from './ResultView';
import ProfileView from './ProfileView';

const elapsed = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);

function Running({ since }: { since: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const t = setInterval(() => { if (ref.current) ref.current.textContent = elapsed(Date.now() - since); }, 100);
    return () => clearInterval(t);
  }, [since]);
  return <span ref={ref}>0 ms</span>;
}

export default function ResultsPanel({ doc }: { doc: Doc }) {
  const update = useStore((s) => s.updateDoc);
  const sets: { set: ResultSet; label: string; sql: string; at: [number, number] }[] = [];
  doc.run?.results.forEach((r, i) => r.sets.forEach((set, j) => {
    sets.push({ set, label: doc.run!.explain ? `Piano ${sets.length + 1}` : `Risultato ${sets.length + 1}`, sql: r.sql, at: [i, j] });
  }));
  const profile = doc.run?.profile;
  const view = doc.view === 'profile' && profile ? 'profile' : doc.view === 'messages' || doc.view === 'profile' || !sets[doc.view] ? 'messages' : doc.view;
  const current = view === 'messages' || view === 'profile' ? null : sets[view];
  const errors = doc.messages.filter((m) => m.level === 'error').length;
  const msgBox = useRef<HTMLDivElement>(null);
  useEffect(() => { if (view === 'messages') msgBox.current?.scrollTo(0, msgBox.current.scrollHeight); }, [view, doc.messages.length]);

  return (
    <div className="results">
      <div className="result-tabs">
        {sets.map((s, i) => (
          <button key={i} className={view === i ? 'active' : ''} onClick={() => update(doc.id, { view: i })} title={s.sql}>
            {s.label} <span className="count">{s.set.total.toLocaleString('it-IT')}</span>
          </button>
        ))}
        {profile && <button className={view === 'profile' ? 'active' : ''} onClick={() => update(doc.id, { view: 'profile' })}>Profilo</button>}
        <button className={view === 'messages' ? 'active' : ''} onClick={() => update(doc.id, { view: 'messages' })}>
          Messaggi {errors > 0 && <span className="count err">{errors}</span>}
        </button>
        <div className="spacer" />
        <div className="result-info">
          {doc.running && doc.startedAt ? <>In esecuzione… <Running since={doc.startedAt} /></>
            : current ? <>{current.set.total.toLocaleString('it-IT')} righe{current.set.truncated ? ` (mostrate ${current.set.rows.length.toLocaleString('it-IT')})` : ''} · {current.set.columns.length} colonne · {elapsed(doc.run!.ms)}</>
              : doc.run ? elapsed(doc.run.ms) : ''}
        </div>
      </div>
      {view === 'profile' && profile ? <ProfileView profile={profile} /> : current ? (
        current.set.columns.length ? <ResultView key={`${doc.id}/${view}`} doc={doc} set={current.set} sql={current.sql} at={current.at} /> : <div className="empty">Nessuna colonna.</div>
      ) : (
        <div className="messages" ref={msgBox}>
          {doc.messages.length === 0 && <div className="empty">Premi F5 per eseguire lo script, Ctrl+Invio per l'istruzione sotto il cursore.</div>}
          {doc.messages.map((m, i) => (
            <div key={i} className={`msg ${m.level}`} onDoubleClick={() => m.offset !== undefined && reveal(doc.id, m.offset)} title={m.sql}>
              <span className="at">{m.at}</span>
              <span className="text">{m.text}</span>
              {m.sql && <span className="sql">{m.sql.replace(/\s+/g, ' ').slice(0, 120)}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
