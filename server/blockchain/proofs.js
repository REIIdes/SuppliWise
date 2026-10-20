// Product-event chain proofs.
//
// Every proof on this ledger used to exist only because a member opened the
// Web3 hub and pressed a button. That made the chain a museum of opt-in demos
// instead of evidence about the product: an assessment that the platform
// actually issued carried no anchor, so nothing could be shown to a clinic or a
// regulator afterwards unless someone remembered to go and click.
//
// These are the two operations that a real product event can call, shared by
// the web3 routes (manual button, pays the daily anchor reward) and the
// assessment routes (automatic, pays nothing). One implementation, one digest
// derivation, so an automatic anchor and a manual anchor of the same record
// produce the same commitment — if they differed, `/health/verify` would reject
// half the receipts the product issued.
//
// Anchoring NEVER fails the surrounding request. `engine.anchor` already
// swallows append errors and returns `anchored: false`; these helpers pass that
// signal up instead of throwing, so a member can always save their assessment,
// and a caller only claims a proof when it exists.
const {
  HealthAnchor,
  RecAnchor,
} = require('../models/Web3');
const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const engine = require('./engine');
const { hashPayload, dayKey } = require('./crypto');
const { can } = require('../utils/entitlements');

// Bumped whenever the recommender's decision logic changes in a way that makes
// an old plan non-reproducible. The version is part of the anchored commitment,
// so an old plan stays verifiable against the version that produced it.
const RECOMMENDER_LOGIC_VERSION = 'suppliwise-rec-engine@1';

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

