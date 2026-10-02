// HTTP transport for the AI adapters: one JSON request, or one streamed (Server-Sent Events) request per call.
// Caller cancellation and an idle timeout via AbortController, request/response size caps, error classification
// into a small set of codes, and redaction so no error text ever carries a key or an auth header.
// No DOM and no storage: this file runs unchanged in browsers and in Node 18+ (the relay imports it).

export const ERROR_CODES = Object.freeze(['auth', 'missing-model', 'bad-endpoint', 'network', 'timeout',
  'rate-limit', 'refused', 'malformed', 'cancelled', 'budget']);

export const MAX_REQUEST_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class AiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AiError';
    this.code = ERROR_CODES.includes(code) ? code : 'malformed';
    if (extra.status) this.status = extra.status;
    if (extra.param) this.param = extra.param;
    this.hints = Array.isArray(extra.hints) ? extra.hints : [];
  }
  toJSON() { return { code: this.code, message: this.message, status: this.status, hints: this.hints }; }
}

/** Replace known secrets and anything that looks like a credential. */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const k of secrets) if (typeof k === 'string' && k.length >= 4) s = s.split(k).join('[redacted]');
  return s.replace(/(bearer\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{10,})/g, '[redacted]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/((?:x-api-key|x-goog-api-key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1[redacted]');
}

