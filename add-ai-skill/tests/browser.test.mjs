// Runtime behaviour that only a real browser can show: keyboard isolation from host shortcuts, native modal
// dialogs, the push-layout warning, theme overrides, resume, form controls, the relay probe and the context size.
// Runs headless Edge/Chrome/Chromium over the DevTools protocol (scripts/lib/cdp.mjs, Node 22+). Skipped when no
// browser is installed; set AIA_BROWSER to a browser executable to choose one, or AIA_SKIP_BROWSER=1 to skip.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, serveStatic, findBrowser, sleep } from '../scripts/lib/cdp.mjs';

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
  browser = await launchBrowser({ width: 1366, height: 900 });
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
