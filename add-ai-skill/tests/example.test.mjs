// The Hello World content builders (examples/hello-world/content.js) — the tests every integration should have for
// its own content builder: the same state gives identical text, a real change gives different text, and nothing
// prints NaN or undefined.

import test from 'node:test';
import assert from 'node:assert/strict';
import { editorContent, editorView, stats, EDITOR_SETTINGS } from '../examples/hello-world/content.js';
import { hashText } from '../assets/ai-agent/core/hash.js';
import { parseBlockValues } from '../assets/ai-agent/core/blocks.js';

const state = { fileName: 'notes.txt', text: 'Hello\nworld', selectionStart: 3, selectionEnd: 5, dirty: true, fontSize: 15, wrap: true };

test('hello-world content: deterministic, sensitive to real changes, and never prints NaN/undefined', () => {
  assert.equal(editorContent(state), editorContent({ ...state }), 'the same state gives identical text');
  assert.equal(hashText(editorContent(state)), hashText(editorContent({ ...state, selectionStart: 0, dirty: false })), 'view state does not change the content');
  assert.notEqual(editorContent(state), editorContent({ ...state, text: 'Hello\nworld!' }));
  assert.notEqual(editorContent(state), editorContent({ ...state, fileName: 'other.txt' }));
  for (const s of [state, {}, { text: '' }, { fileName: '', text: 'x' }]) {
    const out = `${editorContent(s)}\n${JSON.stringify(editorView(s))}`;
    assert.doesNotMatch(out, /NaN|undefined|null/, JSON.stringify(s));
  }
});

test('hello-world content: labels match the status bar (no second name for one number)', () => {
  const s = stats('one two\nthree');
  assert.deepEqual(s, { words: 3, chars: 13, lines: 2 });
  assert.match(editorContent({ fileName: 'a.txt', text: 'one two\nthree' }), /Stats: 3 words, 13 characters, 2 lines/);
  assert.deepEqual(editorView({ ...state, fontSize: 17.4, wrap: false }).editorSettings, 'font size 17 px, line wrapping off');
});

test('hello-world: the model\'s editor-settings block is read leniently and clamped to the real controls', () => {
  const read = (language, code) => parseBlockValues({ language, code }, { tags: 'editor-settings', schema: EDITOR_SETTINGS });
  assert.deepEqual(read('editor-settings', '{"fontSize": 40, "wrap": "off"}').values, { fontSize: 24, wrap: false });
  assert.deepEqual(read('json', '{"font size": 16}').values, { fontSize: 16 }, 'json from a small model: every key known');
  assert.equal(read('json', '{"fontSize": 16, "theme": "dark"}'), null, 'json with an unknown key is not a settings block');
  assert.equal(read('text', 'Some rewritten paragraph.'), null, 'rewrites keep their Insert/Replace buttons');
});
