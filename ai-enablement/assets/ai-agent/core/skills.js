// Skills: reusable instructions for a kind of work, in the open Agent Skills format (https://agentskills.io):
//
//   skills/proofreading/
//     SKILL.md           required: YAML frontmatter (name, description; optional license, compatibility, metadata,
//                        allowed-tools) + Markdown instructions
//     references/        optional: documents the instructions point to (read on demand)
//     scripts/, assets/  optional: kept for other tools; never run in the browser
//
// Progressive disclosure, as the format intends: the system prompt lists each available skill's name and description;
// the model calls `use_skill` when a request matches one; from then on the skill's instructions are part of the
// system prompt for the rest of the conversation (an "active" skill, saved with the chat); `read_skill_file` reads a
// file the instructions point to. The user can also start a message with /skill-name. Pure module: no DOM.

import { parseFrontmatter, listValue } from './frontmatter.js';

export const SKILL_NAME = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_BODY_MAX = 16000;
export const SKILL_FILE_MAX = 20000;
export const SKILL_FILE_TYPES = Object.freeze(['md', 'markdown', 'txt', 'json', 'csv', 'tsv', 'yaml', 'yml', 'xml', 'html', 'js', 'mjs', 'ts', 'py', 'sh', 'sql']);

/**
 * A SKILL.md file -> { skill, problems }. `skill` is null when the file cannot be used (no name or description).
 * @param {string} text
 * @param {object} [o]
 * @param {string} [o.base]    URL (or path) of the skill's folder, ending with "/"
 * @param {string} [o.folder]  the folder's name (the format wants it to equal `name`)
 * @param {'app'|'builtin'} [o.source]
 */
export function parseSkill(text, { base = '', folder = '', source = 'app' } = {}) {
  const { data, body, errors } = parseFrontmatter(text);
  const problems = errors.map((e) => `frontmatter: ${e}`);
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  if (!name) problems.push('name is missing (frontmatter "name:").');
  else if (!SKILL_NAME.test(name)) problems.push(`name "${name}" must be 1-64 lowercase letters, digits and single hyphens (not at the start or end).`);
  if (!description) problems.push('description is missing: it is what the model reads to decide when to use the skill.');
  else if (description.length > 1024) problems.push(`description is ${description.length} characters long; the format allows 1024.`);
  if (folder && name && folder !== name) problems.push(`the folder is "${folder}" but the name is "${name}"; the format wants them equal.`);
  if (data.compatibility !== undefined && String(data.compatibility).length > 500) problems.push('compatibility is longer than 500 characters.');
  if (data.metadata !== undefined && (typeof data.metadata !== 'object' || Array.isArray(data.metadata) || data.metadata === null)) problems.push('metadata must be a mapping of keys to values.');
  if (!body.trim()) problems.push('the instructions (the Markdown after the frontmatter) are empty.');
  if (!name || !SKILL_NAME.test(name) || !description) return { skill: null, problems };
  return {
    skill: {
      name,
      description: description.slice(0, 1024),
      body: body.trim(),
      base,
      source,
      ...(data.license ? { license: String(data.license) } : {}),
      ...(data.compatibility ? { compatibility: String(data.compatibility) } : {}),
      ...(data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata) ? { metadata: data.metadata } : {}),
      allowedTools: listValue(data['allowed-tools']),
    },
    problems,
  };
}

/** A skill given inline ({ name, description, body | instructions, … }) -> the same shape as parseSkill's. */
export function normalizeSkill(def, { source = 'app' } = {}) {
  if (!def || typeof def !== 'object') return { skill: null, problems: ['a skill must be an object.'] };
  if (typeof def.text === 'string') return parseSkill(def.text, { base: def.base || '', source });
  const fm = ['---', `name: ${JSON.stringify(String(def.name ?? ''))}`, `description: ${JSON.stringify(String(def.description ?? ''))}`, '---', String(def.body ?? def.instructions ?? '')].join('\n');
  const r = parseSkill(fm, { base: def.base || '', source });
  if (r.skill && def['allowed-tools'] !== undefined) r.skill.allowedTools = listValue(def['allowed-tools']);
  if (r.skill && def.allowedTools !== undefined) r.skill.allowedTools = listValue(def.allowedTools);
  return r;
}