// The web3 feature is what pays for anchoring, so a product event must not
// silently mint chain work for a free-tier account. Admins are excluded the way
// the web3 routes exclude them: this chain records member activity.
function web3Enabled(user) {
  if (!user || user.role === 'admin') return false;
  return can(user, 'web3');
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

// @returns {Promise<object>} `{ anchored: false, error }` when the chain
//   refused the append — the caller must not store or display a proof then.
async function anchorHealthLedger(user, { reward = false } = {}) {
  try {
    const snapshot = await buildHealthDigest(user._id);
    const wallet = await engine.getWalletDoc(user._id);
    const tx = await engine.anchor('health:anchor', wallet.address, {
      secret: snapshot.payload,               // digest-only: never the data
      public: {
        digest: snapshot.digest,
        assessmentCount: snapshot.assessmentCount,
        intakeCount: snapshot.intakeCount,
      },
    });
    if (tx.anchored === false || !(tx.index >= 0)) {
      return {
        anchored: false,
        code: 'append_failed',
        snapshot,
        error: tx.error || 'the ledger refused this block',
      };
    }
    const anchor = await HealthAnchor.create({
      user: user._id,
      digest: snapshot.digest,
      assessmentCount: snapshot.assessmentCount,
      intakeCount: snapshot.intakeCount,
      latestAssessmentAt: snapshot.latestAssessmentAt,
      blockIndex: tx.index,
      txHash: tx.txs[0] || '',
    });
    const out = { anchored: true, snapshot, anchor, blockIndex: tx.index, txHash: tx.txs[0] || '' };
    if (reward) {
      const cfg = await engine.getConfig();
      // Idempotent per calendar day through the (user, kind, refId) unique
      // index, so an automatic anchor and the manual button cannot pay twice.
      const granted = await engine.grantReward({
        userId: user._id,
        kind: 'health-anchor',
        refId: dayKey(),
        amount: cfg.params.healthAnchorReward,
        public: { digest: snapshot.digest },
      });
      out.reward = granted.amount;
      out.alreadyClaimed = granted.alreadyClaimed;
    }
    return out;
  } catch (err) {
    console.error('[proofs anchorHealthLedger]', err.message);
    return { anchored: false, error: err.message };
  }
}

// The commitment itself, split out from the write so it can be tested and so
// every caller — the member's anchor button, the automatic anchor on plan save,
// and the verifier that re-derives it later — hashes the same thing the same
// way. `aiResults` is the OUTPUT; everything else on the record is the INPUT,
// including `_id` and `updatedAt`, so a re-issued plan cannot be passed off as
// the one that was anchored.
function recommendationCommitment(assessment, logicVersion = RECOMMENDER_LOGIC_VERSION) {
  const safe = jsonSafe(assessment);
  const { aiResults, ...inputFields } = safe;
  const inputHash = hashPayload(inputFields);
  const outputHash = hashPayload(aiResults);
  return {
    logicVersion,
    inputHash,
    outputHash,
    combinedHash: hashPayload({ logicVersion, inputHash, outputHash }),
  };
}

// Anchor the AI recommendation for one assessment: a commitment to the inputs,
// the plan the engine returned, and the engine version that produced it, so a
// plan can be proven unchanged (or shown to have been edited) after the fact.
//
// The assessment is loaded HERE, with `.lean()`, even though the caller from
// `PATCH /:id/results` already holds a document: a Mongoose doc and a lean
// object can differ where a schema getter fires, and the two digests must be
// byte-identical or an automatic anchor would fail its own verification. One
// read path, so one commitment. `code` is structured so the route can answer
// with the right status without parsing a message.
async function anchorRecommendation(user, assessmentId) {
  try {
    if (!assessmentId) return { anchored: false, code: 'invalid', error: 'no assessment id' };
    const assessment = await Assessment.findOne({ _id: assessmentId, user: user._id }).lean();
    if (!assessment) return { anchored: false, code: 'not_found', error: 'assessment not found' };
    if (!assessment.aiResults) return { anchored: false, code: 'no_results', error: 'no AI results yet' };

    const commitment = recommendationCommitment(assessment);
    const { inputHash, outputHash, combinedHash } = commitment;

    const anchorDoc = await RecAnchor.findOneAndUpdate(
      { user: user._id, assessmentId: assessment._id },
      {
        $set: {
          logicVersion: RECOMMENDER_LOGIC_VERSION,
          inputHash,
          outputHash,
          combinedHash,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    const wallet = await engine.getWalletDoc(user._id);
    const tx = await engine.anchor('rec:anchor', wallet.address, {
      public: { assessment: String(assessment._id), logicVersion: RECOMMENDER_LOGIC_VERSION, combinedHash },
    });
    if (tx.anchored === false || !(tx.index >= 0)) {
      return {
        anchored: false,
        code: 'append_failed',
        anchor: anchorDoc,
        error: tx.error || 'the ledger refused this block',
      };
    }
    anchorDoc.blockIndex = tx.index;
    anchorDoc.txHash = tx.txs[0] || '';
    await anchorDoc.save();
    return {
      anchored: true,
      anchor: anchorDoc,
      blockIndex: tx.index,
      txHash: tx.txs[0] || '',
      combinedHash,
      logicVersion: RECOMMENDER_LOGIC_VERSION,
    };
  } catch (err) {
    console.error('[proofs anchorRecommendation]', err.message);
    return { anchored: false, error: err.message };
  }
}

// Both facts a saved plan produces, in ONE block: the plan commitment and the
// health-ledger snapshot that now describes it.
//
// The snapshot has to be re-anchored with the plan, not only when the
// assessment is first created. `updatedAt` is part of the health digest, so an
// assessment anchored before its AI results existed describes a record that has
// since moved on — and `/health/verify`, which looks the credential's CURRENT
// digest up in the anchor table, then correctly answers "this record was never
// anchored" for a member who did everything right. Mined separately that is two
// blocks per plan save; `anchorMany` makes it one.
async function anchorPlanEvents(user, assessmentId) {
  try {
    if (!assessmentId) return { anchored: false, code: 'invalid', error: 'no assessment id' };
    const assessment = await Assessment.findOne({ _id: assessmentId, user: user._id }).lean();
    if (!assessment) return { anchored: false, code: 'not_found', error: 'assessment not found' };
    if (!assessment.aiResults) return { anchored: false, code: 'no_results', error: 'no AI results yet' };

    const { inputHash, outputHash, combinedHash } = recommendationCommitment(assessment);
    // Read AFTER the results write, so this snapshot is the state the plan left
    // the record in — the same digest an export will re-derive minutes later.
    const snapshot = await buildHealthDigest(user._id);
    const wallet = await engine.getWalletDoc(user._id);
    const anchorDoc = await RecAnchor.findOneAndUpdate(
      { user: user._id, assessmentId: assessment._id },
      { $set: { logicVersion: RECOMMENDER_LOGIC_VERSION, inputHash, outputHash, combinedHash } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const tx = await engine.anchorMany([
      {
        type: 'rec:anchor',
        actor: wallet.address,
        data: { assessment: String(assessment._id), logicVersion: RECOMMENDER_LOGIC_VERSION, combinedHash },
      },
      {
        // digest-only, like the manual route: personal answers stay in the DB.
        type: 'health:anchor',
        actor: wallet.address,
        data: { digest: snapshot.digest, assessmentCount: snapshot.assessmentCount, intakeCount: snapshot.intakeCount },
        secret: snapshot.payload,
      },
    ]);
    if (tx.anchored === false || !(tx.index >= 0)) {
      return { anchored: false, code: 'append_failed', anchor: anchorDoc, error: tx.error || 'the ledger refused this block' };
    }

    anchorDoc.blockIndex = tx.index;
    anchorDoc.txHash = tx.txs[0] || '';
    await anchorDoc.save();
    const healthRow = await HealthAnchor.create({
      user: user._id,
      digest: snapshot.digest,
      assessmentCount: snapshot.assessmentCount,
      intakeCount: snapshot.intakeCount,
      latestAssessmentAt: snapshot.latestAssessmentAt,
      blockIndex: tx.index,
      txHash: tx.txs[1] || '',
    });
    return {
      anchored: true,
      blockIndex: tx.index,
      combinedHash,
      logicVersion: RECOMMENDER_LOGIC_VERSION,
      planTxHash: tx.txs[0] || '',
      healthTxHash: tx.txs[1] || '',
      digest: snapshot.digest,
      assessmentCount: snapshot.assessmentCount,
      anchor: anchorDoc,
      healthRow,
    };
  } catch (err) {
    console.error('[proofs anchorPlanEvents]', err.message);
    return { anchored: false, error: err.message };
  }
}

module.exports = {
  RECOMMENDER_LOGIC_VERSION,
  jsonSafe,
  recommendationCommitment,
  buildHealthDigest,
  web3Enabled,
  anchorHealthLedger,
  anchorRecommendation,
  anchorPlanEvents,
};
