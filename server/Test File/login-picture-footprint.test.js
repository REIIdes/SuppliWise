/**
 * IMAGES MUST NOT BE LOADED OR SHIPPED ON THE SIGN-IN PATH.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `profilePicture` and `bannerPicture` used to hold a raw
 * `data:image/...;base64,...` string on the user document. One real account
 * carried a 2,962,602-character banner, making its document ~3 MB — and
 * `POST /api/auth/login` did two things with that document on every attempt:
 *
 *     const user = await User.findOne({ email: trimmedEmail });   // read ~3 MB
 *     …
 *     await user.save();                                          // write ~3 MB
 *
 * Measured over the project's Atlas connection, each of those cost ~30.5 s
 * while a `ping` on the same connection took 36 ms — the cluster was healthy,
 * the payload was simply enormous. Sign-in therefore could not finish inside
 * any client timeout, the client abandoned the request, and the socket error
 * was reported as "We could not reach our servers just now." The blob also
 * rode back in every auth response and was parked in sessionStorage.
 *
 * Images now live on disk (utils/pictures.js) and the document holds a URL, but
 * a projection that quietly disappears is exactly the kind of optimisation that
 * gets reverted as "unnecessary" six months later. These tests assert the
 * invariant directly, so the day someone drops the `.select()` the suite says
 * why it matters instead of the login button breaking in production.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  storePicture,
  safePictureValue,
  parseDataUrl,
  isDataUrl,
  isStoredPath,
  PICTURE_DIR,
  PUBLIC_PATH,
  MAX_AVATAR_BYTES,
} = require('../utils/pictures');
const User = require('../models/User');
const emailUtils = require('../utils/email');
const sessionUtils = require('../utils/sessions');
const { stubQuery } = require('./stubQuery');
// /login now mints an MFA transaction and, for accounts with a second factor,
// counts passkeys and unused recovery codes. Each is a real round-trip, so a
// suite that stubs only User leaves them buffering against a connection that
// does not exist and the route answers 500 after a 10s timeout.
const { stubMfaModels } = require('./stubMfaModels');

// A real 1x1 PNG — a valid image, not just plausible base64.
const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── 1. The sign-in read must not pull the picture fields ────────────────────

test('POST /api/auth/login projects the inline pictures out of its read', async () => {
  const originalFindOne = User.findOne;
  // The second step of sign-in touches three more models; see stubMfaModels.js.
  const restoreMfaModels = stubMfaModels();
  /** @type {string|null} the projection the route actually asked for */
  let seenSelect = null;

  User.findOne = (...args) => {
    const query = stubQuery(() => ({
      _id: '507f1f77bcf86cd799439011',
      email: 'demo@example.com',
      firstName: 'Demo',
      lastName: 'User',
      fullName: 'Demo User',
      accountStatus: 'active',
      twoFactorEnabled: false,
      // A megabyte-scale inline banner, exactly as the real document held it.
      bannerPicture: `data:image/png;base64,${'A'.repeat(1024 * 1024)}`,
      profilePicture: PNG_1PX,
      save: async () => {},
      matchPassword: async (v) => v === 'Secret123',
    }));
    // Record the projection without changing what the stub resolves to.
    const realSelect = query.select;
    query.select = (fields) => {
      seenSelect = fields;
      return realSelect(fields);
    };
    return query;
  };
  emailUtils.sendOtpEmail = async () => true;
  sessionUtils.issueUserSession = async () => 'stub.token';
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  delete require.cache[require.resolve('../routes/auth')];
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', password: 'Secret123' }),
    });
    const body = await res.json();

    assert.equal(res.status, 200, `login should succeed: ${JSON.stringify(body)}`);

    // THE ASSERTION. Without this projection the route reads the whole
    // document, and with an inline banner that is a multi-megabyte transfer on
    // the critical path of every single sign-in.
    assert.ok(seenSelect, 'login must project the fields it needs');
    assert.match(
      seenSelect,
      /-profilePicture/,
      'login must exclude profilePicture from its read'
    );
    assert.match(
      seenSelect,
      /-bannerPicture/,
      'login must exclude bannerPicture from its read'
    );
  } finally {
    server.close();
    User.findOne = originalFindOne;
    restoreMfaModels();
    delete require.cache[require.resolve('../routes/auth')];
    process.env.NODE_ENV = prevEnv;
  }
});

