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

test('hello-world tools: every tool is valid, wraps the editor\'s own functions, and matches ai-tools.json', async () => {
  const { editorTools } = await import('../examples/hello-world/ai-tools.js');
  const { normalizeTool, validateArgs, toolsConfigPatch } = await import('../assets/ai-agent/core/tools.js');
  const calls = [];
  const app = {
    findText: (q, o) => { calls.push(['findText', q, o]); return [{ line: 3, column: 1, lineText: 'x' }]; },
    replaceText: (f, r, o) => { calls.push(['replaceText', f, r, o]); return 2; },
    insertText: (t, w) => calls.push(['insertText', t, w]),
    renameFile: (n) => calls.push(['renameFile', n]),
    replaceDocument: (t) => calls.push(['replaceDocument', t]),
    newDocument: () => calls.push(['newDocument']),
    selection: () => ({ text: '', start: 0, end: 0, line: 1, col: 1 }),
    controls: {},
  };
  const tools = editorTools(app).map((d) => normalizeTool(d));
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(tools.map((t) => [t.name, t.effect]), [
    ['find_text', 'read'], ['get_selection', 'read'], ['insert_text', 'write'], ['replace_text', 'write'],
    ['set_editor_settings', 'write'], ['rename_file', 'write'], ['replace_document', 'destructive'], ['new_document', 'destructive'],
  ]);
  const run = (name, args) => { const v = validateArgs(byName[name], args); assert.ok(v.ok, v.errors.join()); return byName[name].run(v.args); };
  assert.deepEqual(run('find_text', { query: 'wher' }), { count: 1, occurrences: [{ line: 3, column: 1, lineText: 'x' }] });
  assert.equal(run('replace_text', { find: 'wher', replace: 'were' }), 'Replaced 2 occurrences of "wher".');
  assert.deepEqual(calls.find((c) => c[0] === 'replaceText'), ['replaceText', 'wher', 'were', { all: true, matchCase: false }]);
  assert.equal(validateArgs(byName.set_editor_settings, { fontSize: 99 }).args.fontSize, 24, 'clamped to the slider range');
  assert.equal(validateArgs(byName.insert_text, { text: 'x', where: 'middle' }).ok, false);
  const fs = await import('node:fs');
  const config = JSON.parse(fs.readFileSync(new URL('../examples/hello-world/ai-tools.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(config.tools).sort(), tools.map((t) => t.name).sort(), 'the config lists exactly the catalog');
  assert.equal(toolsConfigPatch(config).toolStates.new_document, false, 'destructive tools start off');
});

test('hello-world: the model\'s editor-settings block is read leniently and clamped to the real controls', () => {
  const read = (language, code) => parseBlockValues({ language, code }, { tags: 'editor-settings', schema: EDITOR_SETTINGS });
  assert.deepEqual(read('editor-settings', '{"fontSize": 40, "wrap": "off"}').values, { fontSize: 24, wrap: false });
  assert.deepEqual(read('json', '{"font size": 16}').values, { fontSize: 16 }, 'json from a small model: every key known');
  assert.equal(read('json', '{"fontSize": 16, "theme": "dark"}'), null, 'json with an unknown key is not a settings block');
  assert.equal(read('text', 'Some rewritten paragraph.'), null, 'rewrites keep their Insert/Replace buttons');
});
