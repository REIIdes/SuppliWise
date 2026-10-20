const mongoose = require('mongoose');

/**
 * The durable memory of the self-learning loop.
 *
 * `utils/conditionLearning.js` decides whether it is allowed to spend provider
 * quota yet. Without this collection that decision lives in process memory, so
 * every restart either re-ran the analysis immediately (double spend, and a
 * second set of candidates racing the first into `DynamicCondition`) or never
 * ran it again at all. Two numbers have to survive the process:
 *
 *   `watermarkAt`  which assessments have already been learned from — this is
 *                  what makes "25 new assessments" mean 25 *new* ones rather
 *                  than the same 2000 rows re-analysed every hour.
 *   `finishedAt`   when the last cycle ended, for the minimum-interval rule.
 *
 * `lockUntil` is a lease, not a flag. A run claims it atomically before doing
 * any work and stamps it a fixed time ahead, so a process that is killed
 * mid-cycle cannot strand the loop in `running` forever: the lease simply
 * expires and the next eligible cycle takes over. That is also what keeps two
 * API processes sharing one database from both running the same analysis.
 *
 * Deliberately absent: the candidates themselves. They are already recorded —
 * every verdict, accepted or rejected, with the evidence gate's reason verbatim,
 * in `ConditionProposal`. This document only says whether the loop is alive and
 * what it counted, which is exactly what the admin monitor needs to show.
 */
const aiLearningRunSchema = new mongoose.Schema(
  {
    // One document per learning loop. Today there is one; the unique key is
    // what makes adding a second loop a new row rather than a rewrite of this
    // one's watermark.
    name: { type: String, required: true, unique: true, trim: true, maxlength: 120 },

    status: {
      type: String,
      enum: ['idle', 'running', 'completed', 'failed'],
      default: 'idle',
    },
    trigger: { type: String, enum: ['scheduled', 'manual', 'cli'], default: 'scheduled' },

    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    // Lease expiry. A stale lease is claimable, so nothing has to "unlock" this
    // by hand after a crash.
    lockUntil: { type: Date, default: new Date(0) },

    // Newest assessment `createdAt` this cycle consumed. Assessments created
    // while it was running are picked up by the next cycle, never lost.
    watermarkAt: { type: Date, default: null },

    newAssessments: { type: Number, min: 0, default: 0 },
    assessmentsScanned: { type: Number, min: 0, default: 0 },
    candidates: { type: Number, min: 0, default: 0 },
    accepted: { type: Number, min: 0, default: 0 },
    rejected: { type: Number, min: 0, default: 0 },
    published: { type: Number, min: 0, default: 0 },
    refreshed: { type: Number, min: 0, default: 0 },

    // Counts consecutive failures so the monitor can tell "one bad provider
    // day" from "the loop has been broken for a week".
    consecutiveFailures: { type: Number, min: 0, default: 0 },
    lastError: { type: String, trim: true, maxlength: 500, default: '' },
  },
  { versionKey: false }
);

const LEDGER_NAME = 'condition-learning';

/** The one ledger row this loop needs, created on first use. */
aiLearningRunSchema.statics.ensureLedger = async function ensureLedger(name = LEDGER_NAME) {
  return this.findOneAndUpdate(
    { name },
    { $setOnInsert: { name, status: 'idle', lockUntil: new Date(0) } },
    { new: true, upsert: true, setDefaultsOnInsert: true, lean: true }
  );
};

/**
 * Take the lease, or find out that someone else holds it.
 *
 * The filter is the whole mechanism: a claim only succeeds while `lockUntil`
 * already lies in the past, and mongoose runs it as one atomic operation, so
 * two processes asking at the same instant get one row and one `null`.
 */
aiLearningRunSchema.statics.claim = function claim({
  name = LEDGER_NAME,
  trigger = 'scheduled',
  now = new Date(),
  lockMs = 30 * 60 * 1000,
} = {}) {
  const startedAt = now instanceof Date ? now : new Date(now);
  return this.findOneAndUpdate(
    { name, lockUntil: { $lte: startedAt } },
    {
      $set: {
        status: 'running',
        trigger,
        startedAt,
        lockUntil: new Date(startedAt.getTime() + Math.max(60 * 1000, lockMs)),
      },
    },
    { new: true, lean: true }
  );
};

/** Write the outcome and release the lease in the same operation. */
aiLearningRunSchema.statics.release = function release(
  { name = LEDGER_NAME } = {},
  { now = new Date(), status = 'completed', stats = {}, error = '' } = {}
) {
  const finishedAt = now instanceof Date ? now : new Date(now);
  const failed = status === 'failed';
  const $set = {
    status,
    finishedAt,
    lockUntil: finishedAt,
    lastError: String(error || '').slice(0, 500),
  };
  if (failed) return this.updateOne({ name }, { $set, $inc: { consecutiveFailures: 1 } });
  $set.consecutiveFailures = 0;
  $set.watermarkAt = stats.watermarkAt instanceof Date
    ? stats.watermarkAt
    : (stats.watermarkAt ? new Date(stats.watermarkAt) : finishedAt);
  for (const key of ['newAssessments', 'assessmentsScanned', 'candidates', 'accepted', 'rejected', 'published', 'refreshed']) {
    const value = Number(stats[key]);
    $set[key] = Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
  }
  return this.updateOne({ name }, { $set });
};

/**
 * Is this loop allowed to run yet?
 *
 * The rule lives here rather than only inside the cycle so that the admin
 * monitor and the timer answer with the same number: a monitor that reports a
 * different eligibility than the code that acts on it is how "it never learns"
 * gets blamed on the database.
 */
aiLearningRunSchema.statics.nextEligibility = function nextEligibility(
  ledger,
  { now = new Date(), minHours = 24, minNewAssessments = 25, newAssessments = 0 } = {}
) {
  const current = now instanceof Date ? now : new Date(now);
  if (!ledger || !ledger.finishedAt) return { eligible: true, waitMs: 0, reason: 'never run' };
  const elapsed = current.getTime() - new Date(ledger.finishedAt).getTime();
  const minMs = Math.max(0, Number(minHours) || 0) * 3600 * 1000;
  if (elapsed < minMs) return { eligible: false, waitMs: minMs - elapsed, reason: 'interval not elapsed' };
  if ((Number(newAssessments) || 0) < (Math.max(1, Number(minNewAssessments) || 1))) {
    return { eligible: false, waitMs: null, reason: 'not enough new assessments' };
  }
  return { eligible: true, waitMs: 0, reason: 'due' };
};

module.exports = mongoose.model('AiLearningRun', aiLearningRunSchema);
module.exports.LEDGER_NAME = LEDGER_NAME;
