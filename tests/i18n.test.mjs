import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { keys } from '../scripts/i18n-keys.mjs';
import { t, tn, useLang } from '../src/i18n.ts';

const en = JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'));
const ph = (s) => (s.match(/\{\d+\}/g) ?? []).sort().join();

test('every text in t()/tn() has an English translation with the same placeholders', () => {
  const k = keys();
  const missing = [...k.keys()].filter((x) => !(x in en));
  assert.deepEqual(missing, [], `missing in locales/en.json: ${missing.slice(0, 10).join(' | ')}`);
  const wrong = [...k.keys()].filter((x) => ph(x) !== ph(en[x]) || !en[x].trim());
  assert.deepEqual(wrong, []);
  const unused = Object.keys(en).filter((x) => !k.has(x));
  assert.deepEqual(unused, [], 'unused keys in locales/en.json');
});

test('t() fills placeholders and falls back to Italian', () => {
  useLang('en');
  assert.equal(t('Salvare le modifiche a {0}?', 'a.sql'), 'Save the changes to a.sql?');
  assert.equal(t('testo che non esiste'), 'testo che non esiste');
  assert.equal(tn(1, '{0} riga', '{0} righe'), '1 row');
  assert.equal(tn(1200, '{0} riga', '{0} righe'), '1,200 rows');
  useLang('it');
  assert.equal(tn(12000, '{0} riga', '{0} righe'), '12.000 righe');
});
