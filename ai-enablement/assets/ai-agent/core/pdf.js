// Text from PDF files, for the agent. No dependencies and no worker: the file's objects are found by scanning, the
// page tree is walked, and each page's content streams are run just far enough to know where text is drawn and what
// it says. That covers the PDFs people usually attach (exported from Word, browsers, LaTeX, reporting tools); it does
// not cover scanned pages (no text layer: attach them as images instead) or encrypted files.
//
// Text decoding follows the font: its ToUnicode map first, then its encoding (WinAnsi, MacRoman, Differences with
// glyph names). Line breaks and spaces come from where the text is placed (font widths, text and graphics matrices).
//
//   pdfText(bytes, { maxChars }) -> { text, count: pages, unit: 'pages', missing: characters that could not be decoded }

import { inflate, latin1, cp1252 } from './bytes.js';

const LIMITS = Object.freeze({ pages: 3000, formDepth: 8, chars: 2000000 });
const IDENTITY = [1, 0, 0, 1, 0, 0];

/* -------------------------------------------------------------------------------------------- syntax */

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

/**
 * Reads PDF values from a latin1 string: numbers, names ('/Name'), strings ({ s: bytes as latin1 }), arrays, dicts
 * (null-prototype objects keyed without the slash), references ({ r, g }), booleans, null, and operators ({ op }).
 */
class Lexer {
  constructor(s, i = 0, refs = true) { this.s = s; this.i = i; this.refs = refs; }

  skip() {
    const s = this.s;
    for (;;) {
      const c = s.charCodeAt(this.i);
      if (isWs(c)) this.i++;
      else if (c === 37) { while (this.i < s.length && s[this.i] !== '\n' && s[this.i] !== '\r') this.i++; }
      else return;
    }
  }

  word() {
    const s = this.s;
    const start = this.i;
    while (this.i < s.length) {
      const c = s.charCodeAt(this.i);
      if (isWs(c) || isDelim(c)) break;
      this.i++;
    }
    return s.slice(start, this.i);
  }

  /** The next value, or undefined at the end. */
  value() {
    this.skip();
    const s = this.s;
    if (this.i >= s.length) return undefined;
    const c = s[this.i];
    if (c === '/') {
      this.i++;
      return `/${this.word().replace(/#([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))}`;
    }
    if (c === '(') return { s: this.literal() };
    if (c === '<') {
      if (s[this.i + 1] === '<') return this.dict();
      const end = s.indexOf('>', this.i);
      const hex = s.slice(this.i + 1, end < 0 ? s.length : end).replace(/[^0-9a-f]/gi, '');
      this.i = end < 0 ? s.length : end + 1;
      let out = '';
      for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt(hex.substr(k, 2).padEnd(2, '0'), 16));
      return { s: out };
    }
    if (c === '[') {
      this.i++;
      const arr = [];
      for (;;) {
        this.skip();
        if (this.i >= s.length) return arr;
        if (s[this.i] === ']') { this.i++; return arr; }
        const v = this.value();
        if (v === undefined) return arr;
        arr.push(v);
      }
    }
    if (c === '>' || c === ']' || c === ')' || c === '{' || c === '}') { this.i++; return { op: c }; }
    const w = this.word();
    if (!w) { this.i++; return { op: c }; }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = Number(w);
      if (this.refs && /^\d+$/.test(w)) {
        // "12 0 R" is a reference.
        const save = this.i;
        this.skip();
        const g = this.word();
        if (/^\d+$/.test(g)) {
          this.skip();
          if (s[this.i] === 'R' && (this.i + 1 >= s.length || isWs(s.charCodeAt(this.i + 1)) || isDelim(s.charCodeAt(this.i + 1)))) {
            this.i++;
            return { r: n, g: Number(g) };
          }
        }
        this.i = save;
      }
      return n;
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return { op: w };
  }

  literal() {
    const s = this.s;
    let i = this.i + 1;
    let depth = 1;
    let out = '';
    while (i < s.length) {
      const c = s[i++];
      if (c === '\\') {
        const n = s[i++];
        if (n === 'n') out += '\n';
        else if (n === 'r') out += '\r';
        else if (n === 't') out += '\t';
        else if (n === 'b') out += '\b';
        else if (n === 'f') out += '\f';
        else if (n === '\r') { if (s[i] === '\n') i++; }
        else if (n === '\n') { /* line continuation */ }
        else if (n >= '0' && n <= '7') {
          let oct = n;
          while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') oct += s[i++];
          out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        } else if (n !== undefined) out += n;
      } else if (c === '(') { depth++; out += c; }
      else if (c === ')') { if (--depth === 0) break; out += c; }
      else out += c;
    }
    this.i = i;
    return out;
  }

  dict() {
    const s = this.s;
    this.i += 2;
    const d = Object.create(null);
    for (;;) {
      this.skip();
      if (this.i >= s.length) return d;
      if (s[this.i] === '>' && s[this.i + 1] === '>') { this.i += 2; return d; }
      const key = this.value();
      if (key === undefined) return d;
      if (typeof key !== 'string' || key[0] !== '/') continue;
      const v = this.value();
      if (v && v.op === '>') return d;
      d[key.slice(1)] = v;
    }
  }
}

