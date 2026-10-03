/**
 * Boots an API server bound to the THROWAWAY test database, for the end-to-end
 * suites.
 *
 * ── The problem this solves ────────────────────────────────────────────────
 *
 * The e2e suites write real documents and then talk to a real HTTP API. Those
 * two halves have to agree on ONE database:
 *
 *   - the suite connects with `connectTestDb()` — the throwaway database, so the
 *     application's own data is never touched;
 *   - the API reads whatever MONGO_URI points at.
 *
 * Against a normally-running server those are DIFFERENT databases. Every user
 * the suite created was invisible to the API, so every authenticated call came
 * back 401 and the suites reported a wall of failures that had nothing to do with
 * the subscription system. It is the same class of bug as testing against
 * production: correct isolation, wrong wiring.
 *
 * So the suite brings its own server. It is booted with MONGO_URI pointed at the
 * test database, on a free port so it cannot collide with the developer's own
 * server, and torn down when the suite ends.
 *
 * ── Why not just let the suites use the app database? ─────────────────────
 *
 * Because they create and delete users, and an interrupted run leaves documents
 * behind — 129 stray accounts had accumulated that way before the test-database
 * guard was added. Isolating the data is the right call; the server has to be
 * brought along with it.
 */
const { spawn } = require('child_process');
const path = require('path');

const { connectTestDb, validateTestUri } = require('./testDbGuard');

const SERVER_ENTRY = path.join(__dirname, '..', 'index.js');

/** True when something is already answering on this port. */
async function isListening(port, host = '127.0.0.1') {
  const net = require('net');
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * Find a port nothing is using, starting at `preferred`.
 * @returns {Promise<number>}
 */
async function freePort(preferred = 5099) {
  for (let port = preferred; port < preferred + 40; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await isListening(port))) return port;
  }
  throw new Error(`No free port found in ${preferred}..${preferred + 40}`);
}

/**
 * Start a server for the suite, connected to the test database.
 *
 * @param {object}  [options]
 * @param {number}  [options.port]  preferred port; a free one is chosen nearby
 * @param {Record<string,string>} [options.env]  extra environment for the child
 * @returns {Promise<{ok: true, base: string, port: number, stop: () => Promise<void>}
 *                 | {ok: false, reason: string}>}
 */
async function startTestServer(options = {}) {
  const verdict = validateTestUri();
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  // The server needs MONGO_URI — that is what it reads. Pointing it at the test
  // database is the entire point; the suite's own connection already is.
  const env = {
    ...process.env,
    MONGO_URI: verdict.uri,
    NODE_ENV: 'test',
    // Tells utils/envFile.js that this is a real server being started FOR the
    // suite, not a test process: it must still read server/.env for JWT_SECRET
    // and the rest, or it dies on boot. The suite itself keeps the guard.
    SUPPLIWISE_TEST_SERVER: '1',
    // Never bind a shared port, and never send real mail from a test run.
    EMAIL_ENABLED: 'false',
    ...(options.env || {}),
  };
  if (options.port) env.PORT = String(options.port);

  const port = options.port || (await freePort());
  env.PORT = String(port);

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: path.join(__dirname, '..'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  const capture = (chunk) => {
    // Kept for the failure message only — a test run should not spray server
    // output over its own results.
    logs.push(String(chunk));
    if (logs.length > 60) logs.shift();
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);

  // Wait for the port to answer, or give up with the reason.
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      return {
        ok: false,
        reason: `the test server exited with code ${child.exitCode}:\n${logs.join('').slice(-1200)}`,
      };
    }
    // eslint-disable-next-line no-await-in-loop
    if (await isListening(port)) {
      return {
        ok: true,
        base: `http://127.0.0.1:${port}`,
        port,
        stop: () => new Promise((resolve) => {
          if (child.exitCode !== null) { resolve(); return; }
          child.once('exit', () => resolve());
          child.kill('SIGTERM');
          // Escalate if it ignores SIGTERM, so a stuck child cannot hold the
          // port for the next run.
          setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 4000);
        }),
      };
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 400));
  }
  child.kill('SIGKILL');
  return { ok: false, reason: `the test server never opened port ${port}:\n${logs.join('').slice(-1200)}` };
}

module.exports = { startTestServer, freePort, isListening, connectTestDb };
