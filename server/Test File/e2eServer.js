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
 *
 * Checks whether the port is FREE, and returns it if so — it does not reserve
 * it. Between this returning and the child process binding there is a window in
 * which another concurrently-running suite can pick the same port, because each
 * file is its own process with no shared state to coordinate through. That race
 * is why `startTestServer` below RETRIES rather than trusting this result: a
 * single check narrows the window enormously, and the retry closes it.
 *
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
    // Which is exactly why TLS has to be switched off here. Lifting that guard
    // means the child reads the developer's real .env — so a developer who has
    // turned TLS on for local development would get a test server that serves
    // HTTPS, while every suite below talks plain HTTP to it. The symptom is a
    // wall of connection errors that names neither TLS nor the certificate, and
    // it appears only on the machines where HTTPS is switched on, which is the
    // worst possible time to introduce it.
    //
    // Set from the OS environment here (not .env), because utils/envFile.js
    // treats OS-provided values as authoritative and never overwrites them.
    //
    // This also covers HSTS: the header is only sent when TLS is being served
    // (see utils/tls.js), so pinning TLS off keeps the test server from
    // advertising an HTTPS-only host. That matters because HSTS is cached in the
    // BROWSER against the host — a test run on a machine with TLS enabled would
    // otherwise leave a localhost entry behind, and the developer's next
    // http://localhost:5000 would be refused with nothing naming the cause.
    TLS_ENABLED: 'false',
    // Never bind a shared port, and never send real mail from a test run.
    EMAIL_ENABLED: 'false',
    ...(options.env || {}),
  };
  // The requested port is a PREFERENCE, not a reservation, and this distinction
  // is the fix for a suite that failed intermittently with
  // "Cannot bind port 5124 — EADDRINUSE".
  //
  // Two suites asked for 5124 (admin-session-expiry and totp-and-recovery), and
  // `node --test` runs every FILE in its own process, concurrently. So whichever
  // child bound 5124 first won, and the other one died at startup — a failure
  // that appears only when the two happen to overlap, passes on a rerun, and
  // says nothing about the code under test. It also cost the whole file: the
  // suite's tests never ran, which is why it surfaced as an entire file failing
  // with 'test failed' and no individual assertion named.
  //
  // So a requested port that is already taken is stepped over rather than
  // obeyed. Suites pass a port so their logs are readable and reproducible, not
  // to reserve one — and the suite never learns the port, because `base` is what
  // it talks to.
  //
  // Retry loop, because "the port was free a moment ago" is not a guarantee.
  //
  // Each file is its own process with no shared state, so two suites starting at
  // the same instant can both find the same port free and both spawn a child
  // aimed at it. The loser prints EADDRINUSE and exits. `freePort` above shrinks
  // that window but cannot close it, so this closes it: a bind failure is
  // retried on a different port.
  //
  // The failure is recognised from the child's OWN log rather than guessed from
  // the exit code, because a bind failure is not the only reason a child can
  // exit, and retrying an unrelated crash (a bad .env, a missing secret) just
  // delays a real error by four long retries. Only a message naming a bind
  // failure is retried; anything else is reported immediately.
  const ATTEMPTS = 4;
  let lastReason = '';

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const port = await freePort((options.port || 5099) + attempt);
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

    // Readiness is confirmed by THIS CHILD'S OWN OUTPUT, never by probing the
    // port.
    //
    // Probing the port cannot tell "my child is serving" from "something else
    // already is", and those are indistinguishable exactly when it matters. Two
    // suites asking for the same port: the first child binds it, the second
    // child's bind fails, and the second's `isListening(port)` returns TRUE —
    // because the FIRST server is there. The second suite is then handed a
    // `base` pointing at a server it does not own, and every request it makes
    // goes to the wrong database state.
    //
    // That failure is silent and it is far worse than a reported error: the
    // suite reports green while testing nothing. It is exactly what happened
    // here — my own concurrency test caught it, by asserting the two ports
    // differed and finding them equal.
    //
    // The child prints `Server running on <scheme>://localhost:<port>` once it
    // is genuinely listening, so waiting for that line (and requiring it to name
    // the port THIS child was given) is unambiguous: if another process holds
    // the port, this child never prints it, and the bind failure is caught below
    // and retried on a different port.
    const boundPattern = new RegExp(`Server running on \\w+://[^\\s]*:?${port}\\b`);
    const deadline = Date.now() + 40000;
    let announced = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        const output = logs.join('');
        lastReason = `the test server exited with code ${child.exitCode}:\n${output.slice(-1200)}`;
        // A bind failure means the port was taken between the check and the
        // bind. Anything else is a real fault and retrying would only hide it.
        if (/\bEADDRINUSE\b/.test(output) && attempt < ATTEMPTS - 1) break;
        return { ok: false, reason: lastReason };
      }
      if (!announced) {
        announced = boundPattern.test(logs.join(''));
        // A server that binds but cannot answer requests is not usable, so the
        // probe is kept as a second condition — just never as the only one.
        if (announced && !(await isListening(port))) announced = false;
      }
      if (announced) {
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
      await new Promise((r) => setTimeout(r, 200));
    }

    child.kill('SIGKILL');
    lastReason = `the test server never opened port ${port}:\n${logs.join('').slice(-1200)}`;
    // Timed out without exiting — ported past the deadline rather than crashed.
    // Retrying is still correct: something else may hold the port.
  }

  return { ok: false, reason: `${lastReason} (after ${ATTEMPTS} ports)` };
}

module.exports = { startTestServer, freePort, isListening, connectTestDb };
