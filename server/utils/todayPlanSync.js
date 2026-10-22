/**
 * Which doses of THIS plan are today's rows — and which start at the next 4 AM.
 *
 * Run: node --test "Test File/today-plan-sync.test.js"
 *
 * THE TWO BUGS THIS CLOSES
 * GET / used to seed today's rows only when the day was EMPTY:
 *
 *   if (todayIntakeRecords.length === 0 && recommendations.length > 0) { ... }
 *
 * That single condition broke both halves of what the user is told about a plan.
 *
 *   AN UPDATED PLAN NEVER ARRIVES. Updating an assessment makes a new assessment
 *   document, which has no rows for today, so the day looks untouched — except
 *   the OLD plan's rows are already there under the old assessment, and the
 *   migration that should have moved them is the step that fails. Either way the
 *   supplements the update ADDED were not on the page. A user who added Vitamin D
 *   by updating their assessment was told their plan had not changed.
 *
 *   A CLOSED FRAME IS STILL ASKED FOR. A plan made at 3 PM has a Morning stack
 *   whose window shut at noon. utils/planActivation.js stopped charging for it,
 *   which fixed the score but left the ask: the row sat on the page, untakeable
 *   on time, in a list the user could not finish. "Not counted as missed" above
 *   a Morning the user cannot make is half an answer.
 *
 * THE RULE
 * Today's rows carry only the frames this day can still be judged on. The frames
 * the plan was never given time for are not written today at all — they are
 * reported in `planDeferred` as starting at the next 4 AM reset, which is exactly
 * when they become ordinary, chargeable work. `anytime` is never deferred; it has
 * no window to have missed and "anytime" includes now. See
 * utils/planActivation.js → deferredSlotsOnDay.
 *
 * A dose is therefore EITHER today's row OR tomorrow's start, never both. The
 * deferral list is filtered against the rows that actually exist, so a day that
 * already has its Morning rows (seeded before this rule, or migrated in) keeps
 * showing them as today's work.
 *
 * THE ONE THING THAT OVERRIDES A DEFERRED FRAME: a dose the user already TICKED
 * today is written anyway, ticked. A taken dose is history, and history belongs
 * to the day it happened on — an Update arriving at 3 PM must not delete the
 * record that the morning pill was taken at 8.
 *
 * WHY TAKEN STATE IS INHERITED
 * An update is not a new day. If the user ticked Magnesium at 8 AM under the old
 * plan, the same dose on the same plan day must not come back unticked under the
 * new one — that would ask them to take a pill twice. So before writing, the sync
 * reads the user's ticked doses for this `dayKey` across EVERY assessment and
 * keeps any name it is about to write already taken. It is keyed on the plan day
 * and the normalised supplement name, not on the assessment, which is what makes
 * it work when the history migration failed.
 *
 * WHY ONCE PER (ASSESSMENT, DAY)
 * Syncing on every load would resurrect supplements the user removed through
 * POST /remove-supplement, because those rows are hard-deleted and the plan still
 * names them. `DashboardMetrics.planSynced` records the last plan this routine
 * wrote for this day, so a load after the first changes nothing. The deferral
 * list, by contrast, is recomputed from the plan on EVERY load — it is a read of
 * the plan, not a write, and must survive a page refresh at 9 PM.
 *
 * WHY IT NEVER DELETES
 * A row that exists is history: it is scored, it feeds the calendar, Insights and
 * the Web3 export, and it may be a dose the user ticked. Dropping rows that the
 * current plan no longer names is a decision about the PLAN, and only
 * POST /api/assessment/:id/migrate-history knows both plans' name sets — so that
 * pruning lives there, not on a read path.
 */

const { buildDayDoseDocs } = require('./missedDayDoses');
const { normalizeName, SLOT_DEFS } = require('./dailyScheduleSlots');
const { deferredSlotsOnDay } = require('./planActivation');
const { shiftDayKey, PLAN_DAY_RESET_LABEL } = require('./planDay');

const asText = (value) => (typeof value === 'string' ? value : value == null ? '' : String(value));

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A cap on the cross-assessment read, so a pathological day cannot grow a huge map. */
const MAX_TAKEN_ROWS = 200;

const slotDef = (key) => SLOT_DEFS.find((def) => def.key === asText(key).toLowerCase()) || SLOT_DEFS[SLOT_DEFS.length - 1];

/** One deferred dose, in the shape the tracker renders a row from. */
function deferredItem(doc) {
  const def = slotDef(doc.timeSlot);
  return {
    name: doc.supplementName,
    dosage: doc.dosage || '',
    priority: doc.priority || 'Medium',
    scheduledTime: doc.scheduledTime || def.label,
    timeSlot: def.key,
    timeSlotLabel: def.label,
    timeSlotOrder: def.order,
  };
}

/**
 * Split one plan into the doses today may be judged on and the frames it was
 * never given time for. Pure — no database, no clock beyond the `now` handed in.
 *
 * @param {Array} recommendations `assessment.aiResults.recommendations`
 * @param {Array} dailySchedule   `assessment.aiResults.dailySchedule`
 * @param {{dayKey: string, date?: Date, activation?: object|null}} options
 * @returns {{toWrite: Array, waiting: Array, deferredSlots: string[]}}
 */
