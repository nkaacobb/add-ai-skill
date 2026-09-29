// Native modal dialogs vs the drawer (opt-in: createAiAgent({ dialogs: 'dock' })).
//
// dialog.showModal() makes everything outside the dialog inert, the drawer included, so a drawer opened on top of a
// modal cannot be used. With docking on:
//   - while the drawer is open, showModal() on a managed dialog opens it non-modally ("docked") instead;
//   - opening the drawer docks the managed dialogs that are open modally; closing it makes them modal again;
//   - a switch is close() + show()/showModal(), which the host must not mistake for a real close (a close handler
//     may unload a video player, reset a form…). Measured in Chromium, one switch produces two synchronous
//     `beforetoggle` events, then a late `close` event (after other tasks, while the dialog is open again), then one
//     merged `toggle` event (open -> open). All of them are swallowed by window-level capturing listeners, which run
//     before any host listener on the document or the dialog.
// Docked dialogs get the .aia-docked-dialog class: centred in the space left of the drawer (see ai-agent.css).

export const DOCKED_CLASS = 'aia-docked-dialog';
const SAFETY_MS = 2000;   // the late events arrived within ~100 ms in tests; never leave a swallower armed forever

export function createDialogDock({ selector = 'dialog', isDrawerOpen, onChange = () => {} }) {
  const Dialog = globalThis.HTMLDialogElement;
  if (typeof Dialog !== 'function' || typeof Dialog.prototype.showModal !== 'function') {
    return { dock() {}, undock() {}, destroy() {} };
  }
  const nativeShowModal = Dialog.prototype.showModal;
  const managed = new Set();
  const docked = new Set();
  const modalFlag = new WeakMap();        // for browsers without :modal
  let switching = null;                   // the dialog being switched right now (synchronous window)
  const pending = new Map();              // dialog -> { close: bool, toggle: bool, timer }

  const isDialog = (el) => el instanceof Dialog && el.matches(selector);

  function isModal(d) {
    try { return d.matches(':modal'); } catch { /* :modal unsupported */ }
    if (modalFlag.has(d)) return d.open && modalFlag.get(d);
    return d.open && getComputedStyle(d).position === 'fixed';
  }

  /* ------------------------------------------------ swallowing switch events */

  const onBeforeToggle = (e) => { if (switching && e.target === switching) e.stopImmediatePropagation(); };
  const onClose = (e) => {
    const d = e.target;
    const p = pending.get(d);
    if (p?.close && d.open) {           // the late close of a switch: the dialog is open again
      p.close = false;
      settle(d);
      e.stopImmediatePropagation();
      return;
    }
    if (managed.has(d) && !d.open && docked.delete(d)) {   // a real close of a docked dialog
      d.classList.remove(DOCKED_CLASS);
      onChange();
    }
  };
  const onToggle = (e) => {
    const d = e.target;
    const p = pending.get(d);
    if (p?.toggle && e.oldState === e.newState) {
      p.toggle = false;
      settle(d);
      e.stopImmediatePropagation();
    }
  };
  function settle(d) {
    const p = pending.get(d);
    if (p && !p.close && !p.toggle) { clearTimeout(p.timer); pending.delete(d); }
  }

  window.addEventListener('beforetoggle', onBeforeToggle, true);
  window.addEventListener('close', onClose, true);
  window.addEventListener('toggle', onToggle, true);

  /** close() + show()/showModal() without the host noticing a close. */
  function switchTo(d, modal) {
    const scroll = d.scrollTop;
    const old = pending.get(d);
    if (old) clearTimeout(old.timer);
    const p = { close: true, toggle: 'ToggleEvent' in globalThis, timer: 0 };
    p.timer = setTimeout(() => pending.delete(d), SAFETY_MS);
    pending.set(d, p);
    switching = d;
    try {
      d.close();
      if (modal) nativeShowModal.call(d); else d.show();
    } finally {
      switching = null;
    }
    d.scrollTop = scroll;
    modalFlag.set(d, modal);
    d.classList.toggle(DOCKED_CLASS, !modal);
    if (modal) docked.delete(d); else docked.add(d);
  }

  /* ---------------------------------------------------- managing dialogs */

  function manage(d) {
    if (managed.has(d)) return;
    managed.add(d);
    // Per instance: other dialogs (and the prototype) are left alone.
    d.showModal = function showModal() {
      if (isDrawerOpen()) {
        if (d.open) return undefined;
        d.show();
        modalFlag.set(d, false);
        d.classList.add(DOCKED_CLASS);
        docked.add(d);
        onChange();
        return undefined;
      }
      modalFlag.set(d, true);
      const r = nativeShowModal.call(d);
      onChange();
      return r;
    };
  }

  function scan(root = document) {
    if (root.nodeType === 1 && isDialog(root)) manage(root);
    for (const d of root.querySelectorAll?.(selector) || []) if (d instanceof Dialog) manage(d);
  }

  const observer = typeof MutationObserver === 'function' ? new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
    for (const d of [...managed]) if (!d.isConnected) { managed.delete(d); docked.delete(d); }
  }) : null;
  scan();
  observer?.observe(document.documentElement, { childList: true, subtree: true });

  // A dialog opened modally some other way while the drawer is open (e.g. the prototype method): dock it.
  const onOpened = (e) => {
    const d = e.target;
    if (e.newState === 'open' && isDialog(d) && isDrawerOpen() && isModal(d) && switching !== d) {
      manage(d);
      switchTo(d, false);
      onChange();
    }
  };
  window.addEventListener('toggle', onOpened, true);

  return {
    /** The drawer opened: open modal dialogs become docked (non-modal). */
    dock() {
      scan();
      let n = 0;
      for (const d of managed) if (d.open && isModal(d)) { switchTo(d, false); n++; }
      if (n) onChange();
    },
    /** The drawer closed: docked dialogs become modal again. */
    undock() {
      let n = 0;
      for (const d of [...docked]) {
        if (d.isConnected && d.open) { switchTo(d, true); n++; } else { d.classList.remove(DOCKED_CLASS); docked.delete(d); }
      }
      if (n) onChange();
    },
    isDocked: (d) => docked.has(d),
    destroy() {
      this.undock();
      observer?.disconnect();
      for (const d of managed) delete d.showModal;   // back to the prototype method
      managed.clear();
      for (const p of pending.values()) clearTimeout(p.timer);
      window.removeEventListener('beforetoggle', onBeforeToggle, true);
      window.removeEventListener('close', onClose, true);
      window.removeEventListener('toggle', onToggle, true);
      window.removeEventListener('toggle', onOpened, true);
    },
  };
}

/** Is a modal dialog open right now (the drawer would be inert behind it)? */
export function modalDialogOpen() {
  try { return !!document.querySelector('dialog:modal'); } catch { return false; }
}
