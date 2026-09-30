# add-ai-skill — the AI Agent Drawer pattern, as a reusable skill

This repository packages an AI agent pattern so any app can have it, and so Claude Code, Codex and GitHub Copilot can
build it into an app on request:

> **Application X has an AI agent that slides out from the right, sees what is on the current screen
> (plus what the app and the page are for), can act in the app through its own functions (you confirm changes and
> choose which tools are on), remembers what you ask it to remember, can look at a screenshot of what you are looking
> at, answers in rich Markdown, and can use any LLM — LM Studio by default.**

| | |
| --- | --- |
| **The skill** — [`add-ai-skill/`](add-ai-skill/) | Instructions ([`SKILL.md`](add-ai-skill/SKILL.md) + [`references/`](add-ai-skill/references/)) plus everything a coding agent needs to build the pattern into an app: the runtime, the relays, verification tooling, and tests. |
| **The Hello World app** — [`add-ai-skill/examples/hello-world/`](add-ai-skill/examples/hello-world/) | A small text editor with the agent built in. The reference integration. |
| **The installer** — [`install-skill.ps1`](install-skill.ps1) / [`install-skill.sh`](install-skill.sh) | Copies the skill to the user-wide skill folders so it is available in every project. |

## Install the skill for Claude Code, Codex and Copilot

```powershell
.\install-skill.ps1            # or: ./install-skill.sh on macOS/Linux/Git Bash
```

This copies `add-ai-skill/` to:

| Folder | Read by |
| --- | --- |
| `~/.claude/skills/add-ai-skill` | Claude Code |
| `~/.agents/skills/add-ai-skill` | Codex, GitHub Copilot |

**This repository is the source of truth.** Edit the skill here, then re-run the installer to update the installed
copies (it also removes copies installed under the old name `ai-agent-drawer`). `-Uninstall` removes them;
`-Targets claude` installs for one tool only.

## Apps that already have the agent

Run the skill again in the app — no special prompt needed. Its first step (`scripts/detect.mjs`) finds the existing
integration, its version, and which features it already has and uses (tools, memory, vision). The skill then
**upgrades** it (`references/upgrading.md`): new runtime and relay, config migrated, workarounds removed, and **only
the pieces that are missing** added — what is already there (hooks, tools, settings, saved chats) stays. A record is
written (`ai-agent.integration.json`); there is never a second agent. You can narrow it: "/add-ai-skill just update
the runtime", "/add-ai-skill add tools", "/add-ai-skill add memory and screenshots".

```powershell
node add-ai-skill/scripts/detect.mjs D:\path\to\app      # see what an app has, without changing anything
```

## Use it in another app

Open the app and ask your agent:

- **Claude Code** — "Use the add-ai-skill skill to build an AI agent into this app", or `/add-ai-skill`
- **Codex** — `$add-ai-skill build an AI agent into this app`
- **GitHub Copilot** (agent mode) — `/add-ai-skill build an AI agent into this app`

The skill tells the agent to survey the app (including its production stack, keyboard shortcuts, modal dialogs,
layout, and everything the user can do on each page), propose a context plan and a **tool plan**, copy the runtime
in, mount one agent, wire `setPage` / `content` / `view` for every page, signal changes, fit the host app, build the
tools over the app's own functions (with `ai-tools.json` choosing which are on), seed the agent's memory
(`ai-memory.json`) and choose how screenshots are taken, optionally add a relay, and verify with `scripts/verify.mjs`.
You can steer it, e.g. "…and put the Ask AI button next to the search box" or "…use the PHP relay in public mode".

## Run the Hello World app

1. Start **LM Studio**: Developer tab → *Start server* (the template expects `http://127.0.0.1:9000`; change it in
   Settings if yours uses 1234), turn on **Enable CORS**, and load a model (with at least 8k context).
2. From this repository's root:

   ```powershell
   node add-ai-skill/assets/relay/relay.mjs --static .
   ```

3. Open <http://127.0.0.1:8787/>. (Any static server works too; this one also provides the optional relay at
   `/ai-relay`.)

