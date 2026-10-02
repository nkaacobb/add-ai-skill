# Providers, keys, CORS and relays

## Supported out of the box

| Id | Protocol | Default address | Key | Notes |
| --- | --- | --- | --- | --- |
| `lmstudio` (default) | openai-chat | `http://127.0.0.1:9000` | optional token | Empty model = whatever is loaded. Models listed from `/api/v1/models` (shows which is loaded), falling back to `/v1/models`. Thinking arrives as `reasoning_content`; "Ask the model not to think" sends `reasoning_effort: "none"`. LM Studio's own default port is 1234. |
| `ollama` | openai-chat | `http://127.0.0.1:11434` | optional | Model required. `OLLAMA_ORIGINS` must allow the page origin for browser calls. |
| `custom` | openai-chat | `http://127.0.0.1:8080` | optional | Any `/v1/chat/completions` server (llama.cpp, vLLM, LocalAI, Jan, gateways). |
| `openai` | openai-chat | `https://api.openai.com` | required | Sends `max_completion_tokens`, no temperature (reasoning models reject it). |
| `anthropic` | anthropic-messages | `https://api.anthropic.com` | required | Browser calls send `anthropic-dangerous-direct-browser-access: true`. Temperature not sent. "Off" thinking sends `thinking: {type: 'disabled'}`. |
| `google` | gemini-generate | `https://generativelanguage.googleapis.com` | required | `:streamGenerateContent?alt=sse`, key in `x-goog-api-key`. Thought parts shown as thinking. |
| `deepseek` | openai-chat | `https://api.deepseek.com` | required | Thinking off = `thinking: {type: 'disabled'}`. May need the relay (CORS). |
| `openrouter` | openai-chat | `https://openrouter.ai/api` | required | Hundreds of models behind one key; model ids like `anthropic/claude-sonnet-5`. |

Models are never hard-coded: "Load models" asks the provider, and any id can be typed. Placeholders are examples.

**Tool calling** (`tools.md`): native for all three protocols (OpenAI-compatible `tools`/`tool_calls`, Anthropic
`tool_use`, Gemini `functionCall`). Local models need to be trained for tool use (LM Studio shows it per model);
otherwise use Settings > Tools > "Text blocks", which works with any model.

Each provider keeps its own address and model (`profiles`), so switching back and forth does not lose settings.
A **fallback provider** can be set (Settings > Model > Advanced): used only if the primary cannot be reached and no
text has arrived yet; a notice in the reply says so.

## Local models: context size

The first question of a chat carries the system prompt (the app's prompt + app context + page context + the screen
protocol) and the page snapshot. In a real app that is easily 4–5k tokens, and local servers often load models with a
**4,096-token context window** by default — the reply then gets cut off, or the request fails. Settings > Context shows
the estimate (≈ 4 characters per token) and warns above `contextWarnTokens` (3,000) for local providers.

- Load local models with **at least 8k context** (16k+ for thinking models, whose reasoning counts too):
  LM Studio — the Context Length slider when loading the model (or `lms load <model> --context-length 16384`);
  Ollama — `PARAMETER num_ctx 16384` in a Modelfile (the OpenAI-compatible endpoint the drawer uses cannot set it per
  request), or `OLLAMA_CONTEXT_LENGTH=16384` for the whole server in recent versions.
- Keep the app context lean: titles and lists of capabilities/limits, not whole glossaries or manuals. Generate it
  from the app's own data modules (the list of views, the fields of a record type) so it stays true as the app changes.
- Lower *Max screen content* (Settings > Agent) for pages with a lot of data, or summarise in the content builder.

## Keys

