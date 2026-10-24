// Light/dark theme: CSS variables switch on <html data-theme>, Monaco gets its own theme.
// The choice ('system' follows the desktop) is a per-user convenience kept in localStorage.
import { monaco } from './editor';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'mibsql.theme';
const media = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const resolvedTheme = (pref = themePref()): 'light' | 'dark' => (pref === 'system' ? (media.matches ? 'dark' : 'light') : pref);

export function applyTheme() {
  const t = resolvedTheme();
  document.documentElement.dataset.theme = t;
  monaco.editor.setTheme(t === 'dark' ? 'mibsql-dark' : 'mibsql');
  listeners.forEach((l) => l());
}

export function setThemePref(pref: ThemePref) {
  try { localStorage.setItem(KEY, pref); } catch { /* storage unavailable: applies to this session only */ }
  applyTheme();
}

export function onThemeChange(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

media.addEventListener('change', () => { if (themePref() === 'system') applyTheme(); });
