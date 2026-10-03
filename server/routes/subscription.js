/**
 * /api/subscription — the user's authoritative subscription surface.
 *
 *   GET  /            -> full entitlement state (single source for all UI)
 *   GET  /plans       -> the purchasable plan catalogue (prices + features)
 *   GET  /feature/:key-> backend authorization for one feature (200 | 403)
 *   POST /purchase    -> buy/renew a plan; writes the PAID layer only
 *   POST /requests    -> submit a plan request + proof-of-payment image
 *   GET  /requests    -> my requests and where each one stands
 *   GET  /requests/:id-> one of my requests, including the proof image
 *   POST /downgrade   -> end the paid plan NOW, back to Free
 *   POST /cancel-requests -> ask an admin to do the same (waits for review)
 *   GET  /cancel-requests -> my cancellations and where each one stands
 *   GET  /stream      -> SSE push: fires on every admin/expiry change so the
 *                        user's open tab/phone syncs instantly, no refresh.
 *
 * Every response is computed from the CURRENT user document (protect re-reads
 * it per request), so there is never a server-side cache to invalidate.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const User = require('../models/User');
const SubscriptionRequest = require('../models/SubscriptionRequest');
const SubscriptionCancelRequest = require('../models/SubscriptionCancelRequest');
const { protect } = require('../middleware/auth');
const { describeSubscription, can, getFeature, PLAN_LABELS } = require('../utils/entitlements');
const subState = require('../utils/subscriptionState');
const { STANDARD_PERIOD_DAYS, STANDARD_PERIOD_MONTHS } = subState;
const {
  cataloguePayload, resolvePurchasable, teamTotal, formatAmount,
  selfServeEnabled, normalizeCurrency, convertFromPhp, TEAM_PLAN,
} = require('../utils/planCatalogue');
const bus = require('../utils/subscriptionBus');
const requestRules = require('../utils/subscriptionRequests');
const cancelRules = require('../utils/subscriptionCancels');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const SSE_HEARTBEAT_MS = 25_000;

// Every field the subscription surface reads, so the purchase path, the read
// path and the SSE snapshot can never disagree.
const SUBSCRIPTION_SELECT = 'subscriptionActive subscriptionPlan subscriptionUpdatedAt '
  + 'subscriptionStartedAt subscriptionExpiresAt subscriptionPermanent subscriptionSource subscriptionRecord';

// Buying is a write against money, so it gets its own tight budget — separate
// from the read routes, and far stricter than the global limiter. A burst of
// double-clicks on "Choose plan" is a 429, not four subscriptions.
//
// Deliberately NOT part of the escalating lockout ladder (that is for
// credentials): a rate-limited purchase must never lock a customer out of their
// account. Local development gets the relaxed budget the other limiters use so a
// manual test run is never throttled.
const purchaseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => {
    const ip = req.ip || '';
    const isLocal = ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '127.0.0.1';
    return isLocal ? 120 : 6;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many subscription attempts. Please wait a minute and try again.' },
});

// EventSource cannot set an Authorization header, so the SSE stream accepts
// the access token as a query parameter. Scoped to THIS route only — every
// other endpoint still requires the header, so the token never appears in
// logs/URLs anywhere else.
const streamTokenAuth = (req, res, next) => {
  if (!req.headers.authorization && req.query.token) {
    req.headers.authorization = `Bearer ${String(req.query.token)}`;
  }
  next();
};

function sseWrite(res, event, payload) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// @route  GET /api/subscription/plans
// @desc   The purchasable plan catalogue: prices for both billing periods and the
//         feature list for each card. Served by the server so the numbers on the
//         pricing page are the numbers the purchase endpoint uses.
//         Public — a visitor must be able to compare plans before signing up.
//
//         CURRENCY: resolved per request in this order — `?currency=` (the
//         visitor's own choice), then a region-tagged Accept-Language, then the
//         country behind their IP, then PHP. Every step can miss and falls
//         through, so this never fails. The response always says which rule
//         decided (`currencySource`) and what it saw (`detectedCountry`), so the
//         UI can EXPLAIN the number rather than just assert it.
// @access Public
router.get('/plans', async (req, res) => {
  try {
    // An unrecognised ?currency= must not become a 400: a stale bookmark or a
    // typo should quietly fall back to detection, not break the page.
    const { resolveCurrencyForRequest } = require('../utils/currency');
    const { normalizeCurrency, DEFAULT_CURRENCY, CURRENCY_ORDER } = require('../utils/planCatalogue');
    const requested = normalizeCurrency(req.query.currency) || undefined;
    const resolved = await resolveCurrencyForRequest(req, { requested });

    res.json({
      ...cataloguePayload(resolved.code),
      currencySource: resolved.source,
      detectedCountry: resolved.detectedCountry,
      defaultCurrency: DEFAULT_CURRENCY,
      supportedCurrencies: CURRENCY_ORDER,
      selfServe: selfServeEnabled(),
    });
  } catch (error) {
    // Detection is an enhancement: if it ever throws, the visitor still gets the
    // full price list in the base currency instead of an error page.
    console.error('[subscription GET /plans]', error.message);
    res.json({
      ...cataloguePayload(),
      currencySource: 'default',
      detectedCountry: null,
      defaultCurrency: require('../utils/planCatalogue').DEFAULT_CURRENCY,
      supportedCurrencies: require('../utils/planCatalogue').CURRENCY_ORDER,
      selfServe: selfServeEnabled(),
    });
  }
});

// @route  GET /api/subscription/quote
// @desc   Price one specific order without buying it: `?plan=team&seats=7&months=1`.
//
//         The checkout needs an exact total for EVERY seat count, not just the
//         handful the catalogue pre-computes, because the stepper reaches any
//         number in one click. Doing that arithmetic in the browser would mean
//         the client multiplying money, so the figure the visitor confirms could
//         disagree with the figure the purchase endpoint charges.
//
//         Public and side-effect free: it reveals nothing but prices, which
//         /plans already publishes in full.
// @access Public
router.get('/quote', async (req, res) => {
  try {
    const { resolveCurrencyForRequest } = require('../utils/currency');
    const { normalizeCurrency, STANDARD_PERIOD_MONTHS } = require('../utils/planCatalogue');

    const purchasable = resolvePurchasable(req.query.plan);
    if (!purchasable) return res.status(400).json({ message: 'Choose a valid plan.' });
    const { entry, isTeam, tier } = purchasable;
    if (entry.id === 'free') {
      return res.status(400).json({ message: 'The Free plan needs no purchase — it is already yours.' });
    }

    // Same bounded term rule as the purchase, so a quote can never promise more
    // days than a purchase would actually grant.
    const months = Math.min(
      12,
      Math.max(1, Math.round(Number(req.query.months) || STANDARD_PERIOD_MONTHS)),
    );

    // Seats are refused, never clamped — the same rule the purchase applies, so
    // a quote and a purchase can never disagree about what "500" means.
    let seats = 1;
    if (isTeam) {
      const parsed = subState.parseSeatCount(req.query.seats, {
        min: TEAM_PLAN.minSeats,
        max: TEAM_PLAN.maxSeats,
      });
      if (parsed === null) {
        return res.status(400).json({
          message: `Choose between ${TEAM_PLAN.minSeats} and ${TEAM_PLAN.maxSeats} seats.`,
        });
      }
      seats = parsed;
    }

    const resolved = await resolveCurrencyForRequest(req, {
      requested: normalizeCurrency(req.query.currency) || undefined,
    });
    const perSeatPhp = isTeam
      ? (months > 1 ? TEAM_PLAN.perSeatYearly : TEAM_PLAN.perSeatMonthly)
      : null;
    const unitPhp = perSeatPhp ?? (months > 1 ? entry.yearly : entry.monthly);
    const amountPhp = teamTotal(unitPhp, seats);

    res.json({
      plan: entry.id,
      planLabel: entry.label,
      isTeam,
      tier,
      seats,
      months,
      days: months * STANDARD_PERIOD_DAYS,
      currency: resolved.code,
      symbol: resolved.symbol,
      perSeatPhp,
      perSeatFormatted: perSeatPhp === null ? null : formatAmount(perSeatPhp, resolved.code),
      baseAmountPhp: amountPhp,
      amount: convertFromPhp(amountPhp, resolved.code),
      formatted: formatAmount(amountPhp, resolved.code),
    });
  } catch (error) {
    // A quote is an enhancement on the display. If it fails, the checkout shows
    // a placeholder rather than a wrong number, and the purchase still works.
    console.error('[subscription GET /quote]', error.message);
    return res.status(500).json({ message: 'Could not price that order right now.' });
  }
});

// @route  POST /api/subscription/purchase
// @desc   Buy (or renew) a plan for the signed-in account. Writes the PAID layer
//         only — a purchase can never touch an admin override, and paying can
//         never create one. A purchase is normally one month (30 days); a
//         renewal extends from the end of the window already paid for, so no
//         paid day is ever discarded. Pushing the new state over SSE means the
//         features unlock immediately.
// @access Private (user)
router.post('/purchase', purchaseLimiter, protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });

    const requested = (req.body || {}).plan;
    // `resolvePurchasable` handles Team as well as the four stored plan ids. Team
    // is not a plan id — it is the Premium tier with a seat count — so it cannot
    // go through normalizePlanId() without inventing a fifth tier.
    const purchasable = resolvePurchasable(requested);
    // Validate the plan BEFORE the self-serve guard, so a bad request is a
    // clear 400 rather than being masked as "billing is switched off".
    if (!purchasable) return res.status(400).json({ message: 'Choose a valid plan.' });
    const { entry, isTeam, tier } = purchasable;
    if (entry.id === 'free') {
      return res.status(400).json({ message: 'The Free plan needs no purchase — it is already yours.' });
    }

    // Seats. Team defaults to its minimum; an individual plan is always one, and
    // a `seats` value on one is ignored rather than silently billing extra.
    const rawSeats = (req.body || {}).seats;
    let seats = 1;
    if (isTeam) {
      if (rawSeats === undefined || rawSeats === null || rawSeats === '') {
        seats = TEAM_PLAN.minSeats;
      } else {
        // Reject rather than clamp: silently turning "5000 seats" into 500 would
        // show an invoice the customer did not agree to. This MUST use
        // parseSeatCount, not normalizeSeats — the latter already clamps, so the
        // bounds check below it would be comparing a clamped value to the cap and
        // could never fire.
        const parsed = subState.parseSeatCount(rawSeats, {
          min: TEAM_PLAN.minSeats,
          max: TEAM_PLAN.maxSeats,
        });
        if (parsed === null) {
          return res.status(400).json({
            message: `Choose between ${TEAM_PLAN.minSeats} and ${TEAM_PLAN.maxSeats} seats.`,
          });
        }
        seats = parsed;
      }
    }

    if (!selfServeEnabled()) {
      return res.status(501).json({
        message: 'Self-serve billing is not enabled on this deployment. An administrator can activate your plan for you.',
        code: 'SELF_SERVE_DISABLED',
      });
    }

    // `months` is honoured but bounded, so a scripted client cannot mint a
    // decade of access in one request.
    const requestedMonths = Number((req.body || {}).months);
    const months = Number.isFinite(requestedMonths) && requestedMonths > 0
      ? Math.min(12, Math.max(1, Math.round(requestedMonths)))
      : STANDARD_PERIOD_MONTHS;

    const user = await User.findById(req.user._id).select(SUBSCRIPTION_SELECT).lean();
    if (!user) return res.status(404).json({ message: 'Account not found.' });

    const result = subState.applyAction(user.subscriptionRecord, 'setPaid', {
      actor: 'payment',
      // A Team purchase writes the TIER a seat grants plus the seat count, not a
      // `team` plan id — which is why no entitlement gate in the app changes.
      plan: tier,
      seats,
      days: months * STANDARD_PERIOD_DAYS,
      note: isTeam
        ? `Purchased Team — ${seats} seats, ${months} month${months === 1 ? '' : 's'}.`
        : `Purchased ${entry.label} — ${months} month${months === 1 ? '' : 's'}.`,
    }, new Date());
    if (!result.ok) return res.status(result.status || 400).json({ message: result.error });

    await User.findByIdAndUpdate(user._id, {
      $set: { subscriptionRecord: result.record, ...result.patch },
    });

    // Read back so the response is the persisted state, never the in-memory
    // guess — a cast or default that differed would otherwise be invisible.
    const fresh = await User.findById(user._id).select(SUBSCRIPTION_SELECT).lean();
    const state = describeSubscription(fresh);
    // Instant unlock: the open tab/phone/pill all re-render from this push.
    const delivered = bus.publish(String(user._id), state);
    console.log(
      `[subscription/purchase] user ${user._id} -> ${state.currentPlan} (${state.daysRemaining} days, ${seats} seat${seats === 1 ? '' : 's'}); pushed to ${delivered} session(s)`,
    );

    // The receipt, priced in the currency the visitor was actually shown. The
    // amount is server-computed from the catalogue, never taken from the
    // request, so a tampered client cannot "pay" ₱1 for Premium — or ₱1 per seat
    // for a 50-seat Team subscription.
    const { resolveCurrencyForRequest } = require('../utils/currency');
    const { formatAmount } = require('../utils/planCatalogue');
    const currency = await resolveCurrencyForRequest(req, {
      requested: normalizeCurrency((req.body || {}).currency) || undefined,
    });
    const perSeatPhp = isTeam
      ? (months > 1 ? TEAM_PLAN.perSeatYearly : TEAM_PLAN.perSeatMonthly)
      : null;
    const unitPhp = isTeam ? perSeatPhp : (months > 1 ? entry.yearly : entry.monthly);
    const amountPhp = teamTotal(unitPhp, isTeam ? seats : 1);
    const receipt = {
      currency: currency.code,
      symbol: currency.symbol,
      // The base figure, so an invoice can be reconciled against the price list.
      baseAmountPhp: amountPhp,
      amount: convertFromPhp(amountPhp, currency.code),
      formatted: formatAmount(amountPhp, currency.code),
      plan: entry.id,
      planLabel: entry.label,
      isTeam,
      seats,
      // What one seat costs, and what each seat of the subscription grants.
      perSeatFormatted: isTeam ? formatAmount(perSeatPhp, currency.code) : null,
      grantsPlanLabel: isTeam ? PLAN_LABELS[tier] : null,
      months,
      days: months * STANDARD_PERIOD_DAYS,
    };
    console.log(`[subscription/purchase] charged ${receipt.formatted} (PHP ${amountPhp}) for ${entry.label} x${months}`);

    return res.json({
      message: `You are now on ${entry.label}.`,
      plan: entry.id,
      months,
      receipt,
      subscription: state,
    });
  } catch (error) {
    console.error('[subscription POST /purchase]', error.message);
    return res.status(500).json({ message: 'We could not complete your purchase. Please try again.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// PLAN REQUESTS WITH PROOF OF PAYMENT
//
// A user picks a plan on /pricing, uploads a screenshot of the transfer, and
// the request lands here. It is NOT a purchase: nothing is granted, no money
// moves and no entitlement changes. It becomes a row in the admin "Subscription
// management" queue, and only an admin pressing Approve runs the subscription
// engine. That is what makes the queue safe to expose: the user controls the
// plan they ask for and nothing else.
//
//   POST /requests       create a request (plan, months, reference, note, image)
//   GET  /requests       my requests, newest first, with the current plan
//   GET  /requests/:id   one of MY requests, including the proof image
// ══════════════════════════════════════════════════════════════════════════

// A request carries a multi-megabyte image, so it gets a much smaller budget
// than the shared session limiter: a handful of receipts per ten minutes is
// plenty for a real purchase, and it stops a scripted client from filling the
// admin queue with megabytes. Never part of the escalating credential lockout —
// a throttled customer must not be locked out of their account.
const requestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: (req) => {
    const ip = req.ip || '';
    const isLocal = ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '127.0.0.1';
    return isLocal ? 60 : 8;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many plan requests. Please wait a few minutes and try again.' },
});

// @route  POST /api/subscription/requests
// @desc   Submit a plan request together with a proof-of-payment image. The
//         amount recorded on the request is priced by the SERVER from the
//         catalogue, so a tampered body cannot invent a cheaper purchase.
//         Grants nothing — the admin queue decides.
// @access Private (user)
router.post('/requests', requestLimiter, protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const body = req.body || {};

    // Validate the image FIRST: it is the largest, most expensive part of the
    // request, and a 3 MB upload with a bad plan id should not get that far.
    const proof = requestRules.parseProofImage(body.proof);
    if (!proof.ok) return res.status(proof.status).json({ message: proof.message });

    const planned = requestRules.resolveRequestedPlan(body.plan, body.seats);
    if (!planned.ok) return res.status(planned.status).json({ message: planned.message });

    const months = requestRules.clampMonths(body.months);
    const purchasable = resolvePurchasable(planned.isTeam ? 'team' : planned.plan);
    const entry = purchasable?.entry;
    if (!entry) return res.status(400).json({ message: 'Choose a valid plan.' });

    // One open request per plan per account. Without this a user whose upload
    // keeps failing validation (or a double-tapping client) fills the admin
    // queue with duplicates, and "pending count" stops meaning anything.
    // isTeam is part of the key: a pending Team request must not block a
    // Premium request for the same account, or the reverse.
    const existing = await SubscriptionRequest.findOne({
      user: req.user._id, plan: planned.plan, isTeam: planned.isTeam, status: 'pending',
    }).select('_id createdAt').lean();
    if (existing) {
      return res.status(409).json({
        message: `You already have a ${entry.label} request waiting for review. An administrator will get to it shortly.`,
        code: 'DUPLICATE_REQUEST',
        requestId: String(existing._id),
      });
    }

    // Currency follows the same resolution order as /plans and /purchase, so the
    // figure the user was shown is the figure recorded on the request.
    const { resolveCurrencyForRequest } = require('../utils/currency');
    const currency = await resolveCurrencyForRequest(req, {
      requested: normalizeCurrency(body.currency) || undefined,
    });
    const priced = requestRules.priceRequest(planned.plan, months, currency.code, planned);
    if (!priced) return res.status(400).json({ message: 'Choose a valid plan.' });

    const request = await SubscriptionRequest.create({
      user: req.user._id,
      plan: planned.plan,
      months,
      isTeam: planned.isTeam,
      seats: planned.seats,
      ...priced,
      reference: requestRules.cleanText(body.reference, requestRules.MAX_REFERENCE_LENGTH),
      note: requestRules.cleanText(body.note, requestRules.MAX_NOTE_LENGTH),
      proof: proof.dataUrl,
      proofMime: proof.mime,
      proofBytes: proof.bytes,
    });

    const seatNote = planned.isTeam ? ` x${planned.seats} seats` : '';
    console.log(
      `[subscription/request] user ${req.user._id} -> ${entry.label}${seatNote} x${months} `
      + `(${priced.formattedAmount}, PHP ${priced.amountPhp}), proof ${proof.mime} `
      + `${(proof.bytes / 1024).toFixed(0)} KB, request ${request._id}`,
    );

    // The admin bell. Fire-and-forget on purpose: a failed bell must not lose a
    // request the user already submitted. The queue itself is the source of
    // truth and is polled by the admin panel regardless.
    require('../models/AdminEvent').create({
      type: 'subscription-request',
      title: `${entry.label} upgrade request`,
      detail: `New ${entry.label}${seatNote} request for ${months} month${months === 1 ? '' : 's'} (${priced.formattedAmount}). Proof of payment attached — review and approve to grant the plan.`,
      user: req.user._id,
      linkUserId: req.user._id,
    }).catch((bellError) => {
      console.error('[subscription/request] admin bell', bellError.message);
    });

    return res.status(201).json({
      message: `Your ${entry.label} request was sent. An administrator will review your payment and activate the plan — you will get a notification.`,
      request: {
        ...requestRules.toSummary(request.toObject()),
        planLabel: requestRules.planLabelFor(request.toObject()),
      },
    });
  } catch (error) {
    console.error('[subscription POST /requests]', error.message);
    return res.status(500).json({ message: 'We could not submit your request. Please try again.' });
  }
});

// @route  GET /api/subscription/requests
// @desc   My plan requests, newest first, each with the current plan so the UI
//         can show what I asked for vs. what I have. Excludes the proof image
//         (see requestRules.toSummary) — it is fetched per-request instead.
// @access Private (user)
router.get('/requests', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const [rows, pendingCount] = await Promise.all([
      SubscriptionRequest.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(requestRules.LIST_FIELDS)
        .lean(),
      SubscriptionRequest.countDocuments({ user: req.user._id, status: 'pending' }),
    ]);

    return res.json({
      // `planLabel` comes from the SAME rule the admin queue and the bell use, so
      // the member sees the exact name an administrator sees — and a Team request
      // reads "5× Team" rather than the tier its seats happen to grant.
      requests: (rows || []).map((row) => ({
        ...requestRules.toSummary(row),
        planLabel: requestRules.planLabelFor(row),
      })),
      pendingCount,
    });
  } catch (error) {
    console.error('[subscription GET /requests]', error.message);
    return res.status(500).json({ message: 'Could not load your plan requests.' });
  }
});

// @route  GET /api/subscription/requests/:id
// @desc   One of MY requests, including the proof image so the user can check
//         what they submitted. Owner-scoped: another account's id is a 404, not
//         a 403, so the endpoint cannot be used to probe for valid ids.
// @access Private (user)
router.get('/requests/:id', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid request.' });
    }
    const request = await SubscriptionRequest.findOne({ _id: req.params.id, user: req.user._id }).lean();
    if (!request) return res.status(404).json({ message: 'Request not found.' });
    return res.json({
      request: { ...request, planLabel: requestRules.planLabelFor(request) },
    });
  } catch (error) {
    console.error('[subscription GET /requests/:id]', error.message);
    return res.status(500).json({ message: 'Could not load that request.' });
  }
});

// ══════════════════════════════════════════════════════════════════════════
// CANCELLING — back to Free
//
// The mirror of the request queue above. A member on a paid plan who no longer
// wants it has two honest routes out, and this is where both are implemented:
//
//   POST /cancel-requests   ask an administrator to do it (row sits 'pending')
//   POST /downgrade         do it now, in one call
//
// Both run the SAME subscription engine action ('remove', scope 'all') that the
// admin panel uses, so a cancellation cannot invent a state the rest of the app
// does not already know how to read. Cancelling only ever REMOVES access, which
// is why the immediate path is available even where self-serve billing is off —
// there is nothing to pay and nothing to grant.
// ══════════════════════════════════════════════════════════════════════════

// Cancellation is a write against the account, so it gets the same tight
// budget as a purchase. Never part of the escalating credential lockout: a
// rate-limited customer must not be locked out of their own account.
const cancelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: (req) => {
    const ip = req.ip || '';
    const isLocal = ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '127.0.0.1';
    return isLocal ? 120 : 6;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many cancellation attempts. Please wait a minute and try again.' },
});

/**
 * Run the cancellation for an account and return the fresh authoritative state.
 *
 * Shared by the immediate route and the admin approval, so "what a cancellation
 * does" is written down once. Reads the CURRENT document, applies the engine,
 * writes the record, then reads back — the response is the persisted state, not
 * an in-memory guess, so a default or cast that differed would be visible
 * instead of silently reported as a success.
 */
