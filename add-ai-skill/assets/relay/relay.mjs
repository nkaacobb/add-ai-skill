#!/usr/bin/env node
// ai-agent-drawer — Node relay 1.1 (and optional static file server). Zero dependencies; Node 18+.
//
//   node relay.mjs [--port 8787] [--host 127.0.0.1] [--path /ai-relay] [--static <dir>] [--config <file>]
//                  [--allow-remote] [--allow-any-upstream] [--cors <origin>]
//
// Why a relay: some providers refuse direct browser calls (CORS), keys are better kept on a server, and a deployed
// app should not ship keys to every visitor. The browser POSTs the chat to this endpoint; the relay calls the
// provider with the SAME adapters the browser uses (imported from ../ai-agent) and streams the reply back as
// Server-Sent Events. Same contract, modes and configuration keys as relay.php:
//
//   local  (default) Only requests from this computer (--allow-remote to change). The user's provider, model and key.
//   public Anyone who can load the app. Only the configured preset (provider, models, server key); visitor keys are
//          ignored; same-origin enforced (X-Requested-With, Origin, Sec-Fetch-Site; no CORS headers); per-visitor
//          and site-wide rate limits; body/message/token caps; generic errors for visitors.
//
// Tools (1.2): the request may carry `tools` and `toolTurns` (neutral formats, ../ai-agent/core/tools.js); the relay
// passes them to the provider and streams the model's calls back as `tool_call` events. Tools run in the browser.
// A public relay counts one question per chain of tool steps (`turnId`), up to limits.maxToolSteps.
//
// Configuration (optional): the first of --config <file>, $AIA_RELAY_CONFIG, $AIA_RELAY_DIR/relay.config.{mjs,json},
// relay.config.{mjs,json} next to this file. A .json file or an .mjs module with `export default { … }`, using the
// keys of relay.config.example.php. The static server never serves files named relay.config.*.
// Keys: environment variables (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY,
// OPENROUTER_API_KEY), then the config's `keys`, then (local mode only) the key the user typed.
//
// --static <dir> also serves that folder, so `node assets/relay/relay.mjs --static .` from the skill folder runs the
// Hello World example at http://127.0.0.1:8787/examples/hello-world/ with the relay on the same origin.
//
// When copying this file into an application, keep the import paths below pointing at the app's copy of ai-agent/.
// To embed the relay in your own server: `const relay = createRelay(await loadConfig()); relay.handle(req, res)`.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { streamChat, listModels } from '../ai-agent/core/client.js';
import { PROVIDERS, provider, isLocalUrl } from '../ai-agent/core/providers.js';
import { sanitizeSettings } from '../ai-agent/core/settings.js';

export const RELAY_VERSION = '1.2.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A refusal with its HTTP status and the drawer's error code; `detail` only reaches requests from this computer. */
export class RelayError extends Error {
  constructor(status, code, message, { detail = '', headers = {} } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }

  static misconfigured(detail) {
    return new RelayError(503, 'refused', 'The assistant is not available right now.', { detail });
  }
}

/* ------------------------------------------------------------------------------------------------ config */

export function configDefaults(mode = 'local') {
  const pub = mode === 'public';
  return {
    mode,
    allowRemote: false,
    authorize: null,            // (req) => true | string   (.mjs configs only)
    preset: null,
    keys: {},
    allowedOrigins: [],
    dataDir: '',
    timeout: 300,
    keepalive: 15,
    allowAnyUpstream: false,
    limits: {
      perMinute: pub ? 6 : 0,
      perDay: pub ? 100 : 0,
      siteDaily: pub ? 1000 : 0,
      maxBodyBytes: pub ? 512 * 1024 : 4 * 1024 * 1024,
      maxMessages: pub ? 40 : 400,
      maxOutputTokens: pub ? 4096 : 64000,
      maxTools: 64,
      maxToolSteps: pub ? 10 : 30,
    },
  };
}

