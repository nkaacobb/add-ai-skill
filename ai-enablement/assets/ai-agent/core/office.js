// Text from office documents, for the agent: Word (.docx), Excel (.xlsx), PowerPoint (.pptx), OpenDocument (.odt,
// .ods, .odp) and RTF. The XML formats are ZIP archives (core/bytes.js); their XML is scanned, not parsed into a DOM,
// so this runs anywhere. What comes out is plain text with a little Markdown structure the model reads well:
// headings (#), list items (-), table rows (| a | b |), and one section per sheet or slide.
//
// Each reader returns { text, count?, unit? } (count/unit: 3 sheets, 12 slides) and throws an Error with a reason.

import { readZip, cp1252 } from './bytes.js';

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** XML text with its entities resolved. */
export function xmlText(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** One attribute of a tag's attribute text (prefix included, e.g. 'w:val'). */
export function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name.replace(/[.:-]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs || '');
  return m ? xmlText(m[1] ?? m[2]) : null;
}

/**
 * Walk an XML document: tag(name, attrs, closing, selfClosing) for every element tag, text(raw) for the text between
 * tags (entities still encoded; CDATA passed through as is).
 */
export function scanXml(xml, { tag = () => {}, text = () => {} }) {
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Z][^>]*>/g;
  let last = 0;
  let m;
  while ((m = re.exec(xml))) {
    if (m.index > last) text(xml.slice(last, m.index), false);
    last = re.lastIndex;
    if (m[2]) tag(m[2], m[3], m[1] === '/', m[4] === '/');
    else if (m[5] !== undefined) text(m[5], true);
  }
  if (last < xml.length) text(xml.slice(last), false);
}

const tidy = (s) => s.replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const cell = (s) => s.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();

/** Targets of a part's relationships: { rId: { target, type } }, targets resolved against the part's folder. */
async function relationships(zip, part) {
  const dir = part.includes('/') ? part.slice(0, part.lastIndexOf('/') + 1) : '';
  const relsPath = `${dir}_rels/${part.slice(dir.length)}.rels`;
  const xml = await zip.text(relsPath);
  const out = {};
  if (!xml) return out;
  scanXml(xml, {
    tag(name, attrs, closing) {
      if (closing || name !== 'Relationship') return;
      const t = attr(attrs, 'Target') || '';
      if (attr(attrs, 'TargetMode') === 'External') return;
      out[attr(attrs, 'Id')] = { type: attr(attrs, 'Type') || '', target: resolvePath(dir, t) };
    },
  });
  return out;
}

