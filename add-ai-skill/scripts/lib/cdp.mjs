// A small Chrome DevTools Protocol driver for headless Edge / Chrome / Chromium. Zero dependencies: Node 22+ has a
// global WebSocket and fetch. Used by scripts/verify.mjs and tests/browser.test.mjs.
//
//   const browser = await launchBrowser();          // finds Edge/Chrome, or pass { executable }
//   const page = browser.page;
//   await page.goto('http://127.0.0.1:8787/');
//   await page.evaluate(() => document.title);
//   await page.press('Space');  await page.press('i', { ctrl: true });
//   await browser.close();

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exists = (p) => { try { return !!p && fs.statSync(p).isFile(); } catch { return false; } };

/** Path of an installed Chromium-based browser, or '' when none is found. */
export function findBrowser(explicit = '') {
  const env = explicit || process.env.AIA_BROWSER || process.env.CHROME_PATH || '';
  if (env) return exists(env) ? env : '';
  const list = [];
  if (process.platform === 'win32') {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      list.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      list.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      list.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) {
        list.push(path.join(dir, name));
      }
    }
  }
  return list.find(exists) || '';
}

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
const KEYS = {
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
};

function keyInfo(name) {
  if (KEYS[name]) return KEYS[name];
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : '';
    return { key: name, code, keyCode: upper.charCodeAt(0), text: name };
  }
  return { key: name, code: name, keyCode: 0 };
}

class Page {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.console = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.handlers.get(msg.method) || []) { try { fn(msg.params); } catch { /* ignore */ } }
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs);
      const off = this.on(method, (p) => { clearTimeout(t); off(); resolve(p); });
    });
  }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    const ignore = (url) => /^(chrome|edge|devtools)(-extension)?:/.test(String(url || ''));
    this.on('Runtime.consoleAPICalled', (p) => {
      const text = p.args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description || a.type)).join(' ');
      const url = p.stackTrace?.callFrames?.[0]?.url || '';
      if (!ignore(url)) this.console.push({ level: p.type, text, url });
    });
    this.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      if (!ignore(d.url)) this.console.push({ level: 'exception', text: d.exception?.description || d.text, url: d.url || '' });
    });
    this.on('Log.entryAdded', ({ entry }) => {
      if (!ignore(entry.url)) this.console.push({ level: entry.level, text: entry.text, url: entry.url || '' });
    });
  }

  /** Console errors, uncaught exceptions and failed loads since the last reset (browser-extension noise ignored). */
  errors() { return this.console.filter((c) => (c.level === 'error' || c.level === 'exception') && !/\/favicon\.ico(\?|$)/.test(c.url)); }

  async goto(url, { timeoutMs = 30000 } = {}) {
    const loaded = this.once('Page.loadEventFired', timeoutMs);
    const r = await this.send('Page.navigate', { url });
    if (r.errorText) throw new Error(`Could not load ${url}: ${r.errorText}`);
    await loaded;
  }

  /** Evaluate a function (serialised with its arguments) or an expression in the page; promises are awaited. */
  async evaluate(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})`
      : String(fnOrExpr);
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`Page error: ${d.exception?.description || d.text}`);
    }
    return r.result.value;
  }

  async waitFor(fnOrExpr, { timeoutMs = 10000, intervalMs = 50, args = [] } = {}) {
    const end = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try { last = await this.evaluate(fnOrExpr, ...args); } catch (e) { last = e; }
      if (last && !(last instanceof Error)) return last;
      if (Date.now() > end) throw new Error(`Timed out waiting for ${typeof fnOrExpr === 'function' ? 'condition' : fnOrExpr}${last instanceof Error ? ` (${last.message})` : ''}`);
      await sleep(intervalMs);
    }
  }

  /** Press one key the way a user would (keydown, text input, keyup). */
  async press(name, mods = {}) {
    const k = keyInfo(name);
    const modifiers = Object.entries(MODIFIERS).reduce((n, [m, bit]) => (mods[m] ? n | bit : n), 0);
    const typing = k.text && !(modifiers & (MODIFIERS.ctrl | MODIFIERS.meta | MODIFIERS.alt));
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: typing ? 'keyDown' : 'rawKeyDown', ...base, ...(typing ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }

  async type(text) { for (const ch of text) await this.press(ch === ' ' ? 'Space' : ch); }

  async click(selector) {
    const box = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, selector);
    if (!box) throw new Error(`No element matches ${selector}`);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }

  async viewport(width, height = 900) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Start a headless browser with a throwaway profile and connect to its first tab.
 * @returns {Promise<{page: Page, executable: string, close: () => Promise<void>}>}
 */
export async function launchBrowser({ executable = '', headless = true, width = 1366, height = 900, timeoutMs = 20000 } = {}) {
  const exe = findBrowser(executable);
  if (!exe) throw new Error('No Chromium-based browser found (Edge, Chrome or Chromium). Set AIA_BROWSER to its path.');
  if (typeof WebSocket !== 'function') throw new Error('This needs Node 22 or newer (global WebSocket).');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-cdp-'));
  const args = [
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--disable-component-update', '--disable-default-apps',
    '--disable-features=Translate,MediaRouter,OptimizationHints', `--window-size=${width},${height}`,
    ...(headless ? ['--headless=new'] : []), 'about:blank',
  ];
  const child = spawn(exe, args, { stdio: 'ignore' });
  child.on('error', () => { /* reported by the timeout below */ });
  // The browser writes its debugging port into the profile. (Reading stderr is not enough: Edge on Windows may hand
  // over to a relaunched process and exit with 0.)
  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = '';
  let browserPath = '';
  const until = Date.now() + timeoutMs;
  while (!port) {
    try { [port, browserPath] = fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/); } catch { /* not yet */ }
    if (!port && Date.now() > until) throw new Error(`The browser did not start within ${timeoutMs / 1000} s (${exe}).`);
    if (!port) await sleep(100);
  }
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
    if (!target) await sleep(100);
  }
  if (!target) throw new Error('The browser has no page to drive.');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  const page = new Page(ws);
  await page.init();
  await page.viewport(width, height);

  let closed = false;
  return {
    page,
    executable: exe,
    async close() {
      if (closed) return;
      closed = true;
      try { ws.close(); } catch { /* ignore */ }
      // Close the whole browser over its own endpoint (works even when the launched process already handed over).
      try {
        const bws = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
        await new Promise((resolve, reject) => { bws.addEventListener('open', resolve, { once: true }); bws.addEventListener('error', reject, { once: true }); });
        bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
        await new Promise((r) => { bws.addEventListener('close', r, { once: true }); setTimeout(r, 3000); });
      } catch { /* fall back to killing the process */ }
      if (child.exitCode === null) child.kill();
      await new Promise((r) => { if (child.exitCode !== null) r(); else { child.once('exit', r); setTimeout(r, 3000); } });
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(profile, { recursive: true, force: true }); break; } catch { await sleep(200); }
      }
    },
  };
}

/** A static file server for a folder, on 127.0.0.1 and a free port. Returns { url, close }. */
export async function serveStatic(root, { headers = {} } = {}) {
  const http = await import('node:http');
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let rel;
    try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    let file = path.resolve(base, `.${rel}`);
    if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
    try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', ...headers });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
