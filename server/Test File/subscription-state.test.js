'use strict';
/**
 * Subscription engine tests — the two-layer model (utils/subscriptionState.js).
 *
 * These cover the behaviour the product spec calls out explicitly:
 *   1. a purchase is normally 1 month / 30 days, tracked exactly;
 *   2. an admin can add/deduct days, extend, make permanent, change plan, remove;
 *   3. an admin edit NEVER destroys the user's paid state;
 *   4. "restore original" returns the EXACT previous expiry (4 days left, not 30);
 *   5. a permanent grant never expires and can be removed explicitly;
 *   6. entitlements resolve from the effective layer with no manual refresh.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../utils/subscriptionState');
const E = require('../utils/entitlements');

const DAY = S.DAY_MS;

/** Build a user-shaped document the way the projection writes one. */
function apply(user, record, action, options, at) {
  const result = S.applyAction(record, action, options, at);
  if (!result.ok) return { ...result, user };
  // Mirror the route: store the record, then project the effective state onto
  // the legacy top-level fields the whole app reads.
  return {
    ...result,
    user: { ...user, subscriptionRecord: result.record, ...result.patch },
    record: result.record,
  };
}

function buy(user, plan, days, at) {
  return apply(user, user.subscriptionRecord, 'setPaid', {
    plan, days: days ?? S.STANDARD_PERIOD_DAYS, actor: 'payment',
  }, at);
}

// ── 1. A purchase is 1 month / 30 days ─────────────────────────────────────
test('a purchase is valid for 30 days and reports 30 days remaining', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const { user } = buy({}, 'annual', undefined, now);
  const state = E.describeSubscription(user, now.getTime());
  assert.equal(state.currentPlan, 'annual');
  assert.equal(state.subscriptionActive, true);
  assert.equal(state.daysRemaining, 30);
  assert.equal(state.subscriptionDuration, '30 days');
  assert.equal(state.subscriptionSource, 'payment');
  assert.equal(state.subscriptionStart, now.toISOString());
  assert.equal(state.subscriptionEnd, new Date(now.getTime() + 30 * DAY).toISOString());
  assert.equal(state.entitlements.priorityAssessment, true);
  assert.equal(state.entitlements.chat, false);
});

test('remaining days count down exactly: 26 days later leaves 4', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const { user } = buy({}, 'annual', undefined, bought);
  const later = new Date(bought.getTime() + 26 * DAY);
  const state = E.describeSubscription(user, later.getTime());
  assert.equal(state.daysRemaining, 4);
  assert.equal(state.subscriptionEnd, new Date(bought.getTime() + 30 * DAY).toISOString());
});

test('an elapsed window expires on its own and falls back to FREE', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const { user } = buy({}, 'annual', undefined, bought);
  const past = new Date(bought.getTime() + 30 * DAY + 1000);
  const state = E.describeSubscription(user, past.getTime());
  assert.equal(state.subscriptionStatus, 'expired');
  assert.equal(state.currentPlan, 'free');
  assert.equal(state.entitlements.priorityAssessment, false);
  assert.equal(state.daysRemaining, null);
});

// ── 2. Admin control over the override layer ────────────────────────────────
test('admin can grant, add days, deduct days, extend, change plan and remove', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  let user = {};
  let r = apply(user, null, 'grant', { plan: 'monthly', days: 10, actor: 'admin:root' }, now);
  assert.equal(r.ok, true);
  assert.equal(r.user.subscriptionPlan, 'monthly');
  assert.equal(r.user.subscriptionSource, 'admin');
  assert.equal(E.describeSubscription(r.user, now.getTime()).daysRemaining, 10);

  r = apply(r.user, r.record, 'addDays', { days: 5, actor: 'admin:root' }, now);
  assert.equal(E.describeSubscription(r.user, now.getTime()).daysRemaining, 15);

  r = apply(r.user, r.record, 'deductDays', { days: 3, actor: 'admin:root' }, now);
  assert.equal(E.describeSubscription(r.user, now.getTime()).daysRemaining, 12);

  const target = new Date(now.getTime() + 40 * DAY).toISOString();
  r = apply(r.user, r.record, 'extend', { expiresAt: target, actor: 'admin:root' }, now);
  assert.equal(r.user.subscriptionExpiresAt.toISOString(), target);
  assert.equal(E.describeSubscription(r.user, now.getTime()).daysRemaining, 40);

  r = apply(r.user, r.record, 'changePlan', { plan: 'custom', actor: 'admin:root' }, now);
  assert.equal(r.user.subscriptionPlan, 'custom');
  assert.equal(E.describeSubscription(r.user, now.getTime()).entitlements.chat, true);

  r = apply(r.user, r.record, 'remove', { actor: 'admin:root' }, now);
  assert.equal(r.user.subscriptionPlan, 'free');
  assert.equal(E.describeSubscription(r.user, now.getTime()).currentPlan, 'free');
  assert.equal(E.describeSubscription(r.user, now.getTime()).entitlements.chat, false);
});