// ── 2. No response may ever ship a multi-megabyte inline blob ──────────────

test('safePictureValue drops an oversized inline blob but keeps small ones', () => {
  // The one legitimate inline case: a client previewing an unsaved image.
  assert.equal(safePictureValue(PNG_1PX), PNG_1PX);

  // A stored path is returned untouched.
  assert.equal(
    safePictureValue('/pictures/abc-profile-def.png'),
    '/pictures/abc-profile-def.png'
  );

  // A legacy not-yet-migrated blob is refused rather than shipped, which is
  // what keeps a single un-migrated document from re-inflating a response.
  const huge = `data:image/png;base64,${'A'.repeat(2 * 1024 * 1024)}`;
  assert.equal(safePictureValue(huge), '');

  // Nonsense in, empty string out — never a non-string reaching the DOM.
  for (const bad of [null, undefined, 0, 42, {}, [], true]) {
    assert.equal(safePictureValue(bad), '');
  }
  assert.equal(safePictureValue('   '), '');
});

// ── 3. 2FA must never demand a code the account cannot produce ─────────────

/**
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `twoFactorEnabled` and `twoFactorSecret` are written by different code paths,
 * so a document can carry the flag with no secret behind it (a half-finished
 * setup, or a value written by a script). `/login` branched on the flag alone
 * and answered "Google Authenticator verification required." — a challenge with
 * no secret to verify it against, so no code the account holder could ever enter
 * would pass. Observed on a real account: permanently locked out of its own
 * second factor, with no recourse.
 *
 * `/login-2fa` already refused the impossible case; it was the PROMPT that was
 * wrong, which is the worse half — it sent the user down a dead end.
 */
async function loginWithTwoFactorState(overrides) {
  const originalFindOne = User.findOne;
  // The second step of sign-in touches three more models; see stubMfaModels.js.
  const restoreMfaModels = stubMfaModels();
  const originalSend = emailUtils.sendOtpEmail;
  const originalSession = sessionUtils.issueUserSession;

  let response = null;
  User.findOne = () => stubQuery(() => ({
    _id: '507f1f77bcf86cd799439011',
    email: 'demo@example.com',
    firstName: 'Demo',
    lastName: 'User',
    fullName: 'Demo User',
    accountStatus: 'active',
    save: async () => {},
    matchPassword: async () => true,
    ...overrides,
  }));
  emailUtils.sendOtpEmail = async () => true;
  sessionUtils.issueUserSession = async () => 'stub.token';
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';

  delete require.cache[require.resolve('../routes/auth')];
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use('/api/auth', require('../routes/auth'));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'demo@example.com', password: 'Secret123' }),
    });
    response = { status: res.status, body: await res.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
    User.findOne = originalFindOne;
    emailUtils.sendOtpEmail = originalSend;
    sessionUtils.issueUserSession = originalSession;
    restoreMfaModels();
    delete require.cache[require.resolve('../routes/auth')];
    process.env.NODE_ENV = prevEnv;
  }
  return response;
}

test('an account claiming 2FA with no secret is not issued an impossible challenge', async () => {
  const res = await loginWithTwoFactorState({
    twoFactorEnabled: true,
    twoFactorMethod: 'authenticator',
    twoFactorSecret: undefined, // the impossible state
  });

  assert.equal(res.status, 200, `sign-in must still succeed: ${JSON.stringify(res.body)}`);
  assert.notEqual(
    res.body.requiresTwoFactor, true,
    'must not demand an authenticator code when there is no secret to check it against'
  );
  assert.equal(res.body.requiresOtp, true, 'must fall back to a code it can actually deliver');
});

test('a real authenticator setup still gets its authenticator challenge', async () => {
  const res = await loginWithTwoFactorState({
    twoFactorEnabled: true,
    twoFactorMethod: 'authenticator',
    twoFactorSecret: 'JBSWY3DPEHPK3PXP', // a genuine base32 secret
  });

  assert.equal(res.status, 200);
  assert.equal(
    res.body.requiresTwoFactor, true,
    'a working authenticator must NOT be downgraded — the user has one enrolled'
  );
  assert.equal(res.body.requiresOtp, undefined);
});

