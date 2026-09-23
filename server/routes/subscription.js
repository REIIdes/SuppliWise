/**
 * /api/subscription — the user's authoritative subscription surface.
 *
 *   GET /                -> full entitlement state (single source for all UI)
 *   GET /feature/:key    -> backend authorization for one feature (200 | 403)
 *   GET /stream          -> SSE push: fires on every admin/expiry change so the
 *                           user's open tab/phone syncs instantly, no refresh.
 *
 * Every response is computed from the CURRENT user document (protect re-reads
 * it per request), so there is never a server-side cache to invalidate.
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const { describeSubscription, can, getFeature, PLAN_LABELS } = require('../utils/entitlements');
const bus = require('../utils/subscriptionBus');

const router = express.Router();

const SSE_HEARTBEAT_MS = 25_000;

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

// @route  GET /api/subscription
// @desc   Authoritative entitlement state for the signed-in user
// @access Private (user)
router.get('/', protect, async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const user = await User.findById(req.user._id)
      .select('subscriptionActive subscriptionPlan subscriptionUpdatedAt subscriptionStartedAt subscriptionExpiresAt')
      .lean();
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
    const user = await User.findById(req.user._id)
      .select('subscriptionActive subscriptionPlan subscriptionUpdatedAt subscriptionStartedAt subscriptionExpiresAt')
      .lean();
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
    const user = await User.findById(req.user._id)
      .select('subscriptionActive subscriptionPlan subscriptionUpdatedAt subscriptionStartedAt subscriptionExpiresAt')
      .lean();
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

