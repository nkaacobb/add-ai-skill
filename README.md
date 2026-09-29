# Hello World — the AI Agent Drawer pattern, as a reusable skill

This folder packages PortScope's AI agent pattern so any app can have it, and so Claude Code, Codex and GitHub
Copilot can build it into an app on request:

> **Application X has an AI agent that slides out from the right, sees what is on the current screen
> (plus what the app and the page are for), answers in rich Markdown, and can use any LLM — LM Studio by default.**

It contains three things:

| | |
| --- | --- |
| **The skill** — [`ai-agent-drawer/`](ai-agent-drawer/) | Instructions ([`SKILL.md`](ai-agent-drawer/SKILL.md)) plus everything an AI coding agent needs to build the pattern into an app: the runtime, relays, references, and tests. |
| **The Hello World app** — [`ai-agent-drawer/examples/hello-world/`](ai-agent-drawer/examples/hello-world/) | A small text editor (type, or open a file) with the agent built in. The reference integration. |
| **The installer** — [`install-skill.ps1`](install-skill.ps1) / [`install-skill.sh`](install-skill.sh) | Copies the skill to the user-wide skill folders so it is available in every project. |

## Run the Hello World app

1. Start **LM Studio**: Developer tab → *Start server* (this template expects `http://127.0.0.1:9000`; change it in
   Settings if yours uses 1234), turn on **Enable CORS**, and load a model.
2. From this `hello-world` folder:

   ```powershell
   node ai-agent-drawer/assets/relay/relay.mjs --static .
   ```

3. Open <http://127.0.0.1:8787/>. (Any static server works too; this one also provides the optional relay at
   `/ai-relay`.)

Then try it:

- Click **Ask AI** (or press `Ctrl+I`) and ask "Proofread this". Your message shows **Read the page · Editor · N chars · hash**,
  and the status bar flag turns green: *AI has the latest page*.
- Type something in the editor. The flag turns amber (*Page changed*) and shows the new hash.
- Ask again. The page is re-read (new hash). Ask once more without editing: **Page unchanged**, and the document is
  not sent again.
- **Open file…** or drag a text file onto the editor. The agent sees the new document.
- Click the flag (or the eye icon in the drawer) to open **Settings → Context**. It shows exactly what the AI
  receives: the app context, the page context, the view state (cursor/selection), the snapshot, and the full
  system prompt.
- The gear opens **Settings → Model** (provider, address, model, key, Test connection) and **Settings → Agent**
  (system prompt, temperature, reply length, thinking, memory, screen sharing).

## Install the skill for Claude Code, Codex and Copilot

```powershell
.\install-skill.ps1            # or: ./install-skill.sh on macOS/Linux/Git Bash
```

This copies `ai-agent-drawer/` to:

| Folder | Read by |
| --- | --- |
| `~/.claude/skills/ai-agent-drawer` | Claude Code, GitHub Copilot |
| `~/.agents/skills/ai-agent-drawer` | Codex, GitHub Copilot |

Re-run the installer whenever you change the skill. `-Uninstall` removes it.

## Use it in another app

Open the app in VS Code and ask your agent:

- **Claude Code** — "Use the ai-agent-drawer skill to build an AI agent into this app", or `/ai-agent-drawer`
- **Codex** — `$ai-agent-drawer build an AI agent into this app`
- **GitHub Copilot** (agent mode) — `/ai-agent-drawer build an AI agent into this app`

The skill tells the agent to:
1. Survey the app, then propose a context plan: the app's purpose and limits, and what each page shows.
2. Copy the runtime in.
3. Mount one agent, wire `setPage` / `content` / `view` for every page, and call `contextChanged()` wherever data changes.
4. Optionally add app-specific buttons (for example "Insert into editor"), and a relay for deployed apps.
5. Verify in a browser.

You can steer it, e.g. "…and put the Ask AI button next to the search box" or "…use the PHP relay with server keys".

## How it works (short version)

| Layer | Comes from | Sent |
| --- | --- | --- |
| **App context**: what the app is, what it can and cannot do | `app` option | in the system prompt, every time |
| **Page context**: which page, and what it is for | `setPage({ id, title, purpose })` | in the system prompt, every time |
| **Screen content**: the document, the table rows, the record | `page.content` hook | **only when its hash changed** |
| **View state**: cursor, selection, filters | `page.view` hook | with every question, never hashed |

Before each question, the runtime hashes the screen content and compares it with the newest snapshot the model
already has in the conversation. If they match, it sends only the question. If not, it attaches a fresh snapshot.
That result drives the flag: green = in sync, amber = changed, blue = not read yet. Details:
[`references/context-sync.md`](ai-agent-drawer/references/context-sync.md).

## What's inside the skill

```
ai-agent-drawer/
  SKILL.md                 instructions the coding agent follows
  agents/openai.yaml       Codex display metadata
  assets/ai-agent/         the runtime (copied into apps): ai-agent.js · ai-agent.css · ai-agent.d.ts
    core/                  context, sync protocol, hashing, prompt, settings, providers, client, transport
    adapters/              openai-chat (LM Studio/Ollama/OpenAI/DeepSeek/OpenRouter/custom), anthropic, gemini, relay
    ui/                    drawer, settings modal, markdown renderer, resize handle
  assets/relay/            relay.php (XAMPP/PHP) and relay.mjs (Node, also a static server)
  examples/hello-world/    this demo
  references/              api · context-sync · frameworks · providers · checklist · architecture
  tests/                   node --test  (27 unit tests)
  package.json             npm run demo · npm test
```

It is built from two apps you already have:
- **PortScope** (this repo): the drawer, streaming chat, Markdown renderer, saved chats, settings modal, and PHP proxy.
- **Rolling World** (`games/roll-world/src/ai`): the provider catalog, protocol adapters, transport and error handling, settings validation, and the connection test.

The context layers, the hash sync with its flag and per-message receipts, the editable system prompt, and the Context inspector are new.

## Changing the pattern

Edit the files under `ai-agent-drawer/`, run `node --test` inside it, try the Hello World app, then re-run the
installer. Apps that already have a copy of `ai-agent/` can take the update by copying the folder over theirs.
Integrations only use the options and methods, so the copy can be replaced wholesale.
