'use strict';
/**
 * The in-repo RFC 6238 implementation that replaced `speakeasy`.
 *
 * Two things had to be proven before the dependency could go, and both are
 * asserted here rather than reasoned about:
 *
 *  1. The math is the spec's math. RFC 6238 Appendix B publishes codes for a
 *     known seed at known times, so a wrong truncation, counter width or epoch
 *     fails against a source nobody can argue with.
 *  2. It agrees with what the old library produced FOR THE SEEDS ALREADY IN THE
 *     DATABASE. Those vectors below were captured from speakeasy 2.0.0 on
 *     2026-10-19, in the last commit that still had it. They are the real
 *     regression test: an enrolment from 2025 must keep verifying tomorrow,
 *     because the person who enrolled has no way to re-scan except by guessing
 *     that their authenticator app is broken.
 *
 * The interesting case is the 52-character seed. A 32-byte key base32-encodes to
 * 52 characters, and decoding those 260 bits leaves four bits over. RFC 4648
 * calls them padding and drops them; the old library emitted a 33rd byte. Same
 * input, different HMAC key, and every code silently stops matching — so this
 * implementation follows the old library and the vectors pin it in place.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const rfc = require('../utils/totpRfc');

/** Codes captured from speakeasy 2.0.0 before it was removed. */
const LEGACY_VECTORS = [
  { name: '52-character seed (the partial-byte case)', secret: 'MVZC6NRXORQWM6BXN6ZQ65ZXMVZXKY3TNJYWK6JYEBQWK6DPNB2A', time: 1700000000, code: '426145' },
  { name: '52-character seed', secret: 'MVZC6NRXORQWM6BXN6ZQ65ZXMVZXKY3TNJYWK6JYEBQWK6DPNB2A', time: 1700000029, code: '143107' },
  { name: '52-character seed', secret: 'MVZC6NRXORQWM6BXN6ZQ65ZXMVZXKY3TNJYWK6JYEBQWK6DPNB2A', time: 1715000123, code: '797652' },
  { name: '52-character seed', secret: 'MVZC6NRXORQWM6BXN6ZQ65ZXMVZXKY3TNJYWK6JYEBQWK6DPNB2A', time: 1799999999, code: '783303' },
  { name: '32-character seed (exact multiple)', secret: 'NBSWY3DPEB3W64TMMQXC4LQAOBSWY3DP', time: 1700000000, code: '108977' },
  { name: '32-character seed', secret: 'NBSWY3DPEB3W64TMMQXC4LQAOBSWY3DP', time: 1700000030, code: '189281' },
  { name: '32-character seed', secret: 'NBSWY3DPEB3W64TMMQXC4LQAOBSWY3DP', time: 1799999999, code: '914925' },
];

test('codes match the ones the previous library produced for the same seeds', () => {
  for (const v of LEGACY_VECTORS) {
    assert.equal(rfc.totp({ secret: v.secret, encoding: 'base32', time: v.time }), v.code, v.name);
  }
});

test('the 52-character seed decodes to 33 bytes, the way the old decoder did', () => {
  // Deliberate non-conformance, documented in utils/totpRfc.js: dropping the
  // four leftover bits would change the key and break every seed this system
  // has already generated. If anyone "tidies" this, the legacy vectors above
  // fail first — this only explains why they failed.
  const key = rfc.base32Decode(LEGACY_VECTORS[0].secret);
  assert.equal(key.length, 33);
  assert.equal(key[key.length - 1], 0, 'the extra byte is the zero-filled padding bits');
  assert.equal(rfc.base32Decode('NBSWY3DPEB3W64TMMQXC4LQAOBSWY3DP').length, 20, 'an exact multiple adds nothing');
});

test('RFC 6238 Appendix B (SHA-1, 8 digits) verifies against the spec itself', () => {
  const secret = rfc.base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  const vectors = {
    59: '94287082', 1111111109: '07081804', 1111111111: '14050471',
    1234567890: '89005924', 2000000000: '69279037', 20000000000: '65353130',
  };
  for (const [time, expected] of Object.entries(vectors)) {
    assert.equal(rfc.totp({ secret, encoding: 'base32', digits: 8, time: Number(time) }), expected, `t=${time}`);
  }
});

