// The lifecycle scripts beyond detect: scaffold.mjs (create a capability and register it, never overwrite) and
// validate.mjs (load everything the runtime would, report errors and warnings). Fixture apps live in a temp folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffold, formatJson } from '../scripts/scaffold.mjs';
import { validate } from '../scripts/validate.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aia-life-'));
const write = (root, rel, text) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const json = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8'));

test('scaffold: init, then a tool, a toolset, a skill and an agent — registered, never overwritten, and valid', async () => {
  const app = tmp();
  const ai = path.join(app, 'public', 'ai');
  assert.deepEqual(scaffold(ai, 'init').created, ['index.json', 'ai-tools.json', 'ai-memory.json']);
  assert.deepEqual(scaffold(ai, 'tool', 'inspect_track', { effect: 'read', description: 'The current track.' }), {
    created: ['tools/inspect_track.js'], updated: ['index.json', 'ai-tools.json'],
    next: ['Write tools/inspect_track.js: call the application\'s own function through host; set the real parameters and effect.', 'Unit-test it with host mocked; then node <skill>/scripts/validate.mjs.'],
  });
  scaffold(ai, 'toolset', 'track', { tools: 'inspect_track' });
  scaffold(ai, 'skill', 'track-design', { description: 'Design a track: curves, straights and pit lane.' });
  scaffold(ai, 'agent', 'track-designer', { description: 'Designs tracks with you.', toolsets: 'track', skills: 'track-design' });
  const index = json(ai, 'index.json');
  assert.deepEqual([index.tools, index.toolsets, index.skills, index.agents], [['tools/inspect_track.js'], ['toolsets/track.json'], ['skills/track-design'], ['agents/track-designer.md']]);
  assert.deepEqual(json(ai, 'ai-tools.json').tools.inspect_track, { enabled: false, effect: 'read', description: 'The current track.' }, 'new tools start off');
  assert.match(fs.readFileSync(path.join(ai, 'index.json'), 'utf8'), /"tools": \["tools\/inspect_track\.js"\]/, 'short lists stay on one line');
  assert.match(fs.readFileSync(path.join(ai, 'skills', 'track-design', 'SKILL.md'), 'utf8'), /^---\nname: track-design\ndescription: "Design a track: curves, straights and pit lane\."\n---/, 'quoted where YAML needs it');

  assert.throws(() => scaffold(ai, 'tool', 'inspect_track'), /already exists; scaffold never overwrites/);
  assert.throws(() => scaffold(ai, 'tool', '9lives'), /not a tool name/);
  assert.throws(() => scaffold(ai, 'skill', 'Track Design', { description: 'x' }), /not a skill name/);
  assert.throws(() => scaffold(ai, 'skill', 'nodesc'), /needs --description/);
  assert.throws(() => scaffold(ai, 'toolset', 'empty'), /needs --tools/);
  assert.throws(() => scaffold(ai, 'tool', 'x', { effect: 'nuke' }), /--effect must be one of/);
  assert.throws(() => scaffold(ai, 'widget', 'x'), /Unknown kind/);

  const v = await validate(app);
  assert.equal(v.ok, true, JSON.stringify(v.indexes[0].errors));
  assert.deepEqual(v.indexes[0].counts, { agents: 1, skills: 1, tools: 1, toolsets: 1 });
  assert.deepEqual(v.indexes[0].warnings, []);
  assert.ok(v.app.notes.length === 0 && v.app.warnings.length === 0, 'no agent installed yet: no manifest is asked for');
});

test('formatJson: two-space JSON, short arrays and small nested objects on one line', () => {
  assert.equal(formatJson({ a: [1, 2], b: { deny: ['x'] }, c: [{ k: 'v' }] }), '{\n  "a": [1, 2],\n  "b": { "deny": ["x"] },\n  "c": [\n    { "k": "v" }\n  ]\n}');
  assert.deepEqual(JSON.parse(formatJson({ long: Array.from({ length: 30 }, (_, i) => `item-number-${i}`) })).long.length, 30);
});

