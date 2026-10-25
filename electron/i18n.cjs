// Main-process side of the UI language (see src/i18n.ts): same Italian keys, same dictionary.
// The renderer reports the language at startup through app:setLang.
const en = require('../locales/en.json');

const DICTS = { it: null, en };
let dict = null;
let lang = 'it';

function setLang(l) {
  lang = DICTS[l] !== undefined ? l : 'it';
  dict = DICTS[lang];
}

const fill = (s, args) => (args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (Number(i) < args.length ? String(args[Number(i)]) : m)) : s);

function t(s, ...args) {
  return fill((dict && dict[s]) || s, args);
}

const locale = () => (lang === 'it' ? 'it-IT' : 'en-GB');

module.exports = { t, setLang, locale, getLang: () => lang };
