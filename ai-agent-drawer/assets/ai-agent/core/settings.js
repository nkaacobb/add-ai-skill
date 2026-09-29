// Agent settings: validated like a schema (unknown keys dropped, invalid values fall back to the default, strings
// bounded, URLs http(s) without embedded credentials), stored per application in localStorage.
//
// Layering: built-in defaults < the host app's `defaults` option < what the user saved in Settings.
//
// API keys are NOT part of the settings object. They live in their own store: sessionStorage by default (gone when
// the tab closes), localStorage only when the user ticks "Remember on this device". Either way any script on this
// origin can read them — for deployed/shared apps use the relay so keys stay on the server.

import { PROVIDER_IDS, provider } from './providers.js';
import { DEFAULT_MAX_CONTEXT_CHARS } from './context.js';
import { DEFAULT_HISTORY_MESSAGES } from './conversation.js';

export const LIMITS = Object.freeze({ url: 400, model: 200, prompt: 20000, key: 512 });

/** Field schema: [type, default, extra]. int/number: [min, max]; enum: allowed values. */
export const SETTINGS_SCHEMA = Object.freeze({
  provider: ['enum', 'lmstudio', PROVIDER_IDS],
  profiles: ['profiles', {}],                 // per provider: { baseUrl, model } — remembered when switching
  transport: ['enum', 'direct', ['direct', 'relay']],
  relayUrl: ['endpoint', ''],                 // absolute, or a same-origin path such as /ai-relay or api/relay.php
  fallbackProvider: ['enum', '', ['', ...PROVIDER_IDS]],
  systemPrompt: ['text', ''],                 // '' = use the application's default prompt
  temperature: ['number', 0.4, [0, 2]],
  maxOutputTokens: ['int', 4096, [64, 64000]],  // local models often think first: leave room
  historyMessages: ['int', DEFAULT_HISTORY_MESSAGES, [2, 200]],
  maxContextChars: ['int', DEFAULT_MAX_CONTEXT_CHARS, [1000, 400000]],
  reasoning: ['enum', 'show', ['show', 'hide', 'off']],
  shareScreen: ['boolean', true],
  timeoutSec: ['int', 120, [10, 900]],
  rememberKeys: ['boolean', false],
});

export const DEFAULT_SETTINGS = Object.freeze(Object.fromEntries(
  Object.entries(SETTINGS_SCHEMA).map(([k, [, d]]) => [k, typeof d === 'object' ? { ...d } : d]),
));

export function validUrl(v) {
  if (typeof v !== 'string' || v.length > LIMITS.url || /[\s\u0000-\u001f]/.test(v)) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  return !/[?&](key|api_key|token|access_token)=/i.test(u.search);
}

