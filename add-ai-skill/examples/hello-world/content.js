// What the agent sees of Hello World: pure functions from the editor's state to text, so they are easy to unit test
// (tests/example.test.mjs): the same state always gives the same text, a real change gives different text, and
// nothing prints NaN or undefined. No DOM here — app.js passes the state in.

/** Counts shown in the status bar. The labels below match the status bar exactly, so the model never sees two names
 *  for one number. */
export function stats(text) {
  const s = String(text ?? '');
  const words = (s.match(/\S+/g) || []).length;
  const lines = s === '' ? 1 : s.split('\n').length;
  return { words, chars: s.length, lines };
}

export const plural = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** The screen content (fingerprinted): file name, the status-bar counts, and the document. */
export function editorContent({ fileName = '', text = '' } = {}) {
  const s = stats(text);
  return `File name: ${fileName || 'untitled.txt'}\nStats: ${plural(s.words, 'word')}, ${plural(s.chars, 'character')}, ${plural(s.lines, 'line')}\n\n--- document ---\n${text}`;
}

/** Line and column of a caret offset, as the status bar shows them ("Ln 3, Col 7"). */
export function caret(text, offset) {
  const before = String(text ?? '').slice(0, Math.max(0, offset | 0));
  return { line: before.split('\n').length, col: before.length - before.lastIndexOf('\n') };
}

/** Volatile view state (sent with each question, never fingerprinted). */
export function editorView({ text = '', selectionStart = 0, selectionEnd = 0, dirty = false, fontSize = 15, wrap = true } = {}) {
  const c = caret(text, selectionStart);
  const selected = String(text).slice(selectionStart, selectionEnd);
  return {
    cursor: `line ${c.line}, column ${c.col}`,
    selection: selected ? (selected.length > 1500 ? `${selected.slice(0, 1500)}…` : selected) : '(nothing selected)',
    unsavedChanges: dirty ? 'yes' : 'no',
    editorSettings: `font size ${Math.round(fontSize)} px, line wrapping ${wrap ? 'on' : 'off'}`,
  };
}

/**
 * The editor settings the agent may change, with the ranges of the real controls (index.html). Used to read the
 * model's ```editor-settings block (parseBlockValues) before applying it through those controls.
 */
export const EDITOR_SETTINGS = Object.freeze({
  fontSize: { type: 'integer', min: 11, max: 24, aliases: ['font', 'font size', 'size', 'text size'] },
  wrap: { type: 'boolean', aliases: ['wrap lines', 'line wrap', 'line wrapping', 'word wrap', 'wrapping'] },
});
