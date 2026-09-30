# Changelog

All notable changes to the add-ai-skill skill (it builds the "AI agent drawer" into apps). The skill's version is in
`package.json`; the runtime (`VERSION` in `assets/ai-agent/ai-agent.js`) and the relays (`AIA_RELAY_VERSION` /
`RELAY_VERSION`) carry their own, which only change when their code does. `scripts/release-hashes.json` fingerprints
every released runtime and relay.

## 1.4.0 — memory and vision (runtime and relays 1.3.0)

The agent remembers what it is asked to remember, and can look at the screen. Both are part of the runtime: an app
gets them by replacing its runtime copy, and the skill adds the app-specific part. All 1.2 options and methods keep
working.

### Memory

- Notes kept between conversations: the user says "remember that…", the model calls the built-in `remember` tool, the
  chat shows a chip with **Undo**; `forget` deletes one after the user confirms. The notes are a `== MEMORY ==`
  section of every system prompt, marked as notes that lose against the screen.
- **Settings > Memory**: the list (edit, delete, add), *Download ai-memory.json*, *Copy JSON*, *Import a file…*,
  *Delete all*, and two switches (use memories; let the agent save them).
- `memoryFile` (`ai-memory.json`): the app's starting notes. A browser stores only what differs from the file (its own
  notes, edits, deletions), so a later file still reaches users. `memorySave(file)` lets an app's backend keep them.
- `agent.memory` (`list`, `add`, `update`, `remove`, `clear`, `export`, `import`), the `memory` event, the settings
  `memoryEnabled` / `memoryWrite`, `memory: false` to remove it. Limits: 100 notes of 500 characters.

### Vision

- A **camera button** beside Send attaches a screenshot of what the user is looking at (a thumbnail in the composer,
  then on the question); the model receives it as an image.
- The agent's own `take_screenshot` tool, callable only when the user frees it (Settings > Vision: untick "Only take
  a screenshot when I press the camera button"). Otherwise the agent can ask, and the user gets *Allow once* /
  *Always allow* / *No*. Every screenshot the agent takes shows as a thumbnail on its chip.
- **Settings > Vision**: "This model can see images" (off: no camera button, no screenshots), the camera-only switch,
  how screenshots are taken here, *Stop sharing this tab*; with LM Studio, what the server says about the loaded model.
- Two ways to take the picture: the browser's screen capture of the tab (default: the whole page as displayed, drawer
  cropped off; the browser asks the user) or the app's `screenshot` hook (a canvas, image, video frame, Blob…; no
  prompt; a WebGL canvas returned right after a render is read before its buffer is cleared).
- JPEG scaled to `screenshotMaxEdge` (1280 px); only the two newest questions with screenshots send their images;
  saved chats keep thumbnails only. `agent.screenshot()`, the `screenshot` event, the settings `vision` /
  `screenshotAuto`, `screenshots: false` to remove it.
- Images in all three provider formats (OpenAI-compatible, Anthropic, Gemini) and in text-mode tool results. Checked
  live with a vision model on LM Studio; Anthropic and Gemini follow their documented formats (unit-tested, not run live).

### Relays (1.3.0)

- `relay.php` and `relay.mjs` check and pass `images` on user messages and tool results: `limits.maxImages` (public 4,
  local 16; 0 refuses images) and `maxImageBytes` (public 1.5 MB, local 4 MB, as base64), on top of `maxBodyBytes`,
  which stays the cap for the text. The GET reply has `images` and, from the preset, `vision`.
- The drawer asks a relay once before the first request with an image, and refuses the question with a clear message
  when the relay is older than 1.3 (it would drop the image silently). With `relayProbe`, such a relay switches vision off.
- `relay.php` answers 413 with the reason when a body is larger than PHP's `post_max_size` (PHP discards such bodies).

### Skill workflow

- New step 9, **Memory and vision**, and `references/memory-and-vision.md`: collecting the seed notes, `ai-memory.json`,
  where users' notes live, choosing the capture method, hook recipes (2D, WebGL, layered canvases), host requirements
  (secure context, `Permissions-Policy`, CSP), relay limits, privacy.
- `scripts/detect.mjs` reports, per feature (tools, memory, vision), whether the installed runtime has it and whether
  the integration uses it, plus canvases/WebGL views and policy headers that matter for screenshots — so an upgrade
  adds only what is missing. `references/upgrading.md` has the steps for an app at 1.2 or older.
