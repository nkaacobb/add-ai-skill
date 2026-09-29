// Provider catalog. A provider is a preset for editable settings (address, model, key) plus the wire protocol it
// speaks. There is deliberately no maintained model list: models come from "Load models" (discovery) or are typed.
// Placeholders are examples only. Add a provider by adding an entry here; if it speaks one of the three protocols
// below, no adapter code is needed.
//
//   openai-chat          POST {base}/v1/chat/completions   (LM Studio, Ollama, OpenAI, DeepSeek, OpenRouter, custom)
//   anthropic-messages   POST {base}/v1/messages
//   gemini-generate      POST {base}/v1beta/models/{model}:streamGenerateContent?alt=sse

export const PROTOCOLS = Object.freeze({
  'openai-chat': { id: 'openai-chat', label: 'OpenAI-compatible chat completions' },
  'anthropic-messages': { id: 'anthropic-messages', label: 'Anthropic Messages' },
  'gemini-generate': { id: 'gemini-generate', label: 'Google Gemini generateContent' },
});

const P = (o) => Object.freeze({
  chatPath: '', modelsPath: '', altModelsPath: '', tokenField: 'max_tokens', sendsTemperature: true,
  keyRequired: false, keyOptional: false, modelRequired: true, reasoningOff: null, placeholder: '', keyEnv: '',
  consoleUrl: '', note: '', ...o,
});

export const PROVIDERS = Object.freeze({
  lmstudio: P({
    id: 'lmstudio', label: 'LM Studio (local)', group: 'On this computer', kind: 'local', protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:9000', chatPath: '/v1/chat/completions',
    // The native list reports which model is loaded; the OpenAI-compatible one is the fallback.
    modelsPath: '/api/v1/models', altModelsPath: '/v1/models',
    keyOptional: true, modelRequired: false,
    // Honoured by LM Studio's compatibility endpoint (it thinks by default otherwise).
    reasoningOff: { reasoning_effort: 'none' },
    placeholder: 'Leave empty to use whatever model is loaded',
    docs: 'https://lmstudio.ai/docs/developer/openai-compat',
    note: 'Runs on this computer. In LM Studio: Developer tab > Start server, and turn on "Enable CORS". The default port is 1234; this template defaults to 9000.',
  }),
  ollama: P({
    id: 'ollama', label: 'Ollama (local)', group: 'On this computer', kind: 'local', protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:11434', chatPath: '/v1/chat/completions', modelsPath: '/v1/models',
    keyOptional: true, placeholder: 'e.g. llama3.2 or qwen3:8b',
    reasoningOff: { reasoning_effort: 'none' },
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    note: 'Runs on this computer. If the browser is blocked, set OLLAMA_ORIGINS to include this page\'s origin.',
  }),
  custom: P({
    id: 'custom', label: 'Other OpenAI-compatible server', group: 'On this computer', kind: 'custom', protocol: 'openai-chat',
    baseUrl: 'http://127.0.0.1:8080', chatPath: '/v1/chat/completions', modelsPath: '/v1/models',
    keyOptional: true, modelRequired: false, placeholder: 'model id the server expects',
    note: 'Any server that speaks /v1/chat/completions: llama.cpp, vLLM, LocalAI, Jan, a corporate gateway…',
  }),
  openai: P({
    id: 'openai', label: 'OpenAI', group: 'Cloud', kind: 'cloud', protocol: 'openai-chat',
    baseUrl: 'https://api.openai.com', chatPath: '/v1/chat/completions', modelsPath: '/v1/models',
    tokenField: 'max_completion_tokens', sendsTemperature: false, keyRequired: true, keyEnv: 'OPENAI_API_KEY',
    placeholder: 'e.g. gpt-5-mini', consoleUrl: 'https://platform.openai.com/api-keys',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
  }),
  anthropic: P({
    id: 'anthropic', label: 'Anthropic (Claude)', group: 'Cloud', kind: 'cloud', protocol: 'anthropic-messages',
    baseUrl: 'https://api.anthropic.com', modelsPath: '/v1/models?limit=1000', sendsTemperature: false,
    keyRequired: true, keyEnv: 'ANTHROPIC_API_KEY', placeholder: 'e.g. claude-sonnet-5',
    consoleUrl: 'https://console.anthropic.com/settings/keys', docs: 'https://docs.anthropic.com/en/api/messages',
  }),
  google: P({
    id: 'google', label: 'Google Gemini', group: 'Cloud', kind: 'cloud', protocol: 'gemini-generate',
    baseUrl: 'https://generativelanguage.googleapis.com', modelsPath: '/v1beta/models?pageSize=1000',
    keyRequired: true, keyEnv: 'GEMINI_API_KEY', placeholder: 'e.g. gemini-2.5-flash',
    consoleUrl: 'https://aistudio.google.com/apikey', docs: 'https://ai.google.dev/api/generate-content',
  }),
  deepseek: P({
    id: 'deepseek', label: 'DeepSeek', group: 'Cloud', kind: 'cloud', protocol: 'openai-chat',
    baseUrl: 'https://api.deepseek.com', chatPath: '/chat/completions', modelsPath: '/models',
    keyRequired: true, keyEnv: 'DEEPSEEK_API_KEY', placeholder: 'e.g. deepseek-chat',
    reasoningOff: { thinking: { type: 'disabled' } },
    consoleUrl: 'https://platform.deepseek.com/api_keys', docs: 'https://api-docs.deepseek.com/',
    note: 'If direct browser requests are blocked, switch "Send requests" to the app relay.',
  }),
  openrouter: P({
    id: 'openrouter', label: 'OpenRouter (many models)', group: 'Cloud', kind: 'cloud', protocol: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api', chatPath: '/v1/chat/completions', modelsPath: '/v1/models',
    keyRequired: true, keyEnv: 'OPENROUTER_API_KEY', placeholder: 'e.g. anthropic/claude-sonnet-5',
    consoleUrl: 'https://openrouter.ai/keys', docs: 'https://openrouter.ai/docs',
  }),
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

export function provider(id) { return PROVIDERS[id] || PROVIDERS.lmstudio; }

/** True for loopback / private-network / .local hosts: the data stays on this machine or LAN. */
export function isLocalUrl(url) {
  let h;
  try { h = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h === '::1' || h === '0.0.0.0') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** One line for the Settings panel: where the conversation and the screen content will go. */
export function transmissionNote(providerId, baseUrl) {
  const p = provider(providerId);
  if (p.kind === 'cloud') return `Your questions and the screen content shared with the agent are sent over the internet to ${p.label}.`;
  if (isLocalUrl(baseUrl || p.baseUrl)) return 'Your questions and the screen content stay on this computer (or your local network).';
  return 'This address is not local: your questions and the screen content are sent to that server.';
}
