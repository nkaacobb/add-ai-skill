// Runtime behaviour that only a real browser can show: keyboard isolation from host shortcuts, native modal
// dialogs, the push-layout warning, theme overrides, resume, form controls, the relay probe, the context size, the
// tool loop, tool rows (a cut-off call rolled down and copied), memory, screenshots (an app hook with a WebGL
// canvas, and the browser's own screen capture), attachments (the + menu, drag and drop, paste, a browser-made PDF),
// and the settings dialog's layout under a hostile host stylesheet (tests/fixtures/hostile-host/hostile.css).
// Runs headless Edge/Chrome/Chromium over the DevTools protocol (scripts/lib/cdp.mjs, Node 22+). Skipped when no
// browser is installed; set AIA_BROWSER to a browser executable to choose one, or AIA_SKIP_BROWSER=1 to skip.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, serveStatic, findBrowser, sleep } from '../scripts/lib/cdp.mjs';
import { checkSettingsLayout, SETTINGS_SIZES } from '../scripts/lib/settings-layout.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.env.AIA_SKIP_BROWSER ? 'AIA_SKIP_BROWSER is set'
  : typeof WebSocket !== 'function' ? 'needs Node 22+ (global WebSocket)'
    : !findBrowser() ? 'no Edge/Chrome/Chromium found (set AIA_BROWSER)' : false;

let browser;
let server;
let page;

before(async () => {
  if (skip) return;
  server = await serveStatic(ROOT);
  // --auto-accept-this-tab-capture: the "share this tab" prompt of the screen-capture test is accepted without a person.
  browser = await launchBrowser({ width: 1366, height: 900, args: ['--auto-accept-this-tab-capture'] });
  page = browser.page;
});

after(async () => {
  await browser?.close();
  await server?.close();
});

/** A fresh harness page (storage cleared) with the runtime module loaded as window.M. */
async function fresh({ width = 1366 } = {}) {
  await page.viewport(width, 900);
  await page.goto(`${server.url}/tests/browser/harness.html`);
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    window.M = await import('/assets/ai-agent/ai-agent.js');
  });
  page.console.length = 0;
}

/* ------------------------------------------------------------------------------ keyboard isolation */

test('typing in the drawer never reaches host shortcut handlers (Space = play, letters)', { skip, timeout: 60000 }, async () => {
  for (const isolateKeys of [true, false]) {
    await fresh();
    await page.evaluate((iso) => {
      window.hostHits = 0;
      // A typical host handler: exempts INPUT/SELECT/BUTTON only, so a TEXTAREA looks like "not typing".
      window.addEventListener('keydown', (e) => {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON') return;
        if (e.key === ' ' || e.key === 'k') { e.preventDefault(); window.hostHits++; }
      });
      window.agent = M.createAiAgent({ appId: `keys-${iso}`, isolateKeys: iso, launcher: false, devWarnings: false });
      agent.open();
      document.querySelector('.aia-composer textarea').focus();
    }, isolateKeys);
    await page.type('a k');
    const r = await page.evaluate(() => ({ value: document.querySelector('.aia-composer textarea').value, hits: window.hostHits }));
    if (isolateKeys) {
      assert.deepEqual(r, { value: 'a k', hits: 0 }, 'with isolation (default) every keystroke lands in the composer');
    } else {
      assert.equal(r.hits, 2, 'without isolation the host handler swallows Space and k (the 1.0 problem this test detects)');
      assert.equal(r.value, 'a');
    }
  }

  // The runtime's own keys still work from inside the drawer: Ctrl+I closes it, Escape closes it.
  await fresh();
  await page.evaluate(() => { window.agent = M.createAiAgent({ appId: 'keys-own', launcher: false, devWarnings: false }); agent.open(); document.querySelector('.aia-composer textarea').focus(); });
  await page.press('i', { ctrl: true });
  assert.equal(await page.evaluate(() => agent.isOpen()), false, 'the hotkey toggles from inside the drawer');
  await page.evaluate(() => { agent.open(); document.querySelector('.aia-composer textarea').focus(); });
  await page.press('Escape');
  assert.equal(await page.evaluate(() => agent.isOpen()), false, 'Escape closes the drawer');

  // App shortcuts with Ctrl/Cmd still reach the host.
  await page.evaluate(() => {
    window.saved = 0;
    document.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key === 's') { e.preventDefault(); window.saved++; } });
    agent.open();
    document.querySelector('.aia-composer textarea').focus();
  });
  await page.press('s', { ctrl: true });
  assert.equal(await page.evaluate(() => window.saved), 1, 'Ctrl+S reaches the host from the drawer');

  // The settings modal (system prompt textarea) is isolated too.
  await page.evaluate(() => {
    window.hostHits = 0;
    window.addEventListener('keydown', (e) => { if (e.key === ' ' && e.target.tagName !== 'INPUT') { e.preventDefault(); window.hostHits++; } });
    agent.openSettings('agent');
    const ta = document.querySelector('.aia-modal textarea');
    ta.value = 'Prompt';
    ta.focus();
    ta.setSelectionRange(6, 6);
  });
  await page.type(' ok');
  assert.deepEqual(await page.evaluate(() => ({ v: document.querySelector('.aia-modal textarea').value, hits: window.hostHits })), { v: 'Prompt ok', hits: 0 });
});

/* ---------------------------------------------------------------------------------- modal dialogs */

test('dialogs: \'dock\' keeps the drawer usable over a native modal dialog without firing host close handlers', { skip, timeout: 60000 }, async () => {
  await fresh({ width: 1366 });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<dialog id="video"><p>Player</p><input id="dlgInput"></dialog>');
    window.hostEvents = [];
    const d = document.getElementById('video');
    for (const t of ['close', 'toggle', 'beforetoggle']) d.addEventListener(t, (e) => hostEvents.push(`${t}${e.newState ? `:${e.newState}` : ''}`));
    window.agent = M.createAiAgent({ appId: 'dlg', dialogs: 'dock', launcher: false, devWarnings: false });
    d.showModal();
  });
  await sleep(300);                             // let the host's own (late) open toggle event arrive
  await page.evaluate(() => { hostEvents.length = 0; });
  assert.equal(await page.evaluate(() => document.getElementById('video').matches(':modal')), true);

  await page.press('i', { ctrl: true });       // the hotkey, pressed while the modal is open
  await sleep(400);                             // the late close/toggle events arrive after other tasks
  const docked = await page.evaluate(() => {
    const d = document.getElementById('video');
    const ta = document.querySelector('.aia-composer textarea');
    ta.focus();
    const dr = d.getBoundingClientRect();
    const drawerLeft = document.querySelector('.aia-drawer').getBoundingClientRect().left;
    return { open: agent.isOpen(), modal: d.matches(':modal'), dialogOpen: d.open, cls: d.classList.contains('aia-docked-dialog'), composerFocused: document.activeElement === ta, events: [...hostEvents], leftOfDrawer: dr.right <= drawerLeft + 1, visible: dr.width > 0 };
  });
  assert.deepEqual(docked, { open: true, modal: false, dialogOpen: true, cls: true, composerFocused: true, events: [], leftOfDrawer: true, visible: true });

  await page.type('hi');
  assert.equal(await page.evaluate(() => document.querySelector('.aia-composer textarea').value), 'hi', 'the drawer takes input');

  await page.evaluate(() => agent.close());
  await sleep(400);
  assert.deepEqual(await page.evaluate(() => { const d = document.getElementById('video'); return { modal: d.matches(':modal'), cls: d.classList.contains('aia-docked-dialog'), events: [...hostEvents] }; }),
    { modal: true, cls: false, events: [] }, 'modal again when the drawer closes; the host saw no close');

  // While the drawer is open, showModal() opens non-modally; a real close still reaches the host.
  await page.evaluate(() => { document.getElementById('video').close(); agent.open(); });
  await sleep(300);
  await page.evaluate(() => { hostEvents.length = 0; document.getElementById('video').showModal(); });
  await sleep(300);
  assert.equal(await page.evaluate(() => document.getElementById('video').matches(':modal')), false);
  await page.evaluate(() => document.getElementById('video').close());
  await sleep(300);
  assert.ok((await page.evaluate(() => hostEvents)).includes('close'), 'a genuine close is delivered');

  // Without the option: the drawer is inert behind the modal, and a dev warning says what to do.
  await fresh();
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<dialog id="d2">x</dialog>');
    window.agent = M.createAiAgent({ appId: 'dlg-off', launcher: false, devWarnings: true });
    document.getElementById('d2').showModal();
    agent.open();
  });
  await sleep(100);
  assert.ok(page.console.some((c) => c.level === 'warning' && /modal <dialog> is open/.test(c.text)), 'dev warning about the inert drawer');
});

/* ------------------------------------------------------------------------------ push layout check */

