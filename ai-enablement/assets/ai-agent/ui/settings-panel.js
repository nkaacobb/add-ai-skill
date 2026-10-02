// Settings modal: Model (provider, address, model, key, connection test, relay/fallback), Agent (system prompt and
// generation options), Tools (which of the application's tools the agent may use, confirmations, export as the app's
// tool config), Memory (the notes the agent keeps between conversations: add, edit, delete, export, import), Vision
// (whether the model sees images, and who may take screenshots) and Context (a read-only view of exactly what the
// application's hooks give the agent).
// Edits are held in a draft and written on Save; "Load models" and "Test connection" use the draft, so a setup can
// be tried before it is kept.

import { PROVIDERS, PROVIDER_IDS, provider, transmissionNote } from '../core/providers.js';
import { profileFor, sanitizeSettings, validUrl } from '../core/settings.js';
import { listModels, testConnection } from '../core/client.js';
import { shortHash } from '../core/hash.js';
import { estimateTokens } from '../core/messages.js';
import { ICONS } from './icons.js';
import { esc, h, nf, uid, isolateKeys, copyText } from './dom.js';
import { toolEnabled, toolAvailable, exportToolsConfig } from '../core/tools.js';
import { decidePermission } from '../core/permissions.js';
import { exportMemoryFile, parseMemoryFile, memoryText, nextId, MEMORY_LIMITS } from '../core/memory.js';
import { formatWhen } from './dom.js';

/** Above this many estimated tokens (system prompt + snapshot + view state), Settings > Context warns for local models. */
export const CONTEXT_WARN_TOKENS = 3000;

const STATE_TEXT = {
  synced: 'The agent has the current screen.',
  dirty: 'The screen changed since the agent last saw it. It will re-read it with your next message.',
  unread: 'The agent has not seen this screen in this conversation yet. It will read it with your next message.',
  none: 'This page does not share any content with the agent.',
  off: 'Screen sharing is switched off (Agent tab).',
};

