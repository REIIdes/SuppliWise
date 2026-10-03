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

// ══════════════════════════════════════════════════════════════════════════
// 2. What is being requested
// ══════════════════════════════════════════════════════════════════════════

test('a Team request stores the tier its seats grant, not a "team" plan', () => {
  const planned = R.resolveRequestedPlan('team', 5);
  assert.equal(planned.ok, true);
  assert.equal(planned.isTeam, true);
  assert.equal(planned.plan, C.TEAM_PLAN.tier);
  assert.equal(planned.plan, 'annual', 'a seat grants Premium entitlements');
  assert.equal(planned.seats, 5);
  // …and the stored plan id is one the subscription engine knows.
  assert.ok(R.REQUESTABLE_PLANS.includes(planned.plan));
});

test('a Team request of one seat is refused rather than quietly upgraded', () => {
  // Team starts at 2. Bumping a "1 seat" order to the minimum would bill for
  // something the user did not ask for.
  for (const seats of [0, 1, -4]) {
    const planned = R.resolveRequestedPlan('team', seats);
    assert.equal(planned.ok, false, `seats=${seats}`);
    assert.equal(planned.status, 400);
  }
  const bad = R.resolveRequestedPlan('team', 'abc');
  assert.equal(bad.ok, false, 'a value that names no number is refused, not guessed');
});

