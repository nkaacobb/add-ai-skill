// The development workspace: while a developer works on the app, the in-app agent can read the application's source
// and add capabilities (a tool, a skill, an agent) to its capability folder — the motivating case being "add a tool
// for that" asked inside the app itself.
//
// The other side is the skill's dev server (scripts/workspace.mjs), never deployed with the app. It answers only
// this computer, only the app's own pages (or origins it was told), reads inside the app's folder (no hidden files,
// no secrets, no dependencies), and writes only inside the capability folder. Every write is shown to the user and
// confirmed first (effect "system"); nothing here runs without that server.
//
//   GET  {url}                 -> { ok, workspace: 'ai-enablement', version, root, aiDir, index, writable: [dirs] }
//   GET  {url}?list=<dir>      -> { ok, path, entries: [{ name, type: 'file'|'dir', size? }], truncated }
//   GET  {url}?read=<file>&offset=<n> -> { ok, path, text, size, offset, end, truncated }
//   GET  {url}?search=<text>&path=<dir> -> { ok, query, matches: [{ path, line, text }], truncated }
//   POST {url}  { path, content, replace? } -> { ok, path, bytes, created }   (409 when the file exists and replace is not true)
//   errors: { ok: false, error: { message } } with a 4xx status
//
// Pure module apart from fetch (injected for tests).

export const WORKSPACE_HEADER = { 'X-Requested-With': 'ai-agent-drawer' };
export const DEFAULT_WORKSPACE_URL = '/ai-workspace';

async function call(url, { method = 'GET', body, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetchImpl(url, {
      method,
      headers: { Accept: 'application/json', ...WORKSPACE_HEADER, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      credentials: 'same-origin',
      cache: 'no-store',
      ...(controller ? { signal: controller.signal } : {}),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok || !json || json.ok === false) throw new Error(json?.error?.message || `The workspace answered HTTP ${res.status}.`);
    return json;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('The workspace did not answer in time.');
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Is a workspace server there? Its info, or null (quietly: no server is the normal case). */
export async function probeWorkspace(url, { fetchImpl = globalThis.fetch, timeoutMs = 2500, base = globalThis.location?.href } = {}) {
  if (!url || typeof fetchImpl !== 'function') return null;
  let href;
  try { href = new URL(url, base).href; } catch { return null; }
  try {
    const info = await call(href, { fetchImpl, timeoutMs });
    if (info.workspace !== 'ai-enablement') return null;
    return {
      url: href,
      version: String(info.version || ''),
      root: String(info.root || ''),
      aiDir: String(info.aiDir || 'ai').replace(/^\/+|\/+$/g, ''),
      index: String(info.index || ''),
      writable: Array.isArray(info.writable) ? info.writable.map(String) : [],
    };
  } catch {
    return null;
  }
}

/** A relative path inside the workspace, cleaned; throws on anything that tries to leave it. */
export function workspacePath(path, { allowEmpty = false } = {}) {
  const p = String(path ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!p) { if (allowEmpty) return ''; throw new Error('Give a path relative to the application folder, for example src/editor.js.'); }
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/')) throw new Error(`"${p}" is not a relative path inside the application folder.`);
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`"${p}" leaves the application folder.`);
  return p;
}

/** Can the agent write this path (inside one of the workspace's writable folders)? '' when yes, else why not. */
export function writeProblem(path, info) {
  const dirs = (info?.writable || []).map((d) => String(d).replace(/\/+$/, ''));
  if (!dirs.length) return 'This workspace does not allow writing.';
  if (!dirs.some((d) => path === d || path.startsWith(`${d}/`))) return `Only files inside ${dirs.map((d) => `${d}/`).join(' or ')} can be written (the capability folder); "${path}" is outside it.`;
  if (!/\.(js|mjs|json|md)$/i.test(path)) return 'Only .js, .mjs, .json and .md files can be written.';
  return '';
}

/** The calls the built-in workspace tools make. */
export function workspaceClient(info, { fetchImpl = globalThis.fetch } = {}) {
  const at = (params) => `${info.url}${info.url.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;
  return {
    info,
    list: (dir = '') => call(at({ list: workspacePath(dir, { allowEmpty: true }) || '.' }), { fetchImpl }),
    read: (file, offset = 0) => call(at({ read: workspacePath(file), offset: String(Math.max(0, offset | 0)) }), { fetchImpl }),
    search: (query, dir = '') => call(at({ search: String(query ?? '').slice(0, 200), path: workspacePath(dir, { allowEmpty: true }) || '.' }), { fetchImpl }),
    /** Create a file; an existing one only with { replace: true } (the server refuses otherwise). */
    write: (file, content, { replace = false } = {}) => {
      const path = workspacePath(file);
      const problem = writeProblem(path, info);
      if (problem) return Promise.reject(new Error(problem));
      return call(info.url, { method: 'POST', body: { path, content: String(content ?? ''), ...(replace ? { replace: true } : {}) }, fetchImpl });
    },
  };
}

/**
 * A line diff of two texts (longest common subsequence), for showing what a replacement changes before the user
 * confirms it: [{ op: ' ' | '-' | '+', line }]. Texts too large to compare line by line come back as a whole
 * removal and addition.
 */
export function lineDiff(before, after, { maxCells = 2_000_000 } = {}) {
  const a = String(before ?? '').replace(/\r\n?/g, '\n').split('\n');
  const b = String(after ?? '').replace(/\r\n?/g, '\n').split('\n');
  if (a.length * b.length > maxCells) return [...a.map((line) => ({ op: '-', line })), ...b.map((line) => ({ op: '+', line }))];
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the longest common subsequence of a[i..] and b[j..], one row at a time from the end.
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', line: a[i] }); i++; j++; } else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ op: '-', line: a[i] }); i++; } else { out.push({ op: '+', line: b[j] }); j++; }
  }
  while (i < n) out.push({ op: '-', line: a[i++] });
  while (j < m) out.push({ op: '+', line: b[j++] });
  return out;
}

/** The changed parts of a diff with `context` unchanged lines around each, and the counts: { hunks, removed, added }. */
export function diffHunks(diff, context = 2) {
  const keep = new Array(diff.length).fill(false);
  diff.forEach((d, k) => {
    if (d.op === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(diff.length - 1, k + context); x++) keep[x] = true;
  });
  const hunks = [];
  let current = null;
  diff.forEach((d, k) => {
    if (!keep[k]) { current = null; return; }
    if (!current) { current = []; hunks.push(current); }
    current.push(d);
  });
  return { hunks, removed: diff.filter((d) => d.op === '-').length, added: diff.filter((d) => d.op === '+').length };
}