function normalizePreset(p) {
  if (!p || typeof p !== 'object' || !PROVIDERS[p.provider]) return null;
  const models = (Array.isArray(p.models) ? p.models : []).map(String).filter(Boolean);
  const model = String(p.model || models[0] || '');
  if (model && !models.includes(model)) models.unshift(model);
  return { provider: p.provider, models, model, baseUrl: String(p.baseUrl || '').trim() };
}

export function normalizeConfig(raw = {}, source = '') {
  const mode = raw.mode === 'public' ? 'public' : 'local';
  const d = configDefaults(mode);
  const cfg = { ...d };
  for (const k of Object.keys(d)) if (raw[k] !== undefined && k !== 'limits') cfg[k] = raw[k];
  cfg.limits = { ...d.limits };
  for (const k of Object.keys(d.limits)) if (raw.limits?.[k] !== undefined) cfg.limits[k] = Math.max(0, Math.floor(Number(raw.limits[k]) || 0));
  cfg.keys = cfg.keys && typeof cfg.keys === 'object' ? cfg.keys : {};
  cfg.allowedOrigins = (Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : []).map(String).filter(Boolean);
  cfg.timeout = Math.max(10, Math.min(900, Number(cfg.timeout) || 300));
  cfg.keepalive = Math.max(1, Number(cfg.keepalive) || 15);
  cfg.preset = normalizePreset(cfg.preset);
  if (cfg.authorize !== null && typeof cfg.authorize !== 'function') throw RelayError.misconfigured('"authorize" must be a function.');
  cfg.source = source;
  return cfg;
}

/** Find and read the configuration (see the header). Returns the defaults when there is none. */
export async function loadConfig({ file = '', env = process.env } = {}) {
  const candidates = [];
  const explicit = file || env.AIA_RELAY_CONFIG || '';
  if (explicit) candidates.push([path.resolve(explicit), true]);
  if (env.AIA_RELAY_DIR) for (const n of ['relay.config.mjs', 'relay.config.json']) candidates.push([path.join(env.AIA_RELAY_DIR, n), false]);
  for (const n of ['relay.config.mjs', 'relay.config.json']) candidates.push([path.join(HERE, n), false]);
  for (const [f, required] of candidates) {
    if (!fs.existsSync(f)) {
      if (required) throw RelayError.misconfigured(`The relay config ${f} does not exist.`);
      continue;
    }
    let raw;
    if (/\.json$/i.test(f)) raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    else if (/\.m?js$/i.test(f)) raw = (await import(pathToFileURL(f).href)).default;
    else throw RelayError.misconfigured(`The relay config must be .json or .mjs: ${f}`);
    if (!raw || typeof raw !== 'object') throw RelayError.misconfigured(`${f} must contain an object.`);
    return normalizeConfig(raw, f);
  }
  return normalizeConfig({}, '');
}

export function publicProblem(cfg, env = process.env) {
  const p = cfg.preset;
  if (!p) return `Public mode needs a "preset" with a known provider${cfg.source ? ` in ${cfg.source}` : ''}.`;
  const cat = provider(p.provider);
  if (cat.kind === 'cloud' && !serverKey(p.provider, cfg, env)) return `Public mode: no key for ${p.provider}. Set ${cat.keyEnv} or "keys" in the config.`;
  if (!p.model && cat.modelRequired) return 'Public mode: the preset needs "models" (the first is the default).';
  return '';
}

export function serverKey(id, cfg, env = process.env) {
  const p = provider(id);
  return (p.keyEnv && env[p.keyEnv]) || (typeof cfg.keys?.[id] === 'string' ? cfg.keys[id].trim() : '');
}

/* --------------------------------------------------------------------------------------- request checks */

const FORWARD_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip'];

/** From this computer, and not through a proxy (a proxied request is not local even if the proxy is). */
export function isLocalRequest(req) {
  if (FORWARD_HEADERS.some((h) => req.headers[h])) return false;
  return /^(127\.|::1$|::ffff:127\.)/.test(String(req.socket?.remoteAddress || ''));
}

function authority(host, scheme) {
  const h = String(host || '').toLowerCase().trim();
  const def = scheme === 'https' ? ':443' : ':80';
  return h.endsWith(def) ? h.slice(0, -def.length) : h;
}

