/**
 * Subscription system — entitlement, transition and authorization tests.
 *
 * Pure unit tests: no database, no HTTP server, no network. They pin the
 * contract that both the API and the UI depend on, so `npm test` fails if the
 * tier rules, the feature registry or a 403 gate ever drift.
 *
 * Covers the transitions required by the subscription spec:
 *   FREE -> DELUXE -> PREMIUM -> ULTIMATE -> FREE, plus FREE -> PREMIUM,
 *   PREMIUM -> FREE, admin removal, expiry, cancellation and downgrade.
 *
 * The live end-to-end suite (SSE push + admin mutation against a running
 * server) is `npm run test:flows`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const E = require('../utils/entitlements');

const ALL_FEATURES = Object.keys(E.FEATURES);

// The tier structure, written out independently of the implementation so a
// change to either the registry or this table has to be made deliberately.
const EXPECTED_TIER_FEATURES = {
  free:    ['healthAssessment', 'recommendations', 'dailyIntake'],
  monthly: ['healthAssessment', 'recommendations', 'dailyIntake', 'insights', 'pdfExport',
            'web3', 'market', 'dao'],
  annual:  ['healthAssessment', 'recommendations', 'dailyIntake', 'insights', 'pdfExport',
            'priorityAssessment', 'historyFull', 'web3', 'market', 'dao'],
  custom:  ALL_FEATURES,
};

// The blockchain layer is DELUXE-only: the first paid tier above FREE.
// Spelled out rather than folded into EXPECTED_TIER_FEATURES so that granting
// it to FREE by accident fails by name, and so the three areas are asserted
// separately.
const DELUXE_ONLY = ['web3', 'market', 'dao'];

const SPEC_LABELS = { free: 'FREE', monthly: 'DELUXE', annual: 'PREMIUM', custom: 'ULTIMATE' };

/** Build a user document shaped like the model, for an arbitrary plan. */
function user(plan, { active = true, expiresAt = null, startedAt = null, updatedAt = null, role } = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    ...(role ? { role } : {}),
    subscriptionActive: active,
    subscriptionPlan: plan,
    subscriptionStartedAt: startedAt,
    subscriptionExpiresAt: expiresAt,
    subscriptionUpdatedAt: updatedAt ?? new Date().toISOString(),
  };
}

function enabledSet(u) {
  const map = E.entitlementsFor(u);
  return ALL_FEATURES.filter((k) => map[k] === true);
}

/** Features that flip from locked to unlocked between two plans. */
function gained(fromPlan, toPlan) {
  const before = new Set(enabledSet(user(fromPlan)));
  return enabledSet(user(toPlan)).filter((k) => !before.has(k));
}

/**
 * Drive an express middleware to completion.
 * resolves { status, body } for a 403/400 short-circuit, or { status: 200 }
 * when it calls next() (i.e. the request is allowed through).
 */
function run(middleware, req) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      body: undefined,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; resolve({ status: this.statusCode, body: payload }); },
    };
    try {
      middleware(req, res, () => resolve({ status: 200, body: undefined }));
    } catch (error) {
      resolve({ status: 500, body: { thrown: error.message } });
    }
  });
}

// ── 1. Structure ─────────────────────────────────────────────────────────────

test('the blockchain layer is registered as DELUXE-only', () => {
  // The product rule: Web3, Market and DAO require DELUXE. FREE must be
  // refused; every paid tier allowed. Asserted by name so a later edit that
  // quietly widens or narrows it fails here.
  for (const key of DELUXE_ONLY) {
    assert.ok(E.hasFeature(key), `${key} must be registered`);
    assert.equal(E.FEATURES[key].minTier, 'monthly', `${key} must require DELUXE`);
    assert.ok(E.FEATURES[key].label, `${key} needs a label for the upgrade card`);
  }
  assert.equal(E.can(user('free'), 'web3'), false, 'FREE must not reach the blockchain layer');
  for (const plan of ['monthly', 'annual', 'custom']) {
    for (const key of DELUXE_ONLY) {
      assert.equal(E.can(user(plan), key), true, `${plan} must reach ${key}`);
    }
  }
  // Admins bypass every gate, at every tier.
  for (const key of DELUXE_ONLY) {
    assert.equal(E.can({ ...user('free'), role: 'admin' }, key), true, 'admins bypass');
  }
});

