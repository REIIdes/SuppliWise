/**
 * The Priority-assessment rule, with NO dependencies.
 *
 * Everything in this file is a pure function of plain data. It must stay
 * importable without mongoose, without a database and without a network, so
 * that the rule the whole product hinges on can be asserted directly:
 *
 *   "A Priority review may only be raised while the day's plan is still
 *    outstanding, and never on top of another open review."
 *
 * That is a precondition, and preconditions are exactly the defect class that
 * comes back the next time somebody adds a third code path that sets the flag.
 * utils/priorityGate.js is the database-facing half (it re-exports everything
 * here, so existing imports keep working) — keep the logic over there only if
 * it needs a query.
 */

/** Today in YYYY-MM-DD, matching the dayKey used by IntakeRecord. */
function getTodayKey() {
  return new Date().toISOString().split('T')[0];
}

/** "Nothing tracked yet" — never mutate this; callers get a copy. */
const EMPTY_INTAKE = Object.freeze({ total: 0, taken: 0, complete: false, dayKey: null });

/**
 * Completion state of a day's plan, derived from plain intake records.
 *
 * THE RULE:
 *   - TODAY is evaluated whenever today has records.
 *   - Otherwise the most recent day that HAS records is evaluated. This fallback
 *     is what makes "the assessment is already done" detectable at all: someone
 *     who ticked everything off yesterday and was flagged this morning has NO
 *     records for today, so a today-only check reports total=0, "not complete",
 *     and the gate stays up for a review they already finished — with no path to
 *     clear it, because clearing it requires posting an intake for today.
 *   - A day is complete only when it has at least one record and every record
 *     is `taken`. An empty plan is "not started", never "complete": treating it
 *     as complete would let a Priority through for a user with no supplements,
 *     and would auto-release every flag belonging to one.
 *
 * Records without a usable `dayKey` are ignored rather than grouped under
 * `undefined`, so a corrupt row cannot manufacture a "finished" day.
 *
 * @param {Array<{dayKey?: string, taken?: boolean}>} records
 * @param {string} [today] YYYY-MM-DD, injectable so the rule is testable
 * @returns {{total: number, taken: number, complete: boolean, dayKey: string|null}}
 */
function summarizeIntakeDays(records, today = getTodayKey()) {
  if (!Array.isArray(records) || records.length === 0) return { ...EMPTY_INTAKE };

  const byDay = new Map();
  for (const r of records) {
    if (!r || typeof r.dayKey !== 'string' || r.dayKey === '') continue;
    if (!byDay.has(r.dayKey)) byDay.set(r.dayKey, []);
    byDay.get(r.dayKey).push(!!r.taken);
  }
  if (byDay.size === 0) return { ...EMPTY_INTAKE };

  // `[...keys].sort().pop()` is the newest dayKey: day keys are zero-padded
  // YYYY-MM-DD, so lexicographic order IS chronological order.
  const dayKey = byDay.has(today) ? today : [...byDay.keys()].sort().pop();
  const flags = byDay.get(dayKey);
  const total = flags.length;
  const taken = flags.filter(Boolean).length;

  return { total, taken, complete: total > 0 && taken === total, dayKey };
}

/**
 * The gate itself, as a pure function of two facts.
 *
 * Refusal order matters and is part of the contract: completion is reported
 * ahead of the stacking check, because "this assessment is already finished" is
 * the one the admin can act on right now, while "another one is open" is not.
 *
 * `intake.complete` is compared with `=== true` rather than truthily. A caller
 * that hands over a Mongo document whose `complete` is the STRING "false" would
 * otherwise have every legitimate clinical flag refused as "already done".
 *
 * @param {{intake?: {total:number, taken:number, complete:boolean}, openId?: string|null}} [facts]
 * @returns {{ok: boolean, code?: string, message?: string, intake?: object, openId?: string}}
 */
function decideRaisePriority({ intake, openId } = {}) {
  if (intake && intake.complete === true) {
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

module.exports = {
  getTodayKey,
  EMPTY_INTAKE,
  summarizeIntakeDays,
  decideRaisePriority,
};
