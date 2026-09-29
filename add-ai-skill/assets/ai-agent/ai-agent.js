// ai-agent-drawer runtime — public entry point.
//
//   import { createAiAgent } from './ai-agent/ai-agent.js';   // plus <link rel="stylesheet" href="./ai-agent/ai-agent.css">
//
//   const agent = createAiAgent({
//     appId: 'my-app',
//     title: 'Assistant',
//     app:  { name: 'My App', purpose: 'What the app is for', capabilities: [...], limits: [...] },
//     page: { id: 'orders', title: 'Orders', purpose: 'What this page is for',
//             content: () => visibleRows,            // what is on screen (fingerprinted)
//             view:    () => ({ selection, filters }) },  // volatile UI state (not fingerprinted)
//     toggle: '#ask-ai',
//   });
//   agent.contextChanged();          // call whenever the screen content may have changed
//   agent.setPage({ ... });          // call on navigation
//
// Everything is vanilla ES modules with no dependencies and no build step. See ai-agent.d.ts for the full API and
// the skill's references/ folder for the design.

import { ContextManager } from './core/context.js';
import { createSettingsStore, safeStorage } from './core/settings.js';
import { DEFAULT_SYSTEM_PROMPT, buildSystemPrompt } from './core/prompt.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { AgentDrawer } from './ui/drawer.js';
import { debounce } from './ui/dom.js';
import { isDevHost } from './ui/layout-check.js';
import { probeRelay, relayDefaults, adjustForRelay, mergeSettings } from './core/relay-probe.js';

export { PROVIDERS, PROVIDER_IDS } from './core/providers.js';
export { DEFAULT_SYSTEM_PROMPT } from './core/prompt.js';
export { renderMarkdown } from './ui/markdown.js';
export { hashText, stableStringify } from './core/hash.js';
export { AiError } from './core/transport.js';
export { parseBlockValues } from './core/blocks.js';
export { probeRelay } from './core/relay-probe.js';
export { setControlValue } from './ui/dom.js';

export const VERSION = '1.1.0';

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.then !== 'function';

const DEFAULT_WELCOME = 'I can see what is on your screen. Ask me about it — to explain, summarise, check or improve what you are looking at.';

/**
 * Create and mount the agent: a toggle (or floating launcher), the drawer, and the settings modal.
 * @param {import('./ai-agent').AiAgentOptions} options
 * @returns {import('./ai-agent').AiAgent}
 */
