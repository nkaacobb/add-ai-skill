// scripts/detect.mjs: does the skill recognise an app that already has the agent, at which version, with which edits
// and workarounds — so it upgrades instead of building a second agent? Fixture apps are built in a temp folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detect, createAgentKeys, skillInfo } from '../scripts/detect.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(SKILL, 'assets', 'ai-agent');
const app = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aia-detect-'));
const write = (root, rel, text) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
const copyRuntime = (root, rel, transform = (t) => t) => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(RUNTIME)) write(root, `${rel}/${path.relative(RUNTIME, f).split(path.sep).join('/')}`, transform(fs.readFileSync(f, 'utf8')));
};

const INTEGRATION = `import { createAiAgent } from '../ai-agent/ai-agent.js';
export const agent = createAiAgent({
  appId: 'demo-app', // the storage namespace
  title: 'Demo', push: 'main',
  page: { id: 'p', content: () => build(state, { dialogs: openDialogs() }), view: () => ({ a: 1 }) },
  tools: appTools,
  codeActions: [{ id: 'x', label: 'X', run: () => {} }],
});`;

test('detect: an app without the agent gets the normal workflow', () => {
  const root = app();
  write(root, 'index.html', '<h1>Hello</h1>');
  assert.equal(detect(root).status, 'none');
});

test('detect: a current, unchanged runtime (CRLF checkout too) with its integration and options', () => {
  const root = app();
  copyRuntime(root, 'public/ai-agent', (t) => t.replace(/\n/g, '\r\n'));
  write(root, 'public/js/ai-agent-setup.js', INTEGRATION);
  write(root, 'public/js/ai-tools.json', '{"tools":{}}');
  const r = detect(root);
  assert.equal(r.status, 'current');
  assert.equal(r.runtimes.length, 1);
  assert.equal(r.runtimes[0].dir, 'public/ai-agent');
  assert.equal(r.runtimes[0].version, skillInfo().runtimeVersion);
  assert.deepEqual([r.runtimes[0].modified, r.runtimes[0].missing], [[], []], 'line endings do not count as edits');
  assert.equal(r.integrations[0].appId, 'demo-app');
  assert.deepEqual(r.integrations[0].options, ['title', 'push', 'page', 'tools', 'codeActions'], 'only top-level options (not the "dialogs" inside the content call)');
  assert.deepEqual(r.toolConfigs, ['public/js/ai-tools.json']);
});

