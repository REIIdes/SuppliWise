const express = require('express');
const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  HealthAnchor,
  DataShare,
  StorageObject,
  RecAnchor,
  ShareLink,
  Wallet,
} = require('../../models/Web3');
const Assessment = require('../../models/Assessment');
const DashboardMetrics = require('../../models/DashboardMetrics');
const User = require('../../models/User');
const engine = require('../../blockchain/engine');
const ledger = require('../../blockchain/ledger');
const {
  sealData,
  openData,
  contentId,
  sign,
  verify,
  stableStringify,
} = require('../../blockchain/crypto');
const { requireFeature } = require('../../utils/entitlements');
// The health-ledger and recommendation commitments are derived in
// blockchain/proofs.js, because the product now anchors them automatically: an
// assessment save and the member's own "anchor" button must produce
// byte-identical commitments, or `/health/verify` would reject half of the
// receipts the platform issues.
const {
  recommendationCommitment,
  buildHealthDigest,
  anchorHealthLedger,
  anchorRecommendation,
} = require('../../blockchain/proofs');

const router = express.Router();

function userOnly(req, res, next) {
  if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
  next();
}
// DELUXE plan gate for the health ledger, storage, consent and AI proofs.
router.use(userOnly, requireFeature('web3'));

// ── User-owned health records (feature 6) ─────────────────────────────────
router.get('/health/ledger', async (req, res) => {
  try {
    const [anchors, snapshot] = await Promise.all([
      HealthAnchor.find({ user: req.user._id }).sort({ at: -1 }).limit(30).lean(),
      buildHealthDigest(req.user._id),
    ]);
    res.json({
      anchors,
      summary: {
        assessmentCount: snapshot.assessmentCount,
        intakeCount: snapshot.intakeCount,
        latestAssessmentAt: snapshot.latestAssessmentAt,
        currentDigest: snapshot.digest,
      },
    });
  } catch (error) {
    console.error('[web3 GET /health/ledger]', error.message);
    res.status(500).json({ message: 'Could not load your health ledger.' });
  }
});

router.post('/health/ledger/anchor', async (req, res) => {
  try {
    const out = await anchorHealthLedger(req.user, { reward: true });
    // A failed append is now explicit rather than an index of -1 that every
    // caller had to remember to test. Without this check the route stored an
    // anchor row saying "proven at block -1", paid the anchor reward for a block
    // that does not exist, and LedgerPanel showed the member a chain anchor they
    // can never verify — the health/verify endpoint would reject that digest,
    // so the receipt contradicted the ledger it came from.
    if (!out.anchored) {
      return res.status(502).json({
        anchored: false,
        message: 'The chain could not accept this snapshot right now, so nothing was anchored and no reward was paid. Try again in a moment.',
        error: out.error || 'unknown',
      });
    }
    res.status(201).json({
      anchor: out.anchor,
      reward: out.reward,
      alreadyClaimed: out.alreadyClaimed,
    });
  } catch (error) {
    console.error('[web3 POST /health/ledger/anchor]', error.message);
    res.status(500).json({ message: 'Could not anchor your health ledger.' });
  }
});

