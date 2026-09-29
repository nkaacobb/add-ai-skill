# Framework recipes

The runtime is plain ES modules plus one stylesheet. Every recipe below does the same four things:

1. load `ai-agent.css` once;
2. create the agent **once, on the client**;
3. give it the current page (`setPage`) on every navigation, with `content`/`view` hooks that read the latest state;
4. call `contextChanged()` when that state changes.

In frameworks, prefer a button in your own component that calls `agent.toggle()` (with `launcher: false`) over a
`toggle` selector — the selector must already exist in the DOM when the agent is created. Show the sync flag with
`agent.onContextStatus()` (it provides `state` and `hash`).

---

## Plain HTML / vanilla SPA

```html
<link rel="stylesheet" href="assets/ai-agent/ai-agent.css">
<header>… <button id="ask-ai" type="button">Ask AI</button></header>
<main id="main">…</main>
<script type="module" src="assets/js/ai-agent-setup.js"></script>
```

```js
// assets/js/ai-agent-setup.js
import { createAiAgent, DEFAULT_SYSTEM_PROMPT } from '../ai-agent/ai-agent.js';
import { router, state } from './app.js';

export const agent = createAiAgent({
  appId: 'my-app', title: 'Assistant', toggle: '#ask-ai', push: '#main',
  app: { name: 'My App', purpose: '…', capabilities: ['…'], limits: ['…'] },
  systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n…domain rules…`,
});

const PAGES = {
  list: { title: 'Customers', purpose: '…', content: () => state.visibleCustomers, view: () => ({ selected: state.selectedId }) },
  detail: { title: () => `Customer ${state.customer?.name ?? ''}`, purpose: '…', content: () => state.customer },
};
router.onChange((route) => agent.setPage({ id: route.name, ...PAGES[route.name] }));
state.onChange(() => agent.contextChanged());
```

The Hello World example (`examples/hello-world/`) is a complete single-page integration.

---

## PHP / server-rendered multi-page apps

Each navigation is a full page load, so: one shared include, a per-page description rendered by PHP, and optional
page-specific content hooks. `resume` (on by default) keeps the conversation and the open drawer across page loads.

```php
<?php // partials/ai-agent.php — include at the end of the shared layout
$aiPage = $aiPage ?? ['id' => basename($_SERVER['SCRIPT_NAME'], '.php'), 'title' => $pageTitle ?? 'Page'];
?>
<link rel="stylesheet" href="/assets/ai-agent/ai-agent.css">
<script type="application/json" id="ai-page"><?= json_encode($aiPage, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) ?></script>
<script type="module" src="/assets/js/ai-agent-setup.js"></script>
```

```php
<?php // orders.php
$aiPage = ['id' => 'orders', 'title' => 'Orders', 'purpose' => 'Lists open orders with status and totals. The user filters and opens orders here.'];
require __DIR__ . '/partials/layout.php';
```

```js
// assets/js/ai-agent-setup.js
import { createAiAgent, fromDom, DEFAULT_SYSTEM_PROMPT } from '../ai-agent/ai-agent.js';

const page = JSON.parse(document.getElementById('ai-page')?.textContent || '{}');

export const agent = createAiAgent({
  appId: 'my-php-app', title: 'Assistant', toggle: '#ask-ai', push: '.page',
  app: { name: '…', purpose: '…', capabilities: ['…'], limits: ['…'] },
  systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n…`,
  page: {
    ...page,
    // A page script may register a better hook: window.aiPageContent = () => ({ rows: … });
    content: () => (typeof window.aiPageContent === 'function' ? window.aiPageContent() : fromDom('main')()),
    view: () => (typeof window.aiPageView === 'function' ? window.aiPageView() : undefined),
  },
  // defaults: { transport: 'relay', relayUrl: '/api/ai-relay.php' },   // deployed apps: keep keys on the server
});
window.aiAgent = agent;   // lets page scripts call aiAgent.contextChanged() after AJAX updates
```

Data rendered by PHP can also be embedded for the hook: `<script type="application/json" id="ai-data"><?= json_encode($rows, JSON_HEX_TAG | JSON_HEX_AMP) ?></script>`
and `window.aiPageContent = () => JSON.parse(document.getElementById('ai-data').textContent)`.

For the relay, copy `assets/relay/relay.php` to e.g. `/api/ai-relay.php` and add the app's login/CSRF check where the
file marks it; pass the CSRF token with `relayHeaders: () => ({ 'X-CSRF-Token': csrfToken })`.

---

## React (Vite / CRA)

Copy the runtime to `src/lib/ai-agent/` (TypeScript picks up `ai-agent.d.ts` automatically).

```ts
// src/ai/agent.ts
import { createAiAgent, DEFAULT_SYSTEM_PROMPT, type AiAgent } from '../lib/ai-agent/ai-agent.js';
import '../lib/ai-agent/ai-agent.css';

let agent: AiAgent | null = null;

export function getAgent(): AiAgent {
  agent ??= createAiAgent({
    appId: 'my-react-app',
    title: 'Assistant',
    launcher: false,                 // the header button calls getAgent().toggle()
    push: '#root',
    app: { name: '…', purpose: '…', capabilities: ['…'], limits: ['…'] },
    systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n…`,
  });
  return agent;
}
```

```ts
// src/ai/useAiPage.ts
import { useEffect, useRef } from 'react';
import { getAgent } from './agent';

