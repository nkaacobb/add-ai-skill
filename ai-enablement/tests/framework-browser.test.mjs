// AI Enablement in a real browser: a capability index (Hello World's) with agents, skills, toolsets and permissions;
// the agent picker; skills loaded by the model and by /name; saved chats that bring their agent back; and the
// development workspace, where the in-app agent reads the app's source, writes a new tool and uses it — the
// motivating case. A fake OpenAI-compatible model scripts the replies. Skipped without a browser (see browser.test.mjs).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { launchBrowser, serveStatic, findBrowser } from '../scripts/lib/cdp.mjs';
import { startFakeUpstream } from './fixtures/fake-upstream.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.env.AIA_SKIP_BROWSER ? 'AIA_SKIP_BROWSER is set'
  : typeof WebSocket !== 'function' ? 'needs Node 22+ (global WebSocket)'
    : !findBrowser() ? 'no Edge/Chrome/Chromium found (set AIA_BROWSER)' : false;

let browser;
let server;
let page;

before(async () => {
  if (skip) return;
  server = await serveStatic(ROOT);
  browser = await launchBrowser({ width: 1366, height: 900 });
  page = browser.page;
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function fresh(base = server.url, harness = '/tests/browser/harness.html') {
  await page.viewport(1366, 900);
  await page.goto(`${base}${harness}`);
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    window.M = await import('/assets/ai-agent/ai-agent.js');
  });
  page.console.length = 0;
}

const systemOf = (chat) => chat.body.messages[0].content;
const toolNames = (chat) => (chat.body.tools || []).map((t) => t.function.name);
const toolMessages = (chat) => chat.body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
const card = (text) => page.waitFor((t) => [...document.querySelectorAll('.aia-tool-card:not([hidden])')].some((c) => c.textContent.includes(t)), { timeoutMs: 15000, args: [text] });
const clickCard = (choice) => page.evaluate((c) => document.querySelector(`.aia-tool-card:not([hidden]) [data-decide="${c}"]`).click(), choice);

/** A stand-in for Hello World's editor (the tools' `host`). */
const HOST = `{
  calls: [],
  findText(q) { this.calls.push(['findText', q]); return [{ line: 1, column: 1, lineText: 'Their wher' }]; },
  selection() { return { text: '', line: 1, col: 1 }; },
  insertText(t, w) { this.calls.push(['insertText', t, w]); },
  replaceText(f, r) { this.calls.push(['replaceText', f, r]); return 1; },
  renameFile(n) { this.calls.push(['renameFile', n]); },
  replaceDocument(t) { this.calls.push(['replaceDocument', t]); },
  newDocument() { this.calls.push(['newDocument']); },
  controls: {},
}`;