- `scripts/verify.mjs`: `memory` and `vision` checks (it takes one screenshot the way the camera button does).
- Hello World ships `ai-memory.json`.
- Tests: the memory store and prompt, images per provider and in the conversation, relay image limits (Node + PHP),
  and in a real browser: remember / forget / Undo / Settings > Memory, a WebGL `screenshot` hook, the agent asking to
  look, and the browser's screen capture with the drawer cropped off.

### Upgrading from 1.2

1. Re-copy `assets/ai-agent/` and the relay. Memory and vision are then on with their defaults.
2. Add what the app lacks (`references/upgrading.md`, "Adding memory and vision"): `ai-memory.json` + `memoryFile`,
   and a `screenshot` hook where the view is a canvas. Set `defaults: { vision: false }` for a text-only default model.
3. Behaviour changes to know about:
   - Requests now carry tool definitions even in apps without tools (`remember`, `forget`, and `request_tool` while
     the agent may not look on its own). A model server without tool calling gets them as text blocks automatically.
     `memory: false` and `screenshots: false` give exactly the 1.2 requests.
   - The default composer placeholder is shorter ("Ask about what is on screen…").
   - A relay must be 1.3 for screenshots; its body cap for text is unchanged, images come on top. Raise
     `client_max_body_size` / `post_max_size` in front of it.
   - A page with a `Content-Security-Policy` needs `img-src data:` for the thumbnails.

## 1.3.0 — upgrade mode (runtime and relays unchanged: 1.2.0)

Running the skill on an app that already has the agent now upgrades it instead of building a second one.

- **Step 0** in SKILL.md: run `scripts/detect.mjs` first. It finds the runtime copy and its version, says whether the
  copy is unchanged since its release (fingerprints for 1.0.0, 1.1.0 and 1.2.0), finds relays (with 1.0-style edits:
  constants, keys or auth code inside the file — never printing keys), relay config files (names only), every
  `createAiAgent()` call with its `appId` and options, the integration record, tool configs, and app code that looks
  like a workaround a newer runtime covers. It ends with BUILD, UPGRADE or CURRENT.
- **`references/upgrading.md`**: the upgrade workflow — read the record and the CHANGELOG since the installed
  version, propose the upgrade, replace the runtime and relay wholesale (migrating 1.0 relay constants to
  `relay.config.php`), remove redundant workarounds (table), offer the new features that fit (tools first), verify,
  and record. Keeps the `appId`, hooks, prompts and customisations.
- **`ai-agent.integration.json`**: every integration and upgrade leaves a record in the app (versions, files,
  features, plans, declined features), so the next run knows exactly what is there.
- `scripts/release-hashes.mjs` records the fingerprints of a release (maintainers: run it for every release).
- Tests: `tests/detect.test.mjs`.

## 1.2.0 — the agent can act: tools

The agent no longer only explains and suggests: it calls the application's own functions. All 1.1 options and
methods keep working; an app without `tools` behaves exactly as before.

### Skill workflow

- Survey step: the app's **action surface** (API clients, store actions, services, handlers, controls with ranges).
- Context plan: a **tool plan** per page (what each tool wraps, read / write / destructive, parameters, what is left
  out), with the user choosing which tools start on.
- New step "Build the tools" and `references/tools.md`: one tools module over the app's own functions, `ai-tools.json`
  for the default selection, unit tests, and checks with a model.

### Runtime

- `tools` option, `page.tools`, `toolsConfig` (e.g. `'ai-tools.json'`), and `agent.tools` (`list`, `register`,
  `unregister`, `setEnabled`, `run`, `exportConfig`); events `tool` and `tool-state`.
- The tool loop: native tool calls for OpenAI-compatible servers (LM Studio, Ollama, OpenAI, DeepSeek, OpenRouter,
  custom), Anthropic and Gemini; a text-block protocol for models without tool calling (`toolMode`); arguments
  validated and clamped; results (and the screen, if it changed) sent back; up to `maxToolSteps` rounds.
- Confirmations: write tools ask (*Run* / *Allow for this chat* / *Skip*), destructive tools always ask — both
  switchable (`confirmWrites`, `confirmDestructive`). Reading tools never ask.
- Turned-off tools stay known to the model: it can say so and ask with the built-in `request_tool`, which shows a
  *Turn on* button; turning a tool on saves the choice.
