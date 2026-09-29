'use strict';
/**
 * The support-chat state machine, tested directly.
 *
 * This is the module both routers import, and it is the only place the
 * resolved-lock rule lives. The e2e suite (support-chat.e2e.js) proves the rule
 * holds over HTTP; these tests pin the rule at its source, so a change that
 * breaks the lock fails here in milliseconds without a database, a server and
 * two signed tokens.
 *
 * The property under test, in one line: a resolved thread is read-only for
 * BOTH sides, and only an administrator can change that.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ChatStateError,
  RESOLVED_LOCK_MESSAGE,
  isThreadResolved,
  assertThreadWritable,
  statusAfterMessage,
  statusAfterReopen,
  normalizeStatus,
} = require('../utils/supportChat');

// ── The lock ──────────────────────────────────────────────────────────────

test('a resolved thread is recognised as resolved', () => {
  assert.equal(isThreadResolved({ status: 'resolved' }), true);
});

test('an open or pending thread is not resolved', () => {
  assert.equal(isThreadResolved({ status: 'open' }), false);
  assert.equal(isThreadResolved({ status: 'pending' }), false);
});

test('a thread with no status is not treated as resolved', () => {
  // Fail OPEN here. A missing field must never read as "closed", or a schema
  // default that failed to apply would silently lock every new thread.
  assert.equal(isThreadResolved({}), false);
  assert.equal(isThreadResolved(null), false);
  assert.equal(isThreadResolved(undefined), false);
});

test('the lock refuses a resolved thread with a 409', () => {
  assert.throws(
    () => assertThreadWritable({ status: 'resolved' }),
    (error) => {
      assert.ok(error instanceof ChatStateError);
      assert.equal(error.status, 409);
      assert.equal(error.message, RESOLVED_LOCK_MESSAGE);
      return true;
    },
  );
});

test('the lock lets an open, pending or unset thread through', () => {
  for (const status of ['open', 'pending', undefined, null, '', 'nonsense']) {
    assert.equal(assertThreadWritable({ status }), undefined, `status=${status}`);
  }
});

test('one message tells both sides the same thing', () => {
  // The member and the admin are told different words in the UI, but the API
  // contract is a single string, so the two routers cannot drift.
  assert.equal(typeof RESOLVED_LOCK_MESSAGE, 'string');
  assert.ok(RESOLVED_LOCK_MESSAGE.length > 20);
});

// ── Transitions ───────────────────────────────────────────────────────────

test('a message always points the ball at the other side', () => {
  assert.equal(statusAfterMessage('user'), 'open');       // waiting on us
  assert.equal(statusAfterMessage('admin'), 'pending');   // waiting on them
});

test('a message can no longer produce a resolved thread', () => {
  // The old bug this guards: a reply silently un-resolved the thread, so
  // "resolved" was a state a message could undo.
  assert.notEqual(statusAfterMessage('user'), 'resolved');
  assert.notEqual(statusAfterMessage('admin'), 'resolved');
});

test('reopening puts the thread back in the working queue', () => {
  // An admin reopens because they have more to say, so it is waiting on US —
  // not 'pending', which would claim the member owes a reply they were never
  // asked for.
  assert.equal(statusAfterReopen(), 'open');
});

test('reopening agrees with the lock', () => {
  // Whatever reopen returns must be a state the lock permits, or reopening
  // would leave the thread still closed and the admin unable to reply — the
  // exact "reopen does nothing" bug the lock would otherwise hide.
  const reopened = statusAfterReopen();
  assert.doesNotThrow(() => assertThreadWritable({ status: reopened }));
});

// ── Status normalisation ───────────────────────────────────────────────────

test('normalizeStatus accepts the known states and defaults the rest to open', () => {
  assert.equal(normalizeStatus('resolved'), 'resolved');
  assert.equal(normalizeStatus('  RESOLVED '), 'resolved');
  assert.equal(normalizeStatus('pending'), 'pending');
  // Anything unrecognised is 'open' — never 'resolved'. Defaulting to the
  // locked state would let a bad value close a thread nobody asked to close.
  for (const value of ['', null, undefined, 'closed', 'archived', 'banana']) {
    assert.equal(normalizeStatus(value), 'open', `value=${value}`);
  }
});