const MODEL_HINT = /model\b[^\n]{0,80}?\b(not[ _-]?found|does ?n[o']t exist|not exist|invalid|unknown|is not (found|supported)|not available|not loaded)|(invalid|unknown|no such) model|model_not_found|no models? loaded|models\/[\w.-]+ is not found/i;

/** Map an HTTP failure to an error code. `body` is parsed JSON or raw text. */
export function classifyHttp(status, body) {
  const err = body && typeof body === 'object' ? (typeof body.error === 'object' && body.error ? body.error : body) : {};
  const msg = typeof body === 'string' ? body : String(err.message ?? (typeof body?.error === 'string' ? body.error : '') ?? '');
  const pcode = String(err.code ?? err.type ?? err.status ?? '');
  const param = typeof err.param === 'string' ? err.param : undefined;
  const modelIssue = param === 'model' || /model_not_found/i.test(pcode) || MODEL_HINT.test(msg);
  let code;
  if (status === 401 || status === 403) code = 'auth';
  else if (status === 429) code = 'rate-limit';
  else if (status === 404 || status === 400 || status === 422) code = modelIssue ? 'missing-model' : status === 404 ? 'bad-endpoint' : 'refused';
  else if (status === 405 || status === 501) code = 'bad-endpoint';
  else if (status === 408 || status === 504) code = 'timeout';
  else if (status === 413) code = 'budget';
  else if (status >= 500) code = modelIssue ? 'missing-model' : 'network';
  else code = 'refused';
  return { code, message: msg, param };
}

const GUIDE = {
  'auth': 'The provider rejected the credentials. Check the API key in Settings.',
  'missing-model': 'The server does not have that model (or none is loaded). Pick one with "Load models" in Settings.',
  'bad-endpoint': 'That address does not offer this API. Check the base URL, the port and the provider type.',
  'rate-limit': 'The provider is rate limiting requests. Wait a moment and try again.',
  'timeout': 'The model took too long. Loading a model can be slow the first time; try again, or raise the timeout in Settings.',
  'budget': 'The request is too large. Lower "Max screen content" or "Conversation memory" in Settings.',
};

/** Human guidance for a request that never got an HTTP response. */
export function networkGuidance(url) {
  let u = null;
  try { u = new URL(url); } catch { /* keep null */ }
  const pageHttps = globalThis.location?.protocol === 'https:';
  if (u && pageHttps && u.protocol === 'http:') {
    return 'The browser blocked a plain-http request from this https page (mixed content). Serve the app over http://localhost, use an https endpoint, or switch "Send requests" to the app relay in Settings.';
  }
  const local = u && /^(localhost|127\.|\[::1\]|::1|0\.0\.0\.0)/.test(u.hostname);
  if (local) {
    return `Could not reach ${u.origin}. Is the server running on that port? For LM Studio: Developer tab > Start server, and enable CORS in its server settings. Use 127.0.0.1 rather than localhost on Windows.`;
  }
  return 'The browser could not complete the request (offline, blocked by CORS, or a wrong address). Some providers do not accept direct browser requests: switch "Send requests" to the app relay in Settings.';
}

/** Absolute http(s) URL, resolving relative ones (e.g. a same-origin relay) against the page. */
export function absoluteUrl(url) {
  const s = String(url ?? '').trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (s && globalThis.location?.href && /^https?:/i.test(globalThis.location.protocol)) {
    try { return new URL(s, globalThis.location.href).href; } catch { /* fall through */ }
  }
  throw new AiError('bad-endpoint', 'The address must start with http:// or https:// (relative addresses need a page served over http).');
}

/** Join a base URL and a path without doubling '/v1' or slashes. */
export function joinUrl(base, path) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : '/' + path;
  const m = p.match(/^\/v1(beta)?\//);
  if (m && b.endsWith(m[0].slice(0, -1))) b = b.slice(0, -(m[0].length - 1));
  return b + p;
}

function httpError(status, text, secrets, relay = false) {
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  // The app's relay reports the drawer's own error code and a message written for the user: use them as they are
  // (a relay refusing a foreign origin is not "check your API key").
  const re = relay && json && typeof json.error === 'object' ? json.error : null;
  if (re && ERROR_CODES.includes(re.code) && typeof re.message === 'string') {
    const detail = typeof re.detail === 'string' && re.detail ? ` (${redact(re.detail, secrets).slice(0, 400)})` : '';
    return new AiError(re.code, `${redact(re.message, secrets).slice(0, 600)}${detail}`, { status });
  }
  const c = classifyHttp(status, json ?? text);
  const said = c.message ? ` Server said: "${redact(c.message, secrets).slice(0, 400)}"` : '';
  const guide = GUIDE[c.code] || (status >= 500 ? 'The server reported an internal error.' : 'The request was refused.');
  return new AiError(c.code, `HTTP ${status}. ${guide}${said}`, { status, param: c.param });
}

/** Some servers answer HTTP 200 with only an error body (LM Studio for unknown path prefixes). */
function bodyError(json, status, secrets) {
  if (!json || typeof json !== 'object' || !json.error) return null;
  const msg = typeof json.error === 'string' ? json.error : json.error.message;
  if (typeof msg !== 'string') return null;
  const c = /unexpected endpoint|no route|unknown (path|url|endpoint)/i.test(msg) && !MODEL_HINT.test(msg)
    ? { code: 'bad-endpoint' } : classifyHttp(Number(json.error?.code) >= 400 ? Number(json.error.code) : 400, json);
  return new AiError(c.code, `${GUIDE[c.code] || 'The request was refused.'} Server said: "${redact(msg, secrets).slice(0, 400)}"`, { status });
}

/**
 * Incremental SSE parser (per the EventSource spec: fields `event` and `data`, blank line dispatches, `:` comments).
 * onRecord({ event, data }) receives the raw data string; it may throw to abort the stream.
 */
export function createSseParser(onRecord) {
  let buf = '';
  let event = '';
  let data = [];

  function dispatch() {
    if (data.length) onRecord({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  }

  function line(text) {
    if (text === '') { dispatch(); return; }
    if (text[0] === ':') return;
    const i = text.indexOf(':');
    const field = i < 0 ? text : text.slice(0, i);
    let value = i < 0 ? '' : text.slice(i + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }

  return {
    push(chunk) {
      buf += chunk;
      const re = /\r\n|\r|\n/g;
      let start = 0;
      let m;
      while ((m = re.exec(buf))) {
        // A lone '\r' at the very end may be the first half of '\r\n': wait for the next chunk.
        if (m[0] === '\r' && m.index === buf.length - 1) break;
        line(buf.slice(start, m.index));
        start = m.index + m[0].length;
      }
      buf = buf.slice(start);
    },
    end() {
      if (buf !== '') line(buf);
      buf = '';
      dispatch();
    },
  };
}

function prepare(o) {
  const url = absoluteUrl(o.url);
  const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
  // Attached images (screenshots) do not count against the text cap; they have their own.
  const images = Math.max(0, Number(o.imageBytes) || 0);
  if (images > MAX_IMAGE_BYTES) throw new AiError('budget', `The attached images are larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB. Remove a screenshot and try again.`);
  if (payload && payload.length - images > (o.maxRequestBytes || MAX_REQUEST_BYTES)) {
    throw new AiError('budget', `The request is larger than ${Math.round((o.maxRequestBytes || MAX_REQUEST_BYTES) / 1024)} KB. ${GUIDE.budget}`);
  }
  const init = {
    method: o.method || (payload ? 'POST' : 'GET'),
    headers: { ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(o.headers || {}) },
  };
  if (payload) init.body = payload;
  if (o.credentials) init.credentials = o.credentials;
  return { url, init };
}

/**
 * Wrap a fetch with caller cancellation and an idle timeout. The timer is re-armed with `touch()` whenever bytes
 * arrive, so a long streamed answer is never cut off while it is still flowing.
 */
function guard(o) {
  const ctl = new AbortController();
  const timeoutMs = Math.max(1, o.timeoutMs || 120000);
  let timedOut = false;
  let timer = null;
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  };
  const onAbort = () => ctl.abort();
  if (o.signal?.aborted) throw new AiError('cancelled', 'Cancelled.');
  o.signal?.addEventListener?.('abort', onAbort, { once: true });
  touch();
  const fail = (e, url) => {
    if (e instanceof AiError) return e;
    if (timedOut) return new AiError('timeout', `No response for ${Math.round(timeoutMs / 1000)} s. ${GUIDE.timeout}`);
    if (o.signal?.aborted || e?.name === 'AbortError') return new AiError('cancelled', 'Cancelled.');
    return new AiError('network', `${networkGuidance(url)} (${redact(e?.message || e, o.secrets || []).slice(0, 200)})`);
  };
  const done = () => {
    clearTimeout(timer);
    o.signal?.removeEventListener?.('abort', onAbort);
  };
  return { signal: ctl.signal, touch, fail, done };
}

/** Send one JSON request and return the parsed JSON body. Throws AiError. */
export async function requestJson(o) {
  const { url, init } = prepare(o);
  const fetchFn = o.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new AiError('network', 'No fetch implementation is available.');
  const g = guard(o);
  try {
    let res;
    try { res = await fetchFn(url, { ...init, signal: g.signal }); } catch (e) { throw g.fail(e, url); }
    let text;
    try { text = await res.text(); } catch (e) { throw g.fail(e, url); }
    if (text.length > MAX_RESPONSE_BYTES) throw new AiError('malformed', 'The response was larger than the allowed size.');
    if (!res.ok) throw httpError(res.status, text, o.secrets || [], o.relay);
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (json === null || typeof json !== 'object') throw new AiError('malformed', 'The server replied, but not with JSON.');
    const inBody = bodyError(json, res.status, o.secrets || []);
    if (inBody) throw inBody;
    return json;
  } finally {
    g.done();
  }
}

/**
 * Send one streaming request. SSE records are handed to `onRecord({event, data})` as they arrive.
 * If the server answers with plain JSON instead (it ignored `stream: true`, or a relay replied in one piece),
 * nothing is streamed and `{ streamed: false, json }` is returned so the adapter can parse it whole.
 */
export async function requestStream(o, onRecord) {
  const { url, init } = prepare(o);
  const fetchFn = o.fetch || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new AiError('network', 'No fetch implementation is available.');
  const g = guard(o);
  let reader = null;
  try {
    let res;
    try { res = await fetchFn(url, { ...init, signal: g.signal }); } catch (e) { throw g.fail(e, url); }
    g.touch();

    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch { /* keep empty */ }
      throw httpError(res.status, text.slice(0, 8000), o.secrets || [], o.relay);
    }

    const type = res.headers?.get?.('content-type') || '';
    if (!/text\/event-stream/i.test(type) || !res.body?.getReader) {
      let text;
      try { text = await res.text(); } catch (e) { throw g.fail(e, url); }
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (json === null || typeof json !== 'object') {
        // A server that streamed without the right content type: try reading it as SSE anyway.
        if (/^\s*(data|event):/m.test(text)) {
          const sse = createSseParser(onRecord);
          sse.push(text);
          sse.end();
          return { streamed: true };
        }
        throw new AiError('malformed', 'The server replied, but neither as a stream nor as JSON.');
      }
      const inBody = bodyError(json, res.status, o.secrets || []);
      if (inBody) throw inBody;
      return { streamed: false, json };
    }

    reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    const sse = createSseParser(onRecord);
    let total = 0;
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch (e) { throw g.fail(e, url); }
      if (chunk.done) break;
      g.touch();
      total += chunk.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new AiError('budget', 'The streamed reply was larger than the allowed size.');
      sse.push(decoder.decode(chunk.value, { stream: true }));
    }
    sse.push(decoder.decode());
    sse.end();
    reader = null;
    return { streamed: true };
  } finally {
    if (reader) { try { reader.cancel().catch(() => {}); } catch { /* ignore */ } }
    g.done();
  }
}
