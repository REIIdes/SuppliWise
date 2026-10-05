import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { securityFactor, securityMethod, SECURITY_METHODS } from './securityFactor.js';
import { EVENT_LABELS, NOTABLE, eventLabel } from './securityEventLabels.js';

const here = dirname(fileURLToPath(import.meta.url));

// ── The 2FA / Security column ─────────────────────────────────────────────
//
// This column used to render one expression:
//     user.twoFactorEnabled ? 'Google Authenticator active' : 'Email OTP active'
// which was wrong twice over. Every assertion below is a case that expression
// got wrong and that no amount of UI polish would have fixed.

test('a passkey outranks every other factor', () => {
  // The headline bug: an account holding the strongest factor available, and
  // no authenticator app, was reported as the weakest thing it had.
  assert.equal(
    securityFactor({ passkeyCount: 2, twoFactorEnabled: false }).method,
    SECURITY_METHODS.PASSKEY,
  );
  // Even alongside an active authenticator app.
  assert.equal(
    securityFactor({ passkeyCount: 1, twoFactorEnabled: true, twoFactorMethod: 'authenticator' }).method,
    SECURITY_METHODS.PASSKEY,
  );
});

test('an account on email codes is never called an authenticator', () => {
  // The other headline bug: twoFactorEnabled was true but the second factor was
  // a mailed code, and the column claimed Google Authenticator.
  const factor = securityFactor({ passkeyCount: 0, twoFactorEnabled: true, twoFactorMethod: 'email' });
  assert.equal(factor.method, SECURITY_METHODS.EMAIL);
  assert.equal(factor.label, 'Email OTP active');
  assert.doesNotMatch(factor.label, /Authenticator/i);
  assert.equal(factor.strong, false, 'email codes must not read as strong');
});

test('an authenticator app is only claimed when it is the method', () => {
  const factor = securityFactor({ passkeyCount: 0, twoFactorEnabled: true, twoFactorMethod: 'authenticator' });
  assert.equal(factor.label, 'Google Authenticator active');
  assert.equal(factor.strong, true);
});

test('a missing method on an enabled account reads as the authenticator, not as password', () => {
  // Models/User.js documents twoFactorMethod as meaningful only while enabled
  // and defaults it to 'authenticator'. Under-reporting protection here would be
  // the dangerous direction, so the stronger reading wins.
  assert.equal(
    securityMethod({ twoFactorEnabled: true }),
    SECURITY_METHODS.AUTHENTICATOR,
  );
});

test('twoFactorMethod is ignored while 2FA is off', () => {
  // The field is documented as meaningless in this state; honouring it would
  // show protection the account does not have.
  assert.equal(
    securityMethod({ passkeyCount: 0, twoFactorEnabled: false, twoFactorMethod: 'authenticator' }),
    SECURITY_METHODS.PASSWORD,
  );
});

test('an account with no second factor says so, instead of implying email codes', () => {
  const factor = securityFactor({ passkeyCount: 0, twoFactorEnabled: false, twoFactorMethod: 'email' });
  assert.equal(factor.method, SECURITY_METHODS.PASSWORD);
  assert.equal(factor.label, 'Password only');
  assert.match(factor.note, /no second factor/i);
});

test('a non-numeric or absent count never counts as a passkey', () => {
  // countDocuments returns a Number, but a Mongo aggregation can hand back a
  // Long and a hand-built payload can be anything. None of these may promote an
  // account to "passkey" — a false positive here claims protection that is not
  // there.
  for (const passkeyCount of [undefined, null, 0, '0', '', NaN, 'many', {}, [], -1]) {
    assert.equal(
      securityMethod({ passkeyCount, twoFactorEnabled: true, twoFactorMethod: 'authenticator' }),
      SECURITY_METHODS.AUTHENTICATOR,
      `passkeyCount ${JSON.stringify(passkeyCount)} must not read as a passkey`,
    );
  }
});

test('the passkey count is pluralised and counted from the real rows', () => {
  assert.equal(securityFactor({ passkeyCount: 1 }).label, '1 passkey active');
  assert.equal(securityFactor({ passkeyCount: 3 }).label, '3 passkeys active');
  assert.equal(securityFactor({ passkeyCount: 3 }).passkeyCount, 3);
});

test('a server-resolved label wins, but cannot disagree with the count', () => {
  // The server computes this from the database and is authoritative. The count
  // still comes from the row, so a payload carrying a stale `security` object
  // cannot render "2 passkeys active" beside a count of 1.
  const factor = securityFactor({
    passkeyCount: 1,
    twoFactorEnabled: false,
    security: { label: '2 passkeys active', method: 'passkey' },
  });
  assert.equal(factor.label, '2 passkeys active', 'the server label is used as-is');
  assert.equal(factor.passkeyCount, 1, 'the row remains the source of the count');
});