- **Settings > Tools**: a checkbox per tool (grouped, with its effect and availability), the switches, and
  "Download ai-tools.json" to make the selection the app's default. Only choices that differ from the app's defaults
  are stored.
- Chips for every call in the reply; actions kept in saved chats and summarised in later requests.
- Settings > Context counts the tool definitions in the size estimate; the Context tab's system prompt includes the
  TOOLS section.
- Some local models (seen with LM Studio + Qwen 3.5 9B) answer the step after a tool round only in their reasoning
  channel: that reasoning is shown as the answer.

### Relays (1.2.0)

- `relay.php` and `relay.mjs` pass `tools` and `toolTurns` to the provider (all three protocols) and stream
  `tool_call` events. Public mode counts one question per chain of tool steps (`turnId`) up to `limits.maxToolSteps`;
  a forged continuation is counted. New limits `maxTools` (64) and `maxToolSteps` (public 10, local 30).

### Tooling

- `scripts/verify.mjs` reports the tool catalog and runs the reading tools that need no arguments.
- Hello World: eight tools over the editor's functions (`ai-tools.js`) and `ai-tools.json`.
- Tests: tool unit tests, adapter tool formats, relay tool pass-through (Node + PHP), the full drawer tool loop in a
  real browser (confirmation, turn-on, text mode), Hello World's tools.

### Upgrading from 1.1

Re-copy `assets/ai-agent/` and the relay. Nothing else changes until you add `tools`. A 1.1 relay ignores tools, so
upgrade the relay too if the app uses one.

## 1.1.0 — lessons from the first production integration

The skill is now named **add-ai-skill** (was `ai-agent-drawer`): install it with the repository's
`install-skill.ps1` / `install-skill.sh`, which also remove copies installed under the old name. What it puts into
apps keeps its names: the `ai-agent/` runtime folder, the `aia-` CSS prefix, and the relay protocol identifiers
(`X-Requested-With: ai-agent-drawer`, `"relay": "ai-agent-drawer"`), so existing integrations and relays keep working.

A WebGL simulation fed by a Web Worker (~10 state updates/s), native `<dialog>` modals, a dense fixed-width header,
developed on XAMPP and deployed on Nginx + PHP-FPM. Everything it needed app-side workarounds for is now built in or
documented. All 1.0 options and methods keep working.

### Runtime

- **`contextChanged()` no longer starves under continuous updates**: a trailing debounce with a max wait
  (`debounceMaxMs`, default 1000). Before, an app changing state every ~100 ms never let the 300 ms debounce fire.
- **Key isolation** (`isolateKeys`, default on): key events that start inside the drawer or the settings modal do not
  reach the host's bubbling listeners, so host shortcuts (Space = play, letters, arrows) cannot swallow typing.
  Ctrl/Cmd application shortcuts still reach the host; the hotkey and Escape work from inside the drawer.
- **Native modal dialogs** (`dialogs: 'dock'`, opt-in): dialogs are shown non-modally beside the open drawer and
  become modal again when it closes, without `close`/`beforetoggle`/`toggle` events reaching the host.
- **Dev-time warnings** (`devWarnings`, default on for local hosts): the pushed layout overflows or hides elements
  (including the toggle) under the drawer; a modal dialog makes the drawer inert.
- **Theming**: the theme rules are wrapped in `:where()`, so host `.aia-scope { --aia-… }` overrides win in dark
  mode too. New `--aia-badge-synced/-dirty/-unread/-ring/-size/-top/-right` variables for the toggle's context dot
  (defaults unchanged). New `--aia-push-width` host hook. `html.aia-drawer-open` and `--aia-drawer-width` are now
  documented, supported hooks.