export function createAiAgent(options = {}) {
  if (typeof document === 'undefined') throw new Error('createAiAgent() needs a browser document. Call it on the client only.');

  const o = {
    appId: 'app',
    title: 'AI agent',
    placeholder: 'Ask about what is on screen…  (Enter to send, Shift+Enter for a new line)',
    welcome: DEFAULT_WELCOME,
    suggestions: [],
    toggle: null,
    launcher: true,
    toggleBadge: true,
    push: document.body,
    hotkey: 'mod+i',
    theme: 'auto',
    width: 440,
    watch: 0,
    debounceMs: 300,
    debounceMaxMs: 1000,
    isolateKeys: true,
    dialogs: false,
    devWarnings: 'auto',
    relayProbe: false,
    contextWarnTokens: 3000,
    codeActions: [],
    replyActions: [],
    defaults: {},
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    saveChats: true,
    resume: true,
    mount: document.body,
    ...options,
  };
  if (o.push === true) o.push = document.body;
  if (o.push === false) o.push = null;
  o.devWarnings = o.devWarnings === 'auto' ? isDevHost() : !!o.devWarnings;

  const namespace = `${String(o.appId).replace(/[^\w.-]/g, '_')}.ai`;
  const storage = safeStorage('localStorage');
  // `defaults` may be an object, a promise, or a (possibly async) function; the async part is applied by `ready`.
  const syncDefaults = isPlainObject(o.defaults) ? o.defaults : {};
  const store = createSettingsStore({ namespace, defaults: syncDefaults });
  const ctx = new ContextManager({ app: o.app, page: o.page, maxChars: store.get().maxContextChars });

  const listeners = new Map();
  const emit = (event, detail) => {
    for (const fn of [...(listeners.get(event) || [])]) {
      try { fn(detail); } catch (e) { console.error(`[ai-agent] "${event}" listener failed`, e); }
    }
  };
  const on = (event, fn) => {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return () => listeners.get(event)?.delete(fn);
  };

  const defaultPrompt = () => {
    const p = typeof o.systemPrompt === 'function' ? o.systemPrompt() : o.systemPrompt;
    return String(p || DEFAULT_SYSTEM_PROMPT);
  };

  const systemPrompt = async () => {
    const s = store.get();
    const [appText, pageText] = await Promise.all([ctx.appText(), ctx.pageText()]);
    const base = s.systemPrompt && s.systemPrompt.trim() ? s.systemPrompt : defaultPrompt();
    return buildSystemPrompt({ base, appText, pageText, share: s.shareScreen });
  };

  let drawer = null;

  const getContextInfo = async () => {
    const s = store.get();
    ctx.setMaxChars(s.maxContextChars);
    const status = await drawer.computeStatus();
    const [appText, pageText, viewText, snapshot, system] = await Promise.all([
      ctx.appText(), ctx.pageText(), ctx.viewText(), ctx.snapshot(), systemPrompt(),
    ]);
    return {
      status: { state: status.state, currentHash: status.hash, syncedHash: status.syncedHash },
      appText, pageText, viewText, snapshot, system, share: s.shareScreen, hasContent: ctx.hasContent,
    };
  };

  let relay = null;
  const panel = createSettingsPanel({
    store, defaultPrompt, getContextInfo, relayHeaders: o.relayHeaders, theme: o.theme, title: o.title, mount: o.mount,
    isolate: o.isolateKeys !== false, warnTokens: o.contextWarnTokens, relayInfo: () => relay,
  });
  let onDialogChange = () => {};
  drawer = new AgentDrawer({
    ctx, store, panel, emit, defaultPrompt,
    options: { ...o, storage, session: safeStorage('sessionStorage'), onDialogChange: () => onDialogChange() },
  });

  // Trailing debounce with a max wait: continuous updates (animation, simulation, live data) still refresh the flag
  // at least every debounceMaxMs.
  const changed = debounce(() => drawer.refreshStatus(), o.debounceMs, { maxWait: Math.max(0, Number(o.debounceMaxMs) || 0) });
  onDialogChange = () => changed();

  // Async defaults and the relay probe. Questions wait for this (drawer.ready); nothing else does.
  const needsAsync = !isPlainObject(o.defaults) && o.defaults != null;
  const ready = (needsAsync || o.relayProbe) ? (async () => {
    let d = syncDefaults;
    if (needsAsync) {
      try {
        const v = await (typeof o.defaults === 'function' ? o.defaults() : o.defaults);
        if (isPlainObject(v)) d = v;
      } catch (e) {
        console.error('[ai-agent] The `defaults` option failed; using the built-in defaults.', e);
      }
    }
    if (o.relayProbe) {
      const cfg = typeof o.relayProbe === 'object' ? o.relayProbe : { url: typeof o.relayProbe === 'string' ? o.relayProbe : '' };
      const url = cfg.url || d.relayUrl || '';
      if (!url) {
        console.warn('[ai-agent] relayProbe needs a relay address: relayProbe: "api/relay.php", or defaults.relayUrl.');
      } else {
        const headers = typeof o.relayHeaders === 'function' ? o.relayHeaders() : o.relayHeaders;
        relay = await probeRelay(url, { timeoutMs: cfg.timeoutMs, headers: headers && typeof headers === 'object' ? headers : {} });
        d = mergeSettings(d, relayDefaults(relay));
        store.setAdjust((settings) => adjustForRelay(settings, relay));
        emit('relay', relay);
      }
    }
    store.setDefaults(d);
  })() : Promise.resolve();
  drawer.ready = ready;

  const offSettings = store.onChange((settings) => {
    drawer.probeInfo = { key: '' };
    drawer.refreshSubtitle();
    drawer.refreshStatus();
    emit('settings', settings);
  });

  const api = {
    open: () => drawer.open(),
    close: () => drawer.close(),
    toggle: () => drawer.toggle(),
    isOpen: () => drawer.isOpen(),
    ask: (text) => drawer.send(text),
    stop: () => drawer.stop(),
    newChat: () => drawer.newChat(),
    openSettings: (tab = 'model') => panel.open(tab),

    setApp(app) { ctx.setApp(app); changed(); },
    setPage(page) { ctx.setPage(page); drawer.refreshStatus(); },
    setContent(content) { ctx.setContent(content); changed(); },
    setView(view) { ctx.setView(view); },
    contextChanged() { changed(); },
    refreshContext: () => drawer.refreshStatus(),
    getContextStatus: () => ({ ...drawer.status }),
    relayInfo: () => (relay ? { ...relay } : null),
    onContextStatus(fn) {
      const off = on('context', fn);
      try { fn({ ...drawer.status }); } catch (e) { console.error('[ai-agent] onContextStatus listener failed', e); }
      return off;
    },
    rereadPage() { drawer.forceReread = true; return drawer.refreshStatus(); },
    systemPrompt,

    on,
    settings: {
      get: () => store.get(),
      save: (patch) => store.save(patch),
      reset: () => store.reset(),
      setKey: (providerId, key) => store.keys.set(providerId, key),
    },
    destroy() {
      changed.cancel();
      offSettings();
      drawer.destroy();
      panel.destroy();
      listeners.clear();
    },
  };
  api.ready = ready.then(() => api);
  drawer.api = api;
  drawer.refreshStatus();
  // `resume` may have reopened the drawer inside this call, before the app could register agent.on('open'):
  // replay that 'open' once, to listeners registered in the same tick. (Registering later? Check agent.isOpen().)
  if (drawer.resumedOpen) setTimeout(() => { if (drawer.isOpen()) emit('open', { resumed: true }); }, 0);
  return api;
}

