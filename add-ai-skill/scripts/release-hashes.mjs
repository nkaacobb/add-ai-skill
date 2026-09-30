#!/usr/bin/env node
// Record the fingerprints of a release's runtime and relays in scripts/release-hashes.json, so scripts/detect.mjs can
// tell an app whether its copies are unchanged (safe to replace wholesale) or were edited.
//
//   node scripts/release-hashes.mjs                        # the current assets, under the runtime's VERSION
//   node scripts/release-hashes.mjs --git <commit> --prefix <skill dir in that commit> --version <x.y.z>
//
// Run it for every release (see the repository README). Hashes are sha256 of the UTF-8 text with a BOM removed and
// line endings normalised to LF, so a copy checked out with CRLF still matches.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(SKILL, 'scripts', 'release-hashes.json');
const RELAYS = ['relay.php', 'relay.mjs'];

export function normalizedHash(text) {
  const s = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

function fromDisk() {
  const runtimeDir = path.join(SKILL, 'assets', 'ai-agent');
  const version = fs.readFileSync(path.join(runtimeDir, 'ai-agent.js'), 'utf8').match(/export const VERSION = '([^']+)'/)[1];
  const runtime = Object.fromEntries(listFiles(runtimeDir).map((f) => [f, normalizedHash(fs.readFileSync(path.join(runtimeDir, f), 'utf8'))]));
  const relay = Object.fromEntries(RELAYS.map((f) => [f, normalizedHash(fs.readFileSync(path.join(SKILL, 'assets', 'relay', f), 'utf8'))]));
  return { version, entry: { runtime, relay } };
}

function fromGit(commit, prefix, version) {
  const git = (...a) => execFileSync('git', a, { cwd: SKILL, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const root = git('rev-parse', '--show-toplevel').trim();
  const show = (p) => execFileSync('git', ['show', `${commit}:${p}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', `${prefix}/assets/ai-agent`], { cwd: root, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  const runtime = Object.fromEntries(files.map((f) => [f.slice(`${prefix}/assets/ai-agent/`.length), normalizedHash(show(f))]));
  const relay = Object.fromEntries(RELAYS.map((f) => [f, normalizedHash(show(`${prefix}/assets/relay/${f}`))]));
  return { version, entry: { runtime, relay } };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : ''; };
  const { version, entry } = opt('git') ? fromGit(opt('git'), opt('prefix'), opt('version')) : fromDisk();
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) { console.error('A version like 1.2.0 is needed.'); process.exit(1); }
  const data = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  data.$comment = 'Fingerprints of each released runtime (assets/ai-agent) and relay, used by scripts/detect.mjs. sha256 of UTF-8 text, BOM removed, line endings normalised to LF. Update with scripts/release-hashes.mjs.';
  data.releases = { ...(data.releases || {}), [version]: entry };
  data.releases = Object.fromEntries(Object.entries(data.releases).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  fs.writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`release-hashes.json: ${version} (${Object.keys(entry.runtime).length} runtime files, ${Object.keys(entry.relay).length} relays)`);
}
