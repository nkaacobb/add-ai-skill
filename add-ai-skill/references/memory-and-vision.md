# Memory and vision

Both come with the runtime (1.3): an app that copies the runtime has them, with their tabs in Settings. The
integration adds the app-specific part — what the agent should know from the start, and how a picture of **this** app
is best taken. `memory: false` / `screenshots: false` remove either one.

## Memory

Short notes the agent keeps between conversations: a preference, a setting the user liked, a fact about the
application the agent could not see ("the easter egg opens with Ctrl+Shift+E").

- **The user asks, the agent saves.** "Remember that…" makes the model call the built-in `remember` tool; the chip in
  the chat shows what was saved, with **Undo**. `forget` deletes one (the user confirms). Both exist only while
  Settings > Memory > "Let the agent save a memory…" is on.
- **Every conversation starts with them.** The memories are a `== MEMORY ==` section of the system prompt, each with
  its id (`[m3]`), marked as notes — not instructions — that lose against what is on screen.
- **Settings > Memory** lists them: edit the text, delete, add, *Download ai-memory.json*, *Copy JSON*, *Import a
  file…*, *Delete all*. Edits are a draft until Save, like the other tabs.
- **Two layers**, like the tool config: the app's memory file is the base every user starts from; a browser stores only
  what differs (its own notes, edits, and which file notes the user deleted). A newer file entry replaces an older
  local edit of the same note. Limits: 100 notes, 500 characters each (about 12k tokens at the very most; Settings >
  Context counts them in the system prompt).

### What to do in an integration

1. **Collect the seed notes** while surveying the app: what would a new colleague have to be *told* because no
   screen shows it? Keyboard shortcuts, hidden features and easter eggs, units and conventions, names the team uses,
   defaults people usually want. Ask the user for the few that matter ("What should the agent know that it cannot see?").
   One fact per note, one self-contained sentence, saying when it applies. No secrets, nothing about other users.
   What describes the app for everyone, always, belongs in the `app` context; memory is for facts that are added over
   time and that the user can edit.