async function runCancellation(userId, { reason, actor, mode }) {
  const user = await User.findById(userId).select(SUBSCRIPTION_SELECT).lean();
  if (!user) return { ok: false, status: 404, error: 'Account not found.' };

  const before = describeSubscription(user);
  const target = cancelRules.resolveCancellable(before);
  if (!target.ok) return { ok: false, status: target.status, error: target.message };

  const result = subState.applyAction(user.subscriptionRecord, cancelRules.ENGINE_ACTION, {
    actor: actor || 'member',
    scope: 'all',
    note: reason
      ? `Cancelled by ${actor || 'member'}: ${reason}`.slice(0, 240)
      : `Cancelled by ${actor || 'member'}.`,
  }, new Date());
  if (!result.ok) return { ok: false, status: result.status || 400, error: result.error };

  await User.findByIdAndUpdate(user._id, {
    $set: { subscriptionRecord: result.record, ...result.patch },
  });

  const fresh = await User.findById(user._id).select(SUBSCRIPTION_SELECT).lean();
  const state = describeSubscription(fresh);
  // Same push a purchase makes, so every open tab/phone drops to Free at once
  // instead of waiting for a refresh.
  const delivered = bus.publish(String(user._id), state);

  return {
    ok: true,
    state,
    from: target,
    delivered,
    log: `[subscription/cancel] user ${user._id} ${cancelRules.planLabelFor(target)} -> `
      + `${state.currentPlan} (mode=${mode}, actor=${actor || 'member'}); `
      + `pushed to ${delivered} session(s)`,
  };
}

