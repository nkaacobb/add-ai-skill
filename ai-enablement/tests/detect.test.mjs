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

/* ------------------------------------------------------------------------------------------ layout guards */

const GUARD_BLOCKS = /\/\* aia-guard: (pinned-chrome|host-isolation)[\s\S]*?\/\* end aia-guard: \1 \*\/\n?/g;
const unguarded = () => fs.readFileSync(path.join(RUNTIME, 'ai-agent.css'), 'utf8').replace(GUARD_BLOCKS, '');
// The fix one app added to its runtime's ai-agent.css by hand before 1.6.1 (no marker comment).
const HAND_MADE = `
/* Head, tabs and foot never shrink: only the body scrolls. */
.aia-modal-head, .aia-tabs, .aia-modal-foot { flex-shrink: 0; }
.aia-modal-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 14px; scrollbar-width: thin; }
`;

test('detect: layoutGuards — a runtime with both guards, one with neither, and one with the hand-made fix', () => {
  const both = app();
  copyRuntime(both, 'public/ai-agent');
  write(both, 'public/js/setup.js', INTEGRATION);
  const g = detect(both).layoutGuards;
  assert.equal(g.length, 1);
  assert.deepEqual([g[0].dir, g[0].css, g[0].version], ['public/ai-agent', 'public/ai-agent/ai-agent.css', skillInfo().runtimeVersion]);
  assert.deepEqual([g[0].pinnedChrome, g[0].hostIsolation, g[0].missing, g[0].fix], [true, true, [], null]);
  assert.deepEqual(g[0].markers, ['pinned-chrome', 'host-isolation']);

  const neither = app();
  copyRuntime(neither, 'public/ai-agent');
  write(neither, 'public/ai-agent/ai-agent.css', unguarded());
  write(neither, 'public/js/setup.js', INTEGRATION);
  const n = detect(neither).layoutGuards[0];
  assert.deepEqual([n.pinnedChrome, n.hostIsolation, n.missing, n.fix], [false, false, ['pinned-chrome', 'host-isolation'], 'patch'], 'an edited copy is patched in place');
  assert.deepEqual(n.details.flexShrink, { 'aia-modal-head': '1', 'aia-tabs': '1', 'aia-modal-foot': '1' });

  const hand = app();
  copyRuntime(hand, 'public/ai-agent');
  write(hand, 'public/ai-agent/ai-agent.css', unguarded() + HAND_MADE);
  write(hand, 'public/js/setup.js', INTEGRATION);
  const h = detect(hand).layoutGuards[0];
  assert.deepEqual([h.pinnedChrome, h.hostIsolation, h.missing], [true, false, ['host-isolation']], 'the hand-made Bug 1 CSS counts as pinned chrome');
  assert.deepEqual(h.details, { flexShrink: { 'aia-modal-head': '0', 'aia-tabs': '0', 'aia-modal-foot': '0' }, bodyMinHeight: '0' });

  // Weaker or conditional rules do not count: a later, more specific `flex: 1` on .aia-tabs, or the fix in a media query.
  const weak = app();
  copyRuntime(weak, 'public/ai-agent');
  write(weak, 'public/ai-agent/ai-agent.css', `${unguarded()}${HAND_MADE}.aia-scope .aia-tabs { flex: 1; }\n`);
  assert.equal(detect(weak).layoutGuards[0].pinnedChrome, false, 'a stronger flex: 1 wins');
  write(weak, 'public/ai-agent/ai-agent.css', `${unguarded()}@media (min-width: 900px) {${HAND_MADE}}\n`);
  assert.equal(detect(weak).layoutGuards[0].pinnedChrome, false, 'only on wide screens is not pinned');
});

