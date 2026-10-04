/**
 * What today's plan is doing to the Wellness Score, in one line.
 *
 * Run: node --test src/utils/scoreSync.test.js
 *
 * WHY THE SENTENCE EXISTS
 * The score used to move with nothing on screen to explain it, which reads as a
 * glitch rather than as a consequence. But the server's rule has three outcomes
 * (`server/utils/intakeWindows.js`), not two, and a line that only ever said
 * "you missed N" would accuse a user at 8:30 AM about a dose they were still on
 * time for. So all three are named:
 *
 *   ticked, whenever it was ticked ... no cost, however late
 *   unticked, window still open ...... no cost yet
 *   unticked, window closed ......... costs points, now
 *
 * This file only FORMATS. It never decides whether something was missed, and it
 * never computes a penalty — both come from the API, because the score itself is
 * persisted server-side and read by Insights and the Web3 export, which have no
 * browser to ask. Deriving any of it here is how a number on the dashboard would
 * come to disagree with the number everywhere else.
 *
 * WHY IT IS ITS OWN MODULE
 * It is pure string work over a plain object, and this codebase tests that kind
 * of thing directly (`node --test`) rather than through a rendered page — see
 * utils/slotSchedule.js for the same reason.
 */

/** "1 dose" / "3 doses", and the cost as "1 point" / "12 points". */
const plural = (count, singular, pluralForm) => (count === 1 ? singular : pluralForm);

/** Tone for the pill: a penalty, or not. Nothing else — two states, two looks. */
export function scoreSyncTone(today) {
  return (today?.missed || 0) > 0 ? 'penalty' : 'ok';
}

/**
 * The line under the score, or '' when there is nothing true to say.
 *
 * @param {{missed?: number, awaiting?: number, taken?: number, penaltyPoints?: number}} today
 *   The API's `stats.wellnessToday`.
 * @returns {string} '' for an older server that does not send the block, or for
 *   a day with no plan on it.
 */
export function scoreSyncLine(today) {
  if (!today || typeof today !== 'object') return '';

  const missed = Math.max(0, Number(today.missed) || 0);
  const awaiting = Math.max(0, Number(today.awaiting) || 0);
  const taken = Math.max(0, Number(today.taken) || 0);
  const points = Math.max(0, Number(today.penaltyPoints) || 0);

  if (missed > 0) {
    const doses = plural(missed, 'dose', 'doses');
    // Points can be 0 for a miss in a very large plan where the rounding lands
    // there, so the wording says "costing you nothing" rather than "0 points".
    const cost = points === 0 ? 'costing you nothing yet' : `costing you ${points} ${plural(points, 'point', 'points')}`;
    // "their" vs "its" follows the awaiting count so the sentence agrees with the
    // number of doses it is talking about.
    const owner = awaiting > 0 ? 'their' : 'its';
    const still = awaiting > 0
      ? ` ${awaiting} still open — take ${awaiting === 1 ? 'it' : 'them'} on time and today recovers.`
      : ' Nothing is left to take today.';
    return `${missed} ${doses} missed after ${owner} window closed, ${cost}.${still}`;
  }

  if (awaiting > 0) {
    return `In step — ${awaiting} still open, and nothing has closed yet.`;
  }

  if (taken > 0) {
    return 'Everything taken. Late entries count the same as on time.';
  }

  return '';
}