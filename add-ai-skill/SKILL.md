---
name: add-ai-skill
description: Build a screen-aware AI agent into any web application - a chat drawer that slides out from the right, sees what the user sees (application context + page context + live screen content that is re-sent only when its hash changes, with a visible in-sync/changed flag), streams replies as rich Markdown, keeps saved chats, and has a settings panel for any LLM (LM Studio by default, Ollama, OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, any OpenAI-compatible server, or a PHP/Node relay with a production-ready public mode) with an editable system prompt. Use when the user asks to add, build or integrate an AI agent, AI assistant, chatbot, copilot panel, or "chat with what is on screen" into an app, or mentions the add-ai-skill skill or the AI agent drawer pattern. Vanilla ES modules with no build step and no dependencies; works with plain HTML, PHP, React, Vue, Svelte, Angular and Next.js.
---

# add-ai-skill — the AI Agent Drawer

Build this pattern into the user's application:

1. **A drawer that slides in from the right** (toggle button or floating launcher, `Ctrl+I`, resizable, pushes the page aside, saved chats, stop button).
2. **It sees what the user sees.** Three context layers come from hooks you write for the app:
   - **app** — what the application is and can do (system prompt)
   - **page** — which page/view is open and what it is for (system prompt)
   - **content** — the live screen content, fingerprinted with a hash; plus **view** — volatile UI state (cursor, selection, filters), sent each turn but never hashed
3. **Context sync with a visible flag.** Before every question the runtime hashes the screen and compares it with the newest snapshot the model already has in the conversation. Same hash → send only the question. Different → attach a fresh snapshot. The flag (green *synced* / amber *changed* / blue *not read yet*) shows in the drawer and can be shown anywhere in the app.
4. **Rich rendering.** Streaming, escape-first Markdown (headings, lists, task lists, tables, quotes, fenced code with Copy and app-specific buttons), a collapsible "thinking" panel.
5. **Settings for any LLM.** Provider, address, model (with discovery), API key, connection test, relay/fallback, and an **editable system prompt**, all stored per app in the browser. LM Studio (`http://127.0.0.1:9000`, whatever model is loaded) is the default.

Everything lives in this skill folder (the folder that contains this `SKILL.md`). You copy the runtime into the app and write only the app-specific integration. **Do not rewrite the runtime.**

## What is in this skill

| Path | What it is |
| --- | --- |
| `assets/ai-agent/` | **The runtime to copy into the app** (1.1). `ai-agent.js` (entry: `createAiAgent`, `fromDom`, `parseBlockValues`, `setControlValue`, `probeRelay`), `ai-agent.css`, `ai-agent.d.ts`, `core/` (context, sync protocol, hashing, settings, prompt, transport, client, relay probe, block values), `adapters/` (openai-chat, anthropic, gemini, relay), `ui/` (drawer, settings modal, markdown, resize, dialog docking, layout check). |
| `assets/relay/relay.php` | Drop-in PHP relay (PHP 8.1+, curl): Apache/XAMPP, Nginx + PHP-FPM, `php -S`. Local-only by default; an explicit **public mode** (fixed preset, same-origin, rate limits, caps). Configured by a `.php` config file, so it is copied unchanged. |
| `assets/relay/relay.config.example.php` | Every relay setting, documented. |
| `assets/relay/relay.mjs` | Node relay with the same contract, modes and config (+ optional static server; zero dependencies). |
| `examples/hello-world/` | **Reference integration**: a text editor (`app.js`) that loads its AI integration (`ai-agent-setup.js`) with `import()`, pure content builders (`content.js`, unit-tested), a status-bar sync flag, and code actions (insert/replace text, apply editor settings through the real controls). Read `ai-agent-setup.js` before integrating. |
| `references/` | `api.md` (every option, method and host hook), `context-sync.md` (the protocol, real-time apps, content builders), `frameworks.md` (stack recipes, safe loading, keyboard shortcuts, modal dialogs, layout, change signals, small-model code actions), `providers.md` (LLMs, context size, keys, CORS, relays, Nginx/Apache deployment), `checklist.md` (verification + troubleshooting), `architecture.md`. |
| `scripts/verify.mjs` | **Automated verification** in headless Edge/Chrome (Node 22+): console errors, hotkey, flag, typing, context size, layout at 3 widths with screenshots, and the read → change → re-read → "Page unchanged" loop. |
| `tests/` | `node --test` suites: runtime, relays (Node + PHP, fake upstream), real-browser behaviour, the example's content builders. Run them if you ever change the runtime. |

