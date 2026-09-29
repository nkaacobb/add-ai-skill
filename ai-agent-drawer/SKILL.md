---
name: ai-agent-drawer
description: Build a screen-aware AI agent into any web application - a chat drawer that slides out from the right, sees what the user sees (application context + page context + live screen content that is re-sent only when its hash changes, with a visible in-sync/changed flag), streams replies as rich Markdown, keeps saved chats, and has a settings panel for any LLM (LM Studio by default, Ollama, OpenAI, Anthropic, Gemini, DeepSeek, OpenRouter, any OpenAI-compatible server, or a PHP/Node relay) with an editable system prompt. Use when the user asks to add, build or integrate an AI agent, AI assistant, chatbot, copilot panel, or "chat with what is on screen" into an app, or mentions the ai-agent-drawer skill or pattern. Vanilla ES modules with no build step and no dependencies; works with plain HTML, PHP, React, Vue, Svelte, Angular and Next.js.
---

# AI Agent Drawer

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
| `assets/ai-agent/` | **The runtime to copy into the app.** `ai-agent.js` (entry: `createAiAgent`, `fromDom`), `ai-agent.css`, `ai-agent.d.ts`, `core/` (context, sync protocol, hashing, settings, prompt, transport, client), `adapters/` (openai-chat, anthropic, gemini, relay), `ui/` (drawer, settings modal, markdown, resize). |
| `assets/relay/relay.php` | Drop-in PHP relay (XAMPP/Apache, php-fpm). Streams via cURL. Localhost-only by default. |
| `assets/relay/relay.mjs` | Node relay + optional static server (zero dependencies, reuses the browser adapters). |
| `examples/hello-world/` | **Reference integration**: a text editor (type or open a file) wired with app/page/content/view hooks, a status-bar sync flag, and "Insert at cursor" / "Replace document" actions. Read `app.js` before integrating. |
| `references/` | `api.md` (every option and method), `context-sync.md` (the protocol), `frameworks.md` (plain HTML, PHP multi-page, React, Vue, Svelte, Angular, Next.js recipes), `providers.md` (LLMs, CORS, keys, relays, adding a provider), `checklist.md` (verification + troubleshooting), `architecture.md` (how the pieces fit). |
| `tests/` | `node --test` unit tests for the runtime (run them if you ever change the runtime). |

## Workflow

### 1. Survey the app (read-only)

Find out, and keep notes:

- **Stack and entry points**: plain HTML/PHP templates, or a framework (React/Vite, Next.js, Vue, Svelte, Angular…). Where the root layout/shell is rendered.
- **Where static assets are served from** (`public/`, `static/`, `assets/`, `wwwroot/`), or whether code is bundled from `src/`.
- **Every page/view/route** the user can be on, and **what each one shows**: which state/store/API data renders it, what the user edits or selects there.
- **The header/toolbar** where an "Ask AI" button belongs, and the **main content container** that should make room for the drawer.
- **Backend**: is there a server (PHP, Node, Python…)? Will the app be deployed beyond localhost? Is there auth/CSRF?
- **Existing AI code** or an existing chat panel (do not build a second one; ask the user).
- **Theme**: brand colors / CSS variables, light/dark support.

### 2. Write the context plan

Before coding, draft this and show it to the user in a few lines (proceed unless they object):

- **App context**: name, purpose (1–2 sentences written from the README/UI, not invented), capabilities (what the app can do), limits (what it cannot do — this prevents the model from promising features that do not exist), domain glossary if useful.
- **Per page**: `id`, `title`, `purpose`, **content** (exactly what data represents the screen: visible rows, the open record, the document text, form values…), **view** (selection, cursor, active tab, filters, sort), and **where the change signal comes from** (store subscription, fetch completion, input events).
- **System prompt**: the persona and answer rules for this domain (start from `DEFAULT_SYSTEM_PROMPT` and add domain rules, like the Hello World example does).
- **Actions** worth adding to code blocks/replies (insert into editor, apply a filter, open a record, copy as SQL…). Never auto-execute: the user clicks.
- **Transport**: direct from the browser (default; fine for local LLMs and personal tools) or through a relay (deployed apps, server-held keys, providers that block CORS).

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

