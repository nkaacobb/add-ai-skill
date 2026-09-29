#!/usr/bin/env node
// ai-agent-drawer — Node relay (and optional static file server). Zero dependencies; Node 18+.
//
//   node relay.mjs [--port 8787] [--host 127.0.0.1] [--path /ai-relay] [--static <dir>]
//                  [--allow-remote] [--allow-any-upstream] [--cors <origin>]
//
// Why a relay: some providers refuse direct browser calls (CORS), keys are better kept on a server, and a deployed
// app should not ship keys to every visitor. The browser POSTs the chat to this endpoint (Settings > Model >
// Advanced > "Through the application's relay"); the relay calls the provider with the SAME adapters the browser
// uses (imported from ../ai-agent), and streams the reply back as Server-Sent Events.
//
// Keys: the request's apiKey if the user typed one, otherwise the provider's environment variable
// (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY).
//
// Safety defaults: listens on 127.0.0.1 and refuses non-loopback clients (--allow-remote to change); cloud providers
// always use their catalog address (the client cannot redirect a server key elsewhere); local providers may only
// target loopback/private addresses (--allow-any-upstream to change); request bodies are capped at 4 MB.
//
// --static <dir> also serves that folder, so `node assets/relay/relay.mjs --static .` from the skill folder runs the
// Hello World example at http://127.0.0.1:8787/examples/hello-world/ with the relay on the same origin.
//
// When copying this file into an application, keep the import path below pointing at the app's copy of ai-agent/.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamChat, listModels } from '../ai-agent/core/client.js';
import { PROVIDERS, provider, isLocalUrl } from '../ai-agent/core/providers.js';
import { sanitizeSettings } from '../ai-agent/core/settings.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

const PORT = Number(opt('port', process.env.AI_RELAY_PORT || 8787));
const HOST = opt('host', process.env.AI_RELAY_HOST || '127.0.0.1');
const RELAY_PATH = opt('path', '/ai-relay');
const STATIC_DIR = opt('static', '') ? path.resolve(opt('static', '')) : '';
const ALLOW_REMOTE = flag('allow-remote');
const ALLOW_ANY_UPSTREAM = flag('allow-any-upstream');
const CORS = opt('cors', '');
const MAX_BODY = 4 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
};

const isLoopback = (addr) => /^(127\.|::1$|::ffff:127\.)/.test(String(addr || ''));

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders() });
  res.end(JSON.stringify(body));
}

