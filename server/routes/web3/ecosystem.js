const express = require('express');
const mongoose = require('mongoose');
const {
  Trial,
  TrialConsent,
  OracleFeed,
  Expert,
  Booking,
} = require('../../models/Web3');
const engine = require('../../blockchain/engine');
const { hashPayload, dayKey, round2 } = require('../../blockchain/crypto');
const {
  SEED_ORACLE_FEEDS,
  seededValue,
  refreshOracleFeeds,
  ensureOracleFeedsFresh,
} = require('../../blockchain/seed');
const { requireFeature } = require('../../utils/entitlements');

const router = express.Router();

// Minimum gap between two *forced* oracle refreshes. See POST /oracle/refresh.
const ORACLE_REFRESH_LATCH_MS = 60 * 1000;
let lastManualRefreshAt = 0;

function userOnly(req, res, next) {
  if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
  next();
}
// DELUXE plan gate for trials, oracles and the professional directory.
router.use(userOnly, requireFeature('web3'));

// ── Secure clinical trial participation (feature 18) ──────────────────────
router.get('/trials', async (req, res) => {
  try {
    const [trials, consents] = await Promise.all([
      Trial.find({ status: 'open' }).sort({ createdAt: -1 }).lean(),
      TrialConsent.find({ user: req.user._id }).lean(),
    ]);
    const byTrial = new Map(consents.map((c) => [String(c.trial), c]));
    res.json({
      trials: trials.map((t) => {
        const consent = byTrial.get(String(t._id)) || null;
        return {
          ...t,
          consent: consent
            ? { status: consent.status, termsHash: consent.termsHash, consentTx: consent.consentTx, at: consent.createdAt, reward: consent.reward }
            : null,
        };
      }),
    });
  } catch (error) {
    console.error('[web3 GET /trials]', error.message);
    res.status(500).json({ message: 'Could not load clinical trials.' });
  }
});

// Opt-in = a smart-contract consent record: the exact terms digest, the data
// scope and withdrawal rights are anchored on-chain.
router.post('/trials/:id/optin', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid trial.' });
    const trial = await Trial.findOne({ _id: req.params.id, status: 'open' });
    if (!trial) return res.status(404).json({ message: 'Trial not found or closed.' });

    const terms = {
      trial: trial.title,
      sponsor: trial.sponsor,
      dataScope: ['assessment-summaries', 'intake-history', 'anonymized-demographics'],
      revocable: true,
      rewardWell: trial.rewardWell,
    };
    const termsHash = hashPayload(terms);
    const wallet = await engine.getWalletDoc(req.user._id);

    // Upsert, not insert. A plain create made the unique (user, trial) index
    // turn a withdrawal into a PERMANENT dead end: after withdrawing, the user
    // could never re-consent and could never re-earn the reward, even though
    // withdrawal is documented as revocable consent rather than a ban.
    const existing = await TrialConsent.findOne({ user: req.user._id, trial: trial._id });
    if (existing && existing.status === 'opted-in') {
      return res.status(400).json({ message: 'You already have an active consent record for this trial.' });
    }
    const consent =
      existing ||
      new TrialConsent({ user: req.user._id, trial: trial._id });
    consent.status = 'opted-in';
    consent.termsHash = termsHash;
    consent.withdrawnAt = 0;
    await consent.save();

    const tx = await engine.anchor('trial:consent', wallet.address, {
      public: { trial: String(trial._id), termsHash, sponsor: trial.sponsor },
    });
    consent.consentTx = tx.txs[0] || '';
    await consent.save();

    const reward = await engine.grantReward({
      userId: req.user._id,
      kind: 'trial',
      refId: String(trial._id),
      amount: trial.rewardWell,
      public: { trial: String(trial._id) },
    });
    // Persist what was actually paid. The schema field was never written, so
    // GET /trials reported consent.reward = 0 for every participant even though
    // the WELL had been credited.
    consent.reward = reward.amount;
    consent.rewardTx = reward.txHash || '';
    await consent.save();
    res.status(201).json({ consent, reward: reward.amount });
  } catch (error) {
    console.error('[web3 POST /trials/:id/optin]', error.message);
    res.status(500).json({ message: 'Could not record your consent.' });
  }
});

