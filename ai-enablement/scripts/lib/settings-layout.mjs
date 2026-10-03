// The settings dialog's layout spec (references/settings-layout.md), checked in a real browser. Shared by
// scripts/verify.mjs (the `settings` check) and tests/browser.test.mjs (the hostile-host regression test).
//
//   const results = await checkSettingsLayout(page, { agent: 'window.agent', out: '.verify' });
//   // [{ tab, size: '1280x600', problems: [{ kind, element, text, culprit }], metrics, screenshot }]
//
// Per visible tab and window size it checks that the tab strip is whole and inside the card, the footer and Save are
// inside the card, labels sit at the left of their card (or grid column), rows of an input and a button are as wide
// as their field with the input taking at least half, checkbox text starts right after its box, and nothing in the
// body is centred except what is on the allow-list. A problem names the element and the host CSS rule that probably
// caused it (a matching rule outside the runtime's own stylesheet that sets the property).

import path from 'node:path';
import { sleep } from './cdp.mjs';

export const SETTINGS_SIZES = [[1920, 1080], [1280, 600]];

/** Elements that may be centred: glyphs inside buttons (and the controls the browser itself centres). */
export const ALLOW_CENTER = 'button, button *, .aia-btn, .aia-icon-btn, .aia-mark, .aia-mark *, option, input[type="checkbox"], input[type="radio"], input[type="color"], input[type="file"], [data-aia-allow-center], [data-aia-allow-center] *';

/**
 * Evaluated in the page (self-contained: it is serialised). Checks the open settings dialog as it is now.
 * @param {{ allowCenter: string, maxProblems?: number }} opts
 */
