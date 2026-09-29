/**
 * SUBSCRIPTION STATE — the two-layer subscription engine.
 *
 * WHY TWO LAYERS
 * ---------------
 * A subscription here has two independent owners:
 *
 *   paid     — what the USER bought. Created by a purchase/renewal, changed by
 *              a purchase, a cancellation, or expiry. An administrator may
 *              *inspect* it and may correct it, but no admin edit is allowed to
 *              silently destroy it.
 *   override — an ADMIN layer that sits ON TOP of the paid state (grant,
 *              extend, reduce, make permanent, change plan…). It is explicitly
 *              reversible: while it is active the paid state is frozen into
 *              `override.restore`, and "Restore original subscription state"
 *              puts that exact snapshot back — including the exact expiry date
 *              that was captured, NOT a freshly computed full period.
 *
 *   effective = override.active ? override : paid
 *
 * The example this exists for:
 *
 *   bought PREMIUM, 30 days      -> 26 days later: 4 days remaining
 *   admin adds 6 days            -> 10 days remaining (override)
 *   admin restores original      -> 4 days remaining, original expiry date
 *
 * BACKWARD COMPATIBILITY (this is why the schema is shaped the way it is)
 * ------------------------------------------------------------------------
 * `User.subscriptionActive / subscriptionPlan / subscriptionStartedAt /
 *  subscriptionExpiresAt` remain the PROJECTED EFFECTIVE state, written on
 * every mutation. Every existing reader — utils/entitlements.js, the admin
 * grid, /auth/me, requireFeature() gates, the admin overview metrics — keeps
 * working untouched; nothing had to be rewritten to gain the new behaviour.
 * The durable two-layer truth lives in `User.subscriptionRecord`.
 *
 * A user with no record at all (every account created before this existed) is
 * read as a single paid layer built from those legacy fields, so no migration
 * script is required and no account can be lost.
 *
 * This module is a LEAF on purpose: it requires nothing from the codebase, so
 * utils/entitlements.js can require IT without a cycle.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The standard purchase period. Deliberately a fixed 30 days rather than a
 * calendar month: the product contract is "one purchase = 30 days of access",
 * and a calendar month would show 31 (or 28) and make the number the UI shows
 * disagree with the number the user was charged for.
 */
const STANDARD_PERIOD_DAYS = 30;
const STANDARD_PERIOD_MONTHS = 1;

/** Admin day arithmetic is bounded so a typo cannot mint a 100-year plan. */
const MAX_ADMIN_DAYS = 3650;
const MAX_HISTORY_ENTRIES = 50;
const HISTORY_KEEP = 40;

// ── Plan vocabulary (single source; entitlements.js re-exports these) ──────
const PLAN_RANK = { free: 0, monthly: 1, annual: 2, custom: 3 };
const PLAN_LABELS = { free: 'FREE', monthly: 'DELUXE', annual: 'PREMIUM', custom: 'ULTIMATE' };
const PLAN_ORDER = ['free', 'monthly', 'annual', 'custom'];
const PLAN_ALIASES = {
  free: 'free', basic: 'free',
  monthly: 'monthly', deluxe: 'monthly', deluxeplan: 'monthly',
  annual: 'annual', premium: 'annual', pro: 'annual',
  custom: 'custom', ultimate: 'custom', ult: 'custom', ultimateplan: 'custom',
};

/** Accepted spellings -> canonical plan id, or null when unknown (fail closed). */
function normalizePlanId(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(PLAN_ALIASES, key) ? PLAN_ALIASES[key] : null;
}

const rankOf = (plan) => (Object.prototype.hasOwnProperty.call(PLAN_RANK, plan) ? PLAN_RANK[plan] : 0);
const isPaidPlan = (plan) => rankOf(plan) > 0;

// ── Small date helpers ─────────────────────────────────────────────────────
function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}
const toIso = (value) => { const d = toDate(value); return d ? d.toISOString() : null; };
const addDays = (date, days) => new Date(date.getTime() + days * DAY_MS);

/** Whole days left, rounded UP. 30 days remaining at purchase, 4 later. */
function daysRemainingFrom(expiresAt, now = Date.now()) {
  const end = toDate(expiresAt);
  if (!end) return null;
  const ms = end.getTime() - now;
  if (ms <= 0) return 0;
  return Math.ceil(ms / DAY_MS);
}

/** Accepts "1 month", 1, "30d", 30 … and returns whole days (null = invalid). */
function toDays(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const text = String(value).trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(\.\d+)?\s*months?$/.test(text)) {
    const months = parseFloat(text);
    return Number.isFinite(months) ? Math.round(months * STANDARD_PERIOD_DAYS) : null;
  }
  if (/^\d+(\.\d+)?\s*(d|day|days)$/.test(text)) return Math.round(parseFloat(text));
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(parseFloat(text));
  return null;
}

/** Clamp an admin-entered day count into a sane range. */
function clampDays(days) {
  if (!Number.isFinite(days)) return null;
  return Math.max(0, Math.min(MAX_ADMIN_DAYS, Math.round(days)));
}

/**
 * How many seats a subscription carries.
 *
 * One seat is an individual plan — the account holder. More than one is a Team
 * subscription: the same Premium entitlements, shared by N people. Seats are
 * therefore BILLING metadata and not a tier; adding a `team` tier instead would
 * have meant touching the rank order, every feature gate and every limit mapping
 * in the app, for something that unlocks nothing extra.
 *
 * Always at least 1: a subscription with zero seats would be a plan nobody can
 * use, and multiplying a per-seat price by it would produce a total of 0.
 */
