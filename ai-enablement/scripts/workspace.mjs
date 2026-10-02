#!/usr/bin/env node
// The development workspace: lets the AI inside an application read that application's source and add capabilities
// (tools, skills, agents) to its capability folder while a developer works on it. DEVELOPMENT ONLY — this file stays
// in the skill and is never copied into the app or deployed. Zero dependencies; Node 18+.
//
//   node <skill>/scripts/workspace.mjs <app-root> [options]
//
//   --ai <dir>          the capability folder, relative to <app-root> (default: the folder of the first index.json
//                       with "format": "ai-enablement/1", else "ai")
//   --static <dir>      serve this folder as the website (default: <app-root>); --no-static for apps with their own
//                       dev server (then pass --origin and point the app's `workspace` option at this server)
//   --origin <url>      an extra page origin allowed to call the workspace (repeatable), e.g. http://localhost:5173
//   --port <n>          default 8790          --host <addr>   default 127.0.0.1 (loopback addresses only)
//   --path <p>          the workspace endpoint, default /ai-workspace
//   --no-relay          do not mount the Node relay at /ai-relay (it is mounted by default, as relay.mjs --static does)
//
// In the app: createAiAgent({ …, workspace: true }) (or the URL of this server's endpoint). The runtime then offers
// the agent list_source_files, read_source_file, search_source, write_ai_file and reload_capabilities, plus the
// built-in create-tool skill. Without this server those tools do not exist.
//
// What the page can do through it:
//   read    files inside <app-root>: not hidden files or folders (.git, .env…), not dependencies (node_modules…),
//           not keys or relay configs; text only, up to 2 MB, in parts
//   search  plain text over those files (100 matches at most)
//   write   .js / .mjs / .json / .md files inside the capability folder only (JSON must parse); an existing file only with
//           replace: true (a new tool goes in a new file); never delete
// Who can call it: requests from this computer only (loopback, not proxied), with a loopback Host header (no DNS
// rebinding), the X-Requested-With: ai-agent-drawer header, and from the page's own origin or an --origin you listed.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay, loadConfig, createStaticHandler, isLocalRequest } from '../assets/relay/relay.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(SKILL, 'package.json'), 'utf8')).version || ''; } catch { return ''; } })();

export const LIMITS = Object.freeze({ readBytes: 2 * 1024 * 1024, chunkChars: 60000, writeBytes: 256 * 1024, listEntries: 500, matches: 100, searchFiles: 5000, searchBytes: 1024 * 1024 });
const SKIP_DIRS = new Set(['node_modules', 'bower_components', 'vendor', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.svelte-kit', '.output', '.verify', '.cache', '.turbo', '.vercel', '__pycache__', 'target']);
const SECRET = /^(\.env.*|.*\.(pem|key|p12|pfx|crt|cer|der|keystore|jks|kdbx)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|relay\.config\..*|relay-limits\.json|secrets?\..*|credentials?\..*|.*\.sqlite3?|.*\.db)$/i;
const TEXT_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'astro', 'html', 'htm', 'css', 'scss', 'less', 'json', 'md', 'markdown', 'txt', 'php', 'py', 'rb', 'go', 'rs', 'java', 'cs', 'c', 'cpp', 'h', 'hpp', 'sql', 'yaml', 'yml', 'toml', 'ini', 'xml', 'svg', 'sh', 'ps1', 'graphql', 'gql', 'csv', 'tsv', 'twig', 'blade', 'ejs', 'hbs', 'liquid']);
const WRITABLE_EXT = /\.(js|mjs|json|md)$/i;

class WorkspaceError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The capability folder: the folder of the first ai-enablement index.json under root, else "ai". */
export function findAiDir(root) {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < 4000) {
    const dir = stack.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      seen++;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) stack.push(p); continue; }
      if (e.name === 'index.json') {
        try {
          if (JSON.parse(fs.readFileSync(p, 'utf8')).format === 'ai-enablement/1') return path.relative(root, dir).split(path.sep).join('/') || '.';
        } catch { /* not ours */ }
      }
    }
  }
  return 'ai';
}

/**
 * The workspace endpoint for one application.
 * @param {object} o
 * @param {string} o.root            the application folder
 * @param {string} [o.aiDir]         the capability folder, relative to root
 * @param {string[]} [o.origins]     extra page origins allowed to call it
 * @param {(req) => boolean} [o.isLocal]  override the "from this computer" test (tests)
 * @param {(line: string) => void} [o.log]
 */