test('push: a shell that cannot shrink beside the drawer triggers a dev warning (opt-out), and the recipe fixes it', { skip, timeout: 60000 }, async () => {
  const setup = (devWarnings, fixed) => {
    document.body.style.margin = '0';
    document.body.insertAdjacentHTML('beforeend', `
      <style>
        .shell { display: grid; grid-template-columns: 280px 1fr 320px; grid-template-rows: 56px 1fr; min-height: 100vh; }
        .shell > header { grid-column: 1 / -1; display: flex; gap: 8px; white-space: nowrap; }
        .shell > header button { flex: 0 0 auto; width: 110px; }
        ${fixed ? `
        html.aia-drawer-open .shell { grid-template-columns: minmax(0, 280px) minmax(0, 1fr) minmax(0, 320px); grid-template-rows: minmax(56px, auto) 1fr; }
        html.aia-drawer-open .shell > header { flex-wrap: wrap; }` : ''}
      </style>
      <div class="shell"><header>${Array.from({ length: 9 }, (_, i) => `<button>Tool ${i}</button>`).join('')}<button id="ask">Ask AI</button></header><aside>side</aside><main>main</main><aside>panel</aside></div>`);
    window.agent = M.createAiAgent({ appId: `push-${devWarnings}-${fixed}`, toggle: '#ask', push: '.shell', devWarnings });
    agent.open();
  };
  for (const width of [1280, 1366, 1600]) {
    await fresh({ width });
    await page.evaluate(setup, true, false);
    await sleep(700);
    const warned = page.console.filter((c) => c.level === 'warning' && /does not fit beside the open drawer/.test(c.text));
    assert.equal(warned.length, 1, `warning at ${width}px`);
    assert.match(warned[0].text, /Ask AI|#ask|button/, 'names the hidden elements');

    await fresh({ width });
    await page.evaluate(setup, true, true);
    await sleep(700);
    assert.equal(page.console.filter((c) => /does not fit/.test(c.text)).length, 0, `the documented recipe fits at ${width}px`);
    const toggleVisible = await page.evaluate(() => document.getElementById('ask').getBoundingClientRect().right <= document.querySelector('.aia-drawer').getBoundingClientRect().left + 1);
    assert.equal(toggleVisible, true, 'the toggle stays left of the drawer');
  }
  await fresh({ width: 1280 });
  await page.evaluate(setup, false, false);
  await sleep(700);
  assert.equal(page.console.filter((c) => /does not fit/.test(c.text)).length, 0, 'devWarnings: false silences it');
});

/* ---------------------------------------------------------------------------------------- theming */

test('theming: a host .aia-scope override wins in dark mode too, whatever the load order; badge variables apply', { skip, timeout: 60000 }, async () => {
  await fresh();
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  try {
    const r = await page.evaluate(() => {
      const style = document.createElement('style');
      style.textContent = '.aia-scope { --aia-accent: rgb(1, 2, 3); } :root { --aia-badge-ring: rgb(9, 9, 9); --aia-badge-synced: rgb(0, 100, 0); }';
      document.head.prepend(style);        // worst case: the host rule is loaded BEFORE ai-agent.css
      document.body.insertAdjacentHTML('beforeend', '<button id="t1">Ask</button>');
      const auto = M.createAiAgent({ appId: 'theme-auto', toggle: '#t1', devWarnings: false });
      const forced = M.createAiAgent({ appId: 'theme-dark', theme: 'dark', launcher: false, devWarnings: false });
      const drawers = document.querySelectorAll('.aia-drawer');
      const t = document.getElementById('t1');
      t.setAttribute('data-aia-context', 'synced');
      const after = getComputedStyle(t, '::after');
      const out = {
        autoAccent: getComputedStyle(drawers[0]).getPropertyValue('--aia-accent').trim(),
        forcedAccent: getComputedStyle(drawers[1]).getPropertyValue('--aia-accent').trim(),
        darkBg: getComputedStyle(drawers[0]).getPropertyValue('--aia-bg').trim(),
        ring: after.boxShadow,
        dot: after.backgroundColor,
      };
      auto.destroy();
      forced.destroy();
      return out;
    });
    assert.equal(r.autoAccent, 'rgb(1, 2, 3)', 'OS dark mode');
    assert.equal(r.forcedAccent, 'rgb(1, 2, 3)', 'theme: dark');
    assert.equal(r.darkBg, '#0f1621', 'the rest of the dark theme still applies');
    assert.match(r.ring, /rgb\(9, 9, 9\)/);
    assert.equal(r.dot, 'rgb(0, 100, 0)');
  } finally {
    await page.send('Emulation.setEmulatedMedia', { features: [] });
  }
});

/* ------------------------------------------------------------------------------ resume + open event */

test('resume: an agent reopened during createAiAgent replays "open" to listeners registered right after', { skip, timeout: 60000 }, async () => {
  await fresh();
  const r = await page.evaluate(async () => {
    sessionStorage.setItem('resume-test.ai.session', JSON.stringify({ open: true }));
    const agent = M.createAiAgent({ appId: 'resume-test', launcher: false, devWarnings: false });
    const openedDuringCreate = agent.isOpen();
    const seen = [];
    agent.on('open', (d) => seen.push(d));      // registered after createAiAgent returned
    await new Promise((res) => setTimeout(res, 50));
    return { openedDuringCreate, seen };
  });
  assert.equal(r.openedDuringCreate, true);
  assert.deepEqual(r.seen, [{ resumed: true }]);
});

/* --------------------------------------------------------------------------------- setControlValue */

test('setControlValue: clamps to the control, fires input + change, flips checkboxes by clicking', { skip, timeout: 60000 }, async () => {
  await fresh();
  const r = await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<input id="r" type="range" min="0" max="10" step="0.5" value="1"><input id="c" type="checkbox"><select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select>');
    const log = [];
    for (const id of ['r', 'c', 's']) for (const t of ['input', 'change']) document.getElementById(id).addEventListener(t, () => log.push(`${id}:${t}`));
    const ok = [M.setControlValue('#r', 42), M.setControlValue('#c', true), M.setControlValue('#s', 'beta'), M.setControlValue('#r', 'abc')];
    return { ok, r: document.getElementById('r').value, c: document.getElementById('c').checked, s: document.getElementById('s').value, log };
  });
  assert.deepEqual(r.ok, [true, true, true, false]);
  assert.equal(r.r, '10');
  assert.equal(r.c, true);
  assert.equal(r.s, 'b');
  for (const e of ['r:input', 'r:change', 'c:input', 'c:change', 's:input', 's:change']) assert.ok(r.log.includes(e), e);
});

/* ------------------------------------------------------------------------------------ relay probe */

test('relayProbe on a static server (relay.php served as source) falls back to direct, with no console errors', { skip, timeout: 60000 }, async () => {
  await fresh();
  const r = await page.evaluate(async () => {
    const agent = M.createAiAgent({ appId: 'probe', launcher: false, devWarnings: false, relayProbe: true, defaults: { relayUrl: '/assets/relay/relay.php', provider: 'ollama' } });
    await agent.ready;
    return { info: agent.relayInfo(), transport: agent.settings.get().transport, provider: agent.settings.get().provider };
  });
  assert.equal(r.info.available, false);
  assert.match(r.info.reason, /not JSON/);
  assert.equal(r.transport, 'direct');
  assert.equal(r.provider, 'ollama', 'the app defaults still apply');
  assert.deepEqual(page.errors(), []);

  // Async defaults: a function (or promise) resolved before the first question.
  const d = await page.evaluate(async () => {
    const agent = M.createAiAgent({ appId: 'async-defaults', launcher: false, devWarnings: false, defaults: async () => ({ provider: 'custom', temperature: 1.5 }) });
    const before = agent.settings.get().provider;
    await agent.ready;
    return { before, after: agent.settings.get().provider, t: agent.settings.get().temperature };
  });
  assert.deepEqual(d, { before: 'lmstudio', after: 'custom', t: 1.5 });
});

/* ------------------------------------------------------------------------------------------ tools */

