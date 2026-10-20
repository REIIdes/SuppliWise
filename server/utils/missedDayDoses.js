/**
 * The IntakeRecord documents a plan day is made of — and the routine that
 * retro-seeds days the user never opened.
 *
 * Run: node --test "Test File/missedDayDoses.test.js"
 *
 * WHY THE DOC BUILDER IS SHARED
 * GET / seeds today's rows and this file seeds a week of yesterdays. Those two
 * used to be one inline map, and the moment the second reader appeared the name
 * lookup, the priority fallback and the slot resolution would have existed twice
 * — which is exactly how a hand-added row came to be judged by a different window
 * than a seeded one. One builder, so a dose has the same shape and the same slot
 * whichever day it is written for.
 *
 * WHY BACKFILL WRITES `taken: false` AND NOTHING ELSE
 * A backfilled day is judged by the same rulebook as a live one
 * (utils/intakeWindows.js): every window of a day that is already over has closed,
 * so an unticked row is simply a missed row. There is no second scoring path for
 * skipped days and no special "this was backfilled" branch in the score — the day
 * costs exactly what a day you opened and ignored would have cost.
 */

const { resolveTimeSlot, buildScheduleSlotIndex } = require('./dailyScheduleSlots');
const { planDaysToBackfill, DEFAULT_BACKFILL_LOOKBACK_DAYS } = require('./missedDayResolver');

const cleanText = (value, max) => (typeof value === 'string' ? value : '').trim().slice(0, max);

/** How many day-existence probes may be in flight at once. */
const COUNT_BATCH = 12;

/** Is `dayKey` a real key strictly after `other` (which may be empty)? */
const isAhead = (dayKey, other) => {
  const a = cleanText(dayKey, 10);
  const b = cleanText(other, 10);
  return a.length === 10 && (b.length !== 10 || a > b);
};

/**
 * The unticked dose rows for one plan day.
 *
 * @param {Array} recommendations  `assessment.aiResults.recommendations`
 * @param {Array} dailySchedule    `assessment.aiResults.dailySchedule`
 * @param {{dayKey: string, date?: Date}} options
 * @returns {Array} IntakeRecord-shaped documents, capped at 20 per day — the
 *   same cap GET / has always used, so a backfilled day cannot be bigger than a
 *   live one.
 */
function buildDayDoseDocs(recommendations, dailySchedule, { dayKey, date = new Date() } = {}) {
  const slotIndex = buildScheduleSlotIndex(Array.isArray(dailySchedule) ? dailySchedule : []);

  return (Array.isArray(recommendations) ? recommendations : [])
    .slice(0, 20)
    .map((rec) => {
      const name = cleanText(rec && (rec.name || rec.supplement), 200);
      const slot = resolveTimeSlot({ name, timing: rec && rec.timing }, slotIndex);
      return {
        supplementName: name,
        // Empty, not a placeholder: the dashboard has always shown whatever the
        // AI returned, and inventing "1" here would put a dosage on a card the
        // user never had.
        dosage: cleanText(rec && rec.dosage, 100),
        priority: ['High', 'Medium', 'Low'].includes(rec && rec.priority) ? rec.priority : 'Medium',
        scheduledTime: slot.timeLabel || cleanText(rec && rec.timing, 100) || 'Anytime',
        // Stored, not re-derived: the score has to know when this dose was due.
        timeSlot: slot.key,
        taken: false,
        date,
        dayKey,
      };
    })
    .filter((doc) => doc.supplementName);
}

