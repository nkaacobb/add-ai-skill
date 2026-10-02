// Markdown files with YAML frontmatter — SKILL.md (Agent Skills) and agent files (Claude Code / Copilot style):
//
//   ---
//   name: proofreading
//   description: Proofread the document and list each fix.
//   tools: [find_text, replace_text]
//   permissions:
//     deny: [new_document]
//   ---
//   # Instructions…
//
// Pure module: no DOM. It reads the subset of YAML these files use — mappings, block and flow sequences, nested
// mappings, plain / single- / double-quoted scalars, `|` and `>` block scalars, plain scalars continued on more
// indented lines, comments — and reports what it could not read instead of guessing. Anchors, tags and multi-document
// streams are not supported (no skill or agent file needs them).

const PLAIN_START = new Set(['#', "'", '"', '{', '[', ']', '}', ',', '&', '*', '!', '|', '>', '%', '@', '`']);
const isBlank = (ch) => ch === ' ' || ch === '\t';

/**
 * "key: value" -> { key, rest } (the key still quoted if it was), or null. A linear scan: the key ends at the first
 * ":" followed by a space or the end of the line (inside flow {…}: at the first ":"), outside quotes.
 */
function splitKey(text, { flow = false } = {}) {
  const t = String(text);
  const ends = (k) => flow || k + 1 >= t.length || isBlank(t[k + 1]);
  if (t[0] === '"' || t[0] === "'") {
    const end = t[0] === '"' ? closingDouble(t) : closingSingle(t);
    if (end < 0) return null;
    let k = end + 1;
    while (isBlank(t[k])) k++;
    if (t[k] !== ':' || !ends(k)) return null;
    return { key: t.slice(0, end + 1), rest: t.slice(k + 1).trim() };
  }
  if (!t || PLAIN_START.has(t[0]) || (t[0] === '-' && (t.length === 1 || isBlank(t[1])))) return null;
  for (let k = 0; k < t.length; k++) {
    if (t[k] === '#' && k > 0 && isBlank(t[k - 1])) return null;
    if (t[k] === ':' && ends(k)) {
      const key = t.slice(0, k).trimEnd();
      return key ? { key, rest: t.slice(k + 1).trim() } : null;
    }
  }
  return null;
}

/** Split a file into { data, body, errors }. A file without frontmatter is all body. */
export function parseFrontmatter(text) {
  const src = String(text ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!/^---[ \t]*\n/.test(src)) return { data: {}, body: src, errors: [] };
  const lines = src.split('\n');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { data: {}, body: src, errors: ['The frontmatter has no closing --- line.'] };
  const { value, errors } = parseYaml(lines.slice(1, end).join('\n'));
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (value !== null && value !== undefined && data !== value) errors.push('The frontmatter is not a mapping of keys to values.');
  return { data, body: lines.slice(end + 1).join('\n').replace(/^\n+/, ''), errors };
}

