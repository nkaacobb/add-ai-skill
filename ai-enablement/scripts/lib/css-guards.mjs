// The CSS side of the runtime's layout guards (ai-agent.css, runtime 1.6.1+), shared by scripts/detect.mjs and
// scripts/guards.mjs: a small stylesheet reader (rules, specificity, the winning declaration), which guards a
// stylesheet has, the host's global element rules, app CSS the guards make redundant, and applying the guard blocks.
//   pinnedChrome   the settings dialog's header, tab strip and footer never shrink (flex-shrink: 0) and its body has
//                  min-height: 0 — the "aia-guard: pinned-chrome" block, or the same rules written by hand
//   hostIsolation  the "aia-guard: host-isolation" block: the host page's element rules (label, button, input, p,
//                  h2…) do not reach what the runtime renders

export const GUARDS = ['pinned-chrome', 'host-isolation'];
const MARK = (name) => `aia-guard: ${name}`;
/** The anchor the host-isolation block goes before: present in every ai-agent.css since 1.0. */
const ISOLATION_ANCHOR = /^\.aia-scope \*, \.aia-scope \*::before, \.aia-scope \*::after\s*\{/m;
const HOST_ELEMENTS = new Set(['label', 'input', 'select', 'textarea', 'button', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/* ------------------------------------------------------------------------------------------------ CSS reading */

/** Comments blanked out (same length, newlines kept, so offsets and line numbers still hold). */
const blankComments = (text) => String(text).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));

function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return text.length;
}

/** Split at `sep` characters outside (), [] and strings. */
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && sep.includes(c)) { out.push(text.slice(from, i)); from = i + 1; }
  }
  out.push(text.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

function declarations(body) {
  // Nested rules (CSS nesting) are skipped: only this rule's own declarations.
  const own = body.includes('{') ? body.replace(/[^;{}]*\{[^{}]*\}/g, ';') : body;
  return splitTop(own, ';').map((d) => {
    const colon = d.indexOf(':');
    if (colon < 1) return null;
    let value = d.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    return { prop: d.slice(0, colon).trim().toLowerCase(), value, important };
  }).filter(Boolean);
}

/**
 * The style rules of a stylesheet, in order: { selectors, decls, atRules (enclosing @media/@supports/@layer
 * preludes), line }. Comments and the contents of @keyframes, @font-face and the like are skipped.
 */
export function parseCss(text) {
  const src = blankComments(text);
  const rules = [];
  const stack = [];
  const lineAt = (offset) => src.slice(0, offset).split('\n').length;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
    if (c === ';') { start = i + 1; continue; }                // @import, @charset…
    if (c === '}') { stack.pop(); start = i + 1; continue; }
    if (c !== '{') continue;
    const prelude = src.slice(start, i).trim();
    const lead = start + (src.slice(start, i).length - src.slice(start, i).trimStart().length);
    if (prelude.startsWith('@')) {
      if (/^@(media|supports|layer|container|scope|document)\b/i.test(prelude)) { stack.push(prelude); start = i + 1; continue; }
      i = closing(src, i);                                     // @keyframes, @font-face, @page…: not style rules
      start = i + 1;
      continue;
    }
    const end = closing(src, i);
    rules.push({ selectors: splitTop(prelude, ','), decls: declarations(src.slice(i + 1, end)), atRules: [...stack], line: lineAt(lead) });
    i = end;
    start = i + 1;
  }
  return rules;
}

