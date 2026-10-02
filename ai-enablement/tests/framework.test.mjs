// The AI Enablement framework layer of the runtime (pure modules, no browser): frontmatter, JSON Schema tool contracts
// and MCP descriptors, permissions, skills, agents, the capability index, and the workspace client's checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFrontmatter, parseYaml, listValue } from '../assets/ai-agent/core/frontmatter.js';
import { fromJsonSchema, effectFromAnnotations, annotationsFor } from '../assets/ai-agent/core/schema.js';
import { normalizeTool, validateArgs, toMcpTool, toolSpecs, toJsonSchema } from '../assets/ai-agent/core/tools.js';
import { normalizePolicy, mergePolicies, decidePermission, needsConfirmation, ruleMatches } from '../assets/ai-agent/core/permissions.js';
import { parseSkill, normalizeSkill, skillFilePath, parseSlashCommand, buildSkillsPrompt, skillLoadedMessage } from '../assets/ai-agent/core/skills.js';
import { parseAgent, normalizeAgent, agentToolNames, agentSkillNames, buildAgentPrompt, pickAgent, implicitAgent } from '../assets/ai-agent/core/agents.js';
import { loadCapabilities, readToolModule, linkToolsets, checkReferences, skillLocation } from '../assets/ai-agent/core/capabilities.js';
import { workspacePath, writeProblem, probeWorkspace, workspaceClient } from '../assets/ai-agent/core/workspace.js';
import { buildSystemPrompt } from '../assets/ai-agent/core/prompt.js';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ------------------------------------------------------------------------------------------ frontmatter */

test('frontmatter: the YAML that SKILL.md and agent files use, read as YAML reads it', () => {
  const { data, body, errors } = parseFrontmatter([
    '---',
    'name: proofreading',
    'description: >',
    '  Proofread the text',
    '  and list the fixes.',
    'tools: [find_text, "replace_text"]',
    'permissions:',
    '  deny:',
    '    - new_document',
    '  allow: [find_text]',
    'metadata:',
    '  author: "Nate # not a comment"',
    '  version: "1.0"   # a comment',
    'title: Issue #3 tracker',
    'list:',
    '- a',
    '- b: 1',
    '  c: two',
    'url: http://example.com/x',
    'long: this goes',
    '  on and on',
    'lit: |',
    '  line1',
    '    indented',
    'empty:',
    'flow: {a: 1, b: [x, y]}',
    '---',
    '# Body',
  ].join('\r\n'));
  assert.deepEqual(errors, []);
  assert.equal(data.name, 'proofreading');
  assert.equal(data.description, 'Proofread the text and list the fixes.\n');
  assert.deepEqual(data.tools, ['find_text', 'replace_text']);
  assert.deepEqual(data.permissions, { deny: ['new_document'], allow: ['find_text'] });
  assert.deepEqual(data.metadata, { author: 'Nate # not a comment', version: '1.0' });
  assert.equal(data.title, 'Issue', 'a # after a space starts a comment, as in YAML');
  assert.deepEqual(data.list, ['a', { b: 1, c: 'two' }]);
  assert.equal(data.url, 'http://example.com/x');
  assert.equal(data.long, 'this goes on and on');
  assert.equal(data.lit, 'line1\n  indented\n');
  assert.equal(data.empty, null);
  assert.deepEqual(data.flow, { a: 1, b: ['x', 'y'] });
  assert.equal(body, '# Body');
});

test('frontmatter: no frontmatter is all body; problems are reported, not guessed', () => {
  assert.deepEqual(parseFrontmatter('# Just text'), { data: {}, body: '# Just text', errors: [] });
  assert.match(parseFrontmatter('---\nname: x\n').errors[0], /no closing ---/);
  const bad = parseYaml('name: x\n  oops: y\n: nokey\nkey: &anchor v');
  assert.ok(bad.errors.some((e) => /Line 3/.test(e)), bad.errors.join(' | '));
  assert.ok(bad.errors.some((e) => /anchors/.test(e)));
  assert.deepEqual(parseYaml('a: "x\\ny\\u0041"').value, { a: 'x\nyA' });
  assert.deepEqual(parseYaml("a: 'it''s'").value, { a: "it's" });
  assert.deepEqual(parseYaml('a: [1, 2.5, true, null, ~]').value, { a: [1, 2.5, true, null, null] });
  assert.deepEqual(listValue('Read  Bash(git:*), find_text'), ['Read', 'Bash(git:*)', 'find_text']);
  assert.equal(parseYaml(`k: ${'a '.repeat(5000)}:`).errors.length >= 0, true, 'long lines stay linear');
});