test('tools: the drawer runs the model\'s tool calls, asks before changes, and offers to turn off tools on', { skip, timeout: 90000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  const upstream = await startFakeUpstream({
    cors: true,
    respond: (body, n) => [
      { toolCalls: [{ id: 'c1', name: 'count_items', arguments: {} }] },
      { text: 'Renaming it now.', toolCalls: [{ id: 'c2', name: 'set_title', arguments: { title: 'Hello tools' } }] },
      { toolCalls: [{ id: 'c3', name: 'request_tool', arguments: { name: 'wipe', reason: 'You asked me to clear the list.' } }] },
      { text: 'All done: 3 items, renamed, and the wipe tool is on now.' },
    ][n - 1] || { text: 'Extra.' },
  });
  try {
    await fresh();
    await page.evaluate((url) => {
      document.body.insertAdjacentHTML('beforeend', '<h1 id="title">Old title</h1>');
      window.agent = M.createAiAgent({
        appId: 'tools-e2e', launcher: false, devWarnings: false, memory: false, screenshots: false,   // the app's tools only
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'fake-model' } } },
        page: { id: 'list', title: 'List', content: () => `Title: ${document.getElementById('title').textContent}\nItems: a, b, c` },
        tools: [
          { name: 'count_items', description: 'Count the items.', effect: 'read', enabled: true, run: () => 3 },
          { name: 'set_title', description: 'Rename the list.', effect: 'write', enabled: true, parameters: { title: { type: 'string', required: true } },
            run: ({ title }) => { document.getElementById('title').textContent = title; return `Renamed to ${title}`; } },
          { name: 'wipe', description: 'Remove every item.', effect: 'destructive', run: () => 'wiped' },
        ],
      });
      window.done = agent.ask('Count, rename to "Hello tools", then clear it.');
    }, upstream.url);

    const card = async (text) => page.waitFor((t) => [...document.querySelectorAll('.aia-tool-card:not([hidden])')].some((c) => c.textContent.includes(t)), { timeoutMs: 15000, args: [text] });
    await card('Run Set title');
    assert.equal(await page.evaluate(() => document.getElementById('title').textContent), 'Old title', 'nothing changes before the user says so');
    await page.evaluate(() => document.querySelector('.aia-tool-card:not([hidden]) [data-decide="run"]').click());
    await card('which is turned off');
    await page.evaluate(() => document.querySelector('.aia-tool-card:not([hidden]) [data-decide="on"]').click());
    await page.evaluate(() => window.done);

    const r = await page.evaluate(() => ({
      title: document.getElementById('title').textContent,
      chips: [...document.querySelectorAll('.aia-drawer .aia-tool')].map((c) => [c.querySelector('.aia-tool-call').textContent, c.dataset.status]),
      rollDown: [...document.querySelectorAll('.aia-drawer .aia-tool .aia-tool-line')].map((l) => !l.disabled),
      answer: [...document.querySelectorAll('.aia-drawer .aia-msg.aia-assistant .aia-md')].pop().textContent,
      wipeOn: agent.settings.get().toolStates.wipe,
      saved: JSON.parse(localStorage.getItem('tools-e2e.ai.chats'))[0].messages.find((m) => m.role === 'assistant').actions.map((a) => [a.call, a.status]),
      flag: agent.getContextStatus().state,
    }));
    assert.equal(r.title, 'Hello tools');
    assert.deepEqual(r.chips, [['count_items()', 'ok'], ['set_title(title: "Hello tools")', 'ok'], ['wipe()', 'ok']]);
    assert.deepEqual(r.rollDown, [true, true, true], 'every finished row rolls down, the "Turn on" one too');
    assert.match(r.answer, /Renaming it now\.[\s\S]*All done/);
    assert.equal(r.wipeOn, true, 'turning a tool on from the chat is saved like the Tools tab');
    assert.deepEqual(r.saved, [['count_items()', 'ok'], ['set_title(title: "Hello tools")', 'ok'], ['turn on wipe', 'ok']]);
    assert.equal(r.flag, 'dirty', 'the tools changed the screen: the next question re-reads it');

    const [first, second, third, fourth] = upstream.chats().map((c) => c.body);
    assert.deepEqual(first.tools.map((t) => t.function.name), ['count_items', 'set_title', 'request_tool'], 'turned-off tools are offered through request_tool only');
    assert.match(first.messages[0].content, /== TOOLS ==[\s\S]*Turned off by the user[\s\S]*wipe/);
    assert.deepEqual(second.messages.filter((m) => m.role === 'tool').map((m) => m.content), ['3']);
    const afterRename = third.messages.filter((m) => m.role === 'tool').pop().content;
    assert.match(afterRename, /^Renamed to Hello tools\n\n\[The screen after these actions\]\n<page_snapshot [^>]*>\nTitle: Hello tools/, 'the model sees the effect of its action');
    assert.deepEqual(fourth.tools.map((t) => t.function.name), ['count_items', 'set_title', 'wipe'], 'once turned on, the tool is offered');

    // Settings > Tools: a checkbox per tool, saved on Save, exported as the app's tool config.
    const tab = await page.evaluate(async () => {
      agent.openSettings('tools');
      const boxes = () => [...document.querySelectorAll('.aia-modal [data-tool]')];
      const before = boxes().map((b) => [b.dataset.tool, b.checked]);
      const wipe = boxes().find((b) => b.dataset.tool === 'wipe');
      wipe.click();
      document.querySelector('.aia-modal [data-act="save"]').click();
      await new Promise((res) => setTimeout(res, 50));
      return { before, wipeAfter: agent.settings.get().toolStates.wipe, exported: agent.tools.exportConfig().tools.wipe.enabled, list: agent.tools.list().map((t) => [t.name, t.enabled, t.effect]) };
    });
    assert.deepEqual(tab.before, [['count_items', true], ['set_title', true], ['wipe', true]]);
    assert.equal(tab.wipeAfter, false);
    assert.equal(tab.exported, false);
    assert.deepEqual(tab.list, [['count_items', true, 'read'], ['set_title', true, 'write'], ['wipe', false, 'destructive']]);
  } finally {
    await upstream.close();
  }

  // Text mode (models without tool calling) and confirmations switched off: no card, the block is parsed.
  const textModel = await startFakeUpstream({
    cors: true,
    respond: (body, n) => (n === 1 ? { text: 'Sure.\n```tool\n{"name": "set_title", "arguments": {"title": "Via text"}}\n```' } : { text: 'Renamed.' }),
  });
  try {
    await fresh();
    await page.evaluate(async (url) => {
      document.body.insertAdjacentHTML('beforeend', '<h1 id="title">Old</h1>');
      window.agent = M.createAiAgent({
        appId: 'tools-text', launcher: false, devWarnings: false, memory: false, screenshots: false,
        defaults: { provider: 'custom', toolMode: 'text', confirmWrites: false, profiles: { custom: { baseUrl: url, model: 'm' } } },
        tools: [{ name: 'set_title', description: 'Rename.', effect: 'write', enabled: true, parameters: { title: { type: 'string', required: true } }, run: ({ title }) => { document.getElementById('title').textContent = title; } }],
      });
      await agent.ask('Rename it');
    }, textModel.url);
    const t = await page.evaluate(() => ({ title: document.getElementById('title').textContent, shown: [...document.querySelectorAll('.aia-drawer .aia-msg.aia-assistant .aia-md')].pop().textContent }));
    assert.equal(t.title, 'Via text');
    assert.doesNotMatch(t.shown, /"name"/, 'the tool block is not shown to the user');
    const [a, b] = textModel.chats().map((c) => c.body);
    assert.equal(a.tools, undefined, 'text mode sends no tool definitions');
    assert.match(a.messages[0].content, /fenced code block tagged `tool`[\s\S]*set_title\(title: string\)/);
    assert.match(b.messages.at(-1).content, /<tool_results>\nset_title: Done\.\n<\/tool_results>/);
  } finally {
    await textModel.close();
  }
});

test('tool rows: a cut-off call is reported, rolls down to show what was sent, copies, and survives a saved chat', { skip, timeout: 90000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  // What LM Studio streamed when the reply ran out of tokens part-way through the notes (78 characters).
  const CUT = '{"track": "Concert Grand Piano", "notes": "[[0,\\"C4\\",0.5,0.8],[0.5,\\"E4\\",0.5';
  const upstream = await startFakeUpstream({
    cors: true,
    respond: (body, n) => [
      { toolCalls: [{ id: 'c1', name: 'write_notes', rawArguments: CUT }], finish: 'length' },
      { toolCalls: [{ id: 'c2', name: 'write_notes', arguments: { track: 'seq', notes: '[[0,"C4",1]]' } }] },
      { text: 'Wrote it in two smaller steps.' },
    ][n - 1] || { text: 'Extra.' },
  });
  try {
    await fresh();
    await page.evaluate(async (url) => {
      window.copied = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t) => { window.copied.push(t); } } });
      window.agent = M.createAiAgent({
        appId: 'rows-e2e', launcher: false, devWarnings: false, memory: false, screenshots: false,
        defaults: { provider: 'custom', confirmWrites: false, profiles: { custom: { baseUrl: url, model: 'fake-model' } } },
        page: { id: 'song', title: 'Song', content: () => 'Track "Concert Grand Piano" [seq]' },
        tools: [{
          name: 'write_notes', description: 'Write notes.', effect: 'write', enabled: true,
          parameters: { track: { type: 'string', required: true, maxLength: 80 }, notes: { type: 'string', required: true, maxLength: 12000 } },
          run: ({ notes }) => `Wrote ${JSON.parse(notes).length} note.`,
        }],
      });
      await agent.ask('Write a piano piece.');
    }, upstream.url);

    const rows = await page.evaluate(() => [...document.querySelectorAll('.aia-drawer .aia-tool')].map((c) => ({
      call: c.querySelector('.aia-tool-call').textContent,
      status: c.dataset.status,
      tip: c.querySelector('.aia-tool-state').title,
      canOpen: !c.querySelector('.aia-tool-line').disabled,
      open: !c.querySelector('.aia-tool-detail').hidden,
    })));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => [r.call, r.status, r.canOpen, r.open]), [['write_notes()', 'error', true, false], ['write_notes(track: "seq", notes: "[[0,\\"C4\\",1]]")', 'ok', true, false]]);
    assert.match(rows[0].tip, /^Cut off: the reply reached Max reply tokens \(4,096 tokens\) after 78 characters of arguments/);

    // What the model was told, and what went back to the provider for the cut call (no half-written arguments).
    const second = upstream.chats()[1].body;
    const assistant = second.messages.find((m) => m.role === 'assistant' && m.tool_calls);
    assert.equal(assistant.tool_calls[0].function.arguments, '{}');
    assert.match(second.messages.find((m) => m.role === 'tool').content, /^Not run: your reply reached its length limit \(4,096 tokens\)/);

    // Roll the failed row down: the problem, the arguments, the raw text the model sent, and the result.
    await page.click('.aia-drawer .aia-tool:first-child .aia-tool-line');
    const open = await page.evaluate(() => {
      const c = document.querySelector('.aia-drawer .aia-tool');
      return { expanded: c.querySelector('.aia-tool-line').getAttribute('aria-expanded'), labels: [...c.querySelectorAll('.aia-tool-part-label')].map((l) => l.textContent), pres: [...c.querySelectorAll('.aia-tool-part pre')].map((p) => p.textContent), problem: c.querySelector('.aia-tool-problem')?.textContent };
    });
    assert.equal(open.expanded, 'true');
    assert.deepEqual(open.labels, ['Arguments the tool received', 'As the model sent them · 78 chars', 'Error returned to the model']);
    assert.equal(open.pres[1], CUT);
    assert.match(open.problem, /^Cut off:/);
    await page.click('.aia-drawer .aia-tool:first-child [data-aia-tool-copy]');
    await page.click('.aia-drawer .aia-tool:first-child .aia-tool-line');
    assert.equal(await page.evaluate(() => document.querySelector('.aia-drawer .aia-tool .aia-tool-detail').hidden), true, 'rolls back up');

    // "Copy tool log" on the reply: every row.
    await page.click('.aia-drawer [data-aia-reply-action="copy-tools"]');
    const copied = await page.evaluate(() => window.copied);
    assert.equal(copied.length, 2);
    assert.ok(copied[0].startsWith('Write notes · write_notes · Failed\n\nProblem: Cut off:') && copied[0].includes(CUT), copied[0]);
    assert.ok(copied[1].includes('----------------') && copied[1].includes('Returned to the model:\nWrote 1 note.'), copied[1]);

    // The saved chat keeps the detail: reopen it and roll the row down again.
    await page.evaluate(() => document.querySelector('[data-act="new"]').click());
    await page.evaluate(() => document.querySelector('[data-act="library"]').click());
    await page.waitFor(() => !!document.querySelector('[data-chat-open]'), { timeoutMs: 5000 });
    await page.evaluate(() => document.querySelector('[data-chat-open]').click());
    await page.waitFor(() => document.querySelectorAll('.aia-drawer .aia-tool').length === 2, { timeoutMs: 5000 });
    await page.click('.aia-drawer .aia-tool:first-child .aia-tool-line');
    const reopened = await page.evaluate(() => [...document.querySelectorAll('.aia-drawer .aia-tool:first-child .aia-tool-part pre')].map((p) => p.textContent));
    assert.equal(reopened[1], CUT, 'raw text restored from the saved chat');
    assert.deepEqual(page.errors(), []);
  } finally {
    await upstream.close();
  }
});

