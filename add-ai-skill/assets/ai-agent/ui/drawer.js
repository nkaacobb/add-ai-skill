// The chat drawer: slides in from the right, streams replies as rich Markdown, shows the context-sync flag, and
// keeps saved conversations. Everything application-specific arrives through options and the ContextManager.

import { streamChat, listModels, resolveTarget } from '../core/client.js';
import { planTurn, contextState, buildRequestMessages, snapshotBlock } from '../core/conversation.js';
import {
  REQUEST_TOOL, classifyTools, toolSpecs, requestToolSpec, buildToolPrompt, parseTextToolCalls, textTurnMessages,
  validateArgs, toolEnabled, toolAvailable, serializeResult, formatCall,
} from '../core/tools.js';
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
    this.conv = { id: null, messages: [] };
    this.replies = new Map();
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
      <div class="aia-title-text"><h2>${esc(o.title)}</h2><p data-el="subtitle">…</p></div>
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
    <textarea data-el="input" rows="1" placeholder="${esc(o.placeholder)}" aria-label="Message the ${esc(o.title)}"></textarea>
    <button type="submit" class="aia-btn aia-btn-primary aia-send" data-el="send" title="Send (Enter)" aria-label="Send">${ICONS.send}</button>
  </form>
</aside>`);
    (resolveElement(o.mount) || document.body).appendChild(this.el);

    const q = (name) => this.el.querySelector(`[data-el="${name}"]`);
    this.$ = {
      subtitle: q('subtitle'), ctxText: q('ctxText'), ctxHash: q('ctxHash'), ctxBar: this.el.querySelector('.aia-context'),
      library: q('library'), libraryList: q('libraryList'), libraryCount: q('libraryCount'),
      messages: q('messages'), form: q('form'), input: q('input'), send: q('send'),
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
    this.welcome();
    this.renderLibrary();
    this.refreshSubtitle();
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
      if (this.streaming) this.stop(); else this.close();
    }
  }

  /** Keys pressed inside the drawer (key isolation on): the hotkey and Escape, handled before propagation stops. */
  onOwnKey(e) {
    if (this.hotkeyMatches(e)) { e.preventDefault(); e.stopPropagation(); this.toggle(); return; }
    if (e.key === 'Escape' && this.openState && !this.panel.isOpen()) {
      e.preventDefault();
      e.stopPropagation();
      if (this.streaming) this.stop(); else this.close();
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

    const suggestion = t.closest('[data-aia-suggest]');
    if (suggestion) return this.send(suggestion.dataset.aiaSuggest);

    const chatOpen = t.closest('[data-chat-open]');
    if (chatOpen) return this.loadChat(chatOpen.dataset.chatOpen);
    const chatDelete = t.closest('[data-chat-delete]');
    if (chatDelete) return this.armDelete(chatDelete);

    const codeBtn = t.closest('[data-aia-code-action]');
    if (codeBtn) return this.runCodeAction(codeBtn);
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
    const reply = this.replyFor(btn);
    if (!reply || !reply.markdown) return;
    const id = btn.dataset.aiaReplyAction;
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

  welcome() {
    const o = this.o;
    const wrap = this.addWrap('assistant');
    wrap.classList.add('aia-welcome');
    const md = renderMarkdown(o.welcome || '');
    const chips = (o.suggestions || []).map((s) => `<button type="button" class="aia-chip" data-aia-suggest="${esc(s)}">${esc(s)}</button>`).join('');
    wrap.querySelector('.aia-bubble').innerHTML = `<div class="aia-md">${md.html}</div>${chips ? `<div class="aia-chips">${chips}</div>` : ''}`;
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
    const chip = this.syncChip(m);
    if (chip) wrap.appendChild(h(`<div class="aia-msg-meta">${chip}</div>`));
    this.scrollToEnd(true);
    return wrap;
  }

  /** Assistant message scaffold: notice line, collapsible reasoning, text, actions. */
  addAssistantView() {
    const wrap = this.addWrap('assistant');
    const actions = [{ id: 'copy', label: 'Copy' }, ...(this.o.replyActions || [])]
      .map((a) => `<button type="button" class="aia-msg-action" data-aia-reply-action="${esc(a.id)}"${a.title ? ` title="${esc(a.title)}"` : ''}>${esc(a.label)}</button>`).join('');
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
    for (const a of Array.isArray(m.actions) ? m.actions : []) this.setChip(this.addChip(view, a.title || a.call, a.call), a.status, a.summary || '');
    this.paint(view);
    view.actions.hidden = false;
    if (m.meta) { view.foot.hidden = false; view.foot.textContent = m.meta; }
    return view;
  }

  /* =============================================================== tools */

  /** 'off' (no tools registered), 'native' tool calls, or 'text' tool blocks. */
  toolMode(settings) {
    if (!this.o.toolRegistry?.all().length) return 'off';
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
    const classes = classifyTools(this.o.toolRegistry.all(), settings, this.ctx.page?.id);
    return buildToolPrompt({ classes, mode, enabled: settings.toolsEnabled });
  }

  addChip(view, title, call) {
    view.toolLog.hidden = false;
    const chip = h(`<div class="aia-tool" data-status="running">
      <div class="aia-tool-line"><span class="aia-tool-dot" aria-hidden="true"></span><span class="aia-tool-title">${esc(title)}</span><code class="aia-tool-call">${esc(call)}</code><span class="aia-tool-state"></span></div>
      <div class="aia-tool-card" hidden></div>
    </div>`);
    view.toolLog.appendChild(chip);
    this.scrollToEnd();
    return chip;
  }

  setChip(chip, status, detail = '') {
    const words = { running: 'Running…', waiting: 'Waiting for you', ok: 'Done', error: 'Failed', declined: 'Declined', off: 'Turned off', skipped: 'Skipped' };
    chip.dataset.status = status;
    const state = chip.querySelector('.aia-tool-state');
    state.textContent = words[status] || status;
    state.title = detail ? String(detail).slice(0, 600) : '';
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
    this.store.save({ toolStates: { [name]: !!on } });
    this.emit('tool-state', { name, enabled: !!on });
  }

  /**
   * Run one tool call from the model: availability, on/off state, arguments, confirmation, then the app's own
   * function. Returns { id, name, content, changed } — content is what the model reads.
   */
  async executeTool(call, { view, signal, actions }) {
    const reg = this.o.toolRegistry;
    const result = (content, changed = false) => ({ id: call.id, name: call.name, content, changed });

    if (call.name === REQUEST_TOOL) {
      const want = reg.get(String(call.arguments?.name || ''));
      if (!want) return result(`There is no tool named "${call.arguments?.name}".`);
      if (toolEnabled(want, this.store.get())) return result(`${want.name} is already turned on: call it.`);
      const chip = this.addChip(view, `Turn on ${want.title}`, formatCall(want.name, {}));
      const reason = call.arguments?.reason ? `<br><span class="aia-tool-reason">${esc(String(call.arguments.reason).slice(0, 300))}</span>` : '';
      const choice = await this.decide(chip, `The agent wants to use <b>${esc(want.title)}</b>, which is turned off.${reason}`, [
        { id: 'on', label: 'Turn on', primary: true }, { id: 'off', label: 'Keep off' },
      ], signal);
      if (choice === 'on') {
        this.setToolEnabled(want.name, true);
        this.setChip(chip, 'ok', 'Turned on');
        chip.querySelector('.aia-tool-state').textContent = 'Turned on';
        actions.push({ call: `turn on ${want.name}`, title: `Turn on ${want.title}`, status: 'ok' });
        return result(`The user turned on ${want.name}. You can call it now.`);
      }
      this.setChip(chip, 'off');
      actions.push({ call: `turn on ${want.name}`, title: `Turn on ${want.title}`, status: 'declined' });
      return result(`The user kept ${want.name} turned off. Do not call it; explain how they can do it themselves, or that they can turn it on in Settings > Tools.`);
    }

    const tool = reg.get(call.name);
    if (!tool) return result(`There is no tool named "${call.name}". Use only the tools you were given.`);
    const settings = this.store.get();
    const v = validateArgs(tool, call.arguments);
    const chip = this.addChip(view, tool.title, formatCall(tool.name, v.args));
    const record = (status, summary = '') => {
      this.setChip(chip, status, summary);
      actions.push({ call: formatCall(tool.name, v.args), title: tool.title, status, summary: String(summary).slice(0, 200) });
      this.emit('tool', { name: tool.name, args: v.args, status, result: summary });
    };

    if (!settings.toolsEnabled) { record('off'); return result('Tools are switched off by the user (Settings > Tools).'); }
    let consented = false;
    if (!toolEnabled(tool, settings)) {
      const choice = await this.decide(chip, `<b>${esc(tool.title)}</b> is turned off. Turn it on and run it?`, [
        { id: 'on', label: 'Turn on and run', primary: true }, { id: 'off', label: 'Keep off' },
      ], signal);
      if (choice !== 'on') { record('off'); return result(`${tool.name} is turned off and the user kept it off. Do not call it again.`); }
      this.setToolEnabled(tool.name, true);
      consented = true;
    }
    if (!toolAvailable(tool, this.ctx.page?.id)) {
      record('skipped', 'Not available on this screen');
      return result(`${tool.name} is not available on this screen${tool.pages.length ? ` (it works on: ${tool.pages.join(', ')})` : ''}.`);
    }
    if (!v.ok) { record('error', v.errors.join('; ')); return result(`Invalid arguments: ${v.errors.join('; ')}. Check the tool's parameters and try again.`); }

    const ask = tool.effect === 'destructive' ? settings.confirmDestructive
      : tool.effect === 'write' ? settings.confirmWrites && !this.allowedTools.has(tool.name) : false;
    if (ask && !consented) {
      const buttons = [{ id: 'run', label: 'Run', primary: true }];
      if (tool.effect === 'write') buttons.push({ id: 'chat', label: 'Allow for this chat' });
      buttons.push({ id: 'skip', label: 'Skip' });
      const what = tool.effect === 'destructive' ? 'This removes or overwrites something.' : 'This changes the application.';
      const choice = await this.decide(chip, `Run <b>${esc(tool.title)}</b>? ${what}`, buttons, signal);
      if (choice === 'cancel') { record('skipped'); return result('Stopped by the user.'); }
      if (choice === 'skip') { record('declined'); return result(`The user declined to run ${tool.name}. Do not call it again for this request.`); }
      if (choice === 'chat') this.allowedTools.add(tool.name);
    }

    this.setChip(chip, 'running');
    view.status = `Running ${tool.title}…`;
    view.paint();
    try {
      let timer;
      const value = await Promise.race([
        Promise.resolve().then(() => tool.run(v.args, { agent: this.api, signal, call: { id: call.id, name: tool.name } })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no result after ${Math.round(tool.timeoutMs / 1000)} s`)), tool.timeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      const content = serializeResult(value);
      record('ok', content);
      return result(content, tool.effect !== 'read');
    } catch (e) {
      const msg = String(e?.message || e);
      record('error', msg);
      return result(`Error: ${msg}`, tool.effect !== 'read');
    }
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
      const classes = mode === 'off' ? { callable: [], off: [], elsewhere: [] } : classifyTools(this.o.toolRegistry.all(), s, this.ctx.page?.id);
      const toolsText = mode === 'off' ? '' : buildToolPrompt({ classes, mode, enabled: s.toolsEnabled });
      const native = mode === 'native' && s.toolsEnabled;
      const specs = native ? [...toolSpecs(classes.callable), ...(classes.off.length ? [requestToolSpec(classes.off)] : [])] : [];
      const stepStart = view.raw.length;
      const nativeStart = view.native.length;
      try {
        result = await streamChat({
          settings,
          keyFor: this.keyFor,
          system: buildSystemPrompt({ ...baseSystem, toolsText }),
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
        throw e;
      }

      const stepRaw = view.raw.slice(stepStart);
      let stepText = splitReasoning(stepRaw).text.trim();
      let calls = result.toolCalls || [];
      if (mode === 'text' && s.toolsEnabled) {
        const parsed = parseTextToolCalls(stepText, `t${step}_`);
        calls = parsed.calls;
        if (calls.length) {
          view.raw = view.raw.slice(0, stepStart) + parsed.text;
          stepText = parsed.text;
          this.paint(view);
        }
      }
      if (!calls.length || mode === 'off') {
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
      if (step >= s.maxToolSteps) {
        view.notice.textContent = `Stopped after ${s.maxToolSteps} tool steps (Settings > Tools > Max tool steps).`;
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
      if (changed && settings.shareScreen && this.ctx.hasContent && results.length) {
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
      toolTurns.push({ text: stepText, calls, results: results.map(({ id, name, content }) => ({ id, name, content })) });
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
    const text = this.$.input.value.trim();
    if (!text) return;
    this.$.input.value = '';
    this.autoGrow();
    this.send(text);
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

  async send(rawText) {
    const text = String(rawText ?? '').trim();
    if (!text) return;
    if (this.streaming) { this.addNotice('Still answering the previous question — press Stop or wait a moment.', true); return; }
    this.setOpen(true);
    this.setLibraryOpen(false);
    if (this.ready) { try { await this.ready; } catch { /* keep the defaults as they were */ } }
    const settings = this.store.get();
    this.ctx.setMaxChars(settings.maxContextChars);

    // Configuration problems (missing key/model) are reported before anything is added to the conversation.
    try {
      resolveTarget(settings, this.keyFor);
    } catch (e) {
      this.renderError(this.addWrap('assistant'), e, settings);
      return;
    }

    const controller = new AbortController();
    this.streaming = { controller };
    this.setStreaming(true);
    this.stick = true;

    const share = !!settings.shareScreen;
    const snapshot = share && this.ctx.hasContent ? await this.ctx.snapshot() : null;
    const plan = planTurn({ messages: this.conv.messages, snapshot, historyMessages: settings.historyMessages, share, force: this.forceReread });
    const userMsg = { id: uid('u'), role: 'user', content: text, at: Date.now(), sync: plan.attach ? 'attached' : plan.reason };
    if (plan.attach) {
      userMsg.snapshot = {
        hash: snapshot.hash, text: snapshot.text, pageId: snapshot.pageId, pageTitle: snapshot.pageTitle,
        chars: snapshot.chars, totalChars: snapshot.totalChars, truncated: snapshot.truncated, at: snapshot.at,
      };
    } else if (plan.reason === 'unchanged') {
      userMsg.snapshotRef = snapshot.hash;
    }
    this.forceReread = false;
    this.conv.messages.push(userMsg);
    const userWrap = this.renderUser(userMsg);
    this.refreshStatus(snapshot);

    const [appText, pageText, viewText] = await Promise.all([this.ctx.appText(), this.ctx.pageText(), share ? this.ctx.viewText() : '']);
    const baseSystem = { base: this.effectivePrompt(settings), appText, pageText, share };
    const messages = buildRequestMessages({
      messages: this.conv.messages,
      historyMessages: settings.historyMessages,
      viewText,
      unchangedHash: plan.reason === 'unchanged' ? snapshot.hash : null,
    });

    const view = this.addAssistantView();
    view.status = `Contacting ${provider(settings.provider).label}…`;
    this.paint(view);
    this.emit('send', { text, attached: plan.attach, reason: plan.reason, hash: snapshot?.hash || null });

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
    const share = !!settings.shareScreen;
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
      this.probeInfo = { key, text, loaded, at: Date.now() };
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
    for (let n = list.length; n > 0; n = Math.floor(n * 0.7)) {
      try { this.o.storage.setItem(this.chatsKey, JSON.stringify(list.slice(0, n))); return true; } catch { /* shrink and retry */ }
    }
    return false;
  }

  deriveTitle() {
    const first = this.conv.messages.find((m) => m.role === 'user');
    const t = String(first?.content || '').replace(/\s+/g, ' ').trim();
    return !t ? 'New chat' : t.length > 48 ? `${t.slice(0, 47).trim()}…` : t;
  }

  /** Save the transcript. Snapshot TEXT is not kept (it can be large); fingerprints and titles are. */
  persist() {
    if (!this.conv.messages.length || this.o.saveChats === false) return;
    if (!this.conv.id) this.conv.id = uid('c');
    const messages = this.conv.messages.slice(-MESSAGE_LIMIT).map((m) => {
      const out = { role: m.role, content: m.content, at: m.at };
      if (m.sync) out.sync = m.sync;
      if (m.meta) out.meta = m.meta;
      if (m.actions) out.actions = m.actions;
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
    if (existing) Object.assign(existing, { title: this.deriveTitle(), updatedAt: now, messages });
    else list.push({ id: this.conv.id, title: this.deriveTitle(), createdAt: now, updatedAt: now, messages, page: this.ctx.page?.id || '' });
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
    };
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
  }

  newChat() {
    if (this.streaming) this.stop();
    this.allowedTools.clear();
    this.persist();
    this.conv = { id: null, messages: [] };
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
    this.stopWatch();
    clearTimeout(this.layoutTimer);
    for (const fn of this.cleanups) { try { fn(); } catch { /* ignore */ } }
    for (const target of resolveElements(this.o.push)) target.classList.remove('aia-pushed');
    document.documentElement.classList.remove('aia-drawer-open');
    this.launcher?.remove();
    this.el.remove();
  }
}