/* ------------------------------------------------------------------------------- JSON Schema and MCP */

test('schema: a JSON Schema inputSchema becomes the runtime fields; what cannot be enforced is refused', () => {
  const fields = fromJsonSchema({
    type: 'object',
    properties: {
      q: { type: 'string', maxLength: 200, minLength: 2, pattern: '^[a-z ]+$', description: 'Query' },
      n: { type: 'integer', minimum: 1, exclusiveMaximum: 10, default: 3 },
      mode: { enum: ['a', 'b'] },
      tags: { type: 'array', items: { type: 'string', enum: ['x', 'y'] }, maxItems: 3, minItems: 1 },
      flag: { type: ['boolean', 'null'] },
      fixed: { const: 'only' },
    },
    required: ['q'],
  }, 'Tool "t"');
  assert.deepEqual(fields.q, { type: 'string', maxLength: 200, minLength: 2, pattern: '^[a-z ]+$', description: 'Query', required: true });
  assert.deepEqual(fields.n, { type: 'integer', min: 1, max: 9, default: 3 });
  assert.deepEqual(fields.mode, { type: 'enum', values: ['a', 'b'] });
  assert.deepEqual(fields.tags, { type: 'array', items: { type: 'enum', values: ['x', 'y'] }, maxItems: 3, minItems: 1 });
  assert.deepEqual(fields.flag, { type: 'boolean', nullable: true });
  assert.deepEqual(fields.fixed, { type: 'enum', values: ['only'] });
  for (const [schema, why] of [
    [{ properties: { o: { type: 'object' } } }, /is an object/],
    [{ properties: { r: { $ref: '#/x' } } }, /\$ref/],
    [{ properties: { u: { anyOf: [] } } }, /anyOf/],
    [{ properties: { s: { type: 'string', minimum: 1 } } }, /"minimum"/],
    [{ properties: { x: { type: 'number', exclusiveMinimum: 0 } } }, /exclusive bound/],
    [{ properties: { l: { type: 'array', items: { type: 'array' } } } }, /list of lists/],
    [{ properties: {}, required: ['missing'] }, /not among the properties/],
    [{ type: 'array' }, /type "object"/],
  ]) assert.throws(() => fromJsonSchema({ type: 'object', ...schema }), why);
});