export function createSettingsPanel({ store, defaultPrompt, getContextInfo, relayHeaders, theme = 'auto', mount = document.body, title = 'AI agent', isolate = true, warnTokens = CONTEXT_WARN_TOKENS, relayInfo = () => null, getTools = () => [], pageId = () => null, memory = null, vision = () => null, attachments = true, getPolicy = () => null, getCapabilities = () => null }) {
  const memLimits = memory?.limits || MEMORY_LIMITS;
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
      <button type="button" role="tab" class="aia-tab" data-tab="tools" id="${id}-t-tools" aria-controls="${id}-p-tools" aria-selected="false" hidden>Tools</button>
      <button type="button" role="tab" class="aia-tab" data-tab="memory" id="${id}-t-memory" aria-controls="${id}-p-memory" aria-selected="false"${memory ? '' : ' hidden'}>Memory</button>
      <button type="button" role="tab" class="aia-tab" data-tab="vision" id="${id}-t-vision" aria-controls="${id}-p-vision" aria-selected="false"${vision() ? '' : ' hidden'}>Vision</button>
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
        <div class="aia-section aia-caps" data-f="caps" hidden></div>
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
        <div class="aia-section"${attachments ? '' : ' hidden'}>
          <label class="aia-field"><span class="aia-label">Max file content (characters per attached file)</span><input type="number" min="1000" max="400000" step="1000" data-f="maxFileChars"></label>
          <p class="aia-note">Files you attach with the + button are read in this browser (PDF, Word, Excel, PowerPoint, text…) and their text goes to the agent with your question; longer files are cut to this size, and the agent is told. Local models with a small context need a lower value.</p>
        </div>
      </section>

      <section class="aia-panel" data-panel="tools" role="tabpanel" id="${id}-p-tools" aria-labelledby="${id}-t-tools" hidden>
        <div class="aia-section">
          <label class="aia-check"><input type="checkbox" data-f="toolsEnabled"><span>Let the agent use the application's tools</span></label>
          <label class="aia-check"><input type="checkbox" data-f="confirmWrites"><span>Ask me before actions that change something</span></label>
          <label class="aia-check"><input type="checkbox" data-f="confirmDestructive"><span>Ask me before destructive actions (delete, overwrite)</span></label>
          <div class="aia-grid">
            <label class="aia-field"><span class="aia-label">How tools are called</span><select data-f="toolMode">
              <option value="auto">Automatic</option>
              <option value="native">Tool calls (models trained for tool use)</option>
              <option value="text">Text blocks (any model)</option>
            </select></label>
            <label class="aia-field"><span class="aia-label">Max tool steps per question</span><input type="number" min="1" max="30" step="1" data-f="maxToolSteps"></label>
          </div>
          <p class="aia-note">Reading tools run without asking. The agent only sees the tools that are turned on; for the others it can ask you to turn them on.</p>
        </div>
        <div class="aia-section">
          <div class="aia-label-row"><span class="aia-label" data-f="toolCount">Tools</span>
            <span class="aia-row"><button type="button" class="aia-btn aia-btn-ghost aia-btn-sm" data-act="toolsRead">Reading tools on</button><button type="button" class="aia-btn aia-btn-ghost aia-btn-sm" data-act="toolsAll">All on</button><button type="button" class="aia-btn aia-btn-ghost aia-btn-sm" data-act="toolsNone">All off</button></span>
          </div>
          <div class="aia-tool-list" data-f="toolList"></div>
        </div>
        <div class="aia-section">
          <p class="aia-note">Your choices are saved in this browser. To make them the application's defaults for everyone, download the tool config and save it in the app as its tool config file (for example <code>ai-tools.json</code>, loaded with the <code>toolsConfig</code> option).</p>
          <div class="aia-row aia-row-center"><button type="button" class="aia-btn" data-act="exportTools">Download ai-tools.json</button><button type="button" class="aia-btn aia-btn-ghost" data-act="copyTools">Copy JSON</button></div>
        </div>
      </section>

      <section class="aia-panel" data-panel="memory" role="tabpanel" id="${id}-p-memory" aria-labelledby="${id}-t-memory" hidden>
        <div class="aia-section">
          <label class="aia-check"><input type="checkbox" data-f="memoryEnabled"><span>Use memories: the notes below are part of every conversation</span></label>
          <label class="aia-check"><input type="checkbox" data-f="memoryWrite"><span>Let the agent save a memory when I ask it to remember something</span></label>
          <p class="aia-note">Tell the agent in the chat — "remember that I like the dark colour map" — or write memories here yourself: preferences, settings you liked, things about this application the agent did not know.</p>
        </div>
        <div class="aia-section">
          <div class="aia-label-row"><span class="aia-label" data-f="memoryCount">Memories</span></div>
          <div class="aia-memory-list" data-f="memoryList"></div>
          <div class="aia-row"><input type="text" data-f="memoryNew" maxlength="${memLimits.chars}" autocomplete="off" placeholder="Add a memory…" aria-label="New memory"><button type="button" class="aia-btn" data-act="memoryAdd">Add</button></div>
        </div>
        <div class="aia-section">
          <p class="aia-note">Memories are kept in this browser. To keep a copy, take them to another browser, or make them the application's starting memories for everyone, download the file and save it in the app as its memory file (for example <code>ai-memory.json</code>, loaded with the <code>memoryFile</code> option).</p>
          <div class="aia-row aia-row-center"><button type="button" class="aia-btn" data-act="memoryExport">Download ai-memory.json</button><button type="button" class="aia-btn aia-btn-ghost" data-act="memoryCopy">Copy JSON</button><button type="button" class="aia-btn aia-btn-ghost" data-act="memoryImport">Import a file…</button><button type="button" class="aia-btn aia-btn-ghost" data-act="memoryClear">Delete all</button></div>
          <input type="file" accept="application/json,.json" data-f="memoryFile" hidden>
        </div>
      </section>

      <section class="aia-panel" data-panel="vision" role="tabpanel" id="${id}-p-vision" aria-labelledby="${id}-t-vision" hidden>
        <div class="aia-section">
          <label class="aia-check"><input type="checkbox" data-f="vision"><span>This model can see images (vision)</span></label>
          <p class="aia-note" data-f="visionModel" hidden></p>
          <p class="aia-note">Leave it on for models that accept images: most current cloud models, and local vision models. Switch it off for a text-only model: the camera button goes away, images cannot be attached, and questions are answered from text alone.</p>
        </div>
        <div class="aia-section" data-f="shotsSection">
          <label class="aia-check"><input type="checkbox" data-f="shotsManual"><span>Only take a screenshot when I press the camera button</span></label>
          <p class="aia-note">Untick it to let the agent take a screenshot on its own whenever it thinks seeing the screen would help. While it is ticked the agent can still ask, and you get a button to allow it once or always. Either way, every screenshot shows in the chat as a thumbnail.</p>
        </div>
        <div class="aia-section" data-f="howSection">
          <h3 class="aia-h3">How screenshots are taken</h3>
          <p class="aia-note" data-f="visionHow"></p>
          <div class="aia-row aia-row-center" data-f="visionLive" hidden><button type="button" class="aia-btn aia-btn-ghost" data-act="visionStop">Stop sharing this tab</button></div>
          <p class="aia-note">A screenshot is sent to the model with your question, like the rest of the conversation. Saved chats keep only a small thumbnail of it.</p>
        </div>
        <div class="aia-section" data-f="uploadSection" hidden>
          <h3 class="aia-h3">Images you attach</h3>
          <p class="aia-note">Images you add with the + button, drop on the chat or paste go to the model like a screenshot: scaled down, with a thumbnail in the chat. Saved chats keep only the thumbnail.</p>
        </div>
      </section>

      <section class="aia-panel" data-panel="context" role="tabpanel" id="${id}-p-context" aria-labelledby="${id}-t-context" hidden>
        <div class="aia-section aia-ctx-status" data-f="ctxStatus"></div>
        <div class="aia-section aia-ctx-size" data-f="ctxSize"></div>
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
  let toolChanges = {};     // tool on/off changes in this draft (only these are saved)
  let memDraft = [];        // the memories as edited in this draft: [{ key, id, text, created, updated?, source }]
  let memDirty = false;
  let memSeq = 0;

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
    f('maxFileChars').value = draft.maxFileChars;
    f('toolsEnabled').checked = draft.toolsEnabled;
    f('confirmWrites').checked = draft.confirmWrites;
    f('confirmDestructive').checked = draft.confirmDestructive;
    f('toolMode').value = draft.toolMode;
    f('maxToolSteps').value = draft.maxToolSteps;
    toolChanges = {};
    renderTools();
    f('memoryEnabled').checked = draft.memoryEnabled;
    f('memoryWrite').checked = draft.memoryWrite;
    f('vision').checked = draft.vision;
    f('shotsManual').checked = !draft.screenshotAuto;
    loadMemory();
    renderVision();
    setStatus('');
  }

  /* ----------------------------------------------------------------- memory */

  function loadMemory() {
    memDraft = memory ? memory.list().map((m) => ({ ...m, key: `k${++memSeq}` })) : [];
    memDirty = false;
    renderMemory();
  }

  const sourceLabel = { agent: 'saved by the agent', app: 'from the application', user: 'written by you' };

  function renderMemory() {
    if (!memory) return;
    const n = memDraft.length;
    f('memoryCount').textContent = `Memories · ${n}${n >= memLimits.max ? ' (full)' : ''}`;
    f('memoryList').innerHTML = n ? memDraft.map((m) => `
      <div class="aia-memory-row" data-memory="${esc(m.key)}">
        <textarea rows="2" maxlength="${memLimits.chars}" data-memory-text aria-label="Memory ${esc(m.id || 'new')}">${esc(m.text)}</textarea>
        <div class="aia-memory-meta"><span>${esc([m.id, m.id ? sourceLabel[m.source] || '' : 'new', formatWhen(Date.parse(m.updated || m.created))].filter(Boolean).join(' · '))}</span>
          <button type="button" class="aia-icon-btn" data-memory-delete title="Delete this memory" aria-label="Delete this memory">${ICONS.trash}</button></div>
      </div>`).join('') : '<p class="aia-note">Nothing saved yet.</p>';
    f('memoryNew').disabled = n >= memLimits.max;
  }

  function memoryChanged(message) {
    memDirty = true;
    setStatus(message || 'Memory changed — press Save to keep it.');
  }

  function addMemory(text, source = 'user') {
    const t = memoryText(text, memLimits.chars);
    if (!t || memDraft.length >= memLimits.max) return false;
    if (memDraft.some((m) => m.text.trim().toLowerCase() === t.toLowerCase())) return false;
    memDraft.push({ key: `k${++memSeq}`, id: '', text: t, created: new Date().toISOString(), source });
    return true;
  }

  /** The draft as memories. New ones have no id yet: the store gives them one on Save; an export numbers them itself. */
  function memoryItems(assignIds = false) {
    const ids = [...memDraft.map((m) => m.id).filter(Boolean), ...(memory ? memory.list().map((m) => m.id) : [])];
    return memDraft.filter((m) => memoryText(m.text, memLimits.chars)).map(({ key, ...m }) => {
      if (!m.id && assignIds) { m.id = nextId(ids); ids.push(m.id); }
      return { ...m, text: memoryText(m.text, memLimits.chars) };
    });
  }

  const memoryJson = () => JSON.stringify(exportMemoryFile(memoryItems(true)), null, 2);

  async function importMemory(file) {
    let json;
    try { json = JSON.parse(await file.text()); } catch { setStatus('That file is not valid JSON.', 'error'); return; }
    const incoming = parseMemoryFile(json, { maxChars: memLimits.chars, max: memLimits.max, source: 'user' });
    let added = 0;
    for (const m of incoming) if (addMemory(m.text, m.source)) added += 1;
    renderMemory();
    if (added) memoryChanged(`Imported ${added} memor${added === 1 ? 'y' : 'ies'} — press Save to keep ${added === 1 ? 'it' : 'them'}.`);
    else setStatus(incoming.length ? 'Those memories are already here.' : 'No memories found in that file.', incoming.length ? '' : 'error');
  }

  /* ----------------------------------------------------------------- vision */

  function renderVision() {
    const v = vision();
    root.querySelector('[data-tab="vision"]').hidden = !v;
    if (!v) return;
    f('visionHow').textContent = v.method === 'app'
      ? 'This application provides the picture itself (its own view of what you are looking at), so nothing has to be shared and the browser does not ask.'
      : v.method === 'screen'
        ? 'With your browser\'s screen sharing: the first time, the browser asks you to share this tab. When only you take screenshots, sharing stops after each one. When the agent may look on its own, the tab stays shared (the browser shows that) until you stop it or reload the page.'
        : 'Not available here: this browser cannot capture the page (that needs a desktop browser and an https or localhost address), and the application provides no picture of its own.';
    f('shotsSection').hidden = v.shots === false;
    f('howSection').hidden = v.shots === false;
    f('uploadSection').hidden = !v.uploads;
    f('visionLive').hidden = !v.live;
    // What the model server itself says about the model in use, when it says anything (LM Studio does).
    const known = typeof v.modelSees === 'boolean' && v.model && formProvider === store.get().provider;
    f('visionModel').hidden = !known;
    f('visionModel').classList.toggle('aia-warn-note', !!known && !v.modelSees && f('vision').checked);
    if (known) f('visionModel').textContent = v.modelSees
      ? `The model server says ${v.model} sees images.`
      : `The model server says ${v.model} is text-only: screenshots would fail or be ignored. Switch this off, or load a vision model.`;
    f('vision').disabled = v.method === 'none' && !v.uploads;
    f('shotsManual').disabled = v.method === 'none';
  }

  /* ------------------------------------------------------------------ tools */

  const toolOn = (t) => (Object.prototype.hasOwnProperty.call(toolChanges, t.name) ? toolChanges[t.name] : toolEnabled(t, draft));

  function renderTools() {
    const tools = getTools();
    root.querySelector('[data-tab="tools"]').hidden = !tools.length;
    if (!tools.length || !draft) return;
    const here = pageId();
    const groups = new Map();
    for (const t of tools) {
      const g = t.group || (t.pages.length ? `Page: ${t.pages.join(', ')}` : 'Whole application');
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    const on = tools.filter(toolOn).length;
    f('toolCount').textContent = `Tools · ${on} of ${tools.length} on`;
    const effectLabel = { read: 'reads', write: 'changes', destructive: 'destructive', external: 'outside the app', system: 'changes the app' };
    // The application's (and the active agent's) permission rules: deny blocks a tool, ask always confirms, allow never.
    const policy = getPolicy();
    const ruleBadge = {
      deny: '<span class="aia-badge aia-badge-deny" title="The application does not permit this tool (permissions: deny)">blocked</span>',
      ask: '<span class="aia-badge aia-badge-ask" title="The application always asks before this tool runs (permissions: ask)">always asks</span>',
      allow: '<span class="aia-badge aia-badge-allow" title="The application runs this tool without asking (permissions: allow)">no confirmation</span>',
    };
    f('toolList').innerHTML = [...groups.entries()].map(([g, list]) => `<div class="aia-tool-group"><h4>${esc(g)}</h4>${list.map((t) => {
      const rule = policy ? decidePermission(t, policy) : '';
      return `
      <label class="aia-tool-row${rule === 'deny' ? ' aia-tool-blocked' : ''}">
        <input type="checkbox" data-tool="${esc(t.name)}"${toolOn(t) ? ' checked' : ''}${rule === 'deny' ? ' disabled' : ''}>
        <span class="aia-tool-main"><span class="aia-tool-name">${esc(t.title)} <code>${esc(t.name)}</code></span><span class="aia-tool-desc">${esc(t.description)}</span></span>
        <span class="aia-tool-tags"><span class="aia-badge aia-badge-${esc(t.effect)}">${esc(effectLabel[t.effect] || t.effect)}</span>${ruleBadge[rule] || ''}${toolAvailable(t, here) ? '<span class="aia-badge aia-badge-here">on this screen</span>' : ''}</span>
      </label>`;
    }).join('')}</div>`).join('');
  }

  /* ---------------------------------------------------- agents and skills */

  function renderCaps() {
    const info = getCapabilities();
    const box = f('caps');
    const agents = info?.agents || [];
    const skills = info?.skills || [];
    box.hidden = !agents.length && !skills.length && !info?.workspace;
    if (box.hidden) return;
    const current = agents.find((a) => a.name === info.agent);
    box.innerHTML = [
      current ? `<div class="aia-label-row"><span class="aia-label">Agent</span><span class="aia-note">${agents.length} agent${agents.length === 1 ? '' : 's'} · switch with the picker at the top of the panel</span></div>
        <p class="aia-cap-line"><b>${esc(current.title)}</b> — ${esc(current.description)}${current.model ? ` <span class="aia-badge" title="This agent's preferred model (a hint; Settings > Model decides)">prefers ${esc(current.model)}</span>` : ''}</p>` : '',
      skills.length ? `<div class="aia-label-row"><span class="aia-label">Skills</span><span class="aia-note">the agent loads one when a request matches it; type /name to start one yourself</span></div>
        <ul class="aia-cap-list">${skills.map((s) => `<li><code>/${esc(s.name)}</code>${s.active ? ' <span class="aia-badge aia-badge-here">active in this chat</span>' : ''}${s.source === 'builtin' ? ' <span class="aia-badge">built in</span>' : ''} — ${esc(s.description)}</li>`).join('')}</ul>` : '',
      info.workspace ? `<p class="aia-note">Development workspace connected (${esc(info.workspace.root || 'app')}): the agent can read the source and write in <code>${esc((info.workspace.writable || []).join(', '))}</code>, each write shown to you first.</p>` : '',
    ].join('');
  }

  function setAllTools(pred) {
    const policy = getPolicy();
    for (const t of getTools()) if (!policy || decidePermission(t, policy) !== 'deny') toolChanges[t.name] = pred(t);
    renderTools();
  }

  function toolsJson() {
    const next = collect();
    const merged = { ...next, toolStates: { ...(draft.toolStates || {}), ...toolChanges } };
    return JSON.stringify(exportToolsConfig(getTools(), merged), null, 2);
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
      maxFileChars: Math.round(num('maxFileChars') ?? draft.maxFileChars),
      rememberKeys: f('rememberKeys').checked,
      toolsEnabled: f('toolsEnabled').checked,
      confirmWrites: f('confirmWrites').checked,
      confirmDestructive: f('confirmDestructive').checked,
      toolMode: f('toolMode').value,
      maxToolSteps: Math.round(num('maxToolSteps') ?? 0),
      toolStates: { ...toolChanges },
      memoryEnabled: f('memoryEnabled').checked,
      memoryWrite: f('memoryWrite').checked,
      vision: f('vision').checked,
      screenshotAuto: !f('shotsManual').checked,
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
    if (memory && memDirty) {
      const items = memoryItems();
      memDirty = false;
      memory.replaceAll(items);
      loadMemory();
    }
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
    renderSize(info);
  }

  /** Estimated tokens (about 4 characters each) of what the first question of a chat carries. */
  function renderSize(info) {
    const settings = store.get();
    const p = provider(settings.provider);
    const system = estimateTokens(info.system);
    const snap = info.hasContent && info.share ? estimateTokens(info.snapshot?.text) : 0;
    const view = info.share ? estimateTokens(info.viewText) : 0;
    const tools = estimateTokens(info.toolsJson || '');
    const total = system + snap + view + tools;
    const relay = relayInfo();
    const local = settings.transport === 'relay' ? provider(relay?.preset?.provider || settings.provider).kind !== 'cloud' : p.kind !== 'cloud';
    const warn = local && total > warnTokens;
    f('ctxSize').classList.toggle('aia-ctx-warn', warn);
    f('ctxSize').innerHTML = `<h3 class="aia-h3">Size</h3>`
      + `<p class="aia-note">First question of a chat: <strong>≈ ${nf(total)} tokens</strong> before the question itself — system prompt ≈ ${nf(system)}, screen snapshot ≈ ${nf(snap)}${view ? `, view state ≈ ${nf(view)}` : ''}${tools ? `, tool definitions ≈ ${nf(tools)}` : ''}. The reply needs room on top (up to ${nf(settings.maxOutputTokens)} tokens: Agent tab). Estimated at 4 characters per token.</p>`
      + (warn ? `<p class="aia-note aia-warn-note">Local models often run with a 4,096-token context window by default (LM Studio's Context Length when loading a model, Ollama's num_ctx). This first message alone is close to or over that, so replies may be cut off or fail. Load the model with at least 8k context (16k or more for thinking models), or make the app context and screen content leaner (Max screen content in the Agent tab).</p>` : '');
  }

  function showTab(name) {
    currentTab = name;
    for (const tab of root.querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const panel of root.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== name;
    if (name === 'tools') renderTools();
    if (name === 'agent') renderCaps();
    if (name === 'memory') renderMemory();
    if (name === 'vision') renderVision();
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
    else if (a === 'toolsAll') setAllTools(() => true);
    else if (a === 'toolsNone') setAllTools(() => false);
    else if (a === 'toolsRead') setAllTools((t) => t.effect === 'read');
    else if (a === 'copyTools') { copyText(toolsJson()); setStatus('Tool config copied. Save it in the app as its tool config file.', 'ok'); }
    else if (a === 'exportTools') {
      download('ai-tools.json', toolsJson());
      setStatus('Downloaded ai-tools.json. Save it in the app and load it with the toolsConfig option.', 'ok');
    }
    else if (a === 'memoryAdd') {
      if (addMemory(f('memoryNew').value)) { f('memoryNew').value = ''; renderMemory(); memoryChanged(); } else if (f('memoryNew').value.trim()) setStatus(memDraft.length >= memLimits.max ? `Memory is full (${memLimits.max}). Delete one first.` : 'That memory is already there.', 'error');
      f('memoryNew').focus();
    }
    else if (a === 'memoryClear') { if (memDraft.length) { memDraft = []; renderMemory(); memoryChanged('All memories removed — press Save to confirm, or close to keep them.'); } }
    else if (a === 'memoryCopy') { copyText(memoryJson()); setStatus('Memory copied as JSON.', 'ok'); }
    else if (a === 'memoryExport') {
      download('ai-memory.json', memoryJson());
      setStatus('Downloaded ai-memory.json. Save it in the app and load it with the memoryFile option.', 'ok');
    }
    else if (a === 'memoryImport') f('memoryFile').click();
    else if (a === 'visionStop') { vision()?.stop(); renderVision(); }
    else if (t.closest('[data-memory-delete]')) {
      const key = t.closest('[data-memory]').dataset.memory;
      memDraft = memDraft.filter((m) => m.key !== key);
      renderMemory();
      memoryChanged();
    }
    else if (a === 'revealKey') {
      const showing = f('apiKey').type === 'text';
      f('apiKey').type = showing ? 'password' : 'text';
      act('revealKey').textContent = showing ? 'Show' : 'Hide';
      act('revealKey').setAttribute('aria-pressed', String(!showing));
    }
  });

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  f('memoryList').addEventListener('input', (e) => {
    const row = e.target.closest('[data-memory]');
    const m = row && memDraft.find((x) => x.key === row.dataset.memory);
    if (!m || !e.target.matches('[data-memory-text]')) return;
    m.text = e.target.value;
    memoryChanged();
  });
  f('memoryFile').addEventListener('change', () => {
    const file = f('memoryFile').files?.[0];
    f('memoryFile').value = '';
    if (file) importMemory(file);
  });

  f('provider').addEventListener('change', () => {
    commitProviderFields();
    formProvider = f('provider').value;
    loadProviderFields(formProvider);
    setStatus('');
  });

  f('baseUrl').addEventListener('input', syncProviderText);
  f('vision').addEventListener('change', renderVision);

  f('toolList').addEventListener('change', (e) => {
    const box = e.target.closest('[data-tool]');
    if (!box) return;
    toolChanges[box.dataset.tool] = box.checked;
    renderTools();
  });

  root.addEventListener('input', () => {
    clearTimeout(closeTimer);
    if (f('status').classList.contains('aia-ok')) setStatus('');
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Enter' && e.target === f('memoryNew')) { e.preventDefault(); act('memoryAdd').click(); return; }
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
  // Typing in the modal (the system prompt textarea…) must not trigger host keyboard shortcuts.
  const detachKeys = isolate ? isolateKeys(root) : () => {};

  return {
    element: root,
    open,
    close,
    isOpen,
    refreshContext: () => { if (isOpen() && currentTab === 'context') renderContext(); },
    refreshTools: () => {
      if (isOpen() && currentTab === 'tools') renderTools(); else root.querySelector('[data-tab="tools"]').hidden = !getTools().length;
      if (isOpen() && currentTab === 'agent') renderCaps();
    },
    /** The memories changed outside this panel (the agent saved one, the app's file arrived): show them. */
    refreshMemory: () => { if (isOpen() && !memDirty) loadMemory(); },
    refreshVision: () => { if (isOpen()) renderVision(); },
    destroy: () => { close(); detachKeys(); root.remove(); },
  };
}
