# Verification checklist and troubleshooting

## Automated check

```bash
node <skill>/scripts/verify.mjs http://127.0.0.1:8080/ --change "<js that changes what is on screen>"
```

Drives headless Edge/Chrome (Node 22+, nothing to install): console errors on load, the hotkey and the flag, the
toggle, typing a space in the composer, Settings > Context size, the tool catalog, the starting memories, one
screenshot taken the way the camera button takes it, the + menu and one attached text file, the pushed layout at
1280/1366/1600 px, every Settings tab at 1920×1080 and 1280×600 against its layout spec (`settings-layout.md`; a
failure names the host CSS rule behind it) — with screenshots in `.verify/` — and, with a model running, "Read the
page" → synced → change → dirty → re-read →
"Page unchanged". `--no-llm` skips the questions; `--toggle`, `--agent`, `--widths`, `--question` adjust it; `--help`
lists everything. Exit code 1 when a check fails. It does not replace looking at the page yourself.

## Before you say it is done

- [ ] `scripts/detect.mjs` was run first: an app that already had the agent was **upgraded** (`upgrading.md`), not
      given a second one; the `appId` did not change; old saved chats and settings still load.
- [ ] `ai-enablement.json` written or updated at the app's root (versions, framework files, capability folder,
      integration files, features, plans, declined features — no secrets); a 1.x `ai-agent.integration.json` was
      turned into it.
- [ ] `scripts/validate.mjs <app-root>`: no errors; the warnings read and either fixed or explained.
- [ ] **Capabilities** (with a capability folder): `verify.mjs` → capabilities lists the intended agents, skills and
      toolsets and no problems; with two or more agents the title is a picker and switching starts a new chat; a skill
      loads when its kind of work is asked for (a *Use skill* row) and with `/name`; permission badges in
      Settings > Tools match the plan (a `deny` tool is *blocked*); development-time folders (`.claude/` …) untouched.
- [ ] `ai-agent/` copied unchanged; `ai-agent.css` loaded once; the agent created once, client-side. Detect's
      `Layout guards` line says pinned chrome: yes · host isolation: yes (an edited copy got them with
      `scripts/guards.mjs --apply`, recorded under `patches` in the manifest).