function checkSameOrigin(req, cfg) {
  const refuse = (detail) => new RelayError(403, 'refused', 'This assistant only answers pages of the site it runs on.', { detail });
  if (req.headers['x-requested-with'] !== 'ai-agent-drawer') {
    throw new RelayError(403, 'refused', 'Requests must come from the application\'s own pages.', { detail: 'Missing the X-Requested-With: ai-agent-drawer header.' });
  }
  const origin = String(req.headers.origin || '').replace(/\/+$/, '');
  let u = null;
  try { u = new URL(origin); } catch { /* refused below */ }
  if (!u || !/^https?:$/.test(u.protocol)) throw new RelayError(403, 'refused', 'Requests must come from the application\'s own pages.', { detail: 'Missing or malformed Origin header.' });
  const scheme = u.protocol.slice(0, -1);
  const listed = cfg.allowedOrigins.some((o) => o.replace(/\/+$/, '').toLowerCase() === origin.toLowerCase());
  if (authority(u.host, scheme) !== authority(req.headers.host, scheme) && !listed) throw refuse(`Origin ${origin} is not this host (${req.headers.host}) and not in allowedOrigins.`);
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site && site !== 'same-origin' && !listed) throw refuse(`Sec-Fetch-Site: ${site}`);
}

async function authorize(req, cfg) {
  if (!cfg.authorize) return;
  const r = await cfg.authorize(req);
  if (r === true) return;
  throw new RelayError(403, 'refused', typeof r === 'string' && r ? r : 'Sign in to use the assistant.');
}

/** IPv4 as is; IPv6 by its /64 network (one household or device usually owns a whole /64). */
export function addressKey(addr) {
  let a = String(addr || '').toLowerCase();
  if (a.startsWith('::ffff:') && a.includes('.')) return a.slice(7);
  if (!a.includes(':')) return a;
  if (a.includes('%')) a = a.slice(0, a.indexOf('%'));
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => x.padStart(4, '0')).join(':')}::/64`;
}

/**
 * Per-visitor (minute, day) and site-wide (day) limits. Visitors are salted hashes whose salt changes every UTC day:
 * no addresses and no conversation text are kept. In memory, mirrored to <dataDir>/relay-limits.json when a data
 * folder is configured (so a restart does not reset the daily caps). One process: behind a cluster, use one relay.
 */
export function createLimiter(cfg, { now = () => Date.now() } = {}) {
  const file = cfg.dataDir ? path.join(cfg.dataDir, 'relay-limits.json') : '';
  let state = null;
  if (file) {
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = null; }
  }
  const save = () => {
    if (!file) return;
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) {
      throw RelayError.misconfigured(`Cannot write ${file}: ${e.message}`);
    }
  };
  return {
    /** Count a question. A request that continues the visitor's current question (same turnId, tool steps left) is free. */
    hit(addr, { turn = '', continuation = false } = {}) {
      const l = cfg.limits;
      if (!(l.perMinute > 0 || l.perDay > 0 || l.siteDaily > 0)) return;
      const t = Math.floor(now() / 1000);
      const day = new Date(t * 1000).toISOString().slice(0, 10);
      if (!state || state.day !== day || typeof state.salt !== 'string') state = { day, salt: crypto.randomBytes(16).toString('hex'), site: 0, visitors: {} };
      const id = crypto.createHmac('sha256', state.salt).update(addressKey(addr)).digest('hex').slice(0, 20);
      let [start, inWindow, today, activeTurn = '', steps = 0] = state.visitors[id] || [0, 0, 0];
      const turnHash = turn ? crypto.createHmac('sha256', state.salt).update(String(turn)).digest('hex').slice(0, 12) : '';
      if (continuation && turnHash && turnHash === activeTurn && steps < (l.maxToolSteps || 10)) {
        state.visitors[id] = [start, inWindow, today, activeTurn, steps + 1];
        save();
        return;
      }
      if (t - start >= 60) { start = t; inWindow = 0; }
      const tomorrow = Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000) / 1000) - t;
      if (l.siteDaily > 0 && state.site >= l.siteDaily) throw new RelayError(429, 'rate-limit', 'The assistant has reached its limit for today. Please try again tomorrow.', { detail: 'siteDaily reached', headers: { 'Retry-After': String(tomorrow) } });
      if (l.perDay > 0 && today >= l.perDay) throw new RelayError(429, 'rate-limit', `You have reached today's limit of ${l.perDay} questions. Please try again tomorrow.`, { headers: { 'Retry-After': String(tomorrow) } });
      if (l.perMinute > 0 && inWindow >= l.perMinute) {
        const wait = Math.max(1, 60 - (t - start));
        throw new RelayError(429, 'rate-limit', `Too many questions in a row (limit ${l.perMinute} per minute). Try again in ${wait} s.`, { headers: { 'Retry-After': String(wait) } });
      }
      state.visitors[id] = [start, inWindow + 1, today + 1, turnHash, 0];
      state.site += 1;
      save();
    },
  };
}

