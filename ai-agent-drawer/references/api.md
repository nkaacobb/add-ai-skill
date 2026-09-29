# API reference

`import { createAiAgent, fromDom, DEFAULT_SYSTEM_PROMPT } from './ai-agent/ai-agent.js'` and load `ai-agent/ai-agent.css`.
Types: `assets/ai-agent/ai-agent.d.ts`.

## createAiAgent(options) → agent

Creates and mounts the toggle wiring (or a floating launcher), the drawer and the settings modal. Call once, in the
browser, after the DOM exists.

| Option | Default | Meaning |
| --- | --- | --- |
| `appId` | `'app'` | **Required in practice.** Namespaces browser storage: `<appId>.ai.settings`, `.keys`, `.chats`, `.width`. |
| `title` | `'AI agent'` | Drawer title (e.g. "Security analyst", "Writing agent"). |
| `app` | – | App context hook: string, object or (async) function. Objects render as `Label: value` lines; arrays as bullets. Suggested keys: `name`, `purpose`, `audience`, `capabilities[]`, `limits[]`, `glossary{}`. |
| `page` | – | Initial page: `{ id, title, purpose, content, view, ...more descriptive keys }`. See "Page". |
| `systemPrompt` | `DEFAULT_SYSTEM_PROMPT` | The app's default prompt (string or function). Users can override it in Settings > Agent; "Restore app default" brings this back. |
| `welcome` | generic | Markdown shown at the start of each chat. |
| `suggestions` | `[]` | Clickable starter questions under the welcome. |
| `placeholder` | generic | Composer placeholder. |
| `toggle` | `null` | Selector/element(s) that toggle the drawer. None → floating launcher (unless `launcher: false`). |
| `toggleBadge` | `true` | Adds a coloured context-state dot on toggles (`[data-aia-toggle][data-aia-context]`). |
| `push` | `document.body` | Element(s) that get `padding-right` = drawer width while open. `false` = overlay. Below 900 px wide the drawer always overlays. |
| `hotkey` | `'mod+i'` | Toggle shortcut (`mod` = Ctrl/Cmd; also `shift+`, `alt+`). `false` disables. |
| `theme` | `'auto'` | `'light'`/`'dark'` force a theme; auto follows the OS. |
| `width` | `440` | Default drawer width (users drag the left edge; double-click resets; remembered). |
| `watch` | `0` | Poll the content hook every N ms while the drawer is open. Use when you cannot call `contextChanged()`. |
| `debounceMs` | `300` | Debounce for `contextChanged()`. |
| `codeActions` | `[]` | `[{ id, label, title?, when?(block), run(block, agent), doneLabel? }]` → buttons on fenced code blocks (`block = { language, code }`). Copy is built in. |
| `replyActions` | `[]` | `[{ id, label, title?, run(markdown, agent), doneLabel? }]` → buttons under each reply. Copy is built in. |
| `defaults` | `{}` | App defaults for any setting (see "Settings"). User choices override them. |
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
  content: () => ({ order: current.order, lines: current.lines }),   // FINGERPRINTED
  view: () => ({ selectedLine: current.selectedLineId, tab: current.tab }), // NOT fingerprinted
});
```

- `content` may return a string (sent as written) or JSON-able data (sent as sorted-key, 2-space JSON; key order never
  changes the hash). Async functions are fine. If it throws, the snapshot says the content could not be read.
- `view` is sent inside `<view_state>` with every question and is limited to 2,000 characters.
- `setPage(null)` clears the page (flag shows *none*).

## Agent methods

| Method | Does |
| --- | --- |
| `open()`, `close()`, `toggle()`, `isOpen()` | Drawer visibility. |
| `ask(text)` | Send a question as the user (opens the drawer). Returns when the reply has finished. |
| `stop()` | Abort the streaming reply (partial text is kept and marked). |
| `newChat()` | Save the current chat and start a new one (flag → *unread*). |
| `openSettings('model' \| 'agent' \| 'context')` | Open the settings modal on a tab. The Context tab shows exactly what the hooks produce. |
| `setApp(app)` | Replace the app context. |
| `setPage(page)` | Replace the page (navigation). Recomputes the flag immediately. |
| `setContent(fn)`, `setView(fn)` | Replace only the current page's content/view hook. |
| `contextChanged()` | Debounced: re-hash the screen and update the flag. Call after every change to what is shown. |
| `refreshContext()` | Same, immediately; resolves to the status. |
| `getContextStatus()` | Current status (below). |
| `onContextStatus(fn)` | Subscribe; `fn` runs immediately and on every change. Returns unsubscribe. |
| `rereadPage()` | Force the next question to carry a fresh snapshot. |
| `systemPrompt()` | Resolves to the full system prompt as it would be sent now. |
| `on(event, fn)` | Events: `open`, `close`, `send` `{text, attached, reason, hash}`, `reply` `{text, provider, model, stopped}`, `error` `{error}`, `context` (status), `settings` (settings). Returns unsubscribe. |
| `settings.get()`, `settings.save(patch)`, `settings.reset()`, `settings.setKey(provider, key)` | Programmatic settings. |
| `destroy()` | Remove everything the agent added. |

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
| `timeoutSec` | `120` | Idle timeout (resets while tokens stream). |
| `rememberKeys` | `false` | Keys in localStorage instead of sessionStorage. |

## fromDom(target, { exclude, fields = true })

Returns a content hook reading an element's rendered text (`innerText`, so tables keep their tab-separated columns)
plus a "Form fields:" list of visible input/select/textarea values (never passwords or hidden fields). Skips the
agent's UI, `[data-aia-ignore]`, and anything matching `exclude`.

## Other exports

`renderMarkdown(md, { codeActions })`, `hashText(str)`, `stableStringify(value)`, `DEFAULT_SYSTEM_PROMPT`,
`PROVIDERS`, `PROVIDER_IDS`, `AiError`, `VERSION`.

## Theming

Override variables on `.aia-scope` from the host stylesheet:

```css
.aia-scope { --aia-accent: #7c3aed; --aia-accent-strong: #5b21b6; --aia-accent-soft: #ede9fe; --aia-radius: 6px; }
:root { --aia-drawer-width: 480px; --aia-z: 1000; }
```

All runtime classes start with `aia-`; add `data-aia-ignore` to host elements `fromDom` should skip.