/**
 * Seed every past plan day that has no records at all.
 *
 * Called by GET / after today's own rows are seeded, so `todayKey` is never a
 * candidate here — a running day must be judged by its windows, not by this.
 *
 * A day is judged by having rows at all, not by having ticked rows: a day the
 * user opened and skipped is already scored, and re-seeding it would be wrong.
 *
 * WHY ONE WRITE FOR THE WHOLE GAP
 * The candidate days are read in parallel and every dose of every missing day
 * goes out in a SINGLE bulkWrite. Walking the gap day by day would be one
 * round-trip per day — at the ~0.5s Atlas latency this file's own route
 * comments quote, a month-long gap would turn a dashboard load into a
 * half-minute one. The writes are idempotent ($setOnInsert on the natural key),
 * so nothing is lost by retrying the whole pass.
 *
 * @param {{user, assessment, recommendations, dailySchedule, metrics,
 *          todayKey, sinceDayKey?, now?, lookbackDays?, IntakeRecord?}} options
 *   `IntakeRecord` is injectable so this is testable without a database; the
 *   route passes nothing and gets the real model.
 * @returns {Promise<{judged: number, days: number, doses: number, lastBackfilledDay: string}>}
 *   `judged` counts candidate days examined (and therefore how far the pointer
 *   moved); `days`/`doses` count what was actually written. A caller that only
 *   persists on `days` would lose the pointer on a pass that found the history
 *   already decided — which is every load after the first.
 */
async function backfillMissedDays({
  user,
  assessment,
  recommendations,
  dailySchedule,
  metrics,
  todayKey,
  sinceDayKey = '',
  now = new Date(),
  lookbackDays = DEFAULT_BACKFILL_LOOKBACK_DAYS,
  IntakeRecord = null,
} = {}) {
  const Model = IntakeRecord || require('../models/IntakeRecord');
  const resumeAfter = cleanText(metrics && metrics.lastBackfilledDay, 10);

  const { keys } = planDaysToBackfill({
    sinceDayKey,
    lastBackfilledDay: resumeAfter,
    todayKey,
    lookbackDays,
  });
  if (keys.length === 0) return { judged: 0, days: 0, doses: 0, lastBackfilledDay: resumeAfter };

  // Read the candidates in bounded batches rather than all at once. The window
  // can legally be a year wide, and firing 366 queries at once would take the
  // connection pool with it — this project has already learned what a drained
  // pool does to a shared database. Small batches, still far fewer round-trip
  // rounds than one query per day.
  const counts = [];
  for (let i = 0; i < keys.length; i += COUNT_BATCH) {
    const batch = keys.slice(i, i + COUNT_BATCH);
    counts.push(...(await Promise.all(
      batch.map((dayKey) => Model.countDocuments({ user, assessment, dayKey }))
    )));
  }

  const missing = keys.filter((dayKey, i) => counts[i] === 0);
  const ops = [];
  let days = 0;
  let doses = 0;
  for (const dayKey of missing) {
    const docs = buildDayDoseDocs(recommendations, dailySchedule, { dayKey, date: now });
    if (docs.length === 0) continue;
    days += 1;
    doses += docs.length;
    for (const doc of docs) {
      // $setOnInsert + upsert: a day that grew rows between the count above and
      // this write keeps them instead of colliding.
      ops.push({
        updateOne: {
          filter: { user, assessment, supplementName: doc.supplementName, dayKey: doc.dayKey },
          update: { $setOnInsert: { ...doc, user, assessment } },
          upsert: true,
        },
      });
    }
  }

  // `ordered: false` for the same reason GET / uses it — one bad row must not
  // abandon the rest of the gap. A throw here leaves the pointer exactly where
  // it was, so the next load re-judges these days; the upsert makes that safe.
  if (ops.length > 0) await Model.bulkWrite(ops, { ordered: false });

  // Every candidate is now decided: the days that had rows already were scored,
  // and the ones that did not have just been written. Newest wins, and the
  // pointer never moves backwards.
  const newest = keys[keys.length - 1];
  const advanced = isAhead(newest, resumeAfter) ? newest : resumeAfter;
  if (metrics && advanced !== resumeAfter) metrics.lastBackfilledDay = advanced;

  return { judged: keys.length, days, doses, lastBackfilledDay: advanced };
}

module.exports = {
  buildDayDoseDocs,
  backfillMissedDays,
};