test('a permanent admin grant never expires and is removed only on request', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  let r = apply({}, null, 'grant', { plan: 'custom', permanent: true, actor: 'admin:root' }, now);
  assert.equal(r.ok, true);
  assert.equal(r.user.subscriptionPermanent, true);
  assert.equal(r.user.subscriptionExpiresAt, null);
  assert.equal(r.user.subscriptionSource, 'admin');

  // Ten years later it is still live.
  const later = new Date(now.getTime() + 3650 * DAY);
  const state = E.describeSubscription(r.user, later.getTime());
  assert.equal(state.currentPlan, 'custom');
  assert.equal(state.subscriptionPermanent, true);
  assert.equal(state.subscriptionDuration, 'PERMANENT');
  assert.equal(state.daysRemaining, null);
  assert.equal(state.entitlements.chat, true);

  r = apply(r.user, r.record, 'remove', { actor: 'admin:root' }, later);
  assert.equal(E.describeSubscription(r.user, later.getTime()).currentPlan, 'free');
});

test('day arithmetic is rejected on a permanent grant with a clear message', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const granted = apply({}, null, 'grant', { plan: 'annual', permanent: true, actor: 'a' }, now);
  const r = apply(granted.user, granted.record, 'addDays', { days: 5, actor: 'a' }, now);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /permanent/i);
});

test('deducting more days than remain ends the subscription instead of going negative', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  let r = apply({}, null, 'grant', { plan: 'monthly', days: 5, actor: 'a' }, now);
  r = apply(r.user, r.record, 'deductDays', { days: 40, actor: 'a' }, now);
  const state = E.describeSubscription(r.user, now.getTime());
  assert.equal(state.currentPlan, 'free');
  assert.equal(state.subscriptionStatus, 'expired');
});

test('a grant must name a real paid plan and a real duration', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  assert.equal(apply({}, null, 'grant', { plan: 'platinum', days: 5 }, now).ok, false);
  assert.equal(apply({}, null, 'grant', { plan: 'free', days: 5 }, now).ok, false);
  assert.equal(apply({}, null, 'grant', { plan: 'annual', days: 0 }, now).ok, false);
  // No `days` at all falls back to the standard 1-month period.
  assert.equal(apply({}, null, 'grant', { plan: 'annual' }, now).ok, true);
  assert.equal(apply({}, null, 'nonsense', {}, now).ok, false);
});

test('adjusting a subscription that is not in force is refused, not silently faked', () => {
  // Regression: `addDays` on a FREE account used to create a pointless override
  // with plan 'free' and answer 200 "Days added", so the admin saw a success
  // message while nothing whatsoever changed.
  const now = new Date('2026-03-01T12:00:00.000Z');
  for (const [action, payload] of [
    ['addDays', { days: 5 }],
    ['deductDays', { days: 5 }],
    ['extend', { expiresAt: new Date(now.getTime() + 30 * DAY).toISOString() }],
    ['permanent', {}],
    ['changePlan', { plan: 'annual' }],
  ]) {
    const r = apply({}, null, action, payload, now);
    assert.equal(r.ok, false, `${action} on a free account must be refused`);
    assert.equal(r.status, 400);
    assert.match(r.error, /no active subscription/i, action);
  }
  // The same actions DO work once something is in force.
  const granted = apply({}, null, 'grant', { plan: 'annual', days: 10 }, now);
  for (const [action, payload] of [
    ['addDays', { days: 5 }],
    ['deductDays', { days: 5 }],
    ['extend', { expiresAt: new Date(now.getTime() + 40 * DAY).toISOString() }],
    ['permanent', {}],
    ['changePlan', { plan: 'custom' }],
  ]) {
    const r = apply(granted.user, granted.record, action, payload, now);
    assert.equal(r.ok, true, `${action} on an active subscription must work`);
  }
});

test('an expired paid window cannot be adjusted — it must be granted again', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const longAfter = new Date(bought.getTime() + 90 * DAY);
  const paid = buy({}, 'annual', undefined, bought);
  const r = apply(paid.user, paid.record, 'addDays', { days: 5 }, longAfter);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

// ── 3 + 4. The paid state survives an admin edit, and restores exactly ──────
test('an admin edit never destroys the paid state, and restore returns 4 days not 30', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const afterDays = new Date(bought.getTime() + 26 * DAY); // 4 days remaining
  const paid = buy({}, 'annual', undefined, bought);

  const before = E.describeSubscription(paid.user, afterDays.getTime());
  assert.equal(before.daysRemaining, 4);
  assert.equal(before.subscriptionSource, 'payment');
  const originalExpiry = before.subscriptionEnd;

  // Admin adds 6 days.
  const bumped = apply(paid.user, paid.record, 'addDays', { days: 6, actor: 'admin:root' }, afterDays);
  const during = E.describeSubscription(bumped.user, afterDays.getTime());
  assert.equal(during.daysRemaining, 10);
  assert.equal(during.currentPlan, 'annual');
  assert.equal(during.subscriptionSource, 'admin');

  // The paid layer is untouched underneath, and remembers the 4 days.
  const detail = S.describeRecord(bumped.user, afterDays.getTime());
  assert.equal(detail.paid.plan, 'annual');
  assert.equal(detail.paid.expiresAt, originalExpiry);
  assert.equal(detail.paid.daysRemaining, 4);
  assert.equal(detail.override.active, true);
  assert.equal(detail.canRestore, true);
  assert.equal(detail.restoreTarget.capturedDaysRemaining, 4);
  assert.equal(detail.restoreTarget.expiresAt, originalExpiry);

  // Restore returns to the exact previous state.
  const restored = apply(bumped.user, bumped.record, 'restore', { actor: 'admin:root' }, afterDays);
  const after = E.describeSubscription(restored.user, afterDays.getTime());
  assert.equal(after.daysRemaining, 4, 'must come back as 4 days, not a fresh 30');
  assert.equal(after.subscriptionEnd, originalExpiry);
  assert.equal(after.subscriptionSource, 'payment');
  assert.equal(after.currentPlan, 'annual');
  assert.equal(restored.user.subscriptionPermanent, false);
  assert.equal(S.describeRecord(restored.user, afterDays.getTime()).override.active, false);
});