/* ----------------------------------------------------------------------------------------- filters */

function ascii85(bytes) {
  const s = latin1(bytes).replace(/\s+/g, '').replace(/^<~/, '');
  const end = s.indexOf('~>');
  const t = end >= 0 ? s.slice(0, end) : s;
  const out = [];
  let group = [];
  const flush = (n) => {
    let v = 0;
    for (let k = 0; k < 5; k++) v = v * 85 + ((group[k] ?? 84));
    for (let k = 0; k < n; k++) out.push((v >>> (24 - 8 * k)) & 0xff);
    group = [];
  };
  for (const ch of t) {
    if (ch === 'z' && !group.length) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33;
    if (c < 0 || c > 84) continue;
    group.push(c);
    if (group.length === 5) flush(4);
  }
  if (group.length > 1) flush(group.length - 1);
  return Uint8Array.from(out);
}

function asciiHex(bytes) {
  const s = latin1(bytes);
  const end = s.indexOf('>');
  const hex = (end >= 0 ? s.slice(0, end) : s).replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let k = 0; k < hex.length; k += 2) out[k / 2] = parseInt(hex.substr(k, 2).padEnd(2, '0'), 16);
  return out;
}

/** PNG predictors (DecodeParms /Predictor 10–15), used by object and cross-reference streams. */
function unpredict(data, parms) {
  const colors = Number(parms?.Colors) || 1;
  const bpc = Number(parms?.BitsPerComponent) || 8;
  const columns = Number(parms?.Columns) || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const cur = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let x = 0; x < rowLen; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = v & 0xff;
    }
    prev = row;
  }
  return out;
}

/* -------------------------------------------------------------------------------------- encodings */

const MAC_ROMAN = (() => { try { return new TextDecoder('macintosh'); } catch { return null; } })();

// Glyph names that are not a single letter or digit (a subset of the Adobe Glyph List: what text fonts use).
const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  quoteright: '’', parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', minus: '−',
  period: '.', slash: '/', colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@',
  bracketleft: '[', backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', quoteleft: '‘',
  braceleft: '{', bar: '|', braceright: '}', asciitilde: '~', zero: '0', one: '1', two: '2', three: '3', four: '4',
  five: '5', six: '6', seven: '7', eight: '8', nine: '9', quotedblleft: '“', quotedblright: '”',
  quotesinglbase: '‚', quotedblbase: '„', endash: '–', emdash: '—', bullet: '•', ellipsis: '…',
  fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', dagger: '†', daggerdbl: '‡', trademark: '™',
  copyright: '©', registered: '®', degree: '°', section: '§', paragraph: '¶',
  periodcentered: '·', multiply: '×', divide: '÷', plusminus: '±', Euro: '€', euro: '€',
  sterling: '£', yen: '¥', cent: '¢', currency: '¤', germandbls: 'ß', ae: 'æ', AE: 'Æ',
  oe: 'œ', OE: 'Œ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', Eth: 'Ð', thorn: 'þ',
  Thorn: 'Þ', dotlessi: 'ı', lslash: 'ł', Lslash: 'Ł', exclamdown: '¡', questiondown: '¿',
  guillemotleft: '«', guillemotright: '»', guilsinglleft: '‹', guilsinglright: '›', perthousand: '‰',
  ordfeminine: 'ª', ordmasculine: 'º', onehalf: '½', onequarter: '¼', threequarters: '¾',
  mu: 'µ', logicalnot: '¬', brokenbar: '¦', dieresis: '¨', macron: '¯', acute: '´',
  cedilla: '¸', florin: 'ƒ', nbspace: '\u00a0', nonbreakingspace: '\u00a0', sfthyphen: '\u00ad', arrowright: '→',
  arrowleft: '←', checkmark: '✓', infinity: '∞', notequal: '≠', lessequal: '≤', greaterequal: '≥',
};
const MARKS = { acute: '\u0301', grave: '\u0300', circumflex: '\u0302', tilde: '\u0303', dieresis: '\u0308', ring: '\u030a',
  cedilla: '\u0327', caron: '\u030c', macron: '\u0304', breve: '\u0306', ogonek: '\u0328', dotaccent: '\u0307', hungarumlaut: '\u030b', commaaccent: '\u0326' };