## Workflow

### 1. Survey the app (read-only)

Find out, and keep notes:

- **Stack and entry points**: plain HTML/PHP templates, or a framework (React/Vite, Next.js, Vue, Svelte, Angular…). Where the root layout/shell is rendered.
- **Production stack, up front**: which web server (Apache, Nginx, a Node server, static hosting/CDN), PHP or Node, whether long-running processes are allowed, and how development differs (e.g. XAMPP locally, Nginx + PHP-FPM in production). This decides the relay (step 8). Never plan on `.htaccess` or rewrites.
- **Where static assets are served from** (`public/`, `static/`, `assets/`, `wwwroot/`), or whether code is bundled from `src/`; how the app busts caches after a deploy.
- **Every page/view/route** the user can be on, and **what each one shows**: which state/store/API data renders it (including Web Worker messages and typed arrays), what the user edits or selects there, and how often it changes (static, on edits, continuously — animation, simulation, live data).
- **The header/toolbar** where an "Ask AI" button belongs, and the **main content container** that should make room for the drawer. Note fixed-width grid columns and wide toolbars (they need the layout recipe) and fixed-position elements.
- **Global keyboard handlers** (`keydown` on window/document, hotkey libraries) and **modal dialogs** (`showModal()`, popovers, focus-trapped modals).
- **Backend**: is there a server (PHP, Node, Python…)? Will the app be deployed beyond localhost? Is there auth/CSRF?
- **Existing AI code** or an existing chat panel (do not build a second one; ask the user).
- **Theme**: brand colors / CSS variables, light/dark support (and how dark mode is switched).

### 2. Write the context plan

Before coding, draft this and show it to the user in a few lines (proceed unless they object):

- **App context**: name, purpose (1–2 sentences written from the README/UI, not invented), capabilities (what the app can do), limits (what it cannot do — this prevents the model from promising features that do not exist). Keep it **lean** — titles and lists, not full glossaries or manuals — and **generate it from the app's own data modules** (its list of views, tools, record types) rather than hand-written prose, so it stays true. App context + page purpose + snapshot + prompt easily reach 4–5k tokens, and local models often run with a 4k window.
- **Per page**: `id`, `title`, `purpose`, **content** (exactly what data represents the screen: visible rows, the open record, the document text, form values, an open dialog…), **view** (selection, cursor, active tab, filters, sort), and **where the change signal comes from** (store subscription, fetch completion, worker messages, input events).
- **System prompt**: the persona and answer rules for this domain (start from `DEFAULT_SYSTEM_PROMPT` and add domain rules, like the Hello World example does).
- **Actions** worth adding to code blocks/replies (insert into editor, apply a filter or settings, open a record, copy as SQL…). Never auto-execute: the user clicks.
- **Transport**: direct from the browser (default; fine for local LLMs and personal tools) or through a relay (deployed apps, server-held keys, providers that block CORS) — `relayProbe` picks the relay automatically when it answers.

### 3. Install the runtime

Copy the whole `assets/ai-agent/` folder from this skill into the app, unchanged:

- Plain HTML / PHP / server-rendered: next to the other static assets, e.g. `assets/ai-agent/` or `public/ai-agent/`.
- Bundled apps (Vite, webpack, Next.js): `src/lib/ai-agent/` and import it (CSS import included), or `public/ai-agent/` and load it with a module script / dynamic `import()`.

```powershell
Copy-Item -Recurse "<skill>/assets/ai-agent" "<app>/public/ai-agent"      # Windows
```
```bash
cp -r "<skill>/assets/ai-agent" "<app>/public/ai-agent"                    # macOS/Linux
```

