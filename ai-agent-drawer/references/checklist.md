# Verification checklist and troubleshooting

## Before you say it is done

- [ ] `ai-agent/` copied unchanged; `ai-agent.css` loaded once; the agent created once, client-side.
- [ ] `appId` is unique to this application.
- [ ] App context describes the real app (purpose, capabilities, **limits**) — nothing invented.
- [ ] Every page/view calls `setPage` with an `id`, `title`, `purpose` and a `content` hook; `view` where there is
      selection/cursor/filter state.
- [ ] `contextChanged()` is called wherever the visible data changes (or `watch` is set).
- [ ] Content is deterministic: reload the page without changing anything → the fingerprint in the flag is the same.
- [ ] No secrets or other users' data in any hook.
- [ ] Toggle button in the app's header (or the floating launcher); `Ctrl+I` works; the drawer does not cover
      content (`push` target chosen) and overlays correctly on narrow screens.
- [ ] Settings > Context shows exactly the intended app/page/view/snapshot text.
- [ ] Ask → receipt "Read the page · … · hash", flag green. Change data → flag amber. Ask → re-read (new hash).
      Ask again unchanged → "Page unchanged".
- [ ] Navigate → page context and snapshot follow the new page.
- [ ] Code/reply actions (if any) do what they say and never bypass the app's confirmations.
- [ ] Light and dark mode both look right; the host page's styles are unaffected when the drawer is closed.
- [ ] Deployed apps: relay in place with auth, keys on the server, `transport: 'relay'` default.

A quick console check: `agent.getContextStatus()`, `await agent.systemPrompt()`, `agent.settings.get()`.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Nothing happens, console: "Failed to load module script" / CORS on `file://` | Modules need http. Serve the app (dev server, XAMPP, or `node <skill>/assets/relay/relay.mjs --static <dir>`). |
| "Could not reach http://127.0.0.1:9000" | LM Studio server not started, wrong port, or CORS off. Developer tab → Start server → Enable CORS. Test: `curl http://127.0.0.1:9000/api/v1/models`. |
| "Connected, but no model is loaded in LM Studio" | Load a model in LM Studio, or choose one in Settings (LM Studio loads it on first use; the first answer is slow). |
| Answer empty: "spent its whole reply budget thinking" | Raise *Max reply tokens*, or set *Thinking* to "Ask the model not to think". |
| Flag flips to amber on its own | The content hook includes something volatile (time, random id, scroll position). Move it to `view`. |
| Flag stays green after data changed | `contextChanged()` is not called on that change (or the hook reads stale state — read state inside the hook, not when the page was registered). |
| Model says it cannot see the page | Settings > Agent > "Share what is on screen" is off, or the page has no `content` hook (flag shows *none*). Check Settings > Context. |
| Answers about the wrong page | `setPage` not called on navigation, or called with the previous page's hooks. |
| HTTP 401 / "rejected the credentials" | Wrong or expired key (Settings > Model). With the relay, check the server's environment variable. |
| Network error to a cloud provider from the browser | That provider blocks browser calls: switch to the relay. On https pages, http endpoints are blocked (mixed content). |
| Drawer covers the page's content | Set `push` to the main container (the element whose right edge should move). Fixed-position host elements need their own `right: var(--aia-drawer-width)` rule under `html.aia-drawer-open`. |
| Host styles leak into the drawer | Rare; all runtime classes are `aia-` prefixed. Raise specificity in the host rule or add a reset for `.aia-scope` descendants. |
| Two drawers appear | `createAiAgent` called twice (React StrictMode, HMR). Use a module-level singleton (`getAgent()`). |
| Settings do not stick | Browser storage blocked (private mode / sandboxed iframe): the runtime falls back to memory for the session. |

## Runtime tests

From the skill folder: `node --test` (or `npm test`). Covers hashing, the sync planner, request building, prompt
assembly, SSE parsing, transport errors, adapters, settings/keys storage, fallback and Markdown safety.