router.post('/trials/:id/withdraw', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid trial.' });
    const consent = await TrialConsent.findOne({ user: req.user._id, trial: req.params.id });
    if (!consent) return res.status(404).json({ message: 'No consent record for this trial.' });
    if (consent.status === 'withdrawn') return res.json({ consent, message: 'Consent already withdrawn.' });
    consent.status = 'withdrawn';
    consent.withdrawnAt = Date.now();
    const wallet = await engine.getWalletDoc(req.user._id);
    const tx = await engine.anchor('trial:withdraw', wallet.address, {
      public: { trial: String(req.params.id), termsHash: consent.termsHash },
    });
    consent.withdrawTx = tx.txs[0] || '';
    await consent.save();
    res.json({ consent, message: 'Consent withdrawn and recorded on-chain.' });
  } catch (error) {
    console.error('[web3 POST /trials/:id/withdraw]', error.message);
    res.status(500).json({ message: 'Could not withdraw consent.' });
  }
});

// ── Decentralized oracles (feature 19) ────────────────────────────────────
// `refreshOracleFeeds` is the single source of truth for re-deriving feed
// values; it is the same routine the boot sweep and the background sweeper run,
// so a manual refresh can never produce a different result than the automatic
// ones.
router.get('/oracle/feeds', async (req, res) => {
  try {
    // Read-through freshness: never hand a client a stale value just because
    // the background sweep has not fired yet. Throttled internally.
    await ensureOracleFeedsFresh();
    const feeds = await OracleFeed.find({}).sort({ category: 1, key: 1 }).lean();
    res.json({ feeds, refreshedAt: feeds.length ? feeds[0].updatedAt : null });
  } catch (error) {
    console.error('[web3 GET /oracle/feeds]', error.message);
    res.status(500).json({ message: 'Could not load oracle feeds.' });
  }
});

// Re-derive today's values (deterministic per day — auditable) and push each
// change on-chain. The same routine runs at boot and on a timer, so feeds are
// never empty and never stale.
router.post('/oracle/refresh', async (req, res) => {
  // Each *changed* feed costs one mined block, and `anchor` is serialised
  // through a single CPU-bound mining queue. A manual refresh therefore used to
  // be a free way to queue six blocks per request. Latch it to one run per
  // sweep window: a legitimate user pressing the button twice gets the same
  // (already current) answer instead of six more blocks.
  //
  // The response SHAPE is identical either way — `feeds`, `day` and `updated`
  // are always present. Returning a different shape on the throttled path
  // pushed the "is this an error?" decision onto every client.
  const day = dayKey();
  const throttled = Date.now() - lastManualRefreshAt < ORACLE_REFRESH_LATCH_MS;
  try {
    if (throttled) {
      const feeds = await OracleFeed.find({}).sort({ category: 1, key: 1 }).lean();
      const byKey = new Map(feeds.map((f) => [f.key, f]));
      return res.json({
        feeds,
        day,
        throttled: true,
        message: 'Oracle feeds were refreshed moments ago. Values are re-derived once per day, so a repeat refresh returns the same figures.',
        updated: SEED_ORACLE_FEEDS.map((feed) => ({
          key: feed.key,
          value: byKey.has(feed.key) ? byKey.get(feed.key).value : seededValue(feed, day),
          changed: false,
        })),
      });
    }
    lastManualRefreshAt = Date.now();
    const { day: publishedDay, updated } = await refreshOracleFeeds({ force: true });
    res.json({
      feeds: await OracleFeed.find({}).sort({ category: 1, key: 1 }).lean(),
      day: publishedDay,
      throttled: false,
      updated,
    });
  } catch (error) {
    console.error('[web3 POST /oracle/refresh]', error.message);
    res.status(500).json({ message: 'Could not refresh oracle feeds.' });
  }
});

// ── Tokenized access to health professionals (feature 20) ─────────────────
router.get('/experts', async (req, res) => {
  try {
    const experts = await Expert.find({ active: true }).sort({ rateWell: 1 }).lean();
    res.json({ experts });
  } catch (error) {
    console.error('[web3 GET /experts]', error.message);
    res.status(500).json({ message: 'Could not load professionals.' });
  }
});

