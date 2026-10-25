// Lists the texts passed to t() / tr() / tn() in src/ and electron/ and checks them against locales/en.json.
// node scripts/i18n-keys.mjs            → missing and unused keys
// node scripts/i18n-keys.mjs --missing  → JSON of the missing keys (to translate)
import { parseAst } from 'rolldown/parseAst';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const files = [
  ...readdirSync(join(root, 'src')).filter((f) => /\.tsx?$/.test(f)).map((f) => join(root, 'src', f)),
  ...readdirSync(join(root, 'src/components')).filter((f) => /\.tsx$/.test(f)).map((f) => join(root, 'src/components', f)),
  ...readdirSync(join(root, 'electron')).filter((f) => /\.cjs$/.test(f)).map((f) => join(root, 'electron', f)),
];

export function keys() {
  const out = new Map(); // key → first file
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const ast = parseAst(src, { lang: file.endsWith('.tsx') ? 'tsx' : file.endsWith('.ts') ? 'ts' : 'js' });
    const visit = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(visit); return; }
      if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && ['t', 'tr', 'tn'].includes(n.callee.name)) {
        const args = n.callee.name === 'tn' ? n.arguments.slice(1, 3) : n.arguments.slice(0, 1);
        for (const a of args) if (a?.type === 'Literal' && typeof a.value === 'string' && !out.has(a.value)) out.set(a.value, file.slice(root.length));
      }
      for (const [k, v] of Object.entries(n)) if (k !== 'type' && v && typeof v === 'object') visit(v);
    };
    visit(ast);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const en = JSON.parse(readFileSync(join(root, 'locales/en.json'), 'utf8'));
  const k = keys();
  const missing = [...k.keys()].filter((x) => !(x in en));
  if (process.argv.includes('--missing')) { console.log(JSON.stringify(Object.fromEntries(missing.map((x) => [x, ''])), null, 1)); process.exit(0); }
  const unused = Object.keys(en).filter((x) => !k.has(x));
  console.log(`${k.size} keys, ${missing.length} missing, ${unused.length} unused`);
  for (const x of missing) console.log(`missing: ${JSON.stringify(x)}  (${k.get(x)})`);
  for (const x of unused) console.log(`unused: ${JSON.stringify(x)}`);
}
