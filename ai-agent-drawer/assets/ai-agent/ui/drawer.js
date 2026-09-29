// The chat drawer: slides in from the right, streams replies as rich Markdown, shows the context-sync flag, and
// keeps saved conversations. Everything application-specific arrives through options and the ContextManager.

import { streamChat, listModels, resolveTarget } from '../core/client.js';
import { planTurn, contextState, buildRequestMessages } from '../core/conversation.js';
import { buildSystemPrompt } from '../core/prompt.js';
import { splitReasoning } from '../core/reasoning.js';
import { shortHash } from '../core/hash.js';
import { provider } from '../core/providers.js';
import { profileFor } from '../core/settings.js';
import { renderMarkdown } from './markdown.js';
import { attachResize } from './resize.js';
import { ICONS } from './icons.js';
import { esc, h, copyText, flash, formatWhen, uid, nf, frameThrottle, resolveElements, resolveElement } from './dom.js';

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
    if (s.open) this.setOpen(true, { focus: false });
  }

  bindToggles() {
    this.toggles = resolveElements(this.o.toggle);
    if (!this.toggles.length && this.o.launcher !== false) {
      this.launcher = h(`<button type="button" class="aia-scope aia-launcher" title="${esc(this.o.title)} (Ctrl+I)" aria-label="Open ${esc(this.o.title)}">${ICONS.spark}<span class="aia-launcher-dot" aria-hidden="true"></span></button>`);
      document.body.appendChild(this.launcher);
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

  setOpen(next, { focus = true } = {}) {
    if (next === this.openState) return;
    this.openState = next;
    if (!next && this.el.contains(document.activeElement)) document.activeElement.blur();
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
      if (focus) setTimeout(() => this.$.input.focus(), 60);
      this.scrollToEnd(true);
      this.startWatch();
    } else {
      this.stopWatch();
    }
    this.emit(next ? 'open' : 'close', {});
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
    this.paint(view);
    view.actions.hidden = false;
    if (m.meta) { view.foot.hidden = false; view.foot.textContent = m.meta; }
    return view;
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
    const system = buildSystemPrompt({ base: this.effectivePrompt(settings), appText, pageText, share });
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
    try {
      result = await streamChat({
        settings,
        keyFor: this.keyFor,
        system,
        messages,
        signal: controller.signal,
        relayHeaders: this.o.relayHeaders,
        onEvent: (e) => {
          if (e.type === 'text') view.raw += e.text;
          else if (e.type === 'reasoning') view.native += e.text;
          else if (e.type === 'notice') { view.notice.textContent = e.text; view.notice.hidden = false; }
          else if (e.type === 'status') view.status = e.text;
          view.paint();
        },
      });
    } catch (e) {
      error = e;
    }
    this.$.messages.removeEventListener('scroll', onScroll);

    view.done = true;
    this.paint(view);
    const answer = view.answer.trim();
    const cancelled = error?.code === 'cancelled';

    if (answer) {
      const who = result ? `${result.label}${result.model ? ` · ${result.model}` : this.probeInfo.loaded ? ` · ${this.probeInfo.loaded}` : ''}` : '';
      const meta = cancelled ? 'Stopped' : who;
      if (meta) { view.foot.hidden = false; view.foot.textContent = meta; }
      view.actions.hidden = false;
      this.conv.messages.push({ id: uid('a'), role: 'assistant', content: cancelled ? `${answer}\n\n_(stopped)_` : answer, at: Date.now(), meta });
      if (error && !cancelled) this.renderError(this.addWrap('assistant'), error, settings);
      this.emit('reply', { text: answer, provider: result?.provider, model: result?.model, stopped: cancelled });
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
    for (const fn of this.cleanups) { try { fn(); } catch { /* ignore */ } }
    for (const target of resolveElements(this.o.push)) target.classList.remove('aia-pushed');
    document.documentElement.classList.remove('aia-drawer-open');
    this.launcher?.remove();
    this.el.remove();
  }
}
