// Hello World — a plain-text editor. This file is the host application and knows nothing about AI: the agent lives
// in ai-agent-setup.js, loaded at the bottom with import() so the editor keeps working if the agent cannot load.
// What the agent sees is built by the pure functions in content.js.

import { stats, plural, caret } from './content.js';

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const fileName = $('fileName');
const fontSize = $('fontSize');
const wrapLines = $('wrapLines');
const DRAFT_KEY = 'hello-world.draft';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const SAMPLE = `Hello, World!

This is a tiny text editor with an AI agent built in. The agent can see this
document — open the panel with the "Ask AI" button (or Ctrl+I) and ask it anything:

  - "Summarize this document"
  - "Proofread it and list the fixes"
  - "Rewrite the second paragraph to be friendlier"

Watch the "AI context" flag in the status bar. It turns amber as soon as you edit
this text, because the agent's copy is out of date. Ask another question and the
agent re-reads the page first; the flag goes green again. If nothing changed, the
page is not sent twice.

Their wher some spelling misteaks in this sentance for the agent to find.
`;

let savedText = '';
let dirty = false;
const changeListeners = new Set();
const changed = () => { for (const fn of changeListeners) fn(); };

/* ----------------------------------------------------------------- helpers */

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}

function renderStats() {
  const s = stats(editor.value);
  $('statWords').textContent = plural(s.words, 'word');
  $('statChars').textContent = plural(s.chars, 'character');
  $('statLines').textContent = plural(s.lines, 'line');
  renderCursor();
}

function renderCursor() {
  const c = caret(editor.value, editor.selectionStart);
  $('statCursor').textContent = `Ln ${c.line}, Col ${c.col}`;
}

function setDirty(next) {
  dirty = next;
  $('dirtyFlag').hidden = !dirty;
  document.title = `${dirty ? '● ' : ''}${fileName.value} — Hello World`;
}

let draftTimer = null;
function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: fileName.value, text: editor.value, savedText, fontSize: Number(fontSize.value), wrap: wrapLines.checked })); } catch { /* ignore */ }
  }, 400);
}

/** Load new text as the whole document (a file, "New", or restoring the draft). */
function loadDocument(name, text, { saved = true } = {}) {
  fileName.value = name;
  editor.value = text;
  savedText = saved ? text : '';
  setDirty(!saved);
  editor.setSelectionRange(0, 0);
  editor.scrollTop = 0;
  renderStats();
  saveDraft();
  changed();
}

/** Replace a range in a way the browser's undo (Ctrl+Z) can take back. */
function replaceRange(start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  let done = false;
  try { done = document.execCommand('insertText', false, text); } catch { done = false; }
  if (!done) { editor.setRangeText(text, start, end, 'end'); onEdit(); }
}

function insertAtCursor(text) {
  replaceRange(editor.selectionStart, editor.selectionEnd, text);
  toast('Inserted at the cursor (Ctrl+Z to undo)');
}

function replaceDocument(text) {
  replaceRange(0, editor.value.length, text);
  toast('Document replaced (Ctrl+Z to undo)');
}

function onEdit() {
  setDirty(editor.value !== savedText);
  renderStats();
  saveDraft();
  changed();
}

/* --------------------------------------------------------- editor settings */

// The agent applies settings through these same controls (setControlValue), so this is the only place they act.
function applyEditorSettings() {
  editor.style.fontSize = `${fontSize.value}px`;
  $('fontSizeValue').textContent = `${fontSize.value}px`;
  editor.wrap = wrapLines.checked ? 'soft' : 'off';
  saveDraft();
}
fontSize.addEventListener('input', applyEditorSettings);
wrapLines.addEventListener('change', applyEditorSettings);

/* ------------------------------------------------------------------ files */

async function openFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { toast('That file is larger than 5 MB.'); return; }
  if (dirty && !confirm('Discard the unsaved changes in the current document?')) return;
  const text = await file.text();
  if (/\u0000/.test(text.slice(0, 4096))) { toast('That looks like a binary file, not text.'); return; }
  loadDocument(file.name, text.replace(/\r\n?/g, '\n'));
  toast(`Opened ${file.name}`);
}

async function saveFile() {
  const name = fileName.value.trim() || 'untitled.txt';
  const blob = new Blob([editor.value], { type: 'text/plain;charset=utf-8' });
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      fileName.value = handle.name;
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
  } catch (e) {
    if (e?.name === 'AbortError') return;
    toast(`Could not save: ${e?.message || e}`);
    return;
  }
  savedText = editor.value;
  setDirty(false);
  saveDraft();
  changed();
  toast(`Saved ${fileName.value}`);
}