test('a partial row derives the same answer as the server does', () => {
  // The stale-cache / older-payload path: no `security` object at all. It must
  // not fall back to the old boolean expression.
  assert.equal(securityFactor({ passkeyCount: 1 }).label, '1 passkey active');
  assert.equal(securityFactor({}).label, 'Password only');
  assert.equal(securityFactor(null).label, 'Password only');
});

test('every method carries a distinct label and a non-empty note', () => {
  const seen = new Set();
  for (const method of Object.values(SECURITY_METHODS)) {
    const factor = securityFactor({
      passkeyCount: method === SECURITY_METHODS.PASSKEY ? 1 : 0,
      twoFactorEnabled: method === SECURITY_METHODS.AUTHENTICATOR || method === SECURITY_METHODS.EMAIL,
      twoFactorMethod: method,
    });
    assert.equal(factor.method, method);
    assert.ok(factor.label.trim(), `${method} needs a label`);
    assert.ok(factor.note.trim(), `${method} needs a note explaining its strength`);
    assert.equal(seen.has(factor.label), false, `label "${factor.label}" is used twice`);
    seen.add(factor.label);
  }
});

// ── Event labels ──────────────────────────────────────────────────────────
//
// Read EVENT_TYPES out of the model's SOURCE rather than importing it: the
// model requires mongoose, which does not resolve from this package.

const securityEventSource = readFileSync(
  join(here, '..', '..', '..', 'server', 'models', 'SecurityEvent.js'),
  'utf8',
);

function serverEventTypes() {
  const block = securityEventSource.match(/const EVENT_TYPES = \[([\s\S]*?)\];/);
  assert.ok(block, 'EVENT_TYPES array not found in server/models/SecurityEvent.js');
  return [...block[1].matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]);
}

test('the model still publishes an EVENT_TYPES list this test can read', () => {
  // Guards the regex above. If the array's shape changes, this fails with a
  // clear message instead of the coverage test below silently passing on an
  // empty list.
  const types = serverEventTypes();
  assert.ok(types.length > 20, `expected a real list, parsed ${types.length}`);
  assert.ok(types.includes('passkey-added'));
  assert.equal(new Set(types).size, types.length, 'EVENT_TYPES contains a duplicate');
});

test('every server event type has a human label', () => {
  // The bug this pins: all six passkey events, plus every TOTP event, fell
  // through to the generic "Security event" fallback — including "a passkey was
  // removed", which is the line a user most wants to read.
  const missing = serverEventTypes().filter((type) => !EVENT_LABELS[type]);
  assert.deepEqual(missing, [], 'these event types render as generic "Security event"');
});

test('no label is defined for an event type the server does not emit', () => {
  // The other direction: a stale label is dead code that will mislead the next
  // person who renames a type.
  const known = new Set(serverEventTypes());
  const orphans = Object.keys(EVENT_LABELS).filter((type) => !known.has(type));
  assert.deepEqual(orphans, [], 'these labels have no matching EVENT_TYPES entry');
});

test('an unknown event still renders something', () => {
  // An event recorded by an older server, or one this build has never heard of,
  // must not blank the row or print the raw enum string.
  assert.equal(eventLabel('event-from-the-future'), 'Security event');
  assert.equal(eventLabel(undefined), 'Security event');
  assert.equal(eventLabel('passkey-used'), 'Passkey used to sign in');
});

test('every NOTABLE entry is a real event type', () => {
  const known = new Set(serverEventTypes());
  const unknown = [...NOTABLE].filter((type) => !known.has(type));
  assert.deepEqual(unknown, [], 'these are highlighted but can never occur');
});

test('every failure is flagged notable', () => {
  // By construction: a failure is the signal. Missing one means a rejected
  // attempt renders in the same calm grey as a routine sign-in.
  const failures = serverEventTypes().filter((type) => /failed$|-failure$/.test(type));
  assert.ok(failures.length > 0, 'no failure-shaped types found — the filter is stale');
  for (const type of failures) {
    assert.ok(NOTABLE.has(type), `${type} is a failure and must be notable`);
  }
});

test('credential changes are flagged notable', () => {
  // Adding, renaming or removing a passkey changes who can get in.
  for (const type of ['passkey-added', 'passkey-renamed', 'passkey-removed']) {
    assert.ok(NOTABLE.has(type), `${type} must be notable`);
  }
});