- **Code actions that survive small models**: `parseBlockValues(block, { tags, schema })` (custom tag, or `json` when
  every key is known; JSON or `key: value` lines; linear-time parsing; clamping) and `setControlValue(el, value)`
  (applies through the app's real controls: native setter + `input`/`change`).
- **Relay auto-detection**: `relayProbe` (GET the relay at startup, use it when `available`, with its preset) and
  async `defaults` (promise or async function). New `agent.ready`, `agent.relayInfo()`, `relay` event. Saved settings
  that no longer fit the relay are adjusted when read, without touching storage.
- **Resume**: a drawer reopened during `createAiAgent()` replays its `open` event (`{ resumed: true }`) to listeners
  registered in the same tick. The composer no longer takes focus from a settings modal opened right after the drawer.
- **Context size**: Settings > Context shows the estimated tokens of the first request and warns (local providers)
  above `contextWarnTokens` (3000).
- Relay errors keep their own code and message in the drawer (a refused origin is no longer shown as "check your
  API key"); `detail` is appended when the relay sends one.

### Relays

- `relay.php` and `relay.mjs` are configured by a **config file** (`relay.config.example.php`; `.json`/`.mjs` for
  Node), looked up in `AIA_RELAY_CONFIG`, then `AIA_RELAY_DIR` (default: `ai-agent-relay` next to the web root), then
  next to the relay. Apps copy the relay unchanged.
- **Public mode**: only the configured preset (provider, models, server key); visitor keys never forwarded;
  same-origin enforced (`X-Requested-With`, `Origin`, `Sec-Fetch-Site`, no CORS headers); per-visitor per-minute and
  per-day limits plus a site-wide daily cap (salted, daily-rotating hashes; IPv6 by /64; no addresses or text stored);
  body, message-count and reply-token caps.
- Streams start with `: open` and send `: keepalive` comments every ~15 s while the model is silent (Nginx
  `fastcgi_read_timeout`; also detects a visitor's Stop). `X-Accel-Buffering: no`, `apache_setenv('no-gzip')`.
- Typed errors with HTTP status and drawer error code; misconfiguration details only for requests from the server
  itself. `GET` always answers 200 (`available: false` instead of 403). Keys from `getenv()` and `$_SERVER`
  (`fastcgi_param`), then the config. `caBundle: 'native'` for Windows certificate stores (TLS-scanning antivirus).
- `relay.mjs` exports `createRelay`, `loadConfig`, `createStaticHandler`; its static server never serves
  `relay.config.*` or dotfiles.

### Tooling and docs

- `scripts/verify.mjs`: automated integration check in headless Edge/Chrome (no dependencies; Node 22+).
- Tests: `tests/relay.test.mjs` (both relays, fake upstream), `tests/browser.test.mjs` (real browser),
  `tests/example.test.mjs`; new unit tests in `tests/runtime.test.mjs`.
- Hello World now loads its integration with `import()` (`ai-agent-setup.js`), builds its content in a pure tested
  module (`content.js`), and has an "Apply editor settings" code action using the new helpers.
- References: real-time apps, content builders, keyboard shortcuts, modal dialogs, layout recipe, change signals,
  small-model code actions, stale caches, local model context size, relay modes/config, Nginx + PHP-FPM and
  Apache/XAMPP deployment, TLS trust.

### Upgrading an app from 1.0

1. Re-copy `assets/ai-agent/` (unchanged, as always).
2. Re-copy `relay.php` / `relay.mjs`. If you had edited constants in 1.0's `relay.php`, move them to a
   `relay.config.php`: `AIA_ALLOW_REMOTE` → `'allowRemote'`, `AIA_ALLOW_ANY_UPSTREAM` → `'allowAnyUpstream'`,
   `AIA_KEYS` → `'keys'`, `AIA_TIMEOUT` → `'timeout'`, `AIA_MAX_BODY` → `'limits' => ['maxBodyBytes' => …]`; an auth
   check you added in the file goes into `'authorize'`.
3. Behaviour changes to know about: typing in the drawer no longer reaches host key handlers (`isolateKeys: false`
   restores 1.0); the flag refreshes during continuous updates (`debounceMaxMs: 0` restores 1.0); dev warnings appear
   in the console on local hosts (`devWarnings: false`); the relay's GET answers 200 with `available: false` for
   clients it will not serve (was 403); in local mode, requests that came through a proxy (`X-Forwarded-For`…) are no
   longer treated as local — a local dev proxy in front of the relay needs `allowRemote`.
4. Remove app-side workarounds the runtime now covers: your own `contextChanged` throttle, dialog/`showModal`
   switching code (use `dialogs: 'dock'`), keydown filters for the drawer, a pre-mount relay probe (use `relayProbe`).

## 1.0.0

First version: drawer, context layers and hash-based sync with the flag, rich Markdown, saved chats, settings for
eight providers, editable system prompt, PHP and Node relays (local only), Hello World example, unit tests.