function resolvePath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${dir}${target}`.split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}

/** The package's main part (word/document.xml, xl/workbook.xml, ppt/presentation.xml unless it says otherwise). */
async function mainPart(zip, fallback) {
  const rels = await relationships(zip, '');
  const main = Object.values(rels).find((r) => /\/officeDocument$/.test(r.type));
  return main && zip.has(main.target) ? main.target : fallback;
}

/* ----------------------------------------------------------------------------------------- Word (.docx) */

/** Paragraphs, headings, list items and tables of one WordprocessingML part. */
function wordXmlText(xml) {
  const out = [];
  let para = null;          // the paragraph being read: { text, heading, list }
  const paras = [];         // paragraphs inside text boxes nest
  let inText = 0;
  let inRun = 0;
  let skip = 0;             // inside <mc:Fallback> (a second copy of a text box)
  let tables = 0;
  let row = null;
  let cellText = null;
  let firstRow = false;

  const emit = (line) => {
    if (cellText !== null) cellText += (cellText ? ' ' : '') + line;
    else out.push(line);
  };
  scanXml(xml, {
    tag(name, attrs, closing, self) {
      if (name === 'mc:Fallback') { if (!self) skip += closing ? -1 : 1; return; }
      if (skip > 0) return;
      switch (name) {
        case 'w:p':
          if (self) { if (cellText === null) out.push(''); return; }
          if (!closing) { if (para) paras.push(para); para = { text: '', heading: 0, list: false }; return; }
          if (para) {
            let t = para.text.replace(/[ \t]+$/g, '');
            if (t && para.heading) t = `${'#'.repeat(Math.min(6, para.heading))} ${t}`;
            else if (t && para.list) t = `- ${t}`;
            emit(t);
          }
          para = paras.pop() || null;
          return;
        case 'w:pStyle': {
          const v = attr(attrs, 'w:val') || '';
          const m = /^(?:heading|berschrift|titre|kop|titolo|encabezado)\s*(\d)$/i.exec(v);
          if (para && m) para.heading = Number(m[1]);
          else if (para && /^(title|titel|titre)$/i.test(v)) para.heading = 1;
          return;
        }
        case 'w:numPr': if (para && !closing) para.list = true; return;
        case 'w:r': if (!self) inRun += closing ? -1 : 1; return;
        case 'w:t': if (!self) inText += closing ? -1 : 1; return;
        case 'w:tab': if (inRun > 0 && para) para.text += '\t'; return;
        case 'w:br': case 'w:cr': if (inRun > 0 && para) para.text += '\n'; return;
        case 'w:noBreakHyphen': if (para) para.text += '-'; return;
        case 'w:tbl':
          tables += closing ? -1 : 1;
          if (!closing && tables === 1) firstRow = true;
          if (closing && tables === 0) out.push('');
          return;
        case 'w:tr':
          if (tables !== 1) return;
          if (!closing) { row = []; return; }
          if (row && row.length) {
            out.push(`| ${row.join(' | ')} |`);
            if (firstRow) { out.push(`|${' --- |'.repeat(row.length)}`); firstRow = false; }
          }
          row = null;
          return;
        case 'w:tc':
          if (tables !== 1) { if (closing && cellText !== null) cellText += ' /'; return; }
          if (!closing) { cellText = ''; return; }
          if (row) row.push(cell(cellText || ''));
          cellText = null;
          return;
        default:
      }
    },
    text(raw) {
      if (skip > 0 || inText <= 0 || !para) return;
      para.text += xmlText(raw);
    },
  });
  return tidy(out.join('\n'));
}

export async function docxText(zip) {
  const main = await mainPart(zip, 'word/document.xml');
  const xml = await zip.text(main);
  if (!xml) throw new Error('it has no document body (word/document.xml)');
  const parts = [wordXmlText(xml)];
  for (const [file, title] of [['word/footnotes.xml', 'Footnotes'], ['word/endnotes.xml', 'Endnotes']]) {
    const notes = zip.has(file) ? wordXmlText(await zip.text(file)) : '';
    if (notes) parts.push(`## ${title}\n\n${notes}`);
  }
  return { text: parts.filter(Boolean).join('\n\n') };
}

/* ---------------------------------------------------------------------------------------- Excel (.xlsx) */

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Does an Excel number format show a date or time? (Quoted text, [colors] and escapes do not count.) */
export function isDateFormat(code) {
  const s = String(code || '').replace(/"[^"]*"|\[[^\]]*\]|\\.|_.|\*./g, '');
  return /[dmyhs]/i.test(s) && !/^general$/i.test(s.trim());
}

