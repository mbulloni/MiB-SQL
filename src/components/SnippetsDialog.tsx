import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { setSnippets, snippetPreview } from '../editor';
import { useStore } from '../store';
import type { Snippet } from '../types';

/** Snippet manager: prefix typed in the editor + Tab (or the completion list) inserts the body. */
export default function SnippetsDialog({ body }: { body?: string }) {
  const [list, setList] = useState<Snippet[] | null>(null);
  const [custom, setCustom] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => useStore.getState().set({ snippetDialog: null });

  useEffect(() => {
    api.snippets.list().then((r) => {
      let l = r.list;
      if (body !== undefined) {
        // "save selection as snippet": $ is literal text in a snippet body
        const fresh = { id: crypto.randomUUID(), prefix: '', name: '', body: body.replace(/\$/g, '\\$') };
        l = [fresh, ...l];
        setSel(fresh.id);
      } else setSel(l[0]?.id ?? null);
      setList(l);
      setCustom(r.custom);
    }).catch((err) => setError((err as Error).message));
  }, []);

  const cur = list?.find((s) => s.id === sel) ?? null;
  const patch = (p: Partial<Snippet>) => setList((l) => l && l.map((s) => (s.id === sel ? { ...s, ...p } : s)));
  const shown = useMemo(() => (list ?? []).filter((s) => !filter || `${s.prefix} ${s.name}`.toLowerCase().includes(filter.toLowerCase())), [list, filter]);

  const problem = useMemo(() => {
    if (!list) return null;
    const seen = new Set<string>();
    for (const s of list) {
      if (!s.prefix.trim()) return 'Ogni snippet deve avere un prefisso.';
      if (/\s/.test(s.prefix.trim())) return `Il prefisso «${s.prefix}» non può contenere spazi.`;
      if (seen.has(s.prefix.trim().toLowerCase())) return `Prefisso «${s.prefix}» usato due volte.`;
      seen.add(s.prefix.trim().toLowerCase());
    }
    const empty = list.find((s) => !s.body.trim());
    return empty ? `Lo snippet «${empty.prefix}» è vuoto.` : null;
  }, [list]);

  const save = async () => {
    if (!list || problem) return;
    try {
      const r = await api.snippets.save(list);
      setSnippets(r.list);
      close();
    } catch (err) { setError((err as Error).message); }
  };
  const reset = async () => {
    if ((await api.confirm('Ripristinare gli snippet predefiniti?', 'Gli snippet aggiunti o modificati verranno persi.', ['Ripristina', 'Annulla'])) !== 0) return;
    const r = await api.snippets.save(null);
    setSnippets(r.list);
    setList(r.list);
    setCustom(false);
    setSel(r.list[0]?.id ?? null);
  };
  const add = () => {
    const s = { id: crypto.randomUUID(), prefix: '', name: '', body: '' };
    setList((l) => [s, ...(l ?? [])]);
    setSel(s.id);
    setFilter('');
  };
  const remove = () => {
    if (!cur) return;
    const at = list!.findIndex((s) => s.id === cur.id);
    const next = list!.filter((s) => s.id !== cur.id);
    setList(next);
    setSel(next[Math.min(at, next.length - 1)]?.id ?? null);
  };

  return (
    <div className="modal-back" onMouseDown={close}>
      <div className="modal wizard snippets" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') close(); }}>
        <div className="modal-title">Snippet SQL<span className="hint">scrivi il prefisso nell'editor e premi Tab (o sceglilo dall'elenco dei suggerimenti)</span></div>
        <div className="snip-body">
          <div className="snip-list">
            <input className="filter" placeholder="Filtra…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="snip-items">
              {shown.map((s) => (
                <div key={s.id} className={`cmp-item${s.id === sel ? ' sel' : ''}`} onMouseDown={() => setSel(s.id)}>
                  <code>{s.prefix || '(nuovo)'}</code><span className="name muted">{s.name}</span>
                </div>
              ))}
            </div>
            <div className="snip-actions">
              <button onClick={add}>+ Nuovo</button>
              <button onClick={remove} disabled={!cur}>Elimina</button>
            </div>
          </div>
          {cur ? (
            <div className="form snip-edit">
              <div className="row">
                <label>Prefisso<input value={cur.prefix} autoFocus={body !== undefined} placeholder="es. selw" onChange={(e) => patch({ prefix: e.target.value })} /></label>
                <label className="grow">Descrizione<input value={cur.name} onChange={(e) => patch({ name: e.target.value })} /></label>
              </div>
              <label className="grow">Testo
                <textarea className="snip-text" spellCheck={false} value={cur.body} onChange={(e) => patch({ body: e.target.value })} />
              </label>
              <p className="note">Segnaposti: <code>{'${1:tabella}'}</code> (Tab passa al successivo; lo stesso numero si ripete), <code>{'${2|ASC,DESC|}'}</code> scelta, <code>$0</code> posizione finale del cursore, <code>\$</code> per il simbolo $.</p>
              <div className="props-title">Anteprima</div>
              <pre className="hist-sql snip-preview">{snippetPreview(cur.body)}</pre>
            </div>
          ) : <div className="empty">Nessuno snippet.</div>}
        </div>
        {(error || problem) && <div className="status error">{error ?? problem}</div>}
        <div className="modal-buttons">
          <button onClick={reset} disabled={!custom && body === undefined}>Ripristina predefiniti</button>
          <div className="spacer" />
          <button onClick={close}>Annulla</button>
          <button className="primary" onClick={save} disabled={!list || !!problem}>Salva</button>
        </div>
      </div>
    </div>
  );
}
