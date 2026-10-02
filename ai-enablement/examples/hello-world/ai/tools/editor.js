// Hello World — the "editor" toolset: how the editor shows the text (not the text itself). The tool drives the
// editor's real controls with setControlValue, so the app's own input/change handlers run exactly as if the user had
// moved the slider. The tool's input contract is written as JSON Schema (`inputSchema`, as in MCP) to show that form;
// the other modules use the shorter `parameters`.

import { setControlValue } from '../../../../assets/ai-agent/ai-agent.js';
import { EDITOR_SETTINGS } from '../../content.js';

export default {
  name: 'editor',
  title: 'Editor',
  description: 'The editor\'s view settings.',
  tools: [
    {
      name: 'set_editor_settings',
      title: 'Editor settings',
      effect: 'write',
      description: 'Change the editor\'s font size (11-24 px) and line wrapping. Only the view changes, not the document.',
      inputSchema: {
        type: 'object',
        properties: {
          fontSize: { type: 'integer', minimum: EDITOR_SETTINGS.fontSize.min, maximum: EDITOR_SETTINGS.fontSize.max, description: 'Font size in px, 11-24.' },
          wrap: { type: 'boolean', description: 'Wrap long lines.' },
        },
      },
      run: ({ fontSize, wrap }, { host }) => {
        if (fontSize !== undefined) setControlValue(host.controls.fontSize, fontSize);
        if (wrap !== undefined) setControlValue(host.controls.wrap, wrap);
        return `Font size ${host.controls.fontSize.value} px, wrapping ${host.controls.wrap.checked ? 'on' : 'off'}.`;
      },
    },
  ],
};
