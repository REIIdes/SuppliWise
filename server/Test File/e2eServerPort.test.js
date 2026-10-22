/**
 * The end-to-end harness's port allocation.
 *
 * A suite that boots a real server asks for a specific port so its log is
 * readable and reproducible. Two suites asking for the SAME port used to be a
 * coin toss: `node --test` runs every file in its own process, concurrently, so
 * whichever child bound the port first won and the other died at startup with
 * EADDRINUSE.
 *
 * That failure mode is genuinely nasty to diagnose, which is why it is worth a
 * test rather than a code comment:
 *
 *   • it only appears when the two suites happen to overlap in time, so it
 *     passes on a rerun and reads as flakiness in the code under test
 *   • it costs the ENTIRE file — the suite's tests never ran, so the report is
 *     "Test File/x.test.js — test failed" with no assertion named
 *   • the message names a port and nothing about the feature being tested
 *
 * The fix for that made the OTHER half of the problem visible: stepping over a
 * busy port means a suite that asks for a specific one sometimes gets a
 * different one, and the test guarding that ("a free requested port is used as
 * asked") is exactly where the combined run started failing. Two suites could
 * both be told the same port was free, because "free" was only ever a probe with
 * no claim behind it. Ports are now LEASED across processes before a child is
 * booted — see the lease tests at the bottom of this file.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { startTestServer, isListening, freePort, leasePort, leaseFile } = require('./e2eServer');
const { validateTestUri } = require('./testDbGuard');

const verdict = validateTestUri();
const requiresDb = { skip: !verdict.ok && `needs MONGO_TEST_URI (${verdict.reason})` };

test('a requested port is a preference, not a reservation', requiresDb, async () => {
  // Occupy the port the way a sibling suite would, then ask for it anyway.
  // Before the fix this returned {ok: false} with EADDRINUSE, taking the whole
  // file down with it.
  const squatter = await freePort(5300);
  assert.equal(await isListening(squatter), false);

  // Something is genuinely listening on `requested`, so the harness must move.
  const net = require('node:net');
  const blocker = net.createServer();
  await new Promise((ready) => blocker.listen(squatter, '127.0.0.1', ready));

  try {
    const server = await startTestServer({ port: squatter });
    assert.equal(server.ok, true, `harness should have stepped over the busy port: ${server.reason || ''}`);
    // The suite never learns the port — it talks to `base` — so moving is
    // invisible to it, which is the whole point.
    assert.notEqual(server.port, squatter, 'should not have used the occupied port');
    assert.match(server.base, new RegExp(`:${server.port}$`));
    await server.stop();
  } finally {
    await new Promise((done) => blocker.close(done));
  }
});

test('a free requested port is used as asked', requiresDb, async () => {
  // The preference must not become "always somewhere else": a suite that asks
  // for a specific port and gets a different one every time makes its logs
  // impossible to follow, which is the reason to pass one at all.
  //
  // This assertion is what a sibling suite used to break. It is now stable
  // because `startTestServer` CLAIMS the port (see the lease tests below) before
  // it boots the child, so nothing else in the run can be handed the same one
  // while this child is starting.
  const wanted = await freePort(5400);
  const server = await startTestServer({ port: wanted });
  try {
    assert.equal(server.ok, true, server.reason || '');
    assert.equal(server.port, wanted, 'an available port should be honoured exactly');
  } finally {
    if (server.ok) await server.stop();
  }
});

test('two servers started at once both come up', requiresDb, async () => {
  // The actual failing scenario, as a test: the two suites that collided asked
  // for the same port, and the harness had no way to cope. Started concurrently
  // against one preferred port, both must now succeed on distinct ports.
  const preferred = await freePort(5500);
  const [a, b] = await Promise.all([
    startTestServer({ port: preferred }),
    startTestServer({ port: preferred }),
  ]);
  try {
    assert.equal(a.ok, true, `first server failed: ${a.reason || ''}`);
    assert.equal(b.ok, true, `second server failed: ${b.reason || ''}`);
    assert.notEqual(a.port, b.port, 'concurrent servers must not share a port');
    // Both are actually answering, not merely reported as started.
    assert.equal(await isListening(a.port), true, 'first server is not listening');
    assert.equal(await isListening(b.port), true, 'second server is not listening');
  } finally {
    if (a.ok) await a.stop();
    if (b.ok) await b.stop();
  }
});

test('a suite is never handed a server another process already owns', requiresDb, async () => {
  // THE SILENT ONE. This is the bug that made the whole harness unsound, and it
  // is worth stating plainly.
  //
  // Readiness was decided by probing the port: `isListening(port)`. That cannot
  // distinguish "MY child is serving" from "something else already is" — and in
  // the one case that matters, the two are indistinguishable. Suite A binds 5124.
  // Suite B is given 5124 too; B's child fails to bind and exits; B's probe finds
  // A's server answering on 5124 and concludes it started successfully.
  //
  // B is then handed `base` pointing at A's server. Every request B makes goes
  // to A's process and A's state, so B tests nothing and reports GREEN. A test
  // suite that passes while exercising nothing is worse than one that fails.
  //
  // So: occupy the port with a plain TCP server that is NOT a SuppliWise API,
  // ask the harness for that port, and require that the harness does NOT hand
  // back a `base` pointing at it. The child cannot bind, must be reported as a
  // failure, and must be retried elsewhere.
  const occupied = await freePort(5600);
  const net = require('node:net');
  const impostor = net.createServer((socket) => socket.destroy());
  await new Promise((ready) => impostor.listen(occupied, '127.0.0.1', ready));

  try {
    const server = await startTestServer({ port: occupied });
    // The outcome may legitimately be either "moved to another port" or "gave
    // up" — both are correct. What must never happen is success on the occupied
    // port, because that is the impostor, not a server this suite started.
    if (server.ok) {
      assert.notEqual(
        server.port,
        occupied,
        'the harness reported success on a port held by a DIFFERENT process — '
        + 'the suite would have been talking to it and testing nothing',
      );
      // And the server it did get must genuinely be a SuppliWise API, not any
      // listener: the whole point is that `base` is trustworthy.
      const res = await fetch(`${server.base}/api/health`);
      assert.equal(res.status, 200, 'the server it was given must be the API');
      assert.match(await res.text(), /Server is running/);
      await server.stop();
    } else {
      // Giving up is acceptable; handing back a wrong server is not.
      assert.match(server.reason, /exited|never opened|after \d+ ports/);
    }
  } finally {
    await new Promise((done) => impostor.close(done));
  }
});

test('no server is left listening after the suite stops it', requiresDb, async () => {
  // The retry loop above can start a child that fails to bind. If that child were
  // left running it would hold a port for the next run, and the next run would
  // fail — the failure being caused by the previous run's cleanup, which is
  // close to untraceable.
  const server = await startTestServer();
  assert.equal(server.ok, true, server.reason || '');
  const { port } = server;
  await server.stop();
  assert.equal(await isListening(port), false, `port ${port} is still held after stop()`);
});

/* ── The leases that make the tests above deterministic ───────────────────── */