test('an expired or cancelled DELUXE session loses the blockchain layer', () => {
  // The plan id on the document is not the decision — a lapsed subscription
  // must fail closed even when subscriptionPlan still says DELUXE.
  const expired = user('monthly', { expiresAt: new Date(Date.now() - 1000).toISOString() });
  const cancelled = user('monthly', { active: false });
  for (const key of DELUXE_ONLY) {
    assert.equal(E.can(expired, key), false, `expired DELUXE must lose ${key}`);
    assert.equal(E.can(cancelled, key), false, `cancelled DELUXE must lose ${key}`);
  }
});

test('the three blockchain features are separate keys, not one shared entry', () => {
  // The navbar shows three cards; if they collapsed to a single key the UI
  // would advertise one entitlement while the server gated another.
  const defs = DELUXE_ONLY.map((k) => E.getFeature(k));
  assert.equal(new Set(defs.map((d) => d.label)).size, 3, 'each area needs its own label');
  for (const key of DELUXE_ONLY) {
    assert.equal(E.getFeature(key), E.FEATURES[key], `${key} must resolve to itself`);
  }
});

test('each plan exposes exactly the features specified for it', () => {
  for (const [plan, expected] of Object.entries(EXPECTED_TIER_FEATURES)) {
    assert.deepEqual(enabledSet(user(plan)).sort(), [...expected].sort(), `plan ${plan}`);
  }
});

test('tiers form a strict hierarchy: every higher plan inherits the lower one', () => {
  for (let i = 1; i < E.PLAN_ORDER.length; i += 1) {
    const lower = E.PLAN_ORDER[i - 1];
    const higher = E.PLAN_ORDER[i];
    const lowerSet = new Set(enabledSet(user(lower)));
    const higherSet = new Set(enabledSet(user(higher)));
    // Inheritance: nothing the lower tier grants may be lost above it.
    for (const key of lowerSet) {
      assert.ok(higherSet.has(key), `${key} granted on ${lower} must remain available on ${higher}`);
    }
    // And each step up must actually unlock something new.
    assert.ok(
      higherSet.size > lowerSet.size,
      `${higher} must unlock at least one feature over ${lower}`,
    );
  }
});

test('plan labels match FREE / DELUXE / PREMIUM / ULTIMATE', () => {
  const stamp = '2030-01-01T00:00:00.000Z';
  for (const [plan, label] of Object.entries(SPEC_LABELS)) {
    assert.equal(E.PLAN_LABELS[plan], label, plan);
    assert.equal(E.describeSubscription(user(plan, { updatedAt: stamp })).planLabel, label, plan);
  }
  assert.deepEqual(Object.keys(E.PLAN_LABELS).sort(), E.PLAN_ORDER.slice().sort());
});

test('plan ranks order free < monthly < annual < custom', () => {
  assert.deepEqual(E.PLAN_ORDER, ['free', 'monthly', 'annual', 'custom']);
  for (let i = 1; i < E.PLAN_ORDER.length; i += 1) {
    assert.ok(E.PLAN_RANK[E.PLAN_ORDER[i]] > E.PLAN_RANK[E.PLAN_ORDER[i - 1]]);
  }
});

// ── 2. Required transitions ──────────────────────────────────────────────────

test('FREE -> DELUXE unlocks Insights, PDF and the blockchain layer', () => {
  // The blockchain layer is the headline of a DELUXE upgrade, so it is named
  // explicitly here rather than left to fall out of the tier table.
  assert.deepEqual(gained('free', 'monthly').sort(), ['dao', 'insights', 'market', 'pdfExport', 'web3']);
  for (const key of EXPECTED_TIER_FEATURES.free) {
    assert.ok(E.can(user('monthly'), key), `${key} must survive the upgrade`);
  }
});

test('DELUXE -> PREMIUM unlocks Priority + 5-Year History, keeps Free + Deluxe', () => {
  assert.deepEqual(gained('monthly', 'annual').sort(), ['historyFull', 'priorityAssessment']);
  for (const key of EXPECTED_TIER_FEATURES.monthly) {
    assert.ok(E.can(user('annual'), key), `${key} must survive the upgrade`);
  }
});

test('PREMIUM -> ULTIMATE unlocks every available feature', () => {
  assert.deepEqual(gained('annual', 'custom').sort(), ['chat']);
  assert.deepEqual(enabledSet(user('custom')).sort(), ALL_FEATURES.slice().sort());
});