/**
 * A path the model asked to read inside a skill's folder -> the clean relative path, or throws with the reason.
 * Relative paths only, no "..", no hidden files, text types only.
 */
export function skillFilePath(path) {
  const p = String(path ?? '').trim().replace(/^\.\/+/, '');
  if (!p) throw new Error('Give the path of a file inside the skill, for example references/guide.md.');
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.includes('\\')) throw new Error(`"${p}" is not a path inside the skill: use a relative path such as references/guide.md.`);
  const parts = p.split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) throw new Error(`"${p}" leaves the skill's folder or names a hidden file.`);
  const ext = (/\.([a-z0-9]+)$/i.exec(p)?.[1] || '').toLowerCase();
  if (!SKILL_FILE_TYPES.includes(ext)) throw new Error(`"${p}" is not a text file the agent can read (${SKILL_FILE_TYPES.join(', ')}).`);
  if (p.toUpperCase() === 'SKILL.MD') throw new Error('SKILL.md is the skill itself: call use_skill instead.');
  return p;
}

/** "/proofreading fix the second paragraph" -> { name: 'proofreading', rest: 'fix the second paragraph' } or null. */
export function parseSlashCommand(text, names) {
  const m = /^\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:\s+([\s\S]*))?$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const known = names instanceof Set ? names : new Set(names || []);
  return known.has(m[1]) ? { name: m[1], rest: (m[2] || '').trim() } : null;
}

/** Text cut to `max` characters, saying so. */
export function clipText(text, max, what = 'text') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max - 120)}\n…[${what} cut: the first ${(max - 120).toLocaleString('en-US')} of ${s.length.toLocaleString('en-US')} characters are shown]`;
}

/**
 * The SKILLS section of the system prompt: the available skills (name and description), then the instructions of
 * each active one. '' when there are no skills.
 * @param {object} o
 * @param {Array}  o.skills    the skills this agent may use
 * @param {string[]} [o.active] names of the skills active in this conversation
 * @param {boolean} [o.canLoad] the model can call use_skill (tools are usable in this request)
 */
export function buildSkillsPrompt({ skills = [], active = [], canLoad = true } = {}) {
  if (!skills.length) return '';
  const on = new Set(active);
  const lines = ['== SKILLS =='];
  lines.push(canLoad
    ? 'Skills are instructions for particular kinds of work in this application. When the user\'s request matches a skill below, call `use_skill` with its name before you start, then follow it; it stays active for the rest of the conversation. Do not guess what a skill says. A message starting with /skill-name activates that skill.'
    : 'Skills are instructions for particular kinds of work in this application. The active ones are below; follow them when they apply.');
  for (const s of skills) lines.push(`- ${s.name}${on.has(s.name) ? ' (active)' : ''} — ${s.description.replace(/\s+/g, ' ')}`);
  for (const s of skills) {
    if (!on.has(s.name)) continue;
    lines.push('', `== SKILL: ${s.name} (active) ==`, clipText(s.body, SKILL_BODY_MAX, 'skill'));
    if (canLoad) lines.push(`(Files this skill points to — relative to its folder — can be read with read_skill_file, skill "${s.name}".)`);
  }
  return lines.join('\n');
}

/**
 * What use_skill tells the model: the skill is active, and how the tools it names stand right now.
 * @param {object} skill
 * @param {(name: string) => ('on'|'off'|'missing'|'denied')} toolState
 */
export function skillLoadedMessage(skill, toolState = () => 'missing') {
  const parts = [`The skill "${skill.name}" is active: its instructions are now in your system prompt, under == SKILL: ${skill.name} (active) ==. Follow them.`];
  if (skill.allowedTools?.length) {
    const words = { on: 'on', off: 'turned off — ask with request_tool if you need it', missing: 'not in this application', denied: 'not permitted' };
    parts.push(`Tools it uses: ${skill.allowedTools.map((t) => `${t} (${words[toolState(t)] || toolState(t)})`).join(', ')}.`);
  }
  return parts.join(' ');
}
