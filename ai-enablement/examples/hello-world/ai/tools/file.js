// Hello World — the "file" toolset: the document as a file. Renaming changes app state (write); replacing the whole
// document or starting a new one cannot be taken back from the tool's side (destructive: the user always confirms,
// unless they switched that off in Settings > Tools). ai-tools.json starts all three turned off.

export default {
  name: 'file',
  title: 'File',
  description: 'The document as a file: its name, replacing it, starting a new one.',
  tools: [
    {
      name: 'rename_file',
      title: 'Rename the file',
      effect: 'write',
      description: 'Change the document\'s file name (used when it is saved).',
      parameters: { name: { type: 'string', required: true, maxLength: 120, description: 'The new file name, e.g. notes.txt.' } },
      run: ({ name }, { host }) => { host.renameFile(name.trim() || 'untitled.txt'); return `The file is now called ${name.trim() || 'untitled.txt'}.`; },
    },
    {
      name: 'replace_document',
      title: 'Replace the document',
      effect: 'destructive',
      description: 'Replace the whole document with new text (Ctrl+Z still undoes it).',
      parameters: { text: { type: 'string', required: true, maxLength: 200000 } },
      run: ({ text }, { host }) => { host.replaceDocument(text); return `The document now has ${text.length} characters.`; },
    },
    {
      name: 'new_document',
      title: 'New document',
      effect: 'destructive',
      description: 'Start a new, empty document. Unsaved changes to the current one are lost.',
      run: (args, { host }) => { host.newDocument(); return 'Started a new, empty document (untitled.txt).'; },
    },
  ],
};
