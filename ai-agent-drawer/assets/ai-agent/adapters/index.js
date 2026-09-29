// Protocol -> adapter registry. Every adapter implements the same contract:
//   stream({ cfg, key, system, messages, maxTokens, temperature, signal, onEvent, fetch }) -> { usage? }
//       onEvent({ type: 'text' | 'reasoning' | 'notice' | 'status', text }) is called as fragments arrive.
//   listModels({ cfg, key, signal, fetch }) -> [{ id, label, loaded }]
// To support a new wire protocol, add a file next to this one and register it here.

import { openaiChat } from './openai-chat.js';
import { anthropic } from './anthropic.js';
import { gemini } from './gemini.js';
import { relay } from './relay.js';

export const ADAPTERS = Object.freeze({
  'openai-chat': openaiChat,
  'anthropic-messages': anthropic,
  'gemini-generate': gemini,
  relay,
});

export function adapterFor(protocol) { return ADAPTERS[protocol] || null; }
