// Dev-time check of the `push` layout. `push` gives the host container padding-right, but a shell with fixed-width
// grid columns or a wide min-content header (many toolbar buttons) does not shrink into what is left: it overflows,
// and content slides under the drawer (clipped side panels, hidden header buttons, sometimes the toggle itself).
// After the drawer opens, this looks for that and explains the fix in the console. It never changes the page.

const MAX_ELEMENTS = 3000;
const MAX_REPORTED = 6;

/** Development hosts: where the dev-time warnings are on by default (`devWarnings: 'auto'`). */
export function isDevHost(loc = globalThis.location) {
  if (!loc) return false;
  if (loc.protocol === 'file:') return true;
  const h = String(loc.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\./.test(h) || /\.(localhost|test|local)$/.test(h);
}

function label(el) {
  let s = el.tagName.toLowerCase();
  if (el.id) s += `#${el.id}`;
  const cls = [...el.classList].filter((c) => !c.startsWith('aia-')).slice(0, 2);
  if (cls.length) s += `.${cls.join('.')}`;
  return s;
}

/**
 * @param {object} o
 * @param {Element[]} o.targets   the pushed elements
 * @param {Element} o.drawer
 * @param {Element[]} o.toggles
 * @returns {{problems: Array<{kind: string, element?: Element, text: string}>}}
 */
export function checkPushLayout({ targets, drawer, toggles = [] }) {
  const problems = [];
  const edge = drawer.getBoundingClientRect().left;
  const vw = document.documentElement.clientWidth;
  if (!(edge > 0) || edge >= vw) return { problems };   // overlay on narrow screens, or not open

  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollWidth > vw + 1) {
    problems.push({ kind: 'page', element: doc, text: `The page is ${doc.scrollWidth - vw}px wider than the window while the drawer is open (horizontal scrolling).` });
  }

  for (const t of targets) {
    if (t === document.body || t === document.documentElement) continue;
    if (t.scrollWidth > t.clientWidth + 1) {
      problems.push({ kind: 'target', element: t, text: `${label(t)} (the push target) overflows by ${t.scrollWidth - t.clientWidth}px: its content does not shrink into the space left of the drawer.` });
    }
  }

  // Elements (inside the pushed containers) that reach under the drawer. Clipping containers are checked but not
  // entered: what they clip is scrollable, not hidden under the drawer.
  const flagged = [];
  let seen = 0;
  const queue = targets.map((t) => [...t.children]).flat();
  while (queue.length && seen < MAX_ELEMENTS && flagged.length < MAX_REPORTED) {
    const el = queue.shift();
    seen++;
    if (el.closest('.aia-scope') || flagged.some((f) => f.contains(el))) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (r.right > edge + 1 && r.left < edge - 1 && cs.position !== 'fixed') {
      flagged.push(el);
      problems.push({ kind: 'under', element: el, text: `${label(el)} extends ${Math.round(r.right - edge)}px under the drawer.` });
      continue;
    }
    if (cs.overflowX === 'visible' || cs.overflowX === '') queue.push(...el.children);
  }

  for (const t of toggles) {
    if (t.closest('.aia-scope')) continue;
    const r = t.getBoundingClientRect();
    if (r.width === 0 || r.left >= edge - 1 || r.right > edge + 1) {
      problems.push({ kind: 'toggle', element: t, text: `The toggle ${label(t)} is hidden under the drawer (or not visible), so it cannot close it.` });
    }
  }
  return { problems };
}

export const PUSH_HELP = `Fix it with host CSS scoped to html.aia-drawer-open (supported hooks: the html.aia-drawer-open class and the
--aia-push-width / --aia-drawer-width variables), for example:
  html.aia-drawer-open .app-shell  { grid-template-columns: minmax(0, 1fr); }        /* the pushed container */
  html.aia-drawer-open .app-header { grid-template-rows: minmax(56px, auto); }       /* let the header grow… */
  html.aia-drawer-open .toolbar    { flex-wrap: wrap; }                              /* …and its actions wrap */
  html.aia-drawer-open .layout     { grid-template-columns: minmax(0, 280px) minmax(0, 1fr) minmax(0, 320px); }
  html.aia-drawer-open .fixed-bar  { right: var(--aia-push-width); }                 /* fixed elements are not pushed */
Turn this check off with createAiAgent({ devWarnings: false }).`;