test('restoring a paid subscription that had already expired keeps it expired', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const longAfter = new Date(bought.getTime() + 200 * DAY);
  const paid = buy({}, 'annual', undefined, bought);

  const granted = apply(paid.user, paid.record, 'grant', { plan: 'custom', permanent: true, actor: 'a' }, longAfter);
  assert.equal(E.describeSubscription(granted.user, longAfter.getTime()).currentPlan, 'custom');

  const restored = apply(granted.user, granted.record, 'restore', { actor: 'a' }, longAfter);
  const state = E.describeSubscription(restored.user, longAfter.getTime());
  assert.equal(state.currentPlan, 'free', 'the paid window elapsed while overridden');
  assert.equal(state.subscriptionStatus, 'expired');
  assert.equal(state.subscriptionSource, 'free');
});

test('restore with nothing to restore is a 400, not a silent no-op', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const r = apply({}, null, 'restore', { actor: 'a' }, now);
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('a first "add days" on a paid subscription is an override, not a rewrite of it', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = buy({}, 'annual', 30, now);
  const bumped = apply(paid.user, paid.record, 'addDays', { days: 6, actor: 'admin:root' }, now);
  const detail = S.describeRecord(bumped.user, now.getTime());
  assert.equal(detail.override.active, true, 'the admin edit must be layered, not written into paid');
  assert.equal(detail.override.daysRemaining, 36);
  assert.equal(detail.paid.daysRemaining, 30, 'the paid window is untouched');
  assert.equal(detail.effective.source, 'admin');
  assert.equal(detail.canRestore, true);
  assert.equal(detail.restoreTarget.capturedDaysRemaining, 30);
});

test('a permanent override over a paid plan restores the paid expiry afterwards', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = buy({}, 'annual', 30, now);
  const madePermanent = apply(paid.user, paid.record, 'permanent', { actor: 'admin:root' }, now);
  const state = E.describeSubscription(madePermanent.user, now.getTime());
  assert.equal(state.subscriptionPermanent, true);
  assert.equal(state.subscriptionEnd, null, 'no end date while permanent');
  assert.equal(state.subscriptionSource, 'admin');
  assert.equal(S.describeRecord(madePermanent.user, now.getTime()).paid.daysRemaining, 30);

  const restored = apply(madePermanent.user, madePermanent.record, 'restore', { actor: 'admin:root' }, now);
  const back = E.describeSubscription(restored.user, now.getTime());
  assert.equal(back.subscriptionPermanent, false);
  assert.equal(back.daysRemaining, 30, 'the original 30-day window is back, not a fresh one');
  assert.equal(back.subscriptionSource, 'payment');
});

test('day arithmetic continues from the remaining paid time, not from today', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const later = new Date(bought.getTime() + 26 * DAY); // 4 days left
  const paid = buy({}, 'annual', undefined, bought);
  const bumped = apply(paid.user, paid.record, 'addDays', { days: 6, actor: 'admin:root' }, later);
  const state = E.describeSubscription(bumped.user, later.getTime());
  assert.equal(state.daysRemaining, 10, '4 remaining + 6 added');
  assert.equal(state.currentPlan, 'annual');
  assert.equal(state.subscriptionSource, 'admin');
  const detail = S.describeRecord(bumped.user, later.getTime());
  assert.equal(detail.paid.daysRemaining, 4);
  assert.equal(detail.canRestore, true);
  assert.equal(detail.restoreTarget.capturedDaysRemaining, 4);
  assert.equal(detail.restoreTarget.expiresAt, new Date(bought.getTime() + 30 * DAY).toISOString());

  const restored = apply(bumped.user, bumped.record, 'restore', { actor: 'admin:root' }, later);
  const back = E.describeSubscription(restored.user, later.getTime());
  assert.equal(back.daysRemaining, 4, 'restore returns 4 days, not a fresh 30');
  assert.equal(back.subscriptionEnd, new Date(bought.getTime() + 30 * DAY).toISOString());
  assert.equal(back.subscriptionSource, 'payment');
});

