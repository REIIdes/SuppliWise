/**
 * Priority-flag guard — one rule for every code path that raises a Priority.
 *
 * THE BUG THIS FIXES
 * `PATCH /api/assessment/:id/priority` set `priority: 'Priority'` with no
 * conditions at all. So an admin could flag an assessment whose intake was
 * already finished, and the user was immediately shown "New Assessments
 * Paused" — with no way out. The auto-lift in `POST /api/dashboard/intake`
 * only runs when the user next posts an intake for that day; someone who had
 * already ticked everything off was never coming back to post again, so the
 * flag stayed open indefinitely. That is the "panicked user" case: a gate with
 * no exit.
 *
 * The same hole existed on two other paths that raise the flag without an
 * admin touching anything — `flagSevereAssessment` (severity auto-flag) and
 * `PATCH /:id/results`, which re-runs severity detection. Re-saving results
 * for a finished assessment re-raised a gate the user had already satisfied.
 *
 * THE RULE
 * A Priority review is only meaningful while the day's plan is still
 * outstanding. It is refused when:
 *   1. the assessment's intake is already complete today (nothing left to do), or
 *   2. the user already has a different assessment open as Priority (the gate
 *      is designed around one open review; stacking them produced a
 *      "You have 3 prioritized assessments" wall with no per-item resolution).
 *
 * `selfHealOpenPriority` additionally repairs flags that were already written
 * before this guard existed, so users stuck behind an old bad flag are released
 * the next time their status is read instead of staying blocked forever.
 */

const IntakeRecord = require('../models/IntakeRecord');
const Assessment = require('../models/Assessment');
const AdminEvent = require('../models/AdminEvent');
const { expiryFromCreatedAt } = require('./assessments');

/** Today in YYYY-MM-DD, matching the dayKey used by IntakeRecord. */
function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Completion state of an assessment's plan for today.
 * Mirrors the definition in routes/dashboard.js: every record for today must
 * be `taken`, and there must be at least one record (an empty plan is not
 * "complete", it is "not started" — treating it as complete would let a
 * Priority through for a user who has no supplements at all).
 */
async function intakeStateFor(userId, assessmentId) {
  if (!userId || !assessmentId) return { total: 0, taken: 0, complete: false, dayKey: null };

  // TODAY first, then fall back to the most recent day that has records.
  //
  // The fallback is what makes "the assessment is already done" detectable at
  // all. Someone who ticked everything off yesterday and was flagged this
  // morning has NO records for today, so a today-only check returns total=0,
  // reports "not complete", and the gate stays up for a review they finished
  // yesterday — with no path to clear it, because clearing it requires posting
  // an intake for today.
  const today = getTodayKey();
  const recent = await IntakeRecord.find({ user: userId, assessment: assessmentId })
    .sort({ dayKey: -1 })
    .limit(200)
    .select('taken dayKey')
    .lean();

  if (recent.length === 0) {
    return { total: 0, taken: 0, complete: false, dayKey: null };
  }

  // Group by day, newest first, and evaluate today if it exists at all.
  const byDay = new Map();
  for (const r of recent) {
    if (!byDay.has(r.dayKey)) byDay.set(r.dayKey, []);
    byDay.get(r.dayKey).push(!!r.taken);
  }

  const dayKey = byDay.has(today) ? today : [...byDay.keys()].sort().pop();
  const flags = byDay.get(dayKey);
  const total = flags.length;
  const taken = flags.filter(Boolean).length;

  return { total, taken, complete: total > 0 && taken === total, dayKey };
}

/**
 * The actual rule, as a pure function of two facts.
 *
 * Kept free of Mongoose so it can be unit-tested directly — the bug this file
 * fixes was a missing precondition, and a missing precondition is exactly the
 * kind of thing that regresses silently if the only test needs a live database.
 *
 * @param {{intake: {total:number, taken:number, complete:boolean}, openId?: string}} facts
 */
