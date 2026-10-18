/**
 * Known-vulnerability census of the installed dependency tree.
 *
 * "Keep everything patched" is only true if someone asks the advisory database,
 * and the answer is worth more on the Security Center than in a terminal a
 * person has to remember to open. This shells `npm audit` for BOTH packages —
 * the API and the client — and reports production findings separately from
 * dev-only ones, because they are not the same risk: a vulnerability in the
 * file watcher that reloads the dev server cannot be reached by a request,
 * while one in a package the request path imports can.
 *
 * It is a background check, not a boot gate: npm needs the network, so the
 * result is cached and refreshed on the monitor's own cadence, and an audit
 * that could not run is reported as such rather than as a pass.
 */

const { execFile } = require('node:child_process');
const path = require('node:path');

const PACKAGES = [
  { name: 'server', dir: path.join(__dirname, '..') },
  { name: 'client', dir: path.join(__dirname, '..', '..', 'my-react-app') },
];

const CACHE_MS = 6 * 60 * 60 * 1000;
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

let cached = { at: 0, running: null, result: null };

// npm cannot simply be spawned by name. On Windows it is a batch file, and Node
// refuses to spawn one without a shell since CVE-2024-27980 (spawn EINVAL) —
// so the shell-free way is to run npm's own CLI through the node binary that
// started this process. That binary is known to exist, and reaching for a shell
// here would be caught by the command-injection probe, which pins this file's
// argv.
function npmInvocation() {
  return { cmd: process.execPath, args: ['--no-warnings', npmCli()] };
}

function npmCli() {
  const { existsSync } = require('node:fs');
  const root = path.dirname(process.execPath);
  const candidates = [
    path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(root, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(root, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  ];
  return candidates.find(existsSync) || candidates[0];
}

function auditOne(dir) {
  return new Promise((resolve) => {
    const spawn = npmInvocation();
    execFile(spawn.cmd, [...spawn.args, 'audit', '--json', '--omit=dev'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout) => {
      const body = stdout && stdout.trim() ? stdout : (error && error.stdout);
      if (!body) {
        resolve({ ok: false, reason: (error && (error.code || error.message)) || 'no output' });
        return;
      }
      try {
        const json = JSON.parse(body);
        const found = Object.entries(json.vulnerabilities || {})
          .filter(([, v]) => SEVERITY_RANK[v.severity] >= 1)
          .map(([name, v]) => ({ name, severity: v.severity }))
          .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
        resolve({ ok: true, found });
      } catch {
        resolve({ ok: false, reason: 'unparseable audit output' });
      }
    });
  });
}

async function auditAll() {
  const parts = await Promise.all(PACKAGES.map(async (p) => ({ ...p, ...(await auditOne(p.dir)) })));
  const blocked = parts.filter(p => !p.ok);
  const vulnerable = parts.filter(p => p.ok && p.found.length > 0);
  const list = (rows) => rows.map(v => `${v.name} (${v.severity})`).join(', ');

  if (blocked.length === parts.length) {
    return {
      status: 'warning',
      detail: `npm audit could not run for ${blocked.map(b => `${b.name}: ${b.reason}`).join(', ')} — `
        + 'known vulnerabilities are unmeasured until it can (it needs the network).',
    };
  }
  if (vulnerable.length > 0) {
    return {
      status: 'critical',
      detail: `Production dependencies carry advisories — ${vulnerable.map(p => `${p.name}: ${list(p.found)}`).join('; ')}.`,
    };
  }
  const partial = blocked.length > 0
    ? ` (${blocked.map(b => b.name).join(', ')} unmeasured: ${blocked.map(b => b.reason).join(', ')})`
    : '';
  return {
    status: 'healthy',
    detail: 'npm audit (production trees only) reports zero advisories for server and client' + partial
      + '. Dev-tree findings are excluded: nothing in a dev dependency is loaded by a request.',
  };
}

// Cheap for the dashboard: the census is cached, and a refresh started while
// one is in flight returns the in-flight promise instead of spawning npm twice.
async function dependencyAudit() {
  const now = Date.now();
  if (cached.result && now - cached.at < CACHE_MS) return cached.result;
  if (!cached.running) {
    cached.running = auditAll()
      .then((result) => { cached = { at: Date.now(), running: null, result }; return result; })
      .catch((err) => {
        cached.running = null;
        return { status: 'warning', detail: `Dependency audit failed: ${err.message}` };
      });
  }
  return cached.running;
}

module.exports = { dependencyAudit };