- Typed keys are kept in **sessionStorage** (gone when the tab closes) unless the user ticks *Remember API keys on this
  device* (localStorage). They are sent only to the provider (or the app's relay), never elsewhere, and error
  messages are redacted.
- Any script on the page's origin can read browser-held keys. That is fine for local/personal tools; for deployed or
  shared apps use the **relay** with server-side keys (in public mode the relay ignores visitor keys entirely).

## CORS and direct browser calls

Browser → provider calls need the provider to allow the page's origin:

- **LM Studio**: Developer tab → server settings → *Enable CORS*. Use `127.0.0.1` (on Windows `localhost` may resolve
  to IPv6 `::1`).
- **Ollama**: set `OLLAMA_ORIGINS` (e.g. `http://localhost:*`), restart Ollama.
- **OpenAI, Anthropic, Gemini, OpenRouter**: accept browser calls with the headers above.
- **DeepSeek / others**: if the browser reports a network/CORS error, use the relay.
- An **https** page cannot call an **http** LLM (mixed content): serve the app over http on localhost, or use the relay.

## Relays

The relay is the app's own endpoint: the browser sends the conversation to it, it calls the provider, and streams
the reply back. Two reference implementations with the same contract, modes and configuration keys:

- **`assets/relay/relay.php`** — one file, **PHP 8.1+** with the curl extension (uses `never` and readonly properties;
  no 8.2/8.3-only functions, because development and production PHP versions often differ). Apache + mod_php (XAMPP),
  Nginx + PHP-FPM, `php -S`. No rewrites or `.htaccess`.
- **`assets/relay/relay.mjs`** — Node 18+, zero dependencies, reuses the runtime's `core/client.js` (the same adapters
  as the browser). Run it as a sidecar (`node relay.mjs --path /ai-relay`) or embed it:
  `createRelay(await loadConfig()).handle(req, res)`. `--static <dir>` also serves files (never `relay.config.*` or
  dotfiles) — that is how the Hello World example runs.

**Choose the relay that matches production**, not development: if production is Nginx + PHP-FPM without long-running
processes, use `relay.php` (it also runs under XAMPP); if production runs Node, use `relay.mjs`. Copy the relay
**unchanged**; everything app-specific goes in its config file, so a newer relay can be dropped in later.

Enable it with `relayProbe: true` + `defaults: { relayUrl }` (picks the relay when it answers, direct requests
otherwise), or `defaults: { transport: 'relay', relayUrl }`, or in Settings > Model > Advanced.

### Modes

