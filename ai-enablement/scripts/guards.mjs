#!/usr/bin/env node
// The runtime's layout guards (ai-agent.css, runtime 1.6.1+): are they in an app's installed copy, and — for a copy
// the app edited — apply them in place. scripts/detect.mjs reports the same (its "Layout guards" lines); every run of the
// skill on an app that has the agent checks them (SKILL.md, step 0; references/upgrading.md, "Layout guards").
//
//   node <skill>/scripts/guards.mjs [app-root] [--json]   report: per runtime copy, the guards and what to do
//   node <skill>/scripts/guards.mjs [app-root] --apply    add the missing guard blocks to each EDITED copy's
//                                                         ai-agent.css (its other edits stay) and record the patch
//                                                         in the manifest; an unchanged copy is replaced instead
//                                                         (references/upgrading.md, U4) — this script says so
//
// The guards:
//   pinnedChrome   the settings dialog's header, tab strip and footer never shrink (flex-shrink: 0) and its body has
//                  min-height: 0 — the "aia-guard: pinned-chrome" block, or the same rules written by hand
//   hostIsolation  the "aia-guard: host-isolation" block: the host page's element rules (label, button, input, p,
//                  h2…) do not reach what the runtime renders
// It also lists the host's own global element rules (label, input, select, textarea, button, p, h1–h6, and
// text-align on body), for information: what the settings dialog has to withstand in this app.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { layoutGuards, applyGuards } from './lib/css-guards.mjs';
import { detect, skillInfo } from './detect.mjs';

export * from './lib/css-guards.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const root = path.resolve(argv.find((a) => !a.startsWith('--')) || '.');
  const info = skillInfo();
  const r = detect(root, info);
  if (argv.includes('--json') && !argv.includes('--apply')) {
    console.log(JSON.stringify({ app: r.app, layoutGuards: r.layoutGuards, hostRules: r.hostRules }, null, 2));
    process.exit(0);
  }
  if (!r.layoutGuards.length) { console.log(r.runtimes.length ? 'No ai-agent.css next to the runtime copy.' : 'No runtime copy in this app (nothing to guard).'); process.exit(0); }
  const skillCss = fs.readFileSync(path.join(SKILL, 'assets', 'ai-agent', 'ai-agent.css'), 'utf8');
  const patched = [];
  for (const g of r.layoutGuards) {
    const state = g.missing.length ? `MISSING ${g.missing.join(', ')}` : 'both guards in place';
    console.log(`${g.css}: pinned chrome ${g.pinnedChrome ? 'yes' : 'NO'} · host isolation ${g.hostIsolation ? 'yes' : 'NO'} — ${state}`);
    if (!g.missing.length) continue;
    if (g.fix === 'replace') { console.log(`   unchanged ${g.version} copy: replace the runtime with the skill's (references/upgrading.md, U4) — not patched`); continue; }
    if (!argv.includes('--apply')) { console.log('   edited copy: run again with --apply to add the guard blocks in place (its other edits stay)'); continue; }
    const file = path.join(root, ...g.css.split('/'));
    const out = applyGuards(fs.readFileSync(file, 'utf8'), skillCss);
    fs.writeFileSync(file, out.css);
    const after = layoutGuards(out.css);
    console.log(`   applied ${out.applied.map((a) => `${a} (${out.where[a]})`).join(', ')} → pinned chrome ${after.pinnedChrome ? 'yes' : 'NO'} · host isolation ${after.hostIsolation ? 'yes' : 'NO'}`);
    patched.push({ css: g.css, applied: out.applied });
  }
  if (patched.length) {
    const rec = r.records.find((x) => !x.legacy) || r.records.find((x) => x.legacy);
    const note = (p) => `${p.css}: aia-guard ${p.applied.join(' + ')} from ai-enablement ${info.skillVersion} (runtime ${info.runtimeVersion}) applied in place to an edited copy (${new Date().toISOString().slice(0, 10)})`;
    if (rec && rec.data && !rec.data.error) {
      const file = path.join(root, ...rec.file.split('/'));
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.patches = [...(Array.isArray(data.patches) ? data.patches : []).filter((x) => !patched.some((p) => String(x).startsWith(`${p.css}: aia-guard`))), ...patched.map(note)];
      fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
      console.log(`Recorded in ${rec.file} ("patches").`);
    } else {
      console.log(`No manifest yet: record in ai-enablement.json, "patches": ${JSON.stringify(patched.map(note))}`);
    }
  }
}