test('changePlan is refused on an open-ended window instead of granting permanence', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const granted = apply({}, null, 'grant', { plan: 'annual', permanent: true, actor: 'a' }, now);
  const r = apply(granted.user, granted.record, 'changePlan', { plan: 'custom', actor: 'a' }, now);
  assert.equal(r.ok, true, 'a permanent window may be re-tiered freely');

  const paid = buy({}, 'annual', 30, now);
  const open = S.applyAction(paid.record, 'extend', { expiresAt: new Date(now.getTime() + 30 * DAY) }, now);
  const r2 = apply(paid.user, open.record, 'clearOverride', { actor: 'a' }, now);
  assert.equal(r2.ok, true);
});

test('clearOverride drops only the admin layer and returns the paid state', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = buy({}, 'monthly', 20, now);
  const granted = apply(paid.user, paid.record, 'grant', { plan: 'custom', permanent: true, actor: 'a' }, now);
  const cleared = apply(granted.user, granted.record, 'clearOverride', { actor: 'a' }, now);
  const state = E.describeSubscription(cleared.user, now.getTime());
  assert.equal(state.currentPlan, 'monthly');
  assert.equal(state.daysRemaining, 20);
  assert.equal(state.subscriptionSource, 'payment');
});

test('remove (scope=all) cancels the paid subscription itself', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = buy({}, 'annual', 30, now);
  const removed = apply(paid.user, paid.record, 'remove', { actor: 'a' }, now);
  const state = E.describeSubscription(removed.user, now.getTime());
  assert.equal(state.currentPlan, 'free');
  assert.equal(S.describeRecord(removed.user, now.getTime()).paid.plan, 'free');
  assert.equal(S.describeRecord(removed.user, now.getTime()).paid.status, 'none');
});

test('an admin can remove ONLY the override, keeping the paid subscription', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = buy({}, 'monthly', 12, now);
  const granted = apply(paid.user, paid.record, 'grant', { plan: 'custom', days: 5, actor: 'a' }, now);
  const removed = apply(granted.user, granted.record, 'remove', { scope: 'override', actor: 'a' }, now);
  const state = E.describeSubscription(removed.user, now.getTime());
  assert.equal(state.currentPlan, 'monthly');
  assert.equal(state.daysRemaining, 12);
});

test('a purchase during an override re-freezes the restore target', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = buy({}, 'monthly', 10, now);
  const granted = apply(paid.user, paid.record, 'grant', { plan: 'custom', permanent: true, actor: 'a' }, now);
  // The customer renews DELUXE while the admin override is still in force. The
  // renewal runs from the end of the paid window (10 + 30 = 40 days).
  const renewed = buy(granted.user, 'monthly', 30, now);
  const detail = S.describeRecord(renewed.user, now.getTime());
  assert.equal(detail.override.active, true, 'the admin layer is still on top');
  assert.equal(detail.paid.plan, 'monthly');
  assert.equal(detail.paid.daysRemaining, 40, 'the renewal is recorded on the paid layer');
  assert.equal(
    detail.restoreTarget.capturedDaysRemaining,
    40,
    'restore target follows the renewed paid state, not the pre-renewal one',
  );

  const restored = apply(renewed.user, renewed.record, 'restore', { actor: 'a' }, now);
  const state = E.describeSubscription(restored.user, now.getTime());
  assert.equal(state.currentPlan, 'monthly');
  assert.equal(state.daysRemaining, 40);
});

test('a renewal extends from the end of the current window, never truncating it', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const halfway = new Date(bought.getTime() + 20 * DAY); // 10 days left
  const paid = buy({}, 'annual', undefined, bought);
  const renewed = buy(paid.user, 'annual', 30, halfway);
  const state = E.describeSubscription(renewed.user, halfway.getTime());
  assert.equal(state.daysRemaining, 40, '10 remaining + 30 renewed');
});

// ── 5. History ──────────────────────────────────────────────────────────────
test('history records every admin change with from/to state, newest first', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = buy({}, 'monthly', 30, now);
  let r = { record: paid.record, user: paid.user };
  r = apply(r.user, r.record, 'grant', { plan: 'custom', days: 7, actor: 'admin:root', note: 'goodwill' }, now);
  r = apply(r.user, r.record, 'addDays', { days: 3, actor: 'admin:zoe' }, now);
  r = apply(r.user, r.record, 'permanent', { actor: 'admin:root' }, now);

  const { history } = S.describeRecord(r.user, now.getTime());
  const actions = history.map((h) => h.action);
  assert.ok(actions.includes('grant'));
  assert.ok(actions.includes('addDays'));
  assert.ok(actions.includes('permanent'));
  assert.equal(actions[0], 'permanent', 'newest first');

  const grant = history.find((h) => h.action === 'grant');
  assert.equal(grant.actor, 'admin:root');
  assert.equal(grant.note, 'goodwill');
  assert.equal(grant.from.plan, 'monthly');
  assert.equal(grant.to.plan, 'custom');
  assert.ok(grant.from.expiresAt && grant.to.expiresAt);

  const add = history.find((h) => h.action === 'addDays');
  assert.match(add.note, /Added 3 days/);
});

