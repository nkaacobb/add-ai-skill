// Hello World — the whole AI integration, in one module. This is the reference integration: read it before
// integrating the agent into another app.
//
// app.js (the editor) loads this file with import() and keeps working if it fails. Everything the agent knows comes
// from four hooks, fed by the pure builders in content.js:
//   app      what Hello World is and can do                        (setApp / `app` option)
//   page     which view is open and what it is for                 (setPage / `page` option)
//   content  the document on screen — fingerprinted for sync      (page.content)
//   view     cursor, selection, save state, editor settings — sent, not hashed (page.view)
// …plus one change signal: agent.contextChanged() whenever the document changes.
//
// What the AI can do lives in the capability folder, ai/ (AI Enablement), named by ai/index.json:
//   ai/tools/*.js         three toolsets over the editor's own functions (document, editor, file), reached through
//                         `host` — the editor object passed below
//   ai/skills/*/SKILL.md  proofreading and summarizing, in the Agent Skills format (the agent loads one when needed)
//   ai/agents/*.md        the Writing agent (everything) and the Proofreader (document tools, the proofreading skill)
//   ai/ai-tools.json      which tools start on · ai/ai-memory.json what the agent knows from the start
// This module only mounts the agent and feeds it what is on screen.
//
// Memory, vision and attachments come with the runtime: screenshots use the browser's screen capture here (an app that
// draws on a canvas passes a `screenshot` hook instead); the + button attaches images and files with no code here.
// `workspace: true` lets the agent add tools to ai/ itself while the skill's dev server serves the app
// (scripts/workspace.mjs); without that server it does nothing.

import { createAiAgent, DEFAULT_SYSTEM_PROMPT, parseBlockValues, setControlValue } from '../../assets/ai-agent/ai-agent.js';
import { editorContent, editorView, EDITOR_SETTINGS } from './content.js';

/** The model was asked for ```editor-settings; small models often answer ```json instead — accepted when every key
 *  is a known setting. Values are clamped to the real controls' ranges. */
const readSettings = (block) => parseBlockValues(block, { tags: 'editor-settings', schema: EDITOR_SETTINGS });

