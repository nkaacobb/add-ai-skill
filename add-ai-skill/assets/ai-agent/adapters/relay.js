// App relay: the browser talks to the application's own server, which calls the provider.
// Use it when the provider refuses direct browser calls (CORS), when keys must stay on the server, or when the app
// is deployed beyond localhost. Reference servers: assets/relay/relay.php and assets/relay/relay.mjs.
//
// Contract
//   POST {relayUrl}  JSON { action:'chat', provider, baseUrl, model, apiKey, system, messages:[{role,content,images?}],
//                           maxTokens, temperature, reasoning, tools?, toolTurns?, turnId? }
//     -> text/event-stream:  event: delta {text} | reasoning {text} | notice {message} | status {message}
//                            | tool_call {id, name, arguments, signature?}
//                            | error {message, code?, hints?} | done {usage?, provider?, model?}
//   tools / toolTurns use the neutral formats of core/tools.js; the relay translates them for the provider. The tools
//   themselves always run in the browser. `turnId` lets a public relay count one question per chain of tool steps.
//   images (1.3): user messages and tool results may carry `images: [{ mime, data }]` (core/messages.js). A relay says
//   how many it accepts per request in its GET reply (`images`; absent = a relay older than 1.3, which would drop
//   them silently), so a request with images first asks the relay once and fails clearly when it cannot pass them.
//     -> or JSON { text, reasoning?, usage? } | { error:{ message, code? } }
//   POST {relayUrl}  JSON { action:'models', provider, baseUrl, apiKey } -> { ok, models:[{id,label,loaded}], error? }
//   GET  {relayUrl}  -> { ok, relay, version, available, mode, providers, serverKeys, preset, images, reason? } (core/relay-probe.js)
//   Refusals: HTTP 4xx/5xx JSON { ok:false, error:{ message, code, detail? } } — `code` is one of the drawer's error
//   codes and `message` is written for the user; `detail` is only sent to requests from the relay's own computer.
//   The streams start with an `: open` comment and carry `: keepalive` comments while the model is silent.
// `apiKey` may be empty: the relay then uses its own key (environment variable / server config). In public mode the
// relay ignores it and uses only its configured preset.

import { requestJson, requestStream, AiError } from '../core/transport.js';
import { normalizeMessages, imageChars } from '../core/messages.js';
import { parseArguments } from '../core/tools.js';
import { probeRelay } from '../core/relay-probe.js';

// Relay address -> how many images it accepts per request (asked once, when a request first carries images).
const imageSupport = new Map();

async function checkImages(cfg, count, fetch) {
  if (!imageSupport.has(cfg.relayUrl)) {
    const info = await probeRelay(cfg.relayUrl, { headers: relayHeaders(cfg), ...(fetch ? { fetch } : {}) });
    if (!info.mode) return;                            // not reachable / not a relay: let the request report it
    imageSupport.set(cfg.relayUrl, info.images);
  }
  const max = imageSupport.get(cfg.relayUrl);
  if (!max) throw new AiError('refused', 'The relay cannot pass images to the model (it is older than version 1.3, or images are switched off in its configuration). Update the relay, or turn off "This model can see images" in Settings > Vision.');
  if (count > max) throw new AiError('budget', `The relay accepts at most ${max} image${max === 1 ? '' : 's'} per request (this one has ${count}). Remove a screenshot, or start a new chat.`);
}

const countImages = (messages, toolTurns) => (Array.isArray(messages) ? messages : []).reduce((n, m) => n + (Array.isArray(m?.images) ? m.images.length : 0), 0)
  + (Array.isArray(toolTurns) ? toolTurns : []).reduce((n, t) => n + (t.results || []).reduce((k, r) => k + (Array.isArray(r.images) ? r.images.length : 0), 0), 0);

function relayHeaders(cfg) {
  const extra = typeof cfg.relayHeaders === 'function' ? cfg.relayHeaders() : cfg.relayHeaders;
  return { 'X-Requested-With': 'ai-agent-drawer', ...(extra && typeof extra === 'object' ? extra : {}) };
}

export function buildChat({ cfg, key, system, messages, maxTokens, temperature, tools, toolTurns, turnId }) {
  const extra = {};
  if (tools?.length) extra.tools = tools;
  if (toolTurns?.length) extra.toolTurns = toolTurns;
  if (turnId) extra.turnId = String(turnId);
  return {
    url: cfg.relayUrl,
    headers: relayHeaders(cfg),
    credentials: 'same-origin',
    body: {
      action: 'chat',
      provider: cfg.provider,
      baseUrl: cfg.baseUrl,
      model: cfg.model || '',
      apiKey: key || '',
      system: system || '',
      messages: normalizeMessages(messages),
      maxTokens,
      temperature,
      reasoning: cfg.reasoning,
      ...extra,
    },
  };
}

export const relay = {
  protocol: 'relay',

  async stream({ cfg, key, system, messages, maxTokens, temperature, signal, onEvent, fetch, tools, toolTurns, turnId }) {
    if (!cfg.relayUrl) throw new AiError('bad-endpoint', 'No relay address is configured (Settings > Model > Advanced).');
    const r = buildChat({ cfg, key, system, messages, maxTokens, temperature, tools, toolTurns, turnId });
    const images = countImages(r.body.messages, toolTurns);
    if (images) await checkImages(cfg, images, fetch);
    let usage;
    const toolCalls = [];
    const res = await requestStream({ ...r, signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch, relay: true, imageBytes: imageChars(r.body.messages, toolTurns) }, ({ event, data }) => {
      let json;
      try { json = JSON.parse(data); } catch { return; }
      if (event === 'delta') onEvent({ type: 'text', text: String(json.text ?? '') });
      else if (event === 'reasoning') onEvent({ type: 'reasoning', text: String(json.text ?? '') });
      else if (event === 'notice' || event === 'status') onEvent({ type: event, text: String(json.message ?? '') });
      else if (event === 'tool_call' && json.name) toolCalls.push({ id: String(json.id || `relay_${toolCalls.length + 1}`), name: String(json.name), arguments: parseArguments(json.arguments), ...(json.signature ? { signature: String(json.signature) } : {}) });
      else if (event === 'error') throw new AiError(json.code || 'refused', `${String(json.message || 'The relay reported an error.')}${json.detail ? ` (${json.detail})` : ''}`, { hints: json.hints });
      else if (event === 'done') usage = json.usage;
    });
    if (!res.streamed) {
      const j = res.json;
      if (j.error) throw new AiError(j.error.code || 'refused', String(j.error.message || j.error));
      if (j.reasoning) onEvent({ type: 'reasoning', text: String(j.reasoning) });
      if (j.text) onEvent({ type: 'text', text: String(j.text) });
      for (const c of Array.isArray(j.toolCalls) ? j.toolCalls : []) if (c?.name) toolCalls.push({ id: String(c.id || `relay_${toolCalls.length + 1}`), name: String(c.name), arguments: parseArguments(c.arguments) });
      usage = j.usage;
    }
    return { usage, toolCalls };
  },

  async listModels({ cfg, key, signal, fetch }) {
    if (!cfg.relayUrl) throw new AiError('bad-endpoint', 'No relay address is configured.');
    const j = await requestJson({
      url: cfg.relayUrl, headers: relayHeaders(cfg), credentials: 'same-origin', signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch, relay: true,
      body: { action: 'models', provider: cfg.provider, baseUrl: cfg.baseUrl, apiKey: key || '' },
    });
    if (!j.ok) throw new AiError(j.code || 'network', String(j.error || 'The relay could not list models.'));
    return Array.isArray(j.models) ? j.models : [];
  },
};