test('history is capped so it cannot grow without bound', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  let r = apply({}, null, 'grant', { plan: 'annual', days: 30, actor: 'a' }, now);
  for (let i = 0; i < 70; i += 1) {
    r = apply(r.user, r.record, 'addDays', { days: 1, actor: 'a' }, now);
  }
  const { history } = S.describeRecord(r.user, now.getTime());
  assert.ok(history.length <= 40, `expected a cap, got ${history.length}`);
  assert.equal(history[0].action, 'addDays');
});

// ── 6. Immediate feature access (no manual refresh) ────────────────────────
test('every admin action changes entitlements immediately', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const steps = [
    [{ plan: 'monthly', days: 30 }, (s) => s.entitlements.insights === true && s.entitlements.chat === false],
    [{ plan: 'annual', days: 30 }, (s) => s.entitlements.priorityAssessment === true && s.entitlements.chat === false],
    [{ plan: 'custom', days: 30 }, (s) => s.entitlements.chat === true],
  ];
  let r = apply({}, null, 'grant', steps[0][0], now);
  assert.equal(steps[0][1](E.describeSubscription(r.user, now.getTime())), true);
  for (const [options, check] of steps.slice(1)) {
    r = apply(r.user, r.record, 'grant', options, now);
    assert.equal(check(E.describeSubscription(r.user, now.getTime())), true);
  }
  // The version signature moves on every change, so SSE clients re-render.
  const versions = new Set();
  let v = apply({}, null, 'grant', { plan: 'monthly', days: 30 }, now);
  versions.add(E.describeSubscription(v.user, now.getTime()).version);
  v = apply(v.user, v.record, 'addDays', { days: 1 }, now);
  versions.add(E.describeSubscription(v.user, now.getTime()).version);
  v = apply(v.user, v.record, 'permanent', {}, now);
  versions.add(E.describeSubscription(v.user, now.getTime()).version);
  v = apply(v.user, v.record, 'restore', {}, now);
  versions.add(E.describeSubscription(v.user, now.getTime()).version);
  assert.equal(versions.size, 4, 'each change must produce a distinct version');
});

// ── 6b. Team seats ─────────────────────────────────────────────────────────
// Team is the Premium tier with a seat count. The count is BILLING metadata:
// it never changes what is unlocked, an admin action never changes it, and
// "restore original" brings it back.

test('a Team purchase is the Premium tier with a seat count, unlocking the same features', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  // What the purchase route does for plan "team": the tier a seat grants, plus
  // the seat count. There is no `team` plan id anywhere in the system.
  const r = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', seats: 5 }, now);
  assert.equal(r.ok, true);
  assert.equal(r.patch.subscriptionPlan, 'annual', 'Team writes the Premium tier');
  assert.equal(r.patch.subscriptionSeats, 5);
  assert.equal(r.patch.subscriptionActive, true);

  const detail = S.describeRecord({ subscriptionRecord: r.record, ...r.patch }, now.getTime());
  assert.equal(detail.effective.seats, 5);
  assert.equal(detail.effective.isTeam, true);
  assert.equal(detail.paid.seats, 5);
  // A seat unlocks exactly what Premium unlocks — nothing less, nothing more.
  const state = E.describeSubscription({ subscriptionRecord: r.record, ...r.patch }, now.getTime());
  assert.equal(state.currentPlan, 'annual');
  assert.equal(state.entitlements.priorityAssessment, true);
  assert.equal(state.entitlements.historyFull, true);
  assert.equal(state.entitlements.chat, false, 'Team is Premium, not Ultimate');
  assert.equal(state.subscriptionSeats, 5);
  assert.equal(state.subscriptionIsTeam, true);
});

test('an individual plan is one seat, and buying one drops a Team subscription', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  let r = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', seats: 20 }, now);
  assert.equal(r.patch.subscriptionSeats, 20);

  // Buying Deluxe with no seat count resets to one. Without this, a customer
  // could pay for a single seat and keep twenty.
  r = apply(r.user, r.record, 'setPaid', { actor: 'payment', plan: 'monthly', days: 30 }, now);
  assert.equal(r.patch.subscriptionSeats, 1);
  const detail = S.describeRecord({ subscriptionRecord: r.record, ...r.patch }, now.getTime());
  assert.equal(detail.effective.seats, 1);
  assert.equal(detail.effective.isTeam, false);
});

