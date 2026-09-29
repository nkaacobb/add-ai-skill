# Providers, keys, CORS and relays

## Supported out of the box

| Id | Protocol | Default address | Key | Notes |
| --- | --- | --- | --- | --- |
| `lmstudio` (default) | openai-chat | `http://127.0.0.1:9000` | optional token | Empty model = whatever is loaded. Models listed from `/api/v1/models` (shows which is loaded), falling back to `/v1/models`. Thinking arrives as `reasoning_content`; "Ask the model not to think" sends `reasoning_effort: "none"`. LM Studio's own default port is 1234. |
| `ollama` | openai-chat | `http://127.0.0.1:11434` | optional | Model required. `OLLAMA_ORIGINS` must allow the page origin for browser calls. |
| `custom` | openai-chat | `http://127.0.0.1:8080` | optional | Any `/v1/chat/completions` server (llama.cpp, vLLM, LocalAI, Jan, gateways). |
| `openai` | openai-chat | `https://api.openai.com` | required | Sends `max_completion_tokens`, no temperature (reasoning models reject it). |
| `anthropic` | anthropic-messages | `https://api.anthropic.com` | required | Browser calls send `anthropic-dangerous-direct-browser-access: true`. Temperature not sent. "Off" thinking sends `thinking: {type: 'disabled'}`. |
| `google` | gemini-generate | `https://generativelanguage.googleapis.com` | required | `:streamGenerateContent?alt=sse`, key in `x-goog-api-key`. Thought parts shown as thinking. |
| `deepseek` | openai-chat | `https://api.deepseek.com` | required | Thinking off = `thinking: {type: 'disabled'}`. May need the relay (CORS). |
| `openrouter` | openai-chat | `https://openrouter.ai/api` | required | Hundreds of models behind one key; model ids like `anthropic/claude-sonnet-5`. |

Models are never hard-coded: "Load models" asks the provider, and any id can be typed. Placeholders are examples.

Each provider keeps its own address and model (`profiles`), so switching back and forth does not lose settings.
A **fallback provider** can be set (Settings > Model > Advanced): used only if the primary cannot be reached and no
text has arrived yet; a notice in the reply says so.

## Keys

- Typed keys are kept in **sessionStorage** (gone when the tab closes) unless the user ticks *Remember API keys on this
  device* (localStorage). They are sent only to the provider (or the app's relay), never elsewhere, and error
  messages are redacted.
- Any script on the page's origin can read browser-held keys. That is fine for local/personal tools; for deployed or
  shared apps use the **relay** with server-side keys.

## CORS and direct browser calls

Browser → provider calls need the provider to allow the page's origin:

- **LM Studio**: Developer tab → server settings → *Enable CORS*. Use `127.0.0.1` (on Windows `localhost` may resolve
  to IPv6 `::1`).
- **Ollama**: set `OLLAMA_ORIGINS` (e.g. `http://localhost:*`), restart Ollama.
- **OpenAI, Anthropic, Gemini, OpenRouter**: accept browser calls with the headers above.
- **DeepSeek / others**: if the browser reports a network/CORS error, use the relay.
- An **https** page cannot call an **http** LLM (mixed content): serve the app over http on localhost, or use the relay.

## Relays

The relay is the app's own endpoint: the browser sends the conversation to it, it calls the provider, and streams
the reply back. Enable it with `defaults: { transport: 'relay', relayUrl: '…' }` or in Settings > Model > Advanced.

### Contract

```
POST {relayUrl}   Content-Type: application/json   X-Requested-With: ai-agent-drawer (+ relayHeaders)
{ "action": "chat", "provider": "anthropic", "baseUrl": "…", "model": "…", "apiKey": "" ,
  "system": "…", "messages": [{ "role": "user", "content": "…" }], "maxTokens": 4096, "temperature": 0.4,
  "reasoning": "show" }
→ 200 text/event-stream
  event: delta      data: {"text":"…"}
  event: reasoning  data: {"text":"…"}
  event: notice     data: {"message":"…"}
  event: error      data: {"message":"…","code":"auth|missing-model|bad-endpoint|network|timeout|rate-limit|refused"}
  event: done       data: {"provider":"…","model":"…","usage":{…}}
  (or 200 application/json {"text":"…","reasoning":"…"} / {"error":{"message":"…"}})

POST {relayUrl}  { "action": "models", "provider": "…", "baseUrl": "…", "apiKey": "" }
→ {"ok":true,"models":[{"id":"…","label":"…","loaded":false}]}  |  {"ok":false,"error":"…"}

GET {relayUrl} → {"ok":true,"relay":"ai-agent-drawer","providers":[…],"serverKeys":{"openai":true,…}}
```

An empty `apiKey` means "use the server's key": `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` (PHP also accepts the `AIA_KEYS` array in the file).

### Reference relays

- **`assets/relay/relay.php`** — single file, PHP 8, cURL streaming. Answers only localhost by default
  (`AIA_ALLOW_REMOTE`); local providers may only target loopback/private addresses (`AIA_ALLOW_ANY_UPSTREAM`); cloud
  providers always use their catalog address. Add the app's auth/CSRF check where marked.
- **`assets/relay/relay.mjs`** — Node 18+, zero dependencies, reuses the runtime's `core/client.js` (the same adapters
  as the browser). Flags: `--port`, `--host`, `--path`, `--static <dir>`, `--allow-remote`, `--allow-any-upstream`,
  `--cors <origin>`. `--static` also serves files, which is how the Hello World example runs.

Before exposing a relay beyond localhost, put the application's authentication in front of it and rate-limit it.

## Adding a provider

- **Speaks an existing protocol** (most do — OpenAI-compatible is common): add an entry to
  `assets/ai-agent/core/providers.js` (id, label, group, kind `local|cloud|custom`, protocol, baseUrl, chatPath,
  modelsPath, keyRequired, keyEnv, tokenField, sendsTemperature, reasoningOff, placeholder, note) and the matching
  row in `relay.php`'s `AIA_PROVIDERS`. No adapter code.
- **New wire protocol**: add `assets/ai-agent/adapters/<name>.js` exporting `{ protocol, stream(), listModels() }`
  (see `adapters/index.js` for the contract), register it in `adapters/index.js`, and add parsing to `relay.php`.
  Add tests in `tests/runtime.test.mjs`.
