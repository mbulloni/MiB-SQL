import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { insertText, replaceDocText } from '../actions';
import { inlineSegments, parseBlocks, schemaText, SYSTEM_PROMPT, TSQL_PROMPT, userMessage, type TurnContext } from '../assistant';
import { modelOf, monaco } from '../editor';
import type { ErModel } from '../er';
import { hints } from '../profile';
import { isTds, useStore, type MetaEntry } from '../store';
import type { Doc } from '../types';
import Icon from './Icon';
import { t as tr } from '../i18n';

type ApiMessage = { role: 'user' | 'assistant'; content: unknown };
interface Turn { role: 'user' | 'assistant'; text: string; note?: string; error?: boolean }
interface Chat { system: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] | null; messages: ApiMessage[]; view: Turn[]; running: string | null }
interface Settings { source: 'key' | 'env' | 'system'; model: string; effort: string; consent: boolean; models: string[]; efforts: string[]; keyring: boolean }

// one conversation per SQL document, kept for the session (not persisted: it may contain data)
const chats = new Map<string, Chat>();
const chatOf = (id: string) => chats.get(id) ?? chats.set(id, { system: null, messages: [], view: [], running: null }).get(id)!;
let seq = 0;

const MODEL_LABEL: Record<string, string> = { 'claude-opus-5-5': 'Claude Opus 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-haiku-5-5': 'Claude Haiku 5.5' };

function Code({ text, docId }: { text: string; docId: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => { let on = true; monaco.editor.colorize(text, 'mysql', {}).then((h) => { if (on) setHtml(h); }); return () => { on = false; }; }, [text]);
  return (
    <div className="ai-code">
      {/* colorize escapes the text itself: the HTML holds only its own spans */}
      {html ? <pre dangerouslySetInnerHTML={{ __html: html }} /> : <pre>{text}</pre>}
      <div className="ai-code-bar">
        <button onClick={() => insertText(text)} title={tr('Inserisci alla posizione del cursore')}>{tr('Inserisci')}</button>
        <button onClick={() => replaceDocText(docId, text + '\n')} title={tr('Sostituisci tutto lo script (annullabile con Ctrl+Z)')}>{tr('Sostituisci')}</button>
        <button onClick={() => navigator.clipboard.writeText(text)}>{tr('Copia')}</button>
      </div>
    </div>
  );
}

function Reply({ text, docId }: { text: string; docId: string }) {
  return <>{parseBlocks(text).map((b, i) => (b.type === 'code' ? <Code key={i} text={b.text} docId={docId} /> : (
    <div key={i} className="ai-text">{b.text.split('\n').map((line, j) => <div key={j}>{inlineSegments(line).map((s, k) => (s.kind === 'bold' ? <b key={k}>{s.text}</b> : s.kind === 'code' ? <code key={k}>{s.text}</code> : <span key={k}>{s.text}</span>))}</div>)}</div>
  )))}</>;
}

export function AssistantSettings({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.ai.settings().then(setS); }, []);
  if (!s) return null;
  const save = async (patch: Record<string, unknown>) => {
    try { setS(await api.ai.saveSettings(patch)); setError(null); } catch (err) { setError((err as Error).message); }
  };
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal small" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
        <div className="modal-title">{tr('Impostazioni assistente AI')}</div>
        <div className="form">
          <label>{tr('Chiave API Anthropic')}
            <div className="row"><input type="password" className="grow" placeholder={s.source === 'key' ? tr('salvata nel portachiavi') : tr('sk-ant-…')} value={key} onChange={(e) => setKey(e.target.value)} />
              <button type="button" disabled={!key.trim()} onClick={async () => { await save({ key }); setKey(''); }}>{tr('Salva')}</button>
              {s.source === 'key' && <button type="button" onClick={() => save({ key: null })}>{tr('Rimuovi')}</button>}</div>
          </label>
          <p className="note">{s.source === 'key' ? tr('Usata la chiave salvata nel portachiavi di sistema.') : s.source === 'env' ? tr('Usata la variabile ANTHROPIC_API_KEY.') : tr('Senza chiave salvata si usano le credenziali di sistema (ANTHROPIC_API_KEY o il profilo di «ant auth login»).')}</p>
          <label>{tr('Modello')}<select value={s.model} onChange={(e) => save({ model: e.target.value })}>{s.models.map((m) => <option key={m} value={m}>{MODEL_LABEL[m] ?? m}</option>)}</select></label>
          <label>{tr('Effort (profondità del ragionamento)')}<select value={s.effort} onChange={(e) => save({ effort: e.target.value })}>{s.efforts.map((x) => <option key={x}>{x}</option>)}</select></label>
          <p className="note">{tr('«medium» è un buon equilibrio; «high» o superiore per query complesse, «low» per risposte rapide.')}</p>
          <label className="check"><input type="checkbox" checked={s.consent} onChange={(e) => save({ consent: e.target.checked })} />{' '}{tr('Consento l\'invio ad Anthropic di domande, schema del database e del contesto che scelgo')}</label>
          {error && <div className="status error">{error}</div>}
        </div>
        <div className="modal-buttons"><div className="spacer" /><button className="primary" onClick={onClose}>{tr('Chiudi')}</button></div>
      </div>
    </div>
  );
}