test('an account with 2FA off is unaffected', async () => {
  const res = await loginWithTwoFactorState({
    twoFactorEnabled: false,
    twoFactorMethod: 'authenticator',
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.requiresOtp, true);
});

// ── 4. storePicture writes to disk and hands back a URL ────────────────────

test('storePicture turns a data URL into a servable path', () => {
  const stored = storePicture({
    ownerId: '507f1f77bcf86cd799439011',
    kind: 'profile',
    value: PNG_1PX,
  });

  assert.ok(stored.startsWith(`${PUBLIC_PATH}/`), `expected a ${PUBLIC_PATH} path, got ${stored}`);

  // The bytes are genuinely on disk, and decodable back to the same image.
  const name = stored.slice(`${PUBLIC_PATH}/`.length);
  const onDisk = path.join(PICTURE_DIR, name);
  assert.ok(fs.existsSync(onDisk), 'the image must be written to disk');
  const written = fs.readFileSync(onDisk);
  assert.deepEqual(
    [...written],
    [...parseDataUrl(PNG_1PX).buffer],
    'the file must contain exactly the decoded image bytes'
  );
  // PNG magic number — proof it is an image and not the base64 text.
  assert.deepEqual([...written.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

  fs.unlinkSync(onDisk);
});

test('storePicture is idempotent and content-addressed', () => {
  const opts = { ownerId: 'owner-1', kind: 'banner', value: PNG_1PX };
  const first = storePicture(opts);
  const second = storePicture({ ...opts, value: PNG_1PX });

  // Same bytes ⇒ same URL. Re-picking the same avatar cannot grow the
  // directory, and the URL is safe to cache immutably.
  assert.equal(first, second);

  // A stored path round-trips untouched, so a client echoing our own value
  // back is not re-encoded.
  assert.equal(storePicture({ ...opts, value: first }), first);

  fs.unlinkSync(path.join(PICTURE_DIR, first.slice(`${PUBLIC_PATH}/`.length)));
});

test('a stored path or absolute URL is passed through, and "" clears', () => {
  const base = { ownerId: 'owner-2', kind: 'profile' };
  assert.equal(storePicture({ ...base, value: '' }), '');
  assert.equal(storePicture({ ...base, value: null }), '');
  assert.equal(
    storePicture({ ...base, value: 'https://cdn.example.com/a.png' }),
    'https://cdn.example.com/a.png'
  );
});

test('storePicture refuses payloads that are not acceptable images', () => {
  const base = { ownerId: 'owner-3', kind: 'profile' };

  // A scriptable scheme must never reach the filesystem or the document.
  assert.throws(() => storePicture({ ...base, value: 'javascript:alert(1)' }), /data URL/);
  // A non-image data URL.
  assert.throws(
    () => storePicture({ ...base, value: 'data:text/html;base64,PHNjcmlwdD4=' }),
    /base64 PNG, JPEG, WebP or GIF/
  );
  // A non-string.
  assert.throws(() => storePicture({ ...base, value: { evil: true } }), /must be a string/);
  // Decoded size over the cap → 413, not a silent truncation.
  //
  // Sized by DECODED bytes, deliberately: base64 expands by 4/3, so a payload
  // of "4/3 × cap" base64 characters is what actually crosses the limit. (A
  // 2 MB run of base64 text decodes to only ~1.5 MB and is correctly accepted
  // — the cap is on the image, not on its encoding.)
  const tooBigBytes = Buffer.alloc(MAX_AVATAR_BYTES + 64 * 1024, 0x41);
  const oversized = `data:image/png;base64,${tooBigBytes.toString('base64')}`;
  assert.throws(
    () => storePicture({ ...base, value: oversized }),
    (err) => err.statusCode === 413,
    'an oversized image must be refused with 413'
  );
});

test('picture shape helpers agree on what is inline vs stored', () => {
  assert.equal(isDataUrl(PNG_1PX), true);
  assert.equal(isDataUrl('/pictures/a.png'), false);
  assert.equal(isStoredPath('/pictures/a.png'), true);
  assert.equal(isStoredPath(PNG_1PX), false);
  // A protocol-relative value is not one of our paths.
  assert.equal(isStoredPath('//evil.example.com/a.png'), false);
});
