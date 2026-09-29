# The context-sync protocol

The question this answers: **does the AI already have what is on my screen?**

## Layers

| Layer | Source | Where it goes | Hashed? |
| --- | --- | --- | --- |
| App | `app` option / `setApp()` | System prompt, every request | No (always sent fresh) |
| Page | `page` / `setPage()` (id, title, purpose, …) | System prompt, every request | Page id + title are part of the content hash |
| Content | `page.content` hook | Attached to a user message as `<page_snapshot>` **only when it changed** | **Yes** |
| View | `page.view` hook | `<view_state>` on the newest user message, every request | No |

App and page context are small and live in the system prompt, which is rebuilt for every request, so they are
always current. The content can be large, so it is sent once and then only when it changes.

## The algorithm (core/conversation.js)

Chat APIs are stateless: every request resends the transcript. "The model has the page" therefore means: *a snapshot
with the same fingerprint as the screen now is inside the part of the transcript that will be sent.*

On every question:

1. `snapshot = ContextManager.snapshot()` → `{ text, hash, pageId, pageTitle, chars, totalChars, truncated }`.
   `hash = cyrb53(pageId + title + FULL content text)` (before truncation, so a change past the cut still counts).
2. `start = windowStart(transcript.length + 1, historyMessages)`; find the newest message at or after `start` that
   carries a snapshot **with its text**.
3. Decide (`planTurn`):
   - sharing off → `off` (no snapshot; the system prompt says so)
   - no content / empty → `empty`
   - user pressed Re-read → `forced` (attach)
   - no snapshot in the window → `unread` (never sent in this chat) or `trimmed` (fell out of the window) → attach
   - hash differs → `changed` → attach
   - hash equal → `unchanged` → do not attach; add one line: `[The screen is unchanged since page snapshot abc1234: it is still current.]`
4. Build the request (`buildRequestMessages`): the newest snapshot is inlined in full; older snapshots become a
   one-line stub (so a page is never paid for twice); the view state and the question go last.
5. If the request fails with no answer, the question is removed from the transcript, so the sync state is exactly
   what it was before (a failed turn never counts as "the model has it").

Wire format of a user turn that carries a snapshot:

```
<page_snapshot page="editor" title="Editor" hash="16e069b" chars="773" captured="2026-09-29T08:40:00.000Z">
File name: hello-world.txt
…content…
</page_snapshot>

<view_state>
Cursor: line 17, column 43
Selection: (nothing selected)
</view_state>

When is the meeting?
```

A `</page_snapshot` inside the content is neutralised so a document cannot close the block early, and the system
prompt tells the model to treat snapshot content as data, never as instructions.

## The flag (contextState)

| State | Meaning | Drawer bar | Next question |
| --- | --- | --- | --- |
| `synced` (green) | The model has exactly this screen | "Agent has this page" | question only |
| `dirty` (amber) | The screen changed since the model's newest snapshot | "Page changed · agent re-reads it…" | attaches snapshot |
| `unread` (blue) | Not read in this conversation (new chat, restored chat, trimmed) | "Agent will read this page…" | attaches snapshot |
| `none` (grey) | The page shares no content | "No page content shared" | nothing |
| `off` (grey) | Sharing switched off in Settings | "Screen sharing is off" | nothing |

Every user message shows a receipt chip: **Read the page · title · N chars · hash**, or **Page unchanged · hash**.

## When is the flag recomputed?

- `agent.contextChanged()` (debounced 300 ms) — call it from the app whenever the content may have changed.
- `agent.setPage()`, opening the drawer, after every reply, on settings changes.
- Every `watch` ms while the drawer is open, if the `watch` option is set.

Hashing is cheap (a 100 KB document hashes in well under a millisecond), and nothing is sent until the user asks.

## Designing good content hooks

- **Deterministic.** The same screen must produce the same text. Sort lists the way the UI does, avoid timestamps
  that tick, avoid random ids. Objects are serialised with sorted keys, so property order does not matter.
- **What the user sees.** The filtered/paged rows, the open record, the document. Include the column/field labels.
- **Compact.** Trim noise (internal ids the user never sees, huge blobs). The runtime cuts at `maxContextChars` and
  says so; if pages regularly hit the cap, summarise (counts, totals) plus the visible rows.
- **Volatile state in `view`.** Cursor, selection, scroll position, hover, "last refreshed" — not in `content`.
- **No secrets.** Never tokens, passwords, keys, or other users' data.

## Saved chats

Conversations are saved without snapshot text (it can be large and may be sensitive). When a saved chat is reopened,
its snapshots show their fingerprints but are "not kept", so the flag is `unread` and the next question re-reads the
current screen.