export default function AssistantPanel({ doc }: { doc: Doc }) {
  const [, redraw] = useState(0);
  const refresh = () => redraw((n) => n + 1);
  const chat = chatOf(doc.id);
  const [input, setInput] = useState('');
  const [sendScript, setSendScript] = useState(true);
  const [sendSample, setSendSample] = useState(false);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [consent, setConsent] = useState<null | (() => void)>(null);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const info = useStore((s) => (doc.connId ? s.connState[doc.connId]?.info : undefined));
  useEffect(() => { api.ai.settings().then(setSettings); }, [showSettings]);
  useEffect(() => api.ai.onDelta(({ id, text }) => {
    for (const c of chats.values()) {
      if (c.running === id) { c.view[c.view.length - 1].text += text; refresh(); }
    }
  }), []);
  useEffect(() => { list.current?.scrollTo(0, list.current.scrollHeight); });

  /** System prompt with the schema, frozen for the whole conversation (a new chat re-reads it). */
  const system = async () => {
    if (chat.system) return chat.system;
    let schema = tr('Nessun database selezionato nel documento.');
    if (doc.connId && doc.db) {
      const key = `${doc.connId}/${doc.db}/er`;
      const er = (await useStore.getState().loadMeta(key, () => api.meta.erModel(doc.connId!, doc.db!))) as ErModel | undefined;
      if (er) schema = schemaText(er, doc.db, info?.version ?? 'MariaDB/MySQL');
    }
    chat.system = [{ type: 'text', text: isTds(doc.connId) ? `${SYSTEM_PROMPT}\n\n${TSQL_PROMPT}` : SYSTEM_PROMPT }, { type: 'text', text: tr('Schema del database:\n{0}', schema), cache_control: { type: 'ephemeral' } }];
    return chat.system;
  };

  const context = (): TurnContext => {
    const ctx: TurnContext = {};
    if (sendScript) ctx.script = modelOf(doc.id).getValue();
    const err = [...doc.messages].reverse().find((m) => m.level === 'error');
    if (err) ctx.error = err.text + (err.sql ? tr('\nIstruzione: {0}', err.sql) : '');
    const run = doc.run;
    if (run?.profile) {
      const p = run.profile;
      ctx.plan = [tr('Tempo {0} ms, righe {1}', p.ms, p.rows || p.affectedRows || 0), ...hints(p).map((h) => `- ${h.text}`),
        ...p.status.map((s) => `${s.name} = ${s.value}`), p.plan?.format === 'json' ? JSON.stringify(p.plan.data).slice(0, 6000) : typeof p.plan?.data === 'string' ? p.plan.data : ''].filter(Boolean).join('\n');
    } else if (run?.explain && run.results[0]?.sets[0]) {
      const s = run.results[0].sets[0];
      ctx.plan = [s.columns.map((c) => c.name).join('\t'), ...s.rows.map((r) => r.map((v) => (v === null ? 'NULL' : String(v))).join('\t'))].join('\n');
    }
    if (sendSample) {
      const s = run?.results.find((r) => r.sets.length)?.sets[0];
      if (s) ctx.sample = [s.columns.map((c) => c.name).join('\t'), ...s.rows.slice(0, 20).map((r) => r.map((v) => (v === null ? 'NULL' : String(v))).join('\t'))].join('\n');
    }
    return ctx;
  };

  const send = async (question: string, consented = false) => {
    if (!question.trim() || chat.running) return;
    // the first question waits for the consent dialog, then goes on with consented = true
    if (!consented && !settings?.consent) { setConsent(() => () => send(question, true)); return; }
    const id = `ai${++seq}`;
    const text = userMessage(question, context());
    chat.view.push({ role: 'user', text: question.trim() }, { role: 'assistant', text: '' });
    chat.running = id;
    setInput('');
    refresh();
    try {
      const sys = await system();
      const messages = [...chat.messages, { role: 'user' as const, content: text }];
      const r = await api.ai.chat(id, { system: sys, messages });
      // append-only: the user turn and the full assistant content (thinking blocks included) go back next time
      chat.messages = [...messages, { role: 'assistant', content: r.content }];
      const last = chat.view[chat.view.length - 1];
      if (r.stopReason === 'refusal') { last.note = tr('Il modello ha rifiutato la richiesta{0}.', r.stopDetails?.category ? ` (categoria ${r.stopDetails.category})` : ''); last.error = true; }
      else if (r.stopReason === 'max_tokens') last.note = tr('Risposta troncata: limite di lunghezza raggiunto.');
      if (r.model && r.model !== settings?.model) last.note = tr('{0}Risposta di {1}.', last.note ? last.note + ' ' : '', MODEL_LABEL[r.model] ?? r.model);
    } catch (err) {
      const last = chat.view[chat.view.length - 1];
      last.note = (err as Error).message;
      last.error = (err as { code?: string }).code !== 'CANCELLED';
      // a failed turn is not part of the conversation: the next question starts from the last good one
    } finally {
      chat.running = null;
      refresh();
    }
  };

  const hasError = doc.messages.some((m) => m.level === 'error');
  const quick = [
    { label: tr('Spiega la query'), q: tr('Spiega cosa fa lo script corrente, istruzione per istruzione, e segnala eventuali problemi.') },
    { label: tr('Correggi l\'errore'), q: tr('Correggi l\'errore dell\'ultima esecuzione e spiega in una riga la causa.'), disabled: !hasError },
    { label: tr('Ottimizza'), q: tr('Come posso rendere più veloce questa query? Considera indici, piano di esecuzione e riscritture equivalenti.') },
  ];

  return (
    <div className="ai-panel">
      <div className="ai-head">
        <Icon name="ai" />
        <b>{tr('Assistente AI')}</b>
        <span className="muted">{settings ? MODEL_LABEL[settings.model] ?? settings.model : ''}</span>
        <div className="spacer" />
        <button title={tr('Nuova conversazione (rilegge lo schema)')} disabled={!!chat.running} onClick={() => { chats.delete(doc.id); refresh(); }}>{tr('Nuova')}</button>
        <button title={tr('Impostazioni')} onClick={() => setShowSettings(true)}>⚙</button>
        <button title={tr('Chiudi pannello')} onClick={() => useStore.getState().setAssistantOpen(false)}>×</button>
      </div>
      <div className="ai-list" ref={list}>
        {!chat.view.length && (
          <div className="ai-empty">
            <p>{tr('Chiedi una query in linguaggio naturale, oppure fai spiegare, correggere o ottimizzare lo script.')}</p>
            <p className="muted">{tr('Database:')}{' '}{doc.db ?? tr('nessuno')}{' '}{tr('· lo schema (nomi di tabelle e colonne) è incluso. Nulla viene eseguito senza di te.')}</p>
          </div>
        )}
        {chat.view.map((t, i) => (
          <div key={i} className={`ai-turn ${t.role}`}>
            {t.role === 'user' ? <div className="ai-text">{t.text}</div> : t.text ? <Reply text={t.text} docId={doc.id} /> : chat.running && i === chat.view.length - 1 ? <div className="ai-wait"><span className="spinner" />{' '}{tr('Sto pensando…')}</div> : null}
            {t.note && <div className={`ai-note${t.error ? ' error' : ''}`}>{t.note}</div>}
          </div>
        ))}
      </div>
      <div className="ai-quick">
        {quick.map((x) => <button key={x.label} disabled={!!chat.running || x.disabled} onClick={() => send(x.q)}>{x.label}</button>)}
      </div>
      <div className="ai-input">
        <textarea ref={box} rows={3} value={input} placeholder={tr('Es.: clienti di Roma con più di 10 ordini nel 2025, ordinati per fatturato (Ctrl+Invio per inviare)')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(input); } }} />
        <div className="ai-send">
          <label className="check" title={tr('Invia il testo del documento SQL')}><input type="checkbox" checked={sendScript} onChange={(e) => setSendScript(e.target.checked)} />{' '}{tr('script')}</label>
          <label className="check" title={tr('Invia le prime 20 righe dell\'ultimo risultato')}><input type="checkbox" checked={sendSample} onChange={(e) => setSendSample(e.target.checked)} />{' '}{tr('righe di esempio')}</label>
          <div className="spacer" />
          {chat.running ? <button onClick={() => api.ai.cancel(chat.running!)}>{tr('■ Stop')}</button> : <button className="primary" disabled={!input.trim()} onClick={() => send(input)}>{tr('Invia')}</button>}
        </div>
      </div>
      {showSettings && <AssistantSettings onClose={() => setShowSettings(false)} />}
      {consent && (
        <div className="modal-back">
          <div className="modal small">
            <div className="modal-title">{tr('Invio dei dati ad Anthropic')}</div>
            <div className="form">
              <p>{tr('L\'assistente usa Claude tramite l\'API di Anthropic. A ogni domanda vengono inviati:')}</p>
              <ul className="ai-consent">
                <li>{tr('la domanda e la conversazione;')}</li>
                <li>{tr('lo schema del database (nomi e tipi di tabelle e colonne, relazioni, righe stimate);')}</li>
                <li>{tr('se attivati: lo script dell\'editor, l\'ultimo errore e il piano, le prime righe del risultato.')}</li>
              </ul>
              <p className="note">{tr('Le righe dei dati non vengono inviate se non attivi «righe di esempio». La scelta si cambia nelle impostazioni dell\'assistente.')}</p>
            </div>
            <div className="modal-buttons">
              <div className="spacer" />
              <button onClick={() => setConsent(null)}>{tr('Annulla')}</button>
              <button className="primary" onClick={async () => { const s = await api.ai.saveSettings({ consent: true }); setSettings(s); const go = consent; setConsent(null); setTimeout(go, 0); }}>{tr('Accetto')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