test('ULTIMATE -> FREE leaves only the Free features', () => {
  const lost = enabledSet(user('custom')).filter((k) => !enabledSet(user('free')).includes(k));
  assert.deepEqual(
    lost.sort(),
    ['chat', 'dao', 'historyFull', 'insights', 'market', 'pdfExport', 'priorityAssessment', 'web3'],
  );
  assert.deepEqual(enabledSet(user('free')).sort(), [...EXPECTED_TIER_FEATURES.free].sort());
});

test('FREE -> PREMIUM grants everything Premium includes in one step', () => {
  assert.deepEqual(
    gained('free', 'annual').sort(),
    ['dao', 'historyFull', 'insights', 'market', 'pdfExport', 'priorityAssessment', 'web3'],
  );
});

test('PREMIUM -> FREE removes every paid entitlement at once', () => {
  const lost = enabledSet(user('annual')).filter((k) => !enabledSet(user('free')).includes(k));
  assert.deepEqual(
    lost.sort(),
    ['dao', 'historyFull', 'insights', 'market', 'pdfExport', 'priorityAssessment', 'web3'],
  );
  assert.deepEqual(enabledSet(user('free')).sort(), [...EXPECTED_TIER_FEATURES.free].sort());
});

test('DELUXE -> FREE loses the blockchain layer but keeps nothing else', () => {
  // Downgrade boundary: DELUXE is the lowest tier that grants the blockchain
  // layer, so dropping to FREE must remove all three and nothing from FREE.
  const lost = enabledSet(user('monthly')).filter((k) => !enabledSet(user('free')).includes(k));
  assert.deepEqual(lost.sort(), ['dao', 'insights', 'market', 'pdfExport', 'web3']);
  for (const key of EXPECTED_TIER_FEATURES.free) {
    assert.ok(E.can(user('free'), key), `${key} must survive the downgrade`);
  }
});

// ── 3. Expiry, cancellation, removal ─────────────────────────────────────────

