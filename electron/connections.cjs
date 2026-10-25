// Saved connection profiles. Definitions live in <userData>/connections.json; secrets (password, SSH password,
// key passphrase) in <userData>/secrets.json encrypted with Electron safeStorage (system keyring). When the
// keyring is unavailable, or the profile does not save its password, secrets are kept for this session only.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const { t } = require('./i18n.cjs');

const defsFile = () => path.join(app.getPath('userData'), 'connections.json');
const secretsFile = () => path.join(app.getPath('userData'), 'secrets.json');
const session = new Map(); // id -> secrets entered in this session

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
};

function list() {
  return readJson(defsFile(), []);
}

function get(id) {
  const def = list().find((c) => c.id === id);
  if (!def) throw new Error(t('Connessione non trovata.'));
  return def;
}

/** The keyring is usable only with a real backend: 'basic_text' is a fixed key, no better than plain text. */
async function keyringAvailable() {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

async function storedSecrets(id) {
  const all = readJson(secretsFile(), {});
  if (!all[id] || !(await keyringAvailable())) return {};
  try { return JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(all[id], 'base64'))).result); } catch { return {}; }
}

async function storeSecrets(id, secrets) {
  const all = readJson(secretsFile(), {});
  if (secrets && Object.keys(secrets).length) all[id] = (await safeStorage.encryptStringAsync(JSON.stringify(secrets))).toString('base64');
  else delete all[id];
  writeJson(secretsFile(), all);
}

/** Merge of saved secrets, this session's and the ones just entered (undefined fields keep the previous value). */
async function secretsFor(def, given = {}) {
  const clean = Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined));
  return { ...(await storedSecrets(def.id)), ...session.get(def.id), ...clean };
}

/** Remembers secrets as the profile asks: on disk (keyring) or for this session only. */
async function remember(def, secrets) {
  const keep = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v !== undefined && v !== ''));
  session.set(def.id, keep);
  await storeSecrets(def.id, def.savePassword && (await keyringAvailable()) ? keep : null);
}

async function save(def, secrets) {
  const all = list();
  const entry = { ...def, id: def.id || crypto.randomUUID() };
  const at = all.findIndex((c) => c.id === entry.id);
  if (at >= 0) all[at] = entry; else all.push(entry);
  writeJson(defsFile(), all);
  await remember(entry, await secretsFor(entry, secrets));
  return entry;
}

async function remove(id) {
  writeJson(defsFile(), list().filter((c) => c.id !== id));
  await storeSecrets(id, null);
  session.delete(id);
}

module.exports = { list, get, save, remove, secretsFor, remember, keyringAvailable };