const MIN_SEATS = 1;
const MAX_SEATS = 500;

/**
 * Normalize a requested seat count, or null when it names no real number.
 *
 * This CLAMPS rather than rejecting, which is the right rule for a value read
 * back out of storage: a record written with an older, higher ceiling must
 * still resolve to something usable instead of becoming unreadable.
 *
 * It is therefore the WRONG function for a seat count a customer is about to be
 * charged for. `parseSeatCount` is that one — clamping here meant a request for
 * 9999 seats resolved to 500 and was accepted, so the caller's "refuse anything
 * over the cap" check was comparing an already-clamped value against the cap
 * and could never fire.
 */
function normalizeSeats(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  return Math.max(MIN_SEATS, Math.min(MAX_SEATS, Math.round(n)));
}

/**
 * Parse a seat count a CUSTOMER is choosing, without silently changing it.
 *
 * Returns null for anything that is not a whole number inside [min, max]. The
 * difference from `normalizeSeats` is the whole point: a price is about to be
 * multiplied by this number, and quietly turning 9999 into 500 (or 0 into 1)
 * would put an invoice in front of the customer that they never agreed to. A
 * refusal they can see and correct beats a coercion they cannot.
 */
function parseSeatCount(value, { min = MIN_SEATS, max = MAX_SEATS } = {}) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) return null;
  if (!Number.isInteger(n)) return null;   // a fraction of a seat is not a seat
  if (n < min || n > max) return null;
  return n;
}

// ── Record shape ───────────────────────────────────────────────────────────
/** A fresh, empty record. Every field is explicit so the mongoose schema and
 *  the read path agree on "unset" (null, never undefined). */
function emptyRecord() {
  return {
    paid: {
      plan: 'free',
      status: 'none',            // none | active | expired | cancelled
      startedAt: null,
      expiresAt: null,
      permanent: false,
      updatedAt: null,
      updatedBy: 'system',
      periodDays: null,
      // Every account is one seat until it buys more.
      seats: MIN_SEATS,
    },
    override: null,              // null when no admin layer is in force
    history: [],
  };
}

const emptyPaid = () => emptyRecord().paid;

/**
 * Normalize whatever is on the document into a full record.
 *
 * Legacy accounts (and any hand-edited record) are upgraded in place: their
 * top-level subscription fields ARE the paid layer, which is exactly what they
 * were before this feature existed.
 */
function readRecord(user) {
  const base = emptyRecord();
  if (!user || typeof user !== 'object') return base;

  const raw = user.subscriptionRecord && typeof user.subscriptionRecord === 'object'
    ? user.subscriptionRecord
    : {};

  // ── paid layer ──
  const rawPaid = raw.paid && typeof raw.paid === 'object' ? raw.paid : null;
  const legacyPlan = normalizePlanId(user.subscriptionPlan) || 'free';
  const legacyEnd = toDate(user.subscriptionExpiresAt);
  const legacyActive = user.subscriptionActive === true;

  if (rawPaid) {
    const plan = normalizePlanId(rawPaid.plan) || 'free';
    const expiresAt = toDate(rawPaid.expiresAt);
    const permanent = rawPaid.permanent === true && plan !== 'free';
    // Fall back to a computed status when the stored one is missing/unknown.
    const known = ['none', 'active', 'expired', 'cancelled'];
    let status = known.includes(rawPaid.status) ? rawPaid.status : null;
    if (!status) {
      if (plan === 'free') status = 'none';
      else if (expiresAt && !permanent && expiresAt.getTime() <= Date.now()) status = 'expired';
      else status = 'active';
    }
    base.paid = {
      plan,
      status,
      startedAt: toDate(rawPaid.startedAt),
      expiresAt: permanent ? null : expiresAt,
      permanent,
      updatedAt: toDate(rawPaid.updatedAt),
      updatedBy: String(rawPaid.updatedBy || 'system').slice(0, 64),
      periodDays: Number.isFinite(rawPaid.periodDays) ? rawPaid.periodDays : null,
      // A record written before seats existed has none; that is an individual
      // plan, i.e. one seat.
      seats: normalizeSeats(rawPaid.seats) ?? MIN_SEATS,
    };
  } else if (legacyPlan !== 'free' || legacyActive) {
    // Pre-upgrade account: promote the raw fields to the paid layer verbatim.
    const permanent = user.subscriptionPermanent === true;
    base.paid = {
      plan: legacyPlan,
      status: legacyActive ? 'active' : 'cancelled',
      startedAt: toDate(user.subscriptionStartedAt),
      expiresAt: permanent ? null : legacyEnd,
      permanent,
      updatedAt: toDate(user.subscriptionUpdatedAt),
      updatedBy: 'system:migrated',
      periodDays: null,
      // Every pre-seats account is an individual plan.
      seats: MIN_SEATS,
    };
  }

  // ── override layer ──
  const rawOverride = raw.override && typeof raw.override === 'object' ? raw.override : null;
  if (rawOverride && rawOverride.active === true) {
    const plan = normalizePlanId(rawOverride.plan) || base.paid.plan || 'free';
    const permanent = rawOverride.permanent === true;
    base.override = {
      active: true,
      plan,
      permanent,
      startedAt: toDate(rawOverride.startedAt),
      expiresAt: permanent ? null : toDate(rawOverride.expiresAt),
      appliedAt: toDate(rawOverride.appliedAt),
      updatedAt: toDate(rawOverride.updatedAt),
      adminAlias: String(rawOverride.adminAlias || 'admin').slice(0, 64),
      reason: String(rawOverride.reason || '').slice(0, 240),
      restore: rawOverride.restore && typeof rawOverride.restore === 'object'
        ? {
          plan: normalizePlanId(rawOverride.restore.plan) || 'free',
          status: String(rawOverride.restore.status || 'none'),
          startedAt: toDate(rawOverride.restore.startedAt),
          // The frozen expiry — this is the value "restore" puts back verbatim.
          expiresAt: toDate(rawOverride.restore.expiresAt),
          permanent: rawOverride.restore.permanent === true,
          capturedAt: toDate(rawOverride.restore.capturedAt),
          // Days that were left when the override began (e.g. 4). Informational
          // for the admin UI; the absolute expiresAt is what actually applies.
          capturedDaysRemaining: Number.isFinite(rawOverride.restore.capturedDaysRemaining)
            ? rawOverride.restore.capturedDaysRemaining
            : null,
          periodDays: Number.isFinite(rawOverride.restore.periodDays) ? rawOverride.restore.periodDays : null,
          // The seat count the paid layer had when the override began, so
          // "restore" also puts the right number of seats back.
          seats: normalizeSeats(rawOverride.restore.seats) ?? MIN_SEATS,
        }
        : null,
      // An override never changes seats: an admin grant is about access, and
      // silently changing how many paid seats someone has would be surprising.
      // It inherits the paid count until an admin edits it deliberately.
      seats: base.paid.seats,
    };
  }

  // ── history ──
  if (Array.isArray(raw.history)) {
    base.history = raw.history
      .filter((entry) => entry && typeof entry === 'object')
      .slice(0, HISTORY_KEEP)
      .map((entry) => ({
        at: toDate(entry.at),
        actor: String(entry.actor || 'system').slice(0, 64),
        action: String(entry.action || 'update').slice(0, 48),
        note: String(entry.note || '').slice(0, 240),
        from: describeLayerState(entry.from),
        to: describeLayerState(entry.to),
      }));
  }

  return base;
}