function corsHeaders() {
  return CORS ? { 'Access-Control-Allow-Origin': CORS, 'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {};
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('The request body is larger than 4 MB.'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Turn a relay request into settings for the shared client, enforcing where it may connect. */
function settingsFrom(body) {
  const id = String(body.provider || '');
  if (!PROVIDERS[id]) throw Object.assign(new Error(`Unknown provider "${id}".`), { status: 400 });
  const p = provider(id);
  let baseUrl = p.baseUrl;
  const wanted = String(body.baseUrl || '').trim();
  if (wanted && p.kind !== 'cloud') {
    if (!ALLOW_ANY_UPSTREAM && !isLocalUrl(wanted)) {
      throw Object.assign(new Error(`The relay only forwards ${p.label} requests to local/private addresses (start it with --allow-any-upstream to change that).`), { status: 400 });
    }
    baseUrl = wanted;
  }
  const settings = sanitizeSettings({
    provider: id,
    profiles: { [id]: { baseUrl, model: String(body.model || '') } },
    transport: 'direct',
    reasoning: body.reasoning,
    maxOutputTokens: Number.isInteger(body.maxTokens) ? body.maxTokens : undefined,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    timeoutSec: 300,
  });
  const key = String(body.apiKey || '').trim() || (p.keyEnv ? process.env[p.keyEnv] || '' : '');
  return { settings, keyFor: () => key };
}

async function handleRelay(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); res.end(); return; }
  if (req.method === 'GET') {
    json(res, 200, {
      ok: true,
      relay: 'ai-agent-drawer',
      providers: Object.keys(PROVIDERS),
      serverKeys: Object.fromEntries(Object.values(PROVIDERS).filter((p) => p.keyEnv).map((p) => [p.id, !!process.env[p.keyEnv]])),
    });
    return;
  }
  if (req.method !== 'POST') { json(res, 405, { error: { message: 'Use POST.' } }); return; }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    json(res, e.status || 400, { error: { message: e.status ? e.message : 'The request body was not valid JSON.' } });
    return;
  }

  let target;
  try { target = settingsFrom(body || {}); } catch (e) { json(res, e.status || 400, { ok: false, error: { message: e.message } }); return; }

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  if (body.action === 'models') {
    try {
      const models = await listModels({ ...target, signal: controller.signal });
      json(res, 200, { ok: true, models });
    } catch (e) {
      json(res, 200, { ok: false, code: e.code || 'network', error: e.message || String(e) });
    }
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(),
  });
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

  try {
    const result = await streamChat({
      ...target,
      system: String(body.system || ''),
      messages: Array.isArray(body.messages) ? body.messages : [],
      signal: controller.signal,
      onEvent: (e) => {
        if (e.type === 'text') send('delta', { text: e.text });
        else if (e.type === 'reasoning') send('reasoning', { text: e.text });
        else send(e.type === 'notice' ? 'notice' : 'status', { message: e.text });
      },
    });
    send('done', { usage: result.usage || null, provider: result.provider, model: result.model });
  } catch (e) {
    send('error', { message: e.message || String(e), code: e.code || 'network', hints: e.hints || [] });
  }
  res.end();
}

function handleStatic(req, res) {
  if (!STATIC_DIR) { json(res, 404, { error: { message: 'Not found.' } }); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, 405, { error: { message: 'Method not allowed.' } }); return; }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { json(res, 400, { error: { message: 'Bad path.' } }); return; }
  const file = path.resolve(STATIC_DIR, `.${rel}`);
  if (file !== STATIC_DIR && !file.startsWith(STATIC_DIR + path.sep)) { json(res, 403, { error: { message: 'Forbidden.' } }); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      // Directory URLs need a trailing slash so relative links inside the page resolve correctly.
      if (!rel.endsWith('/')) { res.writeHead(301, { Location: `${rel}/` }); res.end(); return; }
      const index = path.join(file, 'index.html');
      if (fs.existsSync(index)) { stream(index); return; }
      json(res, 404, { error: { message: 'No index.html in this folder.' } });
      return;
    }
    if (err || !st.isFile()) { json(res, 404, { error: { message: 'Not found.' } }); return; }
    stream(file);
  });
  function stream(f) {
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(f).pipe(res);
  }
}

const server = http.createServer((req, res) => {
  if (!ALLOW_REMOTE && !isLoopback(req.socket.remoteAddress)) {
    json(res, 403, { error: { message: 'This relay only answers requests from this computer (start it with --allow-remote to change that).' } });
    return;
  }
  const pathname = (req.url || '/').split('?')[0];
  if (pathname === RELAY_PATH) {
    handleRelay(req, res).catch((e) => { try { json(res, 500, { error: { message: e.message } }); } catch { /* headers sent */ } });
    return;
  }
  handleStatic(req, res);
});

server.listen(PORT, HOST, () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  console.log(`ai-agent-drawer relay listening on http://${HOST}:${PORT}${RELAY_PATH}`);
  if (STATIC_DIR) console.log(`serving static files from ${STATIC_DIR}  ->  http://${HOST}:${PORT}/`);
  const keys = Object.values(PROVIDERS).filter((p) => p.keyEnv && process.env[p.keyEnv]).map((p) => p.label);
  console.log(`server-side keys: ${keys.length ? keys.join(', ') : 'none (users type keys in Settings)'}`);
  console.log(`runtime: ${path.relative(process.cwd(), path.resolve(here, '../ai-agent')) || '.'}`);
});
