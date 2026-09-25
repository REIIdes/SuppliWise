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
const { SEED_ORACLE_FEEDS, seededValue } = require('../../blockchain/seed');
const { requireFeature } = require('../../utils/entitlements');

const router = express.Router();

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

    let consent;
    try {
      consent = await TrialConsent.create({ user: req.user._id, trial: trial._id, status: 'opted-in', termsHash });
    } catch (err) {
      if (err && err.code === 11000) return res.status(400).json({ message: 'You already have a consent record for this trial.' });
      throw err;
    }
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
router.get('/oracle/feeds', async (req, res) => {
  try {
    const feeds = await OracleFeed.find({}).sort({ category: 1, key: 1 }).lean();
    res.json({ feeds, refreshedAt: feeds.length ? feeds[0].updatedAt : null });
  } catch (error) {
    console.error('[web3 GET /oracle/feeds]', error.message);
    res.status(500).json({ message: 'Could not load oracle feeds.' });
  }
});

// Re-derive today's values (deterministic per day — auditable) and push each
// change on-chain. The same routine runs at boot, so feeds are never empty.
router.post('/oracle/refresh', async (req, res) => {
  try {
    const day = dayKey();
    const updated = [];
    for (const feed of SEED_ORACLE_FEEDS) {
      const value = seededValue(feed, day);
      const existing = await OracleFeed.findOne({ key: feed.key });
      if (existing && existing.value === value && existing.txHash) {
        updated.push({ key: feed.key, value, changed: false });
        continue;
      }
      const tx = await engine.anchor('oracle:update', 'sw:oracle', {
        public: { key: feed.key, value, unit: feed.unit, day },
      });
      if (existing) {
        existing.value = value;
        existing.txHash = tx.txs[0] || '';
        existing.updatedAt = Date.now();
        await existing.save();
      } else {
        try {
          await OracleFeed.create({
            key: feed.key,
            label: feed.label,
            value,
            unit: feed.unit,
            category: feed.category,
            source: 'SuppliWise Oracle Network',
            txHash: tx.txs[0] || '',
          });
        } catch (err) {
          // Another request refreshed this feed first — apply the
          // value to the winner instead of crashing the sweep.
          if (err && err.code === 11000) {
            await OracleFeed.updateOne({ key: feed.key }, { $set: { value, txHash: tx.txs[0] || '', updatedAt: Date.now() } });
          } else {
            throw err;
          }
        }
      }
      updated.push({ key: feed.key, value, changed: true });
    }
    res.json({ feeds: await OracleFeed.find({}).sort({ category: 1, key: 1 }).lean(), day, updated });
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
    const payment = await engine.transfer({
      from: wallet.address,
      to: 'sw_system_expert_pool',
      amount: cost,
      type: 'consult:book',
      public: { expert: expert.name, hours, cost },
    });
    const booking = await Booking.create({
      expert: expert._id,
      user: req.user._id,
      userAddress: wallet.address,
      hours,
      cost,
      txHash: payment.txHash,
    });
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
