// Markdown renderer for the agent's replies. Self-contained on purpose: no marked/markdown-it, no build step.
//
// The rule that matters most: the model's text is escaped FIRST and only then decorated. Nothing the model writes
// can introduce an element or attribute — every tag in the output is emitted by this file, and links are limited
// to http(s) and mailto.
//
// Supported: fenced code (``` and ~~~, with a language label and action buttons), headings, bullet/ordered lists
// with nesting and task boxes, blockquotes, GFM pipe tables with alignment, horizontal rules, and inline code, bold,
// italic, bold-italic, strikethrough, links and bare URLs. Unterminated fences render as code mid-stream.
//
// renderMarkdown(text, { codeActions }) -> { html, code }. `code` lists every fenced block so the caller can act on
// one by index. `codeActions` = [{ id, label, title?, when?(block) }] adds buttons next to the built-in Copy.

const HOLD = '\u0001';

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ inline */

function safeUrl(value) {
  const url = String(value || '').trim();
  return /^(?:https?:|mailto:)/i.test(url) ? url : '';
}

export function inline(text) {
  let out = esc(text);
  const held = [];
  const hold = (html) => { held.push(html); return HOLD + (held.length - 1) + HOLD; };

  // Code spans and links are lifted out first so emphasis cannot reach inside them.
  out = out.replace(/`([^`\n]+)`/g, (m, body) => hold(`<code>${body}</code>`));
  out = out.replace(/\[([^\]\n]*)\]\(\s*([^)\s]+)(?:\s+&quot;[^\n]*?&quot;)?\s*\)/g, (m, label, href) => {
    const url = safeUrl(href);
    if (!url) return m;
    return hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label === '' ? url : label}</a>`);
  });
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<>()"']+)/gi, (m, lead, url) => {
    const trimmed = url.replace(/[.,;:!?]+$/, '');
    return lead + hold(`<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${trimmed}</a>`) + url.slice(trimmed.length);
  });

  out = out.replace(/\*\*\*([^\n]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  out = out.replace(/\*\*([^\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^\n]+?)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*(\S[^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\n]+?)_(?=[\s).,:;!?]|$)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^\n]+?)~~/g, '<del>$1</del>');

  return out.replace(new RegExp(`${HOLD}(\\d+)${HOLD}`, 'g'), (m, i) => held[Number(i)] || '');
}

/* ------------------------------------------------------------------- blocks */

const isBlank = (line) => /^\s*$/.test(line);
const isFence = (line) => /^ {0,3}(`{3,}|~{3,})/.test(line);
const isHeading = (line) => /^ {0,3}#{1,6}[ \t]/.test(line);
const isQuote = (line) => /^ {0,3}>/.test(line);
const isRule = (line) => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
const isListItem = (line) => /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+\S|[ \t]*$)/.test(line);
const indentWidth = (value) => String(value).replace(/\t/g, '    ').length;

function markerInfo(line) {
  const m = /^([ \t]*)(\d{1,9}[.)]|[-*+])[ \t]/.exec(line);
  return m ? { indent: indentWidth(m[1]), type: /\d/.test(m[2]) ? 'ol' : 'ul' } : null;
}

function isDelimiterRow(line) {
  return /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line) && line.includes('-');
}

const isTableStart = (lines, i) => lines[i].includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1]);

function startsBlock(lines, i) {
  const line = lines[i];
  return isFence(line) || isHeading(line) || isQuote(line) || isRule(line) || isListItem(line) || isTableStart(lines, i);
}

function renderBlocks(lines, ctx) {
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)/.exec(line);
    if (fence) {
      const ch = fence[1].charAt(0);
      const closing = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${fence[1].length},}[ \\t]*$`);
      const body = [];
      i++;
      while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      html += codeBlock(fence[2], body.join('\n'), ctx);
      continue;
    }

    const heading = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html += `<h${level}>${inline(heading[2].replace(/[ \t]+#+[ \t]*$/, ''))}</h${level}>`;
      i++;
      continue;
    }

    if (isRule(line)) { html += '<hr>'; i++; continue; }

    if (isQuote(line)) {
      const quoted = [];
      while (i < lines.length && isQuote(lines[i])) quoted.push(lines[i++].replace(/^ {0,3}>[ \t]?/, ''));
      html += `<blockquote>${renderBlocks(quoted, ctx)}</blockquote>`;
      continue;
    }

    if (isTableStart(lines, i)) {
      html += table(lines, i);
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) i++;
      continue;
    }

    const start = markerInfo(line);
    if (start) {
      const listLines = [];
      while (i < lines.length) {
        const current = lines[i];
        if (isBlank(current)) {
          const next = i + 1 < lines.length ? markerInfo(lines[i + 1]) : null;
          if (next && (next.type === start.type || next.indent > start.indent)) { listLines.push(current); i++; continue; }
          if (i + 1 < lines.length && /^[ \t]{2,}\S/.test(lines[i + 1])) { listLines.push(current); i++; continue; }
          break;
        }
        const item = markerInfo(current);
        if (item) {
          if (item.indent <= start.indent && item.type !== start.type) break;
          listLines.push(current);
          i++;
          continue;
        }
        if (/^[ \t]+\S/.test(current)) { listLines.push(current); i++; continue; }
        break;
      }
      html += list(listLines, ctx);
      continue;
    }

    const paragraph = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) paragraph.push(lines[i++]);
    html += `<p>${paragraph.map(inline).join('<br>')}</p>`;
  }
  return html;
}

