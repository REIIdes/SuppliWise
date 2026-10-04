/**
 * Plan requests: "I paid by transfer" — the pricing page's proof-of-payment
 * hand-off to the admin queue.
 *
 * This is the one path where a bug costs real money in both directions: a
 * validator that lets a ₱1 receipt through as a Premium purchase, or an approval
 * that grants the wrong plan or the wrong seat count. So it is tested as a
 * contract, from both ends:
 *
 *   1. the validators refuse everything they must (wrong type, script vector,
 *      oversized, out-of-range seats, free plan);
 *   2. pricing is DERIVED from the catalogue, never read from the body;
 *   3. approving a request produces exactly the subscriptionState `setPaid`
 *      write the purchase endpoint would have produced — same plan, same term,
 *      same seat count — so the two routes cannot drift apart.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const R = require('../utils/subscriptionRequests');
const C = require('../utils/planCatalogue');
const S = require('../utils/subscriptionState');
const E = require('../utils/entitlements');

/** A real 1x1 PNG as a data URL — the smallest thing that passes the parser. */
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const NOW = new Date('2026-03-01T12:00:00.000Z');

/**
 * A peso amount as the catalogue formats it.
 *
 * The formatted string is produced by `formatAmount`, not retyped here: PHP has
 * no minor unit, so it prints as `₱699`, and restating it with `toLocaleString`
 * produced `?699` on a machine whose console cannot render the glyph — a test
 * that fails on encoding rather than on behaviour.
 */
const formatPeso = (php) => C.formatAmount(php, 'PHP');

/**
 * Apply a subscription action the way every route does. `applyAction` takes the
 * RECORD (not the user document) and builds the top-level patch itself, so a
 * route's whole write is `subscriptionRecord: result.record, ...result.patch`.
 */
function apply(record, action, opts, now = NOW) {
  return S.applyAction(record, action, opts, now);
}

/** The state a route would store and then hand back to the client. */
function stateOf(result, now = NOW) {
  return E.describeSubscription(
    { subscriptionRecord: result.record, ...result.patch },
    now.getTime(),
  );
}

// ══════════════════════════════════════════════════════════════════════════
// 1. The proof image
// ══════════════════════════════════════════════════════════════════════════

test('a real PNG data URL is accepted and measured', () => {
  const proof = R.parseProofImage(PNG_1PX);
  assert.equal(proof.ok, true);
  assert.equal(proof.mime, 'image/png');
  assert.ok(proof.bytes > 0);
  assert.equal(proof.dataUrl, PNG_1PX);
});

test('JPEG and WebP are accepted; the allowed set is exactly three types', () => {
  assert.deepEqual(R.ALLOWED_PROOF_MIME, ['image/png', 'image/jpeg', 'image/webp']);
  for (const mime of R.ALLOWED_PROOF_MIME) {
    const proof = R.parseProofImage(`data:${mime};base64,QUJD`);
    assert.equal(proof.ok, true, mime);
    assert.equal(proof.mime, mime);
  }
});

test('an SVG data URL is refused — it is a stored-XSS vector, not a receipt', () => {
  // <svg onload=alert(1)> is valid base64 target and would render if stored.
  const svg = `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`;
  const proof = R.parseProofImage(svg);
  assert.equal(proof.ok, false, 'an SVG must never be stored');
  assert.equal(proof.status, 400);
  // A non-base64 data URL claiming to be a PNG is refused too.
  assert.equal(R.parseProofImage('data:image/png,<svg onload="alert(1)"/>').ok, false);
  // A bare base64 blob with no data-URL header has no declared type, so it is
  // refused rather than sniffed.
  assert.equal(R.parseProofImage('QUJD').ok, false);
});

test('a payload with trailing junk after the base64 is refused', () => {
  // Anchored end-to-end on purpose: without the `$`, a valid image could smuggle
  // a second payload past the alphabet check.
  assert.equal(R.parseProofImage(`${PNG_1PX}extra`).ok, false);
  assert.equal(R.parseProofImage(`${PNG_1PX} `).ok, true, 'whitespace is compacted, not junk');
  assert.equal(R.parseProofImage(`${PNG_1PX}\n`).ok, true, 'line breaks are compacted');
  assert.equal(R.parseProofImage(`${PNG_1PX}\nrm -rf /`).ok, false);
});

