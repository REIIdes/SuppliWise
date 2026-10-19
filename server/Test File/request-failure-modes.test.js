'use strict';
/**
 * Failure modes that used to look like the server being down.
 *
 * THREE SEPARATE FAULTS, ONE SYMPTOM
 * ---------------------------------
 *  1. Express 4 never awaits an async handler, so a route with a bare `await`
 *     that rejects leaves the request unanswered. The socket stays open until
 *     the client gives up at its own timeout, and the API reads as an outage.
 *  2. A gzipped `text/event-stream` buffers every `event:` line inside zlib
 *     until a block fills. The connection looks alive and says nothing, which
 *     is what "the chat only updates when I reload" actually was.
 *  3. The admin 2FA challenge map used to grow with every abandoned sign-in
 *     for the life of the process, and each entry was a live second factor
 *     waiting to be spent.
 *
 * 1 and 2 are exercised here for real — a rejecting handler through the wrapper,
 * and a compression policy over an actual HTTP socket. 3 is structural, because
 * the map lives inside routes/auth.js behind a password step and a database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');

require('dotenv').config();

const { asyncRoute } = require('../utils/asyncRoute');
const compressionPolicy = require('../utils/compressionPolicy');

const INDEX_SRC = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
const AUTH_SRC = fs.readFileSync(path.resolve(__dirname, '../routes/auth.js'), 'utf8');

const fakeRes = () => {
  const headers = {};
  return {
    headersSent: false,
    getHeader: (n) => headers[String(n).toLowerCase()],
    setHeader(n, v) { headers[String(n).toLowerCase()] = v; },
  };
};

test('a rejecting async handler becomes a response, not a hanging request', async () => {
  const boom = new Error('cache unreadable');
  const res = fakeRes();
  const seen = [];
  await asyncRoute(async () => { throw boom; })({}, res, (error) => seen.push(error));
  assert.deepEqual(seen, [boom], 'the rejection must reach Express error middleware while the request is alive');
});

test('a synchronous throw is forwarded once, not swallowed', async () => {
  const boom = new Error('bad input');
  const seen = [];
  await asyncRoute(() => { throw boom; })({}, fakeRes(), (error) => seen.push(error));
  assert.deepEqual(seen, [boom]);
});

test('a handler that answers is left completely alone', async () => {
  // The wrapper must not double-answer, and must not mark a working route as
  // failed just because it is async.
  const seen = [];
  let wrote = false;
  const res = { ...fakeRes(), json() { wrote = true; } };
  await asyncRoute(async (req, r) => { r.json({ ok: true }); })({}, res, (e) => seen.push(e));
  assert.equal(wrote, true);
  assert.deepEqual(seen, [], 'a fulfilled handler must not also call next(error)');
});

test('a rejection after the response was already sent is logged, not re-thrown', async () => {
  // Calling next() here would make Express try to write a second response and
  // throw ERR_HTTP_HEADERS_SENT — turning a partial delivery into a crashed
  // request. The client already has its answer; the honest action is the log.
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    const res = { ...fakeRes(), headersSent: true };
    const seen = [];
    await asyncRoute(async () => { throw new Error('too late'); })({}, res, (e) => seen.push(e));
    assert.deepEqual(seen, [], 'next(error) after headers were sent would throw inside Express');
    assert.equal(logged.length, 1, 'and the fault is still recorded');
    assert.match(logged[0], /after the response was sent/);
  } finally {
    console.error = realError;
  }
});

test('the handlers that hung are wrapped', () => {
  // Each of these is a sign-in path: a rejected read there used to produce no
  // answer at all, which is indistinguishable from the API being down.
  const totp = fs.readFileSync(path.resolve(__dirname, '../routes/totp.js'), 'utf8');
  const recovery = fs.readFileSync(path.resolve(__dirname, '../routes/recoveryCodes.js'), 'utf8');
  assert.match(totp, /router\.post\('\/verify', verifyLimiter, asyncRoute\(/, 'authenticator verify');
  assert.match(recovery, /router\.post\('\/verify', redeemLimiter, asyncRoute\(/, 'recovery-code redeem');
  for (const src of [totp, recovery]) {
    assert.match(src, /SecurityEvent\.write\([\s\S]{0,400}\.catch\(/,
      'and a failure to record the evidence never swallows the 401 the user is owed');
  }
});

test('a slow cache read on a supplement page cannot hang the request either', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../routes/supplement_detail.js'), 'utf8');
  assert.match(src, /readGuide\([\s\S]{0,200}catch/,
    'a guide cache that cannot be read is a miss, not an unanswered GET');
});

// ── Compression over a real socket ─────────────────────────────────────────
function startPolicyApp() {
  const express = require('express');
  const compression = require('compression');
  const app = express();
  app.use(compression(compressionPolicy.options()));
  app.get('/big', (req, res) => {
    res.json({ padding: 'x'.repeat(4096) });
  });
  app.get('/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.flushHeaders();
    res.write('event: ping\ndata: first\n\n');
    // Held open on purpose: the property being tested is that the FIRST event
    // arrives while the response is still running.
    setTimeout(() => res.end(), 250);
  });
  const server = http.createServer(app);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers: { 'Accept-Encoding': 'gzip', ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a large JSON body is still compressed — the win that motivated the middleware', async () => {
  const { server, port } = await startPolicyApp();
  try {
    const r = await get(port, '/big');
    assert.equal(r.headers['content-encoding'], 'gzip', '500 KB AI payloads are why this exists');
    assert.ok(r.body.length < 4096, 'and the body really did shrink');
  } finally {
    server.close();
  }
});

test('an event stream arrives uncompressed and immediately', async () => {
  const { server, port } = await startPolicyApp();
  try {
    const firstByte = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/stream', headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
        res.once('data', (chunk) => resolve({ headers: res.headers, chunk: chunk.toString() }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(2000, () => reject(new Error('no event arrived within 2 s — the stream is being buffered')));
      req.end();
    });
    assert.equal(firstByte.headers['content-encoding'], undefined,
      'mime-db calls text/event-stream compressible, so the default filter says yes and stalls the stream');
    assert.match(firstByte.chunk, /^event: ping/, 'the whole first event is on the wire, not a deflate block');
  } finally {
    server.close();
  }
});

test('a client that asks not to be compressed is honoured', async () => {
  const { server, port } = await startPolicyApp();
  try {
    const r = await get(port, '/big', { 'x-no-compression': '1' });
    assert.equal(r.headers['content-encoding'], undefined);
  } finally {
    server.close();
  }
});

test('index.js installs this policy rather than a private copy', () => {
  // The rule and the wiring must not drift: a second inline filter here would
  // silently win and the tests above would be measuring a module nothing uses.
  assert.match(INDEX_SRC, /compression\(compressionPolicy\.options\(\)\)/);
  assert.doesNotMatch(INDEX_SRC, /compression\(\{[\s\S]{0,200}event-stream/, 'no duplicated SSE rule left behind');
});

// ── The admin challenge map ────────────────────────────────────────────────
test('an abandoned admin sign-in cannot grow memory forever', () => {
  // Every entry was a live 2FA challenge with a spendable second factor, and
  // they were only ever removed when spent — a page left open, or a scripted
  // flood of /admin-login, held them for the life of the process.
  assert.match(AUTH_SRC, /const ADMIN_CHALLENGE_MAX = (\d+);/);
  const max = Number(AUTH_SRC.match(/const ADMIN_CHALLENGE_MAX = (\d+);/)[1]);
  assert.ok(max >= 100 && max <= 10000, `the ceiling is a real bound, not ${max}`);
  assert.match(AUTH_SRC, /function pruneAdminChallenges\(\)[\s\S]{0,900}adminChallenges\.size > ADMIN_CHALLENGE_MAX/,
    'expired entries are swept AND the map is evicted down to the ceiling');
  // Swept from the write path, so a flood is bounded even if the timer is starved.
  const setIndex = AUTH_SRC.indexOf('pruneAdminChallenges();');
  const storeIndex = AUTH_SRC.indexOf('adminChallenges.set(challengeId');
  assert.ok(setIndex !== -1 && setIndex < storeIndex, 'pruning happens before a challenge is stored');
  // And the sweeper must not keep a test process or a `node -e` alive.
  assert.match(AUTH_SRC, /adminChallengeSweeper\.unref\(\)/);
});

// ── Metering the side doors ────────────────────────────────────────────────
test('every route a locked-out credential could reach honours the lockout', () => {
  // `/api/auth` had the check; the assessment, survey, instrument, proposal and
  // medical-review mounts did not, so an account under a lockout could still
  // drive the paths that write health data and ratify clinical changes.
  // Honouring an existing lockout is not escalation — nothing on those paths
  // creates one.
  for (const mount of ['/api/assessment', '/api/survey', '/api/instrument', '/api/proposals', '/api/medical-review', '/api/admin', '/api/auth']) {
    const line = INDEX_SRC.split('\n').find((l) => l.includes(`app.use('${mount}'`) && l.includes('Limiter'));
    assert.ok(line, `${mount} is rate-limited`);
    assert.ok(line.includes('lockoutCheck'), `${mount} must refuse a locked-out credential: ${line.trim()}`);
  }
});
