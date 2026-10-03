// scripts/guards.mjs and scripts/lib/css-guards.mjs: reading a stylesheet's layout guards, the cascade arithmetic
// behind it, the host's global element rules, and applying the guard blocks in place to an edited runtime copy (its
// other edits kept, the patch recorded).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { layoutGuards, applyGuards, guardBlock, specificity, compounds, parseCss, hostElementRules, inlineStyles } from '../scripts/lib/css-guards.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(SKILL, 'assets', 'ai-agent');
const CSS = fs.readFileSync(path.join(RUNTIME, 'ai-agent.css'), 'utf8');
const GUARD_BLOCKS = /\/\* aia-guard: (pinned-chrome|host-isolation)[\s\S]*?\/\* end aia-guard: \1 \*\/\n?/g;
const UNGUARDED = CSS.replace(GUARD_BLOCKS, '');

test('guards: the runtime\'s own stylesheet has both blocks, in the right places', () => {
  const g = layoutGuards(CSS);
  assert.deepEqual([g.pinnedChrome, g.hostIsolation, g.missing], [true, true, []]);
  const isolation = CSS.indexOf('/* aia-guard: host-isolation');
  assert.ok(isolation > CSS.lastIndexOf(':where(.aia-scope[data-aia-theme="dark"])'), 'after the theme tokens');
  assert.ok(isolation < CSS.indexOf('.aia-scope *, .aia-scope *::before'), 'before every other rule');
  assert.match(guardBlock(CSS, 'host-isolation'), /\.aia-scope :where\(div, span, p, [^)]*label, input, select[^)]*\) \{ all: revert; \}/);
  assert.match(guardBlock(CSS, 'pinned-chrome'), /\.aia-scope \.aia-modal-head, \.aia-scope \.aia-tabs, \.aia-scope \.aia-modal-foot \{ flex-shrink: 0; \}/);
  // No new !important except [hidden] (the stylesheet's other !important rules style host elements: pushed, docked).
  const important = parseCss(CSS).filter((r) => r.decls.some((d) => d.important)).flatMap((r) => r.selectors).filter((s) => s.startsWith('.aia-scope'));
  assert.deepEqual(important, ['.aia-scope[hidden]', '.aia-scope [hidden]', '.aia-scope .aia-ok']);
});

test('guards: specificity and compounds follow the cascade (:where counts nothing, :is its strongest argument)', () => {
  assert.deepEqual(specificity('.aia-scope :where(div, label)'), [0, 1, 0]);
  assert.deepEqual(specificity('.aia-scope .aia-field'), [0, 2, 0]);
  assert.deepEqual(specificity('.aia-scope :is(input[type="text"], select)'), [0, 2, 1]);
  assert.deepEqual(specificity('button:hover'), [0, 1, 1]);
  assert.deepEqual(specificity('label::after'), [0, 0, 2]);
  assert.deepEqual(specificity('#app main > p.lead'), [1, 1, 2]);
  assert.deepEqual(compounds('.aia-scope > .aia-tabs:hover ~ a[href="x y"]'), ['.aia-scope', '.aia-tabs:hover', 'a[href="x y"]']);
  const rules = parseCss('/* x { } */ @import "a.css"; @keyframes k { from { top: 0 } } @media (min-width: 1px) { p { margin: 0 !important } } a, b:hover { color: red; }');
  assert.deepEqual(rules.map((r) => [r.selectors, r.atRules, r.decls.map((d) => `${d.prop}=${d.value}${d.important ? '!' : ''}`)]), [
    [['p'], ['@media (min-width: 1px)'], ['margin=0!']],
    [['a', 'b:hover'], [], ['color=red']],
  ]);
});

test('guards: host element rules — global bare elements and body text-align only; inline styles but not scoped ones', () => {
  const css = 'label{display:flex}\n.panel label{color:red}\nhtml.dark button:hover{transform:none}\nbutton.x{margin:0}\n:root{text-align:center}\nmain p{margin:0}';
  assert.deepEqual(hostElementRules(css, 'a.css').map((r) => `${r.line} ${r.selector} ${r.props}`), ['1 label display', '3 html.dark button:hover transform', '5 :root text-align: center']);
  const html = '<head>\n<style>\np { margin: 0 }\n</style>\n<style scoped>label{}</style></head>';
  assert.deepEqual(inlineStyles(html).map((s) => hostElementRules(s.css, 'i.html', s.lineOffset).map((r) => `${r.line} ${r.selector}`)), [['3 p']]);
  assert.deepEqual(inlineStyles('<style>label{}</style>', 'Comp.svelte'), [], 'Svelte styles are scoped to their component');
});

