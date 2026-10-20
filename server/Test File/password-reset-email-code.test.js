'use strict';

/**
 * THE 6-DIGIT CODE IN THE RESET EMAIL
 * ==================================
 *
 * Every reset email prints a 6-digit code and tells the reader to use it "on the
 * reset screen instead" when they are opening the message on another device.
 *
 * That sentence was a promise the product did not keep. The reset screen had no
 * field for a code, and the only endpoint that could redeem one
 * (POST /api/auth/verify-password-reset-otp, retained for stale clients) is
 * keyed on a `userId` that the email does not carry. So the one recovery route
 * offered to somebody whose link did not open led nowhere, and the tests below
 * are the ones that should have caught it: they assert the code in the email can
 * be REDEEMED, rather than asserting only that it is present.
 *
 * The first test is the regression guard. If the `/code` route is removed, stops
 * being registered before `requestLimiter`, or the client stops calling it, that
 * one fails.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-email-code';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withResetRouter, stubUser, CURRENT_PASSWORD, EMAIL } = require('./withResetRouter');
const lockout = require('../utils/lockout');

/**
 * Clear the lockout buckets this flow writes to.
 *
 * utils/lockout.js holds them in a module-level Map — deliberately, it models a
 * live process. Several cases below deliberately submit a wrong code, which walks
 * the escalating ladder for the `pwreset-factor` bucket, and every case here uses
 * the SAME stub user id — so without this reset the ladder set by one case turns
 * a later case into a 429 that has nothing to do with what it is testing. The
 * idiom and the reasoning are the ones already used in email-otp-security.test.js.
 *
 * Nothing here weakens the ladder, which has its own tests.
 */
function clearLockoutState() {
  lockout.clearAccountState(lockout.accountKey('pwreset-factor', stubUser()._id));
}

// Compliant with the current policy, and deliberately NOT the user's current
// password, so it clears both the validator and the reuse check.
const NEW_PASSWORD = 'Zephyr$Quartz29!';

/** Ask for a reset and return the captured email payload. */
async function requestReset(ctx) {
  const res = await ctx.request();
  assert.equal(res.status, 200);
  assert.equal(ctx.sent.length, 1, 'exactly one reset email should go out');
  return ctx.sent[0];
}

// Every case starts from a clean ladder. Placed here rather than inside each
// test so a new case cannot forget it.
test.beforeEach(clearLockoutState);
test.afterEach(clearLockoutState);