test('a seat count a customer chose is refused, never silently changed', () => {
  // The engine is the last line before a seat count is stored AND priced, so it
  // is the one that must be strict. Clamping here would mean a request for
  // 9999 seats becomes 500 — an invoice the customer never agreed to — and a
  // request for 0 becomes 1, which silently creates a Team order from a
  // blank field. A visible refusal beats a quiet coercion.
  const now = new Date('2026-03-01T12:00:00.000Z');
  const cases = [
    [99999, 'over the ceiling'],
    [S.MAX_SEATS + 1, 'one seat over'],
    [0, 'zero'],
    [-9, 'negative'],
    [2.5, 'a fraction of a seat'],
    ['4.4', 'a fractional string'],
    ['abc', 'no number at all'],
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
  ];
  for (const [value, why] of cases) {
    const r = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', seats: value }, now);
    assert.equal(r.ok, false, `seats=${value} (${why}) must be refused`);
    assert.equal(r.status, 400);
    assert.equal(r.patch, undefined, 'a refused action writes nothing');
  }
  // The boundary values themselves are accepted.
  for (const value of [1, 2, S.MAX_SEATS, '12']) {
    const r = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', seats: value }, now);
    assert.equal(r.ok, true, `seats=${value} must be accepted`);
    assert.equal(r.patch.subscriptionSeats, Number(value));
  }
  // Omitting seats entirely is the individual-plan default, not a refusal.
  const plain = apply({}, null, 'setPaid', { actor: 'payment', plan: 'monthly' }, now);
  assert.equal(plain.ok, true);
  assert.equal(plain.patch.subscriptionSeats, 1);
});

test('reading a stored seat count still clamps, so an old record stays usable', () => {
  // The mirror image of the rule above, and the reason the two functions exist
  // separately: normalizeSeats is for values read back out of storage, where a
  // record written under an older ceiling must still resolve to something
  // usable rather than becoming unreadable. Refusing it would strand the
  // account; refusing a customer's live order would overcharge or undercharge.
  const now = new Date('2026-03-01T12:00:00.000Z');
  assert.equal(S.normalizeSeats(99999), S.MAX_SEATS, 'stored values clamp');
  assert.equal(S.normalizeSeats(0), 1, 'a stored zero is not a valid plan, so it reads as one seat');
  assert.equal(S.normalizeSeats(-9), 1);
  assert.equal(S.normalizeSeats(2.6), 3, 'and rounds to a whole seat');
  assert.equal(S.normalizeSeats('abc'), null, 'but an unparseable value is still refused');

  // A record persisted with an out-of-range count still reads back sanely.
  const legacy = S.readRecord({
    subscriptionRecord: { paid: { plan: 'annual', status: 'active', seats: 9999 } },
  });
  assert.equal(legacy.paid.seats, S.MAX_SEATS);

  // And parseSeatCount is the strict one, for live customer input.
  assert.equal(S.parseSeatCount(99999), null);
  assert.equal(S.parseSeatCount(0), null);
  assert.equal(S.parseSeatCount(2.5), null);
  assert.equal(S.parseSeatCount(3), 3);
});

test('editing the seat count does not grant a month of access', () => {
  // THE REGRESSION THIS GUARDS: `setPaid` used to default to a fresh 30-day
  // window whenever no term was given, so an admin changing 6 seats to 12
  // silently handed the customer 30 more days. A seat count is an edit to the
  // subscription that exists, not a purchase.
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const midway = new Date(bought.getTime() + 10 * DAY);
  const started = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30, seats: 6 }, bought);
  const before = S.describeRecord(started.user, midway.getTime());
  assert.equal(before.paid.daysRemaining, 20, '20 days left on the paid window');

  const edited = apply(started.user, started.record, 'setPaid', { actor: 'admin:Devs', plan: 'annual', seats: 12 }, midway);
  assert.equal(edited.ok, true);
  const after = S.describeRecord(edited.user, midway.getTime());
  assert.equal(after.paid.seats, 12, 'the seat count changed');
  assert.equal(after.paid.daysRemaining, 20, 'the window is UNCHANGED');
  assert.equal(
    after.paid.expiresAt, before.paid.expiresAt,
    'the very same expiry date, not a new one',
  );
  // The stored period must still describe the window that is on the clock, or
  // the UI would render "0-day plan" against a 20-day subscription.
  assert.equal(after.paid.periodDays, 30, 'the period still describes the real window');
});

test('a reactivating setPaid with no term keeps whatever window exists', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const later = new Date(bought.getTime() + 60 * DAY);
  const started = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, bought);
  const lapsed = S.describeRecord(started.user, later.getTime());
  assert.equal(lapsed.effective.active, false, 'it has lapsed');

  // Re-sending the same plan with no term must NOT invent 30 fresh days for a
  // window that ended weeks ago.
  const revived = apply(started.user, started.record, 'setPaid', { actor: 'admin:Devs', plan: 'annual' }, later);
  const after = S.describeRecord(revived.user, later.getTime());
  assert.equal(after.effective.active, false, 'a lapsed window is not resurrected by a no-op setPaid');
  assert.equal(after.paid.daysRemaining, 0, 'and it grants no days');
});

