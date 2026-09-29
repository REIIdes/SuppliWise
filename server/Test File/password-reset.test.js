/**
 * PASSWORD RESET — the link-based flow, end to end.
 *
 * The bugs these lock down were all reported as "the forgot password thing is
 * broken", and each one is a specific, observable failure:
 *
 *   1. THE LINK DIED ON A RESTART. Codes lived in a module-level `Map`, so any
 *      nodemon reload or deploy silently destroyed them. A user with the email
 *      open was told "No password reset request found" — with nothing they could
 *      do and no way to tell it wasn't their fault. Now the grant is a MongoDB
 *      document, so these tests stub the model rather than the store and the
 *      state provably outlives the request that created it.
 *
 *   2. THE RESPONSE LEAKED WHO HAS AN ACCOUNT. The old /forgot-password returned
 *      a `userId` only for real accounts, right next to a message insisting it
 *      revealed nothing. Every response is now byte-identical, and that is
 *      asserted for the known, unknown and mail-outage cases together — a fix
 *      for one that quietly opens another is the failure mode worth guarding.
 *
 *   3. A MAIL OUTAGE COULD NOT BE REPORTED. The old route answered 503 when
 *      delivery failed and 200 when the address had no account, which is the
 *      same oracle wearing a different hat.
 *
 *   4. A TYPO'D NEW PASSWORD BURNED THE LINK. The grant is now claimed only
 *      after the policy passes, so a rejected password leaves the user able to
 *      try again.
 *
 *   5. THE LINK REPLAYED. Claiming is one atomic conditional update, so two
 *      simultaneous redemptions cannot both succeed.
 *
 * The mailer and the database are stubbed, so this runs with no SMTP and no
 * MongoDB.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { PASSWORD_RULES } = require('../utils/passwordRules');
const { withResetRouter, USER_ID, EMAIL, CURRENT_PASSWORD, TTL_MS } = require('./withResetRouter');

const NEW_PASSWORD = 'Mango$Tulip77!';
// Satisfies every composition rule and is on the server's blocklist in spirit —
// the shape of password people actually pick when told to add a symbol.
const GUESSABLE_PASSWORD = 'Password123!';

// ── 1. The grant outlives the request ──────────────────────────────────────

test('the link still works on a later request — the grant is not held in memory', async () => {
  await withResetRouter({}, async ({ request, call, linkFromLastMail, store }) => {
    const first = await request();
    assert.equal(first.status, 200);

    // The proof that matters: state lives in the model, so it is still here.
    assert.equal(store.rows.length, 1, 'the grant must be persisted, not held in a Map');
    assert.equal(store.rows[0].tokenHash.startsWith('h:'), true);

    const token = linkFromLastMail();
    const validated = await call(`/validate?token=${encodeURIComponent(token)}`);
    assert.equal(validated.status, 200, `link must validate: ${JSON.stringify(validated.body)}`);
    assert.equal(validated.body.valid, true);
  });
});

test('the stored row holds no plaintext token or code — only digests', async () => {
  await withResetRouter({}, async ({ request, sent, store, linkFromLastMail }) => {
    await request();
    const row = store.rows[0];
    const token = linkFromLastMail();
    const code = sent[sent.length - 1].code;

    assert.notEqual(row.tokenHash, token, 'the raw token must never be stored');
    assert.notEqual(row.codeHash, code, 'the raw code must never be stored');
  });
});

// ── 2 & 3. One answer for everyone, always ──────────────────────────────────

test('a known account, an unknown address and a mail outage all get the same answer', async () => {
  const known = await (async () => {
    let out;
    await withResetRouter({ deliver: () => true }, async (ctx) => { out = (await ctx.request()).body; });
    return out;
  })();

  const unknown = await (async () => {
    let out;
    await withResetRouter({ deliver: () => true, findUser: () => null }, async (ctx) => {
      out = (await ctx.call('/request', { email: 'ghost@example.test' })).body;
    });
    return out;
  })();


  const outage = await (async () => {
    let out;
    await withResetRouter({ deliver: () => false }, async (ctx) => { out = (await ctx.request()).body; });
    return out;
  })();

  // Byte-identical, not merely similar. Any difference here is an oracle.
  assert.deepEqual(known, unknown, 'an unknown address must be indistinguishable from a known one');
  assert.deepEqual(known, outage, 'a mail outage must be indistinguishable too — 503 would leak existence');
  assert.equal(Object.keys(known).length, 1, `the body must carry only a message, got ${JSON.stringify(known)}`);
});

test('the old enumeration leak — a userId in the response — is gone', async () => {
  await withResetRouter({}, async ({ request }) => {
    const res = await request();
    assert.equal(res.body.userId, undefined, 'a userId hands back exactly what the generic message denies');
    assert.equal(res.body.token, undefined, 'the token lives in the email, never in the response');
    assert.equal(res.body.requiresOtp, undefined);
  });
});

test('a mail outage is logged loudly even though the user is told to check their inbox', async () => {
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    await withResetRouter({ deliver: () => false }, async ({ request, store, sent }) => {
      const res = await request();
      assert.equal(res.status, 200);
      // Nothing was stored: a link that was never delivered must not validate.
      assert.equal(store.rows.length, 0, 'an undelivered link must never become a live credential');
      assert.equal(sent.length, 1, 'the mailer was genuinely tried');
    });
  } finally {
    console.error = originalError;
  }
  assert.ok(
    logged.some((line) => /delivery FAILED/.test(line)),
    `the outage must be visible to the operator, got ${JSON.stringify(logged)}`
  );
});

test('a malformed address is still rejected — the anonymity is not a free pass', async () => {
  await withResetRouter({}, async ({ call }) => {
    for (const email of ['', 'not-an-email', 'a@b', '@example.com']) {
      const res = await call('/request', { email });
      assert.equal(res.status, 400, `"${email}" should be a 400, got ${res.status}`);
    }
  });
});

// ── 4. Redeeming the link ───────────────────────────────────────────────────

test('a valid link sets the new password and signs every device out', async () => {
  await withResetRouter({}, async ({ request, call, linkFromLastMail, sessionUsers }) => {
    await request();
    const token = linkFromLastMail();

    const res = await call('/complete', { token, newPassword: NEW_PASSWORD });
    assert.equal(res.status, 200, `${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.success, true);
    assert.equal(sessionUsers.size, 0, 'a reset must evict the sessions an intruder may be holding');
  });
});

test('the same link cannot be used twice', async () => {
  await withResetRouter({}, async ({ request, call, linkFromLastMail }) => {
    await request();
    const token = linkFromLastMail();

    const first = await call('/complete', { token, newPassword: NEW_PASSWORD });
    assert.equal(first.status, 200);

    const replay = await call('/complete', { token, newPassword: 'Different$Pass99!' });
    assert.equal(replay.status, 400, 'a single-use link must not work twice');
    assert.match(replay.body.message, /no longer valid|already been used|just been used/i);
  });
});

test('two simultaneous redemptions of one link: exactly one wins', async () => {
  await withResetRouter({}, async ({ request, call, linkFromLastMail }) => {
    await request();
    const token = linkFromLastMail();

    // Fired together on purpose. The guarantee is in the conditional claim, so
    // this is the only way to prove it is really there.
    const [a, b] = await Promise.all([
      call('/complete', { token, newPassword: NEW_PASSWORD }),
      call('/complete', { token, newPassword: 'Another$Pass99!' }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 400], `exactly one must win, got ${statuses}`);
  });
});

test('a rejected new password leaves the link usable', async () => {
  await withResetRouter({}, async ({ request, call, linkFromLastMail }) => {
    await request();
    const token = linkFromLastMail();

    // Too short, no symbol, then the blocked shape — each must refuse.
    for (const bad of ['short', 'alllowercase1', GUESSABLE_PASSWORD, `${'a'.repeat(200)}aA1!`]) {
      const res = await call('/complete', { token, newPassword: bad });
      assert.equal(res.status, 400, `"${bad.slice(0, 20)}" should be refused`);
      assert.ok(res.body.message, 'a refusal must say what is wrong');
    }

    // The link must have survived every one of those.
    const good = await call('/complete', { token, newPassword: NEW_PASSWORD });
    assert.equal(good.status, 200, `the link must not be burned by a bad password: ${JSON.stringify(good.body)}`);
  });
});

test('a password identical to the current one is refused, and the link survives', async () => {
  await withResetRouter({}, async ({ request, call, linkFromLastMail }) => {
    await request();
    const token = linkFromLastMail();

    const res = await call('/complete', { token, newPassword: CURRENT_PASSWORD });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /you have not used before|not been used before/i);

    const retry = await call('/complete', { token, newPassword: NEW_PASSWORD });
    assert.equal(retry.status, 200, 'refusing a weak password must not consume the link');
  });
});

test('an unknown or malformed token is refused without a 500', async () => {
  await withResetRouter({}, async ({ call }) => {
    for (const token of ['', 'short', 'x'.repeat(64), '../../etc/passwd']) {
      const res = await call('/complete', { token, newPassword: NEW_PASSWORD });
      assert.equal(res.status, 400, `token "${token.slice(0, 12)}" gave ${res.status}`);
    }
    const validated = await call('/validate?token=not-a-real-token');
    assert.equal(validated.status, 400);
    assert.equal(validated.body.valid, false);
  });
});

test('a NoSQL-operator token cannot select a grant', async () => {
  await withResetRouter({ deliver: () => true }, async ({ request, call, linkFromLastMail }) => {
    await request();
    // The classic probe: if the hash were compared as a query object rather
    // than as a string, this would match every row.
    const res = await call('/complete', { token: { $ne: null }, newPassword: NEW_PASSWORD });
    assert.equal(res.status, 400, `an object token must not resolve a grant, got ${res.status}`);
  });
});

test('missing fields are 400s, never a 500', async () => {
  await withResetRouter({}, async ({ call }) => {
    assert.equal((await call('/complete', {})).status, 400);
    assert.equal((await call('/complete', { token: 'x'.repeat(43) })).status, 400);
    assert.equal((await call('/complete', { token: 'x'.repeat(43), newPassword: 12345 })).status, 400);
    assert.equal((await call('/complete', { token: ['a'], newPassword: {} })).status, 400);
  });
});

// ── 5. Superseding a link ──────────────────────────────────────────────────

test('a successful reset burns the account\'s other outstanding links', async () => {
  await withResetRouter({}, async ({ request, call, store, linkFromLastMail }) => {
    await request();
    const ownerToken = linkFromLastMail();

    // A second link issued before the owner got theirs — what an attacker who
    // triggered a reset first would be holding. Written straight to the store
    // because the resend cooldown (correctly) refuses to issue a second one
    // this quickly, and this test is about invalidation, not the cooldown.
    const { generateSecrets } = require('../models/PasswordResetToken');
    const intruder = generateSecrets();
    await store.store({ userId: USER_ID, token: intruder.token, code: intruder.code, ttlMs: TTL_MS });

    const done = await call('/complete', { token: ownerToken, newPassword: NEW_PASSWORD });
    assert.equal(done.status, 200, `${done.status} ${JSON.stringify(done.body)}`);

    // The intruder's link must be dead, or the owner's recovery evicted nobody.
    const replay = await call('/complete', { token: intruder.token, newPassword: 'Yet$Another99!' });
    assert.equal(replay.status, 400, 'every other live link must be invalidated by the reset');
  });
});

test('the resend cooldown suppresses a second email without saying why', async () => {
  await withResetRouter({}, async ({ call, sent }) => {
    const first = await call('/request', { email: EMAIL });
    assert.equal(sent.length, 1);

    const second = await call('/request', { email: EMAIL });
    assert.equal(sent.length, 1, 'the cooldown must actually suppress the send');
    // 200, not 429: a cooldown error would confirm the address has an account.
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body, 'the suppressed answer must be identical');
  });
});

// ── 6. The legacy aliases still complete a reset ───────────────────────────
//
// The link is the flow, but the old OTP endpoints were kept and kept working so
// a stale client is not stranded. These run against routes/auth.js itself.

test('the emailed code can be exchanged for a grant, and the grant sets the password', async () => {
  await withResetRouter({ route: 'legacy' }, async ({ request, sent, call, sessionUsers }) => {
    await request();
    const code = sent[sent.length - 1].code;

    const wrong = await call('/verify-password-reset-otp', { userId: USER_ID, otp: '000000' });
    assert.equal(wrong.status, 400, 'a wrong code must be refused');

    const ok = await call('/verify-password-reset-otp', { userId: USER_ID, otp: code });
    assert.equal(ok.status, 200, `the emailed code must verify: ${JSON.stringify(ok.body)}`);
    assert.ok(ok.body.resetToken, 'a grant must come back so the code need not be held');

    const done = await call('/reset-password', { resetToken: ok.body.resetToken, newPassword: NEW_PASSWORD });
    assert.equal(done.status, 200, `${done.status} ${JSON.stringify(done.body)}`);
    assert.equal(sessionUsers.size, 0, 'the code path must revoke sessions too');
  });
});

test('the old code-only client shape still works: userId + otp in one call', async () => {
  await withResetRouter({ route: 'legacy' }, async ({ request, sent, call }) => {
    await request();
    const code = sent[sent.length - 1].code;

    // No /verify-password-reset-otp step at all — this is the shape the original
    // client used, and it is the reason both accepted forms are kept.
    const done = await call('/reset-password', { userId: USER_ID, otp: code, newPassword: NEW_PASSWORD });
    assert.equal(done.status, 200, `${done.status} ${JSON.stringify(done.body)}`);
  });
});

test('the code is burned after five wrong guesses, not merely counted', async () => {
  await withResetRouter({ route: 'legacy' }, async ({ request, sent, call }) => {
    await request();
    const code = sent[sent.length - 1].code;

    for (let i = 0; i < 5; i += 1) {
      const status = (await call('/verify-password-reset-otp', { userId: USER_ID, otp: '000000' })).status;
      assert.notEqual(status, 429, `guess ${i + 1} should be a plain rejection, not a lockout`);
    }
    // The real code is now worthless — a 6-digit space must not be unlimited.
    const after = await call('/verify-password-reset-otp', { userId: USER_ID, otp: code });
    assert.equal(after.status, 429, 'the code must be burned after five strikes');
  });
});

test('a grant signed for another purpose cannot be used to reset a password', async () => {
  await withResetRouter({ route: 'legacy' }, async ({ call }) => {
    // A grant is proof for exactly one thing. Anything else signed with the same
    // secret — including a session token shape — must not pass here.
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: USER_ID, purpose: 'something-else' }, process.env.JWT_SECRET, { expiresIn: 900 });
    const res = await call('/reset-password', { resetToken: forged, newPassword: NEW_PASSWORD });
    assert.equal(res.status, 400, 'a grant with the wrong purpose must be refused');
  });
});

// ── 8. Bad input is a 4xx, never a 500 ─────────────────────────────────────
//
// `User.findById('not-an-id')` does not return null — it THROWS a CastError. On
// a route whose catch-all answers "Something went wrong. Please try again later."
// that turns the caller's typo into an opaque 500, which is both wrong (our side
// is fine) and useless (a retry sends the same malformed value). Found by
// driving the live server, not by any test.
//
// These are all PUBLIC, UNAUTHENTICATED routes, so this is the difference
// between a 4xx and an unauthenticated way to make the server throw.

test('a malformed user id is a 400 on every legacy route that takes one', async () => {
  await withResetRouter({ route: 'legacy' }, async ({ call }) => {
    const malformed = ['not-an-id', '123', 'x'.repeat(24), '507f1f77bcf86cd79943901z', { $ne: null }, ['a']];
    for (const userId of malformed) {
      const label = JSON.stringify(userId).slice(0, 24);
      assert.equal(
        (await call('/resend-password-reset-otp', { userId })).status, 400,
        `/resend-password-reset-otp with ${label} must be a 400`
      );
      assert.equal(
        (await call('/verify-password-reset-otp', { userId, otp: '123456' })).status, 400,
        `/verify-password-reset-otp with ${label} must be a 400`
      );
      assert.equal(
        (await call('/reset-password', { userId, otp: '123456', newPassword: NEW_PASSWORD })).status, 400,
        `/reset-password with ${label} must be a 400`
      );
    }
  });
});

test('a well-formed id for an account that does not exist is a 401, not a 500', async () => {
  await withResetRouter({ route: 'legacy', findUser: () => null }, async ({ call }) => {
    const ghost = '507f1f77bcf86cd7994390ff';
    assert.equal((await call('/resend-password-reset-otp', { userId: ghost })).status, 401);
    assert.equal((await call('/verify-password-reset-otp', { userId: ghost, otp: '123456' })).status, 401);
  });
});

// ── 7. The policy is served, not copied ────────────────────────────────────

test('the rules endpoint is what the client renders its checklist from', async () => {
  await withResetRouter({}, async ({ call }) => {
    const res = await call('/rules');
    assert.equal(res.status, 200);
    assert.equal(res.body.minLength, PASSWORD_RULES.minLength);
    assert.equal(res.body.maxLength, PASSWORD_RULES.maxLength);
    assert.equal(res.body.checks.length, 6);
    assert.ok(res.body.scoreLabels.every((label) => typeof label === 'string' && label));
  });
});