/* ----------------------------------------------------------------- wiring */

editor.addEventListener('input', onEdit);
for (const ev of ['keyup', 'mouseup', 'select', 'focus']) editor.addEventListener(ev, renderCursor);
fileName.addEventListener('input', () => { setDirty(true); saveDraft(); changed(); });

$('newButton').addEventListener('click', () => {
  if (dirty && !confirm('Discard the unsaved changes in the current document?')) return;
  loadDocument('untitled.txt', '');
  editor.focus();
});
$('openButton').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('saveButton').addEventListener('click', saveFile);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); }
});

const card = $('editorCard');
card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('dragging'); });
card.addEventListener('dragleave', (e) => { if (!card.contains(e.relatedTarget)) card.classList.remove('dragging'); });
card.addEventListener('drop', (e) => {
  e.preventDefault();
  card.classList.remove('dragging');
  openFile(e.dataTransfer?.files?.[0]);
});

window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

/* -------------------------------------------------------------------- start */

(function restore() {
  let draft = null;
  try { draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch { draft = null; }
  if (draft && typeof draft.text === 'string') {
    loadDocument(draft.name || 'untitled.txt', draft.text, { saved: true });
    savedText = typeof draft.savedText === 'string' ? draft.savedText : draft.text;
    setDirty(draft.text !== savedText);
    if (Number.isFinite(draft.fontSize)) fontSize.value = String(draft.fontSize);
    if (typeof draft.wrap === 'boolean') wrapLines.checked = draft.wrap;
  } else {
    loadDocument('hello-world.txt', SAMPLE);
  }
  applyEditorSettings();
})();

/* ------------------------------------------------ actions the agent's tools use */

function findText(query, { matchCase = false, limit = 50 } = {}) {
  const hay = matchCase ? editor.value : editor.value.toLowerCase();
  const needle = matchCase ? query : query.toLowerCase();
  const found = [];
  if (!needle) return found;
  for (let i = hay.indexOf(needle); i >= 0 && found.length < limit; i = hay.indexOf(needle, i + needle.length)) {
    const c = caret(editor.value, i);
    const lineText = editor.value.split('\n')[c.line - 1] || '';
    found.push({ line: c.line, column: c.col, lineText: lineText.length > 160 ? `${lineText.slice(0, 157)}…` : lineText });
  }
  return found;
}

/** Replace text through the editor's undoable path. Returns how many occurrences were replaced. */
function replaceText(find, replacement, { all = true, matchCase = false } = {}) {
  if (!find) return 0;
  const text = editor.value;
  const hay = matchCase ? text : text.toLowerCase();
  const needle = matchCase ? find : find.toLowerCase();
  let out = '';
  let from = 0;
  let count = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    out += text.slice(from, i) + replacement;
    from = i + find.length;
    count++;
    if (!all) break;
  }
  if (!count) return 0;
  replaceRange(0, text.length, out + text.slice(from));
  return count;
}

function insertText(text, where = 'cursor') {
  if (where === 'start') replaceRange(0, 0, text);
  else if (where === 'end') replaceRange(editor.value.length, editor.value.length, text);
  else replaceRange(editor.selectionStart, editor.selectionEnd, text);
}

function renameFile(name) {
  fileName.value = name;
  setDirty(true);
  saveDraft();
  changed();
}

/** What the integration may use: read-only state, a change signal, and the editor's own actions. */
export function createEditorApp() {
  return {
    findText,
    replaceText,
    insertText,
    renameFile,
    newDocument: () => loadDocument('untitled.txt', ''),
    selection: () => ({ text: editor.value.slice(editor.selectionStart, editor.selectionEnd), start: editor.selectionStart, end: editor.selectionEnd, ...caret(editor.value, editor.selectionStart) }),
    state: () => ({
      fileName: fileName.value,
      text: editor.value,
      selectionStart: editor.selectionStart,
      selectionEnd: editor.selectionEnd,
      dirty,
      fontSize: Number(fontSize.value),
      wrap: wrapLines.checked,
    }),
    onChange(fn) { changeListeners.add(fn); return () => changeListeners.delete(fn); },
    insertAtCursor,
    replaceDocument,
    toast,
    controls: { fontSize, wrap: wrapLines },
  };
}

// The agent is optional: load it without letting a failure (network, a stale cached file, an old browser) break
// the editor.
import('./ai-agent-setup.js')
  .then(({ mountAgent }) => mountAgent(createEditorApp()))
  .catch((e) => console.warn('The AI agent is not available; the editor works without it.', e));
