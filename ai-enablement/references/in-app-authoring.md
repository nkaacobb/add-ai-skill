# In-app authoring: the app's AI adds tools to the app

While a developer works on an application, its own agent can give itself a new tool: the user asks inside the app
("I need a tool that tells me where the cursor is"), the agent reads the app's source, writes a tool module into the
capability folder, registers it, reloads and uses it — every file shown to the user and confirmed first. The developer
then commits the change like any other.

This is development tooling. It needs the skill's workspace server, which never ships with the app; without it the
agent has none of these tools.

## Set it up

1. The app has a capability folder (`ai/index.json`; `capabilities.md`, `upgrading.md` "Adopting the framework").
2. The integration passes `host` (what tools call) and turns the workspace on for development:

   ```js
   createAiAgent({ …, capabilities: 'ai/index.json', host: app, workspace: location.hostname === '127.0.0.1' });
   ```

   `workspace: true` uses `/ai-workspace` on the page's own origin; a URL points at another port. When nothing answers
   (production, or the server is not running) the option does nothing.
3. Run the server:

   ```bash
   # a static app (or a PHP app you can serve as files): one server for the site, the relay and the workspace
   node <skill>/scripts/workspace.mjs <app-root>                      # http://127.0.0.1:8790/
   node <skill>/scripts/workspace.mjs examples/hello-world --static .  # Hello World inside this skill

   # an app with its own dev server (Vite, Next.js, XAMPP…): the workspace on its own port, that origin allowed
   node <skill>/scripts/workspace.mjs <app-root> --no-static --origin http://localhost:5173
   #   and in the app: workspace: 'http://127.0.0.1:8790/ai-workspace'
   ```

   `--ai <dir>` names the capability folder when there are several (default: the folder of the first ai-enablement
   `index.json`, else `ai`).

## What the agent gets

| Built-in | Effect | Does |
| --- | --- | --- |
| `describe_host` | read | Lists what `host` offers: functions with their parameters, properties (one level). |
| `list_source_files` | read | A folder of the app. |
| `read_source_file` | read | A file of the app (in parts of 60,000 characters). |
| `search_source` | read | Plain-text search over the app's files (100 matches). |
| `write_ai_file` | **system** | Creates a file in the capability folder; replaces one only with `replace: true`. |
| `reload_capabilities` | read | Loads the index, modules, tool config and memory file again; reports problems, and tool files the index does not name. |
| skill `create-tool` | — | The procedure and the module format (`assets/ai-agent/skills/create-tool/SKILL.md`). |

The model loads the skill when a request needs a tool it does not have, or the user types `/create-tool …`.

## What keeps it safe

- **Every write is confirmed.** `system` tools always show the card — no setting or `allow` rule skips it. A new
  file is shown whole; a replacement as a diff (lines removed and added), so a dropped tool cannot slip by.
- **Creating and replacing are different acts.** Writing to an existing file without `replace: true` is refused
  before the user is asked (and by the server), with what to do instead. The skill tells the agent that a new tool
  always goes in a new file.
- **Writes stay in the capability folder**: `.js`, `.mjs`, `.json`, `.md` only; JSON must parse; 256 KB at most;
  never a delete. A tool module without `export default`, or with `run(args, host)`, is refused with the fix.
- **Reads skip what must not leave the machine**: hidden files and folders (`.git`, `.env`…), dependencies and
  build output, keys and certificates, relay configs, databases; text only, 2 MB at most.
- **Only this computer, only the app's pages**: loopback connections, not proxied; a loopback `Host` header (no DNS
  rebinding); the `X-Requested-With: ai-agent-drawer` header; the page's own origin, or an origin you passed with
  `--origin` (CORS for that origin only). The server listens on loopback addresses only.
- **Nothing runs unseen**: the module the agent wrote runs in the page only after the user approved its content, and
  only in development.
- **The developer reviews and commits**: the workspace logs every write; `git diff` shows them; `validate.mjs`
  checks the folder.

## Tips

- Smaller local models (7–9B) manage it with the skill's recipe, but not every time: read the diff before you
  approve. A larger model, or `Max reply tokens` of 8k or more for models that think first, helps.
- The workspace tools add about 1,500 tokens of definitions; Settings > Context shows the size. They exist only while
  the workspace answers.
- Add a unit test for the new tool afterwards, as for the app's other tools.
