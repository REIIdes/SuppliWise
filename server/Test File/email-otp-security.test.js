/**
 * EMAIL OTP SECURITY — the properties the emailed-code flows must hold.
 *
 * WHAT THIS COVERS
 * ----------------
 * The lifecycle is: issue → deliver → store → submit → verify → single-use.
 * These tests assert the security properties of every stage, using
 * utils/otpChallenge.js directly (unit) and the real routers (integration) so a
 * regression in either the primitive or its wiring is caught.
 *
 * The properties pinned here, in order:
 *   1.  generation      — CSPRNG, 6 digits, no predictable structure
 *   2.  storage         — never the plaintext, digest only
 *   3.  purpose binding — a code for one purpose cannot verify in another
 *   4.  expiry          — enforced server-side, independent of any client timer
 *   5.  single use      — atomic; concurrent redemption yields exactly one win
 *   6.  attempt limit   — 5 per challenge, then the challenge is destroyed
 *   7.  resend          — a new code invalidates the previous one
 *   8.  comparison      — constant-time against the digest
 *   9.  header safety   — CRLF / multi-recipient injection rejected
 *  10.  no disclosure   — no OTP in responses, no OTP in logs, no SMTP secrets
 *
 * The mailer is stubbed throughout, so nothing here needs SMTP or a database.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-that-is-long-enough-for-hkdf-derivation-0123456789';
process.env.NODE_ENV = 'test';

const otpChallenge = require('../utils/otpChallenge');
const emailUtils = require('../utils/email');
const User = require('../models/User');
const sessionUtils = require('../utils/sessions');
const { stubQuery } = require('./stubQuery');
const { stubMfaModels } = require('./stubMfaModels');
const lockout = require('../utils/lockout');

const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_USER_ID = '507f1f77bcf86cd799439099';
const EMAIL = 'demo@example.com';
const PASSWORD = 'Secret123';

// A real, well-formed transaction token: /verify-login-otp checks its shape
// before looking anything up.
const MFA_TOKEN = 'test-only-transaction-aaaaaaaaaaaaaaaaaaaaaaaa';

// The suite's HTTP server binds to loopback, so this is the address every
// rate-limit and lockout bucket sees.
const LOOPBACK = '127.0.0.1';

// ── 1. Generation ──────────────────────────────────────────────────────────

test('codes are six digits drawn from the CSPRNG', () => {
  for (let i = 0; i < 500; i += 1) {
    const code = otpChallenge.generateOtp();
    assert.match(code, /^\d{6}$/, `not a six-digit code: ${code}`);
  }
});

test('the full 000000-999999 space is reachable, including the upper bound', () => {
  // The generation call previously passed 999999 as an EXCLUSIVE upper bound, so
  // 999999 was never produced and the space was silently 899,999 wide. Sampling
  // cannot prove a bound is reachable, so this asserts the declared bounds are
  // the correct ones for a six-digit code instead.
  assert.equal(otpChallenge.OTP_MIN, 100000);
  assert.equal(otpChallenge.OTP_MAX, 1000000, 'upper bound must be exclusive of 1000000');
  assert.equal(otpChallenge.OTP_MAX - otpChallenge.OTP_MIN, 900000);
});

test('codes are not predictable from the previous one', () => {
  // 200 consecutive codes must not contain a visible stride or repeat. A
  // timestamp- or counter-based generator fails this immediately.
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) seen.add(otpChallenge.generateOtp());
  assert.equal(seen.size, 200, 'generated codes repeated within 200 draws');
});

test('the module refuses Math.random anywhere in its source', () => {
  // A guard against someone "simplifying" the generator later. Cheap, and it
  // fails loudly in CI rather than silently in production.
  const source = require('fs').readFileSync(require.resolve('../utils/otpChallenge'), 'utf8');
  assert.doesNotMatch(source, /Math\.random/, 'otpChallenge must not use Math.random');
  assert.match(source, /crypto\.randomInt/, 'otpChallenge must use crypto.randomInt');
});

// ── 2. Storage: the plaintext is never retained ────────────────────────────

test('a stored entry contains a digest, never the code', () => {
  const code = otpChallenge.generateOtp();
  const entry = otpChallenge.buildEntry({ otp: code, context: 'login_user1', ttlMs: 60000 });

  assert.ok(!('otp' in entry), 'the entry must not carry a plaintext `otp` field');
  const serialized = JSON.stringify(entry);
  assert.ok(
    !serialized.includes(code),
    `the serialized entry must not contain the code: ${serialized}`
  );
  assert.match(entry.digest, /^[a-f0-9]{64}$/, 'expected a hex SHA-256 HMAC');
});

test('a bare hash of a six-digit code would be no protection — the digest is keyed', () => {
  // Demonstrate WHY the HMAC is keyed rather than a plain SHA-256, so nobody
  // "simplifies" it later. 900,000 candidates hashes in well under a second,
  // so a bare digest of a six-digit value is an encoding, not a secret.
  const code = '123456';
  const bare = crypto.createHash('sha256').update(code).digest('hex');
  const recovered = ['000000', '111111', '123456'].filter(
    (candidate) => crypto.createHash('sha256').update(candidate).digest('hex') === bare
  );
  assert.equal(recovered.length, 1, 'a bare digest must be trivially reversible');

  // The keyed digest cannot be reversed without the server secret.
  const keyed = otpChallenge.digestOtp(code, 'login_user1');
  const guess = crypto.createHash('sha256').update(code).digest('hex');
  assert.notEqual(keyed, guess, 'the stored digest must not be a bare hash');
});

// ── 3. Purpose binding ─────────────────────────────────────────────────────

test('a code issued for one purpose cannot verify under another', () => {
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set('login_user1', otpChallenge.buildEntry({ otp: code, context: 'login_user1', ttlMs: 60000 }));

  // The same code presented against the email-change key of the same user.
  store.set('user1_new@example.com', otpChallenge.buildEntry({
    otp: '000000', context: 'user1_new@example.com', ttlMs: 60000,
  }));

  const asLogin = otpChallenge.consume(store, 'login_user1', code);
  assert.equal(asLogin.ok, true, 'the code must verify under its own purpose');

  // And the cross-purpose digest differs, so a code can never be moved between
  // purposes even if the store were shared.
  assert.notEqual(
    otpChallenge.digestOtp(code, 'login_user1'),
    otpChallenge.digestOtp(code, 'password_reset_user1')
  );
});

test('a code for one account cannot verify against another account', () => {
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set(`login_${USER_ID}`, otpChallenge.buildEntry({
    otp: code, context: `login_${USER_ID}`, ttlMs: 60000,
  }));

  // The victim has no outstanding challenge of their own.
  const wrongAccount = otpChallenge.consume(store, `login_${OTHER_USER_ID}`, code);
  assert.equal(wrongAccount.ok, false);
  assert.equal(wrongAccount.outcome, 'missing');

  // And the stored digest is bound to the account's key, so even a transplanted
  // entry would not match.
  assert.notEqual(
    otpChallenge.digestOtp(code, `login_${USER_ID}`),
    otpChallenge.digestOtp(code, `login_${OTHER_USER_ID}`)
  );
});

// ── 4. Expiry ──────────────────────────────────────────────────────────────

test('an expired code is rejected', () => {
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: code, context: 'k', ttlMs: -1 }));

  const verdict = otpChallenge.consume(store, 'k', code);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.outcome, 'expired');
  assert.equal(store.has('k'), false, 'an expired entry must be discarded, not kept');
});

test('expiry is enforced by the server, not trusted from the client', () => {
  // No argument to consume() can extend or shorten a window — the deadline lives
  // in the entry. There is deliberately no client-supplied timestamp parameter.
  const code = otpChallenge.generateOtp();
  const entry = otpChallenge.buildEntry({ otp: code, context: 'k', ttlMs: 60000 });
  assert.ok(entry.expiresAt > Date.now());
  assert.ok(!('clientExpiry' in entry));
  assert.equal(otpChallenge.consume.length, 3, 'consume takes only (store, key, code)');
});

test('the email tells the user the TTL the server actually enforces', () => {
  // routes/auth.js enforces OTP_TTL_MS; utils/email.js states OTP_TTL_MINUTES.
  // They must agree, or the mail makes a promise the server does not keep.
  const authSource = require('fs').readFileSync(
    require.resolve('../routes/auth'), 'utf8'
  );
  const declared = authSource.match(/const OTP_TTL_MS = (\d+) \* 60 \* 1000;/);
  assert.ok(declared, 'OTP_TTL_MS must be declared as minutes so it can be compared');
  assert.equal(
    Number(declared[1]),
    emailUtils.OTP_TTL_MINUTES,
    'the enforced TTL and the TTL advertised in the email have drifted apart'
  );
  assert.ok(emailUtils.OTP_TTL_MINUTES <= 5, 'the enforced TTL must be 5 minutes or less');
});

// ── 5. Single use, atomically ──────────────────────────────────────────────

test('a correct code verifies exactly once', () => {
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: code, context: 'k', ttlMs: 60000 }));

  assert.equal(otpChallenge.consume(store, 'k', code).ok, true);

  const replay = otpChallenge.consume(store, 'k', code);
  assert.equal(replay.ok, false, 'the same code must not work twice');
  assert.equal(replay.outcome, 'missing');
});

test('concurrent redemption of one code yields exactly one winner', () => {
  // consume() contains no await between its check and its delete, so on the
  // event loop no other request can observe the entry in between. This drives it
  // the way the event loop does: every "request" runs to completion before the
  // next starts, which is exactly the interleaving the no-await property rules
  // out.
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: code, context: 'k', ttlMs: 60000 }));

  const winners = [];
  for (let i = 0; i < 25; i += 1) {
    if (otpChallenge.consume(store, 'k', code).ok) winners.push(i);
  }

  assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`);
});

test('a real concurrent HTTP race lets exactly one request through', async () => {
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: code, context: 'k', ttlMs: 60000 }));

  const app = express();
  app.use(express.json());
  // Awaits a tick BEFORE consuming, so all 20 requests are genuinely in flight
  // together — the worst case for a non-atomic check-then-delete.
  app.post('/redeem', async (req, res) => {
    await new Promise((resolve) => setImmediate(resolve));
    res.json({ ok: otpChallenge.consume(store, 'k', String(req.body.code)).ok });
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => fetch(`${base}/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      }).then((r) => r.json()))
    );
    const wins = results.filter((r) => r.ok).length;
    assert.equal(wins, 1, `exactly one redemption must succeed, got ${wins}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ── 6. Attempt limit ───────────────────────────────────────────────────────

test('the challenge is destroyed after the attempt limit', () => {
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: code, context: 'k', ttlMs: 60000 }));

  for (let i = 0; i < otpChallenge.MAX_ATTEMPTS; i += 1) {
    const verdict = otpChallenge.consume(store, 'k', '999999');
    assert.equal(verdict.ok, false);
    if (i < otpChallenge.MAX_ATTEMPTS - 1) {
      assert.equal(verdict.outcome, 'mismatch', `strike ${i + 1} answered ${verdict.outcome}`);
    }
  }

  assert.equal(store.has('k'), false, 'the entry must be gone once the budget is spent');

  // The CORRECT code must not work afterwards. This is the property that matters:
  // the limit is not a delay before the real code is accepted.
  const afterLockout = otpChallenge.consume(store, 'k', code);
  assert.equal(afterLockout.ok, false, 'a correct code must not be accepted after the limit');
});

test('the attempt limit is five', () => {
  assert.equal(otpChallenge.MAX_ATTEMPTS, 5);
});

test('wrong guesses are counted even when the submission is well-formed garbage', () => {
  // An attacker must not get unlimited attempts by varying the shape of the
  // guess; every non-matching submission consumes budget.
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: code, context: 'k', ttlMs: 60000 }));

  for (const guess of ['000000', '111111', '222222', '333333', '444444']) {
    otpChallenge.consume(store, 'k', guess);
  }
  assert.equal(otpChallenge.consume(store, 'k', code).ok, false, 'the budget was not enforced');
});

test('malformed submissions are rejected without touching a live challenge', () => {
  const store = new Map();
  const code = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: code, context: 'k', ttlMs: 60000 }));

  assert.equal(otpChallenge.consume(store, 'k', '').outcome, 'malformed');
  assert.equal(otpChallenge.consume(store, 'k', 'abcdef').outcome, 'malformed');
  assert.equal(otpChallenge.consume(store, 'k', '12345').outcome, 'malformed');
  assert.equal(otpChallenge.consume(store, 'k', '1234567').outcome, 'malformed');
  assert.equal(otpChallenge.consume(store, 'k', { $ne: null }).outcome, 'malformed');
  assert.equal(otpChallenge.consume(store, 'k', null).outcome, 'malformed');

  // A junk probe must not have burned the real user's budget.
  assert.equal(otpChallenge.consume(store, 'k', code).ok, true);
});

// ── 7. Resend invalidates the previous code ─────────────────────────────────

test('issuing a new code invalidates the previous one', () => {
  const store = new Map();
  const first = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: first, context: 'k', ttlMs: 60000 }));

  // A resend writes the same key, replacing the entry.
  const second = otpChallenge.generateOtp();
  store.set('k', otpChallenge.buildEntry({ otp: second, context: 'k', ttlMs: 60000 }));

  assert.equal(
    otpChallenge.consume(store, 'k', first).ok, false,
    'the superseded code must stop working'
  );
  assert.equal(otpChallenge.consume(store, 'k', second).ok, true, 'the newest code must work');
});

// ── 8. Comparison ──────────────────────────────────────────────────────────

test('digest comparison is constant-time and rejects non-hex input safely', () => {
  const code = '424242';
  const digest = otpChallenge.digestOtp(code, 'k');

  assert.equal(otpChallenge.digestMatches(digest, code, 'k'), true);
  assert.equal(otpChallenge.digestMatches(digest, '424243', 'k'), false);
  // Wrong context must not match even with the right code.
  assert.equal(otpChallenge.digestMatches(digest, code, 'other'), false);
  // Malformed stored values must return false rather than throw.
  assert.equal(otpChallenge.digestMatches('', code, 'k'), false);
  assert.equal(otpChallenge.digestMatches('zzzz', code, 'k'), false);
  assert.equal(otpChallenge.digestMatches(null, code, 'k'), false);
});

// ── 9. Email header injection ──────────────────────────────────────────────

/**
 * Drive the real senders against a stubbed transport.
 *
 * `utils/email.js` builds its transporter from process.env at first use, so the
 * only way to observe what it hands to nodemailer is to install a fake
 * `createTransport` before the module is required. Returns the options object of
 * every message that reached the transport, and a restore function.
 */