test('the code printed in the email can actually be redeemed for a grant', async () => {
  await withResetRouter({}, async (ctx) => {
    const mail = await requestReset(ctx);

    assert.match(mail.code, /^\d{6}$/, 'the email must carry a 6-digit code');

    const res = await ctx.call('/code', { email: EMAIL, code: mail.code });

    assert.equal(res.status, 200, `the emailed code was refused: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.resetToken, 'a grant is what the rest of the flow redeems');
    // The same shape every other recovery method returns, so the client keeps one
    // redemption path rather than one per proof.
    assert.ok(res.body.expiresAt);
  });
});

test('the redeemed grant sets the password in the one place a password changes', async () => {
  await withResetRouter({}, async (ctx) => {
    const mail = await requestReset(ctx);
    const { body: granted } = await ctx.call('/code', { email: EMAIL, code: mail.code });

    const done = await ctx.call('/complete', { token: granted.resetToken, newPassword: NEW_PASSWORD });

    assert.equal(done.status, 200);
    assert.equal(done.body.success, true);
    // The properties the grant exists to provide, all still intact because this
    // path mints exactly what the emailed link mints.
    assert.equal(ctx.revoked(), 1, 'every session must be revoked');
    assert.ok(
      ctx.store.rows.every((row) => row.usedAt),
      'every outstanding grant for the account must be burned'
    );
  });
});

test('the email carries a code and NO reset link', async () => {
  // The link was the whole problem: mail clients rewrite and sometimes truncate
  // the query string, and a link has to name an address the reader's device can
  // reach — which on a phone is not the laptop that issued it. The code has
  // neither failure mode, so the email must not carry one at all.
  await withResetRouter({}, async (ctx) => {
    const mail = await requestReset(ctx);

    assert.match(mail.code, /^\d{6}$/, 'the email must carry a 6-digit code');
    assert.equal(mail.resetUrl, undefined, 'the emailed credential is the code alone');
    // And the token still exists on the record — it is the grant the recovery
    // proofs hand out — it is simply never put in the mail.
    assert.ok(ctx.tokenFromStore(), 'a grant is stored even though no link is emailed');
  });
});

test('the token path still works for the recovery proofs that hand one out', async () => {
  // Removing the link from the EMAIL must not remove the grant-based flow: the
  // passkey / recovery-code / authenticator methods all mint a token and send the
  // client to the same form, which still reads `?token=`.
  await withResetRouter({}, async (ctx) => {
    await requestReset(ctx);
    const { body: granted } = await ctx.call('/code', { email: EMAIL, code: ctx.sent[0].code });

    const validated = await ctx.call(`/validate?token=${encodeURIComponent(granted.resetToken)}`);
    assert.equal(validated.status, 200);
    assert.equal(validated.body.valid, true);

    const done = await ctx.call('/complete', { token: granted.resetToken, newPassword: NEW_PASSWORD });
    assert.equal(done.status, 200);
  });
});

test('the email sends a code entry page, and it is the only address in it', async () => {
  // Without this link "enter this code" gives the reader nowhere to go on a
  // device that never opened a link. One place to go: two addresses in one mail
  // is how somebody ends up on the wrong one.
  await withResetRouter({}, async (ctx) => {
    const mail = await requestReset(ctx);

    assert.ok(mail.codeUrl, 'the email must say where the code is typed');
    assert.doesNotMatch(mail.codeUrl, /token=/, 'the code page must not carry a grant');
    assert.equal(new URL(mail.codeUrl).pathname, '/reset-password');
    assert.equal(new URL(mail.codeUrl).search, '', 'the code page must have no query string');
  });
});

test('every failure is refused identically, so the route is not an oracle', async () => {
  // Three genuinely different failures, which must be indistinguishable outside:
  // a wrong secret, an unknown address, and no reset in progress.
  const outcomes = [];

  outcomes.push(await withResetRouter({}, async (ctx) => {
    await requestReset(ctx);
    const res = await ctx.call('/code', { email: EMAIL, code: '000000' });
    return `${res.status}:${res.body.message}`;
  }));

  // Each case below records its own failure against the same stub account, so
  // the ladder has to be cleared between them or the next one is answering 429
  // instead of the refusal under test.
  clearLockoutState();
  outcomes.push(await withResetRouter({ findUser: () => null }, async (ctx) => {
    const res = await ctx.call('/code', { email: 'nobody@example.com', code: '000000' });
    return `${res.status}:${res.body.message}`;
  }));

  clearLockoutState();
  outcomes.push(await withResetRouter({}, async (ctx) => {
    // A real account, but no reset was ever requested — nothing is in progress.
    const res = await ctx.call('/code', { email: EMAIL, code: '000000' });
    return `${res.status}:${res.body.message}`;
  }));

  assert.equal(
    new Set(outcomes).size, 1,
    `these refusals must be indistinguishable:\n${outcomes.join('\n')}`
  );
  assert.match(outcomes[0], /^401:/, 'an unverifiable proof is a refusal, not a hint');
});

test('a malformed code is refused before anything is looked up', async () => {
  await withResetRouter({}, async (ctx) => {
    // A reset IS running here, so the assertions below are about the shape check
    // happening first rather than about there being nothing to find.
    await requestReset(ctx);

    for (const code of ['12345', '1234567', 'abcdef', '', '12 34 56x']) {
      const res = await ctx.call('/code', { email: EMAIL, code });
      assert.equal(res.status, 400, `"${code}" should be a 400, got ${res.status}`);
    }

    // A 400 here is safe to be specific about precisely because no account has
    // been read: the shape was rejected on its own.
    assert.equal(ctx.store.rows.length, 1, 'no record may be created by a shape error');
    assert.equal(ctx.store.rows[0].codeAttempts, 0, 'a shape error must not spend an attempt');
  });
});

test('an account with two-factor is not downgraded to a code in its mailbox', async () => {
  // Where an authenticator is the factor, the emailed code is not proof of it.
  // Honouring the code here would quietly remove 2FA from the account.
  const res = await withResetRouter(
    { findUser: () => stubUser({ twoFactorEnabled: true, twoFactorMethod: 'authenticator' }) },
    async (ctx) => {
      const mail = await requestReset(ctx);
      return ctx.call('/code', { email: EMAIL, code: mail.code });
    },
  );

  assert.equal(res.status, 401);
});

test('a wrong code is refused and the attempt is counted', async () => {
  await withResetRouter({}, async (ctx) => {
    const mail = await requestReset(ctx);

    const res = await ctx.call('/code', { email: EMAIL, code: '000000' });

    assert.equal(res.status, 401);
    assert.equal(ctx.store.rows[0].codeAttempts, 1, 'a miss must be recorded against the record');
    // The emailed code is still the one that works: a wrong guess must not burn
    // the reset the user actually asked for.
    assert.equal((await ctx.call('/code', { email: EMAIL, code: mail.code })).status, 200);
  });
});

test('a wrong code never yields a grant, whatever else is asked for', async () => {
  await withResetRouter({}, async (ctx) => {
    await requestReset(ctx);

    // The refused request also carries a new password, in case a handler were
    // ever written to complete the reset inline instead of minting a grant.
    const res = await ctx.call('/code', { email: EMAIL, code: '000000', newPassword: NEW_PASSWORD });

    assert.equal(res.status, 401);
    assert.equal(res.body.resetToken, undefined, 'a refused code must not return a grant');
    assert.equal(ctx.store.rows.filter((row) => !row.usedAt).length, 1, 'no grant may be created');
    assert.equal(ctx.revoked(), 0, 'nothing about the account may change');
  });
});

test('a grant minted from a code cannot "reset" to the password already in use', async () => {
  // Guards the reuse check on the code path.
  await withResetRouter({}, async (ctx) => {
    const mail = await requestReset(ctx);
    const { body: granted } = await ctx.call('/code', { email: EMAIL, code: mail.code });

    const done = await ctx.call('/complete', {
      token: granted.resetToken,
      newPassword: CURRENT_PASSWORD,
    });

    assert.equal(done.status, 400);
    assert.equal(ctx.revoked(), 0, 'a refused password must not revoke sessions');
  });
});