export function probeSettingsLayout(opts) {
  const modal = [...document.querySelectorAll('.aia-modal')].find((m) => !m.hidden);
  if (!modal) return { error: 'the settings dialog is not open' };
  const card = modal.querySelector('.aia-modal-card');
  const head = card?.querySelector('.aia-modal-head');
  const tabs = card?.querySelector('.aia-tabs');
  const body = card?.querySelector('.aia-modal-body');
  const foot = card?.querySelector('.aia-modal-foot');
  if (!card || !tabs || !body || !foot) return { error: 'this runtime\'s settings dialog has no .aia-modal-card / .aia-tabs / .aia-modal-body / .aia-modal-foot' };
  const tab = tabs.querySelector('[aria-selected="true"]')?.dataset.tab || '?';
  const max = opts.maxProblems || 12;
  const problems = [];

  const R = (el) => el.getBoundingClientRect();
  const css = (el) => getComputedStyle(el);
  const shown = (el) => !!el && el.getClientRects().length > 0 && css(el).visibility !== 'hidden' && (R(el).width > 0 || R(el).height > 0);
  const px = (v) => parseFloat(v) || 0;
  // The content box (inside borders, padding and a scrollbar).
  const content = (el) => {
    const s = css(el);
    const left = R(el).left + el.clientLeft + px(s.paddingLeft);
    const width = el.clientWidth - px(s.paddingLeft) - px(s.paddingRight);
    return { left, right: left + width, width };
  };
  const inside = (a, b, tol = 1) => a.left >= b.left - tol && a.right <= b.right + tol && a.top >= b.top - tol && a.bottom <= b.bottom + tol;
  const name = (el) => {
    const cls = [...el.classList].slice(0, 2).map((c) => `.${c}`).join('');
    const text = (el.matches('input, select, textarea') ? (el.dataset.f || el.getAttribute('aria-label') || el.type) : el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls}${text ? ` "${text}"` : ''}`;
  };

  // The host CSS rule that probably did it: the last rule (document order) outside the runtime's stylesheet that
  // matches the element — or, for inherited properties, its nearest ancestor with one — sets the property, and
  // decides it: without that declaration the element's computed value would be different (a rule the runtime's own
  // CSS already overrides is not the cause). The declaration is taken out and put back at once, unchanged.
  const INHERITED = new Set(['text-align', 'color', 'font', 'font-size', 'font-family', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'white-space']);
  let hostRules = null;
  const collect = () => {
    const out = [];
    const isRuntimeSheet = (sheet) => /(^|\/)ai-agent\.css(\?|#|$)/.test(sheet.href || '');
    const walk = (rules, sheet, runtimeBundle) => {
      for (const rule of rules) {
        if (rule.styleSheet) { try { walk(rule.styleSheet.cssRules, rule.styleSheet, false); } catch { /* cross-origin */ } continue; }
        if (rule.media && rule.cssRules) { if (matchMedia(rule.media.mediaText).matches) walk(rule.cssRules, sheet, runtimeBundle); continue; }
        if (rule.cssRules && !rule.selectorText) { walk(rule.cssRules, sheet, runtimeBundle); continue; }
        if (!rule.selectorText || !rule.style) continue;
        // In a bundle that also holds the runtime's CSS, the runtime's own rules are the ones naming aia- classes.
        if (runtimeBundle && /aia-/.test(rule.selectorText)) continue;
        const where = sheet.href ? sheet.href.split(/[?#]/)[0].split('/').pop() : 'an inline <style>';
        out.push({ rule, where });
      }
    };
    for (const sheet of document.styleSheets) {
      if (isRuntimeSheet(sheet)) continue;
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      const runtimeBundle = [...rules].some((r) => r.selectorText === ':where(.aia-scope)');
      walk(rules, sheet, runtimeBundle);
    }
    return out;
  };
  const decides = (el, rule, prop) => {
    const before = css(el).getPropertyValue(prop);
    const text = rule.style.cssText;
    try {
      rule.style.removeProperty(prop);
      return css(el).getPropertyValue(prop) !== before;
    } catch { return true; } finally { rule.style.cssText = text; }
  };
  const culprit = (el, props) => {
    hostRules ||= collect();
    for (let node = el, depth = 0; node && node.nodeType === 1; node = node.parentElement, depth++) {
      const wanted = depth === 0 ? props : props.filter((p) => INHERITED.has(p));
      if (!wanted.length) break;
      for (let i = hostRules.length - 1; i >= 0; i--) {
        const { rule, where } = hostRules[i];
        let match = false;
        try { match = node.matches(rule.selectorText); } catch { /* a selector this browser cannot match */ }
        if (!match) continue;
        const set = wanted.filter((p) => rule.style.getPropertyValue(p) !== '' && decides(el, rule, p));
        if (set.length) return `${rule.selectorText} { ${set.map((p) => `${p}: ${rule.style.getPropertyValue(p)}`).join('; ')} } (${where}${depth ? `, inherited from ${node.tagName.toLowerCase()}` : ''})`;
      }
    }
    return '';
  };
  const add = (kind, el, text, props = [], fallback = '') => {
    if (problems.length >= max) return;
    problems.push({ kind, element: el ? name(el) : '', text, culprit: (el && props.length ? culprit(el, props) : '') || fallback });
  };

  // 1. The tab strip: whole (no vertical overflow), every visible tab inside the strip and the card.
  const cardR = R(card);
  const tabsR = R(tabs);
  const pinHint = 'the runtime\'s ai-agent.css lacks the pinned-chrome guard (flex-shrink: 0 on .aia-tabs; min-height: 0 on .aia-modal-body): update the runtime to 1.6.1+ or run scripts/guards.mjs --apply';
  if (tabs.scrollHeight > tabs.clientHeight + 1) {
    add('tabs', tabs, `the tab strip is ${Math.round(tabsR.height)}px tall but its tabs need ${tabs.scrollHeight}px: tabs are clipped behind the body`, ['flex-shrink', 'flex', 'height', 'max-height'], css(tabs).flexShrink !== '0' ? pinHint : '');
  }
  for (const t of tabs.querySelectorAll('[role="tab"], .aia-tab')) {
    if (t.hidden || !shown(t)) continue;
    const r = R(t);
    if (!inside(r, tabsR) || !inside(r, cardR)) add('tab', t, `the ${t.textContent.trim()} tab is not fully inside the tab strip (tab ${Math.round(r.top)}–${Math.round(r.bottom)}px, strip ${Math.round(tabsR.top)}–${Math.round(tabsR.bottom)}px)`, ['flex-shrink', 'flex', 'height', 'margin', 'padding'], css(tabs).flexShrink !== '0' ? pinHint : '');
  }
  if (head && !inside(R(head), cardR)) add('head', head, 'the dialog header is not inside the card', ['flex-shrink', 'height']);

  // 2. The footer and Save.
  if (!inside(R(foot), cardR)) add('foot', foot, 'the footer is not inside the card', ['flex-shrink', 'height', 'margin'], css(foot).flexShrink !== '0' ? pinHint : '');
  const save = foot.querySelector('[data-act="save"]');
  if (save && !save.hidden && shown(save) && !inside(R(save), cardR)) add('save', save, 'the Save button is not inside the card', ['margin', 'width', 'transform']);

  const panel = body.querySelector('[data-panel]:not([hidden])') || body;
  const sections = [...panel.querySelectorAll('.aia-section')].filter(shown);

  // 3. Full-width cards; labels at the left of their card, or of their column in a paired-fields grid.
  const bodyBox = content(body);
  for (const section of sections) {
    if (section.parentElement === panel) {
      const r = R(section);
      if (Math.abs(r.left - bodyBox.left) > 1 || Math.abs(r.width - bodyBox.width) > 1) add('section', section, `the card is ${Math.round(r.width)}px wide at ${Math.round(r.left - bodyBox.left)}px from the body's edge (cards span the body: ${Math.round(bodyBox.width)}px)`, ['max-width', 'width', 'margin', 'margin-left', 'padding', 'align-items'], culprit(panel, ['max-width', 'width', 'margin', 'padding', 'align-items']));
    }
    const box = content(section);
    for (const label of section.querySelectorAll('.aia-label')) {
      if (!shown(label) || label.closest('.aia-section') !== section) continue;
      const cell = label.closest('.aia-grid > *');
      const left = cell && section.contains(cell) ? R(cell).left : box.left;
      const d = R(label).left - left;
      if (Math.abs(d) > 2) add('label', label, `the label starts ${Math.round(d)}px ${d > 0 ? 'right' : 'left'} of its card's left edge (it must sit at the top-left)`, ['justify-content', 'align-items', 'text-align', 'margin-left', 'padding-left', 'display', 'width']);
    }
  }

  // 4. Rows of a control and its buttons: as wide as their field (or card); a text input takes at least half.
  for (const row of panel.querySelectorAll('.aia-row')) {
    if (!shown(row) || row.parentElement.closest('.aia-label-row') || row.parentElement.classList.contains('aia-label-row')) continue;
    const holder = row.parentElement.matches('.aia-field, .aia-section, .aia-advanced-body') ? row.parentElement : null;
    if (!holder) continue;
    const want = content(holder).width;
    const got = R(row).width;
    if (Math.abs(got - want) > 1) add('row', row, `the row is ${Math.round(got)}px wide, its ${holder.matches('.aia-field') ? 'field' : 'card'} ${Math.round(want)}px (it must span the full width)`, ['align-items', 'justify-content', 'display', 'width', 'margin']);
    const input = row.querySelector(':scope > input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), :scope > select');
    if (input && shown(input) && R(input).width < got * 0.5 - 0.5) add('input', input, `the input is ${Math.round(R(input).width)}px of its ${Math.round(got)}px row (at least half expected)`, ['width', 'flex', 'flex-grow', 'margin', 'min-width', 'max-width']);
  }

  // 5. Checkbox rows: the text starts right after the box.
  for (const check of panel.querySelectorAll('.aia-check')) {
    if (!shown(check)) continue;
    const box = check.querySelector('input');
    const text = [...check.childNodes].find((n) => n !== box && (n.nodeType === 1 || n.textContent.trim()));
    if (!box || !text || !shown(box)) continue;
    const range = document.createRange();
    range.selectNodeContents(text);
    const first = [...range.getClientRects()].find((r) => r.width > 0);
    if (!first) continue;
    const gap = first.left - R(box).right;
    if (gap > 12 || gap < -1) add('check', check, `the text starts ${Math.round(gap)}px from its checkbox (at most 12px expected)`, ['justify-content', 'text-align', 'gap', 'flex-direction', 'margin', 'width'], culprit(box, ['margin', 'margin-right', 'margin-left', 'width']) || culprit(text.nodeType === 1 ? text : check, ['flex', 'flex-grow', 'text-align', 'margin-left']));
  }

  // 6. Nothing centred in the body except the allow-list.
  for (const el of panel.querySelectorAll('*')) {
    if (problems.length >= max) break;
    if (!/center/.test(css(el).textAlign) || el.closest(opts.allowCenter) || !shown(el)) continue;
    // Only where it shows: own text, or the text inside a field.
    const control = el.matches('input, textarea, select');
    if (!control && ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    add('center', el, 'text is centred (everything in a card is left-aligned)', ['text-align']);
  }

  const bodyR = R(body);
  return {
    tab,
    problems,
    metrics: { card: Math.round(cardR.height), head: head ? Math.round(R(head).height) : 0, tabs: Math.round(tabsR.height), tabsNeed: tabs.scrollHeight, body: Math.round(bodyR.height), bodyScroll: body.scrollHeight, foot: Math.round(R(foot).height), overflows: body.scrollHeight > body.clientHeight + 1 },
  };
}