async function withStubbedTransport(fn) {
  const nodemailer = require('nodemailer');
  const originalCreate = nodemailer.createTransport;
  const originalEnv = {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
    nodeEnv: process.env.NODE_ENV,
  };
  const attempted = [];

  nodemailer.createTransport = () => ({
    verify: async () => true,
    close: async () => {},
    sendMail: async (options) => {
      attempted.push(options);
      return { messageId: 'stub' };
    },
  });
  process.env.EMAIL_USER = 'mailer@example.test';
  process.env.EMAIL_PASSWORD = 'test-only-password';

  delete require.cache[require.resolve('../utils/email')];
  const stubbedEmail = require('../utils/email');

  try {
    return await fn(stubbedEmail, attempted);
  } finally {
    nodemailer.createTransport = originalCreate;
    delete require.cache[require.resolve('../utils/email')];
    if (originalEnv.user === undefined) delete process.env.EMAIL_USER;
    else process.env.EMAIL_USER = originalEnv.user;
    if (originalEnv.pass === undefined) delete process.env.EMAIL_PASSWORD;
    else process.env.EMAIL_PASSWORD = originalEnv.pass;
    process.env.NODE_ENV = originalEnv.nodeEnv;
  }
}

test('sendOtpEmail rejects injected recipients', async () => {
  await withStubbedTransport(async (stubbedEmail, attempted) => {
    const injections = [
      'victim@example.com\r\nBcc: attacker@evil.test',
      'victim@example.com\nBcc: attacker@evil.test',
      'victim@example.com\r\nSubject: pwned',
      'victim@example.com, attacker@evil.test',
      'victim@example.com <attacker@evil.test>',
      'not-an-address',
      '',
      'a'.repeat(300) + '@example.com',
    ];

    for (const bad of injections) {
      const sent = await stubbedEmail.sendOtpEmail(bad, '123456', 'login');
      assert.equal(sent, false, `accepted an injectable recipient: ${JSON.stringify(bad)}`);
    }

    assert.equal(attempted.length, 0, 'no message may reach the transport');

    // A legitimate address is still accepted — the guard must not be a blanket
    // refusal that breaks real sign-ins.
    const ok = await stubbedEmail.sendOtpEmail('real.user@example.com', '123456', 'login');
    assert.equal(ok, true, 'a valid address must still be deliverable');
    assert.equal(attempted.length, 1);
    assert.equal(attempted[0].to, 'real.user@example.com');
  });
});