/* --------------------------------------------------------------------------------- context size */

test('Settings > Context shows the estimated tokens and warns for local models above the threshold', { skip, timeout: 60000 }, async () => {
  await fresh();
  const read = () => page.evaluate(async () => {
    await new Promise((res) => setTimeout(res, 300));
    const box = document.querySelector('.aia-ctx-size');
    return { text: box.textContent, warn: box.classList.contains('aia-ctx-warn') };
  });
  await page.evaluate(() => {
    window.agent = M.createAiAgent({ appId: 'size', launcher: false, devWarnings: false, app: { name: 'Big app' }, page: { id: 'p', title: 'P', content: () => 'word '.repeat(4000) } });
    agent.openSettings('context');
  });
  const big = await read();
  assert.match(big.text, /≈ [\d,.]+ tokens/);
  assert.equal(big.warn, true, 'about 5,000+ tokens with LM Studio: warn');
  assert.match(big.text, /8k/);
  await page.evaluate(() => { agent.setContent(() => 'small'); document.querySelector('.aia-modal [data-tab="agent"]').click(); document.querySelector('.aia-modal [data-tab="context"]').click(); });
  assert.equal((await read()).warn, false);
});

/* ------------------------------------------------------------------------- settings layout (host CSS) */

/** The harness with the hostile host stylesheet loaded after the runtime's (ties go to the host), extra CSS after
 *  that, and the hostile fixture's agent: 29 tools, 30 memories, a long screen, so every tab overflows its body. */
async function hostileAgent({ hostile = true, css = '', options = {} } = {}) {
  await fresh();
  await page.evaluate(async (o) => {
    if (o.hostile) {
      await new Promise((res) => { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/tests/fixtures/hostile-host/hostile.css'; l.onload = res; document.head.append(l); });
    }
    if (o.css) document.head.insertAdjacentHTML('beforeend', `<style>${o.css}</style>`);
    const { mountHostileAgent } = await import('/tests/fixtures/hostile-host/app.js');
    window.agent = mountHostileAgent({ launcher: false, devWarnings: true, ...o.options });
    await agent.ready;
  }, { hostile, css, options });
  page.console.length = 0;
}

/** Evaluated in the page: the geometry and the styles that show, of every element of the dialog's card (or the drawer). */
const GEOMETRY = (selector) => {
  const root = document.querySelector(selector);
  const base = root.getBoundingClientRect();
  return [...root.querySelectorAll('*')].filter((el) => el.getClientRects().length).map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return `${el.tagName}.${el.className?.baseVal ?? el.className} ${[r.x - base.x, r.y - base.y, r.width, r.height].map(Math.round).join(',')} ${cs.fontSize} ${cs.fontWeight} ${cs.fontFamily} ${cs.color} ${cs.backgroundColor} ${cs.textAlign} ${cs.textTransform} ${cs.letterSpacing} ${cs.fill} ${cs.stroke}`;
  });
};

async function uiGeometry() {
  const out = {};
  await page.viewport(1280, 600);
  for (const tab of ['model', 'agent', 'tools', 'memory', 'vision', 'context']) {
    await page.evaluate((t) => agent.openSettings(t), tab);
    await sleep(tab === 'context' ? 500 : 300);
    out[tab] = await page.evaluate(GEOMETRY, '.aia-modal:not([hidden]) .aia-modal-card');
    await page.evaluate(() => document.querySelector('.aia-modal:not([hidden]) [data-act="close"]').click());
  }
  await page.evaluate(() => agent.open());
  await sleep(450);
  out.drawer = await page.evaluate(GEOMETRY, '.aia-drawer');
  return out;
}

test('settings layout: every tab keeps its spec under a hostile host stylesheet (1920x1080, 1280x600), and looks as it does without it', { skip, timeout: 180000 }, async () => {
  await hostileAgent();
  const results = await checkSettingsLayout(page, { agent: 'window.agent' });
  const tabs = ['model', 'agent', 'tools', 'memory', 'vision', 'context'];
  assert.deepEqual([...new Set(results.map((r) => r.tab))], tabs, 'every tab, in their fixed order');
  assert.deepEqual([...new Set(results.map((r) => r.size))], SETTINGS_SIZES.map((s) => s.join('x')));
  for (const r of results) assert.deepEqual(r.problems.map((p) => `${p.element}: ${p.text} — ${p.culprit}`), [], `${r.size} ${r.tab}`);
  for (const r of results.filter((x) => x.size === '1280x600')) {
    assert.equal(r.metrics.overflows, true, `${r.tab}: the body overflows at 1280x600 (what used to squeeze the tab strip)`);
    assert.equal(r.metrics.tabs, r.metrics.tabsNeed, `${r.tab}: the tab strip keeps its full height`);
  }
  assert.equal(page.console.filter((c) => /does not match its layout spec/.test(c.text)).length, 0, 'no dev-time layout warning');

  // The guard leaves alone what it must: [hidden] (a hidden tab collapses), the dark theme, the icons' paint.
  await hostileAgent({ options: { memory: false, theme: 'dark' } });
  const dark = await page.evaluate(() => {
    agent.openSettings('model');
    const m = document.querySelector('.aia-modal:not([hidden])');
    const icon = m.querySelector('.aia-modal-head .aia-icon-btn svg');
    return { memoryTab: getComputedStyle(m.querySelector('[data-tab="memory"]')).display, card: getComputedStyle(m.querySelector('.aia-modal-card')).backgroundColor,
      fill: getComputedStyle(icon).fill, stroke: getComputedStyle(icon).stroke, iconWidth: getComputedStyle(icon).width };
  });
  assert.deepEqual(dark, { memoryTab: 'none', card: 'rgb(23, 33, 49)', fill: 'none', stroke: 'rgb(157, 171, 192)', iconWidth: '17px' });

  // Identical geometry and styles with and without the host's stylesheet: the dialog on every tab, and the drawer.
  await hostileAgent();
  const withHost = await uiGeometry();
  await hostileAgent({ hostile: false });
  const without = await uiGeometry();
  for (const k of Object.keys(without)) assert.deepEqual(withHost[k], without[k], `${k}: host CSS changed the runtime's UI`);
  assert.deepEqual(page.errors(), []);
});

test('settings layout check: it catches a squeezed tab strip and host CSS leaking in, names the rule, and the dev warning says so', { skip, timeout: 120000 }, async () => {
  // What 1.6.0 looked like under the lab app's `label { … }` rule: tabs that shrink, centred labels, checkbox text far
  // from its box. Written here as later, stronger rules, so the check has something to find.
  const leak = `.aia-scope .aia-tabs.aia-tabs { flex-shrink: 1; }
    .aia-scope label.aia-field, .aia-scope label.aia-check { align-items: center; justify-content: space-between; }
    .aia-scope label.aia-check > span { flex: none; }
    .aia-scope .aia-note.aia-note { text-align: center; }`;
  await hostileAgent({ css: leak });
  const results = await checkSettingsLayout(page, { agent: 'window.agent', sizes: [[1280, 600]] });
  const all = results.flatMap((r) => r.problems.map((p) => ({ ...p, tab: r.tab })));
  const kinds = new Set(all.map((p) => p.kind));
  for (const k of ['tabs', 'tab', 'label', 'row', 'check', 'center']) assert.ok(kinds.has(k), `reports "${k}" problems (got ${[...kinds]})`);
  const tools = results.find((r) => r.tab === 'tools');
  assert.ok(tools.metrics.tabs < tools.metrics.tabsNeed, 'the Tools tab squeezes the strip again');
  assert.match(all.find((p) => p.kind === 'check').culprit, /label\.aia-check \{ justify-content: space-between \} \(an inline <style>\)/, 'names the rule behind it');
  assert.match(all.find((p) => p.kind === 'center').culprit, /text-align: center/);
  const warned = page.console.filter((c) => c.level === 'warning' && /does not match its layout spec/.test(c.text));
  assert.ok(warned.length >= 1, 'the dev-time check warns');
  assert.match(warned[0].text, /label\.aia-field has align-items: center/);
  assert.match(warned[0].text, /tab strip is \d+px tall but its tabs need/);
  assert.match(warned[0].text, /Host CSS is leaking/);
});

/* ------------------------------------------------------------------------------------------ memory */

