/**
 * The Wellness Score, in one place.
 *
 * WHAT IT IS
 *   baseline (0-30) + adherence (0-50) + streak (0-20) = 100.
 *
 * WHAT CHANGED, AND WHY
 * The adherence term used to be `overallAdherence` alone — every dose ever
 * recorded, divided into 50 points. Which meant a user who took nothing at all
 * today lost, at most, `0.5 * 50 / (doses ever recorded)` points: on a plan of 4
 * supplements tracked for 30 days that is a third of a point. The score was
 * therefore incapable of reacting to today, which is the only day anyone is
 * actually living.
 *
 * So the term is now a blend:
 *
 *   adherencePct = 60% today's adherence  +  40% lifetime adherence
 *
 * 60/40 rather than today's alone, because a score that forgets a 200-day
 * record every morning is not a wellness score, it is a to-do list. 40/60 the
 * other way would reintroduce the bug from the other side: one missed pill at
 * 9 AM would be invisible for weeks.
 *
 * WHAT "TODAY'S ADHERENCE" COUNTS IS THE WHOLE FEATURE
 * It is NOT taken / total. It is taken / DECIDED, where a dose is decided once
 * either it has been ticked or its window has closed (utils/intakeWindows.js):
 *
 *   ticked, whenever it was ticked ....... full credit, late included
 *   unticked, window still open ........... not counted either way
 *   unticked, window closed ............... missed, full penalty
 *
 * So an unticked morning pill costs nothing at 8:30 and costs everything at
 * 12:01, and ticking it at 11:55 costs nothing at all. That is the difference
 * between a score that measures discipline and one that measures alarms.
 */

/** Ceiling of each term. They sum to 100, which is the scale the UI promises. */
const BASELINE_MAX = 30;
const ADHERENCE_MAX = 50;
const STREAK_MAX = 20;

/** How the two adherence inputs are weighted. Documented above; see also
 *  QUICK_START_GUIDE.md, which needs the same update whenever these move. */
const TODAY_WEIGHT = 0.6;
const HISTORY_WEIGHT = 0.4;

/** Default starting point when the AI produced no baseline. */
const DEFAULT_BASELINE = 15;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/** A percentage is clamped rather than trusted: a NaN here would silently
 *  delete the whole adherence term instead of scoring zero for it. */
const clampPct = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, 100);
};

/**
 * The health baseline, from the assessment's AI results.
 *
 * Falls back to a neutral 15 rather than 0 so a plan without a baseline still
 * has a score worth improving, and clamps to 0-30 so a malformed or
 * out-of-range value cannot hand out free points.
 */
function getWellnessBaseline(assessment) {
  // No AI results at all means the recommendation generation failed before
  // anything was saved — that is NOT a completed assessment. Returning the
  // neutral 15 here used to manufacture a wellness number out of thin air.
  if (assessment && (assessment.aiResults == null || typeof assessment.aiResults !== 'object')) return 0;
  const raw = assessment && assessment.aiResults && assessment.aiResults.wellnessBaseline;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return clamp(raw, 0, BASELINE_MAX);
  }
  return DEFAULT_BASELINE;
}

/**
 * @param {{baseline?: number, overallAdherence?: number, todayAdherence?: number, streak?: number}} input
 * @returns {number} 0-100, always an integer.
 */
function calculateWellnessScore({
  baseline = DEFAULT_BASELINE,
  overallAdherence = 0,
  todayAdherence = 100,
  streak = 0,
} = {}) {
  const blendedAdherence = Math.round(
    TODAY_WEIGHT * clampPct(todayAdherence) + HISTORY_WEIGHT * clampPct(overallAdherence)
  );

  const baselinePoints = clamp(Number(baseline) || 0, 0, BASELINE_MAX);
  const adherencePoints = Math.round((blendedAdherence / 100) * ADHERENCE_MAX);
  const streakPoints = Math.min(Math.round(Math.max(Number(streak) || 0, 0) * 0.67), STREAK_MAX);

  return clamp(Math.round(baselinePoints + adherencePoints + streakPoints), 0, 100);
}

/**
 * How many points today's misses are costing right now.
 *
 * Computed as a difference between two real scores rather than a separate
 * formula, so the number the UI shows can never disagree with the number the UI
 * shows. Returns 0 when nothing has closed yet — which is the honest answer at
 * 7 AM, not a promise that the day will go well.
 *
 * @returns {{points: number, unpenalisedScore: number}}
 */
function penaltyForMisses({ baseline, overallAdherence, streak = 0, today } = {}) {
  const actual = calculateWellnessScore({ baseline, overallAdherence, todayAdherence: today?.adherence ?? 100, streak });
  const unpenalised = calculateWellnessScore({ baseline, overallAdherence, todayAdherence: 100, streak });
  return { points: Math.max(0, unpenalised - actual), unpenalisedScore: unpenalised };
}

/**
 * The `stats.wellnessToday` payload the dashboard renders.
 *
 * `missed` and `awaiting` are the two halves of the rule, so the UI can say
 * "2 missed" and "3 still open" without re-deriving anything client-side (and
 * therefore without the client being able to disagree with the score).
 */
function describeToday(today) {
  const snapshot = today || {};
  return {
    total: snapshot.total || 0,
    taken: snapshot.taken || 0,
    missed: snapshot.missed || 0,
    awaiting: snapshot.awaiting || 0,
    decided: snapshot.decided || 0,
    adherence: Number.isFinite(snapshot.adherence) ? snapshot.adherence : 100,
  };
}

module.exports = {
  BASELINE_MAX,
  ADHERENCE_MAX,
  STREAK_MAX,
  TODAY_WEIGHT,
  HISTORY_WEIGHT,
  DEFAULT_BASELINE,
  getWellnessBaseline,
  calculateWellnessScore,
  penaltyForMisses,
  describeToday,
};