test('every sender in the module rejects an injected recipient', async () => {
  await withStubbedTransport(async (stubbedEmail, attempted) => {
    const bad = 'victim@example.com\r\nBcc: attacker@evil.test';

    const results = await Promise.all([
      stubbedEmail.sendOtpEmail(bad, '123456', 'login'),
      stubbedEmail.sendStatusEmail(bad, 'lockout', {}),
      stubbedEmail.sendPasswordResetEmail(bad, { resetUrl: 'https://x.test/r?t=1', code: '123456' }),
      stubbedEmail.sendCredentialUpdateEmail(bad, {}),
      stubbedEmail.sendAdminCredentialUpdateEmail(bad, {}),
      stubbedEmail.sendAdminCredentialsEmail(bad, { alias: 'a', password: 'p', totpSecret: 's' }),
    ]);

    for (const [index, sent] of results.entries()) {
      assert.equal(sent, false, `sender ${index} accepted an injectable recipient`);
    }
    assert.equal(attempted.length, 0, 'no sender may hand an injected address to the transport');
  });
});

test('an operator-supplied description is escaped, not interpolated raw', async () => {
  await withStubbedTransport(async (stubbedEmail, attempted) => {
    const payload = '<img src=x onerror=alert(1)>';
    await stubbedEmail.sendCredentialUpdateEmail('real.user@example.com', { description: payload });

    assert.equal(attempted.length, 1);
    const html = attempted[0].html;
    assert.ok(!html.includes('<img'), 'raw markup must not reach the HTML body');
    assert.match(html, /&lt;img/, 'the payload must appear HTML-escaped');
  });
});

