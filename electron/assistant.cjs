// AI assistant (Claude) for the SQL editor. The API key is kept in <userData>/assistant.json encrypted with
// safeStorage; without one the SDK resolves credentials itself (ANTHROPIC_API_KEY, `ant auth login` profile).
// Replies stream to the renderer; the renderer keeps the conversation append-only (full assistant content,
// thinking blocks included) and sends it back whole on every turn.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const AnthropicModule = require('@anthropic-ai/sdk');
const { t } = require('./i18n.cjs');

const Anthropic = AnthropicModule.default ?? AnthropicModule;
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// server-side refusal fallback ("default" form): Claude API, Opus 5.5 and Sonnet 5.5
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

const file = () => path.join(app.getPath('userData'), 'assistant.json');
const read = () => { try { return JSON.parse(fs.readFileSync(file(), 'utf8')); } catch { return {}; } };
const write = (cfg) => { fs.mkdirSync(path.dirname(file()), { recursive: true }); fs.writeFileSync(file(), JSON.stringify(cfg, null, 2), { mode: 0o600 }); };
const active = new Map(); // request id -> stream

async function storedKey() {
  const cfg = read();
  if (!cfg.key || !(await safeStorage.isAsyncEncryptionAvailable())) return null;
  try { return (await safeStorage.decryptStringAsync(Buffer.from(cfg.key, 'base64'))).result; } catch { return null; }
}

async function settings() {
  const cfg = read();
  const key = await storedKey();
  return {
    source: key ? 'key' : process.env.ANTHROPIC_API_KEY ? 'env' : 'system',
    model: MODELS.includes(cfg.model) ? cfg.model : MODELS[0],
    effort: EFFORTS.includes(cfg.effort) ? cfg.effort : 'medium',
    consent: !!cfg.consent,
    models: MODELS,
    efforts: EFFORTS,
    keyring: await safeStorage.isAsyncEncryptionAvailable(),
  };
}

/** key: string = store, null = remove, undefined = unchanged. */
async function saveSettings({ model, effort, key, consent }) {
  const cfg = read();
  if (model !== undefined) cfg.model = model;
  if (effort !== undefined) cfg.effort = effort;
  if (consent !== undefined) cfg.consent = consent;
  if (key === null) delete cfg.key;
  else if (typeof key === 'string' && key.trim()) {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error(t('Portachiavi di sistema non disponibile: impostare la variabile ANTHROPIC_API_KEY.'));
    cfg.key = (await safeStorage.encryptStringAsync(key.trim())).toString('base64');
  }
  write(cfg);
  return settings();
}

async function client() {
  const key = await storedKey();
  // no stored key: the SDK reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / the `ant` profile (and ANTHROPIC_BASE_URL)
  return key ? new Anthropic({ apiKey: key }) : new Anthropic();
}

/** Errors in the user's language, by SDK error class (never by message text). */
function explain(err) {
  if (err instanceof Anthropic.APIUserAbortError) return { cancelled: true, message: t('Risposta interrotta.') };
  if (err instanceof Anthropic.AuthenticationError) return { message: t('Credenziali Anthropic non valide: controlla la chiave API nelle impostazioni dell\'assistente.') };
  if (err instanceof Anthropic.PermissionDeniedError) return { message: t('Accesso negato dall\'API: {0}', err.message) };
  if (err instanceof Anthropic.RateLimitError) return { message: t('Limite di richieste raggiunto: riprova tra poco.') };
  if (err instanceof Anthropic.BadRequestError) return { message: t('Richiesta non valida: {0}', err.message) };
  if (err instanceof Anthropic.APIConnectionError) return { message: t('Impossibile raggiungere l\'API di Anthropic: controlla la connessione.') };
  if (err instanceof Anthropic.APIError) return { message: t('Errore dell\'API ({0}): {1}', err.status ?? '?', err.message) };
  if (/authentication|api key|credentials/i.test(String(err?.message))) return { message: t('Nessuna credenziale Anthropic: inserisci una chiave API nelle impostazioni dell\'assistente oppure imposta ANTHROPIC_API_KEY.') };
  return { message: String(err?.message ?? err) };
}

/**
 * One assistant turn. `messages` is the whole conversation (append-only); text deltas go to onText.
 * Returns the full assistant content to append, the stop reason and usage.
 */
async function chat(id, { system, messages }, onText) {
  const cfg = await settings();
  const params = {
    model: cfg.model,
    max_tokens: 64000,
    system,
    messages,
    output_config: { effort: cfg.effort },
  };
  if (FALLBACK_MODELS.has(cfg.model)) {
    params.betas = ['server-side-fallback-2026-07-01'];
    params.fallbacks = 'default';
  }
  try {
    const stream = (await client()).beta.messages.stream(params);
    active.set(id, stream);
    stream.on('text', (delta) => onText(delta));
    const msg = await stream.finalMessage();
    return { content: msg.content, stopReason: msg.stop_reason, stopDetails: msg.stop_details ?? null, model: msg.model, usage: msg.usage };
  } catch (err) {
    const why = explain(err);
    const e = new Error(why.message);
    e.code = why.cancelled ? 'CANCELLED' : 'AI_ERROR';
    throw e;
  } finally {
    active.delete(id);
  }
}

function cancel(id) {
  active.get(id)?.abort();
}

module.exports = { settings, saveSettings, chat, cancel, MODELS };