/** Parse a small YAML document: { value, errors }. */
export function parseYaml(text) {
  const errors = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((raw, n) => ({ raw, n: n + 1, indent: raw.length - raw.trimStart().length, text: raw.trim() }));
  const isContent = (l) => l && l.text !== '' && !l.text.startsWith('#');
  let i = 0;
  const skip = () => { while (i < lines.length && !isContent(lines[i])) i++; };

  /** A block scalar (| or >) whose header is at `parentIndent`. */
  function blockScalar(header, parentIndent) {
    const literal = header[0] === '|';
    const chomp = header.includes('-') ? 'strip' : header.includes('+') ? 'keep' : 'clip';
    const body = [];
    let indent = -1;
    while (i < lines.length) {
      const l = lines[i];
      if (l.text === '') { body.push(''); i++; continue; }
      if (l.indent <= parentIndent) break;
      if (indent < 0) indent = l.indent;
      if (l.indent < indent) break;
      body.push(l.raw.slice(indent));
      i++;
    }
    let trailing = 0;
    while (body.length && body[body.length - 1] === '') { body.pop(); trailing++; }
    let out;
    if (literal) out = body.join('\n');
    else {
      out = '';
      // Folding: lines join with a space, an empty line is a line break, more-indented lines keep their breaks.
      for (let k = 0; k < body.length; k++) {
        const line = body[k];
        if (k === 0) out = line;
        else if (line === '') out += '\n';
        else if (body[k - 1] === '') out += line;
        else if (/^\s/.test(line) || /^\s/.test(body[k - 1])) out += '\n' + line;
        else out += ' ' + line;
      }
    }
    if (!body.length) return '';
    if (chomp === 'strip') return out;
    if (chomp === 'keep') return out + '\n'.repeat(trailing + 1);
    return out + '\n';
  }

  /** The value after `key:` (or `- `) on line `at`, plus any continuation lines. */
  function inlineValue(rest, at, parentIndent) {
    const r = rest.trim();
    if (/^[|>][+-]?\d*\s*(#.*)?$/.test(r)) return blockScalar(r, parentIndent);
    if (r[0] === '"' || r[0] === "'") {
      let s = r;
      // A quoted scalar may continue on the next lines until its closing quote.
      while (!closedQuote(s) && i < lines.length && lines[i].indent > parentIndent) { s += ' ' + lines[i].text; i++; }
      return scalar(s, at);
    }
    if (r[0] === '[' || r[0] === '{') {
      let s = r;
      while (!balanced(s) && i < lines.length && lines[i].indent > parentIndent) { s += ' ' + lines[i].text; i++; }
      return flow(s, at);
    }
    let s = stripComment(r);
    // A plain scalar continues on more-indented lines (folded with spaces).
    while (i < lines.length && isContent(lines[i]) && lines[i].indent > parentIndent) {
      s += ' ' + stripComment(lines[i].text);
      i++;
    }
    return scalar(s, at);
  }

  function parseNode(indent) {
    skip();
    if (i >= lines.length) return null;
    const l = lines[i];
    if (l.indent < indent) return null;
    return l.text === '-' || l.text.startsWith('- ') ? parseSequence(l.indent) : parseMapping(l.indent);
  }

  function parseSequence(indent) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      if (l.indent !== indent || !(l.text === '-' || l.text.startsWith('- '))) break;
      i++;
      const rest = l.text === '-' ? '' : l.text.slice(2);
      const contentIndent = indent + 2 + (rest.length - rest.trimStart().length);
      if (!rest.trim()) { out.push(parseNode(indent + 1)); continue; }
      if (splitKey(rest.trim())) {
        // "- key: value" starts a mapping whose other keys are indented to the key's column.
        lines.splice(i, 0, { raw: ' '.repeat(contentIndent) + rest.trim(), n: l.n, indent: contentIndent, text: rest.trim() });
        out.push(parseMapping(contentIndent));
        continue;
      }
      out.push(inlineValue(rest, l.n, indent));
    }
    return out;
  }

  function parseMapping(indent) {
    const out = {};
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      if (l.indent < indent) break;
      if (l.indent > indent) { errors.push(`Line ${l.n}: unexpected indentation.`); i++; continue; }
      if (l.text === '-' || l.text.startsWith('- ')) break;
      const m = splitKey(l.text);
      if (!m) { errors.push(`Line ${l.n}: expected "key: value", found "${l.text.slice(0, 60)}".`); i++; continue; }
      i++;
      const key = String(scalar(m.key, l.n));
      if (Object.prototype.hasOwnProperty.call(out, key)) errors.push(`Line ${l.n}: "${key}" is set twice; the last value wins.`);
      const rest = m.rest;
      if (rest.trim() === '' || rest.trim().startsWith('#')) {
        skip();
        const next = lines[i];
        if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) out[key] = parseSequence(indent);
        else if (next && next.indent > indent) out[key] = parseNode(indent + 1);
        else out[key] = null;
      } else {
        out[key] = inlineValue(rest, l.n, indent);
      }
    }
    return out;
  }

  function scalar(s, at) {
    const t = String(s).trim();
    if (t === '') return null;
    if (t[0] === '"') {
      const end = closingDouble(t);
      if (end < 0) { errors.push(`Line ${at}: unclosed double quote.`); return t.slice(1); }
      if (t.slice(end + 1).trim() && !t.slice(end + 1).trim().startsWith('#')) errors.push(`Line ${at}: text after a closing quote.`);
      return unescapeDouble(t.slice(1, end));
    }
    if (t[0] === "'") {
      let out = '';
      let k = 1;
      for (; k < t.length; k++) {
        if (t[k] === "'") { if (t[k + 1] === "'") { out += "'"; k++; continue; } break; }
        out += t[k];
      }
      if (k >= t.length) errors.push(`Line ${at}: unclosed single quote.`);
      return out;
    }
    if (t[0] === '[' || t[0] === '{') return flow(t, at);
    if (/^(true|True|TRUE)$/.test(t)) return true;
    if (/^(false|False|FALSE)$/.test(t)) return false;
    if (/^(null|Null|NULL|~)$/.test(t)) return null;
    if (/^[-+]?\d+$/.test(t)) return Number(t);
    if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(t)) return Number(t);
    if (/^[&*!%@`]/.test(t)) errors.push(`Line ${at}: "${t[0]}" (anchors, aliases, tags) is not supported; quote the value.`);
    return t;
  }

  /** [a, "b, c", {k: v}] or {a: 1, b: [x]}. */
  function flow(s, at) {
    const t = stripComment(String(s).trim());
    const open = t[0];
    const close = open === '[' ? ']' : '}';
    if (t[t.length - 1] !== close) { errors.push(`Line ${at}: unclosed ${open}.`); return open === '[' ? [] : {}; }
    const items = splitFlow(t.slice(1, -1));
    if (open === '[') return items.filter((x) => x.trim() !== '').map((x) => (/^[[{]/.test(x.trim()) ? flow(x, at) : scalar(x, at)));
    const out = {};
    for (const item of items) {
      if (!item.trim()) continue;
      const m = splitKey(item.trim(), { flow: true });
      if (!m) { errors.push(`Line ${at}: expected "key: value" inside {…}.`); continue; }
      const v = m.rest;
      out[String(scalar(m.key, at))] = /^[[{]/.test(v) ? flow(v, at) : scalar(v, at);
    }
    return out;
  }

  const value = parseNode(0);
  skip();
  if (i < lines.length) errors.push(`Line ${lines[i].n}: could not be read ("${lines[i].text.slice(0, 60)}").`);
  return { value, errors };
}

function closingDouble(t) {
  for (let k = 1; k < t.length; k++) {
    if (t[k] === '\\') { k++; continue; }
    if (t[k] === '"') return k;
  }
  return -1;
}

function closingSingle(t) {
  for (let k = 1; k < t.length; k++) {
    if (t[k] !== "'") continue;
    if (t[k + 1] === "'") { k++; continue; }
    return k;
  }
  return -1;
}

function closedQuote(s) {
  const t = s.trim();
  if (t[0] === '"') return closingDouble(t) > 0;
  if (t[0] === "'") return closingSingle(t) > 0;
  return true;
}

function balanced(s) {
  let depth = 0;
  let quote = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (quote) {
      if (quote === '"' && ch === '\\') { k++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
  }
  return depth <= 0 && !quote;
}

function splitFlow(s) {
  const out = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (quote) {
      cur += ch;
      if (quote === '"' && ch === '\\') { cur += s[k + 1] ?? ''; k++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** A trailing ` # comment` outside quotes (YAML: a # after whitespace starts a comment). */
function stripComment(s) {
  let quote = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (quote) {
      if (quote === '"' && ch === '\\') { k++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { if (k === 0 || /[\s[{,:]/.test(s[k - 1])) quote = ch; continue; }
    if (ch === '#' && (k === 0 || s[k - 1] === ' ' || s[k - 1] === '\t')) return s.slice(0, k).trimEnd();
  }
  return s;
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f', ' ': ' ', e: '\x1b' };

function unescapeDouble(s) {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch !== '\\') { out += ch; continue; }
    const n = s[k + 1];
    if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(k + 2, k + 6))) { out += String.fromCharCode(parseInt(s.slice(k + 2, k + 6), 16)); k += 5; continue; }
    if (n === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(k + 2, k + 4))) { out += String.fromCharCode(parseInt(s.slice(k + 2, k + 4), 16)); k += 3; continue; }
    out += ESCAPES[n] ?? n ?? '';
    k++;
  }
  return out;
}

/** A list from a frontmatter value: a YAML list, or a comma- or space-separated string (Agent Skills' allowed-tools). */
export function listValue(v) {
  if (v === null || v === undefined || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x ?? '').trim()).filter(Boolean);
  return String(v).split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}
