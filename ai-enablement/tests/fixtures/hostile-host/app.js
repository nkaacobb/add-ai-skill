// The hostile host's integration: enough tools, memories and screen content that every settings tab overflows its
// body (so the tab strip, the header and the footer have to hold their own), on a page whose global CSS styles bare
// elements (hostile.css). The same setup is used by tests/browser.test.mjs through `mountHostileAgent`.

import { createAiAgent } from '../../../assets/ai-agent/ai-agent.js';

const $ = (id) => document.getElementById(id);

/** Tools over the page's own controls: readers without arguments (verify.mjs runs those) and writers with ranges. */
export function hostileTools() {
  const tools = [
    { name: 'read_coil', title: 'Read the coil', description: 'The coil settings as shown: turns, current, material.', effect: 'read', enabled: true,
      run: () => `Turns ${$('turns')?.value ?? '?'}, current ${$('current')?.value ?? '?'} A, material ${$('material')?.value ?? '?'}` },
    { name: 'field_lines_shown', title: 'Field lines shown?', description: 'Whether the field lines are drawn.', effect: 'read', enabled: true, run: () => String(!!$('showField')?.checked) },
    { name: 'set_turns', title: 'Set turns', description: 'Change the number of turns of the coil.', effect: 'write', parameters: { turns: { type: 'integer', min: 1, max: 500, required: true } }, run: ({ turns }) => { $('turns').value = turns; return `Turns: ${turns}`; } },
    { name: 'set_current', title: 'Set current', description: 'Change the coil current in amperes.', effect: 'write', parameters: { amps: { type: 'number', min: -10, max: 10, required: true } }, run: ({ amps }) => { $('current').value = amps; return `Current: ${amps} A`; } },
    { name: 'reset_lab', title: 'Reset the lab', description: 'Put every control back to its starting value.', effect: 'destructive', run: () => 'reset' },
  ];
  // Many more, so Settings > Tools is far taller than the dialog.
  for (let i = 1; i <= 24; i++) {
    tools.push({
      name: `probe_${i}`, title: `Probe ${i}`, group: i % 2 ? 'Measurements' : 'Experiments', effect: i % 3 ? 'read' : 'write', enabled: i % 4 !== 0,
      description: `Measure the field at probe point ${i} and report its strength and direction, rounded the way the lab shows it.`,
      parameters: i % 3 ? {} : { point: { type: 'integer', min: 1, max: 24 } },
      run: () => `Probe ${i}: ${(i * 0.37).toFixed(2)} mT`,
    });
  }
  return tools;
}

/** Thirty starting memories (Settings > Memory overflows). */
export function hostileMemories() {
  return {
    version: 1,
    memories: Array.from({ length: 30 }, (_, i) => ({
      id: `m${i + 1}`, source: 'app', created: '2026-10-01T00:00:00.000Z',
      text: `Lab note ${i + 1}: the students use SI units; field strengths are shown in millitesla with two decimals.`,
    })),
  };
}

/** A long screen snapshot (Settings > Context overflows). */
export function hostileContent() {
  const rows = Array.from({ length: 160 }, (_, i) => `Probe ${i + 1}: ${(i * 0.37).toFixed(2)} mT at ${(i * 2.5).toFixed(1)} cm`);
  return `Coil: ${$('turns')?.value ?? 120} turns, ${$('current')?.value ?? 2.5} A\n${rows.join('\n')}`;
}

/** A small picture of the view, so the vision check does not need the browser's screen capture. */
function screenshot() {
  const c = document.createElement('canvas');
  c.width = 320;
  c.height = 200;
  const g = c.getContext('2d');
  g.fillStyle = '#123';
  g.fillRect(0, 0, 320, 200);
  g.strokeStyle = '#7af0ff';
  for (let r = 20; r < 200; r += 20) { g.beginPath(); g.arc(160, 100, r, 0, Math.PI * 2); g.stroke(); }
  return c;
}

export function mountHostileAgent(extra = {}) {
  const agent = createAiAgent({
    appId: 'hostile-host',
    title: 'Lab assistant',
    toggle: '#ask',
    push: '#app',
    app: { name: 'Field lab', purpose: 'A teaching lab for electromagnetic fields.', capabilities: ['Coil settings', 'Probe measurements'], limits: ['No real hardware'] },
    page: { id: 'coil', title: 'Coil', purpose: 'Set up the coil and read the probes.', content: hostileContent, view: () => ({ showField: !!$('showField')?.checked }) },
    tools: hostileTools(),
    memoryFile: hostileMemories(),
    screenshot,
    defaults: { provider: 'lmstudio' },
    ...extra,
  });
  for (const id of ['turns', 'current', 'showField', 'material']) $(id)?.addEventListener('input', () => agent.contextChanged());
  return agent;
}

if (document.getElementById('app') && !globalThis.AIA_NO_AUTOMOUNT) window.agent = mountHostileAgent();