/** Compound selectors, subject last: '.aia-scope > .aia-tabs:hover' → ['.aia-scope', '.aia-tabs:hover']. */
export function compounds(selector) {
  const out = [];
  let cur = '';
  let depth = 0;
  for (const c of String(selector).trim()) {
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(c)) { if (cur) out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** Specificity [ids, classes, types] (:where() counts nothing; :is/:not/:has count their most specific argument). */
export function specificity(selector) {
  const total = [0, 0, 0];
  const add = (s) => { for (let k = 0; k < 3; k++) total[k] += s[k]; };
  const s = String(selector);
  for (let i = 0; i < s.length;) {
    const rest = s.slice(i);
    let m;
    if ((m = rest.match(/^:(where|is|not|has|matches|-webkit-any)\(/i))) {
      const open = i + m[0].length - 1;
      let depth = 0;
      let j = open;
      for (; j < s.length; j++) { if (s[j] === '(') depth++; else if (s[j] === ')' && --depth === 0) break; }
      if (m[1].toLowerCase() !== 'where') {
        const best = splitTop(s.slice(open + 1, j), ',').map(specificity).sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
        if (best) add(best);
      }
      i = j + 1;
    } else if ((m = rest.match(/^#[\w-]+/))) { total[0]++; i += m[0].length; }
    else if ((m = rest.match(/^\.[\w-]+/))) { total[1]++; i += m[0].length; }
    else if ((m = rest.match(/^\[[^\]]*\]/))) { total[1]++; i += m[0].length; }
    else if ((m = rest.match(/^::?(before|after|first-line|first-letter)\b/i)) || (m = rest.match(/^::[\w-]+(\([^)]*\))?/))) { total[2]++; i += m[0].length; }
    else if ((m = rest.match(/^:[\w-]+(\([^)]*\))?/))) { total[1]++; i += m[0].length; }
    else if ((m = rest.match(/^[a-zA-Z][\w-]*/))) { total[2]++; i += m[0].length; }
    else i++;
  }
  return total;
}

const beats = (a, b) => (a.important !== b.important ? a.important : a.spec[0] - b.spec[0] || a.spec[1] - b.spec[1] || a.spec[2] - b.spec[2] || a.order - b.order) > 0;

/**
 * The value that wins for `prop` on an element with class `cls`, from the top-level rules whose subject is that class
 * with no state (no :hover, ::before…): the cascade's own order — !important, then specificity, then source order.
 */
function winning(rules, cls, props) {
  const re = new RegExp(`\\.${cls}(?![\\w-])`);
  let best = null;
  rules.forEach((rule, order) => {
    if (rule.atRules.length) return;
    for (const sel of rule.selectors) {
      const subject = compounds(sel).pop() || '';
      if (!re.test(subject) || /:(?!is\(|where\()/.test(subject)) continue;
      for (const d of rule.decls) {
        if (!props.includes(d.prop)) continue;
        const cand = { ...d, spec: specificity(sel), order, selector: sel, line: rule.line };
        if (!best || beats(cand, best)) best = cand;
      }
    }
  });
  return best;
}

/** flex-shrink from a flex-shrink or flex declaration. */
function shrinkOf(d) {
  if (!d) return '1';
  if (d.prop === 'flex-shrink') return d.value.trim();
  const v = d.value.trim().toLowerCase();
  if (v === 'none') return '0';
  if (v === 'auto' || v === 'initial') return '1';
  const parts = v.split(/\s+/);
  return parts.length >= 2 && /^[\d.]+$/.test(parts[1]) ? parts[1] : '1';
}

/**
 * Which layout guards a runtime stylesheet has.
 * @returns {{ pinnedChrome: boolean, hostIsolation: boolean, missing: string[], markers: string[], details: object }}
 */
export function layoutGuards(cssText) {
  const text = String(cssText || '');
  const rules = parseCss(text);
  const shrink = {};
  for (const cls of ['aia-modal-head', 'aia-tabs', 'aia-modal-foot']) shrink[cls] = shrinkOf(winning(rules, cls, ['flex-shrink', 'flex']));
  const minHeight = winning(rules, 'aia-modal-body', ['min-height'])?.value.trim() || 'auto';
  const pinnedChrome = Object.values(shrink).every((v) => Number(v) === 0) && /^0(px|%|rem|em)?$/.test(minHeight);
  const markers = GUARDS.filter((g) => text.includes(MARK(g)));
  // The block, with a reset in it (all: revert, or the properties reset one by one).
  const hostIsolation = markers.includes('host-isolation') && /\.aia-scope\s+:where\(/.test(blankComments(guardBlock(text, 'host-isolation') || text));
  return {
    pinnedChrome,
    hostIsolation,
    missing: [...(pinnedChrome ? [] : ['pinned-chrome']), ...(hostIsolation ? [] : ['host-isolation'])],
    markers,
    details: { flexShrink: shrink, bodyMinHeight: minHeight },
  };
}

/* ------------------------------------------------------------------------------------------------ host CSS */

/** <style> blocks of a page or component (Vue's scoped and Svelte's component styles do not reach the agent). */
export function inlineStyles(text, file = '') {
  if (/\.svelte$/i.test(file)) return [];
  const out = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = re.exec(text))) {
    if (/\bscoped\b/i.test(m[1])) continue;
    const before = text.slice(0, m.index + m[0].indexOf('>') + 1);
    out.push({ css: m[2], lineOffset: before.split('\n').length - 1 });
  }
  return out;
}

/**
 * The host's own global element rules: a bare label, input, select, textarea, button, p or h1–h6 as the subject
 * (attributes and states allowed: input[type=number], button:hover), with nothing scoping it but html, body or
 * :root; and text-align on body/html. For information: what the settings dialog has to withstand.
 */
export function hostElementRules(cssText, file, lineOffset = 0) {
  const found = [];
  for (const rule of parseCss(cssText)) {
    for (const sel of rule.selectors) {
      if (/aia-/.test(sel)) continue;
      const parts = compounds(sel);
      const subject = parts.pop() || '';
      const type = subject.match(/^([a-zA-Z][\w-]*)/)?.[1]?.toLowerCase();
      const scopedOnlyByRoot = parts.every((p) => /^(html|body|:root|\*)([.:[#]|$)/i.test(p));
      const props = rule.decls.map((d) => d.prop);
      if (type && HOST_ELEMENTS.has(type) && !/[.#]/.test(subject.replace(/\([^)]*\)|\[[^\]]*\]/g, '')) && scopedOnlyByRoot && props.length) {
        found.push({ file, line: rule.line + lineOffset, selector: sel, props, media: rule.atRules.join(' ') || undefined });
      } else if (/^(html|body|:root)\b/i.test(subject) && !parts.length && props.includes('text-align')) {
        const v = rule.decls.find((d) => d.prop === 'text-align').value;
        found.push({ file, line: rule.line + lineOffset, selector: sel, props: [`text-align: ${v}`], media: rule.atRules.join(' ') || undefined });
      }
    }
  }
  return found;
}

/**
 * App CSS that works around what the guards now cover (references/upgrading.md, U5): flex-shrink/flex on the dialog's
 * header, tabs or footer; min-height on its body; !important on .aia-field, .aia-check, .aia-row and the like.
 */
export function layoutWorkarounds(cssText, file) {
  const found = [];
  for (const rule of parseCss(cssText)) {
    const sel = rule.selectors.join(', ');
    if (!/aia-/.test(sel)) continue;
    const props = rule.decls;
    if (/\.aia-(tabs|modal-head|modal-foot)(?![\w-])/.test(sel) && props.some((d) => d.prop === 'flex-shrink' || d.prop === 'flex')) {
      found.push({ file, line: rule.line, hint: `${sel} sets ${props.filter((d) => /^flex/.test(d.prop)).map((d) => `${d.prop}: ${d.value}`).join('; ')}: the runtime's pinned-chrome guard (1.6.1) does this — remove it once the settings check passes without it` });
    } else if (/\.aia-modal-body(?![\w-])/.test(sel) && props.some((d) => d.prop === 'min-height')) {
      found.push({ file, line: rule.line, hint: `${sel} sets min-height on the settings body: the runtime's pinned-chrome guard (1.6.1) does this — remove it once the settings check passes without it` });
    } else if (/\.aia-(field|check|row|label|label-row|note|section|grid|modal-[a-z]+|tabs?|btn[\w-]*)(?![\w-])/.test(sel) && props.some((d) => d.important)) {
      found.push({ file, line: rule.line, hint: `${sel} overrides the settings dialog with !important (${props.filter((d) => d.important).map((d) => d.prop).join(', ')}): the runtime's host-isolation guard (1.6.1) keeps host CSS out — remove it once the settings check passes without it` });
    }
  }
  return found;
}

/* ------------------------------------------------------------------------------------------------ applying */

/** A guard block of a stylesheet: from its marker comment to its "end aia-guard" comment, inclusive. */
export function guardBlock(cssText, name) {
  const text = String(cssText);
  const start = text.indexOf(`/* ${MARK(name)}`);
  const endMark = `/* end ${MARK(name)} */`;
  const end = text.indexOf(endMark, start);
  return start < 0 || end < 0 ? '' : text.slice(start, end + endMark.length);
}

/**
 * Add the missing guard blocks (taken from the skill's own ai-agent.css) to an app's ai-agent.css, keeping everything
 * else. host-isolation goes before the runtime's first base rule (it must come before every component rule);
 * pinned-chrome at the end (its (0,2,0) rules win there over any version's).
 * @returns {{ css: string, applied: string[], where: Record<string, string> }}
 */
export function applyGuards(appCss, skillCss) {
  let css = String(appCss);
  const eol = /\r\n/.test(css) ? '\r\n' : '\n';
  const block = (name) => guardBlock(skillCss, name).replace(/\r?\n/g, eol);
  const have = layoutGuards(css);
  const applied = [];
  const where = {};
  if (!have.hostIsolation) {
    const text = block('host-isolation');
    if (!text) throw new Error('the skill\'s ai-agent.css has no host-isolation block');
    const m = css.match(ISOLATION_ANCHOR);
    if (m) {
      css = `${css.slice(0, m.index)}${text}${eol}${eol}${css.slice(m.index)}`;
      where['host-isolation'] = 'before the .aia-scope * { box-sizing } rule';
    } else {
      // No anchor (a heavily edited copy): after the theme tokens, i.e. before the first rule that is not one.
      const rules = parseCss(css);
      const first = rules.find((r) => !r.selectors.every((s) => /^(:root|html\.aia-drawer-open|:where\(\.aia-scope[^)]*\)|\.aia-scope)$/.test(s.replace(/\s+/g, ' '))) && !r.atRules.length);
      const lines = css.split(eol);
      const at = first ? first.line - 1 : lines.length;
      lines.splice(at, 0, text, '');
      css = lines.join(eol);
      where['host-isolation'] = first ? `before line ${first.line} (${first.selectors[0]})` : 'at the end';
    }
    applied.push('host-isolation');
  }
  if (!have.pinnedChrome) {
    const text = block('pinned-chrome');
    if (!text) throw new Error('the skill\'s ai-agent.css has no pinned-chrome block');
    css = `${css.replace(/\s*$/, '')}${eol}${eol}${text}${eol}`;
    where['pinned-chrome'] = 'at the end';
    applied.push('pinned-chrome');
  }
  return { css, applied, where };
}