test('an oversized image is refused with 413, not 400', () => {
  // The two ceilings are derived from one another, so the data-URL limit can
  // never be stricter than what a legitimately-sized file produces.
  const budget = R.MAX_PROOF_DATA_URL_BYTES;
  const atCap = `data:image/png;base64,${'A'.repeat(budget - 30)}`;
  assert.ok(R.parseProofImage(atCap).ok, 'a payload just inside the derived cap must pass');
  const overCap = `data:image/png;base64,${'A'.repeat(budget + 64)}`;
  const proof = R.parseProofImage(overCap);
  assert.equal(proof.ok, false);
  assert.equal(proof.status, 413, 'too large is 413, not a 400 about the format');
  // The derivation itself: 4/3 inflation of a 2 MB file, plus a small header.
  assert.ok(
    R.MAX_PROOF_DATA_URL_BYTES > R.MAX_PROOF_IMAGE_BYTES,
    'the stored string must be allowed to exceed the file size it encodes',
  );
  assert.ok(
    R.MAX_PROOF_DATA_URL_BYTES < R.MAX_PROOF_IMAGE_BYTES * 1.5,
    'but not by an absurd margin, or the 2 MB file limit would be a fiction',
  );
});

test('a missing or non-string proof is refused, never defaulted', () => {
  for (const value of [undefined, null, '', 0, 42, {}, [], true]) {
    const proof = R.parseProofImage(value);
    assert.equal(proof.ok, false, String(value));
    assert.equal(proof.status, 400);
  }
});

// 2. What is being requested
//
// A request is one account on one plan. The Team concept (a per-seat multiplier
// on Premium) was removed, so there is no seat count to accept, reject, clamp
// or bill — and `plan: 'team'` is now simply an unknown id.

test('the removed Team id is refused as an unknown plan', () => {
  for (const input of ['team', 'Team', 'TEAM', ' team ', 'team', 'team-seats']) {
    const planned = R.resolveRequestedPlan(input);
    assert.equal(planned.ok, false, `${input} must not resolve`);
    assert.equal(planned.status, 400);
    assert.match(planned.message, /valid plan/i);
  }
});

test('a request carries no seat fields, whatever the body sent', () => {
  const planned = R.resolveRequestedPlan('annual');
  assert.equal(planned.ok, true);
  assert.deepEqual(Object.keys(planned).sort(), ['ok', 'plan'], 'only a plan comes back');
  assert.equal('isTeam' in planned, false);
  assert.equal('seats' in planned, false);
});

