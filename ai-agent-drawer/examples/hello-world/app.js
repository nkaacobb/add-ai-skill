// Hello World — a plain-text editor with the ai-agent-drawer pattern built in.
//
// This file is the reference integration. Everything the agent knows comes from four hooks:
//   app      what Hello World is and can do                       (setApp / `app` option)
//   page     which view is open and what it is for                (setPage / `page` option)
//   content  the document on screen — fingerprinted for sync     (page.content)
//   view     cursor, selection, save state — sent, not hashed     (page.view)
// …plus one call, agent.contextChanged(), whenever the document changes.

import { createAiAgent, DEFAULT_SYSTEM_PROMPT } from '../../assets/ai-agent/ai-agent.js';

const $ = (id) => document.getElementById(id);
const editor = $('editor');
const fileName = $('fileName');
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

/* ----------------------------------------------------------------- helpers */

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 2200);
}

function stats(text) {
  const words = (text.match(/\S+/g) || []).length;
  const lines = text === '' ? 1 : text.split('\n').length;
  return { words, chars: text.length, lines };
}

function cursorInfo() {
  const before = editor.value.slice(0, editor.selectionStart);
  const line = before.split('\n').length;
  const col = before.length - before.lastIndexOf('\n');
  return { line, col };
}

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function renderStats() {
  const s = stats(editor.value);
  $('statWords').textContent = plural(s.words, 'word');
  $('statChars').textContent = plural(s.chars, 'character');
  $('statLines').textContent = plural(s.lines, 'line');
  renderCursor();
}

function renderCursor() {
  const c = cursorInfo();
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
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ name: fileName.value, text: editor.value, savedText })); } catch { /* ignore */ }
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
  agent.contextChanged();
}

/** Replace a range in a way the browser's undo (Ctrl+Z) can take back. */
function replaceRange(start, end, text) {
  editor.focus();
  editor.setSelectionRange(start, end);
  let done = false;
  try { done = document.execCommand('insertText', false, text); } catch { done = false; }
  if (!done) editor.setRangeText(text, start, end, 'end');
  onEdit();
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
  agent.contextChanged(); // <- the one call that keeps the AI-context flag honest
}

/* -------------------------------------------------------------- the agent */

const agent = createAiAgent({
  appId: 'hello-world',
  title: 'Writing agent',
  toggle: '#aiToggle',
  push: '#app',
  defaults: {
    provider: 'lmstudio',
    relayUrl: '/ai-relay', // used if you switch Settings > Model > Advanced to "through the relay"
  },

  // What this application is. Goes into the system prompt on every request.
  app: {
    name: 'Hello World',
    purpose: 'A minimal plain-text editor. It is also the reference implementation of the ai-agent-drawer pattern.',
    capabilities: [
      'Type or paste text into one document',
      'Open a text file from disk (button or drag and drop) and save the document as a file',
      'Apply the agent\'s suggestions with the "Insert at cursor" and "Replace document" buttons on its code blocks',
    ],
    limits: [
      'The agent cannot change the document by itself: the user applies suggestions with the buttons',
      'Plain text only: no formatting, images, or multiple documents',
    ],
  },

  // The page. This app has one view, so it is set once; a routed app calls agent.setPage() on navigation.
  page: {
    id: 'editor',
    title: 'Editor',
    purpose: 'The user writes or loads one plain-text document here. The document is the screen content.',
    // Fingerprinted: any change here flips the flag to "changed" until the agent has re-read it.
    content: () => {
      const s = stats(editor.value);
      return `File name: ${fileName.value}\nStats: ${plural(s.words, 'word')}, ${plural(s.chars, 'character')}, ${plural(s.lines, 'line')}\n\n--- document ---\n${editor.value}`;
    },
    // Volatile: sent with each question, never fingerprinted — moving the cursor does not make the page "changed".
    view: () => {
      const c = cursorInfo();
      const selected = editor.value.slice(editor.selectionStart, editor.selectionEnd);
      return {
        cursor: `line ${c.line}, column ${c.col}`,
        selection: selected ? (selected.length > 1500 ? `${selected.slice(0, 1500)}…` : selected) : '(nothing selected)',
        unsavedChanges: dirty ? 'yes' : 'no',
      };
    },
  },

  systemPrompt: `${DEFAULT_SYSTEM_PROMPT}

You are the writing agent inside Hello World, a plain-text editor. Help the user write, edit, proofread, summarise and understand the document on screen.
- When the user asks about "this", "the text" or "the document", they mean the document in the page snapshot.
- If there is a selection in the view state and the question is about "this part", work on the selection.
- When you propose a rewrite, put the complete new text in ONE fenced code block tagged \`text\`, so the user can apply it with "Replace document" or "Insert at cursor". Explain the changes briefly outside the block.
- For proofreading, list each fix as: original → corrected, with a short reason.`,

  welcome: '**Hi!** I can read the document in the editor. Ask me to summarise it, proofread it, rewrite part of it, or continue it.\n\nThe flag above shows whether my copy of the page is current.',
  suggestions: ['Summarize this document', 'Proofread it and list the fixes', 'Suggest a better title', 'Continue writing from the end'],

  // Buttons on the agent's code blocks and replies, wired to this app's own abilities.
  codeActions: [
    { id: 'insert', label: 'Insert at cursor', title: 'Insert this block where the cursor is', run: (block) => insertAtCursor(block.code) },
    { id: 'replace', label: 'Replace document', title: 'Replace the whole document with this block (Ctrl+Z to undo)', run: (block) => replaceDocument(block.code) },
  ],
  replyActions: [
    { id: 'insert-reply', label: 'Insert reply at cursor', run: (markdown) => insertAtCursor(markdown) },
  ],
});

// The status-bar flag: does the agent have what is on screen?
const FLAG_TEXT = {
  synced: 'AI has the latest page',
  dirty: 'Page changed — AI re-reads it next message',
  unread: 'AI has not read this page yet',
  none: 'Nothing to share',
  off: 'Screen sharing off',
};
agent.onContextStatus((s) => {
  $('aiStatus').dataset.state = s.state;
  $('aiStatusText').textContent = `AI context: ${FLAG_TEXT[s.state] || s.state}`;
  $('aiStatusHash').textContent = s.hash ? s.hash.slice(0, 7) : '';
  $('aiStatus').title = s.hash
    ? `Screen fingerprint ${s.hash.slice(0, 7)} · the AI has ${s.syncedHash ? s.syncedHash.slice(0, 7) : 'nothing yet'}. Click to see exactly what the AI receives.`
    : 'Click to see exactly what the AI receives.';
});

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
  toast(`Saved ${fileName.value}`);
}

/* ----------------------------------------------------------------- wiring */

editor.addEventListener('input', onEdit);
for (const ev of ['keyup', 'mouseup', 'select', 'focus']) editor.addEventListener(ev, renderCursor);
fileName.addEventListener('input', () => { setDirty(true); saveDraft(); agent.contextChanged(); });

$('newButton').addEventListener('click', () => {
  if (dirty && !confirm('Discard the unsaved changes in the current document?')) return;
  loadDocument('untitled.txt', '');
  editor.focus();
});
$('openButton').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => { openFile(e.target.files[0]); e.target.value = ''; });
$('saveButton').addEventListener('click', saveFile);
$('settingsButton').addEventListener('click', () => agent.openSettings('model'));
$('aiStatus').addEventListener('click', () => agent.openSettings('context'));

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
  } else {
    loadDocument('hello-world.txt', SAMPLE);
  }
})();

// Handy for experimenting in the browser console: window.agent.getContextStatus(), agent.ask('…'), …
window.agent = agent;