/** Layer -> a compact, storable/serializable shape (ISO strings, no Dates). */
function describeLayerState(layer) {
  if (!layer || typeof layer !== 'object') return null;
  const plan = normalizePlanId(layer.plan) || 'free';
  const permanent = layer.permanent === true && plan !== 'free';
  return {
    plan,
    status: String(layer.status || (plan === 'free' ? 'none' : 'active')).slice(0, 16),
    permanent,
    startedAt: toIso(layer.startedAt),
    expiresAt: permanent ? null : toIso(layer.expiresAt),
    // Carried into the audit row so a seat change is visible in the log, not
    // just in the current state.
    seats: normalizeSeats(layer.seats) ?? MIN_SEATS,
  };
}

/**
 * Live view of one layer: the plan, whether it is currently granting access,
 * and exactly how long is left. `active` already accounts for expiry, so a
 * caller never has to re-derive it.
 */
function resolveLayer(layer, now = Date.now()) {
  const plan = isPaidPlan(layer.plan) ? layer.plan : 'free';
  const permanent = layer.permanent === true && plan !== 'free';
  const expiresAt = permanent ? null : toDate(layer.expiresAt);
  const remainingMs = permanent || !expiresAt ? null : Math.max(0, expiresAt.getTime() - now);
  const expired = remainingMs !== null && remainingMs <= 0;
  const cancelled = layer.status === 'cancelled';
  const active = plan !== 'free' && permanent ? !cancelled : (plan !== 'free' && !expired && !cancelled);

  return {
    plan,
    label: PLAN_LABELS[plan],
    rank: PLAN_RANK[plan],
    status: plan === 'free'
      ? (cancelled ? 'cancelled' : 'none')
      : (cancelled ? 'cancelled' : (expired ? 'expired' : (active ? 'active' : 'inactive'))),
    active,
    permanent,
    startedAt: toIso(layer.startedAt),
    expiresAt: toIso(expiresAt),
    remainingMs,
    daysRemaining: remainingMs === null ? null : daysRemainingFrom(expiresAt, now),
    periodDays: Number.isFinite(layer.periodDays) ? layer.periodDays : null,
    // Seats are reported even for a free/expired layer: the record of what a
    // lapsed Team subscription had is exactly what an admin needs to see.
    seats: normalizeSeats(layer.seats) ?? MIN_SEATS,
  };
}

/**
 * THE effective state: the override when one is in force, otherwise the paid
 * state.
 *
 * Two things matter for every surface that renders this:
 *
 *   - `plan` is the plan the account is ACTUALLY GETTING. A cancelled or elapsed
 *     window reports `free` here, even though its plan is still recorded on the
 *     layer — otherwise an admin panel would headline "PREMIUM" above a
 *     CANCELLED chip, and the pricing page would claim a tier nobody has. The
 *     recorded plan is still reachable, on `paid` / `override`, which is where
 *     "what did they have?" belongs.
 *   - `recordedPlan` is that stored plan, for the same readout.
 *
 * `source` answers "where did the access I have right now come from?", so it is
 * `free` whenever nothing is granting access.
 */