/** Unicode text for a glyph name: AGL names, uniXXXX / uXXXX, accented letters, ligatures (f_f_i), suffixes (.sc). */
export function glyphText(name) {
  const n = String(name || '').replace(/^\//, '').split('.')[0];
  if (!n) return '';
  if (n.includes('_')) return n.split('_').map(glyphText).join('');
  if (GLYPHS[n] !== undefined) return GLYPHS[n];
  if (/^[A-Za-z]$/.test(n)) return n;
  let m = /^uni([0-9A-F]{4})+$/i.exec(n);
  if (m) return n.slice(3).match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-F]{4,6})$/i.exec(n);
  if (m) { const cp = parseInt(m[1], 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
  m = /^([A-Za-z])(acute|grave|circumflex|tilde|dieresis|ring|cedilla|caron|macron|breve|ogonek|dotaccent|hungarumlaut|commaaccent)$/.exec(n);
  if (m) return (m[1] + MARKS[m[2]]).normalize('NFC');
  return '';
}

/** A simple font's 256 codes as text: its base encoding with its Differences applied. */
function simpleEncoding(enc) {
  const base = typeof enc === 'string' ? enc : enc?.BaseEncoding;
  const table = [];
  for (let b = 0; b < 256; b++) {
    if (base === '/MacRomanEncoding' && b >= 128 && MAC_ROMAN) table.push(MAC_ROMAN.decode(new Uint8Array([b])));
    else table.push(b < 32 ? '' : b === 127 ? '' : cp1252(b));
  }
  if (enc && typeof enc === 'object' && Array.isArray(enc.Differences)) {
    let code = 0;
    for (const d of enc.Differences) {
      if (typeof d === 'number') code = d;
      else if (typeof d === 'string' && code < 256) table[code++] = glyphText(d);
    }
  }
  return table;
}

/** A ToUnicode CMap: { map: code -> text, ranges: codespace ranges [{ len, lo: [bytes], hi: [bytes] }] }. */
export function parseCMap(text) {
  const lex = new Lexer(text, 0, false);
  const map = new Map();
  const ranges = [];
  const bytesOf = (v) => (v && typeof v.s === 'string' ? [...v.s].map((ch) => ch.charCodeAt(0)) : null);
  const codeOf = (b) => b.reduce((n, x) => n * 256 + x, 0);
  const unicode = (v) => {
    if (typeof v === 'string') return glyphText(v);
    const b = bytesOf(v);
    if (!b) return '';
    if (b.length === 1) return String.fromCharCode(b[0]);
    let out = '';
    for (let k = 0; k + 1 < b.length; k += 2) out += String.fromCharCode((b[k] << 8) | b[k + 1]);
    return out;
  };
  let ops = [];
  let budget = 200000;
  for (let v = lex.value(); v !== undefined; v = lex.value()) {
    if (!v || !v.op) { ops.push(v); continue; }
    if (v.op === 'endcodespacerange') {
      for (let k = 0; k + 1 < ops.length; k += 2) {
        const lo = bytesOf(ops[k]);
        const hi = bytesOf(ops[k + 1]);
        if (lo && hi && lo.length === hi.length && lo.length <= 4) ranges.push({ len: lo.length, lo, hi });
      }
    } else if (v.op === 'endbfchar') {
      for (let k = 0; k + 1 < ops.length; k += 2) {
        const src = bytesOf(ops[k]);
        if (src) map.set(codeOf(src), unicode(ops[k + 1]));
      }
    } else if (v.op === 'endbfrange') {
      for (let k = 0; k + 2 < ops.length; k += 3) {
        const lo = bytesOf(ops[k]);
        const hi = bytesOf(ops[k + 1]);
        if (!lo || !hi) continue;
        const a = codeOf(lo);
        const b = Math.min(codeOf(hi), a + 65535);
        const dst = ops[k + 2];
        if (Array.isArray(dst)) {
          for (let c = a; c <= b && budget > 0; c++, budget--) map.set(c, unicode(dst[c - a]));
        } else {
          const base = unicode(dst);
          if (!base) continue;
          const head = base.slice(0, -1);
          const last = base.charCodeAt(base.length - 1);
          for (let c = a; c <= b && budget > 0; c++, budget--) map.set(c, head + String.fromCharCode(last + (c - a)));
        }
      }
    }
    ops = [];
  }
  return { map, ranges };
}

/* ------------------------------------------------------------------------------------------ matrices */

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const nums = (a, n) => (Array.isArray(a) && a.length >= n && a.slice(0, n).every((x) => typeof x === 'number') ? a.slice(0, n) : null);

/* -------------------------------------------------------------------------------------------- document */

class PdfDocument {
  constructor(bytes) {
    this.bytes = bytes;
    this.s = latin1(bytes);
    this.offsets = new Map();   // object number -> where its value starts
    this.packed = new Map();    // object number -> value (from object streams)
    this.cache = new Map();
    this.decoded = new Map();
    this.fonts = new Map();
    this.missing = 0;
    for (const m of this.s.matchAll(/(\d+)\s+(\d+)\s+obj\b/g)) this.offsets.set(Number(m[1]), m.index + m[0].length);
  }

  get encrypted() { return /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(this.s); }

  /** An indirect object: its value, or { stream: true, dict, start, end } for a stream. */
  object(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    let value = null;
    const at = this.offsets.get(num);
    if (at !== undefined) {
      this.cache.set(num, null);        // a reference cycle reads as null
      const lex = new Lexer(this.s, at);
      value = lex.value();
      lex.skip();
      if (value && typeof value === 'object' && !Array.isArray(value) && this.s.startsWith('stream', lex.i)) {
        let start = lex.i + 6;
        if (this.s[start] === '\r') start++;
        if (this.s[start] === '\n') start++;
        let end = -1;
        const len = this.resolve(value.Length);
        if (typeof len === 'number' && len >= 0 && /^\s*endstream/.test(this.s.slice(start + len, start + len + 32))) end = start + len;
        else {
          end = this.s.indexOf('endstream', start);
          if (end < 0) end = this.s.length;
          while (end > start && (this.s[end - 1] === '\n' || this.s[end - 1] === '\r')) end--;
        }
        value = { stream: true, dict: value, start, end };
      }
    } else if (this.packed.has(num)) {
      value = this.packed.get(num);
    }
    this.cache.set(num, value ?? null);
    return value ?? null;
  }

  resolve(v, depth = 0) {
    let x = v;
    for (let d = depth; x && typeof x === 'object' && typeof x.r === 'number' && d < 32; d++) x = this.object(x.r);
    return x;
  }

  dictOf(v) {
    const x = this.resolve(v);
    if (x && x.stream) return x.dict;
    return x && typeof x === 'object' && !Array.isArray(x) && !x.op && x.s === undefined ? x : null;
  }

  /** The decoded data of a stream object (a reference or the object itself). */
  async data(ref) {
    const key = typeof ref?.r === 'number' ? ref.r : null;
    if (key !== null && this.decoded.has(key)) return this.decoded.get(key);
    const obj = this.resolve(ref);
    if (!obj || !obj.stream) return null;
    let out = this.bytes.subarray(obj.start, obj.end);
    const filters = [this.resolve(obj.dict.Filter)].flat().filter(Boolean).map((f) => this.resolve(f));
    const parms = [this.resolve(obj.dict.DecodeParms)].flat().map((p) => this.dictOf(p));
    for (let k = 0; k < filters.length; k++) {
      const f = filters[k];
      if (f === '/FlateDecode' || f === '/Fl') {
        try { out = await inflate(out, 'deflate'); } catch { out = await inflate(out.subarray(2), 'deflate-raw'); }
        if (parms[k] && Number(parms[k].Predictor) >= 10) out = unpredict(out, parms[k]);
      } else if (f === '/ASCIIHexDecode' || f === '/AHx') out = asciiHex(out);
      else if (f === '/ASCII85Decode' || f === '/A85') out = ascii85(out);
      else throw new Error(`unsupported filter ${f}`);
    }
    if (key !== null) this.decoded.set(key, out);
    return out;
  }

  /** Objects packed in object streams (PDF 1.5+): fonts, pages and resources often live there. */
  async unpack() {
    for (const [num, at] of this.offsets) {
      if (!/\/ObjStm\b/.test(this.s.slice(at, at + 400))) continue;
      const obj = this.object(num);
      if (!obj?.stream || obj.dict.Type !== '/ObjStm') continue;
      let data;
      try { data = latin1(await this.data({ r: num, g: 0 })); } catch { continue; }
      const n = Number(obj.dict.N) || 0;
      const first = Number(obj.dict.First) || 0;
      const head = new Lexer(data.slice(0, first), 0, false);
      for (let k = 0; k < n; k++) {
        const id = head.value();
        const off = head.value();
        if (typeof id !== 'number' || typeof off !== 'number') break;
        if (!this.offsets.has(id) && !this.packed.has(id)) this.packed.set(id, new Lexer(data, first + off).value() ?? null);
      }
    }
    this.cache.clear();     // lookups made before the packed objects were known
  }

  /** The pages in order, each with the resources it inherits. */
  pages() {
    const out = [];
    const seen = new Set();
    const walk = (ref, resources, depth) => {
      if (depth > 64 || out.length >= LIMITS.pages) return;
      if (typeof ref?.r === 'number') { if (seen.has(ref.r)) return; seen.add(ref.r); }
      const node = this.dictOf(ref);
      if (!node) return;
      const res = node.Resources !== undefined ? this.dictOf(node.Resources) : resources;
      const kids = this.resolve(node.Kids);
      if (node.Type !== '/Page' && Array.isArray(kids)) { for (const k of kids) walk(k, res, depth + 1); return; }
      if (node.Type === '/Page' || node.Contents !== undefined) out.push({ node, resources: res });
    };
    const rootRef = [...this.s.matchAll(/\/Root\s+(\d+)\s+(\d+)\s+R/g)].pop();
    const root = rootRef ? this.dictOf({ r: Number(rootRef[1]), g: 0 }) : null;
    if (root?.Pages) walk(root.Pages, null, 0);
    if (!out.length) {
      // No usable page tree: every page object, in file order.
      for (const num of [...this.offsets.keys(), ...this.packed.keys()]) {
        const d = this.dictOf({ r: num, g: 0 });
        if (d?.Type === '/Page') out.push({ node: d, resources: this.dictOf(d.Resources) });
      }
    }
    return out;
  }

  async font(ref) {
    const key = typeof ref?.r === 'number' ? ref.r : ref;
    if (this.fonts.has(key)) return this.fonts.get(key);
    const d = this.dictOf(ref) || Object.create(null);
    const type0 = d.Subtype === '/Type0';
    const font = { type0, map: null, ranges: [], table: null, widths: new Map(), dw: type0 ? 1000 : 0, scale: 0.001 };
    if (d.ToUnicode) {
      try { Object.assign(font, parseCMap(latin1((await this.data(d.ToUnicode)) || new Uint8Array()))); } catch { /* no map: the encoding is used */ }
    }
    if (type0) {
      const desc = this.dictOf((this.resolve(d.DescendantFonts) || [])[0]);
      if (desc) {
        if (typeof desc.DW === 'number') font.dw = desc.DW;
        const w = this.resolve(desc.W);
        for (let k = 0; Array.isArray(w) && k < w.length;) {
          const first = w[k];
          const next = this.resolve(w[k + 1]);
          if (Array.isArray(next)) { next.forEach((x, j) => font.widths.set(first + j, Number(x) || 0)); k += 2; }
          else { for (let c = first; c <= next && c - first < 65536; c++) font.widths.set(c, Number(w[k + 2]) || 0); k += 3; }
        }
      }
    } else {
      const enc = this.resolve(d.Encoding);
      const encDict = typeof enc === 'string' ? null : this.dictOf(enc);
      font.table = simpleEncoding(encDict ? { BaseEncoding: this.resolve(encDict.BaseEncoding), Differences: this.resolve(encDict.Differences) } : enc);
      const widths = this.resolve(d.Widths);
      const firstChar = Number(d.FirstChar) || 0;
      if (Array.isArray(widths)) widths.forEach((x, j) => font.widths.set(firstChar + j, Number(this.resolve(x)) || 0));
      const missingWidth = Number(this.dictOf(d.FontDescriptor)?.MissingWidth);
      font.dw = Number.isFinite(missingWidth) && missingWidth > 0 ? missingWidth : Array.isArray(widths) ? 0 : 500;
      if (d.Subtype === '/Type3') font.scale = Number(nums(this.resolve(d.FontMatrix), 1)?.[0]) || 0.001;
    }
    this.fonts.set(key, font);
    return font;
  }

  /** The codes of a shown string: [{ code, len, text }]. */
  codes(font, str) {
    const out = [];
    for (let i = 0; i < str.length;) {
      let len = font.type0 ? 2 : 1;
      if (font.ranges.length) {
        const r = font.ranges.find((x) => i + x.len <= str.length && x.lo.every((lo, k) => { const b = str.charCodeAt(i + k); return b >= lo && b <= x.hi[k]; }));
        len = r ? r.len : font.ranges[0].len;
      }
      let code = 0;
      for (let k = 0; k < len && i + k < str.length; k++) code = code * 256 + str.charCodeAt(i + k);
      let text = font.map?.get(code);
      if (text === undefined) text = !font.type0 && len === 1 ? (font.table?.[code] ?? '') : '';
      if (!text && code !== 32 && !(font.type0 && code === 3)) this.missing++;
      out.push({ code, len, text });
      i += len;
    }
    return out;
  }
}

/* ------------------------------------------------------------------------------------- content streams */

/** Where text lands, collected as lines: a new line when the baseline moves, a space when there is a gap. */
class TextSink {
  constructor() { this.parts = []; this.last = null; }

  add(text, x, y, xEnd, size) {
    if (!text) return;
    if (this.last) {
      const dy = Math.abs(y - this.last.y);
      const h = Math.max(1e-6, Math.min(size, this.last.size) || size || 1);
      if (dy > h * 0.55) this.parts.push('\n');
      else {
        const gap = x - this.last.xEnd;
        const prev = this.parts[this.parts.length - 1] || '';
        if ((gap > h * 0.18 || gap < -h * 2) && !/\s$/.test(prev) && !/^\s/.test(text)) this.parts.push(' ');
      }
    }
    this.parts.push(text);
    this.last = { y, xEnd, size };
  }

  text() {
    return this.parts.join('').split('\n').map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}

async function runContent(doc, data, resources, ctm0, sink, depth) {
  const lex = new Lexer(data, 0, false);
  let g = { ctm: ctm0, font: null, fs: 0, cs: 0, ws: 0, th: 1, tl: 0, rise: 0 };
  const stack = [];
  let tm = IDENTITY;
  let tlm = IDENTITY;
  let ops = [];
  const fontsDict = () => doc.dictOf(resources?.Font);
  const td = (tx, ty) => { tlm = mul([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };
  const show = (str) => {
    if (!g.font || typeof str !== 'string') return;
    const trm = mul([g.fs * g.th, 0, 0, g.fs, 0, g.rise], mul(tm, g.ctm));
    const size = Math.hypot(trm[2], trm[3]) || Math.abs(g.fs) || 1;
    let text = '';
    for (const c of doc.codes(g.font, str)) {
      text += c.text;
      const w = g.font.widths.has(c.code) ? g.font.widths.get(c.code) : g.font.dw;
      const tx = (w * g.font.scale * g.fs + g.cs + (c.len === 1 && c.code === 32 ? g.ws : 0)) * g.th;
      tm = mul([1, 0, 0, 1, tx, 0], tm);
    }
    const end = mul([g.fs * g.th, 0, 0, g.fs, 0, g.rise], mul(tm, g.ctm));
    sink.add(text, trm[4], trm[5], end[4], size);
  };

  for (let v = lex.value(); v !== undefined; v = lex.value()) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !v.op) { ops.push(v); continue; }
    const a = ops;
    ops = [];
    switch (v.op) {
      case 'q': stack.push(g); g = { ...g }; break;
      case 'Q': g = stack.pop() || g; break;
      case 'cm': { const m = nums(a, 6); if (m) g.ctm = mul(m, g.ctm); break; }
      case 'BT': tm = IDENTITY; tlm = IDENTITY; break;
      case 'Tf': {
        const ref = fontsDict()?.[String(a[0] || '').slice(1)];
        g.font = ref ? await doc.font(ref) : null;
        g.fs = typeof a[1] === 'number' ? a[1] : g.fs;
        break;
      }
      case 'Tc': if (typeof a[0] === 'number') g.cs = a[0]; break;
      case 'Tw': if (typeof a[0] === 'number') g.ws = a[0]; break;
      case 'Tz': if (typeof a[0] === 'number') g.th = a[0] / 100; break;
      case 'TL': if (typeof a[0] === 'number') g.tl = a[0]; break;
      case 'Ts': if (typeof a[0] === 'number') g.rise = a[0]; break;
      case 'Td': if (nums(a, 2)) td(a[0], a[1]); break;
      case 'TD': if (nums(a, 2)) { g.tl = -a[1]; td(a[0], a[1]); } break;
      case 'Tm': { const m = nums(a, 6); if (m) { tm = m; tlm = m; } break; }
      case 'T*': td(0, -g.tl); break;
      case 'Tj': show(a[0]?.s); break;
      case "'": td(0, -g.tl); show(a[0]?.s); break;
      case '"': if (typeof a[0] === 'number') g.ws = a[0]; if (typeof a[1] === 'number') g.cs = a[1]; td(0, -g.tl); show(a[2]?.s); break;
      case 'TJ':
        for (const el of Array.isArray(a[0]) ? a[0] : []) {
          if (typeof el === 'number') tm = mul([1, 0, 0, 1, (-el / 1000) * g.fs * g.th, 0], tm);
          else show(el?.s);
        }
        break;
      case 'Do': {
        if (depth >= LIMITS.formDepth) break;
        const ref = doc.dictOf(resources?.XObject)?.[String(a[0] || '').slice(1)];
        const xo = doc.resolve(ref);
        if (!xo?.stream || xo.dict.Subtype !== '/Form') break;
        let body;
        try { body = await doc.data(ref); } catch { break; }
        if (!body) break;
        const m = nums(doc.resolve(xo.dict.Matrix), 6) || IDENTITY;
        await runContent(doc, latin1(body), doc.dictOf(xo.dict.Resources) || resources, mul(m, g.ctm), sink, depth + 1);
        break;
      }
      case 'BI': {
        // An inline image: skip its data, which runs from "ID" to "EI".
        const id = data.indexOf('ID', lex.i);
        const end = id < 0 ? -1 : data.slice(id + 3).search(/\sEI(\s|$)/);
        lex.i = end < 0 ? data.length : id + 3 + end + 3;
        break;
      }
      default:
    }
  }
}

/**
 * The text of a PDF file.
 * @param {Uint8Array} bytes
 * @returns {Promise<{ text: string, count: number, unit: string, missing: number }>}
 */
export async function pdfText(bytes) {
  const head = latin1(bytes.subarray(0, 1024));
  if (!head.includes('%PDF-')) throw new Error('it is not a PDF file');
  const doc = new PdfDocument(bytes);
  if (doc.encrypted) throw Object.assign(new Error('it is encrypted (password-protected or with copy restrictions), so its text cannot be read here'), { reason: 'encrypted' });
  await doc.unpack();
  const pages = doc.pages();
  if (!pages.length) throw new Error('no pages were found in it (the file may be damaged)');
  const out = [];
  let chars = 0;
  for (let p = 0; p < pages.length && chars < LIMITS.chars; p++) {
    const { node, resources } = pages[p];
    const sink = new TextSink();
    for (const ref of [doc.resolve(node.Contents)].flat().filter(Boolean)) {
      let data;
      try { data = await doc.data(ref); } catch { continue; }
      if (data) await runContent(doc, latin1(data), resources, IDENTITY, sink, 0);
    }
    const text = sink.text();
    chars += text.length;
    out.push(pages.length > 1 ? `--- Page ${p + 1} ---\n${text}` : text);
  }
  const text = out.join('\n\n').trim();
  return { text, count: pages.length, unit: pages.length === 1 ? 'page' : 'pages', missing: doc.missing };
}