test('capabilities: agents, skills and permissions from a capability index, with the picker and saved chats', { skip, timeout: 120000 }, async () => {
  const upstream = await startFakeUpstream({
    cors: true,
    respond: (body, n) => [
      { toolCalls: [{ id: 'c1', name: 'use_skill', arguments: { name: 'proofreading' } }] },
      { toolCalls: [{ id: 'c2', name: 'read_skill_file', arguments: { skill: 'proofreading', path: 'references/checklist.md' } }] },
      { text: 'Their → There — homophone.' },
      // as the Proofreader: a denied tool, a tool outside its toolsets, then an answer
      { toolCalls: [{ id: 'c3', name: 'insert_text', arguments: { text: 'x' } }, { id: 'c4', name: 'rename_file', arguments: { name: 'a.txt' } }] },
      { text: 'I can only fix what you accept.' },
      { text: 'Checked with the skill.' },
    ][n - 1] || { text: 'Extra.' },
  });
  try {
    await fresh();
    const setup = await page.evaluate(async (url, host) => {
      window.host = (0, eval)(`(${host})`);
      document.body.insertAdjacentHTML('beforeend', '<main id="doc">Their wher some misteaks.</main>');
      window.agent = M.createAiAgent({
        appId: 'caps-e2e', launcher: false, devWarnings: false, screenshots: false, attachments: false, title: 'Writing agent',
        capabilities: '/examples/hello-world/ai/index.json', host: window.host,
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'fake-model' } } },
        page: { id: 'editor', title: 'Editor', content: () => document.getElementById('doc').textContent },
      });
      await agent.ready;
      const pick = document.querySelector('.aia-agent-pick');
      return {
        agents: agent.agents.list().map((a) => [a.name, a.active]),
        skills: agent.skills.list().map((s) => s.name),
        picker: { hidden: pick.hidden, options: [...pick.options].map((o) => o.textContent) },
        welcome: document.querySelector('.aia-welcome').textContent,
        perms: Object.fromEntries(agent.tools.list().map((t) => [t.name, t.permission])),
        toolsets: agent.tools.toolsets().map((ts) => ts.name),
        mcp: agent.tools.mcp().find((t) => t.name === 'set_editor_settings'),
        problems: agent.capabilities.problems(),
      };
    }, upstream.url, HOST);
    assert.deepEqual(setup.problems, []);
    assert.deepEqual(setup.agents, [['writer', true], ['proofreader', false]]);
    assert.deepEqual(setup.skills, ['proofreading', 'summarize']);
    assert.deepEqual(setup.picker, { hidden: false, options: ['Writing agent', 'Proofreader'] });
    assert.match(setup.welcome, /I can read the document in the editor[\s\S]*Summarize this document/, 'the agent\'s own welcome and suggestions');
    assert.equal(setup.perms.rename_file, 'ask', 'the index\'s "ask: toolset:file"');
    assert.equal(setup.perms.find_text, 'default');
    assert.deepEqual(setup.toolsets, ['document', 'editor', 'file']);
    assert.deepEqual(setup.mcp.inputSchema.properties.fontSize, { type: 'integer', minimum: 11, maximum: 24, description: 'Font size in px, 11-24.' });

    // The writer: the model loads the proofreading skill, then reads a file it points to.
    await page.evaluate(() => agent.ask('Proofread this'));
    const [first, second, third] = upstream.chats();
    assert.match(systemOf(first), /== AGENT: Writing agent ==[\s\S]*== SKILLS ==[\s\S]*- proofreading — [\s\S]*- summarize — /);
    assert.doesNotMatch(systemOf(first), /== SKILL: proofreading/);
    assert.ok(['use_skill', 'read_skill_file', 'find_text', 'set_editor_settings', 'request_tool'].every((n) => toolNames(first).includes(n)), toolNames(first).join());
    assert.match(systemOf(second), /== SKILL: proofreading \(active\) ==\n# Proofreading/, 'an active skill is in the system prompt from the next request on');
    assert.match(toolMessages(second)[0], /The skill "proofreading" is active[\s\S]*find_text \(on\), replace_text \(on\), get_selection \(on\)/);
    assert.match(toolMessages(third).at(-1), /^proofreading\/references\/checklist\.md \([\d,]+ characters\):\n\n# Proofreading checklist/);
    assert.deepEqual(await page.evaluate(() => agent.skills.active()), ['proofreading']);

    // The proofreader: another agent, a new chat; its tools are its toolset minus what it denies.
    const switched = await page.evaluate(() => {
      const ok = agent.agents.use('proofreader');
      return { ok, current: agent.agents.current(), skillsActive: agent.skills.active(), welcome: document.querySelector('.aia-welcome').textContent, messages: document.querySelectorAll('.aia-drawer .aia-msg.aia-user').length };
    });
    assert.deepEqual([switched.ok, switched.current, switched.skillsActive, switched.messages], [true, 'proofreader', [], 0]);
    assert.match(switched.welcome, /I check the document for spelling/);
    await page.evaluate(() => agent.ask('Fix it'));
    const [fourth, fifth] = upstream.chats().slice(3);
    assert.deepEqual(toolNames(fourth).sort(), ['find_text', 'get_selection', 'read_skill_file', 'replace_text', 'use_skill'], 'no insert_text (denied), no file or editor tools (not its toolsets), no memory tools (memory: read)');
    assert.match(systemOf(fourth), /== AGENT: Proofreader ==[\s\S]*careful proofreader/);
    assert.match(systemOf(fourth), /You cannot save or change memories/);
    assert.deepEqual(toolMessages(fifth), [
      'insert_text is not permitted in this application for the Proofreader agent. Do not call it; tell the user if it matters.',
      'rename_file is not one of the Proofreader agent\'s tools. Use the tools you were given.',
    ]);
    assert.deepEqual(await page.evaluate(() => window.host.calls.filter((c) => c[0] !== 'findText')), [], 'nothing ran');

    // "/proofreading …" activates the skill for that very request.
    await page.evaluate(() => agent.ask('/proofreading check the first line'));
    const sixth = upstream.chats()[5];
    assert.match(systemOf(sixth), /== SKILL: proofreading \(active\) ==/);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.aia-sync-skill')].pop()?.textContent), 'Skill · proofreading');

    // Saved chats bring their agent and their active skills back.
    const restored = await page.evaluate(async () => {
      const chats = JSON.parse(localStorage.getItem('caps-e2e.ai.chats'));
      const writerChat = chats.find((c) => c.agent === 'writer');
      document.querySelector('.aia-drawer [data-act="library"]').click();
      document.querySelector(`[data-chat-open="${writerChat.id}"]`).click();
      return { saved: chats.map((c) => [c.agent, c.skills]), current: agent.agents.current(), active: agent.skills.active(), picker: document.querySelector('.aia-agent-pick').value };
    });
    assert.deepEqual(restored.saved.sort(), [['proofreader', ['proofreading']], ['writer', ['proofreading']]]);
    assert.deepEqual([restored.current, restored.picker, restored.active], ['writer', 'writer', ['proofreading']]);
  } finally {
    await upstream.close();
  }
});