// @route  POST /api/subscription/downgrade
// @desc   End the paid subscription NOW and return to Free. One call, no admin
//         in the loop. Refuses an account that is already on Free rather than
//         writing a no-op "cancelled" row for something that never existed.
// @access Private (user)
router.post('/downgrade', cancelLimiter, protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const reason = cancelRules.cleanReason((req.body || {}).reason);

    const outcome = await runCancellation(req.user._id, { reason, actor: 'member', mode: 'immediate' });
    if (!outcome.ok) return res.status(outcome.status).json({ message: outcome.error });
    console.log(outcome.log);

    const planLabel = cancelRules.planLabelFor(outcome.from);
    const gaveUp = cancelRules.daysRemainingLabel(outcome.from.daysRemaining);

    // An audit row for a change that already happened. Fire-and-forget: the
    // cancellation is done, so a failed bell must not be reported as a failure.
    require('../models/AdminEvent').create({
      type: 'subscription-cancel-request',
      title: `${planLabel} cancelled`,
      detail: `A member cancelled their ${planLabel} plan and returned to Free `
        + `(${gaveUp} given up)${reason ? `. Reason: ${reason}` : '.'}`,
      user: req.user._id,
      linkUserId: req.user._id,
    }).catch((bellError) => {
      console.error('[subscription/downgrade] audit event', bellError.message);
    });

    // The record of what was given up, so the cancellation is reviewable in the
    // same queue as the ones that waited — with mode 'immediate' and status
    // 'applied', which is exactly what happened.
    await SubscriptionCancelRequest.create({
      user: req.user._id,
      plan: outcome.from.plan,
      isTeam: outcome.from.isTeam,
      seats: outcome.from.seats,
      mode: 'immediate',
      reason,
      status: 'applied',
      appliedPlan: 'free',
      appliedAt: new Date(),
    }).catch((recordError) => {
      console.error('[subscription/downgrade] record', recordError.message);
    });

    return res.json({
      message: `Your ${planLabel} plan has ended — you are back on Free.`,
      subscription: outcome.state,
    });
  } catch (error) {
    console.error('[subscription POST /downgrade]', error.message);
    return res.status(500).json({ message: 'We could not cancel your plan. Please try again.' });
  }
});