test('memory: the agent saves what it is asked to remember, knows it in the next request, and Settings > Memory edits it', { skip, timeout: 90000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  const upstream = await startFakeUpstream({
    cors: true,
    respond: (body, n) => [
      { toolCalls: [{ id: 'c1', name: 'remember', arguments: { text: 'The hidden demo scene opens with Ctrl+Shift+E.' } }] },
      { text: 'Saved.' },
      { toolCalls: [{ id: 'c2', name: 'forget', arguments: { id: 'm1' } }] },
      { text: 'Forgotten.' },
    ][n - 1] || { text: 'Ok.' },
  });
  try {
    await fresh();
    await page.evaluate(async (url) => {
      window.saved = [];
      window.events = [];
      window.agent = M.createAiAgent({
        appId: 'mem-e2e', launcher: false, devWarnings: false,
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'fake-model' } } },
        memoryFile: { memories: [{ id: 'm1', text: 'The user prefers metric units.' }] },
        memorySave: (file) => { saved.push(file.memories.map((m) => m.id).join(',')); },
        screenshots: false,
        attachments: false,
      });
      agent.on('memory', (e) => events.push(e.change.type));
      await agent.ask('Remember the shortcut for the easter egg: Ctrl+Shift+E.');
    }, upstream.url);

    const first = await page.evaluate(() => ({
      list: agent.memory.list().map((m) => [m.id, m.text, m.source]),
      chip: [...document.querySelectorAll('.aia-drawer .aia-tool')].map((c) => [c.querySelector('.aia-tool-title').textContent, c.dataset.status, c.querySelector('.aia-tool-state').textContent, !!c.querySelector('[data-aia-undo]')]),
      stored: JSON.parse(localStorage.getItem('mem-e2e.ai.memory')),
      events,
    }));
    assert.deepEqual(first.list, [['m1', 'The user prefers metric units.', 'app'], ['m2', 'The hidden demo scene opens with Ctrl+Shift+E.', 'agent']]);
    assert.deepEqual(first.chip, [['Remember', 'ok', 'Saved', true]], 'a chip with Undo, and no confirmation card');
    assert.deepEqual(first.stored.items.map((m) => m.id), ['m2'], 'only what this browser added is stored; the app\'s file stays the base');
    assert.deepEqual(first.events, ['base', 'add']);

    const [q1, q2] = upstream.chats().map((c) => c.body);
    assert.deepEqual(q1.tools.map((t) => t.function.name), ['remember', 'forget'], 'an app without tools of its own still gets the memory tools');
    assert.match(q1.messages[0].content, /== MEMORY ==[\s\S]*- \[m1\] The user prefers metric units\.[\s\S]*call the `remember` tool/);
    assert.doesNotMatch(q1.messages[0].content, /\[m2\]/);
    assert.match(q2.messages[0].content, /- \[m2\] The hidden demo scene opens with Ctrl\+Shift\+E\./, 'the next request already knows it');
    assert.deepEqual(q2.messages.filter((m) => m.role === 'tool').map((m) => m.content), ['Saved as memory m2.']);
    await page.waitFor(() => window.saved.length === 1, { timeoutMs: 5000 });
    assert.deepEqual(await page.evaluate(() => window.saved), ['m1,m2'], 'memorySave gets the whole file after a change (not for the file load)');

    // Forgetting asks first (it deletes something the user saved).
    await page.evaluate(() => { window.done = agent.ask('Forget the units thing.'); });
    await page.waitFor(() => [...document.querySelectorAll('.aia-tool-card:not([hidden])')].some((c) => c.textContent.includes('Delete the saved memory')), { timeoutMs: 15000 });
    assert.equal(await page.evaluate(() => agent.memory.list().length), 2, 'nothing is deleted before the user agrees');
    await page.evaluate(() => document.querySelector('.aia-tool-card:not([hidden]) [data-decide="run"]').click());
    await page.evaluate(() => window.done);
    assert.deepEqual(await page.evaluate(() => agent.memory.list().map((m) => m.id)), ['m2']);
    await page.evaluate(() => [...document.querySelectorAll('.aia-drawer [data-aia-undo]')].pop().click());
    assert.deepEqual(await page.evaluate(() => agent.memory.list().map((m) => m.id)), ['m1', 'm2'], 'Undo on the chip brings it back');

    // Settings > Memory: edit, add, delete, save; the export is the app's memory file format.
    const tab = await page.evaluate(async () => {
      agent.openSettings('memory');
      const rows = () => [...document.querySelectorAll('.aia-modal .aia-memory-row textarea')];
      const before = rows().map((t) => t.value);
      rows()[0].value = 'The user prefers imperial units.';
      rows()[0].dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.aia-modal [data-f="memoryNew"]').value = 'Likes the dark colour map.';
      document.querySelector('.aia-modal [data-act="memoryAdd"]').click();
      document.querySelectorAll('.aia-modal [data-memory-delete]')[1].click();
      const pending = agent.memory.list().map((m) => m.text);
      document.querySelector('.aia-modal [data-act="save"]').click();
      await new Promise((r) => setTimeout(r, 80));
      return { before, pending, after: agent.memory.list().map((m) => [m.id, m.text, m.source]), file: agent.memory.export(), tabs: [...document.querySelectorAll('.aia-modal .aia-tab')].filter((t) => !t.hidden).map((t) => t.textContent) };
    });
    assert.deepEqual(tab.before, ['The user prefers metric units.', 'The hidden demo scene opens with Ctrl+Shift+E.']);
    assert.deepEqual(tab.pending, tab.before, 'edits are a draft until Save');
    assert.deepEqual(tab.after, [['m1', 'The user prefers imperial units.', 'app'], ['m3', 'Likes the dark colour map.', 'user']]);
    assert.deepEqual([tab.file.version, tab.file.memories.map((m) => m.id)], [1, ['m1', 'm3']]);
    assert.deepEqual(tab.tabs, ['Model', 'Agent', 'Memory', 'Context'], 'screenshots: false and attachments: false remove the Vision tab; no app tools, no Tools tab');

    // Saving switched off: the tools are gone and the model is told it cannot save.
    await page.evaluate(async () => { agent.settings.save({ memoryWrite: false }); await agent.ask('Remember that I like tea.'); });
    const off = upstream.lastChat().body;
    assert.equal(off.tools, undefined);
    assert.match(off.messages[0].content, /You cannot save or change memories/);
    assert.deepEqual(page.errors(), []);
  } finally {
    await upstream.close();
  }

  // memory: false — no tab, no tools, no prompt section, agent.memory is null.
  const plain = await startFakeUpstream({ cors: true });
  try {
    await fresh();
    const r = await page.evaluate(async (url) => {
      window.agent = M.createAiAgent({ appId: 'mem-off', launcher: false, devWarnings: false, memory: false, screenshots: false, attachments: false, defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'm' } } } });
      await agent.ask('hi');
      agent.openSettings('model');
      return { memory: agent.memory, tabs: [...document.querySelectorAll('.aia-modal .aia-tab')].filter((t) => !t.hidden).map((t) => t.textContent), camera: document.querySelector('.aia-shot-btn').hidden };
    }, plain.url);
    assert.deepEqual(r, { memory: null, tabs: ['Model', 'Agent', 'Context'], camera: true });
    const body = plain.lastChat().body;
    assert.equal(body.tools, undefined, 'exactly the 1.2 request: no tools');
    assert.doesNotMatch(body.messages[0].content, /MEMORY|Screenshots:|TOOLS/);
  } finally {
    await plain.close();
  }
});

/* ------------------------------------------------------------------------------------------ vision */

/** Decode an image in the page and read pixels: { w, h, px: [[r,g,b], …] } for points given as fractions of its size. */
const readImage = (url, points) => page.evaluate(async (src, pts) => {
  const img = new Image();
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return { w: img.width, h: img.height, px: pts.map(([fx, fy]) => [...g.getImageData(Math.floor(fx * img.width), Math.floor(fy * img.height), 1, 1).data].slice(0, 3)) };
}, url, points);
const near = (a, b, tol = 24) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const imagesOf = (body) => body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'image_url').map((p) => p.image_url.url) : []));

