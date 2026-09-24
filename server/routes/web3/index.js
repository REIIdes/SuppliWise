const express = require('express');
const { protect } = require('../../middleware/auth');

const chainRouter = require('./chain');
const supplyRouter = require('./supply');
const rewardsRouter = require('./rewards');
const marketRouter = require('./market');
const governRouter = require('./govern');
const dataRouter = require('./data');
const ecosystemRouter = require('./ecosystem');

// ═══════════════════════════════════════════════════════════════════════════
// /api/web3 — SuppliWise blockchain layer router.
//
// Order matters: the three PUBLIC endpoints (QR verification of a physical
// bottle + shared health-profile links) are registered before `protect`, so
// a consumer can scan a code without an account. Everything else requires a
// signed-in USER session (admins are rejected by the per-router guard —
// admin identities have no health/wallet semantics here).
// ═══════════════════════════════════════════════════════════════════════════

const router = express.Router();

// ── Public (no account needed) ────────────────────────────────────────────
// #1 Immutable supply chain tracking — scan-to-verify any bottle.
router.get('/verify/:code', supplyRouter.verifyBatch);
// QR payload for a batch (points scanners at /verify/<code>).
router.get('/verify/:code/qr', supplyRouter.batchQr);
// #16 Interoperable health profile — time-boxed, revocable share links.
router.get('/share/:token', dataRouter.publicShare);

// ── Authenticated ─────────────────────────────────────────────────────────
router.use(protect);

router.use('/', chainRouter);       // wallet/DID, chain explorer, tx lookup, config
router.use('/', supplyRouter);      // supply batches, journey steps, certifications
router.use('/', rewardsRouter);     // rewards, NFTs, staking, loyalty
router.use('/', marketRouter);      // marketplace, escrow orders, disputes
router.use('/', governRouter);      // DAO + knowledge base
router.use('/', dataRouter);        // health ledger, storage, consent, AI proof, shares
router.use('/', ecosystemRouter);   // trials, oracles, professionals

module.exports = router;