| | `local` (default) | `public` |
| --- | --- | --- |
| Who | Requests from the relay's own computer only (a request that came through a proxy — `X-Forwarded-For`, `Forwarded`… — is not local). `allowRemote: true` / `--allow-remote` opens it up: then put `authorize` in front. | Anyone who can load the app. |
| Provider / model / key | What the user chose; the user's key, or the server's. Local providers may only target loopback/LAN addresses (`allowAnyUpstream`). | Only the configured `preset`: other providers or models are refused with a clear message; visitor keys are never forwarded. |
| Origin | – | Same-origin enforced: `X-Requested-With: ai-agent-drawer` required, `Origin` must be the relay's own host (or in `allowedOrigins`), `Sec-Fetch-Site` must be `same-origin`. No CORS headers, ever. |
| Limits | Body 4 MB; 64 tools and 30 tool steps per question; 16 images of 4 MB. | Per visitor per minute and per day, plus a site-wide daily cap (HTTP 429 + `Retry-After`) — one question per chain of tool steps (`turnId`), up to `maxToolSteps` (10); body, message-count, reply-token and tool (64) caps; 4 images of 1.5 MB (`maxImages`, `maxImageBytes`). |
| Images (1.3) | Screenshots (`images: [{ mime, data }]` on user messages and tool results: base64 PNG, JPEG, WebP or GIF) are checked and passed to the provider. They come **on top of** `maxBodyBytes`, which stays the cap for the text. `maxImages: 0` refuses images. | The same; set `'vision' => true\|false` in the `preset` to say whether its model sees images (the drawer's default for visitors). |
| Errors | Full details. | Visitors get generic messages; configuration details go only to requests from the server itself and to the error log. |

Rate-limit state is a small JSON file (PHP: `flock`ed; Node: in memory, mirrored to the file when `dataDir` is set)
in the data folder. Visitors are identified by IP address — IPv6 by its /64 — hashed with a salt that rotates every
UTC day. No addresses and no conversation text are stored.

### Configuration

A PHP file returning an array (`relay.config.example.php` documents every key); `relay.mjs` reads the same keys from
`relay.config.json` or `relay.config.mjs` (`export default { … }`). Lookup order:

1. the path in the `AIA_RELAY_CONFIG` environment/server variable (`--config <file>` for Node);
2. `relay.config.php` in the `AIA_RELAY_DIR` folder — default: a folder named `ai-agent-relay` **next to the web root**
   (outside it). Recommended in production; the rate-limit state goes there too;
3. `relay.config.php` next to the relay — convenient in development; keep it out of version control (`.gitignore`).

Config files that can sit inside a web root must be `.php` (executed, never served) — never `.json`.

```php
<?php // /var/www/example-app/ai-agent-relay/relay.config.php  (outside the web root /var/www/example-app/public)
return [
    'mode'   => 'public',
    'preset' => ['provider' => 'openai', 'models' => ['gpt-5-mini']],
    'limits' => ['perMinute' => 6, 'perDay' => 100, 'siteDaily' => 1000],
];
```

Keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY` from the
environment first (PHP reads both `getenv()` and `$_SERVER`: Apache `SetEnv` and Nginx `fastcgi_param` values reach
both under mod_php and PHP-FPM; `$_ENV` usually does not have them), then the config's `keys`, then — local mode only —
the key the user typed.

### Contract

```
GET {relayUrl}   (always 200, so a probe never logs an error)
→ { "ok": true, "relay": "ai-agent-drawer", "version": "1.4.0", "available": true|false, "mode": "local"|"public",
    "providers": [...], "serverKeys": {"openai": true, …}, "preset": {"provider","model","models":[…],"vision"?} | null,
    "images": 4,                           (how many images one request may carry; 0 = none; absent before 1.3)
    "reason"?: "…", "detail"?: "… (requests from the server itself only)" }

POST {relayUrl}   Content-Type: application/json   X-Requested-With: ai-agent-drawer (+ relayHeaders)
{ "action": "chat", "provider": "anthropic", "baseUrl": "…", "model": "…", "apiKey": "" ,
  "system": "…", "messages": [{ "role": "user", "content": "…", "images"?: [{ "mime": "image/jpeg", "data": "<base64>" }] }],
  "maxTokens": 4096, "temperature": 0.4, "reasoning": "show",
  "tools": [{ "name": "…", "description": "…", "parameters": { JSON Schema } }],                       (optional)
  "toolTurns": [{ "text": "…", "calls": [{ "id", "name", "arguments": {} }], "results": [{ "id", "name", "content", "images"? }] }],
  "turnId": "…" }
→ 200 text/event-stream
  : open                                   (comment: flushes the headers through every layer)
  : keepalive                              (comment, every ~15 s while the model is silent)
  event: delta      data: {"text":"…"}
  event: reasoning  data: {"text":"…"}
  event: notice     data: {"message":"…"}
  event: tool_call  data: {"id":"…","name":"…","arguments":{…},"signature"?:"…","raw"?:"…"}   (the tools run in the browser)
  event: error      data: {"message":"…","code":"auth|missing-model|bad-endpoint|network|timeout|rate-limit|refused|budget|malformed"}
  event: done       data: {"provider":"…","model":"…","usage":{…},"truncated"?:true}
→ 4xx/5xx application/json {"ok":false,"error":{"message":"…","code":"…","detail"?:"…"}}   (+ Retry-After on 429)

POST {relayUrl}  { "action": "models", "provider": "…", "baseUrl": "…", "apiKey": "" }
→ {"ok":true,"models":[{"id":"…","label":"…","loaded":false}]}  |  {"ok":false,"error":"…","code":"…"}
```

`code` is one of the drawer's error codes and `message` is written for the user: the drawer shows them as they are.

`tool_call.raw` (1.4) is the arguments as the model wrote them (text), and `done.truncated` (1.4) says the reply stopped
at the max-tokens limit. The browser reads the call from `raw` when it is there, so a broken or cut-off call is
reported as such instead of running with guessed values (`tools.md`, "Providers and relays"). A relay older than 1.4
sends neither; it keeps working, but a cut-off call then reads as "could not be read" rather than "cut off".

A relay older than 1.3 would drop images without a word, so before the first request that carries one the drawer asks
the relay (the GET above) and, when `images` is missing or 0, refuses the question with "the relay cannot pass images"
instead. With `relayProbe`, such a relay also switches "This model can see images" off.

### Nginx + PHP-FPM

- **No rewrites and no `.htaccess`**: requests go straight to `relay.php` like any PHP file.
- Streaming: `relay.php` sends `X-Accel-Buffering: no`, so Nginx does not buffer the stream, and `: keepalive` comments
  every ~15 s (driven by cURL's progress callback), so `fastcgi_read_timeout` (60 s by default) never fires while a
  model thinks; the same writes let the relay notice a visitor's Stop. Optionally make it explicit:

  ```nginx
  location = /api/relay.php {
      include fastcgi_params;
      fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
      fastcgi_pass unix:/run/php/php-fpm.sock;
      fastcgi_buffering off;
      fastcgi_read_timeout 330s;         # above the relay's 'timeout' (300 s)
      gzip off;
      client_max_body_size 8m;           # above maxBodyBytes + maxImages × maxImageBytes (public: 0.5 + 4 × 1.5 MB)
      fastcgi_param AIA_RELAY_DIR /var/www/example-app/ai-agent-relay;
      fastcgi_param OPENAI_API_KEY "sk-…";   # or env[OPENAI_API_KEY] in the PHP-FPM pool
  }
  ```
- `gzip_types` must **not** include `text/event-stream` (compression buffers the stream).
- `open_basedir`, if set, must include the relay's data folder (`AIA_RELAY_DIR`).
- Screenshots make requests larger: besides `client_max_body_size`, PHP's `post_max_size` (8 MB by default) must be
  above the largest request — PHP silently discards a larger body, and the relay then answers 413 with the reason (to
  requests from the server itself). Apache: `LimitRequestBody`.
- The PHP curl extension must be installed (`php8.x-curl` on Debian/Ubuntu).
- PHP-FPM's `clear_env = yes` (default) hides the process environment from PHP: pass keys with `fastcgi_param` or
  `env[NAME] = …` in the pool.
- Behind a CDN or load balancer, restore the client address with the `real_ip` module (`set_real_ip_from`,
  `real_ip_header`); otherwise every visitor shares one rate-limit bucket.

### Apache / XAMPP

- `relay.php` calls `apache_setenv('no-gzip', '1')` when available, so `mod_deflate` does not buffer the stream.
- **HTTPS to providers fails with "SSL certificate problem: unable to get local issuer certificate" (cURL errno 60):**
  - XAMPP's bundled CA file (`apache/bin/curl-ca-bundle.crt`, Mozilla data from 2022) is old: download a current
    `https://curl.se/ca/cacert.pem` and point `curl.cainfo` and `openssl.cafile` in `php.ini` at it (restart Apache).
  - If it still fails, something on the machine intercepts TLS (antivirus HTTPS scanning, a company proxy): its root
    certificate is in the Windows store but in no PEM bundle. Set `'caBundle' => 'native'` in the relay config (cURL
    then uses the Windows certificate store), or add that root to the bundle, or turn the HTTPS scanning off for the
    web server. The relay's error message says this when it hits errno 60.
- `SetEnv OPENAI_API_KEY …` (httpd.conf or a vhost) reaches `getenv()`.

### Node relay

`node relay.mjs [--port 8787] [--host 127.0.0.1] [--path /ai-relay] [--config <file>] [--static <dir>]
[--allow-remote] [--allow-any-upstream] [--cors <origin>]` (`--cors` only in local mode). One process keeps the rate
limits in memory (mirrored to `<dataDir>/relay-limits.json`); behind a cluster, run one relay process. Behind a reverse
proxy, turn off proxy buffering for the relay path and keep `proxy_read_timeout` above the relay timeout.

### Before exposing a relay beyond localhost

Use public mode (or local mode with `allowRemote` and an `authorize` check), keep keys on the server, set limits that
match your budget, and run `node --test` in the skill folder (the relay tests need no provider).

## Adding a provider

- **Speaks an existing protocol** (most do — OpenAI-compatible is common): add an entry to
  `assets/ai-agent/core/providers.js` (id, label, group, kind `local|cloud|custom`, protocol, baseUrl, chatPath,
  modelsPath, keyRequired, keyEnv, tokenField, sendsTemperature, reasoningOff, placeholder, note) and the matching
  row in `relay.php`'s `AIA_PROVIDERS`. No adapter code.
- **New wire protocol**: add `assets/ai-agent/adapters/<name>.js` exporting `{ protocol, stream(), listModels() }`
  (see `adapters/index.js` for the contract), register it in `adapters/index.js`, and add parsing to `relay.php`.
  Add tests in `tests/runtime.test.mjs`.