router.post('/experts/:id/book', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid professional.' });
    const expert = await Expert.findOne({ _id: req.params.id, active: true });
    if (!expert) return res.status(404).json({ message: 'Professional not found.' });
    const hours = parseInt(req.body.hours, 10);
    if (!Number.isInteger(hours) || hours < 1 || hours > 8) {
      return res.status(400).json({ message: 'Hours must be between 1 and 8.' });
    }
    const cost = round2(expert.rateWell * hours);
    const wallet = await engine.getWalletDoc(req.user._id);

    // Create the booking FIRST, then take payment. Paying first meant a
    // Booking.create failure left the WELL in the expert pool with no booking
    // row and no txHash to reconcile against — the cancellation path was
    // rollback-guarded, this one was not.
    const booking = await Booking.create({
      expert: expert._id,
      user: req.user._id,
      userAddress: wallet.address,
      hours,
      cost,
      status: 'pending',
    });

    let payment;
    try {
      payment = await engine.transfer({
        from: wallet.address,
        to: 'sw_system_expert_pool',
        amount: cost,
        type: 'consult:book',
        public: { expert: expert.name, hours, cost },
      });
    } catch (err) {
      // Payment failed — drop the un-paid booking rather than leaving a
      // 'pending' row no one can ever settle or cancel.
      await Booking.deleteOne({ _id: booking._id, status: 'pending' }).catch(() => {});
      throw err;
    }

    booking.status = 'confirmed';
    booking.txHash = payment.txHash;
    await booking.save();
    res.status(201).json({ booking, txHash: payment.txHash, balance: payment.fromBalance });
  } catch (error) {
    if (error.code && typeof error.code === 'string') {
      return res.status(400).json({ message: error.message, code: error.code });
    }
    console.error('[web3 POST /experts/:id/book]', error.message);
    res.status(500).json({ message: 'Could not book the consultation.' });
  }
});

router.get('/bookings', async (req, res) => {
  try {
    const bookings = await Booking.find({ user: req.user._id })
      .populate('expert', 'name specialty title rateWell')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ bookings });
  } catch (error) {
    console.error('[web3 GET /bookings]', error.message);
    res.status(500).json({ message: 'Could not load bookings.' });
  }
});

router.post('/bookings/:id/cancel', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid booking.' });
    const booking = await Booking.findOne({ _id: req.params.id, user: req.user._id });
    if (!booking) return res.status(404).json({ message: 'Booking not found.' });
    const claimed = await Booking.updateOne(
      { _id: booking._id, user: req.user._id, status: 'confirmed' },
      { $set: { status: 'cancelled' } }
    );
    if (claimed.modifiedCount !== 1) {
      const fresh = await Booking.findOne({ _id: booking._id, user: req.user._id });
      if (!fresh) return res.status(404).json({ message: 'Booking not found.' });
      return res.json({ booking: fresh, message: 'Already cancelled.' });
    }
    booking.status = 'cancelled';
    const wallet = await engine.getWalletDoc(req.user._id);
    let refund;
    try {
      refund = await engine.transfer({
        from: 'sw_system_expert_pool',
        to: wallet.address,
        amount: booking.cost,
        type: 'consult:refund',
        public: { booking: String(booking._id) },
      });
    } catch (err) {
      // Refund failed — revert the claim so the booking isn't lost unpaid.
      await Booking.updateOne(
        { _id: booking._id, status: 'cancelled' },
        { $set: { status: 'confirmed' } }
      ).catch(() => {});
      throw err;
    }
    res.json({ booking, txHash: refund.txHash, message: 'Booking cancelled and refunded.' });
  } catch (error) {
    if (error.code && typeof error.code === 'string') {
      return res.status(400).json({ message: error.message, code: error.code });
    }
    console.error('[web3 POST /bookings/:id/cancel]', error.message);
    res.status(500).json({ message: 'Could not cancel the booking.' });
  }
});

module.exports = router;
