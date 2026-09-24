const express = require('express');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const { SupplyBatch, SUPPLY_STEPS } = require('../../models/Web3');
const engine = require('../../blockchain/engine');
const ledger = require('../../blockchain/ledger');
const { hashPayload, sha256Hex } = require('../../blockchain/crypto');

const router = express.Router();

const STEP_LABELS = {
  'raw-sourcing': 'Raw material sourcing',
  manufacturing: 'Manufacturing',
  'lab-testing': 'Third-party lab testing',
  'quality-release': 'Quality release',
  distribution: 'Distribution',
  retail: 'Retail receipt',
  delivered: 'Delivered to customer',
};

const CERT_TYPES = ['lab-report', 'organic', 'non-gmo', 'third-party', 'gmp', 'other'];

function ownerFilter(req) {
  return { createdBy: req.user._id };
}

// ── Public verification (QR target — no account needed to scan) ────────────
// Returns the batch's full journey, its anchored certifications, and a chain
// proof: each event/cert tx is re-checked against its block so the reader
// sees tamper-evidence, not just claims.
async function verifyBatch(req, res) {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) {
      return res.status(400).json({ message: 'Invalid verification code.', verified: false });
    }
    const batch = await SupplyBatch.findOne({ code }).lean();
    if (!batch) {
      return res.status(404).json({ message: 'No batch found for this code.', verified: false, code });
    }

    // Recompute the hash of every anchored tx and check its block linkage.
    const txHashes = [
      ...batch.events.map((e) => e.txHash),
      ...batch.certifications.map((c) => c.txHash),
    ].filter(Boolean);
    const blocks = await Block_lookup(txHashes);
    let proofsChecked = 0;
    let proofsValid = 0;
    for (const hash of txHashes) {
      const block = blocks.get(hash);
      if (!block) continue;
      proofsChecked += 1;
      const recomputed = ledger.headerHash(block);
      if (recomputed === block.hash) proofsValid += 1;
    }

    res.json({
      verified: proofsChecked > 0 && proofsValid === proofsChecked,
      code: batch.code,
      productName: batch.productName,
      brand: batch.brand,
      notes: batch.notes,
      createdAt: batch.createdAt,
      steps: batch.events
        .slice()
        .sort((a, b) => a.at - b.at)
        .map((e) => ({
          step: e.step,
          label: STEP_LABELS[e.step] || e.step,
          location: e.location,
          note: e.note,
          actorName: e.actorName,
          at: e.at,
          txHash: e.txHash,
          blockIndex: e.blockIndex,
        })),
      certifications: batch.certifications.map((c) => ({
        type: c.type,
        name: c.name,
        issuer: c.issuer,
        resultHash: c.resultHash,
        at: c.at,
        txHash: c.txHash,
        blockIndex: c.blockIndex,
      })),
      proof: {
        checks: proofsChecked,
        valid: proofsValid,
        difficulty: ledger.difficulty,
        height: ledger.height,
        network: 'SuppliWise Mainnet (proof-of-work)',
      },
    });
  } catch (error) {
    console.error('[web3 verify]', error.message);
    res.status(500).json({ message: 'Could not verify this batch.', verified: false });
  }
}

// Fetch all blocks containing the given tx hashes in one query.
async function Block_lookup(txHashes) {
  const map = new Map();
  if (!txHashes.length) return map;
  const { Block } = require('../../models/Web3');
  const docs = await Block.find({ 'txs.txHash': { $in: txHashes } }).lean();
  for (const doc of docs) {
    for (const tx of doc.txs || []) {
      if (txHashes.includes(tx.txHash)) map.set(tx.txHash, doc);
    }
  }
  return map;
}

// QR code for a batch (points scanners at /verify/<code>).
async function batchQr(req, res) {
  try {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{4,32}$/.test(code)) return res.status(400).json({ message: 'Invalid verification code.' });
    const batch = await SupplyBatch.findOne({ code }).lean();
    if (!batch) return res.status(404).json({ message: 'No batch found for this code.' });
    const base = String(req.query.base || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) return res.status(400).json({ message: 'Missing or invalid base URL.' });
    const url = `${base}/verify/${code}`;
    const qr = await QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: '#0f172a', light: '#ffffff' } });
    res.json({ qr, url, code });
  } catch (error) {
    console.error('[web3 qr]', error.message);
    res.status(500).json({ message: 'Could not render the QR code.' });
  }
}

// ── Authenticated brand/manufacturer endpoints ─────────────────────────────
// @route   GET /api/web3/supply/batches
// @desc    Batches this account has created (with journey + certifications)
// @access  Private
router.get('/supply/batches', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const batches = await SupplyBatch.find(ownerFilter(req))
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    res.json({ batches, steps: SUPPLY_STEPS.map((s) => ({ key: s, label: STEP_LABELS[s] })), certTypes: CERT_TYPES });
  } catch (error) {
    console.error('[web3 GET /supply/batches]', error.message);
    res.status(500).json({ message: 'Could not load batches.' });
  }
});