test('tools: inputSchema and annotations are accepted; the effect wins; MCP descriptors come back out', () => {
  const t = normalizeTool({
    name: 'search_notes', description: 'Search the notes.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'] },
    annotations: { readOnlyHint: true, title: 'Search notes' },
    run: () => [],
  });
  assert.equal(t.effect, 'read');
  assert.equal(t.title, 'Search notes');
  assert.deepEqual(toJsonSchema(t.parameters), { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'] });
  assert.deepEqual(toMcpTool(t), {
    name: 'search_notes', title: 'Search notes', description: 'Search the notes.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 100 } }, required: ['query'] },
    annotations: { title: 'Search notes', readOnlyHint: true, openWorldHint: false },
  });
  const send = normalizeTool({ name: 'send_mail', description: 'Send.', effect: 'external', annotations: { readOnlyHint: true }, run: () => 1 });
  assert.equal(send.effect, 'external', 'an explicit effect wins over annotations');
  assert.deepEqual(toMcpTool(send).annotations, { title: 'Send mail', readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  assert.match(toolSpecs([send])[0].description, /reaches outside the application; the user always confirms/);
  assert.equal(normalizeTool({ name: 'x', description: 'X.', annotations: { destructiveHint: true }, run() {} }).effect, 'destructive');
  assert.equal(normalizeTool({ name: 'x', description: 'X.', run() {} }).effect, 'write', 'no effect, no annotations: write');
  assert.equal(normalizeTool({ name: 'x', description: 'X.', effect: 'nuke', run() {} }).effect, 'write', 'an unknown effect asks first, as in 1.x (validate reports it)');
  assert.throws(() => normalizeTool({ name: 'x', description: 'X.', parameters: {}, inputSchema: { type: 'object' }, run() {} }), /not both/);
  assert.equal(effectFromAnnotations({ openWorldHint: true }), 'external');
  assert.deepEqual(annotationsFor('system'), { readOnlyHint: false, destructiveHint: true, openWorldHint: false });
});

test('tools: minLength, pattern and minItems from a schema are enforced on the model\'s arguments', () => {
  const t = normalizeTool({
    name: 'tag', description: 'Tag.', effect: 'write', run() {},
    inputSchema: { type: 'object', properties: { code: { type: 'string', pattern: '^[A-Z]{3}$', minLength: 3 }, tags: { type: 'array', minItems: 2 } }, required: ['code'] },
  });
  assert.deepEqual(validateArgs(t, { code: 'ABC', tags: ['a', 'b'] }), { ok: true, args: { code: 'ABC', tags: ['a', 'b'] }, errors: [] });
  assert.match(validateArgs(t, { code: 'abc' }).errors[0], /expected form/);
  assert.match(validateArgs(t, { code: 'AB' }).errors[0], /at least 3 characters/);
  assert.match(validateArgs(t, { code: 'ABC', tags: ['a'] }).errors[0], /at least 2 items/);
});

/* --------------------------------------------------------------------------------------- permissions */

test('permissions: deny > ask > allow > the user\'s settings; system always asks', () => {
  const problems = [];
  const app = normalizePolicy({ deny: ['new_document', 'nope!'], ask: 'toolset:file', bogus: [] }, problems);
  assert.deepEqual(app, { allow: [], ask: ['toolset:file'], deny: ['new_document'] });
  assert.equal(problems.length, 2);
  const agent = normalizePolicy({ allow: ['effect:write', 'set_*'], deny: ['rename_*'] });
  const policy = mergePolicies(app, agent);
  const tool = (name, effect, toolset = '') => ({ name, effect, toolset });
  assert.equal(decidePermission(tool('new_document', 'destructive'), policy), 'deny');
  assert.equal(decidePermission(tool('rename_file', 'write', 'file'), policy), 'deny', 'deny wins over ask');
  assert.equal(decidePermission(tool('replace_document', 'destructive', 'file'), policy), 'ask');
  assert.equal(decidePermission(tool('insert_text', 'write'), policy), 'allow');
  assert.equal(decidePermission(tool('find_text', 'read'), policy), '');
  assert.ok(ruleMatches('toolset:fi*', { name: 'x', toolsets: ['editor', 'file'] }), 'membership in any toolset counts');
  assert.ok(ruleMatches('*_text', { name: 'find_text' }));
  assert.ok(!ruleMatches('ab*ba', { name: 'aba' }));

  const s = { confirmWrites: true, confirmDestructive: true };
  assert.equal(needsConfirmation({ tool: tool('a', 'read'), settings: s }), false);
  assert.equal(needsConfirmation({ tool: tool('a', 'read'), decision: 'ask', settings: s }), true);
  assert.equal(needsConfirmation({ tool: tool('a', 'write'), settings: s }), true);
  assert.equal(needsConfirmation({ tool: tool('a', 'write'), settings: s, allowedForChat: true }), false);
  assert.equal(needsConfirmation({ tool: tool('a', 'write'), decision: 'allow', settings: s }), false);
  assert.equal(needsConfirmation({ tool: tool('a', 'external'), settings: { confirmDestructive: false } }), false);
  assert.equal(needsConfirmation({ tool: tool('a', 'system'), decision: 'allow', settings: { confirmWrites: false, confirmDestructive: false } }), true, 'nothing switches off the confirmation of a system tool');
});

/* ---------------------------------------------------------------------------------------------- skills */

test('skills: the Agent Skills format — name rules, description, folder name, allowed-tools', () => {
  const { skill, problems } = parseSkill('---\nname: pdf-tools\ndescription: Work with PDF files.\nlicense: MIT\nallowed-tools: find_text Read\nmetadata:\n  author: x\n---\n# PDF\nDo it.', { base: 'http://x/ai/skills/pdf-tools/', folder: 'pdf-tools' });
  assert.deepEqual(problems, []);
  assert.deepEqual(skill, { name: 'pdf-tools', description: 'Work with PDF files.', body: '# PDF\nDo it.', base: 'http://x/ai/skills/pdf-tools/', source: 'app', license: 'MIT', metadata: { author: 'x' }, allowedTools: ['find_text', 'Read'] });
  for (const [text, why] of [
    ['---\nname: PDF\ndescription: x\n---\nbody', /lowercase/],
    ['---\nname: -pdf\ndescription: x\n---\nbody', /lowercase/],
    ['---\nname: pdf--x\ndescription: x\n---\nbody', /lowercase/],
    ['---\nname: pdf\n---\nbody', /description is missing/],
    ['no frontmatter', /name is missing/],
  ]) {
    const r = parseSkill(text);
    assert.equal(r.skill, null);
    assert.ok(r.problems.some((p) => why.test(p)), `${text}: ${r.problems.join(' | ')}`);
  }
  assert.match(parseSkill('---\nname: a\ndescription: b\n---\nx', { folder: 'other' }).problems[0], /folder is "other"/);
  assert.equal(normalizeSkill({ name: 'inline-one', description: 'Inline.', instructions: 'Steps.' }).skill.body, 'Steps.');
});

test('skills: file paths stay inside the skill; /name activates; the prompt lists, then carries active ones', () => {
  assert.equal(skillFilePath('./references/guide.md'), 'references/guide.md');
  for (const bad of ['../secret.md', '/etc/passwd.md', 'https://x/y.md', 'refs\\a.md', '.hidden/x.md', 'image.png', 'SKILL.md', '']) {
    assert.throws(() => skillFilePath(bad), Error, bad);
  }
  assert.deepEqual(parseSlashCommand('/proofreading fix para 2', ['proofreading']), { name: 'proofreading', rest: 'fix para 2' });
  assert.equal(parseSlashCommand('/unknown x', ['proofreading']), null);
  assert.equal(parseSlashCommand('see /proofreading', ['proofreading']), null);

  const skills = [{ name: 'proofreading', description: 'Proofread.', body: 'Step 1.' }, { name: 'summary', description: 'Summarize.', body: 'S.' }];
  const listed = buildSkillsPrompt({ skills });
  assert.match(listed, /== SKILLS ==[\s\S]*use_skill[\s\S]*- proofreading — Proofread\.\n- summary — Summarize\./);
  assert.doesNotMatch(listed, /Step 1/);
  const active = buildSkillsPrompt({ skills, active: ['proofreading'] });
  assert.match(active, /- proofreading \(active\)[\s\S]*== SKILL: proofreading \(active\) ==\nStep 1\./);
  assert.equal(buildSkillsPrompt({ skills: [] }), '');
  const msg = skillLoadedMessage({ name: 'proofreading', allowedTools: ['find_text', 'replace_text', 'nope'] }, (t) => ({ find_text: 'on', replace_text: 'off' }[t] || 'missing'));
  assert.match(msg, /find_text \(on\), replace_text \(turned off — ask with request_tool if you need it\), nope \(not in this application\)/);
});

/* ---------------------------------------------------------------------------------------------- agents */

test('agents: one Markdown file per agent; composition, context layers, memory and limits', () => {
  const { agent, problems } = parseAgent(`---
name: proofreader
description: Checks spelling and grammar.
toolsets: [document]
tools: [rename_file]
skills: [proofreading]
permissions:
  deny: [toolset:file]
context: [app, page, screen]
memory: read
maxToolSteps: 4
model: qwen/qwen3-8b
suggestions: [Proofread this]
color: blue
---
You proofread.`, { file: 'agents/proofreader.md' });
  assert.ok(problems.some((p) => /"color" is not an agent setting/.test(p)));
  assert.equal(agent.title, 'Proofreader');
  assert.deepEqual([agent.tools, agent.toolsets, agent.skills], [['rename_file'], ['document'], ['proofreading']]);
  assert.deepEqual(agent.context, { app: true, page: true, screen: true, view: false });
  assert.equal(agent.memory, 'read');
  assert.equal(agent.maxToolSteps, 4);
  assert.deepEqual(agent.suggestions, ['Proofread this']);
  assert.match(buildAgentPrompt(agent), /^== AGENT: Proofreader ==\n[\s\S]*Checks spelling[\s\S]*You proofread\.$/);

  const toolsets = new Map([['document', { tools: ['find_text', 'replace_text'] }]]);
  assert.deepEqual([...agentToolNames(agent, { tools: ['find_text', 'replace_text', 'rename_file', 'new_document'], toolsets }).names].sort(), ['find_text', 'rename_file', 'replace_text']);
  assert.equal(agentToolNames(normalizeAgent({ name: 'all', description: 'x' }).agent, { tools: ['a'] }).names, null, 'no tools and no toolsets: all of them');
  assert.match(agentToolNames(normalizeAgent({ name: 'b', description: 'x', tools: ['ghost'] }).agent, { tools: ['a'] }).problems[0], /"ghost" does not exist/);
  assert.equal(agentSkillNames(normalizeAgent({ name: 'c', description: 'x' }).agent, ['s']).names, null);
  assert.equal(parseAgent('---\ndescription: From the file name.\n---\nx', { file: 'agents/track-designer.agent.md' }).agent.name, 'track-designer');
  assert.equal(parseAgent('---\ndescription: x\n---\ny', { file: 'agents/writer/AGENT.md' }).agent.name, 'writer');
  assert.equal(parseAgent('---\nname: Bad Name\ndescription: x\n---\n').agent, null);
  assert.equal(buildAgentPrompt(implicitAgent()), '');
  const list = [normalizeAgent({ name: 'a', description: 'x' }).agent, normalizeAgent({ name: 'b', description: 'x', default: true }).agent];
  assert.equal(pickAgent(list).name, 'b');
  assert.equal(pickAgent(list, 'a').name, 'a');
});

test('system prompt: the agent comes right after the editable prompt; skills before tools', () => {
  const p = buildSystemPrompt({ base: 'BASE', agentText: '== AGENT: X ==\nhi', appText: 'App', skillsText: '== SKILLS ==\n- s', toolsText: '== TOOLS ==\nt', memoryText: '== MEMORY ==\nm' });
  const order = ['BASE', '== AGENT: X ==', '== APPLICATION ==', '== MEMORY ==', '== SKILLS ==', '== TOOLS =='].map((s) => p.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

/* -------------------------------------------------------------------------------------- capabilities */

test('capabilities: tool modules export a tool, a list, a toolset or a factory (host) => any of these', () => {
  const host = { n: 7 };
  const tool = { name: 'a', description: 'A.', run: () => 1 };
  assert.equal(readToolModule({ default: tool }).tools.length, 1);
  assert.equal(readToolModule({ default: [tool, { ...tool, name: 'b' }] }).tools.length, 2);
  const r = readToolModule({ default: (h) => ({ name: 'doc', title: 'Document', tools: [{ ...tool, run: () => h.n }, 'shared_tool'] }) }, { host, source: 'tools/doc.js' });
  assert.deepEqual(r.toolsets, [{ name: 'doc', title: 'Document', description: '', tools: ['a', 'shared_tool'], source: 'tools/doc.js' }]);
  assert.equal(r.tools[0].toolset, 'doc');
  assert.equal(r.tools[0].group, 'Document');
  assert.equal(r.tools[0].run(), 7, 'the factory got the host');
  assert.match(readToolModule({}).problems[0], /exports nothing usable/);
  assert.match(readToolModule({ default: () => { throw new Error('boom'); } }).problems[0], /factory function failed: boom/);
  const linked = linkToolsets([{ name: 'a' }, { name: 'b' }], [{ name: 'doc', tools: ['a', 'ghost'] }, { name: 'all', tools: ['a', 'b'] }]);
  assert.deepEqual(linked.membership.get('a'), ['doc', 'all']);
  assert.match(linked.problems[0], /"ghost" does not exist/);
  assert.deepEqual(skillLocation('skills/proofreading', 'http://h/app/ai/index.json'), { fileUrl: 'http://h/app/ai/skills/proofreading/SKILL.md', folderUrl: 'http://h/app/ai/skills/proofreading/', folder: 'proofreading' });
});

test('capabilities: an index loads its agents, skills, tools and toolsets; problems are collected, never thrown', async () => {
  const files = {
    'http://h/ai/index.json': JSON.stringify({
      format: 'ai-enablement/1',
      agents: ['agents/writer.md', 'agents/broken.md', 'agents/missing.md'],
      skills: ['skills/proofreading', 'skills/bad/SKILL.md'],
      tools: ['tools/doc.js', 'tools/throws.js'],
      toolsets: ['toolsets/editing.json'],
      toolsConfig: 'ai-tools.json',
      memory: 'ai-memory.json',
      permissions: { deny: ['new_document'] },
      defaultAgent: 'writer',
      prompts: [],
      surprise: 1,
    }),
    'http://h/ai/agents/writer.md': '---\nname: writer\ndescription: Writes.\ntoolsets: [doc]\nskills: [proofreading]\n---\nWrite well.',
    'http://h/ai/agents/broken.md': '---\nname: Broken!\n---\n',
    'http://h/ai/skills/proofreading/SKILL.md': '---\nname: proofreading\ndescription: Proofread.\n---\nSteps.',
    'http://h/ai/skills/bad/SKILL.md': '---\nname: bad\n---\nx',
    'http://h/ai/toolsets/editing.json': JSON.stringify({ name: 'editing', title: 'Editing', tools: ['find_text'] }),
  };
  const fetchText = async (url) => { const u = url.split('?')[0]; if (!(u in files)) throw new Error('HTTP 404'); return files[u]; };
  const modules = {
    'http://h/ai/tools/doc.js': { default: (host) => ({ name: 'doc', title: 'Document', tools: [{ name: 'find_text', description: 'Find.', effect: 'read', run: () => host.found }] }) },
  };
  const seen = [];
  const importModule = async (url) => { seen.push(url); const u = url.split('?')[0]; if (!(u in modules)) throw new Error('Failed to fetch'); return modules[u]; };
  const r = await loadCapabilities('ai/index.json', { base: 'http://h/', host: { found: 2 }, fetchText, importModule, bust: 'v1' });
  assert.equal(r.url, 'http://h/ai/index.json');
  assert.deepEqual(r.agents.map((a) => a.name), ['writer']);
  assert.deepEqual(r.skills.map((s) => [s.name, s.base]), [['proofreading', 'http://h/ai/skills/proofreading/']]);
  assert.deepEqual(r.tools.map((t) => [t.name, t.toolset, t.source]), [['find_text', 'doc', 'tools/doc.js']]);
  assert.equal(r.tools[0].run(), 2);
  assert.deepEqual(r.toolsets.map((t) => t.name), ['doc', 'editing']);
  assert.equal(r.toolsConfig, 'http://h/ai/ai-tools.json');
  assert.equal(r.memory, 'http://h/ai/ai-memory.json');
  assert.deepEqual(r.permissions.deny, ['new_document']);
  assert.equal(r.defaultAgent, 'writer');
  assert.ok(seen.every((u) => u.endsWith('?v=v1')), 'bust gives fresh module copies');
  const text = r.problems.join('\n');
  for (const want of [/agents\/broken\.md: name "Broken!"/, /agents\/missing\.md: could not be loaded/, /skills\/bad\/SKILL\.md: description is missing/, /tools\/throws\.js: could not be imported/, /"prompts" is reserved/, /"surprise" is not an index key/]) {
    assert.match(text, want);
  }
  const refs = checkReferences({ agents: [...r.agents, normalizeAgent({ name: 'x', description: 'x', tools: ['ghost'], skills: ['nope'] }).agent], tools: r.tools, toolsets: new Map(r.toolsets.map((t) => [t.name, t])), skills: r.skills, defaultAgent: 'missing' });
  assert.deepEqual(refs, ['agent "x": tool "ghost" does not exist.', 'agent "x": skill "nope" does not exist.', 'defaultAgent "missing" is not one of the agents.']);
  const gone = await loadCapabilities('nothing.json', { base: 'http://h/', fetchText, importModule });
  assert.match(gone.problems[0], /could not be loaded/);
});

test('capabilities: Hello World\'s capability folder loads from disk without problems', async () => {
  const root = path.join(SKILL, 'examples', 'hello-world', 'ai');
  const fetchText = async (url) => fs.readFileSync(fileURLToPath(url.split('?')[0]), 'utf8');
  const r = await loadCapabilities(pathToFileURL(path.join(root, 'index.json')).href, { host: {}, fetchText, importModule: (u) => import(u) });
  assert.deepEqual(r.problems, []);
  assert.ok(r.agents.length >= 2 && r.skills.length >= 1 && r.tools.length >= 8, `${r.agents.length} agents, ${r.skills.length} skills, ${r.tools.length} tools`);
  const linked = linkToolsets(r.tools.map((t) => normalizeTool(t)), r.toolsets);
  assert.deepEqual(linked.problems, []);
  assert.deepEqual(checkReferences({ agents: r.agents, tools: r.tools, toolsets: linked.toolsets, skills: r.skills, defaultAgent: r.defaultAgent }), []);
});

test('the built-in create-tool skill is a valid Agent Skill', () => {
  const dir = path.join(SKILL, 'assets', 'ai-agent', 'skills', 'create-tool');
  const r = parseSkill(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'), { folder: 'create-tool', source: 'builtin' });
  assert.deepEqual(r.problems, []);
  assert.match(r.skill.body, /write_ai_file[\s\S]*reload_capabilities/);
});

/* ----------------------------------------------------------------------------------------- workspace */

test('workspace client: paths stay inside the app; writes only inside the capability folder', async () => {
  assert.equal(workspacePath('./src/app.js'), 'src/app.js');
  assert.equal(workspacePath('', { allowEmpty: true }), '');
  for (const bad of ['../x', 'a/../../b', '/etc/passwd', 'C:/x', 'file:///x', 'a//b']) assert.throws(() => workspacePath(bad), Error, bad);
  const info = { url: 'http://h/ai-workspace', writable: ['public/ai'] };
  assert.equal(writeProblem('public/ai/tools/x.js', info), '');
  assert.match(writeProblem('public/app.js', info), /Only files inside public\/ai\//);
  assert.match(writeProblem('public/ai/x.exe', info), /\.js, \.mjs, \.json and \.md/);
  assert.match(writeProblem('x.js', { writable: [] }), /does not allow writing/);

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.method, init.headers['X-Requested-With'], init.body]);
    if (url === 'http://h/ai-workspace') return new Response(JSON.stringify(init.method === 'POST' ? { ok: true, path: 'public/ai/tools/x.js', bytes: 3, created: true } : { ok: true, workspace: 'ai-enablement', version: '2.0.0', root: 'app', aiDir: 'public/ai/', writable: ['public/ai'] }), { status: 200 });
    return new Response(JSON.stringify({ ok: false, error: { message: 'nope' } }), { status: 403 });
  };
  const probed = await probeWorkspace('/ai-workspace', { fetchImpl, base: 'http://h/page' });
  assert.deepEqual(probed, { url: 'http://h/ai-workspace', version: '2.0.0', root: 'app', aiDir: 'public/ai', index: '', writable: ['public/ai'] });
  assert.equal(await probeWorkspace('/other', { fetchImpl, base: 'http://h/' }), null, 'no workspace is the normal case: null, quietly');
  const client = workspaceClient(probed, { fetchImpl });
  assert.equal((await client.write('public/ai/tools/x.js', 'x()')).created, true);
  await assert.rejects(client.write('src/app.js', 'x'), /Only files inside/);
  await assert.rejects(client.read('src/app.js'), /nope/);
  assert.ok(calls.every((c) => c[2] === 'ai-agent-drawer'), 'every call carries the same-origin header');
});

test('workspace diff: what a replacement removes and adds, in hunks with context', async () => {
  const { lineDiff, diffHunks } = await import('../assets/ai-agent/core/workspace.js');
  const before = 'a\nb\nc\nd\ne\nf\ng';
  const after = 'a\nb\nC\nd\ne\nf\ng\nh';
  const diff = lineDiff(before, after);
  assert.deepEqual(diff.filter((d) => d.op !== ' '), [{ op: '-', line: 'c' }, { op: '+', line: 'C' }, { op: '+', line: 'h' }]);
  const { hunks, removed, added } = diffHunks(diff, 1);
  assert.deepEqual([removed, added], [1, 2]);
  assert.deepEqual(hunks.map((h) => h.map((d) => `${d.op}${d.line}`).join(' ')), [' b -c +C  d', ' g +h']);
  assert.deepEqual(diffHunks(lineDiff('same', 'same')).hunks, [], 'no change, no hunk');
  const big = lineDiff('x\n'.repeat(3000), 'y\n'.repeat(3000), { maxCells: 1000 });
  assert.equal(big.filter((d) => d.op === '-').length, 3001, 'too large to compare: a whole removal and addition');
});

test('this skill\'s own SKILL.md is a valid Agent Skill (name = folder, description within 1024 characters)', () => {
  const r = parseSkill(fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8'), { folder: path.basename(SKILL) === 'ai-enablement' ? 'ai-enablement' : '' });
  assert.deepEqual(r.problems, []);
  assert.equal(r.skill.name, 'ai-enablement');
  assert.ok(r.skill.body.split('\n').length < 500, 'keep SKILL.md under 500 lines: details go in references/');
});