test('verify accepts the previous and next step and nothing beyond them', () => {
  const secret = LEGACY_VECTORS[0].secret;
  const now = 1700000000;
  const codeAt = (offset) => rfc.totp({ secret, encoding: 'base32', time: now + offset * 30 });

  assert.ok(rfc.verify({ secret, token: codeAt(0), time: now, window: 1 }), 'current step');
  assert.ok(rfc.verify({ secret, token: codeAt(-1), time: now, window: 1 }), 'one step behind — ordinary phone drift');
  assert.ok(rfc.verify({ secret, token: codeAt(1), time: now, window: 1 }), 'one step ahead');
  assert.ok(!rfc.verify({ secret, token: codeAt(-2), time: now, window: 1 }), 'two steps behind is refused');
  assert.ok(!rfc.verify({ secret, token: codeAt(2), time: now, window: 1 }), 'two steps ahead is refused');
  assert.ok(rfc.verify({ secret, token: codeAt(0), time: now, window: 0 }), 'window 0 still accepts this step');
  assert.ok(!rfc.verify({ secret, token: codeAt(1), time: now, window: 0 }), 'and window 0 accepts nothing else');
});

test('the accepted window is capped, because it is the guessing surface', () => {
  // window is caller-supplied and every step added multiplies how many codes
  // are live at once. A typo of 50 must not quietly make a 6-digit code good
  // for half an hour.
  const secret = LEGACY_VECTORS[0].secret;
  const now = 1700000000;
  const farPast = rfc.totp({ secret, encoding: 'base32', time: now - (rfc.MAX_WINDOW + 1) * 30 });
  assert.ok(!rfc.verify({ secret, token: farPast, time: now, window: 500 }));
  assert.ok(rfc.verify({
    secret,
    token: rfc.totp({ secret, encoding: 'base32', time: now - rfc.MAX_WINDOW * 30 }),
    time: now,
    window: 500,
  }), 'the cap itself is still honoured');
  assert.equal(rfc.MAX_WINDOW, 3);
});

test('a malformed token is refused without touching the key, at any length', () => {
  const secret = LEGACY_VECTORS[0].secret;
  for (const token of ['', ' ', '12345', '1234567', 'abcdef', '123456a', null, undefined, ' 123456 ', '1e6']) {
    assert.equal(rfc.verify({ secret, token, time: 1700000000, window: 1 }), false, `token ${JSON.stringify(token)}`);
  }
  // The pre-check is a shape test, not a value test: a real code of the right
  // length still passes.
  assert.ok(rfc.verify({ secret, token: rfc.totp({ secret, encoding: 'base32', time: 1700000000 }), time: 1700000000, window: 1 }));
});

test('a secret that is not base32 is refused rather than decoded into a wrong key', () => {
  // A hex seed would "work" under a lenient decoder and produce codes the
  // owner's app never generates — the failure would look like a broken app.
  assert.equal(rfc.base32Decode('00ff11aa'), null);
  assert.equal(rfc.verify({ secret: '00ff11aa', token: '123456', window: 1 }), false);
  assert.throws(() => rfc.totp({ secret: '00ff11aa' }), /decodable secret/);
  assert.equal(rfc.verify({ secret: '', token: '123456' }), false, 'an empty seed is a refusal, not a 500');
});

test('digits, step and digest are validated, not guessed at', () => {
  const secret = LEGACY_VECTORS[0].secret;
  assert.throws(() => rfc.totp({ secret, digits: 4 }), /6 to 8/);
  assert.throws(() => rfc.totp({ secret, digits: 9 }), /6 to 8/);
  assert.throws(() => rfc.totp({ secret, step: 0 }), /whole number/);
  assert.throws(() => rfc.totp({ secret, algorithm: 'md5' }), /Unsupported TOTP digest/);
  // The digests RFC 6238 allows all produce a well-formed code of the right size.
  for (const algorithm of ['sha1', 'sha256', 'sha512']) {
    assert.match(rfc.totp({ secret, algorithm }), /^\d{6}$/, algorithm);
  }
});