// Verifiable health profile export (features 6 & 16): a signed credential a
// user can hand to a doctor or nutritionist; anyone can check the signature
// against the published public key / DID.
router.get('/health/export', async (req, res) => {
  try {
    const wallet = await engine.getWalletDoc(req.user._id);
    const [snapshot, metrics, user] = await Promise.all([
      buildHealthDigest(req.user._id),
      DashboardMetrics.findOne({ user: req.user._id, isActive: true }).lean(),
      User.findById(req.user._id).select('firstName lastName gender dateOfBirth createdAt').lean(),
    ]);
    const payload = {
      did: wallet.did,
      address: wallet.address,
      subject: {
        name: user ? `${user.firstName} ${user.lastName}` : 'SuppliWise member',
        gender: user ? user.gender : '',
        memberSince: user && user.createdAt ? new Date(user.createdAt).toISOString() : '',
      },
      record: {
        assessmentCount: snapshot.assessmentCount,
        intakeCount: snapshot.intakeCount,
        latestAssessmentAt: snapshot.latestAssessmentAt,
        currentDigest: snapshot.digest,
        trackingStreak: metrics ? metrics.currentStreak || 0 : 0,
        overallAdherencePct: metrics ? metrics.overallAdherence || 0 : 0,
      },
      issuedAt: new Date().toISOString(),
      issuer: 'SuppliWise Health Ledger',
    };
    const privateKey = engine.decryptPrivateKey(wallet);
    const signature = sign(privateKey, stableStringify(payload));
    res.json({
      credential: payload,
      proof: {
        signature,
        algorithm: 'ed25519',
        publicKey: wallet.publicKey,
        did: wallet.did,
        verifyWith: 'POST /api/web3/health/verify',
      },
    });
  } catch (error) {
    console.error('[web3 GET /health/export]', error.message);
    res.status(500).json({ message: 'Could not export your health profile.' });
  }
});

// @route   POST /api/web3/health/verify
// @desc    Verify a signed health credential.
// @access  Public
//
// This is the endpoint /health/export has always pointed its `verifyWith` field
// at, and LedgerPanel's "verify it at /web3/health/verify" caption has always
// shown the member — and it did not exist. A verifiable credential that nothing
// can verify is a signed PNG: the export asked the member to hand their health
// record to a clinic, told the clinic where to check it, and the check 404'd.
//
// PUBLIC, deliberately. The entire value of a verifiable credential is that the
// receiver — a doctor, a clinic, a nutritionist — can check it without holding
// an account on the platform that issued it. Requiring auth here would mean the
// verifier has to trust the exporter's word, which is what the signature exists
// to replace.
async function verifyCredential(req, res) {
  try {
    const credential = req.body && req.body.credential;
    // The signature travels in `proof` because that is the shape
    // /health/export returns and the shape the member downloads and hands over:
    // a verifier posts the file back exactly as it was received.
    const signature = String((req.body && req.body.proof && req.body.proof.signature) || '');
    if (!credential || typeof credential !== 'object' || !signature) {
      return res.status(400).json({
        verified: false,
        message: 'Post the exported credential file exactly as /health/export returned it ({ credential, proof }).',
      });
    }

    // The key is read from OUR wallet row, never from the submitted document.
    // Verifying against `credential.proof.publicKey` would let anyone generate a
    // keypair, sign a fabricated health record with it and get a green tick: a
    // signature is only evidence when the key behind it is identified by
    // something other than the thing it signed.
    const address = String(credential.address || '');
    const wallet = address ? await Wallet.findOne({ address }).lean() : null;
    if (!wallet || !wallet.publicKey) {
      return res.json({
        verified: false,
        checks: { identity: false, signature: false, ledger: false, arithmetic: false },
        reason: 'No SuppliWise identity holds this address, so there is no key to verify this against.',
      });
    }
    if (credential.did && String(credential.did) !== String(wallet.did)) {
      return res.json({
        verified: false,
        checks: { identity: false, signature: false, ledger: false, arithmetic: false },
        reason: "The DID on this credential is not the DID issued to that address.",
      });
    }

    // The signature covers the credential body — `proof` is the envelope the
    // signature travels in, and /health/export signs the payload before adding
    // it, so the message re-hashed here is the message that was signed there.
    const signatureValid = verify(wallet.publicKey, stableStringify(credential), signature);

    // Then the ledger, which is what a signature alone cannot give: the numbers
    // in this document were anchored at the time they were issued, in a block
    // that still re-hashes onto its predecessor.
    const digest = credential.record && credential.record.currentDigest;
    const anchor = signatureValid && digest
      ? await HealthAnchor.findOne({ user: wallet.user, digest, blockIndex: { $gte: 0 } }).lean()
      : null;
    const window = anchor ? await ledger.proveBlocks([anchor.blockIndex]) : null;
    const ledgerValid = !!(window && window.valid);

    // Cross-check the credential's own counts against what the ledger recorded
    // under that digest. An issued document asserting more assessments than
    // were anchored is not the document the ledger produced.
    const arithmeticValid = !!anchor
      && Number(anchor.assessmentCount) === Number(credential.record && credential.record.assessmentCount)
      && Number(anchor.intakeCount) === Number(credential.record && credential.record.intakeCount);

    const checks = {
      identity: true,
      signature: signatureValid,
      ledger: ledgerValid,
      arithmetic: arithmeticValid,
    };
    const verified = Object.values(checks).every(Boolean);
    res.json({
      verified,
      checks,
      reason: verified ? '' : (!signatureValid
        ? 'The signature does not match this document under the key issued to that address.'
        : !anchor
          ? 'No ledger anchor exists for this health digest, so the record it describes was never anchored.'
          : !ledgerValid
            ? 'The block anchoring this digest no longer re-hashes cleanly — its contents or its linkage changed.'
            : 'The anchored counts disagree with the counts printed on this credential.'),
      // What the credential claims, so a verifier can read it back without
      // trusting the document's own framing of the result.
      subject: credential.subject || null,
      record: credential.record || null,
      issuedAt: credential.issuedAt || null,
      issuer: credential.issuer || null,
      holder: { did: wallet.did, address: wallet.address },
      anchor: anchor
        ? { digest, blockIndex: anchor.blockIndex, txHash: anchor.txHash, at: anchor.at }
        : null,
      chain: window
        ? {
            blocks: window.blocks,
            integrity: window.integrity,
            difficulty: ledger.difficulty,
            network: 'SuppliWise Mainnet (proof-of-work)',
          }
        : null,
    });
  } catch (error) {
    console.error('[web3 POST /health/verify]', error.message);
    // Same reasoning as /chain/verify: a verifier that could not run has NOT
    // verified anything, and that is a verdict rather than a transport error.
    res.status(503).json({ verified: false, message: 'The credential could not be checked.' });
  }
}