export function createWorkspace({ root, aiDir = '', origins = [], isLocal = isLocalRequest, log = (l) => console.log(l) }) {
  const base = fs.realpathSync(path.resolve(root));
  const ai = (aiDir || findAiDir(base)).replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '') || '.';
  const aiAbs = path.resolve(base, ai);
  if (aiAbs !== base && !aiAbs.startsWith(base + path.sep)) throw new Error(`The capability folder ${ai} is outside ${base}.`);
  const allowed = new Set(origins.map((o) => String(o).replace(/\/+$/, '').toLowerCase()));

  const info = () => ({
    ok: true, workspace: 'ai-enablement', version: VERSION, root: path.basename(base), aiDir: ai,
    index: fs.existsSync(path.join(aiAbs, 'index.json')) ? `${ai === '.' ? '' : `${ai}/`}index.json` : '',
    writable: [ai],
  });

  /** A relative path -> its absolute path inside root (or throws). Hidden, dependency and secret paths are refused. */
  function resolveInside(rel, { forWrite = false } = {}) {
    const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (clean === '' || clean === '.') return base;
    if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/')) throw new WorkspaceError(400, `"${clean}" is not a path relative to the application folder.`);
    const parts = clean.split('/');
    if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new WorkspaceError(400, `"${clean}" leaves the application folder.`);
    if (parts.some((p) => p.startsWith('.'))) throw new WorkspaceError(403, `"${clean}" is a hidden file or folder; the workspace does not show those.`);
    if (parts.some((p) => SKIP_DIRS.has(p)) && !forWrite) throw new WorkspaceError(403, `"${clean}" is inside a dependency or build folder; the workspace does not show those.`);
    if (SECRET.test(parts[parts.length - 1])) throw new WorkspaceError(403, `"${clean}" may hold secrets; the workspace does not show it.`);
    const abs = path.resolve(base, ...parts);
    if (abs !== base && !abs.startsWith(base + path.sep)) throw new WorkspaceError(400, `"${clean}" leaves the application folder.`);
    // A symbolic link may point outside: check where the existing part of the path really is.
    let probe = abs;
    while (!fs.existsSync(probe) && probe !== base) probe = path.dirname(probe);
    const real = fs.realpathSync(probe);
    if (real !== base && !real.startsWith(base + path.sep)) throw new WorkspaceError(403, `"${clean}" points outside the application folder.`);
    return abs;
  }
  const relOf = (abs) => path.relative(base, abs).split(path.sep).join('/');

  function list(rel) {
    const abs = resolveInside(rel);
    let st;
    try { st = fs.statSync(abs); } catch { throw new WorkspaceError(404, `"${rel}" does not exist.`); }
    if (!st.isDirectory()) throw new WorkspaceError(400, `"${rel}" is a file: read it with read_source_file.`);
    const entries = [];
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.name.startsWith('.') || SECRET.test(e.name) || (e.isDirectory() && SKIP_DIRS.has(e.name))) continue;
      if (e.isDirectory()) entries.push({ name: e.name, type: 'dir' });
      else if (e.isFile()) { let size; try { size = fs.statSync(path.join(abs, e.name)).size; } catch { size = undefined; } entries.push({ name: e.name, type: 'file', size }); }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { ok: true, path: relOf(abs), entries: entries.slice(0, LIMITS.listEntries), truncated: entries.length > LIMITS.listEntries };
  }

  function read(rel, offset = 0) {
    const abs = resolveInside(rel);
    let st;
    try { st = fs.statSync(abs); } catch { throw new WorkspaceError(404, `"${rel}" does not exist.`); }
    if (st.isDirectory()) throw new WorkspaceError(400, `"${rel}" is a folder: list it with list_source_files.`);
    if (st.size > LIMITS.readBytes) throw new WorkspaceError(413, `"${rel}" is ${st.size.toLocaleString('en-US')} bytes, over the ${LIMITS.readBytes / 1024 / 1024} MB the workspace reads.`);
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) throw new WorkspaceError(415, `"${rel}" is a binary file.`);
    const text = buf.toString('utf8').replace(/^﻿/, '');
    const start = Math.min(Math.max(0, Number(offset) | 0), text.length);
    const end = Math.min(text.length, start + LIMITS.chunkChars);
    return { ok: true, path: relOf(abs), text: text.slice(start, end), size: text.length, offset: start, end, truncated: end < text.length };
  }

  function search(query, rel = '') {
    const q = String(query ?? '').trim().toLowerCase();
    if (q.length < 2) throw new WorkspaceError(400, 'Search for at least two characters.');
    const start = resolveInside(rel);
    const matches = [];
    let files = 0;
    let truncated = false;
    const stack = [start];
    while (stack.length && !truncated) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
        if (e.name.startsWith('.') || SECRET.test(e.name)) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) stack.push(p); continue; }
        if (!e.isFile() || !TEXT_EXT.has(path.extname(e.name).slice(1).toLowerCase())) continue;
        if (++files > LIMITS.searchFiles) { truncated = true; break; }
        let text;
        try { if (fs.statSync(p).size > LIMITS.searchBytes) continue; text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        if (!text.toLowerCase().includes(q)) continue;
        const lines = text.split(/\r?\n/);
        for (let n = 0; n < lines.length; n++) {
          if (!lines[n].toLowerCase().includes(q)) continue;
          matches.push({ path: relOf(p), line: n + 1, text: lines[n].trim().slice(0, 240) });
          if (matches.length >= LIMITS.matches) { truncated = true; break; }
        }
        if (truncated) break;
      }
    }
    return { ok: true, query: String(query), matches, truncated };
  }

  function write(rel, content, { replace = false } = {}) {
    if (typeof content !== 'string') throw new WorkspaceError(400, 'content must be the text of the file.');
    const abs = resolveInside(rel, { forWrite: true });
    if (abs !== aiAbs && !abs.startsWith(aiAbs + path.sep)) throw new WorkspaceError(403, `Only files inside ${ai}/ (the capability folder) can be written; "${rel}" is outside it.`);
    if (!WRITABLE_EXT.test(abs)) throw new WorkspaceError(400, 'Only .js, .mjs, .json and .md files can be written.');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > LIMITS.writeBytes) throw new WorkspaceError(413, `The file would be ${bytes.toLocaleString('en-US')} bytes, over the ${LIMITS.writeBytes / 1024} KB limit.`);
    if (/\.json$/i.test(abs)) {
      try { JSON.parse(content); } catch (e) { throw new WorkspaceError(400, `Not written: the JSON does not parse (${e.message}). Fix it and write it again.`); }
    }
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new WorkspaceError(400, `"${rel}" is a folder.`);
    const created = !fs.existsSync(abs);
    // Replacing is a deliberate act: an existing file is overwritten only when the caller says so.
    if (!created && replace !== true) throw new WorkspaceError(409, `${relOf(abs)} already exists. A new tool goes in a new file (tools/<tool name>.js). To change this file, read it, then write it whole with replace: true.`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content.endsWith('\n') ? content : `${content}\n`);
    log(`[workspace] ${created ? 'created' : 'replaced'} ${relOf(abs)} (${bytes.toLocaleString('en-US')} bytes)`);
    return { ok: true, path: relOf(abs), bytes, created };
  }

  /** Same-origin (or listed origin), loopback Host, the drawer's header. Returns the CORS origin to echo, or ''. */
  function check(req) {
    if (!isLocal(req)) throw new WorkspaceError(403, 'The workspace only answers this computer.');
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/.test(host)) throw new WorkspaceError(403, 'The workspace only answers requests addressed to localhost / 127.0.0.1.');
    const origin = String(req.headers.origin || '').replace(/\/+$/, '').toLowerCase();
    const listed = origin && allowed.has(origin);
    if (req.method === 'OPTIONS') return listed ? origin : '';
    if (req.headers['x-requested-with'] !== 'ai-agent-drawer') throw new WorkspaceError(403, 'Requests must come from the application\'s pages (X-Requested-With: ai-agent-drawer).');
    if (origin && !listed) {
      let u = null;
      try { u = new URL(origin); } catch { /* refused below */ }
      if (!u || u.host !== host) throw new WorkspaceError(403, `Origin ${origin} may not use this workspace (start it with --origin ${origin} to allow it).`);
    }
    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none' && !listed) throw new WorkspaceError(403, `Cross-site requests are refused (Sec-Fetch-Site: ${site}).`);
    return listed ? origin : '';
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > LIMITS.writeBytes * 2 + 4096) { reject(new WorkspaceError(413, 'The request is too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    let cors = '';
    const send = (status, body) => {
      const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (cors) Object.assign(headers, { 'Access-Control-Allow-Origin': cors, Vary: 'Origin' });
      res.writeHead(status, headers);
      res.end(JSON.stringify(body));
    };
    try {
      cors = check(req);
      if (req.method === 'OPTIONS') {
        if (!cors) { res.writeHead(403); res.end(); return; }
        res.writeHead(204, { 'Access-Control-Allow-Origin': cors, 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'X-Requested-With, Content-Type, Accept', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
        res.end();
        return;
      }
      const url = new URL(req.url || '/', 'http://workspace');
      if (req.method === 'GET') {
        const q = url.searchParams;
        if (q.has('read')) return send(200, read(q.get('read'), q.get('offset')));
        if (q.has('list')) return send(200, list(q.get('list')));
        if (q.has('search')) return send(200, search(q.get('search'), q.get('path') || ''));
        return send(200, info());
      }
      if (req.method === 'POST') {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) throw new WorkspaceError(415, 'Send JSON: { path, content }.');
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { if (e instanceof WorkspaceError) throw e; throw new WorkspaceError(400, 'The body is not valid JSON.'); }
        return send(200, write(body?.path, body?.content, { replace: body?.replace === true }));
      }
      throw new WorkspaceError(405, 'Use GET or POST.');
    } catch (e) {
      const status = e instanceof WorkspaceError ? e.status : 500;
      if (status === 500) log(`[workspace] error: ${e?.stack || e}`);
      return send(status, { ok: false, error: { message: status === 500 ? 'The workspace failed; see its console.' : e.message } });
    }
  }

  return { handle, info, root: base, aiDir: ai, read, list, search, write };
}

/* ------------------------------------------------------------------------------------------------- CLI */

async function main(argv) {
  const flag = (n) => argv.includes(`--${n}`);
  const opts = (n) => argv.flatMap((a, i) => (a === `--${n}` && argv[i + 1] && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
  const opt = (n, fallback) => opts(n)[0] ?? fallback;
  const valued = new Set(['ai', 'static', 'origin', 'port', 'host', 'path']);
  const root = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && valued.has(argv[i - 1].slice(2))));
  if (!root || flag('help')) {
    console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 26).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(root ? 0 : 1);
  }
  const host = opt('host', '127.0.0.1');
  if (!/^(127\.\d+\.\d+\.\d+|localhost|::1)$/.test(host)) { console.error('The workspace listens on loopback addresses only (127.0.0.1, ::1, localhost).'); process.exit(2); }
  const port = Number(opt('port', 8790));
  const wsPath = opt('path', '/ai-workspace');
  const ws = createWorkspace({ root, aiDir: opt('ai', ''), origins: opts('origin') });
  const staticDir = flag('no-static') ? '' : path.resolve(opt('static', root));
  const serveStatic = staticDir ? createStaticHandler(staticDir) : null;
  const relay = flag('no-relay') ? null : createRelay(await loadConfig());

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === wsPath) { ws.handle(req, res); return; }
    if (relay && pathname === '/ai-relay') { relay.handle(req, res).catch((e) => { try { res.writeHead(500); res.end(String(e?.message || e)); } catch { /* sent */ } }); return; }
    if (!isLocalRequest(req)) { res.writeHead(403); res.end('This server only answers requests from this computer.'); return; }
    if (serveStatic) { serveStatic(req, res); return; }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found (started with --no-static).');
  });
  server.listen(port, host, () => {
    const at = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    console.log(`AI Enablement workspace ${VERSION} — DEVELOPMENT ONLY`);
    console.log(`  app        ${ws.root}`);
    console.log(`  writes to  ${path.join(ws.root, ws.aiDir)}  (capability folder; .js .mjs .json .md)`);
    console.log(`  endpoint   ${at}${wsPath}`);
    if (staticDir) console.log(`  website    ${at}/  (static files from ${staticDir})`);
    if (relay) console.log(`  relay      ${at}/ai-relay`);
    for (const o of opts('origin')) console.log(`  origin     ${o} may call it (CORS)`);
    console.log('The page can read this app\'s source and, with your confirmation in the chat, write in the capability folder.');
    console.log('Stop with Ctrl+C. Never run it on a server.');
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((e) => { console.error(e?.message || e); process.exit(1); });
