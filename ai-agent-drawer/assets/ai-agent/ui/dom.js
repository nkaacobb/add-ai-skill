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

export function debounce(fn, ms) {
  let t = null;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}
