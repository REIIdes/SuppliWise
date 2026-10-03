'use strict';
/**
 * A sign-in response must describe the account it signed in — pictures included.
 *
 * ── THE BUG THIS LOCKS DOWN ─────────────────────────────────────────────────
 *
 * `publicUser()` builds the profile every sign-in response returns, and it
 * reports `safePictureValue(user.profilePicture)`. The sign-in READS, on the
 * other hand, deliberately project the picture fields OUT: an account whose
 * images had not yet been moved onto disk carried its avatar inline, so
 * reading it cost megabytes on the critical path of every sign-in — the outage
 * described at the top of `utils/pictures.js`, and the reason
 * `Test File/login-picture-footprint.test.js` exists.
 *
 * Three routes handed the projected document straight to `publicUser()`. A field
 * that was never read is `undefined`; `safePictureValue(undefined)` is `''`; so
 * the response asserted that the account had no avatar and no banner.
 *
 * Nothing errored, nothing looked broken, and nothing recovered — the client
 * stores the sign-in response as this tab's cached profile and never re-reads
 * the pictures. So a passkey sign-in (and an authenticator-code sign-in, and a
 * recovery-code sign-in) silently REPLACED a real profile picture and banner
 * with empty strings and left them that way for the life of the session.
 * Reported as "signing in with a passkey resets my profile".
 *
 * ── What these tests hold in place ──────────────────────────────────────────
 *
 *  1. The pictures come back, over real HTTP, from the reported route.
 *  2. The read that keeps the megabyte outage fixed is still a projection — the
 *     fix must not be "put the fields back on the sign-in read".
 *  3. An account that has not been migrated reports no picture rather than
 *     shipping the blob: the size is decided in the QUERY.
 *  4. Every sign-in route that projects the pictures out of its read is obliged
 *     to put them back into its RESPONSE, so the next one cannot repeat this.
 *
 * No MongoDB and no SMTP: the models are stubbed through `stubQuery.js`, whose
 * header explains why a bare object is not a faithful enough double.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

// `node --test` gives every file its own process, so server/.env is not
// inherited; webauthn.config() needs its RP settings present to build a ceremony.
require('dotenv').config();
process.env.WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';
process.env.WEBAUTHN_ORIGIN = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173';

const { stubQuery } = require('./stubQuery');
const User = require('../models/User');
const Passkey = require('../models/Passkey');
const SecurityEvent = require('../models/SecurityEvent');
const webauthn = require('../utils/webauthn');
const sessionUtils = require('../utils/sessions');
const { publicUser, publicPictures } = require('../utils/authFlow');
const {
  safePictureValue,
  boundedPictureFilter,
  INLINE_BLOB_CHARS,
  PICTURE_PROJECTION,
} = require('../utils/pictures');

const ROOT = path.join(__dirname, '..');
const USER_ID = '507f1f77bcf86cd799439011';
const AVATAR = '/pictures/507f1f77bcf86cd799439011-profile-aaa.png';
const BANNER = '/pictures/507f1f77bcf86cd799439011-banner-bbb.jpg';
const b64u = (value) => Buffer.from(value).toString('base64url');

/** A user document shaped like the sign-in read: no pictures, as projected. */
function projectedUser(overrides = {}) {
  return {
    _id: USER_ID,
    firstName: 'Demo',
    lastName: 'User',
    fullName: 'Demo User',
    email: 'demo@example.com',
    dateOfBirth: new Date('1990-01-01T00:00:00.000Z'),
    age: 34,
    gender: 'Female',
    accountStatus: 'active',
    twoFactorEnabled: false,
    subscriptionActive: false,
    subscriptionPlan: 'free',
    lastLoginLocation: '',
    ...overrides,
  };
}

/** Replace model methods for the duration of one test. */
function stubbing(entries, run) {
  const originals = new Map();
  for (const [model, method, impl] of entries) {
    originals.set([model, method], model[method]);
    model[method] = impl;
  }
  return Promise.resolve(run()).finally(() => {
    for (const [key, value] of originals) key[0][key[1]] = value;
  });
}

// ── 1. publicPictures: the value a sign-in response reports ──────────────────