/** Evaluated in the page: open the settings dialog on a tab (through the agent, else the drawer's own button). */
function openSettingsIn(agentExpr, tab) {
  return `(async () => {
    let a = null; try { a = (${agentExpr}) || null; } catch {}
    const modal = () => [...document.querySelectorAll('.aia-modal')].find((m) => !m.hidden);
    if (!modal()) {
      if (a && typeof a.openSettings === 'function') a.openSettings(${JSON.stringify(tab)});
      else { const b = document.querySelector('.aia-drawer [data-act="settings"]'); if (!b) return { error: 'no agent object and no settings button' }; b.click(); }
    }
    const m = modal();
    if (!m) return { error: 'the settings dialog did not open' };
    const t = m.querySelector('[data-tab=' + JSON.stringify(${JSON.stringify(tab)}) + ']');
    if (t && t.getAttribute('aria-selected') !== 'true') t.click();
    return { tabs: [...m.querySelectorAll('[data-tab]')].filter((x) => !x.hidden).map((x) => x.dataset.tab) };
  })()`;
}

const closeSettingsIn = `(() => { const m = [...document.querySelectorAll('.aia-modal')].find((x) => !x.hidden); m?.querySelector('[data-act="close"]')?.click(); return !!m; })()`;

/**
 * Open Settings, visit every visible tab at each size, check the layout, and save a screenshot per tab
 * (`<out>/settings-<tab>.png` at the first size, `settings-<tab>-<w>x<h>.png` at the others).
 * @param {import('./cdp.mjs').Page} page
 * @param {{ agent?: string, out?: string, sizes?: number[][], allowCenter?: string, settleMs?: number }} [o]
 */
