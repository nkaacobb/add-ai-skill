#!/usr/bin/env node
// Verify an AI Enablement integration (the agent drawer) in a real (headless) browser. Zero dependencies; Node 22+; Edge, Chrome or
// Chromium installed.
//
//   node <skill>/scripts/verify.mjs <page-url> [options]
//
//   --no-llm              skip the questions (no model running): load, hotkey, flag, typing, context and layout only
//   --change "<js>"       JavaScript run in the page to change what is on screen (for the synced -> changed check),
//                         e.g. --change "document.querySelector('#editor').value += '!'; document.querySelector('#editor').dispatchEvent(new Event('input', {bubbles: true}))"
//   --question "<text>"   the question to ask (default: a one-sentence summary)
//   --toggle <selector>   the app's toggle button (default: any element the agent marked with [data-aia-toggle])
//   --agent <expression>  how to reach the agent object (default: window.agent || window.aiAgent); optional
//   --hotkey <combo>      default ctrl+i
//   --widths 1280,1366,1600   layout widths to check (a screenshot per width)
//   --settings-sizes 1920x1080,1280x600   window sizes for the settings check
//   --out <dir>           screenshots and report.json (default: ./.verify)
//   --browser <path>      browser executable (default: Edge/Chrome found on this machine, or $AIA_BROWSER)
//   --headed              show the browser window
//   --timeout <seconds>   per answer (default 180)
//
// Exit code 0 when every check passed (skipped checks do not fail the run), 1 otherwise. The checks:
//   load        no console errors or failed requests (browser-extension noise ignored)
//   mount       the drawer exists (if not: the module did not load; think of a stale cached script)
//   hotkey      the hotkey opens the drawer; the context flag has a state
//   toggle      the toggle is visible and closes/opens the drawer
//   typing      a space and letters typed in the composer land in the composer (host shortcuts do not steal them)
//   context     Settings > Context: estimated size of the first request
//   tools       the tool catalog (on / off / usable here); runs the reading tools that need no arguments
//   capabilities the capability index: agents, skills, toolsets, problems loading them, the dev workspace
//   memory      the memories the agent starts with (the app's memory file + this browser's)
//   vision      takes one screenshot the way the camera button does: the app's hook, or the browser's screen capture
//   attachments the + button opens its menu (Attach an image · Upload a file); a small text file attaches as text
//   layout@W    at each width: no horizontal overflow, nothing under the drawer, the toggle still visible
//   settings:T  every visible Settings tab at 1920x1080 and 1280x600 (references/settings-layout.md): the tab strip
//               whole and inside the card, the footer and Save inside the card, labels at the left of their card,
//               input rows full width (the input at least half), checkbox text right after the box, nothing centred;
//               a failure names the element and the host CSS rule that probably caused it. Screenshots:
//               settings-<tab>.png (1920x1080) and settings-<tab>-1280x600.png
//   ask         "Read the page" receipt, flag synced                                         (needs a model)
//   change      after --change the flag turns "dirty"; the next question re-reads the page  (needs a model)
//   unchanged   asking again without changes says "Page unchanged"                         (needs a model)

