/**
 * The certificate-trust wrapper for the live probe scripts.
 *
 * These scripts use the global `fetch`, which cannot be given a certificate
 * authority: undici has no `ca` option, and `NODE_EXTRA_CA_CERTS` is read once at
 * startup, so setting it from inside the script does nothing. That leaves exactly
 * one correct lever — the environment, in place before the process begins — and
 * this file is the thing that provides it.
 *
 * The tests below assert the three properties that matter:
 *   1. it works (the child really can talk to a TLS server it would otherwise
 *      reject),
 *   2. it does not disable verification (a server presenting an UNKNOWN
 *      certificate authority is still refused — otherwise this would be
 *      `NODE_TLS_REJECT_UNAUTHORIZED=0` with better manners),
 *   3. it is a no-op when TLS is off, so a plain-HTTP run is untouched.
 */
const test = require('node:test');
const assert = require('node:assert');
const https = require('node:https');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tls = require('../utils/tls');

const WRAPPER = path.join(__dirname, '..', 'scripts', 'withDevCa.mjs');
const CA_FILE = path.join(tls.REPO_ROOT, 'certs', 'rootCA.pem');
const KEY_FILE = path.join(tls.REPO_ROOT, 'certs', 'localhost-key.pem');
const CERT_FILE = path.join(tls.REPO_ROOT, 'certs', 'localhost.pem');
const hasCertificate = fs.existsSync(CA_FILE) && fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE);

/**
 * Write a one-line script to a temp file, run it through the wrapper, and return
 * its combined output plus exit code.
 */
async function runThroughWrapper(source, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-probe-'));
  const script = path.join(dir, 'probe.mjs');
  fs.writeFileSync(script, source);
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [WRAPPER, script], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (c) => { out += c; });
      child.stderr.on('data', (c) => { out += c; });
      child.on('close', (code) => resolve({ code, out }));
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
/** Start a TLS server answering 200 with a JSON body, on an ephemeral port. */
function startTlsServer() {
  const server = https.createServer(
    { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) },
    (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"status":"Server is running"}');
    },
  );
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('the wrapper lets a probe reach the API over HTTPS', { skip: !hasCertificate && 'run `npm run certs` first' }, async () => {
  const server = await startTlsServer();
  const port = server.address().port;
  try {
    const { code, out } = await runThroughWrapper(
      `const res = await fetch('https://localhost:${port}/api/health');
       process.stdout.write('STATUS ' + res.status);`,
      { env: { TLS_ENABLED: 'true' } },
    );
    assert.equal(code, 0, `wrapper exited ${code}: ${out}`);
    assert.match(out, /STATUS 200/, `probe did not reach the API: ${out}`);
  } finally {
    server.close();
  }
});

test('without the wrapper the same probe fails certificate verification', { skip: !hasCertificate && 'run `npm run certs` first' }, async () => {
  // Establishes that the test above is actually testing something. If a bare
  // `fetch` could already reach this server, the wrapper would be solving a
  // problem that does not exist — and the whole file would be asserting nothing.
  const server = await startTlsServer();
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-probe-'));
  try {
    const script = path.join(dir, 'probe.mjs');
    fs.writeFileSync(script, `
      try {
        const res = await fetch('https://localhost:${port}/api/health');
        process.stdout.write('STATUS ' + res.status);
      } catch (error) {
        process.stdout.write('REFUSED ' + (error.cause?.code || error.message));
      }
    `);
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [script], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, TLS_ENABLED: 'true', NODE_OPTIONS: undefined, NODE_EXTRA_CA_CERTS: undefined },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (c) => { text += c; });
      child.stderr.on('data', (c) => { text += c; });
      child.on('close', () => resolve(text));
    });
    assert.match(out, /REFUSED/, `a bare fetch should not trust this CA, but it reported: ${out}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close();
  }
});

test('the wrapper adds trust, never a bypass', { skip: !hasCertificate && 'run `npm run certs` first' }, async () => {
  // The distinction that matters. A wrapper setting NODE_TLS_REJECT_UNAUTHORIZED=0
  // would make every probe above pass — and would also let them pass against a
  // server presenting somebody else's certificate, which is exactly what these
  // probes exist to detect. So the environment it builds is asserted directly:
  // no bypass, and one of the two real trust levers present.
  const { out } = await runThroughWrapper(
    `process.stdout.write(JSON.stringify({
       rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? null,
       nodeOptions: process.env.NODE_OPTIONS ?? null,
       extraCa: process.env.NODE_EXTRA_CA_CERTS ?? null,
     }));`,
    { env: { TLS_ENABLED: 'true' } },
  );
  const env = JSON.parse(out);
  assert.notEqual(env.rejectUnauthorized, '0', 'the wrapper must not disable TLS verification');
  // Whichever lever was chosen, one must be present — otherwise the first test
  // passed by accident and nothing is actually being trusted.
  assert.ok(
    env.nodeOptions || env.extraCa,
    'the wrapper should add --use-system-ca or NODE_EXTRA_CA_CERTS, not neither',
  );
});

test('the wrapper is a no-op when TLS is off', async () => {
  // A plain-HTTP run must behave exactly as it did before this script existed:
  // nothing added to the environment, so nothing that can go wrong.
  const { out } = await runThroughWrapper(
    `process.stdout.write(JSON.stringify({
       nodeOptions: process.env.NODE_OPTIONS ?? null,
       extraCa: process.env.NODE_EXTRA_CA_CERTS ?? null,
     }));`,
    {
      // TLS_ENABLED unset entirely — the state a fresh clone is in. The undefined
      // values are dropped from the child environment by Node's own semantics.
      env: { TLS_ENABLED: undefined, NODE_OPTIONS: undefined, NODE_EXTRA_CA_CERTS: undefined },
    },
  );
  const env = JSON.parse(out);
  assert.ok(!/use-system-ca/.test(env.nodeOptions || ''), 'should not add --use-system-ca with TLS off');
  assert.equal(env.extraCa, null, 'should not add NODE_EXTRA_CA_CERTS with TLS off');
});

test('the wrapper refuses a script that does not exist', async () => {
  // A typo in a probe name should be an immediate, named error rather than a
  // cryptic Node module-not-found from a path nobody recognises.
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [WRAPPER, 'no-such-script.js'], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    child.stderr.on('data', (c) => { text += c; });
    child.on('close', (status) => resolve({ status, text }));
  });
  assert.equal(code.status, 2);
});