// ── Decentralized & encrypted storage (feature 8) ─────────────────────────
// Content-addressed (IPFS-style CID) + AES-256-GCM encrypted: no plaintext at
// rest, no single point of failure for a breach, integrity guaranteed by the
// CID itself.
router.post('/storage/pin', async (req, res) => {
  try {
    const kind = String(req.body.kind || 'generic').slice(0, 40);
    const data = req.body.data;
    if (data === undefined || data === null) return res.status(400).json({ message: 'Nothing to store.' });
    const plaintext = JSON.stringify(data);
    if (plaintext.length > 900000) return res.status(400).json({ message: 'Payload too large (max ~900KB).' });
    const sealed = sealData(plaintext);
    const cid = contentId(Buffer.from(sealed.ct, 'base64'));
    const doc = await StorageObject.findOneAndUpdate(
      { cid, owner: req.user._id },
      {
        $set: { ciphertext: sealed.ct, iv: sealed.iv, tag: sealed.tag, kind, size: plaintext.length },
        $setOnInsert: { cid, owner: req.user._id },
      },
      { upsert: true, new: true }
    );
    // Anchor the pin. Until now only /health/backup anchored, so the vault UI
    // could say "pinned on-chain" about a row that existed only in Mongo — the
    // whole point of feature 8 is that a third party can be shown a block that
    // commits to this CID. `engine.anchor` never throws; the receipt is only
    // reported when `anchored` is true.
    const wallet = await engine.getWalletDoc(req.user._id);
    const chain = await engine.anchor('storage:pin', wallet.address, {
      public: { cid: doc.cid, kind: doc.kind },
    });
    if (chain.anchored) {
      const txHash = chain.txs[0] || '';
      await StorageObject.updateOne({ _id: doc._id }, { $set: { anchorTx: txHash } });
      return res.status(201).json({
        cid: doc.cid, kind: doc.kind, size: doc.size, pinnedAt: doc.pinnedAt,
        txHash, blockIndex: chain.index, anchored: true,
      });
    }
    res.status(201).json({
      cid: doc.cid, kind: doc.kind, size: doc.size, pinnedAt: doc.pinnedAt,
      txHash: '', anchored: false,
    });
  } catch (error) {
    console.error('[web3 POST /storage/pin]', error.message);
    res.status(500).json({ message: 'Could not pin this payload.' });
  }
});

