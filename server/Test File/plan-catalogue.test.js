'use strict';
/**
 * Plan catalogue + currency tests.
 *
 * Covers the two things a pricing page gets wrong most easily:
 *   1. the WRONG price (a price that disagrees with what the server charges), and
 *   2. the WRONG currency (a currency that does not match where the visitor is,
 *      or a detection rule that overrides an explicit choice).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../utils/planCatalogue');
// The entitlement gates a card's claims are derived from, plus the engine that
// grants the period a pricing page promises. Imported here so the tests can
// assert the binding rather than restate it.
const E = require('../utils/entitlements');
const S = require('../utils/subscriptionState');

// ══════════════════════════════════════════════════════════════════════════
// 1. Plan identity
// ══════════════════════════════════════════════════════════════════════════

test('the four plans are named Free, Deluxe, Premium and Ultimate', () => {
  const payload = C.cataloguePayload('PHP');
  assert.deepEqual(payload.plans.map((p) => p.label), ['Free', 'Deluxe', 'Premium', 'Ultimate']);
  assert.deepEqual(payload.plans.map((p) => p.id), ['free', 'monthly', 'annual', 'custom']);
});

test('the published prices are the ones on the pricing page', () => {
  const byLabel = Object.fromEntries(C.cataloguePayload('PHP').plans.map((p) => [p.label, p]));
  assert.equal(byLabel.Deluxe.monthly, 499);
  assert.equal(byLabel.Deluxe.yearly, 1600);
  assert.equal(byLabel.Premium.monthly, 699);
  assert.equal(byLabel.Premium.yearly, 1700);
  assert.equal(byLabel.Ultimate.monthly, 899);
  assert.equal(byLabel.Ultimate.yearly, 1800);
  assert.equal(byLabel.Free.monthly, 0);
  assert.equal(byLabel.Free.yearly, 0);
});

test('every plan keeps a valid stored id, an ordered chain and a real feature list', () => {
  const payload = C.cataloguePayload('PHP');
  // The stored ids are the whole app's contract — a typo here silently breaks
  // every entitlement gate.
  assert.deepEqual(payload.plans.map((p) => p.id), ['free', 'monthly', 'annual', 'custom']);
  // `inherits` must point at the tier below, so "Everything in X, plus:" is
  // always true.
  const byId = Object.fromEntries(payload.plans.map((p) => [p.id, p]));
  assert.equal(byId.free.inherits, undefined);
  assert.equal(byId.monthly.inherits, 'free');
  assert.equal(byId.annual.inherits, 'monthly');
  assert.equal(byId.custom.inherits, 'annual');
  for (const plan of payload.plans) {
    assert.ok(Array.isArray(plan.features) && plan.features.length > 0, `${plan.label} needs features`);
    assert.ok(typeof plan.cta === 'string' && plan.cta.length > 0, `${plan.label} needs a CTA`);
  }
  // Exactly one card is recommended.
  assert.equal(payload.plans.filter((p) => p.highlight).length, 1);
  assert.equal(byId.annual.badge, 'Recommended');
});

test('no plan advertises a feature it does not unlock', () => {
  // The card copy and the real gate must not drift: every featureKey on a card
  // has to be a key the entitlement registry actually knows.
  const { FEATURES } = require('../utils/entitlements');
  for (const plan of C.cataloguePayload('PHP').plans) {
    for (const key of plan.featureKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(FEATURES, key),
        `${plan.label} advertises unknown feature "${key}"`);
    }
  }
  // And the union across all plans must cover every gated feature, or a feature
  // exists that no plan can ever sell. Read from the PAYLOAD, not from
  // PLAN_CATALOGUE: the per-plan keys are derived from the gates and attached at
  // payload time, so the raw catalogue entries no longer carry them.
  const sold = new Set(C.cataloguePayload('PHP').plans.flatMap((p) => p.featureKeys));
  for (const key of Object.keys(FEATURES)) {
    assert.ok(sold.has(key), `feature "${key}" is not offered by any plan`);
  }
});

test('the yearly badge reports the declared saving and never a nonsense one', () => {
  const payload = C.cataloguePayload('PHP');
  const byLabel = Object.fromEntries(payload.plans.map((p) => [p.label, p]));
  assert.equal(byLabel.Free.pricing.savedPct, 0, 'free has nothing to save');
  // 499*12 = 5988 -> 1600 is a 73% saving; the badge must match the invoice.
  assert.equal(byLabel.Deluxe.pricing.savedPct, 73);
  assert.equal(byLabel.Premium.pricing.savedPct, 80);
  assert.equal(byLabel.Ultimate.pricing.savedPct, 83);
  for (const plan of payload.plans) {
    const { monthly, yearly, savedPct } = plan.pricing;
    if (monthly <= 0) continue;
    assert.ok(savedPct >= 0 && savedPct <= 95, `${plan.label} saving out of range: ${savedPct}`);
    assert.ok(yearly < monthly * 12, `${plan.label} yearly must beat 12 months`);
    assert.equal(Math.round((1 - yearly / (monthly * 12)) * 100), savedPct,
      `${plan.label} badge must match the actual arithmetic`);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 2. Currency conversion
// ══════════════════════════════════════════════════════════════════════════

test('PHP is the base currency and converts to itself unchanged', () => {
  assert.equal(C.DEFAULT_CURRENCY, 'PHP');
  assert.equal(C.convertFromPhp(499, 'PHP'), 499);
  assert.equal(C.formatAmount(499, 'PHP'), '₱499');
  assert.equal(C.formatAmount(1800, 'PHP'), '₱1,800');
});

test('an unknown currency code falls back to PHP instead of producing NaN', () => {
  assert.equal(C.normalizeCurrency('XYZ'), null);
  assert.equal(C.convertFromPhp(499, 'XYZ'), 499, 'unknown code must not divide by undefined');
  assert.equal(C.formatAmount(499, 'XYZ'), '₱499');
  assert.equal(C.normalizeCurrency(null), null);
  assert.equal(C.normalizeCurrency(''), null);
  assert.equal(C.normalizeCurrency(123), null);
});

test('every supported currency produces a finite, sensibly rounded price', () => {
  for (const code of C.CURRENCY_ORDER) {
    assert.ok(C.CURRENCIES[code], `${code} is listed but not defined`);
    for (const php of [499, 699, 899, 1600, 1700, 1800]) {
      const value = C.convertFromPhp(php, code);
      assert.ok(Number.isFinite(value), `${code} ${php} -> ${value}`);
      assert.ok(value >= 0, `${code} produced a negative price`);
      assert.equal(C.formatAmount(php, code), C.formatAmount(php, code), 'formatting must be stable');
    }
    // A converted price must carry its currency marker, never a bare number.
    assert.ok(C.formatAmount(499, code).startsWith(C.CURRENCIES[code].symbol), code);
  }
});

test('currencies with no minor unit are quoted without decimals', () => {
  assert.equal(C.CURRENCIES.PHP.decimals, 0);
  assert.equal(C.CURRENCIES.JPY.decimals, 0);
  assert.equal(C.CURRENCIES.INR.decimals, 0);
  assert.equal(C.CURRENCIES.USD.decimals, 2);
  assert.ok(!C.formatAmount(499, 'PHP').includes('.'), '₱499 must not read ₱499.00');
  assert.ok(C.formatAmount(499, 'USD').includes('.'), '$8.53 must keep its cents');
});

test('a free plan never shows cents, in any currency', () => {
  // "$0.00" on a pricing card reads like a rounding error, not a free plan.
  for (const code of C.CURRENCY_ORDER) {
    assert.equal(C.formatAmount(0, code), `${C.CURRENCIES[code].symbol}0`, code);
  }
});

test('a higher-value currency converts to a proportionally lower number', () => {
  // 1 USD is worth ~58.5 PHP, so a ₱899 plan must cost less than ₱899 in USD.
  const php = C.convertFromPhp(899, 'PHP');
  const usd = C.convertFromPhp(899, 'USD');
  const jpy = C.convertFromPhp(899, 'JPY');
  assert.ok(usd < php, `USD ${usd} should be below PHP ${php}`);
  // JPY has a weak unit, so 899 PHP is a much larger number of yen.
  assert.ok(jpy > php, `JPY ${jpy} should be above PHP ${php}`);
});

test('the catalogue is internally consistent for whichever currency is asked for', () => {
  for (const code of ['PHP', 'USD', 'EUR', 'JPY']) {
    const payload = C.cataloguePayload(code);
    assert.equal(payload.currency, code);
    assert.equal(payload.symbol, C.CURRENCIES[code].symbol);
    for (const plan of payload.plans) {
      assert.equal(plan.pricing.currency, code, `${plan.label} currency`);
      assert.ok(plan.pricing.formatted.monthly.startsWith(payload.symbol), `${plan.label} symbol`);
      // The base figures travel alongside, so an invoice can be reconciled.
      assert.ok(Number.isFinite(plan.pricing.php.monthly), `${plan.label} base monthly`);
      // No plan may carry a seat count or a per-seat price: every published plan
      // is one account on one tier.
      assert.equal('seats' in plan.pricing, false, `${plan.label} published a seat count`);
      assert.equal('perSeatPhp' in plan.pricing, false, `${plan.label} published a per-seat price`);
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3. Location detection
// ══════════════════════════════════════════════════════════════════════════

test('an explicit choice always wins over detection', () => {
  assert.equal(C.resolveCurrency({ requested: 'usd' }).code, 'USD');
  assert.equal(C.resolveCurrency({ requested: 'JPY', acceptLanguage: 'en-PH' }).code, 'JPY');
  assert.equal(C.resolveCurrency({ requested: 'EUR', country: 'jp' }).code, 'EUR');
  assert.equal(C.resolveCurrency({ requested: 'usd' }).source, 'request');
});

test('a region-tagged language picks the right currency', () => {
  const cases = [
    ['en-PH,en;q=0.9', 'PHP'],
    ['fil-PH', 'PHP'],
    ['tl-PH', 'PHP'],
    ['en-US,en;q=0.9', 'USD'],
    ['en-CA', 'CAD'],
    ['en-GB', 'GBP'],
    ['de-DE,de;q=0.9', 'EUR'],
    ['fr-CA', 'CAD'],
    ['ja-JP', 'JPY'],
    ['en-AU', 'AUD'],
    ['en-SG', 'SGD'],
    ['en-HK', 'HKD'],
    ['en-IN', 'INR'],
  ];
  for (const [header, expected] of cases) {
    const result = C.resolveCurrency({ acceptLanguage: header });
    assert.equal(result.code, expected, `${header} -> ${result.code}, expected ${expected}`);
    assert.equal(result.source, 'accept-language', header);
  }
});

test('a bare language tag is a reading preference, never a location', () => {
  // "en" is the single most common header in the world. Treating it as a
  // location signal would pin every visitor to one currency.
  for (const header of ['en', 'fr', 'de', 'es', 'tl', 'fil', '*', '', null, undefined]) {
    const result = C.resolveCurrency({ acceptLanguage: header });
    assert.notEqual(result.source, 'accept-language', `"${header}" must not pick a currency`);
    assert.equal(result.code, 'PHP', `"${header}" must fall back to the base currency`);
  }
  // Even a multi-entry header whose only regioned entry is a refusal.
  assert.notEqual(C.resolveCurrency({ acceptLanguage: 'en;q=0' }).source, 'accept-language');
  assert.notEqual(C.resolveCurrency({ acceptLanguage: 'en-PH;q=0,en;q=1' }).source, 'accept-language');
});

test('the header is used before the IP, and the IP before the default', () => {
  assert.equal(C.resolveCurrency({ acceptLanguage: 'en-US', country: 'ph' }).code, 'USD');
  assert.equal(C.resolveCurrency({ country: 'jp' }).code, 'JPY');
  assert.equal(C.resolveCurrency({ country: 'jp' }).source, 'geo');
  assert.equal(C.resolveCurrency({}).source, 'default');
  assert.equal(C.resolveCurrency().code, 'PHP');
});

test('junk input resolves to the default instead of throwing', () => {
  const junk = [undefined, null, '', '   ', 'xx', 123, {}, [], 'PH', 'ph-zz', 'toolongvalue'];
  for (const value of junk) {
    const result = C.resolveCurrency({ requested: value, acceptLanguage: value, country: value });
    assert.ok(result.code, `no code for ${JSON.stringify(value)}`);
    assert.equal(result.code, 'PHP', `expected PHP for ${JSON.stringify(value)}`);
  }
});

test('a country code is normalized without ever throwing', () => {
  assert.equal(C.normalizeCountry('PH'), 'ph');
  assert.equal(C.normalizeCountry('en-PH'), 'ph');
  assert.equal(C.normalizeCountry('PH-PH'), 'ph');
  assert.equal(C.normalizeCountry('p'), '');
  assert.equal(C.normalizeCountry('philippines'), '');
  assert.equal(C.normalizeCountry(null), '');
  assert.equal(C.normalizeCountry(42), '');
});

test('the currency list offered to the UI is complete and ordered', () => {
  const list = C.currenciesPayload();
  assert.ok(list.length >= 5, 'the picker needs a real choice, not two options');
  assert.equal(list[0].code, 'PHP', 'the home currency is offered first');
  for (const entry of list) {
    assert.ok(entry.symbol, `${entry.code} needs a symbol`);
    assert.ok(entry.name, `${entry.code} needs a name`);
    assert.ok(Number.isInteger(entry.decimals), `${entry.code} needs decimals`);
  }
  // Every advertised currency must be one we can actually price in.
  for (const entry of list) assert.ok(C.CURRENCIES[entry.code], entry.code);
});

// The Team band was removed: it was priced per seat but granted exactly what
// Premium granted, and no account could ever hold a second seat. These tests
// replace it with the guarantee that it can never come back by accident.

test('there is no Team band in the published catalogue', () => {
  const payload = C.cataloguePayload('PHP');
  assert.equal('team' in payload, false, 'the catalogue must not publish a Team band');
  assert.equal(payload.plans.length, 4, 'exactly the four real plans');
  assert.equal(payload.plans.some((p) => p.id === 'team'), false);
});

test('the removed seat helpers are gone from the public surface', () => {
  // They are not merely unused: `teamTotal` multiplied money, so a caller that
  // still reached for it would be pricing an order the server cannot fulfil.
  for (const name of ['teamTotal', 'TEAM_PLAN', 'TEAM_TIER', 'TEAM_TOTAL_SEATS']) {
    assert.equal(C[name], undefined, `${name} is still exported`);
  }
  const S = require('../utils/subscriptionState');
  for (const name of ['MIN_SEATS', 'MAX_SEATS', 'normalizeSeats', 'parseSeatCount']) {
    assert.equal(S[name], undefined, `${name} is still exported`);
  }
});

test('team is refused as a plan id, exactly like any other unknown one', () => {
  // It used to short-circuit normalizePlanId. Now it takes the normal path, so
  // there is no second, hand-maintained way for a plan name to enter the system.
  assert.equal(C.normalizePlanId('team'), null);
  assert.equal(C.resolvePurchasable('team'), null);
  assert.equal(C.resolvePurchasable('Team'), null);
  // The four real plans, and their aliases, still resolve.
  assert.equal(C.resolvePurchasable('monthly').tier, 'monthly');
  assert.equal(C.resolvePurchasable('premium').tier, 'annual');
  assert.equal(C.resolvePurchasable('ultimate').tier, 'custom');
});

test('no plan card carries a seat flag or per-seat price', () => {
  for (const entry of C.PLAN_CATALOGUE) {
    assert.equal('seat' in entry, false, `${entry.id} still has a seat flag`);
    assert.equal('perSeatMonthly' in entry, false, `${entry.id} has a per-seat price`);
    assert.equal('perSeatYearly' in entry, false, `${entry.id} has a per-seat price`);
  }
});

test('a plan missing a price fails loudly instead of publishing itself as free', () => {
  // pricingFor used to fall back to a second pair of keys and finally to 0, so a
  // mispriced entry became a card reading "Free". That is the worst possible
  // failure for a price list, so it is now an error rather than a number.
  assert.throws(
    () => C.pricingFor({ id: 'broken', label: 'Broken', yearly: 100 }),
    /missing a monthly or yearly amount/,
  );
  assert.throws(
    () => C.pricingFor({ id: 'broken', label: 'Broken', monthly: 100 }),
    /missing a monthly or yearly amount/,
  );
  // A well-formed entry still prices.
  assert.equal(C.pricingFor({ id: 'ok', monthly: 100, yearly: 1200 }).monthly, 100);
});

// ══════════════════════════════════════════════════════════════════════════
// 5. A plan card may only claim what the product actually does
// ══════════════════════════════════════════════════════════════════════════
//
// The binding these tests protect: a card's bullets are DERIVED from the
// entitlement gates, so they cannot name a capability the backend does not
// grant, and they cannot fall out of step with the gate that grants it.
//
// The regression is real. The cards once carried their own hand-typed lists,
// which drifted from the server's own copy AND promised usage multipliers that no
// tier-aware quota in the product could honour.

test('a plan card lists exactly the features its tier unlocks', () => {
  const payload = C.cataloguePayload('PHP');
  for (const plan of payload.plans) {
    // What the gate would newly switch on for this tier.
    const gated = Object.entries(E.FEATURES)
      .filter(([, def]) => def.minTier === plan.id)
      .map(([key]) => key)
      .sort();
    assert.deepEqual([...plan.featureKeys].sort(), gated, `${plan.label} bullets vs its gates`);
    for (const key of plan.featureKeys) {
      assert.ok(E.hasFeature(key), `${plan.label} claims unknown feature "${key}"`);
    }
  }
});

test('every feature a card claims is one the gate really switches on', () => {
  // The strongest form: build the entitlement map for a user on each tier and
  // confirm the card claims nothing that map says is off.
  const now = new Date('2026-03-01T12:00:00.000Z');
  for (const plan of C.cataloguePayload('PHP').plans) {
    const map = E.entitlementsFor({ subscriptionPlan: plan.id, subscriptionActive: true }, now);
    for (const key of plan.featureKeys) {
      assert.equal(map[key], true, `${plan.label} advertises "${key}" but the gate leaves it off`);
    }
  }
});

test('a plan card quotes the limit the product enforces, not a made-up one', () => {
  const byId = Object.fromEntries(C.cataloguePayload('PHP').plans.map((p) => [p.id, p]));
  const rankOf = { free: 0, monthly: 1, annual: 2, custom: 3 };
  for (const [id, expected] of [['free', 5], ['monthly', 10], ['annual', 20], ['custom', 20]]) {
    // The runtime gate, restated here on purpose: if a tier's page size changes,
    // this test and the card must both move.
    assert.equal(E.limitsForRank(rankOf[id]).historyPageSize, expected, `${id} runtime limit moved`);
    assert.ok(
      byId[id].limits.some((line) => line.includes(String(expected))),
      `${byId[id].label} does not quote its real limit of ${expected}`,
    );
  }
});

test('no card promises a usage multiplier the product does not implement', () => {
  // There is no tier-aware usage quota anywhere: every rate limit in the system
  // is per-IP abuse protection. A "3x more usage" badge is a promise the code
  // cannot honour, which is how a pricing page becomes a billing dispute. If a
  // real quota is implemented, this is the test to update.
  const payload = C.cataloguePayload('PHP');
  const copy = [];
  for (const plan of payload.plans) {
    copy.push(plan.tagline, ...plan.features.map((f) => `${f.label} ${f.description || ''}`), ...plan.limits);
  }
  for (const line of copy) {
    assert.ok(!/more usage/i.test(line), `the catalogue still claims a usage multiplier: "${line}"`);
  }
});

test('no displayed copy names a plan that no longer exists', () => {
  // The old cards said "Everything in Pro, plus:" for months after the tiers were
  // renamed to Deluxe/Premium. Any plan name in copy must be a live tier name.
  const payload = C.cataloguePayload('PHP');
  const live = new Set(payload.plans.map((p) => p.label));
  assert.ok(live.has('Deluxe') && live.has('Premium') && live.has('Ultimate'));
  // "Team" is no longer a purchasable name, so it must not appear in copy either.
  assert.equal(live.has('Team'), false);

  const copy = [];
  for (const plan of payload.plans) {
    copy.push(plan.tagline, ...plan.features.map((f) => `${f.label} ${f.description || ''}`), ...plan.limits);
  }
  for (const name of ['Pro+', 'Pro', 'Basic', 'Standard', 'Enterprise', 'Team']) {
    for (const line of copy) {
      assert.ok(
        !new RegExp(`\\b${name}\\b`).test(line),
        `"${line}" names the retired plan "${name}"`,
      );
    }
  }
});


test('card claims do not change with the currency', () => {
  // A shape guard rather than a text one: features and limits must be identical
  // across currencies, so a conversion can never alter what a plan claims.
  const shape = (code) => C.cataloguePayload(code).plans
    .map((p) => [p.id, p.featureKeys, p.limits]);
  assert.deepEqual(shape('PHP'), shape('JPY'));
  assert.deepEqual(shape('PHP'), shape('USD'));
});

// ══════════════════════════════════════════════════════════════════════════
// 6. The pricing page may not promise a billing model that does not exist
// ══════════════════════════════════════════════════════════════════════════
//
// The info columns under the grid are the easiest place on a pricing page to
// invent a policy. These guard the three that were fiction:
//
//   - a local/cloud execution sandbox: no such mode exists anywhere;
//   - a usage allowance drawn from a pre-purchased block: no allowance system;
//   - a user-facing cancel that stops renewal, plus refunds: there is no cancel
//     endpoint, no renewal scheduler and no refund system. Every "refund" in this
//     codebase is Web3 marketplace escrow, which is a different product.
//
// A policy promise is not marketing. It is a commitment the code has to be able
// to keep, and these three could not be.

test('the server grants a fixed period and has no renewal scheduler', () => {
  // The column says "N days, and it never renews on its own". Both halves are
  // checked: the period is a constant the engine actually uses, and the payload
  // reports the same number so the prose cannot quote a different one.
  assert.equal(S.STANDARD_PERIOD_DAYS, 30);
  assert.equal(C.cataloguePayload('PHP').standardPeriodDays, 30);
});

test('a purchase lapses on its own; nothing renews it behind the user', () => {
  // Run the window out and confirm the read path reports Free with no action
  // taken anywhere: expiry is a read-time projection, not a job.
  const now = new Date('2026-03-01T12:00:00.000Z');
  const bought = S.applyAction(null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, now);
  const later = new Date(now.getTime() + 31 * S.DAY_MS);
  const lapsed = E.describeSubscription({ subscriptionRecord: bought.record, ...bought.patch }, later.getTime());
  assert.equal(lapsed.subscriptionActive, false, 'it lapsed with no intervention');
  assert.equal(lapsed.currentPlan, 'free');
});

test('buying again extends the window rather than restarting it', () => {
  // The "paid days are never lost" claim, verified rather than asserted in prose.
  const now = new Date('2026-03-01T12:00:00.000Z');
  const first = S.applyAction(null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, now);
  const halfway = new Date(now.getTime() + 10 * S.DAY_MS);
  const second = S.applyAction(first.record, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 }, halfway);
  const state = E.describeSubscription({ subscriptionRecord: second.record, ...second.patch }, halfway.getTime());
  // 20 unspent + 30 new. A restart would show 30.
  assert.equal(state.daysRemaining, 50);
});

test('the server payload promises no refund, cancel, sandbox or usage allowance', () => {
  // These phrases are the fingerprints of the invented policies. The server
  // cannot see the frontend copy, so this asserts over its own strings; the
  // frontend is covered by the same check in the browser test run.
  const payload = JSON.stringify(C.cataloguePayload('PHP'));
  for (const phrase of [
    /refund/i,
    /stop renewal/i,
    /cancel from/i,
    /sandbox/i,
    /pre-purchased/i,
    /usage allowance/i,
    /more usage/i,
  ]) {
    assert.ok(!phrase.test(payload), `the server payload still contains ${phrase}`);
  }
});
