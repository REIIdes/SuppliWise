/**
 * Dead runtime dependencies are attack surface.
 *
 * `axios` sat in the client's `dependencies` with no importer anywhere: every
 * install of this project pulled a HTTP client its maintainers patch, into a
 * bundle directory nothing ever reads, and `npm audit` counts it. That is the
 * "keep everything patched / remove unused components" mitigation, and the
 * only way it stays true is if the check runs — a package.json row is easy to
 * add and impossible to notice later.
 *
 * The scan is a reference census, not a guess: a declared dependency has to
 * appear in the source, the entry HTML, or a build config, or it fails.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

// Referenced by the generated native build, not by app source: `android/`
// exists and Capacitor resolves the platform package at build time. Anything
// added here has to have a reason as specific as that.
const NATIVE_BUILD_ONLY = new Set(['@capacitor/android', '@capacitor/cli', '@capacitor/core']);

function sourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.(js|jsx|mjs|cjs|ts|tsx|css|html|json)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('no runtime dependency is declared without being referenced', () => {
  const files = sourceFiles(path.join(APP, 'src'));
  for (const extra of ['index.html', 'vite.config.js', 'capacitor.config.json']) {
    const p = path.join(APP, extra);
    if (fs.existsSync(p)) files.push(p);
  }
  const corpus = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  const orphans = Object.keys(pkg.dependencies)
    .filter((name) => !NATIVE_BUILD_ONLY.has(name))
    .filter((name) => !corpus.includes(name));

  assert.deepEqual(orphans, [],
    `declared but never referenced: ${orphans.join(', ')} — remove them (npm uninstall <pkg>) `
    + 'or use them; an unused dependency is a CVE surface with no feature behind it.');
});

test('the removed dead HTTP client does not come back', () => {
  assert.ok(!('axios' in pkg.dependencies), 'axios has no importer — keep it out');
});

// The known-advisory census is deliberately NOT run here: `npm audit` needs
// the network and takes tens of seconds, which would make the whole client
// suite slow and flakily red — and a check that people learn to ignore is
// worse than no check. It runs on the Security Center instead, cached, as the
// `dependency_audit` probe (server/utils/dependencyAudit.js).