// @route   GET /api/web3/storage
// @desc    The member's own encrypted vault — every object they pinned, with
//          its on-chain receipt. Registered BEFORE /storage/:cid, otherwise the
//          param route swallows "storage" as a content id and answers 400.
// @access  Private
router.get('/storage', async (req, res) => {
  try {
    const rows = await StorageObject.find({ owner: req.user._id })
      .sort({ pinnedAt: -1 })
      .limit(100)
      .lean();
    // A pin whose block is missing (ledger busy at the time) is anchored lazily
    // on read, so the vault heals itself instead of storing "no receipt" forever.
    const missing = rows.filter((r) => !r.anchorTx);
    if (missing.length > 0) {
      const wallet = await engine.getWalletDoc(req.user._id);
      const chain = await engine.anchorMany(missing.map((r) => ({
        type: 'storage:pin',
        actor: wallet.address,
        data: { cid: r.cid, kind: r.kind },
      })));
      if (chain.anchored) {
        await Promise.all(missing.map((r, i) => StorageObject.updateOne(
          { _id: r._id },
          { $set: { anchorTx: chain.txs[i] || '' } },
        )));
        missing.forEach((r, i) => { r.anchorTx = chain.txs[i] || ''; });
      }
    }
    res.json({
      objects: rows.map((r) => ({
        cid: r.cid,
        kind: r.kind,
        size: r.size,
        pinnedAt: r.pinnedAt,
        txHash: r.anchorTx || '',
      })),
      count: rows.length,
      totalBytes: rows.reduce((sum, r) => sum + (Number(r.size) || 0), 0),
    });
  } catch (error) {
    console.error('[web3 GET /storage]', error.message);
    res.status(500).json({ message: 'Could not load your vault.' });
  }
});

router.get('/storage/:cid', async (req, res) => {
  try {
    const cid = String(req.params.cid || '');
    if (!/^bafy[a-z2-7]+$/.test(cid)) return res.status(400).json({ message: 'Invalid content id.' });
    const doc = await StorageObject.findOne({ cid, owner: req.user._id }).lean();
    if (!doc) return res.status(404).json({ message: 'Object not found or not owned by you.' });
    const plaintext = openData({ iv: doc.iv, ct: doc.ciphertext, tag: doc.tag });
    // Integrity: the stored ciphertext must hash to the CID it claims.
    const recomputed = contentId(Buffer.from(doc.ciphertext, 'base64'));
    res.json({
      cid: doc.cid,
      kind: doc.kind,
      size: doc.size,
      pinnedAt: doc.pinnedAt,
      integrityOk: recomputed === doc.cid,
      data: JSON.parse(plaintext),
    });
  } catch (error) {
    console.error('[web3 GET /storage/:cid]', error.message);
    res.status(500).json({ message: 'Could not fetch the stored object.' });
  }
});

// Health-record backup: encrypt + content-address the full export, then
// return the CID (the user can re-fetch/decrypt it any time).
router.post('/health/backup', async (req, res) => {
  try {
    const wallet = await engine.getWalletDoc(req.user._id);
    const snapshot = await buildHealthDigest(req.user._id);
    const sealed = sealData(JSON.stringify({ snapshot, did: wallet.did, at: Date.now() }));
    const cid = contentId(Buffer.from(sealed.ct, 'base64'));
    const doc = await StorageObject.findOneAndUpdate(
      { cid, owner: req.user._id, kind: 'health-backup' },
      {
        $set: { ciphertext: sealed.ct, iv: sealed.iv, tag: sealed.tag, size: snapshot.payload.assessments.length },
        $setOnInsert: { cid, owner: req.user._id, kind: 'health-backup' },
      },
      { upsert: true, new: true }
    );
    const chain = await engine.anchor('storage:pin', wallet.address, {
      public: { cid: doc.cid, kind: 'health-backup' },
    });
    // The receipt is reported only when the block actually exists. A backup is
    // still a valid encrypted object without one (GET /storage retries the
    // anchor lazily), but the response must not imply a proof it does not have.
    const txHash = chain.anchored ? chain.txs[0] || '' : '';
    if (txHash) await StorageObject.updateOne({ _id: doc._id }, { $set: { anchorTx: txHash } });
    res.status(201).json({ cid: doc.cid, assessmentCount: snapshot.assessmentCount, intakeCount: snapshot.intakeCount, pinnedAt: doc.pinnedAt, txHash, anchored: chain.anchored });
  } catch (error) {
    console.error('[web3 POST /health/backup]', error.message);
    res.status(500).json({ message: 'Could not back up your health record.' });
  }
});