// @route  POST /api/subscription/cancel-requests
// @desc   Ask an administrator to end the subscription. Nothing changes until an
//         admin approves — the same "a request is a request" rule the upgrade
//         queue follows. `mode: 'immediate'` is accepted here too and routed to
//         the immediate path, so a client can use one endpoint for both doors
//         and still not choose the outcome itself.
// @access Private (user)
router.post('/cancel-requests', cancelLimiter, protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const body = req.body || {};

    const mode = cancelRules.resolveCancelMode(body.mode);
    if (!mode.ok) return res.status(mode.status).json({ message: mode.message });

    const reason = cancelRules.cleanReason(body.reason);

    // One open cancellation per account. Without it a double-tap — or a client
    // retrying on a slow connection — fills the admin queue with duplicates and
    // the pending count stops meaning anything.
    const existing = await SubscriptionCancelRequest.findOne({
      user: req.user._id, status: 'pending',
    }).select('_id createdAt').lean();
    if (existing) {
      return res.status(409).json({
        message: 'You already have a cancellation waiting for review. An administrator will get to it shortly.',
        code: 'DUPLICATE_REQUEST',
        requestId: String(existing._id),
      });
    }

    if (mode.mode === 'immediate') {
      // Same door as POST /downgrade, reached through one endpoint. Routed here
      // rather than duplicated so the two can never behave differently.
      const outcome = await runCancellation(req.user._id, { reason, actor: 'member', mode: 'immediate' });
      if (!outcome.ok) return res.status(outcome.status).json({ message: outcome.error });
      console.log(outcome.log);
      const planLabel = cancelRules.planLabelFor(outcome.from);
      await SubscriptionCancelRequest.create({
        user: req.user._id,
        plan: outcome.from.plan,
        isTeam: outcome.from.isTeam,
        seats: outcome.from.seats,
        mode: 'immediate',
        reason,
        status: 'applied',
        appliedPlan: 'free',
        appliedAt: new Date(),
      }).catch((recordError) => {
        console.error('[subscription/cancel-requests] record', recordError.message);
      });
      return res.json({
        message: `Your ${planLabel} plan has ended — you are back on Free.`,
        subscription: outcome.state,
      });
    }

    // ── The review door ────────────────────────────────────────────────────
    const user = await User.findById(req.user._id).select(SUBSCRIPTION_SELECT).lean();
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    const target = cancelRules.resolveCancellable(describeSubscription(user));
    if (!target.ok) return res.status(target.status).json({ message: target.message });

    const request = await SubscriptionCancelRequest.create({
      user: req.user._id,
      plan: target.plan,
      isTeam: target.isTeam,
      seats: target.seats,
      mode: 'review',
      reason,
    });

    const planLabel = cancelRules.planLabelFor(target);
    console.log(
      `[subscription/cancel-request] user ${req.user._id} -> ${planLabel} `
      + `(${cancelRules.daysRemainingLabel(target.daysRemaining)}), request ${request._id}`,
    );

    // The admin bell, same fire-and-forget rule as an upgrade request: a failed
    // bell must not lose a request the member already submitted.
    require('../models/AdminEvent').create({
      type: 'subscription-cancel-request',
      title: `${planLabel} cancellation request`,
      detail: `A member asked to end their ${planLabel} plan and return to Free `
        + `(${cancelRules.daysRemainingLabel(target.daysRemaining)} remaining). `
        + `Nothing has changed yet — review and approve to apply it.`
        + (reason ? ` Reason given: ${reason}` : ''),
      user: req.user._id,
      linkUserId: req.user._id,
    }).catch((bellError) => {
      console.error('[subscription/cancel-request] admin bell', bellError.message);
    });

    return res.status(201).json({
      message: `Your cancellation request was sent. An administrator will review it — `
        + `your ${planLabel} plan stays active until then.`,
      request: { ...cancelRules.toSummary(request.toObject()), planLabel },
    });
  } catch (error) {
    console.error('[subscription POST /cancel-requests]', error.message);
    return res.status(500).json({ message: 'We could not submit your cancellation request. Please try again.' });
  }
});

