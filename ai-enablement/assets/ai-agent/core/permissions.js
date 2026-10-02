// Permissions: which tools the agent may use without asking, must ask about, or may not use at all. Pure module.
//
// Every tool has an effect — what it can do:
//   read         looks something up; changes nothing
//   write        changes the application's state (undoable, or easily put right)
//   destructive  deletes or overwrites; cannot be undone
//   external     reaches outside the application: sends, publishes, pays, calls a third party
//   system       changes the application itself: its code, its configuration, its capabilities
//
// A policy is three rule lists, set by the application (the capability index or the `permissions` option) and by the
// active agent (its frontmatter). Rules are tool names, names with * wildcards, `toolset:<name>` or `effect:<effect>`:
//
//   { allow: ['find_text', 'effect:read'], ask: ['toolset:file'], deny: ['new_document'] }
//
// Precedence: deny > ask > allow > the user's confirmation settings (Settings > Tools). `deny` hides the tool from the
// model (the user cannot turn it on from the chat either); `ask` always shows the confirmation card; `allow` runs it
// without the card. A `system` tool always asks: no setting and no allow rule switches that off.

export const PERMISSION_KEYS = Object.freeze(['allow', 'ask', 'deny']);
const RULE = /^(?:(toolset|effect):)?[\w*-]{1,64}$/;

/** A policy with clean, de-duplicated rule lists ({ allow, ask, deny }). Invalid rules are left out and reported. */
export function normalizePolicy(value, problems = []) {
  const out = { allow: [], ask: [], deny: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (value !== undefined && value !== null) problems.push('permissions must be an object with allow / ask / deny lists.');
    return out;
  }
  for (const [key, list] of Object.entries(value)) {
    if (!PERMISSION_KEYS.includes(key)) { problems.push(`permissions: unknown list "${key}" (use allow, ask or deny).`); continue; }
    const items = Array.isArray(list) ? list : String(list ?? '').split(/[\s,]+/);
    for (const raw of items) {
      const rule = String(raw ?? '').trim();
      if (!rule) continue;
      if (!RULE.test(rule)) { problems.push(`permissions.${key}: "${rule}" is not a rule (a tool name, name_*, toolset:<name> or effect:<effect>).`); continue; }
      if (!out[key].includes(rule)) out[key].push(rule);
    }
  }
  return out;
}

/** Several policies as one: each list is the union of theirs. */
export function mergePolicies(...policies) {
  const out = { allow: [], ask: [], deny: [] };
  for (const p of policies) {
    if (!p) continue;
    for (const key of PERMISSION_KEYS) for (const rule of p[key] || []) if (!out[key].includes(rule)) out[key].push(rule);
  }
  return out;
}

function glob(pattern, value) {
  if (!pattern.includes('*')) return pattern === value;
  const parts = pattern.split('*');
  let at = 0;
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    if (k === 0) {
      if (!value.startsWith(part)) return false;
      at = part.length;
      continue;
    }
    if (k === parts.length - 1) return value.length - at >= part.length && value.endsWith(part);
    const found = value.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  return true;
}

/** The toolsets a tool belongs to: the one that declares it plus any that list it (`toolsets`, set by the registry). */
export const toolsetsOf = (tool) => (Array.isArray(tool.toolsets) && tool.toolsets.length ? tool.toolsets : tool.toolset ? [tool.toolset] : []);

/** Does one rule cover this tool? */
export function ruleMatches(rule, tool) {
  const r = String(rule);
  if (r.startsWith('effect:')) return glob(r.slice(7), String(tool.effect || ''));
  if (r.startsWith('toolset:')) return toolsetsOf(tool).some((ts) => glob(r.slice(8), String(ts)));
  return glob(r, String(tool.name || ''));
}

/** 'deny' | 'ask' | 'allow' | '' (no rule: the user's settings decide). */
export function decidePermission(tool, policy) {
  if (!policy || !tool) return '';
  for (const key of ['deny', 'ask', 'allow']) {
    if ((policy[key] || []).some((rule) => ruleMatches(rule, tool))) return key;
  }
  return '';
}

/**
 * Must the user confirm this call?
 * @param {object} o
 * @param {object} o.tool             the tool (its effect)
 * @param {string} o.decision         decidePermission()
 * @param {object} o.settings         confirmWrites, confirmDestructive
 * @param {boolean} [o.allowedForChat] the user chose "Allow for this chat" for this write tool
 */
export function needsConfirmation({ tool, decision = '', settings = {}, allowedForChat = false }) {
  if (tool.effect === 'system') return true;
  if (decision === 'ask') return true;
  if (decision === 'allow') return false;
  if (tool.effect === 'write') return settings.confirmWrites !== false && !allowedForChat;
  if (tool.effect === 'destructive' || tool.effect === 'external') return settings.confirmDestructive !== false;
  return false;
}

/** A policy in one line, for prompts and settings ("deny: new_document · ask: toolset:file"). */
export function describePolicy(policy) {
  return PERMISSION_KEYS.filter((k) => policy?.[k]?.length).map((k) => `${k}: ${policy[k].join(', ')}`).join(' · ');
}
