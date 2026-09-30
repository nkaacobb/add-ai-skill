// The AI facade the UI calls. Resolves settings + key into an adapter call, streams the reply, and falls back to a
// second provider when the first cannot be reached (only before any text has arrived, so an answer is never
// spliced from two models). No DOM, no storage: the relay (Node) reuses it server-side.

import { adapterFor } from '../adapters/index.js';
import { provider } from './providers.js';
import { profileFor } from './settings.js';
import { AiError } from './transport.js';

const FALLBACK_CODES = new Set(['network', 'bad-endpoint', 'timeout']);
const TEST_PROMPT = 'Connection check. Reply with the single word: ready';

/**
 * Settings -> { provider, cfg, key, adapter }. Throws AiError when the provider cannot be used as configured.
 * @param {object} settings  a sanitized settings object (core/settings.js)
 * @param {(id: string) => string} keyFor  API key lookup
 */
export function resolveTarget(settings, keyFor, providerId = settings.provider, { relayHeaders, forListing = false } = {}) {
  const p = provider(providerId);
  const { baseUrl, model } = profileFor(settings, p.id);
  const key = (keyFor && keyFor(p.id)) || '';
  const relayMode = settings.transport === 'relay';
  if (!relayMode && p.keyRequired && !key) {
    throw new AiError('auth', `${p.label} needs an API key. Open Settings > Model and paste one.`);
  }
  if (!forListing && p.modelRequired && !model) {
    throw new AiError('missing-model', `Choose a ${p.label} model in Settings > Model (try "Load models").`);
  }
  const adapter = adapterFor(relayMode ? 'relay' : p.protocol);
  if (!adapter) throw new AiError('bad-endpoint', `No adapter for the "${p.protocol}" protocol.`);
  const cfg = {
    provider: p.id,
    protocol: p.protocol,
    label: p.label,
    baseUrl,
    model,
    chatPath: p.chatPath,
    modelsPath: p.modelsPath,
    altModelsPath: p.altModelsPath,
    tokenField: p.tokenField,
    sendsTemperature: p.sendsTemperature,
    reasoningOff: p.reasoningOff,
    reasoning: settings.reasoning,
    timeoutMs: (settings.timeoutSec || 120) * 1000,
    relayUrl: relayMode ? settings.relayUrl : '',
    relayHeaders,
  };
  return { provider: p, cfg, key, adapter };
}

/**
 * Stream one reply. With `tools` (neutral specs, core/tools.js) the reply may end in tool calls instead of (or after)
 * text: they are returned as `toolCalls`; `toolTurns` carries the calls and results of this question so far.
 * @param {object} o
 * @param {object} o.settings
 * @param {(id: string) => string} o.keyFor
 * @param {string} o.system
 * @param {Array<{role, content}>} o.messages
 * @param {AbortSignal} [o.signal]
 * @param {(e: {type: 'text'|'reasoning'|'notice'|'status', text: string}) => void} o.onEvent
 * @returns {Promise<{usage?, provider, label, model, fellBack?, toolCalls: Array<{id, name, arguments}>}>}
 */
export async function streamChat({ settings, keyFor, system, messages, signal, onEvent, fetch, relayHeaders, tools, toolTurns, turnId }) {
  const primary = resolveTarget(settings, keyFor, settings.provider, { relayHeaders });
  let produced = false;
  const forward = (e) => {
    if ((e.type === 'text' || e.type === 'reasoning') && e.text) produced = true;
    if (onEvent) onEvent(e);
  };
  const run = async (t) => {
    const r = await t.adapter.stream({
      cfg: t.cfg, key: t.key, system, messages, maxTokens: settings.maxOutputTokens, temperature: settings.temperature,
      signal, onEvent: forward, fetch, tools, toolTurns, turnId,
    });
    return { ...r, toolCalls: Array.isArray(r?.toolCalls) ? r.toolCalls : [] };
  };
  try {
    const r = await run(primary);
    return { ...r, provider: primary.provider.id, label: primary.provider.label, model: primary.cfg.model };
  } catch (e) {
    const fbId = settings.fallbackProvider;
    if (!fbId || fbId === primary.provider.id || produced || signal?.aborted || !(e instanceof AiError) || !FALLBACK_CODES.has(e.code)) throw e;
    let fb;
    try { fb = resolveTarget(settings, keyFor, fbId, { relayHeaders }); } catch { throw e; }
    if (onEvent) onEvent({ type: 'notice', text: `${primary.provider.label} is not available — answering with ${fb.provider.label} instead.` });
    const r = await run(fb);
    return { ...r, provider: fb.provider.id, label: fb.provider.label, model: fb.cfg.model, fellBack: true };
  }
}

/** Ask a provider which models it offers: [{ id, label, loaded }]. */
export async function listModels({ settings, keyFor, providerId, signal, fetch, relayHeaders, timeoutMs }) {
  const t = resolveTarget(settings, keyFor, providerId || settings.provider, { relayHeaders, forListing: true });
  const cfg = timeoutMs ? { ...t.cfg, timeoutMs } : t.cfg;
  return t.adapter.listModels({ cfg, key: t.key, signal, fetch });
}

/**
 * Settings > "Test connection": discovery, model check, then one tiny generation with reasoning off.
 * Never throws. @returns {Promise<{ok, code, message, models?, loaded?}>}
 */
export async function testConnection({ settings, keyFor, providerId, signal, fetch, relayHeaders }) {
  const id = providerId || settings.provider;
  const p = provider(id);
  const { model } = profileFor(settings, id);
  let models = [];
  try {
    models = await listModels({ settings, keyFor, providerId: id, signal, fetch, relayHeaders });
  } catch (e) {
    return { ok: false, code: e?.code || 'network', message: e?.message || String(e) };
  }
  const loaded = models.find((m) => m.loaded)?.id || '';
  if (model && models.length && !models.some((m) => m.id === model)) {
    return { ok: false, code: 'missing-model', message: `Connected, but "${model}" is not offered by this server. Pick one from the list.`, models, loaded };
  }
  if (!model && p.modelRequired) {
    return { ok: false, code: 'missing-model', message: `Connected (${models.length} models available). Choose a model to finish setup.`, models, loaded };
  }
  if (!model && id === 'lmstudio' && !loaded) {
    return { ok: false, code: 'missing-model', message: 'Connected, but no model is loaded in LM Studio. Load one there, or choose a model here (LM Studio loads it on first use).', models, loaded };
  }
  let text = '';
  let reasoning = '';
  try {
    await streamChat({
      settings: { ...settings, provider: id, fallbackProvider: '', reasoning: 'off', maxOutputTokens: 256, temperature: 0 },
      keyFor, system: '', messages: [{ role: 'user', content: TEST_PROMPT }], signal, fetch, relayHeaders,
      onEvent: (e) => { if (e.type === 'text') text += e.text; if (e.type === 'reasoning') reasoning += e.text; },
    });
  } catch (e) {
    return { ok: false, code: e?.code || 'network', message: e?.message || String(e), models, loaded };
  }
  const using = model || loaded;
  const sample = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim().slice(0, 60);
  const who = using ? ` (${using})` : '';
  if (sample) return { ok: true, code: 'ok', message: `Connected${who}. The model replied: "${sample}"`, models, loaded };
  if (reasoning) return { ok: true, code: 'ok', message: `Connected${who}. The model only produced reasoning in the test; raise "Max reply tokens" if answers come back empty.`, models, loaded };
  return { ok: true, code: 'ok', message: `Connected${who}, but the test reply was empty.`, models, loaded };
}
