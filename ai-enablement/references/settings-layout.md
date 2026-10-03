# The settings dialog's layout, and host CSS

The agent's settings dialog (tabs Model, Agent, Tools, Memory, Vision, Context) lives inside the host page, so the
page's own stylesheet can reach it. Runtime 1.6.1 keeps it out and pins the dialog's frame. This page is the spec the
CSS must produce on every tab, how it is enforced, and how it is checked. The same spec is a comment block above the
modal rules in `assets/ai-agent/ai-agent.css`: change both together.

## The spec

- **Header**: icon, title and subtitle at the left; the close button at the right. Never shrinks.
- **Tab strip**:
  - Directly under the header, left-aligned, always fully visible.
  - Fixed order: Model, Agent, Tools, Memory, Vision, Context. Hidden tabs collapse with no gap.
  - The active tab has a border and the accent text colour. Never shrinks and never scrolls vertically.
- **Body**: the only part that scrolls. A vertical stack of full-width section cards (`.aia-section`) 12px apart,
  each with ~13–14px padding.
- **Alignment**: everything inside a card is left-aligned. Nothing is centred except the glyphs inside buttons.
- **Field** (`.aia-field`): a small uppercase muted label (`.aia-label`) on its own line at the card's top-left (an
  optional soft-case suffix such as "(optional)", `.aia-label-soft`). The control sits below it and spans the full
  card width.
- **Input + action button** (`.aia-row`: Server address + Default, Model + Load models, API key + Show): the input
  fills the remaining width. The button keeps its natural width, sits flush right and matches the input height, with
  a 7px gap.
- **Paired fields** (`.aia-grid`: Temperature / Max reply tokens, Thinking / Conversation memory): a two-column grid
  that drops to one column on narrow cards.
- **Help text** (`.aia-note`): left-aligned, muted, ~11.5px, directly under the control it explains, full width.
- **Checkbox row** (`.aia-check`): the box at the far left, the text immediately to its right (8px gap), wrapped
  lines aligned under the text.
- **Section header with actions** (`.aia-label-row`: System prompt + Restore app default; "Tools · 13 of 14 on" +
  Reading tools on / All on / All off): the title left, the buttons right on the same line, wrapping below when
  narrow.
- **Buttons and inputs**: only the runtime's styles (font, radius, border, background, padding). Host styling never
  shows through.
- **Footer**: status text left; Restore defaults and Save right-aligned. Never shrinks.

## How the CSS holds it

Two marked blocks in `ai-agent.css` ("layout guards"), plus a rule for every other runtime rule:

| Guard | Where | What it does |
| --- | --- | --- |
| `/* aia-guard: pinned-chrome */` | above the modal rules | `.aia-modal-head`, `.aia-tabs`, `.aia-modal-foot` get `flex-shrink: 0`; `.aia-modal-body` gets `flex: 1 1 auto; min-height: 0; overflow-y: auto`. The card is a flex column, and `.aia-tabs` scrolls sideways, so its automatic minimum height is 0: without the guard a tall tab (Tools, Memory, Context) took height from the tab strip as well as the body, and clipped the tabs behind it (23px of 45px in one app). |
| `/* aia-guard: host-isolation */` | right after the theme tokens, before every other rule | `.aia-scope :where(div, span, p, label, input, select, button, h1…h6, ul, li, section, header, form, details, summary, pre, code, table…) { all: revert; }`, the same for their `::before`/`::after`, and `::placeholder`: inside the agent's UI every element starts from the browser's own styles, whatever the page's element rules say. `all` leaves custom properties (the theme) alone; `[hidden]` still wins (`!important`). `svg` and `img` are left out (`revert` would drop their presentation attributes); the icons' paint is restated for `svg[stroke]` instead. |

The block's specificity is (0,1,0): it beats host rules on bare elements (`label`, `button`, `p` are (0,0,1)) and
loses to every runtime rule after it. Every runtime rule is written `.aia-scope .aia-x` — (0,2,0) or more; the
drawer, modal and launcher themselves `.aia-scope.aia-x` — so it also beats host rules with one class, attribute or
state in them (`input[type=number]`, `button:hover`, `.dark label`), and it **states the properties it depends on**
instead of relying on browser defaults (`.aia-field` sets `align-items: stretch; justify-content: flex-start;
text-align: left; margin: 0`, every button sets its margin, font, transform and shadow…). No `!important` except
`[hidden]`. No Shadow DOM.

What still gets through, by design or because CSS cannot stop it:

- Host rules more specific than the runtime's (two classes and an element, an id, `!important`) on properties the
  runtime rule does not state. Rare for element rules; when it happens, `verify.mjs` names the rule.
- Inherited text properties set on the scope elements by an `!important` host rule.
- In an app whose **edited** runtime copy got the guard blocks patched in (`scripts/guards.mjs --apply`), host rules
  with an attribute or state (`input[type=checkbox] { margin }`, `button:hover { transform }`) can still beat that
  copy's older (0,1,0) component rules: only 1.6.1's own rules are raised. Reconcile the app's edits onto the new
  runtime when you can.

## Restyling the agent from the app

- Theme with the `--aia-*` variables on `.aia-scope` (`api.md`, "Theming and host hooks"): unchanged, and the way to
  go.
- To restyle a runtime class, write the rule the way the runtime does — `.aia-scope .aia-btn-primary { … }` — in a
  stylesheet loaded after `ai-agent.css`. A single-class rule (`.aia-btn-primary { … }`) no longer wins (it did by
  load order before 1.6.1).
- Never fix the dialog's layout from the app (`flex-shrink` on `.aia-tabs`, `!important` on `.aia-field`): those
  were workarounds for what the guards now do (`upgrading.md`, U5).

## How it is checked

- `node <skill>/scripts/verify.mjs <url>` — the **settings** check opens Settings (`agent.openSettings(tab)`) and
  visits every visible tab at 1920×1080 and 1280×600: the tab strip whole (`scrollHeight <= clientHeight + 1`) and
  every tab inside it and the card; the footer and Save inside the card; full-width cards; each `.aia-label` within
  2px of its card's (or grid column's) left content edge; each `.aia-row` as wide as its field (±1px) with its input
  at least half of it; each checkbox's text within 12px of the box; nothing in the body centred (buttons and the
  browser's own controls excepted). A failure names the tab, the element and the host rule that decides the value
  (the declaration is taken out and put back to see whether it changes the computed value). Screenshots:
  `.verify/settings-<tab>.png` (1920×1080) and `settings-<tab>-1280x600.png`.
- `devWarnings` (on for local hosts): when the dialog opens and on each tab, the runtime compares computed styles
  with the spec (`ui/layout-check.js`) and warns in the console, naming the element: host CSS is leaking. It never
  changes the page.
- `scripts/detect.mjs` reports each runtime copy's guards (`layoutGuards`: `pinnedChrome`, `hostIsolation`) and, for
  information, the host's global element rules the dialog has to withstand (`hostRules`).
- Tests: `tests/browser.test.mjs` loads the runtime under `tests/fixtures/hostile-host/hostile.css` (every rule
  above and more) with enough tools, memories and screen content to overflow every tab, runs the same checks, and
  compares every element's geometry and styles with and without the host stylesheet (identical);
  `tests/fixtures/hostile-host/index.html` is the same page for `verify.mjs` (`?rules=off` is the control run).