test('seat counts above the ceiling are refused, not clamped into a big bill', () => {
  // Silently turning 5000 into 500 would show an invoice the customer never
  // agreed to, so the request is rejected and the UI can explain.
  const over = R.resolveRequestedPlan('team', C.TEAM_PLAN.maxSeats + 1);
  assert.equal(over.ok, false, 'one seat over the cap is a refusal, not a clamp');
  const atCap = R.resolveRequestedPlan('team', C.TEAM_PLAN.maxSeats);
  assert.equal(atCap.ok, true);
  assert.equal(atCap.seats, C.TEAM_PLAN.maxSeats);
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
    const planned = R.resolveRequestedPlan(input, 1);
    assert.equal(planned.ok, true, input);
    assert.equal(planned.plan, expected, input);
    assert.equal(planned.isTeam, false, input);
    assert.equal(planned.seats, 1, input);
  }
  const free = R.resolveRequestedPlan('free', 1);
  assert.equal(free.ok, false);
  assert.match(free.message, /already yours/i, 'free gets its own message, not "invalid plan"');
  const nonsense = R.resolveRequestedPlan('platinum', 1);
  assert.equal(nonsense.ok, false);
  assert.match(nonsense.message, /valid plan/i);
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

// ══════════════════════════════════════════════════════════════════════════
// 4. Pricing — derived, never read from the body
// ══════════════════════════════════════════════════════════════════════════

test('a request is priced from the catalogue, and months > 1 bills yearly', () => {
  const entry = C.findEntry('annual');
  const monthly = R.priceRequest('annual', 1, 'PHP', { isTeam: false, seats: 1 });
  assert.equal(monthly.amountPhp, entry.monthly);
  assert.equal(monthly.formattedAmount, `₱${entry.monthly.toLocaleString('en-US')}`);
  // Both halves of the per-seat pair are Team-only. Setting `perSeatPhp` here
  // while `perSeatFormatted` stayed null made the admin queue's
  // "₱3,495 (₱699 × 5)" line read "₱699 × 1" on a plan with no seats.
  assert.equal(monthly.perSeatPhp, null);
  assert.equal(monthly.perSeatFormatted, null);

  const yearly = R.priceRequest('annual', 12, 'PHP', { isTeam: false, seats: 1 });
  assert.equal(yearly.amountPhp, entry.yearly);
  assert.ok(yearly.amountPhp < entry.monthly * 12, 'the yearly rate is genuinely cheaper');
});

test('a Team request multiplies the per-seat price by the seat count', () => {
  const row = R.priceRequest(C.TEAM_PLAN.tier, 1, 'PHP', { isTeam: true, seats: 5 });
  assert.equal(row.perSeatPhp, C.TEAM_PLAN.perSeatMonthly);
  assert.equal(row.amountPhp, C.teamTotal(C.TEAM_PLAN.perSeatMonthly, 5));
  // The per-seat figure is kept so a reviewer can check the total at a glance.
  assert.equal(row.perSeatFormatted, `₱${C.TEAM_PLAN.perSeatMonthly.toLocaleString('en-US')}`);
  // And it agrees exactly with what POST /purchase would charge.
  assert.equal(row.amountPhp, C.teamTotal(699, 5));
});

test('a request prices identically to a purchase of the same plan and seats', () => {
  // The whole point of the two paths agreeing: an admin checks a bank transfer
  // against the figure on the receipt, and that figure must be the purchase
  // price, not a second, drifting calculation.
  for (const [plan, isTeam, seats] of [
    ['monthly', false, 1],
    ['annual', false, 1],
    ['custom', false, 1],
    [C.TEAM_PLAN.tier, true, 3],
    [C.TEAM_PLAN.tier, true, 25],
  ]) {
    for (const [months, unit] of [[1, 'monthly'], [12, 'yearly']]) {
      const request = R.priceRequest(plan, months, 'PHP', { isTeam, seats });
      const entry = C.findEntry(plan);
      const unitPhp = isTeam
        ? (months > 1 ? C.TEAM_PLAN.perSeatYearly : C.TEAM_PLAN.perSeatMonthly)
        : (months > 1 ? entry.yearly : entry.monthly);
      assert.ok(request, `${isTeam ? `team x${seats}` : plan} ${unit} priced`);
      assert.equal(
        request.amountPhp,
        C.teamTotal(unitPhp, isTeam ? seats : 1),
        `${isTeam ? `team x${seats}` : plan} ${unit}`,
      );
    }
  }
});

test('a ₱0 request is refused, so a skipped validation cannot reach the queue', () => {
  // The Free plan IS in the catalogue, so findEntry finds it — at ₱0. A ₱0 row
  // in the admin queue looks like a real purchase that costs nothing, so
  // priceRequest refuses it rather than trusting every caller to have checked.
  assert.equal(R.priceRequest('free', 1, 'PHP', {}), null);
  assert.equal(R.priceRequest('platinum', 1, 'PHP', {}), null);
  assert.equal(R.priceRequest(undefined, 1, 'PHP', {}), null);
  assert.equal(R.priceRequest(null, 12, 'PHP', {}), null);
});

test('an unknown currency falls back to the default rather than pricing at 0', () => {
  const priced = R.priceRequest('annual', 1, 'XYZ', { isTeam: false, seats: 1 });
  assert.ok(priced, 'a bad currency must not make the request unpriceable');
  assert.equal(priced.currency, C.DEFAULT_CURRENCY);
  assert.equal(priced.amountPhp, C.findEntry('annual').monthly);
  // A converted amount is present and sane, never NaN.
  assert.ok(Number.isFinite(priced.amount) && priced.amount > 0);
  assert.doesNotMatch(priced.formattedAmount, /NaN|Infinity|undefined/);
  // A Team total in a bad currency is still a real number of seats' worth.
  const team = R.priceRequest(C.TEAM_PLAN.tier, 1, 'XYZ', { isTeam: true, seats: 4 });
  assert.equal(team.amountPhp, C.teamTotal(C.TEAM_PLAN.perSeatMonthly, 4));
  assert.ok(Number.isFinite(team.amount) && team.amount > 0);
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

// ══════════════════════════════════════════════════════════════════════════
// 5. Approval produces the same subscription the purchase would have
// ══════════════════════════════════════════════════════════════════════════

test('approving a monthly request grants exactly 30 days on that tier', () => {
  const planned = R.resolveRequestedPlan('monthly', 1);
  const result = apply(null, 'setPaid', {
    actor: 'admin:Devs',
    plan: planned.plan,
    days: R.clampMonths(1) * S.STANDARD_PERIOD_DAYS,
    seats: planned.isTeam ? planned.seats : 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.patch.subscriptionPlan, 'monthly');
  assert.equal(result.patch.subscriptionActive, true);
  const state = stateOf(result);
  assert.equal(state.daysRemaining, 30);
  assert.equal(state.subscriptionSeats, 1);
  assert.equal(state.subscriptionIsTeam, false);
});

test('approving a Team request grants Premium entitlements across its seats', () => {
  const planned = R.resolveRequestedPlan('team', 8);
  const result = apply(null, 'setPaid', {
    actor: 'admin:Devs',
    plan: planned.plan,
    days: R.clampMonths(1) * S.STANDARD_PERIOD_DAYS,
    seats: planned.seats,
  });
  assert.equal(result.ok, true);
  assert.equal(result.patch.subscriptionPlan, 'annual', 'a Team seat grants Premium');
  assert.equal(result.patch.subscriptionSeats, 8);

  const state = stateOf(result);
  assert.equal(state.currentPlan, 'annual');
  assert.equal(state.entitlements.priorityAssessment, true);
  assert.equal(state.entitlements.chat, false, 'a seat is not an Ultimate seat');
  assert.equal(state.subscriptionSeats, 8);
  assert.equal(state.subscriptionIsTeam, true);
  assert.equal(state.daysRemaining, 30);
});

test('a 12-month request grants 360 days, not 30', () => {
  const days = R.clampMonths(12) * S.STANDARD_PERIOD_DAYS;
  assert.equal(days, 360);
  const result = apply(null, 'setPaid', { actor: 'admin:Devs', plan: 'annual', days });
  assert.equal(stateOf(result).daysRemaining, 360);
});

test('an approved renewal extends the paid window instead of replacing it', () => {
  // A user who paid, then sent a renewal request, must not lose the days they
  // already paid for. This is the `setPaid` renewal rule, exercised on the
  // request path so an approval cannot quietly truncate a paid subscription.
  const first = apply(null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30 });
  const midway = new Date(NOW.getTime() + 10 * S.DAY_MS);
  const second = apply(first.record, 'setPaid', { actor: 'admin:Devs', plan: 'annual', days: 30 }, midway);
  // 30 paid, 20 still unspent on the old window, then 30 more granted.
  assert.equal(stateOf(second, midway).daysRemaining, 50);
});

test('an approval on top of an admin override leaves the override restorable', () => {
  // Approving a payment is a PAID-layer write. If an admin override is in force
  // the effective state must stay the override's, and "restore original" must
  // still put the paid subscription back underneath it.
  const paid = apply(null, 'setPaid', { actor: 'payment', plan: 'annual', days: 30, seats: 4 });
  const granted = apply(paid.record, 'grant', { actor: 'admin:Devs', plan: 'custom', days: 10 });
  assert.equal(granted.ok, true);

  const approved = apply(granted.record, 'setPaid', {
    actor: 'admin:Devs', plan: 'custom', days: 30, seats: 4,
  });
  const during = S.describeRecord(
    { subscriptionRecord: approved.record, ...approved.patch }, NOW.getTime(),
  );
  assert.equal(during.override.active, true, 'the override still wins');
  assert.equal(during.paid.seats, 4, 'the paid seats are untouched by the override');
  assert.equal(during.canRestore, true);
  // `restoreTarget` is the public shape of the frozen snapshot; the raw
  // `restore` object is deliberately not part of the admin panel's payload.
  assert.equal(during.restoreTarget.seats, 4, 'the restore target names the paid seats');

  const restored = apply(approved.record, 'restore', { actor: 'admin:Devs' });
  const after = S.describeRecord(
    { subscriptionRecord: restored.record, ...restored.patch }, NOW.getTime(),
  );
  assert.equal(after.override.active, false);
  assert.equal(after.effective.plan, 'custom');
  assert.equal(after.effective.seats, 4);
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
  for (const field of ['user', 'plan', 'months', 'isTeam', 'seats', 'formattedAmount', 'status']) {
    assert.ok(fields.includes(field), `LIST_FIELDS is missing ${field}`);
  }
});

test('the caps the catalogue and the request validator share cannot drift', () => {
  // Three places mention the seat ceiling. If they drift, the pricing page
  // offers a seat count the server refuses.
  assert.equal(C.TEAM_PLAN.maxSeats, S.MAX_SEATS);
  assert.equal(R.MAX_MONTHS, 12);
  assert.equal(S.MAX_ADMIN_DAYS, 3650, 'an approval can grant at most ten years');
  assert.equal(S.STANDARD_PERIOD_DAYS * R.MAX_MONTHS, 360);
});