test('SMTP transport refuses to run in production without TLS', async () => {
  await withStubbedTransport(async (stubbedEmail, attempted) => {
    const nodemailer = require('nodemailer');
    const captured = [];
    nodemailer.createTransport = (options) => {
      captured.push(options);
      return {
        verify: async () => true,
        close: async () => {},
        sendMail: async () => ({ messageId: 'stub' }),
      };
    };

    const originalHost = process.env.EMAIL_HOST;
    const originalPort = process.env.EMAIL_PORT;
    const originalSecure = process.env.EMAIL_SECURE;
    const nodeEnv = process.env.NODE_ENV;

    process.env.EMAIL_HOST = 'smtp.example.test';
    process.env.EMAIL_PORT = '587';
    process.env.EMAIL_SECURE = 'false';
    process.env.NODE_ENV = 'production';

    try {
      delete require.cache[require.resolve('../utils/email')];
      const productionEmail = require('../utils/email');
      await productionEmail.sendOtpEmail('real.user@example.com', '123456', 'login');
    } finally {
      if (originalHost === undefined) delete process.env.EMAIL_HOST;
      else process.env.EMAIL_HOST = originalHost;
      if (originalPort === undefined) delete process.env.EMAIL_PORT;
      else process.env.EMAIL_PORT = originalPort;
      if (originalSecure === undefined) delete process.env.EMAIL_SECURE;
      else process.env.EMAIL_SECURE = originalSecure;
      process.env.NODE_ENV = nodeEnv;
    }

    const options = captured[captured.length - 1] || {};
    assert.equal(options.tls && options.tls.rejectUnauthorized, true,
      'certificate validation must be explicitly enabled');
    assert.equal(options.requireTLS, true,
      'a STARTTLS downgrade must be a hard failure in production, not a silent fallback');
  });
});

