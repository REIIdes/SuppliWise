/**
 * The OTP countdown must agree with the server, not merely look like a clock.
 *
 * WHAT THIS LOCKS DOWN
 * --------------------
 * The countdown was an accumulating counter (`setState(prev => prev - 1)` on a
 * 1s interval). That shape drifts from real time, stacks when its interval is
 * cleared from a stale closure, and freezes when an unrelated effect tears it
 * down — which is exactly how a user ends up looking at "4:12 remaining" over a
 * code the server already expired.
 *
 * The deadline-based replacement fixes all three because every value is derived
 * from `Date.now()` and is therefore idempotent: the same deadline and the same
 * instant always give the same answer, however many times it is computed and
 * however many intervals exist.
 *
 * These tests pin the properties that make that true.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeadline,
  secondsLeft,
  isExpired,
  formatCountdown,
  ttlFromResponse,
  OTP_TTL_SECONDS,
} from './otpCountdown.js';

const T0 = 1_700_000_000_000; // a fixed instant, so nothing depends on real time

// ── The window ─────────────────────────────────────────────────────────────

test('the default window is five minutes', () => {
  assert.equal(OTP_TTL_SECONDS, 300);
});

test('a deadline is the window measured from the clock', () => {
  assert.equal(createDeadline(300, T0), T0 + 300_000);
});

test('the server response wins over the built-in default', () => {
  // The whole point of publishing `expiresInSeconds`: the client renders the
  // number the server will enforce rather than its own copy of it.
  assert.equal(ttlFromResponse({ expiresInSeconds: 120 }), 120);
  assert.equal(ttlFromResponse({ expiresInSeconds: 600 }), 600);
});

test('a missing or nonsensical response falls back to the default', () => {
  // Each of these would otherwise produce a deadline of "now" — a countdown that
  // is already over the moment the modal opens.
  for (const body of [{}, { expiresInSeconds: 0 }, { expiresInSeconds: -5 }, { expiresInSeconds: null }, { expiresInSeconds: 'soon' }, null, undefined]) {
    assert.equal(ttlFromResponse(body), OTP_TTL_SECONDS, `bad fallback for ${JSON.stringify(body)}`);
  }
});

// ── Remaining time ─────────────────────────────────────────────────────────

test('remaining time is measured from the wall clock', () => {
  const deadline = createDeadline(300, T0);
  assert.equal(secondsLeft(deadline, T0), 300);
  assert.equal(secondsLeft(deadline, T0 + 1000), 299);
  assert.equal(secondsLeft(deadline, T0 + 250_000), 50);
});

test('the final second displays as 1, not 0', () => {
  // A countdown that reads 0:00 while the code is still accepted is one nobody
  // trusts, and it makes the submit button look disabled for a live code.
  const deadline = createDeadline(300, T0);
  assert.equal(secondsLeft(deadline, T0 + 299_000), 1);
  assert.equal(secondsLeft(deadline, T0 + 299_999), 1);
  assert.equal(secondsLeft(deadline, T0 + 300_000), 0);
});

test('remaining time never goes negative', () => {
  const deadline = createDeadline(300, T0);
  assert.equal(secondsLeft(deadline, T0 + 10_000_000), 0);
  assert.equal(secondsLeft(deadline, T0 + 10_000_000), 0);
});

test('a missing deadline reads as expired rather than throwing', () => {
  for (const bad of [0, null, undefined, NaN, 'soon', {}]) {
    assert.equal(secondsLeft(bad, T0), 0, `bad handling for ${String(bad)}`);
    assert.equal(isExpired(bad, T0), true);
  }
});

// ── The properties that make the fix work ──────────────────────────────────

test('repeated reads are idempotent — this is what stops drift', () => {
  // The bug being fixed: a counter decremented per tick loses time whenever a
  // tick is delayed or dropped. Reading the same deadline twice must give the
  // same answer no matter how many times it is read.
  const deadline = createDeadline(300, T0);
  const instant = T0 + 42_000;
  const first = secondsLeft(deadline, instant);
  for (let i = 0; i < 1000; i += 1) {
    assert.equal(secondsLeft(deadline, instant), first, `read ${i} disagreed with the first`);
  }
});

test('a long gap between ticks self-corrects instead of drifting', () => {
  // Simulates a backgrounded tab: browsers clamp setInterval to roughly once a
  // minute, so a throttled interval fires far less often than once a second.
  // A counter would show ~295s remaining after five real minutes; a deadline
  // shows the truth, which is that the code has expired.
  const deadline = createDeadline(300, T0);

  // One tick at the start.
  assert.equal(secondsLeft(deadline, T0), 300);

  // ...and then nothing for five minutes, because the tab was backgrounded.
  assert.equal(secondsLeft(deadline, T0 + 300_000), 0);
  assert.equal(isExpired(deadline, T0 + 300_000), true);
});

test('extra intervals cannot drain the timer faster', () => {
  // Simulates the stacking bug: two intervals firing against one deadline. With
  // an accumulating counter that is a 2x countdown; with a deadline, the extra
  // interval computes the same value and changes nothing.
  const deadline = createDeadline(300, T0);
  const instant = T0 + 100_000;

  const fromOneInterval = secondsLeft(deadline, instant);
  const fromThreeIntervals = [secondsLeft(deadline, instant), secondsLeft(deadline, instant), secondsLeft(deadline, instant)];

  assert.equal(fromOneInterval, 200);
  assert.deepEqual([...new Set(fromThreeIntervals)], [fromOneInterval]);
});

test('a restarted countdown is measured from the restart, not the original', () => {
  // What a resend does: a NEW deadline replaces the old one, so the old code's
  // remaining time is discarded rather than carried over.
  const first = createDeadline(300, T0);
  const resendInstant = T0 + 120_000;
  const second = createDeadline(300, resendInstant);

  assert.equal(secondsLeft(first, resendInstant), 180, 'the first code had 3 minutes left');
  assert.equal(secondsLeft(second, resendInstant), 300, 'the new code starts a full window');
  assert.ok(secondsLeft(second, resendInstant) > secondsLeft(first, resendInstant));
});

test('a zeroed deadline cannot be revived by a later tick', () => {
  // handleCancel and the modal's Cancel button both zero the deadline, so an
  // in-flight tick cannot resurrect a countdown for a modal already closed.
  const deadlineRef = 0;

  assert.equal(secondsLeft(deadlineRef, T0 + 60_000), 0);
  assert.equal(secondsLeft(deadlineRef, T0 + 600_000), 0);
  assert.equal(isExpired(deadlineRef, T0), true);
});

// ── isExpired ──────────────────────────────────────────────────────────────

test('expiry flips exactly at the deadline', () => {
  const deadline = createDeadline(300, T0);
  assert.equal(isExpired(deadline, T0 + 299_000), false);
  assert.equal(isExpired(deadline, T0 + 299_999), false);
  assert.equal(isExpired(deadline, T0 + 300_000), true);
  assert.equal(isExpired(deadline, T0 + 300_001), true);
});

// ── Formatting ────────────────────────────────────────────────────────────

test('the countdown formats as m:ss', () => {
  assert.equal(formatCountdown(300), '5:00');
  assert.equal(formatCountdown(299), '4:59');
  assert.equal(formatCountdown(65), '1:05');
  assert.equal(formatCountdown(9), '0:09');
  assert.equal(formatCountdown(0), '0:00');
});

test('formatting never produces a negative or malformed clock', () => {
  for (const value of [-1, NaN, null, undefined, 'x']) {
    const rendered = formatCountdown(value);
    assert.match(rendered, /^\d+:\d{2}$/, `malformed for ${String(value)}`);
    assert.ok(!rendered.startsWith('-'), `negative for ${String(value)}`);
  }
});

// ── Alignment with the server ──────────────────────────────────────────────

test('the client window matches the window the server enforces', async () => {
  // Reads the server's constants out of source rather than duplicating them a
  // third time, so a change to the enforced TTL cannot leave the client quietly
  // rendering a different number.
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');

  const authSource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../server/routes/auth.js'),
    'utf8',
  );

  const declared = authSource.match(/const OTP_TTL_MS = (\d+) \* 60 \* 1000;/);
  assert.ok(declared, 'OTP_TTL_MS must still be declared in server/routes/auth.js');

  const serverMinutes = Number(declared[1]);
  assert.equal(
    serverMinutes * 60,
    OTP_TTL_SECONDS,
    `the server enforces ${serverMinutes} minutes but the client renders ${OTP_TTL_SECONDS / 60}`
  );
});