/* ------------------------------------------------------------------------------------------ the relay */

const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Tools and the tool exchange from a request, checked and trimmed to the neutral formats. */
function toolsFrom(body, cfg) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const turns = Array.isArray(body.toolTurns) ? body.toolTurns : [];
  if (tools.length > cfg.limits.maxTools) throw new RelayError(413, 'budget', `Too many tools in one request (${tools.length}, limit ${cfg.limits.maxTools}).`);
  if (turns.length > cfg.limits.maxToolSteps) throw new RelayError(413, 'budget', `Too many tool steps for one question (limit ${cfg.limits.maxToolSteps}). Ask again to continue.`);
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  const cleanTools = tools.map((t) => {
    if (!t || !TOOL_NAME.test(String(t.name || ''))) throw new RelayError(400, 'malformed', 'A tool has an invalid name.');
    const parameters = obj(t.parameters);
    return { name: t.name, description: String(t.description || '').slice(0, 2000), parameters: { type: 'object', properties: obj(parameters.properties), ...(Array.isArray(parameters.required) ? { required: parameters.required.map(String) } : {}) } };
  });
  const cleanTurns = turns.map((t) => ({
    text: String(t?.text || ''),
    calls: (Array.isArray(t?.calls) ? t.calls : []).filter((c) => TOOL_NAME.test(String(c?.name || ''))).map((c) => ({ id: String(c.id || '').slice(0, 128), name: c.name, arguments: obj(c.arguments), ...(c.signature ? { signature: String(c.signature) } : {}) })),
    results: (Array.isArray(t?.results) ? t.results : []).map((r) => ({ id: String(r?.id || '').slice(0, 128), name: String(r?.name || ''), content: String(r?.content ?? '').slice(0, 100000) })),
  }));
  return { tools: cleanTools, toolTurns: cleanTurns };
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const tooLarge = () => new RelayError(413, 'budget', 'The request is too large for the assistant. Lower "Max screen content" or "Conversation memory" in Settings > Agent.');
    if (max > 0 && Number(req.headers['content-length']) > max) { reject(tooLarge()); req.resume(); return; }
    req.on('data', (c) => {
      size += c.length;
      if (max > 0 && size > max) { reject(tooLarge()); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * The relay handler for one configuration.
 * @param {object} cfg  normalizeConfig() / loadConfig() result
 * @param {object} [o]
 * @param {string} [o.cors]   local mode only: an origin allowed to call the relay cross-origin
 * @param {(req) => boolean} [o.isLocal]   override the "from this computer" test (tests)
 * @param {object} [o.env]    where keys are read from (default process.env)
 */
export function createRelay(cfg, { cors = '', isLocal = isLocalRequest, env = process.env, now } = {}) {
  const pub = cfg.mode === 'public';
  const limiter = createLimiter(cfg, now ? { now } : {});
  const corsHeaders = () => (cors && !pub ? { 'Access-Control-Allow-Origin': cors, 'Access-Control-Allow-Headers': 'Content-Type, X-Requested-With', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' } : {});

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...corsHeaders(), ...headers });
    res.end(JSON.stringify(body));
  };

  function info(req, res) {
    const local = isLocal(req);
    const base = { ok: true, relay: 'ai-agent-drawer', version: RELAY_VERSION, mode: cfg.mode };
    const unavailable = (reason, detail = '') => json(res, 200, { ...base, available: false, providers: [], serverKeys: {}, preset: null, reason, ...(local && detail ? { detail } : {}) });
    if (!pub && !cfg.allowRemote && !local) return unavailable('This relay only answers requests from the computer it runs on.');
    if (pub) {
      const problem = publicProblem(cfg, env);
      if (problem) { console.error(`[ai-agent relay] ${problem}`); return unavailable('The assistant is not available right now.', problem); }
      const p = cfg.preset;
      return json(res, 200, { ...base, available: true, providers: [p.provider], serverKeys: { [p.provider]: true }, preset: { provider: p.provider, model: p.model, models: p.models }, limits: { perMinute: cfg.limits.perMinute, perDay: cfg.limits.perDay } });
    }
    const serverKeys = Object.fromEntries(Object.values(PROVIDERS).filter((p) => p.keyEnv).map((p) => [p.id, !!serverKey(p.id, cfg, env)]));
    const preset = cfg.preset ? { provider: cfg.preset.provider, model: cfg.preset.model, models: cfg.preset.models } : null;
    return json(res, 200, { ...base, available: true, providers: Object.keys(PROVIDERS), serverKeys, preset });
  }

  /** Which provider, address, model and key a request may use -> shared-client settings. */
  function target(body, forListing = false) {
    const id = String(body.provider || '');
    if (!PROVIDERS[id]) throw new RelayError(400, 'refused', `Unknown provider "${id.slice(0, 40)}".`);
    const p = provider(id);
    const wantedModel = String(body.model || '').trim();
    let baseUrl = p.baseUrl;
    let model = wantedModel;
    let key;
    if (pub) {
      const problem = publicProblem(cfg, env);
      if (problem) throw RelayError.misconfigured(problem);
      const preset = cfg.preset;
      if (id !== preset.provider) throw new RelayError(400, 'refused', `This assistant only offers ${provider(preset.provider).label}. Choose it in Settings > Model.`);
      model = wantedModel || preset.model;
      if (!forListing && preset.models.length && !preset.models.includes(model)) {
        throw new RelayError(400, 'missing-model', `This assistant only offers ${preset.models.length === 1 ? 'the model ' : 'these models: '}${preset.models.join(', ')}. Choose it in Settings > Model.`);
      }
      if (preset.baseUrl) baseUrl = preset.baseUrl;
      key = serverKey(id, cfg, env);                      // visitor keys are never forwarded
    } else {
      if (cfg.preset?.provider === id && cfg.preset.baseUrl) baseUrl = cfg.preset.baseUrl;
      const wanted = String(body.baseUrl || '').trim();
      if (wanted && p.kind !== 'cloud') {
        if (!/^https?:\/\//i.test(wanted)) throw new RelayError(400, 'bad-endpoint', 'The server address must start with http:// or https://.');
        if (!cfg.allowAnyUpstream && !isLocalUrl(wanted)) throw new RelayError(400, 'refused', `The relay only forwards ${p.label} requests to local/private addresses (allowAnyUpstream / --allow-any-upstream).`);
        baseUrl = wanted;
      }
      key = String(body.apiKey || '').trim() || serverKey(id, cfg, env);
    }
    const cap = cfg.limits.maxOutputTokens > 0 ? cfg.limits.maxOutputTokens : 64000;
    const maxTokens = Number.isInteger(body.maxTokens) ? Math.max(64, Math.min(cap, body.maxTokens)) : Math.min(cap, 2048);
    const settings = sanitizeSettings({
      provider: id,
      profiles: { [id]: { baseUrl, model } },
      transport: 'direct',
      reasoning: body.reasoning,
      maxOutputTokens: maxTokens,
      temperature: typeof body.temperature === 'number' ? Math.max(0, Math.min(2, body.temperature)) : undefined,
      timeoutSec: cfg.timeout,
    });
    return { settings, keyFor: () => key, label: p.label, kind: p.kind };
  }

  async function handle(req, res) {
    const local = isLocal(req);
    let streaming = false;
    let keepalive = null;
    const send = (event, data) => { if (!res.writableEnded) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); last = Date.now(); } };
    let last = Date.now();
    const fail = (e) => {
      const err = e instanceof RelayError ? e : new RelayError(500, 'network', 'The relay failed.', { detail: String(e?.message || e) });
      if (err.detail && err.status >= 500) console.error(`[ai-agent relay] ${err.detail}`);
      const error = { message: err.message, code: err.code, ...(local && err.detail && err.detail !== err.message ? { detail: err.detail } : {}) };
      if (streaming || res.headersSent) { send('error', error); res.end(); } else json(res, err.status, { ok: false, error }, err.headers);
    };
    try {
      if (req.method === 'OPTIONS' && !pub && cors) { res.writeHead(204, corsHeaders()); res.end(); return; }
      if (req.method === 'GET' || req.method === 'HEAD') { info(req, res); return; }
      if (req.method !== 'POST') throw new RelayError(405, 'bad-endpoint', 'Use POST.', { headers: { Allow: 'GET, POST' } });
      if (!pub && !cfg.allowRemote && !local) throw new RelayError(403, 'refused', 'This relay only answers requests from the computer it runs on (start it with --allow-remote to change that).');
      if (pub) checkSameOrigin(req, cfg);
      await authorize(req, cfg);

      let body;
      const raw = await readBody(req, cfg.limits.maxBodyBytes);
      try { body = JSON.parse(raw); } catch { throw new RelayError(400, 'malformed', 'The request body was not valid JSON.'); }
      if (!body || typeof body !== 'object') throw new RelayError(400, 'malformed', 'The request body was not valid JSON.');

      const listing = body.action === 'models';
      const t = target(body, listing);
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(); });

      if (listing) {
        if (pub) { json(res, 200, { ok: true, models: cfg.preset.models.map((id) => ({ id, label: id, loaded: false })) }); return; }
        try {
          const models = await listModels({ settings: t.settings, keyFor: t.keyFor, signal: controller.signal });
          json(res, 200, { ok: true, models });
        } catch (e) {
          json(res, 200, { ok: false, code: e.code || 'network', error: e.message || String(e) });
        }
        return;
      }

      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (cfg.limits.maxMessages > 0 && messages.length > cfg.limits.maxMessages) {
        throw new RelayError(413, 'budget', `This conversation is too long for the assistant (${messages.length} messages, limit ${cfg.limits.maxMessages}). Start a new chat, or lower "Conversation memory" in Settings > Agent.`);
      }
      const { tools, toolTurns } = toolsFrom(body, cfg);
      if (pub) limiter.hit(req.socket?.remoteAddress, { turn: String(body.turnId || '').slice(0, 64), continuation: toolTurns.length > 0 });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
        ...corsHeaders(),
      });
      streaming = true;
      res.write(': open\n\n');
      // Keepalive comments while the model is silent (thinking), so proxies keep the stream open.
      const every = cfg.keepalive * 1000;
      keepalive = setInterval(() => { if (Date.now() - last >= every && !res.writableEnded) { res.write(': keepalive\n\n'); last = Date.now(); } }, Math.min(1000, every));

      try {
        const result = await streamChat({
          settings: t.settings,
          keyFor: t.keyFor,
          system: String(body.system || ''),
          messages,
          tools,
          toolTurns,
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === 'text') send('delta', { text: e.text });
            else if (e.type === 'reasoning') send('reasoning', { text: e.text });
            else send(e.type === 'notice' ? 'notice' : 'status', { message: e.text });
          },
        });
        for (const c of result.toolCalls || []) send('tool_call', { id: c.id, name: c.name, arguments: c.arguments || {}, ...(c.signature ? { signature: c.signature } : {}) });
        send('done', { usage: result.usage || null, provider: result.provider, model: result.model });
        res.end();
      } catch (e) {
        if (controller.signal.aborted) { res.end(); return; }
        const full = `${t.label}: ${e.message || e}`;
        if (!pub) throw new RelayError(502, e.code || 'network', e.message || String(e), { detail: '' });
        if (e.code === 'auth') throw RelayError.misconfigured(full);
        const msg = e.code === 'rate-limit' ? 'The model provider is busy. Please try again in a moment.' : 'The model could not answer right now. Please try again.';
        throw new RelayError(502, e.code === 'missing-model' ? 'refused' : (e.code || 'network'), msg, { detail: full });
      }
    } catch (e) {
      fail(e);
    } finally {
      clearInterval(keepalive);
    }
  }

  return { handle, info, limiter, config: cfg };
}

