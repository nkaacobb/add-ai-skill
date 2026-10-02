// The chat drawer: slides in from the right, streams replies as rich Markdown, shows the context-sync flag, and
// keeps saved conversations. Everything application-specific arrives through options and the ContextManager.

import { streamChat, listModels, resolveTarget } from '../core/client.js';
import { planTurn, contextState, buildRequestMessages, snapshotBlock, hasFiles } from '../core/conversation.js';
import {
  REQUEST_TOOL, classifyTools, toolSpecs, requestToolSpec, buildToolPrompt, parseTextToolCalls, textTurnMessages,
  validateArgs, toolEnabled, toolAvailable, serializeResult, formatCall, normalizeTool,
  argumentsProblem, callDetail, callReport, wireCall, STATUS_WORDS,
} from '../core/tools.js';
import { buildMemoryPrompt } from '../core/memory.js';
import { buildSkillsPrompt, skillLoadedMessage, skillFilePath, parseSlashCommand, SKILL_FILE_MAX } from '../core/skills.js';
import { agentToolNames, agentSkillNames, buildAgentPrompt, pickAgent, implicitAgent } from '../core/agents.js';
import { mergePolicies, decidePermission, needsConfirmation } from '../core/permissions.js';
import { lineDiff, diffHunks } from '../core/workspace.js';
import { createCapture, imageFromFile } from './capture.js';
import { readFile, fileKind, fileLabel, safeName, fileSummary, extension, FILE_LIMITS } from '../core/files.js';
import { AiError } from '../core/transport.js';
import { buildSystemPrompt } from '../core/prompt.js';
import { splitReasoning } from '../core/reasoning.js';
import { shortHash } from '../core/hash.js';
import { provider } from '../core/providers.js';
import { profileFor } from '../core/settings.js';
import { renderMarkdown } from './markdown.js';
import { attachResize } from './resize.js';
import { ICONS } from './icons.js';
import { esc, h, copyText, flash, formatWhen, uid, nf, frameThrottle, resolveElements, resolveElement, isolateKeys } from './dom.js';
import { createDialogDock, modalDialogOpen } from './dialogs.js';
import { checkPushLayout, PUSH_HELP } from './layout-check.js';

const CHAT_LIMIT = 50;
const MESSAGE_LIMIT = 200;
const REASONING_TAIL = 20000;
const SHOTS_IN_MEMORY = 8;      // full-size images kept for this page load (saved chats keep thumbnails only)
const PENDING_SHOTS = 3;        // images (screenshots and attached image files) one question can carry
const DETAIL_SAVED = 2000;      // characters of each part of a tool row's detail kept in saved chats (the live row has all)

/**
 * What the integration's `host` offers, for the in-app agent writing a tool (development workspace): each function
 * with its parameter list as written in the source, and the other properties with their type (one level into plain
 * objects). Nothing is called.
 */
export function describeHost(host) {
  if (host === null || host === undefined) return 'There is no host: the integration passes none (createAiAgent({ host })). A tool can only use the page itself, e.g. document.querySelector, or call the agent.';
  const signature = (fn) => {
    const src = Function.prototype.toString.call(fn).replace(/\s+/g, ' ');
    const m = /^(?:async\s+)?(?:function\b[^(]*)?\s*(\([^)]*\)|[\w$]+)\s*(?:=>|\{)/.exec(src) || /^(?:async\s+)?[\w$]+\s*(\([^)]*\))/.exec(src);
    return m ? (m[1].startsWith('(') ? m[1] : `(${m[1]})`) : '(…)';
  };
  const describe = (value) => {
    if (typeof value === 'function') return `function${signature(value)}`;
    if (Array.isArray(value)) return `array (${value.length} items)`;
    if (typeof Element === 'function' && value instanceof Element) return `<${value.tagName.toLowerCase()}${value.id ? `#${value.id}` : ''}> element${'value' in value ? ' (value, checked: a form control — set it with setControlValue)' : ''}`;
    if (value && typeof value === 'object') return 'object';
    return typeof value;
  };
  const keys = (obj) => {
    const out = new Set();
    for (let o = obj; o && o !== Object.prototype && o !== Function.prototype; o = Object.getPrototypeOf(o)) for (const k of Object.getOwnPropertyNames(o)) if (k !== 'constructor') out.add(k);
    return [...out].slice(0, 80);
  };
  const lines = ['host offers (call these as host.<name>):'];
  for (const k of keys(host)) {
    let v;
    try { v = host[k]; } catch { continue; }
    lines.push(`- ${k}: ${describe(v)}`);
    if (v && typeof v === 'object' && !Array.isArray(v) && !(typeof Element === 'function' && v instanceof Element)) {
      for (const k2 of keys(v).slice(0, 30)) {
        let v2;
        try { v2 = v[k2]; } catch { continue; }
        lines.push(`  - ${k}.${k2}: ${describe(v2)}`);
      }
    }
  }
  if (lines.length === 1) lines.push('(nothing enumerable)');
  lines.push('Functions with no parameters that return data (such as a state() getter) can be called inside run(); check what they return by reading their source.');
  return lines.join('\n');
}

/** A tool row's detail as saved chats keep it: each part capped at DETAIL_SAVED characters. */
const savedDetail = (d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length > DETAIL_SAVED
  ? `${v.slice(0, DETAIL_SAVED)}… [${nf(v.length - DETAIL_SAVED)} more characters not kept in saved chats]` : v]));

const FLAG = {
  synced: (s) => `Agent has this page${s.title ? ` · ${s.title}` : ''}`,
  dirty: () => 'Page changed · agent re-reads it with your next message',
  unread: () => 'Agent will read this page with your next message',
  none: () => 'No page content shared',
  off: () => 'Screen sharing is off',
};

export class AgentDrawer {
  /**
   * @param {object} o
   * @param {import('../core/context.js').ContextManager} o.ctx
   * @param {object} o.store      settings store (core/settings.js)
   * @param {object} o.panel      settings panel (ui/settings-panel.js)
   * @param {object} o.options    createAiAgent options
   * @param {Function} o.emit     (event, detail) => void
   * @param {Function} o.defaultPrompt () => string
   */
  constructor({ ctx, store, panel, options, emit, defaultPrompt }) {
    this.ctx = ctx;
    this.store = store;
    this.panel = panel;
    this.o = options;
    this.emit = emit;
    this.defaultPrompt = defaultPrompt;
    this.ns = store.namespace;
    this.chatsKey = `${this.ns}.chats`;
    this.conv = { id: null, messages: [], skills: [] };   // skills: names of the skills active in this conversation
    this.agentName = '';             // the active agent ('' until the capabilities are known: the default one)
    this.replies = new Map();
    this.toolDetails = new WeakMap();  // tool row -> { name, title, status, detail }: what rolling it down shows
    this.streaming = null;
    this.forceReread = false;
    this.status = { state: 'none' };
    this.statusSeq = 0;
    this.openState = false;
    this.probeInfo = { key: '', text: '' };
    this.cleanups = [];
    this.ready = null;         // set by createAiAgent while async defaults / the relay probe are pending
    this.warned = new Set();
    this.allowedTools = new Set();   // write tools the user allowed "for this chat"
    this.textTools = new Set();      // provider+model pairs that refused native tool calls (auto mode)
    this.memory = options.memoryStore || null;
    this.shots = new Map();          // image id -> { mime, data }: the full images, for this page load only
    this.pending = [];               // images (screenshots, image files) waiting in the composer for the next question
    this.attachOn = options.attachments !== false;   // the + button, drag and drop, paste
    this.pendingFiles = [];          // documents waiting in the composer: file records (core/files.js) with an id
    this.reading = new Set();        // attachments still being read; a question waits for them
    this.sendWhenRead = false;       // Send was pressed while a file was still being read
    this.fileRecords = new Map();    // file id -> record, for "see what the agent received"
    this.capture = options.screenshots === false ? null : createCapture({
      hook: typeof options.screenshot === 'function' ? options.screenshot : null,
      maxEdge: options.screenshotMaxEdge,
      keep: () => !!this.store.get().screenshotAuto,
      drawerRect: () => (this.openState ? this.el.getBoundingClientRect() : null),
      hideDrawer: (hidden) => { this.el.style.visibility = hidden ? 'hidden' : ''; },
      onState: () => this.panel.refreshVision?.(),
    });
    this.builtinTools = this.makeBuiltins();
    this.build();
  }

  /* ================================================================== DOM */

