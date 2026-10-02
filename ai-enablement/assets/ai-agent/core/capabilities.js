// The application's capabilities — what its AI can do — loaded from its capability folder:
//
//   ai/
//     index.json              this file names everything below; paths are relative to it
//     tools/document.js       tool modules: a tool, a list of tools, a toolset, or a function (host) => any of these
//     toolsets/editing.json   toolsets that group tools defined elsewhere: { name, title, description, tools: [names] }
//     skills/<name>/SKILL.md  Agent Skills (core/skills.js)
//     agents/<name>.md        agents (core/agents.js)
//     ai-tools.json           which tools start on (core/tools.js toolsConfigPatch)
//     ai-memory.json          starting memories (core/memory.js)
//
//   index.json:
//   { "format": "ai-enablement/1",
//     "agents": ["agents/writer.md"], "skills": ["skills/proofreading"], "tools": ["tools/document.js"],
//     "toolsets": ["toolsets/editing.json"], "toolsConfig": "ai-tools.json", "memory": "ai-memory.json",
//     "permissions": { "deny": ["new_document"] }, "defaultAgent": "writer" }
//
// Entries may also be inline objects. A browser cannot list a folder, so the index is what the runtime reads; it is
// also what tooling (scripts/validate.mjs, an MCP bridge) reads without running the app. Problems are collected, not
// thrown: one broken skill must not take the agent down. No DOM here; fetching and importing are injected.

import { parseSkill, normalizeSkill } from './skills.js';
import { parseAgent, normalizeAgent } from './agents.js';
import { normalizePolicy } from './permissions.js';

export const INDEX_FORMAT = 'ai-enablement/1';
const INDEX_KEYS = new Set(['$schema', '$comment', 'format', 'agents', 'skills', 'tools', 'toolsets', 'toolsConfig', 'memory', 'permissions', 'defaultAgent']);
const LATER = new Set(['prompts', 'resources', 'context']);
export const TOOLSET_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const defaultFetchText = async (url) => {
  const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};
export const defaultImport = (url) => import(/* @vite-ignore */ /* webpackIgnore: true */ url);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isToolset = (v) => isObject(v) && Array.isArray(v.tools) && typeof v.run !== 'function';
const isTool = (v) => isObject(v) && typeof v.run === 'function';

/** A toolset definition -> { toolset, tools (definitions it carries), problems }. */
export function normalizeToolset(def, { source = '' } = {}) {
  const problems = [];
  const name = String(def?.name ?? '').trim();
  if (!TOOLSET_NAME.test(name)) return { toolset: null, tools: [], problems: [`toolset name "${name}" is not valid (letters, digits, _ or -, starting with a letter).`] };
  const names = [];
  const tools = [];
  for (const t of def.tools || []) {
    if (typeof t === 'string') { names.push(t); continue; }
    if (isTool(t)) {
      names.push(String(t.name ?? ''));
      tools.push({ ...t, toolset: t.toolset || name, group: t.group || def.title || '', ...(source ? { source } : {}) });
      continue;
    }
    problems.push(`toolset "${name}": an entry that is neither a tool name nor a tool.`);
  }
  return {
    toolset: { name, title: String(def.title || name.replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())), description: String(def.description || ''), tools: [...new Set(names)], ...(source ? { source } : {}) },
    tools,
    problems,
  };
}

/** What a tool module exported -> { tools, toolsets, problems }. */
export function readToolModule(mod, { host, source = '' } = {}) {
  const problems = [];
  let value = mod && (mod.default ?? mod.toolset ?? mod.tools);
  if (value === undefined) return { tools: [], toolsets: [], problems: ['exports nothing usable: export default a tool, a list of tools, a toolset, or a function (host) => one of these.'] };
  if (typeof value === 'function' && !isTool(value)) {
    try { value = value(host); } catch (e) { return { tools: [], toolsets: [], problems: [`its factory function failed: ${e?.message || e}`] }; }
  }
  const tools = [];
  const toolsets = [];
  const visit = (v) => {
    if (Array.isArray(v)) { for (const x of v) visit(x); return; }
    if (isToolset(v)) {
      const r = normalizeToolset(v, { source });
      problems.push(...r.problems);
      if (r.toolset) { toolsets.push(r.toolset); tools.push(...r.tools); }
      return;
    }
    if (isTool(v)) { tools.push({ ...v, ...(source ? { source } : {}) }); return; }
    problems.push('exports something that is neither a tool (with a run function) nor a toolset (with a tools list).');
  };
  visit(value);
  return { tools, toolsets, problems };
}

