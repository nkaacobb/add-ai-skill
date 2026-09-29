// Settings modal: Model (provider, address, model, key, connection test, relay/fallback), Agent (system prompt and
// generation options) and Context (a read-only view of exactly what the application's hooks give the agent).
// Edits are held in a draft and written on Save; "Load models" and "Test connection" use the draft, so a setup can
// be tried before it is kept.

import { PROVIDERS, PROVIDER_IDS, provider, transmissionNote } from '../core/providers.js';
import { profileFor, sanitizeSettings, validUrl } from '../core/settings.js';
import { listModels, testConnection } from '../core/client.js';
import { shortHash } from '../core/hash.js';
import { ICONS } from './icons.js';
import { esc, h, nf, uid } from './dom.js';

const STATE_TEXT = {
  synced: 'The agent has the current screen.',
  dirty: 'The screen changed since the agent last saw it. It will re-read it with your next message.',
  unread: 'The agent has not seen this screen in this conversation yet. It will read it with your next message.',
  none: 'This page does not share any content with the agent.',
  off: 'Screen sharing is switched off (Agent tab).',
};

export function createSettingsPanel({ store, defaultPrompt, getContextInfo, relayHeaders, theme = 'auto', mount = document.body, title = 'AI agent' }) {
  const id = uid('aia');
  const root = h(`
<div class="aia-scope aia-modal" hidden${theme !== 'auto' ? ` data-aia-theme="${esc(theme)}"` : ''}>
  <div class="aia-modal-scrim" data-dismiss></div>
  <div class="aia-modal-card" role="dialog" aria-modal="true" aria-labelledby="${id}-title">
    <header class="aia-modal-head">
      <div class="aia-modal-title">
        <span class="aia-mark">${ICONS.gear}</span>
        <div><h2 id="${id}-title">${esc(title)} settings</h2><p>Saved in this browser only. Nothing is written to the server.</p></div>
      </div>
      <button type="button" class="aia-icon-btn" data-act="close" title="Close" aria-label="Close settings">${ICONS.close}</button>
    </header>
    <div class="aia-tabs" role="tablist" aria-label="Settings sections">
      <button type="button" role="tab" class="aia-tab" data-tab="model" id="${id}-t-model" aria-controls="${id}-p-model" aria-selected="true">Model</button>
      <button type="button" role="tab" class="aia-tab" data-tab="agent" id="${id}-t-agent" aria-controls="${id}-p-agent" aria-selected="false">Agent</button>
      <button type="button" role="tab" class="aia-tab" data-tab="context" id="${id}-t-context" aria-controls="${id}-p-context" aria-selected="false">Context</button>
    </div>
    <div class="aia-modal-body">

      <section class="aia-panel" data-panel="model" role="tabpanel" id="${id}-p-model" aria-labelledby="${id}-t-model">
        <div class="aia-section">
          <label class="aia-field"><span class="aia-label">Provider</span><select data-f="provider"></select></label>
          <p class="aia-note" data-f="providerNote"></p>
          <p class="aia-note aia-transmit" data-f="transmit"></p>
        </div>
        <div class="aia-section">
          <label class="aia-field"><span class="aia-label">Server address</span>
            <span class="aia-row"><input type="url" data-f="baseUrl" spellcheck="false" autocomplete="off"><button type="button" class="aia-btn aia-btn-ghost" data-act="resetUrl" title="Use the provider's default address">Default</button></span>
          </label>
          <label class="aia-field"><span class="aia-label">Model</span>
            <span class="aia-row"><input type="text" data-f="model" list="${id}-models" spellcheck="false" autocomplete="off"><button type="button" class="aia-btn aia-btn-ghost" data-act="loadModels">Load models</button></span>
          </label>
          <datalist id="${id}-models" data-f="modelList"></datalist>
          <p class="aia-note" data-f="modelHint"></p>
        </div>
        <div class="aia-section" data-f="keySection">
          <label class="aia-field"><span class="aia-label">API key <span class="aia-label-soft" data-f="keyOptional">(optional)</span></span>
            <span class="aia-row"><input type="password" data-f="apiKey" spellcheck="false" autocomplete="off" placeholder="Paste the key"><button type="button" class="aia-btn aia-btn-ghost" data-act="revealKey" aria-pressed="false">Show</button></span>
          </label>
          <label class="aia-check"><input type="checkbox" data-f="rememberKeys"><span>Remember API keys on this device (otherwise they are forgotten when this tab closes)</span></label>
          <p class="aia-note" data-f="keyHint"></p>
        </div>
        <div class="aia-section">
          <div class="aia-row aia-row-center"><button type="button" class="aia-btn" data-act="test">Test connection</button><span class="aia-test-result" data-f="testResult" role="status" aria-live="polite"></span></div>
        </div>
        <details class="aia-section aia-advanced">
          <summary>Advanced</summary>
          <div class="aia-advanced-body">
            <div class="aia-field"><span class="aia-label">Send requests</span>
              <label class="aia-check"><input type="radio" name="${id}-transport" value="direct" data-f="transportDirect"><span>Directly from this browser to the provider</span></label>
              <label class="aia-check"><input type="radio" name="${id}-transport" value="relay" data-f="transportRelay"><span>Through the application's relay (keys can stay on the server; no CORS issues)</span></label>
            </div>
            <label class="aia-field"><span class="aia-label">Relay address</span><input type="text" data-f="relayUrl" spellcheck="false" autocomplete="off" placeholder="e.g. /ai-relay or api/relay.php"></label>
            <label class="aia-field"><span class="aia-label">If the provider cannot be reached, fall back to</span><select data-f="fallbackProvider"></select></label>
            <label class="aia-field"><span class="aia-label">Timeout (seconds without a response)</span><input type="number" min="10" max="900" step="5" data-f="timeoutSec"></label>
          </div>
        </details>
      </section>

      <section class="aia-panel" data-panel="agent" role="tabpanel" id="${id}-p-agent" aria-labelledby="${id}-t-agent" hidden>
        <div class="aia-section">
          <div class="aia-label-row"><span class="aia-label">System prompt</span><button type="button" class="aia-btn aia-btn-ghost aia-btn-sm" data-act="resetPrompt">Restore app default</button></div>
          <textarea data-f="systemPrompt" rows="12" spellcheck="true"></textarea>
          <p class="aia-note">Who the agent is and how it should answer. The application description, the current page and the screen-content rules are added after it automatically — see the Context tab.</p>
        </div>
        <div class="aia-section aia-grid">
          <label class="aia-field"><span class="aia-label">Temperature</span><input type="number" min="0" max="2" step="0.1" data-f="temperature"></label>
          <label class="aia-field"><span class="aia-label">Max reply tokens</span><input type="number" min="64" max="64000" step="64" data-f="maxOutputTokens"></label>
          <label class="aia-field"><span class="aia-label">Thinking</span><select data-f="reasoning">
            <option value="show">Show the model's thinking</option>
            <option value="hide">Hide it</option>
            <option value="off">Ask the model not to think</option>
          </select></label>
          <label class="aia-field"><span class="aia-label">Conversation memory (messages)</span><input type="number" min="2" max="200" step="1" data-f="historyMessages"></label>
        </div>
        <div class="aia-section">
          <label class="aia-check"><input type="checkbox" data-f="shareScreen"><span>Share what is on screen with the agent</span></label>
          <label class="aia-field"><span class="aia-label">Max screen content (characters)</span><input type="number" min="1000" max="400000" step="1000" data-f="maxContextChars"></label>
          <p class="aia-note">Larger pages are cut to this size (the agent is told when that happens). About 4 characters make one token.</p>
        </div>
      </section>

      <section class="aia-panel" data-panel="context" role="tabpanel" id="${id}-p-context" aria-labelledby="${id}-t-context" hidden>
        <div class="aia-section aia-ctx-status" data-f="ctxStatus"></div>
        <div class="aia-section"><h3 class="aia-h3">Application</h3><p class="aia-note">From the <code>app</code> option / <code>agent.setApp()</code>. Sent in the system prompt.</p><pre class="aia-pre" data-f="ctxApp"></pre></div>
        <div class="aia-section"><h3 class="aia-h3">Current page</h3><p class="aia-note">From <code>agent.setPage()</code>. Sent in the system prompt.</p><pre class="aia-pre" data-f="ctxPage"></pre></div>
        <div class="aia-section"><h3 class="aia-h3">View state</h3><p class="aia-note">From the page's <code>view</code> hook. Sent with every question; not fingerprinted.</p><pre class="aia-pre" data-f="ctxView"></pre></div>
        <div class="aia-section"><h3 class="aia-h3">Screen snapshot</h3><p class="aia-note" data-f="ctxSnapMeta"></p><pre class="aia-pre aia-pre-tall" data-f="ctxSnap"></pre></div>
        <details class="aia-section"><summary>Full system prompt as sent</summary><pre class="aia-pre aia-pre-tall" data-f="ctxSystem"></pre></details>
      </section>

    </div>
    <footer class="aia-modal-foot">
      <span class="aia-status" data-f="status" role="status" aria-live="polite"></span>
      <button type="button" class="aia-btn aia-btn-ghost" data-act="resetAll">Restore defaults</button>
      <button type="button" class="aia-btn aia-btn-primary" data-act="save">Save</button>
    </footer>
  </div>
</div>`);
  mount.appendChild(root);

  const f = (name) => root.querySelector(`[data-f="${name}"]`);
  const act = (name) => root.querySelector(`[data-act="${name}"]`);

  let draft = null;
  let draftKeys = {};
  let formProvider = 'lmstudio';
  let currentTab = 'model';
  let closeTimer = null;
  let returnFocus = null;
  let listTicket = 0;

  /* ------------------------------------------------------------ rendering */

  function providerOptions(selectEl, { includeNone = false, exclude = '' } = {}) {
    const groups = {};
    for (const pid of PROVIDER_IDS) {
      if (pid === exclude) continue;
      const p = PROVIDERS[pid];
      (groups[p.group] ||= []).push(p);
    }
    let html = includeNone ? '<option value="">No fallback</option>' : '';
    for (const [group, list] of Object.entries(groups)) {
      html += `<optgroup label="${esc(group)}">${list.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join('')}</optgroup>`;
    }
    selectEl.innerHTML = html;
  }

  function setStatus(message, kind = '') {
    f('status').textContent = message || '';
    f('status').className = `aia-status${kind ? ` aia-${kind}` : ''}`;
  }

  function setTest(message, kind = '') {
    f('testResult').textContent = message || '';
    f('testResult').className = `aia-test-result${kind ? ` aia-${kind}` : ''}`;
  }

  function keyFor(pid) {
    return Object.prototype.hasOwnProperty.call(draftKeys, pid) ? draftKeys[pid] : store.keys.get(pid);
  }

  function loadProviderFields(pid) {
    const p = provider(pid);
    const prof = profileFor(draft, pid);
    f('baseUrl').value = prof.baseUrl;
    f('baseUrl').placeholder = p.baseUrl;
    f('model').value = prof.model;
    f('model').placeholder = p.placeholder || 'model id';
    f('modelList').innerHTML = '';
    f('apiKey').value = keyFor(pid);
    f('apiKey').type = 'password';
    act('revealKey').textContent = 'Show';
    act('revealKey').setAttribute('aria-pressed', 'false');
    syncProviderText();
    setTest('');
  }

  function syncProviderText() {
    const p = provider(formProvider);
    f('providerNote').textContent = p.note || '';
    f('providerNote').hidden = !p.note;
    f('transmit').textContent = transmissionNote(p.id, f('baseUrl').value.trim() || p.baseUrl);
    f('transmit').classList.toggle('aia-warn', p.kind === 'cloud');
    const showKey = p.keyRequired || p.keyOptional;
    f('keySection').hidden = !showKey;
    f('keyOptional').hidden = p.keyRequired;
    f('keyHint').innerHTML = p.keyRequired
      ? `${p.consoleUrl ? `Get a key at <a href="${esc(p.consoleUrl)}" target="_blank" rel="noopener noreferrer">${esc(new URL(p.consoleUrl).host)}</a>. ` : ''}With the relay, the key can instead live on the server${p.keyEnv ? ` (<code>${esc(p.keyEnv)}</code>)` : ''}.`
      : 'Only needed if you protected the local server with a token.';
    f('modelHint').textContent = p.id === 'lmstudio'
      ? 'Leave empty to use whatever model LM Studio has loaded. "Load models" lists what is installed.'
      : p.modelRequired ? 'Type a model id, or use "Load models" to pick from what the provider offers.' : '';
    providerOptions(f('fallbackProvider'), { includeNone: true, exclude: formProvider });
    f('fallbackProvider').value = draft.fallbackProvider && draft.fallbackProvider !== formProvider ? draft.fallbackProvider : '';
  }

  function commitProviderFields() {
    draft.profiles = draft.profiles || {};
    draft.profiles[formProvider] = { baseUrl: f('baseUrl').value.trim(), model: f('model').value.trim() };
    draftKeys[formProvider] = f('apiKey').value.trim();
  }

  function fill() {
    draft = store.get();
    draftKeys = {};
    formProvider = draft.provider;
    providerOptions(f('provider'));
    f('provider').value = formProvider;
    loadProviderFields(formProvider);
    f('rememberKeys').checked = draft.rememberKeys;
    f('transportDirect').checked = draft.transport !== 'relay';
    f('transportRelay').checked = draft.transport === 'relay';
    f('relayUrl').value = draft.relayUrl;
    f('timeoutSec').value = draft.timeoutSec;
    f('systemPrompt').value = draft.systemPrompt || defaultPrompt();
    f('temperature').value = draft.temperature;
    f('maxOutputTokens').value = draft.maxOutputTokens;
    f('reasoning').value = draft.reasoning;
    f('historyMessages').value = draft.historyMessages;
    f('shareScreen').checked = draft.shareScreen;
    f('maxContextChars').value = draft.maxContextChars;
    setStatus('');
  }

  const num = (name) => {
    const v = Number(f(name).value);
    return Number.isFinite(v) ? v : undefined;
  };

  /** The draft as a sanitized settings object (what Save would store). */
  function collect() {
    commitProviderFields();
    const prompt = f('systemPrompt').value;
    const next = {
      ...draft,
      provider: formProvider,
      transport: f('transportRelay').checked ? 'relay' : 'direct',
      relayUrl: f('relayUrl').value.trim(),
      fallbackProvider: f('fallbackProvider').value,
      timeoutSec: Math.round(num('timeoutSec') ?? draft.timeoutSec),
      systemPrompt: prompt.trim() === defaultPrompt().trim() ? '' : prompt,
      temperature: num('temperature'),
      maxOutputTokens: Math.round(num('maxOutputTokens') ?? 0),
      reasoning: f('reasoning').value,
      historyMessages: Math.round(num('historyMessages') ?? 0),
      shareScreen: f('shareScreen').checked,
      maxContextChars: Math.round(num('maxContextChars') ?? 0),
      rememberKeys: f('rememberKeys').checked,
    };
    // An empty address means "the provider default". An empty model is kept: it is a real choice ("whatever is
    // loaded" for LM Studio) and must override a model the application set as its default.
    for (const prof of Object.values(next.profiles || {})) {
      if (!prof.baseUrl) delete prof.baseUrl;
    }
    return next;
  }

  function validate(next) {
    const p = provider(next.provider);
    const url = next.profiles?.[p.id]?.baseUrl;
    if (url && !validUrl(url)) return 'The server address must be a full http:// or https:// URL, without a key in it.';
    if (next.transport === 'relay' && !next.relayUrl) return 'Enter the relay address, or send requests directly.';
    if (next.transport !== 'relay' && p.keyRequired && !keyFor(p.id)) return `${p.label} needs an API key (or use the relay with a server-side key).`;
    return '';
  }

  /* -------------------------------------------------------------- actions */

  async function loadModels() {
    const ticket = ++listTicket;
    const next = sanitizeSettings(collect(), store.defaults());
    const p = provider(formProvider);
    act('loadModels').disabled = true;
    setStatus(`Asking ${p.label} for its models…`);
    try {
      const models = await listModels({ settings: next, keyFor, providerId: formProvider, relayHeaders });
      if (ticket !== listTicket) return;
      f('modelList').innerHTML = models.map((m) => `<option value="${esc(m.id)}">${esc(m.label !== m.id ? `${m.label}${m.loaded ? ' (loaded)' : ''}` : m.loaded ? 'loaded' : '')}</option>`).join('');
      const loaded = models.find((m) => m.loaded);
      setStatus(`Found ${models.length} model${models.length === 1 ? '' : 's'}.${loaded ? ` Loaded now: ${loaded.id}.` : ''} Click the Model box to pick one.`, 'ok');
      if (loaded && p.id === 'lmstudio') f('modelHint').textContent = `LM Studio has ${loaded.id} loaded. Leave Model empty to always use whatever is loaded.`;
    } catch (e) {
      if (ticket === listTicket) setStatus(e?.message || String(e), 'error');
    } finally {
      act('loadModels').disabled = false;
    }
  }

  async function runTest() {
    const next = sanitizeSettings(collect(), store.defaults());
    const problem = validate(next);
    if (problem) { setTest(problem, 'error'); return; }
    act('test').disabled = true;
    setTest('Testing…');
    try {
      const r = await testConnection({ settings: next, keyFor, providerId: formProvider, relayHeaders });
      setTest(r.message, r.ok ? 'ok' : 'error');
      if (r.models?.length) f('modelList').innerHTML = r.models.map((m) => `<option value="${esc(m.id)}">${m.loaded ? 'loaded' : ''}</option>`).join('');
    } finally {
      act('test').disabled = false;
    }
  }

  function save() {
    const next = collect();
    const problem = validate(next);
    if (problem) { setStatus(problem, 'error'); return; }
    // Keys first: saving the settings notifies listeners, which may use them straight away.
    for (const [pid, key] of Object.entries(draftKeys)) {
      if (key !== store.keys.get(pid)) store.keys.set(pid, key);
    }
    if (!store.save(next)) { setStatus('This browser refused to save (storage full or disabled).', 'error'); return; }
    draft = store.get();
    setStatus('Saved.', 'ok');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, 600);
  }

  function resetAll() {
    clearTimeout(closeTimer);
    store.reset();
    fill();
    setStatus('Back to the application defaults (API keys kept).', 'ok');
  }

  let rendering = false;
  let renderAgain = false;

  async function renderContext() {
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    try {
      do {
        renderAgain = false;
        await renderContextOnce();
      } while (renderAgain);
    } finally {
      rendering = false;
    }
  }

  async function renderContextOnce() {
    const box = f('ctxStatus');
    if (!box.textContent) box.textContent = 'Reading the screen…';
    let info;
    try { info = await getContextInfo(); } catch (e) { box.textContent = `Could not read the context: ${e?.message || e}`; return; }
    const s = info.status;
    box.innerHTML = `<div class="aia-ctx-line" data-state="${esc(s.state)}"><span class="aia-context-dot"></span><strong>${esc(STATE_TEXT[s.state] || '')}</strong></div>`
      + `<p class="aia-note">Screen fingerprint now: <code>${esc(shortHash(s.currentHash) || '—')}</code> · last one the agent received: <code>${esc(shortHash(s.syncedHash) || '—')}</code></p>`;
    f('ctxApp').textContent = info.appText || '(no application context provided)';
    f('ctxPage').textContent = info.pageText || '(no page context provided)';
    f('ctxView').textContent = info.viewText || '(none)';
    const snap = info.snapshot;
    if (!info.hasContent) {
      f('ctxSnapMeta').textContent = 'This page has no content hook.';
      f('ctxSnap').textContent = '';
    } else {
      f('ctxSnapMeta').textContent = `${snap.pageTitle} · ${nf(snap.totalChars)} characters${snap.truncated ? ` (cut to ${nf(snap.chars)})` : ''} · fingerprint ${shortHash(snap.hash)}${info.share ? '' : ' · NOT shared (switched off)'}`;
      f('ctxSnap').textContent = snap.text || '(empty)';
    }
    f('ctxSystem').textContent = info.system;
  }

  function showTab(name) {
    currentTab = name;
    for (const tab of root.querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const panel of root.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
    root.querySelector('[data-f="status"]').hidden = name === 'context';
    act('save').hidden = name === 'context';
    act('resetAll').hidden = name === 'context';
    if (name === 'context') renderContext();
  }

  /* ------------------------------------------------------------ open/close */

  function isOpen() { return !root.hidden; }

  function open(tab = 'model') {
    clearTimeout(closeTimer);
    returnFocus = document.activeElement;
    fill();
    root.hidden = false;
    document.documentElement.classList.add('aia-modal-open');
    showTab(tab);
    const first = tab === 'model' ? f('provider') : root.querySelector(`[data-tab="${tab}"]`);
    first?.focus();
  }

  function close() {
    clearTimeout(closeTimer);
    if (root.hidden) return;
    root.hidden = true;
    document.documentElement.classList.remove('aia-modal-open');
    if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) returnFocus.focus();
  }

  /* ---------------------------------------------------------------- wiring */

  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-dismiss]')) { close(); return; }
    const tab = t.closest('[data-tab]');
    if (tab) { showTab(tab.dataset.tab); return; }
    const a = t.closest('[data-act]')?.dataset.act;
    if (a === 'close') close();
    else if (a === 'save') save();
    else if (a === 'resetAll') resetAll();
    else if (a === 'loadModels') loadModels();
    else if (a === 'test') runTest();
    else if (a === 'resetUrl') { f('baseUrl').value = provider(formProvider).baseUrl; syncProviderText(); }
    else if (a === 'resetPrompt') f('systemPrompt').value = defaultPrompt();
    else if (a === 'revealKey') {
      const showing = f('apiKey').type === 'text';
      f('apiKey').type = showing ? 'password' : 'text';
      act('revealKey').textContent = showing ? 'Show' : 'Hide';
      act('revealKey').setAttribute('aria-pressed', String(!showing));
    }
  });

  f('provider').addEventListener('change', () => {
    commitProviderFields();
    formProvider = f('provider').value;
    loadProviderFields(formProvider);
    setStatus('');
  });

  f('baseUrl').addEventListener('input', syncProviderText);

  root.addEventListener('input', () => {
    clearTimeout(closeTimer);
    if (f('status').classList.contains('aia-ok')) setStatus('');
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && !['checkbox', 'radio'].includes(e.target.type)) {
      e.preventDefault();
      save();
      return;
    }
    if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const items = [...root.querySelectorAll('button, input, select, textarea, summary, a[href]')]
        .filter((el) => !el.disabled && el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  return {
    element: root,
    open,
    close,
    isOpen,
    refreshContext: () => { if (isOpen() && currentTab === 'context') renderContext(); },
    destroy: () => { close(); root.remove(); },
  };
}