// ── Data sovereignty & rewards (feature 7) ────────────────────────────────
router.get('/data/shares', async (req, res) => {
  try {
    const shares = await DataShare.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(50).lean();
    const rewards = shares
      .filter((s) => s.status === 'active')
      .reduce((sum, s) => sum + (s.reward || 0), 0);
    res.json({ shares, totalRewards: Math.round(rewards * 100) / 100 });
  } catch (error) {
    console.error('[web3 GET /data/shares]', error.message);
    res.status(500).json({ message: 'Could not load data shares.' });
  }
});

// Grant a research institution an anonymized, coarse dataset. The dataset is
// built server-side (the client can never exfiltrate raw records through
// this endpoint), encrypted, content-addressed, and the consent itself is
// anchored on-chain — revocation is just as explicit.
router.post('/data/shares', async (req, res) => {
  try {
    const recipient = String(req.body.recipient || '').trim().slice(0, 120);
    const scope = String(req.body.scope || 'general-research');
    if (recipient.length < 3) return res.status(400).json({ message: 'Name the research recipient.' });
    if (!['nutrition-outcomes', 'adherence-study', 'general-research'].includes(scope)) {
      return res.status(400).json({ message: 'Unknown data scope.' });
    }

    const [user, metrics, snapshot] = await Promise.all([
      User.findById(req.user._id).select('gender dateOfBirth createdAt').lean(),
      DashboardMetrics.findOne({ user: req.user._id, isActive: true }).lean(),
      buildHealthDigest(req.user._id),
    ]);
    const age = user && user.dateOfBirth
      ? Math.max(0, new Date().getFullYear() - new Date(user.dateOfBirth).getFullYear())
      : null;
    const anonymized = {
      scope,
      // Coarse bands only — re-identification through this payload is not
      // possible by construction (no ids, no dates, no free text).
      ageBand: age === null ? 'unknown' : `${Math.floor(age / 10) * 10}s`,
      gender: user ? user.gender : 'unknown',
      assessmentCountBand: String(Math.min(9, Math.ceil(snapshot.assessmentCount / 3)) * 3),
      intakeVolumeBand: snapshot.intakeCount >= 100 ? '100+' : snapshot.intakeCount >= 30 ? '30-99' : '<30',
      adherenceBand: metrics ? `${Math.floor((metrics.overallAdherence || 0) / 10) * 10}-${Math.floor((metrics.overallAdherence || 0) / 10) * 10 + 9}%` : 'unknown',
      streakBand: !metrics ? '0' : metrics.currentStreak >= 30 ? '30+' : metrics.currentStreak >= 7 ? '7-29' : '<7',
      memberSinceYear: user && user.createdAt ? new Date(user.createdAt).getFullYear() : null,
      generatedAt: new Date().toISOString(),
    };

    // Encrypt + pin the dataset to decentralized storage (feature 8).
    const sealed = sealData(JSON.stringify(anonymized));
    const cid = contentId(Buffer.from(sealed.ct, 'base64'));
    await StorageObject.findOneAndUpdate(
      { cid, owner: req.user._id },
      {
        $set: { ciphertext: sealed.ct, iv: sealed.iv, tag: sealed.tag, kind: 'research-dataset', size: JSON.stringify(anonymized).length },
        $setOnInsert: { cid, owner: req.user._id },
      },
      { upsert: true }
    );

    const share = await DataShare.create({ user: req.user._id, scope, recipient, datasetCid: cid });
    const wallet = await engine.getWalletDoc(req.user._id);
    const tx = await engine.anchor('consent:grant', wallet.address, {
      public: { share: String(share._id), recipient, scope, cid },
    });
    share.consentTx = tx.txs[0] || '';
    await share.save();

    const cfg = await engine.getConfig();
    const reward = await engine.grantReward({
      userId: req.user._id,
      kind: 'data-share',
      refId: String(share._id),
      amount: cfg.params.dataShareReward,
      public: { share: String(share._id), scope },
    });
    // Persist the amount actually paid. The field has always existed on the
    // schema but was never written, so every share reported a lifetime
    // `totalRewards` of 0 while the WELL was really in the wallet.
    share.reward = reward.amount;
    share.rewardTx = reward.txHash || '';
    await share.save();

    res.status(201).json({ share, reward: reward.amount, anonymizedDataset: anonymized });
  } catch (error) {
    console.error('[web3 POST /data/shares]', error.message);
    res.status(500).json({ message: 'Could not create the data share.' });
  }
});