/** The skill folder's URL and its SKILL.md URL for an index entry ("skills/x", "skills/x/", "skills/x/SKILL.md"). */
export function skillLocation(entry, base) {
  const path = String(entry).replace(/\/+$/, '');
  const md = /\.md$/i.test(path) ? path : `${path}/SKILL.md`;
  const fileUrl = new URL(md, base).href;
  const folderUrl = new URL('./', fileUrl).href;
  const folder = decodeURIComponent(folderUrl.replace(/\/$/, '').split('/').pop() || '');
  return { fileUrl, folderUrl, folder };
}

const withBust = (url, bust) => (bust ? `${url}${url.includes('?') ? '&' : '?'}v=${bust}` : url);

/**
 * Load a capability index.
 * @param {string|object} source        the index URL (relative to `base`), or an index object (paths relative to `base`)
 * @param {object} [o]
 * @param {string} [o.base]             what relative URLs resolve against (default: the page)
 * @param {*} [o.host]                  passed to tool-module factories
 * @param {(url: string) => Promise<string>} [o.fetchText]
 * @param {(url: string) => Promise<object>} [o.importModule]
 * @param {string|number} [o.bust]      appended to module and file URLs to load fresh copies (after a change)
 * @returns {Promise<{url, tools, toolsets, skills, agents, toolsConfig, memory, permissions, defaultAgent, problems}>}
 */
export async function loadCapabilities(source, { base = globalThis.location?.href || 'http://localhost/', host, fetchText = defaultFetchText, importModule = defaultImport, bust = '' } = {}) {
  const out = { url: '', tools: [], toolsets: [], skills: [], agents: [], toolsConfig: null, memory: null, permissions: { allow: [], ask: [], deny: [] }, defaultAgent: '', problems: [] };
  const problem = (where, msg) => out.problems.push(where ? `${where}: ${msg}` : msg);
  let index = source;
  let indexBase = base;
  if (typeof source === 'string') {
    out.url = new URL(source, base).href;
    indexBase = out.url;
    try {
      index = JSON.parse(await fetchText(withBust(out.url, bust)));
    } catch (e) {
      problem(source, `the capability index could not be loaded (${e?.message || e}).`);
      return out;
    }
  }
  if (!isObject(index)) { problem('index', 'the capability index must be a JSON object.'); return out; }
  if (index.format !== undefined && index.format !== INDEX_FORMAT) problem('index', `format "${index.format}" is not "${INDEX_FORMAT}"; reading it anyway.`);
  for (const k of Object.keys(index)) {
    if (LATER.has(k)) problem('index', `"${k}" is reserved for a later version and is ignored.`);
    else if (!INDEX_KEYS.has(k)) problem('index', `"${k}" is not an index key; it is ignored.`);
  }
  const list = (k) => {
    if (index[k] === undefined) return [];
    if (Array.isArray(index[k])) return index[k];
    problem('index', `"${k}" must be a list.`);
    return [];
  };
  const at = (entry) => (typeof entry === 'string' ? entry : entry?.name ? `${entry.name} (inline)` : 'inline entry');

  // Tool modules and toolset files load in parallel; so do skills and agents.
  const toolJobs = list('tools').map(async (entry) => {
    if (typeof entry !== 'string') return { entry, ...readToolModule({ default: entry }, { host }) };
    try {
      const mod = await importModule(withBust(new URL(entry, indexBase).href, bust));
      return { entry, ...readToolModule(mod, { host, source: entry }) };
    } catch (e) {
      return { entry, tools: [], toolsets: [], problems: [`could not be imported (${e?.message || e}).`] };
    }
  });
  const toolsetJobs = list('toolsets').map(async (entry) => {
    try {
      const def = typeof entry === 'string' ? JSON.parse(await fetchText(withBust(new URL(entry, indexBase).href, bust))) : entry;
      const r = normalizeToolset(def, { source: typeof entry === 'string' ? entry : '' });
      return { entry, tools: r.tools, toolsets: r.toolset ? [r.toolset] : [], problems: r.problems };
    } catch (e) {
      return { entry, tools: [], toolsets: [], problems: [`could not be loaded (${e?.message || e}).`] };
    }
  });
  const skillJobs = list('skills').map(async (entry) => {
    if (typeof entry !== 'string') return { entry, ...normalizeSkill(entry, { source: 'app' }) };
    const loc = skillLocation(entry, indexBase);
    try {
      const text = await fetchText(withBust(loc.fileUrl, bust));
      return { entry, ...parseSkill(text, { base: loc.folderUrl, folder: loc.folder, source: 'app' }) };
    } catch (e) {
      return { entry, skill: null, problems: [`SKILL.md could not be loaded (${e?.message || e}).`] };
    }
  });
  const agentJobs = list('agents').map(async (entry) => {
    if (typeof entry !== 'string') return { entry, ...normalizeAgent(entry) };
    try {
      const text = await fetchText(withBust(new URL(entry, indexBase).href, bust));
      return { entry, ...parseAgent(text, { file: entry }) };
    } catch (e) {
      return { entry, agent: null, problems: [`could not be loaded (${e?.message || e}).`] };
    }
  });

  const [toolResults, toolsetResults, skillResults, agentResults] = await Promise.all([toolJobs, toolsetJobs, skillJobs, agentJobs].map((jobs) => Promise.all(jobs)));
  for (const r of [...toolResults, ...toolsetResults]) {
    for (const p of r.problems) problem(at(r.entry), p);
    out.tools.push(...r.tools);
    out.toolsets.push(...r.toolsets);
  }
  for (const r of skillResults) {
    for (const p of r.problems) problem(at(r.entry), p);
    if (r.skill) out.skills.push(r.skill);
  }
  for (const r of agentResults) {
    for (const p of r.problems) problem(at(r.entry), p);
    if (r.agent) out.agents.push(r.agent);
  }
  const resolve = (v) => (typeof v === 'string' ? new URL(v, indexBase).href : isObject(v) ? v : null);
  out.toolsConfig = resolve(index.toolsConfig);
  out.memory = resolve(index.memory);
  const policyProblems = [];
  out.permissions = normalizePolicy(index.permissions, policyProblems);
  for (const p of policyProblems) problem('index', p);
  out.defaultAgent = typeof index.defaultAgent === 'string' ? index.defaultAgent : '';
  return out;
}