test('an expired subscription falls back to FREE at read time', () => {
  const expired = user('annual', { expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const state = E.resolveSubscription(expired);
  assert.equal(state.status, 'expired');
  assert.equal(state.plan, 'free');
  assert.equal(state.rank, 0);
  assert.equal(state.subscriptionActive, false);
  assert.deepEqual(enabledSet(expired).sort(), [...EXPECTED_TIER_FEATURES.free].sort());
});

test('an expiry exactly now is already expired (no grace window)', () => {
  const state = E.resolveSubscription(user('custom', { expiresAt: new Date(Date.now()).toISOString() }));
  assert.equal(state.status, 'expired');
  assert.equal(state.plan, 'free');
});

test('a future expiry keeps the plan active until that instant', () => {
  const state = E.resolveSubscription(user('annual', { expiresAt: new Date(Date.now() + 86_400_000).toISOString() }));
  assert.equal(state.status, 'active');
  assert.equal(state.plan, 'annual');
});

test('admin removal (active=false) drops paid entitlements but keeps the record', () => {
  const removed = user('annual', { active: false });
  const state = E.resolveSubscription(removed);
  assert.equal(state.status, 'inactive');
  assert.equal(state.plan, 'free');
  assert.equal(state.rank, 0);
  assert.equal(removed.subscriptionPlan, 'annual'); // the stored plan is untouched
  assert.deepEqual(enabledSet(removed).sort(), [...EXPECTED_TIER_FEATURES.free].sort());

  // A removal that also stamps an expiry resolves as expired instead of
  // inactive — either way every paid entitlement is gone.
  const stamped = user('annual', { active: false, expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(E.resolveSubscription(stamped).status, 'expired');
  assert.equal(E.resolveSubscription(stamped).plan, 'free');
  assert.deepEqual(enabledSet(stamped).sort(), [...EXPECTED_TIER_FEATURES.free].sort());
});

test('cancellation falls back to Free plan features only', () => {
  const cancelled = user('custom', { active: false });
  const state = E.resolveSubscription(cancelled);
  assert.equal(state.plan, 'free');
  assert.equal(state.subscriptionActive, false);
  for (const key of EXPECTED_TIER_FEATURES.free) assert.ok(E.can(cancelled, key), key);
  for (const key of ALL_FEATURES.filter((k) => !EXPECTED_TIER_FEATURES.free.includes(k))) {
    assert.equal(E.can(cancelled, key), false, key);
  }
  assert.deepEqual(enabledSet(cancelled).sort(), [...EXPECTED_TIER_FEATURES.free].sort());
});

test('a downgrade is a plain plan swap — no stale higher entitlements survive', () => {
  // Admin writes `monthly` over `annual`: every annual-only feature must be off.
  const downgraded = user('monthly');
  assert.equal(E.can(downgraded, 'insights'), true);
  assert.equal(E.can(downgraded, 'priorityAssessment'), false);
  assert.equal(E.can(downgraded, 'historyFull'), false);
});

test('an open-ended subscription (null expiry) stays active', () => {
  const state = E.resolveSubscription(user('annual', { expiresAt: null }));
  assert.equal(state.status, 'active');
  assert.equal(state.subscriptionEnd, null);
  assert.equal(state.plan, 'annual');
});

test('a missing user document fails closed to FREE', () => {
  const state = E.resolveSubscription(null);
  assert.equal(state.plan, 'free');
  assert.equal(state.status, 'missing');
  assert.equal(state.rank, 0);
});

test('an unknown/garbage plan id fails closed to FREE', () => {
  for (const plan of ['platinum', 'lifetime', '', null, undefined, 'FREE ']) {
    const state = E.resolveSubscription(user(plan));
    assert.equal(state.plan, 'free', String(plan));
    assert.equal(state.rank, 0, String(plan));
  }
});

// ── 4. One authoritative interpretation ──────────────────────────────────────

test('the served entitlement map never disagrees with can() for any plan', () => {
  // The UI renders from describeSubscription().entitlements while the API
  // authorizes with can(). If those two ever disagree, the app shows one plan
  // while the backend enforces another — exactly the staleness bug this
  // system exists to prevent.
  for (const plan of E.PLAN_ORDER) {
    for (const active of [true, false]) {
      const u = user(plan, { active });
      const map = E.entitlementsFor(u);
      for (const key of ALL_FEATURES) {
        assert.equal(map[key], E.can(u, key), `${plan}/active=${active}/${key}: map vs can()`);
      }
    }
  }
});

test('enabledFeatures list agrees with the entitlement map', () => {
  for (const plan of E.PLAN_ORDER) {
    const u = user(plan);
    const map = E.entitlementsFor(u);
    const list = E.enabledFeatureList(u);
    assert.equal(list.length, ALL_FEATURES.length, plan);
    for (const entry of list) {
      assert.equal(entry.enabled, map[entry.key], `${plan}/${entry.key}`);
      assert.equal(entry.minTier, E.FEATURES[entry.key].minTier, `${plan}/${entry.key} minTier`);
      assert.equal(entry.label, E.FEATURES[entry.key].label, `${plan}/${entry.key} label`);
      assert.equal(entry.description, E.FEATURES[entry.key].description, `${plan}/${entry.key} description`);
    }
  }
});

test('describeSubscription carries every field the frontend store reads', () => {
  const state = E.describeSubscription(user('annual', {
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    updatedAt: '2030-01-01T00:00:00.000Z',
  }));
  for (const field of ['currentPlan', 'subscriptionStatus', 'subscriptionActive', 'subscriptionStart',
    'subscriptionEnd', 'planRank', 'planLabel', 'enabledFeatures', 'entitlements', 'limits', 'version']) {
    assert.ok(Object.prototype.hasOwnProperty.call(state, field), `missing ${field}`);
  }
  assert.equal(state.currentPlan, 'annual');
  assert.equal(state.planRank, E.PLAN_RANK.annual);
  assert.deepEqual(Object.keys(state.entitlements).sort(), ALL_FEATURES.slice().sort());
  assert.equal(Object.keys(state.entitlements).length, ALL_FEATURES.length);
});

test('version changes whenever entitlements change, and is otherwise stable', () => {
  // Reuse ONE document per case: version folds in subscriptionUpdatedAt, so a
  // freshly built user() would differ by a millisecond and look unstable.
  const freeUser = user('free');
  const base = E.describeSubscription(freeUser).version;
  assert.equal(E.describeSubscription(freeUser).version, base, 'same state -> same signature');
  assert.notEqual(E.describeSubscription(user('annual')).version, base, 'upgrade -> new signature');

  const future = new Date(Date.now() + 86_400_000).toISOString();
  const dated = user('annual', { expiresAt: future, updatedAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(
    E.describeSubscription(dated).version,
    E.describeSubscription(dated).version,
    'deterministic for identical input',
  );

  // Extending the expiry must change it, or clients skip the re-render that
  // would move subscriptionEnd. Same plan/updatedAt on both sides so ONLY
  // subscriptionEnd differs.
  assert.notEqual(
    E.describeSubscription(dated).version,
    E.describeSubscription(user('annual', { expiresAt: null, updatedAt: dated.subscriptionUpdatedAt })).version,
    'a different subscriptionEnd must produce a different signature',
  );

  // Same instants, different stored plan: the signature must move too.
  const fixed = '2030-01-01T00:00:00.000Z';
  assert.notEqual(
    E.describeSubscription(user('annual', { expiresAt: fixed, startedAt: fixed, updatedAt: fixed })).version,
    E.describeSubscription(user('custom', { expiresAt: fixed, startedAt: fixed, updatedAt: fixed })).version,
  );
});

// ── 5. Backend authorization (403) ───────────────────────────────────────────

test('requireFeature rejects every paid feature for a FREE user with 403', async () => {
  const gated = ['insights', 'pdfExport', 'priorityAssessment', 'historyFull', 'chat', ...DELUXE_ONLY];
  for (const key of gated) {
    const { status, body } = await run(E.requireFeature(key), { user: user('free') });
    assert.equal(status, 403, `${key} must be rejected, got ${status}`);
    assert.equal(body.allowed, false);
    assert.equal(body.feature, key);
    assert.equal(body.currentPlan, 'free');
    assert.ok(body.requiresPlan, 'requiresPlan drives the upgrade prompt');
    assert.equal(body.requiresPlan, E.FEATURES[key].minTier);
    assert.match(body.message, /requires the/i);
  }
});

test('requireFeature allows exactly the features the tier grants', async () => {
  const expectations = {
    free:    { allow: ['healthAssessment', 'recommendations', 'dailyIntake'],
               deny: ['insights', 'pdfExport', 'priorityAssessment', 'historyFull', 'chat', ...DELUXE_ONLY] },
    monthly: { allow: ['healthAssessment', 'recommendations', 'dailyIntake', 'insights', 'pdfExport',
                       'web3', 'market', 'dao'],
               deny: ['priorityAssessment', 'historyFull', 'chat'] },
    annual:  { allow: ['healthAssessment', 'recommendations', 'dailyIntake', 'insights', 'pdfExport',
                       'priorityAssessment', 'historyFull', 'web3', 'market', 'dao'],
               deny: ['chat'] },
    custom:  { allow: ALL_FEATURES, deny: [] },
  };

  for (const [plan, spec] of Object.entries(expectations)) {
    for (const key of spec.allow) {
      const { status } = await run(E.requireFeature(key), { user: user(plan) });
      assert.equal(status, 200, `${plan} should be allowed ${key}, got ${status}`);
    }
    for (const key of spec.deny) {
      const { status, body } = await run(E.requireFeature(key), { user: user(plan) });
      assert.equal(status, 403, `${plan} should be denied ${key}, got ${status}`);
      assert.equal(body.requiresPlan, E.FEATURES[key].minTier);
      assert.equal(body.currentPlan, plan);
    }
  }
});

test('an expired session loses its paid features at the API too', async () => {
  const expired = user('custom', { expiresAt: new Date(Date.now() - 1000).toISOString() });
  for (const key of ['insights', 'pdfExport', 'priorityAssessment', 'historyFull', 'chat', ...DELUXE_ONLY]) {
    const { status, body } = await run(E.requireFeature(key), { user: expired });
    assert.equal(status, 403, key);
    assert.equal(body.currentPlan, 'free');
    assert.equal(body.subscriptionStatus, 'expired');
  }
});

test('a removed/cancelled session loses its paid features at the API too', async () => {
  const removed = user('annual', { active: false });
  for (const key of ['insights', 'pdfExport', 'priorityAssessment', 'historyFull']) {
    const { status, body } = await run(E.requireFeature(key), { user: removed });
    assert.equal(status, 403, key);
    assert.equal(body.currentPlan, 'free');
    assert.equal(body.subscriptionStatus, 'inactive');
  }
});

test('requirePlan rejects below the tier and passes at or above it', async () => {
  assert.equal((await run(E.requirePlan('annual'), { user: user('monthly') })).status, 403);
  assert.equal((await run(E.requirePlan('annual'), { user: user('annual') })).status, 200);
  assert.equal((await run(E.requirePlan('annual'), { user: user('custom') })).status, 200);
  assert.equal((await run(E.requirePlan('monthly'), { user: user('free') })).status, 403);
  assert.equal((await run(E.requirePlan('free'), { user: user('free') })).status, 200);
});

test('admins bypass feature gates, users never do', async () => {
  const admin = user('free', { role: 'admin' });
  for (const key of ALL_FEATURES) assert.equal(E.can(admin, key), true, key);
  assert.equal((await run(E.requireFeature('chat'), { user: admin })).status, 200, 'admin bypass');
  assert.equal((await run(E.requireFeature('chat'), { user: user('custom') })).status, 200,
    'ULTIMATE holds chat, the top tier');
  assert.equal((await run(E.requireFeature('chat'), { user: user('free') })).status, 403,
    'a FREE user must be rejected');
});

// ── 6. Fail-closed lookups ───────────────────────────────────────────────────

test('unknown and prototype keys never grant access', () => {
  // Regression: `FEATURES[key]` with raw input resolves inherited members
  // (constructor/toString/...) that are truthy but carry no minTier, and
  // rankOf(undefined) === 0 made can() answer TRUE — a fail-open gate.
  const probes = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__',
    'prototype', 'admin', 'isPremium', 'notAFeature', '', '  '];
  for (const plan of E.PLAN_ORDER) {
    for (const key of probes) {
      assert.equal(E.can(user(plan), key), false, `${plan}/${JSON.stringify(key)}`);
      assert.equal(E.getFeature(key), undefined, JSON.stringify(key));
      assert.equal(E.hasFeature(key), false, JSON.stringify(key));
      // The registry itself must stay unpolluted by the probe.
      assert.equal(
        Object.prototype.hasOwnProperty.call(E.FEATURES, key) && key !== '',
        ALL_FEATURES.includes(key),
        `${JSON.stringify(key)} must not become a registered feature`,
      );
    }
  }
  // And the probes must not have been inserted as own properties either.
  for (const key of ['constructor', '__proto__', 'toString', 'isPremium']) {
    assert.equal(Object.prototype.hasOwnProperty.call(E.FEATURES, key), false, key);
  }
});

test('requireFeature on an unknown/prototype key answers 403, never next()', async () => {
  for (const key of ['constructor', '__proto__', 'toString', 'nonsense']) {
    const { status, body } = await run(E.requireFeature(key), { user: user('custom') });
    assert.equal(status, 403, `${key} must not slip through for an ULTIMATE user`);
    assert.equal(body.allowed, false);
    assert.equal(body.feature, key);
    assert.equal(body.requiresPlan, 'free', 'unknown features require nothing that exists');
    assert.match(body.message, /This feature requires/i);
  }
});

test('a ULTIMATE user is still denied an unregistered feature', () => {
  assert.equal(E.can(user('custom'), 'constructor'), false);
  assert.equal(E.can(user('custom'), 'blockchain'), false);
});

// ── 7. Limits and normalization ──────────────────────────────────────────────

test('history page limits follow the tier (5 / 10 / 20 / 20)', () => {
  assert.equal(E.historyLimitFor(user('free')), 5);
  assert.equal(E.historyLimitFor(user('monthly')), 10);
  assert.equal(E.historyLimitFor(user('annual')), 20);
  assert.equal(E.historyLimitFor(user('custom')), 20);
  assert.equal(E.historyLimitFor(user('annual', { expiresAt: new Date(Date.now() - 1).toISOString() })), 5,
    'an expired Premium plan must not keep the larger page size');
});

test('limits agree with the served subscription payload', () => {
  for (const plan of E.PLAN_ORDER) {
    assert.equal(E.describeSubscription(user(plan)).limits.historyPageSize, E.historyLimitFor(user(plan)), plan);
  }
});

test('plan ids normalize through one alias table and reject unknown spellings', () => {
  assert.equal(E.normalizePlanId('premium'), 'annual');
  assert.equal(E.normalizePlanId('PREMIUM'), 'annual');
  assert.equal(E.normalizePlanId('deluxe'), 'monthly');
  assert.equal(E.normalizePlanId('ultimate'), 'custom');
  assert.equal(E.normalizePlanId('basic'), 'free');
  assert.equal(E.normalizePlanId('free'), 'free');
  assert.equal(E.normalizePlanId('  annual  '), 'annual');
  for (const bogus of ['gold', 'enterprise', 'lifetime', '__proto__', 'constructor', null, undefined, 42]) {
    assert.equal(E.normalizePlanId(bogus), null, String(bogus));
  }
});

test('tierOf/tierRank track the resolved plan, not the stored field', () => {
  assert.equal(E.tierOf(user('annual')), 'annual');
  assert.equal(E.tierRank(user('annual')), E.PLAN_RANK.annual);
  assert.equal(E.tierOf(user('annual', { active: false })), 'free');
  assert.equal(E.tierRank(user('annual', { active: false })), 0);
});
