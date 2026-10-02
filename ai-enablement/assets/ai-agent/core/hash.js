// Content fingerprints for the context-sync flag. Synchronous and dependency-free (crypto.subtle is async and
// unavailable outside secure contexts), which matters because the flag is recomputed on every edit.
// cyrb53: a fast 53-bit string hash with good distribution. Not cryptographic; it only has to notice change.

export function hashText(str) {
  const s = String(str ?? '');
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, '0');
}

/** Short form for display: the first 7 hex digits, like a git commit. */
export const shortHash = (hash) => String(hash || '').slice(0, 7);

/**
 * JSON with object keys sorted, so the same data always produces the same text (and the same hash) no matter what
 * order the app built the object in. Functions and undefined are dropped; cycles become "[Circular]".
 */
export function stableStringify(value, indent = 2) {
  const seen = new WeakSet();
  const norm = (v) => {
    if (v === null || typeof v !== 'object') {
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      return v;
    }
    if (v instanceof Date) return v.toISOString();
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    let out;
    if (Array.isArray(v)) out = v.map((x) => (x === undefined || typeof x === 'function' ? null : norm(x)));
    else if (v instanceof Map) out = norm(Object.fromEntries(v));
    else if (v instanceof Set) out = norm([...v]);
    else {
      out = {};
      for (const k of Object.keys(v).sort()) {
        const x = v[k];
        if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
        out[k] = norm(x);
      }
    }
    seen.delete(v);
    return out;
  };
  return JSON.stringify(norm(value), null, indent);
}
