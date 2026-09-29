// Relay tests without a real provider: a fake upstream (tests/fixtures/fake-upstream.mjs) streams after a delay.
// The same scenarios run against relay.mjs (in-process) and relay.php (through `php -S`, when PHP is available:
// set PHP_BIN, or have `php` on the PATH).
//
// Covered: the GET contract, local-only mode (a proxied request is not local), public mode (preset lock, visitor keys
// never forwarded, same-origin checks, rate limits, caps, generic errors with details only for local requests), and
// the stream (": open" first, ": keepalive" comments while the model is silent, then the reply).

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFakeUpstream } from './fixtures/fake-upstream.mjs';
import { createRelay, normalizeConfig, addressKey, createStaticHandler } from '../assets/relay/relay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELAY_DIR = path.join(ROOT, 'assets', 'relay');
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `aia-${name}-`));

/* ------------------------------------------------------------------------------------------- helpers */

/** A raw HTTP request (so Origin, Host and friends are exactly what the test says). */
function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* stream or text */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const pageHeaders = (relayUrl, extra = {}) => ({ 'X-Requested-With': 'ai-agent-drawer', Origin: new URL(relayUrl).origin, 'Sec-Fetch-Site': 'same-origin', ...extra });
const chatBody = (extra = {}) => ({ action: 'chat', provider: 'custom', model: 'fake-model', apiKey: 'visitor-key', system: 'S', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100000, temperature: 0.2, ...extra });

function publicConfig(upstream, dataDir, extra = {}) {
  return {
    mode: 'public',
    preset: { provider: 'custom', models: ['fake-model'], baseUrl: upstream.url },
    keys: { custom: 'server-key' },
    dataDir,
    keepalive: 1,
    limits: { perMinute: 50, perDay: 500, siteDaily: 5000, maxOutputTokens: 1000, ...(extra.limits || {}) },
    ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'limits')),
  };
}

/* ------------------------------------------------------------------------------------ relay starters */