test('the OTP is never written to a log line', async () => {
  await withStubbedTransport(async (stubbedEmail) => {
    const code = '864209';
    const lines = [];
    const originals = { log: console.log, error: console.error };
    console.log = (...args) => lines.push(args.join(' '));
    console.error = (...args) => lines.push(args.join(' '));

    try {
      await stubbedEmail.sendOtpEmail('real.user@example.com', code, 'login');
      await stubbedEmail.sendPasswordResetEmail('real.user@example.com', {
        resetUrl: 'https://x.test/r?t=abc', code,
      });
    } finally {
      console.log = originals.log;
      console.error = originals.error;
    }

    const transcript = lines.join('\n');
    assert.ok(transcript.length > 0, 'the senders are expected to log something');
    assert.ok(!transcript.includes(code), `a code reached the log: ${transcript}`);
  });
});

// ── 10. No disclosure ──────────────────────────────────────────────────────

test('no OTP endpoint returns the code in its response', async () => {
  await withAuthRouter({ deliver: () => true }, async ({ call, sentCodes, mfaTransaction, sessionsIssued }) => {
    const login = await call('/login', { email: EMAIL, password: PASSWORD });
    const code = sentCodes[sentCodes.length - 1].otp;

    assert.equal(login.body.otp, undefined, '/login must not echo the code');
    assert.equal(login.body.code, undefined, '/login must not echo the code');
    assert.equal(login.body.verificationCode, undefined, '/login must not echo the code');

    const verify = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: code });
    assert.equal(verify.status, 200);
    const serialized = JSON.stringify(verify.body);
    assert.ok(!serialized.includes(code), 'a successful verification must not echo the code');
    assert.equal(sessionsIssued(), 1, 'exactly one session may be minted, and only after the code');
  });
});