test('permissions: "ask" confirms even a reading tool; "deny" hides a tool from the model and from request_tool', { skip, timeout: 60000 }, async () => {
  const upstream = await startFakeUpstream({
    cors: true,
    respond: (body, n) => [
      { toolCalls: [{ id: 'c1', name: 'peek', arguments: {} }] },
      { toolCalls: [{ id: 'c2', name: 'request_tool', arguments: { name: 'wipe' } }] },
      { text: 'Done.' },
    ][n - 1] || { text: 'Extra.' },
  });
  try {
    await fresh();
    await page.evaluate((url) => {
      window.agent = M.createAiAgent({
        appId: 'perm-e2e', launcher: false, devWarnings: false, memory: false, screenshots: false, attachments: false,
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'm' } } },
        permissions: { ask: ['peek'], deny: ['wipe'] },
        tools: [
          { name: 'peek', description: 'Look.', effect: 'read', enabled: true, run: () => 'seen' },
          { name: 'wipe', description: 'Wipe everything.', effect: 'destructive', run: () => 'wiped' },
          { name: 'later', description: 'Off for now.', effect: 'write', run: () => 'ok' },
        ],
      });
      window.done = agent.ask('Look, then wipe');
    }, upstream.url);
    await card('The application asks before this tool runs');
    await clickCard('run');
    await page.evaluate(() => window.done);
    const [first, second, third] = upstream.chats();
    assert.deepEqual(toolNames(first), ['peek', 'request_tool']);
    assert.deepEqual(first.body.tools[1].function.parameters.properties.name.enum, ['later'], 'a denied tool cannot even be asked for');
    assert.doesNotMatch(systemOf(first), /wipe/, 'the model is not told about a denied tool');
    assert.deepEqual(toolMessages(second), ['seen']);
    assert.match(toolMessages(third).at(-1), /There is no tool named "wipe"/);
    const settings = await page.evaluate(() => {
      agent.openSettings('tools');
      const row = document.querySelector('.aia-modal [data-tool="wipe"]');
      return { disabled: row.disabled, badge: row.closest('.aia-tool-row').querySelector('.aia-badge-deny')?.textContent, ask: document.querySelector('.aia-modal [data-tool="peek"]').closest('.aia-tool-row').querySelector('.aia-badge-ask')?.textContent };
    });
    assert.deepEqual(settings, { disabled: true, badge: 'blocked', ask: 'always asks' });
  } finally {
    await upstream.close();
  }
});