const validEndpoint = (v) => v === '' || validUrl(v) || (typeof v === 'string' && v.length <= LIMITS.url && /^[\w./~%-][\w./~%?=&-]*$/.test(v) && !/^\/\//.test(v));
const validModel = (v) => typeof v === 'string' && v.length <= LIMITS.model && /^[\w@:./+\- ]*$/.test(v);

function validField([type, , extra], v) {
  switch (type) {
    case 'int': return Number.isInteger(v) && v >= extra[0] && v <= extra[1];
    case 'number': return typeof v === 'number' && Number.isFinite(v) && v >= extra[0] && v <= extra[1];
    case 'boolean': return typeof v === 'boolean';
    case 'enum': return extra.includes(v);
    case 'endpoint': return validEndpoint(v);
    case 'text': return typeof v === 'string' && v.length <= LIMITS.prompt;
    case 'profiles': return !!v && typeof v === 'object' && !Array.isArray(v);
    default: return false;
  }
}

function sanitizeProfiles(v, base = {}) {
  const out = {};
  for (const id of PROVIDER_IDS) {
    const prof = { ...(base[id] || {}) };
    const p = v?.[id];
    if (p && typeof p === 'object') {
      if (validUrl(p.baseUrl)) prof.baseUrl = p.baseUrl;
      if (validModel(p.model)) prof.model = p.model.trim();
    }
    if (Object.keys(prof).length) out[id] = prof;
  }
  return out;
}

/** Merge a candidate over `base`, field by field; anything invalid keeps the base value. */
export function sanitizeSettings(candidate, base = DEFAULT_SETTINGS) {
  const src = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : {};
  const out = {};
  for (const [k, spec] of Object.entries(SETTINGS_SCHEMA)) {
    if (k === 'profiles') continue;
    const has = Object.prototype.hasOwnProperty.call(src, k);
    out[k] = has && validField(spec, src[k]) ? src[k] : (base[k] ?? spec[1]);
  }
  out.profiles = sanitizeProfiles(src.profiles, sanitizeProfiles(base.profiles || {}));
  if (out.fallbackProvider === out.provider) out.fallbackProvider = '';
  return out;
}

/** The effective address and model for a provider, profile first, catalog second. */
export function profileFor(settings, id = settings.provider) {
  const p = provider(id);
  const prof = settings.profiles?.[id] || {};
  return { baseUrl: prof.baseUrl || p.baseUrl, model: prof.model ?? '' };
}

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

/** A storage that works even when the browser blocks it (private mode, file://, sandboxed iframes). */
export function safeStorage(name) {
  try {
    const s = globalThis[name];
    s.setItem('__aia_probe', '1');
    s.removeItem('__aia_probe');
    return s;
  } catch {
    return memoryStorage();
  }
}

function readJson(storage, key, fallback) {
  try {
    const v = JSON.parse(storage.getItem(key) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * @param {object} o
 * @param {string} o.namespace   storage prefix, one per application (e.g. 'hello-world.ai')
 * @param {object} o.defaults    the host application's defaults (any subset of the settings)
 */
export function createSettingsStore({ namespace = 'ai-agent', defaults = {}, storage, session } = {}) {
  const local = storage || safeStorage('localStorage');
  const sess = session || safeStorage('sessionStorage');
  const SETTINGS_KEY = `${namespace}.settings`;
  const KEYS_KEY = `${namespace}.keys`;
  const base = sanitizeSettings(defaults, DEFAULT_SETTINGS);
  const listeners = new Set();

  let current = sanitizeSettings(readJson(local, SETTINGS_KEY, null), base);

  const keyStore = () => (current.rememberKeys ? local : sess);
  const otherStore = () => (current.rememberKeys ? sess : local);

  function readKeys(store) {
    const v = readJson(store, KEYS_KEY, {});
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  }

  function writeKeys(store, map) {
    try {
      if (Object.keys(map).length) store.setItem(KEYS_KEY, JSON.stringify(map));
      else store.removeItem(KEYS_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function emit() {
    for (const fn of [...listeners]) {
      try { fn(get()); } catch { /* a listener must not break the others */ }
    }
  }

  function get() { return JSON.parse(JSON.stringify(current)); }

  /** Save a full or partial settings object. Returns false if the browser refused to store it. */
  function save(next) {
    const before = current;
    current = sanitizeSettings({ ...before, ...next, profiles: { ...before.profiles, ...(next?.profiles || {}) } }, base);
    if (before.rememberKeys !== current.rememberKeys) {
      // Move the keys to the store the user just chose, and clear them from the other one.
      const merged = { ...readKeys(sess), ...readKeys(local) };
      writeKeys(otherStore(), {});
      writeKeys(keyStore(), merged);
    }
    let ok = true;
    try { local.setItem(SETTINGS_KEY, JSON.stringify(current)); } catch { ok = false; }
    emit();
    return ok;
  }

  function reset() {
    try { local.removeItem(SETTINGS_KEY); } catch { /* ignore */ }
    const merged = { ...readKeys(sess), ...readKeys(local) };
    current = sanitizeSettings(null, base);
    writeKeys(local, {});
    writeKeys(keyStore(), merged);
    emit();
  }

  const keys = {
    get(id) {
      const k = readKeys(keyStore())[id] ?? readKeys(otherStore())[id];
      return typeof k === 'string' ? k : '';
    },
    set(id, key) {
      const k = typeof key === 'string' ? key.trim() : '';
      const map = readKeys(keyStore());
      if (!k || k.length > LIMITS.key || /[\s\u0000-\u001f]/.test(k)) delete map[id];
      else map[id] = k;
      const other = readKeys(otherStore());
      if (other[id]) { delete other[id]; writeKeys(otherStore(), other); }
      return writeKeys(keyStore(), map);
    },
    has(id) { return keys.get(id) !== ''; },
    clearAll() { writeKeys(local, {}); writeKeys(sess, {}); },
  };

  return {
    namespace,
    get,
    save,
    reset,
    defaults: () => JSON.parse(JSON.stringify(base)),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    keys,
  };
}