router.delete('/data/shares/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid share.' });
    const share = await DataShare.findOne({ _id: req.params.id, user: req.user._id });
    if (!share) return res.status(404).json({ message: 'Share not found.' });
    if (share.status === 'revoked') return res.json({ share, message: 'Already revoked.' });
    share.status = 'revoked';
    share.revokedAt = Date.now();
    const wallet = await engine.getWalletDoc(req.user._id);
    const tx = await engine.anchor('consent:revoke', wallet.address, {
      public: { share: String(share._id), recipient: share.recipient },
    });
    share.revokeTx = tx.txs[0] || '';
    await share.save();
    // Destroy the shared payload — access ends with the revocation.
    await StorageObject.deleteOne({ cid: share.datasetCid, owner: req.user._id });
    res.json({ share, message: 'Consent revoked and dataset destroyed.' });
  } catch (error) {
    console.error('[web3 DELETE /data/shares/:id]', error.message);
    res.status(500).json({ message: 'Could not revoke the share.' });
  }
});

// ── Verifiable AI recommendations (feature 17) ────────────────────────────
// Anchor the recommender's INPUT, OUTPUT and LOGIC VERSION for one
// assessment. Verification later recomputes both digests from the stored
// record — any drift between then and now fails the check.
router.post('/recommendations/anchor', async (req, res) => {
  try {
    const assessmentId = String(req.body.assessmentId || '');
    if (!mongoose.isValidObjectId(assessmentId)) return res.status(400).json({ message: 'Invalid assessment.' });
    const out = await anchorRecommendation(req.user, assessmentId);
    if (!out.anchored) {
      if (out.code === 'not_found') return res.status(404).json({ message: 'Assessment not found.' });
      if (out.code === 'no_results') return res.status(400).json({ message: 'No AI results on this assessment yet.' });
      return res.status(502).json({
        anchored: false,
        message: 'The chain could not accept this plan right now, so nothing was anchored. Try again in a moment.',
        error: out.error || 'unknown',
      });
    }
    res.status(201).json({ anchor: out.anchor });
  } catch (error) {
    console.error('[web3 POST /recommendations/anchor]', error.message);
    res.status(500).json({ message: 'Could not anchor the recommendation.' });
  }
});

