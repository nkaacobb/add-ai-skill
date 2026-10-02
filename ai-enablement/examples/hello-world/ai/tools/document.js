// Hello World — the "document" toolset: finding, reading and editing the text. Each tool calls a function the editor
// already has (app.js), reached through `host` — the editor object ai-agent-setup.js passes as createAiAgent({ host }).
// None re-implements editor logic.
//
// effect: 'read' runs without asking · 'write' asks first (unless the user turned that off, or allowed it for the chat).

export default {
  name: 'document',
  title: 'Document',
  description: 'Find, read and edit the text of the document.',
  tools: [
    {
      name: 'find_text',
      title: 'Find text',
      effect: 'read',
      description: 'Find every place a word or phrase occurs in the document. Returns line, column and the line\'s text.',
      parameters: {
        query: { type: 'string', required: true, maxLength: 200, description: 'The text to look for.' },
        matchCase: { type: 'boolean', description: 'Only exact-case matches (default false).' },
      },
      run: ({ query, matchCase }, { host }) => {
        const found = host.findText(query, { matchCase });
        return found.length ? { count: found.length, occurrences: found } : `"${query}" does not occur in the document.`;
      },
    },
    {
      name: 'get_selection',
      title: 'Read the selection',
      effect: 'read',
      description: 'The text the user has selected, and where the cursor is.',
      run: (args, { host }) => {
        const s = host.selection();
        return s.text ? s : `Nothing is selected; the cursor is at line ${s.line}, column ${s.col}.`;
      },
    },
    {
      name: 'insert_text',
      title: 'Insert text',
      effect: 'write',
      description: 'Insert text at the cursor (replacing the selection), or at the start or end of the document. The user can undo it with Ctrl+Z.',
      parameters: {
        text: { type: 'string', required: true, maxLength: 20000, description: 'The text to insert.' },
        where: { type: 'enum', values: ['cursor', 'start', 'end'], description: 'Where to insert (default: cursor).' },
      },
      run: ({ text, where = 'cursor' }, { host }) => { host.insertText(text, where); return `Inserted ${text.length} characters at the ${where}.`; },
    },
    {
      name: 'replace_text',
      title: 'Find and replace',
      effect: 'write',
      description: 'Replace a word or phrase everywhere in the document (or only its first occurrence). The user can undo it with Ctrl+Z.',
      parameters: {
        find: { type: 'string', required: true, maxLength: 500 },
        replace: { type: 'string', required: true, maxLength: 5000 },
        all: { type: 'boolean', description: 'Replace every occurrence (default true).' },
        matchCase: { type: 'boolean', description: 'Only exact-case matches (default false).' },
      },
      run: ({ find, replace, all = true, matchCase = false }, { host }) => {
        const n = host.replaceText(find, replace, { all, matchCase });
        return n ? `Replaced ${n} occurrence${n === 1 ? '' : 's'} of "${find}".` : `"${find}" was not found; nothing changed.`;
      },
    },
  ],
};
