# API reference

`import { createAiAgent, fromDom, DEFAULT_SYSTEM_PROMPT } from './ai-agent/ai-agent.js'` and load `ai-agent/ai-agent.css`.
Types: `assets/ai-agent/ai-agent.d.ts`. Runtime version: `VERSION` (1.2.0). Tools (the agent acting in the app):
`tools.md`.

## createAiAgent(options) → agent

Creates and mounts the toggle wiring (or a floating launcher), the drawer and the settings modal. Call once, in the
browser, after the DOM exists. It returns synchronously; `agent.ready` resolves once async `defaults` and the relay
probe (if any) have been applied — questions wait for it automatically.

| Option | Default | Meaning |
| --- | --- | --- |
| `appId` | `'app'` | **Required in practice.** Namespaces browser storage: `<appId>.ai.settings`, `.keys`, `.chats`, `.width`. |
| `title` | `'AI agent'` | Drawer title (e.g. "Security analyst", "Writing agent"). |
| `app` | – | App context hook: string, object or (async) function. Objects render as `Label: value` lines; arrays as bullets. Suggested keys: `name`, `purpose`, `audience`, `capabilities[]`, `limits[]`, `glossary{}`. Keep it lean (it is sent with every request). |
| `page` | – | Initial page: `{ id, title, purpose, content, view, ...more descriptive keys }`. See "Page". |
| `systemPrompt` | `DEFAULT_SYSTEM_PROMPT` | The app's default prompt (string or function). Users can override it in Settings > Agent; "Restore app default" brings this back. |
| `welcome` | generic | Markdown shown at the start of each chat. |
| `suggestions` | `[]` | Clickable starter questions under the welcome. |
| `placeholder` | generic | Composer placeholder. |
| `toggle` | `null` | Selector/element(s) that toggle the drawer. None → floating launcher (unless `launcher: false`). |
| `toggleBadge` | `true` | Adds a coloured context-state dot on toggles (`[data-aia-toggle][data-aia-context]`; see "Theming"). |
| `push` | `document.body` | Element(s) that get `padding-right` = drawer width while open. `false` = overlay. Below 900 px wide the drawer always overlays. Shells with fixed-width columns need the recipe in `frameworks.md` ("Layout"). |
| `hotkey` | `'mod+i'` | Toggle shortcut (`mod` = Ctrl/Cmd; also `shift+`, `alt+`). `false` disables. Works from inside the drawer too. |
| `theme` | `'auto'` | `'light'`/`'dark'` force a theme; auto follows the OS. |
| `width` | `440` | Default drawer width (users drag the left edge; double-click resets; remembered). |
| `watch` | `0` | Poll the content hook every N ms while the drawer is open. Use when you cannot call `contextChanged()`. |
| `debounceMs` | `300` | Trailing debounce for `contextChanged()`. |
| `debounceMaxMs` | `1000` | While `contextChanged()` keeps being called (animation, simulation, live data), refresh the flag at least this often anyway. `0` = plain debounce (1.0 behaviour: the flag waits until the changes stop). |
| `isolateKeys` | `true` | Keystrokes typed in the drawer and the settings modal do not reach the host page's bubbling key listeners, so host shortcuts (Space = play, letters, arrows) cannot swallow them. Ctrl/Cmd application shortcuts (Ctrl+S…) still reach the host; text-editing combos (Ctrl+A/C/V/X/Z/Y, Ctrl+arrows) stay in the field. |
| `dialogs` | `false` | `'dock'`: native modal `<dialog>`s (which make the drawer inert) are shown non-modally beside the open drawer and become modal again when it closes, without firing `close`/`toggle` at the host. `{ selector: 'dialog.x' }` manages only some. See `frameworks.md` ("Modal dialogs"). |
| `devWarnings` | `'auto'` | Console warnings for integration problems: the pushed layout overflows/hides things under the drawer (checked after opening and on resize), a modal dialog makes the drawer inert. `'auto'` = on for `localhost`, `127.x`, `[::1]`, `*.localhost`, `*.test`, `*.local`, `file:`; `true`/`false` force. |
| `relayProbe` | `false` | `true` (probe `defaults.relayUrl`), a URL, or `{ url, timeoutMs = 2500 }`: GET the relay at startup; if it answers `available`, use it (with its preset provider/model), else send requests directly. See "Relay probe". |
| `contextWarnTokens` | `3000` | Settings > Context warns (local providers) when the first request is estimated above this. |
| `tools` | `[]` | The app's tool catalog: `[{ name, title?, description, parameters?, effect: 'read'\|'write'\|'destructive', pages?, when?, group?, enabled?, timeoutMs?, run(args, ctx) }]`. The model calls them; see `tools.md`. Invalid definitions are skipped with a console error. |
| `toolsConfig` | `null` | The app's default tool selection and switches (`ai-tools.json`): a URL, an object, or a (possibly async) function. Applied like `defaults` (questions wait for it). |
| `codeActions` | `[]` | `[{ id, label, title?, when?(block), run(block, agent), doneLabel? }]` → buttons on fenced code blocks (`block = { language, code }`). Copy is built in. For values the app applies, see `parseBlockValues` and `setControlValue`. |
| `replyActions` | `[]` | `[{ id, label, title?, run(markdown, agent), doneLabel? }]` → buttons under each reply. Copy is built in. |
| `defaults` | `{}` | App defaults for any setting (see "Settings"). User choices override them. May be an object, a promise, or a (possibly async) function. |
| `relayHeaders` | – | Object or function returning headers for relay calls (CSRF tokens). |
| `saveChats` | `true` | Keep conversations in localStorage ("Saved chats"). Snapshot *text* is never stored. |
| `resume` | `true` | Per browser tab (sessionStorage): after a reload or a multi-page navigation, reopen the active chat, and the drawer if it was open. The resumed chat re-reads the current page on its next question. |
| `mount` | `document.body` | Where the drawer and modal are appended. |