// @route  GET /api/subscription/cancel-requests
// @desc   My cancellations, newest first, with the plan I had — so the UI can
//         show what I asked to give up against what I currently have.
// @access Private (user)
router.get('/cancel-requests', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));

    const [rows, pendingCount] = await Promise.all([
      SubscriptionCancelRequest.find({ user: req.user._id })
        .sort({ createdAt: -1 })
        .limit(limit)
        .select(cancelRules.LIST_FIELDS)
        .lean(),
      SubscriptionCancelRequest.countDocuments({ user: req.user._id, status: 'pending' }),
    ]);

    return res.json({
      requests: (rows || []).map((row) => ({
        ...cancelRules.toSummary(row),
        planLabel: cancelRules.planLabelFor(row),
        statusMessage: cancelRules.statusMessageFor(row),
      })),
      pendingCount,
    });
  } catch (error) {
    console.error('[subscription GET /cancel-requests]', error.message);
    return res.status(500).json({ message: 'Could not load your cancellation requests.' });
  }
});

// @route  GET /api/subscription
// @desc   Authoritative entitlement state for the signed-in user
// @access Private (user)
router.get('/', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id).select(SUBSCRIPTION_SELECT).lean();
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    res.json({ serverTime: new Date().toISOString(), subscription: describeSubscription(user) });
  } catch (error) {
    console.error('[subscription GET /]', error.message);
    res.status(500).json({ message: 'Could not load your subscription. Please try again.' });
  }
});

