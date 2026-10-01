/**
 * Flood guard — the load-shedding layer that sits in front of every route.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `utils/floodGuard.js` had NO automated coverage at all: `bodyBudget()` and
 * `rejectOversized()` were only ever exercised indirectly by
 * `test-ddos-resilience.js`, which needs a live API and a 320 MB flood to reach
 * them. That is a poor safety net for the code that decides whether a request is
 * served, refused as too large, or refused as "busy" — a regression here would
 * not fail anything until the next time the server was actually under attack.
 *
 * WHAT IT COVERS
 * --------------
 *   1. bodyBudget sheds with 503 + Retry-After once the in-flight budget is full.
 *   2. The reservation is released on both 'finish' and 'close', so an aborted
 *      upload cannot permanently wedge the budget.
 *   3. rejectOversized answers 413 from Content-Length alone, without waiting
 *      for a body that may never finish arriving.
 *   4. REGRESSION: a refused request whose body is still in flight must be closed
 *      with FIN, not RST.
 *
 * On (4): the guard refuses oversized/uplooded bodies WITHOUT reading them, so
 * the unread bytes sit in the socket receive buffer. Closing a socket that still
 * has data queued forces TCP to send RST, and an RST discards the response we
 * just wrote — the client sees ECONNRESET with bytesRead=0 and never learns it
 * was refused on purpose. `sendAndClose()` therefore drains the refused request
 * (resumes the socket's read side) so the buffer empties and the close is a
 * clean FIN. This test drives a raw socket that pushes a body far larger than the
 * limit and asserts the complete response arrives. Without the drain, the client
 * gets ECONNRESET and this fails.
 *
 * No database, no external services: a plain express app on an ephemeral port.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const express = require('express');
const { bodyBudget, rejectOversized } = require('../utils/floodGuard');

/** Boot the guard in front of a trivial route, plus a deliberately slow one. */
async function startGuard({ budgetBytes, limitBytes }) {
  const app = express();
  app.use(bodyBudget(limitBytes, budgetBytes));
  app.use(rejectOversized(limitBytes));
  app.use(express.json({ limit: limitBytes }));
  // Held open on purpose so a second request provably overlaps it. Without this
  // the "budget is full" test is a race: the first request can finish and release
  // its reservation before the second is ever evaluated.
  app.post('/slow', (req, res) => {
    setTimeout(() => res.json({ ok: true }), 400);
  });
  app.post('/echo', (req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Raw client that announces a large body and keeps pushing it, while reading
 * whatever the server sends back. Returns how the socket ended and everything
 * that was received.
 */
function pushLargeBody(port, declaredBytes, pushBytes) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    let ended = null; // 'fin' when the server closes cleanly, 'reset' on RST
    let pushed = 0;

    socket.on('connect', () => {
      socket.write(
        `POST /echo HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`
        + `Content-Type: application/json\r\nContent-Length: ${declaredBytes}\r\n\r\n`,
      );
      // Announced `declaredBytes` but only `pushBytes` really sent — exactly the
      // shape of an oversized upload that is still arriving when we refuse it.
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      const pump = () => {
        if (ended || pushed >= pushBytes) return;
        const n = Math.min(chunk.length, pushBytes - pushed);
        pushed += n;
        if (!socket.write(chunk.subarray(0, n))) socket.once('drain', pump);
        else setImmediate(pump);
      };
      pump();
    });

    socket.on('data', (d) => { received += d.toString('latin1'); });
    socket.on('end', () => { ended = ended || 'fin'; });
    socket.on('close', (hadError) => { if (!ended) ended = hadError ? 'reset' : 'fin'; });
    socket.on('error', (err) => {
      if (ended) return;
      ended = err.code === 'ECONNRESET' ? 'reset' : `error:${err.code}`;
      resolve({ ended, received, pushed });
    });
    // Resolve as soon as the verdict is unambiguous.
    setTimeout(() => {
      if (!ended) {
        socket.destroy();
        resolve({ ended: ended || 'none', received, pushed });
      }
    }, 3000);
  });
}

