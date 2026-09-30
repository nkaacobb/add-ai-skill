# Upgrading an app that already has the agent

Use this when `scripts/detect.mjs` reports **UPGRADE** or **CURRENT**, or the user asks to update the agent or add a
feature to an app that already has it. **Never build a second agent**: one `createAiAgent()` per app, and the same
`appId` forever (it namespaces every user's settings, API keys and saved chats in their browser).

The user's words set the scope: "just update the runtime", "only add tools", "upgrade everything". Without a scope,
propose the full upgrade (U3) and proceed unless they object.

## U1. Find what is there

```bash
node <skill>/scripts/detect.mjs <app-root>          # --json for machine-readable output
```

It reports the runtime copy (version, and whether it is unchanged since that release), the relays (version, 1.0-style
edits), relay config files (names only), the `createAiAgent()` call(s) with their `appId` and options, the
integration record (`ai-agent.integration.json`), tool config files, and app code that looks like a workaround a newer
runtime covers. Without Node, search for `ai-agent.js` containing `export const VERSION`, for `createAiAgent(`, and
for `ai-agent.integration.json`.

Then read, before changing anything:

- **The integration record**, if there is one: features in use, the context and tool plans, what the user declined.
- **The integration module** (the file that calls `createAiAgent`), the content builders and hooks, custom CSS for the
  drawer, and the relay config — enough to restate the current context plan in a few lines.
- **Edited copies.** Detect says whether the runtime or relay files differ from their release. An edited copy must not
  be overwritten blindly: find the change in the app's history (`git log --follow -p -- <runtime dir>/<file>`), then
  turn it into an option or config setting of the new version, or keep it as a documented patch and tell the user
  (so it can be folded back into the skill).
- **More than one** runtime copy or `createAiAgent()` call: find which one the app really loads; plan to remove the rest.

## U2. Read what changed

Read `CHANGELOG.md` from the installed version up to the current one: new features, behaviour changes, and each
version's **Upgrading** notes. They say what to migrate and which app-side workarounds the new runtime makes redundant.

## U3. Propose the upgrade (a few lines to the user)

- Replace the runtime `X → Y` (and the relay `X → Y`), with the relay migration if any.
- Workarounds to remove (from detect's hints and your reading).
- New features that fit **this** app, as a short menu with one line each (U6) — the user picks.
- What stays as it is: the `appId`, the context hooks, actions, prompts, the app's CSS for the drawer.

## U4. Replace the runtime and the relay

- **Runtime**: replace the contents of the app's runtime folder with the skill's `assets/ai-agent/` — delete the old
  files first so files removed in newer versions do not linger. Same folder, so import paths and the stylesheet link do
  not change. Bundled apps: rebuild.
- **Relay**: copy `relay.php` / `relay.mjs` unchanged over the old file. Keep the existing config file where it is.
  From a 1.0 relay, move edits made inside the file into a `relay.config.php` (outside the web root, or next to the
  relay in development — see `providers.md`):

  | 1.0 (edited in relay.php) | 1.1+ (relay.config.php) |
  | --- | --- |
  | `AIA_ALLOW_REMOTE = true` | `'allowRemote' => true` — and add an `'authorize'` check |
  | `AIA_ALLOW_ANY_UPSTREAM = true` | `'allowAnyUpstream' => true` |
  | `AIA_KEYS = ['openai' => '…']` | `'keys' => [...]` or environment variables (never print the values) |
  | `AIA_TIMEOUT`, `AIA_MAX_BODY` | `'timeout'`, `'limits' => ['maxBodyBytes' => …]` |
  | sign-in/CSRF code at "enforce it here" | `'authorize' => static function (): bool\|string { … }` |

  An embedded Node relay: update its imports to the new `relay.mjs` exports (`createRelay`, `loadConfig`).
- **Caches**: bump the version in the asset URLs (`?v=1.2.0`) or rely on `no-cache`, so browsers load the new files.

## U5. Remove workarounds the new runtime covers

Remove each only after checking the new behaviour covers what the app needed:

| Workaround in the app | Since | Replace with |
| --- | --- | --- |
| Own throttle/interval around `contextChanged()` | 1.1 | Call `contextChanged()` on every update; `debounceMaxMs` paces the flag. |
| `showModal` overrides, switching dialogs to non-modal and back, swallowing `close` events | 1.1 | `dialogs: 'dock'` (keep including the dialog's contents in the page content). |
| Key filters so host shortcuts ignore the drawer | 1.1 | `isolateKeys` (default). Keep `closest('.aia-scope')` checks in **capture-phase** host handlers. |
| Probing the relay before `createAiAgent` | 1.1 | `relayProbe: true` + `defaults.relayUrl`. |
| Theme overrides with `[data-aia-theme]` / `:not(...)` selectors | 1.1 | A plain `.aia-scope { --aia-… }` rule (wins in light and dark). |
| Badge colours via `::after` overrides | 1.1 | `--aia-badge-*` variables. |
| Strict `when: (b) => b.language === 'x'` on value-applying code actions | 1.1 | `parseBlockValues` + `setControlValue`. |
| Code actions that are really app operations ("Apply filter") | 1.2 | A tool (the model calls it; the user confirms), optionally keeping the button. |

Keep the layout CSS under `html.aia-drawer-open` — that is still the recipe.

## U6. Offer the new features

Offer only what fits the app; record what the user declines (U7) so the next upgrade does not ask again.

| Feature | Since | Fits when | What it takes |
| --- | --- | --- | --- |
| **Tools** — the agent acts in the app | 1.2 | Users do things on the screens (almost every app) | The tool plan (SKILL.md steps 1–2), `ai-tools.js` over the app's own functions, `ai-tools.json` with the user's choice of what is on, tests (`tools.md`). |
| Dialog docking | 1.1 | The app uses `dialog.showModal()` | `dialogs: 'dock'`. |
| Relay auto-detection | 1.1 | The app runs with and without its relay | `relayProbe`. |
| Relay public mode | 1.1 | Deployed for visitors, server-held key | `relay.config.php` with `'mode' => 'public'`, a preset and limits. |
| Layout check / recipe | 1.1 | Fixed-width shell, wide header | Fix what the dev warning reports (`frameworks.md`, "Layout"). |
| Value code actions for small models | 1.1 | Actions that apply settings/values | `parseBlockValues` / `setControlValue`. |

Automatic with the new runtime (mention, nothing to do): key isolation, the max-wait debounce, theming fixes, the
context-size estimate, resume replay, relay error messages.

## U7. Verify, record, report

1. Run the app's own tests, then `node <skill>/scripts/verify.mjs <url> [--change …]`, and check by hand what was
   added (SKILL.md step 11). Confirm the saved chats and settings of the old version are still there (same `appId`).
2. Write or update **`ai-agent.integration.json`** (below).
3. Report: versions before → after, what was replaced, migrated and removed, the features added and declined, and
   anything you could not verify.

## The integration record: `ai-agent.integration.json`

Written at the end of every integration (SKILL.md step 12) and every upgrade, at the app's repository root (or next to
the integration module), and committed with the app. It lets the next upgrade know exactly what is there.

```json
{
  "skill": "add-ai-skill",
  "skillVersion": "1.3.0",
  "runtimeVersion": "1.2.0",
  "updated": "2026-09-30",
  "appId": "inventory",
  "runtime": "public/ai-agent",
  "relay": { "file": "public/api/relay.php", "version": "1.2.0", "mode": "public", "config": "AIA_RELAY_DIR (outside the web root)" },
  "integration": ["public/js/ai-agent-setup.js", "public/js/ai-content.js", "public/js/ai-tools.js"],
  "toolsConfig": "public/js/ai-tools.json",
  "features": ["tools", "dialogs:dock", "relayProbe", "codeActions"],
  "declined": ["relay public mode"],
  "pages": [
    { "id": "orders", "content": "visible rows with status and totals", "tools": ["filter_orders", "open_order", "cancel_order"] }
  ],
  "customizations": ["theme via css/ai-agent-theme.css", "layout fix for .app-shell under html.aia-drawer-open"],
  "notes": "Anything the next person should know."
}
```

Never put keys, tokens or other secrets in it: it is committed.
