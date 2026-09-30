// Anthropic Messages API.
//   POST {base}/v1/messages  headers x-api-key, anthropic-version: 2023-06-01,
//        anthropic-dangerous-direct-browser-access: true (required for calls made straight from a browser)
//   body { model, max_tokens (required), system, messages (user-first, alternating), stream,
//          thinking:{type:'disabled'} when reasoning is off }. Temperature is not sent: current models only accept
//          the default.
//   stream events: content_block_delta {delta:{type:'text_delta',text} | {type:'thinking_delta',thinking}},
//                  message_delta {usage}, error {error:{message}}
//   models: GET {base}/v1/models -> { data:[{ id, display_name }] }
//   tools: body.tools [{name, description, input_schema}]; the reply streams content_block_start {type:'tool_use',
//   id, name} + input_json_delta pieces; the exchange goes back as an assistant message with tool_use blocks and a
//   user message with tool_result blocks.

import { requestJson, requestStream, joinUrl, AiError } from '../core/transport.js';
import { normalizeMessages } from '../core/messages.js';
import { parseArguments } from '../core/tools.js';

const VERSION = '2023-06-01';
const headers = (key) => ({ 'x-api-key': key || '', 'anthropic-version': VERSION, 'anthropic-dangerous-direct-browser-access': 'true' });

/** The current question's tool exchange, as Messages API turns. */
export function toolTurnMessages(toolTurns = []) {
  const out = [];
  for (const turn of toolTurns) {
    out.push({
      role: 'assistant',
      content: [
        ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
        ...turn.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments || {} })),
      ],
    });
    out.push({ role: 'user', content: turn.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: String(r.content ?? '') })) });
  }
  return out;
}

export function buildChat({ cfg, key, system, messages, maxTokens, stream = true, tools, toolTurns }) {
  const body = {
    model: cfg.model,
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : 2048,
    messages: [...normalizeMessages(messages), ...toolTurnMessages(toolTurns)],
    stream,
  };
  if (tools?.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  if (system) body.system = system;
  if (cfg.reasoning === 'off') body.thinking = { type: 'disabled' };
  return { url: joinUrl(cfg.baseUrl, '/v1/messages'), headers: headers(key), body };
}

export function parseEvent(json) {
  if (json?.type === 'error' || json?.error) {
    throw new AiError(json.error?.type === 'overloaded_error' ? 'rate-limit' : 'refused', json.error?.message || 'Anthropic returned an error.');
  }
  if (json?.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
    return [{ type: 'tool', index: json.index, id: json.content_block.id || '', name: json.content_block.name || '', args: '' }];
  }
  if (json?.type !== 'content_block_delta') return [];
  const d = json.delta || {};
  if (d.type === 'text_delta' && d.text) return [{ type: 'text', text: d.text }];
  if (d.type === 'thinking_delta' && d.thinking) return [{ type: 'reasoning', text: d.thinking }];
  if (d.type === 'input_json_delta') return [{ type: 'tool', index: json.index, id: '', name: '', args: d.partial_json || '' }];
  return [];
}

export function parseFull(json) {
  if (!json || !Array.isArray(json.content)) throw new AiError('malformed', 'The Anthropic reply had no content.');
  const text = json.content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
  const reasoning = json.content.filter((b) => b?.type === 'thinking').map((b) => b.thinking).join('\n');
  if (!text && json.stop_reason === 'refusal') throw new AiError('refused', 'The model declined to answer.');
  const toolCalls = json.content.filter((b) => b?.type === 'tool_use' && b.name).map((b) => ({ id: b.id, name: b.name, arguments: parseArguments(b.input) }));
  return { text, reasoning, usage: { input: json.usage?.input_tokens, output: json.usage?.output_tokens }, toolCalls };
}

export function parseModels(json) {
  return (Array.isArray(json?.data) ? json.data : []).filter((m) => m && typeof m.id === 'string')
    .map((m) => ({ id: m.id, label: m.display_name || m.id, loaded: false }));
}

export const anthropic = {
  protocol: 'anthropic-messages',

  async stream({ cfg, key, system, messages, maxTokens, signal, onEvent, fetch, tools, toolTurns }) {
    if (!cfg.model) throw new AiError('missing-model', 'Choose an Anthropic model in Settings (try "Load models").');
    const r = buildChat({ cfg, key, system, messages, maxTokens, stream: true, tools, toolTurns });
    const usage = {};
    const calls = new Map();
    const res = await requestStream({ ...r, signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch }, ({ data }) => {
      let json;
      try { json = JSON.parse(data); } catch { return; }
      if (json.type === 'message_start') usage.input = json.message?.usage?.input_tokens;
      if (json.type === 'message_delta' && json.usage) usage.output = json.usage.output_tokens;
      for (const f of parseEvent(json)) {
        if (f.type !== 'tool') { onEvent(f); continue; }
        const cur = calls.get(f.index) || { id: '', name: '', args: '' };
        if (f.id) cur.id = f.id;
        if (f.name) cur.name = f.name;
        cur.args += f.args;
        calls.set(f.index, cur);
      }
    });
    if (!res.streamed) {
      const full = parseFull(res.json);
      if (full.reasoning) onEvent({ type: 'reasoning', text: full.reasoning });
      if (full.text) onEvent({ type: 'text', text: full.text });
      return { usage: full.usage, toolCalls: full.toolCalls };
    }
    const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).filter(([, c]) => c.name)
      .map(([i, c]) => ({ id: c.id || `toolu_${i}`, name: c.name, arguments: parseArguments(c.args) }));
    return { usage, toolCalls };
  },

  async listModels({ cfg, key, signal, fetch }) {
    return parseModels(await requestJson({ url: joinUrl(cfg.baseUrl, cfg.modelsPath || '/v1/models?limit=1000'), method: 'GET', headers: headers(key), signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch }));
  },
};
