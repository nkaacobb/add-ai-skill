#!/usr/bin/env node
// Is the AI agent already in this app, and at which version? Run it first, every time the skill is used on an app:
//
//   node <skill>/scripts/detect.mjs [app-root] [--json]
//
// It finds, without changing anything:
//   - copies of the runtime (ai-agent.js with `export const VERSION`), their version, and whether they are unchanged
//     since that release (fingerprints in scripts/release-hashes.json) — unchanged copies can be replaced wholesale;
//   - relays (relay.php / relay.mjs), their version, edits (1.0 constants, keys or checks added inside the file) and
//     config files (names only: never their contents, which may hold keys);
//   - the integration: files that call createAiAgent() (the appId, the options used), the integration record
//     (ai-agent.integration.json), tool config files (ai-tools.json);
//   - app code that looks like a workaround a newer runtime covers (hints to check, not certainties).
// Then it says what to do: build (no agent yet), upgrade (older version), or nothing to upgrade.
// Exit code: 0 always (it only reports).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.output', 'coverage', '.verify', '.cache', '.turbo', '.vercel', 'bower_components']);
// PHP's Composer `vendor/` is skipped; a front-end `js/vendor/` (where a copied runtime often lives) is not.
const isComposerVendor = (dir, name) => name === 'vendor' && fs.existsSync(path.join(dir, 'autoload.php'));
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.php', '.html', '.htm', '.astro']);
const MAX_FILES = 20000;
const MAX_BYTES = 2 * 1024 * 1024;

export const normalizedHash = (text) => crypto.createHash('sha256').update(String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n'), 'utf8').digest('hex');
const cmpVersion = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });

export function skillInfo() {
  const js = fs.readFileSync(path.join(SKILL, 'assets', 'ai-agent', 'ai-agent.js'), 'utf8');
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(SKILL, 'package.json'), 'utf8')); } catch { /* optional */ }
  let hashes = { releases: {} };
  try { hashes = JSON.parse(fs.readFileSync(path.join(SKILL, 'scripts', 'release-hashes.json'), 'utf8')); } catch { /* optional */ }
  return { runtimeVersion: js.match(/export const VERSION = '([^']+)'/)?.[1] || '', skillVersion: pkg.version || '', releases: hashes.releases || {} };
}

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.isSymbolicLink() && !isComposerVendor(p, e.name)) stack.push(p); } else if (e.isFile()) files.push(p);
    }
  }
  return files;
}

const read = (f) => { try { const st = fs.statSync(f); return st.size > MAX_BYTES ? '' : fs.readFileSync(f, 'utf8'); } catch { return ''; } };

function listRel(dir) {
  const out = [];
  for (const f of walk(dir)) out.push(path.relative(dir, f).split(path.sep).join('/'));
  return out.sort();
}

/** Compare a runtime copy with the release it says it is. */
function runtimeIntegrity(dir, version, releases) {
  const expected = releases[version]?.runtime;
  if (!expected) return { known: false, modified: [], missing: [], extra: [] };
  const files = listRel(dir);
  const modified = [];
  const missing = [];
  for (const [f, h] of Object.entries(expected)) {
    const p = path.join(dir, ...f.split('/'));
    if (!fs.existsSync(p)) missing.push(f);
    else if (normalizedHash(read(p)) !== h) modified.push(f);
  }
  const extra = files.filter((f) => !expected[f]);
  return { known: true, modified, missing, extra };
}