function effectiveState(record, now = Date.now()) {
  const override = record.override ? resolveLayer(record.override, now) : null;
  if (override && override.active && override.plan !== 'free') {
    return {
      ...override,
      recordedPlan: override.plan,
      source: 'admin',
      overridden: true,
      override,
    };
  }
  const paid = resolveLayer(record.paid, now);
  const granting = paid.active && paid.plan !== 'free';
  return {
    ...paid,
    plan: granting ? paid.plan : 'free',
    rank: PLAN_RANK[granting ? paid.plan : 'free'],
    label: PLAN_LABELS[granting ? paid.plan : 'free'],
    recordedPlan: paid.plan,
    // A subscription that grants nothing is a single account again, so it must
    // never keep reporting the seats a lapsed Team plan had — otherwise an
    // expired 20-seat subscription would still bill as 20 seats.
    seats: granting ? paid.seats : MIN_SEATS,
    source: granting ? 'payment' : 'free',
    overridden: false,
    override,
  };
}

/** Human-facing duration: "Permanent" or "12 days left". */
function durationLabel(layerState) {
  if (!layerState) return 'None';
  if (layerState.permanent) return 'Permanent';
  if (layerState.plan === 'free') return 'None';
  if (layerState.remainingMs === null) return 'No expiry';
  const days = layerState.daysRemaining;
  if (days <= 0) return 'Expired';
  return `${days} day${days === 1 ? '' : 's'} left`;
}

// ── History ────────────────────────────────────────────────────────────────
function pushHistory(record, entry) {
  if (!Array.isArray(record.history)) record.history = [];
  record.history.unshift({
    at: entry.at,
    actor: String(entry.actor || 'system').slice(0, 64),
    action: String(entry.action || 'update').slice(0, 48),
    note: String(entry.note || '').slice(0, 240),
    from: entry.from || null,
    to: entry.to || null,
  });
  if (record.history.length > MAX_HISTORY_ENTRIES) {
    record.history = record.history.slice(0, HISTORY_KEEP);
  }
}

/**
 * Freeze the current PAID state into the override so it can be restored
 * exactly. Called the first time an override layer is created in a given
 * episode, and re-taken whenever the paid layer itself is deliberately
 * rewritten (setPaid / purchase) so "restore" always means "the paid state
 * that this override is sitting on top of".
 */
function captureRestore(record, now) {
  const paid = record.paid;
  return {
    plan: paid.plan,
    status: paid.status,
    startedAt: paid.startedAt,
    expiresAt: paid.expiresAt,
    permanent: paid.permanent === true,
    capturedAt: now,
    capturedDaysRemaining: paid.permanent ? null : daysRemainingFrom(paid.expiresAt, now.getTime()),
    periodDays: paid.periodDays,
    // Seats are part of what the user bought, so they are frozen with the rest
    // of it — a Team subscription must come back with the same seat count.
    seats: normalizeSeats(paid.seats) ?? MIN_SEATS,
  };
}

/**
 * Project the effective state onto the legacy top-level fields.
 *
 * These fields are what every pre-existing reader consumes, so this projection
 * is the compatibility contract: after it, the whole app sees the effective
 * subscription with no further changes.
 */
function projectEffective(record, now = new Date()) {
  const effective = effectiveState(record, now.getTime());
  return {
    // A cancelled/expired window keeps its plan in storage (history + the admin
    // "what did they have" readout) but reports the FREE tier, exactly as the
    // old read-time expiry rule did.
    subscriptionActive: effective.active,
    subscriptionPlan: effective.active ? effective.plan : (effective.source === 'admin' ? effective.plan : 'free'),
    subscriptionStartedAt: effective.startedAt ? new Date(effective.startedAt) : null,
    subscriptionExpiresAt: effective.active && !effective.permanent && effective.expiresAt
      ? new Date(effective.expiresAt)
      : (effective.active ? null : now),
    subscriptionPermanent: effective.active && effective.permanent === true,
    subscriptionSource: effective.source,
    // Denormalized alongside the rest so a page can render "12 seats" straight
    // from the cached user document, without a second round-trip.
    subscriptionSeats: effective.seats,
    subscriptionUpdatedAt: now,
  };
}

// ── Actions ────────────────────────────────────────────────────────────────
const ACTIONS = [
  'grant',            // create/replace the admin layer (plan + days | permanent)
  'remove',           // strip the admin layer, or the subscription entirely
  'addDays',          // +N days on the layer in force
  'deductDays',       // -N days on the layer in force
  'extend',           // set an absolute expiry date
  'permanent',        // make the layer in force non-expiring
  'changePlan',       // change the plan of the layer in force
  'restore',          // restore the original paid state (exact expiry)
  'clearOverride',    // drop the admin layer only, back to paid
  'setPaid',          // write the PAID layer (purchase / correction / cancel)
];

/**
 * Make sure an admin override layer exists and return the record.
 *
 * EVERY admin action other than `setPaid`/`restore` is an intervention layered
 * ON TOP of the paid state — including a first "add 6 days" on an account that
 * has no override yet. That is the whole point: the admin's edit must be
 * reversible, so it cannot be written straight into `paid` where it would
 * destroy the record of what the user actually bought.
 *
 * A freshly created override starts as a copy of the paid window (same plan,
 * same remaining time) so day arithmetic continues from where the customer
 * actually is, and it freezes the paid state into `restore` immediately.
 */