/** An Excel serial date as ISO text (1900 system, with its leap-year bug; or 1904). */
export function excelDate(serial, date1904 = false) {
  let days = Math.floor(serial);
  const frac = serial - days;
  if (!date1904 && days < 61) days += 1;          // Excel counts 1900-02-29, which never was
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  const d = new Date(epoch + (days - (date1904 ? 0 : 1)) * 86400000 + Math.round(frac * 86400) * 1000);
  if (Number.isNaN(d.getTime())) return String(serial);
  const iso = d.toISOString();
  if (serial < 1 && !date1904) return iso.slice(11, 16);                 // a time of day
  return frac > 1e-9 ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/** Column letters (from a cell reference like "AB12") as a 0-based index. */
function columnIndex(ref) {
  const m = /^([A-Z]+)/i.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Text of a <si> / <is> element: its <t> runs, without phonetic hints (<rPh>). */
function richText(xml) {
  let out = '';
  let inT = 0;
  let rph = 0;
  scanXml(xml, {
    tag(name, attrs, closing, self) {
      if (self) return;
      if (name === 'rPh') rph += closing ? -1 : 1;
      else if (name === 't') inT += closing ? -1 : 1;
    },
    text(raw) { if (inT > 0 && rph <= 0) out += xmlText(raw); },
  });
  return out;
}

const csvCell = (v) => (/[",\n\r]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export async function xlsxText(zip) {
  const book = await mainPart(zip, 'xl/workbook.xml');
  const wb = await zip.text(book);
  if (!wb) throw new Error('it has no workbook (xl/workbook.xml)');
  const rels = await relationships(zip, book);
  const dir = book.slice(0, book.lastIndexOf('/') + 1);

  const sheets = [];
  let date1904 = false;
  scanXml(wb, {
    tag(name, attrs, closing) {
      if (closing) return;
      if (name === 'workbookPr' && /^(1|true)$/i.test(attr(attrs, 'date1904') || '')) date1904 = true;
      if (name === 'sheet') sheets.push({ name: attr(attrs, 'name') || `Sheet ${sheets.length + 1}`, rid: attr(attrs, 'r:id'), hidden: /hidden/i.test(attr(attrs, 'state') || '') });
    },
  });

  // Shared strings: <sst><si>…</si>…
  const shared = [];
  const sstPath = Object.values(rels).find((r) => /\/sharedStrings$/.test(r.type))?.target || `${dir}sharedStrings.xml`;
  const sst = await zip.text(sstPath);
  if (sst) for (const m of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] ? richText(m[1]) : '');

  // Which cell styles show dates: cellXfs order -> numFmtId -> built-in or custom date format.
  const dateStyles = new Set();
  const stylesPath = Object.values(rels).find((r) => /\/styles$/.test(r.type))?.target || `${dir}styles.xml`;
  const styles = await zip.text(stylesPath);
  if (styles) {
    const custom = new Map();
    for (const m of styles.matchAll(/<numFmt\b([^>]*)\/?>/g)) custom.set(Number(attr(m[1], 'numFmtId')), attr(m[1], 'formatCode'));
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] || '';
    let i = 0;
    for (const m of xfs.matchAll(/<xf\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/g)) {
      const id = Number(attr(m[1], 'numFmtId') || 0);
      if (BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)))) dateStyles.add(i);
      i++;
    }
  }

  const parts = [];
  for (const sheet of sheets) {
    const target = rels[sheet.rid]?.target;
    const xml = target ? await zip.text(target) : null;
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const values = [];
      for (const c of r[1].matchAll(/<c\b((?:[^>"']|"[^"]*"|'[^']*')*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const a = c[1];
        const body = c[2] || '';
        const type = attr(a, 't') || 'n';
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let text = '';
        if (type === 's') text = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') text = richText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] || '');
        else if (type === 'b') text = v === '1' ? 'TRUE' : v === '0' ? 'FALSE' : '';
        else if (v !== undefined) {
          text = xmlText(v);
          const n = Number(text);
          if (type === 'n' && Number.isFinite(n) && dateStyles.has(Number(attr(a, 's') || -1))) text = excelDate(n, date1904);
        }
        let col = columnIndex(attr(a, 'r'));
        if (col < 0) col = values.length;
        if (col > 16384) continue;
        while (values.length < col) values.push('');
        values[col] = text;
      }
      while (values.length && values[values.length - 1] === '') values.pop();
      rows.push(values.map(csvCell).join(','));
    }
    while (rows.length && rows[rows.length - 1] === '') rows.pop();
    parts.push(`## Sheet: ${sheet.name}${sheet.hidden ? ' (hidden)' : ''}\n\n${rows.join('\n') || '(empty)'}`);
  }
  if (!parts.length) throw new Error('it has no worksheets');
  return { text: parts.join('\n\n'), count: parts.length, unit: parts.length === 1 ? 'sheet' : 'sheets' };
}

/* ----------------------------------------------------------------------------------- PowerPoint (.pptx) */

/** Paragraphs of a DrawingML part (a slide, its notes). */
function drawingText(xml) {
  const lines = [];
  let p = null;
  let inT = 0;
  scanXml(xml, {
    tag(name, attrs, closing, self) {
      if (name === 'a:p') {
        if (self) return;
        if (!closing) p = '';
        else { if (p !== null && p.trim()) lines.push(p.trim()); p = null; }
      } else if (name === 'a:t' && !self) inT += closing ? -1 : 1;
      else if (name === 'a:br' && p !== null) p += '\n';
      else if (name === 'a:tab' && p !== null) p += '\t';
    },
    text(raw) { if (inT > 0 && p !== null) p += xmlText(raw); },
  });
  return lines.join('\n');
}

export async function pptxText(zip) {
  const pres = await mainPart(zip, 'ppt/presentation.xml');
  const xml = await zip.text(pres);
  const rels = await relationships(zip, pres);
  let slides = [];
  if (xml) for (const m of xml.matchAll(/<p:sldId\b([^>]*)\/?>/g)) { const r = rels[attr(m[1], 'r:id')]; if (r) slides.push(r.target); }
  if (!slides.length) {
    slides = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
      .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)[1]) - Number(/(\d+)\.xml$/i.exec(b)[1]));
  }
  if (!slides.length) throw new Error('it has no slides');
  const parts = [];
  for (let i = 0; i < slides.length; i++) {
    const body = drawingText((await zip.text(slides[i])) || '');
    const notesRel = Object.values(await relationships(zip, slides[i])).find((r) => /\/notesSlide$/.test(r.type));
    const notes = notesRel ? drawingText((await zip.text(notesRel.target)) || '').split('\n').filter((l) => !/^\d+$/.test(l.trim())).join('\n') : '';
    parts.push(`## Slide ${i + 1}\n\n${body || '(no text)'}${notes ? `\n\nSpeaker notes: ${notes}` : ''}`);
  }
  return { text: parts.join('\n\n'), count: slides.length, unit: slides.length === 1 ? 'slide' : 'slides' };
}