router.get('/recommendations/anchor/:assessmentId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.assessmentId)) return res.status(400).json({ message: 'Invalid assessment.' });
    const anchorDoc = await RecAnchor.findOne({ user: req.user._id, assessmentId: req.params.assessmentId }).lean();
    if (!anchorDoc) return res.status(404).json({ message: 'No anchor recorded for this assessment.' });
    const assessment = await Assessment.findOne({ _id: req.params.assessmentId, user: req.user._id }).lean();
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });

    // Re-derived through the same helper the anchor itself uses, so the
    // verifier and the anchorer cannot drift apart.
    const derived = recommendationCommitment(assessment, anchorDoc.logicVersion);
    const { inputHash, outputHash, combinedHash } = derived;
    const recordIntact = combinedHash === anchorDoc.combinedHash;

    // The two rows this used to compare — the assessment and its anchor — live
    // in the SAME database, so this endpoint was grading the database against
    // itself: it detects the application drifting, and detects nothing about
    // whoever can write to either document. The chain holds a third copy of the
    // commitment, inside a block that is hashed onto its predecessor, so read
    // that back and make the verdict depend on it.
    const block = anchorDoc.txHash ? await ledger.findByTx(anchorDoc.txHash) : null;
    const tx = block ? (block.txs || []).find((t) => t.txHash === anchorDoc.txHash) : null;
    const onChain = tx && tx.data ? tx.data : null;
    const window = block ? await ledger.proveBlocks([block.index]) : null;
    const chainBlock = window && window.blocks.length ? window.blocks[0] : null;
    // Re-derive the commitment from the CURRENT records against the logic
    // version the CHAIN recorded, not the one the anchor row claims. An edited
    // `logicVersion` then fails here instead of quietly re-deriving a matching
    // combined hash.
    const againstChain = onChain
      ? recommendationCommitment(assessment, onChain.logicVersion).combinedHash
      : '';
    // v1 blocks committed the joined txHash list only, so the text inside
    // `tx.data` was never hashed into anything. On v2 it was. Saying which one
    // this is beats claiming the stronger guarantee for both.
    const payloadCommitted = !!chainBlock && chainBlock.commitment >= 2;
    const chain = {
      anchored: !!block,
      blockIndex: block ? block.index : null,
      txHash: anchorDoc.txHash || '',
      blockIntact: !!(chainBlock && chainBlock.intact),
      reason: chainBlock && !chainBlock.intact ? chainBlock.reason : (block ? '' : 'no block contains this transaction'),
      payloadCommitted,
      logicVersion: onChain ? onChain.logicVersion : null,
      combinedHash: onChain ? onChain.combinedHash : null,
      // The chain's own copy agrees with what these records say right now.
      agrees: !!onChain && againstChain === String(onChain.combinedHash),
      // The sealed checkpoint covers this block: the server re-hashed genesis→here
      // under a verdict signed with a key that is not in this database.
      sealed: !!(window && window.integrity.anchored),
    };
    res.json({
      anchor: anchorDoc,
      verification: {
        inputIntact: inputHash === anchorDoc.inputHash,
        outputIntact: outputHash === anchorDoc.outputHash,
        logicVersion: anchorDoc.logicVersion,
        recomputed: combinedHash,
        recordIntact,
        chain,
        // "Verified" now means the ledger backs the row, not that two rows in
        // one database agree with each other.
        valid: recordIntact && chain.anchored && chain.blockIntact && chain.payloadCommitted && chain.agrees,
        checkedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[web3 GET /recommendations/anchor/:id]', error.message);
    res.status(500).json({ message: 'Could not verify the recommendation anchor.' });
  }
});

// ── Interoperable health profile share links (feature 16) ─────────────────
router.get('/profile-shares', async (req, res) => {
  try {
    const links = await ShareLink.find({ user: req.user._id }).sort({ createdAt: -1 }).limit(30).lean();
    const now = Date.now();
    res.json({
      links: links.map((l) => ({
        _id: l._id,
        token: l.token,
        revoked: l.revoked,
        views: l.views,
        expiresAt: l.expiresAt,
        expired: l.expiresAt <= now,
        createdAt: l.createdAt,
      })),
    });
  } catch (error) {
    console.error('[web3 GET /profile-shares]', error.message);
    res.status(500).json({ message: 'Could not load share links.' });
  }
});

router.post('/profile-shares', async (req, res) => {
  try {
    const ttlHours = Math.min(720, Math.max(1, parseInt(req.body.ttlHours, 10) || 72));
    const token = crypto.randomBytes(16).toString('hex');
    const link = await ShareLink.create({
      token,
      user: req.user._id,
      expiresAt: Date.now() + ttlHours * 3600000,
    });
    res.status(201).json({ link: { token: link.token, expiresAt: link.expiresAt } });
  } catch (error) {
    console.error('[web3 POST /profile-shares]', error.message);
    res.status(500).json({ message: 'Could not create the share link.' });
  }
});