// @route  GET /api/subscription/feature/:key
// @desc   Backend authorization check for a single feature. 200 = allowed,
//         403 = { allowed:false, feature, requiresPlan, currentPlan, ... }.
//         Used by flows like PDF export where the document is rendered on the
//         client: the export path must pass this gate before proceeding.
// @access Private (user)
router.get('/feature/:key', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    // Own-property lookup: `FEATURES[key]` on raw request input would also
    // match inherited keys (`constructor`, `toString`, …) and their truthy
    // value would skip the "unknown feature" branch. getFeature() returns
    // undefined for anything not registered, so unknown keys fail closed.
    const key = String(req.params.key || '').trim();
    const def = getFeature(key);
    const user = await User.findById(req.user._id).select(SUBSCRIPTION_SELECT).lean();
    if (!user) return res.status(404).json({ message: 'Account not found.' });
    const state = describeSubscription(user);
    if (!def || !can(user, key)) {
      const minTier = def ? def.minTier : 'free';
      return res.status(403).json({
        allowed: false,
        feature: key,
        requiresPlan: minTier,
        requiresPlanLabel: PLAN_LABELS[minTier] || minTier,
        currentPlan: state.currentPlan,
        subscriptionStatus: state.subscriptionStatus,
        message: `${def ? def.label : 'This feature'} requires the ${PLAN_LABELS[minTier] || minTier} plan. Please upgrade to continue.`,
      });
    }
    res.json({ allowed: true, feature: key, currentPlan: state.currentPlan });
  } catch (error) {
    console.error('[subscription GET /feature]', error.message);
    res.status(500).json({ message: 'Could not verify your subscription. Please try again.' });
  }
});