Keep the folder self-contained so it can be re-synced from the skill later. Configure through options; do not edit the runtime files. (If a runtime change is truly needed, make it generic, and tell the user so they can fold it back into the skill.)

### 4. Mount the agent once

Create **one integration module** in the app (e.g. `assets/js/ai-agent-setup.js`, `src/ai/agent.ts`) that calls `createAiAgent` once at startup on the client and exports the instance. Minimal plain-HTML version:

```html
<!-- in the page shell -->
<link rel="stylesheet" href="assets/ai-agent/ai-agent.css">
<button type="button" id="ask-ai">Ask AI</button>
<script type="module" src="assets/js/ai-agent-setup.js"></script>
```

```js
// assets/js/ai-agent-setup.js
import { createAiAgent, DEFAULT_SYSTEM_PROMPT } from '../ai-agent/ai-agent.js';
import { state, store } from './store.js';         // however the app holds its state

export const agent = createAiAgent({
  appId: 'inventory',                          // unique per app: namespaces settings, keys and chats
  title: 'Inventory assistant',
  toggle: '#ask-ai',                           // omit to get a floating launcher button
  push: 'main',                                // container that makes room for the drawer
  app: {
    name: 'Inventory',
    purpose: 'Track stock levels and purchase orders for the warehouse.',
    capabilities: ['Search and filter items', 'Edit stock counts', 'Export CSV'],
    limits: ['Cannot place orders with suppliers', 'Only sees the current page'],
  },
  page: {
    id: 'items',
    title: 'Items',
    purpose: 'Lists stock items with quantity, location and reorder level.',
    content: () => ({ filters: state.filters, rows: state.visibleRows }),   // what is on screen (hashed)
    view: () => ({ selected: state.selectedIds, sort: state.sort }),     // volatile (not hashed)
  },
  systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nYou are the inventory assistant. …domain rules…`,
  welcome: 'I can see the items on your screen. Ask me about stock, reorders or anything odd.',
  suggestions: ['Which items are below their reorder level?', 'Summarize this view'],
  defaults: { provider: 'lmstudio' },          // LM Studio at http://127.0.0.1:9000, loaded model
});

store.subscribe(() => agent.contextChanged());   // the change signal
```

The hooks read `state` when they are called, so every snapshot sees the latest values.

Framework recipes (React hook, Vue composable, Svelte, Angular service, Next.js client component, PHP multi-page) are in `references/frameworks.md`. Always create the agent on the client only (never during SSR), and only once.

### 5. Wire every page

- On navigation call `agent.setPage({ id, title, purpose, content, view })` for the page now shown.
- **content** must describe what the user actually sees, compactly and deterministically:
  - Prefer the app's own state (the rows after filtering/paging, the record being viewed, the document text) over scraping the DOM.
  - Stable ordering and formatting; no clocks, random ids, or "updated 3s ago" strings — anything that changes on its own makes the flag flip to *changed* for nothing. Put volatile bits in **view**.
  - Include the labels a human sees (column names, field labels, units) so the model can refer to them.
  - Cap large data at what is visible (the runtime also truncates at *Max screen content*, 24,000 chars by default, and tells the model it did).
  - Never include secrets, tokens, passwords, or data the current user is not allowed to see.
- If a page has no good state model, `fromDom('main')` (exported by the runtime) reads the rendered text of an element plus visible form values, skipping the agent's own UI.

### 6. Signal changes

Call `agent.contextChanged()` wherever that page's content can change: after data loads/refreshes, on edits, on filter/sort/paging changes, in a store subscription. It is debounced and cheap (it only re-hashes and updates the flag; nothing is sent until the user asks). For apps where that is impractical, pass `watch: 1500` to poll while the drawer is open.

Optionally mirror the flag in the app (the Hello World status bar does this):

```js
agent.onContextStatus((s) => { badge.dataset.state = s.state; badge.title = `AI has ${s.syncedHash?.slice(0, 7) ?? 'nothing'}`; });
```

### 7. App-specific actions (optional)

`codeActions` add buttons to fenced code blocks, `replyActions` to whole replies:

```js
codeActions: [{ id: 'apply-sql', label: 'Run in query tab', when: (b) => b.language === 'sql', run: (b) => queryTab.open(b.code) }],
replyActions: [{ id: 'note', label: 'Save as note', run: (md) => notes.add(md) }],
```

Anything that changes data or runs commands must go through the app's normal confirmation UI. Tell the model about the buttons in the system prompt ("put SQL in a fenced `sql` block; the user can open it in the query tab").

### 8. Relay (only when needed)

Use a relay when the app is deployed beyond localhost, keys must stay on the server, or a provider blocks browser calls:

- PHP apps: copy `assets/relay/relay.php` next to the app's endpoints; add the app's auth/CSRF check where the file marks it.
- Node apps: port the handler in `assets/relay/relay.mjs` into the app's server (it imports the runtime's `core/client.js`), or run it as a sidecar.
- Then set `defaults: { transport: 'relay', relayUrl: 'api/relay.php' }` (and `relayHeaders` for a CSRF token). Server keys come from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`.

