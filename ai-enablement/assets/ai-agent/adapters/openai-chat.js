// OpenAI-compatible Chat Completions: LM Studio, Ollama, OpenAI, DeepSeek, OpenRouter and any custom server.
//   POST {base}{chatPath}  body { model?, messages[system,user,assistant…], stream, max_tokens|max_completion_tokens,
//                                 temperature?, …provider-specific "reasoning off" switch }
//   stream: `data: {choices:[{delta:{content, reasoning_content | reasoning}}]}` … `data: [DONE]`
//   models: GET {base}{modelsPath} -> { data:[{id}] }  (LM Studio native: { models:[{key, type, loaded_instances}] })
// An empty model is sent without a `model` field: LM Studio then answers with whatever model is loaded.
// Checked live against LM Studio 0.4 (reasoning arrives as `reasoning_content`).
// Tools: body.tools [{type:'function', function:{name, description, parameters}}]; the reply streams
//   delta.tool_calls [{index, id, function:{name, arguments (JSON, in pieces)}}]; the exchange goes back as an
//   assistant message with tool_calls, then one {role:'tool', tool_call_id, content} per result.
// finish_reason 'length': the reply stopped at max_tokens, so the call being written may be cut off (`truncated`).
// Images: a user message with `images` becomes content parts [{type:'text'}, {type:'image_url', image_url:{url:
//   'data:<mime>;base64,…'}}]. Tool messages are text only, so an image a tool returned (a screenshot) follows the
//   tool messages of its round in a user message. Checked live against LM Studio with a vision model.

import { requestJson, requestStream, joinUrl, AiError } from '../core/transport.js';
import { normalizeMessages, imageChars, dataUrl } from '../core/messages.js';
import { toolCall } from '../core/tools.js';

const auth = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

/** The current question's tool exchange, in chat-completions form. */
export function toolTurnMessages(toolTurns = []) {
  const out = [];
  for (const turn of toolTurns) {
    out.push({
      role: 'assistant',
      content: turn.text || '',
      tool_calls: turn.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } })),
    });
    for (const r of turn.results) out.push({ role: 'tool', tool_call_id: r.id, content: String(r.content ?? '') });
    for (const r of turn.results) {
      if (Array.isArray(r.images) && r.images.length) out.push({ role: 'user', content: withImages('[The image returned by the tool call above]', r.images) });
    }
  }
  return out;
}

/** Text plus images as chat-completions content parts. */
export function withImages(text, images) {
  return [{ type: 'text', text: text || '(image)' }, ...images.map((i) => ({ type: 'image_url', image_url: { url: dataUrl(i) } }))];
}

export function buildChat({ cfg, key, system, messages, maxTokens, temperature, stream = true, tools, toolTurns }) {
  const body = {
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...normalizeMessages(messages).map((m) => (m.images ? { role: m.role, content: withImages(m.content, m.images) } : m)),
      ...toolTurnMessages(toolTurns),
    ],
    stream,
  };
  if (tools?.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    body.tool_choice = 'auto';
  }
  if (cfg.model) body.model = cfg.model;
  if (Number.isFinite(maxTokens)) body[cfg.tokenField || 'max_tokens'] = maxTokens;
  if (Number.isFinite(temperature) && cfg.sendsTemperature !== false) body.temperature = temperature;
  if (cfg.reasoning === 'off' && cfg.reasoningOff) Object.assign(body, cfg.reasoningOff);
  return { url: joinUrl(cfg.baseUrl, cfg.chatPath || '/v1/chat/completions'), headers: auth(key), body };
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('');
  return '';
}

/** One streamed chunk -> fragments. Throws on an in-stream error object. */
export function parseChunk(json) {
  if (json?.error) {
    const msg = typeof json.error === 'string' ? json.error : json.error.message || 'The model returned an error.';
    throw new AiError(/model/i.test(msg) ? 'missing-model' : 'refused', msg);
  }
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const d = choice?.delta || choice?.message;
  const out = [];
  if (d && typeof d === 'object') {
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (typeof reasoning === 'string' && reasoning) out.push({ type: 'reasoning', text: reasoning });
    const text = textOf(d.content);
    if (text) out.push({ type: 'text', text });
    if (typeof d.refusal === 'string' && d.refusal) out.push({ type: 'text', text: d.refusal });
    for (const [i, tc] of (Array.isArray(d.tool_calls) ? d.tool_calls : []).entries()) {
      if (!tc || typeof tc !== 'object') continue;
      const args = tc.function?.arguments;
      out.push({ type: 'tool', index: Number.isInteger(tc.index) ? tc.index : i, id: tc.id || '', name: tc.function?.name || '', args: typeof args === 'string' ? args : args && typeof args === 'object' ? JSON.stringify(args) : '' });
    }
  }
  if (choice?.finish_reason === 'content_filter') throw new AiError('refused', 'The provider filtered the reply.');
  return out;
}

