// Database documentation: a self-contained HTML page (contents, ER diagram, light/dark and print styles) or
// Markdown, with tables (columns, keys, indexes, foreign keys in both directions, checks, triggers, DDL),
// views, routines and events. Pure functions, tested in tests/docgen.test.mjs.
import { createSql, fromServer, type ServerTable } from './design.ts';
import { autoLayout, bounds, boxSize, HEADER, relationPath, ROW, rowY, type ErModel } from './er.ts';
import { locale, t, tn } from './i18n.ts';

export interface DocTable extends ServerTable { rows: number | null; data: number | null; idx: number | null }
export interface DocObject { kind: 'view' | 'procedure' | 'function' | 'trigger' | 'event'; name: string; ddl: string | null; table?: string; timing?: string; event?: string; status?: string }
export interface DocModel { db: string; server: string; generated: string; tables: DocTable[]; objects: DocObject[]; er: ErModel }
export interface DocOptions {
  format: 'html' | 'md';
  title: string;
  tables: string[] | null; // null = all
  columns: boolean; indexes: boolean; fks: boolean; triggers: boolean; ddl: boolean; diagram: boolean;
  views: boolean; routines: boolean; events: boolean;
}

export const DEFAULT_DOC: Omit<DocOptions, 'title'> = { format: 'html', tables: null, columns: true, indexes: true, fks: true, triggers: true, ddl: false, diagram: true, views: true, routines: true, events: true };

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const anchor = (kind: string, name: string) => `${kind}-${name.replace(/[^\w-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`)}`;
const num = (n: number | null) => (n === null ? '' : n.toLocaleString(locale()));
function size(n: number | null) {
  if (n === null) return '';
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString(locale(), { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
}

/** Shown tables, and the foreign keys pointing at each table from the others. */
function prepare(m: DocModel, o: DocOptions) {
  const pick = o.tables ? new Set(o.tables) : null;
  const tables = m.tables.filter((tb) => !pick || pick.has(tb.name)).sort((a, b) => a.name.localeCompare(b.name));
  const incoming = new Map<string, { table: string; name: string; columns: string[]; refColumns: string[] }[]>();
  for (const tb of m.tables) for (const fk of tb.foreignKeys) {
    if (fk.refDb && fk.refDb !== m.db) continue;
    incoming.set(fk.refTable, [...(incoming.get(fk.refTable) ?? []), { table: tb.name, name: fk.name, columns: fk.columns, refColumns: fk.refColumns }]);
  }
  const objs = (k: DocObject['kind']) => m.objects.filter((x) => x.kind === k).sort((a, b) => a.name.localeCompare(b.name));
  return { tables, incoming, views: o.views ? objs('view') : [], procedures: o.routines ? objs('procedure') : [], functions: o.routines ? objs('function') : [], events: o.events ? objs('event') : [], triggers: objs('trigger') };
}

function keyMarks(tb: ServerTable, col: string) {
  const out: string[] = [];
  const lc = col.toLowerCase();
  if (tb.indexes.some((ix) => ix.kind === 'PRIMARY' && ix.columns.some((c) => c.name.toLowerCase() === lc))) out.push('PK');
  if (tb.foreignKeys.some((fk) => fk.columns.some((c) => c.toLowerCase() === lc))) out.push('FK');
  if (tb.indexes.some((ix) => ix.kind === 'UNIQUE' && ix.columns.length === 1 && ix.columns[0].name.toLowerCase() === lc)) out.push('UQ');
  return out;
}

const extra = (c: ServerTable['columns'][number]) => [
  c.autoIncrement ? 'AUTO_INCREMENT' : '', c.generated ? `${c.generated.stored ? 'STORED' : 'VIRTUAL'}: ${c.generated.expr}` : '', c.onUpdate ? `ON UPDATE ${c.onUpdate}` : '',
].filter(Boolean).join(' · ');

const ixCols = (ix: ServerTable['indexes'][number]) => ix.columns.map((c) => `${c.name}${c.len ? `(${c.len})` : ''}${c.desc ? ' DESC' : ''}`).join(', ');

// ---------------------------------------------------------------- ER diagram

/** Standalone SVG of the relations between the documented tables (light colors, also for print). */
export function erSvg(er: ErModel, names: string[] | null, measure: (s: string) => number = (s) => s.length * 6.8) {
  const pick = names ? new Set(names) : null;
  const tables = er.tables.filter((x) => x.kind === 'table' && (!pick || pick.has(x.name)));
  const keep = new Set(tables.map((x) => x.name));
  const fks = er.fks.filter((f) => keep.has(f.table) && keep.has(f.refTable));
  const model = { tables, fks };
  const sizes = Object.fromEntries(tables.map((x) => [x.name, boxSize(x, x.columns.length, measure)]));
  const pos = autoLayout(model, sizes);
  const b = bounds(pos, sizes, tables.map((x) => x.name));
  const box = (n: string) => ({ ...pos[n], ...sizes[n] });
  const colIndex = (tb: string, c: string) => tables.find((x) => x.name === tb)?.columns.findIndex((x) => x.name === c) ?? -1;
  const fkCols = new Map<string, Set<string>>();
  for (const f of fks) for (const c of f.columns) fkCols.set(f.table, new Set([...(fkCols.get(f.table) ?? []), c]));
  const parts: string[] = [];
  for (const f of fks) {
    const ch = box(f.table);
    const pa = box(f.refTable);
    const r = relationPath(ch, rowY(ch, colIndex(f.table, f.columns[0])), pa, rowY(pa, colIndex(f.refTable, f.refColumns[0])));
    const s = r.start;
    const e = r.end;
    const ends = `M ${s.x + s.dir * 12} ${s.y} L ${s.x} ${s.y - 6} M ${s.x + s.dir * 12} ${s.y} L ${s.x} ${s.y} M ${s.x + s.dir * 12} ${s.y} L ${s.x} ${s.y + 6} M ${e.x + e.dir * 8} ${e.y - 6} L ${e.x + e.dir * 8} ${e.y + 6} M ${e.x + e.dir * 12} ${e.y - 6} L ${e.x + e.dir * 12} ${e.y + 6}`;
    const opt = f.columns.some((c) => tables.find((x) => x.name === f.table)?.columns.find((x) => x.name === c)?.nullable);
    parts.push(`<g class="r${opt ? ' opt' : ''}"><title>${esc(`${f.name}: ${f.table}(${f.columns.join(', ')}) → ${f.refTable}(${f.refColumns.join(', ')})`)}</title><path class="line" d="${r.d}"/><path d="${ends}"/></g>`);
  }
  for (const x of tables) {
    const bx = box(x.name);
    const rows = x.columns.map((c, i) => {
      const y = HEADER + i * ROW + ROW / 2 + 7;
      const mark = c.pk ? '<text class="key" x="8" y="' + y + '">PK</text>' : fkCols.get(x.name)?.has(c.name) ? '<text class="fk" x="8" y="' + y + '">FK</text>' : '';
      return `${mark}<text class="${c.pk ? 'pk' : ''}" x="30" y="${y}">${esc(c.name)}</text><text class="type" x="${bx.w - 8}" y="${y}" text-anchor="end">${esc(c.type)}</text>`;
    }).join('');
    parts.push(`<a href="#${anchor('t', x.name)}"><g class="t" transform="translate(${bx.x} ${bx.y})"><rect class="body" width="${bx.w}" height="${bx.h}" rx="5"/><rect class="head" width="${bx.w}" height="${HEADER}" rx="5"/><rect class="head" y="${HEADER - 6}" width="${bx.w}" height="6"/><text class="name" x="10" y="${HEADER / 2 + 4.5}">${esc(x.name)}</text>${rows}</g></a>`);
  }
  const css = `.t rect.body{fill:#fff;stroke:#b8c2cf}.t rect.head{fill:#3a7bd5}.t text{font:12px 'Noto Sans','Segoe UI',sans-serif;fill:#1f2933}.t text.name{font-weight:600;fill:#fff;font-size:12.5px}.t text.type{fill:#7a8696;font-size:11px}.t text.pk{font-weight:600}.t .key{fill:#b8860b;font-size:10px;font-weight:700}.t .fk{fill:#2a9d8f;font-size:10px;font-weight:700}.r path{fill:none;stroke:#8a96a6;stroke-width:1.4}.r.opt path.line{stroke-dasharray:5 4}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${b.x} ${b.y} ${b.w} ${b.h}" width="${Math.ceil(b.w)}" height="${Math.ceil(b.h)}"><style>${css}</style><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" fill="#fff"/>${parts.join('')}</svg>`;
}

