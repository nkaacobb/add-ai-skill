// Reading values a model wrote in a fenced code block, for code actions that apply them to the app (settings,
// filters, simulation parameters…). Pure module: no DOM.
//
// Small local models are loose with formats: asked for a ```conditions block they may answer with ```json, add
// comments or trailing commas, quote numbers, or write `key: value` lines. So:
//   - a block tagged with one of your `tags` is accepted when at least one key is known (unknown keys are ignored);
//   - a generic block (json, yaml, text, untagged…) is accepted only when EVERY key is in the schema, so an unrelated
//     JSON example never grows an "Apply" button;
//   - the body may be a JSON object or `key: value` / `key = value` lines; parsing is linear (no regular expressions
//     that could backtrack on model output);
//   - values are coerced to the schema's type and clamped to its range (the ranges of the app's real controls).
// Apply the result through the app's real controls (setControlValue in ../ui/dom.js), so the host's own handlers and
// validation run.

export const GENERIC_TAGS = Object.freeze(['', 'json', 'json5', 'jsonc', 'javascript', 'js', 'yaml', 'yml', 'text', 'txt', 'plaintext', 'ini', 'toml', 'properties']);
const MAX_BODY = 20000;
const TRUE = new Set(['true', 'yes', 'on', '1', 'enabled', 'enable', 'y']);
const FALSE = new Set(['false', 'no', 'off', '0', 'disabled', 'disable', 'n']);

/** Lower-case, letters and digits only: "Wind speed", "wind_speed" and "windSpeed" all become "windspeed". */
export function normalizeKey(key) {
  let out = '';
  for (const ch of String(key ?? '').toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch;
  }
  return out;
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' || a === "'" || a === '`') && a === b) return t.slice(1, -1);
  }
  return t;
}

/** Strip a trailing line comment that is not inside quotes (`# …` or `// …`). */
function stripComment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === quote && line[i - 1] !== '\\') quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i);
    if (ch === '/' && line[i + 1] === '/' && (i === 0 || line[i - 1] !== ':')) return line.slice(0, i);
  }
  return line;
}

/** A flat object from JSON or `key: value` / `key = value` lines, or null. */
export function parseLooseObject(code) {
  const text = String(code ?? '').trim();
  if (!text || text.length > MAX_BODY) return null;
  if (text[0] === '{') {
    try {
      const v = JSON.parse(text);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* fall through to line parsing (trailing commas, comments, single quotes…) */ }
  }
  const out = {};
  let found = false;
  for (const raw of text.split('\n')) {
    let line = stripComment(raw).trim();
    if (line.startsWith('- ')) line = line.slice(2).trim();
    if (!line || line === '{' || line === '}' || line === '},' || line[0] === '[') continue;
    if (line[0] === '{') line = line.slice(1).trim();
    if (line.endsWith('}')) line = line.slice(0, -1).trim();
    if (line.endsWith(',') || line.endsWith(';')) line = line.slice(0, -1).trim();
    let sep = -1;
    let quote = '';
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === ':' || ch === '=') { sep = i; break; }
    }
    if (sep <= 0) continue;
    const key = unquote(line.slice(0, sep));
    const value = unquote(line.slice(sep + 1));
    if (!key) continue;
    out[key] = value;
    found = true;
  }
  return found ? out : null;
}

/**
 * Coerce one value to a field spec. Returns { ok, value, adjusted }.
 * spec: { type: 'number'|'integer'|'boolean'|'enum'|'string', min?, max?, step?, values?, maxLength? }
 */
export function coerceValue(spec, raw) {
  const type = spec.type || 'string';
  if (type === 'number' || type === 'integer') {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? '').trim());
    if (!Number.isFinite(n)) return { ok: false };
    let v = n;
    if (spec.step > 0) {
      const origin = Number.isFinite(spec.min) ? spec.min : 0;
      v = origin + Math.round((v - origin) / spec.step) * spec.step;
      v = Number(v.toFixed(Math.min(10, (String(spec.step).split('.')[1] || '').length)));
    }
    if (type === 'integer') v = Math.round(v);
    if (Number.isFinite(spec.min)) v = Math.max(spec.min, v);
    if (Number.isFinite(spec.max)) v = Math.min(spec.max, v);
    return { ok: true, value: v, adjusted: v !== n };
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw, adjusted: false };
    const s = String(raw ?? '').trim().toLowerCase();
    if (TRUE.has(s)) return { ok: true, value: true, adjusted: false };
    if (FALSE.has(s)) return { ok: true, value: false, adjusted: false };
    return { ok: false };
  }
  if (type === 'enum') {
    const values = spec.values || [];
    const s = String(raw ?? '').trim();
    const hit = values.find((x) => String(x) === s)
      ?? values.find((x) => String(x).toLowerCase() === s.toLowerCase())
      ?? values.find((x) => normalizeKey(x) === normalizeKey(s));
    return hit === undefined ? { ok: false } : { ok: true, value: hit, adjusted: String(hit) !== s };
  }
  const s = typeof raw === 'string' ? raw : raw === null || raw === undefined ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  const max = spec.maxLength > 0 ? spec.maxLength : 500;
  return { ok: true, value: s.slice(0, max), adjusted: s.length > max };
}

/**
 * Values from a fenced block, checked against an allowlisted schema.
 * @param {{language?: string, code: string}} block   what codeActions receive
 * @param {object} o
 * @param {string|string[]} [o.tags]   the fence tag(s) you asked the model to use, e.g. 'conditions'
 * @param {Record<string, object>} o.schema   key -> { type, min, max, step, values, maxLength, aliases: [] }
 * @param {string[]} [o.generic]   tags treated as generic (every key must be known)
 * @returns {{values: object, unknown: string[], invalid: string[], adjusted: string[]} | null}
 */
export function parseBlockValues(block, { tags = [], schema = {}, generic = GENERIC_TAGS } = {}) {
  const lang = String(block?.language ?? '').trim().toLowerCase();
  const own = (Array.isArray(tags) ? tags : [tags]).map((t) => String(t).toLowerCase());
  const tagged = own.includes(lang);
  if (!tagged && !generic.includes(lang)) return null;
  const obj = parseLooseObject(block?.code);
  if (!obj) return null;

  const index = new Map();
  for (const [key, spec] of Object.entries(schema)) {
    index.set(normalizeKey(key), key);
    for (const alias of spec?.aliases || []) index.set(normalizeKey(alias), key);
  }
  const values = {};
  const unknown = [];
  const invalid = [];
  const adjusted = [];
  for (const [rawKey, rawValue] of Object.entries(obj)) {
    const key = index.get(normalizeKey(rawKey));
    if (!key) { unknown.push(rawKey); continue; }
    const r = coerceValue(schema[key], rawValue);
    if (!r.ok) { invalid.push(key); continue; }
    values[key] = r.value;
    if (r.adjusted) adjusted.push(key);
  }
  if (!Object.keys(values).length) return null;
  if (!tagged && unknown.length) return null;
  return { values, unknown, invalid, adjusted };
}