test('vision: the camera button attaches the app\'s own picture (a WebGL canvas) and the model receives it', { skip, timeout: 90000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  const upstream = await startFakeUpstream({ cors: true, reply: ['I see a blue view.'] });
  try {
    await fresh();
    const kind = await page.evaluate((url) => {
      document.body.insertAdjacentHTML('beforeend', '<canvas id="view" width="640" height="360"></canvas>');
      const canvas = document.getElementById('view');
      // A WebGL canvas without preserveDrawingBuffer reads back blank a moment after it was drawn: the hook renders a
      // frame and returns the canvas, and the runtime reads it at once.
      const gl = canvas.getContext('webgl');
      const draw = () => {
        if (gl) { gl.clearColor(0, 0.5, 1, 1); gl.clear(gl.COLOR_BUFFER_BIT); } else { const g = canvas.getContext('2d'); g.fillStyle = 'rgb(0,128,255)'; g.fillRect(0, 0, 640, 360); }
      };
      draw();
      window.hookCalls = [];
      window.shots = [];
      window.agent = M.createAiAgent({
        appId: 'vision-hook', launcher: false, devWarnings: false, memory: false,
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'fake-vlm' } } },
        screenshot: (info) => { hookCalls.push(info.reason); draw(); return canvas; },
        screenshotMaxEdge: 320,
      });
      agent.on('screenshot', (e) => shots.push(e));
      agent.open();
      return gl ? 'webgl' : '2d';
    }, upstream.url);

    assert.equal(await page.evaluate(() => document.querySelector('.aia-shot-btn').hidden), false, 'a camera button beside Send');
    await sleep(300);                                   // let the drawn frame be presented (the buffer is then cleared)
    await page.click('.aia-shot-btn');
    await page.waitFor(() => document.querySelectorAll('.aia-attach img').length === 1, { timeoutMs: 10000 });
    await page.click('.aia-shot-btn');
    await page.waitFor(() => document.querySelectorAll('.aia-attach img').length === 2, { timeoutMs: 10000 });
    await page.evaluate(() => document.querySelector('.aia-attach [data-shot-remove]').click());
    assert.equal(await page.evaluate(() => document.querySelectorAll('.aia-attach img').length), 1, 'a waiting screenshot can be removed');

    await page.evaluate(() => { document.querySelector('.aia-composer textarea').value = 'What colour is the view?'; document.querySelector('.aia-composer').requestSubmit(); });
    await page.waitFor(() => !!document.querySelector('.aia-msg.aia-assistant:not(.aia-welcome) .aia-msg-foot:not([hidden])'), { timeoutMs: 15000 });

    const sent = upstream.lastChat().body;
    const urls = imagesOf(sent);
    assert.equal(urls.length, 1);
    assert.match(sent.messages.at(-1).content[0].text, /A screenshot of the user's screen[\s\S]*What colour is the view\?$/);
    assert.match(sent.messages[0].content, /Images: an image attached to a user message is either a screenshot/);
    const img = await readImage(urls[0], [[0.5, 0.5], [0.05, 0.9]]);
    assert.deepEqual([img.w, img.h], [320, 180], 'scaled to screenshotMaxEdge');
    assert.ok(img.px.every((p) => near(p, [0, 128, 255])), `${kind}: the picture is the view, not a blank buffer: ${JSON.stringify(img.px)}`);

    const ui = await page.evaluate(() => ({
      hookCalls, shots,
      thumb: document.querySelectorAll('.aia-msg.aia-user .aia-shots img').length,
      pending: document.querySelectorAll('.aia-attach img').length,
      saved: JSON.parse(localStorage.getItem('vision-hook.ai.chats'))[0].messages[0].shots.map((s) => [s.thumb.startsWith('data:image/jpeg'), s.thumb.length < 20000, 'data' in s]),
      tools: null,
    }));
    assert.deepEqual(ui.hookCalls, ['user', 'user']);
    assert.deepEqual(ui.shots.at(-1), { by: 'user', width: 320, height: 180, source: 'app' });
    assert.deepEqual([ui.thumb, ui.pending], [1, 0], 'the question shows its thumbnail; the composer is empty again');
    assert.deepEqual(ui.saved, [[true, true, false]], 'saved chats keep a small thumbnail, never the full image');
    assert.deepEqual(sent.tools.map((t) => t.function.name), ['request_tool'], 'the agent cannot look on its own, but can ask');

    // The next question without a new screenshot still carries the last one; a text-only model gets none.
    await page.evaluate(() => agent.ask('And the corners?'));
    assert.equal(imagesOf(upstream.lastChat().body).length, 1);
    await page.evaluate(async () => { agent.settings.save({ vision: false }); await agent.ask('Still there?'); });
    const blind = upstream.lastChat().body;
    assert.equal(imagesOf(blind).length, 0);
    assert.equal(blind.tools, undefined);
    assert.match(JSON.stringify(blind.messages), /A screenshot was attached to this message; it is not included any more/);
    assert.equal(await page.evaluate(() => document.querySelector('.aia-shot-btn').hidden), true, 'no camera button for a text-only model');
    assert.deepEqual(page.errors(), []);
  } finally {
    await upstream.close();
  }
});

test('vision: the agent asks before it looks; "Allow once" sends one screenshot, freeing it lets it look on its own', { skip, timeout: 90000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  const upstream = await startFakeUpstream({
    cors: true,
    respond: (body, n) => [
      { toolCalls: [{ id: 'c1', name: 'request_tool', arguments: { name: 'take_screenshot', reason: 'To check the layout.' } }] },
      { text: 'The box is green.' },
      { toolCalls: [{ id: 'c2', name: 'take_screenshot', arguments: {} }] },
      { text: 'Still green.' },
    ][n - 1] || { text: 'Ok.' },
  });
  try {
    await fresh();
    await page.evaluate((url) => {
      document.body.insertAdjacentHTML('beforeend', '<canvas id="view" width="400" height="300"></canvas>');
      const g = document.getElementById('view').getContext('2d');
      g.fillStyle = 'rgb(0,160,60)';
      g.fillRect(0, 0, 400, 300);
      window.agent = M.createAiAgent({
        appId: 'vision-agent', launcher: false, devWarnings: false, memory: false,
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'fake-vlm' } } },
        screenshot: () => document.getElementById('view'),
      });
      window.done = agent.ask('Does the layout look right?');
    }, upstream.url);

    await page.waitFor(() => [...document.querySelectorAll('.aia-tool-card:not([hidden])')].some((c) => c.textContent.includes('look at your screen')), { timeoutMs: 15000 });
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.aia-tool-card:not([hidden]) [data-decide]')].map((b) => b.textContent)), ['Allow once', 'Always allow', 'No']);
    await page.click('.aia-tool-card:not([hidden]) [data-decide="once"]');
    await page.evaluate(() => window.done);

    const [first, second] = upstream.chats().map((c) => c.body);
    assert.match(first.messages[0].content, /Turned off by the user[\s\S]*- take_screenshot —/, 'the model knows the tool exists and is off');
    assert.deepEqual(second.messages.slice(-2).map((m) => m.role), ['tool', 'user'], 'the screenshot comes back with the result of its request');
    assert.match(second.messages.at(-2).content, /^Screenshot taken \(400 × 300 px\)/);
    const img = await readImage(imagesOf(second)[0], [[0.5, 0.5]]);
    assert.ok(near(img.px[0], [0, 160, 60]), JSON.stringify(img.px));
    const once = await page.evaluate(() => ({
      auto: agent.settings.get().screenshotAuto,
      chips: [...document.querySelectorAll('.aia-drawer .aia-tool')].map((c) => [c.querySelector('.aia-tool-title').textContent, c.dataset.status, !!c.querySelector('.aia-tool-shot img')]),
      saved: JSON.parse(localStorage.getItem('vision-agent.ai.chats'))[0].messages[1].actions.map((a) => [a.call, a.status, a.thumb.startsWith('data:image/jpeg')]),
    }));
    assert.equal(once.auto, false, '"Allow once" does not change the setting');
    assert.deepEqual(once.chips, [['Take screenshot', 'ok', true]], 'the chat shows the thumbnail of what the agent saw');
    assert.deepEqual(once.saved, [['take_screenshot()', 'ok', true]]);

    // Settings > Vision: untick "only when I press the camera button" -> the agent may look on its own.
    const tab = await page.evaluate(async () => {
      agent.openSettings('vision');
      const box = document.querySelector('.aia-modal [data-f="shotsManual"]');
      const was = box.checked;
      box.click();
      document.querySelector('.aia-modal [data-act="save"]').click();
      await new Promise((r) => setTimeout(r, 80));
      return { was, auto: agent.settings.get().screenshotAuto, how: document.querySelector('.aia-modal [data-f="visionHow"]').textContent };
    });
    assert.deepEqual([tab.was, tab.auto], [true, true]);
    assert.match(tab.how, /This application provides the picture itself/);
    await sleep(700);                                   // the settings modal closes itself after saving
    await page.evaluate(() => agent.ask('Look again.'));
    const third = upstream.chats()[2].body;
    assert.deepEqual(third.tools.map((t) => t.function.name), ['take_screenshot'], 'now it is a tool the model can call');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.aia-tool-card:not([hidden])').length), 0, 'no card this time');
    assert.equal(imagesOf(upstream.chats()[3].body).length, 1);
    // Reloading a saved chat shows the thumbnails again.
    const reloaded = await page.evaluate(() => { const id = JSON.parse(localStorage.getItem('vision-agent.ai.chats'))[0].id; agent.newChat(); document.querySelector(`[data-chat-open="${id}"]`).click(); return document.querySelectorAll('.aia-drawer .aia-tool-shot img').length; });
    assert.equal(reloaded, 2);
    assert.deepEqual(page.errors(), []);
  } finally {
    await upstream.close();
  }
});