/* ------------------------------------------------------------------------------------------ static files */

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.ts': 'text/plain; charset=utf-8',
};

export function createStaticHandler(dir) {
  const root = path.resolve(dir);
  const send404 = (res) => { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: { message: 'Not found.' } })); };
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); res.end(); return; }
    const file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    // Never serve relay configuration (it may hold keys) or dotfiles (.git, .env…).
    if (rel.split('/').some((part) => part.startsWith('.') && part.length > 1) || /(^|\/)relay\.config\.[^/]*$/i.test(rel)) { send404(res); return; }
    fs.stat(file, (err, st) => {
      if (!err && st.isDirectory()) {
        // Directory URLs need a trailing slash so relative links inside the page resolve correctly.
        if (!rel.endsWith('/')) { res.writeHead(301, { Location: `${rel}/` }); res.end(); return; }
        const index = path.join(file, 'index.html');
        if (fs.existsSync(index)) { stream(index); return; }
        send404(res);
        return;
      }
      if (err || !st.isFile()) { send404(res); return; }
      stream(file);
    });
    function stream(f) {
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(f).pipe(res);
    }
  };
}

/* ------------------------------------------------------------------------------------------------- CLI */

async function main(argv) {
  const flag = (name) => argv.includes(`--${name}`);
  const opt = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const port = Number(opt('port', process.env.AI_RELAY_PORT || 8787));
  const host = opt('host', process.env.AI_RELAY_HOST || '127.0.0.1');
  const relayPath = opt('path', '/ai-relay');
  const staticDir = opt('static', '') ? path.resolve(opt('static', '')) : '';
  const cors = opt('cors', '');

  const cfg = await loadConfig({ file: opt('config', '') });
  if (flag('allow-remote')) cfg.allowRemote = true;
  if (flag('allow-any-upstream')) cfg.allowAnyUpstream = true;
  if (cfg.mode === 'public' && cors) console.warn('--cors is ignored in public mode (the relay only answers its own pages).');
  const relay = createRelay(cfg, { cors });
  const serveStatic = staticDir ? createStaticHandler(staticDir) : null;

  const server = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === relayPath) {
      relay.handle(req, res).catch((e) => { try { res.writeHead(500); res.end(String(e?.message || e)); } catch { /* headers sent */ } });
      return;
    }
    if (!serveStatic) { res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: { message: 'Not found.' } })); return; }
    if (cfg.mode === 'local' && !cfg.allowRemote && !isLocalRequest(req)) { res.writeHead(403); res.end('This server only answers requests from this computer.'); return; }
    serveStatic(req, res);
  });

  server.listen(port, host, () => {
    console.log(`ai-agent-drawer relay ${RELAY_VERSION} (${cfg.mode} mode) listening on http://${host}:${port}${relayPath}`);
    if (cfg.source) console.log(`config: ${cfg.source}`);
    if (staticDir) console.log(`serving static files from ${staticDir}  ->  http://${host}:${port}/`);
    if (cfg.mode === 'public') {
      const problem = publicProblem(cfg);
      console.log(problem ? `NOT READY: ${problem}` : `preset: ${cfg.preset.provider} · ${cfg.preset.models.join(', ') || 'any model'}`);
    } else {
      const keys = Object.values(PROVIDERS).filter((p) => p.keyEnv && serverKey(p.id, cfg)).map((p) => p.label);
      console.log(`server-side keys: ${keys.length ? keys.join(', ') : 'none (users type keys in Settings)'}`);
    }
    console.log(`runtime: ${path.relative(process.cwd(), path.resolve(HERE, '../ai-agent')) || '.'}`);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).catch((e) => { console.error(e?.detail || e?.message || e); process.exit(1); });