test('publicPictures reports the account\'s stored pictures even though the read never had them', async () => {
  let seenFilter = null;
  let seenProjection = null;

  await stubbing([[User, 'findOne', (filter, projection) => {
    seenFilter = filter;
    seenProjection = projection;
    return stubQuery({ profilePicture: AVATAR, bannerPicture: BANNER });
  }]], async () => {
    const pictures = await publicPictures(projectedUser());

    assert.equal(pictures.profilePicture, AVATAR, 'the avatar must survive a sign-in');
    assert.equal(pictures.bannerPicture, BANNER, 'the banner must survive a sign-in');

    // The read is scoped to this account and to the picture fields alone — a
    // second full-document read on the sign-in path is exactly what this fix
    // must not become.
    assert.equal(String(seenFilter._id), USER_ID, 'the picture read must be scoped to the signed-in account');
    assert.deepEqual(
      String(seenProjection).split(/\s+/).filter(Boolean).sort(),
      ['bannerPicture', 'profilePicture'],
      `the picture read must project only the picture fields, got "${seenProjection}"`
    );
  });
});

test('publicPictures is what a sign-in response needed in the first place', () => {
  // The shape of the bug, stated as an assertion: a document read without the
  // picture fields cannot describe the account's pictures, whatever you do to it
  // afterwards. Anything that reports "no avatar" from this document is wrong.
  assert.equal(safePictureValue(projectedUser().profilePicture), '');
  assert.equal(safePictureValue(projectedUser().bannerPicture), '');
});

test('publicPictures never reports a picture value that safePictureValue would refuse', async () => {
  const hostile = [
    null,
    undefined,
    42,
    {},
    [],
    '   ',
    // A legacy inline blob: the value safePictureValue drops, because shipping
    // it is the outage the projection exists to prevent.
    `data:image/png;base64,${'A'.repeat(INLINE_BLOB_CHARS + 1)}`,
  ];

  for (const stored of hostile) {
    await stubbing([[User, 'findOne', () => stubQuery({ profilePicture: stored, bannerPicture: stored })]], async () => {
      const pictures = await publicPictures(projectedUser());
      assert.equal(pictures.profilePicture, safePictureValue(stored),
        `profilePicture must match safePictureValue for ${JSON.stringify(String(stored).slice(0, 24))}`);
      assert.equal(pictures.bannerPicture, safePictureValue(stored),
        `bannerPicture must match safePictureValue for ${JSON.stringify(String(stored).slice(0, 24))}`);
    });
  }
});

test('a failed picture read degrades to "no pictures", never to a failed sign-in', async () => {
  await stubbing([[User, 'findOne', () => { throw new Error('database unavailable'); }]], async () => {
    assert.deepEqual(await publicPictures(projectedUser()), { profilePicture: '', bannerPicture: '' });
  });

  // No account at all, and no document — both are ordinary conditions.
  assert.deepEqual(await publicPictures(null), { profilePicture: '', bannerPicture: '' });
  await stubbing([[User, 'findOne', () => stubQuery(null)]], async () => {
    assert.deepEqual(await publicPictures(projectedUser()), { profilePicture: '', bannerPicture: '' });
  });
});

// ── 2. The cap is decided in the query, so the read stays small ──────────────

test('the picture read is filtered by SIZE, server-side', () => {
  const filter = boundedPictureFilter();
  const serialised = JSON.stringify(filter);

  assert.ok(filter.$expr, 'the bound must be part of the query, not only of the JavaScript that follows it');
  assert.ok(serialised.includes('$strLenCP'), 'the bound must be measured on the stored value');
  assert.ok(serialised.includes('$profilePicture'), 'the profile picture must be measured');
  assert.ok(serialised.includes('$bannerPicture'), 'the banner must be measured');
  assert.ok(serialised.includes(String(INLINE_BLOB_CHARS)),
    `the bound must be INLINE_BLOB_CHARS (${INLINE_BLOB_CHARS}) — the same number safePictureValue uses`);

  // `$convert`/`$ifNull` are what keep a null, missing or non-string value from
  // making `$strLenCP` raise — i.e. from turning a sign-in into a 500.
  assert.ok(serialised.includes('$convert'), 'stored values must be coerced before they are measured');
  assert.ok(serialised.includes('$ifNull'), 'a missing value must measure as empty, not blow up');

  // Only the two operands and the cap: one round trip, and the projection can
  // only ever return something already safe to send.
  const measured = (filter.$expr.$lte[0].$add || []).length;
  assert.equal(measured, 2, 'both picture fields must be measured in the one expression');
});