test('an explicit term still wins, and still renews from the current window', () => {
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const midway = new Date(bought.getTime() + 10 * DAY);
  const started = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, bought);

  // days given → a real renewal: 20 unspent + 30 new.
  const renewed = apply(started.user, started.record, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, midway);
  assert.equal(S.describeRecord(renewed.user, midway.getTime()).paid.daysRemaining, 50);

  // expiresAt given → that exact date, overriding the window.
  const target = new Date(midway.getTime() + 7 * DAY);
  const pinned = apply(renewed.user, renewed.record, 'setPaid', {
    actor: 'admin:Devs', plan: 'annual', expiresAt: target.toISOString(),
  }, midway);
  const afterPin = S.describeRecord(pinned.user, midway.getTime());
  assert.equal(afterPin.paid.expiresAt, target.toISOString(), 'the explicit date is used verbatim');
  assert.equal(afterPin.paid.daysRemaining, 7);

  // permanent given → no expiry at all.
  const forever = apply(pinned.user, pinned.record, 'setPaid', { actor: 'admin:Devs', plan: 'annual', permanent: true }, midway);
  const afterForever = S.describeRecord(forever.user, midway.getTime());
  assert.equal(afterForever.paid.permanent, true);
  assert.equal(afterForever.paid.expiresAt, null);
});

test('a first-time purchase with no term still gets the standard month', () => {
  // The keep-the-window rule must not leave a brand new account with no expiry.
  const now = new Date('2026-03-01T12:00:00.000Z');
  const first = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual' }, now);
  assert.equal(first.ok, true);
  const detail = S.describeRecord(first.user, now.getTime());
  assert.equal(detail.paid.daysRemaining, S.STANDARD_PERIOD_DAYS);
  assert.equal(detail.paid.periodDays, S.STANDARD_PERIOD_DAYS);
});

test('an expired Team subscription stops reporting its seats', () => {
  // A lapsed 20-seat plan must not keep billing as 20 seats, nor claim to be a
  // Team customer — but the record still remembers what it had.
  const bought = new Date('2026-03-01T12:00:00.000Z');
  const later = new Date(bought.getTime() + 60 * DAY);
  const r = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', seats: 20 }, bought);
  const detail = S.describeRecord({ subscriptionRecord: r.record, ...r.patch }, later.getTime());
  assert.equal(detail.effective.active, false);
  assert.equal(detail.effective.seats, 1);
  assert.equal(detail.effective.isTeam, false);
  assert.equal(detail.effective.recordedSeats, 20, 'the admin readout still shows what it had');
  assert.equal(detail.paid.seats, 20);
  assert.equal(detail.paid.isTeam, false, 'an elapsed window grants nothing');
});

test('an admin override never silently changes the seat count', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', seats: 8 }, now);
  // Every admin action, not just the ones that mention seats.
  for (const [action, payload] of [
    ['addDays', { days: 5 }],
    ['grant', { plan: 'custom', days: 30 }],
    ['changePlan', { plan: 'custom' }],
    ['extend', { expiresAt: new Date(now.getTime() + 60 * DAY).toISOString() }],
  ]) {
    const r = apply(paid.user, paid.record, action, { ...payload, actor: 'admin:Devs' }, now);
    assert.equal(r.ok, true, action);
    const detail = S.describeRecord({ subscriptionRecord: r.record, ...r.patch }, now.getTime());
    assert.equal(detail.effective.seats, 8, `${action} must not change the seat count`);
    assert.equal(detail.paid.seats, 8, `${action} must not touch the paid seats`);
  }
});

test('restoring an original state brings the seat count back with it', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', seats: 12 }, now);
  const bumped = apply(paid.user, paid.record, 'addDays', { days: 5, actor: 'admin:Devs' }, now);
  const during = S.describeRecord({ subscriptionRecord: bumped.record, ...bumped.patch }, now.getTime());
  assert.equal(during.restoreTarget.seats, 12, 'the restore target names the seat count');

  const restored = apply(bumped.user, bumped.record, 'restore', { actor: 'admin:Devs' }, now);
  const detail = S.describeRecord({ subscriptionRecord: restored.record, ...restored.patch }, now.getTime());
  assert.equal(detail.effective.seats, 12, 'restore must not silently drop 12 seats to 1');
  assert.equal(restored.patch.subscriptionSeats, 12);
});

test('a legacy account with no record reads as one seat', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const legacy = {
    subscriptionActive: true,
    subscriptionPlan: 'annual',
    subscriptionExpiresAt: new Date(now.getTime() + 10 * DAY).toISOString(),
  };
  assert.equal(S.readRecord(legacy).paid.seats, 1);
  const state = E.describeSubscription(legacy, now.getTime());
  assert.equal(state.subscriptionSeats, 1);
  assert.equal(state.subscriptionIsTeam, false);
});

