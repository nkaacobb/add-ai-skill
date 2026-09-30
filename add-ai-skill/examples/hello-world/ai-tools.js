// Hello World — the tools the agent can call. Each one wraps a function the editor already has (app.js); none
// reimplements editor logic. The catalog is complete: which tools are turned on is decided by ai-tools.json (the
// app's defaults) and by each user in Settings > Tools.
//
// effect: 'read' runs without asking · 'write' asks first (unless the user turned that off, or allowed it for the
// chat) · 'destructive' always asks (unless switched off in Settings > Tools).

import { setControlValue } from '../../assets/ai-agent/ai-agent.js';
import { EDITOR_SETTINGS } from './content.js';

/** @param {ReturnType<import('./app.js').createEditorApp>} app */
export function editorTools(app) {
  return [
    {
      name: 'find_text',
      title: 'Find text',
      group: 'Document',
      effect: 'read',
      description: 'Find every place a word or phrase occurs in the document. Returns line, column and the line\'s text.',
      parameters: {
        query: { type: 'string', required: true, maxLength: 200, description: 'The text to look for.' },
        matchCase: { type: 'boolean', description: 'Only exact-case matches (default false).' },
      },
      run: ({ query, matchCase }) => {
        const found = app.findText(query, { matchCase });
        return found.length ? { count: found.length, occurrences: found } : `"${query}" does not occur in the document.`;
      },
    },
    {
      name: 'get_selection',
      title: 'Read the selection',
      group: 'Document',
      effect: 'read',
      description: 'The text the user has selected, and where the cursor is.',
      run: () => {
        const s = app.selection();
        return s.text ? s : `Nothing is selected; the cursor is at line ${s.line}, column ${s.col}.`;
      },
    },
    {
      name: 'insert_text',
      title: 'Insert text',
      group: 'Document',
      effect: 'write',
      description: 'Insert text at the cursor (replacing the selection), or at the start or end of the document. The user can undo it with Ctrl+Z.',
      parameters: {
        text: { type: 'string', required: true, maxLength: 20000, description: 'The text to insert.' },
        where: { type: 'enum', values: ['cursor', 'start', 'end'], description: 'Where to insert (default: cursor).' },
      },
      run: ({ text, where = 'cursor' }) => { app.insertText(text, where); return `Inserted ${text.length} characters at the ${where}.`; },
    },
    {
      name: 'replace_text',
      title: 'Find and replace',
      group: 'Document',
      effect: 'write',
      description: 'Replace a word or phrase everywhere in the document (or only its first occurrence). The user can undo it with Ctrl+Z.',
      parameters: {
        find: { type: 'string', required: true, maxLength: 500 },
        replace: { type: 'string', required: true, maxLength: 5000 },
        all: { type: 'boolean', description: 'Replace every occurrence (default true).' },
        matchCase: { type: 'boolean', description: 'Only exact-case matches (default false).' },
      },
      run: ({ find, replace, all = true, matchCase = false }) => {
        const n = app.replaceText(find, replace, { all, matchCase });
        return n ? `Replaced ${n} occurrence${n === 1 ? '' : 's'} of "${find}".` : `"${find}" was not found; nothing changed.`;
      },
    },
    {
      name: 'set_editor_settings',
      title: 'Editor settings',
      group: 'Editor',
      effect: 'write',
      description: 'Change the editor\'s font size (11-24 px) and line wrapping. Only the view changes, not the document.',
      parameters: {
        fontSize: { ...EDITOR_SETTINGS.fontSize, description: 'Font size in px, 11-24.' },
        wrap: { ...EDITOR_SETTINGS.wrap, description: 'Wrap long lines.' },
      },
      // Through the real controls: the app's own handlers run exactly as if the user moved the slider.
      run: ({ fontSize, wrap }) => {
        if (fontSize !== undefined) setControlValue(app.controls.fontSize, fontSize);
        if (wrap !== undefined) setControlValue(app.controls.wrap, wrap);
        return `Font size ${app.controls.fontSize.value} px, wrapping ${app.controls.wrap.checked ? 'on' : 'off'}.`;
      },
    },
    {
      name: 'rename_file',
      title: 'Rename the file',
      group: 'File',
      effect: 'write',
      description: 'Change the document\'s file name (used when it is saved).',
      parameters: { name: { type: 'string', required: true, maxLength: 120, description: 'The new file name, e.g. notes.txt.' } },
      run: ({ name }) => { app.renameFile(name.trim() || 'untitled.txt'); return `The file is now called ${name.trim() || 'untitled.txt'}.`; },
    },
    {
      name: 'replace_document',
      title: 'Replace the document',
      group: 'File',
      effect: 'destructive',
      description: 'Replace the whole document with new text (Ctrl+Z still undoes it).',
      parameters: { text: { type: 'string', required: true, maxLength: 200000 } },
      run: ({ text }) => { app.replaceDocument(text); return `The document now has ${text.length} characters.`; },
    },
    {
      name: 'new_document',
      title: 'New document',
      group: 'File',
      effect: 'destructive',
      description: 'Start a new, empty document. Unsaved changes to the current one are lost.',
      run: () => { app.newDocument(); return 'Started a new, empty document (untitled.txt).'; },
    },
  ];
}
