// Relay auto-detection. An app that sometimes runs with its relay (PHP/Node server) and sometimes on a plain static
// server has to choose the transport at startup: `createAiAgent({ relayProbe: true, defaults: { relayUrl } })` asks
// the relay with one GET, then uses it when it says `available` (with its fixed provider/model preset, if any), and
// sends requests directly otherwise. A static server returns the PHP source instead of JSON, which means "no relay".
//
// GET {relayUrl} contract (relay.php / relay.mjs 1.1+):
//   200 { ok, relay: 'ai-agent-drawer', version, available, mode: 'local'|'public', providers: [ids],
//         serverKeys: { id: bool }, preset: { provider, model, models: [ids], vision? } | null,
//         images: <how many images one request may carry; 0 = none; absent before 1.3>, reason? }
// The relay answers 200 with available:false (not 403) when it will not serve this client, so page loads stay free
// of console errors. 1.0 relays have no `available`: `ok` is used instead. Pure module: fetch only, no DOM.

import { PROVIDERS } from './providers.js';

export const PROBE_TIMEOUT_MS = 2500;

function normalizePreset(p) {
  if (!p || typeof p !== 'object' || !PROVIDERS[p.provider]) return null;
  const models = (Array.isArray(p.models) ? p.models : []).map(String).filter(Boolean);
  const model = typeof p.model === 'string' && p.model ? p.model : (models[0] || '');
  return { provider: p.provider, model, models: models.length ? models : (model ? [model] : []), ...(typeof p.vision === 'boolean' ? { vision: p.vision } : {}) };
}

/** A GET reply (parsed JSON) -> relay info. */
export function normalizeRelayInfo(json, url, status = 200) {
  if (!json || typeof json !== 'object' || json.relay !== 'ai-agent-drawer') {
    return { url, available: false, mode: '', preset: null, providers: [], serverKeys: {}, images: 0, reason: 'Not an ai-agent-drawer relay.' };
  }
  const available = typeof json.available === 'boolean' ? json.available : json.ok === true && status < 400;
  return {
    url,
    available,
    mode: json.mode === 'public' ? 'public' : 'local',
    version: typeof json.version === 'string' ? json.version : '',
    providers: Array.isArray(json.providers) ? json.providers.filter((id) => PROVIDERS[id]) : [],
    serverKeys: json.serverKeys && typeof json.serverKeys === 'object' ? { ...json.serverKeys } : {},
    preset: normalizePreset(json.preset),
    images: Number.isInteger(json.images) && json.images > 0 ? json.images : 0,
    reason: typeof json.reason === 'string' ? json.reason : '',
  };
}

/** Ask a relay whether it will serve this page. Never throws. */
export async function probeRelay(url, { timeoutMs = PROBE_TIMEOUT_MS, headers = {}, fetch = globalThis.fetch } = {}) {
  const none = (reason) => ({ url, available: false, mode: '', preset: null, providers: [], serverKeys: {}, images: 0, reason });
  if (!url) return none('No relay address.');
  if (typeof fetch !== 'function') return none('No fetch implementation.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let target = String(url);
    if (!/^https?:\/\//i.test(target) && globalThis.location?.href) target = new URL(target, globalThis.location.href).href;
    const res = await fetch(target, {
      method: 'GET',
      headers: { Accept: 'application/json', 'X-Requested-With': 'ai-agent-drawer', ...headers },
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch {
      return none(`No relay at ${url}: the reply was not JSON (HTTP ${res.status}; a static server returns the relay's source).`);
    }
    return normalizeRelayInfo(json, url, res.status);
  } catch (e) {
    return none(ctl.signal.aborted ? `The relay did not answer within ${timeoutMs} ms.` : `The relay could not be reached (${e?.message || e}).`);
  } finally {
    clearTimeout(timer);
  }
}

/** Settings defaults implied by a probe: the relay (and its preset) when available, direct requests otherwise. */
export function relayDefaults(info) {
  if (!info) return {};
  if (!info.available) return { transport: 'direct' };
  const out = { transport: 'relay', relayUrl: info.url };
  if (info.preset) {
    out.provider = info.preset.provider;
    out.profiles = { [info.preset.provider]: { model: info.preset.model } };
    if (typeof info.preset.vision === 'boolean') out.vision = info.preset.vision;
  }
  if (!info.images) out.vision = false;       // a relay that cannot pass images: no screenshots through it
  return out;
}

function sameUrl(a, b) {
  const norm = (u) => {
    const s = String(u || '').trim();
    try { return globalThis.location?.href ? new URL(s, globalThis.location.href).href : s; } catch { return s; }
  };
  return norm(a) === norm(b);
}

/**
 * Keep saved settings usable against what the probe found (applied when settings are read; storage is untouched):
 * a relay that is not available here is not used; a public relay only serves its preset provider and models.
 */
export function adjustForRelay(settings, info) {
  if (!info || settings.transport !== 'relay' || !sameUrl(settings.relayUrl, info.url)) return settings;
  if (!info.available) return { ...settings, transport: 'direct' };
  if (!info.images && settings.vision) settings = { ...settings, vision: false };
  if (info.mode !== 'public' || !info.preset) return settings;
  const { provider, model, models } = info.preset;
  const prof = settings.profiles?.[provider] || {};
  const okModel = !models.length || models.includes(prof.model);
  return {
    ...settings,
    provider,
    fallbackProvider: '',
    profiles: okModel ? settings.profiles : { ...settings.profiles, [provider]: { ...prof, model } },
  };
}

/** Merge settings patches (profiles merged per provider). */
export function mergeSettings(a = {}, b = {}) {
  const profiles = { ...(a.profiles || {}) };
  for (const [id, p] of Object.entries(b.profiles || {})) profiles[id] = { ...(profiles[id] || {}), ...p };
  return { ...a, ...b, profiles };
}
