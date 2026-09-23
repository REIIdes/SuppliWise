/**
 * Frontend entitlement registry — drift guard.
 *
 * The backend is the source of truth (server/utils/entitlements.js). This
 * frontend file is only a MIRROR used for UI visibility, but if the two ever
 * disagree the app renders one plan while the API enforces another — the exact
 * stale-state bug the subscription system exists to prevent.
 *
 * These tests import the REAL server module and compare the two registries
 * field by field, so a tier/label/feature change on either side fails
 * `npm test` until both are updated together.
 *
 * Run: npm test  (node --test src/subscription/features.test.js)
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import server from '../../../server/utils/entitlements.js';
import {
  FEATURES, PLAN_RANK, PLAN_LABELS, PLAN_ORDER, HISTORY_LIMITS,
  resolveFeatureKey, isKnownFeature, normalizePlanId,
} from './features.js';

// The spellings the subscription spec names explicitly. Each must resolve to a
// canonical key that the SERVER actually registers at the expected tier.
const SPEC_SPELLINGS = {
  health_assessment: { key: 'healthAssessment', minTier: 'free' },
  supplement_recommendations: { key: 'recommendations', minTier: 'free' },
  daily_intake: { key: 'dailyIntake', minTier: 'free' },
  insights: { key: 'insights', minTier: 'monthly' },
  analytics: { key: 'insights', minTier: 'monthly' },
  pdf_reports: { key: 'pdfExport', minTier: 'monthly' },
  pdf_export: { key: 'pdfExport', minTier: 'monthly' },
  priority_assessment: { key: 'priorityAssessment', minTier: 'annual' },
  five_year_history: { key: 'historyFull', minTier: 'annual' },
  five_year_record_history: { key: 'historyFull', minTier: 'annual' },
  ai_chat: { key: 'chat', minTier: 'custom' },
};

test('frontend feature registry is identical to the server registry', () => {
  assert.deepEqual(
    Object.keys(FEATURES).sort(),
    Object.keys(server.FEATURES).sort(),
    'feature keys drifted — add/remove the same feature on both sides',
  );
  for (const [key, def] of Object.entries(FEATURES)) {
    const remote = server.FEATURES[key];
    assert.ok(remote, `server does not register "${key}"`);
    assert.equal(def.minTier, remote.minTier, `${key} minTier drifted`);
    assert.equal(def.label, remote.label, `${key} label drifted`);
    assert.equal(def.description, remote.description, `${key} description drifted`);
  }
});

test('frontend plan ranks, order and labels match the server', () => {
  assert.deepEqual(PLAN_RANK, server.PLAN_RANK);
  assert.deepEqual(PLAN_ORDER, server.PLAN_ORDER);
  assert.deepEqual(PLAN_LABELS, server.PLAN_LABELS);
  assert.deepEqual(Object.values(PLAN_LABELS).sort(), ['DELUXE', 'FREE', 'PREMIUM', 'ULTIMATE']);
});

test('frontend history limits match server limitsFor() for every tier', () => {
  for (const plan of PLAN_ORDER) {
    const serverUser = { subscriptionActive: true, subscriptionPlan: plan, subscriptionExpiresAt: null };
    assert.equal(
      HISTORY_LIMITS[plan],
      server.historyLimitFor(serverUser),
      `${plan} history page limit drifted`,
    );
  }
});

test('every spec spelling resolves to a server-registered feature at the right tier', () => {
  for (const [spelling, expected] of Object.entries(SPEC_SPELLINGS)) {
    const key = resolveFeatureKey(spelling);
    assert.equal(key, expected.key, `"${spelling}" should resolve to ${expected.key}`);
    assert.ok(server.FEATURES[key], `server must register "${key}"`);
    assert.equal(
      server.FEATURES[key].minTier,
      expected.minTier,
      `"${spelling}" tier drifted on the server`,
    );
    // The frontend must agree, or the gate would show a different tier.
    assert.equal(FEATURES[key].minTier, expected.minTier, `"${spelling}" tier drifted in the UI`);
    assert.equal(isKnownFeature(spelling), true, spelling);
  }
});

test('canonical camelCase keys resolve to themselves', () => {
  for (const key of Object.keys(FEATURES)) {
    assert.equal(resolveFeatureKey(key), key, key);
    assert.equal(resolveFeatureKey(`  ${key}  `), key, `whitespace around ${key}`);
    assert.equal(resolveFeatureKey(key.toUpperCase()), key, `case-insensitive ${key}`);
  }
});

test('unknown features fail closed (never resolve to something real)', () => {
  // Fail-open here would make a gate render as unlocked for a feature that
  // does not exist — the frontend twin of the server getFeature() guard.
  const unknown = ['blockchain', 'unlimited', 'god_mode', 'export', 'reports',
    'priorityFlag', 'not_a_feature', 'ADMIN', 'features'];
  for (const probe of unknown) {
    assert.equal(resolveFeatureKey(probe), null, `"${probe}" must not resolve`);
    assert.equal(isKnownFeature(probe), false, `"${probe}" must not be known`);
  }
  assert.equal(resolveFeatureKey(''), null);
  assert.equal(resolveFeatureKey('   '), null);
  assert.equal(resolveFeatureKey(null), null);
  assert.equal(resolveFeatureKey(undefined), null);
  assert.equal(resolveFeatureKey(42), null);
  assert.equal(resolveFeatureKey({}), null);
});

test('prototype-chain keys fail closed', () => {
  // `FEATURES['constructor']` / `Object.prototype` members are truthy but carry
  // no minTier; before the own-property guard, hasFeature(plan,'constructor')
  // answered TRUE for a FREE user. Both resolvers must miss them.
  const probes = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty',
    'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString', 'prototype'];
  for (const probe of probes) {
    assert.equal(resolveFeatureKey(probe), null, `"${probe}" must not resolve`);
    assert.equal(isKnownFeature(probe), false, `"${probe}" must not be known`);
    assert.equal(server.hasFeature(probe), false, `server must reject "${probe}"`);
    assert.equal(server.can(
      { subscriptionActive: true, subscriptionPlan: 'custom', subscriptionExpiresAt: null },
      probe,
    ), false, `server must deny "${probe}" even for ULTIMATE`);
  }
  // The probes must not have been written into either registry.
  for (const probe of ['constructor', '__proto__', 'toString']) {
    assert.equal(Object.prototype.hasOwnProperty.call(FEATURES, probe), false, probe);
    assert.equal(Object.prototype.hasOwnProperty.call(server.FEATURES, probe), false, probe);
  }
});

test('plan id aliases match the server normalization', () => {
  for (const [alias, canonical] of Object.entries({
    free: 'free', basic: 'free',
    monthly: 'monthly', deluxe: 'monthly',
    annual: 'annual', premium: 'annual',
    custom: 'custom', ultimate: 'custom',
  })) {
    assert.equal(normalizePlanId(alias), canonical, alias);
    assert.equal(normalizePlanId(alias.toUpperCase()), canonical, `${alias} case`);
    assert.equal(server.normalizePlanId(alias), canonical, `server ${alias}`);
  }
  for (const bogus of ['gold', 'enterprise', '__proto__', 'constructor', null, undefined]) {
    assert.equal(normalizePlanId(bogus), null, String(bogus));
    assert.equal(server.normalizePlanId(bogus), null, `server ${String(bogus)}`);
  }
});

test('every aliased feature exists in both registries', () => {
  // Guards against adding a frontend alias whose target the server never
  // learned about — that would unlock UI for something the API rejects.
  const spellings = [
    'health_assessment', 'supplement_recommendations', 'daily_intake',
    'insights', 'analytics', 'insights_and_analytics', 'insights_analytics',
    'pdf_export', 'pdf_report_export', 'pdf_reports', 'pdf',
    'priority_assessment', 'priority', 'severe_case_flagging',
    'five_year_history', 'five_year_record_history', 'record_history', 'history',
    'chat', 'ai_chat', 'ai_chat_assistant',
  ];
  for (const spelling of spellings) {
    const key = resolveFeatureKey(spelling);
    assert.ok(key, `"${spelling}" must resolve`);
    assert.ok(FEATURES[key], `frontend must register "${key}"`);
    assert.ok(server.FEATURES[key], `server must register "${key}"`);
  }
});
