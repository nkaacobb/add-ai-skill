// OpenAI-compatible Chat Completions: LM Studio, Ollama, OpenAI, DeepSeek, OpenRouter and any custom server.
//   POST {base}{chatPath}  body { model?, messages[system,user,assistant…], stream, max_tokens|max_completion_tokens,
//                                 temperature?, …provider-specific "reasoning off" switch }
//   stream: `data: {choices:[{delta:{content, reasoning_content | reasoning}}]}` … `data: [DONE]`
//   models: GET {base}{modelsPath} -> { data:[{id}] }  (LM Studio native: { models:[{key, type, loaded_instances}] })
// An empty model is sent without a `model` field: LM Studio then answers with whatever model is loaded.
// Checked live against LM Studio 0.4 (reasoning arrives as `reasoning_content`).

import { requestJson, requestStream, joinUrl, AiError } from '../core/transport.js';
import { normalizeMessages } from '../core/messages.js';

const auth = (key) => (key ? { Authorization: `Bearer ${key}` } : {});

export function buildChat({ cfg, key, system, messages, maxTokens, temperature, stream = true }) {
  const body = {
    messages: [...(system ? [{ role: 'system', content: system }] : []), ...normalizeMessages(messages)],
    stream,
  };
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
  return { text: textOf(msg.content) || msg.refusal || '', reasoning: typeof reasoning === 'string' ? reasoning : '', usage: usageOf(json.usage) };
}

function usageOf(u) {
  if (!u) return undefined;
  return { input: u.prompt_tokens, output: u.completion_tokens };
}

export function parseModels(json) {
  const out = [];
  const seen = new Set();
  const add = (id, label, loaded) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ id, label: label || id, loaded: !!loaded });
  };
  // LM Studio native: { models:[{ type:'llm'|'embedding', key, display_name, loaded_instances:[] }] }
  for (const m of Array.isArray(json?.models) ? json.models : []) {
    if (!m || (m.type && m.type !== 'llm' && m.type !== 'vlm')) continue;
    add(m.key || m.id || m.name, m.display_name, Array.isArray(m.loaded_instances) && m.loaded_instances.length > 0);
  }
  // OpenAI shape: { data:[{ id }] } (LM Studio v0 adds type/state)
  for (const m of Array.isArray(json?.data) ? json.data : []) {
    if (!m || (m.type && /embed/i.test(m.type))) continue;
    add(m.id || m.name, m.name && m.name !== m.id ? m.name : m.id, m.state === 'loaded');
  }
  return [...out.filter((m) => m.loaded), ...out.filter((m) => !m.loaded)];
}

export const openaiChat = {
  protocol: 'openai-chat',

  async stream({ cfg, key, system, messages, maxTokens, temperature, signal, onEvent, fetch }) {
    const r = buildChat({ cfg, key, system, messages, maxTokens, temperature, stream: true });
    let usage;
    const res = await requestStream({ ...r, signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch }, ({ data }) => {
      if (!data || data === '[DONE]') return;
      let json;
      try { json = JSON.parse(data); } catch { return; }
      if (json.usage) usage = usageOf(json.usage);
      for (const f of parseChunk(json)) onEvent(f);
    });
    if (!res.streamed) {
      const full = parseFull(res.json);
      if (full.reasoning) onEvent({ type: 'reasoning', text: full.reasoning });
      if (full.text) onEvent({ type: 'text', text: full.text });
      usage = full.usage;
    }
    return { usage };
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