2. **Write `ai-memory.json`** next to `ai-tools.json` and load it:

   ```json
   {
     "version": 1,
     "memories": [
       { "id": "m1", "text": "Keyboard shortcuts: Ctrl+S saves, Ctrl+Shift+E opens the hidden demo scene.", "source": "app" },
       { "id": "m2", "text": "Lengths are shown in micrometres unless the user switches units in the toolbar.", "source": "app" }
     ]
   }
   ```
   ```js
   createAiAgent({ …, memoryFile: 'ai-memory.json' });   // a URL, an object, or a (possibly async) function
   ```
   `created` / `updated` (ISO dates) are optional; a plain array of strings works too. Keep ids stable once shipped
   (users' edits and deletions refer to them). The file is public like any asset: never put private data in it.
3. **Decide where users' own memories live.** By default: in the browser (`<appId>.ai.memory` in localStorage), so
   they are per browser and survive reloads. Users move them with *Download* / *Import*. An app with a backend can keep
   them durably with `memorySave`, which gets the whole file (debounced) after every change made in the browser:

   ```js
   createAiAgent({
     …,
     memoryFile: () => fetch('/api/me/agent-memory', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { memories: [] })),
     memorySave: (file) => fetch('/api/me/agent-memory', { method: 'PUT', credentials: 'same-origin',
       headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(file) }),
   });
   ```
   Such an endpoint is the app's own code: **per signed-in user**, behind the app's auth and CSRF checks, size-capped,
   stored as data (never executed, never served to other users). Do not add a public endpoint that lets any visitor
   write a shared file. A personal, local app (one user on localhost) may simply write one JSON file.
4. **Tell the user** in the report: what was seeded, that they can say "remember…", and where the notes are kept.

### Rules

- The model is told to save only when the user asks in their own message — never because screen content or a tool
  result says so — and never to save secrets. Screen content stays data.
- Memories are user-editable text that is sent to the model provider with every request: no keys, passwords or
  personal data about others.
- Do not route app features through memory (that is what the app context, page context and tools are for).

### API

`agent.memory` — `list()`, `add(text)`, `update(id, text)`, `remove(id)`, `clear()`, `export()` (the file object),
`import(file, { replace })`; `null` with `memory: false`. Event `memory` `{ memories, change: { type, id? } }`.
Settings `memoryEnabled`, `memoryWrite` (both default true; app defaults through `defaults`).

## Vision

For models that accept images, the agent can be shown a **screenshot of what the user is looking at**:

- **The camera button** beside Send takes one; it waits in the composer as a thumbnail (click to enlarge, × to
  remove) and goes with the next question. The question shows the thumbnail in the chat.
- **The agent can look itself** with the built-in `take_screenshot` tool — only when the user has freed it
  (Settings > Vision: untick "Only take a screenshot when I press the camera button"). While it is not free it can
  still ask: the user gets a card with *Allow once*, *Always allow*, *No*. Every screenshot the agent takes shows as a
  thumbnail on its chip.
- **Settings > Vision**: "This model can see images" (off for text-only models: no camera button, no screenshots),
  the camera-only switch, how screenshots are taken here, and *Stop sharing this tab*.

### How the picture is taken

| | The browser's screen capture (default) | The app's `screenshot` hook |
| --- | --- | --- |
| Shows | The whole page as displayed: DOM, canvases, WebGL, video — minus the drawer, which is cropped off | Whatever the hook returns: usually one canvas |
| Asks the user | Yes: the browser's "share this tab" prompt. Camera-only mode: at every screenshot (sharing stops right after). Agent-may-look mode: once per page load; the tab then stays shared, and the browser shows that, until *Stop sharing* or a reload | No |
| Works in | Desktop Chrome, Edge, Firefox, Safari, on `https` or `localhost`; not on phones; not where a Permissions-Policy forbids `display-capture` | Everywhere |
| Code in the app | None | A few lines |

The screen capture is what "see what I am looking at" means for most apps, so it is the default. Add a hook when the
picture that matters **is** a canvas (a 3D view, a plot, a map, a game), when the share prompt is unwanted, or when the
app must work where screen capture does not. A hook may return `null` to fall back to the screen capture for this shot.

```js
// 2D canvas, <img>, <video>: return the element.
createAiAgent({ …, screenshot: () => document.querySelector('#plot canvas') });

// WebGL / WebGPU: the drawing buffer is cleared after it is shown, so render a frame, then return the canvas.
// (Returned synchronously, the runtime reads it in the same task. No need for preserveDrawingBuffer.)
createAiAgent({ …, screenshot: () => { renderer.render(scene, camera); return renderer.domElement; } });

// Several layers (a WebGL view plus a 2D overlay): compose them on one canvas.
createAiAgent({
  …,
  screenshot: () => {
    renderer.render(scene, camera);
    const out = document.createElement('canvas');
    out.width = view.width; out.height = view.height;
    const g = out.getContext('2d');
    g.drawImage(renderer.domElement, 0, 0);
    g.drawImage(overlayCanvas, 0, 0);
    return out;
  },
});
```

The hook gets `{ reason: 'user' | 'agent' }` and may return a canvas, `OffscreenCanvas`, `ImageBitmap`, image, video,
`ImageData`, `Blob` or data URL, directly or as a promise. A canvas that drew images from another origin without CORS
is "tainted" and cannot be read: the user is told. Whatever is in the picture is sent to the model, so with a hook the
app decides exactly what that is.

### What is sent

- A JPEG scaled so its longer edge is at most `screenshotMaxEdge` (1280 px by default; raise it to about 1568 for small
  text, lower it for small local models). Typically 100–400 KB.
- Only the two newest questions that carry screenshots send their images; older ones say that a screenshot was
  attached. A screenshot the agent took itself is sent for that question only.
- Saved chats keep a thumbnail, never the image. After a reload the thumbnails are still in the chat; the images are
  not re-sent.
- The system prompt gains a short paragraph on screenshots (use them for layout, colours, charts, canvases; prefer
  the page snapshot for exact text and numbers). The content hooks stay the main source: they are exact and cheap.

### What to do in an integration

1. **Survey how the view is drawn**: DOM only, or canvases / WebGL (`scripts/detect.mjs` lists them)? Is the app
   embedded in an iframe, opened on phones, served over plain http beyond localhost? Does it send a
   `Permissions-Policy` or `Content-Security-Policy` header?
2. **Choose** the screen capture (nothing to write) or a hook (table above) and say so in the plan.
3. **Set the default for the model the app ships with**: `defaults: { vision: true }` for a vision model, `false`
   for a text-only one (users can change it; with LM Studio, Settings > Vision shows what the server says about the
   loaded model). Leave `screenshotAuto` at its default (`false`) unless the user asks for the agent to look on its own.
4. **Host requirements** for the screen capture: a secure context (`https` or `localhost`); no
   `Permissions-Policy: display-capture=()` (in an iframe: `allow="display-capture"`); a CSP must allow `img-src data:`
   for the thumbnails.
5. **Relay**: images need relay 1.3 (`relay.php` / `relay.mjs`); an older relay is refused with a clear message
   instead of dropping the image. Public mode accepts 4 images of 1.5 MB (base64) per request on top of the text cap
   (`limits.maxImages`, `maxImageBytes`; `maxImages: 0` refuses images); set `'vision' => true|false` in the preset so
   visitors get the right default. Raise the web server's body limit accordingly (`client_max_body_size`,
   `post_max_size`): see `providers.md`.