async function startNode(config, env = {}) {
  const relay = createRelay(normalizeConfig(config, 'test'), { env: { ...env } });
  const server = http.createServer((req, res) => { relay.handle(req, res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/relay`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

function findPhp() {
  const candidates = [process.env.PHP_BIN, 'php', process.platform === 'win32' ? 'C:\\xampp\\php\\php.exe' : ''].filter(Boolean);
  for (const c of candidates) {
    const r = spawnSync(c, ['-r', 'echo PHP_VERSION;'], { encoding: 'utf8' });
    if (r.status === 0 && /^\d+\.\d+/.test(r.stdout)) {
      const ext = spawnSync(c, ['-r', 'echo extension_loaded("curl") ? "y" : "n";'], { encoding: 'utf8' });
      if (ext.stdout === 'y') return { bin: c, version: r.stdout.trim() };
    }
  }
  return null;
}
const PHP = findPhp();

async function freePort() {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function startPhp(config, env = {}) {
  const dir = tmp('php');
  const cfgFile = path.join(dir, 'relay.config.php');
  fs.writeFileSync(cfgFile, `<?php\nreturn json_decode(base64_decode('${Buffer.from(JSON.stringify(config)).toString('base64')}'), true);\n`);
  const port = await freePort();
  const child = spawn(PHP.bin, ['-S', `127.0.0.1:${port}`, '-t', RELAY_DIR], {
    env: { ...process.env, AIA_RELAY_CONFIG: cfgFile, AIA_RELAY_DIR: dir, OPENAI_API_KEY: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}/relay.php`;
  for (let i = 0; i < 100; i++) {
    try { await request(url); break; } catch { await new Promise((r) => setTimeout(r, 50)); }
  }
  return {
    url,
    log: () => log,
    close: async () => { child.kill(); await new Promise((r) => { if (child.exitCode !== null) r(); else child.once('exit', r); }); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
  };
}

/* -------------------------------------------------------------------------------------- the scenarios */

function relaySuite(name, start, { skip = false } = {}) {
  test(`${name}: GET contract, local-only mode, and proxied requests are not local`, { skip, timeout: 30000 }, async () => {
    const relay = await start({}, { OPENAI_API_KEY: 'sk-server-123456' });
    try {
      const r = await request(relay.url);
      assert.equal(r.status, 200);
      assert.equal(r.json.relay, 'ai-agent-drawer');
      assert.equal(r.json.available, true);
      assert.equal(r.json.mode, 'local');
      assert.equal(r.json.preset, null);
      assert.equal(r.json.serverKeys.openai, true, 'a key from the environment (getenv) is seen');
      assert.ok(r.json.providers.includes('lmstudio'));

      const remote = await request(relay.url, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
      assert.equal(remote.status, 200, 'GET never fails, so a probe never logs an error');
      assert.equal(remote.json.available, false);
      assert.match(remote.json.reason, /only answers requests from the computer/);

      const post = await request(relay.url, { method: 'POST', headers: { 'X-Forwarded-For': '203.0.113.7' }, body: chatBody() });
      assert.equal(post.status, 403);
      assert.equal(post.json.error.code, 'refused');
    } finally { await relay.close(); }
  });

  test(`${name}: public mode streams with ": open" and keepalives while the model is silent, using only the server key`, { skip, timeout: 30000 }, async () => {
    const upstream = await startFakeUpstream({ delayMs: 2600 });
    const relay = await start(publicConfig(upstream, tmp('data')));
    try {
      const info = await request(relay.url);
      assert.equal(info.json.available, true);
      assert.equal(info.json.mode, 'public');
      assert.deepEqual(info.json.providers, ['custom']);
      assert.deepEqual(info.json.preset, { provider: 'custom', model: 'fake-model', models: ['fake-model'] });

      const r = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody() });
      assert.equal(r.status, 200, r.text);
      assert.match(r.headers['content-type'], /text\/event-stream/);
      assert.equal(r.headers['x-accel-buffering'], 'no');
      assert.ok(r.text.startsWith(': open\n\n'), 'the stream starts with an ": open" comment');
      const firstDelta = r.text.indexOf('event: delta');
      const keepalive = r.text.indexOf(': keepalive');
      assert.ok(keepalive > 0 && keepalive < firstDelta, `a keepalive comment arrives before the first token:\n${r.text}`);
      assert.match(r.text, /event: done/);
      assert.match(r.text, /Hello/);
      const sent = upstream.lastChat();
      assert.equal(sent.headers.authorization, 'Bearer server-key', 'the visitor key is never forwarded');
      assert.equal(sent.body.model, 'fake-model');
      assert.equal(sent.body.max_tokens, 1000, 'reply tokens are capped');
      assert.equal(access(sent.body.messages[0]), 'system');
    } finally { await relay.close(); await upstream.close(); }
  });

  test(`${name}: public mode enforces same-origin`, { skip, timeout: 30000 }, async () => {
    const upstream = await startFakeUpstream();
    const relay = await start(publicConfig(upstream, tmp('data'), { allowedOrigins: ['https://partner.example'] }));
    try {
      const noHeader = await request(relay.url, { method: 'POST', headers: { Origin: new URL(relay.url).origin }, body: chatBody() });
      assert.equal(noHeader.status, 403);
      assert.equal(noHeader.json.error.code, 'refused');
      const foreign = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }), body: chatBody() });
      assert.equal(foreign.status, 403);
      assert.match(foreign.json.error.message, /only answers pages of the site/);
      assert.ok(foreign.json.error.detail, 'details go to requests from this computer');
      const crossSite = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url, { 'Sec-Fetch-Site': 'cross-site' }), body: chatBody() });
      assert.equal(crossSite.status, 403);
      const noOrigin = await request(relay.url, { method: 'POST', headers: { 'X-Requested-With': 'ai-agent-drawer' }, body: chatBody() });
      assert.equal(noOrigin.status, 403);
      const partner = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url, { Origin: 'https://partner.example', 'Sec-Fetch-Site': 'cross-site' }), body: chatBody() });
      assert.equal(partner.status, 200, 'listed origins are allowed');
      assert.equal(partner.headers['access-control-allow-origin'], undefined, 'no CORS headers, ever');
    } finally { await relay.close(); await upstream.close(); }
  });

  test(`${name}: public mode locks provider and models`, { skip, timeout: 30000 }, async () => {
    const upstream = await startFakeUpstream();
    const relay = await start(publicConfig(upstream, tmp('data')));
    try {
      const other = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody({ provider: 'openai', model: 'gpt-x' }) });
      assert.equal(other.status, 400);
      assert.equal(other.json.error.code, 'refused');
      assert.match(other.json.error.message, /only offers/);
      const model = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody({ model: 'other-model' }) });
      assert.equal(model.status, 400);
      assert.equal(model.json.error.code, 'missing-model');
      assert.match(model.json.error.message, /fake-model/);
      const list = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: { action: 'models', provider: 'custom' } });
      assert.deepEqual(list.json, { ok: true, models: [{ id: 'fake-model', label: 'fake-model', loaded: false }] });
      const empty = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody({ model: '' }) });
      assert.equal(empty.status, 200, 'an empty model means the preset default');
      assert.equal(upstream.lastChat().body.model, 'fake-model');
      assert.equal(upstream.requests.filter((r) => r.method === 'POST').length, 1, 'refused requests never reach the provider');
    } finally { await relay.close(); await upstream.close(); }
  });

  test(`${name}: public mode rate limits (429 + Retry-After) and caps`, { skip, timeout: 30000 }, async () => {
    const upstream = await startFakeUpstream();
    const dataDir = tmp('data');
    const relay = await start(publicConfig(upstream, dataDir, { limits: { perMinute: 2, maxMessages: 3, maxBodyBytes: 4000 } }));
    try {
      const ok1 = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody() });
      const ok2 = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody() });
      assert.equal(ok1.status, 200);
      assert.equal(ok2.status, 200);
      const limited = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody() });
      assert.equal(limited.status, 429);
      assert.equal(limited.json.error.code, 'rate-limit');
      assert.ok(Number(limited.headers['retry-after']) > 0);
      const state = fs.readdirSync(dataDir).find((f) => f.startsWith('relay-limits'));
      const saved = fs.readFileSync(path.join(dataDir, state), 'utf8');
      assert.doesNotMatch(saved, /127\.0\.0\.1|visitor-key|"hi"|"S"/, 'no addresses and no conversation text are stored');
      assert.deepEqual(Object.keys(JSON.parse(saved)).sort(), ['day', 'salt', 'site', 'visitors']);

      const long = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody({ messages: [1, 2, 3, 4].map((n) => ({ role: n % 2 ? 'user' : 'assistant', content: `m${n}` })) }) });
      assert.equal(long.status, 413);
      assert.equal(long.json.error.code, 'budget');
      const big = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url), body: chatBody({ system: 'x'.repeat(5000) }) });
      assert.equal(big.status, 413);
      assert.equal(big.json.error.code, 'budget');
    } finally { await relay.close(); await upstream.close(); }
  });

  test(`${name}: misconfiguration: generic for visitors, details only for this computer`, { skip, timeout: 30000 }, async () => {
    const relay = await start({ mode: 'public', preset: { provider: 'openai', models: ['gpt-x'] } });   // no key
    try {
      const info = await request(relay.url);
      assert.equal(info.status, 200);
      assert.equal(info.json.available, false);
      assert.match(info.json.detail, /OPENAI_API_KEY/);
      const visitorInfo = await request(relay.url, { headers: { 'X-Forwarded-For': '203.0.113.7' } });
      assert.equal(visitorInfo.json.detail, undefined);
      const post = await request(relay.url, { method: 'POST', headers: pageHeaders(relay.url, { 'X-Forwarded-For': '203.0.113.7' }), body: chatBody({ provider: 'openai', model: 'gpt-x' }) });
      assert.equal(post.status, 503);
      assert.equal(post.json.error.message, 'The assistant is not available right now.');
      assert.equal(post.json.error.detail, undefined, 'visitors never see configuration details');
    } finally { await relay.close(); }
  });
}