/* ------------------------------------------------------------------------- OpenDocument (.odt .ods .odp) */

/** `kind`: odt (text), ods (spreadsheet: one section per sheet) or odp (presentation: one per slide). */
export async function odfText(zip, kind = 'odt') {
  const xml = await zip.text('content.xml');
  if (!xml) throw new Error('it has no content.xml');
  const out = [];
  let para = null;
  const paras = [];
  let row = null;
  let cellText = null;
  let repeat = 1;
  let skip = 0;
  let lists = 0;
  let sheets = 0;
  let slides = 0;
  const emit = (line) => {
    if (cellText !== null) cellText += (cellText ? ' ' : '') + line;
    else out.push(line);
  };
  scanXml(xml, {
    tag(name, attrs, closing, self) {
      if (name === 'office:annotation' || name === 'text:note-citation') { if (!self) skip += closing ? -1 : 1; return; }
      if (skip > 0) return;
      switch (name) {
        case 'text:p': case 'text:h':
          if (self) { if (cellText === null) out.push(''); return; }
          if (!closing) {
            if (para) paras.push(para);
            const level = name === 'text:h' ? Number(attr(attrs, 'text:outline-level') || 1) : 0;
            para = { text: '', level, list: lists > 0 };
            return;
          }
          if (para) {
            const t = para.text.replace(/[ \t]+$/g, '');
            emit(t && para.level ? `${'#'.repeat(Math.min(6, para.level))} ${t}` : t && para.list && cellText === null ? `- ${t}` : t);
          }
          para = paras.pop() || null;
          return;
        case 'text:list': if (!self) lists += closing ? -1 : 1; return;
        case 'text:s': if (para) para.text += ' '.repeat(Math.min(80, Number(attr(attrs, 'text:c') || 1))); return;
        case 'text:tab': if (para) para.text += '\t'; return;
        case 'text:line-break': if (para) para.text += '\n'; return;
        case 'table:table':
          if (self) return;
          if (!closing && kind === 'ods') { sheets++; out.push('', `## Sheet: ${attr(attrs, 'table:name') || `Sheet ${sheets}`}`, ''); }
          out.push('');
          return;
        case 'draw:page':
          if (!closing && !self && kind === 'odp') {
            slides++;
            const n = attr(attrs, 'draw:name');
            out.push('', `## Slide ${slides}${n && !/^(page|slide)\s*\d+$/i.test(n) ? `: ${n}` : ''}`, '');
          }
          return;
        case 'table:table-row':
          if (!closing && !self) { row = []; return; }
          if (closing && row) {
            while (row.length && row[row.length - 1] === '') row.pop();
            if (row.length) out.push(`| ${row.join(' | ')} |`);
            row = null;
          }
          return;
        case 'table:table-cell': case 'table:covered-table-cell':
          if (self) { if (row) for (let i = Math.min(64, Number(attr(attrs, 'table:number-columns-repeated') || 1)); i > 0; i--) row.push(''); return; }
          if (!closing) { cellText = ''; repeat = Math.min(64, Number(attr(attrs, 'table:number-columns-repeated') || 1)); return; }
          if (row) for (let i = 0; i < repeat; i++) row.push(cell(cellText || ''));
          cellText = null;
          return;
        default:
      }
    },
    text(raw) { if (skip <= 0 && para) para.text += xmlText(raw); },
  });
  const count = kind === 'ods' ? sheets : kind === 'odp' ? slides : 0;
  const unit = kind === 'ods' ? (count === 1 ? 'sheet' : 'sheets') : count === 1 ? 'slide' : 'slides';
  return count ? { text: tidy(out.join('\n')), count, unit } : { text: tidy(out.join('\n')) };
}