  build() {
    const o = this.o;
    const theme = o.theme && o.theme !== 'auto' ? ` data-aia-theme="${esc(o.theme)}"` : '';
    this.el = h(`
<aside class="aia-scope aia-drawer" id="${esc(this.ns.replace(/\W/g, '-'))}-drawer" aria-label="${esc(o.title)}" aria-hidden="true"${theme}>
  <div class="aia-resizer" role="separator" aria-orientation="vertical" tabindex="0" aria-label="Resize the ${esc(o.title)} panel" title="Drag to resize · double-click to reset"></div>
  <header class="aia-head">
    <div class="aia-title">
      <span class="aia-mark">${ICONS.spark}</span>
      <div class="aia-title-text"><h2><span data-el="titleText">${esc(o.title)}</span><select class="aia-agent-pick" data-el="agentPick" aria-label="Agent" title="Switch agent (starts a new chat)" hidden></select></h2><p data-el="subtitle">…</p></div>
    </div>
    <div class="aia-head-actions">
      <button type="button" class="aia-icon-btn" data-act="library" aria-expanded="false" title="Saved chats" aria-label="Saved chats">${ICONS.history}</button>
      <button type="button" class="aia-icon-btn" data-act="new" title="New chat (the current one is saved)" aria-label="New chat">${ICONS.plus}</button>
      <button type="button" class="aia-icon-btn" data-act="settings" title="Settings" aria-label="Settings">${ICONS.gear}</button>
      <button type="button" class="aia-icon-btn" data-act="close" title="Close (Esc)" aria-label="Close">${ICONS.close}</button>
    </div>
  </header>
  <div class="aia-context" data-state="none">
    <span class="aia-context-dot" aria-hidden="true"></span>
    <span class="aia-context-text" data-el="ctxText" role="status" aria-live="polite"></span>
    <code class="aia-context-hash" data-el="ctxHash"></code>
    <button type="button" class="aia-mini-btn" data-act="reread" title="Send the page again with the next message" aria-label="Re-read the page">${ICONS.refresh}</button>
    <button type="button" class="aia-mini-btn" data-act="inspect" title="See exactly what the agent receives" aria-label="Inspect context">${ICONS.eye}</button>
  </div>
  <section class="aia-library" data-el="library" hidden aria-label="Saved chats">
    <div class="aia-library-head"><h3>Saved chats</h3><span data-el="libraryCount"></span></div>
    <div class="aia-library-list" data-el="libraryList"></div>
  </section>
  <div class="aia-messages" data-el="messages" aria-live="off"></div>
  <form class="aia-composer" data-el="form" autocomplete="off">
    <div class="aia-attach" data-el="attach" hidden></div>
    <div class="aia-plus" data-el="plusWrap"${this.attachOn ? '' : ' hidden'}>
      <button type="button" class="aia-btn aia-plus-btn" data-act="attach-menu" data-el="plus" aria-haspopup="menu" aria-expanded="false" aria-controls="${esc(this.ns.replace(/\W/g, '-'))}-attach-menu" title="Attach an image or a file" aria-label="Attach an image or a file">${ICONS.plus}</button>
      <div class="aia-attach-menu" role="menu" data-el="menu" id="${esc(this.ns.replace(/\W/g, '-'))}-attach-menu" aria-label="Attach" hidden>
        <button type="button" role="menuitem" class="aia-menu-item" data-act="attach-image" data-el="menuImage">${ICONS.image}<span><b>Attach an image</b><small data-el="menuImageNote">PNG, JPEG, GIF, WebP… The agent sees it like a screenshot.</small></span></button>
        <button type="button" role="menuitem" class="aia-menu-item" data-act="attach-file">${ICONS.doc}<span><b>Upload a file</b><small>PDF, Word, Excel, PowerPoint, text, CSV, code… The agent reads its text.</small></span></button>
      </div>
      <input type="file" accept="image/*" multiple hidden tabindex="-1" data-el="imageInput">
      <input type="file" multiple hidden tabindex="-1" data-el="fileInput">
    </div>
    <textarea data-el="input" rows="1" placeholder="${esc(o.placeholder)}" aria-label="Message the ${esc(o.title)}"></textarea>
    <button type="button" class="aia-btn aia-shot-btn" data-act="screenshot" data-el="shot" title="Attach a screenshot of what you are looking at" aria-label="Attach a screenshot" hidden>${ICONS.camera}</button>
    <button type="submit" class="aia-btn aia-btn-primary aia-send" data-el="send" title="Send (Enter)" aria-label="Send">${ICONS.send}</button>
  </form>
  <div class="aia-shot-view" data-el="shotView" hidden role="dialog" aria-label="Screenshot"><img alt="Screenshot"><button type="button" class="aia-btn aia-btn-sm" data-act="shot-close">Close</button></div>
  <div class="aia-file-view" data-el="fileView" hidden role="dialog" aria-label="Attached file">
    <div class="aia-file-view-card">
      <div class="aia-file-view-head"><div><h3 data-el="fileViewName"></h3><p data-el="fileViewMeta"></p></div><button type="button" class="aia-icon-btn" data-act="file-close" title="Close (Esc)" aria-label="Close">${ICONS.close}</button></div>
      <p class="aia-file-view-note" data-el="fileViewNote" hidden></p>
      <pre data-el="fileViewText" tabindex="0"></pre>
    </div>
  </div>
  <div class="aia-drop" data-el="drop" hidden aria-hidden="true"><div>${ICONS.paperclip}<p>Drop to attach</p><small>Images, and files: PDF, Word, Excel, PowerPoint, text, CSV, code…</small></div></div>
</aside>`);
    (resolveElement(o.mount) || document.body).appendChild(this.el);

    const q = (name) => this.el.querySelector(`[data-el="${name}"]`);
    this.$ = {
      subtitle: q('subtitle'), titleText: q('titleText'), agentPick: q('agentPick'),
      ctxText: q('ctxText'), ctxHash: q('ctxHash'), ctxBar: this.el.querySelector('.aia-context'),
      library: q('library'), libraryList: q('libraryList'), libraryCount: q('libraryCount'),
      messages: q('messages'), form: q('form'), input: q('input'), send: q('send'),
      attach: q('attach'), shot: q('shot'), shotView: q('shotView'),
      plusWrap: q('plusWrap'), plus: q('plus'), menu: q('menu'), menuImage: q('menuImage'), menuImageNote: q('menuImageNote'),
      imageInput: q('imageInput'), fileInput: q('fileInput'), drop: q('drop'),
      fileView: q('fileView'), fileViewName: q('fileViewName'), fileViewMeta: q('fileViewMeta'), fileViewNote: q('fileViewNote'), fileViewText: q('fileViewText'),
      libraryBtn: this.el.querySelector('[data-act="library"]'),
    };

    this.cleanups.push(attachResize(this.el.querySelector('.aia-resizer'), {
      variable: '--aia-drawer-width',
      value: o.width,
      min: 320,
      max: () => Math.max(320, Math.min(900, window.innerWidth - 160)),
      storage: this.o.storage,
      storageKey: `${this.ns}.width`,
    }));

    this.el.addEventListener('click', (e) => this.onClick(e));
    this.$.form.addEventListener('submit', (e) => { e.preventDefault(); this.submit(); });
    this.$.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.submit(); }
    });
    this.$.input.addEventListener('input', () => this.autoGrow());
    this.$.agentPick.addEventListener('change', () => {
      const name = this.$.agentPick.value;
      if (!this.useAgent(name)) this.$.agentPick.value = this.agent().name;
    });
    if (this.attachOn) this.bindAttachments();

    const onKey = (e) => this.onGlobalKey(e);
    document.addEventListener('keydown', onKey);
    this.cleanups.push(() => document.removeEventListener('keydown', onKey));
    // Keystrokes typed in the drawer must not reach host shortcut handlers (Space = play, letters, arrows…). The
    // runtime's own keys are handled here first, because the document listener above will not see them.
    if (o.isolateKeys !== false) {
      this.cleanups.push(isolateKeys(this.el, (e) => { if (e.type === 'keydown') this.onOwnKey(e); }));
    }

    const dlg = o.dialogs;
    if (dlg && dlg !== 'off') {
      this.dialogs = createDialogDock({
        selector: (typeof dlg === 'object' && dlg.selector) || 'dialog',
        isDrawerOpen: () => this.openState,
        onChange: () => this.o.onDialogChange?.(),
      });
      this.cleanups.push(() => this.dialogs.destroy());
    }
    if (o.devWarnings) {
      let timer = null;
      const onResize = () => { clearTimeout(timer); timer = setTimeout(() => this.checkLayout(), 500); };
      window.addEventListener('resize', onResize);
      this.cleanups.push(() => { clearTimeout(timer); window.removeEventListener('resize', onResize); });
    }

    this.bindToggles();
    this.agentName = this.readSession().agent || '';
    this.renderAgentPick();
    this.welcome();
    this.renderLibrary();
    this.refreshSubtitle();
    this.refreshVision();
    if (this.o.resume !== false) this.restoreSession();
  }

  /* ============================================== per-tab session (resume) */

  // Multi-page apps reload on every navigation: remember, per browser tab, which chat was active and whether the
  // drawer was open, so the conversation carries on across pages.

  readSession() {
    try { return JSON.parse(this.o.session.getItem(`${this.ns}.session`) || '{}') || {}; } catch { return {}; }
  }

  writeSession(patch) {
    if (this.o.resume === false) return;
    try { this.o.session.setItem(`${this.ns}.session`, JSON.stringify({ ...this.readSession(), ...patch })); } catch { /* ignore */ }
  }

  restoreSession() {
    const s = this.readSession();
    if (s.chat && this.readChats().some((c) => c.id === s.chat)) this.loadChat(s.chat, { focus: false });
    // This runs inside createAiAgent(), before the app could call agent.on('open'): createAiAgent replays the
    // 'open' event once the agent has been returned (see `resumedOpen`).
    if (s.open) { this.setOpen(true, { focus: false, emit: false }); this.resumedOpen = true; }
  }

  bindToggles() {
    this.toggles = resolveElements(this.o.toggle);
    if (!this.toggles.length && this.o.launcher !== false) {
      this.launcher = h(`<button type="button" class="aia-scope aia-launcher" title="${esc(this.o.title)} (Ctrl+I)" aria-label="Open ${esc(this.o.title)}">${ICONS.spark}<span class="aia-launcher-dot" aria-hidden="true"></span></button>`);
      document.body.appendChild(this.launcher);
      if (this.o.isolateKeys !== false) this.cleanups.push(isolateKeys(this.launcher));
      this.toggles = [this.launcher];
    }
    for (const t of this.toggles) {
      const onClick = (e) => { e.preventDefault(); this.toggle(); };
      t.addEventListener('click', onClick);
      t.setAttribute('aria-pressed', 'false');
      t.setAttribute('aria-controls', this.el.id);
      if (this.o.toggleBadge !== false) t.setAttribute('data-aia-toggle', '');
      this.cleanups.push(() => t.removeEventListener('click', onClick));
    }
  }

  /* ============================================================ open/close */

  isOpen() { return this.openState; }

  setOpen(next, { focus = true, emit = true } = {}) {
    if (next === this.openState) return;
    this.openState = next;
    if (!next && this.el.contains(document.activeElement)) document.activeElement.blur();
    // A modal <dialog> would make the drawer inert: dock it (opt-in) before the drawer takes focus.
    if (next && this.dialogs) this.dialogs.dock();
    else if (next && this.o.devWarnings && modalDialogOpen()) {
      this.warnOnce('modal', '[ai-agent] A modal <dialog> is open, so the drawer is inert behind it and cannot be used. Pass createAiAgent({ dialogs: \'dock\' }) to open such dialogs non-modally beside the drawer (references/frameworks.md, "Modal dialogs").');
    }
    this.el.classList.toggle('aia-open', next);
    this.el.setAttribute('aria-hidden', String(!next));
    this.el.inert = !next;
    document.documentElement.classList.toggle('aia-drawer-open', next);
    for (const t of this.toggles) t.setAttribute('aria-pressed', String(next));
    for (const target of resolveElements(this.o.push)) target.classList.toggle('aia-pushed', next);
    this.writeSession({ open: next });
    if (next) {
      this.refreshStatus();
      this.refreshSubtitle();
      // Focus the composer once the drawer is in view, unless the settings modal opened meanwhile.
      if (focus) setTimeout(() => { if (this.openState && !this.panel.isOpen()) this.$.input.focus(); }, 60);
      this.scrollToEnd(true);
      this.startWatch();
      if (this.o.devWarnings) { clearTimeout(this.layoutTimer); this.layoutTimer = setTimeout(() => this.checkLayout(), 450); }
    } else {
      this.stopWatch();
      clearTimeout(this.layoutTimer);
      if (this.dialogs) this.dialogs.undock();
    }
    if (emit) this.emit(next ? 'open' : 'close', {});
  }

  warnOnce(key, ...args) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(...args);
  }

  /** Dev-time (devWarnings): does the pushed layout fit beside the open drawer? */
  checkLayout() {
    if (!this.openState || !this.o.devWarnings) return;
    const targets = resolveElements(this.o.push);
    if (!targets.length) return;
    let problems;
    try { ({ problems } = checkPushLayout({ targets, drawer: this.el, toggles: this.toggles })); } catch { return; }
    if (!problems.length) return;
    const key = `layout:${window.innerWidth}:${problems.map((p) => p.text).join('|')}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[ai-agent] The page does not fit beside the open drawer at ${window.innerWidth}px wide:\n- ${problems.map((p) => p.text).join('\n- ')}\n\n${PUSH_HELP}`, ...problems.map((p) => p.element));
  }

  open() { this.setOpen(true); }
  close() { this.setOpen(false); }
  toggle() { this.setOpen(!this.openState); }

  startWatch() {
    this.stopWatch();
    const ms = Number(this.o.watch);
    if (ms > 0) this.watchTimer = setInterval(() => this.refreshStatus(), Math.max(250, ms));
  }

  stopWatch() { clearInterval(this.watchTimer); this.watchTimer = null; }

  onGlobalKey(e) {
    if (this.hotkeyMatches(e)) { e.preventDefault(); this.toggle(); return; }
    if (e.key === 'Escape' && this.openState && !this.panel.isOpen() && this.el.contains(document.activeElement)) {
      e.preventDefault();
      this.escape();
    }
  }

  /** Escape inside the drawer closes the innermost thing: the attach menu, a viewer, the reply, then the drawer. */
  escape() {
    if (!this.$.menu.hidden) this.closeMenu(true);
    else if (!this.$.fileView.hidden) this.closeFile();
    else if (!this.$.shotView.hidden) this.closeShot();
    else if (this.streaming) this.stop();
    else this.close();
  }

  /** Keys pressed inside the drawer (key isolation on): the hotkey and Escape, handled before propagation stops. */
  onOwnKey(e) {
    if (this.hotkeyMatches(e)) { e.preventDefault(); e.stopPropagation(); this.toggle(); return; }
    if (e.key === 'Escape' && this.openState && !this.panel.isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      this.escape();
    }
  }

  hotkeyMatches(e) {
    const hk = this.o.hotkey;
    if (!hk) return false;
    const parts = String(hk).toLowerCase().split('+');
    const key = parts.pop();
    const wantMod = parts.includes('mod') || parts.includes('ctrl') || parts.includes('meta');
    const mod = e.ctrlKey || e.metaKey;
    return e.key.toLowerCase() === key && mod === wantMod && e.shiftKey === parts.includes('shift') && e.altKey === parts.includes('alt');
  }

  /* ============================================================== clicks */

  onClick(e) {
    const t = e.target;
    const a = t.closest('[data-act]')?.dataset.act;
    if (a === 'close') return this.close();
    if (a === 'new') return this.newChat();
    if (a === 'settings') return this.panel.open('model');
    if (a === 'inspect') return this.panel.open('context');
    if (a === 'library') return this.setLibraryOpen(this.$.library.hidden);
    if (a === 'reread') { this.forceReread = true; this.refreshStatus(); return; }
    if (a === 'open-settings') return this.panel.open('model');
    if (a === 'memory') return this.panel.open('memory');
    if (a === 'screenshot') return this.attachScreenshot();
    if (a === 'shot-close' || t.closest('.aia-shot-view')) return this.closeShot();
    if (a === 'attach-menu') return this.$.menu.hidden ? this.openMenu() : this.closeMenu(true);
    if (a === 'attach-image') { this.closeMenu(); this.$.imageInput.click(); return undefined; }
    if (a === 'attach-file') { this.closeMenu(); this.$.fileInput.click(); return undefined; }
    if (a === 'file-close' || (t.classList?.contains('aia-file-view'))) return this.closeFile();

    const shotRemove = t.closest('[data-shot-remove]');
    if (shotRemove) { this.pending = this.pending.filter((s) => s.id !== shotRemove.dataset.shotRemove); this.renderPending(); return undefined; }
    const fileRemove = t.closest('[data-file-remove]');
    if (fileRemove) { this.pendingFiles = this.pendingFiles.filter((f) => f.id !== fileRemove.dataset.fileRemove); this.renderPending(); return undefined; }
    const fileOpen = t.closest('[data-aia-file]');
    if (fileOpen) return this.openFile(fileOpen.dataset.aiaFile);
    const shot = t.closest('[data-aia-shot]');
    if (shot) return this.openShot(shot.dataset.aiaShot, shot.getAttribute('src'));
    const undo = t.closest('[data-aia-undo]');
    if (undo) return this.runUndo(undo);

    const suggestion = t.closest('[data-aia-suggest]');
    if (suggestion) return this.ask(suggestion.dataset.aiaSuggest);

    const chatOpen = t.closest('[data-chat-open]');
    if (chatOpen) return this.loadChat(chatOpen.dataset.chatOpen);
    const chatDelete = t.closest('[data-chat-delete]');
    if (chatDelete) return this.armDelete(chatDelete);

    const codeBtn = t.closest('[data-aia-code-action]');
    if (codeBtn) return this.runCodeAction(codeBtn);
    const toolCopy = t.closest('[data-aia-tool-copy]');
    if (toolCopy) { this.copyToolRows([toolCopy.closest('.aia-tool')], toolCopy); return undefined; }
    const toolToggle = t.closest('[data-aia-tool-toggle]');
    if (toolToggle) return this.toggleToolDetail(toolToggle);
    const replyBtn = t.closest('[data-aia-reply-action]');
    if (replyBtn) return this.runReplyAction(replyBtn);
    return undefined;
  }

  replyFor(el) {
    const wrap = el.closest('.aia-msg');
    return wrap ? this.replies.get(wrap) : null;
  }

  runCodeAction(btn) {
    const reply = this.replyFor(btn);
    const block = reply?.code?.[Number(btn.dataset.aiaCode)];
    if (!block) return;
    const id = btn.dataset.aiaCodeAction;
    if (id === 'copy') { copyText(block.code); flash(btn); return; }
    const action = (this.o.codeActions || []).find((x) => x.id === id);
    if (!action) return;
    try {
      const r = action.run(block, this.api);
      if (r !== false) flash(btn, action.doneLabel || 'Done');
    } catch (err) {
      this.addNotice(`"${action.label}" failed: ${err?.message || err}`, true);
    }
  }

  runReplyAction(btn) {
    const id = btn.dataset.aiaReplyAction;
    if (id === 'copy-tools') { this.copyToolRows([...btn.closest('.aia-msg').querySelectorAll('.aia-tool-log > .aia-tool')], btn); return; }
    const reply = this.replyFor(btn);
    if (!reply || !reply.markdown) return;
    if (id === 'copy') { copyText(reply.markdown); flash(btn); return; }
    const action = (this.o.replyActions || []).find((x) => x.id === id);
    if (!action) return;
    try {
      const r = action.run(reply.markdown, this.api);
      if (r !== false) flash(btn, action.doneLabel || 'Done');
    } catch (err) {
      this.addNotice(`"${action.label}" failed: ${err?.message || err}`, true);
    }
  }

  /* =========================================================== messages */

  nearBottom() {
    const m = this.$.messages;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }

  scrollToEnd(force = false) {
    const m = this.$.messages;
    if (force || this.stick) m.scrollTop = m.scrollHeight;
  }

  addWrap(role) {
    const wrap = h(`<div class="aia-msg aia-${role}"><div class="aia-bubble"></div></div>`);
    this.$.messages.appendChild(wrap);
    return wrap;
  }

  /** The welcome message and suggestion chips: the active agent's when it has its own, else the application's. */
  welcome() {
    const o = this.o;
    const agent = this.agent();
    const wrap = this.addWrap('assistant');
    wrap.classList.add('aia-welcome');
    const md = renderMarkdown(agent.welcome || o.welcome || '');
    const suggestions = agent.suggestions?.length ? agent.suggestions : (o.suggestions || []);
    const chips = suggestions.map((s) => `<button type="button" class="aia-chip" data-aia-suggest="${esc(s)}">${esc(s)}</button>`).join('');
    wrap.querySelector('.aia-bubble').innerHTML = `<div class="aia-md">${md.html}</div>${chips ? `<div class="aia-chips">${chips}</div>` : ''}`;
  }

  /* ============================================================== agents */

  /** The agents the user can pick from (the application's implicit agent when it defines none). */
  agents() {
    return this.o.caps?.agents() || [implicitAgent(this.o.title)];
  }

  /** The active agent. */
  agent() {
    const list = this.agents();
    return list.find((a) => a.name === this.agentName) || pickAgent(list, this.o.caps?.defaultAgent() || '') || implicitAgent(this.o.title);
  }

  /** The permission rules in force: the application's, plus the active agent's. */
  policy() {
    return mergePolicies(this.o.caps?.policy(), this.agent().permissions);
  }

  /** The application's tools the active agent may use: its tools and toolsets (all when it names none), not denied. */
  agentTools() {
    const all = this.o.toolRegistry?.all() || [];
    const agent = this.agent();
    const { names } = agentToolNames(agent, { tools: all.map((t) => t.name), toolsets: this.o.caps?.toolsets() || new Map() });
    const policy = this.policy();
    return all.filter((t) => (!names || names.has(t.name)) && decidePermission(t, policy) !== 'deny');
  }

  agentHasTool(name) { return this.agentTools().some((t) => t.name === name); }

  /** The skills the active agent may use: its own list (all when it names none), plus built-in ones in use (workspace). */
  skillsForAgent() {
    const all = this.o.caps?.skills() || [];
    const app = all.filter((s) => s.source !== 'builtin');
    const { names } = agentSkillNames(this.agent(), app.map((s) => s.name));
    return all.filter((s) => s.source === 'builtin' || !names || names.has(s.name));
  }

  /** 'on' | 'read' | 'off': what the active agent may do with memory. */
  memoryMode() {
    return this.memory ? this.agent().memory || 'on' : 'off';
  }

  /** Is screen content shared with the active agent (the user's switch and the agent's context layers)? */
  shareOn(settings) {
    return !!settings.shareScreen && this.agent().context?.screen !== false;
  }

  /** The context texts the active agent receives: { appText, pageText, viewText, share }. */
  async contextTexts(settings) {
    const c = this.agent().context || {};
    const share = this.shareOn(settings);
    const [appText, pageText, viewText] = await Promise.all([
      c.app === false ? '' : this.ctx.appText(),
      c.page === false ? '' : this.ctx.pageText(),
      share && c.view !== false ? this.ctx.viewText() : '',
    ]);
    return { appText, pageText, viewText, share };
  }

  /** What every request of a question shares: the editable prompt, the agent, the context, attached files. */
  async baseSystemFor(settings, texts = null) {
    const { appText, pageText, share } = texts || await this.contextTexts(settings);
    return {
      base: this.effectivePrompt(settings), agentText: buildAgentPrompt(this.agent()), appText, pageText, share,
      files: hasFiles(this.conv.messages, settings.historyMessages),
    };
  }

  /** The whole system prompt for the next request (tools, memory and skills as they stand now). */
  systemFor(settings, baseSystem) {
    const mode = this.toolMode(settings);
    return buildSystemPrompt({
      ...baseSystem,
      toolsText: this.toolPrompt(settings),
      memoryText: this.memoryPrompt(settings),
      skillsText: this.skillsPrompt(mode !== 'off'),
      vision: this.seesImages(settings),
      screenshots: this.visionOn(settings),
    });
  }

  /** The SKILLS section: the active agent's skills, and the instructions of those active in this conversation. */
  skillsPrompt(canLoad = true) {
    return buildSkillsPrompt({ skills: this.skillsForAgent(), active: this.conv.skills, canLoad });
  }

  /** The header: a picker in place of the title when there is more than one agent. */
  renderAgentPick() {
    const list = this.agents();
    const multi = list.length > 1;
    const agent = this.agent();
    this.$.agentPick.hidden = !multi;
    this.$.titleText.hidden = multi;
    if (multi) {
      this.$.agentPick.innerHTML = list.map((a) => `<option value="${esc(a.name)}" title="${esc(a.description)}"${a.name === agent.name ? ' selected' : ''}>${esc(a.title)}</option>`).join('');
      this.$.agentPick.title = `${agent.description} (switching agent starts a new chat)`;
    }
    this.el.dataset.aiaAgent = agent.implicit ? '' : agent.name;
  }

  /** The capabilities changed (loaded, reloaded): keep the agent if it still exists, refresh what shows it. */
  refreshAgents() {
    const before = this.agentName;
    const agent = this.agent();
    this.agentName = agent.implicit ? '' : agent.name;
    if (this.agentName !== before && before) this.writeSession({ agent: this.agentName });
    this.renderAgentPick();
    if (!this.conv.messages.length && !this.streaming) { this.resetMessages(); this.welcome(); }
    this.panel.refreshTools?.();
  }

  /** Switch to another agent. A conversation in progress is saved and a new one starts. */
  useAgent(name) {
    const target = this.agents().find((a) => a.name === name);
    if (!target || this.streaming) return false;
    if (target.name === this.agent().name) return true;
    this.persist();                      // the conversation so far is saved with the agent it was with
    this.agentName = target.implicit ? '' : target.name;
    this.writeSession({ agent: this.agentName });
    this.newChat({ save: false });
    this.renderAgentPick();
    this.refreshStatus();
    this.panel.refreshTools?.();
    this.emit('agent', { name: target.name, title: target.title });
    return true;
  }

  /** What Settings shows about agents and skills. */
  capabilityInfo() {
    const agent = this.agent();
    return {
      agents: this.agents().filter((a) => !a.implicit).map((a) => ({ name: a.name, title: a.title, description: a.description, model: a.model })),
      agent: agent.implicit ? '' : agent.name,
      skills: this.skillsForAgent().map((s) => ({ name: s.name, description: s.description, source: s.source, active: this.conv.skills.includes(s.name) })),
      workspace: this.o.caps?.workspace()?.info || null,
    };
  }

  /* ============================================================== skills */

  /** Make a skill active in this conversation: its instructions join the system prompt from the next request on. */
  activateSkill(name, { via = 'tool' } = {}) {
    const skill = this.skillsForAgent().find((s) => s.name === name);
    if (!skill) return null;
    if (!this.conv.skills.includes(name)) this.conv.skills = [...this.conv.skills, name];
    this.emit('skill', { name, via });
    return skill;
  }

  /** How a tool a skill names stands for the active agent: 'on' | 'off' | 'denied' | 'missing'. */
  toolStateFor(name) {
    const tool = this.o.toolRegistry?.get(name);
    if (!tool) return this.builtins(this.store.get()).some((b) => b.name === name) ? 'on' : 'missing';
    if (!this.agentHasTool(name)) return 'denied';
    return toolEnabled(tool, this.store.get()) ? 'on' : 'off';
  }

  addNotice(text, isError = false) {
    const wrap = this.addWrap('assistant');
    if (isError) wrap.classList.add('aia-error');
    wrap.querySelector('.aia-bubble').innerHTML = `<p>${esc(text)}</p>`;
    this.scrollToEnd(true);
    return wrap;
  }

  syncChip(m) {
    const s = m.snapshot;
    if (m.sync === 'attached' && s) {
      const kept = typeof s.text === 'string';
      return `<span class="aia-sync aia-sync-read" title="The page content was attached to this message${kept ? '' : ' (not kept in saved chats)'}">${ICONS.doc}Read the page · ${esc(s.pageTitle || s.pageId)} · ${nf(s.totalChars ?? s.chars)} chars${s.truncated ? ' (cut)' : ''} · <code>${esc(shortHash(s.hash))}</code></span>`;
    }
    if (m.sync === 'unchanged') {
      return `<span class="aia-sync aia-sync-same" title="The screen matched what the agent already had, so the page was not sent again">${ICONS.check}Page unchanged · <code>${esc(shortHash(m.snapshotRef))}</code></span>`;
    }
    if (m.sync === 'off') return '<span class="aia-sync" title="Screen sharing is switched off in Settings">Screen not shared</span>';
    return '';
  }

  renderUser(m) {
    const wrap = this.addWrap('user');
    wrap.querySelector('.aia-bubble').textContent = m.content;
    if (Array.isArray(m.files) && m.files.length) {
      for (const f of m.files) if (f?.id) this.fileRecords.set(f.id, f);
      wrap.appendChild(h(`<div class="aia-files">${m.files.filter((f) => f?.id).map((f) => this.fileChip(f, { button: true })).join('')}</div>`));
    }
    if (Array.isArray(m.shots) && m.shots.length) wrap.appendChild(h(`<div class="aia-shots">${m.shots.map((s) => this.shotImg(s, s.name ? `Image you attached: ${s.name}` : 'Screenshot you attached')).join('')}</div>`));
    const chip = this.syncChip(m);
    const skill = m.skill ? `<span class="aia-sync aia-sync-skill" title="This message activated the skill for the rest of the conversation">${ICONS.spark}Skill · ${esc(m.skill)}</span>` : '';
    if (chip || skill) wrap.appendChild(h(`<div class="aia-msg-meta">${skill}${chip}</div>`));
    this.scrollToEnd(true);
    return wrap;
  }

  /** Assistant message scaffold: notice line, collapsible reasoning, text, actions. */
  addAssistantView() {
    const wrap = this.addWrap('assistant');
    const actions = [{ id: 'copy', label: 'Copy' }, { id: 'copy-tools', label: 'Copy tool log', title: 'Every tool call of this reply: arguments, errors and results', hidden: true }, ...(this.o.replyActions || [])]
      .map((a) => `<button type="button" class="aia-msg-action" data-aia-reply-action="${esc(a.id)}"${a.title ? ` title="${esc(a.title)}"` : ''}${a.hidden ? ' hidden' : ''}>${esc(a.label)}</button>`).join('');
    wrap.querySelector('.aia-bubble').innerHTML = `
      <p class="aia-notice" hidden></p>
      <details class="aia-reasoning" hidden><summary>Thinking…</summary><div class="aia-reasoning-text"></div></details>
      <div class="aia-tool-log" hidden></div>
      <div class="aia-md"></div>
      <div class="aia-msg-actions" hidden>${actions}</div>
      <div class="aia-msg-foot" hidden></div>`;
    const view = {
      wrap,
      notice: wrap.querySelector('.aia-notice'),
      reasoning: wrap.querySelector('.aia-reasoning'),
      reasoningText: wrap.querySelector('.aia-reasoning-text'),
      summary: wrap.querySelector('.aia-reasoning summary'),
      text: wrap.querySelector('.aia-md'),
      toolLog: wrap.querySelector('.aia-tool-log'),
      actions: wrap.querySelector('.aia-msg-actions'),
      foot: wrap.querySelector('.aia-msg-foot'),
      raw: '',
      native: '',
      answer: '',
      done: false,
    };
    const record = { markdown: '', code: [] };
    this.replies.set(wrap, record);
    view.record = record;
    view.paint = frameThrottle(() => this.paint(view));
    return view;
  }

  paint(view) {
    const split = splitReasoning(view.raw);
    const reasoning = [view.native, split.reasoning].filter(Boolean).join('\n\n');
    const showReasoning = this.store.get().reasoning !== 'hide';
    if (reasoning && showReasoning) {
      view.reasoning.hidden = false;
      view.reasoningText.textContent = reasoning.length > REASONING_TAIL ? `…${reasoning.slice(-REASONING_TAIL)}` : reasoning;
      const thinking = !view.done && (!split.text || split.thinking);
      view.summary.textContent = thinking ? `Thinking… (${nf(reasoning.length)} chars)` : `Thought process (${nf(reasoning.length)} chars)`;
    }
    view.answer = split.text;
    if (split.text) {
      const rendered = renderMarkdown(split.text, { codeActions: this.o.codeActions });
      view.text.innerHTML = rendered.html;
      view.record.markdown = split.text;
      view.record.code = rendered.code;
      view.actions.hidden = !view.done;
    } else if (!view.done) {
      view.text.innerHTML = `<p class="aia-stream-status">${esc(reasoning ? 'Thinking…' : view.status || 'Waiting for the model…')}</p>`;
    }
    this.scrollToEnd();
  }

  /** Render a saved assistant reply (no reasoning, no streaming). */
  addSavedReply(m) {
    const view = this.addAssistantView();
    view.raw = m.content;
    view.done = true;
    for (const a of Array.isArray(m.actions) ? m.actions : []) {
      const chip = this.addChip(view, a.title || a.call, a.call);
      this.setChip(chip, a.status, a.summary || '');
      if (a.thumb) this.addChipShot(chip, { id: a.shot || '', thumb: a.thumb });
      if (a.detail) this.setToolDetail(chip, { name: a.name || a.call, title: a.title || '', status: a.status, detail: a.detail });
    }
    this.paint(view);
    view.actions.hidden = false;
    if (m.meta) { view.foot.hidden = false; view.foot.textContent = m.meta; }
    return view;
  }

  /* =============================================================== tools */

  /** 'off' (no tools registered), 'native' tool calls, or 'text' tool blocks. */
  toolMode(settings) {
    if (!this.agentTools().length && !this.builtins(settings).length) return 'off';
    if (settings.toolMode === 'native' || settings.toolMode === 'text') return settings.toolMode;
    return this.textTools.has(this.modelKey(settings)) ? 'text' : 'native';
  }

  modelKey(settings) {
    return `${settings.transport}|${settings.provider}|${settings.profiles?.[settings.provider]?.model || ''}`;
  }

  /** The TOOLS section of the system prompt, as it would be sent now. */
  toolPrompt(settings = this.store.get()) {
    const mode = this.toolMode(settings);
    if (mode === 'off') return '';
    const set = this.toolSet(settings);
    return buildToolPrompt({ classes: set.classes, mode, enabled: set.active, appOff: set.appOff });
  }

  /**
   * The tools of one request: the application's that the active agent may use (when Settings > Tools has them
   * switched on) plus the built-in ones (memory, screenshots, skills, workspace), which follow their own settings.
   * `active` is false when nothing can be called or asked for.
   */
  toolSet(settings) {
    const app = this.agentTools();
    const builtins = this.builtins(settings).filter((b) => !app.some((t) => t.name === b.name));
    if (!builtins.length) return { classes: classifyTools(app, settings, this.ctx.page?.id), active: !!settings.toolsEnabled, appOff: false };
    const classes = settings.toolsEnabled ? classifyTools(app, settings, this.ctx.page?.id) : { callable: [], off: [], elsewhere: [] };
    for (const b of builtins) {
      if (toolEnabled(b, settings)) classes.callable.push(b);
      else if (b.offerWhenOff) classes.off.push(b);
    }
    return { classes, active: true, appOff: !settings.toolsEnabled && app.length > 0 };
  }

  /** A tool the active agent may use, by name (app tools it may see, then built-ins), or null. */
  findTool(name, settings = this.store.get()) {
    return this.agentTools().find((t) => t.name === name) || this.builtins(settings).find((b) => b.name === name) || null;
  }

  /** Why a tool by this name is not usable here ('' when there is no such tool at all). */
  hiddenReason(name) {
    const tool = this.o.toolRegistry?.get(name) || this.builtinTools.find((b) => b.name === name);
    if (!tool) return '';
    if (decidePermission(tool, this.policy()) === 'deny') return `${name} is not permitted in this application${this.agent().implicit ? '' : ` for the ${this.agent().title} agent`}. Do not call it; tell the user if it matters.`;
    if (!tool.builtin) return `${name} is not one of the ${this.agent().title} agent's tools. Use the tools you were given.`;
    return '';
  }

  /* ------------------------------------------------ built-in tools: memory */

  /** The built-in tools that exist with these settings and are not denied (whether the model may call them: toolEnabled()). */
  builtins(settings) {
    const policy = this.policy();
    return this.builtinTools.filter((b) => b.exists(settings) && decidePermission(b, policy) !== 'deny');
  }

  makeBuiltins() {
    const list = [];
    const mem = this.memory;
    const define = (def, extra) => list.push({ ...normalizeTool({ ...def, enabled: true }), ...extra });
    if (mem) {
      const writable = (s) => !!(s.memoryEnabled && s.memoryWrite) && this.memoryMode() === 'on';
      define({
        name: 'remember',
        title: 'Remember',
        description: 'Save a note to your long-term memory so that you still know it in future conversations. Use it when the user asks you to remember, note or keep something.',
        parameters: {
          text: { type: 'string', required: true, maxLength: mem.limits.chars, description: 'One short, self-contained sentence: what to remember and when it applies.' },
          id: { type: 'string', description: 'Only to correct an existing memory: its id (for example m3).' },
        },
        effect: 'read',
        run: ({ text, id }) => {
          if (id) {
            const prev = mem.get(id);
            if (!prev) return { status: 'error', content: `There is no memory with the id "${id}". Call remember without an id to add a new one.` };
            const m = mem.update(id, text);
            return { content: `Updated memory ${m.id}.`, summary: m.text, undo: () => mem.update(id, prev.text), label: 'Updated' };
          }
          const count = mem.list().length;
          const m = mem.add(text, { source: 'agent' });
          const added = mem.list().length > count;
          return { content: added ? `Saved as memory ${m.id}.` : `That is already saved (memory ${m.id}).`, summary: m.text, undo: added ? () => mem.remove(m.id) : null, label: added ? 'Saved' : 'Already saved' };
        },
      }, { builtin: 'memory', exists: writable, enabledIn: writable, offerWhenOff: false });
      define({
        name: 'forget',
        title: 'Forget',
        description: 'Delete one note from your long-term memory. Use it when the user asks you to forget something you saved.',
        parameters: { id: { type: 'string', required: true, description: 'The id of the memory to delete (for example m3).' } },
        effect: 'write',
        run: ({ id }) => {
          const m = mem.remove(id);
          if (!m) return { status: 'error', content: `There is no memory with the id "${id}".` };
          return { content: `Deleted memory ${id}.`, summary: m.text, undo: () => mem.replaceAll([...mem.list(), m]), label: 'Deleted' };
        },
      }, {
        builtin: 'memory', exists: writable, enabledIn: writable, offerWhenOff: false,
        confirmHtml: ({ id }) => { const m = mem.get(id); return m ? `Delete the saved memory <q>${esc(m.text)}</q>?` : ''; },
      });
    }
    if (this.capture) {
      define({
        name: 'take_screenshot',
        title: 'Take screenshot',
        description: 'Look at the user\'s screen: takes a screenshot of what they are looking at right now and shows it to you. Use it when the page snapshot text is not enough: layout, colours, charts, images, canvas or 3D views, visual problems.',
        parameters: {},
        effect: 'read',
        run: (args, { chip, signal }) => this.agentScreenshot(chip, signal, { allowed: true }),
      }, {
        builtin: 'vision',
        exists: (s) => !!s.vision && this.capture.method() !== 'none',
        enabledIn: (s) => !!s.screenshotAuto,
        offerWhenOff: true,
        setEnabled: (on) => this.store.save({ screenshotAuto: !!on }),
      });
    }
    this.defineSkillTools(define);
    this.defineWorkspaceTools(define);
    return list;
  }

  /** use_skill and read_skill_file: there while the active agent has skills. */
  defineSkillTools(define) {
    const hasSkills = () => this.skillsForAgent().length > 0;
    const always = { exists: hasSkills, enabledIn: hasSkills, offerWhenOff: false, offMessage: 'This agent has no skills.' };
    const named = (name) => this.skillsForAgent().find((s) => s.name === String(name || '').trim());
    const list = () => this.skillsForAgent().map((s) => s.name).join(', ') || 'none';
    define({
      name: 'use_skill',
      title: 'Use skill',
      description: 'Load a skill: the instructions for a kind of work, listed under SKILLS. Call it before doing work a skill describes; the skill then stays active for this conversation.',
      parameters: { name: { type: 'string', required: true, maxLength: 64, description: 'The skill\'s name, as listed under SKILLS.' } },
      effect: 'read',
      run: ({ name }) => {
        const skill = named(name);
        if (!skill) return { status: 'error', content: `There is no skill named "${name}". The skills you can use: ${list()}.` };
        const already = this.conv.skills.includes(skill.name);
        this.activateSkill(skill.name, { via: 'tool' });
        return { content: skillLoadedMessage(skill, (t) => this.toolStateFor(t)), summary: skill.description, label: already ? 'Already active' : 'Loaded' };
      },
    }, { builtin: 'skills', ...always });
    define({
      name: 'read_skill_file',
      title: 'Read skill file',
      description: 'Read a file that a skill\'s instructions point to (a path relative to the skill\'s folder, such as references/guide.md).',
      parameters: {
        skill: { type: 'string', required: true, maxLength: 64, description: 'The skill\'s name.' },
        path: { type: 'string', required: true, maxLength: 300, description: 'The file, relative to the skill\'s folder.' },
        offset: { type: 'integer', min: 0, description: 'Start at this character, to read a long file in parts (default 0).' },
      },
      effect: 'read',
      run: async ({ skill, path, offset = 0 }) => {
        const s = named(skill);
        if (!s) return { status: 'error', content: `There is no skill named "${skill}". The skills you can use: ${list()}.` };
        if (!s.base) return { status: 'error', content: `The skill "${s.name}" has no folder, so it has no files to read.` };
        let rel;
        try { rel = skillFilePath(path); } catch (e) { return { status: 'error', content: e.message }; }
        const url = new URL(rel, s.base).href;
        if (!url.startsWith(s.base)) return { status: 'error', content: `"${rel}" is outside the skill's folder.` };
        let text;
        try { text = await (this.o.caps?.fetchText || ((u) => fetch(u).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))))(url); } catch (e) {
          return { status: 'error', content: `${rel} could not be read (${e?.message || e}). Check the path against the skill's instructions.` };
        }
        const start = Math.min(Math.max(0, offset), text.length);
        const end = Math.min(text.length, start + SKILL_FILE_MAX);
        const more = end < text.length ? `\n\n[${nf(text.length - end)} more characters: call again with offset ${end}.]` : '';
        return { content: `${s.name}/${rel} (${nf(text.length)} characters${start || more ? `, showing ${nf(start)}–${nf(end)}` : ''}):\n\n${text.slice(start, end)}${more}`, summary: `${s.name}/${rel}` };
      },
    }, { builtin: 'skills', ...always });
  }

  /**
   * The development workspace (scripts/workspace.mjs): read the application's source, write in its capability
   * folder, reload the capabilities. There only while that server answers; every write is confirmed (effect system).
   */
  defineWorkspaceTools(define) {
    const ws = () => this.o.caps?.workspace() || null;
    const connected = () => !!ws();
    const always = { exists: connected, enabledIn: connected, offerWhenOff: false, offMessage: 'The workspace is not connected.' };
    const fail = (e) => ({ status: 'error', content: `Error: ${e?.message || e}` });
    define({
      name: 'list_source_files',
      title: 'List source files',
      description: 'List a folder of the application\'s source code (development workspace). Start with "" for the application folder.',
      parameters: { path: { type: 'string', maxLength: 300, description: 'A folder relative to the application folder ("" = the top).' } },
      effect: 'read',
      run: async ({ path = '' }) => {
        try {
          const r = await ws().client.list(path);
          const lines = r.entries.map((e) => (e.type === 'dir' ? `${e.name}/` : `${e.name}${Number.isFinite(e.size) ? ` (${nf(e.size)} bytes)` : ''}`));
          return { content: `${r.path || '.'}:\n${lines.join('\n') || '(empty)'}${r.truncated ? '\n[more entries not shown]' : ''}`, summary: `${r.path || '.'} · ${r.entries.length} entries` };
        } catch (e) { return fail(e); }
      },
    }, { builtin: 'workspace', ...always });
    define({
      name: 'read_source_file',
      title: 'Read source file',
      description: 'Read a file of the application\'s source code (development workspace), to see how a function works before wrapping it in a tool.',
      parameters: {
        path: { type: 'string', required: true, maxLength: 300, description: 'The file, relative to the application folder.' },
        offset: { type: 'integer', min: 0, description: 'Start at this character, to read a long file in parts (default 0).' },
      },
      effect: 'read',
      run: async ({ path, offset = 0 }) => {
        try {
          const r = await ws().client.read(path, offset);
          const more = r.truncated ? `\n\n[More: call again with offset ${r.end}.]` : '';
          return { content: `${r.path} (${nf(r.size)} characters${r.offset || r.truncated ? `, showing ${nf(r.offset)}–${nf(r.end)}` : ''}):\n\n${r.text}${more}`, summary: r.path };
        } catch (e) { return fail(e); }
      },
    }, { builtin: 'workspace', ...always });
    define({
      name: 'search_source',
      title: 'Search source',
      description: 'Find where a word or name appears in the application\'s source code (development workspace): file, line and the line\'s text.',
      parameters: {
        query: { type: 'string', required: true, maxLength: 200, description: 'The text to look for (plain text, not a pattern).' },
        path: { type: 'string', maxLength: 300, description: 'Only inside this folder (default: everywhere).' },
      },
      effect: 'read',
      run: async ({ query, path = '' }) => {
        try {
          const r = await ws().client.search(query, path);
          const lines = r.matches.map((m) => `${m.path}:${m.line}: ${m.text}`);
          return { content: lines.length ? `${lines.join('\n')}${r.truncated ? '\n[more matches not shown: narrow the search]' : ''}` : `"${query}" does not appear in the source.`, summary: `${r.matches.length} match${r.matches.length === 1 ? '' : 'es'}` };
        } catch (e) { return fail(e); }
      },
    }, { builtin: 'workspace', ...always });
    define({
      name: 'describe_host',
      title: 'Describe host',
      description: 'What `host` — the object tools receive as run(args, { host }) — offers: its functions with their parameters, and its other properties. Call it before writing a tool, and use only what it lists.',
      parameters: {},
      effect: 'read',
      run: () => ({ content: describeHost(this.o.host), summary: 'host described' }),
    }, { builtin: 'workspace', ...always });
    define({
      name: 'write_ai_file',
      title: 'Write capability file',
      description: 'Create a file in the application\'s capability folder (a new tool module, a skill, an agent), or replace one whole with replace: true (the capability index, the tool config — read it first and keep every entry). A new tool always goes in a new file. The user sees the file (or the changes) and confirms. Then call reload_capabilities.',
      parameters: {
        path: { type: 'string', required: true, maxLength: 300, description: 'The file, relative to the application folder; it must be inside the capability folder.' },
        content: { type: 'string', required: true, maxLength: 100000, description: 'The complete new content of the file.' },
        replace: { type: 'boolean', description: 'true to replace an existing file whole (read it first); omitted = create a new file (refused if it exists).' },
      },
      effect: 'system',
      run: async ({ path, content, replace = false }) => {
        try {
          const r = await ws().client.write(path, content, { replace });
          return { content: `${r.created ? 'Created' : 'Replaced'} ${r.path} (${nf(r.bytes)} bytes). Call reload_capabilities to load the change, then check it.`, summary: `${r.created ? 'Created' : 'Replaced'} ${r.path}` };
        } catch (e) { return fail(e); }
      },
    }, {
      builtin: 'workspace', ...always,
      // Creating a file that exists is refused before the user is asked (the server would refuse it too).
      precheck: async ({ path, content, replace = false }) => {
        // A tool module the runtime could not load is refused with what to write instead (cheaper than a reload).
        if (/(^|\/)tools\/[^/]+\.m?js$/.test(path)) {
          if (!/export\s+default\b/.test(content)) return 'a tool module must export the tool as its default: export default { name, title, description, effect, parameters, run: (args, { host }) => … } (the format in the create-tool skill).';
          if (/\brun\s*(?::\s*(?:async\s*)?(?:function\s*)?)?\(\s*[\w$]*\s*,\s*host\s*\)/.test(content)) return 'run\'s second argument is an object: write run: (args, { host }) => …, not run(args, host).';
        }
        if (replace) return '';
        try { await ws().client.read(path); } catch { return ''; }
        return `${path} already exists. A new tool goes in a new file (tools/<tool name>.js). To change this file, read it, then write it whole with replace: true.`;
      },
      // A new file is shown whole; a replacement as what it removes and adds, so a dropped tool cannot slip by.
      confirmHtml: async ({ path, content, replace = false }) => {
        const head = `<b>This changes the application's code</b>; it runs in this page once it is loaded.`;
        const whole = (text) => `<pre class="aia-tool-file">${esc(text.slice(0, 20000))}${text.length > 20000 ? `\n… (${nf(text.length - 20000)} more characters)` : ''}</pre>`;
        let before = null;
        if (replace) { try { before = (await ws().client.read(path)).text; } catch { before = null; } }
        if (before === null) return `${replace ? 'Write' : 'Create'} <code>${esc(path)}</code> in the application's capability folder? ${head}${whole(String(content))}`;
        const { hunks, removed, added } = diffHunks(lineDiff(before, String(content)));
        if (!removed && !added) return `Write <code>${esc(path)}</code> again, unchanged?${whole(String(content))}`;
        const body = hunks.map((h) => h.map((d) => `<span class="aia-diff-line aia-diff-${{ ' ': 'same', '-': 'del', '+': 'add' }[d.op]}">${d.op} ${esc(d.line)}</span>`).join('')).join('<span class="aia-diff-gap">⋯</span>');
        return `Replace <code>${esc(path)}</code> in the application's capability folder? ${head} <span class="aia-diff-count">${nf(removed)} line${removed === 1 ? '' : 's'} removed, ${nf(added)} added:</span><pre class="aia-tool-file aia-diff">${body}</pre>`;
      },
    });
    define({
      name: 'reload_capabilities',
      title: 'Reload capabilities',
      description: 'Load the capability folder again (after writing to it), so new or changed tools, skills and agents are available. Returns the problems found, if any.',
      parameters: {},
      effect: 'read',
      run: async () => {
        try {
          const problems = [...await this.o.caps.reload()];
          const tools = this.o.toolRegistry?.all().length || 0;
          // Tool files the index does not name are not loaded: say which, so they get registered.
          try {
            const info = ws().info;
            const dir = `${info.aiDir === '.' ? '' : `${info.aiDir}/`}tools`;
            const listed = new Set((this.o.toolRegistry?.all() || []).map((t) => t.source).filter(Boolean));
            const files = (await ws().client.list(dir)).entries.filter((e) => e.type === 'file' && /\.m?js$/.test(e.name)).map((e) => `tools/${e.name}`);
            for (const f of files) if (!listed.has(f)) problems.push(`${dir}/${f.slice(6)} is not in the capability index, so it is not loaded: add "${f}" to "tools" in index.json (write it whole with replace: true).`);
          } catch { /* no tools folder: nothing to say */ }
          return {
            content: `Reloaded: ${tools} tool${tools === 1 ? '' : 's'}, ${this.skillsForAgent().length} skill(s), ${this.agents().filter((a) => !a.implicit).length} agent(s).${problems.length ? ` Problems:\n- ${problems.join('\n- ')}` : ' No problems.'} New tools start turned off unless the tool config turns them on; a tool that is off can be asked for with request_tool.`,
            summary: problems.length ? `Reloaded · ${problems.length} problem(s)` : 'Reloaded · no problems',
          };
        } catch (e) { return fail(e); }
      },
    }, { builtin: 'workspace', ...always });
  }

  /** The MEMORY section of the system prompt, as it would be sent now. */
  memoryPrompt(settings = this.store.get()) {
    const mode = this.memoryMode();
    if (mode === 'off') return '';
    return buildMemoryPrompt({ items: this.memory.list(), enabled: !!settings.memoryEnabled, canWrite: mode === 'on' && !!(settings.memoryEnabled && settings.memoryWrite) });
  }

  /** An Undo button on a chip (a memory the agent just saved, changed or deleted). */
  addChipUndo(chip, undo) {
    const card = chip.querySelector('.aia-tool-card');
    card.innerHTML = '<div class="aia-tool-buttons"><button type="button" class="aia-btn aia-btn-sm" data-aia-undo>Undo</button><button type="button" class="aia-btn aia-btn-ghost aia-btn-sm" data-act="memory">Open memory</button></div>';
    card.hidden = false;
    card.querySelector('[data-aia-undo]').undo = undo;
  }

  runUndo(btn) {
    const chip = btn.closest('.aia-tool');
    try { btn.undo?.(); } catch (e) { this.addNotice(`Undo failed: ${e?.message || e}`, true); return; }
    btn.closest('.aia-tool-card').hidden = true;
    if (chip) chip.querySelector('.aia-tool-state').textContent = 'Undone';
  }

  /* ------------------------------------------- screenshots (models that see) */

  /** Can screenshots be taken and shown to the model with these settings? */
  visionOn(settings = this.store.get()) {
    return !!this.capture && !!settings.vision && this.capture.method() !== 'none';
  }

  /** Can the model be shown images at all: screenshots, or image files the user attaches? */
  seesImages(settings = this.store.get()) {
    return !!settings.vision && (this.visionOn(settings) || this.attachOn);
  }

  refreshVision() {
    const s = this.store.get();
    const on = this.visionOn(s);
    this.$.shot.hidden = !on;
    const sees = this.seesImages(s);
    if (!sees && this.pending.length) { this.pending = []; this.renderPending(); }
    if (this.capture && (!on || !s.screenshotAuto)) this.capture.stop();
    // The attach menu: images only for a model that sees them.
    this.$.menuImage.disabled = !sees;
    this.$.menuImageNote.textContent = sees
      ? 'PNG, JPEG, GIF, WebP… The agent sees it like a screenshot.'
      : 'This model is set as text-only (Settings > Vision).';
  }

  shotImg(s, alt) {
    // Thumbnails come back from saved chats: only an inline image is ever shown, never an address to load.
    const thumb = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(String(s.thumb || '')) ? s.thumb : '';
    return `<img class="aia-shot" src="${esc(thumb)}" alt="${esc(alt)}" data-aia-shot="${esc(s.id || '')}" title="Click to enlarge"${s.width ? ` width="${Number(s.width) | 0}" height="${Number(s.height) | 0}"` : ''}>`;
  }

  /** Keep an image's full data for this page load (the newest SHOTS_IN_MEMORY, plus any still in the composer). */
  rememberImage(id, image) {
    this.shots.set(id, { mime: image.mime, data: image.data });
    for (const old of [...this.shots.keys()].slice(0, Math.max(0, this.shots.size - SHOTS_IN_MEMORY))) {
      if (!this.pending.some((p) => p.id === old)) this.shots.delete(old);
    }
  }

  /** Take a screenshot now and remember its full image for this page load. `by`: 'user' | 'agent'. */
  async takeShot(by) {
    if (!this.capture) throw new Error('Screenshots are switched off for this application.');
    const shot = await this.capture.take({ reason: by });
    this.rememberImage(shot.id, shot);
    this.emit('screenshot', { by, width: shot.width, height: shot.height, source: shot.source });
    return shot;
  }

  /** The camera button: a screenshot waits in the composer and goes with the next question. */
  async attachScreenshot() {
    if (!this.visionOn() || this.$.shot.disabled) return null;
    if (this.pending.length >= PENDING_SHOTS) { this.addNotice(`A question can carry ${PENDING_SHOTS} screenshots. Remove one first.`, true); return null; }
    this.$.shot.disabled = true;
    try {
      const shot = await this.takeShot('user');
      this.pending.push({ id: shot.id, thumb: shot.thumb, width: shot.width, height: shot.height });
      this.renderPending();
      if (this.openState && !this.panel.isOpen()) this.$.input.focus();
      return shot;
    } catch (e) {
      this.addNotice(e?.message || String(e), true);
      return null;
    } finally {
      this.$.shot.disabled = false;
    }
  }

  /** What waits in the composer: image thumbnails (screenshots, image files), then file chips. */
  renderPending() {
    const box = this.$.attach;
    const remove = (attr, id, what) => `<button type="button" class="aia-attach-remove" ${attr}="${esc(id)}" title="Remove this ${what}" aria-label="Remove this ${what}">${ICONS.close}</button>`;
    const items = [
      ...this.pending.map((s) => {
        const what = s.name ? 'image' : 'screenshot';
        const pic = s.reading
          ? `<span class="aia-shot aia-shot-reading" title="${esc(s.name || '')}">${ICONS.image}</span>`
          : this.shotImg(s, s.name ? `Image to send: ${s.name}` : 'Screenshot to send');
        return `<span class="aia-attach-item">${pic}${remove('data-shot-remove', s.id, what)}</span>`;
      }),
      ...this.pendingFiles.map((f) => `<span class="aia-attach-item">${this.fileChip(f)}${remove('data-file-remove', f.id, 'file')}</span>`),
    ];
    box.hidden = !items.length;
    box.innerHTML = items.join('');
    const shots = this.pending.filter((s) => !s.name).length;
    const images = this.pending.length - shots;
    const files = this.pendingFiles.length;
    let placeholder = this.o.placeholder;
    if (shots && !images && !files) placeholder = 'Ask about the screenshot…';
    else if (images && !shots && !files) placeholder = images === 1 ? 'Ask about the image…' : 'Ask about the images…';
    else if (files && !shots && !images) placeholder = files === 1 ? 'Ask about the file…' : 'Ask about the files…';
    else if (shots || images || files) placeholder = 'Ask about the attachments…';
    this.$.input.placeholder = placeholder;
    this.$.form.classList.toggle('aia-reading', this.reading.size > 0);
  }

  /** A file's chip: in the composer (a span) or on a sent question (a button that shows what the agent received). */
  fileChip(f, { button = false } = {}) {
    let meta;
    if (f.reading) meta = 'Reading…';
    else if (typeof f.text !== 'string') meta = `${f.label || 'File'} · text not kept in saved chats`;
    else meta = `${fileSummary(f, { tokens: true })}${f.truncated ? ' · cut' : ''}`;
    const title = f.reading ? `Reading ${f.name}…` : `${f.name} — ${fileSummary(f)}${f.truncated ? ` (cut to ${nf(f.chars)} by Max file content)` : ''}${button ? '. Click to see the text the agent received.' : ''}`;
    const inner = `${ICONS.doc}<span class="aia-file-text"><span class="aia-file-name">${esc(f.name)}</span><span class="aia-file-meta">${esc(meta)}</span></span>`;
    const cls = `aia-file${f.reading ? ' aia-file-reading' : ''}${f.truncated ? ' aia-file-cut' : ''}`;
    return button
      ? `<button type="button" class="${cls}" data-aia-file="${esc(f.id)}" title="${esc(title)}">${inner}</button>`
      : `<span class="${cls}" title="${esc(title)}">${inner}</span>`;
  }

  /* ------------------------------------------- attachments (the + button) */

  bindAttachments() {
    const menu = this.$.menu;
    // The menu: arrow keys move between its items; Escape and Tab close it.
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
      const i = items.indexOf(document.activeElement);
      let next = null;
      if (e.key === 'ArrowDown') next = items[(i + 1) % items.length];
      else if (e.key === 'ArrowUp') next = items[(i - 1 + items.length) % items.length];
      else if (e.key === 'Home') next = items[0];
      else if (e.key === 'End') next = items[items.length - 1];
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeMenu(true); return; }
      else if (e.key === 'Tab') { this.closeMenu(); return; }
      if (next) { e.preventDefault(); next.focus(); }
    });
    this.onOutside = (e) => { if (!this.$.plusWrap.contains(e.target)) this.closeMenu(); };

    for (const input of [this.$.imageInput, this.$.fileInput]) {
      input.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.value = '';
        if (files.length) this.attachFiles(files);
      });
    }

    // Paste: files and pictures from the clipboard (a screenshot tool, "Copy image"). When the clipboard also holds
    // text (copying from Word or Excel adds a picture of it), the text is pasted as usual.
    this.$.input.addEventListener('paste', (e) => {
      const dt = e.clipboardData;
      const files = [...(dt?.files || [])];
      if (!files.length || ([...(dt.types || [])].includes('text/plain') && dt.getData('text/plain').trim())) return;
      e.preventDefault();
      e.stopPropagation();
      this.attachFiles(files);
    });

    // Drag and drop anywhere on the drawer.
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const show = (on) => { this.$.drop.hidden = !on; };
    this.el.addEventListener('dragenter', (e) => { if (hasFiles(e)) { e.preventDefault(); show(true); } });
    this.el.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      show(true);
    });
    this.el.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !this.el.contains(e.relatedTarget)) show(false); });
    this.el.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();       // the host page's own drop handler must not open the file too
      show(false);
      this.attachFiles([...(e.dataTransfer.files || [])]);
    });
  }

  openMenu() {
    if (!this.attachOn) return;
    this.refreshVision();
    this.$.menu.hidden = false;
    this.$.plus.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.onOutside, true);
    this.$.menu.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }

  closeMenu(focusButton = false) {
    if (this.$.menu.hidden) return;
    this.$.menu.hidden = true;
    this.$.plus.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.onOutside, true);
    if (focusButton) this.$.plus.focus();
  }

  /** Follow one attachment that is being read: questions wait for it; Send pressed meanwhile sends once all are read. */
  track(promise) {
    this.reading.add(promise);
    this.renderPending();
    promise.finally(() => {
      this.reading.delete(promise);
      this.renderPending();
      if (!this.reading.size && this.sendWhenRead) { this.sendWhenRead = false; this.submit(); }
    });
    return promise;
  }

  /**
   * Attach files the user chose, dropped or pasted: images go with the next question as pictures (exactly like a
   * screenshot), other files as their text. Resolves to one summary per file ({ kind, name, … }), or null for a file
   * that could not be attached (the chat says why).
   */
  async attachFiles(list) {
    const files = [...(list || [])].filter((f) => f && typeof f.arrayBuffer === 'function');
    if (!this.attachOn || !files.length) return [];
    this.setOpen(true, { focus: false });
    const s = this.store.get();
    const sees = this.seesImages(s);
    const jobs = [];
    for (const file of files) {
      const name = safeName(file.name || (file.type ? `attachment.${String(file.type).split('/')[1] || 'bin'}` : 'attachment'));
      const kind = fileKind(name, file.type);
      if (kind === 'image' && (sees || extension(name) !== 'svg')) {
        if (!sees) {
          this.addNotice(`"${name}" is an image, and this model is set as text-only. To show it images, pick a model that sees them and switch on "This model can see images" in Settings > Vision.`, true);
          jobs.push(null);
        } else if (this.pending.length >= PENDING_SHOTS) {
          this.addNotice(`A question can carry ${PENDING_SHOTS} images (screenshots included). Remove one first.`, true);
          jobs.push(null);
        } else jobs.push(this.attachImage(file, name));
      } else if (this.pendingFiles.length >= FILE_LIMITS.perQuestion) {
        this.addNotice(`A question can carry ${FILE_LIMITS.perQuestion} files. Remove one first, or send these and attach more with the next question.`, true);
        jobs.push(null);
      } else jobs.push(this.attachDocument(file, name, s));
    }
    return Promise.all(jobs);
  }

  attachImage(file, name) {
    const entry = { id: uid('i'), name, kind: 'image', reading: true };
    this.pending.push(entry);
    return this.track(imageFromFile(file, { maxEdge: this.o.screenshotMaxEdge }).then((img) => {
      this.rememberImage(entry.id, img);
      Object.assign(entry, { thumb: img.thumb, width: img.width, height: img.height, reading: false });
      const info = { kind: 'image', name, size: file.size || 0, width: img.width, height: img.height };
      this.emit('attach', info);
      return info;
    }).catch((e) => {
      this.pending = this.pending.filter((p) => p !== entry);
      this.addNotice(`"${name}" could not be opened as an image: ${e?.message || e}.`, true);
      return null;
    }));
  }

  attachDocument(file, name, settings) {
    const kind = fileKind(name, file.type);
    const entry = { id: uid('f'), name, label: fileLabel(kind, name), size: file.size || 0, reading: true };
    this.pendingFiles.push(entry);
    return this.track(readFile(file, { maxChars: settings.maxFileChars, reader: this.o.readFile }).then((rec) => {
      Object.assign(entry, rec, { id: entry.id, reading: false });
      const info = { kind: rec.kind, name: rec.name, size: rec.size, chars: rec.chars, totalChars: rec.totalChars, truncated: rec.truncated, label: rec.label };
      this.emit('attach', info);
      return info;
    }).catch((e) => {
      this.pendingFiles = this.pendingFiles.filter((f) => f !== entry);
      this.addNotice(e?.message || String(e), true);
      return null;
    }));
  }

  /** "See what the agent received": the text of an attached file. */
  openFile(id) {
    const f = this.fileRecords.get(id);
    if (!f) return;
    this.$.fileViewName.textContent = f.name;
    this.$.fileViewMeta.textContent = `${fileSummary(f)}${f.truncated ? ` · the agent received the first ${nf(f.chars)} characters (Max file content)` : ''}`;
    const note = typeof f.text !== 'string' ? 'The text of this file was not kept in saved chats, so the agent no longer has it. Attach the file again to ask about it.' : (f.note || '');
    this.$.fileViewNote.textContent = note;
    this.$.fileViewNote.hidden = !note;
    this.$.fileViewText.textContent = typeof f.text === 'string' ? f.text : '';
    this.$.fileViewText.hidden = typeof f.text !== 'string';
    this.$.fileView.hidden = false;
    this.$.fileView.querySelector('[data-act="file-close"]').focus();
  }

  closeFile() {
    this.$.fileView.hidden = true;
    this.$.fileViewText.textContent = '';
  }

  openShot(id, fallback) {
    const full = this.shots.get(id);
    const src = full ? `data:${full.mime};base64,${full.data}` : fallback;
    if (!src) return;
    this.$.shotView.querySelector('img').src = src;
    this.$.shotView.hidden = false;
    this.$.shotView.querySelector('button').focus();
  }

  closeShot() {
    this.$.shotView.hidden = true;
    this.$.shotView.querySelector('img').removeAttribute('src');
  }

  addChipShot(chip, s) {
    chip.querySelector('.aia-tool-line').insertAdjacentHTML('afterend', `<div class="aia-tool-shot">${this.shotImg(s, 'Screenshot the agent took')}</div>`);
    this.scrollToEnd();
  }

  /**
   * The agent looks at the screen. When the user has not freed it to do so (`allowed` false) it asks first; with the
   * browser's screen capture, the first screenshot also needs a click, which the same card provides.
   */
  async agentScreenshot(chip, signal, { allowed }) {
    if (!allowed) {
      const choice = await this.decide(chip, 'The agent wants to <b>look at your screen</b> (take a screenshot). It is set to see screenshots only when you press the camera button.', [
        { id: 'once', label: 'Allow once', primary: true }, { id: 'always', label: 'Always allow' }, { id: 'no', label: 'No' },
      ], signal);
      if (choice === 'cancel') return { status: 'skipped', content: 'Stopped by the user.' };
      if (choice === 'no') return { status: 'declined', content: 'The user did not allow a screenshot. Do not ask again for this request: work from the page snapshot, or ask the user to describe what they see.' };
      if (choice === 'always') this.setToolEnabled('take_screenshot', true);
    } else if (this.capture.needsGesture()) {
      const choice = await this.decide(chip, 'The agent wants to look at your screen. Your browser will ask you to share this tab.', [
        { id: 'share', label: 'Share this tab', primary: true }, { id: 'no', label: 'Not now' },
      ], signal);
      if (choice === 'cancel') return { status: 'skipped', content: 'Stopped by the user.' };
      if (choice !== 'share') return { status: 'declined', content: 'The user did not share the screen. Do not ask again for this request: work from the page snapshot.' };
    }
    this.setChip(chip, 'running');
    const shot = await this.takeShot('agent');
    return {
      content: `Screenshot taken (${shot.width} × ${shot.height} px). It is attached: use what you see in it.`,
      summary: `${shot.width} × ${shot.height} px`,
      images: [{ mime: shot.mime, data: shot.data }],
      thumb: shot.thumb,
      shot: shot.id,
    };
  }

  /** A tool row. Once the call is over it rolls down (click the line) to show what was sent and what came back. */
  addChip(view, title, call) {
    view.toolLog.hidden = false;
    const chip = h(`<div class="aia-tool" data-status="running">
      <button type="button" class="aia-tool-line" data-aia-tool-toggle aria-expanded="false" disabled><span class="aia-tool-caret" aria-hidden="true">▸</span><span class="aia-tool-dot" aria-hidden="true"></span><span class="aia-tool-title">${esc(title)}</span><code class="aia-tool-call">${esc(call)}</code><span class="aia-tool-state"></span></button>
      <div class="aia-tool-card" hidden></div>
      <div class="aia-tool-detail" hidden></div>
    </div>`);
    view.toolLog.appendChild(chip);
    const copyLog = view.actions.querySelector('[data-aia-reply-action="copy-tools"]');
    if (copyLog) copyLog.hidden = false;
    this.scrollToEnd();
    return chip;
  }

  setChip(chip, status, detail = '') {
    chip.dataset.status = status;
    const state = chip.querySelector('.aia-tool-state');
    state.textContent = STATUS_WORDS[status] || status;
    state.title = detail ? String(detail).slice(0, 600) : '';
  }

  /** What a finished tool row shows when rolled down: info = { name, title, status, detail: callDetail() }. */
  setToolDetail(chip, info) {
    this.toolDetails.set(chip, info);
    const line = chip.querySelector('.aia-tool-line');
    line.disabled = false;
    line.title = 'Show what was sent and what came back';
    if (!chip.querySelector('.aia-tool-detail').hidden) this.renderToolDetail(chip);
  }

  toggleToolDetail(line) {
    const chip = line.closest('.aia-tool');
    if (line.disabled || !chip || !this.toolDetails.has(chip)) return;
    const box = chip.querySelector('.aia-tool-detail');
    const open = box.hidden;
    if (open) this.renderToolDetail(chip);
    box.hidden = !open;
    line.setAttribute('aria-expanded', String(open));
  }

  renderToolDetail(chip) {
    const { status, detail: d } = this.toolDetails.get(chip);
    const part = (label, text) => `<div class="aia-tool-part"><div class="aia-tool-part-label">${esc(label)}</div><pre>${esc(text)}</pre></div>`;
    chip.querySelector('.aia-tool-detail').innerHTML = [
      d.problem ? `<p class="aia-tool-problem">${esc(d.problem)}</p>` : '',
      part('Arguments the tool received', d.args || '{}'),
      d.sent ? part(`As the model sent them · ${nf(d.sent.length)} chars`, d.sent) : '',
      part(status === 'error' ? 'Error returned to the model' : 'Returned to the model', d.result || '(nothing)'),
      '<div class="aia-tool-buttons"><button type="button" class="aia-msg-action" data-aia-tool-copy>Copy</button></div>',
    ].join('');
  }

  /** Copy tool rows as plain text: one row (its Copy button) or every row of a reply ("Copy tool log"). */
  copyToolRows(chips, btn) {
    const text = chips.filter(Boolean).map((chip) => {
      const info = this.toolDetails.get(chip);
      if (info) return callReport(info);
      return `${chip.querySelector('.aia-tool-title')?.textContent || 'Tool'} · ${chip.querySelector('.aia-tool-state')?.textContent || ''}`;
    }).join('\n\n----------------\n\n');
    if (!text) return;
    copyText(text);
    flash(btn);
  }

  /** Show a question with buttons on a tool chip; resolves to the chosen button id ('cancel' when stopped). */
  decide(chip, question, buttons, signal) {
    this.setChip(chip, 'waiting');
    const card = chip.querySelector('.aia-tool-card');
    card.innerHTML = `<p>${question}</p><div class="aia-tool-buttons">${buttons.map((b) => `<button type="button" class="aia-btn aia-btn-sm${b.primary ? ' aia-btn-primary' : ''}" data-decide="${esc(b.id)}">${esc(b.label)}</button>`).join('')}</div>`;
    card.hidden = false;
    this.scrollToEnd(true);
    return new Promise((resolve) => {
      const done = (v) => {
        card.hidden = true;
        card.innerHTML = '';
        signal?.removeEventListener?.('abort', onAbort);
        card.removeEventListener('click', onClick);
        resolve(v);
      };
      const onClick = (e) => { const b = e.target.closest('[data-decide]'); if (b) done(b.dataset.decide); };
      const onAbort = () => done('cancel');
      card.addEventListener('click', onClick);
      signal?.addEventListener?.('abort', onAbort, { once: true });
      card.querySelector('.aia-btn-primary')?.focus();
    });
  }

  setToolEnabled(name, on) {
    const builtin = this.o.toolRegistry?.get(name) ? null : this.builtinTools.find((b) => b.name === name);
    if (builtin) { if (!builtin.setEnabled) return; builtin.setEnabled(!!on); } else this.store.save({ toolStates: { [name]: !!on } });
    this.emit('tool-state', { name, enabled: !!on });
  }

  /**
   * Run one tool call from the model: availability, on/off state, arguments, confirmation, then the app's own
   * function. Returns { id, name, content, changed } — content is what the model reads.
   */
  async executeTool(call, { view, signal, actions }) {
    const result = (content, changed = false) => ({ id: call.id, name: call.name, content, changed });

    if (call.name === REQUEST_TOOL) {
      const want = this.findTool(String(call.arguments?.name || ''));
      if (!want) return result(`There is no tool named "${call.arguments?.name}".`);
      if (toolEnabled(want, this.store.get())) return result(`${want.name} is already turned on: call it.`);
      if (want.builtin === 'vision') {
        // Asking to look at the screen: the user can allow it once (the screenshot comes back straight away).
        const chip = this.addChip(view, want.title, formatCall(want.name, {}));
        return this.finishBuiltin(want, () => this.agentScreenshot(chip, signal, { allowed: false }), { chip, actions, result, args: {} });
      }
      const chip = this.addChip(view, `Turn on ${want.title}`, formatCall(want.name, {}));
      const reason = call.arguments?.reason ? `<br><span class="aia-tool-reason">${esc(String(call.arguments.reason).slice(0, 300))}</span>` : '';
      const choice = await this.decide(chip, `The agent wants to use <b>${esc(want.title)}</b>, which is turned off.${reason}`, [
        { id: 'on', label: 'Turn on', primary: true }, { id: 'off', label: 'Keep off' },
      ], signal);
      // The row rolls down like any other: what the model asked for and what it was told.
      const answer = (status, content) => {
        const detail = callDetail({ call, args: call.arguments || {}, result: content });
        this.setToolDetail(chip, { name: REQUEST_TOOL, title: `Turn on ${want.title}`, status, detail });
        actions.push({ call: `turn on ${want.name}`, title: `Turn on ${want.title}`, status, name: REQUEST_TOOL, detail: savedDetail(detail) });
        return result(content);
      };
      if (choice === 'on') {
        this.setToolEnabled(want.name, true);
        this.setChip(chip, 'ok', 'Turned on');
        chip.querySelector('.aia-tool-state').textContent = 'Turned on';
        return answer('ok', `The user turned on ${want.name}. You can call it now.`);
      }
      this.setChip(chip, 'off');
      return answer('declined', `The user kept ${want.name} turned off. Do not call it; explain how they can do it themselves, or that they can turn it on in Settings > Tools.`);
    }

    const settings = this.store.get();
    const tool = this.findTool(call.name, settings);
    if (!tool) return result(this.hiddenReason(call.name) || `There is no tool named "${call.name}". Use only the tools you were given.`);
    const decision = decidePermission(tool, this.policy());
    const v = validateArgs(tool, call.arguments);
    const chip = this.addChip(view, tool.title, formatCall(tool.name, v.args));
    let entry = null;
    let problem = '';
    const record = (status, summary = '') => {
      this.setChip(chip, status, summary);
      entry = { call: formatCall(tool.name, v.args), title: tool.title, status, summary: String(summary).slice(0, 200) };
      actions.push(entry);
      this.emit('tool', { name: tool.name, args: v.args, status, result: summary });
    };
    // Every way out after the row exists: the row rolls down to show the arguments and what the model was told.
    const reply = (content, changed = false) => {
      const detail = callDetail({ call, args: v.args, problem, result: content });
      this.setToolDetail(chip, { name: tool.name, title: tool.title, status: entry?.status || 'error', detail });
      if (entry) Object.assign(entry, { name: tool.name, detail: savedDetail(detail) });
      return result(content, changed);
    };

    if (!settings.toolsEnabled && !tool.builtin) { record('off'); return reply('Tools are switched off by the user (Settings > Tools).'); }
    let consented = false;
    if (tool.builtin === 'vision' && !toolEnabled(tool, settings)) {
      return this.finishBuiltin(tool, () => this.agentScreenshot(chip, signal, { allowed: false }), { chip, actions, result, args: v.args });
    }
    if (tool.builtin && !toolEnabled(tool, settings)) { record('off'); return reply(tool.offMessage || 'Saving memories is switched off by the user (Settings > Memory).'); }
    if (!toolEnabled(tool, settings)) {
      const choice = await this.decide(chip, `<b>${esc(tool.title)}</b> is turned off. Turn it on and run it?`, [
        { id: 'on', label: 'Turn on and run', primary: true }, { id: 'off', label: 'Keep off' },
      ], signal);
      if (choice !== 'on') { record('off'); return reply(`${tool.name} is turned off and the user kept it off. Do not call it again.`); }
      this.setToolEnabled(tool.name, true);
      consented = true;
    }
    if (!toolAvailable(tool, this.ctx.page?.id)) {
      record('skipped', 'Not available on this screen');
      return reply(`${tool.name} is not available on this screen${tool.pages.length ? ` (it works on: ${tool.pages.join(', ')})` : ''}.`);
    }
    if (call.argsError) {
      // The arguments could not be read (often: the reply hit Max reply tokens mid-call). Say so; do not guess them.
      const p = argumentsProblem(call, { cutOff: call.cutOff, maxTokens: settings.maxOutputTokens });
      problem = p.summary;
      record('error', p.summary);
      return reply(p.content);
    }
    if (!v.ok) {
      problem = `Invalid arguments: ${v.errors.join('; ')}.`;
      record('error', v.errors.join('; '));
      return reply(`Invalid arguments: ${v.errors.join('; ')}. Check the tool's parameters and try again.`);
    }

    // A built-in may refuse a call before the user is asked (e.g. creating a file that exists): no card for a call
    // that cannot work.
    if (typeof tool.precheck === 'function') {
      let why = '';
      try { why = (await tool.precheck(v.args)) || ''; } catch { why = ''; }
      if (why) { problem = why; record('error', why); return reply(`Not run: ${why}`); }
    }
    // Permissions (core/permissions.js): deny was handled by findTool; ask / allow / the user's settings decide here.
    const ask = needsConfirmation({ tool, decision, settings, allowedForChat: this.allowedTools.has(tool.name) });
    if (ask && (!consented || tool.effect === 'system')) {
      const buttons = [{ id: 'run', label: 'Run', primary: true }];
      if (tool.effect === 'write' && decision !== 'ask') buttons.push({ id: 'chat', label: 'Allow for this chat' });
      buttons.push({ id: 'skip', label: 'Skip' });
      const what = {
        destructive: 'This removes or overwrites something.',
        external: 'This reaches outside the application (it sends, publishes or calls another service).',
        system: 'This changes the application itself.',
        read: 'The application asks before this tool runs.',
      }[tool.effect] || 'This changes the application.';
      let question = '';
      try { question = (await tool.confirmHtml?.(v.args)) || ''; } catch { question = ''; }
      const choice = await this.decide(chip, question || `Run <b>${esc(tool.title)}</b>? ${what}`, buttons, signal);
      if (choice === 'cancel') { record('skipped'); return reply('Stopped by the user.'); }
      if (choice === 'skip') { record('declined'); return reply(`The user declined to run ${tool.name}. Do not call it again for this request.`); }
      if (choice === 'chat') this.allowedTools.add(tool.name);
    }

    this.setChip(chip, 'running');
    view.status = `Running ${tool.title}…`;
    view.paint();
    if (tool.builtin) return this.finishBuiltin(tool, () => tool.run(v.args, { chip, signal }), { chip, actions, result, args: v.args });
    try {
      let timer;
      const value = await Promise.race([
        Promise.resolve().then(() => tool.run(v.args, { host: this.o.host, agent: this.api, signal, call: { id: call.id, name: tool.name } })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no result after ${Math.round(tool.timeoutMs / 1000)} s`)), tool.timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      const content = serializeResult(value);
      record('ok', content);
      return reply(content, tool.effect !== 'read');
    } catch (e) {
      const msg = String(e?.message || e);
      record('error', msg);
      return reply(`Error: ${msg}`, tool.effect !== 'read');
    }
  }

  /**
   * Run a built-in tool (memory, screenshot) and turn what it returns — { content, status?, summary?, images?,
   * thumb?, shot?, undo?, label? } — into the chip, the action record and the result for the model.
   */
  async finishBuiltin(tool, run, { chip, actions, result, args }) {
    let out;
    try { out = await run(); } catch (e) { out = { status: 'error', content: `Error: ${e?.message || e}`, summary: String(e?.message || e) }; }
    const status = out.status || 'ok';
    const summary = String(out.summary ?? out.content ?? '').slice(0, 200);
    this.setChip(chip, status, summary);
    if (out.label && status === 'ok') chip.querySelector('.aia-tool-state').textContent = out.label;
    if (out.thumb) this.addChipShot(chip, { id: out.shot, thumb: out.thumb });
    if (typeof out.undo === 'function' && status === 'ok') this.addChipUndo(chip, out.undo);
    const detail = callDetail({ call: { arguments: args }, args, result: String(out.content ?? 'Done.') });
    this.setToolDetail(chip, { name: tool.name, title: tool.title, status, detail });
    actions.push({ call: formatCall(tool.name, args), title: tool.title, status, summary, name: tool.name, detail: savedDetail(detail), ...(out.thumb ? { thumb: out.thumb, shot: out.shot } : {}) });
    this.emit('tool', { name: tool.name, args, status, result: summary });
    const r = result(String(out.content ?? 'Done.'));
    if (Array.isArray(out.images) && out.images.length) r.images = out.images;
    return r;
  }

  /**
   * One question to the model, with tool rounds: stream a reply; if it asks for tools, run them (asking the user
   * where the settings say so), send the results back, and repeat until it answers or the step limit is reached.
   */
  async runModel({ settings, baseSystem, messages, view, controller, actions, snapshotHash }) {
    const signal = controller.signal;
    const turnId = uid('t');
    const toolTurns = [];
    let lastHash = snapshotHash;
    let mode = this.toolMode(settings);
    let result = null;
    const onEvent = (e) => {
      if (e.type === 'text') view.raw += e.text;
      else if (e.type === 'reasoning') view.native += e.text;
      else if (e.type === 'notice') { view.notice.textContent = e.text; view.notice.hidden = false; }
      else if (e.type === 'status') view.status = e.text;
      view.paint();
    };

    for (let step = 0; step < 64; step++) {
      const s = this.store.get();
      const set = mode === 'off' ? { classes: { callable: [], off: [], elsewhere: [] }, active: false, appOff: false } : this.toolSet(s);
      const { classes } = set;
      const toolsText = mode === 'off' ? '' : buildToolPrompt({ classes, mode, enabled: set.active, appOff: set.appOff });
      const native = mode === 'native' && set.active;
      const specs = native ? [...toolSpecs(classes.callable), ...(classes.off.length ? [requestToolSpec(classes.off)] : [])] : [];
      const stepStart = view.raw.length;
      const nativeStart = view.native.length;
      try {
        result = await streamChat({
          settings,
          keyFor: this.keyFor,
          system: buildSystemPrompt({ ...baseSystem, toolsText, memoryText: this.memoryPrompt(s), skillsText: this.skillsPrompt(mode !== 'off'), vision: this.seesImages(s), screenshots: this.visionOn(s) }),
          messages: mode === 'text' ? [...messages, ...textTurnMessages(toolTurns)] : messages,
          signal,
          relayHeaders: this.o.relayHeaders,
          tools: specs,
          toolTurns: native ? toolTurns : [],
          turnId,
          onEvent,
        });
      } catch (e) {
        // auto mode: a model/server that refuses tool definitions gets the text protocol instead.
        if (native && s.toolMode === 'auto' && specs.length && view.raw.length === stepStart && e instanceof AiError && e.code !== 'cancelled'
          && e.code !== 'auth' && e.code !== 'network' && e.code !== 'timeout' && /tool|function/i.test(e.message)) {
          this.textTools.add(this.modelKey(settings));
          mode = 'text';
          view.notice.textContent = 'This model does not accept tool calls, so tools are described to it as text blocks.';
          view.notice.hidden = false;
          step -= 1;
          continue;
        }
        if (e && typeof e === 'object' && (messages.some((m) => m.images) || toolTurns.some((t) => t.results.some((r) => r.images)))) e.hadImages = true;
        if (e && typeof e === 'object' && messages.some((m) => m.role === 'user' && m.content.includes('<attached_file '))) e.hadFiles = true;
        throw e;
      }

      const stepRaw = view.raw.slice(stepStart);
      let stepText = splitReasoning(stepRaw).text.trim();
      let calls = result.toolCalls || [];
      if (mode === 'text' && set.active) {
        const parsed = parseTextToolCalls(stepText, `t${step}_`, { cutOff: !!result.truncated });
        calls = parsed.calls;
        if (calls.length) {
          view.raw = view.raw.slice(0, stepStart) + parsed.text;
          stepText = parsed.text;
          this.paint(view);
        }
      }
      // A reply that hit Max reply tokens while writing a call: that call's arguments are cut off (executeTool says so).
      const lastCall = calls[calls.length - 1];
      if (result.truncated && lastCall?.argsError) lastCall.cutOff = true;
      if (!calls.length || mode === 'off') {
        if (result.truncated) {
          view.notice.textContent = `The reply reached Max reply tokens (${nf(settings.maxOutputTokens)}) and was cut off. Raise it in Settings > Agent, or ask for less at once.`;
          view.notice.hidden = false;
        }
        // After tool rounds, some local models (seen with LM Studio + a Qwen 3.5 9B) put their whole closing answer
        // in the reasoning channel and leave the text empty. Then that last step's reasoning is what they said.
        if (toolTurns.length && !stepText) {
          const said = (view.native.slice(nativeStart) || splitReasoning(stepRaw).reasoning).trim();
          if (said) {
            view.native = view.native.slice(0, nativeStart);
            view.raw = view.raw.slice(0, stepStart) + said;
            this.paint(view);
          }
        }
        break;
      }
      const agentSteps = this.agent().maxToolSteps;
      const maxSteps = agentSteps ? Math.min(s.maxToolSteps, agentSteps) : s.maxToolSteps;
      if (step >= maxSteps) {
        view.notice.textContent = maxSteps < s.maxToolSteps
          ? `Stopped after ${maxSteps} tool steps (the ${this.agent().title} agent's limit).`
          : `Stopped after ${maxSteps} tool steps (Settings > Tools > Max tool steps).`;
        view.notice.hidden = false;
        break;
      }

      const results = [];
      let changed = false;
      for (const call of calls) {
        if (signal.aborted) break;
        const r = await this.executeTool(call, { view, signal, actions });
        results.push(r);
        changed = changed || r.changed;
      }
      if (signal.aborted) throw new AiError('cancelled', 'Cancelled.');
      // Send the screen back with the results when the actions changed it, so the model sees their effect.
      if (changed && this.shareOn(settings) && this.ctx.hasContent && results.length) {
        try {
          const snap = await this.ctx.snapshot();
          if (!snap.empty && snap.hash !== lastHash) {
            results[results.length - 1].content += `

[The screen after these actions]
${snapshotBlock(snap)}`;
            lastHash = snap.hash;
          }
        } catch { /* the content hook failed: the results still go back */ }
      }
      toolTurns.push({ text: stepText, calls: calls.map(wireCall), results: results.map(({ id, name, content, images }) => (images ? { id, name, content, images } : { id, name, content })) });
      if (view.raw && !view.raw.endsWith('\n\n')) view.raw += '\n\n';
      view.status = 'Continuing…';
      view.paint();
    }
    return result;
  }

  /* ============================================================= sending */

  autoGrow() {
    const i = this.$.input;
    i.style.height = 'auto';
    i.style.height = `${Math.min(i.scrollHeight, 180)}px`;
  }

  submit() {
    if (this.streaming) { this.stop(); return; }
    // A file still being read: send as soon as it is (the composer keeps the text until then).
    if (this.reading.size) { this.sendWhenRead = true; return; }
    const text = this.$.input.value.trim();
    if (!text && !this.pending.length && !this.pendingFiles.length) return;
    const { shots, files } = this.takePending();
    this.$.input.value = '';
    this.autoGrow();
    this.send(text, { shots, files });
  }

  /** Empty the composer's attachments and return them for a question. */
  takePending() {
    const shots = this.pending.filter((s) => !s.reading);
    const files = this.pendingFiles.filter((f) => !f.reading);
    this.pending = this.pending.filter((s) => s.reading);
    this.pendingFiles = this.pendingFiles.filter((f) => f.reading);
    this.renderPending();
    return { shots, files };
  }

  /** A question from the app or a suggestion chip: like Send, it takes what waits in the composer along. */
  async ask(text) {
    if (this.reading.size) await Promise.allSettled([...this.reading]);
    return this.send(text, this.streaming ? {} : this.takePending());
  }

  setStreaming(active) {
    this.$.send.classList.toggle('aia-stop', !!active);
    this.$.send.innerHTML = active ? ICONS.stop : ICONS.send;
    this.$.send.title = active ? 'Stop (Esc)' : 'Send (Enter)';
    this.$.send.setAttribute('aria-label', active ? 'Stop' : 'Send');
    this.el.classList.toggle('aia-busy', !!active);
  }

  stop() {
    if (this.streaming) this.streaming.controller.abort();
  }

  keyFor = (id) => this.store.keys.get(id);

  effectivePrompt(settings) {
    return settings.systemPrompt && settings.systemPrompt.trim() ? settings.systemPrompt : this.defaultPrompt();
  }

  async send(rawText, { shots = [], files = [] } = {}) {
    let text = String(rawText ?? '').trim();
    if (!text && (shots.length || files.length)) {
      const images = shots.filter((s) => s.name).length;
      if (!files.length && !images) text = 'Here is a screenshot of what I am looking at.';
      else if (files.length && !shots.length) text = files.length === 1 ? 'Please look at the attached file.' : 'Please look at the attached files.';
      else if (images && !files.length && images === shots.length) text = images === 1 ? 'Please look at the attached image.' : 'Please look at the attached images.';
      else text = 'Please look at what I attached.';
    }
    if (!text) return;
    // A question that is not sent keeps its attachments in the composer.
    const keepShots = () => {
      if (!shots.length && !files.length) return;
      this.pending = [...shots, ...this.pending].slice(0, PENDING_SHOTS);
      this.pendingFiles = [...files, ...this.pendingFiles].slice(0, FILE_LIMITS.perQuestion);
      this.renderPending();
    };
    if (this.streaming) { keepShots(); this.addNotice('Still answering the previous question — press Stop or wait a moment.', true); return; }
    this.setOpen(true);
    this.setLibraryOpen(false);
    if (this.ready) { try { await this.ready; } catch { /* keep the defaults as they were */ } }
    const settings = this.store.get();
    this.ctx.setMaxChars(settings.maxContextChars);

    // Configuration problems (missing key/model) are reported before anything is added to the conversation.
    try {
      resolveTarget(settings, this.keyFor);
    } catch (e) {
      keepShots();
      this.renderError(this.addWrap('assistant'), e, settings);
      return;
    }
    const vision = this.seesImages(settings);

    const controller = new AbortController();
    this.streaming = { controller };
    this.setStreaming(true);
    this.stick = true;

    const share = this.shareOn(settings);
    const snapshot = share && this.ctx.hasContent ? await this.ctx.snapshot() : null;
    const plan = planTurn({ messages: this.conv.messages, snapshot, historyMessages: settings.historyMessages, share, force: this.forceReread });
    const userMsg = { id: uid('u'), role: 'user', content: text, at: Date.now(), sync: plan.attach ? 'attached' : plan.reason };
    // "/proofreading …" activates that skill for this conversation (the message goes to the model as typed).
    const slash = parseSlashCommand(text, this.skillsForAgent().map((sk) => sk.name));
    if (slash && this.activateSkill(slash.name, { via: 'slash' })) userMsg.skill = slash.name;
    if (plan.attach) {
      userMsg.snapshot = {
        hash: snapshot.hash, text: snapshot.text, pageId: snapshot.pageId, pageTitle: snapshot.pageTitle,
        chars: snapshot.chars, totalChars: snapshot.totalChars, truncated: snapshot.truncated, at: snapshot.at,
      };
    } else if (plan.reason === 'unchanged') {
      userMsg.snapshotRef = snapshot.hash;
    }
    if (vision && shots.length) userMsg.shots = shots.map(({ id, thumb, width, height, name }) => ({ id, thumb, width, height, ...(name ? { name, kind: 'image' } : {}) }));
    if (files.length) userMsg.files = files.map(({ reading, ...f }) => f);
    this.forceReread = false;
    this.conv.messages.push(userMsg);
    const userWrap = this.renderUser(userMsg);
    this.refreshStatus(snapshot);

    const texts = await this.contextTexts(settings);
    const baseSystem = await this.baseSystemFor(settings, texts);
    const { viewText } = texts;
    const messages = buildRequestMessages({
      messages: this.conv.messages,
      historyMessages: settings.historyMessages,
      viewText,
      unchangedHash: plan.reason === 'unchanged' ? snapshot.hash : null,
      imageFor: vision ? (s) => this.shots.get(s.id) || null : null,
    });

    const view = this.addAssistantView();
    view.status = `Contacting ${provider(settings.provider).label}…`;
    this.paint(view);
    this.emit('send', { text, attached: plan.attach, reason: plan.reason, hash: snapshot?.hash || null, images: userMsg.shots?.length || 0, files: (userMsg.files || []).map((f) => f.name) });

    const onScroll = () => { this.stick = this.nearBottom(); };
    this.$.messages.addEventListener('scroll', onScroll, { passive: true });

    let result = null;
    let error = null;
    const actions = [];
    try {
      result = await this.runModel({ settings, baseSystem, messages, view, controller, actions, snapshotHash: snapshot?.hash || null });
    } catch (e) {
      error = e;
    }
    this.$.messages.removeEventListener('scroll', onScroll);

    view.done = true;
    this.paint(view);
    const answer = view.answer.trim();
    const cancelled = error?.code === 'cancelled';

    if (answer || actions.length) {
      // With actions taken, the turn is kept even without text: the app changed and the history must say so.
      const who = result ? `${result.label}${result.model ? ` · ${result.model}` : this.probeInfo.loaded ? ` · ${this.probeInfo.loaded}` : ''}` : '';
      const meta = cancelled ? 'Stopped' : who;
      if (meta) { view.foot.hidden = false; view.foot.textContent = meta; }
      if (!answer) view.text.innerHTML = `<p class="aia-stream-status">${cancelled ? 'Stopped.' : error ? '' : 'Done.'}</p>`;
      view.actions.hidden = !answer;
      const msg = { id: uid('a'), role: 'assistant', content: cancelled && answer ? `${answer}\n\n_(stopped)_` : answer, at: Date.now(), meta };
      if (actions.length) msg.actions = actions;
      this.conv.messages.push(msg);
      if (error && !cancelled) this.renderError(this.addWrap('assistant'), error, settings);
      this.emit('reply', { text: answer, provider: result?.provider, model: result?.model, stopped: cancelled, actions });
    } else {
      // Nothing usable came back: take the question out of the history so the transcript (and the sync state)
      // is exactly as it was before it was asked.
      this.conv.messages = this.conv.messages.filter((m) => m !== userMsg);
      if (userMsg.shots || userMsg.files) keepShots();
      userWrap.classList.add('aia-unsent');
      userWrap.querySelector('.aia-msg-meta')?.remove();
      if (cancelled) {
        view.text.innerHTML = '<p class="aia-stream-status">Stopped before an answer arrived.</p>';
      } else if (error) {
        this.renderError(view.wrap, error, settings, true);
        this.emit('error', { error });
      } else {
        const hint = view.native || splitReasoning(view.raw).reasoning
          ? 'The model spent its whole reply budget thinking. Raise "Max reply tokens" in Settings > Agent, or set Thinking to "Ask the model not to think".'
          : 'The model returned an empty reply.';
        view.text.innerHTML = `<p>${esc(hint)}</p>`;
        view.wrap.classList.add('aia-error');
      }
    }

    this.streaming = null;
    this.setStreaming(false);
    this.persist();
    this.refreshStatus();
  }

  hintsFor(e, settings) {
    const p = provider(settings.provider);
    const { baseUrl } = profileFor(settings, p.id);
    const hints = [...(e.hints || [])];
    if (e.code === 'network' || e.code === 'bad-endpoint') {
      if (settings.transport === 'relay') {
        hints.push(`Is the relay reachable at "${settings.relayUrl}"?`);
      } else if (p.kind !== 'cloud') {
        hints.push(`Is ${p.label} running, with its server started on ${baseUrl}?`);
        if (p.id === 'lmstudio') hints.push('In LM Studio: Developer tab > Start server, and switch on "Enable CORS" in the server settings.');
        hints.push('Use 127.0.0.1 rather than localhost: on Windows, localhost can resolve to IPv6 (::1).');
      } else {
        hints.push('If the browser is blocking the call, switch Settings > Model > Advanced > "Send requests" to the relay.');
      }
    }
    if (e.code === 'auth') hints.push('Check the API key in Settings > Model.');
    if (e.code === 'missing-model') hints.push('Open Settings > Model, press "Load models" and pick one.');
    if (e.code === 'timeout') hints.push('The first request after loading a model can be slow. Try again, or raise the timeout in Settings > Model > Advanced.');
    if (e.code === 'budget') hints.push('Lower "Max screen content" or "Conversation memory" in Settings > Agent.');
    if (e.hadImages && e.code !== 'auth' && e.code !== 'network' && e.code !== 'timeout' && e.code !== 'rate-limit') {
      hints.push('This question carried an image. If the model cannot see images, pick a vision model or switch off "This model can see images" in Settings > Vision.');
    }
    if (e.hadFiles && e.code !== 'auth' && e.code !== 'network' && e.code !== 'rate-limit') {
      hints.push('The conversation carries attached files. If the model\'s context is too small for them (local models often run with 4k–8k tokens), lower "Max file content" in Settings > Agent, load the model with a larger context, or start a new chat.');
    }
    return [...new Set(hints)];
  }

  renderError(wrap, e, settings, inPlace = false) {
    const hints = this.hintsFor(e, settings);
    wrap.classList.add('aia-error');
    const body = `<p>${esc(e?.message || String(e))}</p>`
      + (hints.length ? `<ul class="aia-hints">${hints.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '')
      + '<div class="aia-msg-actions"><button type="button" class="aia-msg-action" data-act="open-settings">Open settings</button></div>';
    const target = inPlace ? wrap.querySelector('.aia-md') : wrap.querySelector('.aia-bubble');
    target.innerHTML = body;
    this.scrollToEnd(true);
  }

  /* ======================================================== context flag */

  /** The sync flag for the screen as it is now. No side effects (the Context tab calls this while it renders). */
  async computeStatus(snapshot) {
    const settings = this.store.get();
    this.ctx.setMaxChars(settings.maxContextChars);
    const share = this.shareOn(settings);
    let snap = snapshot;
    if (!snap && share && this.ctx.hasContent) {
      try { snap = await this.ctx.snapshot(); } catch { snap = null; }
    }
    const st = contextState({ messages: this.conv.messages, snapshot: this.ctx.hasContent ? snap : null, historyMessages: settings.historyMessages, share, force: this.forceReread });
    return {
      state: st.state,
      pending: st.pending,
      reason: st.reason,
      hash: st.currentHash,
      syncedHash: st.syncedHash,
      pageId: snap?.pageId || this.ctx.page?.id || null,
      title: snap?.pageTitle || '',
      chars: snap?.totalChars || 0,
      truncated: !!snap?.truncated,
      forced: this.forceReread,
    };
  }

  /** Recompute the flag, show it, and tell listeners. Pass a snapshot taken moments ago to avoid a second read. */
  async refreshStatus(snapshot) {
    const seq = ++this.statusSeq;
    const status = await this.computeStatus(snapshot);
    if (seq !== this.statusSeq) return this.status;   // a newer refresh overtook this one
    const changed = !this.status || status.state !== this.status.state || status.hash !== this.status.hash
      || status.syncedHash !== this.status.syncedHash || status.forced !== this.status.forced;
    this.status = status;
    this.renderFlag(status);
    if (changed) {
      this.panel.refreshContext();
      this.emit('context', status);
    }
    return status;
  }

  renderFlag(s) {
    const bar = this.$.ctxBar;
    bar.dataset.state = s.state;
    let text = (FLAG[s.state] || FLAG.none)(s);
    if (s.forced && s.state !== 'none' && s.state !== 'off') text = 'Agent re-reads this page with your next message';
    this.$.ctxText.textContent = text;
    this.$.ctxHash.textContent = s.hash ? shortHash(s.hash) : '';
    this.$.ctxHash.title = s.hash
      ? `Screen fingerprint ${shortHash(s.hash)}${s.syncedHash ? ` · agent has ${shortHash(s.syncedHash)}` : ' · agent has none yet'}${s.chars ? ` · ${nf(s.chars)} chars` : ''}`
      : '';
    bar.querySelector('[data-act="reread"]').hidden = !(s.state === 'synced' && !s.forced);
    for (const t of this.toggles) {
      if (this.o.toggleBadge !== false) t.setAttribute('data-aia-context', s.state);
    }
  }

  /* ============================================================ subtitle */

  async refreshSubtitle() {
    const settings = this.store.get();
    const p = provider(settings.provider);
    const { model } = profileFor(settings, p.id);
    const relay = settings.transport === 'relay' ? ' · via relay' : '';
    const base = `${p.label.replace(/ \(.*\)$/, '')} · ${model || (p.id === 'lmstudio' ? 'loaded model' : 'no model')}${relay}`;
    this.$.subtitle.textContent = base;
    this.$.subtitle.title = base;
    if (p.keyRequired && settings.transport !== 'relay' && !this.store.keys.get(p.id)) {
      this.$.subtitle.textContent = `${p.label} · needs an API key`;
      return;
    }
    if (p.kind === 'cloud' || !this.openState) return;
    // Local servers: check they are up, and name the model LM Studio has loaded.
    const key = JSON.stringify([settings.provider, settings.transport, settings.relayUrl, settings.profiles?.[p.id]]);
    if (this.probeInfo.key === key && Date.now() - (this.probeInfo.at || 0) < 15000) {
      this.$.subtitle.textContent = this.probeInfo.text;
      return;
    }
    try {
      const models = await listModels({ settings, keyFor: this.keyFor, relayHeaders: this.o.relayHeaders, timeoutMs: 5000 });
      const loaded = models.find((m) => m.loaded)?.id || '';
      const text = !model && loaded ? `${p.label.replace(/ \(.*\)$/, '')} · ${loaded}${relay}`
        : !model && p.id === 'lmstudio' ? `LM Studio · no model loaded${relay}` : base;
      // Some servers (LM Studio) say whether a model sees images: Settings > Vision shows it as a hint.
      const used = models.find((m) => m.id === (model || loaded));
      this.probeInfo = { key, text, loaded, at: Date.now(), model: used?.id || '', vision: used?.vision };
      this.panel.refreshVision?.();
    } catch {
      this.probeInfo = { key, text: `${base} · not reachable`, loaded: '', at: Date.now() };
    }
    this.$.subtitle.textContent = this.probeInfo.text;
    this.$.subtitle.title = this.probeInfo.text;
  }

  /* ======================================================= saved chats */

  readChats() {
    try {
      const v = JSON.parse(this.o.storage.getItem(this.chatsKey) || '[]');
      return Array.isArray(v) ? v.filter((c) => c && c.id) : [];
    } catch {
      return [];
    }
  }

  writeChats(list) {
    const attempt = (l) => { try { this.o.storage.setItem(this.chatsKey, JSON.stringify(l)); return true; } catch { return false; } };
    if (attempt(list)) return true;
    // Over the storage quota: the text of files in the other chats goes first, then the oldest chats.
    const lean = list.map((c) => (c.id === this.conv.id ? c : {
      ...c, messages: (c.messages || []).map((m) => (m.files ? { ...m, files: m.files.map(({ text, ...f }) => f) } : m)),
    }));
    for (let n = lean.length; n > 0; n = Math.floor(n * 0.7)) {
      if (attempt(lean.slice(0, n))) return true;
    }
    return false;
  }

  deriveTitle() {
    const first = this.conv.messages.find((m) => m.role === 'user');
    const t = String(first?.content || '').replace(/\s+/g, ' ').trim();
    return !t ? 'New chat' : t.length > 48 ? `${t.slice(0, 47).trim()}…` : t;
  }

  /**
   * Save the transcript. Snapshot TEXT is not kept (it can be large, and the screen can be read again); fingerprints
   * and titles are. Attached files keep their text (it cannot be read again), unless storage runs out (writeChats).
   */
  persist() {
    if (!this.conv.messages.length || this.o.saveChats === false) return;
    if (!this.conv.id) this.conv.id = uid('c');
    const messages = this.conv.messages.slice(-MESSAGE_LIMIT).map((m) => {
      const out = { role: m.role, content: m.content, at: m.at };
      if (m.sync) out.sync = m.sync;
      if (m.meta) out.meta = m.meta;
      if (m.actions) out.actions = m.actions;
      if (m.shots) out.shots = m.shots;          // thumbnails only: the full images are never stored
      if (m.files) out.files = m.files;
      if (m.skill) out.skill = m.skill;
      if (m.snapshotRef) out.snapshotRef = m.snapshotRef;
      if (m.snapshot) {
        const { text, ...rest } = m.snapshot;
        out.snapshot = rest;
      }
      return out;
    });
    const list = this.readChats();
    const now = Date.now();
    const existing = list.find((c) => c.id === this.conv.id);
    // Which agent the chat was with, and the skills it activated: loading it brings both back.
    const extra = { agent: this.agentName || '', skills: [...this.conv.skills] };
    if (existing) Object.assign(existing, { title: this.deriveTitle(), updatedAt: now, messages, ...extra });
    else list.push({ id: this.conv.id, title: this.deriveTitle(), createdAt: now, updatedAt: now, messages, page: this.ctx.page?.id || '', ...extra });
    list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    this.writeChats(list.slice(0, CHAT_LIMIT));
    this.writeSession({ chat: this.conv.id });
    this.renderLibrary();
  }

  renderLibrary() {
    const list = this.readChats();
    this.$.libraryCount.textContent = list.length === 1 ? '1 chat' : `${list.length} chats`;
    this.armed = null;
    if (!list.length) {
      this.$.libraryList.innerHTML = '<p class="aia-library-empty">No saved chats yet. Conversations are saved here automatically.</p>';
      return;
    }
    this.$.libraryList.innerHTML = list.map((c) => {
      const n = (c.messages || []).length;
      const meta = `${n} message${n === 1 ? '' : 's'} · ${formatWhen(c.updatedAt || c.createdAt)}`;
      return `<div class="aia-saved${c.id === this.conv.id ? ' aia-active' : ''}">
        <button type="button" class="aia-saved-open" data-chat-open="${esc(c.id)}"><span class="aia-saved-title">${esc(c.title || 'New chat')}</span><span class="aia-saved-meta">${esc(meta)}</span></button>
        <button type="button" class="aia-saved-delete" data-chat-delete="${esc(c.id)}" title="Delete this chat" aria-label="Delete ${esc(c.title || 'chat')}">${ICONS.trash}</button>
      </div>`;
    }).join('');
  }

  setLibraryOpen(next) {
    this.$.library.hidden = !next;
    this.$.libraryBtn.setAttribute('aria-expanded', String(next));
    this.$.libraryBtn.classList.toggle('aia-active', next);
    if (next) this.renderLibrary();
  }

  /** Two-step delete: the first click arms the button, the second deletes. */
  armDelete(btn) {
    const id = btn.dataset.chatDelete;
    if (this.armed !== id) {
      this.$.libraryList.querySelectorAll('.aia-armed').forEach((b) => b.classList.remove('aia-armed'));
      this.armed = id;
      btn.classList.add('aia-armed');
      btn.title = 'Click again to delete';
      return;
    }
    this.writeChats(this.readChats().filter((c) => c.id !== id));
    if (id === this.conv.id) this.conv.id = null;
    this.renderLibrary();
  }

  loadChat(id, { focus = true } = {}) {
    if (this.streaming) return;
    this.allowedTools.clear();
    const record = this.readChats().find((c) => c.id === id);
    if (!record) { this.renderLibrary(); return; }
    this.conv = {
      id: record.id,
      messages: (record.messages || []).map((m) => ({ ...m, id: uid(m.role === 'user' ? 'u' : 'a'), role: m.role === 'user' ? 'user' : 'assistant', content: String(m.content || '') })),
      skills: Array.isArray(record.skills) ? record.skills.map(String) : [],
    };
    // The chat's agent comes back with it (when it still exists).
    if (typeof record.agent === 'string' && record.agent !== this.agentName && (record.agent === '' || this.agents().some((a) => a.name === record.agent))) {
      this.agentName = record.agent;
      this.writeSession({ agent: this.agentName });
      this.renderAgentPick();
    }
    this.resetMessages();
    if (!this.conv.messages.length) this.addNotice('This chat is empty. Ask a question to start it off.');
    for (const m of this.conv.messages) {
      if (m.role === 'user') this.renderUser(m);
      else this.addSavedReply(m);
    }
    this.setLibraryOpen(false);
    this.writeSession({ chat: this.conv.id });
    this.refreshStatus();
    this.scrollToEnd(true);
    if (focus) this.$.input.focus();
  }

  resetMessages() {
    this.$.messages.innerHTML = '';
    this.replies.clear();
    this.fileRecords.clear();
    this.closeFile();
  }

  newChat({ save = true } = {}) {
    if (this.streaming) this.stop();
    this.allowedTools.clear();
    if (save) this.persist();
    this.conv = { id: null, messages: [], skills: [] };
    this.writeSession({ chat: null });
    this.forceReread = false;
    this.resetMessages();
    this.welcome();
    this.setLibraryOpen(false);
    this.renderLibrary();
    this.refreshStatus();
    if (this.openState) this.$.input.focus();
  }

  /* ============================================================ teardown */

  destroy() {
    this.stop();
    this.capture?.stop();
    if (this.onOutside) document.removeEventListener('pointerdown', this.onOutside, true);
    this.stopWatch();
    clearTimeout(this.layoutTimer);
    for (const fn of this.cleanups) { try { fn(); } catch { /* ignore */ } }
    for (const target of resolveElements(this.o.push)) target.classList.remove('aia-pushed');
    document.documentElement.classList.remove('aia-drawer-open');
    this.launcher?.remove();
    this.el.remove();
  }
}
