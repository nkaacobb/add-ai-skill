// Small DOM helpers shared by the drawer and the settings panel.

export { esc } from './markdown.js';

/** Build one element from an HTML string. Only ever called with markup this runtime generated and escaped. */
export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function resolveElement(target) {
  if (!target) return null;
  if (typeof target === 'string') return document.querySelector(target);
  return target instanceof Element ? target : null;
}

export function resolveElements(target) {
  if (!target) return [];
  if (typeof target === 'string') return [...document.querySelectorAll(target)];
  if (target instanceof Element) return [target];
  if (typeof target.length === 'number') return [...target].filter((e) => e instanceof Element);
  return [];
}

export function copyText(value) {
  const text = String(value ?? '');
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  fallbackCopy(text);
  return Promise.resolve();
}

function fallbackCopy(text) {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:-1000px;opacity:0';
  document.body.appendChild(area);
  area.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  area.remove();
}

/** Brief confirmation on a button ("Copied"), restored afterwards. */
export function flash(button, label = 'Copied') {
  if (!button || button.dataset.aiaFlashing) return;
  const original = button.textContent;
  button.dataset.aiaFlashing = '1';
  button.textContent = label;
  button.classList.add('aia-done');
  setTimeout(() => {
    button.textContent = original;
    button.classList.remove('aia-done');
    delete button.dataset.aiaFlashing;
  }, 1200);
}

export function formatWhen(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export const uid = (prefix = 'm') => `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const nf = (n) => Number(n || 0).toLocaleString();

/** Run fn at most once per animation frame. */
export function frameThrottle(fn) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    const run = () => { pending = false; fn(); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 50);
  };
}

/**
 * Trailing debounce with an optional max wait: while calls keep coming faster than `ms`, `fn` still runs at least
 * every `maxWait` ms (0 = plain debounce). Without it, an app that changes state every 100 ms (animation, simulation,
 * live data) would never let a 300 ms debounce fire.
 */
export function debounce(fn, ms, { maxWait = 0 } = {}) {
  let t = null;
  let maxT = null;
  let args = [];
  const run = () => {
    clearTimeout(t);
    clearTimeout(maxT);
    t = null;
    maxT = null;
    fn(...args);
  };
  const d = (...a) => {
    args = a;
    clearTimeout(t);
    t = setTimeout(run, ms);
    if (maxWait > 0 && maxT === null) maxT = setTimeout(run, Math.max(ms, maxWait));
  };
  d.cancel = () => { clearTimeout(t); clearTimeout(maxT); t = null; maxT = null; };
  d.flush = () => { if (t !== null) run(); };
  return d;
}

/** True when a key event belongs to text entry (typing, caret movement, editing shortcuts) rather than an app shortcut. */
const EDIT_COMBOS = new Set(['a', 'c', 'v', 'x', 'z', 'y', 'backspace', 'delete', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'enter']);
export function isTypingKey(e) {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return true;                                                 // letters, Space, arrows, Enter, Tab, Escape…
  if (e.ctrlKey && e.altKey && String(e.key).length === 1) return true;  // AltGr characters (Ctrl+Alt on Windows)
  return EDIT_COMBOS.has(String(e.key).toLowerCase());                   // Ctrl/Cmd text editing stays in the field
}

/**
 * Keep keystrokes that start inside the agent's UI away from the host page's bubbling key listeners, so host
 * shortcuts (Space = play, letters, arrows) cannot swallow what the user types in the drawer. App shortcuts with
 * Ctrl/Cmd (Ctrl+S…) still reach the host. `before(e)` runs first, for the runtime's own keys.
 * @returns {() => void} detach
 */
export function isolateKeys(root, before) {
  const onKey = (e) => {
    if (before) before(e);
    if (!e.cancelBubble && isTypingKey(e)) e.stopPropagation();
  };
  const types = ['keydown', 'keypress', 'keyup'];
  for (const t of types) root.addEventListener(t, onKey);
  return () => { for (const t of types) root.removeEventListener(t, onKey); };
}

/**
 * Set a form control the way a user would, so the host's own handlers and validation run: numbers are clamped to
 * the control's min/max/step, the native value setter is used (frameworks that track values, such as React, notice
 * it), and bubbling `input` + `change` events are dispatched. Checkboxes and radios are clicked when they must flip.
 * @returns {boolean} true when the control now holds the value
 */
export function setControlValue(target, value) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return false;
  const type = String(el.type || '').toLowerCase();
  if (type === 'checkbox' || type === 'radio') {
    const want = type === 'radio' ? true : !!value;
    if (el.checked !== want && !el.disabled) el.click();
    return el.checked === want;
  }
  let v = value;
  if (type === 'number' || type === 'range') {
    let n = Number(v);
    if (!Number.isFinite(n)) return false;
    const min = el.min !== '' ? Number(el.min) : -Infinity;
    const max = el.max !== '' ? Number(el.max) : Infinity;
    const step = el.step && el.step !== 'any' ? Number(el.step) : 0;
    if (step > 0) {
      const origin = Number.isFinite(min) ? min : 0;
      n = origin + Math.round((n - origin) / step) * step;
      n = Number(n.toFixed(Math.min(10, (String(step).split('.')[1] || '').length)));
    }
    v = String(Math.min(max, Math.max(min, n)));
  } else if (el.tagName === 'SELECT') {
    const opt = [...el.options].find((o) => o.value === String(v)) || [...el.options].find((o) => o.text.trim().toLowerCase() === String(v).trim().toLowerCase());
    if (!opt) return false;
    v = opt.value;
  }
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, String(v)); else el.value = String(v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return el.value === String(v);
}
