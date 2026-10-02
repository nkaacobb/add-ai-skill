// Agents: configured AI workers. An agent composes what the application already has — it never defines tools or
// skills itself:
//
//   ---
//   name: proofreader
//   description: Checks spelling and grammar and fixes them with your approval.
//   title: Proofreader
//   toolsets: [document]              # omit tools and toolsets = every tool
//   tools: [find_text]
//   skills: [proofreading]            # omit = every skill
//   permissions:
//     deny: [toolset:file]
//   context: [app, page, screen, view]   # which context layers it receives (default: all)
//   memory: read                      # on (default) | read (sees notes, cannot save) | off
//   maxToolSteps: 6
//   model: qwen/qwen3-8b              # a preference, shown to the user; not applied automatically
//   welcome: I check your text.
//   suggestions: [Proofread this]
//   ---
//   You are the proofreader of this editor…   ← the agent's instructions (its part of the system prompt)
//
// One Markdown file per agent, as Claude Code (.claude/agents/*.md) and GitHub Copilot (.github/agents/*.agent.md)
// keep theirs. Pure module: no DOM.

import { parseFrontmatter, listValue } from './frontmatter.js';
import { normalizePolicy } from './permissions.js';
import { SKILL_NAME } from './skills.js';

export const AGENT_NAME = SKILL_NAME;
export const CONTEXT_LAYERS = Object.freeze(['app', 'page', 'screen', 'view']);
export const MEMORY_MODES = Object.freeze(['on', 'read', 'off']);
const KNOWN = new Set(['name', 'description', 'title', 'tools', 'toolsets', 'skills', 'permissions', 'context', 'memory', 'maxToolSteps', 'model', 'welcome', 'suggestions', 'default', 'instructions', 'body', 'text', 'source', 'file']);

const humanize = (name) => String(name).replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** The agent an application has when it defines none: everything, the 1.x behaviour. */
export function implicitAgent(title = 'AI agent') {
  return {
    name: 'default', title, description: 'The application\'s agent.', instructions: '', implicit: true,
    tools: null, toolsets: null, skills: null, permissions: { allow: [], ask: [], deny: [] },
    context: { app: true, page: true, screen: true, view: true }, memory: 'on', maxToolSteps: null, model: '',
    welcome: '', suggestions: [], default: true,
  };
}

/** Frontmatter-style data + instructions -> { agent, problems }. `agent` is null when it cannot be used. */
export function agentFromData(data, instructions, { file = '' } = {}) {
  const problems = [];
  const name = typeof data.name === 'string' ? data.name.trim() : (file ? fileName(file) : '');
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!name) problems.push('name is missing (frontmatter "name:").');
  else if (!AGENT_NAME.test(name)) problems.push(`name "${name}" must be 1-64 lowercase letters, digits and single hyphens.`);
  if (!description) problems.push('description is missing: it tells the user (and other agents) what this agent is for.');
  for (const k of Object.keys(data)) if (!KNOWN.has(k)) problems.push(`"${k}" is not an agent setting; it is ignored.`);
  const list = (k) => (data[k] === undefined || data[k] === null ? null : listValue(data[k]));
  const permissions = normalizePolicy(data.permissions ?? undefined, problems);
  const context = { app: true, page: true, screen: true, view: true };
  if (data.context !== undefined && data.context !== null) {
    const layers = listValue(data.context);
    for (const l of layers) if (!CONTEXT_LAYERS.includes(l)) problems.push(`context: "${l}" is not a context layer (${CONTEXT_LAYERS.join(', ')}).`);
    for (const l of CONTEXT_LAYERS) context[l] = layers.includes(l);
  }
  let memory = 'on';
  if (data.memory !== undefined && data.memory !== null) {
    const m = data.memory === true ? 'on' : data.memory === false ? 'off' : String(data.memory).trim().toLowerCase();
    if (MEMORY_MODES.includes(m)) memory = m; else problems.push(`memory: "${data.memory}" is not one of ${MEMORY_MODES.join(', ')}.`);
  }
  let maxToolSteps = null;
  if (data.maxToolSteps !== undefined && data.maxToolSteps !== null) {
    if (Number.isInteger(data.maxToolSteps) && data.maxToolSteps >= 1 && data.maxToolSteps <= 30) maxToolSteps = data.maxToolSteps;
    else problems.push('maxToolSteps must be a whole number from 1 to 30.');
  }
  if (!name || !AGENT_NAME.test(name) || !description) return { agent: null, problems };
  return {
    agent: {
      name,
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : humanize(name),
      description,
      instructions: String(instructions ?? '').trim(),
      tools: list('tools'),
      toolsets: list('toolsets'),
      skills: list('skills'),
      permissions,
      context,
      memory,
      maxToolSteps,
      model: typeof data.model === 'string' ? data.model.trim() : '',
      welcome: typeof data.welcome === 'string' ? data.welcome : '',
      suggestions: listValue(Array.isArray(data.suggestions) ? data.suggestions : (data.suggestions ? [data.suggestions] : [])),
      default: data.default === true,
      ...(file ? { file } : {}),
    },
    problems,
  };
}

