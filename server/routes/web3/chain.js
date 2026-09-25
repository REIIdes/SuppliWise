const express = require('express');
const mongoose = require('mongoose');
const engine = require('../../blockchain/engine');
const ledger = require('../../blockchain/ledger');
const { web3Guard } = require('./guards');

const router = express.Router();

// DELUXE plan gate + user-only. The per-handler `req.user.role === 'admin'`
// checks below are now redundant; they are left in place as defence in depth.
router.use(...web3Guard('web3'));

// The stored key is base64 PKCS#8 DER (exactly what blockchain/crypto.js
// sign() consumes). For export we wrap it in standard PEM armor so external
// tooling (openssl, hardware-wallet imports) accepts it directly.
function toPkcs8Pem(derB64) {
  const wrapped = String(derB64).replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${wrapped}\n-----END PRIVATE KEY-----\n`;
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
    res.json({
      did: wallet.did,
      address: wallet.address,
      publicKey: wallet.publicKey,
      privateKey,
      warning: 'Anyone with this key controls the wallet. Store it offline.',
    });
  } catch (error) {
    if (error.code) return res.status(400).json({ message: error.message, code: error.code });
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
// @desc    Recompute every block hash + linkage and report integrity.
// @access  Private
router.get('/chain/verify', async (req, res) => {
  try {
    const result = await ledger.verify();
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
    const hash = String(req.params.hash || '').trim();
    if (!/^[a-f0-9]{16,64}$/i.test(hash)) return res.status(400).json({ message: 'Invalid transaction hash.' });
    const block = await ledger.findByTx(hash);
    if (!block) return res.status(404).json({ message: 'Transaction not found.' });
    const tx = block.txs.find((t) => t.txHash === hash);
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
