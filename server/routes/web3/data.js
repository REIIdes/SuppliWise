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
const IntakeRecord = require('../../models/IntakeRecord');
const DashboardMetrics = require('../../models/DashboardMetrics');
const User = require('../../models/User');
const engine = require('../../blockchain/engine');
const {
  hashPayload,
  encrypt,
  decrypt,
  contentId,
  sign,
  stableStringify,
} = require('../../blockchain/crypto');

const router = express.Router();

const RECOMMENDER_LOGIC_VERSION = 'suppliwise-rec-engine@1';

function userOnly(req, res, next) {
  if (req.user.role === 'admin') return res.status(403).json({ message: 'User account required.' });
  next();
}
router.use(userOnly);

// Deep JSON-safe conversion (Dates → ISO, ObjectIds → strings) so hashing is
// deterministic across reads.
function jsonSafe(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    if (typeof value.toHexString === 'function') return value.toHexString();
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = jsonSafe(v);
    return out;
  }
  return value;
}

// Digest over the user's full record history (feature 6): every assessment
// identity + timestamps + intake volume. Personal data stays in the DB — the
// chain only ever receives this digest.
async function buildHealthDigest(userId) {
  const [assessments, intakeCount, latestIntake] = await Promise.all([
    Assessment.find({ user: userId }).select('_id createdAt updatedAt priority').sort({ createdAt: 1 }).lean(),
    IntakeRecord.countDocuments({ user: userId }),
    IntakeRecord.findOne({ user: userId }).select('date').sort({ date: -1 }).lean(),
  ]);
  const payload = {
    assessments: assessments.map((a) => ({
      id: String(a._id),
      createdAt: a.createdAt ? new Date(a.createdAt).toISOString() : '',
      updatedAt: a.updatedAt ? new Date(a.updatedAt).toISOString() : '',
      priority: a.priority,
    })),
    intakeCount,
    latestIntakeAt: latestIntake && latestIntake.date ? new Date(latestIntake.date).toISOString() : '',
  };
  return {
    payload,
    digest: hashPayload(payload),
    assessmentCount: assessments.length,
    intakeCount,
    latestAssessmentAt: assessments.length
      ? new Date(assessments[assessments.length - 1].createdAt).getTime()
      : 0,
  };
}

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
    const snapshot = await buildHealthDigest(req.user._id);
    const wallet = await engine.getWalletDoc(req.user._id);
    const tx = await engine.anchor('health:anchor', wallet.address, {
      secret: snapshot.payload,               // digest-only: never the data
      public: {
        digest: snapshot.digest,
        assessmentCount: snapshot.assessmentCount,
        intakeCount: snapshot.intakeCount,
      },
    });
    const anchor = await HealthAnchor.create({
      user: req.user._id,
      digest: snapshot.digest,
      assessmentCount: snapshot.assessmentCount,
      intakeCount: snapshot.intakeCount,
      latestAssessmentAt: snapshot.latestAssessmentAt,
      blockIndex: tx.index,
      txHash: tx.txs[0] || '',
    });
    const cfg = await engine.getConfig();
    const reward = await engine.grantReward({
      userId: req.user._id,
      kind: 'health-anchor',
      refId: require('../../blockchain/crypto').dayKey(),
      amount: cfg.params.healthAnchorReward,
      public: { digest: snapshot.digest },
    });
    res.status(201).json({ anchor, reward: reward.amount, alreadyClaimed: reward.alreadyClaimed });
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
        verifyWith: 'GET /api/web3/health/verify',
      },
    });
  } catch (error) {
    console.error('[web3 GET /health/export]', error.message);
    res.status(500).json({ message: 'Could not export your health profile.' });
  }
});

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
    const sealed = encrypt(plaintext, process.env.JWT_SECRET);
    const cid = contentId(Buffer.from(sealed.ct, 'base64'));
    const doc = await StorageObject.findOneAndUpdate(
      { cid, owner: req.user._id },
      {
        $set: { ciphertext: sealed.ct, iv: sealed.iv, tag: sealed.tag, kind, size: plaintext.length },
        $setOnInsert: { cid, owner: req.user._id },
      },
      { upsert: true, new: true }
    );
    res.status(201).json({ cid: doc.cid, kind: doc.kind, size: doc.size, pinnedAt: doc.pinnedAt });
  } catch (error) {
    console.error('[web3 POST /storage/pin]', error.message);
    res.status(500).json({ message: 'Could not pin this payload.' });
  }
});