test('the defaults are the ones every authenticator app assumes', () => {
  assert.deepEqual({ ...rfc.DEFAULTS }, { digits: 6, step: 30, algorithm: 'sha1', secretBytes: 32 });
  const secret = LEGACY_VECTORS[0].secret;
  assert.equal(rfc.totp({ secret }), rfc.totp({ secret, digits: 6, step: 30, algorithm: 'sha1' }));
});

test('generateSecret keeps the shape the setup screen and the QR depend on', () => {
  const generated = rfc.generateSecret({ name: 'SuppliWise (member@example.com)', issuer: 'SuppliWise' });
  assert.equal(generated.base32.length, 52, '32 random bytes -> the same key length the old default showed');
  assert.match(generated.base32, /^[A-Z2-7]+$/, 'unpadded base32, safe to type');
  assert.ok(generated.otpauth_url.startsWith('otpauth://totp/SuppliWise%20(member%40example.com)?secret='));
  assert.ok(generated.otpauth_url.includes(`secret=${generated.base32}`), 'the URL carries exactly the stored key');
  assert.ok(generated.otpauth_url.includes('issuer=SuppliWise'));
  const secretParam = new URL(generated.otpauth_url).searchParams.get('secret');
  assert.ok(!secretParam.includes('='), 'the key inside the URL is unpadded, the way the old generator wrote it');
  assert.equal(secretParam, generated.base32);
  assert.notEqual(rfc.generateSecret().base32, rfc.generateSecret().base32, 'a fresh key every time');

  const shorter = rfc.generateSecret({ name: 'x', length: 20 });
  assert.equal(shorter.base32.length, 32, 'length is bytes, and 20 of them are 32 characters');
  assert.throws(() => rfc.generateSecret({ length: 8 }), /20 to 127/, 'a 64-bit seed is refused');
});

test('a generated seed round-trips: the app that scans it will pass verify', () => {
  const { base32 } = rfc.generateSecret({ name: 'SuppliWise (round.trip@test.local)', issuer: 'SuppliWise' });
  const now = Math.floor(Date.now() / 1000);
  assert.ok(rfc.verify({ secret: base32, token: rfc.totp({ secret: base32, time: now }), time: now, window: 1 }));
});

test('the one-time-use cache still gates replays through the new module', () => {
  // utils/totp.js is the only verification path sign-in uses, so this is the
  // integration point: same code, second account, second attempt all still
  // behave as the replay-scope tests describe.
  const { verifyTotpOnce } = require('../utils/totp');
  const secret = rfc.generateSecret({ name: 'cache check', length: 20 }).base32;
  const code = rfc.totp({ secret });
  const scope = 'rfc-scope-' + process.pid;
  assert.equal(verifyTotpOnce(secret, code, scope), true, 'first use accepted');
  assert.equal(verifyTotpOnce(secret, code, scope), false, 'replay refused');
  assert.equal(verifyTotpOnce(secret, code, scope + '-other'), true, 'a different account is a different bucket');
});

test('nothing in the shipped code requires speakeasy any more', () => {
  // The point of this module. A stray require would keep the dependency alive
  // in the tree, invisible, until the day it is removed and a route 500s.
  const roots = ['routes', 'utils', 'middleware', 'models', 'blockchain', 'scripts', '.'];
  const offenders = [];
  for (const root of roots) {
    const dir = path.resolve(__dirname, '..', root);
    if (!fs.existsSync(dir)) continue;
    const entries = fs.statSync(dir).isFile() ? [dir] : fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js') || f.endsWith('.cjs'))
      .map((f) => path.join(dir, f));
    for (const file of entries) {
      if (path.basename(file).startsWith('_')) continue;
      const source = fs.readFileSync(file, 'utf8');
      if (/require\((?:'|"|\')?speakeasy/.test(source)) offenders.push(path.relative(dir, file) + ' in ' + root);
    }
  }
  assert.deepEqual(offenders, [], 'speakeasy must not be required by any runtime file');

  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(!('speakeasy' in (pkg.dependencies || {})), 'and not declared as a dependency');
  assert.ok(!('speakeasy' in (pkg.devDependencies || {})), 'nor as a dev dependency');
});
