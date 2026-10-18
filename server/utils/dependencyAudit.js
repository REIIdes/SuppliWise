/**
 * Known-vulnerability census of the installed dependency tree.
 *
 * "Keep everything patched" is only true if someone asks the advisory database,
 * and the answer is worth more on the Security Center than in a terminal a
 * person has to remember to open. This runs `npm audit` for every package ROOT
 * installed here — the API and, on a machine that also holds the client, that
 * tree too — and reports production findings separately from dev-only ones,
 * because they are not the same risk: a vulnerability in the file watcher that
 * reloads the dev server cannot be reached by a request, while one in a package
 * the request path imports can.
 *
 * It is a background check, not a boot gate: npm needs the network, so the
 * result is cached and refreshed on the monitor's own cadence, and an audit
 * that could not run is reported as such rather than as a pass.
 */

const { existsSync } = require('node:fs');
const { execFile } = require('node:child_process');
const path = require('node:path');

const PACKAGES = [
  { name: 'server', dir: path.join(__dirname, '..') },
  { name: 'client', dir: path.join(__dirname, '..', '..', 'my-react-app') },
];

const CACHE_MS = 6 * 60 * 60 * 1000;
// A census that could not run is a measurement gap, not a verdict — retry it
// soon instead of holding the warning for six hours.
const FAILURE_CACHE_MS = 10 * 60 * 1000;
const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 };

let cached = { at: 0, ttl: 0, running: null, result: null };

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

// A package ROOT that is not on this filesystem is not an audit failure — it is
// a tree this process cannot see. In the deployed layout the API container holds
// the server tree only, while the client is built into static files in another
// image; calling that "server: ENOENT" would read as a broken control instead of
// what it is: one of two trees, audited where it lives.
function installedHere(dir) {
  return existsSync(path.join(dir, 'package.json'));
}

async function auditAll() {
  const visible = PACKAGES.filter((p) => installedHere(p.dir));
  const absent = PACKAGES.filter((p) => !installedHere(p.dir));
  if (visible.length === 0) {
    return {
      status: 'warning',
      detail: 'No package root is installed at this path, so there is no dependency tree to audit here. '
        + 'This is expected in an image that ships neither tree — and expected to be untrue in one that does.',
    };
  }
  const parts = await Promise.all(visible.map(async (p) => ({ ...p, ...(await auditOne(p.dir)) })));
  const here = visible.map((p) => p.name).join(' and ');
  const elsewhere = absent.length > 0
    ? ` (${absent.map((a) => a.name).join(', ')} is not installed in this deployment, so it is audited where it lives)`
    : '';
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
    detail: `npm audit (production trees only) reports zero advisories for ${here}` + partial + elsewhere
      + '. Dev-tree findings are excluded: nothing in a dev dependency is loaded by a request.',
  };
}

function startRefresh() {
  cached.running = auditAll()
    .then((result) => {
      cached = {
        at: Date.now(),
        // A census that could not run is not a six-hour fact: the registry was
        // unreachable, not the tree clean. Hold the warning briefly so a poll
        // does not spawn npm every 30 seconds, then ask again.
        ttl: result.status === 'warning' ? FAILURE_CACHE_MS : CACHE_MS,
        running: null,
        result,
      };
      return result;
    })
    .catch((err) => {
      cached.running = null;
      return { status: 'warning', detail: `Dependency audit failed: ${err.message}` };
    });
  return cached.running;
}

// Cheap for the dashboard, and cheap in the way that matters: a request never
// waits for the registry once a census exists.
//
// The monitor gives every probe 10 s, while `npm audit` needs the network and
// takes longer than that on a cold cache — which made the first poll after a
// boot read "Probe timed out after 10 s", a healthy control displayed as a
// broken one. So: serve the last census immediately and refresh it behind the
// request when it has aged out, and only wait for npm when there is genuinely
// nothing to report yet.
async function dependencyAudit() {
  if (cached.result) {
    if (Date.now() - cached.at > cached.ttl && !cached.running) startRefresh();
    return cached.result;
  }
  if (!cached.running) startRefresh();
  return cached.running;
}

// Warm the cache once the API is up, so the first person to open the Security
// Center reads a census instead of a timeout.
//
// Gated on the entry point deliberately: `require.main` is index.js only in a
// running server. A test process or a one-liner that pulls this module in for
// its verdict must not spawn npm behind the test runner, where a 40-second
// registry call would look like a hung suite. `unref` on top of that, because a
// timer is never a reason for a process to stay alive.
if (require.main && /index\.js$/.test(String(require.main.filename))) {
  setTimeout(() => { dependencyAudit().catch(() => {}); }, 20000).unref();
}

module.exports = { dependencyAudit };