- [ ] The integration module is loaded with `import()` and a `.catch()`: the app works if it fails to load.
- [ ] `appId` is unique to this application.
- [ ] App context describes the real app (purpose, capabilities, **limits**) — nothing invented — and stays lean
      (titles and lists, generated from the app's own data where possible).
- [ ] Every page/view calls `setPage` with an `id`, `title`, `purpose` and a `content` hook; `view` where there is
      selection/cursor/filter state. The content builder is a pure function with tests (same state → same text;
      change → different text; no `NaN`/`undefined`; labels as in the UI).
- [ ] `contextChanged()` is called wherever the visible data changes (or `watch` is set). Real-time apps call it on
      every update and let `debounceMaxMs` pace the flag.
- [ ] Content is deterministic: reload the page without changing anything → the fingerprint in the flag is the same.
- [ ] No secrets or other users' data in any hook.
- [ ] Toggle button in the app's header (or the floating launcher); `Ctrl+I` works; the drawer does not cover
      content (`push` target chosen) and overlays correctly on narrow screens.
- [ ] **Keyboard:** search the host for global `keydown`/`keyup` handlers (and capture-phase ones). Type a space and a
      few letters in the composer and in Settings > Agent > System prompt: they appear, and the app does not react.
- [ ] **Modal dialogs:** does the app use `showModal()`, popovers or focus-trapped modals? Open one, press the hotkey:
      the drawer must be usable (`dialogs: 'dock'`, or pause the focus trap). An open dialog's contents are part of the
      page content.
- [ ] **Layout** at 1280, 1366 and 1600 px wide with the drawer open: no horizontal scrolling, side panels not
      clipped, header actions (and the toggle) visible — fix with CSS under `html.aia-drawer-open` (`frameworks.md`,
      "Layout"). No `devWarnings` layout warning in the console.
- [ ] **Settings dialog**: open Settings on every tab in the real host app — with the app's real tools, memories
      and screen content, and in a short window too: the tabs stay fully visible and clickable, and the layout matches
      `settings-layout.md` (labels at the top-left of their card, inputs full width with their button flush right,
      checkbox text right after the box, nothing centred, the runtime's own buttons). Look hardest in apps that style
      bare `label`, `input`, `select` or `button` elements (detect lists them under "Host element rules").
      `verify.mjs` → every `settings:<tab>` passes; no "does not match its layout spec" warning in the console.
- [ ] Settings > Context shows exactly the intended app/page/view/snapshot text, and its size is reasonable for the
      target model (local models: at least 8k context).
- [ ] Ask → receipt "Read the page · … · hash", flag green. Change data → flag amber. Ask → re-read (new hash).
      Ask again unchanged → "Page unchanged".
- [ ] Navigate → page context and snapshot follow the new page.
- [ ] **Tools**: the catalog wraps the app's own functions (no reimplemented logic, nothing the UI does not offer);
      effects are right (when unsure, the stronger one); parameters carry the real ranges; `pages`/`when` match where
      they work; `ai-tools.json` turns on only what the user chose. With a model: an action shows a chip, write tools
      ask first, the app changes, the answer confirms; "which tools can you use?" lists on and off; a turned-off tool
      produces the *Turn on* card. The tools module has unit tests.
- [ ] **Memory**: `ai-memory.json` holds the agreed seed notes (facts the screen does not show; one sentence each; no
      secrets) and loads (`verify.mjs` → memory). "Remember that …" shows a *Remember* chip with Undo; a new chat
      knows it; Settings > Memory lists, edits and exports. If `memorySave` is used: per signed-in user, behind auth.
- [ ] **Vision**: the capture method was chosen on purpose (screen capture, or a `screenshot` hook for a canvas view —
      WebGL hooks render a frame first); `defaults.vision` matches the default model; the camera button attaches a
      thumbnail and the model describes the picture; asked to look, the agent shows the *Allow once* card while
      `screenshotAuto` is off. Secure context; no `Permissions-Policy` against `display-capture`; CSP allows
      `img-src data:`. Apps whose screen shows data that must not leave: a hook that draws only what may, or
      `screenshots: false`.
- [ ] **Attachments**: the + button sits left of the message field and opens *Attach an image* · *Upload a file*
      (`verify.mjs` → attachments). With a model: a PDF or Word file shows a chip with its type and token estimate,
      the answer is about its content, and the chip on the question shows the text the agent received; an image is
      described like a screenshot. `defaults.maxFileChars` suits the default model's context; the app's own formats
      have a `readFile` hook (or none are needed); a CSP `img-src` allows `blob:` (attached SVGs). Apps whose users'
      documents must not reach the model provider: `attachments: false`.
- [ ] Code/reply actions (if any) do what they say, show up even when a small model uses a generic fence tag
      (`json`), clamp values, apply through the app's real controls, and never bypass the app's confirmations.
- [ ] Light and dark mode both look right; theme overrides on `.aia-scope` apply in both; the toggle's context dot
      does not cover its label; the host page's styles are unaffected when the drawer is closed.
- [ ] Production stack known (web server, PHP or Node, long-running processes allowed?). Deployed apps: the relay that
      matches production, copied unchanged, config outside the web root, keys on the server, public mode (or auth)
      with limits; `relayProbe` or `transport: 'relay'`. Nothing depends on `.htaccess` or rewrites.
- [ ] Asset URLs are versioned (or served `no-cache`) so a deploy is picked up.

A quick console check: `agent.getContextStatus()`, `await agent.systemPrompt()`, `agent.settings.get()`,
`agent.relayInfo()`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Nothing happens, console: "Failed to load module script" / CORS on `file://` | Modules need http. Serve the app (dev server, XAMPP, or `node <skill>/assets/relay/relay.mjs --static <dir>`). |
| The toggle does nothing and the console is clean (often right after a deploy) | The browser runs a stale cached entry script. Hard reload (Ctrl+Shift+R) to confirm; then version the asset URLs (`?v=…` / build hash) or send `Cache-Control: no-cache`. |
| "Could not reach http://127.0.0.1:9000" | LM Studio server not started, wrong port, or CORS off. Developer tab → Start server → Enable CORS. Test: `curl http://127.0.0.1:9000/api/v1/models`. |
| "Connected, but no model is loaded in LM Studio" | Load a model in LM Studio, or choose one in Settings (LM Studio loads it on first use; the first answer is slow). |
| Answer empty: "spent its whole reply budget thinking" | Raise *Max reply tokens*, or set *Thinking* to "Ask the model not to think". |
| Answers cut off / request fails on a local model with a long page | The model's context window is too small (4k by default in many setups). Settings > Context shows the size; load the model with ≥ 8k context, or trim the app context / *Max screen content*. |
| Flag flips to amber on its own | The content hook includes something volatile (time, random id, scroll position, unrounded live values). Move it to `view`, or round to what the UI shows. |
| Flag stays green after data changed | `contextChanged()` is not called on that change (or the hook reads stale state — read state inside the hook, not when the page was registered). |
| Flag never turns amber in an app that updates continuously | A pre-1.1 runtime (plain debounce starves) or `debounceMaxMs: 0`. Update the runtime / keep the default 1000. |
| Typing in the drawer triggers app shortcuts (Space pauses, letters switch tools) | `isolateKeys: false`, or a **capture-phase** host handler: make it skip `e.target.closest('.aia-scope')`. |
| The hotkey opens the drawer but nothing in it reacts | A modal `<dialog>` (or a focus-trapped modal) makes the page inert. Use `dialogs: 'dock'`, or pause the focus trap while the drawer is open. The dev warning says so. |
| Header buttons, side panels or the toggle disappear under the open drawer | The pushed container cannot shrink (fixed-width grid columns, nowrap header). CSS under `html.aia-drawer-open`: `minmax(0, …)` columns, wrapping header. Fixed elements: `right: var(--aia-push-width)`. |
| Theme overrides work in light mode only | A pre-1.1 stylesheet (dark rules had higher specificity). Update `ai-agent.css`; 1.1 wraps its theme rules in `:where()`. |
| The context dot covers the toggle's label / has a white ring on a dark header | Give the toggle `padding-right`, or move/recolour the dot with `--aia-badge-top/-right/-size/-ring`. |
| A code action's button does not appear | The model used another fence tag (often `json`). Make `when` validate the content (`parseBlockValues` accepts `json` when every key is known), and restate the tag in the system prompt. |
| The model never calls the tools (answers in prose instead) | Its server/model has no native tool calling: Settings > Tools > "Text blocks". Check the tools are on (Settings > Tools) and available on this page (`pages`/`when`), and that descriptions say what each tool is for. |
| The answer after a tool round is empty, or only in the Thinking panel | Some local models answer the step after tools only in their reasoning channel; 1.2 shows that reasoning as the answer. Otherwise raise *Max reply tokens*. |
| "Stopped after N tool steps" | The model kept calling tools: raise Settings > Tools > Max tool steps, or give tools clearer results (counts, "done", errors). |
| A tool is called with wrong values | Tighten its schema (`enum`, `min`/`max`, `required`) and description; arguments are clamped, and errors go back to the model. |
| "Remember that…" gets a plain answer, nothing is saved | The model did not call `remember`: its server has no tool calling (Settings > Tools > "Text blocks"), or Settings > Memory > "Let the agent save a memory" is off. The user can always add it in Settings > Memory. |
| A memory is ignored or contradicted | Memories are notes, and the screen wins when they conflict. Make the note specific (what, when it applies). Very long memory lists dilute: keep them short. |
| No camera button | Settings > Vision > "This model can see images" is off (or `defaults.vision: false`, or the relay has no image support: update it to 1.3), `screenshots: false`, or the browser cannot capture the page (phones, plain http beyond localhost) and the app has no `screenshot` hook. |
| The screenshot fails: "Screen sharing was not allowed" | The user cancelled the browser's prompt, or a `Permissions-Policy` forbids `display-capture` (in an iframe: `allow="display-capture"`). |
| The model ignores the screenshot, or the request fails once one is attached | A text-only model. Pick a vision model, or switch "This model can see images" off. With LM Studio, Settings > Vision says what the server reports for the loaded model. |
| The screenshot of a WebGL view is blank (white) | The drawing buffer was already cleared: in the `screenshot` hook render a frame and return the canvas synchronously (or create the context with `preserveDrawingBuffer: true`). |
| "The screenshot could not be read … tainted canvas" | The canvas drew images from another origin without CORS. Load them with `crossOrigin = 'anonymous'` (and CORS headers), or use the browser's screen capture (return `null` from the hook). |
| Relay: "cannot pass images" / "too large for this server" with a screenshot | A relay older than 1.3, `maxImages: 0`, or a body limit in front of it: `client_max_body_size` (Nginx), `post_max_size` (PHP), `LimitRequestBody` (Apache). |
| No + button | `attachments: false`, or an app stylesheet hides `.aia-plus`. |
| *Attach an image* is greyed out | "This model can see images" is off (Settings > Vision, or `defaults.vision: false`). Files can still be attached. |
| A PDF is refused as "probably scanned" | It has no text layer (pages are pictures). Attach pictures of the pages to a vision model, or OCR it first. Encrypted PDFs are refused too. |
| An attached file is refused ("Old Word files…", "an archive…") | Old binary Office formats, iWork, archives, audio/video are not read: the message says what to save it as. For the app's own formats, add a `readFile` hook. |
| The request fails, or the answer ignores most of a long file, after attaching it | The model's context is too small for the file (the error lists the attached files as a cause). Lower Settings > Agent > *Max file content* (`maxFileChars`), load the local model with more context, or start a new chat (files stay in the conversation while their question is in the history window). |
| A file's text looks scrambled or has gaps | A PDF font without a Unicode map (the file view says so), or a layout the reader orders differently. Click the chip to see what the agent received; an app that ships pdf.js can pass it as the `readFile` hook. |
| Model says it cannot see the page | Settings > Agent > "Share what is on screen" is off, or the page has no `content` hook (flag shows *none*). Check Settings > Context. |
| Answers about the wrong page | `setPage` not called on navigation, or called with the previous page's hooks. |
| Open-time setup does not run after a reload | `resume` reopened the drawer during `createAiAgent()`. Register `on('open')` in the same tick (it is replayed with `{ resumed: true }`), or check `agent.isOpen()` after creating the agent. |
| HTTP 401 / "rejected the credentials" | Wrong or expired key (Settings > Model). With the relay, check the server's environment variable / config `keys`. |
| Network error to a cloud provider from the browser | That provider blocks browser calls: switch to the relay. On https pages, http endpoints are blocked (mixed content). |
| Relay: "only answers requests from the computer it runs on" | Local mode and the request came from elsewhere (or through a proxy). Use public mode, or `allowRemote` with an `authorize` check. |
| Relay: "only answers pages of the site it runs on" (403) | Public mode same-origin check: the page's origin differs from the relay's host (a proxy rewrote `Host`, or another subdomain). Preserve `Host`, or add the origin to `allowedOrigins`. |
| Relay: "not available right now" (503) / probe says unavailable | Misconfiguration. Open the relay URL from the server itself (`curl http://127.0.0.1/…/relay.php`) — the `detail` field says what is missing (preset, key, data folder); it is also in the PHP error log. |
| Relay: 429 | A rate limit (the message says which). Adjust `limits` in the relay config. |
| Relay stream stops after ~60 s (504) or arrives all at once | A buffering/timeout layer: `gzip_types` includes `text/event-stream`, `fastcgi_buffering`/proxy buffering on, `mod_deflate` compressing, or a pre-1.1 relay without keepalives. See `providers.md`, "Nginx + PHP-FPM". |
| Relay: "unable to get local issuer certificate" (cURL errno 60) | Old CA bundle (XAMPP's is from 2022) or TLS interception by antivirus/proxy. Current `cacert.pem` in `php.ini`, or `'caBundle' => 'native'` in the relay config. |
| Every visitor hits the rate limit at once | The relay sees one address for everyone (CDN/load balancer). Restore the client address (`real_ip` in Nginx, `mod_remoteip` in Apache). |
| Host styles leak into the drawer or the settings dialog (centred labels, short input rows, checkbox text far from its box, the page's button look) | The runtime's CSS is older than 1.6.1 or an edited copy without the host-isolation guard (detect: `Layout guards`): replace it, or `scripts/guards.mjs --apply`. Still there: `verify.mjs` names the host rule (an id, two classes, or `!important` can still beat the runtime); scope it away from `.aia-scope`. Never patch it with `!important` on `.aia-` classes. |
| The settings tabs are clipped or hard to click (worst on Tools, Memory, Context) | The tab strip shrank under a tall body: a runtime CSS older than 1.6.1 (no pinned-chrome guard), or app CSS giving `.aia-tabs` a `flex-shrink`/`height`. Replace the runtime or `scripts/guards.mjs --apply`; remove the app rule. |
| Two drawers appear | `createAiAgent` called twice (React StrictMode, HMR), or the skill was run again on an app that already had the agent and built a second one. Keep one integration (`scripts/detect.mjs` lists every `createAiAgent()` call) and a module-level singleton (`getAgent()`). |
| Settings do not stick | Browser storage blocked (private mode / sandboxed iframe): the runtime falls back to memory for the session. |

## Runtime tests

From the skill folder: `node --test` (or `npm test`). No model needed.

- `tests/runtime.test.mjs` — hashing, the sync planner, request building, prompt assembly, SSE parsing, transport
  errors, adapters, settings/keys storage (incl. late defaults), fallback, Markdown safety, the max-wait debounce,
  key classification, `parseBlockValues`, the relay probe, tools, the memory store and its prompt section, images in
  each provider's format and in the conversation.
- `tests/relay.test.mjs` — both relays against a fake upstream: GET contract, local-only mode, public mode (preset
  lock, visitor keys never forwarded, same-origin, rate limits, caps, generic errors), `: open` + keepalive comments,
  tools and images passed through within their limits.
  PHP runs when `php` (with curl) is on the PATH or `PHP_BIN` points at it; otherwise those tests are skipped.
- `tests/browser.test.mjs` — headless Edge/Chrome (`AIA_BROWSER` to choose, `AIA_SKIP_BROWSER=1` to skip): key
  isolation, dialog docking, the layout warning, theme overrides, resume, `setControlValue`, the probe on a static
  server, the context-size warning, the settings dialog under a hostile host stylesheet (every tab at two sizes, the
  same geometry with and without it, and a leak the check and the dev warning must catch), the tool loop, memory end
  to end (remember, forget, Undo, Settings > Memory),
  and screenshots (a WebGL `screenshot` hook, the agent asking to look, and the browser's real screen capture with the
  drawer cropped off), and attachments (the + menu with the keyboard, an image and a Word file through the file
  pickers, what the model receives, the file viewer, saved chats; drag and drop, paste, a text-only model,
  `attach()` + `ask()`, Send while a file is being read, `attachments: false`; a PDF printed by the browser itself).
- `tests/files.test.mjs` — the attachment readers on documents built in memory (`tests/fixtures/documents.mjs`):
  file kinds, text encodings, limits and refusals, the `readFile` hook, ZIP, Word, Excel (dates, CSV), PowerPoint
  (presentation order, notes), OpenDocument, RTF code pages, PDF (encodings, ToUnicode, object streams, forms,
  kerning; encrypted and scanned files), and how files and image files reach the model and the prompt.
- `tests/example.test.mjs` — the Hello World content builders, tools and memory file (the tests every integration
  should have).
- `tests/detect.test.mjs` — `scripts/detect.mjs` on fixture apps (fresh, current, older/edited runtime, 1.0 relay
  edits without printing keys, workaround hints, which features are there and used, the record, the layout guards —
  both, neither, the hand-made fix — and the host's element rules) and that the release fingerprints are up to date.
- `tests/guards.test.mjs` — the stylesheet reader behind the layout guards (specificity, the winning declaration),
  and `scripts/guards.mjs --apply` on an edited copy (edits kept, idempotent, CRLF kept, the manifest's `patches`).