// @route   POST /api/web3/supply/batches
// @desc    Register a new batch (generates the QR verification code) and log
//          its creation as the first on-chain step.
// @access  Private
router.post('/supply/batches', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const productName = String(req.body.productName || '').trim().slice(0, 120);
    const brand = String(req.body.brand || '').trim().slice(0, 80);
    const notes = String(req.body.notes || '').slice(0, 500);
    if (productName.length < 3) return res.status(400).json({ message: 'Product name must be at least 3 characters.' });
    if (brand.length < 2) return res.status(400).json({ message: 'Brand name must be required.' });

    const wallet = await engine.getWalletDoc(req.user._id);
    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      code = `SW-${sha256Hex(`${req.user._id}:${Date.now()}:${attempt}`).slice(0, 8).toUpperCase()}`;
      const clash = await SupplyBatch.exists({ code });
      if (!clash) break;
      code = '';
    }
    if (!code) return res.status(500).json({ message: 'Could not allocate a batch code.' });

    const tx = await engine.anchor('supply:create', wallet.address, {
      public: { code, productName, brand },
    });
    const batch = await SupplyBatch.create({
      code,
      productName,
      brand,
      notes,
      createdBy: req.user._id,
      events: [
        {
          step: 'raw-sourcing',
          location: '',
          note: 'Batch registered on the SuppliWise supply chain ledger.',
          actorName: brand,
          txHash: tx.txs[0] || '',
          blockIndex: tx.index,
          at: Date.now(),
        },
      ],
    });
    res.status(201).json({ batch });
  } catch (error) {
    console.error('[web3 POST /supply/batches]', error.message);
    res.status(500).json({ message: 'Could not create the batch.' });
  }
});

// @route   POST /api/web3/supply/batches/:id/events
// @desc    Append a journey step (owner only) — anchored on-chain first so
//          the stored event always carries a valid tx reference.
// @access  Private
router.post('/supply/batches/:id/events', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid batch.' });
    const location = String(req.body.location || '').slice(0, 120);
    const note = String(req.body.note || '').slice(0, 400);
    const actorName = String(req.body.actorName || '').slice(0, 80);

    const wallet = await engine.getWalletDoc(req.user._id);
    const step = String(req.body.step || '');
    if (!SUPPLY_STEPS.includes(step)) return res.status(400).json({ message: 'Unknown supply chain step.' });
    let batch = null;
    let tx = null;
    let previous = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      batch = await SupplyBatch.findOne({ _id: req.params.id, ...ownerFilter(req) });
      if (!batch) return res.status(404).json({ message: 'Batch not found.' });
      previous = batch.events[batch.events.length - 1];
      if (previous && SUPPLY_STEPS.indexOf(step) <= SUPPLY_STEPS.indexOf(previous.step)) {
        return res.status(400).json({ message: 'Supply chain steps must move forward in sequence.' });
      }
      if (!tx) {
        tx = await engine.anchor('supply:step', wallet.address, {
          public: { code: batch.code, step, at: Date.now(), prev: previous?.txHash || null },
        });
      }
      const event = { step, location, note, actorName, txHash: tx.txs[0] || '', blockIndex: tx.index, at: Date.now() };
      const pushed = await SupplyBatch.updateOne(
        { _id: batch._id, ...ownerFilter(req), events: { $size: batch.events.length } },
        { $push: { events: event } }
      );
      if (pushed.modifiedCount === 1) break;
      batch = null; // loop reloads + re-validates against a fresh read
    }
    if (!batch) return res.status(409).json({ message: 'Batch changed concurrently — please retry.' });
    const fresh = await SupplyBatch.findById(req.params.id);
    res.json({ batch: fresh });
  } catch (error) {
    console.error('[web3 POST /supply/batches/:id/events]', error.message);
    res.status(500).json({ message: 'Could not append the supply chain step.' });
  }
});

// @route   POST /api/web3/supply/batches/:id/certifications
// @desc    Anchor a third-party lab result / certification to the batch.
//          The result document's digest (or an uploaded storage CID) becomes
//          the tamper-proof evidence pointer.
// @access  Private
router.post('/supply/batches/:id/certifications', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid batch.' });
    const batch = await SupplyBatch.findOne({ _id: req.params.id, ...ownerFilter(req) });
    if (!batch) return res.status(404).json({ message: 'Batch not found.' });

    const type = String(req.body.type || 'other');
    if (!CERT_TYPES.includes(type)) return res.status(400).json({ message: 'Unknown certification type.' });
    const name = String(req.body.name || '').trim();
    const issuer = String(req.body.issuer || '').trim();
    if (name.length < 3) return res.status(400).json({ message: 'Certification name is required.' });
    if (issuer.length < 2) return res.status(400).json({ message: 'Issuing body is required.' });

    const suppliedHash = String(req.body.resultHash || '').trim();
    const fileCid = String(req.body.fileCid || '').trim();
    const resultHash = /^([a-f0-9]{64}|bafy[a-z2-7]+)$/i.test(suppliedHash)
      ? suppliedHash
      : hashPayload({ code: batch.code, type, name, issuer, fileCid });

    const wallet = await engine.getWalletDoc(req.user._id);
    const tx = await engine.anchor('cert:anchor', wallet.address, {
      public: { code: batch.code, name, issuer, type, resultHash },
    });
    const cert = { type, name, issuer, resultHash, fileCid, txHash: tx.txs[0] || '', blockIndex: tx.index, at: Date.now() };
    await SupplyBatch.updateOne({ _id: batch._id, ...ownerFilter(req) }, { $push: { certifications: cert } });
    const fresh = await SupplyBatch.findById(req.params.id);
    res.json({ batch: fresh });
  } catch (error) {
    console.error('[web3 POST /supply/batches/:id/certifications]', error.message);
    res.status(500).json({ message: 'Could not anchor the certification.' });
  }
});

module.exports = router;
// Public controllers (mounted without auth by web3/index.js)
module.exports.verifyBatch = verifyBatch;
module.exports.batchQr = batchQr;