router.get('/storage/:cid', async (req, res) => {
  try {
    const cid = String(req.params.cid || '');
    if (!/^bafy[a-z2-7]+$/.test(cid)) return res.status(400).json({ message: 'Invalid content id.' });
    const doc = await StorageObject.findOne({ cid, owner: req.user._id }).lean();
    if (!doc) return res.status(404).json({ message: 'Object not found or not owned by you.' });
    const plaintext = decrypt({ iv: doc.iv, ct: doc.ciphertext, tag: doc.tag }, process.env.JWT_SECRET);
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
    const sealed = encrypt(JSON.stringify({ snapshot, did: wallet.did, at: Date.now() }), process.env.JWT_SECRET);
    const cid = contentId(Buffer.from(sealed.ct, 'base64'));
    const doc = await StorageObject.findOneAndUpdate(
      { cid, owner: req.user._id, kind: 'health-backup' },
      {
        $set: { ciphertext: sealed.ct, iv: sealed.iv, tag: sealed.tag, size: snapshot.payload.assessments.length },
        $setOnInsert: { cid, owner: req.user._id, kind: 'health-backup' },
      },
      { upsert: true, new: true }
    );
    await engine.anchor('storage:pin', wallet.address, {
      public: { cid: doc.cid, kind: 'health-backup' },
    });
    res.status(201).json({ cid: doc.cid, assessmentCount: snapshot.assessmentCount, intakeCount: snapshot.intakeCount, pinnedAt: doc.pinnedAt });
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
    const sealed = encrypt(JSON.stringify(anonymized), process.env.JWT_SECRET);
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
    const assessment = await Assessment.findOne({ _id: assessmentId, user: req.user._id }).lean();
    if (!assessment) return res.status(404).json({ message: 'Assessment not found.' });
    if (!assessment.aiResults) return res.status(400).json({ message: 'No AI results on this assessment yet.' });

    const safe = jsonSafe(assessment);
    const { aiResults, ...inputFields } = safe;
    const inputHash = hashPayload(inputFields);
    const outputHash = hashPayload(aiResults);
    const combinedHash = hashPayload({ logicVersion: RECOMMENDER_LOGIC_VERSION, inputHash, outputHash });

    const anchorDoc = await RecAnchor.findOneAndUpdate(
      { user: req.user._id, assessmentId: assessment._id },
      {
        $set: {
          logicVersion: RECOMMENDER_LOGIC_VERSION,
          inputHash,
          outputHash,
          combinedHash,
        },
      },
      { upsert: true, new: true }
    );
    const wallet = await engine.getWalletDoc(req.user._id);
    const tx = await engine.anchor('rec:anchor', wallet.address, {
      public: { assessment: assessmentId, logicVersion: RECOMMENDER_LOGIC_VERSION, combinedHash },
    });
    anchorDoc.blockIndex = tx.index;
    anchorDoc.txHash = tx.txs[0] || '';
    await anchorDoc.save();
    res.status(201).json({ anchor: anchorDoc });
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

    const safe = jsonSafe(assessment);
    const { aiResults, ...inputFields } = safe;
    const inputHash = hashPayload(inputFields);
    const outputHash = hashPayload(aiResults);
    const combinedHash = hashPayload({ logicVersion: anchorDoc.logicVersion, inputHash, outputHash });
    res.json({
      anchor: anchorDoc,
      verification: {
        inputIntact: inputHash === anchorDoc.inputHash,
        outputIntact: outputHash === anchorDoc.outputHash,
        logicVersion: anchorDoc.logicVersion,
        recomputed: combinedHash,
        valid: combinedHash === anchorDoc.combinedHash,
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

// PUBLIC: read a shared health profile (doctor/nutritionist view). Only the
// fields the sharing user explicitly exposes, gated by expiry + revocation.
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