function ensureOverride(record, now) {
  if (record.override && record.override.active === true) return record;
  const paid = record.paid;
  const paidIsLive = paid.plan !== 'free'
    && paid.status !== 'cancelled'
    && (paid.permanent === true || (paid.expiresAt && paid.expiresAt.getTime() > now.getTime()));
  if (!paidIsLive) {
    // Nothing to copy: start clean. A restore snapshot of "no subscription" is
    // still taken so "restore" has something honest to return to.
    record.override = {
      active: true,
      plan: 'free',
      permanent: false,
      startedAt: now,
      expiresAt: null,
      appliedAt: now,
      updatedAt: now,
      // The real actor is stamped by setLayer(), which runs immediately after
      // this returns — a placeholder here would survive into the audit trail.
      adminAlias: '',
      reason: '',
      restore: captureRestore(record, now),
    };
    return record;
  }
  record.override = {
    active: true,
    plan: paid.plan,
    permanent: paid.permanent === true,
    startedAt: paid.startedAt || now,
    expiresAt: paid.expiresAt,
    appliedAt: now,
    updatedAt: now,
    // The real actor is stamped by setLayer(), which runs immediately after this.
    adminAlias: '',
    reason: '',
    restore: captureRestore(record, now),
  };
  return record;
}

/** Apply +/- days to a layer, keeping "now" as the floor for an active window. */
function shiftDays(layer, days, now) {
  const permanent = layer.permanent === true;
  if (permanent) return layer; // a permanent grant has no day arithmetic
  const base = layer.expiresAt && layer.expiresAt.getTime() > now.getTime()
    ? layer.expiresAt
    : now;
  return { ...layer, expiresAt: addDays(base, days), permanent: false };
}

/**
 * Apply one admin/payment action to a record.
 *
 * Pure: it takes a record, returns a NEW record plus the top-level projection
 * and a log entry. It never touches the database — the route does that — so the
 * rules stay unit-testable and there is exactly one place where the two layers
 * can change.
 *
 * Returns `{ ok: false, error, status }` for a rejected action instead of
 * throwing, so a bad admin click is a 400 and never a 500.
 */