function relayInfo(file, text, releases) {
  const kind = path.basename(file);
  const version = (kind === 'relay.php' ? text.match(/AIA_RELAY_VERSION = '([^']+)'/) : text.match(/RELAY_VERSION = '([^']+)'/))?.[1] || '1.0.0';
  const h = normalizedHash(text);
  const matches = Object.entries(releases).filter(([, e]) => e.relay?.[kind] === h).map(([v]) => v);
  const edits = [];
  if (kind === 'relay.php') {
    if (/^const AIA_ALLOW_REMOTE = true/m.test(text)) edits.push('AIA_ALLOW_REMOTE = true (1.0 constant) -> config "allowRemote" (plus an "authorize" check)');
    if (/^const AIA_ALLOW_ANY_UPSTREAM = true/m.test(text)) edits.push('AIA_ALLOW_ANY_UPSTREAM = true (1.0 constant) -> config "allowAnyUpstream"');
    const keysBlock = text.match(/const AIA_KEYS = \[([\s\S]*?)\];/)?.[1] || '';
    if (keysBlock.split('\n').some((l) => /=>/.test(l) && !/^\s*\/\//.test(l))) edits.push('server keys written in the file (AIA_KEYS) -> config "keys" or environment variables (values not shown)');
    if (/^const AIA_TIMEOUT = (?!300;)/m.test(text)) edits.push('AIA_TIMEOUT changed -> config "timeout"');
    const afterAuth = text.split(/enforce it here, e\.g\.:[^\n]*\n[^\n]*\n/)[1] || '';
    if (afterAuth && /^\s*(require|include|if|\$|[a-z_]+\()/m.test(afterAuth.split('$method')[0] || '')) edits.push('code added at the "enforce it here" spot (sign-in/CSRF) -> config "authorize"');
  }
  return { file, kind, version, unchanged: matches.length > 0, matches, edits };
}

/** Keys at the top level of the object literal passed to createAiAgent({ … }) (strings and comments skipped). */
export function createAgentKeys(text) {
  const start = text.search(/createAiAgent\s*\(\s*\{/);
  if (start < 0) return [];
  let i = text.indexOf('{', start);
  let depth = 0;
  let token = '';
  const keys = [];
  for (; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '/' && n === '/') { i = text.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      token = '';
      continue;
    }
    if (c === '{' || c === '[' || c === '(') { depth++; token = ''; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; token = ''; if (depth === 0) break; continue; }
    if (depth === 1 && c === ':' && /^[A-Za-z_$][\w$]*$/.test(token.trim())) { keys.push(token.trim()); token = ''; continue; }
    if (c === ',' || c === '\n') { token = ''; continue; }
    token += c;
  }
  return keys;
}

function integrationInfo(file, text) {
  const appId = text.match(/appId\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] || '';
  return { file, appId, options: createAgentKeys(text).filter((k) => k !== 'appId') };
}

function workaroundHints(file, text) {
  const hints = [];
  if (/\.showModal\s*=|prototype\.showModal|showModal\.call\(/.test(text) && !/aia-docked-dialog/.test(text)) hints.push('overrides dialog.showModal: the runtime\'s `dialogs: \'dock\'` option (1.1) may replace this code');
  if (/contextChanged/.test(text) && /(throttle|lastSignal|lastChange|setInterval\([^)]*contextChanged)/i.test(text)) hints.push('throttles contextChanged(): the runtime keeps the flag moving itself since 1.1 (debounceMaxMs)');
  if (/(fetch|probe)[\s\S]{0,300}available[\s\S]{0,300}createAiAgent|relayUrl[\s\S]{0,200}available/.test(text)) hints.push('probes the relay before createAiAgent: the `relayProbe` option (1.1) does this');
  if (/keydown[\s\S]{0,400}(aia-|ai-agent)/.test(text) && !/aia-scope/.test(text)) hints.push('filters key events for the drawer: typing is isolated by the runtime since 1.1 (isolateKeys)');
  if (/\[data-aia-theme|:not\(\[data-aia-theme/.test(text)) hints.push('theme overrides with high-specificity selectors: since 1.1 a plain `.aia-scope { --aia-… }` rule wins in light and dark');
  return hints.map((h) => ({ file, hint: h }));
}

export function detect(appRoot, skill = skillInfo()) {
  const root = path.resolve(appRoot);
  const files = walk(root);
  const rel = (f) => path.relative(root, f).split(path.sep).join('/') || '.';
  const runtimes = [];
  const relays = [];
  const relayConfigs = [];
  const integrations = [];
  const records = [];
  const toolConfigs = [];
  const hints = [];
  const runtimeDirs = [];

  for (const f of files) {
    const base = path.basename(f);
    if (base === 'ai-agent.js') {
      const t = read(f);
      const version = t.match(/export const VERSION = '([^']+)'/)?.[1];
      if (version && /export function createAiAgent/.test(t)) {
        const dir = path.dirname(f);
        runtimeDirs.push(dir);
        runtimes.push({ dir: rel(dir), version, ...runtimeIntegrity(dir, version, skill.releases) });
      }
    }
  }
  const inRuntime = (f) => runtimeDirs.some((d) => f.startsWith(d + path.sep));

  for (const f of files) {
    if (inRuntime(f)) continue;
    const base = path.basename(f);
    if (base === 'relay.php' || base === 'relay.mjs') {
      const t = read(f);
      if (t.includes('ai-agent-drawer')) relays.push({ ...relayInfo(f, t, skill.releases), file: rel(f) });
      continue;
    }
    if (/^relay\.config\.(php|json|mjs)$/.test(base)) { relayConfigs.push(rel(f)); continue; }
    if (base === 'ai-agent.integration.json') {
      let data = null;
      try { data = JSON.parse(read(f)); } catch { data = { error: 'not valid JSON' }; }
      records.push({ file: rel(f), data });
      continue;
    }
    if (base === 'ai-tools.json') { toolConfigs.push(rel(f)); continue; }
    if (!CODE_EXT.has(path.extname(f).toLowerCase())) continue;
    const t = read(f);
    if (!t) continue;
    if (/createAiAgent\s*\(/.test(t) && !/export function createAiAgent/.test(t)) integrations.push({ ...integrationInfo(f, t), file: rel(f) });
    if (/createAiAgent|contextChanged|aia-|ai-agent/.test(t)) hints.push(...workaroundHints(rel(f), t));
  }
  for (const f of files) {
    if (path.extname(f).toLowerCase() === '.css' && !inRuntime(f)) {
      const t = read(f);
      if (/\.aia-/.test(t)) hints.push(...workaroundHints(rel(f), t));
    }
  }

  const installed = runtimes.map((r) => r.version).sort(cmpVersion);
  const oldest = installed[0] || null;
  let status;
  if (!runtimes.length && !integrations.length) status = 'none';
  else if (!runtimes.length) status = 'integration-without-runtime';
  else if (cmpVersion(oldest, skill.runtimeVersion) < 0) status = 'upgrade';
  else if (relays.some((r) => cmpVersion(r.version, skill.runtimeVersion) < 0)) status = 'upgrade';
  else status = 'current';

  return {
    app: root,
    skill: { skillVersion: skill.skillVersion, runtimeVersion: skill.runtimeVersion },
    status,
    runtimes: runtimes.map((r) => ({ ...r, extra: r.extra.slice(0, 20) })),
    relays,
    relayConfigs,
    integrations,
    records,
    toolConfigs,
    hints,
    features: { tools: integrations.some((i) => i.options.includes('tools')), toolConfig: toolConfigs.length > 0, record: records.length > 0 },
  };
}

function report(r) {
  const out = [];
  const say = (s = '') => out.push(s);
  say(`add-ai-skill ${r.skill.skillVersion} (runtime ${r.skill.runtimeVersion}) · app: ${r.app}`);
  say('');
  if (r.status === 'none') {
    say('No AI agent found in this app: follow the normal workflow (SKILL.md steps 1-12).');
    return out.join('\n');
  }
  for (const rt of r.runtimes) {
    const state = !rt.known ? 'unknown release (no fingerprints): compare with the app\'s git history before replacing'
      : rt.modified.length || rt.missing.length ? `EDITED since ${rt.version}: ${[...rt.modified.map((f) => `${f} (changed)`), ...rt.missing.map((f) => `${f} (missing)`)].join(', ')}`
        : `unchanged ${rt.version} copy: safe to replace wholesale`;
    say(`Runtime   ${rt.dir}  v${rt.version}  — ${state}${rt.extra.length ? `; extra files: ${rt.extra.join(', ')}` : ''}`);
  }
  if (r.runtimes.length > 1) say('          More than one runtime copy: find out which one the app loads; remove the others.');
  for (const rl of r.relays) {
    say(`Relay     ${rl.file}  v${rl.version}  — ${rl.unchanged ? 'unchanged copy' : 'EDITED (or an unknown version)'}`);
    for (const e of rl.edits) say(`          · ${e}`);
  }
  for (const c of r.relayConfigs) say(`Config    ${c}  (relay config: keep it; contents not read)`);
  for (const i of r.integrations) say(`Agent     ${i.file}  createAiAgent(appId: ${i.appId ? `'${i.appId}'` : '?'})  options: ${i.options.join(', ') || '—'}`);
  if (r.integrations.length > 1) say('          More than one createAiAgent() call: make sure only one runs (one agent per app).');
  for (const rec of r.records) say(`Record    ${rec.file}  (skill ${rec.data?.skillVersion || '?'}, updated ${rec.data?.updated || '?'})`);
  if (!r.records.length) say('Record    none yet — write ai-agent.integration.json at the end of the upgrade (references/upgrading.md).');
  for (const t of r.toolConfigs) say(`Tools     ${t}`);
  if (!r.features.tools) say('Tools     none registered — the app can gain tools (references/tools.md).');
  if (r.hints.length) {
    say('');
    say('Check (possible workarounds a newer runtime covers):');
    for (const h of r.hints) say(`  · ${h.file}: ${h.hint}`);
  }
  say('');
  if (r.status === 'upgrade') {
    const from = r.runtimes.map((x) => x.version).sort(cmpVersion)[0];
    say(`=> UPGRADE: an agent is already built in (runtime ${from}). Do NOT build a second one. Follow references/upgrading.md,`);
    say(`   reading CHANGELOG.md from ${from} to ${r.skill.runtimeVersion}.`);
  } else if (r.status === 'current') {
    say(`=> CURRENT: the runtime is up to date (${r.skill.runtimeVersion}). Offer the features the app does not use yet (references/upgrading.md, step 5),`);
    say('   or make the change the user asked for. Do NOT build a second agent.');
  } else {
    say('=> An integration calls createAiAgent() but no runtime copy was found (bundled from a package, or outside this folder).');
    say('   Find where the runtime comes from before changing anything. Do NOT build a second agent.');
  }
  return out.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--')) || '.';
  const result = detect(dir);
  console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : report(result));
}