// ---------------------------------------------------------------- HTML

const PAGE_CSS = `
:root{--bg:#fff;--text:#1f2933;--muted:#6b7684;--line:#e3e6ea;--head:#f3f5f8;--accent:#2f6fd6;--code:#f3f5f8}
@media (prefers-color-scheme:dark){:root{--bg:#1b1e24;--text:#dfe3ea;--muted:#8d97a5;--line:#323842;--head:#262b33;--accent:#5b9bff;--code:#262b33}.er{background:#fff;border-radius:6px}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 'Noto Sans','Segoe UI',system-ui,sans-serif}
.layout{display:flex;min-height:100vh}nav{width:260px;flex:none;border-right:1px solid var(--line);padding:16px;position:sticky;top:0;height:100vh;overflow:auto;font-size:13px}
nav h2{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 0 4px}nav a{display:block;color:var(--text);text-decoration:none;padding:1px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}nav a:hover{color:var(--accent)}
main{flex:1;min-width:0;padding:24px 32px 60px;max-width:1200px}h1{margin:0 0 4px;font-size:26px}h2.sec{margin:36px 0 10px;padding-bottom:4px;border-bottom:2px solid var(--line)}
h3{margin:28px 0 4px;font-size:18px}h4{margin:14px 0 4px;font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.03em}
.meta{color:var(--muted);font-size:13px}.comment{margin:4px 0 8px}table{border-collapse:collapse;width:100%;font-size:13px;margin:4px 0}
th{text-align:left;background:var(--head);font-weight:600;padding:4px 8px;border-bottom:1px solid var(--line)}td{padding:3px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.n{text-align:right;font-variant-numeric:tabular-nums}code,pre{font-family:'JetBrains Mono','DejaVu Sans Mono',monospace;font-size:12px}pre{background:var(--code);padding:10px 12px;border-radius:4px;overflow:auto;white-space:pre}
.badge{display:inline-block;font-size:10.5px;font-weight:700;padding:0 5px;border-radius:3px;margin-right:3px;background:var(--head)}.badge.PK{color:#b8860b}.badge.FK{color:#2a9d8f}.badge.UQ{color:var(--accent)}
a{color:var(--accent)}.er{overflow:auto;border:1px solid var(--line);border-radius:6px;padding:8px;margin:8px 0}.er svg{max-width:none}.summary td:first-child{color:var(--muted);width:180px}
footer{margin-top:48px;color:var(--muted);font-size:12px}
@media print{nav{display:none}main{padding:0;max-width:none}h3{break-after:avoid}table,pre{break-inside:avoid}.er{border:none}}
`;