test('PICTURE_PROJECTION is the picture fields and nothing else', () => {
  const fields = String(PICTURE_PROJECTION).split(/\s+/).filter(Boolean);
  assert.deepEqual(fields.slice().sort(), ['bannerPicture', 'profilePicture']);
  assert.equal(new Set(fields).size, fields.length, 'no duplicate field names');
});

// ── 3. The reported route, over real HTTP ───────────────────────────────────

/**
 * Drive POST /api/auth/passkeys/login/verify end to end, with the models and
 * the ceremony stubbed. Everything the route itself does — reading the
 * challenge out of the client data, resolving the account from the credential,
 * spending the challenge, building the response — runs for real.
 */
async function signInWithPasskey({ storedPictures, failSignInWith } = {}) {
  const challenge = 'test-challenge-abc123';
  const stored = storedPictures || { profilePicture: AVATAR, bannerPicture: BANNER };

  let signInSelect = null;
  let pictureFilter = null;

  return stubbing([
    [User, 'findById', () => {
      const query = stubQuery(projectedUser());
      const realSelect = query.select;
      query.select = (fields) => { signInSelect = fields; return realSelect(fields); };
      return query;
    }],
    // The picture read the response needs.
    [User, 'findOne', (filter) => {
      pictureFilter = filter;
      return stubQuery(stored);
    }],
    [Passkey, 'findOne', () => stubQuery({
      _id: 'passkey-1', user: USER_ID, name: 'Laptop', credentialId: 'cred-1',
      counter: 3, transports: [], deviceLabel: 'Chrome on Windows',
    })],
    [Passkey, 'updateOne', () => stubQuery({ ok: 1 })],
    [SecurityEvent, 'write', async (event) => event],
    [sessionUtils, 'issueUserSession', async () => {
      if (failSignInWith) throw new Error(failSignInWith);
      return 'stub.jwt.token';
    }],
    [webauthn, 'consumeChallenge', async () => ({ challenge, flow: 'login' })],
    [webauthn, 'verifyAuthentication', async () => ({
      verified: true, authenticationInfo: { newCounter: 9 },
    })],
  ], async () => {
    // `utils/authFlow.js` destructures `issueUserSession` at module load, so a
    // stub applied to the sessions module after it was first required would be
    // invisible to the route. Both caches are dropped INSIDE the stubbed window
    // so the route is rebuilt against the doubles.
    delete require.cache[require.resolve('../utils/authFlow')];
    delete require.cache[require.resolve('../routes/passkeys')];
    const app = express();
    app.use(express.json());
    app.use('/api/auth/passkeys', require('../routes/passkeys'));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/passkeys/login/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          response: {
            id: 'cred-1',
            rawId: 'cred-1',
            response: {
              // Only the challenge is read structurally by the route; the rest
              // is the stubbed library's business.
              clientDataJSON: b64u(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'http://localhost:5173' })),
              authenticatorData: b64u(Buffer.alloc(37)),
              signature: b64u(Buffer.alloc(70)),
            },
          },
        }),
      });
      return { status: res.status, body: await res.json(), signInSelect, pictureFilter };
    } finally {
      await new Promise((resolve) => server.close(resolve));
      delete require.cache[require.resolve('../utils/authFlow')];
      delete require.cache[require.resolve('../routes/passkeys')];
    }
  });
}

test('a passkey sign-in returns the account it signed in — avatar and banner included', async () => {
  const { status, body } = await signInWithPasskey();

  assert.equal(status, 200, `passkey sign-in failed: ${JSON.stringify(body)}`);
  assert.equal(String(body._id), USER_ID, 'the account comes from the credential, not the request');

  // THE ASSERTION. Empty strings here are what made the avatar vanish from the
  // navbar and the profile page for the rest of the session.
  assert.equal(body.profilePicture, AVATAR,
    'a passkey sign-in must return the profile picture the account has');
  assert.equal(body.bannerPicture, BANNER,
    'a passkey sign-in must return the banner the account has');

  // The rest of the profile has to keep working too: a sign-in that trades a
  // missing avatar for a missing name or a wrong plan is not a fix.
  assert.equal(body.name, 'Demo User');
  assert.equal(body.email, 'demo@example.com');
  assert.equal(body.subscriptionPlan, 'free');
  assert.ok(body.token, 'a session token is still issued');
});

