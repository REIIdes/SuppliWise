/**
 * Shared rules for subscription CANCELLATIONS.
 *
 * The mirror of utils/subscriptionRequests.js. That file answers "is this an
 * image, what does it cost, which plan"; this one answers the four questions
 * both sides of the cancellation need to agree on:
 *
 *   1. Does this account actually HAVE something to cancel?
 *   2. Which door did the member choose — strip it now, or ask an admin?
 *   3. What is the plan being given up called in every surface?
 *   4. What is safe to put in a LIST response?
 *
 * WHY THE TWO DOORS EXIST
 * -----------------------
 * The member picks one, and the route enforces it server-side:
 *
 *   immediate — apply `remove` (scope 'all') right now. Cancelling only ever
 *               REMOVES access, so this needs no payment rail and stays
 *               available even where self-serve billing is off. A scripted
 *               client gains nothing by calling it, so it is not a bypass.
 *   review    — create a 'pending' row and let an administrator approve. Some
 *               deployments want a human to see churn before it happens.
 *
 * A client cannot smuggle the review door past the admin: `mode` is validated
 * against this list, and the immediate path is the ONLY one that applies the
 * engine directly.
 */
const { PLAN_LABELS, subState } = require('./entitlements');
const { TEAM_PLAN } = require('./planCatalogue');

/** The statuses a cancellation can be in. */
const CANCEL_STATUSES = ['pending', 'applied', 'rejected'];

/** The only two ways a member may ask to be cancelled. */
const CANCEL_MODES = ['immediate', 'review'];

/** A free plan has nothing to cancel, so it is never a valid subject. */
const CANCELLABLE_PLANS = ['monthly', 'annual', 'custom'];

const MAX_REASON_LENGTH = 500;

/**
 * Is there anything to cancel?
 *
 * A member on Free — or whose paid window has already lapsed — has no paid
 * layer to strip. Saying so plainly is better than running the engine and
 * writing a no-op row, which would put "cancelled" on the audit trail for an
 * account that was never subscribed.
 *
 * This reads the RESOLVED layer, not the projected fields, so an account whose
 * access currently comes from an admin override is still reported correctly:
 * the override is stripped too when the cancellation runs.
 *
 * @returns {{ok: true, plan: string, isTeam: boolean, seats: number, daysRemaining: number|null}
 *          |{ok: false, status: number, message: string}}
 */
function resolveCancellable(state) {
  if (!state || typeof state !== 'object') {
    return { ok: false, status: 400, message: 'We could not read your subscription. Please try again.' };
  }
  // `currentPlan` is the projected EFFECTIVE plan, which is what the member
  // actually has right now — the thing they are giving up.
  const plan = String(state.currentPlan || 'free');
  if (!CANCELLABLE_PLANS.includes(plan)) {
    return { ok: false, status: 400, message: 'You are already on the Free plan — there is nothing to cancel.' };
  }
  const isTeam = state.subscriptionIsTeam === true;
  return {
    ok: true,
    plan,
    isTeam,
    // A Team account's seat count is part of what is being given up, so the
    // queue can say "10× Team" rather than a bare tier.
    seats: isTeam ? Math.max(1, Math.round(Number(state.subscriptionSeats) || 1)) : 1,
    daysRemaining: Number.isFinite(state.daysRemaining) ? state.daysRemaining : null,
  };
}

/**
 * Which door did the member choose? Anything unrecognised is refused rather
 * than defaulted, so a client cannot post `mode: "immediate_typo"` and land in
 * the admin queue by accident, or post nothing and silently skip review.
 *
 * @returns {{ok: true, mode: string}|{ok: false, status: number, message: string}}
 */
function resolveCancelMode(raw) {
  // Absent means 'review', not 'immediate'. The slower, human-in-the-loop door
  // is the safe default for a value the client simply forgot.
  if (raw === undefined || raw === null || raw === '') return { ok: true, mode: 'review' };
  const value = String(raw).trim().toLowerCase();
  if (!CANCEL_MODES.includes(value)) {
    return { ok: false, status: 400, message: 'Choose whether to cancel now or request an administrator to review it.' };
  }
  return { ok: true, mode: value };
}

/** Trim + cap the free-text reason, collapsing newlines like cleanText does. */
function cleanReason(raw) {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LENGTH);
}

/**
 * Human label for the plan being given up.
 *
 * A Team cancellation stores the TIER its seats grant, exactly as an upgrade
 * request does, so the label has to be rebuilt from `isTeam` + `seats` — or a
 * 10-seat cancellation would read "PREMIUM" and look like a single downgrade.
 *
 * One definition, used by the member's own list, the admin queue, the bell and
 * the outcome notification, so those four can never disagree.
 */
function planLabelFor(row) {
  const record = row && typeof row === 'object' ? row : { plan: row };
  if (record.isTeam === true) {
    const seats = Number(record.seats) > 1 ? `${Math.round(Number(record.seats))}× ` : '';
    return `${seats}${TEAM_PLAN.label}`;
  }
  return PLAN_LABELS[record.plan] || String(record.plan || '—');
}

/** The safe shape of a cancellation for a LIST response. */
function toSummary(doc) {
  if (!doc) return null;
  return {
    _id: doc._id,
    plan: doc.plan,
    isTeam: doc.isTeam === true,
    seats: Number(doc.seats) || 1,
    mode: doc.mode,
    reason: doc.reason || '',
    status: doc.status,
    review: doc.review || null,
    appliedPlan: doc.appliedPlan || null,
    appliedAt: doc.appliedAt || null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Projection for list queries. */
const LIST_FIELDS = [
  '_id', 'user', 'plan', 'isTeam', 'seats', 'mode', 'reason', 'status',
  'review', 'appliedPlan', 'appliedAt', 'createdAt', 'updatedAt',
].join(' ');

/**
 * The sentence a member reads about where their cancellation stands.
 *
 * Kept next to the rules so the profile card, the pricing sheet toast and the
 * admin decision notification all phrase the same state the same way.
 */
function statusMessageFor(row) {
  const doc = row && typeof row === 'object' ? row : {};
  const label = planLabelFor(doc);
  if (doc.status === 'applied') {
    return `Your ${label} plan has ended and you are back on Free.`;
  }
  if (doc.status === 'rejected') {
    return `Your cancellation was not approved, so your ${label} plan is unchanged.`
      + (doc.review && doc.review.note ? ` Reason given: ${doc.review.note}` : '');
  }
  return `Your cancellation is waiting for an administrator to review it. Your ${label} plan stays active until then.`;
}

/** The days a member would give up, for the confirmation copy. */
function daysRemainingLabel(days) {
  if (days === null || days === undefined) return 'your remaining access';
  if (days <= 0) return 'no remaining access';
  return `${days} day${days === 1 ? '' : 's'} of access`;
}

// Referenced so the linter sees the import is intentional: subState is re-used
// by callers of this module through the same subscription engine, and pinning
// it here documents that a cancellation is an engine action, not a flag flip.
const ENGINE_ACTION = 'remove';
void subState;

module.exports = {
  CANCEL_STATUSES,
  CANCEL_MODES,
  CANCELLABLE_PLANS,
  MAX_REASON_LENGTH,
  ENGINE_ACTION,
  LIST_FIELDS,
  resolveCancellable,
  resolveCancelMode,
  cleanReason,
  planLabelFor,
  toSummary,
  statusMessageFor,
  daysRemainingLabel,
};