/* ------------------------------------------------------------------- tables */

function splitRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const alignAttr = (v) => (v ? ` style="text-align:${v}"` : '');

function table(lines, index) {
  const head = splitRow(lines[index]);
  const align = splitRow(lines[index + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
  });
  let html = '<div class="aia-md-table-wrap"><table class="aia-md-table"><thead><tr>';
  head.forEach((cell, c) => { html += `<th${alignAttr(align[c])}>${inline(cell)}</th>`; });
  html += '</tr></thead><tbody>';
  let row = index + 2;
  while (row < lines.length && !isBlank(lines[row]) && lines[row].includes('|')) {
    const cells = splitRow(lines[row]);
    html += '<tr>';
    head.forEach((h, c) => { html += `<td${alignAttr(align[c])}>${inline(cells[c] ?? '')}</td>`; });
    html += '</tr>';
    row++;
  }
  return `${html}</tbody></table></div>`;
}

/* -------------------------------------------------------------------- lists */

function list(blockLines, ctx) {
  const items = [];
  for (const line of blockLines) {
    const m = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]*(.*)$/.exec(line);
    if (m) {
      items.push({ indent: indentWidth(m[1]), ordered: /\d/.test(m[2]), number: parseInt(m[2], 10), body: [m[3]] });
    } else if (items.length) {
      items[items.length - 1].body.push(line.replace(/^ {1,4}/, ''));
    }
  }
  if (!items.length) return '';
  return listFrom(items, Math.min(...items.map((it) => it.indent)), ctx);
}

function listFrom(items, base, ctx) {
  const first = items[0];
  const tag = first.ordered ? 'ol' : 'ul';
  const startAttr = first.ordered && first.number > 1 ? ` start="${first.number}"` : '';
  let html = `<${tag}${startAttr}>`;
  let i = 0;
  while (i < items.length) {
    if (items[i].indent < base) break;
    const item = items[i++];
    const children = [];
    while (i < items.length && items[i].indent > base) children.push(items[i++]);
    let body = itemBody(item, ctx);
    if (children.length) body += listFrom(children, Math.min(...children.map((c) => c.indent)), ctx);
    html += `<li>${body}</li>`;
  }
  return `${html}</${tag}>`;
}

function itemBody(item, ctx) {
  let raw = item.body.join('\n');
  let html = '';
  const task = /^\[([ xX])\][ \t]+/.exec(raw);
  if (task) {
    html += `<span class="aia-md-task${task[1].toLowerCase() === 'x' ? ' done' : ''}" aria-hidden="true"></span>`;
    raw = raw.slice(task[0].length);
  }
  // A lone paragraph inside an item is unwrapped so tight lists stay tight.
  return html + renderBlocks(raw.split('\n'), ctx).replace(/^<p>([\s\S]*?)<\/p>$/, '$1');
}

/* -------------------------------------------------------------- code blocks */

function codeBlock(language, text, ctx) {
  const code = String(text ?? '').replace(/\s+$/, '');
  const lang = String(language || '').toLowerCase().replace(/[^a-z0-9+#.-]/g, '');
  const block = { language: lang, code };
  const index = ctx.code.push(block) - 1;

  let buttons = '';
  for (const action of ctx.codeActions) {
    let show = true;
    try { show = typeof action.when === 'function' ? !!action.when(block) : true; } catch { show = false; }
    if (!show) continue;
    buttons += `<button type="button" class="aia-md-btn aia-md-btn-accent" data-aia-code-action="${esc(action.id)}" data-aia-code="${index}"${action.title ? ` title="${esc(action.title)}"` : ''}>${esc(action.label)}</button>`;
  }
  buttons += `<button type="button" class="aia-md-btn" data-aia-code-action="copy" data-aia-code="${index}">Copy</button>`;

  return '<div class="aia-md-code">'
    + `<div class="aia-md-code-head"><span class="aia-md-code-lang">${esc(lang || 'text')}</span><div class="aia-md-code-actions">${buttons}</div></div>`
    + `<pre class="aia-md-code-body"><code>${esc(code)}</code></pre>`
    + '</div>';
}

/* --------------------------------------------------------------- public API */

/**
 * @param {string} raw  markdown as it arrived from the model (may be mid-stream)
 * @param {{codeActions?: Array<{id: string, label: string, title?: string, when?: Function}>}} [options]
 * @returns {{html: string, code: Array<{language: string, code: string}>}}
 */
export function renderMarkdown(raw, options = {}) {
  const ctx = { code: [], codeActions: Array.isArray(options.codeActions) ? options.codeActions : [] };
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  return { html: renderBlocks(text.split('\n'), ctx), code: ctx.code };
}
