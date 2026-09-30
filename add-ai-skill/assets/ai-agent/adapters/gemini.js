// Google Gemini generateContent.
//   POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse   header x-goog-api-key
//   body { contents:[{role:'user'|'model', parts:[{text}]}], systemInstruction:{parts}, generationConfig:{
//          maxOutputTokens, temperature } }
//   stream: `data: {candidates:[{content:{parts:[{text, thought?}]}, finishReason}], promptFeedback?, usageMetadata}`
//   Parts flagged `thought: true` are the model's reasoning.
//   models: GET {base}/v1beta/models -> { models:[{ name:'models/…', displayName, supportedGenerationMethods }] }
//   tools: body.tools [{functionDeclarations:[{name, description, parameters}]}]; the reply has parts
//   {functionCall:{name, args}} (whole, not streamed in pieces), possibly with a thoughtSignature that must be sent
//   back; results go back as a user turn of {functionResponse:{name, response:{result}}} parts.
//   images: {inlineData:{mimeType, data}} parts after the text of a user turn; an image a tool returned follows the
//   functionResponse parts of its round in the same user turn.

import { requestJson, requestStream, joinUrl, AiError } from '../core/transport.js';
import { normalizeMessages, imageChars } from '../core/messages.js';
import { parseArguments } from '../core/tools.js';

const headers = (key) => ({ 'x-goog-api-key': key || '' });
const modelPath = (m) => encodeURIComponent(String(m || '').replace(/^models\//, ''));
const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']);

const inline = (i) => ({ inlineData: { mimeType: i.mime, data: i.data } });

/** The current question's tool exchange, as Gemini contents. */
export function toolTurnContents(toolTurns = []) {
  const out = [];
  for (const turn of toolTurns) {
    out.push({
      role: 'model',
      parts: [
        ...(turn.text ? [{ text: turn.text }] : []),
        ...turn.calls.map((c) => ({ functionCall: { name: c.name, args: c.arguments || {} }, ...(c.signature ? { thoughtSignature: c.signature } : {}) })),
      ],
    });
    out.push({
      role: 'user',
      parts: [
        ...turn.results.map((r) => ({ functionResponse: { name: r.name, response: { result: String(r.content ?? '') } } })),
        ...turn.results.flatMap((r) => (Array.isArray(r.images) ? r.images.map(inline) : [])),
      ],
    });
  }
  return out;
}

export function buildChat({ cfg, key, system, messages, maxTokens, temperature, stream = true, tools, toolTurns }) {
  const body = {
    contents: [
      ...normalizeMessages(messages).map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content || '(image)' }, ...(m.images || []).map(inline)] })),
      ...toolTurnContents(toolTurns),
    ],
    generationConfig: {},
  };
  if (tools?.length) body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (Number.isFinite(maxTokens)) body.generationConfig.maxOutputTokens = maxTokens;
  if (Number.isFinite(temperature)) body.generationConfig.temperature = temperature;
  // thinkingConfig is model-dependent (older models reject it), so the reasoning setting is not translated here.
  const action = stream ? ':streamGenerateContent?alt=sse' : ':generateContent';
  return { url: joinUrl(cfg.baseUrl, `/v1beta/models/${modelPath(cfg.model)}${action}`), headers: headers(key), body };
}

export function parseChunk(json) {
  if (json?.error) throw new AiError('refused', json.error.message || 'Gemini returned an error.');
  if (json?.promptFeedback?.blockReason) throw new AiError('refused', 'The provider blocked this request.');
  const cand = Array.isArray(json?.candidates) ? json.candidates[0] : null;
  if (!cand) return [];
  const out = [];
  for (const p of Array.isArray(cand.content?.parts) ? cand.content.parts : []) {
    if (p && typeof p.text === 'string' && p.text) out.push({ type: p.thought ? 'reasoning' : 'text', text: p.text });
    if (p?.functionCall?.name) out.push({ type: 'tool', id: p.functionCall.id || '', name: p.functionCall.name, arguments: parseArguments(p.functionCall.args), signature: p.thoughtSignature || '' });
  }
  if (!out.length && BLOCKED.has(cand.finishReason)) throw new AiError('refused', 'The provider filtered the reply.');
  return out;
}

export function parseModels(json) {
  return (Array.isArray(json?.models) ? json.models : [])
    .filter((m) => m && typeof m.name === 'string' && (!Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent')))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name.replace(/^models\//, ''), loaded: false }));
}

export const gemini = {
  protocol: 'gemini-generate',

  async stream({ cfg, key, system, messages, maxTokens, temperature, signal, onEvent, fetch, tools, toolTurns }) {
    if (!cfg.model) throw new AiError('missing-model', 'Choose a Gemini model in Settings (try "Load models").');
    const r = buildChat({ cfg, key, system, messages, maxTokens, temperature, stream: true, tools, toolTurns });
    let usage;
    const toolCalls = [];
    const handle = (json) => {
      if (json.usageMetadata) usage = { input: json.usageMetadata.promptTokenCount, output: json.usageMetadata.candidatesTokenCount };
      for (const f of parseChunk(json)) {
        if (f.type === 'tool') toolCalls.push({ id: f.id || `gemini_${toolCalls.length + 1}`, name: f.name, arguments: f.arguments, ...(f.signature ? { signature: f.signature } : {}) });
        else onEvent(f);
      }
    };
    const res = await requestStream({ ...r, signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch, imageBytes: imageChars(messages, toolTurns) }, ({ data }) => {
      let json;
      try { json = JSON.parse(data); } catch { return; }
      handle(json);
    });
    if (!res.streamed) handle(res.json);
    return { usage, toolCalls };
  },

  async listModels({ cfg, key, signal, fetch }) {
    return parseModels(await requestJson({ url: joinUrl(cfg.baseUrl, cfg.modelsPath || '/v1beta/models?pageSize=1000'), method: 'GET', headers: headers(key), signal, timeoutMs: cfg.timeoutMs, secrets: [key], fetch }));
  },
};