// @route  GET /api/subscription/stream
// @desc   Server-Sent Events channel. Emits the authoritative state on connect
//         and immediately after every change that affects this user (admin
//         upgrade/downgrade/cancel/remove/expiry). The connection closes when
//         the access token expires so the client re-authenticates cleanly.
// @access Private (user) — accepts ?token= for EventSource
router.get('/stream', streamTokenAuth, protect, async (req, res) => {
  if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
  try {
    const user = await User.findById(req.user._id).select(SUBSCRIPTION_SELECT).lean();
    if (!user) return res.status(404).json({ message: 'Account not found.' });

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Disable proxy buffering so events arrive instantly (nginx/CDN).
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    const send = (state) => {
      if (closed || res.writableEnded) return;
      try {
        sseWrite(res, 'subscription', { serverTime: new Date().toISOString(), subscription: state });
      } catch {
        closed = true;
      }
    };

    // Snapshot on connect — a reconnecting client catches up without a second fetch.
    send(describeSubscription(user));

    const userId = String(req.user._id);
    const unsubscribe = bus.subscribe(userId, send);
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try {
        res.write(': hb\n\n');
      } catch {
        closed = true;
      }
    }, SSE_HEARTBEAT_MS);

    // Close the stream when the access token expires so the client reconnects
    // with a fresh token (normal session-expiry handling) instead of silently
    // riding a dead credential.
    let expTimer = null;
    try {
      const raw = (req.headers.authorization || '').split(' ')[1] || '';
      const exp = raw ? jwt.decode(raw)?.exp : null;
      if (exp) {
        const ttl = exp * 1000 - Date.now() - 5_000;
        if (ttl > 0 && ttl < 60 * 60 * 1000) expTimer = setTimeout(() => cleanup(), ttl);
      }
    } catch { /* best-effort */ }

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (expTimer) clearTimeout(expTimer);
      unsubscribe();
      try { res.end(); } catch { /* already closed */ }
    }

    req.on('close', cleanup);
  } catch (error) {
    console.error('[subscription GET /stream]', error.message);
    if (!res.headersSent) res.status(500).json({ message: 'Could not open the subscription stream.' });
    else try { res.end(); } catch { /* ignore */ }
  }
});

module.exports = router;