function splitTodayPlan(recommendations, dailySchedule, { dayKey, date = new Date(), activation = null } = {}) {
  const deferred = deferredSlotsOnDay(activation, dayKey);
  const toWrite = [];
  const waiting = [];
  if (!DAY_KEY_RE.test(asText(dayKey))) {
    // No usable day means no deferral is knowable, and writing a row keyed on a
    // junk dayKey would be worse than writing none.
    return { toWrite, waiting, deferredSlots: [...deferred] };
  }
  for (const doc of buildDayDoseDocs(recommendations, dailySchedule, { dayKey, date })) {
    (deferred.has(doc.timeSlot) ? waiting : toWrite).push(doc);
  }
  return { toWrite, waiting, deferredSlots: [...deferred] };
}

/** Has this exact plan already been written for this exact day? */
function isSynced(metrics, assessment, dayKey) {
  const marker = metrics && metrics.planSynced;
  if (!marker) return false;
  return asText(marker.assessment) === asText(assessment) && asText(marker.dayKey) === dayKey;
}

/**
 * The doses the user already ticked on this plan day, under ANY assessment,
 * keyed by normalised supplement name.
 *
 * The assessment is deliberately NOT part of the filter: this exists for the
 * update, where the ticked row lives under the plan that is being replaced.
 */
async function takenDosesToday(Model, user, dayKey) {
  const rows = await Model.find({ user, dayKey, taken: true })
    .select('supplementName takenAt')
    .limit(MAX_TAKEN_ROWS)
    .lean();
  const byName = new Map();
  for (const row of rows) {
    const key = normalizeName(row && row.supplementName);
    if (!key || byName.has(key)) continue;
    byName.set(key, row.takenAt instanceof Date ? row.takenAt : new Date());
  }
  return byName;
}

/**
 * Make today's rows match the plan, once per (assessment, plan day).
 *
 * @param {{user, assessment, recommendations, dailySchedule, metrics,
 *          todayKey, now?, activation?, IntakeRecord?}} options
 *   `metrics` is mutated when the marker moves; the caller persists it.
 *   `IntakeRecord` is injectable so this is testable without a database.
 * @returns {Promise<{records: Array, deferred: object, synced: boolean}>}
 *   `records` — today's rows after the sync, ready to be scored and rendered.
 *   `deferred` — `planDeferred`: the doses starting at the next reset, with the
 *               frames that hold them. Empty once the day is a normal one.
 *   `synced`   — whether the marker moved (and so whether to save `metrics`).
 */
async function syncTodayPlan({
  user,
  assessment,
  recommendations,
  dailySchedule,
  metrics,
  todayKey,
  now = new Date(),
  activation = null,
  IntakeRecord = null,
} = {}) {
  const Model = IntakeRecord || require('../models/IntakeRecord');
  const day = asText(todayKey);
  const readToday = () => Model.find({ user, assessment, dayKey: day }).lean();

  if (!DAY_KEY_RE.test(day)) {
    const records = await readToday();
    return { records, deferred: emptyDeferred(), synced: false };
  }

  const { toWrite, waiting } = splitTodayPlan(recommendations, dailySchedule, {
    dayKey: day,
    date: now,
    activation,
  });

  let records = null;
  let synced = false;

  if (isSynced(metrics, assessment, day)) {
    records = await readToday();
  } else {
    const alreadyTaken = toWrite.length + waiting.length > 0
      ? await takenDosesToday(Model, user, day)
      : new Map();

    // A dose the user already ticked today is written even when its frame is
    // deferred: a taken dose is history, and history belongs to the day it
    // happened on. Dropping it would make this morning's pills disappear from
    // today's page because an Update arrived after they were taken.
    const due = [...toWrite, ...waiting.filter((doc) => alreadyTaken.has(normalizeName(doc.supplementName)))];

    if (due.length > 0) {
      await Model.bulkWrite(
        due.map((doc) => {
          const seed = { ...doc, user, assessment };
          // An update is not a new day: a dose ticked this morning under the
          // plan being replaced stays ticked. `$setOnInsert` means this only
          // applies to a row that does not exist yet.
          const prior = alreadyTaken.get(normalizeName(doc.supplementName));
          if (prior) {
            seed.taken = true;
            seed.takenAt = prior;
          }
          return {
            updateOne: {
              filter: { user, assessment, supplementName: doc.supplementName, dayKey: day },
              update: { $setOnInsert: seed },
              upsert: true,
            },
          };
        }),
        { ordered: false } // one bad row must not abandon the rest of the plan
      );
    }
    if (metrics) metrics.planSynced = { assessment: asText(assessment), dayKey: day };
    synced = true;
    records = await readToday();
  }

  // Either today's row or tomorrow's start — never both.
  const onPage = new Set();
  for (const record of records) {
    const key = normalizeName(record && record.supplementName);
    if (key) onPage.add(key);
  }
  const items = waiting.filter((doc) => !onPage.has(normalizeName(doc.supplementName))).map(deferredItem);

  const startsDayKey = shiftDayKey(day, 1) || '';
  return {
    records,
    deferred: {
      count: items.length,
      items,
      startsDayKey,
      startsAtLabel: PLAN_DAY_RESET_LABEL,
    },
    synced,
  };
}

/**
 * The shape `planDeferred` always has, so a client can read `count` and `items`
 * without a null check on every dashboard response.
 */
function emptyDeferred() {
  return { count: 0, items: [], startsDayKey: '', startsAtLabel: PLAN_DAY_RESET_LABEL };
}

module.exports = {
  splitTodayPlan,
  isSynced,
  syncTodayPlan,
  deferredItem,
};