## Page

```js
agent.setPage({
  id: 'orders/123',                 // stable id; part of the fingerprint
  title: 'Order #123',              // string or hook
  purpose: 'Shows one order: lines, totals, shipping and payment status. The user reviews and edits it.',
  // any other descriptive keys are included in the page context, e.g.
  actionsAvailable: ['Edit quantities', 'Cancel order (with confirmation)'],
  content: () => buildOrderContent(store.getState()),              // FINGERPRINTED
  view: () => ({ selectedLine: current.selectedLineId, tab: current.tab }), // NOT fingerprinted
});
```

- `content` may return a string (sent as written) or JSON-able data (sent as sorted-key, 2-space JSON; key order never
  changes the hash). Async functions are fine. If it throws, the snapshot says the content could not be read.
- `view` is sent inside `<view_state>` with every question and is limited to 2,000 characters.
- `tools` (optional): tools that exist only on this page (same format as the `tools` option). They are sent as
  tools, not as page description.
- `setPage(null)` clears the page (flag shows *none*).
- Write `content` as a pure, tested function of the app's state (`context-sync.md`, "Content builders").

## Agent methods

| Method | Does |
| --- | --- |
| `open()`, `close()`, `toggle()`, `isOpen()` | Drawer visibility. |
| `ask(text)` | Send a question as the user (opens the drawer). Returns when the reply has finished. |
| `stop()` | Abort the streaming reply (partial text is kept and marked). |
| `newChat()` | Save the current chat and start a new one (flag → *unread*). |
| `openSettings('model' \| 'agent' \| 'context')` | Open the settings modal on a tab. The Context tab shows exactly what the hooks produce, and the estimated size of the first request. |
| `setApp(app)` | Replace the app context. |
| `setPage(page)` | Replace the page (navigation). Recomputes the flag immediately. |
| `setContent(fn)`, `setView(fn)` | Replace only the current page's content/view hook. |
| `contextChanged()` | Debounced (`debounceMs`, at least every `debounceMaxMs` under continuous calls): re-hash the screen and update the flag. Call after every change to what is shown. Cheap: nothing is sent. |
| `refreshContext()` | Same, immediately; resolves to the status. |
| `getContextStatus()` | Current status (below). |
| `onContextStatus(fn)` | Subscribe; `fn` runs immediately and on every change. Returns unsubscribe. |
| `rereadPage()` | Force the next question to carry a fresh snapshot. |
| `systemPrompt()` | Resolves to the full system prompt as it would be sent now. |
| `ready` | Promise resolving to the agent once async `defaults` and `relayProbe` are applied (immediately without them). |
| `relayInfo()` | What the relay probe found (`{ url, available, mode, preset, providers, serverKeys, reason }`), or `null`. |
| `tools.list()` | Every tool known now (app-wide + this page): `{ name, title, description, effect, group, pages, enabled, available }`. |
| `tools.register(defs)`, `tools.unregister(name)` | Add/replace or remove app-wide tools at runtime. |
| `tools.setEnabled(name, on)` | Turn a tool on/off for this user (saved like Settings > Tools). |
| `tools.run(name, args)` | Run a tool directly (validated arguments, no confirmation, ignores on/off) — for tests and scripted checks. Resolves to the text the model would receive. |
| `tools.exportConfig()` | The current selection as an `ai-tools.json` object. |
| `on(event, fn)` | Events: `open` (`{}`, or `{ resumed: true }` — see below), `close`, `send` `{text, attached, reason, hash}`, `reply` `{text, provider, model, stopped, actions}`, `error` `{error}`, `context` (status), `settings` (settings), `relay` (relay info), `tool` `{name, args, status: 'ok'\|'error'\|'declined'\|'off'\|'skipped', result}`, `tool-state` `{name, enabled}`. Returns unsubscribe. |
| `settings.get()`, `settings.save(patch)`, `settings.reset()`, `settings.setKey(provider, key)` | Programmatic settings. |
| `destroy()` | Remove everything the agent added. |