test('a port is not leased twice, and comes back when released', () => {
  const first = leasePort(5480);
  assert.equal(typeof first, 'function', 'an unclaimed port must be claimable');
  assert.equal(leasePort(5480), null, 'a second claim of a held port must be refused');
  first();
  const again = leasePort(5480);
  assert.equal(typeof again, 'function', 'a released port must be claimable again');
  again();
});

test('an abandoned lease does not fence a port off forever', () => {
  // What a crashed or SIGKILLed run leaves behind. Without the reclaim, the
  // lease directory would slowly swallow the whole range and every later run
  // would fail with "No unclaimed port found" — a failure caused by a run that
  // ended hours ago, on someone else's machine.
  const file = leaseFile(5481);
  fs.writeFileSync(file, JSON.stringify({ pid: 0x7fffffe0, at: Date.now() }));
  try {
    const reclaimed = leasePort(5481);
    assert.equal(typeof reclaimed, 'function', 'a dead holder must not keep the port');
    reclaimed();
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a lease held by another process is refused, then reclaimed when it dies', async () => {
  // THE POINT OF THE LEASE. Every suite is its own process, so in-process
  // bookkeeping proves nothing; this holds the claim in a real second process.
  const port = 5482;
  const holder = spawn(process.execPath, ['-e', `
    const { leasePort } = require(${JSON.stringify(path.join(__dirname, 'e2eServer.js'))});
    const release = leasePort(${port});
    if (!release) { console.error('holder could not claim the port'); process.exit(1); }
    console.log('held');
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  holder.stderr.on('data', (chunk) => { stderr += String(chunk); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`holder never claimed the port: ${stderr}`)), 20000);
    holder.stdout.once('data', () => { clearTimeout(timer); resolve(); });
    holder.once('exit', (code) => { clearTimeout(timer); reject(new Error(`holder exited ${code}: ${stderr}`)); });
  });

  try {
    assert.equal(leasePort(port), null, 'a port claimed by another process must be refused');
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    // The child was killed, so its file is still there and its owner is gone.
    const afterDeath = leasePort(port);
    assert.equal(typeof afterDeath, 'function', 'the port must be usable once its holder dies');
    afterDeath();
  } finally {
    if (holder.exitCode === null) holder.kill('SIGKILL');
    fs.rmSync(leaseFile(port), { force: true });
  }
});

test('a running harness holds its own port against a second suite', requiresDb, async () => {
  // The behaviour the combined CI run used to get wrong: suite A is handed 5124,
  // suite B probes 5124, finds nothing listening yet, is handed the same port,
  // and one of the two children dies mid-boot. Asserting the claim is held FOR
  // THE LIFETIME OF THE SERVER (not merely at the instant it was chosen) is what
  // closes that window.
  const server = await startTestServer({ port: 5483 });
  assert.equal(server.ok, true, server.reason || '');
  try {
    assert.equal(leasePort(server.port), null, 'the harness must claim the port it boots on');
  } finally {
    await server.stop();
  }
  const after = leasePort(server.port);
  assert.equal(typeof after, 'function', 'stopping the server must give the port back');
  after();
});
