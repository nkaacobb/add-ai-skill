// Dev-time checks (`devWarnings`). They explain a problem in the console and never change the page.
// - The `push` layout. `push` gives the host container padding-right, but a shell with fixed-width grid columns or a
//   wide min-content header (many toolbar buttons) does not shrink into what is left: it overflows, and content
//   slides under the drawer (clipped side panels, hidden header buttons, sometimes the toggle itself). Checked after
//   the drawer opens.
// - The settings dialog's layout (references/settings-layout.md). The runtime's CSS isolates it from the host page's
//   element rules; when computed styles still break the spec, host CSS is leaking in (or ai-agent.css is an older or
//   edited copy). Checked when the dialog opens and on each tab.

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

const START = ['flex-start', 'start', 'normal', 'left'];
const LEFT = ['left', 'start', '-webkit-left'];

/** What the settings dialog's computed styles must be (references/settings-layout.md): [selector, property, allowed, why]. */
const SETTINGS_SPEC = [
  ['.aia-modal-head, .aia-tabs, .aia-modal-foot', 'flex-shrink', ['0'], 'the header, tab strip and footer never shrink'],
  ['.aia-modal-body', 'min-height', ['0px'], 'only the body gives up height (and scrolls)'],
  ['.aia-tabs', 'justify-content', START, 'the tabs sit at the left'],
  ['.aia-section', 'align-items', ['stretch', 'normal'], 'cards stack full width'],
  ['.aia-field', 'align-items', ['stretch', 'normal'], 'the label and the control span the card'],
  ['.aia-field', 'justify-content', START, 'the label sits at the top-left of its card'],
  ['.aia-check', 'justify-content', START, 'the text sits right after its checkbox'],
  ['.aia-check', 'align-items', ['flex-start', 'start'], 'wrapped lines stay under the text'],
  ['.aia-row', 'display', ['flex'], 'an input and its button share one row'],
  ['.aia-row', 'justify-content', START, 'the input fills the row from the left'],
  ['.aia-section, .aia-field, .aia-label, .aia-note, .aia-h3, .aia-check', 'text-align', LEFT, 'everything in a card is left-aligned'],
  ['.aia-btn, .aia-tab, .aia-icon-btn', 'text-transform', ['none'], 'buttons look the same in every app'],
  ['.aia-btn, .aia-tab, .aia-icon-btn', 'letter-spacing', ['normal', '0px'], 'buttons look the same in every app'],
];

/**
 * Dev-time check of the open settings dialog against its layout spec: computed styles that only host CSS (or an
 * older or edited ai-agent.css) can have changed, and a tab strip squeezed by the body.
 * @param {Element} root   the settings dialog (.aia-modal)
 * @returns {{problems: Array<{element: Element, text: string}>}}
 */
export function checkSettingsLayout(root) {
  const problems = [];
  if (!root || root.hidden) return { problems };
  const panel = root.querySelector('[data-panel]:not([hidden])');
  for (const [selector, prop, allowed, why] of SETTINGS_SPEC) {
    // The chrome, and what is on the open tab; one report per rule is enough to find the cause.
    const el = [...root.querySelectorAll(selector)].find((x) => x.getClientRects().length && (!x.closest('[data-panel]') || x.closest('[data-panel]') === panel)
      && !allowed.includes(getComputedStyle(x).getPropertyValue(prop)));
    if (el) problems.push({ element: el, text: `${label(el)}.${[...el.classList].filter((c) => c.startsWith('aia-')).join('.')} has ${prop}: ${getComputedStyle(el).getPropertyValue(prop)} (expected ${allowed[0]}: ${why})` });
  }
  const tabs = root.querySelector('.aia-tabs');
  if (tabs && tabs.scrollHeight > tabs.clientHeight + 1) {
    problems.push({ element: tabs, text: `the tab strip is ${tabs.clientHeight}px tall but its tabs need ${tabs.scrollHeight}px: the tabs are clipped behind the body` });
  }
  return { problems };
}

export const SETTINGS_HELP = `Host CSS is leaking into the agent's settings dialog: a page rule on bare elements (label, button, input,
select, p, h2…) or one that restyles .aia- classes reaches it. Runtime 1.6.1+ keeps it out (ai-agent.css,
"aia-guard: host-isolation" and "aia-guard: pinned-chrome"): check that the app loads a current, unedited
ai-agent.css, and that no app stylesheet overrides .aia- rules. The skill's scripts/verify.mjs names the host rule
behind each problem; the spec is references/settings-layout.md in the skill.
Turn this check off with createAiAgent({ devWarnings: false }).`;