**Open-time setup and `resume`.** With `resume` (default), a drawer that was open before a reload reopens *inside*
`createAiAgent()`, before the app could register listeners. The runtime replays that `open` once, as
`{ resumed: true }`, to listeners registered in the same tick. If you register later (after an `await`), check
`agent.isOpen()` once and run the open-time setup yourself:

```js
const agent = createAiAgent({ … });
const onOpen = () => startPreview();
agent.on('open', onOpen);
if (agent.isOpen()) onOpen();          // safe either way: make onOpen idempotent
```

### Context status

```ts
{ state: 'synced' | 'dirty' | 'unread' | 'none' | 'off',
  pending: boolean,        // the next question will attach a snapshot
  reason: string,          // 'unchanged' | 'changed' | 'unread' | 'trimmed' | 'forced' | 'empty' | 'off'
  hash: string | null,     // fingerprint of the screen now (show .slice(0, 7))
  syncedHash: string | null,// newest fingerprint the model has in this conversation
  pageId, title, chars, truncated, forced }
```

## Settings (Settings modal, `defaults`, `agent.settings`)

| Key | Default | |
| --- | --- | --- |
| `provider` | `'lmstudio'` | `lmstudio`, `ollama`, `custom`, `openai`, `anthropic`, `google`, `deepseek`, `openrouter` |
| `profiles` | `{}` | Per provider `{ baseUrl, model }`. Empty model = whatever LM Studio has loaded. |
| `transport` | `'direct'` | `'relay'` sends through the app's relay. |
| `relayUrl` | `''` | Absolute URL or same-origin path (`/ai-relay`, `api/relay.php`). |
| `fallbackProvider` | `''` | Used when the primary cannot be reached (before any text arrived). |
| `systemPrompt` | `''` | `''` = the app's default. |
| `temperature` | `0.4` | Not sent to providers that reject it (OpenAI reasoning models, Anthropic). |
| `maxOutputTokens` | `4096` | Local reasoning models need room to think. |
| `historyMessages` | `20` | Transcript entries sent per request. The snapshot is re-sent if it falls out of this window. |
| `maxContextChars` | `24000` | Screen content cap (≈ 6k tokens). |
| `reasoning` | `'show'` | `'hide'` hides the thinking panel; `'off'` asks the model not to think (where supported). |
| `shareScreen` | `true` | Off = the model gets app/page context but not the content. |
| `timeoutSec` | `120` | Idle timeout (resets while tokens or relay keepalives arrive). |
| `rememberKeys` | `false` | Keys in localStorage instead of sessionStorage. |
| `toolsEnabled` | `true` | Master switch for tools (Settings > Tools). |
| `toolMode` | `'auto'` | `'native'` tool calls, `'text'` tool blocks (any model), `'auto'` = native, text if the server refuses tools. |
| `confirmWrites` | `true` | Ask before tools with `effect: 'write'` ("Allow for this chat" skips it for that tool). |
| `confirmDestructive` | `true` | Ask before tools with `effect: 'destructive'`. |
| `maxToolSteps` | `8` | Tool rounds per question. |
| `toolStates` | `{}` | `{ toolName: true \| false }`, merged over `toolsConfig` and each tool's `enabled`. Only differences from the app defaults are stored. |

Layering: built-in defaults < `defaults` (applied late when async / probed) < what the user saved.

## Relay probe

```js
const agent = createAiAgent({ …, relayProbe: true, defaults: { relayUrl: 'api/relay.php', provider: 'lmstudio' } });
```

At startup the runtime GETs `relayUrl` (2.5 s timeout). The relay answers `200 { relay: 'ai-agent-drawer', available,
mode, preset, … }` (contract in `providers.md`). `available` → `transport: 'relay'` plus the preset provider/model as
defaults; anything else (a static server returning the PHP source, a 404, a timeout, `available: false`) → direct
requests. Saved settings that no longer fit are adjusted when read, without touching storage: an unavailable relay is
not used, and a public relay's preset provider/model replace ones it does not offer. `agent.relayInfo()` and the
`relay` event report what was found.

## fromDom(target, { exclude, fields = true })

