/**
 * Run a Node script with the development certificate authority trusted.
 *
 * ── Why this has to exist ───────────────────────────────────────────────────
 *
 * Every probe script in this repository (glitch-hunt*.js, test-*-flows.js,
 * verify-bc-monitor.js) uses the global `fetch`, and Node does not read the
 * operating system's certificate store. It trusts its own bundled roots plus
 * whatever `NODE_EXTRA_CA_CERTS` names at startup — and `mkcert -install`, which
 * is what makes `https://localhost` work in a browser, puts the authority in the
 * OS store. So with TLS enabled, every one of those scripts fails its first
 * request with SELF_SIGNED_CERT_IN_CHAIN or UNABLE_TO_VERIFY_LEAF_SIGNATURE.
 *
 * The error names the certificate and nothing else. It reads as "the certificate
 * is broken", which sends you looking at a perfectly good certificate, because
 * from the browser's point of view it demonstrably is not broken.
 *
 * ── Why the obvious fixes do not work ───────────────────────────────────────
 *
 * `fetch(url, { ca })` — undici accepts no `ca` option. The property is ignored
 * silently and the handshake still fails. Verified, not assumed.
 *
 * `process.env.NODE_EXTRA_CA_CERTS = …` inside the script — read once, at
 * startup. Assigning it later has no effect. Verified, not assumed.
 *
 * `NODE_TLS_REJECT_UNAUTHORIZED=0` — that disables certificate verification
 * entirely. It would make these probes run, and it would also make them run
 * against a server presenting somebody else's certificate, which is precisely
 * the condition a security probe exists to catch. Not acceptable.
 *
 * What remains is the correct lever, and it only works from outside the process:
 * re-launch the target with the right environment in place before it starts.
 *
 * ── How it decides ──────────────────────────────────────────────────────────
 *
 * `NODE_OPTIONS=--use-system-ca` when the flag exists, because that is the
 * general fix — it trusts the whole OS store, so any local authority works and
 * no path has to be tracked. `NODE_EXTRA_CA_CERTS` as the fallback for a Node
 * too old for the flag, naming certs/rootCA.pem.
 *
 * With TLS off, or with no certificate on disk, the target runs unchanged. A
 * fresh clone with nothing configured behaves exactly as it did before.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   node scripts/withDevCa.mjs glitch-hunt.js
 *   node scripts/withDevCa.mjs test-subscription-flows.js
 *
 * Exit code, signals and stdio all pass through, so this is invisible to
 * whatever invoked it apart from the environment it adds.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(here, '..');
const REPO_ROOT = resolve(SERVER_ROOT, '..');
const CA_FILE = join(REPO_ROOT, 'certs', 'rootCA.pem');

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/withDevCa.mjs <script.js> [args...]');
  process.exit(2);
}

/**
 * Does this Node understand `--use-system-ca`?
 *
 * Probed rather than inferred from a version number: the flag was added in a
 * specific release, and a version check is a second thing to keep true. Running
 * `node --use-system-ca -e ''` is the direct question, and it costs milliseconds.
 * A Node without the flag exits non-zero and prints "bad option".
 */
function supportsSystemCa() {
  return new Promise((resolveProbe) => {
    const probe = spawn(process.execPath, ['--use-system-ca', '-e', 'process.exit(0)'], { stdio: 'ignore' });
    const timer = setTimeout(() => {
      probe.kill();
      resolveProbe(false);
    }, 5000);
    probe.on('close', (code) => {
      clearTimeout(timer);
      resolveProbe(code === 0);
    });
    probe.on('error', () => {
      clearTimeout(timer);
      resolveProbe(false);
    });
  });
}

const env = { ...process.env };

const target = resolve(SERVER_ROOT, args[0]);
if (!existsSync(target)) {
  console.error(`[withDevCa] no such script: ${args[0]}`);
  process.exit(2);
}

// Nothing to add when the API is not serving TLS. A plain-HTTP run must behave
// exactly as it did before this script existed.
const tlsEnabled = String(env.TLS_ENABLED || '').trim().toLowerCase() === 'true';

if (tlsEnabled && existsSync(CA_FILE)) {
  // `--use-system-ca` when this Node has it, because that trusts the whole OS
  // store and needs no path tracked here; NODE_EXTRA_CA_CERTS otherwise.
  if (await supportsSystemCa()) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --use-system-ca`.trim();
  } else {
    env.NODE_EXTRA_CA_CERTS = CA_FILE;
  }
} else if (tlsEnabled) {
  console.warn(
    '[withDevCa] TLS_ENABLED=true but certs/rootCA.pem does not exist. Run '
    + '`npm run certs` at the repository root, or requests to the API will fail '
    + 'certificate verification.',
  );
}

const child = spawn(process.execPath, [target, ...args.slice(1)], {
  cwd: SERVER_ROOT,
  env,
  stdio: 'inherit',
});

// Forward the signals a Ctrl+C sends, so an interrupted probe stops the probe
// rather than orphaning it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { try { child.kill(signal); } catch { /* already gone */ } });
}

child.on('close', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});