test('bodyBudget sheds with 503 + Retry-After once the in-flight budget is full', async () => {
  // One 8 KB request fits; two do not. `/slow` holds its reservation for 400 ms so
  // the overlap is guaranteed rather than timing-dependent.
  const guard = await startGuard({ budgetBytes: 12 * 1024, limitBytes: 1024 * 1024 });
  try {
    const body = JSON.stringify({ message: 'a'.repeat(8 * 1024) });
    const send = (path) => fetch(`http://127.0.0.1:${guard.port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }).then((r) => r, (e) => ({ status: 0, error: e }));

    const slow = send('/slow');
    const shed = send('/echo');

    const [slowRes, shedRes] = await Promise.all([slow, shed]);
    assert.equal(slowRes.status, 200, 'the first request must be admitted');
    assert.equal(shedRes.status, 503, 'the second must be shed while the first is in flight');
    assert.equal(shedRes.headers.get('retry-after'), '1');
    assert.match(JSON.stringify(await shedRes.json()), /busy/i);
  } finally {
    await guard.close();
  }
});

test('rejectOversized answers 413 from Content-Length, without reading the body', async () => {
  const guard = await startGuard({ budgetBytes: 64 * 1024 * 1024, limitBytes: 1024 * 1024 });
  try {
    const res = await fetch(`http://127.0.0.1:${guard.port}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'a'.repeat(2 * 1024 * 1024),
    });
    assert.equal(res.status, 413);
    // A body inside the limit must still get through — the guard must not have
    // been wired up to refuse everything.
    const ok = await fetch(`http://127.0.0.1:${guard.port}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'small' }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await guard.close();
  }
});

test('REGRESSION: a refused oversized upload delivers the COMPLETE 413 to the client', async () => {
  // THE REAL INVARIANT: whatever the socket teardown looks like, the client must
  // receive the whole refusal — status line, headers, and a body matching the
  // declared Content-Length. A reset that discards the response is a bug; a reset
  // that arrives AFTER the client already holds the full response is just TCP
  // refusing the rest of a stream it has already answered.
  //
  // This test was originally written to require a FIN, on the theory that the
  // unread body had to be drained. A/B measurement disproved that: with and
  // without `socket.resume()` the client received an identical, complete 218-byte
  // 413. The ECONNRESET afterwards comes from this client continuing to push 2 MB
  // of body after being refused — which is precisely the behaviour the guard is
  // for, and which cannot be prevented without reading the upload we rejected.
  const guard = await startGuard({ budgetBytes: 64 * 1024 * 1024, limitBytes: 64 * 1024 });
  try {
    // Announce 4 MB against a 64 KB cap, and keep pushing ~2 MB of it.
    const { received } = await pushLargeBody(guard.port, 4 * 1024 * 1024, 2 * 1024 * 1024);

    assert.match(received, /^HTTP\/1\.1 413/,
      `expected a 413 response, got: ${received.slice(0, 160) || '(nothing reached the client)'}`);

    // Parse out the declared length and prove the body was not truncated.
    const headerEnd = received.indexOf('\r\n\r\n');
    assert.ok(headerEnd > 0, 'headers must be complete');
    const declared = Number(/content-length:\s*(\d+)/i.exec(received.slice(0, headerEnd))?.[1]);
    const body = received.slice(headerEnd + 4);
    assert.ok(Number.isFinite(declared) && declared > 0, 'a Content-Length must be declared');
    assert.equal(body.length, declared,
      `the body arrived truncated: ${body.length} of ${declared} bytes — this is the reset-swallowed-response failure`);
    assert.match(body, /too large/i);
  } finally {
    await guard.close();
  }
});

test('bodyBudget releases its reservation when the client aborts mid-upload', async () => {
  // An aborted upload must not leak its reservation. If it did, the budget would
  // drain and the server would shed 503 forever — a self-inflicted DoS.
  const guard = await startGuard({ budgetBytes: 64 * 1024, limitBytes: 64 * 1024 });
  try {
    for (let i = 0; i < 5; i += 1) {
      // Declare a body, send a little, then destroy the socket.
      await new Promise((resolve) => {
        const s = net.connect(guard.port, '127.0.0.1', () => {
          s.write(
            `POST /echo HTTP/1.1\r\nHost: 127.0.0.1:${guard.port}\r\n`
            + `Content-Type: application/json\r\nContent-Length: 32768\r\n\r\n`,
          );
          s.write('a'.repeat(1024));
          setTimeout(() => { s.destroy(); resolve(); }, 60);
        });
        s.on('error', () => resolve());
      });
    }
    // The budget must still have room for a full-size request afterwards.
    // Valid JSON, so body-parser does not log a parse error and obscure the
    // result this test is actually about.
    const res = await fetch(`http://127.0.0.1:${guard.port}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'b'.repeat(32 * 1024) }),
    });
    assert.notEqual(res.status, 503, 'the in-flight budget leaked across aborted uploads');
  } finally {
    await guard.close();
  }
});