test('detect: an older or edited runtime means upgrade, with the edited files named', () => {
  const root = app();
  copyRuntime(root, 'js/vendor/ai-agent', (t) => t.replace(/export const VERSION = '[^']+'/, "export const VERSION = '1.0.0'"));
  write(root, 'js/ai.js', INTEGRATION);
  write(root, 'vendor/autoload.php', '<?php // composer');
  write(root, 'vendor/some/pkg/ai-agent.js', "export const VERSION = '9.9.9'; export function createAiAgent() {}");
  const r = detect(root);
  assert.equal(r.status, 'upgrade');
  assert.equal(r.runtimes.length, 1, 'js/vendor is scanned, Composer vendor/ is not');
  assert.equal(r.runtimes[0].version, '1.0.0');
  assert.ok(r.runtimes[0].modified.includes('ai-agent.js'), 'a 1.0.0 that is not the real 1.0.0 is reported as edited');
});

test('detect: a 1.0 relay with edits inside the file; keys and config contents are never printed', () => {
  const root = app();
  copyRuntime(root, 'assets/ai-agent');
  write(root, 'api/relay.php', `<?php
/** ai-agent-drawer — PHP relay */
const AIA_ALLOW_REMOTE = true;
const AIA_ALLOW_ANY_UPSTREAM = false;
const AIA_KEYS = [
    'openai' => 'sk-live-SECRET-123456',
];
`);
  write(root, 'api/relay.config.php', "<?php return ['keys' => ['openai' => 'sk-OTHER-SECRET']];");
  write(root, 'assets/js/setup.js', INTEGRATION);
  const r = detect(root);
  const relay = r.relays[0];
  assert.equal(relay.version, '1.0.0');
  assert.equal(relay.unchanged, false);
  assert.ok(relay.edits.some((e) => /AIA_ALLOW_REMOTE/.test(e)));
  assert.ok(relay.edits.some((e) => /AIA_KEYS/.test(e) && /values not shown/.test(e)));
  assert.deepEqual(r.relayConfigs, ['api/relay.config.php']);
  assert.equal(r.status, 'upgrade', 'an old relay alone means upgrade');
  const out = JSON.stringify(r);
  assert.doesNotMatch(out, /SECRET/, 'no key and no config content in the report');
});

test('detect: app-side workarounds that a newer runtime covers are pointed out', () => {
  const root = app();
  copyRuntime(root, 'lib/ai-agent');
  write(root, 'src/agent.js', `${INTEGRATION}
const originalShowModal = HTMLDialogElement.prototype.showModal;
dialog.showModal = function () { return drawerOpen ? this.show() : originalShowModal.call(this); };
const signal = throttle(() => agent.contextChanged(), 1000);`);
  write(root, 'src/theme.css', '.aia-scope[data-aia-theme="dark"] { --aia-accent: red; }');
  const hints = detect(root).hints.map((h) => h.hint).join('\n');
  assert.match(hints, /dialogs: 'dock'/);
  assert.match(hints, /debounceMaxMs/);
  assert.match(hints, /plain `\.aia-scope/);
});

test('detect: the integration record is read', () => {
  const root = app();
  copyRuntime(root, 'lib/ai-agent');
  write(root, 'src/setup.js', INTEGRATION);
  write(root, 'ai-agent.integration.json', JSON.stringify({ skill: 'add-ai-skill', skillVersion: '1.3.0', updated: '2026-09-30', features: ['tools'] }));
  const r = detect(root);
  assert.equal(r.records[0].data.skillVersion, '1.3.0');
  assert.equal(r.features.record, true);
});

test('release fingerprints cover the current runtime and relays (run scripts/release-hashes.mjs after changing them)', async () => {
  const { normalizedHash } = await import('../scripts/detect.mjs');
  const { runtimeVersion, releases } = skillInfo();
  const rel = releases[runtimeVersion];
  assert.ok(rel, `scripts/release-hashes.json has no entry for ${runtimeVersion}: run node scripts/release-hashes.mjs`);
  for (const [f, h] of Object.entries(rel.runtime)) {
    assert.equal(normalizedHash(fs.readFileSync(path.join(RUNTIME, ...f.split('/')), 'utf8')), h, `${f} changed since its fingerprint: bump VERSION if it is a release, then run node scripts/release-hashes.mjs`);
  }
  for (const [f, h] of Object.entries(rel.relay)) {
    assert.equal(normalizedHash(fs.readFileSync(path.join(SKILL, 'assets', 'relay', f), 'utf8')), h, `${f} changed since its fingerprint: run node scripts/release-hashes.mjs`);
  }
});

test('createAgentKeys: top-level keys only, strings and comments ignored', () => {
  const src = "createAiAgent({ a: 1, /* b: 2 */ c: { d: 3 }, e: 'f: g', // h: i\n j: [k(l, { m: 1 })], `n`: 2 })";
  assert.deepEqual(createAgentKeys(src), ['a', 'c', 'e', 'j']);
});

test('detect: which features the runtime has and the integration uses, so an upgrade adds only what is missing', () => {
  // An app at 1.2: tools in use, no memory, a WebGL view, policy headers.
  const root = app();
  copyRuntime(root, 'lib/ai-agent', (t) => t.replace(/export const VERSION = '[^']+'/, "export const VERSION = '1.2.0'"));
  write(root, 'src/setup.js', INTEGRATION);
  write(root, 'src/ai-tools.json', '{"tools":{}}');
  write(root, 'src/view.js', "const gl = canvas.getContext('webgl2');");
  write(root, 'src/ai-upload.js', "import { agent } from './ai-agent-setup.js';\nconst r = new FileReader();\nr.onload = () => agent.ask(`Read this: ${r.result}`);");
  write(root, 'tests/view.test.js', "const gl = canvas.getContext('webgl');");
  write(root, '.htaccess', 'Header set Permissions-Policy "display-capture=()"\nHeader set Content-Security-Policy "default-src \'self\'; img-src \'self\'"');
  const r = detect(root);
  assert.equal(r.status, 'upgrade');
  assert.deepEqual([r.features.tools.inRuntime, r.features.tools.options, r.features.tools.config], [true, ['tools'], ['src/ai-tools.json']], 'tools are there: leave them');
  assert.deepEqual([r.features.memory.inRuntime, r.features.memory.options, r.features.memory.file], [false, [], []], 'memory is to add');
  assert.deepEqual([r.features.vision.inRuntime, r.features.vision.options], [false, []]);
  assert.deepEqual([r.features.attachments.inRuntime, r.features.attachments.options], [false, []], 'attachments arrive with 1.5');
  assert.ok(r.hints.some((h) => h.file === 'src/ai-upload.js' && /reads files for the agent itself[^\n]*`readFile` hook/.test(h.hint)), 'app-side file reading is a workaround the + button covers');
  const checks = r.checks.map((c) => `${c.file}: ${c.hint}`).join('\n');
  assert.match(checks, /src\/view\.js: draws with WebGL[^\n]*`screenshot` hook/);
  assert.doesNotMatch(checks, /tests\/view\.test\.js/, 'test files are not the app\'s view');
  assert.match(checks, /\.htaccess: sets display-capture in a Permissions-Policy/);
  assert.match(checks, /\.htaccess: Content-Security-Policy img-src without data:/);

  // The same app after the upgrade: nothing left to add, and no more hook hint.
  const done = app();
  copyRuntime(done, 'lib/ai-agent');
  write(done, 'src/setup.js', INTEGRATION.replace('tools: appTools,', "tools: appTools, memoryFile: 'ai-memory.json', screenshot: () => view.canvas,"));
  write(done, 'src/ai-memory.json', '{"version":1,"memories":[]}');
  write(done, 'src/view.js', "const gl = canvas.getContext('webgl2');");
  const d = detect(done);
  assert.equal(d.status, 'current');
  assert.deepEqual([d.features.memory.inRuntime, d.features.memory.options, d.features.memory.file], [true, ['memoryFile'], ['src/ai-memory.json']]);
  assert.deepEqual([d.features.vision.inRuntime, d.features.vision.options], [true, ['screenshot']]);
  assert.deepEqual([d.features.attachments.inRuntime, d.features.attachments.options], [true, []], 'on by default; no readFile hook needed');
  assert.deepEqual(d.checks, []);

  // No runtime copy in the folder: the features cannot be judged.
  const bare = app();
  write(bare, 'src/setup.js', INTEGRATION);
  assert.equal(detect(bare).features.memory.inRuntime, null);
});

test('detect: the 2.0 manifest and the 1.x record; capability folders with what is missing; dev-time folders kept apart', () => {
  const root = app();
  copyRuntime(root, 'public/ai-agent');
  write(root, 'public/js/setup.js', INTEGRATION.replace('tools: appTools,', "capabilities: 'ai/index.json', host: app,"));
  write(root, 'ai-agent.integration.json', JSON.stringify({ skill: 'add-ai-skill', skillVersion: '1.6.0', updated: '2026-09-30' }));
  write(root, 'public/ai/index.json', JSON.stringify({ format: 'ai-enablement/1', agents: ['agents/writer.md'], skills: ['skills/proofreading', 'skills/gone'], tools: ['tools/doc.js'], toolsConfig: 'ai-tools.json' }));
  write(root, 'public/ai/agents/writer.md', '---\nname: writer\ndescription: x\n---\n');
  write(root, 'public/ai/skills/proofreading/SKILL.md', '---\nname: proofreading\ndescription: x\n---\nx');
  write(root, 'public/ai/tools/doc.js', '// passes createAiAgent({ host }) — a comment, not a second integration\nexport default [];');
  write(root, '.claude/skills/deploy/SKILL.md', '---\nname: deploy\ndescription: dev-time\n---\n');
  write(root, '.claude/skills/deploy/index.json', JSON.stringify({ format: 'ai-enablement/1', tools: [] }));
  write(root, '.github/agents/reviewer.agent.md', '---\nname: reviewer\n---\n');
  const r = detect(root);
  assert.equal(r.status, 'current');
  assert.equal(r.integrations.length, 1, 'a createAiAgent mentioned in a comment is not an integration');
  assert.equal(r.legacyRecord, 'ai-agent.integration.json');
  assert.equal(r.manifest, null);
  assert.deepEqual(r.framework, { adopted: true, manifest: false, legacyRecord: true });
  assert.deepEqual(r.capabilities.map((c) => [c.file, c.agents, c.skills, c.tools, c.missing]), [['public/ai/index.json', 1, 2, 1, ['skills/gone', 'ai-tools.json']]], 'the index inside .claude/ is not the app\'s');
  assert.deepEqual(r.devTime.map((d) => d.dir), ['.claude/skills', '.github/agents']);
  assert.deepEqual(r.features.capabilities.options, ['capabilities', 'host']);
  assert.equal(r.features.skills.defined, 2);
  assert.equal(r.features.capabilities.inRuntime, true);

  write(root, 'ai-enablement.json', JSON.stringify({ skill: 'ai-enablement', skillVersion: '2.0.0', updated: '2026-10-02' }));
  const m = detect(root);
  assert.equal(m.manifest, 'ai-enablement.json');
  assert.equal(m.framework.manifest, true);
});

test('detect: a relay is compared with the skill\'s own relay version, not the runtime\'s', () => {
  const root = app();
  copyRuntime(root, 'assets/ai-agent');
  write(root, 'assets/js/setup.js', INTEGRATION);
  write(root, 'api/relay.php', fs.readFileSync(path.join(SKILL, 'assets', 'relay', 'relay.php'), 'utf8'));
  const r = detect(root);
  assert.equal(r.relays[0].unchanged, true);
  assert.equal(r.status, 'current', 'the current relay (its own version) is not an upgrade, whatever the runtime version is');
});