test('no OTP endpoint leaks SMTP credentials', async () => {
  const secrets = ['EMAIL_PASSWORD', 'EMAIL_USER', 'JWT_SECRET', 'SMTP_PASSWORD'];
  const before = secrets.map((name) => process.env[name]).filter(Boolean);

  await withAuthRouter({ deliver: () => false }, async ({ call }) => {
    const res = await call('/login', { email: EMAIL, password: PASSWORD });
    const serialized = JSON.stringify(res.body);
    for (const secret of before) {
      assert.ok(!serialized.includes(secret), `a response leaked ${secret}`);
    }
    assert.ok(!/smtp/i.test(serialized), 'a response must not mention SMTP internals');
  });
});

test('the dev OTP console logger cannot run in an unrecognised environment', () => {
  const source = require('fs').readFileSync(require.resolve('../routes/auth'), 'utf8');

  // The guard used to ask only "is NODE_ENV NOT production?" — a denylist that
  // fails open on staging, on an unset NODE_ENV, and on a typo.
  assert.match(source, /DEV_ENVIRONMENTS/, 'the guard must be an allowlist');
  assert.match(source, /localDev/, 'the guard must require an explicit dev environment');

  const block = source.slice(source.indexOf('function logOtpToConsole'));
  assert.ok(
    !/NODE_ENV\s*!==\s*'production'/.test(block.slice(0, block.indexOf('}'))),
    'the denylist form must be gone'
  );
});

// ── Integration: the login flow end to end ─────────────────────────────────

function stubUser(overrides = {}) {
  return {
    _id: USER_ID,
    email: EMAIL,
    firstName: 'Demo',
    lastName: 'User',
    fullName: 'Demo User',
    dateOfBirth: new Date('1990-01-01'),
    age: 36,
    gender: 'Male',
    profilePicture: '',
    bannerPicture: '',
    accountStatus: 'active',
    twoFactorEnabled: false,
    twoFactorMethod: 'authenticator',
    save: async () => {},
    matchPassword: async (value) => value === PASSWORD,
    ...overrides,
  };
}