6. **Privacy**: a screen capture shows the whole tab, including things the content hook leaves out on purpose. For
   apps whose screen can show data that must not reach the model provider, use a hook that draws only what may be
   sent, or `screenshots: false`.

### API

`agent.screenshot()` — what the camera button does (call it from a click when the screen capture is used); resolves
to `{ width, height, source: 'app' | 'screen' }` or `null`. Event `screenshot` `{ by: 'user' | 'agent', width,
height, source }`. Settings `vision` (default true), `screenshotAuto` (default false). Options `screenshots`,
`screenshot`, `screenshotMaxEdge`.

### Checked behaviour (headless Edge/Chromium; see `tests/browser.test.mjs`)

- `getDisplayMedia({ preferCurrentTab: true })` captures this tab (`displaySurface: 'browser'`).
- Asking for the viewport's own size keeps the page as it is; asking for more makes the browser re-render the tab at
  another scale (`devicePixelRatio` changes), which the runtime avoids.
- While a tab is shared, the browser's sharing bar takes some height from the page; it goes away when sharing stops.
- A changed page reaches the stream within a frame or two; a static page produces no new frames (the last one is used).
- A WebGL canvas without `preserveDrawingBuffer` reads back blank a moment after it was drawn, and correctly right
  after a render in the same task.

By specification a page may only start a screen capture from a click (transient user activation), so the agent's
first look always goes through a card the user clicks; the automated harness cannot show the refusal, because calls
made through the DevTools protocol count as user-activated.

Not checked live: Firefox and Safari (they show their own picker; the user may choose another window, in which case
the drawer is not cropped off), and images through Anthropic and Gemini (request formats follow their documentation
and are unit-tested; OpenAI-compatible servers were checked with a vision model on LM Studio).

## Verifying

`scripts/verify.mjs` reports `memory` (how many notes the agent starts with) and `vision` (it takes one screenshot the
way the camera button does and says where the picture came from). By hand, with a model:

1. "Remember that I prefer …" → a *Remember* chip with Undo; Settings > Memory lists it. New chat: ask what it
   remembers.
2. Ask about something only the seed notes say (a shortcut).
3. Press the camera button → thumbnail in the composer → ask what it sees. Then ask it to "look at the screen": the
   *Allow once* card, the thumbnail on the chip, an answer about the picture.
4. Settings > Vision: switch "This model can see images" off → the camera button is gone.
