// Tool contracts in the standard shapes: JSON Schema for inputs (as MCP's `inputSchema`) and MCP tool annotations for
// what a tool does. Pure module: no DOM.
//
// A tool may declare its input either with the runtime's field shorthand (`parameters`, see core/tools.js) or with a
// JSON Schema object. The schema is converted to fields, so arguments are validated the same way either way. Only the
// subset that can be enforced is accepted: a construct that cannot be enforced (nested objects, $ref, oneOf…) is
// refused with the reason, never silently loosened.
//
// Effects (core/permissions.js) and MCP annotations describe the same thing:
//   read         readOnlyHint: true
//   write        readOnlyHint: false, destructiveHint: false
//   destructive  destructiveHint: true
//   external     openWorldHint: true   (it reaches outside the application: sends, publishes, calls a third party)
//   system       destructiveHint: true (it changes the application itself: its code, its configuration)

const IGNORED = new Set(['title', 'description', 'default', 'examples', '$comment', 'deprecated', 'readOnly', 'writeOnly', 'format', 'contentMediaType', 'contentEncoding', '$schema', '$id']);
const FIELD_KEYS = {
  string: new Set(['type', 'enum', 'maxLength', 'minLength', 'pattern', 'const']),
  number: new Set(['type', 'enum', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'const']),
  boolean: new Set(['type', 'const']),
  array: new Set(['type', 'items', 'maxItems', 'minItems']),
};

const UNSUPPORTED = ['$ref', 'oneOf', 'anyOf', 'allOf', 'not', 'if', 'patternProperties'];

/** The one type of a property ({ type, nullable }), or throws. */
function propType(key, prop, where) {
  let type = prop.type;
  let nullable = false;
  if (Array.isArray(type)) {
    const real = type.filter((t) => t !== 'null');
    nullable = real.length < type.length;
    if (real.length !== 1) throw new Error(`${where}: "${key}" has several types (${type.join(', ')}); give it one.`);
    type = real[0];
  }
  if (type === undefined && Array.isArray(prop.enum)) type = prop.enum.every((v) => typeof v === 'number') ? 'number' : 'string';
  if (type === undefined && 'const' in prop) type = typeof prop.const;
  if (type === 'object') throw new Error(`${where}: "${key}" is an object. Tool arguments are flat: give each value its own parameter, or take JSON text in a string with a maxLength.`);
  return { type, nullable };
}

function stringField(key, prop, where) {
  const field = { type: 'string' };
  if (prop.maxLength > 0) field.maxLength = prop.maxLength;
  if (prop.minLength > 0) field.minLength = prop.minLength;
  if (typeof prop.pattern === 'string') {
    try { new RegExp(prop.pattern, 'u'); } catch { throw new Error(`${where}: "${key}" has a pattern that is not a valid regular expression.`); }
    field.pattern = prop.pattern;
  }
  return field;
}

function numberField(key, prop, where, type) {
  const field = { type };
  if (Number.isFinite(prop.minimum)) field.min = prop.minimum;
  if (Number.isFinite(prop.maximum)) field.max = prop.maximum;
  const exMin = Number.isFinite(prop.exclusiveMinimum);
  const exMax = Number.isFinite(prop.exclusiveMaximum);
  if (exMin || exMax) {
    // Exact for integers (> 0 is >= 1); a number range with an open end cannot be clamped, so it is refused.
    if (type !== 'integer') throw new Error(`${where}: "${key}" uses an exclusive bound; use minimum / maximum for a number.`);
    if (exMin) field.min = Math.max(field.min ?? -Infinity, Math.floor(prop.exclusiveMinimum) + 1);
    if (exMax) field.max = Math.min(field.max ?? Infinity, Math.ceil(prop.exclusiveMaximum) - 1);
  }
  if (prop.multipleOf > 0) field.step = prop.multipleOf;
  return field;
}

function arrayField(key, prop, where) {
  const items = prop.items ?? { type: 'string' };
  if (Array.isArray(items)) throw new Error(`${where}: "${key}" has a tuple of item schemas; give one schema for every item.`);
  const item = fieldFromSchema(`${key}[]`, items, where);
  if (item.type === 'array') throw new Error(`${where}: "${key}" is a list of lists, which tool arguments do not support.`);
  delete item.description;
  delete item.default;
  delete item.nullable;
  const field = { type: 'array', items: item };
  if (prop.maxItems > 0) field.maxItems = prop.maxItems;
  if (prop.minItems > 0) field.minItems = prop.minItems;
  return field;
}