test('detect: an unchanged release without the guards is replaced, an edited one patched; the summary says so', async () => {
  // An unchanged copy of a release that predates the guards (as 1.6.0 did), fingerprinted as that release.
  const root = app();
  copyRuntime(root, 'public/ai-agent', (t) => t.replace(/export const VERSION = '[^']+'/, "export const VERSION = '1.6.0'"));
  write(root, 'public/ai-agent/ai-agent.css', unguarded());
  write(root, 'public/js/setup.js', INTEGRATION);
  const { normalizedHash } = await import('../scripts/detect.mjs');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const dir = path.join(root, 'public', 'ai-agent');
  const runtime = Object.fromEntries(walk(dir).map((f) => [path.relative(dir, f).split(path.sep).join('/'), normalizedHash(fs.readFileSync(f, 'utf8'))]));
  const info = skillInfo();
  const r = detect(root, { ...info, releases: { ...info.releases, '1.6.0': { runtime, relay: {} } } });
  assert.equal(r.status, 'upgrade');
  assert.deepEqual([r.layoutGuards[0].fix, r.layoutGuards[0].missing], ['replace', ['pinned-chrome', 'host-isolation']]);

  // The human summary (the CLI, with the real fingerprints: this copy is not the real 1.6.0, so it is patched).
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'detect.mjs'), root], { encoding: 'utf8' });
  assert.match(out, /Layout guards/);
  assert.match(out, /public\/ai-agent\/ai-agent\.css {2}pinned chrome: MISSING · host isolation: MISSING — FIX IN THIS RUN: node <skill>\/scripts\/guards\.mjs <app-root> --apply/);
  assert.match(out, /Layout guards missing in public\/ai-agent\/ai-agent\.css: fix them in this run, whatever the task/);
  const json = JSON.parse(execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'detect.mjs'), root, '--json'], { encoding: 'utf8' }));
  assert.equal(json.layoutGuards[0].hostIsolation, false);
  assert.ok(Array.isArray(json.hostRules));
});

test('detect: the host\'s global element rules (CSS files and inline <style>), and app CSS the guards make redundant', () => {
  const root = app();
  copyRuntime(root, 'public/ai-agent');
  write(root, 'public/js/setup.js', INTEGRATION);
  write(root, 'public/css/app.css', `/* the lab */
label { display: flex; justify-content: space-between; align-items: center; gap: .85rem; color: #9aa; font-size: .92rem; }
.panel label { color: red; }
body { margin: 0; text-align: center; }
body.dark input[type=number], select { width: 100%; }
button:hover { transform: translateY(-1px); }
button.primary { background: blue; }
@media (max-width: 600px) { p { margin: 0; } }
.aia-tabs { flex-shrink: 0; }
.aia-scope .aia-field { align-items: stretch !important; }
`);
  write(root, 'public/index.html', '<html><head><style>\n  h2 { margin: 2em 0 }\n</style></head><body></body></html>');
  write(root, 'src/Panel.vue', '<template><label>x</label></template><style scoped>label { display: block }</style>');
  write(root, 'tests/fixture.css', 'label { color: red }');
  const r = detect(root);
  const rules = r.hostRules.map((h) => `${h.file}:${h.line} ${h.selector} {${h.props.join(',')}}${h.media ? ` ${h.media}` : ''}`).sort();
  assert.deepEqual(rules, [
    'public/css/app.css:2 label {display,justify-content,align-items,gap,color,font-size}',
    'public/css/app.css:4 body {text-align: center}',
    'public/css/app.css:5 body.dark input[type=number] {width}',
    'public/css/app.css:5 select {width}',
    'public/css/app.css:6 button:hover {transform}',
    'public/css/app.css:8 p {margin} @media (max-width: 600px)',
    'public/index.html <style>:2 h2 {margin}',
  ], '.panel label, button.primary, scoped Vue styles and test files are not global element rules');
  const hints = r.hints.filter((h) => /guard/.test(h.hint)).map((h) => `${h.file}: ${h.hint}`);
  assert.equal(hints.length, 2);
  assert.match(hints[0], /^public\/css\/app\.css:9: \.aia-tabs sets flex-shrink: 0: the runtime's pinned-chrome guard/);
  assert.match(hints[1], /^public\/css\/app\.css:10: \.aia-scope \.aia-field overrides the settings dialog with !important \(align-items\)/);
});