/** Register the current page with the agent. `content`/`view` are read lazily, so they are always current. */
export function useAiPage(page: { id: string; title: string; purpose?: string }, content: unknown, view?: unknown) {
  const latest = useRef({ content, view });
  latest.current = { content, view };

  useEffect(() => {
    const agent = getAgent();
    agent.setPage({ ...page, content: () => latest.current.content, view: () => latest.current.view });
    return () => agent.setPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id, page.title]);

  useEffect(() => { getAgent().contextChanged(); }, [content]);
}
```

```tsx
// in a page component
useAiPage({ id: 'orders', title: 'Orders', purpose: 'Open orders with status and totals.' },
  { filters, rows: visibleRows }, { selectedId });

// in the header
const [flag, setFlag] = useState('unread');
useEffect(() => getAgent().onContextStatus((s) => setFlag(s.state)), []);
<button onClick={() => getAgent().toggle()} data-flag={flag}>Ask AI</button>
```

Memoise `content` (e.g. `useMemo`) so the effect only fires when the data really changes; `contextChanged()` is
debounced and hash-based, so an extra call is harmless.

## Next.js (App Router)

Same files as React, plus: the agent must only be created in the browser.

```tsx
// app/ai-agent-boot.tsx
'use client';
import { useEffect } from 'react';
export default function AiAgentBoot() {
  useEffect(() => { import('@/ai/agent').then(({ getAgent }) => getAgent()); }, []);
  return null;
}
```

Render `<AiAgentBoot />` in `app/layout.tsx`, import `@/lib/ai-agent/ai-agent.css` there (global CSS is allowed in the
root layout), and mark any component that calls `useAiPage` with `'use client'`. Use a route handler
(`app/api/ai-relay/route.ts`) ported from `assets/relay/relay.mjs` if keys must stay on the server.

---

## Vue 3

```js
// src/ai/agent.js
import { onMounted, onBeforeUnmount, watch, unref } from 'vue';
import { createAiAgent, DEFAULT_SYSTEM_PROMPT } from '../lib/ai-agent/ai-agent.js';
import '../lib/ai-agent/ai-agent.css';

let agent;
export const getAgent = () => (agent ??= createAiAgent({ appId: 'my-vue-app', title: 'Assistant', launcher: false, push: '#app', app: { … }, systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n\n…` }));

export function useAiPage(page, content, view) {
  onMounted(() => getAgent().setPage({ ...page, content: () => unref(content), view: () => unref(view) }));
  onBeforeUnmount(() => getAgent().setPage(null));
  watch(content, () => getAgent().contextChanged(), { deep: true });
}
```

`content` can be a `ref`/`computed`; reactive proxies serialise normally.

## Svelte / SvelteKit

```js
// src/lib/ai.js
import { browser } from '$app/environment';
import { createAiAgent } from '$lib/ai-agent/ai-agent.js';
let agent;
export const getAgent = () => (browser ? (agent ??= createAiAgent({ appId: 'my-svelte-app', launcher: false, app: { … } })) : null);
```

```svelte
<script>
  import { onMount } from 'svelte';
  import { getAgent } from '$lib/ai.js';
  import { rows, filters } from './stores.js';
  onMount(() => {
    const agent = getAgent();
    agent.setPage({ id: 'orders', title: 'Orders', purpose: '…', content: () => ({ filters: $filters, rows: $rows }) });
    const off = rows.subscribe(() => agent.contextChanged());
    return () => { off(); agent.setPage(null); };
  });
</script>
```

Import `ai-agent.css` in the root `+layout.svelte`.

## Angular

```ts
// ai-agent.service.ts
import { Injectable, Inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { createAiAgent, type AiAgent, type PageContext } from '../lib/ai-agent/ai-agent.js';

@Injectable({ providedIn: 'root' })
export class AiAgentService {
  private agent: AiAgent | null = null;
  constructor(@Inject(PLATFORM_ID) private platform: object) {}
  get(): AiAgent | null {
    if (!isPlatformBrowser(this.platform)) return null;
    return (this.agent ??= createAiAgent({ appId: 'my-ng-app', launcher: false, app: { … } }));
  }
  setPage(page: PageContext) { this.get()?.setPage(page); }
  changed() { this.get()?.contextChanged(); }
}
```

Add `"src/lib/ai-agent/ai-agent.css"` to `styles` in `angular.json`, call `setPage` in each routed component's
`ngOnInit` (content hook reading the component's fields), and `changed()` after data loads.

---

## Electron / Tauri / desktop webviews

Same as plain HTML. `file://` pages cannot load ES modules in some shells: serve the UI from the app's local
server/protocol handler. Local LLMs (LM Studio, Ollama) work directly; cloud providers may need the relay.
