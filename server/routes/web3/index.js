const express = require('express');
const { protect } = require('../../middleware/auth');
const { userOnly, web3PlanGate } = require('./guards');

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

// ── DELUXE plan gate ──────────────────────────────────────────────────────
// The whole blockchain layer is a DELUXE entitlement. It used to sit behind
// `protect` only, so any signed-in FREE user could create a wallet, mint NFTs,
// lock tokens in staking, escrow funds and vote in the DAO.
//
// ONE gate, applied here, keyed on the request path — see routes/web3/guards.js
// for why it cannot live in the sub-routers: they are all mounted at '/', so a
// guard inside any one of them runs for EVERY path, and the first mount's gate
// would then report the wrong feature (/market/* answering "Web3 requires
// DELUXE"). Attached as the second handler it does not run at all, because the
// sub-router has already answered.
//
// Below `protect` and below the three public routes above: bottle
// verification and share links are read by consumers with no account and no
// plan, so they must stay reachable.
router.use(userOnly, web3PlanGate);

router.use('/', chainRouter);       // wallet/DID, chain explorer, tx lookup, config
router.use('/', supplyRouter);      // supply batches, journey steps, certifications
router.use('/', rewardsRouter);     // rewards, NFTs, staking, loyalty
router.use('/', marketRouter);      // marketplace, escrow orders, disputes
router.use('/', governRouter);      // DAO + knowledge base
router.use('/', dataRouter);        // health ledger, storage, consent, AI proof, shares
router.use('/', ecosystemRouter);   // trials, oracles, professionals

module.exports = router;