function fileName(file) {
  const base = String(file).split(/[\\/]/).pop() || '';
  if (/^AGENT\.md$/i.test(base)) return String(file).split(/[\\/]/).slice(-2, -1)[0] || '';
  return base.replace(/\.agent\.md$|\.md$/i, '');
}

/** An agent file (Markdown with YAML frontmatter) -> { agent, problems }. */
export function parseAgent(text, { file = '' } = {}) {
  const { data, body, errors } = parseFrontmatter(text);
  const r = agentFromData(data, body, { file });
  r.problems.unshift(...errors.map((e) => `frontmatter: ${e}`));
  return r;
}

/** An agent given inline ({ name, description, instructions, tools, … }) or as file text ({ text }). */
export function normalizeAgent(def) {
  if (!def || typeof def !== 'object') return { agent: null, problems: ['an agent must be an object.'] };
  if (typeof def.text === 'string') return parseAgent(def.text, { file: def.file || '' });
  return agentFromData(def, def.instructions ?? def.body ?? '', { file: def.file || '' });
}

/**
 * Which tools an agent may use: a Set of names, or null for "all of them".
 * @param {object} agent
 * @param {object} o
 * @param {string[]} o.tools                    names of the tools that exist
 * @param {Map<string, {tools: string[]}>} o.toolsets
 * @returns {{ names: Set<string>|null, problems: string[] }}
 */
export function agentToolNames(agent, { tools = [], toolsets = new Map() } = {}) {
  const problems = [];
  if (!agent || (agent.tools === null && agent.toolsets === null)) return { names: null, problems };
  const known = new Set(tools);
  const names = new Set();
  for (const t of agent.tools || []) {
    if (known.has(t)) names.add(t); else problems.push(`agent "${agent.name}": tool "${t}" does not exist.`);
  }
  for (const ts of agent.toolsets || []) {
    const set = toolsets.get(ts);
    if (!set) { problems.push(`agent "${agent.name}": toolset "${ts}" does not exist.`); continue; }
    for (const t of set.tools) if (known.has(t)) names.add(t);
  }
  return { names, problems };
}

/** Which skills an agent may use: a Set of names, or null for "all of them". */
export function agentSkillNames(agent, skills = []) {
  const problems = [];
  if (!agent || agent.skills === null) return { names: null, problems };
  const known = new Set(skills);
  const names = new Set();
  for (const s of agent.skills) {
    if (known.has(s)) names.add(s); else problems.push(`agent "${agent.name}": skill "${s}" does not exist.`);
  }
  return { names, problems };
}

/** The AGENT section of the system prompt ('' for the implicit agent or one without instructions). */
export function buildAgentPrompt(agent) {
  if (!agent || agent.implicit || !agent.instructions) return '';
  return `== AGENT: ${agent.title} ==\nYou are working as the "${agent.title}" agent of this application. ${agent.description}\n\n${agent.instructions}`;
}

/** The agent to start with: the one named, else the one marked default, else the first. */
export function pickAgent(agents, wanted = '') {
  if (!agents.length) return null;
  return agents.find((a) => a.name === wanted) || agents.find((a) => a.default) || agents[0];
}
