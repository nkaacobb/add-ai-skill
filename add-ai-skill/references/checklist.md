# Verification checklist and troubleshooting

## Automated check

```bash
node <skill>/scripts/verify.mjs http://127.0.0.1:8080/ --change "<js that changes what is on screen>"
```

Drives headless Edge/Chrome (Node 22+, nothing to install): console errors on load, the hotkey and the flag, the
toggle, typing a space in the composer, Settings > Context size, the pushed layout at 1280/1366/1600 px (with
screenshots in `.verify/`), and — with a model running — "Read the page" → synced → change → dirty → re-read →
"Page unchanged". `--no-llm` skips the questions; `--toggle`, `--agent`, `--widths`, `--question` adjust it; `--help`
lists everything. Exit code 1 when a check fails. It does not replace looking at the page yourself.

## Before you say it is done

- [ ] `ai-agent/` copied unchanged; `ai-agent.css` loaded once; the agent created once, client-side.
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
- [ ] Settings > Context shows exactly the intended app/page/view/snapshot text, and its size is reasonable for the
      target model (local models: at least 8k context).
- [ ] Ask → receipt "Read the page · … · hash", flag green. Change data → flag amber. Ask → re-read (new hash).
      Ask again unchanged → "Page unchanged".
- [ ] Navigate → page context and snapshot follow the new page.
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
| Host styles leak into the drawer | Rare; all runtime classes are `aia-` prefixed. Raise specificity in the host rule or add a reset for `.aia-scope` descendants. |
| Two drawers appear | `createAiAgent` called twice (React StrictMode, HMR). Use a module-level singleton (`getAgent()`). |
| Settings do not stick | Browser storage blocked (private mode / sandboxed iframe): the runtime falls back to memory for the session. |

## Runtime tests

From the skill folder: `node --test` (or `npm test`). No model needed.

- `tests/runtime.test.mjs` — hashing, the sync planner, request building, prompt assembly, SSE parsing, transport
  errors, adapters, settings/keys storage (incl. late defaults), fallback, Markdown safety, the max-wait debounce,
  key classification, `parseBlockValues`, the relay probe.
- `tests/relay.test.mjs` — both relays against a fake upstream: GET contract, local-only mode, public mode (preset
  lock, visitor keys never forwarded, same-origin, rate limits, caps, generic errors), `: open` + keepalive comments.
  PHP runs when `php` (with curl) is on the PATH or `PHP_BIN` points at it; otherwise those tests are skipped.
- `tests/browser.test.mjs` — headless Edge/Chrome (`AIA_BROWSER` to choose, `AIA_SKIP_BROWSER=1` to skip): key
  isolation, dialog docking, the layout warning, theme overrides, resume, `setControlValue`, the probe on a static
  server, the context-size warning.
- `tests/example.test.mjs` — the Hello World content builders (the tests every integration should have).
