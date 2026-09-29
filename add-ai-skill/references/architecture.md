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
| `core/relay-probe.js` | `probeRelay` (the relay's GET), `relayDefaults`, `adjustForRelay` (keeps saved settings usable). | no |
| `core/blocks.js` | `parseBlockValues`: values from a fenced block, checked against an allowlisted schema, clamped. | no |
| `core/transport.js` | `requestJson`, `requestStream` (idle timeout, abort), SSE parser, error codes + guidance, redaction. | no |
| `core/messages.js`, `core/reasoning.js` | Transcript normalisation; `<think>` splitting. | no |
| `adapters/*.js` | One per wire protocol: build request, parse stream chunks / whole replies, list models. | no |
| `ui/drawer.js` | The drawer: toggles, open/close/push, streaming render, receipts, flag, saved chats, resume, actions, errors. | yes |
| `ui/settings-panel.js` | The modal: Model / Agent / Context tabs, draft + save, load models, test connection. | yes |
| `ui/markdown.js` | Escape-first Markdown renderer with code-block actions. | no (string in/out) |
| `ui/dialogs.js` | `dialogs: 'dock'`: native modal dialogs shown non-modally beside the open drawer, switch events swallowed. | yes |
| `ui/layout-check.js` | Dev-time check that the pushed layout fits beside the drawer (`devWarnings`). | yes |
| `ui/resize.js`, `ui/dom.js`, `ui/icons.js` | Resize handle, DOM helpers (debounce with max wait, key isolation, `setControlValue`), inline SVG icons. | yes |

Outside the runtime:

| Path | What it is |
| --- | --- |
| `assets/relay/relay.php`, `relay.mjs`, `relay.config.example.php` | The relays (same contract, modes and config keys) and the documented config. |
| `scripts/verify.mjs` | Drives headless Edge/Chrome through an integration and reports pass/fail per check. |
| `scripts/lib/cdp.mjs` | Zero-dependency DevTools-protocol driver (Node 22+ global WebSocket), shared by `verify.mjs` and the browser tests. |
| `tests/` | `runtime` (pure modules), `relay` (both relays + fake upstream), `browser` (real browser), `example` (Hello World content). |

Everything under `core/` and `adapters/` is DOM-free, which is why the Node relay can import it and the unit tests can
run without a browser. What needs a browser (`ui/`) is covered by `tests/browser.test.mjs`.

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
- Keystrokes typed in the agent's UI do not reach host shortcut handlers (`isolateKeys`).
- Relays: local mode (the default) answers only its own computer — a proxied request is never "local" — with an
  upstream allow-list (cloud: catalog address only; local: private hosts only). Public mode is explicit and uses only
  the configured preset and server key, enforces same-origin (no CORS headers), rate-limits per visitor (salted,
  daily-rotating hashes; no addresses or text stored) and site-wide, caps bodies/messages/tokens, and gives visitors
  generic errors (details only to the server itself and its log). Config files are `.php` (never served) and live
  outside the web root. Streams carry keepalive comments; the upstream call is aborted when the visitor leaves.

## Lineage

The drawer, resize handle, streaming chat with a reasoning panel, escape-first Markdown with code-block actions,
saved chats, the settings modal and the PHP proxy come from earlier in-house tools; the provider catalog without a
maintained model list, the protocol adapters behind one contract, the transport's error classification and the
connection test come from another. New in this skill: the app/page/content/view context layers, the hash-based sync
protocol with receipts and the flag, the editable system prompt layered with fixed protocol text, the Context
inspector, app-defined actions, per-tab resume, streaming for all protocols, the shared relay contract — and, from
the first real integration (1.1), the max-wait debounce, key isolation, dialog docking, the layout check, the relay
probe, production relays and the verification tooling.