test('a passkey sign-in did NOT stop projecting the pictures out of its read', async () => {
  // The other half of the contract. `Test File/login-picture-footprint.test.js`
  // pins this projection for /login because of the multi-megabyte document; the
  // fix has to leave it exactly where it was.
  const { signInSelect } = await signInWithPasskey();
  assert.ok(signInSelect, 'the sign-in read must still project the fields it needs');
  assert.match(signInSelect, /-profilePicture/,
    'the sign-in read must keep profilePicture out — that projection is what prevents the outage');
  assert.match(signInSelect, /-bannerPicture/,
    'the sign-in read must keep bannerPicture out — that projection is what prevents the outage');
});

test('the picture a sign-in reports is read through the size-bounded filter', async () => {
  const { pictureFilter } = await signInWithPasskey();
  assert.ok(pictureFilter && pictureFilter.$expr,
    'the sign-in response must read its pictures through boundedPictureFilter, not an unbounded projection');
  assert.ok(JSON.stringify(pictureFilter).includes(String(INLINE_BLOB_CHARS)),
    'the bounded read must carry the cap');
});

test('a failure AFTER the passkey was accepted is not reported as a rejected passkey', async () => {
  // The passkey has already been verified at this point, and the session mint
  // has already displaced the account's previous session. Answering "that
  // passkey could not be verified" — and counting an offense against the
  // account — told the owner their credential was refused and walked them up
  // the lockout ladder for a database problem.
  const { status, body } = await signInWithPasskey({ failSignInWith: 'database unavailable' });

  assert.equal(status, 503, `an internal failure must not be dressed as a refusal: ${JSON.stringify(body)}`);
  assert.doesNotMatch(body.message || '', /passkey could not be verified/i,
    'the owner must not be told their (verified) passkey was rejected');
  assert.equal(body.token, undefined, 'no half-finished session may be handed over');
});

// ── 4. Every sign-in route that hides the pictures must still show them ──────

/**
 * The routes below read the account WITHOUT the picture fields and then build
 * their response from that same document. Each one has to reach for
 * `publicPictures` — the defect above was three copies of forgetting to.
 *
 * Scoped per handler (from the route declaration to the next one) so a
 * `publicPictures` call in a different handler cannot make this pass.
 */
const SIGN_IN_HANDLERS = [
  { file: 'routes/passkeys.js', route: "router.post('/login/verify'", label: 'POST /auth/passkeys/login/verify' },
  { file: 'routes/recoveryCodes.js', route: "router.post('/verify'", label: 'POST /auth/recovery-codes/verify' },
  { file: 'routes/totp.js', route: "router.post('/verify'", label: 'POST /auth/totp/verify' },
];

test('every sign-in route that projects the pictures out reports them anyway', () => {
  for (const { file, route, label } of SIGN_IN_HANDLERS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const start = source.indexOf(route);
    assert.ok(start > -1, `could not find ${route} in ${file}`);

    const next = source.indexOf('\nrouter.', start + route.length);
    const body = source.slice(start, next > -1 ? next : source.length);

    assert.match(body, /publicUser\(user\)/, `${label} builds its response from the projected document`);
    assert.match(body, /publicPictures\(user\)/,
      `${label} must add publicPictures(user) to its response — otherwise it tells the client the account has no avatar`);
  }
});

test('no sign-in response reports a picture field the account does have', () => {
  // Same idea from the other end: `publicUser` reads the pictures off whatever
  // document it is given, so every route that gives it a picture-less document
  // is a route that can only ever answer "no avatar".
  const projected = publicUser(projectedUser());
  assert.equal(projected.profilePicture, '', 'precondition: the projected document carries no avatar');
  assert.equal(projected.bannerPicture, '', 'precondition: the projected document carries no banner');

  for (const { file, route, label } of SIGN_IN_HANDLERS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const start = source.indexOf(route);
    const next = source.indexOf('\nrouter.', start + route.length);
    const body = source.slice(start, next > -1 ? next : source.length);

    // Either the pictures are read (publicPictures) or the document itself
    // carries them. Reading the projection is what tells the two apart.
    const readsPictures = /publicPictures\(user\)/.test(body);
    const readsThemInline = /User\.findById\(transaction\.user\)(?![\s\S]{0,40}-profilePicture)/.test(body);
    assert.ok(readsPictures || readsThemInline,
      `${label} neither reads the pictures separately nor reads them inline — one of the two has to be true`);
  }
});