/**
 * A content hook that reads what an element shows: its rendered text (tables keep their columns) plus the values of
 * visible form fields, which innerText does not include. The agent's own UI is always skipped.
 * Use it when the app has no better model of its screen; a hook over the app's own state is usually tighter.
 * @param {string|Element} target  CSS selector or element, e.g. 'main'
 * @param {{exclude?: string, fields?: boolean}} [options]
 * @returns {() => string}
 */
export function fromDom(target, { exclude = '', fields = true } = {}) {
  const skip = `.aia-scope, [data-aia-ignore], script, style, template${exclude ? `, ${exclude}` : ''}`;
  return () => {
    const root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) return '';
    const parts = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (child.matches(skip)) continue;
        if (child.querySelector('.aia-scope, [data-aia-ignore]') || (exclude && child.querySelector(exclude))) walk(child);
        else if (child.offsetParent !== null || getComputedStyle(child).position === 'fixed') parts.push(child.innerText);
      }
    };
    if (root.querySelector(skip)) walk(root); else parts.push(root.innerText);
    let text = parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    if (fields) {
      const lines = [];
      for (const field of root.querySelectorAll('input, textarea, select')) {
        if (field.closest(skip) || field.offsetParent === null) continue;
        const type = (field.getAttribute('type') || '').toLowerCase();
        if (['password', 'hidden', 'file', 'submit', 'button', 'reset', 'image'].includes(type)) continue;
        const label = field.getAttribute('aria-label')
          || (field.id && root.querySelector(`label[for="${CSS.escape(field.id)}"]`)?.innerText)
          || field.closest('label')?.innerText
          || field.getAttribute('placeholder') || field.name || field.id || field.tagName.toLowerCase();
        let value;
        if (type === 'checkbox' || type === 'radio') value = field.checked ? 'checked' : 'not checked';
        else if (field.tagName === 'SELECT') value = [...field.selectedOptions].map((x) => x.text).join(', ');
        else value = field.value;
        lines.push(`- ${String(label).replace(/\s+/g, ' ').trim().slice(0, 80)}: ${String(value ?? '').slice(0, 4000)}`);
      }
      if (lines.length) text += `\n\nForm fields:\n${lines.join('\n')}`;
    }
    return text;
  };
}