function decideRaisePriority({ intake, openId } = {}) {
  if (intake && intake.complete) {
    return {
      ok: false,
      code: 'intake-complete',
      intake,
      message:
        'This assessment is already complete — all of today\u2019s supplements are taken, ' +
        'so there is no outstanding review to flag. Mark it Standard instead, or flag it ' +
        'before the day\u2019s plan is finished.',
    };
  }
  if (openId) {
    return {
      ok: false,
      code: 'already-open',
      intake,
      openId: String(openId),
      message:
        'This user already has an assessment open for priority review. Resolve that one first, ' +
        'otherwise the two flags stack and the user sees a pause they cannot clear.',
    };
  }
  return { ok: true, intake };
}

/**
 * Decide whether `assessmentId` may be raised to Priority.
 * @returns {Promise<{ok: boolean, code?: string, message?: string, intake?: object, openId?: string}>}
 */
async function guardRaisePriority(userId, assessmentId) {
  // Fail closed on an unresolvable owner.
  //
  // Without this, `intakeStateFor(null, id)` finds no intake rows and reports
  // `{ total: 0, taken: 0, complete: false }`, which the rule below reads as
  // "nothing finished, go ahead" — so the flag was written onto an assessment
  // with no owner. Such a flag can never be released, notified or audited,
  // because every repair path is keyed on the user. That is precisely the
  // "panicked user has no exit" failure this guard exists to prevent, so an
  // ownerless assessment must be refused rather than flagged blind.
  if (userId === null || userId === undefined || userId === '' || userId === false) {
    return {
      ok: false,
      code: 'invalid-assessment',
      intake: null,
      openId: null,
      message:
        'This assessment has no resolvable owner, so a priority flag could never be released, ' +
        'notified or audited. Repair the record before flagging it.',
    };
  }

  const intake = await intakeStateFor(userId, assessmentId);

  const open = await Assessment.findOne({
    user: userId,
    priority: 'Priority',
    _id: { $ne: assessmentId },
  })
    .select('_id')
    .lean();

  return decideRaisePriority({ intake, openId: open ? open._id : null });
}

/**
 * Release Priority flags whose plan is already finished.
 *
 * Reads happen on every page load that cares about the gate, so this is where
 * a flag written before the guard existed (or by a path that has not been
 * audited) stops harming the user. Each repair is best-effort: a failure here
 * must never turn a status read into a 500.
 *
 * @returns {Promise<{released: string[], remaining: object[]}>}
 */
async function selfHealOpenPriority(userId) {
  const open = await Assessment.find({ user: userId, priority: 'Priority' }).lean();
  const released = [];
  const remaining = [];

  for (const doc of open) {
    const { complete } = await intakeStateFor(userId, doc._id);
    if (complete) {
      const ok = await Assessment.findByIdAndUpdate(
        doc._id,
        {
          $set: {
            priority: 'Standard',
            // Release must also RESTORE the retention date. A Priority record
            // stores `expiresAt: null` (expiration is suspended while flagged),
            // so without this a released assessment was left with no expiry at
            // all and the record silently became undeletable-in-practice.
            expiresAt: expiryFromCreatedAt(doc.createdAt),
            resolvedAt: new Date(),
            resolvedReason: 'intake-complete',
          },
        }
      ).then((r) => !!r);
      if (ok) {
        released.push(String(doc._id));
        // An automatic release must be auditable, not silent: the user was told
        // "New Assessments Paused" and is now being told nothing, so an admin
        // needs to see why the gate opened on its own.
        await AdminEvent.create({
          type: 'resolved',
          title: 'Priority auto-resolved (intake complete)',
          detail: `Assessment ${doc._id} was released automatically — the day\u2019s plan is already complete, so there was no outstanding review.`,
          user: doc.user,
          assessmentId: doc._id,
          linkUserId: doc.user,
        }).catch(() => {});
      } else remaining.push(doc);
    } else {
      remaining.push(doc);
    }
  }

  return { released, remaining };
}

module.exports = {
  getTodayKey,
  intakeStateFor,
  decideRaisePriority,
  guardRaisePriority,
  selfHealOpenPriority,
};