/** @param {ReturnType<import('./app.js').createEditorApp>} app */
export function mountAgent(app) {
  const agent = createAiAgent({
    appId: 'hello-world',
    title: 'Writing agent',
    toggle: '#aiToggle',
    push: '#app',
    defaults: {
      provider: 'lmstudio',
      relayUrl: '/ai-relay', // used if you switch Settings > Model > Advanced to "through the relay"
    },
    // relayProbe: true,    // pick the relay automatically when it answers (see references/providers.md)

    // What the AI can do: tools, skills, agents, permissions, the tool defaults and the starting memories.
    capabilities: 'ai/index.json',
    host: app,             // the tools call the editor through this: run(args, { host })
    workspace: true,       // development: the agent may add tools while scripts/workspace.mjs serves this app

    // What this application is. Goes into the system prompt on every request. Keep it short: titles and lists.
    app: {
      name: 'Hello World',
      purpose: 'A minimal plain-text editor. It is also the reference implementation of AI Enablement (the agent drawer).',
      capabilities: [
        'Type or paste text into one document',
        'Open a text file from disk (button or drag and drop) and save the document as a file',
        'Apply the agent\'s suggestions with the "Insert at cursor" and "Replace document" buttons on its code blocks',
        'Change the editor font size (11-24 px) and line wrapping, also from the agent\'s "Apply editor settings" button',
        'The agent can edit through its tools (find, insert, replace, editor settings…): the user confirms each change',
        'Two agents to pick from at the top of the panel: the Writing agent and the Proofreader',
        'The user can give the agent an image or a file (PDF, Word, Excel, text…) with a question: the + button beside the message field',
      ],
      limits: [
        'The agent only uses the tools that are turned on (Settings > Tools); changes need the user\'s confirmation',
        'Plain text only: no formatting, images, or multiple documents',
      ],
    },

    // The page. This app has one view, so it is set once; a routed app calls agent.setPage() on navigation.
    page: {
      id: 'editor',
      title: 'Editor',
      purpose: 'The user writes or loads one plain-text document here. The document is the screen content.',
      content: () => editorContent(app.state()),   // fingerprinted: any change flips the flag to "changed"
      view: () => editorView(app.state()),         // volatile: moving the cursor does not make the page "changed"
    },

    // The rules for every agent of this app; each agent (ai/agents/*.md) adds its own instructions after them.
    systemPrompt: `${DEFAULT_SYSTEM_PROMPT}

You work inside Hello World, a plain-text editor, on the document on screen.
- When the user asks about "this", "the text" or "the document", they mean the document in the page snapshot.
- If there is a selection in the view state and the question is about "this part", work on the selection.
- To change the editor's font size (11-24) or line wrapping, answer with a fenced code block tagged \`editor-settings\` holding JSON, for example {"fontSize": 17, "wrap": false}. The user applies it with a button.`,

    // The agents bring their own welcome and suggestions (ai/agents/*.md); this one shows if none does.
    welcome: '**Hi!** I can read the document in the editor. Ask me anything about it.',

    // Buttons on the agent's code blocks and replies, wired to this app's own abilities.
    codeActions: [
      { id: 'insert', label: 'Insert at cursor', title: 'Insert this block where the cursor is', when: (b) => !readSettings(b), run: (b) => app.insertAtCursor(b.code) },
      { id: 'replace', label: 'Replace document', title: 'Replace the whole document with this block (Ctrl+Z to undo)', when: (b) => !readSettings(b), run: (b) => app.replaceDocument(b.code) },
      {
        id: 'apply-settings',
        label: 'Apply editor settings',
        title: 'Set the font size / line wrapping through the editor\'s own controls',
        when: (b) => !!readSettings(b),
        run: (b) => {
          const { values, adjusted } = readSettings(b);
          // Through the real controls: their input/change handlers (and any validation) run as if the user did it.
          if ('fontSize' in values) setControlValue(app.controls.fontSize, values.fontSize);
          if ('wrap' in values) setControlValue(app.controls.wrap, values.wrap);
          app.toast(`Editor settings applied${adjusted.length ? ` (${adjusted.join(', ')} adjusted to the allowed range)` : ''}`);
        },
      },
    ],
    replyActions: [
      { id: 'insert-reply', label: 'Insert reply at cursor', run: (markdown) => app.insertAtCursor(markdown) },
    ],
  });

  // The change signal: the document changed (typing, opening a file, applying a suggestion).
  app.onChange(() => agent.contextChanged());

  // The status-bar flag: does the agent have what is on screen?
  const $ = (id) => document.getElementById(id);
  const FLAG_TEXT = {
    synced: 'AI has the latest page',
    dirty: 'Page changed — AI re-reads it next message',
    unread: 'AI has not read this page yet',
    none: 'Nothing to share',
    off: 'Screen sharing off',
  };
  agent.onContextStatus((s) => {
    $('aiStatus').dataset.state = s.state;
    $('aiStatusText').textContent = `AI context: ${FLAG_TEXT[s.state] || s.state}`;
    $('aiStatusHash').textContent = s.hash ? s.hash.slice(0, 7) : '';
    $('aiStatus').title = s.hash
      ? `Screen fingerprint ${s.hash.slice(0, 7)} · the AI has ${s.syncedHash ? s.syncedHash.slice(0, 7) : 'nothing yet'}. Click to see exactly what the AI receives.`
      : 'Click to see exactly what the AI receives.';
  });
  $('settingsButton').addEventListener('click', () => agent.openSettings('model'));
  $('aiStatus').addEventListener('click', () => agent.openSettings('context'));
  for (const id of ['aiToggle', 'settingsButton', 'aiStatus']) $(id).hidden = false;   // AI controls appear once the agent is up

  // Handy for experimenting in the browser console (and for scripts/verify.mjs): window.agent.getContextStatus()…
  window.agent = agent;
  return agent;
}