Returns a content hook reading an element's rendered text (`innerText`, so tables keep their tab-separated columns)
plus a "Form fields:" list of visible input/select/textarea values (never passwords or hidden fields). Skips the
agent's UI, `[data-aia-ignore]`, and anything matching `exclude`. Include an open dialog: `fromDom('main, dialog[open]')`
reads only the first match, so combine two hooks instead (`() => [fromDom('main')(), fromDom('dialog[open]')()].join('\n\n')`).

## parseBlockValues(block, { tags, schema, generic })

Reads values a model wrote in a fenced block, for code actions that apply them to the app:

```js
import { parseBlockValues, setControlValue } from './ai-agent/ai-agent.js';
const SCHEMA = {
  speed:   { type: 'number', min: 0, max: 10, step: 0.5, aliases: ['velocity'] },
  mode:    { type: 'enum', values: ['orbit', 'free'] },
  trails:  { type: 'boolean' },
};
const read = (b) => parseBlockValues(b, { tags: 'conditions', schema: SCHEMA });
codeActions: [{
  id: 'apply', label: 'Apply', when: (b) => !!read(b),
  run: (b) => { const { values } = read(b); if ('speed' in values) setControlValue('#speed', values.speed); /* … */ },
}]
```

- A block tagged with one of `tags` is accepted when at least one key is known (unknown keys are ignored).
- A generic block (`json`, `yaml`, `text`, untagged… — `generic` lists them) only when **every** key is known, so an
  unrelated JSON example never grows an Apply button, but a small model that answers in `json` still works.
- The body may be JSON or `key: value` / `key = value` lines (comments, trailing commas and quotes tolerated).
  Parsing is linear — no backtracking regular expressions run on model output.
- Keys match case- and punctuation-insensitively (`Wind speed` = `windSpeed`), plus `aliases`.
- Values are coerced (`number`, `integer`, `boolean` from yes/no/on/off/1/0, `enum`, `string`) and clamped to
  `min`/`max`/`step`. Returns `{ values, unknown, invalid, adjusted }`, or `null`.

## setControlValue(target, value)

Sets a form control the way a user would, so the host's own handlers and validation run: numbers are clamped to the
control's `min`/`max`/`step`; the native value setter is used (React and similar frameworks notice); bubbling `input`
and `change` events are dispatched; checkboxes and radios are clicked when they must flip; selects match an option's
value or text. Returns `true` when the control now holds the value.

## Other exports

`renderMarkdown(md, { codeActions })`, `hashText(str)`, `stableStringify(value)`, `probeRelay(url, { timeoutMs })`,
`DEFAULT_SYSTEM_PROMPT`, `PROVIDERS`, `PROVIDER_IDS`, `AiError`, `VERSION`.

## Theming and host hooks

Override variables on `.aia-scope` from the host stylesheet. The runtime's theme rules are wrapped in `:where()`
(zero specificity), so a host `.aia-scope { … }` rule wins in light **and** dark mode, whatever the load order:

```css
.aia-scope { --aia-accent: #7c3aed; --aia-accent-strong: #5b21b6; --aia-accent-soft: #ede9fe; --aia-radius: 6px; }
@media (prefers-color-scheme: dark) { .aia-scope { --aia-accent-soft: #2e1065; } }   /* dark-only values */
html.dark .aia-scope { --aia-bg: #0b0b0f; }                                           /* or the host's own dark class */
:root { --aia-z: 1000; }
```

Supported host hooks (stable across versions):

| Hook | What it is |
| --- | --- |
| `html.aia-drawer-open` | Class on `<html>` while the drawer is open. Scope layout fixes to it. |
| `--aia-drawer-width` | The drawer width, set on `:root` by the runtime (inline, so use the `width` option for the default). |
| `--aia-push-width` | The room the open drawer takes from the page: the drawer width while open, `0px` when closed and below 900 px (overlay). Use it for fixed host elements: `html.aia-drawer-open .toast { right: var(--aia-push-width) }`. |
| `--aia-badge-synced`, `-dirty`, `-unread` | Colours of the context dot on toggles (defaults green/amber/blue). |
| `--aia-badge-ring` | The ring around the dot (default `#fff`; set it to the toggle's background on dark hosts). |
| `--aia-badge-size`, `-top`, `-right` | Size and position of the dot (defaults 7px, 3px, 3px). Give a small text toggle some right padding (e.g. `padding-right: 18px`) so the dot never covers its label. |
| `.aia-docked-dialog` | Class on host dialogs docked beside the drawer (`dialogs: 'dock'`). |
| `[data-aia-ignore]` | Host elements `fromDom` skips. |

Set the badge variables on the toggle itself or any ancestor (`:root`). All runtime classes start with `aia-`.