function applyAction(inputRecord, action, options = {}, nowInput = new Date()) {
  const now = toDate(nowInput) || new Date();
  const nowMs = now.getTime();
  const record = readRecord(inputRecord ? { subscriptionRecord: inputRecord } : null);
  const opts = options && typeof options === 'object' ? options : {};
  const actor = String(opts.actor || (action === 'purchase' || action === 'renew' ? 'payment' : 'admin')).slice(0, 64);
  const note = String(opts.note || '').slice(0, 240);

  const from = describeLayerState(effectiveState(record, nowMs));

  if (!ACTIONS.includes(action)) {
    return { ok: false, status: 400, error: `Unknown subscription action "${String(action)}".` };
  }

  // Which layer this action edits.
  //   - `setPaid` and `restore` name the paid layer explicitly;
  //   - EVERY other admin action is an override layered on top of the paid
  //     state (created on demand), so no admin edit can destroy what the user
  //     bought and "restore original" always has something to go back to.
  const isPaidAction = action === 'setPaid' || action === 'restore';
  const layer = isPaidAction ? 'paid' : 'override';

  const setLayer = (next, extra) => {
    if (isPaidAction) {
      record.paid = { ...next, updatedAt: now, updatedBy: actor, ...(extra || {}) };
      return;
    }
    // Every non-paid action edits (and, if needed, creates) the override.
    ensureOverride(record, now);
    // `adminAlias`/`reason` are stamped here rather than per-action: `grant`
    // builds the whole object itself, while every other action goes through
    // this path, and a placeholder alias left behind by ensureOverride would
    // otherwise reach the audit trail as a bare "admin".
    record.override = {
      ...record.override,
      ...next,
      active: true,
      updatedAt: now,
      adminAlias: actor,
      ...(note ? { reason: note } : {}),
      ...(extra || {}),
    };
  };

  const readLayer = () => (isPaidAction ? record.paid : (record.override || record.paid));

  const fail = (status, error) => ({ ok: false, status, error });

  // Validate the action's OWN inputs before anything else, so a typo is reported
  // as a typo ("Enter a whole number of days greater than 0") rather than being
  // masked by a downstream state check.
  if (action === 'addDays' || action === 'deductDays') {
    const days = toDays(opts.days);
    if (days === null || clampDays(days) === null || clampDays(days) <= 0) {
      return fail(400, 'Enter a whole number of days greater than 0.');
    }
  }
  if (action === 'extend' && !toDate(opts.expiresAt)) {
    return fail(400, 'Provide a valid expiry date.');
  }

  // An adjustment to "the subscription in force" is meaningless when nothing is
  // in force. Without this guard, `addDays` on a FREE account quietly created an
  // override with plan 'free' and reported success — the admin saw "Days added"
  // and nothing at all happened, which is worse than an error.
  //
  // `ensureOverride` seeds a new override from the paid window when one is live,
  // so this check is about there being nothing live to seed from.
  if (!isPaidAction && action !== 'grant' && action !== 'remove' && action !== 'clearOverride') {
    const current = effectiveState(record, nowMs);
    if (!current.active || current.plan === 'free') {
      return fail(400, 'This account has no active subscription to adjust. Grant a plan first.');
    }
  }

  // Per-action default note, filled in by the handlers that know more than the
  // final state can express (e.g. "+7 days" needs the number that was added).
  let defaultNote = '';

  switch (action) {
    // ── Grant ────────────────────────────────────────────────────────────
    case 'grant': {
      const plan = normalizePlanId(opts.plan);
      if (!plan || !isPaidPlan(plan)) return fail(400, 'Choose a paid plan to grant.');
      const permanent = opts.permanent === true;
      const days = permanent ? null : clampDays(toDays(opts.days) ?? STANDARD_PERIOD_DAYS);
      if (!permanent && (days === null || days <= 0)) {
        return fail(400, 'Choose a duration of at least 1 day, or make the grant permanent.');
      }
      // Preserve the original paid snapshot across repeated grants so a chain
      // of them still restores to the pre-override state, and keep the
      // intervention's own start/applied timestamps so the audit trail reads
      // as one continuous episode.
      const previous = record.override && record.override.active === true ? record.override : null;
      const restore = (previous && previous.restore) || captureRestore(record, now);
      const startedAt = previous && previous.startedAt ? previous.startedAt : now;
      record.override = {
        active: true,
        plan,
        permanent,
        startedAt,
        // A grant always starts a fresh window from now — a grant is a gift of
        // time, not a continuation of whatever was left.
        expiresAt: permanent ? null : addDays(now, days),
        appliedAt: (previous && previous.appliedAt) || now,
        updatedAt: now,
        adminAlias: actor,
        reason: note || (previous && previous.reason) || '',
        restore,
      };
      break;
    }

    // ── Remove ───────────────────────────────────────────────────────────
    case 'remove': {
      const scope = opts.scope === 'override' ? 'override' : 'all';
      if (scope === 'override') {
        if (!record.override) return fail(400, 'There is no admin override on this account.');
        record.override = null;
      } else {
        // Strip the admin layer AND cancel what the user paid for. The prior
        // state stays in `history` so an admin can always see it.
        record.override = null;
        record.paid = {
          ...emptyPaid(),
          plan: opts.keepPlan ? (normalizePlanId(opts.keepPlan) || 'free') : 'free',
          status: opts.keepPlan ? 'cancelled' : 'none',
          expiresAt: now,
          startedAt: record.paid.startedAt,
          updatedAt: now,
          updatedBy: actor,
        };
      }
      break;
    }

    // ── Add / deduct days ────────────────────────────────────────────────
    case 'addDays':
    case 'deductDays': {
      const current = readLayer();
      if (current.permanent === true) {
        return fail(400, 'This subscription is permanent — it has no days to add or remove. Choose "Remove permanent" first.');
      }
      const requested = clampDays(toDays(opts.days));
      if (requested === null || requested <= 0) return fail(400, 'Enter a whole number of days greater than 0.');
      const signed = action === 'addDays' ? requested : -requested;
      defaultNote = `${signed > 0 ? 'Added' : 'Deducted'} ${requested} day${requested === 1 ? '' : 's'}.`;
      const next = shiftDays(current, signed, now);
      // Deducting past today ends the subscription instead of storing an
      // expiry in the past (an expired window reads as FREE anyway, but keeping
      // the record honest makes the admin readout correct).
      if (signed < 0 && next.expiresAt.getTime() <= nowMs) {
        setLayer({ ...next, expiresAt: now, status: 'cancelled', active: false });
      } else {
        setLayer({ ...next, status: 'active' });
      }
      break;
    }

    // ── Extend to an exact date ──────────────────────────────────────────
    case 'extend': {
      const current = readLayer();
      const explicit = toDate(opts.expiresAt);
      if (!explicit) return fail(400, 'Provide a valid expiry date.');
      setLayer({ expiresAt: explicit, permanent: false, status: 'active' });
      break;
    }

    // ── Make permanent ───────────────────────────────────────────────────
    case 'permanent': {
      const current = readLayer();
      if (current.permanent === true) {
        return fail(400, 'This subscription is already permanent.');
      }
      // Seed a fresh override from the live paid window first, so "permanent"
      // on a user's own plan layers over it (their paid expiry is preserved and
      // comes back on restore) instead of rewriting what they bought.
      setLayer({ permanent: true, expiresAt: null, status: 'active' });
      break;
    }

    // ── Change plan (authorized tier swap) ───────────────────────────────
    case 'changePlan': {
      const plan = normalizePlanId(opts.plan);
      if (!plan || !isPaidPlan(plan)) return fail(400, 'Choose a valid paid plan.');
      const current = readLayer();
      if (current.permanent !== true && !current.expiresAt) {
        // Swapping the tier of an open-ended window that has no end date would
        // otherwise hand out a permanent plan by accident.
        return fail(400, 'This subscription has no expiry date to keep. Choose a duration or make it permanent explicitly.');
      }
      setLayer({ plan, status: 'active' });
      break;
    }

    // ── Restore the original paid state ──────────────────────────────────
    case 'restore': {
      if (!record.override || record.override.active !== true) {
        return fail(400, 'There is no admin override to restore — this subscription is already the original.');
      }
      const snap = record.override.restore;
      if (!snap) return fail(400, 'No original snapshot was captured for this override.');
      // Put the FROZEN paid state back — the captured expiry date verbatim, so
      // "4 days remaining" comes back as 4 days, not a fresh 30.
      record.paid = {
        plan: snap.plan,
        status: snap.status,
        startedAt: snap.startedAt,
        expiresAt: snap.permanent ? null : snap.expiresAt,
        permanent: snap.permanent === true,
        updatedAt: now,
        updatedBy: actor,
        periodDays: snap.periodDays,
        // Restoring brings back the seat count too — a 10-seat subscription that
        // came back as 1 seat would be a silent downgrade.
        seats: normalizeSeats(snap.seats) ?? MIN_SEATS,
      };
      record.override = null;
      break;
    }

    // ── Drop the admin layer only ────────────────────────────────────────
    case 'clearOverride': {
      if (!record.override || record.override.active !== true) {
        return fail(400, 'There is no admin override on this account.');
      }
      record.override = null;
      break;
    }

    // ── Write the paid layer (purchase, renewal, correction, cancellation) ─
    case 'setPaid': {
      const plan = normalizePlanId(opts.plan) || 'free';
      const permanent = opts.permanent === true && isPaidPlan(plan);
      const active = opts.active !== false && isPaidPlan(plan);
      const wasActive = record.paid.status === 'active';

      // Renaming or renewing the user's paid subscription while an admin
      // override is in force must not rewrite the snapshot that override
      // restores to. Re-freeze AFTER the write, so "restore" returns to the
      // paid state the override is actually sitting on right now.
      const refreeze = () => {
        if (record.override && record.override.active === true) {
          record.override.restore = captureRestore(record, now);
        }
      };

      if (!active) {
        record.paid = {
          ...emptyPaid(),
          plan,
          status: 'cancelled',
          startedAt: record.paid.startedAt,
          expiresAt: now,
          updatedAt: now,
          updatedBy: actor,
        };
        refreeze();
        break;
      }

      // Seats. `opts.seats` REPLACES the count (that is how seat-based billing
      // works — you state how many seats you are renewing for), and omitting it
      // resets to 1.
      //
      // That default matters: buying an individual plan must drop a lapsed Team
      // subscription back to a single account, or a customer could pay for one
      // Deluxe seat and keep 50.
      //
      // An out-of-range count is REFUSED, not clamped, so a caller that skipped
      // its own validation cannot get 500 seats by asking for 9999. This is the
      // last line before the number is stored and priced, so it is the one that
      // must be strict.
      const seatsWereGiven = opts.seats !== undefined && opts.seats !== null;
      const parsedSeats = seatsWereGiven ? parseSeatCount(opts.seats) : null;
      if (seatsWereGiven && parsedSeats === null) {
        return fail(400, `Seats must be a whole number between ${MIN_SEATS} and ${MAX_SEATS}.`);
      }
      const seats = parsedSeats ?? MIN_SEATS;

      const explicitExpiry = toDate(opts.expiresAt);
      // Did the caller say anything about the TERM? A seat count, a plan name or
      // a bare "make it active" is not a purchase — it is an edit to the
      // subscription that already exists. Defaulting those to a fresh 30 days
      // meant an admin changing 6 seats to 12 silently granted a month of free
      // access, and a "reactivate this lapsed plan" click invented time the
      // customer never paid for.
      const termWasGiven = opts.days !== undefined && opts.days !== null;
      // …but an explicit expiry, or a request to make it permanent, IS a term.
      const termIsExplicit = termWasGiven || explicitExpiry !== null || permanent === true;
      // Keep the window that is already paid for when the caller said nothing
      // about length and there is one to keep.
      const keepExistingWindow = !termIsExplicit
        && record.paid.expiresAt !== null
        && record.paid.expiresAt !== undefined;
      const days = permanent
        ? null
        : (keepExistingWindow
          ? null
          : clampDays(toDays(opts.days) ?? STANDARD_PERIOD_DAYS));
      // Renewals run from the end of the current window, not from today, so a
      // renewal never silently discards the days already paid for.
      const base = explicitExpiry
        ? new Date(Math.max(explicitExpiry.getTime(), nowMs))
        : (record.paid.expiresAt && record.paid.expiresAt.getTime() > nowMs
          ? record.paid.expiresAt
          : now);
      const startedAt = plan === record.paid.plan && wasActive && record.paid.startedAt
        ? record.paid.startedAt
        : now;
      const expiresAt = permanent
        ? null
        : (explicitExpiry
          || (keepExistingWindow ? record.paid.expiresAt : addDays(base, days ?? STANDARD_PERIOD_DAYS)));

      record.paid = {
        plan,
        status: 'active',
        startedAt,
        expiresAt,
        permanent,
        updatedAt: now,
        updatedBy: actor,
        // The window's own length, not what this call asked for: when the
        // window was kept, `days` is null and the stored period has to describe
        // the days that are actually on the clock.
        periodDays: permanent
          ? null
          : (days ?? (expiresAt && startedAt
            ? Math.max(1, Math.round((expiresAt.getTime() - startedAt.getTime()) / DAY_MS))
            : null)),
        seats,
      };
      refreeze();
      break;
    }

    default:
      return fail(400, 'Unsupported subscription action.');
  }

  const to = describeLayerState(effectiveState(record, nowMs));
  pushHistory(record, {
    at: now,
    actor,
    action,
    note: note || defaultNote || describeActionNote(action, record, nowMs),
    from,
    to,
  });

  return {
    ok: true,
    record,
    action,
    actor,
    from,
    to,
    patch: projectEffective(record, now),
  };
}