test('vision without an app hook: the browser\'s screen capture of this tab, with the drawer left out', { skip, timeout: 90000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  const upstream = await startFakeUpstream({ cors: true, respond: (body, n) => (n === 1 ? { toolCalls: [{ id: 'c1', name: 'take_screenshot', arguments: {} }] } : { text: 'Done.' }) });
  try {
    await fresh();
    // The capture shows the real window, so the emulated viewport of the other tests is switched off here.
    await page.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
    const geo = await page.evaluate((url) => {
      document.body.style.margin = '0';
      document.body.insertAdjacentHTML('beforeend', '<div style="position:fixed;left:0;top:0;width:50vw;height:100vh;background:rgb(220,0,0)"></div>');
      window.agent = M.createAiAgent({
        appId: 'vision-screen', launcher: false, devWarnings: false, memory: false, push: false,
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'fake-vlm' } } },
      });
      agent.open();
      return { supported: typeof navigator.mediaDevices?.getDisplayMedia === 'function' };
    }, upstream.url);
    assert.equal(geo.supported, true);
    // The drawer slides in: wait until it stands still.
    await page.waitFor(async () => {
      const left = () => document.querySelector('.aia-drawer').getBoundingClientRect().left;
      const a = left();
      await new Promise((r) => setTimeout(r, 150));
      return a === left() && a < innerWidth - 100;
    }, { timeoutMs: 10000 });
    const box = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, drawerLeft: document.querySelector('.aia-drawer').getBoundingClientRect().left }));

    await page.click('.aia-shot-btn');                  // a real click: the browser only shares the screen after one
    await page.waitFor(() => document.querySelectorAll('.aia-attach img').length === 1 || document.querySelector('.aia-drawer .aia-error'), { timeoutMs: 15000 });
    assert.equal(await page.evaluate(() => document.querySelector('.aia-drawer .aia-error')?.textContent || ''), '');
    await page.evaluate(() => { document.querySelector('.aia-composer textarea').value = 'What is on the left?'; document.querySelector('.aia-composer').requestSubmit(); });
    await page.waitFor(() => [...document.querySelectorAll('.aia-tool-card:not([hidden])')].some((c) => c.textContent.includes('look at your screen')), { timeoutMs: 15000 });

    const first = upstream.chats()[0].body;
    const img = await readImage(imagesOf(first)[0], [[0.2, 0.5], [0.95, 0.5]]);
    // (While a tab is shared the browser's own "sharing" bar takes some of the window's height.)
    assert.ok(Math.abs(img.w - box.drawerLeft) <= 2 && img.h <= box.h && img.h > box.h - 120, `the picture is the page beside the drawer (${img.w}×${img.h} for ${box.drawerLeft}×${box.h})`);
    assert.ok(near(img.px[0], [220, 0, 0], 40), `the left half is the red block: ${JSON.stringify(img.px[0])}`);
    assert.ok(near(img.px[1], [255, 255, 255], 40), `the right edge is the page, not the drawer: ${JSON.stringify(img.px[1])}`);
    const live = () => page.evaluate(async () => { agent.openSettings('vision'); const v = !document.querySelector('.aia-modal [data-f="visionLive"]').hidden; document.querySelector('.aia-modal [data-act="close"]').click(); return v; });
    assert.equal(await live(), false, 'with "only when I press the button", sharing stops after each screenshot');

    // "Always allow": the agent's own screenshot, and the tab stays shared until the user stops it.
    await page.click('.aia-tool-card:not([hidden]) [data-decide="always"]');
    await page.waitFor(() => !document.querySelector('.aia-drawer').classList.contains('aia-busy'), { timeoutMs: 15000 });
    assert.equal(await page.evaluate(() => agent.settings.get().screenshotAuto), true);
    assert.equal(imagesOf(upstream.chats()[1].body).length, 2, 'the question\'s screenshot and the agent\'s');
    assert.equal(await live(), true);
    const stopped = await page.evaluate(() => { agent.openSettings('vision'); document.querySelector('.aia-modal [data-act="visionStop"]').click(); return document.querySelector('.aia-modal [data-f="visionLive"]').hidden; });
    assert.equal(stopped, true, '"Stop sharing this tab" ends it');
    assert.deepEqual(page.errors(), []);
  } finally {
    await upstream.close();
  }
});

test('built-in tools keep working with the app\'s tools switched off, and as text blocks for models without tool calling', { skip, timeout: 60000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  const upstream = await startFakeUpstream({
    cors: true,
    respond: (body, n) => (n === 1 ? { text: 'Noted.\n```tool\n{"name": "remember", "arguments": {"text": "The user likes tea."}}\n```' } : { text: 'Saved.' }),
  });
  try {
    await fresh();
    await page.evaluate(async (url) => {
      window.ran = 0;
      window.agent = M.createAiAgent({
        appId: 'builtin-text', launcher: false, devWarnings: false, screenshots: false,
        defaults: { provider: 'custom', toolMode: 'text', toolsEnabled: false, profiles: { custom: { baseUrl: url, model: 'm' } } },
        tools: [{ name: 'wipe', description: 'Remove every item.', effect: 'destructive', enabled: true, run: () => { ran += 1; } }],
      });
      await agent.ask('Remember that I like tea.');
    }, upstream.url);
    const [first, second] = upstream.chats().map((c) => c.body);
    assert.equal(first.tools, undefined, 'text mode: no tool definitions');
    const system = first.messages[0].content;
    assert.match(system, /The application has tools of its own, but the user switched them off/);
    assert.match(system, /Tools you can call:\n- remember\(text: string, id\?: string\)[^\n]*\n- forget\(id: string\)/);
    assert.doesNotMatch(system, /- wipe/, 'the app\'s tools are not offered while they are switched off');
    assert.match(second.messages.at(-1).content, /<tool_results>\nremember: Saved as memory m1\.\n<\/tool_results>/);
    const r = await page.evaluate(() => ({ list: agent.memory.list().map((m) => [m.text, m.source]), ran, shown: [...document.querySelectorAll('.aia-drawer .aia-msg.aia-assistant .aia-md')].pop().textContent }));
    assert.deepEqual(r.list, [['The user likes tea.', 'agent']]);
    assert.equal(r.ran, 0);
    assert.doesNotMatch(r.shown, /"name"/, 'the tool block is not shown to the user');
    assert.deepEqual(page.errors(), []);
  } finally {
    await upstream.close();
  }
});

/* ----------------------------------------------------------------------------------- attachments (+) */

/** Put files into one of the drawer's file inputs, as the browser's file picker does. files: [{ b64, name, type }] */
const pick = (selector, files) => page.evaluate((sel, list) => {
  const dt = new DataTransfer();
  for (const f of list) dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
  const input = document.querySelector(sel);
  input.files = dt.files;
  input.dispatchEvent(new Event('change'));
}, selector, files);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
/** A PNG of one colour, made in the page. */
const pngB64 = (w, h, color) => page.evaluate(async (W, H, c) => {
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = c;
  g.fillRect(0, 0, W, H);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}, w, h, color);

test('attachments: the + menu attaches an image (sent like a screenshot) and a Word file (sent as its text)', { skip, timeout: 90000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  const F = await import('./fixtures/documents.mjs');
  const upstream = await startFakeUpstream({ cors: true, reply: ['The report says sales rose; the picture is red.'] });
  try {
    await fresh();
    await page.evaluate((url) => {
      window.attached = [];
      window.agent = M.createAiAgent({
        appId: 'attach-e2e', launcher: false, devWarnings: false, memory: false, screenshots: false, screenshotMaxEdge: 400,
        defaults: { provider: 'custom', profiles: { custom: { baseUrl: url, model: 'fake-vlm' } } },
      });
      agent.on('attach', (e) => attached.push(e));
      agent.open();
    }, upstream.url);
    await sleep(350);

    // The menu: opens from +, the keyboard moves through it, Escape and a click elsewhere close it.
    assert.deepEqual(await page.evaluate(() => [document.querySelector('.aia-plus').hidden, document.querySelector('.aia-attach-menu').hidden]), [false, true]);
    await page.click('.aia-plus-btn');
    const menu = await page.evaluate(() => ({
      open: !document.querySelector('.aia-attach-menu').hidden,
      expanded: document.querySelector('.aia-plus-btn').getAttribute('aria-expanded'),
      items: [...document.querySelectorAll('.aia-menu-item b')].map((b) => b.textContent),
      focus: document.activeElement.dataset.act,
      leftOfField: document.querySelector('.aia-plus-btn').getBoundingClientRect().right <= document.querySelector('.aia-composer textarea').getBoundingClientRect().left,
    }));
    assert.deepEqual(menu, { open: true, expanded: 'true', items: ['Attach an image', 'Upload a file'], focus: 'attach-image', leftOfField: true });
    await page.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.act), 'attach-file');
    await page.press('Escape');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('.aia-attach-menu').hidden, document.activeElement.classList.contains('aia-plus-btn'), agent.isOpen()]), [true, true, true], 'Escape closes the menu, not the drawer');
    await page.click('.aia-plus-btn');
    await page.click('.aia-messages');
    assert.equal(await page.evaluate(() => document.querySelector('.aia-attach-menu').hidden), true, 'a click elsewhere closes it');

    // Pick an image and a Word document, as the browser's file pickers would.
    await pick('[data-el="imageInput"]', [{ b64: await pngB64(800, 400, 'rgb(220,0,0)'), name: 'red.png', type: 'image/png' }]);
    await pick('[data-el="fileInput"]', [{ b64: b64(await F.docx()), name: 'report.docx', type: '' }]);
    await page.waitFor(() => document.querySelectorAll('.aia-attach img').length === 1 && document.querySelector('.aia-attach .aia-file:not(.aia-file-reading)'), { timeoutMs: 10000 });
    const composer = await page.evaluate(() => ({
      chip: document.querySelector('.aia-attach .aia-file').textContent,
      placeholder: document.querySelector('.aia-composer textarea').placeholder,
      events: attached.map((e) => [e.kind, e.name]),
    }));
    assert.match(composer.chip, /^report\.docxWord document · ≈ \d+ tokens$/);
    assert.equal(composer.placeholder, 'Ask about the attachments…');
    assert.deepEqual(composer.events.sort(), [['docx', 'report.docx'], ['image', 'red.png']]);

    await page.evaluate(() => { document.querySelector('.aia-composer textarea').value = 'What do these say?'; document.querySelector('.aia-composer').requestSubmit(); });
    await page.waitFor(() => !!document.querySelector('.aia-msg.aia-assistant:not(.aia-welcome) .aia-msg-foot:not([hidden])'), { timeoutMs: 15000 });
    const sent = upstream.lastChat().body;
    const parts = sent.messages.at(-1).content;
    assert.match(parts[0].text, /^<attached_file name="report\.docx" type="Word document" chars="\d+" hash="[0-9a-f]{7}">\n# Quarterly report\n# Summary\n[\s\S]*<\/attached_file>\n\n\[Attached to this message: the image file "red\.png"\.\]\n\nWhat do these say\?$/);
    assert.match(sent.messages[0].content, /Attached files: files the user attached reach you inside <attached_file/);
    assert.match(sent.messages[0].content, /Images: an image attached to a user message is an image file the user attached/, 'no screenshots in this app: the image paragraph says so');
    const img = await readImage(imagesOf(sent)[0], [[0.5, 0.5]]);
    assert.deepEqual([img.w, img.h], [400, 200], 'scaled like a screenshot (screenshotMaxEdge)');
    assert.ok(near(img.px[0], [220, 0, 0]), JSON.stringify(img.px));

    // The question shows both; the file chip opens the text the agent received.
    await page.click('.aia-msg.aia-user .aia-files .aia-file');
    const viewer = await page.evaluate(() => ({
      open: !document.querySelector('.aia-file-view').hidden,
      name: document.querySelector('[data-el="fileViewName"]').textContent,
      text: document.querySelector('[data-el="fileViewText"]').textContent.split('\n')[0],
    }));
    assert.deepEqual(viewer, { open: true, name: 'report.docx', text: '# Quarterly report' });
    await page.press('Escape');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('.aia-file-view').hidden, agent.isOpen(), document.querySelectorAll('.aia-msg.aia-user .aia-shots img').length]), [true, true, 1]);

    // Saved chats keep the file's text and the image's thumbnail, never the image.
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('attach-e2e.ai.chats'))[0].messages[0]);
    assert.match(saved.files[0].text, /^# Quarterly report/);
    assert.deepEqual(saved.shots.map((s) => [s.name, s.kind, s.thumb.startsWith('data:image/jpeg'), 'data' in s]), [['red.png', 'image', true, false]]);

    // The next question: the file stays in the conversation, and the image is still among the newest.
    await page.evaluate(() => agent.ask('And the totals?'));
    const next = upstream.lastChat().body;
    assert.match(next.messages[1].content[0].text, /<attached_file name="report\.docx"/);
    assert.equal(next.messages.at(-1).content, 'And the totals?');
    assert.equal(imagesOf(next).length, 1);

    // Reopened from Saved chats: the chip is back and still shows the text.
    await page.evaluate(() => { const id = JSON.parse(localStorage.getItem('attach-e2e.ai.chats'))[0].id; agent.newChat(); document.querySelector(`[data-chat-open="${id}"]`).click(); });
    await page.click('.aia-msg.aia-user .aia-files .aia-file');
    assert.match(await page.evaluate(() => document.querySelector('[data-el="fileViewText"]').textContent), /Kept words/);
    assert.deepEqual(page.errors(), []);
  } finally {
    await upstream.close();
  }
});

