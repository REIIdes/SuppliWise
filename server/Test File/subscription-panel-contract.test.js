'use strict';
/**
 * Contract check: AdminSubscriptionPanel <-> GET/POST /api/admin/users/:id/subscription
 *
 * The panel is a separate chunk from the server, so the real risk is a field
 * name that does not exist in the payload — which renders as a blank card or a
 * dead button rather than an error. This walks every field the panel reads out
 * of a REAL response from the running engine and fails loudly on any that is
 * missing.
 *
 *   node Test File/subscription-panel-contract.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../utils/subscriptionState');
const E = require('../utils/entitlements');

// The exact shape the server route returns for `detail`. `now` must be the same
// instant the actions were applied at, or a 30-day window looks expired.
function detailOf(record, now = Date.now()) {
  return S.describeRecord({ subscriptionRecord: record }, now);
}

test('GET detail returns every field AdminSubscriptionPanel reads', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  const paid = S.applyAction(null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, now);
  const bumped = S.applyAction(paid.record, 'addDays', { days: 6, actor: 'admin:Devs', note: 'credit' }, now);
  const detail = detailOf(bumped.record, now.getTime());

  // effective.* — the top card
  for (const field of ['plan', 'label', 'status', 'active', 'permanent', 'source',
    'sourceLabel', 'startedAt', 'expiresAt', 'daysRemaining', 'remainingMs', 'durationLabel']) {
    assert.ok(Object.prototype.hasOwnProperty.call(detail.effective, field), `effective.${field}`);
  }
  assert.equal(detail.effective.sourceLabel, 'ADMIN');
  // 30 days paid + 6 granted = 36. Day arithmetic continues from the time
  // remaining, exactly as the spec's "4 + 6 = 10" example requires.
  assert.equal(detail.effective.durationLabel, '36 days left');

  // paid.* — the "user's own subscription" card
  for (const field of ['plan', 'label', 'status', 'active', 'permanent', 'startedAt',
    'expiresAt', 'daysRemaining', 'remainingMs', 'durationLabel', 'periodDays',
    'updatedAt', 'updatedBy']) {
    assert.ok(Object.prototype.hasOwnProperty.call(detail.paid, field), `paid.${field}`);
  }
  assert.equal(detail.paid.durationLabel, '30 days left');
  assert.equal(detail.paid.updatedBy, 'payment');

  // override.* — the admin card
  for (const field of ['active', 'plan', 'label', 'permanent', 'startedAt', 'expiresAt',
    'daysRemaining', 'remainingMs', 'durationLabel', 'appliedAt', 'updatedAt',
    'adminAlias', 'reason', 'canRestore', 'restoreTarget']) {
    assert.ok(Object.prototype.hasOwnProperty.call(detail.override, field), `override.${field}`);
  }
  assert.equal(detail.override.active, true);
  assert.equal(detail.override.adminAlias, 'admin:Devs');
  assert.equal(detail.override.reason, 'credit');

  // restoreTarget — the "Restore original" description
  for (const field of ['plan', 'label', 'status', 'permanent', 'startedAt', 'expiresAt',
    'capturedAt', 'capturedDaysRemaining', 'capturedDuration']) {
    assert.ok(Object.prototype.hasOwnProperty.call(detail.override.restoreTarget, field), `restoreTarget.${field}`);
  }
  assert.equal(detail.override.restoreTarget.capturedDaysRemaining, 30);
  assert.equal(detail.override.restoreTarget.capturedDuration, '30 days left');
  assert.equal(detail.override.canRestore, true);

  // top-level flags the panel's buttons read
  assert.equal(detail.canRestore, true);
  assert.ok(Array.isArray(detail.history));
  assert.equal(detail.history[0].action, 'addDays');
});

test('the panel buttons are all reachable: every action is accepted by the engine', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  // Start from a granted account, which is the only state where the panel's
  // action buttons are enabled.
  let state = S.applyAction(null, 'grant', { actor: 'admin:Devs', plan: 'annual', days: 30 }, now);
  assert.equal(state.ok, true);

  // Exactly the actions AdminSubscriptionPanel's buttons dispatch, in the order a
  // happy-path admin would press them.
  const presses = [
    ['addDays', { days: 7 }],
    ['deductDays', { days: 3 }],
    ['changePlan', { plan: 'custom' }],
    ['extend', { expiresAt: new Date(now.getTime() + 90 * S.DAY_MS).toISOString() }],
    ['grant', { plan: 'monthly', days: 15, permanent: false }],
    ['permanent', {}],
    ['clearOverride', {}],
    ['grant', { plan: 'custom', permanent: true }],
    ['restore', {}],
    ['remove', {}],
    ['setPaid', { plan: 'annual', active: true, days: 30 }],
    ['setPaid', { plan: 'annual', active: false }],
  ];
  for (const [action, payload] of presses) {
    const next = S.applyAction(state.record, action, { actor: 'admin:Devs', ...payload }, now);
    assert.equal(next.ok, true, `${action} must be accepted: ${next.error || ''}`);
    state = next;
  }
  const final = detailOf(state.record, now.getTime());
  assert.equal(final.effective.plan, 'free', 'a cancelled plan grants nothing');
  assert.equal(final.effective.active, false);
  // …but the plan it used to be is still on the record, for the admin readout.
  assert.equal(final.effective.recordedPlan, 'annual');
  assert.equal(final.paid.status, 'cancelled');
});

test('the history rows the panel lists have every field it renders', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  let state = S.applyAction(null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, now);
  state = S.applyAction(state.record, 'addDays', { days: 6, actor: 'admin:Devs' }, now);
  const { history } = detailOf(state.record);
  // Newest first, and each row carries what the panel prints.
  for (const entry of history) {
    for (const field of ['at', 'actor', 'action', 'note', 'from', 'to']) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, field), `history[].${field}`);
    }
    assert.ok(entry.at, 'history[].at must be a real date');
    assert.ok(entry.actor, 'history[].actor must be set');
    assert.ok(entry.note, 'history[].note must never be blank');
  }
  assert.equal(history[0].action, 'addDays');
  assert.equal(history[1].action, 'setPaid');
});

test('the user-facing snapshot carries what the pricing page banner renders', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');
  let state = S.applyAction(null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, now);
  const doc = { subscriptionRecord: state.record, ...state.patch };
  const sub = E.describeSubscription(doc, now.getTime());

  // PricingPage / ProfilePage banner fields.
  for (const field of ['currentPlan', 'subscriptionStatus', 'subscriptionActive',
    'subscriptionStart', 'subscriptionEnd', 'subscriptionPermanent',
    'subscriptionSource', 'subscriptionDuration', 'daysRemaining', 'remainingMs',
    'standardPeriodDays', 'planRank', 'planLabel', 'entitlements', 'limits',
    'subscriptionLayers', 'version']) {
    assert.ok(Object.prototype.hasOwnProperty.call(sub, field), `subscription.${field}`);
  }
  assert.equal(sub.daysRemaining, 30);
  assert.equal(sub.subscriptionSource, 'payment');

  // Admin override in force -> the banner must say ADMIN and mention restore.
  const bumped = S.applyAction(state.record, 'addDays', { days: 6, actor: 'admin:Devs' }, now);
  const overridden = E.describeSubscription({ subscriptionRecord: bumped.record, ...bumped.patch }, now.getTime());
  assert.equal(overridden.subscriptionSource, 'admin');
  assert.equal(overridden.daysRemaining, 36);
  assert.equal(overridden.subscriptionLayers.override.active, true);
  assert.equal(overridden.subscriptionLayers.canRestore, true);
  assert.equal(overridden.subscriptionLayers.restoreTarget.capturedDaysRemaining, 30);
  // The user must never receive the admin change log through this surface.
  assert.deepEqual(overridden.subscriptionLayers.history, []);
  // The admin endpoint opts into it.
  const asAdmin = E.describeSubscription({ subscriptionRecord: bumped.record, ...bumped.patch }, now.getTime(), { history: true });
  assert.ok(asAdmin.subscriptionLayers.history.length > 0);

  // Permanent -> duration reads PERMANENT and there are no days.
  const perm = S.applyAction(bumped.record, 'permanent', { actor: 'admin:Devs' }, now);
  const permanent = E.describeSubscription({ subscriptionRecord: perm.record, ...perm.patch }, now.getTime());
  assert.equal(permanent.subscriptionPermanent, true);
  assert.equal(permanent.subscriptionDuration, 'PERMANENT');
  assert.equal(permanent.daysRemaining, null);
  assert.equal(permanent.subscriptionEnd, null);
});
