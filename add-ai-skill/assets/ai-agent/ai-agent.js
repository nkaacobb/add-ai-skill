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
import { normalizeTool, toolEnabled, toolAvailable, toolsConfigPatch, exportToolsConfig, validateArgs, serializeResult, toolSpecs } from './core/tools.js';
import { createMemoryStore } from './core/memory.js';

export { PROVIDERS, PROVIDER_IDS } from './core/providers.js';
export { DEFAULT_SYSTEM_PROMPT } from './core/prompt.js';
export { renderMarkdown } from './ui/markdown.js';
export { hashText, stableStringify } from './core/hash.js';
export { AiError } from './core/transport.js';
export { parseBlockValues } from './core/blocks.js';
export { probeRelay } from './core/relay-probe.js';
export { setControlValue } from './ui/dom.js';
export { parseMemoryFile, exportMemoryFile } from './core/memory.js';

export const VERSION = '1.4.0';

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
    placeholder: 'Ask about what is on screen…',
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
    tools: [],
    toolsConfig: null,
    memory: true,               // notes kept between conversations (Settings > Memory); false = none
    memoryFile: null,           // the app's memory file, e.g. 'ai-memory.json' (URL, object, or function)
    memorySave: null,           // (file) => void | Promise: keep the memories somewhere besides this browser
    screenshots: true,          // screenshots for models that see images (Settings > Vision); false = none
    screenshot: null,           // () => canvas | image | Blob | data URL: the app's own way to capture its view
    screenshotMaxEdge: 1280,    // screenshots are scaled down to this many pixels on their longer edge
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
    return buildSystemPrompt({
      base, appText, pageText, share: s.shareScreen,
      toolsText: drawer ? drawer.toolPrompt(s) : '',
      memoryText: drawer ? drawer.memoryPrompt(s) : '',
      vision: drawer ? drawer.visionOn(s) : false,
    });
  };

  let drawer = null;

  /* Memory: notes kept between conversations — the app's file underneath, this browser's changes on top. */
  const memory = o.memory === false ? null : createMemoryStore({ namespace, storage });
  let saveTimer = null;
  const offMemory = memory ? memory.onChange(({ memories, change }) => {
    emit('memory', { memories, change });
    panel?.refreshMemory?.();
    // The app's own persistence (a file on its server, a user profile): every change made here, never the file load.
    if (typeof o.memorySave === 'function' && change?.type !== 'base') {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        Promise.resolve().then(() => o.memorySave(memory.export())).catch((e) => console.warn('[ai-agent] memorySave failed; the memories are still kept in this browser.', e));
      }, 400);
    }
  }) : () => {};

  /* Tools: the app-wide catalog (`tools` option, agent.tools.register) plus the current page's `tools`. */
  const appTools = new Map();
  const pageToolCache = new WeakMap();
  const registerTools = (defs, { page = '' } = {}) => {
    const out = [];
    for (const def of Array.isArray(defs) ? defs : [defs]) {
      try { out.push(normalizeTool(def, { page })); } catch (e) { console.error(`[ai-agent] Tool skipped: ${e.message}`); }
    }
    return out;
  };
  for (const t of registerTools(o.tools)) appTools.set(t.name, t);
  const toolRegistry = {
    all() {
      const page = ctx.page;
      let pageTools = [];
      if (page && Array.isArray(page.tools) && page.tools.length) {
        pageTools = pageToolCache.get(page);
        if (!pageTools) { pageTools = registerTools(page.tools, { page: page.id }); pageToolCache.set(page, pageTools); }
      }
      const merged = new Map(appTools);
      for (const t of pageTools) merged.set(t.name, t);
      return [...merged.values()];
    },
    get(name) { return toolRegistry.all().find((t) => t.name === name) || null; },
  };

  const getContextInfo = async () => {
    const s = store.get();
    ctx.setMaxChars(s.maxContextChars);
    const status = await drawer.computeStatus();
    const [appText, pageText, viewText, snapshot, system] = await Promise.all([
      ctx.appText(), ctx.pageText(), ctx.viewText(), ctx.snapshot(), systemPrompt(),
    ]);
    const set = drawer.toolMode(s) === 'native' ? drawer.toolSet(s) : null;
    const callable = set && set.active ? set.classes.callable : [];
    return {
      status: { state: status.state, currentHash: status.hash, syncedHash: status.syncedHash },
      appText, pageText, viewText, snapshot, system, share: s.shareScreen, hasContent: ctx.hasContent,
      toolsJson: callable.length ? JSON.stringify(toolSpecs(callable)) : '',
    };
  };

  let relay = null;
  let panel = null;
  panel = createSettingsPanel({
    store, defaultPrompt, getContextInfo, relayHeaders: o.relayHeaders, theme: o.theme, title: o.title, mount: o.mount,
    isolate: o.isolateKeys !== false, warnTokens: o.contextWarnTokens, relayInfo: () => relay,
    getTools: () => toolRegistry.all(), pageId: () => ctx.page?.id,
    memory,
    vision: () => (drawer?.capture ? {
      method: drawer.capture.method(), live: drawer.capture.live(), stop: () => drawer.capture.stop(),
      model: drawer.probeInfo?.model || '', modelSees: drawer.probeInfo?.vision,
    } : null),
  });
  let onDialogChange = () => {};
  drawer = new AgentDrawer({
    ctx, store, panel, emit, defaultPrompt,
    options: { ...o, storage, session: safeStorage('sessionStorage'), onDialogChange: () => onDialogChange(), toolRegistry, memoryStore: memory },
  });

  // Trailing debounce with a max wait: continuous updates (animation, simulation, live data) still refresh the flag
  // at least every debounceMaxMs.
  const changed = debounce(() => drawer.refreshStatus(), o.debounceMs, { maxWait: Math.max(0, Number(o.debounceMaxMs) || 0) });
  onDialogChange = () => changed();

  // A JSON file of the app (tool config, memory): an object, a URL, or a (possibly async) function.
  const loadJson = async (source) => {
    let v = typeof source === 'function' ? await source() : await source;
    if (typeof v === 'string') {
      const res = await fetch(new URL(v, globalThis.location?.href).href, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${v}`);
      v = await res.json();
    }
    return v;
  };

  // Async defaults, the tool config file, the memory file and the relay probe. Questions wait for this (drawer.ready);
  // nothing else does.
  const needsAsync = !isPlainObject(o.defaults) && o.defaults != null;
  const ready = (needsAsync || o.relayProbe || o.toolsConfig || (memory && o.memoryFile)) ? (async () => {
    let d = syncDefaults;
    if (needsAsync) {
      try {
        const v = await (typeof o.defaults === 'function' ? o.defaults() : o.defaults);
        if (isPlainObject(v)) d = v;
      } catch (e) {
        console.error('[ai-agent] The `defaults` option failed; using the built-in defaults.', e);
      }
    }
    if (o.toolsConfig) {
      // The app's tool selection (e.g. ai-tools.json): an object, a URL, or a (possibly async) function.
      try {
        const patch = toolsConfigPatch(await loadJson(o.toolsConfig));
        d = { ...d, ...patch, toolStates: { ...(d.toolStates || {}), ...(patch.toolStates || {}) } };
      } catch (e) {
        console.warn('[ai-agent] The toolsConfig could not be loaded; tools keep their built-in defaults.', e);
      }
    }
    if (memory && o.memoryFile) {
      // The app's memory file (e.g. ai-memory.json): the base that this browser's own memories sit on.
      try {
        memory.setBase(await loadJson(o.memoryFile));
      } catch (e) {
        console.warn('[ai-agent] The memoryFile could not be loaded; only the memories saved in this browser are used.', e);
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
    drawer.refreshVision();
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

    tools: {
      /** Every tool the agent knows now (app-wide + this page), with its state. */
      list() {
        const s = store.get();
        return toolRegistry.all().map((t) => ({
          name: t.name, title: t.title, description: t.description, effect: t.effect, group: t.group, pages: [...t.pages],
          enabled: toolEnabled(t, s), available: toolAvailable(t, ctx.page?.id),
        }));
      },
      /** Add or replace app-wide tools. */
      register(defs) { for (const t of registerTools(defs)) appTools.set(t.name, t); panel.refreshTools?.(); },
      unregister(name) { appTools.delete(name); panel.refreshTools?.(); },
      /** Turn a tool on or off for this user (saved like the other settings). */
      setEnabled(name, on) { drawer.setToolEnabled(name, on); },
      /** Run a tool directly (tests, scripted checks): arguments are validated; no confirmation, no on/off check. */
      async run(name, args = {}) {
        const t = toolRegistry.get(name);
        if (!t) throw new Error(`No tool named "${name}".`);
        const v = validateArgs(t, args);
        if (!v.ok) throw new Error(`Invalid arguments: ${v.errors.join('; ')}`);
        return serializeResult(await t.run(v.args, { agent: api, signal: undefined, call: { id: 'direct', name } }));
      },
      /** The current selection as the JSON an app ships as its toolsConfig (e.g. ai-tools.json). */
      exportConfig() { return exportToolsConfig(toolRegistry.all(), store.get()); },
    },

    /** Notes kept between conversations (null with `memory: false`). */
    memory: memory ? {
      list: () => memory.list(),
      add: (text) => memory.add(text, { source: 'user' }),
      update: (id, text) => memory.update(id, text),
      remove: (id) => memory.remove(id),
      clear: () => memory.clear(),
      /** The memories as the JSON an app ships as its memoryFile (e.g. ai-memory.json). */
      export: () => memory.export(),
      /** Add the memories of such a file; `{ replace: true }` makes them the whole memory. Returns how many were added. */
      import: (json, options) => memory.import(json, options),
    } : null,

    /**
     * Take a screenshot and put it in the composer for the next question (what the camera button does). With the
     * browser's screen capture this must be called from a click. Resolves to { width, height, source } or null.
     */
    async screenshot() {
      const shot = await drawer.attachScreenshot();
      return shot ? { width: shot.width, height: shot.height, source: shot.source } : null;
    },

    on,
    settings: {
      get: () => store.get(),
      save: (patch) => store.save(patch),
      reset: () => store.reset(),
      setKey: (providerId, key) => store.keys.set(providerId, key),
    },
    destroy() {
      changed.cancel();
      clearTimeout(saveTimer);
      offMemory();
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