/**
 * Put toolsets and tools together: which toolsets each tool belongs to (tool.toolsets), and what does not add up.
 * Tools are the normalised definitions; a toolset that lists a missing tool, or two toolsets with one name, is a
 * problem (reported, not fatal).
 * @returns {{ toolsets: Map<string, object>, membership: Map<string, string[]>, problems: string[] }}
 */
export function linkToolsets(tools, toolsets) {
  const problems = [];
  const byName = new Map();
  for (const ts of toolsets) {
    if (byName.has(ts.name)) {
      const prev = byName.get(ts.name);
      byName.set(ts.name, { ...prev, tools: [...new Set([...prev.tools, ...ts.tools])], description: prev.description || ts.description });
    } else byName.set(ts.name, { ...ts, tools: [...ts.tools] });
  }
  const known = new Set(tools.map((t) => t.name));
  const membership = new Map();
  for (const ts of byName.values()) {
    for (const t of ts.tools) {
      if (!known.has(t)) { problems.push(`toolset "${ts.name}": tool "${t}" does not exist.`); continue; }
      if (!membership.has(t)) membership.set(t, []);
      membership.get(t).push(ts.name);
    }
    ts.tools = ts.tools.filter((t) => known.has(t));
  }
  return { toolsets: byName, membership, problems };
}

/** Problems with how agents refer to tools, toolsets and skills (for scripts/validate.mjs and the console). */
export function checkReferences({ agents = [], tools = [], toolsets = new Map(), skills = [], defaultAgent = '' }) {
  const problems = [];
  const toolNames = new Set(tools.map((t) => t.name));
  const skillNames = new Set(skills.map((s) => s.name));
  const seen = new Set();
  for (const a of agents) {
    if (seen.has(a.name)) problems.push(`agent "${a.name}" is defined twice; the last one wins.`);
    seen.add(a.name);
    for (const t of a.tools || []) if (!toolNames.has(t)) problems.push(`agent "${a.name}": tool "${t}" does not exist.`);
    for (const ts of a.toolsets || []) if (!toolsets.has(ts)) problems.push(`agent "${a.name}": toolset "${ts}" does not exist.`);
    for (const s of a.skills || []) if (!skillNames.has(s)) problems.push(`agent "${a.name}": skill "${s}" does not exist.`);
  }
  const skillSeen = new Set();
  for (const s of skills) {
    if (skillSeen.has(s.name)) problems.push(`skill "${s.name}" is defined twice; the last one wins.`);
    skillSeen.add(s.name);
    for (const t of s.allowedTools || []) if (/^[A-Za-z][\w-]*$/.test(t) && !toolNames.has(t)) problems.push(`skill "${s.name}": allowed-tools names "${t}", which is not a tool of this application.`);
  }
  if (defaultAgent && !agents.some((a) => a.name === defaultAgent)) problems.push(`defaultAgent "${defaultAgent}" is not one of the agents.`);
  return problems;
}