/** A whole (non-streamed) completion. */
export function parseFull(json) {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const msg = choice?.message;
  if (!msg || typeof msg !== 'object') throw new AiError('malformed', 'The reply had no message.');
  const reasoning = msg.reasoning_content ?? msg.reasoning;
  const toolCalls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : [])
    .map((tc, i) => toolCall(tc.id || `call_${i + 1}`, tc.function?.name || '', tc.function?.arguments)).filter((c) => c.name);
  return {
    text: textOf(msg.content) || msg.refusal || '', reasoning: typeof reasoning === 'string' ? reasoning : '', usage: usageOf(json.usage), toolCalls,
    ...(choice.finish_reason === 'length' ? { truncated: true } : {}),
  };
}

/** Assemble streamed tool-call fragments (keyed by index) into complete calls. */
export function collectToolCalls(parts) {
  const byIndex = new Map();
  for (const p of parts) {
    const cur = byIndex.get(p.index) || { id: '', name: '', args: '' };
    if (p.id) cur.id = p.id;
    if (p.name) cur.name = cur.name && cur.name !== p.name ? cur.name + p.name : p.name;
    cur.args += p.args || '';
    byIndex.set(p.index, cur);
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => toolCall(c.id || `call_${i + 1}`, c.name, c.args)).filter((c) => c.name);
}

function usageOf(u) {
  if (!u) return undefined;
  return { input: u.prompt_tokens, output: u.completion_tokens };
}

export function parseModels(json) {
  const out = [];
  const seen = new Set();
  // `vision` is only set when the server says whether the model sees images (LM Studio does; most servers do not).
  const add = (id, label, loaded, vision) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: label || id, loaded: !!loaded, ...(typeof vision === 'boolean' ? { vision } : {}) });
  };
  // LM Studio native: { models:[{ type:'llm'|'embedding', key, display_name, loaded_instances:[], capabilities:{ vision } }] }
  for (const m of Array.isArray(json?.models) ? json.models : []) {
    if (!m || (m.type && m.type !== 'llm' && m.type !== 'vlm')) continue;
    add(m.key || m.id || m.name, m.display_name, Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0, m.capabilities?.vision ?? (m.type === 'vlm' ? true : undefined));
  }
  // OpenAI shape: { data:[{ id }] } (LM Studio v0 adds type 'llm'|'vlm' and state)
  for (const m of Array.isArray(json?.data) ? json.data : []) {
    if (!m || (m.type && /embed/i.test(m.type))) continue;
    add(m.id || m.name, m.name && m.name !== m.id ? m.name : m.id, m.state === 'loaded', m.type === 'vlm' ? true : m.type === 'llm' && 'state' in m ? false : undefined);
  }
  return [...out.filter((m) => m.loaded), ...out.filter((m) => !m.loaded)];
}

export const openaiChat = {
  protocol: 'openai-chat',

  async stream({ cfg, key, system, messages, maxTokens, temperature, signal, onEvent, fetch, tools, toolTurns }) {
    const r = buildChat({ cfg, key, system, messages, maxTokens, temperature, stream: true, tools, toolTurns });
    let usage;
    let finish = '';
    const parts = [];
    const res = await requestStream({ ...r, signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch, imageBytes: imageChars(messages, toolTurns) }, ({ data }) => {
      if (!data || data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { return; }
      if (json.usage) usage = usageOf(json.usage);
      const reason = Array.isArray(json.choices) ? json.choices[0]?.finish_reason : null;
      if (reason) finish = reason;
      for (const f of parseChunk(json)) {
        if (f.type === 'tool') parts.push(f); else onEvent(f);
      }
    });
    if (!res.streamed) {
      const full = parseFull(res.json);
      if (full.reasoning) onEvent({ type: 'reasoning', text: full.reasoning });
      if (full.text) onEvent({ type: 'text', text: full.text });
      return { usage: full.usage, toolCalls: full.toolCalls, ...(full.truncated ? { truncated: true } : {}) };
    }
    return { usage, toolCalls: collectToolCalls(parts), ...(finish === 'length' ? { truncated: true } : {}) };
  },

  async listModels({ cfg, key, signal, fetch }) {
    const get = (path) => requestJson({ url: joinUrl(cfg.baseUrl, path), method: 'GET', headers: auth(key), signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch });
    try {
      return parseModels(await get(cfg.modelsPath || '/v1/models'));
    } catch (e) {
      if (!cfg.altModelsPath || e?.code === 'auth' || e?.code === 'cancelled') throw e;
      return parseModels(await get(cfg.altModelsPath));
    }
  },
};
