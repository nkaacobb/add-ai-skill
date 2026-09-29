// Drag handle that resizes the drawer by writing one CSS custom property on :root, so everything that depends on
// the drawer width (the drawer itself, the host content pushed aside) moves together.
// Pointer drag with pointer capture, arrow keys nudge (Shift = coarse), Home/End jump to the limits, double-click
// restores the default. The chosen width is remembered per application.

const STEP = 12;
const COARSE_STEP = 40;

const resolveNumber = (value, fallback) => {
  const v = typeof value === 'function' ? value() : value;
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/**
 * @param {HTMLElement} handle
 * @param {{variable: string, value?: number, min?: number|Function, max?: number|Function, storage?: Storage, storageKey?: string}} o
 * @returns {() => void} detach
 */
export function attachResize(handle, o) {
  const root = document.documentElement;
  const fallback = Math.round(resolveNumber(o.value, 460));
  let size = fallback;
  let pointerId = null;
  let startX = 0;
  let startSize = fallback;
  let frame = null;

  const bounds = () => {
    const low = Math.round(resolveNumber(o.min, 320));
    const high = Math.max(low, Math.round(resolveNumber(o.max, 900)));
    return { low, high };
  };

  const readStored = () => {
    if (!o.storage || !o.storageKey) return null;
    try {
      const v = parseFloat(o.storage.getItem(o.storageKey));
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  };

  const writeStored = () => {
    if (!o.storage || !o.storageKey) return;
    try { o.storage.setItem(o.storageKey, String(size)); } catch { /* ignore */ }
  };

  function apply(value, remember) {
    const { low, high } = bounds();
    size = Math.round(Math.min(high, Math.max(low, value)));
    root.style.setProperty(o.variable, `${size}px`);
    handle.setAttribute('aria-valuenow', String(size));
    handle.setAttribute('aria-valuemin', String(low));
    handle.setAttribute('aria-valuemax', String(high));
    if (remember) writeStored();
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startSize = size;
    handle.classList.add('aia-dragging');
    document.body.classList.add('aia-resizing');
    try { handle.setPointerCapture(pointerId); } catch { /* ignore */ }
    e.preventDefault();
  }

  function onMove(e) {
    if (pointerId === null || e.pointerId !== pointerId) return;
    apply(startSize + (startX - e.clientX), false);
    e.preventDefault();
  }

  function onUp(e) {
    if (pointerId === null || (e && e.pointerId !== undefined && e.pointerId !== pointerId)) return;
    try { handle.releasePointerCapture(pointerId); } catch { /* ignore */ }
    pointerId = null;
    handle.classList.remove('aia-dragging');
    document.body.classList.remove('aia-resizing');
    writeStored();
  }

  function onKey(e) {
    const { low, high } = bounds();
    let next;
    if (e.key === 'Home') next = low;
    else if (e.key === 'End') next = high;
    else if (e.key === 'ArrowLeft') next = size + (e.shiftKey ? COARSE_STEP : STEP);
    else if (e.key === 'ArrowRight') next = size - (e.shiftKey ? COARSE_STEP : STEP);
    else return;
    e.preventDefault();
    apply(next, true);
  }

  const onDbl = () => apply(fallback, true);
  const onViewport = () => {
    if (frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; apply(size, false); });
  };

  handle.addEventListener('pointerdown', onDown);
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
  handle.addEventListener('lostpointercapture', onUp);
  handle.addEventListener('dblclick', onDbl);
  handle.addEventListener('keydown', onKey);
  window.addEventListener('resize', onViewport);

  const stored = readStored();
  apply(stored === null ? fallback : stored, false);

  return () => {
    handle.removeEventListener('pointerdown', onDown);
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    handle.removeEventListener('lostpointercapture', onUp);
    handle.removeEventListener('dblclick', onDbl);
    handle.removeEventListener('keydown', onKey);
    window.removeEventListener('resize', onViewport);
  };
}