test('individual plans resolve through their aliases, and free is refused clearly', () => {
  for (const [input, expected] of [
    ['monthly', 'monthly'],
    ['deluxe', 'monthly'],
    ['annual', 'annual'],
    ['premium', 'annual'],
    ['custom', 'custom'],
    ['ultimate', 'custom'],
    ['  ANNUAL  ', 'annual'],
  ]) {
    const planned = R.resolveRequestedPlan(input);
    assert.equal(planned.ok, true, input);
    assert.equal(planned.plan, expected, input);
    // The stored id is one the subscription engine knows.
    assert.ok(R.REQUESTABLE_PLANS.includes(planned.plan), input);
  }
  const free = R.resolveRequestedPlan('free');
  assert.equal(free.ok, false);
  assert.match(free.message, /already yours/i, 'free gets its own message, not \"invalid plan\"');
  for (const junk of ['platinum', '', null, undefined, 0, {}]) {
    const nonsense = R.resolveRequestedPlan(junk);
    assert.equal(nonsense.ok, false, JSON.stringify(junk));
    assert.match(nonsense.message, /valid plan/i);
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 3. The term
// ══════════════════════════════════════════════════════════════════════════

test('the term is clamped to whole months inside [1, 12]', () => {
  assert.equal(R.clampMonths(undefined), S.STANDARD_PERIOD_MONTHS);
  assert.equal(R.clampMonths(null), S.STANDARD_PERIOD_MONTHS);
  assert.equal(R.clampMonths('nope'), S.STANDARD_PERIOD_MONTHS);
  assert.equal(R.clampMonths(0), S.STANDARD_PERIOD_MONTHS);
  assert.equal(R.clampMonths(-5), S.STANDARD_PERIOD_MONTHS);
  assert.equal(R.clampMonths(1), 1);
  assert.equal(R.clampMonths(6.4), 6);
  assert.equal(R.clampMonths('12'), 12);
  assert.equal(R.clampMonths(13), R.MAX_MONTHS);
  assert.equal(R.clampMonths(9999), R.MAX_MONTHS);
});


// 4. Pricing - derived, never read from the body
//
// The amount is looked up from the catalogue for the named plan and term. There
// is no multiplier to apply, so a client-supplied `seats` can no longer change
// what a request is worth even if the field is still sent by a stale client.

test('a request is priced from the catalogue, and months > 1 bills yearly', () => {
  const entry = C.findEntry('annual');
  const monthly = R.priceRequest('annual', 1, 'PHP');
  assert.equal(monthly.amountPhp, entry.monthly);
  assert.equal(monthly.formattedAmount, formatPeso(entry.monthly));
  // No per-seat pair survives on the priced row.
  assert.equal('perSeatPhp' in monthly, false);
  assert.equal('perSeatFormatted' in monthly, false);

  const yearly = R.priceRequest('annual', 12, 'PHP');
  assert.equal(yearly.amountPhp, entry.yearly);
  assert.ok(yearly.amountPhp < entry.monthly * 12, 'the yearly rate is genuinely cheaper');
});

test('every priced row is exactly the catalogue price for its plan and term', () => {
  // The whole point of the two paths agreeing: an admin checks a bank transfer
  // against the figure on the receipt, and that figure must be the catalogue's
  // number rather than a second calculation that can drift from it.
  for (const plan of ['monthly', 'annual', 'custom']) {
    for (const [months, unit] of [[1, 'monthly'], [12, 'yearly']]) {
      const request = R.priceRequest(plan, months, 'PHP');
      const entry = C.findEntry(plan);
      assert.ok(request, `${plan} ${unit} priced`);
      assert.equal(request.amountPhp, entry[unit], `${plan} ${unit}`);
      assert.equal(request.formattedAmount, formatPeso(entry[unit]), `${plan} ${unit}`);
    }
  }
});

test('a request prices identically to a purchase of the same plan and term', () => {
  // Spelled out through the purchase route's own arithmetic rather than a shared
  // helper, because the failure this guards is the two disagreeing.
  for (const plan of ['monthly', 'annual', 'custom']) {
    for (const [months, unit] of [[1, 'monthly'], [12, 'yearly']]) {
      const entry = C.findEntry(plan);
      const expectedPhp = months > 1 ? entry.yearly : entry.monthly;
      const request = R.priceRequest(plan, months, 'PHP');
      const purchase = months > 1 ? entry.yearly : entry.monthly;
      assert.equal(request.amountPhp, expectedPhp, `${plan} ${unit} request`);
      assert.equal(request.amountPhp, purchase, `${plan} ${unit} purchase`);
    }
  }
});

test('a zero-cost request is refused, so a skipped validation cannot reach the queue', () => {
  // The Free plan IS in the catalogue, so findEntry finds it - at ?0. A ?0 row
  // in the admin queue looks like a real purchase that costs nothing, so
  // priceRequest refuses it rather than trusting every caller to have checked.
  assert.equal(R.priceRequest('free', 1, 'PHP'), null);
  assert.equal(R.priceRequest('platinum', 1, 'PHP'), null);
  assert.equal(R.priceRequest(undefined, 1, 'PHP'), null);
  assert.equal(R.priceRequest(null, 12, 'PHP'), null);
  // …and the removed Team id lands in the same refusal.
  assert.equal(R.priceRequest('team', 1, 'PHP'), null);
});

test('an unknown currency falls back to the default rather than pricing at 0', () => {
  for (const plan of ['monthly', 'annual', 'custom']) {
    const priced = R.priceRequest(plan, 1, 'XYZ');
    assert.ok(priced, `${plan}: a bad currency must not make the request unpriceable`);
    assert.equal(priced.currency, C.DEFAULT_CURRENCY, plan);
    assert.equal(priced.amountPhp, C.findEntry(plan).monthly, plan);
    assert.ok(Number.isFinite(priced.amount) && priced.amount > 0, plan);
    assert.doesNotMatch(priced.formattedAmount, /NaN|Infinity|undefined/, plan);
  }
});

test('free text is trimmed, collapsed and truncated to its cap', () => {
  assert.equal(R.cleanText('  GC1234  ', R.MAX_REFERENCE_LENGTH), 'GC1234');
  assert.equal(R.cleanText(undefined, 10), '');
  assert.equal(R.cleanText(null, 10), '');
  // A non-string is dropped rather than coerced: a JSON body can send a number
  // or an object here, and neither is text a reviewer should see.
  assert.equal(R.cleanText(12345, 10), '');
  assert.equal(R.cleanText({}, 10), '');
  assert.equal(R.cleanText('x'.repeat(500), 80).length, 80);
  assert.equal(R.cleanText('x'.repeat(500), R.MAX_NOTE_LENGTH).length, R.MAX_NOTE_LENGTH);
  // Newlines collapse, because these render inline in the queue's row layout.
  assert.equal(R.cleanText('a\n\n  b\tc', 100), 'a b c');
});

// 5. Approval produces the same subscription the purchase would have

test('approving a monthly request grants exactly 30 days on that tier', () => {
  const planned = R.resolveRequestedPlan('monthly');
  const result = apply(null, 'setPaid', {
    actor: 'admin:Devs',
    plan: planned.plan,
    days: R.clampMonths(1) * S.STANDARD_PERIOD_DAYS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.patch.subscriptionPlan, 'monthly');
  assert.equal(result.patch.subscriptionActive, true);
  const state = stateOf(result);
  assert.equal(state.daysRemaining, 30);
  // No seat fields on the projected state an old client would still read.
  assert.equal('subscriptionSeats' in state, false);
  assert.equal('subscriptionIsTeam' in state, false);
});

test('a 12-month request grants 360 days, not 30', () => {
  const days = R.clampMonths(12) * S.STANDARD_PERIOD_DAYS;
  assert.equal(days, 360);
  const result = apply(null, 'setPaid', { actor: 'admin:Devs', plan: 'annual', days });
  assert.equal(stateOf(result).daysRemaining, 360);
});

test('an approved renewal extends the paid window instead of replacing it', () => {
  // A user who paid, then sent a renewal request for the SAME plan, must not lose
  // the days they already paid for. This is the `setPaid` renewal rule,
  // exercised on the request path so an approval cannot quietly truncate a paid
  // subscription.
  const first = apply(null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 });
  const midway = new Date(NOW.getTime() + 10 * S.DAY_MS);
  const second = apply(first.record, 'setPaid', { actor: 'admin:Devs', plan: 'annual', days: 30 }, midway);
  // 30 paid, 20 still unspent on the old window, then 30 more granted.
  assert.equal(stateOf(second, midway).daysRemaining, 50);
  assert.equal(second.replaced, false, 'renewing the same plan replaces nothing');
});

test('approving a request for a DIFFERENT plan replaces what was paid for', () => {
  // The other half of the rule, on the path an admin actually presses. Approving
  // a Deluxe request for someone holding 300 days of Ultimate gives 30 days of
  // Deluxe — the reviewer granted exactly the plan on the receipt.
  const paid = apply(null, 'setPaid', { actor: 'payment', plan: 'custom', days: 300 });
  const midway = new Date(NOW.getTime() + 10 * S.DAY_MS);
  const approved = apply(paid.record, 'setPaid', {
    actor: 'admin:Devs', plan: 'monthly', days: 30,
  }, midway);
  const state = stateOf(approved, midway);
  assert.equal(state.currentPlan, 'monthly');
  assert.equal(state.daysRemaining, 30, '30 granted days, not 30 on top of 290');
  assert.equal(approved.replaced, true);
  assert.equal(approved.forfeitedDays, 290);
});

test('an approval on top of an admin override leaves the override restorable', () => {
  // Approving a payment is a PAID-layer write. If an admin override is in force
  // the effective state must stay the override's, and "restore original" must
  // still put the paid subscription back underneath it.
  //
  // The approval is for `custom`, which is the SAME plan the override granted —
  // deliberately, so this test isolates the override mechanics from the
  // replacement rule. Switching plans here would forfeit the 30 paid days and
  // `restoreTarget` would correctly show 0, which is a different test.
  const paid = apply(null, 'setPaid', { actor: 'payment', plan: 'custom', days: 30 });
  const granted = apply(paid.record, 'grant', { actor: 'admin:Devs', plan: 'custom', days: 10 });
  assert.equal(granted.ok, true);

  const approved = apply(granted.record, 'setPaid', {
    actor: 'admin:Devs', plan: 'custom', days: 30,
  });
  assert.equal(approved.replaced, false, 'renewing the same plan forfeits nothing');
  const during = S.describeRecord(
    { subscriptionRecord: approved.record, ...approved.patch }, NOW.getTime(),
  );
  assert.equal(during.override.active, true, 'the override still wins');
  assert.equal(during.canRestore, true);
  assert.equal(during.paid.daysRemaining, 60, 'the paid window is the approved one');
  // `restoreTarget` is the public shape of the frozen snapshot; the raw
  // `restore` object is deliberately not part of the admin panel's payload, so
  // the remaining time is reported as the count captured when the override
  // began rather than recomputed (which would decay as days pass).
  assert.equal(during.restoreTarget.capturedDaysRemaining, 60, 'restore returns the paid window');

  const restored = apply(approved.record, 'restore', { actor: 'admin:Devs' });
  const after = S.describeRecord(
    { subscriptionRecord: restored.record, ...restored.patch }, NOW.getTime(),
  );
  assert.equal(after.override.active, false);
  assert.equal(after.effective.plan, 'custom');
});

// ══════════════════════════════════════════════════════════════════════════
// 6. What the queue is allowed to receive
// ══════════════════════════════════════════════════════════════════════════

test('the request summary hides the image but reports that one exists', () => {
  // The admin queue must not ship 2 MB of base64 to every list render.
  const doc = { _id: 'r1', plan: 'annual', status: 'pending', proof: PNG_1PX, reference: 'GC1', note: '' };
  const summary = R.toSummary(doc);
  assert.equal(summary.proof, undefined, 'the image itself is not in the list payload');
  assert.equal(summary.hasProof, true);
  assert.equal(summary.reference, 'GC1');
  assert.equal(R.toSummary({ ...doc, proof: '' }).hasProof, false);
  assert.equal(R.toSummary(null), null);
});

test('hasProof is still true for a row the projection already stripped', () => {
  // THE REGRESSION THIS GUARDS: the list query selects LIST_FIELDS, which does
  // not include `proof`. Deriving hasProof from `proof` therefore made it
  // permanently false for every real list render — so the admin queue told
  // every reviewer that a request had no receipt attached, on requests that had
  // one. The stored metadata is what survives the projection.
  const projected = {
    _id: 'r2', plan: 'annual', status: 'pending',
    proofMime: 'image/png', proofBytes: 118, formattedAmount: '₱1,700',
  };
  const summary = R.toSummary(projected);
  assert.equal(summary.proof, undefined);
  assert.equal(summary.hasProof, true, 'a projected row with proof metadata has a proof');
  // A row genuinely without one is still reported honestly.
  assert.equal(R.toSummary({ ...projected, proofBytes: 0 }).hasProof, false);
  assert.equal(R.toSummary({ ...projected, proofMime: '' }).hasProof, false);
  // …and the metadata itself is still available for display.
  assert.equal(summary.proofMime, 'image/png');
  assert.equal(summary.proofBytes, 118);
});

test('the list projection does not select the proof image', () => {
  // Defence in depth: even if toSummary were bypassed, the query must not
  // select a multi-megabyte string for a list. LIST_FIELDS is a space-joined
  // projection string, so it is compared field-by-field — a bare `includes`
  // would trip over `proofMime` and `proofBytes`.
  const fields = R.LIST_FIELDS.split(/\s+/).filter(Boolean);
  assert.equal(fields.includes('proof'), false, 'LIST_FIELDS must not select the image');
  // The image's metadata is fine — it is kilobytes, not megabytes.
  assert.ok(fields.includes('proofMime'));
  assert.ok(fields.includes('proofBytes'));
  for (const field of ['user', 'plan', 'months', 'formattedAmount', 'status', 'paymentRequired']) {
    assert.ok(fields.includes(field), `LIST_FIELDS is missing ${field}`);
  }
  // …and the removed per-seat fields are gone from the projection, so a queue
  // render cannot still be reading a count the schema no longer stores.
  for (const field of ['isTeam', 'seats', 'perSeatPhp', 'perSeatFormatted']) {
    assert.equal(fields.includes(field), false, `LIST_FIELDS still selects ${field}`);
  }
});

test('the term cap is enforced identically in both places that read it', () => {
  // `clampMonths` is what bounds a request, and `STANDARD_PERIOD_DAYS` is what
  // turns it into days. If either moved alone, a 12-month request would promise
  // a term the approval route could not grant.
  assert.equal(R.MAX_MONTHS, 12);
  assert.equal(R.clampMonths(13), R.MAX_MONTHS, 'an over-long term clamps, it does not grow');
  assert.equal(R.clampMonths(9999), R.MAX_MONTHS);
  assert.equal(S.MAX_ADMIN_DAYS, 3650, 'an approval can grant at most ten years');
  assert.equal(S.STANDARD_PERIOD_DAYS * R.MAX_MONTHS, 360);
});