test('workspace: the in-app agent reads the app\'s code, writes a new tool (each file confirmed), loads and uses it', { skip, timeout: 120000 }, async () => {
  const { createWorkspace } = await import('../scripts/workspace.mjs');
  const { createStaticHandler } = await import('../assets/relay/relay.mjs');
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-ws-app-'));
  const put = (rel, text) => { const p = path.join(app, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  put('src/editor.js', 'export const editor = {\n  text: "one two three",\n  countWords() { return this.text.split(/\\s+/).filter(Boolean).length; },\n};\n');
  put('ai/index.json', `${JSON.stringify({ format: 'ai-enablement/1', tools: ['tools/basics.js'] }, null, 2)}\n`);
  put('ai/tools/basics.js', 'export default { name: "basics", title: "Basics", tools: [{ name: "get_text", description: "The text.", effect: "read", enabled: true, run: (a, { host }) => host.text }] };\n');
  put('index.html', '<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/assets/ai-agent/ai-agent.css"></head><body><main id="main"></main></body></html>');

  const ws = createWorkspace({ root: app, log: () => {} });
  const runtime = createStaticHandler(ROOT);
  const site = createStaticHandler(app);
  const srv = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    if (p === '/ai-workspace') return ws.handle(req, res);
    if (p.startsWith('/assets/')) return runtime(req, res);
    return site(req, res);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;

  const tool = 'export default {\n  name: "count_words",\n  title: "Count words",\n  description: "How many words the document has.",\n  effect: "read",\n  run: (args, { host }) => `${host.countWords()} words`,\n};\n';
  const index = `${JSON.stringify({ format: 'ai-enablement/1', tools: ['tools/basics.js', 'tools/count_words.js'] }, null, 2)}\n`;
  const upstream = await startFakeUpstream({
    cors: true,
    respond: (body, n) => [
      { toolCalls: [{ id: 'w1', name: 'use_skill', arguments: { name: 'create-tool' } }] },
      { toolCalls: [{ id: 'w2', name: 'search_source', arguments: { query: 'countWords' } }] },
      { toolCalls: [{ id: 'w3', name: 'read_source_file', arguments: { path: 'src/editor.js' } }] },
      { toolCalls: [{ id: 'w4', name: 'write_ai_file', arguments: { path: 'ai/tools/count_words.js', content: tool } }] },
      { toolCalls: [{ id: 'w5', name: 'write_ai_file', arguments: { path: 'ai/index.json', content: index } }] },
      { toolCalls: [{ id: 'w5b', name: 'write_ai_file', arguments: { path: 'ai/index.json', content: index, replace: true } }] },
      { toolCalls: [{ id: 'w6', name: 'reload_capabilities', arguments: {} }] },
      { toolCalls: [{ id: 'w7', name: 'count_words', arguments: {} }] },
      { text: 'Added count_words: the document has 3 words.' },
    ][n - 1] || { text: 'Extra.' },
  });
  try {
    await fresh(base, '/index.html');
    await page.evaluate(async (url) => {
      const { editor } = await import('/src/editor.js');
      window.agent = M.createAiAgent({
        appId: 'ws-e2e', launcher: false, devWarnings: false, memory: false, screenshots: false, attachments: false,
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'm' } } },
        capabilities: '/ai/index.json', host: editor, workspace: true,
      });
      await agent.ready;
      window.done = agent.ask('Add a tool that counts the words of the document.');
    }, upstream.url);

    await card('Create ai/tools/count_words.js');
    const shown = await page.evaluate(() => document.querySelector('.aia-tool-card:not([hidden]) .aia-tool-file')?.textContent);
    assert.equal(shown, tool, 'the whole file is shown before it is written');
    assert.equal(fs.existsSync(path.join(app, 'ai/tools/count_words.js')), false, 'nothing is written before the user says so');
    await clickCard('run');
    await card('Replace ai/index.json');      // creating it was refused before any card; replacing shows the changes
    const diff = await page.evaluate(() => ({
      added: [...document.querySelectorAll('.aia-tool-card:not([hidden]) .aia-diff-add')].map((s) => s.textContent),
      count: document.querySelector('.aia-tool-card:not([hidden]) .aia-diff-count')?.textContent,
    }));
    assert.ok(diff.added.some((l) => l.includes('tools/count_words.js')), JSON.stringify(diff));
    assert.match(diff.count, /1 line removed, 2 added/);
    await clickCard('run');
    await card('Count words');            // the new tool starts off: "Turn on and run"
    await clickCard('on');
    await page.evaluate(() => window.done);

    const chats = upstream.chats();
    assert.ok(['list_source_files', 'read_source_file', 'search_source', 'write_ai_file', 'reload_capabilities', 'use_skill'].every((n) => toolNames(chats[0]).includes(n)), toolNames(chats[0]).join());
    assert.match(systemOf(chats[0]), /- create-tool — Add a new tool/);
    assert.match(toolMessages(chats[2]).at(-1), /src\/editor\.js:3: countWords\(\)/);
    assert.match(toolMessages(chats[3]).at(-1), /^src\/editor\.js \(\d+ characters\):\n\nexport const editor/);
    assert.match(toolMessages(chats[4]).at(-1), /Created ai\/tools\/count_words\.js/);
    assert.match(toolMessages(chats[5]).at(-1), /^Not run: ai\/index\.json already exists\. A new tool goes in a new file/, 'creating a file that exists is refused, with what to do instead');
    assert.match(toolMessages(chats[7]).at(-1), /Reloaded: 2 tools[\s\S]*No problems/);
    assert.ok(toolNames(chats[7]).includes('request_tool'), 'the new tool is known (off) right after the reload');
    assert.equal(toolMessages(chats[8]).at(-1), '3 words', 'the new tool ran the app\'s own function');
    assert.equal(fs.readFileSync(path.join(app, 'ai/tools/count_words.js'), 'utf8'), tool);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'ai/index.json'), 'utf8')).tools, ['tools/basics.js', 'tools/count_words.js']);
    assert.deepEqual(await page.evaluate(() => agent.tools.list().map((t) => [t.name, t.enabled])), [['get_text', true], ['count_words', true]]);
    assert.equal(await page.evaluate(() => agent.workspace()?.aiDir), 'ai');

    // A reload also re-reads the tool config the index names: a new default applies at once, a misnamed key is reported.
    const reloaded = await page.evaluate(async () => {
      const post = (path, content) => fetch('/ai-workspace', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'ai-agent-drawer' }, body: JSON.stringify({ path, content, replace: true }) }).then((r) => r.json());
      agent.tools.setEnabled('count_words', false);
      agent.settings.save({ toolStates: {} });
      await post('ai/index.json', JSON.stringify({ format: 'ai-enablement/1', tools: ['tools/basics.js', 'tools/count_words.js', 'tools/later.js'], toolsConfig: 'ai-tools.json' }));
      await post('ai/tools/later.js', 'export default { name: "later", description: "Later.", effect: "read", run: () => 1 };');
      await post('ai/ai-tools.json', JSON.stringify({ tools: { later: { enabled: true }, basics: { enabled: true } } }));
      const problems = await agent.capabilities.reload();
      return { problems, later: agent.tools.list().find((t) => t.name === 'later')?.enabled };
    });
    assert.equal(reloaded.later, true, 'the tool config written in the workspace applies without a page reload');
    assert.deepEqual(reloaded.problems, ['tool config: "basics" is not a tool of this application (key it by the tool\'s name).']);
  } finally {
    await upstream.close();
    srv.close();
  }
});
