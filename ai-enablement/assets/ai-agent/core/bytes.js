// Byte-level helpers for the files a user attaches: text decoding, DEFLATE (PDF streams, ZIP entries) with the
// platform's own DecompressionStream, and a small ZIP reader (the container of .docx, .xlsx, .pptx and OpenDocument
// files). No DOM, no dependencies: runs in browsers and in Node 18+ ('deflate-raw' needs Node 21.2+).

export const LIMITS = Object.freeze({ inflatedBytes: 64 * 1024 * 1024, zipEntries: 20000 });

/** Bytes as a string of char codes 0–255 (how PDF and RTF syntax is read). */
export function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

/** A latin1 string back to bytes. */
export function toBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// Windows-1252 0x80–0x9F (the rest is Latin-1). PDF's WinAnsiEncoding and RTF's default code page.
const CP1252 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

/** One Windows-1252 byte as text. */
export const cp1252 = (b) => (b >= 0x80 && b < 0xa0 ? CP1252[b - 0x80] : String.fromCharCode(b));

/** Windows-1252 bytes as text. */
export function decodeCp1252(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += cp1252(bytes[i]);
  return s;
}

/**
 * Text from bytes: a byte-order mark decides (UTF-8, UTF-16 LE/BE); otherwise UTF-8 when the bytes are valid UTF-8,
 * else Windows-1252 (older Windows text files).
 */
export function decodeText(bytes) {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeCp1252(bytes);
  }
}

/** True when the start of the bytes is not text: NUL bytes or many control characters (UTF-16 with a BOM is text). */
export function looksBinary(bytes) {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return false;
  const n = Math.min(bytes.length, 8192);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return true;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 && b !== 12 && b !== 27) odd++;
  }
  return odd > n * 0.05;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/**
 * Inflate DEFLATE data: 'deflate' (zlib: PDF FlateDecode) or 'deflate-raw' (ZIP). Data that stops early or has junk
 * after its end gives what was read before that (real PDFs often do); nothing readable is an error. More than
 * `maxBytes` of output is an error too (an archive bomb).
 */
export async function inflate(bytes, format = 'deflate', { maxBytes = LIMITS.inflatedBytes } = {}) {
  if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot unpack compressed data');
  const ds = new DecompressionStream(format);
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw Object.assign(new Error(`it unpacks to more than ${Math.round(maxBytes / 1024 / 1024)} MB`), { tooLarge: true });
      }
    }
  } catch (e) {
    if (e?.tooLarge || !total) throw e?.tooLarge ? e : new Error(`compressed data could not be read (${e?.message || e})`);
  }
  return concat(chunks, total);
}

/**
 * Open a ZIP archive. Entries are read on demand: `text(name)` / `bytes(name)` (names are matched without regard to
 * case, as Office files require). Stored and deflated entries; ZIP64 sizes; no encryption.
 */
export function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => dv.getUint16(p, true);
  const u32 = (p) => dv.getUint32(p, true);
  const u64 = (p) => Number(dv.getBigUint64(p, true));
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('it is not a ZIP archive');
  let count = u16(eocd + 10);
  let offset = u32(eocd + 16);
  if ((count === 0xffff || offset === 0xffffffff) && eocd >= 20 && u32(eocd - 20) === 0x07064b50) {
    const z = u64(eocd - 12);
    if (z + 56 <= bytes.length && u32(z) === 0x06064b50) { count = u64(z + 32); offset = u64(z + 48); }
  }
  const entries = new Map();
  let p = offset;
  for (let n = 0; n < Math.min(count, LIMITS.zipEntries) && p + 46 <= bytes.length; n++) {
    if (u32(p) !== 0x02014b50) break;
    const flags = u16(p + 8);
    const method = u16(p + 10);
    let csize = u32(p + 20);
    let usize = u32(p + 24);
    const nameLen = u16(p + 28);
    const extraLen = u16(p + 30);
    const commentLen = u16(p + 32);
    let local = u32(p + 42);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));
    // ZIP64: the sizes and offset that do not fit 32 bits are in extra field 0x0001, in this order.
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
      const id = u16(e);
      const size = u16(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = u64(q); q += 8; }
        if (csize === 0xffffffff) { csize = u64(q); q += 8; }
        if (local === 0xffffffff) local = u64(q);
      }
      e += 4 + size;
    }
    entries.set(name.toLowerCase(), { name, method, csize, usize, local, encrypted: !!(flags & 1) });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const find = (name) => entries.get(String(name).replace(/^\/+/, '').toLowerCase()) || null;
  async function entryBytes(name) {
    const e = find(name);
    if (!e) return null;
    if (e.encrypted) throw new Error('it is encrypted (password-protected)');
    if (u32(e.local) !== 0x04034b50) throw new Error('the archive is damaged');
    const start = e.local + 30 + u16(e.local + 26) + u16(e.local + 28);
    const data = bytes.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflate(data, 'deflate-raw');
    throw new Error(`it uses a compression method this reader does not know (${e.method})`);
  }
  return {
    names: () => [...entries.values()].map((e) => e.name),
    has: (name) => !!find(name),
    bytes: entryBytes,
    async text(name) {
      const b = await entryBytes(name);
      return b ? decodeText(b) : null;
    },
  };
}