test('validate: errors for what would break, warnings for what would be ignored', async () => {
  const app = tmp();
  write(app, 'ai/index.json', JSON.stringify({
    format: 'ai-enablement/1',
    agents: ['agents/a.md', 'agents/broken.md'],
    skills: ['skills/good', 'skills/bad'],
    tools: ['tools/one.js', 'tools/two.js', 'tools/browser-only.js'],
    toolsConfig: 'ai-tools.json',
    memory: 'ai-memory.json',
  }));
  write(app, 'ai/agents/a.md', '---\nname: a\ndescription: A.\ntools: [ghost]\nskills: [nope]\n---\nx');
  write(app, 'ai/agents/broken.md', '---\nname: Not Valid\n---\n');
  write(app, 'ai/agents/unlisted.md', '---\nname: unlisted\ndescription: x\n---\n');
  write(app, 'ai/skills/good/SKILL.md', '---\nname: good\ndescription: Good.\n---\nRead [the guide](references/guide.md) and [this](https://example.com).');
  write(app, 'ai/skills/bad/SKILL.md', '---\nname: bad\n---\nno description');
  write(app, 'ai/tools/one.js', 'export default { name: "same", description: "One.", effect: "read", run: () => 1 };');
  write(app, 'ai/tools/two.js', 'export default [{ name: "same", description: "Two.", effect: "read", run: () => 2 }, { name: "noeffect", description: "No effect.", run: () => 3 }, { name: "bad schema", description: "x", run: () => 4 }];');
  write(app, 'ai/tools/browser-only.js', 'import "/assets/app.js";\nexport default [];');
  write(app, 'ai/ai-tools.json', JSON.stringify({ tools: { same: true, removed_tool: true } }));
  write(app, 'ai/ai-memory.json', JSON.stringify({ version: 1, memories: [{ id: 'm1', text: 'The admin password is hunter2.' }] }));
  write(app, 'ai-agent.integration.json', '{"skill":"add-ai-skill","skillVersion":"1.6.0"}');
  write(app, 'js/setup.js', "createAiAgent({ appId: 'x', capabilities: 'ai/index.json' });");

  const v = await validate(app);
  assert.equal(v.ok, false);
  const r = v.indexes[0];
  const errors = r.errors.join('\n');
  for (const want of [/agents\/broken\.md: name "Not Valid"/, /skills\/bad: description is missing/, /tool "same" is defined twice \(tools\/one\.js and tools\/two\.js\)/, /tools\/two\.js: Tool name "bad schema" is not valid/, /agent "a": tool "ghost" does not exist/, /agent "a": skill "nope" does not exist/]) {
    assert.match(errors, want);
  }
  const warnings = r.warnings.join('\n');
  for (const want of [/tools\/browser-only\.js: could not be imported[\s\S]*verify\.mjs/, /agents\/unlisted\.md is in the capability folder but not in index\.json/, /skill "good" links to references\/guide\.md, which does not exist/, /ai-tools\.json: "removed_tool" is not a tool/, /"noeffect"[^\n]*states no effect/, /ai-memory\.json: a note mentions a password/]) {
    assert.match(warnings, want);
  }
  assert.doesNotMatch(warnings, /example\.com/, 'web links are not files');
  assert.match(v.app.warnings.join('\n'), /ai-agent\.integration\.json is the 1\.x record: write ai-enablement\.json/);

  write(app, 'ai-enablement.json', JSON.stringify({ skill: 'ai-enablement', skillVersion: '2.0.0', capabilities: { index: 'ai/missing.json' }, notes: 'key: sk-abcdefghijklmnopqrstuvwx' }));
  const m = await validate(app);
  assert.match(m.app.warnings.join('\n'), /names the capability index ai\/missing\.json, which does not exist/);
  assert.match(m.app.errors.join('\n'), /looks like it holds a key or password/);
});

test('validate: Hello World is clean', async () => {
  const v = await validate(path.join(SKILL, 'examples', 'hello-world'));
  assert.equal(v.ok, true);
  assert.deepEqual(v.indexes.map((r) => [r.errors, r.warnings]), [[[], []]]);
  assert.deepEqual(v.app.errors, []);
});