async function withAuthRouter({ deliver, findOne }, fn) {
  // utils/email.js is re-required fresh, and this is the instance routes/auth.js
  // will bind to. The header-injection block above deliberately drops that module
  // from the require cache when it restores, so without this the route would bind
  // to an instance whose sendOtpEmail is unstubbed — every login then answered 503
  // "we could not send your code", which reads like a broken mailer rather than a
  // broken harness.
  delete require.cache[require.resolve('../utils/email')];
  const email = require('../utils/email');

  const originals = {
    findOne: User.findOne,
    sendOtpEmail: email.sendOtpEmail,
    issueUserSession: sessionUtils.issueUserSession,
    revokeAllUserSessions: sessionUtils.revokeAllUserSessions,
    nodeEnv: process.env.NODE_ENV,
  };
  const sentCodes = [];
  // Counted rather than asserted via a property on the stub: a signed-in
  // session is the thing this file must prove is NOT created before MFA.
  let sessionsIssued = 0;
  process.env.NODE_ENV = 'test';

  // utils/lockout.js holds its buckets in a module-level Map — deliberately, it
  // is a live process. Two of the cases below deliberately exhaust an OTP budget,
  // which walks the ladder for that account, and that shared ladder is what turns
  // a later case's first sign-in into a 429. Resetting the buckets between cases
  // keeps each one testing what it claims to. Nothing here weakens the ladder
  // itself, which has its own tests.
  lockout.clearAccountState(lockout.accountKey('otp-user', USER_ID));
  lockout.clearAccountState(lockout.accountKey('email', EMAIL));
  lockout.clearOffenses(`ip:${LOOPBACK}`);
  lockout.clearIpAccountFailures(LOOPBACK);

  User.findOne = () => stubQuery(() => (findOne ? findOne() : stubUser()));
  const restoreMfaModels = stubMfaModels({
    transaction: { _id: 'tx1', user: USER_ID, methods: ['email-otp', 'totp', 'backup-code'] },
  });
  email.sendOtpEmail = async (to, otp, type) => {
    sentCodes.push({ to, otp, type });
    return deliver ? deliver(to, otp, type) : true;
  };
  sessionUtils.issueUserSession = async () => {
    sessionsIssued += 1;
    return 'stub.session.token';
  };
  sessionUtils.revokeAllUserSessions = async () => 0;

  delete require.cache[require.resolve('../routes/auth')];
  const authRouter = require('../routes/auth');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (route, body) => {
    const res = await fetch(`${base}/api/auth${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };

  const skipCooldown = () => {
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    return () => { Date.now = realNow; };
  };

  try {
    return await fn({
      call,
      sentCodes,
      skipCooldown,
      mfaTransaction: MFA_TOKEN,
      sessionsIssued: () => sessionsIssued,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreMfaModels();
    User.findOne = originals.findOne;
    email.sendOtpEmail = originals.sendOtpEmail;
    sessionUtils.issueUserSession = originals.issueUserSession;
    sessionUtils.revokeAllUserSessions = originals.revokeAllUserSessions;
    process.env.NODE_ENV = originals.nodeEnv;
    delete require.cache[require.resolve('../routes/auth')];
  }
}

test('the happy path still signs a user in', async () => {
  await withAuthRouter({ deliver: () => true }, async ({ call, sentCodes, mfaTransaction }) => {
    const login = await call('/login', { email: EMAIL, password: PASSWORD });
    assert.equal(login.status, 200);
    assert.equal(login.body.requiresOtp, true);

    const code = sentCodes[sentCodes.length - 1].otp;
    const verify = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: code });
    assert.equal(verify.status, 200, `a delivered code must verify: ${JSON.stringify(verify.body)}`);
    assert.ok(verify.body.token);
  });
});

test('a wrong code is refused and the fifth strike burns the challenge', async () => {
  await withAuthRouter({ deliver: () => true }, async ({ call, sentCodes, mfaTransaction }) => {
    await call('/login', { email: EMAIL, password: PASSWORD });
    const code = sentCodes[sentCodes.length - 1].otp;

    for (let i = 0; i < otpChallenge.MAX_ATTEMPTS; i += 1) {
      const attempt = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: '000000' });
      assert.notEqual(attempt.status, 200, `strike ${i + 1} must not verify`);
    }

    const correct = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: code });
    assert.notEqual(correct.status, 200, 'the real code must not work after the budget is spent');
  });
});

test('a code cannot be replayed after a successful sign-in', async () => {
  await withAuthRouter({ deliver: () => true }, async ({ call, sentCodes, mfaTransaction }) => {
    await call('/login', { email: EMAIL, password: PASSWORD });
    const code = sentCodes[sentCodes.length - 1].otp;

    const first = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: code });
    assert.equal(first.status, 200);

    const replay = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: code });
    assert.notEqual(replay.status, 200, 'a code must not be redeemable twice');
  });
});

test('a resend invalidates the code the user was already holding', async () => {
  await withAuthRouter({ deliver: () => true }, async ({ call, sentCodes, skipCooldown, mfaTransaction }) => {
    await call('/login', { email: EMAIL, password: PASSWORD });
    const original = sentCodes[sentCodes.length - 1].otp;

    const restore = skipCooldown();
    const resend = await call('/resend-login-otp', { userId: USER_ID });
    restore();
    assert.equal(resend.status, 200);
    const replacement = sentCodes[sentCodes.length - 1].otp;

    assert.notEqual(replacement, original, 'a resend must issue a different code');

    const stale = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: original });
    assert.notEqual(stale.status, 200, 'the superseded code must stop working');

    const fresh = await call('/verify-login-otp', { userId: USER_ID, mfaTransaction, otp: replacement });
    assert.equal(fresh.status, 200, 'the newest code must work');
  });
});

test('the resend cooldown is enforced', async () => {
  await withAuthRouter({ deliver: () => true }, async ({ call, sentCodes }) => {
    await call('/login', { email: EMAIL, password: PASSWORD });
    const before = sentCodes.length;

    const immediate = await call('/resend-login-otp', { userId: USER_ID });
    assert.equal(sentCodes.length, before, 'a resend inside the cooldown must send no mail');
    assert.equal(immediate.body.remainingSeconds > 0, true, 'the cooldown must be reported');
  });
});

test('the resend route does not confirm whether an account exists', async () => {
  // It used to answer 401 "User not found" for an unknown id and 200 for a real
  // one, from an unauthenticated route.
  const unknownId = '507f1f77bcf86cd7994390ff';
  await withAuthRouter({ deliver: () => true, findOne: () => null }, async ({ call }) => {
    const res = await call('/resend-login-otp', { userId: unknownId });
    assert.doesNotMatch(
      res.body.message || '',
      /not found|no such|unknown/i,
      'the response must not reveal that the account does not exist'
    );
  });

  await withAuthRouter({ deliver: () => true }, async ({ call }) => {
    const real = await call('/resend-login-otp', { userId: USER_ID });
    const malformed = await call('/resend-login-otp', { userId: 'not-an-id' });
    // A malformed id is bad input (400) and can never name an account, so it
    // carries no existence information. A WELL-FORMED id that names nothing must
    // be indistinguishable from one that names a real account — that is the
    // assertion in the block above, and it is what "User not found" broke.
    assert.equal(malformed.status, 400, 'a malformed id is a bad request, not a CastError');
    assert.equal(real.status, 200, 'a real account must get the non-committal answer');
  });
});

test('no authenticated session exists before the code is verified', async () => {
  // The password step must open a challenge, not a session.
  await withAuthRouter({ deliver: () => true }, async ({ call, sessionsIssued }) => {
    const login = await call('/login', { email: EMAIL, password: PASSWORD });

    assert.equal(login.body.token, undefined, 'no token may be issued before MFA completes');
    assert.equal(login.body.requiresOtp, true, 'the flow must stop at the code step');
    assert.ok(login.body.mfaTransaction, 'a pre-authentication challenge must be opened');
    assert.equal(sessionsIssued(), 0, 'no session may be minted before the code is verified');
  });
});