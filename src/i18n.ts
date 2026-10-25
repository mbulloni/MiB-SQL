// UI language. Strings are written in Italian in the code and wrapped in t(): the Italian text is the key,
// locales/en.json maps it to English (missing keys fall back to Italian). Placeholders are {0}, {1}…
// The choice lives in localStorage; changing it reloads the window, so module-level t() calls are fine.
import en from '../locales/en.json' with { type: 'json' };

export type Lang = 'it' | 'en';
export const LANGS: { id: Lang; name: string }[] = [{ id: 'it', name: 'Italiano' }, { id: 'en', name: 'English' }];
const KEY = 'mibsql.lang';
const DICTS: Record<Lang, Record<string, string> | null> = { it: null, en };

function initial(): Lang {
  try {
    const v = globalThis.localStorage?.getItem(KEY);
    if (v === 'it' || v === 'en') return v;
  } catch { /* storage unavailable */ }
  const nav = (globalThis as { navigator?: { language?: string } }).navigator?.language ?? 'it';
  return nav.toLowerCase().startsWith('it') ? 'it' : 'en';
}

let lang: Lang = initial();
let dict = DICTS[lang];

export const getLang = () => lang;
/** BCP 47 locale for numbers and dates. */
export const locale = () => (lang === 'it' ? 'it-IT' : 'en-GB');

/** Tests and the main-process bridge: switch without reloading. */
export function useLang(l: Lang) { lang = l; dict = DICTS[l]; }

export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  useLang(l);
}

const fill = (s: string, args: unknown[]) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s);

export function t(s: string, ...args: (string | number | null | undefined)[]): string {
  return fill(dict?.[s] ?? s, args);
}

/** Count with singular/plural forms, both translated: tn(3, '{0} riga', '{0} righe'). */
export function tn(n: number, one: string, many: string): string {
  return t(n === 1 ? one : many, n.toLocaleString(locale()));
}