router.delete('/profile-shares/:id', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid link.' });
    const link = await ShareLink.findOneAndUpdate(
      { _id: req.params.id, user: req.user._id },
      { $set: { revoked: true } },
      { new: true }
    );
    if (!link) return res.status(404).json({ message: 'Share link not found.' });
    res.json({ message: 'Share link revoked.' });
  } catch (error) {
    console.error('[web3 DELETE /profile-shares/:id]', error.message);
    res.status(500).json({ message: 'Could not revoke the share link.' });
  }
});

// PUBLIC: read a shared health profile (doctor/nutritionist view).
//
// What actually gates it, stated plainly because the shape of the answer matters:
// the 128-bit random token in the URL, its expiry, and revocation. There is NO
// field-level scoping — ShareLink stores a token, an owner, an expiry, a revoked
// flag and a view count (models/Web3.js), nothing else — so opening a live link
// discloses the fixed set below, not a subset someone chose when sharing. A
// member who wants "only my adherence, not my medications" cannot get it here,
// and this endpoint must not be described as if they could.
//
// Meters: `/api/web3` is behind the per-address limiter in index.js (120 req/min
// in production), which is what bounds anyone trying to walk token space.
async function publicShare(req, res) {
  try {
    const token = String(req.params.token || '');
    if (!/^[a-f0-9]{32}$/.test(token)) return res.status(400).json({ message: 'Invalid share token.' });
    const link = await ShareLink.findOne({ token, revoked: false, expiresAt: { $gt: Date.now() } }).lean();
    if (!link) return res.status(404).json({ message: 'This share link is expired, revoked, or never existed.' });

    const [user, metrics, snapshot, anchors] = await Promise.all([
      User.findById(link.user).select('firstName lastName gender dateOfBirth createdAt').lean(),
      DashboardMetrics.findOne({ user: link.user, isActive: true }).lean(),
      buildHealthDigest(link.user),
      HealthAnchor.find({ user: link.user }).sort({ at: -1 }).limit(1).lean(),
    ]);
    if (!user) return res.status(404).json({ message: 'Profile unavailable.' });
    const latest = await Assessment.find({ user: link.user }).sort({ createdAt: -1 }).limit(1).lean();
    const age = user.dateOfBirth
      ? Math.max(0, new Date().getFullYear() - new Date(user.dateOfBirth).getFullYear())
      : null;

    ShareLink.updateOne({ _id: link._id }, { $inc: { views: 1 } }).exec().catch(() => {});

    res.json({
      sharedProfile: {
        name: `${user.firstName} ${user.lastName}`,
        gender: user.gender,
        age,
        assessmentCount: snapshot.assessmentCount,
        intakeCount: snapshot.intakeCount,
        trackingStreak: metrics ? metrics.currentStreak || 0 : 0,
        overallAdherencePct: metrics ? metrics.overallAdherence || 0 : 0,
        latestAssessment: latest[0]
          ? {
              at: latest[0].createdAt,
              healthGoals: latest[0].healthGoals || [],
              symptoms: latest[0].symptoms || [],
              medicalConditions: latest[0].medicalConditions || [],
              currentMedications: latest[0].currentMedications || '',
              allergies: latest[0].allergies || '',
            }
          : null,
        lastLedgerAnchor: anchors[0]
          ? { digest: anchors[0].digest, blockIndex: anchors[0].blockIndex, at: anchors[0].at }
          : null,
      },
      expiresAt: link.expiresAt,
      views: link.views + 1,
      disclaimer: 'Shared by the account holder via SuppliWise. Not a medical diagnosis.',
    });
  } catch (error) {
    console.error('[web3 share]', error.message);
    res.status(500).json({ message: 'Could not load the shared profile.' });
  }
}

module.exports = router;
module.exports.publicShare = publicShare;
module.exports.verifyCredential = verifyCredential;
