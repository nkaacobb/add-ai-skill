// scripts/workspace.mjs — the development workspace the in-app agent uses to read the app's source and add
// capabilities. What it shows, what it refuses, where it writes, and who may call it.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createWorkspace, findAiDir } from '../scripts/workspace.mjs';

let root;
let server;
let base;
let local = true;
const logs = [];

const write = (rel, text) => { const p = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };

before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-ws-'));
  write('src/editor.js', 'export function renameFile(name) {\n  state.name = name;\n}\n');
  write('src/big.bin', Buffer.from([0, 1, 2, 3]).toString('binary'));
  write('.env', 'SECRET=1');
  write('config/.secret/x.js', 'x');
  write('node_modules/lib/index.js', 'renameFile()');
  write('secrets.json', '{"k":"v"}');
  write('server.key', 'KEY');
  write('relay.config.php', '<?php return [];');
  write('public/ai/index.json', JSON.stringify({ format: 'ai-enablement/1', tools: [] }));
  write('public/ai/tools/doc.js', 'export default [];');
  const ws = createWorkspace({ root, isLocal: () => local, log: (l) => logs.push(l) });
  server = http.createServer((req, res) => ws.handle(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const H = { 'X-Requested-With': 'ai-agent-drawer' };
const get = async (query, headers = H) => { const r = await fetch(`${base}/?${new URLSearchParams(query)}`, { headers }); return { status: r.status, json: await r.json() }; };
const post = async (body, headers = H) => {
  const r = await fetch(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
/** A raw request with any Host / Origin headers (fetch cannot set Host). */
const raw = (headers, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(`${base}/`, { method, headers }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t })); });
  req.on('error', reject);
  req.end();
});

test('workspace: it finds the capability folder and describes itself', async () => {
  assert.equal(findAiDir(root), 'public/ai');
  const r = await get({});
  assert.equal(r.status, 200);
  assert.equal(r.json.workspace, 'ai-enablement');
  assert.equal(r.json.aiDir, 'public/ai');
  assert.equal(r.json.index, 'public/ai/index.json');
  assert.deepEqual(r.json.writable, ['public/ai']);
});

test('workspace: lists and reads the source, never hidden files, dependencies or secrets', async () => {
  const top = await get({ list: '.' });
  assert.deepEqual(top.json.entries.map((e) => e.name), ['config', 'public', 'src'], 'no .env, node_modules, secrets.json, server.key, relay.config.php');
  const file = await get({ read: 'src/editor.js' });
  assert.equal(file.status, 200);
  assert.match(file.json.text, /export function renameFile/);
  assert.equal(file.json.truncated, false);
  for (const [p, status] of [['.env', 403], ['config/.secret/x.js', 403], ['node_modules/lib/index.js', 403], ['secrets.json', 403], ['server.key', 403], ['relay.config.php', 403], ['../outside.txt', 400], ['/etc/passwd', 400], ['src/missing.js', 404], ['src/big.bin', 415], ['src', 400]]) {
    const r = await get({ read: p });
    assert.equal(r.status, status, `${p}: ${r.json.error?.message}`);
    assert.equal(r.json.ok, false);
  }
  const found = await get({ search: 'renamefile' });
  assert.deepEqual(found.json.matches, [{ path: 'src/editor.js', line: 1, text: 'export function renameFile(name) {' }], 'node_modules is not searched');
  assert.equal((await get({ search: 'x' })).status, 400, 'at least two characters');
});

test('workspace: writes only .js/.mjs/.json/.md inside the capability folder; JSON must parse', async () => {
  const ok = await post({ path: 'public/ai/tools/inspect.js', content: 'export default { name: "inspect" };' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, path: 'public/ai/tools/inspect.js', bytes: 35, created: true });
  assert.equal(fs.readFileSync(path.join(root, 'public/ai/tools/inspect.js'), 'utf8'), 'export default { name: "inspect" };\n');
  const again = await post({ path: 'public/ai/tools/inspect.js', content: 'x' });
  assert.equal(again.status, 409, 'an existing file is replaced only on purpose');
  assert.match(again.json.error.message, /already exists\. A new tool goes in a new file[\s\S]*replace: true/);
  assert.equal((await post({ path: 'public/ai/tools/inspect.js', content: 'x', replace: true })).json.created, false);
  assert.match(logs.join('\n'), /created public\/ai\/tools\/inspect\.js/);
  for (const [body, status, why] of [
    [{ path: 'src/editor.js', content: 'hacked' }, 403, /capability folder/],
    [{ path: 'public/ai/../../src/editor.js', content: 'x' }, 400, /leaves/],
    [{ path: 'public/ai/run.exe', content: 'x' }, 400, /\.js, \.mjs, \.json and \.md/],
    [{ path: 'public/ai/index.json', content: '{ broken' }, 400, /JSON does not parse/],
    [{ path: 'public/ai/.hidden.js', content: 'x' }, 403, /hidden/],
    [{ path: 'public/ai/tools/x.js', content: 42 }, 400, /text of the file/],
    [{ path: 'public/ai/big.md', content: 'x'.repeat(300 * 1024) }, 413, /limit/],
  ]) {
    const r = await post(body);
    assert.equal(r.status, status, JSON.stringify(r.json));
    assert.match(r.json.error.message, why);
  }
  assert.equal(fs.readFileSync(path.join(root, 'src/editor.js'), 'utf8').startsWith('export function renameFile'), true, 'the app\'s own code is untouched');
});

test('workspace: only this computer, a loopback Host, the drawer\'s header, and the page\'s own origin', async () => {
  const port = server.address().port;
  assert.equal((await get({}, {})).status, 403, 'no X-Requested-With');
  assert.equal((await raw({ ...H, Host: 'evil.example' })).status, 403, 'DNS rebinding: a foreign Host header');
  assert.equal((await raw({ ...H, Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' })).status, 403, 'another site');
  assert.equal((await raw({ ...H, Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` })).status, 200, 'the page\'s own origin');
  assert.equal((await raw({ ...H, Host: `127.0.0.1:${port}`, 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await raw({ Host: `127.0.0.1:${port}`, Origin: 'http://localhost:5173' }, 'OPTIONS')).status, 403, 'no preflight for an origin nobody listed');
  local = false;
  try { assert.equal((await get({})).status, 403, 'not from this computer'); } finally { local = true; }
});

test('workspace: an origin given with --origin gets CORS (its own origin echoed, never *)', async () => {
  const ws = createWorkspace({ root, origins: ['http://localhost:5173'], isLocal: () => true, log: () => {} });
  const s = http.createServer((req, res) => ws.handle(req, res));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  const call = (headers, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${port}/`, { method, headers }, (res) => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); });
    req.on('error', reject);
    req.end();
  });
  try {
    const pre = await call({ Host: `127.0.0.1:${port}`, Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' }, 'OPTIONS');
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:5173');
    const r = await call({ ...H, Host: `127.0.0.1:${port}`, Origin: 'http://localhost:5173', 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(r.status, 200);
    assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:5173');
  } finally {
    s.close();
  }
});