export function docHtml(m: DocModel, o: DocOptions, measure?: (s: string) => number) {
  const p = prepare(m, o);
  const out: string[] = [];
  const toc: string[] = [];
  const section = (id: string, title: string, items: { kind: string; name: string }[]) => {
    toc.push(`<h2><a href="#${id}">${esc(title)}</a></h2>${items.map((x) => `<a href="#${anchor(x.kind, x.name)}">${esc(x.name)}</a>`).join('')}`);
  };
  const totals = p.tables.reduce((a, x) => ({ rows: a.rows + (x.rows ?? 0), size: a.size + (x.data ?? 0) + (x.idx ?? 0) }), { rows: 0, size: 0 });
  out.push(`<h1>${esc(o.title)}</h1><div class="meta">${esc(t('Database {0} · {1} · generato il {2} con MiB-SQL', m.db, m.server, m.generated))}</div>`);
  out.push(`<h2 class="sec" id="summary">${esc(t('Riepilogo'))}</h2><table class="summary"><tbody>
<tr><td>${esc(t('Tabelle'))}</td><td>${p.tables.length}</td></tr>
<tr><td>${esc(t('Righe (stima)'))}</td><td>${num(totals.rows)}</td></tr><tr><td>${esc(t('Dimensione'))}</td><td>${size(totals.size)}</td></tr>
${o.views ? `<tr><td>${esc(t('Viste'))}</td><td>${p.views.length}</td></tr>` : ''}${o.routines ? `<tr><td>${esc(t('Procedure / funzioni'))}</td><td>${p.procedures.length} / ${p.functions.length}</td></tr>` : ''}
${o.triggers ? `<tr><td>Trigger</td><td>${p.triggers.filter((x) => !o.tables || o.tables.includes(x.table ?? '')).length}</td></tr>` : ''}${o.events ? `<tr><td>${esc(t('Eventi'))}</td><td>${p.events.length}</td></tr>` : ''}
</tbody></table>`);
  out.push(`<table><thead><tr><th>${esc(t('Tabella'))}</th><th>Engine</th><th class="n">${esc(t('Righe'))}</th><th class="n">${esc(t('Dimensione'))}</th><th>${esc(t('Descrizione'))}</th></tr></thead><tbody>${p.tables.map((x) => `<tr><td><a href="#${anchor('t', x.name)}">${esc(x.name)}</a></td><td>${esc(x.engine)}</td><td class="n">${num(x.rows)}</td><td class="n">${size((x.data ?? 0) + (x.idx ?? 0))}</td><td>${esc(x.comment)}</td></tr>`).join('')}</tbody></table>`);
  toc.push(`<h2><a href="#summary">${esc(t('Riepilogo'))}</a></h2>`);
  if (o.diagram && p.tables.length) {
    out.push(`<h2 class="sec" id="diagram">${esc(t('Diagramma delle relazioni'))}</h2><div class="er">${erSvg(m.er, p.tables.map((x) => x.name), measure)}</div>`);
    toc.push(`<h2><a href="#diagram">${esc(t('Diagramma'))}</a></h2>`);
  }

  out.push(`<h2 class="sec" id="tables">${esc(t('Tabelle'))}</h2>`);
  section('tables', t('Tabelle'), p.tables.map((x) => ({ kind: 't', name: x.name })));
  for (const tb of p.tables) {
    out.push(`<h3 id="${anchor('t', tb.name)}">${esc(tb.name)}</h3>`);
    if (tb.comment) out.push(`<p class="comment">${esc(tb.comment)}</p>`);
    out.push(`<div class="meta">${esc([tb.engine, tb.collation, tb.rows !== null ? tn(tb.rows, '{0} riga (stima)', '{0} righe (stima)') : '', tb.data !== null ? t('dati {0}, indici {1}', size(tb.data), size(tb.idx)) : ''].filter(Boolean).join(' · '))}</div>`);
    if (o.columns) {
      out.push(`<h4>${esc(t('Colonne'))}</h4><table><thead><tr><th>#</th><th>${esc(t('Nome'))}</th><th>${esc(t('Tipo'))}</th><th>NULL</th><th>Default</th><th>${esc(t('Altro'))}</th><th>${esc(t('Descrizione'))}</th></tr></thead><tbody>`
        + tb.columns.map((c, i) => `<tr><td class="n">${i + 1}</td><td>${keyMarks(tb, c.name).map((k) => `<span class="badge ${k}">${k}</span>`).join('')}<b>${esc(c.name)}</b></td><td><code>${esc(c.type)}</code></td><td>${c.nullable ? esc(t('sì')) : esc(t('no'))}</td><td>${c.default === null ? '' : `<code>${esc(c.default)}</code>`}</td><td>${esc(extra(c))}</td><td>${esc(c.comment)}</td></tr>`).join('')
        + '</tbody></table>');
    }
    if (o.indexes && tb.indexes.length) {
      out.push(`<h4>${esc(t('Indici'))}</h4><table><thead><tr><th>${esc(t('Nome'))}</th><th>${esc(t('Tipo'))}</th><th>${esc(t('Colonne'))}</th><th>${esc(t('Descrizione'))}</th></tr></thead><tbody>`
        + tb.indexes.map((ix) => `<tr><td>${esc(ix.name)}</td><td>${esc(ix.kind)}</td><td><code>${esc(ixCols(ix))}</code></td><td>${esc(ix.comment)}</td></tr>`).join('') + '</tbody></table>');
    }
    if (o.fks) {
      if (tb.foreignKeys.length) out.push(`<h4>${esc(t('Chiavi esterne'))}</h4><table><thead><tr><th>${esc(t('Nome'))}</th><th>${esc(t('Colonne'))}</th><th>${esc(t('Riferimento'))}</th><th>ON DELETE</th><th>ON UPDATE</th></tr></thead><tbody>`
        + tb.foreignKeys.map((fk) => `<tr><td>${esc(fk.name)}</td><td><code>${esc(fk.columns.join(', '))}</code></td><td>${fk.refDb && fk.refDb !== m.db ? esc(`${fk.refDb}.${fk.refTable}`) : `<a href="#${anchor('t', fk.refTable)}">${esc(fk.refTable)}</a>`} (<code>${esc(fk.refColumns.join(', '))}</code>)</td><td>${esc(fk.onDelete)}</td><td>${esc(fk.onUpdate)}</td></tr>`).join('') + '</tbody></table>');
      const inc = p.incoming.get(tb.name) ?? [];
      if (inc.length) out.push(`<h4>${esc(t('Riferita da'))}</h4><table><tbody>${inc.map((r) => `<tr><td><a href="#${anchor('t', r.table)}">${esc(r.table)}</a> (<code>${esc(r.columns.join(', '))}</code>)</td><td>→ <code>${esc(r.refColumns.join(', '))}</code></td><td class="meta">${esc(r.name)}</td></tr>`).join('')}</tbody></table>`);
    }
    if (o.fks && tb.checks?.length) out.push(`<h4>${esc(t('Vincoli CHECK'))}</h4><table><tbody>${tb.checks.map((k) => `<tr><td>${esc(k.name)}</td><td><code>${esc(k.expr)}</code></td></tr>`).join('')}</tbody></table>`);
    const trg = o.triggers ? p.triggers.filter((x) => x.table === tb.name) : [];
    if (trg.length) out.push(`<h4>Trigger</h4>${trg.map((x) => `<p><b id="${anchor('trg', x.name)}">${esc(x.name)}</b> <span class="meta">${esc(`${x.timing ?? ''} ${x.event ?? ''}`)}</span></p>${x.ddl ? `<pre>${esc(x.ddl)}</pre>` : ''}`).join('')}`);
    if (o.ddl) out.push(`<h4>DDL</h4><pre>${esc(createSql(fromServer(m.db, tb)))};</pre>`);
  }
  const objSection = (id: string, title: string, kind: string, list: DocObject[], meta: (x: DocObject) => string = () => '') => {
    if (!list.length) return;
    out.push(`<h2 class="sec" id="${id}">${esc(title)}</h2>`);
    section(id, title, list.map((x) => ({ kind, name: x.name })));
    for (const x of list) out.push(`<h3 id="${anchor(kind, x.name)}">${esc(x.name)}</h3>${meta(x) ? `<div class="meta">${esc(meta(x))}</div>` : ''}${x.ddl ? `<pre>${esc(x.ddl)}</pre>` : `<p class="meta">${esc(t('Definizione non leggibile (privilegi insufficienti).'))}</p>`}`);
  };
  objSection('views', t('Viste'), 'v', p.views);
  objSection('procedures', t('Procedure'), 'p', p.procedures);
  objSection('functions', t('Funzioni'), 'f', p.functions);
  objSection('events', t('Eventi'), 'e', p.events, (x) => x.status ?? '');
  out.push(`<footer>${esc(t('Generato da MiB-SQL'))} · ${esc(m.generated)}</footer>`);
  return `<!doctype html>\n<html lang="${t('it')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(o.title)}</title><style>${PAGE_CSS}</style></head>
<body><div class="layout"><nav><b>${esc(m.db)}</b>${toc.join('')}</nav><main>${out.join('\n')}</main></div></body></html>\n`;
}

