# Changelog

All notable changes to the add-ai-skill skill (it builds the "AI agent drawer" into apps). The runtime (`assets/ai-agent/`), the relays (`assets/relay/`) and
the skill instructions are versioned together: `VERSION` in `ai-agent.js`, `AIA_RELAY_VERSION` / `RELAY_VERSION` in
the relays, and `package.json`.

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