test('the version signature moves when only the seat count changes', () => {
  // Otherwise a client applying an idempotent snapshot skips the re-render and
  // the billing screen keeps showing the old seat count.
  const now = new Date('2026-03-01T12:00:00.000Z');
  const five = apply({}, null, 'setPaid', { actor: 'payment', plan: 'annual', seats: 5 }, now);
  const ten = apply(five.user, five.record, 'setPaid', { actor: 'payment', plan: 'annual', seats: 10 }, now);
  const a = E.describeSubscription({ subscriptionRecord: five.record, ...five.patch }, now.getTime());
  const b = E.describeSubscription({ subscriptionRecord: ten.record, ...ten.patch }, now.getTime());
  assert.notEqual(a.version, b.version, 'a seat change must produce a new signature');
  // …while an identical state still produces an identical one.
  assert.equal(
    E.describeSubscription({ subscriptionRecord: ten.record, ...ten.patch }, now.getTime()).version,
    b.version,
  );
});

// ── 7. Legacy compatibility ─────────────────────────────────────────────────
test('a pre-upgrade account with no record reads as a paid subscription', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const end = new Date(now.getTime() + 4 * DAY);
  const legacy = {
    subscriptionActive: true,
    subscriptionPlan: 'annual',
    subscriptionStartedAt: new Date(now.getTime() - 26 * DAY),
    subscriptionExpiresAt: end,
  };
  const record = S.readRecord(legacy);
  assert.equal(record.paid.plan, 'annual');
  assert.equal(record.paid.status, 'active');
  assert.equal(record.paid.expiresAt.toISOString(), end.toISOString());
  assert.equal(record.override, null);
  assert.equal(E.describeSubscription(legacy, now.getTime()).daysRemaining, 4);
});

test('the projection writes exactly the fields the rest of the app reads', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const r = apply({}, null, 'grant', { plan: 'annual', days: 30 }, now);
  for (const field of ['subscriptionActive', 'subscriptionPlan', 'subscriptionStartedAt',
    'subscriptionExpiresAt', 'subscriptionPermanent', 'subscriptionSource', 'subscriptionUpdatedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(r.patch, field), `missing ${field}`);
  }
  assert.equal(r.patch.subscriptionPlan, 'annual');
  assert.equal(r.patch.subscriptionActive, true);
  assert.equal(r.patch.subscriptionPermanent, false);
  assert.equal(r.patch.subscriptionSource, 'admin');
});

test('every admin action records WHO made the change, not a placeholder', () => {
  // Regression: ensureOverride() seeded the override with a hard-coded
  // 'admin' alias, so an "+6 days" by a named administrator showed "by admin"
  // in the change log while only `grant` stamped the real alias.
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = buy({}, 'annual', 30, now);
  for (const [action, payload, actor] of [
    ['addDays', { days: 6 }, 'admin:AdminZoe'],
    ['permanent', {}, 'admin:AdminDevs'],
    ['changePlan', { plan: 'custom' }, 'admin:AdminPoli'],
    ['extend', { expiresAt: new Date(now.getTime() + 60 * DAY).toISOString() }, 'admin:AdminJoma'],
  ]) {
    const r = apply(paid.user, paid.record, action, { ...payload, actor }, now);
    assert.equal(r.ok, true, action);
    assert.equal(r.record.override.adminAlias, actor, `${action} must stamp the acting admin`);
    assert.equal(r.record.history[0].actor, actor, `${action} history must name the acting admin`);
  }
});

test('a grant stamps its reason onto the override for the admin panel', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const r = apply({}, null, 'grant', { plan: 'annual', days: 30, actor: 'admin:Devs', note: 'Support case #4821' }, now);
  assert.equal(r.record.override.adminAlias, 'admin:Devs');
  assert.equal(r.record.override.reason, 'Support case #4821');
  const detail = S.describeRecord(r.user, now.getTime());
  assert.equal(detail.override.reason, 'Support case #4821');
  assert.equal(detail.override.adminAlias, 'admin:Devs');
});

test('plan aliases stay in one place and unknown plans fail closed', () => {
  assert.equal(S.normalizePlanId('Premium'), 'annual');
  assert.equal(S.normalizePlanId('  ULTIMATE '), 'custom');
  assert.equal(S.normalizePlanId('deluxe'), 'monthly');
  assert.equal(S.normalizePlanId('free'), 'free');
  assert.equal(S.normalizePlanId('platinum'), null);
  assert.equal(S.normalizePlanId(null), null);
  assert.equal(S.normalizePlanId(undefined), null);
  // Entitlements re-exports the same function object — no second implementation.
  assert.equal(E.normalizePlanId, S.normalizePlanId);
  assert.equal(E.PLAN_RANK.annual, 2);
  assert.equal(E.PLAN_LABELS.custom, 'ULTIMATE');
});

test('day parsing accepts the shapes an admin UI actually sends', () => {
  assert.equal(S.toDays(30), 30);
  assert.equal(S.toDays('7'), 7);
  assert.equal(S.toDays('7d'), 7);
  assert.equal(S.toDays('7 days'), 7);
  assert.equal(S.toDays('1 month'), 30);
  assert.equal(S.toDays('2 months'), 60);
  assert.equal(S.toDays('abc'), null);
  assert.equal(S.toDays(''), null);
  assert.equal(S.clampDays(99999), S.MAX_ADMIN_DAYS);
  assert.equal(S.clampDays(-4), 0);
});