// ---------------------------------------------------------------- Markdown

const mdCell = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const mdTable = (head: string[], rows: unknown[][]) => [`| ${head.map(mdCell).join(' | ')} |`, `|${head.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n');
const mdCode = (s: string) => `\`\`\`sql\n${s}\n\`\`\``;
const mdAnchor = (s: string) => s.toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');

export function docMarkdown(m: DocModel, o: DocOptions) {
  const p = prepare(m, o);
  const out: string[] = [`# ${o.title}`, '', `_${t('Database {0} · {1} · generato il {2} con MiB-SQL', m.db, m.server, m.generated)}_`, ''];
  out.push(`## ${t('Tabelle')}`, '', mdTable([t('Tabella'), 'Engine', t('Righe'), t('Dimensione'), t('Descrizione')], p.tables.map((x) => [`[${x.name}](#${mdAnchor(x.name)})`, x.engine, num(x.rows), size((x.data ?? 0) + (x.idx ?? 0)), x.comment])), '');
  for (const tb of p.tables) {
    out.push(`### ${tb.name}`, '');
    if (tb.comment) out.push(tb.comment, '');
    out.push(`_${[tb.engine, tb.collation, tb.rows !== null ? tn(tb.rows, '{0} riga (stima)', '{0} righe (stima)') : ''].filter(Boolean).join(' · ')}_`, '');
    if (o.columns) out.push(mdTable(['#', t('Nome'), t('Tipo'), 'NULL', 'Default', t('Altro'), t('Descrizione')],
      tb.columns.map((c, i) => [i + 1, `${keyMarks(tb, c.name).map((k) => `**${k}** `).join('')}${c.name}`, `\`${c.type}\``, c.nullable ? t('sì') : t('no'), c.default === null ? '' : `\`${c.default}\``, extra(c), c.comment])), '');
    if (o.indexes && tb.indexes.length) out.push(`**${t('Indici')}**`, '', mdTable([t('Nome'), t('Tipo'), t('Colonne')], tb.indexes.map((ix) => [ix.name, ix.kind, `\`${ixCols(ix)}\``])), '');
    if (o.fks && tb.foreignKeys.length) out.push(`**${t('Chiavi esterne')}**`, '', mdTable([t('Nome'), t('Colonne'), t('Riferimento'), 'ON DELETE', 'ON UPDATE'],
      tb.foreignKeys.map((fk) => [fk.name, fk.columns.join(', '), `${fk.refTable}(${fk.refColumns.join(', ')})`, fk.onDelete, fk.onUpdate])), '');
    const inc = o.fks ? p.incoming.get(tb.name) ?? [] : [];
    if (inc.length) out.push(`**${t('Riferita da')}**: ${inc.map((r) => `${r.table}(${r.columns.join(', ')})`).join(', ')}`, '');
    const trg = o.triggers ? p.triggers.filter((x) => x.table === tb.name) : [];
    for (const x of trg) out.push(`**Trigger ${x.name}** (${x.timing ?? ''} ${x.event ?? ''})`, '', ...(x.ddl ? [mdCode(x.ddl), ''] : []));
    if (o.ddl) out.push(mdCode(`${createSql(fromServer(m.db, tb))};`), '');
  }
  const objs = (title: string, list: DocObject[]) => {
    if (!list.length) return;
    out.push(`## ${title}`, '');
    for (const x of list) out.push(`### ${x.name}`, '', x.ddl ? mdCode(x.ddl) : `_${t('Definizione non leggibile (privilegi insufficienti).')}_`, '');
  };
  objs(t('Viste'), p.views);
  objs(t('Procedure'), p.procedures);
  objs(t('Funzioni'), p.functions);
  objs(t('Eventi'), p.events);
  return out.join('\n');
}