test('guards: applyGuards adds what is missing in place, keeps the app\'s edits, keeps CRLF, and is idempotent', () => {
  const edited = UNGUARDED.replace('.aia-scope .aia-tab:hover { color: var(--aia-text); }', '.aia-scope .aia-tab:hover { color: hotpink; } /* app edit */');
  assert.notEqual(edited, UNGUARDED);
  const out = applyGuards(edited, CSS);
  assert.deepEqual(out.applied, ['host-isolation', 'pinned-chrome']);
  assert.match(out.css, /color: hotpink; \} \/\* app edit \*\//, 'the edit stays');
  assert.deepEqual(layoutGuards(out.css).missing, []);
  assert.ok(out.css.indexOf('aia-guard: host-isolation') < out.css.indexOf('.aia-scope *, .aia-scope *::before'), 'isolation before the base rules');
  assert.ok(out.css.trimEnd().endsWith('/* end aia-guard: pinned-chrome */'), 'pinned chrome at the end');
  assert.deepEqual(applyGuards(out.css, CSS).applied, [], 'a second run changes nothing');
  assert.equal(applyGuards(out.css, CSS).css, out.css);

  // Only what is missing: a copy with the hand-made Bug 1 fix gets host isolation alone.
  const hand = `${UNGUARDED}\n.aia-modal-head, .aia-tabs, .aia-modal-foot { flex-shrink: 0; }\n.aia-modal-body { min-height: 0; }\n`;
  assert.deepEqual(applyGuards(hand, CSS).applied, ['host-isolation']);

  const crlf = applyGuards(UNGUARDED.replace(/\n/g, '\r\n'), CSS).css;
  assert.equal(/[^\r]\n/.test(crlf), false, 'a CRLF copy stays CRLF');
});

test('guards CLI: --apply patches an edited copy, records it in the manifest; an unchanged current copy needs nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aia-guards-'));
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const f of walk(RUNTIME)) {
    const to = path.join(root, 'public', 'ai-agent', path.relative(RUNTIME, f));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(f, to);
  }
  fs.mkdirSync(path.join(root, 'public', 'js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'js', 'setup.js'), "import { createAiAgent } from '../ai-agent/ai-agent.js';\ncreateAiAgent({ appId: 'lab' });\n");
  fs.writeFileSync(path.join(root, 'ai-enablement.json'), JSON.stringify({ skill: 'ai-enablement', skillVersion: '2.0.0', customizations: ['theme'] }, null, 2));
  const run = (...args) => execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'guards.mjs'), root, ...args], { encoding: 'utf8' });

  assert.match(run(), /public\/ai-agent\/ai-agent\.css: pinned chrome yes · host isolation yes — both guards in place/);

  const css = path.join(root, 'public', 'ai-agent', 'ai-agent.css');
  fs.writeFileSync(css, UNGUARDED.replace('.aia-scope .aia-tab:hover { color: var(--aia-text); }', '.aia-scope .aia-tab:hover { color: hotpink; }'));
  assert.match(run(), /MISSING pinned-chrome, host-isolation\n {3}edited copy: run again with --apply/, 'without --apply it only reports');
  const out = run('--apply');
  assert.match(out, /applied host-isolation \(before the \.aia-scope \* \{ box-sizing \} rule\), pinned-chrome \(at the end\) → pinned chrome yes · host isolation yes/);
  assert.match(out, /Recorded in ai-enablement\.json \("patches"\)/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ai-enablement.json'), 'utf8'));
  assert.deepEqual(manifest.customizations, ['theme'], 'the rest of the manifest stays');
  assert.equal(manifest.patches.length, 1);
  assert.match(manifest.patches[0], /^public\/ai-agent\/ai-agent\.css: aia-guard host-isolation \+ pinned-chrome from ai-enablement \d+\.\d+\.\d+ \(runtime \d+\.\d+\.\d+\) applied in place to an edited copy/);
  assert.match(fs.readFileSync(css, 'utf8'), /color: hotpink/);
  assert.match(run('--apply'), /both guards in place/, 'a second run has nothing to do');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'ai-enablement.json'), 'utf8')).patches.length, 1);
});