/** Default human note for the audit row, so history is never blank. */
function describeActionNote(action, record, nowMs) {
  const effective = effectiveState(record, nowMs);
  switch (action) {
    case 'grant': return `Granted ${effective.label} — ${durationLabel(effective)}.`;
    case 'remove': return 'Subscription removed by an administrator.';
    case 'extend': return `Expiry date set to ${effective.expiresAt || 'none'}.`;
    case 'permanent': return 'Made permanent — it no longer expires.';
    case 'changePlan': return `Plan changed to ${effective.label}.`;
    case 'restore': return 'Original paid subscription state restored.';
    case 'clearOverride': return 'Admin override removed — back to the original subscription.';
    case 'setPaid': return `Paid subscription set to ${effective.label} (${durationLabel(effective)}).`;
    default: return 'Subscription updated.';
  }
}

// ── Full description (admin console + user surfaces) ───────────────────────
/**
 * The complete two-layer view of one account's subscription.
 *
 * `paid` and `override` are reported SEPARATELY from `effective` so the admin
 * can always see what the user bought, what is layered on top, and exactly how
 * much time each has left.
 */
function describeRecord(user, nowInput = Date.now()) {
  const now = typeof nowInput === 'number' ? nowInput : (toDate(nowInput) || new Date()).getTime();
  const record = readRecord(user);
  const paid = resolveLayer(record.paid, now);
  const override = record.override ? resolveLayer(record.override, now) : null;
  const overrideActive = !!(override && override.active);
  const effective = effectiveState(record, now);

  const restoreTarget = overrideActive && record.override.restore
    ? (() => {
      const snap = record.override.restore;
      const snapExpiry = snap.permanent ? null : snap.expiresAt;
      return {
        plan: snap.plan,
        label: PLAN_LABELS[snap.plan] || PLAN_LABELS.free,
        seats: normalizeSeats(snap.seats) ?? MIN_SEATS,
        status: snap.status,
        permanent: snap.permanent === true,
        startedAt: toIso(snap.startedAt),
        expiresAt: toIso(snapExpiry),
        capturedAt: toIso(snap.capturedAt),
        // What the user had LEFT before the override — the number the admin
        // must be able to check ("4 days remaining" was his paid balance).
        capturedDaysRemaining: snap.permanent
          ? null
          : daysRemainingFrom(snapExpiry, snap.capturedAt ? new Date(snap.capturedAt).getTime() : now),
        capturedDuration: snap.permanent
          ? 'Permanent'
          : (snapExpiry ? `${daysRemainingFrom(snapExpiry, snap.capturedAt ? new Date(snap.capturedAt).getTime() : now)} days left` : 'No expiry'),
      };
    })()
    : null;

  return {
    effective: {
      plan: effective.plan,
      label: effective.label,
      // How many seats this subscription covers. 1 = an individual plan; more
      // means a Team subscription sharing the same entitlements.
      seats: effective.seats,
      isTeam: effective.active && effective.seats > MIN_SEATS,
      // The plan still recorded on the layer in force, even when it grants
      // nothing ("was PREMIUM, cancelled 3 days ago"). The admin panel shows
      // this so an expiring or cancelled subscription never looks like it never
      // existed.
      recordedPlan: effective.recordedPlan,
      recordedSeats: paid.seats,
      recordedLabel: PLAN_LABELS[effective.recordedPlan] || PLAN_LABELS.free,
      status: effective.status,
      active: effective.active,
      permanent: effective.permanent === true,
      source: effective.source,
      sourceLabel: effective.source === 'admin' ? 'ADMIN' : (effective.source === 'payment' ? 'PAID' : 'FREE'),
      startedAt: effective.startedAt,
      expiresAt: effective.expiresAt,
      daysRemaining: effective.daysRemaining,
      remainingMs: effective.remainingMs,
      durationLabel: durationLabel(effective),
    },
    paid: {
      plan: paid.plan,
      label: paid.label,
      status: paid.status,
      active: paid.active,
      permanent: paid.permanent === true,
      startedAt: paid.startedAt,
      expiresAt: paid.expiresAt,
      daysRemaining: paid.daysRemaining,
      remainingMs: paid.remainingMs,
      durationLabel: durationLabel(paid),
      periodDays: record.paid.periodDays,
      seats: paid.seats,
      isTeam: paid.active && paid.seats > MIN_SEATS,
      updatedAt: toIso(record.paid.updatedAt),
      updatedBy: record.paid.updatedBy,
    },
    override: overrideActive
      ? {
        active: true,
        plan: override.plan,
        label: override.label,
        seats: override.seats,
        permanent: override.permanent === true,
        startedAt: override.startedAt,
        expiresAt: override.expiresAt,
        daysRemaining: override.daysRemaining,
        remainingMs: override.remainingMs,
        durationLabel: durationLabel(override),
        appliedAt: toIso(record.override.appliedAt),
        updatedAt: toIso(record.override.updatedAt),
        adminAlias: record.override.adminAlias,
        reason: record.override.reason,
        canRestore: !!record.override.restore,
        restoreTarget,
      }
      : { active: false, canRestore: false, restoreTarget: null },
    canRestore: overrideActive && !!record.override.restore,
    restoreTarget,
    hasPaidSubscription: isPaidPlan(record.paid.plan),
    // The entitlement tier a Team subscription grants. Team is not a tier of its
    // own: it is Premium entitlements shared across N seats, so the admin panel
    // and the receipt can both say what a seat actually unlocks.
    teamTierPlan: 'annual',
    history: record.history,
  };
}

module.exports = {
  // constants
  DAY_MS,
  STANDARD_PERIOD_DAYS,
  STANDARD_PERIOD_MONTHS,
  MAX_ADMIN_DAYS,
  MIN_SEATS,
  MAX_SEATS,
  ACTIONS,
  // plan vocabulary
  PLAN_RANK,
  PLAN_LABELS,
  PLAN_ORDER,
  PLAN_ALIASES,
  normalizePlanId,
  rankOf,
  isPaidPlan,
  // helpers
  toDate,
  toIso,
  toDays,
  clampDays,
  normalizeSeats,
  parseSeatCount,
  addDays,
  daysRemainingFrom,
  durationLabel,
  // record
  emptyRecord,
  readRecord,
  resolveLayer,
  effectiveState,
  describeLayerState,
  captureRestore,
  projectEffective,
  applyAction,
  describeRecord,
};