Keep the folder self-contained so it can be re-synced from the skill later. Configure through options; do not edit the runtime files. (If a runtime change is truly needed, make it generic, and tell the user so they can fold it back into the skill.) Version the asset URLs (or serve them `no-cache`) so a deploy is picked up.

### 4. Mount the agent once

Create **one integration module** in the app (e.g. `assets/js/ai-agent-setup.js`, `src/ai/agent.ts`) that calls `createAiAgent` once on the client. **Load it with `import()` and catch failures**, so the app keeps working if the agent cannot load:

```html
<!-- in the page shell -->
<link rel="stylesheet" href="assets/ai-agent/ai-agent.css">
<button type="button" id="ask-ai" hidden>Ask AI</button>
```

```js
// in the app's entry script
import('./ai-agent-setup.js').then((m) => m.mountAgent()).catch((e) => console.warn('AI agent unavailable', e));
```

```js
// assets/js/ai-agent-setup.js
import { createAiAgent, DEFAULT_SYSTEM_PROMPT } from '../ai-agent/ai-agent.js';
import { store } from './store.js';                          // however the app holds its state
import { buildItemsContent } from './ai-content.js';         // pure, unit-tested (step 5)
import { VIEWS } from './views.js';                          // the app's own data, reused for the app context

export function mountAgent() {
  const agent = createAiAgent({
    appId: 'inventory',                          // unique per app: namespaces settings, keys and chats
    title: 'Inventory assistant',
    toggle: '#ask-ai',                           // omit to get a floating launcher button
    push: 'main',                                // container that makes room for the drawer
    app: {
      name: 'Inventory',
      purpose: 'Track stock levels and purchase orders for the warehouse.',
      capabilities: VIEWS.map((v) => `${v.title}: ${v.summary}`),
      limits: ['Cannot place orders with suppliers', 'Only sees the current page'],
    },
    page: {
      id: 'items',
      title: 'Items',
      purpose: 'Lists stock items with quantity, location and reorder level.',
      content: () => buildItemsContent(store.getState()),                    // what is on screen (hashed)
      view: () => ({ selected: store.getState().selectedIds }),              // volatile (not hashed)
    },
    systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nYou are the inventory assistant. …domain rules…`,
    welcome: 'I can see the items on your screen. Ask me about stock, reorders or anything odd.',
    suggestions: ['Which items are below their reorder level?', 'Summarize this view'],
    defaults: { provider: 'lmstudio' },          // LM Studio at http://127.0.0.1:9000, loaded model
    // dialogs: 'dock',                          // if the app uses dialog.showModal() (step 1)
  });
  store.subscribe(() => agent.contextChanged());   // the change signal
  document.getElementById('ask-ai').hidden = false;
  return agent;
}
```

The hooks read the state when they are called, so every snapshot sees the latest values. `createAiAgent` returns at once; with `relayProbe` or async `defaults`, `agent.ready` resolves when they are applied (questions wait for it). With `resume` (default) the drawer may reopen *during* `createAiAgent`: register `agent.on('open', …)` right after creating the agent (the event is replayed as `{ resumed: true }`) or check `agent.isOpen()` once — see `references/api.md`.

Framework recipes (React hook, Vue composable, Svelte, Angular service, Next.js client component, PHP multi-page) are in `references/frameworks.md`. Always create the agent on the client only (never during SSR), and only once.

### 5. Wire every page

- On navigation call `agent.setPage({ id, title, purpose, content, view })` for the page now shown.
- **content** must describe what the user actually sees, compactly and deterministically. Write it as a **pure content-builder module** (state + a small UI record → text) with unit tests: the same state gives identical text, a real change gives different text, no `NaN`/`undefined`.
  - Prefer the app's own state (the rows after filtering/paging, the record being viewed, the document text) over scraping the DOM. Decode compact buffers (typed arrays from a worker) instead of reading the canvas/DOM.
  - Round to the precision the UI shows, with its units. Label every value **exactly as the UI does**; never put a raw value next to a derived one under the same name — the model will report the contradiction.
  - Stable ordering and formatting; no clocks, random ids, or "updated 3s ago" strings — anything that changes on its own makes the flag flip to *changed* for nothing. Put volatile bits in **view**.
  - Include what an open dialog/panel shows; it is part of the screen.
  - Cap large data at what is visible (the runtime also truncates at *Max screen content*, 24,000 chars by default, and tells the model it did).
  - Never include secrets, tokens, passwords, or data the current user is not allowed to see.
- If a page has no good state model, `fromDom('main')` (exported by the runtime) reads the rendered text of an element plus visible form values, skipping the agent's own UI.

### 6. Signal changes

Call `agent.contextChanged()` wherever that page's content can change: after data loads/refreshes, on edits, on filter/sort/paging changes, in a store subscription, on each worker message. It is debounced (300 ms) with a max wait (1 s), so apps that update continuously (animation, simulation, websockets) call it on every update without their own throttle. A capture-phase `click`/`change`/`input` listener plus dialog `close` events is a cheap catch-all (`references/frameworks.md`). For apps where none of that is practical, pass `watch: 1500` to poll while the drawer is open.

Optionally mirror the flag in the app (the Hello World status bar does this):

```js
agent.onContextStatus((s) => { badge.dataset.state = s.state; badge.title = `AI has ${s.syncedHash?.slice(0, 7) ?? 'nothing'}`; });
```

### 7. Fit the host app

- **Keyboard**: typing in the drawer never reaches host shortcut handlers (`isolateKeys`, on by default). Capture-phase host handlers must skip `e.target.closest('.aia-scope')`.
- **Modal dialogs**: `dialogs: 'dock'` if the app uses `showModal()` — otherwise the drawer is inert behind the modal. Pause JS focus traps while the drawer is open.
- **Layout**: if the shell has fixed-width columns or a wide header, add CSS under `html.aia-drawer-open` (`minmax(0, …)` columns, wrapping header actions; fixed elements use `--aia-push-width`). The dev-time warning (on for localhost) names what slides under the drawer.
- **Theme**: override `--aia-*` variables on `.aia-scope` (wins in light and dark mode); badge colours/ring/position with `--aia-badge-*`; give a small text toggle right padding for its context dot.

### 8. App-specific actions (optional)

`codeActions` add buttons to fenced code blocks, `replyActions` to whole replies:

```js
codeActions: [{ id: 'apply-sql', label: 'Run in query tab', when: (b) => b.language === 'sql', run: (b) => queryTab.open(b.code) }],
replyActions: [{ id: 'note', label: 'Save as note', run: (md) => notes.add(md) }],
```

Anything that changes data or runs commands must go through the app's normal confirmation UI. Tell the model about the buttons in the system prompt ("put SQL in a fenced `sql` block; the user can open it in the query tab"). For actions that apply **values** (settings, filters, parameters), assume a small local model will ignore the requested fence tag: validate the content in `when` with `parseBlockValues(block, { tags, schema })` (custom tag, or `json` when every key is known; lenient parsing; clamped to the control ranges) and apply through the app's real controls with `setControlValue(el, value)` — see Hello World's "Apply editor settings".

### 9. Relay (only when needed)

Use a relay when the app is deployed beyond localhost, keys must stay on the server, or a provider blocks browser calls. Pick the one that matches **production** (step 1), copy it **unchanged**, and put everything app-specific in its config file:

- PHP (Apache/XAMPP, Nginx + PHP-FPM): `assets/relay/relay.php` next to the app's endpoints; config `relay.config.php` (from `relay.config.example.php`) outside the web root (`AIA_RELAY_DIR`) or next to the relay in development. Sign-in/CSRF checks go in its `authorize` function.
- Node: `assets/relay/relay.mjs` as a sidecar or embedded (`createRelay(config).handle(req, res)`).
- **Local mode** (default) serves only the relay's own computer. **Public mode** (`'mode' => 'public'`) serves visitors with a fixed `preset` (provider, models, server key), same-origin checks, rate limits and caps.
- In the app: `relayProbe: true, defaults: { relayUrl: 'api/relay.php' }` — the relay is used when it answers `available`, direct requests otherwise. Server keys come from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` (environment, `SetEnv`, `fastcgi_param`) or the config.