Then try it: click **Ask AI** (or `Ctrl+I`) and ask "Proofread this" — your message shows **Read the page · Editor ·
N chars · hash** and the status bar flag turns green. Edit the text: the flag turns amber. Ask again: the page is
re-read; ask once more without editing: **Page unchanged**. Ask "make the text bigger": the agent answers with an
editor-settings block and an **Apply editor settings** button. Ask "fix the spelling mistakes": the agent calls its
`replace_text` tool and asks you to confirm before the document changes. Ask "rename the file to notes.txt": that
tool is off by default, so it offers a **Turn on** button first. **Settings → Tools** has a checkbox per tool. Click
the flag to see exactly what the AI receives (Settings → Context, including the estimated token size).

Memory and vision: ask "which shortcut saves the document?" (it knows from `ai-memory.json`), then "remember that I
prefer British spelling" — a **Remember** chip with Undo; **Settings → Memory** lists, edits and exports the notes.
With a model that sees images, press the **camera button** beside Send: the browser asks to share the tab, a thumbnail
appears in the composer, and the agent answers about the picture. Ask it to "look at my screen": it asks first
(**Allow once / Always allow / No**). **Settings → Vision** has the two switches.

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
[`references/context-sync.md`](add-ai-skill/references/context-sync.md).

## What's inside the skill

```
add-ai-skill/
  SKILL.md                 instructions the coding agent follows (keep it concise: it is loaded into the agent's context)
  CHANGELOG.md             what changed per version, with upgrade notes for apps
  agents/openai.yaml       Codex display metadata
  assets/ai-agent/         the runtime (copied into apps unchanged): ai-agent.js · ai-agent.css · ai-agent.d.ts
    core/                  context, sync protocol, hashing, prompt, settings, providers, client, transport, relay probe, block values, tools, memory
    adapters/              openai-chat (LM Studio/Ollama/OpenAI/DeepSeek/OpenRouter/custom), anthropic, gemini, relay
    ui/                    drawer, settings modal, markdown, resize, dialog docking, layout check, screenshot capture
  assets/relay/            relay.php (PHP 8.1+) · relay.mjs (Node) · relay.config.example.php — copied unchanged, configured by a file
  examples/hello-world/    the demo: app.js (the editor) · ai-agent-setup.js (the integration) · content.js (pure, tested)
                           · ai-tools.js (8 tools) · ai-tools.json (which are on) · ai-memory.json (starting notes)
  references/              upgrading · api · tools · memory-and-vision · context-sync · frameworks · providers · checklist · architecture
  scripts/detect.mjs       run first on any app: is the agent there, which version, which features, what to upgrade
  scripts/verify.mjs       checks an integration in headless Edge/Chrome (scripts/lib/cdp.mjs is its driver)
  tests/                   node --test: runtime · relays (Node + PHP) · real browser · example
  package.json             npm test · npm run demo · npm run verify
```

## Changing the skill

```powershell
cd add-ai-skill
node --test                                    # all suites; no model needed
node assets/relay/relay.mjs --static .         # Hello World at http://127.0.0.1:8787/examples/hello-world/
node scripts/verify.mjs http://127.0.0.1:8787/examples/hello-world/ --no-llm
```

- The relay tests also run the PHP relay when `php` (with curl) is on the PATH, or `PHP_BIN` points at it
  (e.g. `$env:PHP_BIN = 'D:\xampp\php\php.exe'`).
- The browser tests need Node 22+ and Edge/Chrome/Chromium (`AIA_BROWSER` to choose one; `AIA_SKIP_BROWSER=1` to skip).
- With LM Studio running, `verify.mjs` without `--no-llm` also runs the read → change → re-read → "Page unchanged" loop.

When an integration needed a workaround, fold the lesson back in here so the next one does not:

1. Reproduce it in a test first; check browser/server behaviour for real before encoding it.
2. Keep changes additive and generic (no app names, domains or server paths); anything that could surprise an
   existing app is opt-in or has a safe default. No dependencies, no build step.
3. Update `ai-agent.d.ts`, `references/api.md` and other affected references, `SKILL.md` if the workflow changes,
   Hello World if it demonstrates the feature, and `CHANGELOG.md` (with **Upgrading** notes, and any new
   workaround the upgrade should remove in `references/upgrading.md`); bump the version (`VERSION` in `ai-agent.js`
   and the relay versions when their code changed, `package.json` always).
4. When the runtime or a relay changed: `node scripts/release-hashes.mjs` (the tests fail until you do).
5. Run the tests, try Hello World, commit, and re-run the installer.

Apps that already have a copy of `ai-agent/` take an update by copying the folder over theirs (see the upgrade notes
in `CHANGELOG.md`); integrations only use the options and methods, so the copy can be replaced wholesale.
