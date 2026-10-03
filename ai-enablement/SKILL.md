---
name: ai-enablement
description: Install, upgrade and extend a web application's AI layer. Builds a screen-aware AI agent into the app (a chat drawer that sees the current page with hash-synced context, acts through tools wrapping the app's own functions, remembers notes, looks at screenshots, takes attachments, works with any LLM - LM Studio, Ollama, OpenAI, Anthropic, Gemini, relays) and manages its capability folder - MCP-compatible tools and toolsets, Agent Skills, agents, permissions - plus a dev workspace where the in-app agent writes new tools. Use when the user asks to add or integrate an AI agent, assistant, chatbot or copilot panel into an app; to update or upgrade one (it detects what is there, upgrades framework files, keeps the app's own); to add a tool, toolset, skill or agent to an app's AI ("add a tool that lets the AI inspect the current track"); to let the app's AI create tools; or mentions ai-enablement, add-ai-skill or the agent drawer. Vanilla ES modules, no build step; HTML, PHP, React, Vue, Svelte, Angular, Next.js.
license: MIT
---

# AI Enablement

You manage an application's AI layer, end to end and repeatably:

- **The runtime** (`assets/ai-agent/`, copied into the app unchanged): the agent drawer — it slides in from the right,
  sees what the user sees (app + page + live screen content, re-sent only when its hash changes, with a flag), acts
  through tools that wrap the app's own functions (confirmations, per-tool on/off, permissions), remembers notes, looks
  at screenshots, takes attachments, renders Markdown, keeps chats, talks to any LLM (LM Studio by default). It also
  loads the app's capabilities, runs agents and skills, and — in development — lets the in-app agent add tools.
- **The capability folder** (`ai/` in the app, app-owned): *what* the app's AI can do — `index.json` naming tool
  modules and toolsets, Agent Skills (`skills/<name>/SKILL.md`), agents (`agents/<name>.md`), permissions, the tool
  defaults (`ai-tools.json`) and the starting memories (`ai-memory.json`).
- **The lifecycle**: install → upgrade → validate → add → reconcile, safe to repeat. Framework files are replaced
  only when unchanged; the app's own files are only ever added to or edited in place; a manifest
  (`ai-enablement.json`) records what is where.

Everything lives in this skill folder (the folder that contains this `SKILL.md`). **Do not rewrite the runtime.**

## What is in this skill

| Path | What it is |
| --- | --- |
| `assets/ai-agent/` | **The runtime** (1.6), copied into apps unchanged: `ai-agent.js` (`createAiAgent`, `fromDom`, `parseBlockValues`, `setControlValue`, `probeRelay`, `toMcpTool`, `loadCapabilities`…), `ai-agent.css`, `ai-agent.d.ts`, `core/` (context, sync, settings, prompt, transport, tools, memory, attachments, and the framework layer: `capabilities`, `agents`, `skills`, `permissions`, `schema`, `frontmatter`, `workspace`), `adapters/`, `ui/`, `skills/create-tool/` (the built-in authoring skill). |
| `assets/relay/` | `relay.php` (PHP 8.1+) and `relay.mjs` (Node), copied unchanged, configured by a file; `relay.config.example.php`. |
| `assets/templates/` | Starting points: `ai/index.json`, a tool module, a toolset, a `SKILL.md`, an agent file, the manifest. |
| `examples/hello-world/` | **Reference integration**: a text editor with `ai-agent-setup.js` (mount + context hooks), `ai/` (three toolset modules over the editor's functions, two skills, two agents, permissions), `ai-enablement.json`. Read it before integrating. |
| `scripts/detect.mjs` | **Run first**: what is in the app — runtime, relay, integration, capability folders, manifest (or the 1.x record), dev-time folders, features — and what to do. Read-only. |
| `scripts/validate.mjs` | Loads the capability folder the way the runtime does; errors and warnings. Run after every change. |
| `scripts/scaffold.mjs` | Creates a tool, toolset, skill or agent from the templates and registers it (never overwrites). |
| `scripts/verify.mjs` | Headless Edge/Chrome check of the running app: console, hotkey, flag, typing, context size, tools, capabilities, memory, vision, attachments, layout, every Settings tab against its layout spec, and the read → change → re-read loop. |
| `scripts/guards.mjs` | The runtime CSS's **layout guards** (pinned dialog chrome, host-CSS isolation): reports them; `--apply` adds the missing ones in place to an *edited* runtime copy and records the patch. |
| `scripts/workspace.mjs` | Dev server for **in-app authoring**: the app's own agent reads its source and writes new tools (development only). |
| `references/` | `framework.md` (concepts and formats), `capabilities.md` (**add a tool / toolset / skill / agent**), `in-app-authoring.md`, `upgrading.md` (**apps that already have it**, the manifest), `settings-layout.md` (the settings dialog's layout spec and host CSS), `tools.md`, `memory-and-vision.md`, `context-sync.md`, `frameworks.md`, `providers.md`, `api.md`, `checklist.md`, `architecture.md`. |
| `CHANGELOG.md` | What each version changed, with **Upgrading** notes. |

## Step 0. Detect, then route (every time)

```bash
node <skill>/scripts/detect.mjs <app-root>
```

| detect says | Do |
| --- | --- |
| **No AI agent found** | **Install**: steps 1–15 below. |
| **UPGRADE** (older runtime or relay) | `references/upgrading.md`: replace framework files that are unchanged, reconcile edited ones, migrate, add only what is missing, write the manifest. Never build a second agent. |
| **CURRENT** | **Validate** (`scripts/validate.mjs <app-root>`), then do what the user asked. |
| The user asks for a capability ("add a tool that…", "a skill for…", "an agent that…") | After the routing above: `references/capabilities.md`. |

- The user's words set the scope ("just update the runtime", "add a tool", "add a Track Designer agent"); without one,
  propose the full upgrade or install.
- **Layout guards — every run on an app that has the agent** (install, upgrade, add a tool, anything): read detect's
  `Layout guards` lines (`layoutGuards` with `--json`). A guard **MISSING** is fixed in this run, whatever the task:
  an unchanged runtime copy is replaced (`references/upgrading.md`, U4); an edited one gets the guard blocks in place
  with `node <skill>/scripts/guards.mjs <app-root> --apply` (its other edits stay; the patch is recorded in the
  manifest). Tell the user in one line, e.g. "Also fixed the settings dialog: its tabs no longer clip and the page's
  own CSS no longer leaks in (runtime CSS 1.6.1)." Details: `references/upgrading.md`, "Layout guards"; the spec:
  `references/settings-layout.md`.
- `.claude/`, `.github/agents`, `.agents/skills`, `.codex/` hold the *coding agent's* skills and agents — not the
  app's. Leave them alone; the app's live in its capability folder.
- Without Node: search for `ai-agent.js` containing `export const VERSION`, for `createAiAgent(`, for an `index.json`
  with `"format": "ai-enablement/1"`, and for `ai-enablement.json` / `ai-agent.integration.json`.

## Install

### 1. Survey the app (read-only)

Find out, and keep notes:

- **Stack and entry points**: plain HTML/PHP, or a framework (React/Vite, Next.js, Vue, Svelte, Angular…); where the root layout is rendered.
- **Production stack**: web server (Apache, Nginx, Node, static hosting), PHP or Node, long-running processes allowed, how development differs. This decides the relay (step 13). Never plan on `.htaccess` or rewrites.
- **Where static assets are served from** (`public/`, `static/`, `assets/`) or whether code is bundled from `src/`; how caches are busted.
- **Every page/view/route and what it shows**: which state/store/API data renders it, what the user edits or selects, how often it changes.
- **The header/toolbar** for an "Ask AI" button and the **main content container** that makes room for the drawer; fixed-width grids, wide toolbars, fixed elements.
- **What the user can do on each page** — the action surface for tools: API clients, store actions, services, handlers behind buttons/menus/forms, navigation, controls with their real ranges. Classify each as read / write / destructive / external / system. Note **one object** that reaches them (the store, a service layer, the editor instance): it becomes `host`.
- **Kinds of work** users repeat in several steps (candidates for skills) and **distinct roles** (candidates for agents) — usually none at first.
- **Global keyboard handlers** and **modal dialogs** (`showModal()`, focus traps).
- **What the agent could not know from the screen**: shortcuts, hidden features, conventions — starting memories.
- **How the view is drawn** (DOM, canvas, WebGL), iframes, phones, `Permissions-Policy`, `Content-Security-Policy`.
- **Backend**, auth/CSRF, deployment beyond localhost. **Existing AI code** (do not build a second panel; ask). **Theme**.

### 2. Write the plan

Draft and show the user in a few lines (proceed unless they object):

- **App context**: name, purpose (from the README/UI), capabilities, limits — lean, generated from the app's own data modules.
- **Per page**: `id`, `title`, `purpose`, **content** (what represents the screen), **view** (selection, cursor, filters), the change signal.
- **System prompt**: persona and answer rules for this domain (start from `DEFAULT_SYSTEM_PROMPT`).
- **Tool plan**: per page, the tools — name, what it wraps (via `host`), effect, parameters with real ranges — grouped
  into **toolsets**, and what is left out on purpose (payments, security settings, messages to others, bulk deletes).
  Ask which start **on**.
- **Skills and agents** (optional): a skill per multi-step kind of work worth writing down; agents only for distinct
  roles (a "Proofreader" that may not rewrite). One implicit agent is the default.
- **Permissions**: anything the app must always confirm (`ask`) or never let the agent do (`deny`).
- **Memory plan**, **vision plan** (screen capture or a `screenshot` hook), **attachments** (`maxFileChars` for small
  models), **code/reply actions**, **transport** (direct or relay).

### 3. Install the runtime

Copy the whole `assets/ai-agent/` folder into the app, unchanged, next to the static assets (`assets/ai-agent/`,
`public/ai-agent/`) — or `src/lib/ai-agent/` for bundled apps. It is framework-owned: configure it through options,
never edit it (if a change is truly needed, make it generic and tell the user so it can be folded back into the skill).
Version the asset URLs or serve them `no-cache`.

### 4. Create the capability folder

```bash
node <skill>/scripts/scaffold.mjs <served-dir>/ai init       # index.json, ai-tools.json, ai-memory.json
```

It must be **served** next to the app (the runtime fetches its Markdown and JSON and imports tool modules), e.g.
`public/ai/`. Bundled apps whose modules live in `src/` keep the folder under `public/` for skills and agents and either
serve tool modules too or import them statically and pass them as `tools` (`references/framework.md`, "Bundled apps").

### 5. Mount the agent once

One integration module (e.g. `assets/js/ai-agent-setup.js`, `src/ai/agent.ts`), loaded with `import()` and a catch so
the app works without it:

```js
// in the app's entry script
import('./ai-agent-setup.js').then((m) => m.mountAgent()).catch((e) => console.warn('AI agent unavailable', e));
```

```js
// assets/js/ai-agent-setup.js
import { createAiAgent, DEFAULT_SYSTEM_PROMPT } from '../ai-agent/ai-agent.js';
import { store } from './store.js';                          // the object the tools call: `host`
import { buildItemsContent } from './ai-content.js';         // pure, unit-tested (step 6)
import { VIEWS } from './views.js';

export function mountAgent() {
  const agent = createAiAgent({
    appId: 'inventory',                          // unique per app, never changed (namespaces users' data)
    title: 'Inventory assistant',
    toggle: '#ask-ai',
    push: 'main',
    capabilities: 'assets/ai/index.json',        // tools, toolsets, skills, agents, permissions, defaults, memories
    host: store,                                 // tools: run(args, { host })
    // workspace: location.hostname === '127.0.0.1',   // development: in-app tool authoring (in-app-authoring.md)
    app: { name: 'Inventory', purpose: 'Track stock levels and purchase orders.', capabilities: VIEWS.map((v) => `${v.title}: ${v.summary}`), limits: ['Cannot place orders with suppliers'] },
    page: {
      id: 'items', title: 'Items', purpose: 'Stock items with quantity, location and reorder level.',
      content: () => buildItemsContent(store.getState()),      // what is on screen (hashed)
      view: () => ({ selected: store.getState().selectedIds }), // volatile (not hashed)
    },
    systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\nYou are the inventory assistant. …domain rules…`,
    welcome: 'I can see the items on your screen. Ask me about stock or reorders.',
    defaults: { provider: 'lmstudio' },
  });
  store.subscribe(() => agent.contextChanged());
  document.getElementById('ask-ai').hidden = false;
  return agent;
}
```

Client-side only, once. `agent.ready` resolves when the capability index, tool config, memory file and relay probe are
in. Recipes per framework: `references/frameworks.md`. Every option and method: `references/api.md`.

### 6. Wire every page

`agent.setPage({ id, title, purpose, content, view })` on navigation. **content** is what the user sees, compact and
deterministic, from a **pure, unit-tested builder** (state → text): the app's own state, not the DOM; the precision and
labels the UI shows; stable order; no clocks or random ids (volatile bits go in **view**); what open dialogs show; never
secrets. `fromDom('main')` when there is no state model. Details: `references/context-sync.md`.

### 7. Signal changes

`agent.contextChanged()` wherever content can change (store subscription, fetch completion, edits, worker messages) —
debounced with a max wait, so continuous updates need no throttle. `watch: 1500` polls as a last resort.
`agent.onContextStatus(fn)` mirrors the flag in the app.

### 8. Fit the host app

Typing never reaches host shortcuts (`isolateKeys`); capture-phase handlers skip `.aia-scope`. `dialogs: 'dock'` for
`showModal()`. Layout fixes under `html.aia-drawer-open` (`--aia-push-width`). Theme with `--aia-*` on `.aia-scope`.
The page's own element CSS (`label`, `button`, `input`, `p`, `body { text-align }`…) does not reach the agent's UI: never
"fix" the drawer or the settings dialog from app CSS (`references/settings-layout.md`).

### 9. Build the tools

One tool module per toolset (or per tool) in `ai/tools/`, following `references/capabilities.md` and `references/tools.md`:

```bash
node <skill>/scripts/scaffold.mjs <ai-dir> tool filter_orders --effect write --description "Show only orders with this status."
```

- Each tool calls a function the app **already has**, through `host` (`run(args, { host })`), or drives the real control
  with `setControlValue`. Never reimplement business logic; never add a tool the UI does not offer the user.
- Accurate `effect` (read / write / destructive / external / system; when unsure, the stronger), short `description`,
  parameters (`parameters` shorthand or a JSON Schema `inputSchema`) with real ranges and `required`, an explicit
  `maxLength` on long text, `pages` / `when` for where it applies, a short factual result.
- Group related tools as a toolset (`export default { name, title, description, tools: [...] }`); register modules in
  `index.json`; record which start on in `ai-tools.json`; add `permissions` for what must always ask or never run.
- Unit-test each module with `host` mocked.

### 10. Skills and agents (when the plan has them)

```bash
node <skill>/scripts/scaffold.mjs <ai-dir> skill track-design --description "Design a track: … Use when …"
node <skill>/scripts/scaffold.mjs <ai-dir> agent track-designer --description "…" --toolsets track --skills track-design
```

A skill is numbered steps for one kind of work (which tools, in which order, what to check), in the Agent Skills
format; long material in its `references/`. An agent composes existing tools, toolsets and skills with instructions,
permissions, context layers and memory policy — it never defines tools. Formats: `references/framework.md`.

### 11. Memory, vision and attachments

All three work once the runtime is in. Write `ai-memory.json` (short notes no screen shows, never secrets); keep the
browser's screen capture or pass a `screenshot` hook for canvas/WebGL views; set `defaults.maxFileChars` for small-
context models and `readFile` only for the app's own formats. `references/memory-and-vision.md`.

### 12. App-specific actions (optional)

`codeActions` (buttons on fenced code blocks) and `replyActions` (on whole replies); values applied through the real
controls with `parseBlockValues` + `setControlValue`. Anything that changes data uses the app's own confirmation UI.

### 13. Relay (only when needed)

Deployed beyond localhost, server-held keys, or providers that block browsers: copy `relay.php` or `relay.mjs`
unchanged (framework-owned), app settings in its config file (local mode by default; public mode with a fixed preset,
same-origin, rate limits). In the app: `relayProbe: true, defaults: { relayUrl: 'api/relay.php' }`. `references/providers.md`.

### 14. Verify

```bash
node <skill>/scripts/validate.mjs <app-root>                                  # the capability folder
node <skill>/scripts/verify.mjs http://127.0.0.1:8787/ --change "<js that changes the screen>"   # the running app
```

(`--no-llm` without a model.) Then by hand: no console errors; the toggle and `Ctrl+I`; every Settings tab (the tabs stay
visible, the layout matches `references/settings-layout.md`); Settings > Context shows the
intended app/page/view/snapshot at a size the model fits; "Read the page" then "Page unchanged"; navigation; a tool
call with its confirmation and roll-down; the agent picker and a skill (`/name`) if any; memory, a screenshot, an
attached file. Full list: `references/checklist.md`.

### 15. Manifest and report

Write **`ai-enablement.json`** at the app root (`references/upgrading.md`, "The manifest"): versions, `appId`, the
framework files (runtime, relay), the capability folder and what it holds, the integration files, features, declined
items, plans in brief. Never secrets. Tell the user: the files added, the context and tool plans (which tools are on),
skills and agents, memories, screenshots, attachments, how to open it, how to configure the model (LM Studio needs its
server started with CORS and ≥ 8k context), the relay, and anything you could not verify.

## Add or change a capability

On an app that has the framework (detect: CURRENT; capability folder present — or adopt one first,
`references/upgrading.md`, "Adopting the framework"). `references/capabilities.md` has the recipes:

- **Tool** — "add a tool that lets the AI inspect the current track": find the app function, choose the effect and
  parameters, `scaffold.mjs … tool`, write it over `host`, add it to `ai-tools.json`, unit-test, validate.
- **Toolset**, **skill**, **agent** — scaffold, write, reference by name, validate. Compose; never duplicate.
- **Context**, **memory**, **permissions**, **prompt** changes — edit the integration or the index.

Preserve what the app has: never overwrite an app-owned file wholesale; edit it in place.

## In-app authoring (the app's AI adds tools)

`node <skill>/scripts/workspace.mjs <app-root>` serves the app in development with a workspace endpoint; with
`workspace: true` in the integration, the in-app agent gets `describe_host`, `list_source_files`, `read_source_file`,
`search_source`, `write_ai_file` (always confirmed, with a diff), `reload_capabilities`, and the built-in
`create-tool` skill. The developer commits what it wrote. Setup and safety: `references/in-app-authoring.md`.

## Rules

- **Ownership**: the runtime folder and relay files are framework-owned — copied unchanged, replaced only when detect
  says they are unchanged, reconciled when edited. Everything else (integration, content builders, the capability
  folder, relay config, CSS) is app-owned — added to, edited in place, never replaced wholesale.
- One agent instance per app, client-side, loaded so a failure cannot break the app; `appId` never changes. An app
  that already has the agent is upgraded, never rebuilt.
- Context is what the user sees, never secrets; deterministic content from a tested pure builder.
- Tools wrap the app's own functions with the user's own permissions; changes are confirmed by default; destructive,
  external and system tools start off; the app's own confirmations and server checks stay.
- Skills and agents compose what exists; formats follow Agent Skills and the agent-file convention — no proprietary
  extras where the format already has a field.
- Memory holds notes, never secrets or instructions. Screenshots and attachments go to the model provider only when
  the user sends them (`screenshots: false` / `attachments: false` where they must not).
- The workspace is development-only; it never ships with the app.
- Do not modify unrelated parts of the app. Do not invent capabilities in the app context.

## Quick API

```
createAiAgent(options) -> agent        options: appId, title, app, page, systemPrompt, welcome, suggestions, toggle,
                                                push, hotkey, theme, width, watch, debounceMs, debounceMaxMs, isolateKeys,
                                                dialogs, devWarnings, relayProbe, contextWarnTokens, tools, toolsConfig,
                                                host, capabilities, agents, skills, toolsets, permissions, agent, workspace,
                                                memory, memoryFile, memorySave, screenshots, screenshot, screenshotMaxEdge,
                                                attachments, readFile, codeActions, replyActions, defaults, relayHeaders,
                                                saveChats, resume, mount
agent.setApp · setPage · setContent · setView · contextChanged · refreshContext · getContextStatus · onContextStatus
agent.tools.list · register · unregister · setEnabled · run · exportConfig · toolsets · mcp
agent.agents.list · current · use(name)        agent.skills.list · activate(name) · active
agent.capabilities.reload · problems · index    agent.workspace()
agent.memory.list · add · update · remove · clear · export · import     agent.screenshot() · agent.attach(files)
agent.open · close · toggle · isOpen · ask · stop · newChat · openSettings · systemPrompt · ready · relayInfo · destroy
agent.on('open'|'close'|'send'|'reply'|'error'|'context'|'settings'|'relay'|'tool'|'tool-state'|'memory'|'screenshot'|'attach'|'agent'|'skill'|'capabilities'|'workspace', fn)
fromDom · parseBlockValues · setControlValue · probeRelay · toMcpTool · fromJsonSchema · loadCapabilities · parseSkill · parseAgent
```

Full reference with types: `references/api.md` and `assets/ai-agent/ai-agent.d.ts`.