const access = (m) => m?.role;

relaySuite('relay.mjs', startNode);
relaySuite(`relay.php${PHP ? ` (PHP ${PHP.version})` : ''}`, startPhp, { skip: PHP ? false : 'PHP with curl not found (set PHP_BIN)' });

/* ----------------------------------------------------------------------------------- Node-only details */

test('relay.mjs: IPv6 visitors are grouped by /64, IPv4-mapped addresses by IPv4', () => {
  assert.equal(addressKey('2001:db8:1:2:aaaa::1'), addressKey('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
  assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'));
  assert.equal(addressKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(addressKey('192.0.2.1'), '192.0.2.1');
});

test('relay.mjs: the static server never serves relay configuration or dotfiles', async () => {
  const dir = tmp('static');
  fs.writeFileSync(path.join(dir, 'relay.config.json'), '{"keys":{"openai":"sk-secret"}}');
  fs.writeFileSync(path.join(dir, 'index.html'), 'ok');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'config'), 'secret');
  const handler = createStaticHandler(dir);
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await request(`${base}/index.html`)).status, 200);
    assert.equal((await request(`${base}/relay.config.json`)).status, 404);
    assert.equal((await request(`${base}/.git/config`)).status, 404);
  } finally { await new Promise((r) => server.close(r)); }
});