export async function checkSettingsLayout(page, { agent = 'window.agent || window.aiAgent', out = '', sizes = SETTINGS_SIZES, allowCenter = ALLOW_CENTER, settleMs = 260 } = {}) {
  const results = [];
  for (const [index, [w, h]] of sizes.entries()) {
    await page.viewport(w, h);
    await page.evaluate(closeSettingsIn);
    const first = await page.evaluate(openSettingsIn(agent, 'model'));
    if (first.error) return [{ tab: '', size: `${w}x${h}`, error: first.error, problems: [] }];
    await sleep(settleMs);                       // the card's opening animation
    for (const tab of first.tabs) {
      await page.evaluate(openSettingsIn(agent, tab));
      if (tab === 'context') await page.waitFor(() => /tokens|context/i.test(document.querySelector('.aia-modal:not([hidden]) .aia-ctx-size')?.textContent || ''), { timeoutMs: 5000 }).catch(() => {});
      await sleep(80);
      const r = await page.evaluate(probeSettingsLayout, { allowCenter });
      let screenshot = '';
      if (out) screenshot = await page.screenshot(path.join(out, index === 0 ? `settings-${tab}.png` : `settings-${tab}-${w}x${h}.png`));
      results.push({ tab, size: `${w}x${h}`, ...r, screenshot });
    }
    await page.evaluate(closeSettingsIn);
  }
  return results;
}

/** One line per problem: "[1280x600] tools · label.aia-field "Model": … — probably label { … } (app.css)". */
export function formatProblem(r, p) {
  return `[${r.size}] ${p.element ? `${p.element}: ` : ''}${p.text}${p.culprit ? ` — probably ${p.culprit}` : ''}`;
}