test('attachments: drag and drop, paste, a text-only model, agent.attach() + ask(), Send while reading, attachments: false', { skip, timeout: 90000 }, async () => {
  const { startFakeUpstream } = await import('./fixtures/fake-upstream.mjs');
  const upstream = await startFakeUpstream({ cors: true, reply: ['Ok.'] });
  try {
    await fresh();
    const red = await pngB64(64, 64, 'rgb(220,0,0)');
    await page.evaluate((url) => {
      window.hostDrops = 0;
      window.addEventListener('drop', () => { hostDrops++; });
      window.agent = M.createAiAgent({
        appId: 'attach-more', launcher: false, devWarnings: false, memory: false,
        defaults: { provider: 'custom', vision: false, profiles: { custom: { baseUrl: url, model: 'text-only' } } },
      });
      agent.open();
    }, upstream.url);
    await sleep(300);

    // A text-only model: no images (the menu says why), but an SVG is still read as text.
    await page.click('.aia-plus-btn');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('[data-act="attach-image"]').disabled, document.querySelector('[data-el="menuImageNote"]').textContent]), [true, 'This model is set as text-only (Settings > Vision).']);
    await page.press('Escape');
    const blind = await page.evaluate(async (png) => {
      const photo = new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], 'photo.png', { type: 'image/png' });
      const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"><text>Logo</text></svg>'], 'logo.svg', { type: 'image/svg+xml' });
      const r = await agent.attach([photo, svg, new File(['PK'], 'bundle.zip')]);
      return { r: r.map((x) => x && [x.kind, x.name]), errors: [...document.querySelectorAll('.aia-drawer .aia-error')].map((e) => e.textContent.trim()) };
    }, red);
    assert.deepEqual(blind.r, [null, ['text', 'logo.svg'], null]);
    assert.match(blind.errors[0], /"photo\.png" is an image, and this model is set as text-only/);
    assert.match(blind.errors[1], /"bundle\.zip" is an archive/);

    // Drag a CSV over the drawer and drop it: the overlay shows, and the host page's own drop handler is not reached.
    const drop = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['item,qty\nbolts,40\n'], 'stock.csv', { type: 'text/csv' }));
      const target = document.querySelector('.aia-messages');
      target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const shown = !document.querySelector('.aia-drop').hidden;
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return { shown, hidden: document.querySelector('.aia-drop').hidden };
    });
    assert.deepEqual(drop, { shown: true, hidden: true });
    await page.waitFor(() => [...document.querySelectorAll('.aia-attach .aia-file-name')].some((n) => n.textContent === 'stock.csv'), { timeoutMs: 5000 });
    assert.equal(await page.evaluate(() => hostDrops), 0);

    // Paste: a file alone is attached; a file that comes with text (copied from Word or Excel) leaves the text paste alone.
    const pasted = await page.evaluate(() => {
      const ta = document.querySelector('.aia-composer textarea');
      const paste = (withText) => {
        const dt = new DataTransfer();
        dt.items.add(new File(['pasted notes'], 'notes.txt', { type: 'text/plain' }));
        if (withText) dt.setData('text/plain', 'cells as text');
        const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
        ta.dispatchEvent(e);
        return e.defaultPrevented;
      };
      return [paste(true), paste(false)];
    });
    assert.deepEqual(pasted, [false, true]);
    await page.waitFor(() => document.querySelectorAll('.aia-attach .aia-file:not(.aia-file-reading)').length === 3, { timeoutMs: 5000 });

    // ask() takes what waits in the composer along, like Send.
    await page.evaluate(() => agent.ask('Summarize them.'));
    const first = upstream.lastChat().body.messages.at(-1).content;
    assert.deepEqual([...first.matchAll(/<attached_file name="([^"]+)"/g)].map((m) => m[1]), ['logo.svg', 'stock.csv', 'notes.txt']);
    assert.match(first, /Summarize them\.$/);
    assert.equal(await page.evaluate(() => document.querySelector('.aia-attach').hidden), true);

    // Send pressed while a file is still being read: the question goes once it is read.
    await page.evaluate(() => {
      agent.attach(new File(['x'.repeat(200000)], 'big.log'));
      document.querySelector('.aia-composer textarea').value = 'And this log?';
      document.querySelector('.aia-composer').requestSubmit();
    });
    for (const end = Date.now() + 10000; upstream.chats().length < 2 && Date.now() < end;) await sleep(50);
    assert.match(upstream.lastChat().body.messages.at(-1).content, /<attached_file name="big\.log" type="Log" chars="200000" truncated="true"[\s\S]*And this log\?$/);

    // attachments: false: no + button, no drop target, attach() does nothing, no Max file content field.
    await fresh();
    const off = await page.evaluate(async () => {
      window.agent = M.createAiAgent({ appId: 'attach-off', launcher: false, devWarnings: false, attachments: false });
      agent.open();
      const dt = new DataTransfer();
      dt.items.add(new File(['a'], 'a.txt'));
      document.querySelector('.aia-messages').dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      agent.openSettings('agent');
      const field = document.querySelector('.aia-modal [data-f="maxFileChars"]').closest('.aia-section').hidden;
      document.querySelector('.aia-modal [data-act="close"]').click();
      return { plus: document.querySelector('.aia-plus').hidden, overlay: document.querySelector('.aia-drop').hidden, attached: await agent.attach([new File(['a'], 'a.txt')]), field };
    });
    assert.deepEqual(off, { plus: true, overlay: true, attached: [], field: true });
    assert.deepEqual(page.errors(), []);
  } finally {
    await upstream.close();
  }
});

test('attachments: a PDF printed by the browser itself (Skia: Type0 fonts, ToUnicode, Flate) reads back as its text', { skip, timeout: 60000 }, async () => {
  await fresh();
  await page.evaluate(() => {
    document.body.innerHTML = `<main style="font: 16px Arial, sans-serif; padding: 20px">
      <h1>Invoice 42</h1><p>Total due: 1,234.50 EUR — payable “within 30 days”.</p>
      <table border="1"><tr><td>Bolts</td><td>40</td></tr><tr><td>Nuts</td><td>12</td></tr></table>
      <p>Offices in Zürich and 東京.</p></main>`;
  });
  const { data } = await page.send('Page.printToPDF', { printBackground: false });
  const r = await page.evaluate(async (pdf) => {
    const { readFile } = await import('/assets/ai-agent/core/files.js');
    const f = new File([Uint8Array.from(atob(pdf), (c) => c.charCodeAt(0))], 'invoice.pdf', { type: 'application/pdf' });
    const rec = await readFile(f);
    return { text: rec.text, label: rec.label, count: rec.count, note: rec.note || '' };
  }, data);
  assert.deepEqual([r.label, r.count, r.note], ['PDF', 1, '']);
  const flat = r.text.replace(/\s+/g, ' ');
  for (const want of ['Invoice 42', 'Total due: 1,234.50 EUR — payable “within 30 days”.', 'Bolts 40', 'Nuts 12', 'Offices in Zürich and 東京.']) {
    assert.ok(flat.includes(want), `"${want}" in: ${flat}`);
  }
  assert.ok(flat.indexOf('Invoice 42') < flat.indexOf('Bolts') && flat.indexOf('Bolts') < flat.indexOf('Zürich'), 'reading order');
});
