// SQL assistant prompts and reply parsing. Pure functions (no React, no IPC) for tests.
import type { ErModel } from './er';

export const SYSTEM_PROMPT = `Sei l'assistente SQL integrato in MiB-SQL, un IDE per MariaDB e MySQL. Aiuti chi lavora sul database qui sotto: scrivi query, le spieghi, correggi errori e suggerisci ottimizzazioni.

Rispondi in italiano, in modo conciso. Quando proponi SQL mettilo in un blocco \`\`\`sql e usa solo tabelle e colonne presenti nello schema; se una richiesta non si può soddisfare con lo schema, dillo invece di inventare nomi. Scrivi SQL valido per la versione del server indicata.

Tu non esegui nulla: l'utente decide se inserire ed eseguire il codice. Per istruzioni che modificano dati o struttura (UPDATE, DELETE, ALTER, DROP, TRUNCATE) segnala gli effetti e, se utile, proponi prima una SELECT di verifica. Su tabelle grandi preferisci condizioni su colonne indicizzate e un LIMIT nelle query esplorative.`;

/** Compact schema description: one line per table with columns, keys and estimated rows; then relations. */
export function schemaText(model: ErModel, db: string, server: string) {
  const lines = [`Server: ${server}`, `Database: ${db}`, ''];
  const fkCols = new Map<string, Set<string>>();
  for (const fk of model.fks) {
    const s = fkCols.get(fk.table) ?? new Set<string>();
    fk.columns.forEach((c) => s.add(c));
    fkCols.set(fk.table, s);
  }
  for (const t of model.tables) {
    const cols = t.columns.map((c) => `${c.name} ${c.type}${c.pk ? ' PK' : ''}${fkCols.get(t.name)?.has(c.name) ? ' FK' : ''}${c.nullable ? '' : ' NOT NULL'}`);
    const rows = t.rows !== null && t.kind === 'table' ? `, ~${t.rows} righe` : '';
    lines.push(`${t.kind === 'view' ? 'VISTA' : 'TABELLA'} ${t.name} (${cols.join(', ')})${rows}${t.comment ? ` -- ${t.comment}` : ''}`);
  }
  if (model.fks.length) {
    lines.push('', 'Relazioni:');
    for (const fk of model.fks) lines.push(`${fk.table}(${fk.columns.join(', ')}) -> ${fk.refDb && fk.refDb !== db ? fk.refDb + '.' : ''}${fk.refTable}(${fk.refColumns.join(', ')})`);
  }
  return lines.join('\n');
}

export interface TurnContext {
  script?: string;          // current SQL document (or the statement under the cursor)
  error?: string;           // last error message of the document
  plan?: string;            // EXPLAIN / profile summary
  sample?: string;          // first rows of the current result, TSV
}

/** User message: the question, then the context the user chose to share, clearly delimited. */
export function userMessage(question: string, ctx: TurnContext) {
  const parts = [question.trim()];
  if (ctx.script?.trim()) parts.push(`Script corrente nell'editor:\n\`\`\`sql\n${ctx.script.trim().slice(0, 20000)}\n\`\`\``);
  if (ctx.error) parts.push(`Ultimo errore restituito dal server:\n${ctx.error}`);
  if (ctx.plan) parts.push(`Piano / profilo dell'ultima esecuzione:\n${ctx.plan.slice(0, 8000)}`);
  if (ctx.sample) parts.push(`Prime righe del risultato (TSV):\n${ctx.sample.slice(0, 8000)}`);
  return parts.join('\n\n');
}

export type Block = { type: 'text'; text: string } | { type: 'code'; lang: string; text: string };

/** Splits a reply into text and fenced code blocks (an unterminated fence while streaming is still code). */
export function parseBlocks(reply: string): Block[] {
  const out: Block[] = [];
  const re = /```([\w-]*)[^\n]*\n([\s\S]*?)(?:```|$(?![\s\S]))/g;
  let last = 0;
  for (const m of reply.matchAll(re)) {
    const before = reply.slice(last, m.index);
    if (before.trim()) out.push({ type: 'text', text: before.trim() });
    out.push({ type: 'code', lang: (m[1] || 'sql').toLowerCase(), text: m[2].replace(/\n$/, '') });
    last = m.index! + m[0].length;
  }
  const rest = reply.slice(last);
  if (rest.trim()) out.push({ type: 'text', text: rest.trim() });
  return out;
}

/** Inline markdown of a text block: **bold**, `code`, and line breaks; returns segments to render. */
export function inlineSegments(text: string): { kind: 'plain' | 'bold' | 'code'; text: string }[] {
  const out: { kind: 'plain' | 'bold' | 'code'; text: string }[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ kind: 'plain', text: text.slice(last, m.index) });
    out.push(m[0].startsWith('**') ? { kind: 'bold', text: m[0].slice(2, -2) } : { kind: 'code', text: m[0].slice(1, -1) });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'plain', text: text.slice(last) });
  return out;
}
