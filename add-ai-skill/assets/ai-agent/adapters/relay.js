// App relay: the browser talks to the application's own server, which calls the provider.
// Use it when the provider refuses direct browser calls (CORS), when keys must stay on the server, or when the app
// is deployed beyond localhost. Reference servers: assets/relay/relay.php and assets/relay/relay.mjs.
//
// Contract
//   POST {relayUrl}  JSON { action:'chat', provider, baseUrl, model, apiKey, system, messages:[{role,content}],
//                           maxTokens, temperature, reasoning }
//     -> text/event-stream:  event: delta {text} | reasoning {text} | notice {message} | status {message}
//                            | error {message, code?, hints?} | done {usage?, provider?, model?}
//     -> or JSON { text, reasoning?, usage? } | { error:{ message, code? } }
//   POST {relayUrl}  JSON { action:'models', provider, baseUrl, apiKey } -> { ok, models:[{id,label,loaded}], error? }
//   GET  {relayUrl}  -> { ok, relay, version, available, mode, providers, serverKeys, preset, reason? } (core/relay-probe.js)
//   Refusals: HTTP 4xx/5xx JSON { ok:false, error:{ message, code, detail? } } — `code` is one of the drawer's error
//   codes and `message` is written for the user; `detail` is only sent to requests from the relay's own computer.
//   The streams start with an `: open` comment and carry `: keepalive` comments while the model is silent.
// `apiKey` may be empty: the relay then uses its own key (environment variable / server config). In public mode the
// relay ignores it and uses only its configured preset.

import { requestJson, requestStream, AiError } from '../core/transport.js';
import { normalizeMessages } from '../core/messages.js';

function relayHeaders(cfg) {
  const extra = typeof cfg.relayHeaders === 'function' ? cfg.relayHeaders() : cfg.relayHeaders;
  return { 'X-Requested-With': 'ai-agent-drawer', ...(extra && typeof extra === 'object' ? extra : {}) };
}

export function buildChat({ cfg, key, system, messages, maxTokens, temperature }) {
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
    },
  };
}

export const relay = {
  protocol: 'relay',

  async stream({ cfg, key, system, messages, maxTokens, temperature, signal, onEvent, fetch }) {
    if (!cfg.relayUrl) throw new AiError('bad-endpoint', 'No relay address is configured (Settings > Model > Advanced).');
    const r = buildChat({ cfg, key, system, messages, maxTokens, temperature });
    let usage;
    const res = await requestStream({ ...r, signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch, relay: true }, ({ event, data }) => {
      let json;
      try { json = JSON.parse(data); } catch { return; }
      if (event === 'delta') onEvent({ type: 'text', text: String(json.text ?? '') });
      else if (event === 'reasoning') onEvent({ type: 'reasoning', text: String(json.text ?? '') });
      else if (event === 'notice' || event === 'status') onEvent({ type: event, text: String(json.message ?? '') });
      else if (event === 'error') throw new AiError(json.code || 'refused', `${String(json.message || 'The relay reported an error.')}${json.detail ? ` (${json.detail})` : ''}`, { hints: json.hints });
      else if (event === 'done') usage = json.usage;
    });
    if (!res.streamed) {
      const j = res.json;
      if (j.error) throw new AiError(j.error.code || 'refused', String(j.error.message || j.error));
      if (j.reasoning) onEvent({ type: 'reasoning', text: String(j.reasoning) });
      if (j.text) onEvent({ type: 'text', text: String(j.text) });
      usage = j.usage;
    }
    return { usage };
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
