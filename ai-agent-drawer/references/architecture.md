# Architecture

```
host app ──hooks──▶ ContextManager ──snapshot/hash──▶ conversation.js (planTurn / buildRequestMessages)
   │                    (core/context.js)                           │
   │                                                                ▼
   ├── toggle / push ◀── AgentDrawer (ui/drawer.js) ──▶ client.js (streamChat, fallback)
   │                         │   ▲                            │
   │                         │   └── markdown.js (render)     ▼
   │                         ▼                          adapters/{openai-chat, anthropic, gemini, relay}.js
   └── settings button ─▶ Settings panel (ui/settings-panel.js)        │
                              │                                       ▼
                        core/settings.js (localStorage)        core/transport.js (fetch + SSE, errors)
                                                                      │
                                                  LM Studio · Ollama · OpenAI · Anthropic · Gemini · …
                                                  or the app's relay (relay.php / relay.mjs → same adapters)
```

## Files

| File | Responsibility | DOM? |
| --- | --- | --- |
| `ai-agent.js` | `createAiAgent()` wires everything and returns the public API; `fromDom()` helper. | yes |
| `ai-agent.css` | All styling, scoped under `.aia-scope`, themable with `--aia-*` variables, light/dark. | – |
| `core/context.js` | App/page/content/view hooks → text; snapshot + fingerprint; truncation. | no |
| `core/conversation.js` | The sync protocol: `planTurn`, `contextState`, `buildRequestMessages`, snapshot block format. | no |
| `core/hash.js` | `hashText` (cyrb53, 53-bit), `stableStringify` (sorted keys). | no |
| `core/prompt.js` | `DEFAULT_SYSTEM_PROMPT`, the screen protocol text, `buildSystemPrompt`. | no |
| `core/settings.js` | Schema, validation, layered defaults, per-app storage, key store (session vs device). | storage |
| `core/providers.js` | Provider catalog (presets, protocol, paths, quirks). | no |
| `core/client.js` | `resolveTarget`, `streamChat` (with fallback), `listModels`, `testConnection`. | no |
| `core/transport.js` | `requestJson`, `requestStream` (idle timeout, abort), SSE parser, error codes + guidance, redaction. | no |
| `core/messages.js`, `core/reasoning.js` | Transcript normalisation; `<think>` splitting. | no |
| `adapters/*.js` | One per wire protocol: build request, parse stream chunks / whole replies, list models. | no |
| `ui/drawer.js` | The drawer: toggles, open/close/push, streaming render, receipts, flag, saved chats, resume, actions, errors. | yes |
| `ui/settings-panel.js` | The modal: Model / Agent / Context tabs, draft + save, load models, test connection. | yes |
| `ui/markdown.js` | Escape-first Markdown renderer with code-block actions. | no (string in/out) |
| `ui/resize.js`, `ui/dom.js`, `ui/icons.js` | Resize handle, DOM helpers, inline SVG icons. | yes |

Everything under `core/` and `adapters/` is DOM-free, which is why the Node relay can import it and the unit tests can
run without a browser.

## One request, end to end

1. User presses Enter. `AgentDrawer.send()` checks the configuration (`resolveTarget`) before touching the transcript.
2. `ContextManager.snapshot()` reads the content hook and fingerprints it; `planTurn()` decides whether to attach it.
3. The user message is added with its receipt chip (Read the page / Page unchanged); the flag updates.
4. `buildSystemPrompt()` = editable prompt + app context + page context + screen protocol + formatting rules.
5. `buildRequestMessages()` = history window with the newest snapshot inlined, older ones stubbed, view state last.
6. `streamChat()` → adapter → `requestStream()`; fragments arrive as `text` / `reasoning` events.
7. The drawer accumulates raw text, splits inline `<think>` blocks, and re-renders Markdown at most once per frame.
8. On finish: the reply is stored, the chat persisted (without snapshot text), and the flag recomputed. On failure
   with no text: the question is removed from the transcript (so the sync state is unchanged) and the error is shown
   with hints and an "Open settings" button.

## Security posture

- Model output is escaped before Markdown decoration; links are http(s)/mailto only; code is shown, never executed.
- Screen content is fenced in `<page_snapshot>` with its closing tag neutralised, and the system prompt tells the model
  to treat it as data, not instructions.
- Actions run only when the user clicks, through the host app's own functions.
- Keys: sessionStorage by default, never in the settings object, redacted from errors; relay for server-side keys.
- Relays: localhost-only by default, upstream allow-list (cloud: catalog address only; local: private hosts only),
  body size caps, streaming aborted when the browser disconnects.

## Lineage

- **PortScope** (`utils/ports`): the right-hand drawer, resize handle, streaming SSE chat with reasoning panel,
  escape-first Markdown renderer with code-block actions, saved chats with two-step delete, settings modal, the
  "context chip", the idea of sending the on-screen data with the question, and the PHP proxy (`chat.php` /
  `AiProvider.php` → `relay.php`).
- **Rolling World** (`games/roll-world/src/ai`): the provider catalog without a maintained model list, protocol
  adapters behind one contract (`adapters/`), the transport with error classification/redaction and guidance,
  settings sanitisation with per-provider profiles, message normalisation, reasoning stripping, and the connection
  test (discovery → model check → one tiny generation).
- **New here**: the app/page/content/view context layers, the hash-based sync protocol with receipts and the flag,
  the editable system prompt layered with fixed protocol text, the Context inspector tab, app-defined code/reply
  actions, per-tab resume for multi-page apps, streaming for all protocols, and the shared relay contract.
