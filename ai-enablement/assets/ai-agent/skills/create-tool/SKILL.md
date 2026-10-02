---
name: create-tool
description: Add a new tool to this application from inside it - when the user asks for something none of your tools can do and the application's own code can. Reads the source to find the function, writes a tool module into the capability folder, registers it, reloads and checks it. Only while the development workspace is connected.
license: Part of the AI Enablement runtime
metadata:
  framework: ai-enablement
  version: "1.6.0"
---

# Create a tool for this application

You can give yourself a new tool while a developer is working on this application: you find a function the
application **already has**, write a small tool module that calls it, register it, and load it. The user sees every
file before it is written and confirms it.

Use this skill when the user asks for a tool, or asks for something that none of your tools can do but the
application can (a button, a menu command, a function in its code). Do not use it for a one-off answer you can give
from the screen.

## The recipe (the calls, in order)

1. `describe_host` — what `host` offers. A tool reaches the application only through it.
2. `write_ai_file` — a **new** file `<capability folder>/tools/<tool name>.js` in the format below.
3. `read_source_file` on `<capability folder>/index.json`, then `write_ai_file` it back whole with `replace: true`
   and `"tools/<tool name>.js"` added to its `"tools"` list.
4. `reload_capabilities` — fix and repeat if it reports a problem.
5. A reading tool: call it once (ask for it with `request_tool` if it is off) and check the result.

## The tool module

```js
// <capability folder>/tools/file_status.js
export default {
  name: 'file_status',                   // letters, digits, _ or -; starts with a letter; unique
  title: 'File status',                  // shown to the user
  description: 'The file name, and whether the document has unsaved changes.',
  effect: 'read',                        // read | write | destructive | external | system — when unsure, the stronger
  parameters: {},                        // e.g. { section: { type: 'integer', min: 1, max: 500, description: '…' } }
  run: (args, { host }) => {             // the second argument is an object: take host from it
    const s = host.state();              // only what describe_host listed
    return { fileName: s.fileName, unsaved: s.dirty };
  },
};
```

- **Parameter types**: `string` (give long text an explicit `maxLength`; the default limit is 500), `number` /
  `integer` (`min`, `max`, `step`), `boolean`, `enum` (`values: [...]`), `array` (`items`, `maxItems`). Each can have
  `required: true`, `description`, `default`.
- **Effects**: `read` looks something up · `write` changes the application (undoable) · `destructive` deletes or
  overwrites · `external` sends or publishes outside the application · `system` changes the application itself.
  Only `read` tools run without the user's confirmation.
- **Results**: return a short string or a small object (counts, ids, the new value). Throw an `Error` with a clear
  message when it cannot work.
- `run` may be `async`; it gets `{ host, agent, signal }`.

## Steps, in more detail

1. **Say what you will build** in one or two sentences: the tool's name, what it does, which `host` function it
   calls, and whether it changes anything. Wait for the user to agree if it changes anything.
2. **Find the function** with `describe_host`. If it is not obvious what a function returns, `search_source` for its
   name and `read_source_file` to read it (a getter such as `state()` may hold the value you need). Use the exact
   names it lists; never invent one.
3. **Copy the style** of one existing tool module (`read_source_file`), but write your own **new** file.
4. **Register** the module in the index (recipe step 3). To have the tool on from the start, also write the tool
   config the index names (`"toolsConfig"`) back with `replace: true` and the tool added **under its own name**:
   `"file_status": { "enabled": true }`. Otherwise it starts turned off.
5. **Reload and check** (recipe steps 4–5). A tool that changes something: tell the user it is ready; do not run it
   unasked.
6. **Report**: the files written, what the tool does, whether it is on, and that the developer should commit the
   change (and add a unit test, as for the application's other tools).

## Common mistakes

- `run: function (args, host)` — wrong: the second argument is an object. Write `run: (args, { host }) => …`.
- `export function run(…)` — wrong: the module exports the whole tool as its default (`export default { … }`).
- `host.editor.fileName` when `describe_host` listed no `editor` — use only what it lists.
- Rewriting an existing tool module — it holds other tools. A new tool always goes in a new file.
- Changing a file with the application's own tools (`insert_text`, `replace_text`…) — they edit what the user has on
  screen, not files. Files change only with `write_ai_file`, written whole.
- Keying the tool config by the toolset's or file's name — key it by the **tool's** name.
- Forgetting to add the module to the index — `reload_capabilities` says so; add it.

## Rules

- Wrap a function the application already has. Never re-implement its logic, never add a feature the application
  does not offer the user, never call a server the application does not already call.
- Write only inside the capability folder; never edit the application's other code (tell the user what to change
  instead, if something is missing). Never delete files.
- Keep the index valid JSON and keep every entry that was there.
- No secrets, keys or personal data in tool files.
- If the function you need does not exist, say so and stop: a tool cannot make up what the application cannot do.
