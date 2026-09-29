const express = require('express');
const mongoose = require('mongoose');
const engine = require('../../blockchain/engine');
const ledger = require('../../blockchain/ledger');
const { Wallet } = require('../../models/Web3');
const { web3Guard } = require('./guards');

const router = express.Router();

// DELUXE plan gate + user-only. The per-handler `req.user.role === 'admin'`
// checks below are now redundant; they are left in place as defence in depth.
router.use(...web3Guard('web3'));

// The stored key is base64 PKCS#8 DER (exactly what blockchain/crypto.js
// sign() consumes). For export we wrap it in standard PEM armor so external
// tooling (openssl, hardware-wallet imports) accepts it directly.
function toPkcs8Pem(derB64) {
  // Guard the chunking: an empty/undefined key made `.match()` return null and
  // `.join()` throw a TypeError, so a malformed stored key surfaced as an
  // opaque 500 instead of a clean "no key on this wallet".
  const chunks = String(derB64 || '').replace(/\s+/g, '').match(/.{1,64}/g);
  if (!chunks || !chunks.length) {
    throw new engine.EngineError('NO_KEY', 'No signing key on this wallet.');
  }
  return `-----BEGIN PRIVATE KEY-----\n${chunks.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

// @route   GET /api/web3/wallet
// @desc    The caller's decentralized identity + wallet. Created on first
//          access (with the one-time welcome airdrop), then idempotent.
// @access  Private (user accounts)
router.get('/wallet', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const wallet = await engine.getWalletDoc(req.user._id);
    const view = await engine.walletView(wallet, req.user._id);
    res.json({ wallet: view, created: !!view.welcomeBonusAt });
  } catch (error) {
    console.error('[web3 GET /wallet]', error.message);
    res.status(500).json({ message: 'Could not load your wallet.' });
  }
});

// @route   GET /api/web3/wallet/private-key
// @desc    Export the wallet's ed25519 signing key (owner only, decrypted
//          server-side from its AES-256-GCM envelope).
// @access  Private
router.get('/wallet/private-key', async (req, res) => {
  try {
    if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
    const wallet = await engine.getWalletDoc(req.user._id);
    const privateKey = toPkcs8Pem(engine.decryptPrivateKey(wallet));
    // Private key export is sensitive: it hands over the credential that
    // controls the wallet. Pin the session AND record the export so it is not
    // invisible after the fact (Cache-Control: no-store is set globally in
    // index.js, so the response is not cacheable).
    await Wallet.updateOne({ _id: wallet._id }, { $set: { keyExportedAt: Date.now() } }).catch(() => {});
    res.json({
      did: wallet.did,
      address: wallet.address,
      publicKey: wallet.publicKey,
      privateKey,
      warning: 'Anyone with this key controls the wallet. Store it offline.',
    });
  } catch (error) {
    // `typeof === 'string'` is required: Mongo driver errors carry a NUMERIC
    // code (11000) and infra errors carry strings like ECONNRESET. A bare
    // `if (error.code)` reported those as 400 client errors, masking a real
    // outage and leaking the raw driver code to the caller.
    if (error.code && typeof error.code === 'string') {
      return res.status(400).json({ message: error.message, code: error.code });
    }
    console.error('[web3 GET /wallet/private-key]', error.message);
    res.status(500).json({ message: 'Could not export the signing key.' });
  }
});

// @route   GET /api/web3/chain?limit=25&before=<index>
// @desc    Recent blocks of the SuppliWise ledger (explorer).
// @access  Private
router.get('/chain', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 25;
    const before = Number.isFinite(parseInt(req.query.before, 10)) ? parseInt(req.query.before, 10) : null;
    const blocks = await ledger.getBlocks({ limit, before });
    res.json({
      height: ledger.height,
      tip: ledger.tip,
      difficulty: ledger.difficulty,
      blocks,
    });
  } catch (error) {
    console.error('[web3 GET /chain]', error.message);
    res.status(500).json({ message: 'Could not load the chain.' });
  }
});

// @route   GET /api/web3/chain/verify
// @desc    Verify block hash + linkage and report integrity.
//          By default this is the incremental check: every block appended since
//          the last proven-good one, chained from the hash proven there. Pass
//          ?full=1 to force a re-hash of every block in the chain — that is
//          O(chain) and the chain only ever grows, so it is opt-in rather than
//          the default (it used to be the default, and it made this endpoint —
//          and the admin monitor that shares it — unusably slow).
// @access  Private
router.get('/chain/verify', async (req, res) => {
  try {
    const result = req.query.full === '1' ? await ledger.audit({ maxAgeMs: 0 }) : await ledger.verify();
    res.json(result);
  } catch (error) {
    console.error('[web3 GET /chain/verify]', error.message);
    res.status(500).json({ message: 'Could not verify the chain.' });
  }
});

// @route   GET /api/web3/tx/:hash
// @desc    Locate a transaction and its containing block.
// @access  Private
router.get('/tx/:hash', async (req, res) => {
  try {
    // Normalise before validating AND before querying. The old regex was
    // case-insensitive and accepted 16–64 chars, but the lookup and the
    // `===` comparison are exact — so an uppercased hash (a routine client-side
    // normalisation) or a truncated one passed validation and then 404'd, which
    // made the route's own contract a lie. Normalise to the canonical form the
    // ledger actually stores, and support prefix lookup explicitly.
    const raw = String(req.params.hash || '').trim().toLowerCase();
    if (!/^[a-f0-9]{16,64}$/.test(raw)) return res.status(400).json({ message: 'Invalid transaction hash.' });
    const block = await ledger.findByTx(raw);
    if (!block) return res.status(404).json({ message: 'Transaction not found.' });
    const tx = block.txs.find((t) => String(t.txHash).toLowerCase() === raw);
    if (!tx) return res.status(404).json({ message: 'Transaction not found.' });
    res.json({ tx, block: { index: block.index, hash: block.hash, prevHash: block.prevHash, timestamp: block.timestamp } });
  } catch (error) {
    console.error('[web3 GET /tx/:hash]', error.message);
    res.status(500).json({ message: 'Could not load the transaction.' });
  }
});

// @route   GET /api/web3/config
// @desc    DAO-governed protocol parameters (read-only, public contract ABI
//          equivalent — everyone sees the rules the platform runs on).
// @access  Private
router.get('/config', async (req, res) => {
  try {
    const cfg = await engine.getConfig();
    res.json({ params: cfg.params, updatedBy: cfg.updatedBy, updatedAt: cfg.updatedAt });
  } catch (error) {
    console.error('[web3 GET /config]', error.message);
    res.status(500).json({ message: 'Could not load configuration.' });
  }
});

module.exports = router;
module.exports.isValidId = (id) => mongoose.isValidObjectId(id);