/** One property of a JSON Schema object -> a field spec (or throws with the reason). */
function fieldFromSchema(key, prop, where) {
  if (!prop || typeof prop !== 'object' || Array.isArray(prop)) throw new Error(`${where}: "${key}" must be a schema object.`);
  const bad = UNSUPPORTED.find((k) => k in prop);
  if (bad) throw new Error(`${where}: "${key}" uses ${bad}, which tool arguments do not support. Describe it with one type, or with an enum.`);
  const { type, nullable } = propType(key, prop, where);
  const family = type === 'integer' ? 'number' : type;
  if (!FIELD_KEYS[family]) throw new Error(`${where}: "${key}" has an unsupported type "${type}".`);
  const unknown = Object.keys(prop).find((k) => !FIELD_KEYS[family].has(k) && !IGNORED.has(k));
  if (unknown) throw new Error(`${where}: "${key}" uses "${unknown}", which cannot be enforced for a ${type}.`);

  if (family === 'boolean' && 'const' in prop) throw new Error(`${where}: "${key}" can only be ${prop.const}: that is not a parameter.`);
  const values = Array.isArray(prop.enum) ? prop.enum.filter((v) => v !== null) : null;
  let field;
  if ((values || 'const' in prop) && family !== 'boolean' && family !== 'array') {
    const list = values ?? [prop.const];
    if (!list.length) throw new Error(`${where}: "${key}" has an empty enum.`);
    field = { type: 'enum', values: list };
  } else if (family === 'string') field = stringField(key, prop, where);
  else if (family === 'number') field = numberField(key, prop, where, type);
  else if (family === 'boolean') field = { type: 'boolean' };
  else field = arrayField(key, prop, where);

  if (prop.description) field.description = String(prop.description);
  if (prop.default !== undefined) field.default = prop.default;
  if (nullable) field.nullable = true;
  return field;
}

/**
 * A JSON Schema object (a tool's `inputSchema`) -> the runtime's field specs (a tool's `parameters`).
 * @param {object} schema  { type: 'object', properties: {…}, required: […] }
 * @param {string} [where] for messages, e.g. 'Tool "find_text"'
 */
export function fromJsonSchema(schema, where = 'inputSchema') {
  if (schema === undefined || schema === null) return {};
  if (typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${where}: the input schema must be an object.`);
  if (schema.type !== undefined && schema.type !== 'object') throw new Error(`${where}: the input schema must have type "object".`);
  for (const bad of ['$ref', 'oneOf', 'anyOf', 'allOf', 'patternProperties']) {
    if (bad in schema) throw new Error(`${where}: the input schema uses ${bad}, which tool arguments do not support.`);
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  const out = {};
  for (const [key, prop] of Object.entries(schema.properties || {})) {
    const field = fieldFromSchema(key, prop, where);
    if (required.has(key)) field.required = true;
    out[key] = field;
  }
  for (const key of required) if (!(key in out)) throw new Error(`${where}: "${key}" is required but not among the properties.`);
  return out;
}

export const EFFECT_NAMES = Object.freeze(['read', 'write', 'destructive', 'external', 'system']);

/** MCP annotations -> an effect (when the tool does not say its effect). */
export function effectFromAnnotations(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.readOnlyHint === true) return 'read';
  if (a.destructiveHint === true) return 'destructive';
  if (a.openWorldHint === true) return 'external';
  if (a.readOnlyHint === false || a.destructiveHint === false) return 'write';
  return '';
}

/** An effect (+ the tool's own annotations) -> MCP annotations. The effect wins where they disagree. */
export function annotationsFor(effect, given = {}) {
  const own = given && typeof given === 'object' ? given : {};
  const out = { ...own };
  out.readOnlyHint = effect === 'read';
  out.destructiveHint = effect === 'destructive' || effect === 'system';
  out.openWorldHint = effect === 'external' || own.openWorldHint === true;   // a read tool may still look outside (a web search)
  if (effect === 'read') delete out.destructiveHint;
  return out;
}