import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, sleep } from './lib/cdp.mjs';
import { checkSettingsLayout, formatProblem, SETTINGS_SIZES } from './lib/settings-layout.mjs';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const url = argv.find((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--') || ['no-llm', 'headed'].includes(argv[i - 1].slice(2))));
if (!url || has('help')) {
  const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(lines.slice(1, lines.findIndex((l, i) => i > 0 && !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(url ? 0 : 1);
}

const O = {
  llm: !has('no-llm'),
  change: opt('change', ''),
  question: opt('question', 'In one sentence: what is on this page?'),
  toggle: opt('toggle', '[data-aia-toggle]'),
  agent: opt('agent', 'window.agent || window.aiAgent'),
  hotkey: opt('hotkey', 'ctrl+i'),
  widths: opt('widths', '1280,1366,1600').split(',').map(Number).filter((n) => n > 0),
  settingsSizes: opt('settings-sizes', SETTINGS_SIZES.map((s) => s.join('x')).join(',')).split(',').map((s) => s.split('x').map(Number)).filter((s) => s[0] > 0 && s[1] > 0),
  out: path.resolve(opt('out', '.verify')),
  browser: opt('browser', ''),
  headed: has('headed'),
  timeoutMs: Number(opt('timeout', 180)) * 1000,
};

const results = [];
const record = (name, status, detail = '') => {
  results.push({ name, status, detail });
  const mark = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', info: 'INFO' }[status];
  console.log(`${mark}  ${name}${detail ? `  —  ${detail}` : ''}`);
};

function comboToPress(combo) {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop();
  const mods = { ctrl: parts.includes('ctrl') || parts.includes('mod'), meta: parts.includes('meta') || parts.includes('cmd'), shift: parts.includes('shift'), alt: parts.includes('alt') };
  if (process.platform === 'darwin' && parts.includes('mod')) { mods.ctrl = false; mods.meta = true; }
  return { key, mods };
}

/** Evaluated in the page: status from the agent object if reachable, else from the drawer's flag. */
const STATUS = (agentExpr) => `(() => {
  let a = null; try { a = (${agentExpr}) || null; } catch {}
  const bar = document.querySelector('.aia-drawer .aia-context');
  const s = a && a.getContextStatus ? a.getContextStatus() : null;
  return { via: s ? 'agent' : 'dom', state: s ? s.state : bar?.dataset.state || null, hash: s ? s.hash : (document.querySelector('.aia-drawer .aia-context-hash')?.textContent || null), open: !!document.querySelector('.aia-drawer.aia-open') };
})()`;

/** Evaluated in the page: the same checks as the runtime's dev-time layout check. */
const LAYOUT = (toggleSel) => `(() => {
  const drawer = document.querySelector('.aia-drawer');
  const edge = drawer.getBoundingClientRect().left;
  const vw = document.documentElement.clientWidth;
  const label = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ([...el.classList].filter((c) => !c.startsWith('aia-')).slice(0, 2).map((c) => '.' + c).join(''));
  const out = { width: innerWidth, drawerLeft: Math.round(edge), overflowPx: Math.max(0, (document.scrollingElement || document.documentElement).scrollWidth - vw), pushed: [], under: [], toggles: [] };
  for (const t of document.querySelectorAll('.aia-pushed')) {
    if (t !== document.body && t.scrollWidth > t.clientWidth + 1) out.pushed.push(label(t) + ' overflows by ' + (t.scrollWidth - t.clientWidth) + 'px');
    const queue = [...t.children];
    let seen = 0;
    while (queue.length && seen < 4000 && out.under.length < 8) {
      const el = queue.shift(); seen++;
      if (el.closest('.aia-scope')) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (!r.width || cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (r.right > edge + 1 && r.left < edge - 1 && cs.position !== 'fixed') { out.under.push(label(el) + ' (' + Math.round(r.right - edge) + 'px under)'); continue; }
      if (cs.overflowX === 'visible') queue.push(...el.children);
    }
  }
  for (const t of document.querySelectorAll(${JSON.stringify(toggleSel)})) {
    if (t.classList.contains('aia-launcher')) continue;
    const r = t.getBoundingClientRect();
    out.toggles.push({ label: label(t), visible: r.width > 0 && r.right <= edge + 1 && r.left >= 0 });
  }
  return out;
})()`;

async function ask(page, text) {
  await page.evaluate(() => { const ta = document.querySelector('.aia-composer textarea'); ta.value = ''; ta.focus(); });
  await page.send('Input.insertText', { text });
  const before = await page.evaluate(() => document.querySelectorAll('.aia-drawer .aia-msg.aia-user').length);
  await page.press('Enter');
  await page.waitFor(`document.querySelectorAll('.aia-drawer .aia-msg.aia-user').length > ${before}`, { timeoutMs: 15000 });
  await page.waitFor(() => !document.querySelector('.aia-drawer').classList.contains('aia-busy'), { timeoutMs: O.timeoutMs, intervalMs: 250 });
  return page.evaluate(() => {
    const users = document.querySelectorAll('.aia-drawer .aia-msg.aia-user');
    const u = users[users.length - 1];
    const assistants = document.querySelectorAll('.aia-drawer .aia-msg.aia-assistant');
    const a = assistants[assistants.length - 1];
    return {
      receipt: u.querySelector('.aia-sync')?.textContent.trim() || '',
      read: !!u.querySelector('.aia-sync-read'),
      same: !!u.querySelector('.aia-sync-same'),
      hash: u.querySelector('.aia-sync code')?.textContent || '',
      unsent: u.classList.contains('aia-unsent'),
      error: a?.classList.contains('aia-error') ? a.textContent.trim().slice(0, 300) : '',
      answer: a?.querySelector('.aia-md')?.textContent.trim().slice(0, 160) || '',
    };
  });
}

async function main() {
  fs.mkdirSync(O.out, { recursive: true });
  // --auto-accept-this-tab-capture: the browser's "share this tab" prompt is accepted without a person (the vision check).
  const browser = await launchBrowser({ executable: O.browser, headless: !O.headed, width: O.widths[0] || 1366, args: ['--auto-accept-this-tab-capture'] });
  const { page } = browser;
  console.log(`browser: ${browser.executable}\npage:    ${url}\n`);
  try {
    await page.goto(url);
    const mounted = await page.waitFor(() => !!document.querySelector('.aia-drawer'), { timeoutMs: 10000 }).then(() => true, () => false);
    await sleep(800);
    const errors = page.errors();
    record('load', errors.length ? 'fail' : 'pass', errors.length ? errors.map((e) => `${e.text}${e.url ? ` (${e.url})` : ''}`).join(' | ').slice(0, 800) : 'no console errors');
    if (!mounted) {
      record('mount', 'fail', 'no .aia-drawer: the integration module did not run. Check the console errors above, the import paths, and stale cached scripts (hard reload: Ctrl+Shift+R; version your asset URLs).');
      return;
    }
    record('mount', 'pass', await page.evaluate(`(() => { let a = null; try { a = (${O.agent}) || null; } catch {} return a ? 'agent object reachable' : 'drawer present (agent object not reachable: pass --agent for richer checks)'; })()`));

    // Hotkey + flag.
    const wasOpen = (await page.evaluate(STATUS(O.agent))).open;
    if (wasOpen) await page.evaluate(() => document.querySelector('.aia-drawer [data-act="close"]').click());
    await page.evaluate(() => { document.activeElement?.blur?.(); document.body.focus(); });
    const hk = comboToPress(O.hotkey);
    await page.press(hk.key, hk.mods);
    await sleep(400);
    const st = await page.evaluate(STATUS(O.agent));
    record('hotkey', st.open ? 'pass' : 'fail', st.open ? `${O.hotkey} opens the drawer; flag: ${st.state}${st.hash ? ` ${String(st.hash).slice(0, 7)}` : ''} (via ${st.via})` : `${O.hotkey} did not open the drawer (a host handler may swallow it, or a modal dialog makes the drawer inert)`);

    // Toggle.
    const toggle = await page.evaluate((sel) => { const t = [...document.querySelectorAll(sel)].find((x) => !x.classList.contains('aia-launcher')) || document.querySelector(sel); if (!t) return null; const r = t.getBoundingClientRect(); return { w: r.width, h: r.height }; }, O.toggle);
    if (!toggle) {
      record('toggle', 'skip', `no element matches ${O.toggle}`);
    } else {
      await page.evaluate((sel) => { ([...document.querySelectorAll(sel)].find((x) => !x.classList.contains('aia-launcher')) || document.querySelector(sel)).click(); }, O.toggle);
      await sleep(350);
      const closed = !(await page.evaluate(STATUS(O.agent))).open;
      await page.evaluate((sel) => { ([...document.querySelectorAll(sel)].find((x) => !x.classList.contains('aia-launcher')) || document.querySelector(sel)).click(); }, O.toggle);
      await sleep(350);
      const reopened = (await page.evaluate(STATUS(O.agent))).open;
      record('toggle', closed && reopened ? 'pass' : 'fail', closed && reopened ? 'the toggle closes and reopens the drawer' : 'clicking the toggle did not close/reopen the drawer (is it hidden under the drawer, or bound twice?)');
    }

    // Typing (host shortcuts must not swallow keys typed in the composer).
    await page.evaluate(() => { const ta = document.querySelector('.aia-composer textarea'); ta.value = ''; ta.focus(); });
    await page.type('a b k');
    const typed = await page.evaluate(() => { const ta = document.querySelector('.aia-composer textarea'); const v = ta.value; ta.value = ''; return v; });
    record('typing', typed === 'a b k' ? 'pass' : 'fail', typed === 'a b k' ? 'a space and letters land in the composer' : `typed "a b k", the composer holds "${typed}": a host keyboard handler steals keys (key isolation off?)`);

    // Settings > Context size.
    await page.evaluate(() => document.querySelector('.aia-drawer [data-act="inspect"]').click());
    const size = await page.waitFor(() => { const b = document.querySelector('.aia-modal .aia-ctx-size'); return b && /tokens/.test(b.textContent) ? { text: b.querySelector('.aia-note')?.textContent || b.textContent, warn: b.classList.contains('aia-ctx-warn') } : null; }, { timeoutMs: 10000 }).catch(() => null);
    record('context', size ? (size.warn ? 'info' : 'pass') : 'skip', size ? `${size.text.replace(/\s+/g, ' ').slice(0, 220)}${size.warn ? ' — WARNING: large for a local model with a 4k context' : ''}` : 'Settings > Context size not found (runtime older than 1.1?)');
    await page.evaluate(() => document.querySelector('.aia-modal [data-act="close"]')?.click());

    // Tools: the catalog, and the reading tools that need no arguments (they change nothing).
    const tl = await page.evaluate(`(async () => {
      let a = null; try { a = (${O.agent}) || null; } catch {}
      if (!a || !a.tools) return null;
      await a.ready;
      const list = a.tools.list();
      const runs = [];
      for (const t of list.filter((x) => x.effect === 'read' && x.available)) {
        try { runs.push([t.name, 'ok', String(await a.tools.run(t.name, {})).slice(0, 80)]); }
        catch (e) { runs.push([t.name, /^Invalid arguments/.test(e.message) ? 'needs-args' : 'error', e.message]); }
      }
      return { list, runs };
    })()`);
    if (!tl) {
      record('tools', 'skip', 'agent object not reachable (pass --agent)');
    } else if (!tl.list.length) {
      record('tools', 'info', 'no tools registered (the agent can only answer and suggest)');
    } else {
      const on = tl.list.filter((t) => t.enabled).length;
      const here = tl.list.filter((t) => t.available).length;
      const failed = tl.runs.filter((r) => r[1] === 'error');
      const ran = tl.runs.filter((r) => r[1] === 'ok').map((r) => r[0]);
      record('tools', failed.length ? 'fail' : 'pass', `${tl.list.length} tools (${on} on, ${tl.list.length - on} off, ${here} usable here); reading tools ran: ${ran.join(', ') || 'none without arguments'}${failed.length ? `; FAILED: ${failed.map((r) => `${r[0]}: ${r[2]}`).join('; ')}` : ''}`);
    }

    // Capabilities (AI Enablement, runtime 1.6+): agents, skills, toolsets from the capability index, and what did not
    // load. Tool modules that only import in the browser (validate.mjs could not check them) are checked here.
    const cap = await page.evaluate(`(async () => {
      let a = null; try { a = (${O.agent}) || null; } catch {}
      if (!a) return null;
      await a.ready;
      if (!a.capabilities) return { old: true };
      return {
        index: a.capabilities.index(), problems: a.capabilities.problems(),
        agents: a.agents.list().filter((x) => !x.implicit).map((x) => x.name + (x.active ? ' (active)' : '')),
        skills: a.skills.list().map((s) => s.name), toolsets: a.tools.toolsets().map((t) => t.name),
        workspace: a.workspace() ? a.workspace().aiDir : '',
      };
    })()`);
    if (!cap) record('capabilities', 'skip', 'agent object not reachable (pass --agent)');
    else if (cap.old) record('capabilities', 'skip', 'this runtime has no capability index (older than 1.6)');
    else if (!cap.index && !cap.agents.length && !cap.skills.length && !cap.toolsets.length) record('capabilities', 'info', 'no capability index: tools come from the integration itself (adopting ai/index.json is optional)');
    else {
      record('capabilities', cap.problems.length ? 'fail' : 'pass', `${cap.index ? `${cap.index.replace(/^https?:\/\/[^/]+/, '')}: ` : ''}agents ${cap.agents.join(', ') || 'none (one implicit agent)'}; skills ${cap.skills.join(', ') || 'none'}; toolsets ${cap.toolsets.join(', ') || 'none'}${cap.workspace ? `; workspace connected (writes to ${cap.workspace}/)` : ''}${cap.problems.length ? `; PROBLEMS: ${cap.problems.join(' | ').slice(0, 600)}` : ''}`);
    }

    // Memory: what the agent knows from the start.
    const mem = await page.evaluate(`(async () => {
      let a = null; try { a = (${O.agent}) || null; } catch {}
      if (!a) return null;
      await a.ready;
      if (a.memory === undefined) return { old: true };
      if (a.memory === null) return { off: true };
      const list = a.memory.list();
      return { count: list.length, app: list.filter((m) => m.source === 'app').length, enabled: a.settings.get().memoryEnabled, write: a.settings.get().memoryWrite };
    })()`);
    if (!mem) record('memory', 'skip', 'agent object not reachable (pass --agent)');
    else if (mem.old) record('memory', 'skip', 'this runtime has no memory (older than 1.3)');
    else if (mem.off) record('memory', 'info', 'memory is switched off for this app (memory: false)');
    else record('memory', 'pass', `${mem.count} memor${mem.count === 1 ? 'y' : 'ies'} (${mem.app} from the application's memory file)${mem.enabled ? '' : '; switched off in Settings > Memory'}${mem.write ? '' : '; the agent may not save new ones'}`);

    // Vision: one screenshot, taken the way the camera button takes it (the browser here accepts tab sharing itself).
    const vis = await page.evaluate(`(async () => {
      let a = null; try { a = (${O.agent}) || null; } catch {}
      if (!a) return null;
      if (typeof a.screenshot !== 'function') return { old: true };
      const btn = document.querySelector('.aia-shot-btn');
      if (!btn || btn.hidden) return { hidden: true, vision: a.settings.get().vision };
      const before = document.querySelectorAll('.aia-drawer .aia-error').length;
      const shot = await a.screenshot();
      const errors = [...document.querySelectorAll('.aia-drawer .aia-error')].slice(before).map((e) => e.textContent.trim());
      document.querySelectorAll('.aia-attach [data-shot-remove]').forEach((b) => b.click());
      return { shot, errors, auto: a.settings.get().screenshotAuto };
    })()`);
    if (!vis) record('vision', 'skip', 'agent object not reachable (pass --agent)');
    else if (vis.old) record('vision', 'skip', 'this runtime has no screenshots (older than 1.3)');
    else if (vis.hidden) record('vision', 'info', vis.vision ? 'no camera button: screenshots are switched off for this app, or this browser cannot capture the page' : 'vision is switched off (Settings > Vision, or defaults.vision: false): no camera button');
    else if (!vis.shot) record('vision', 'fail', `the screenshot failed: ${vis.errors.join(' | ') || 'no picture came back'}`);
    else record('vision', 'pass', `${vis.shot.width} × ${vis.shot.height} px from ${vis.shot.source === 'app' ? 'the application\'s screenshot hook' : 'the browser\'s screen capture (users are asked to share the tab)'}; the agent may take screenshots on its own: ${vis.auto ? 'yes' : 'no (camera button only)'}`);

    // Attachments: the + menu, and one small text file attached the way the menu attaches it (then removed again).
    const att = await page.evaluate(`(async () => {
      let a = null; try { a = (${O.agent}) || null; } catch {}
      const plus = document.querySelector('.aia-drawer .aia-plus-btn');
      if (!plus) return { old: true };
      if (plus.closest('.aia-plus').hidden) return { off: true };
      plus.click();
      const menu = document.querySelector('.aia-drawer .aia-attach-menu');
      const open = !menu.hidden;
      const items = [...menu.querySelectorAll('.aia-menu-item')].map((b) => (b.querySelector('b')?.textContent || '') + (b.disabled ? ' (off: text-only model)' : ''));
      if (!menu.hidden) plus.click();
      if (!a || typeof a.attach !== 'function') return { open, items, file: null };
      const before = document.querySelectorAll('.aia-drawer .aia-error').length;
      const [r] = await a.attach([new File(['verify.mjs: a test attachment.\\nSecond line.'], 'verify-check.txt', { type: 'text/plain' })]);
      const errors = [...document.querySelectorAll('.aia-drawer .aia-error')].slice(before).map((e) => e.textContent.trim());
      const chip = !!document.querySelector('.aia-drawer .aia-attach .aia-file');
      document.querySelectorAll('.aia-drawer .aia-attach [data-file-remove]').forEach((b) => b.click());
      return { open, items, file: r, chip, errors, maxChars: a.settings.get().maxFileChars };
    })()`);
    if (att.old) record('attachments', 'skip', 'this runtime has no + button (older than 1.5)');
    else if (att.off) record('attachments', 'info', 'attachments are switched off for this app (attachments: false)');
    else if (!att.open || att.items.length !== 2) record('attachments', 'fail', `the + button did not open its menu (items: ${att.items.join(', ') || 'none'})`);
    else if (att.file === null && att.errors?.length) record('attachments', 'fail', `attaching a text file failed: ${att.errors.join(' | ')}`);
    else record('attachments', 'pass', `the + menu offers ${att.items.join(' · ')}${att.file ? `; a text file attached as ${att.file.kind} (${att.file.chars} chars, chip ${att.chip ? 'shown' : 'MISSING'}); Max file content ${Number(att.maxChars).toLocaleString('en-US')} chars` : ' (agent object not reachable: pass --agent to attach a file)'}`);

    // Layout at each width.
    for (const w of O.widths) {
      await page.viewport(w, 900);
      if (!(await page.evaluate(STATUS(O.agent))).open) { await page.press(hk.key, hk.mods); }
      await sleep(700);
      const L = await page.evaluate(LAYOUT(O.toggle));
      const file = await page.screenshot(path.join(O.out, `layout-${w}.png`));
      const problems = [
        ...(L.overflowPx ? [`page ${L.overflowPx}px wider than the window`] : []),
        ...L.pushed, ...L.under.map((u) => `${u}`),
        ...L.toggles.filter((t) => !t.visible).map((t) => `toggle ${t.label} hidden under the drawer`),
      ];
      record(`layout@${w}`, problems.length ? 'fail' : 'pass', `${problems.length ? problems.join('; ') : 'fits beside the drawer'} (screenshot ${path.relative(process.cwd(), file)})`);
    }
    await page.viewport(O.widths[0] || 1366, 900);

    // The settings dialog's layout, on every visible tab (references/settings-layout.md).
    const settings = await checkSettingsLayout(page, { agent: O.agent, out: O.out, sizes: O.settingsSizes });
    if (settings.length === 1 && settings[0].error) {
      record('settings', 'skip', settings[0].error);
    } else {
      for (const tab of [...new Set(settings.map((r) => r.tab))]) {
        const runs = settings.filter((r) => r.tab === tab);
        const problems = runs.flatMap((r) => (r.error ? [{ text: r.error }] : r.problems).map((p) => formatProblem(r, p)));
        const shots = runs.map((r) => r.screenshot).filter(Boolean).map((f) => path.relative(process.cwd(), f)).join(', ');
        const m = runs.find((r) => r.metrics)?.metrics;
        record(`settings:${tab}`, problems.length ? 'fail' : 'pass', `${problems.length ? problems.join(' | ').slice(0, 1600) : `${runs.map((r) => r.size).join(' and ')}: tab strip whole (${m?.tabs}px), labels left, rows full width, checkbox text by its box, nothing centred${m?.overflows ? '; the body scrolls' : ''}`} (screenshots ${shots})`);
      }
    }
    await page.viewport(O.widths[0] || 1366, 900);

    // Questions.
    if (!O.llm) {
      for (const n of ['ask', 'change', 'unchanged']) record(n, 'skip', '--no-llm');
    } else {
      if (!(await page.evaluate(STATUS(O.agent))).open) await page.press(hk.key, hk.mods);
      await page.evaluate(() => document.querySelector('.aia-drawer [data-act="new"]').click());
      await sleep(300);
      const a1 = await ask(page, O.question);
      const s1 = await page.evaluate(STATUS(O.agent));
      if (a1.error || a1.unsent) {
        record('ask', 'fail', `no answer: ${a1.error || 'the question was not sent'}. Is the model running and reachable (Settings > Model > Test connection)?`);
        for (const n of ['change', 'unchanged']) record(n, 'skip', 'no answer to the first question');
      } else {
        record('ask', a1.read && s1.state === 'synced' ? 'pass' : 'fail', `receipt "${a1.receipt}", flag ${s1.state}; answer: "${a1.answer}"`);
        let last = a1;
        if (O.change) {
          await page.evaluate(O.change);
          const dirty = await page.waitFor(`(${STATUS(O.agent)}).state === 'dirty'`, { timeoutMs: 5000 }).then(() => true, () => false);
          const a2 = await ask(page, 'What changed?');
          record('change', dirty && a2.read && a2.hash !== a1.hash ? 'pass' : 'fail', `flag after the change: ${dirty ? 'dirty' : (await page.evaluate(STATUS(O.agent))).state}; next question: "${a2.receipt}"`);
          last = a2;
        } else {
          record('change', 'skip', 'pass --change "<js>" to test the changed -> re-read path');
        }
        const a3 = await ask(page, 'Anything else worth noting? One sentence.');
        record('unchanged', a3.same && a3.hash === last.hash ? 'pass' : 'fail', `receipt "${a3.receipt}"`);
      }
    }
  } finally {
    const late = page.errors().filter((e) => !results.some((r) => r.name === 'load' && r.detail.includes(e.text)));
    if (late.length) record('console', 'fail', `errors during the checks: ${late.map((e) => e.text).join(' | ').slice(0, 600)}`);
    fs.writeFileSync(path.join(O.out, 'report.json'), JSON.stringify({ url, at: new Date().toISOString(), results }, null, 2));
    await browser.close();
  }
}

main().then(() => {
  const failed = results.filter((r) => r.status === 'fail');
  console.log(`\n${failed.length ? `${failed.length} check(s) failed` : 'All checks passed'} · report: ${path.relative(process.cwd(), path.join(O.out, 'report.json'))}`);
  process.exit(failed.length ? 1 : 0);
}, (e) => { console.error(`verify failed: ${e.message}`); process.exit(1); });