Details and the wire contract: `references/providers.md`.

### 9. Verify

Run the app (use the project's own dev server; for static sites `node <skill>/assets/relay/relay.mjs --static <app-root>` works) and check, in a browser if you can drive one:

1. No console errors on load; the toggle (and `Ctrl+I`) opens the drawer; the page content moves aside.
2. **Settings > Context** shows the app context, the page context, the view state and the snapshot you intended — this is the fastest way to validate your hooks.
3. Ask a question: the user message shows **"Read the page · <title> · N chars · <hash>"** and the flag turns green.
4. Change the content: the flag turns amber. Ask again: the page is re-read (new hash). Ask once more without changes: **"Page unchanged"**.
5. Navigate to another page: the page context and snapshot follow.
6. Dark mode and a narrow window look right.

If no LLM is reachable, say so and still verify steps 1, 2 and the flag transitions. Full checklist and fixes: `references/checklist.md`.

### 10. Report

Tell the user: which files you added/changed, the context plan per page, how to open it (button/`Ctrl+I`), how to configure the model (gear icon → Model; LM Studio needs its server started with CORS enabled), and anything you could not verify.

## Rules

- Copy the runtime; configure it through options. Do not fork or restyle its internals — theme with `--aia-*` CSS variables on `.aia-scope` (e.g. `--aia-accent`).
- One agent instance per app, created client-side. `appId` unique per app.
- Context is **what the user sees**, not the whole database, and never secrets.
- Keep content deterministic; volatile state goes in `view`.
- The model never acts on its own: every action is a button the user clicks, and destructive actions keep the app's confirmation.
- Do not modify unrelated parts of the application; keep the integration small and in one module plus per-page hooks.
- Do not invent capabilities in the app context. List real limits.

## Quick API

```
createAiAgent(options) -> agent            options: appId, title, app, page, systemPrompt, welcome, suggestions,
                                                    toggle, push, hotkey, theme, width, watch, codeActions,
                                                    replyActions, defaults, relayHeaders, saveChats, resume, mount
agent.setApp(app) · agent.setPage(page) · agent.setContent(fn) · agent.setView(fn)
agent.contextChanged() · agent.refreshContext() · agent.getContextStatus() · agent.onContextStatus(fn)
agent.rereadPage() · agent.systemPrompt()
agent.open() · close() · toggle() · isOpen() · ask(text) · stop() · newChat() · openSettings(tab)
agent.on('open'|'close'|'send'|'reply'|'error'|'context'|'settings', fn)
agent.settings.get() · save(patch) · reset() · setKey(provider, key) · agent.destroy()
fromDom(selector) -> content hook
```

Full reference with types: `references/api.md` and `assets/ai-agent/ai-agent.d.ts`.
