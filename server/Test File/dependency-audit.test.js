/**
 * The dependency census must be honest about what it could not measure.
 *
 * `utils/dependencyAudit.js` is the control behind "keep everything patched":
 * it asks npm what the installed production trees owe us. Its dangerous failure
 * mode is not a wrong verdict but a MISSING one rendered as healthy — so these
 * drive it with npm replaced, without touching the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AUDIT = path.join(SERVER, 'utils', 'dependencyAudit.js');
const auditSrc = fs.readFileSync(AUDIT, 'utf8');
// Prose can name the very constructs these tests forbid, so the source
// assertions look only at code.
const codeOnly = auditSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// The module destructures execFile at require time, so patching the
// child_process export later would not reach it — the loader itself has to
// hand back the stub, and the module has to be loaded fresh under it.
function withFakeNpm(run, impl) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request !== 'node:child_process' && request !== 'child_process') {
      return realLoad.call(this, request, parent, isMain);
    }
    return { execFile: impl };
  };
  delete require.cache[AUDIT];
  try {
    return run(require(AUDIT)).finally(() => {
      Module._load = realLoad;
      delete require.cache[AUDIT];
    });
  } finally {
    Module._load = realLoad;
    delete require.cache[AUDIT];
  }
}

const npmFails = (bin, args, opts, cb) => cb(new Error('ENOENT npm'), '', '');
const npmReports = (payload) => (bin, args, opts, cb) => cb(null, JSON.stringify(payload), '');

test('the census covers BOTH shipped packages, not just the API', () => {
  assert.match(auditSrc, /name: 'server'/);
  assert.match(auditSrc, /name: 'client'/);
});

test('an audit that could not run is a warning, never a healthy', () => {
  return withFakeNpm(({ dependencyAudit }) => dependencyAudit().then((result) => {
    assert.equal(result.status, 'warning');
    assert.match(result.detail, /unmeasured/);
  }), npmFails);
});

test('a production advisory is reported critical with the package named', () => {
  return withFakeNpm(({ dependencyAudit }) => dependencyAudit().then((result) => {
    assert.equal(result.status, 'critical');
    assert.match(result.detail, /express \(high\)/);
    assert.match(result.detail, /mongoose \(critical\)/);
  }), npmReports({ vulnerabilities: { express: { severity: 'high' }, mongoose: { severity: 'critical' } } }));
});

test('a clean tree reads healthy and says which trees it checked', () => {
  return withFakeNpm(({ dependencyAudit }) => dependencyAudit().then((result) => {
    assert.equal(result.status, 'healthy');
    assert.match(result.detail, /zero advisories/);
  }), npmReports({ vulnerabilities: {} }));
});

test('dev-tree findings stay out of the production verdict', () => {
  // A vulnerable file watcher in the dev toolchain is not reachable by a
  // request, and mixing the two would make the real signal ignorable. The flag
  // is asserted from source because npm is not called here.
  assert.match(auditSrc, /'--omit=dev'/);
  assert.match(auditSrc, /Dev-tree findings are excluded/);
});

test('the spawner never asks for a shell and resolves npm without one', () => {
  assert.match(auditSrc, /require\('node:child_process'\)/);
  assert.doesNotMatch(auditSrc, /execSync|spawnSync|shell\s*:\s*true/);
  // Windows: `npm` is a .cmd, and Node refuses to spawn one without a shell
  // since CVE-2024-27980 (spawn EINVAL). The shell-free form is npm's own CLI
  // script run through the binary that started this process — and the module
  // must never name a .cmd at all, even in code.
  const codeOnly = auditSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(codeOnly, /cmd:\s*process\.execPath/);
  assert.match(codeOnly, /npm-cli\.js/);
  assert.doesNotMatch(codeOnly, /['"`][^'"`\n]*\.cmd['"`]/);
});

test('the real spawn is the node binary with a fixed audit argv', () => {
  const calls = [];
  const capture = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    cb(null, JSON.stringify({ vulnerabilities: {} }), '');
  };
  return withFakeNpm(({ dependencyAudit }) => dependencyAudit().then(() => {
    assert.equal(calls.length, 2, 'one audit per shipped package');
    for (const call of calls) {
      assert.equal(call.bin, process.execPath);
      assert.ok(call.args[1].endsWith('npm-cli.js'), `expected npm's CLI script, got ${call.args[1]}`);
      assert.deepEqual(call.args.slice(2), ['audit', '--json', '--omit=dev']);
      assert.equal(call.opts.shell, undefined);
      assert.ok(path.isAbsolute(call.opts.cwd));
    }
  }), capture);
});