Modes, contract, Nginx/Apache settings (buffering, timeouts, gzip, `open_basedir`, `real_ip`, CA bundles): `references/providers.md`.

### 10. Verify

Run the app (use the project's own dev server; for static sites `node <skill>/assets/relay/relay.mjs --static <app-root>` works), then run the automated check:

```bash
node <skill>/scripts/verify.mjs http://127.0.0.1:8787/ --change "<js that changes what is on screen>"
```

(`--no-llm` when no model is running.) It reports console errors, the hotkey and flag, typing a space in the composer, the context size, the layout at 1280/1366/1600 px with screenshots, and the read → change → re-read → "Page unchanged" loop. Then check by hand, in a browser if you can drive one:

1. No console errors on load; the toggle (and `Ctrl+I`) opens the drawer; the page content moves aside and nothing slides under the drawer.
2. **Settings > Context** shows the app context, the page context, the view state and the snapshot you intended — the fastest way to validate your hooks — and an estimated size that fits the target model.
3. Ask a question: the user message shows **"Read the page · <title> · N chars · <hash>"** and the flag turns green.
4. Change the content: the flag turns amber. Ask again: the page is re-read (new hash). Ask once more without changes: **"Page unchanged"**.
5. Navigate to another page: the page context and snapshot follow.
6. Type a space and letters in the composer (host shortcuts must not react); open a modal dialog and press the hotkey; dark mode and a narrow window look right.

If no LLM is reachable, say so and still verify the rest. Full checklist and fixes: `references/checklist.md`.

### 11. Report

Tell the user: which files you added/changed, the context plan per page, how to open it (button/`Ctrl+I`), how to configure the model (gear icon → Model; LM Studio needs its server started with CORS enabled and ≥ 8k context), the relay setup for production, and anything you could not verify.

## Rules

- Copy the runtime and the relays unchanged; configure them through options and config files. Do not fork or restyle their internals — theme with `--aia-*` CSS variables on `.aia-scope` and the host hooks (`html.aia-drawer-open`, `--aia-push-width`).
- One agent instance per app, created client-side, loaded so a failure cannot break the app. `appId` unique per app.
- Context is **what the user sees**, not the whole database, and never secrets.
- Keep content deterministic, built by a tested pure function; volatile state goes in `view`.
- The model never acts on its own: every action is a button the user clicks, applied through the app's own controls, and destructive actions keep the app's confirmation.
- Do not modify unrelated parts of the application; keep the integration small and in one module plus per-page hooks.
- Do not invent capabilities in the app context. List real limits.

## Quick API

```
createAiAgent(options) -> agent            options: appId, title, app, page, systemPrompt, welcome, suggestions,
                                                    toggle, push, hotkey, theme, width, watch, debounceMs,
                                                    debounceMaxMs, isolateKeys, dialogs, devWarnings, relayProbe,
                                                    contextWarnTokens, codeActions, replyActions, defaults,
                                                    relayHeaders, saveChats, resume, mount
agent.setApp(app) · agent.setPage(page) · agent.setContent(fn) · agent.setView(fn)
agent.contextChanged() · agent.refreshContext() · agent.getContextStatus() · agent.onContextStatus(fn)
agent.rereadPage() · agent.systemPrompt() · agent.ready · agent.relayInfo()
agent.open() · close() · toggle() · isOpen() · ask(text) · stop() · newChat() · openSettings(tab)
agent.on('open'|'close'|'send'|'reply'|'error'|'context'|'settings'|'relay', fn)
agent.settings.get() · save(patch) · reset() · setKey(provider, key) · agent.destroy()
fromDom(selector) -> content hook · parseBlockValues(block, {tags, schema}) · setControlValue(el, value) · probeRelay(url)
```

Full reference with types: `references/api.md` and `assets/ai-agent/ai-agent.d.ts`.