/* ------------------------------------------------------------------------------------------------- RTF */

// Destinations whose content is not document text.
const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl', 'headerr',
  'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'fldinst', 'themedata', 'colorschememapping', 'latentstyles',
  'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'mmathPr', 'filetbl', 'revtbl',
  'pgdsctbl', 'bkmkstart', 'bkmkend', 'xe', 'tc', 'nonshppict', 'shpinst', 'sp', 'listtext', 'pntext', 'pntxta', 'pntxtb']);
const RTF_CHARS = { par: '\n', line: '\n', sect: '\n\n', page: '\n\n', tab: '\t', cell: ' | ', row: '\n', emdash: '—',
  endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ' };

// RTF font charsets -> Windows code pages.
const RTF_CHARSETS = { 0: 1252, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255,
  178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 77: 10000 };
const CODEPAGE_LABELS = { 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874', 10000: 'macintosh', 65001: 'utf-8' };
const decoders = new Map();

/** Bytes in a Windows code page as text (TextDecoder where the platform knows the code page, else Windows-1252). */
function decodeCodepage(bytes, cp) {
  if (cp === 1252 || !cp) return bytes.map(cp1252).join('');
  if (!decoders.has(cp)) {
    const label = CODEPAGE_LABELS[cp] || (cp >= 1250 && cp <= 1258 ? `windows-${cp}` : '');
    try { decoders.set(cp, label ? new TextDecoder(label) : null); } catch { decoders.set(cp, null); }
  }
  const d = decoders.get(cp);
  return d ? d.decode(Uint8Array.from(bytes)) : bytes.map(cp1252).join('');
}

/**
 * Text of an RTF document (given as a latin1 string of its bytes). \'hh bytes are decoded in the code page of the
 * current font (\fcharset) or of the document (\ansicpg), so Japanese, Chinese, Cyrillic\u2026 documents read correctly.
 */
export function rtfText(s) {
  if (!/^\s*\{\\rtf/.test(s)) throw new Error('it is not an RTF document');
  let out = '';
  let g = { skip: false, uc: 1, font: -1, fonttbl: false };
  const stack = [];
  let pending = 0;      // characters still to skip after a \u
  let docCp = 1252;
  let defFont = -1;     // the font being defined inside \fonttbl
  const fontCp = new Map();
  let bytes = [];       // consecutive \'hh bytes: one multi-byte character can span several
  const flush = () => {
    if (!bytes.length) return;
    const t = decodeCodepage(bytes, fontCp.get(g.font) ?? docCp);
    bytes = [];
    if (!g.skip) out += t;
  };
  const put = (t) => { flush(); if (!g.skip) out += t; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '{') { flush(); stack.push(g); g = { ...g }; pending = 0; continue; }
    if (c === '}') { flush(); g = stack.pop() || { skip: false, uc: 1, font: -1, fonttbl: false }; pending = 0; continue; }
    if (c === '\r' || c === '\n') continue;
    if (c !== '\\') {
      if (pending > 0) { pending--; continue; }
      put(c);
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) break;
    if (/[a-z]/i.test(n)) {
      const m = /^([a-z]+)(-?\d+)? ?/i.exec(s.slice(i + 1, i + 40));
      const word = m[1];
      const param = m[2] !== undefined ? Number(m[2]) : null;
      i += m[0].length;
      if (word === 'bin' && param > 0) { i += param; continue; }
      if (word === 'ansicpg' && param > 0) { docCp = param; continue; }
      if (word === 'fonttbl') { flush(); g.skip = true; g.fonttbl = true; continue; }
      if (word === 'f' && param !== null) { if (g.fonttbl) defFont = param; else { flush(); g.font = param; } continue; }
      if (word === 'fcharset' && param !== null && g.fonttbl && defFont >= 0) { if (RTF_CHARSETS[param]) fontCp.set(defFont, RTF_CHARSETS[param]); continue; }
      if (word === 'cpg' && param > 0 && g.fonttbl && defFont >= 0) { fontCp.set(defFont, param); continue; }
      if (RTF_SKIP.has(word)) { flush(); g.skip = true; continue; }
      if (word === 'uc' && param !== null) { g.uc = param; continue; }
      if (word === 'u' && param !== null) { put(String.fromCharCode(param < 0 ? param + 65536 : param)); pending = g.uc; continue; }
      if (RTF_CHARS[word]) put(RTF_CHARS[word]);
      continue;
    }
    i++;
    if (n === "'") {
      const code = parseInt(s.substr(i + 1, 2), 16);
      i += 2;
      if (pending > 0) { pending--; continue; }
      if (Number.isFinite(code)) bytes.push(code);
    } else if (n === '*') { flush(); g.skip = true; }
    else if (n === '~') put('\u00a0');
    else if (n === '_') put('-');
    else if (n === '\\' || n === '{' || n === '}') put(n);
    else if (n === '\r' || n === '\n') put('\n');
  }
  flush();
  return { text: tidy(out.replace(/\u00a0/g, ' ')) };
}

/** Which reader an office file needs, and run it. `kind`: docx | xlsx | pptx | odt | ods | odp. */
export async function officeText(kind, bytes) {
  const zip = readZip(bytes);
  if (kind === 'docx') return docxText(zip);
  if (kind === 'xlsx') return xlsxText(zip);
  if (kind === 'pptx') return pptxText(zip);
  return odfText(zip, kind);
}
