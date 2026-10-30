// Microsoft Entra ID sign-in for Fabric / Azure SQL connections (MSAL public client). The token cache (refresh
// tokens) is kept in <userData>/entra-cache.bin encrypted with safeStorage, so a sign-in lasts across restarts
// like in Azure Data Studio; without a real keyring it stays in memory for this session only.
const fs = require('fs');
const path = require('path');
const { app, safeStorage, shell } = require('electron');
const msal = require('@azure/msal-node');
const connections = require('./connections.cjs');
const { t } = require('./i18n.cjs');

// Public client of the Azure CLI: accepted by most tenants for Azure SQL / Fabric with a loopback redirect.
// Profiles can name their own app registration (public client, redirect http://localhost) instead.
const DEFAULT_CLIENT = '04b07795-8ddb-461a-bbee-02f9e1bf7b46';
const SQL_SCOPE = 'https://database.windows.net//.default';
const cacheFile = () => path.join(app.getPath('userData'), 'entra-cache.bin');

let memory = null; // serialized cache when the keyring is unavailable
const apps = new Map(); // clientId|tenant -> PublicClientApplication
const locks = new Map(); // same key -> pending interactive sign-in (one browser window at a time)
const chosen = new Map(); // profile id -> homeAccountId picked at the last interactive sign-in
let notify = () => {};

/** Main process hook: device code prompts and sign-in progress reach the renderer through it. */
const onPrompt = (fn) => { notify = fn; };

const cachePlugin = {
  async beforeCacheAccess(ctx) {
    if (!(await connections.keyringAvailable())) { if (memory) ctx.tokenCache.deserialize(memory); return; }
    try {
      const data = fs.readFileSync(cacheFile());
      ctx.tokenCache.deserialize((await safeStorage.decryptStringAsync(data)).result);
    } catch { /* no cache yet, or written with another key */ }
  },
  async afterCacheAccess(ctx) {
    if (!ctx.cacheHasChanged) return;
    const text = ctx.tokenCache.serialize();
    if (!(await connections.keyringAvailable())) { memory = text; return; }
    fs.mkdirSync(path.dirname(cacheFile()), { recursive: true });
    fs.writeFileSync(cacheFile(), await safeStorage.encryptStringAsync(text), { mode: 0o600 });
  },
};

const settings = (def) => ({ clientId: def.entra?.clientId || DEFAULT_CLIENT, tenant: def.entra?.tenant || 'organizations' });

function clientFor(def) {
  const { clientId, tenant } = settings(def);
  const key = `${clientId}|${tenant}`;
  if (!apps.has(key)) {
    apps.set(key, new msal.PublicClientApplication({
      auth: { clientId, authority: `https://login.microsoftonline.com/${tenant}` },
      cache: { cachePlugin },
    }));
  }
  return { pca: apps.get(key), key };
}

/** Cached account of a profile: the one named in the profile (login hint), else the only one. */
async function accountFor(pca, def) {
  const all = await pca.getAllAccounts();
  const picked = all.find((a) => a.homeAccountId === chosen.get(def.id));
  if (picked) return picked;
  const hint = (def.user || '').toLowerCase();
  if (hint) return all.find((a) => a.username.toLowerCase() === hint) ?? null;
  return all.length === 1 ? all[0] : null;
}

const page = (title, text) => `<!doctype html><meta charset="utf-8"><title>MiB-SQL</title>
<body style="font:15px system-ui,sans-serif;display:grid;place-items:center;height:90vh;color:#222"><div><h2>${title}</h2><p>${text}</p></div>`;

/**
 * Access token for scopes: silently from the cache (refresh token) when possible, otherwise an interactive
 * sign-in (system browser, or device code when the profile asks for it) only if `interactive`.
 */
async function token(def, scopes = [SQL_SCOPE], { interactive = true } = {}) {
  const { pca, key } = clientFor(def);
  const account = await accountFor(pca, def);
  if (account) {
    try { return await pca.acquireTokenSilent({ account, scopes }); } catch (err) {
      if (!(err instanceof msal.InteractionRequiredAuthError) && !/interaction_required|invalid_grant|no_tokens_found/i.test(err.errorCode ?? err.message)) throw signInError(err);
    }
  }
  if (!interactive) throw new Error(t('Accesso Microsoft Entra scaduto: riconnettersi.'));
  if (locks.has(key)) { await locks.get(key).catch(() => {}); return token(def, scopes, { interactive }); }
  const run = (async () => {
    try {
      if (def.entra?.method === 'device') {
        return await pca.acquireTokenByDeviceCode({
          scopes,
          deviceCodeCallback: (r) => notify({ kind: 'device', connId: def.id, name: def.name, url: r.verificationUri, code: r.userCode, message: r.message }),
        });
      }
      notify({ kind: 'browser', connId: def.id, name: def.name });
      return await pca.acquireTokenInteractive({
        scopes,
        loginHint: def.user || undefined,
        prompt: def.user ? undefined : 'select_account',
        openBrowser: async (url) => { await shell.openExternal(url); },
        successTemplate: page(t('Accesso completato'), t('Puoi chiudere questa scheda e tornare a MiB-SQL.')),
        errorTemplate: page(t('Accesso non riuscito'), t('Torna a MiB-SQL per i dettagli.')),
      });
    } catch (err) {
      throw signInError(err);
    } finally {
      notify({ kind: 'done', connId: def.id });
    }
  })();
  locks.set(key, run);
  try {
    const r = await run;
    if (r?.account) chosen.set(def.id, r.account.homeAccountId);
    return r;
  } finally { locks.delete(key); }
}

function signInError(err) {
  const code = err.errorCode || err.code || '';
  const e = new Error(t('Accesso Microsoft Entra non riuscito: {0}', (err.errorMessage || err.message || String(err)).split('\n')[0]));
  e.code = /user_cancelled|access_denied/.test(code) ? 'ENTRA_CANCELLED' : 'ENTRA';
  return e;
}

/** TokenCredential for tedious: called on every new TDS connection with the scope the server announces. */
function credential(def, { interactive = false } = {}) {
  return {
    async getToken(scopes) {
      const r = await token(def, Array.isArray(scopes) ? scopes : [scopes], { interactive });
      return { token: r.accessToken, expiresOnTimestamp: r.expiresOn ? new Date(r.expiresOn).getTime() : Date.now() + 3000 * 1000 };
    },
  };
}

/** Account signed in for a profile (null = none in the cache). */
async function account(def) {
  const a = await accountFor(clientFor(def).pca, def);
  return a ? { username: a.username, name: a.name ?? '' } : null;
}

/** Forgets the profile's account: the next connection asks to sign in again. */
async function signOut(def) {
  const { pca } = clientFor(def);
  const a = await accountFor(pca, def);
  chosen.delete(def.id);
  if (a) await pca.getTokenCache().removeAccount(a);
  return !!a;
}

module.exports = { token, credential, account, signOut, onPrompt, DEFAULT_CLIENT, SQL_SCOPE };
