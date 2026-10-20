/**
 * The member's own record, read back into the plan they are about to be given.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every plan this app generates used to be generated from one assessment in
 * isolation: the answers typed a minute ago and nothing else. That is the
 * behaviour of a form-filler, not of an assistant, and it produced three visibly
 * wrong experiences:
 *
 *   1. A member who retook the questionnaire after six weeks got a plan with no
 *      mention of the six weeks — no acknowledgment that fatigue was reported
 *      last time and is gone now, or that it is still there.
 *   2. A member who follows the plan imperfectly got the same plan again, with
 *      the same four-a-day schedule, as though tracking were decorative.
 *   3. A member who double-submits the same answers (a retry, a back-button
 *      resubmit) and a member whose symptoms genuinely did not change looked
 *      identical to the code — and the second is the one that matters.
 *
 * So this reads the previous plan, the symptom delta and the member's own
 * adherence, hands all three to the prompt as data the server owns, and records
 * what the plan did with them in `plan.adaptation`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never demotes anything. Low adherence does not reduce a recommendation: a
 * member who cannot take four supplements a day still needs the one that covers
 * a reported deficiency, and quietly dropping it because they were busy is the
 * kind of automation that gets people hurt. The only automatic change is an
 * ESCALATION — a symptom reported for the first time is the most clinically
 * interesting thing in the assessment, so the rows it triggers are raised to
 * High priority (see `applyAdaptation`). Everything else is shown to the model
 * and to the member, and decided by them or by their clinician.
 *
 * IT ALSO CANNOT BREAK A PLAN
 * ---------------------------
 * Every query here is optional. A member with no history, a timeout, or a
 * database that will not answer gets `block: null` and today's plan unchanged —
 * the same shape as before this file existed. An adaptation that is unavailable
 * must cost a member nothing but the nicety, never their results.
 */
'use strict';

const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const { recentPlanDayKeys } = require('./planDay');
const {
  cleanTimeZone, localMinutesOfDay, slotKeyForRecord, windowStateForSlot, WINDOW_STATE,
} = require('./intakeWindows');
const { neutralize, fenceData } = require('./aiGuardrails');

/** How many previous assessments the model is shown. More is noise, not context. */
const HISTORY_LIMIT = 3;

/**
 * A resubmit of identical answers inside this window is the same assessment
 * twice, not a member who retook the questionnaire. Five minutes is longer than
 * a retry and shorter than any real re-assessment.
 */
const RESUBMIT_WINDOW_MS = 5 * 60 * 1000;

/** Days of tracking that go into the adherence figure the plan is told about. */
const ADHERENCE_DAYS = 14;

/** The fields that ARE the answers. Anything else on the document is bookkeeping. */
const ANSWER_FIELDS = [
  'age', 'gender', 'weight', 'height', 'activityLevel', 'dietType', 'healthGoals',
  'symptoms', 'symptomSeverity', 'stressLevel', 'sleepQuality', 'waterIntake',
  'medicalConditions', 'currentMedications', 'allergies', 'feelingDescription',
  'lifestyleHabits', 'pregnancyStatus', 'takingSupplements', 'currentSupplements',
  'recentBloodTest', 'bloodTestResults', 'sunExposure', 'fitnessFocus',
  'proteinIntake', 'recreationalDrugTypes',
];

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * A stable string of everything the member answered, so two assessments can be
 * compared for "same answers" without comparing documents.
 *
 * Lists are sorted and de-duplicated because the questionnaire does not promise
 * an order: selecting Fatigue then Headache is the same answer as Headache then
 * Fatigue, and an unordered comparison is what makes a double-submit detectable.
 */
function canonicalAnswers(source = {}) {
  const parts = [];
  for (const field of ANSWER_FIELDS) {
    const value = source[field];
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    if (field === 'symptomSeverity' && value && typeof value === 'object') {
      parts.push(`${field}=${Object.keys(value).sort().map((k) => `${norm(k)}:${norm(value[k])}`).join('|')}`);
    } else if (Array.isArray(value)) {
      parts.push(`${field}=${[...new Set(value.map(norm))].sort().join('|')}`);
    } else if (typeof value === 'object') {
      parts.push(`${field}=${JSON.stringify(value)}`);
    } else {
      parts.push(`${field}=${norm(value)}`);
    }
  }
  return parts.join(';');
}

/** The previous plan's rows, in the shape the adaptation layer compares on. */
function planRows(assessment) {
  const recs = assessment?.aiResults?.recommendations;
  if (!Array.isArray(recs)) return [];
  return recs
    .map((r) => ({ name: String(r?.name || '').trim(), priority: String(r?.priority || '').trim() }))
    .filter((r) => r.name);
}

/**
 * Which stored assessments count as history for this submission.
 *
 * The newest document is normally the one just saved by this very submission, so
 * it is dropped when it is a resubmit of identical answers inside
 * `RESUBMIT_WINDOW_MS`. The window is what makes the two cases separable: an
 * identical answer set recorded yesterday IS history (the member retook the
 * questionnaire and nothing changed — the plan must know that), while the same
 * answers recorded ninety seconds ago are the same assessment twice.
 *
 * Rows with no answers at all (a draft, a partial autosave) are never history:
 * comparing against a half-filled form would report symptoms as "resolved" that
 * were simply never asked.
 */
function selectHistory(rows, incoming = {}, { now = new Date(), limit = HISTORY_LIMIT } = {}) {
  const incomingCanonical = canonicalAnswers(incoming);
  const then = now instanceof Date ? now : new Date(now);
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.createdAt) continue;
    const created = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    if (Number.isNaN(created.getTime()) || created > then) continue;
    const canonical = canonicalAnswers(row);
    if (!canonical) continue;
    const isResubmit = canonical === incomingCanonical
      && (then.getTime() - created.getTime()) < RESUBMIT_WINDOW_MS;
    if (isResubmit) continue;
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Symptoms and conditions reported now that were not reported before, and the
 * reverse. Compared on the questionnaire's own labels, normalised.
 *
 * Only the NEWEST previous assessment is used. "Newly reported" means new
 * against the plan the member is currently holding — against three plans ago it
 * could have been reported for weeks.
 */
function symptomDelta(previous, incoming = {}) {
  const labels = (source) => new Set([
    ...(Array.isArray(source?.symptoms) ? source.symptoms : []),
    ...(Array.isArray(source?.medicalConditions) ? source.medicalConditions : []),
  ].map(norm).filter(Boolean));

  if (!previous) return { newlyReported: [], resolved: [], hasBaseline: false };

  const before = labels(previous);
  const now = labels(incoming);
  return {
    hasBaseline: true,
    newlyReported: [...now].filter((l) => !before.has(l)),
    resolved: [...before].filter((l) => !now.has(l)),
  };
}

/**
 * How the member actually followed their plan, from their own tracking rows.
 *
 * The window is plan days, not UTC days, and today counts only for the slots
 * whose window has already closed. A member assessed at 09:00 has an evening
 * dose still ahead of them, and scoring it as missed would tell the next plan
 * they skip their supplements when they have simply not reached that part of
 * their day yet — the same in-flight rule the wellness score already applies.
 *
 * @returns {{percent: number|null, days: number, taken: number, total: number,
 *            perSupplement: Array<{name: string, taken: number, total: number}>}}
 */
function summariseAdherence(records, { now = new Date(), timeZone = '' } = {}) {
  const zone = cleanTimeZone(timeZone) ? timeZone : '';
  const minutes = localMinutesOfDay(now, zone);
  const todayKey = recentPlanDayKeys(1, now, zone)[0] || '';
  const per = new Map();
  let taken = 0;
  let total = 0;
  const days = new Set();

  for (const record of Array.isArray(records) ? records : []) {
    const dayKey = String(record?.dayKey || '');
    if (!dayKey || dayKey > todayKey) continue;
    // Today, in-flight: a dose whose window has not closed is not a missed dose.
    if (dayKey === todayKey) {
      if (!Number.isFinite(minutes)) continue;
      const state = windowStateForSlot(slotKeyForRecord(record), minutes);
      if (state !== WINDOW_STATE.CLOSED) continue;
    }
    const name = norm(record?.supplementName);
    if (!name) continue;
    total += 1;
    if (record?.taken === true) taken += 1;
    days.add(dayKey);
    const bucket = per.get(name) || { name: String(record.supplementName).trim(), taken: 0, total: 0 };
    bucket.total += 1;
    if (record?.taken === true) bucket.taken += 1;
    per.set(name, bucket);
  }

  if (!total) return { percent: null, days: 0, taken: 0, total: 0, perSupplement: [] };
  return {
    percent: Math.round((taken / total) * 100),
    days: days.size,
    taken,
    total,
    perSupplement: [...per.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
  };
}

/**
 * The fenced block the prompt is given.
 *
 * Server-owned data, but it still carries stored free text (a supplement name
 * the model wrote six weeks ago, a symptom label), so it is neutralised and
 * fenced exactly like the untrusted fields — a stored string must never be able
 * to become an instruction. It is labelled as reference, and the instruction
 * half lives in `assessmentPrompt`, not here.
 */
function buildHistoryBlock({ previous, history, delta, adherence }) {
  if (!previous && !history.length) return null;
  const lines = [];

  if (previous) {
    lines.push(`Previous assessment date: ${new Date(previous.createdAt).toISOString().slice(0, 10)}`);
    const names = planRows(previous).map((r) => (r.priority ? `${r.name} (${r.priority})` : r.name));
    if (names.length) lines.push(`Recommendations in the plan they are holding: ${names.join('; ')}`);
  }
  if (history.length > 1) {
    lines.push(`Older assessments on record: ${history.length - 1}`);
  }
  if (delta.hasBaseline) {
    lines.push(`Reported now, not reported then: ${delta.newlyReported.length ? delta.newlyReported.join(', ') : 'nothing'}`);
    lines.push(`Reported then, not reported now: ${delta.resolved.length ? delta.resolved.join(', ') : 'nothing'}`);
  }
  if (adherence.percent !== null) {
    lines.push(`Plan-following over the last ${adherence.days} tracked day(s): ${adherence.percent}% of scheduled doses marked taken (${adherence.taken}/${adherence.total}).`);
    const worst = adherence.perSupplement
      .filter((s) => s.total >= 3)
      .map((s) => ({ ...s, rate: s.taken / s.total }))
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 3);
    if (worst.length) {
      lines.push(`Least-taken items: ${worst.map((s) => `${s.name} ${Math.round(s.rate * 100)}%`).join('; ')}.`);
    }
  }
  if (lines.length === 0) return null;
  return fenceData('MEMBER HISTORY', lines.map((l) => neutralize(l, { maxLength: 800 })).join('\n'));
}

/**
 * Everything the route needs, in one call that cannot fail the request.
 *
 * Two queries, both projection-limited: the assessment projection takes the
 * answer fields and only the name/priority of each stored recommendation — a
 * full `aiResults` document is hundreds of kilobytes and taking three of them to
 * read eight names would make the plan slower than it is worth.
 */
async function loadMemberHistory(userId, incoming = {}, { timeZone = '', now = new Date() } = {}) {
  const empty = { block: null, previous: null, history: [], delta: symptomDelta(null, incoming), adherence: { percent: null, days: 0, taken: 0, total: 0, perSupplement: [] } };
  if (!userId) return empty;

  const rows = await Assessment.find({ user: userId })
    .sort({ createdAt: -1 })
    .limit(HISTORY_LIMIT + 1)
    // Every answer field, because a resubmit is detected by comparing canonical
    // answers and a row missing `dietType` can never match the submission it came
    // from. What is deliberately NOT taken is the rest of `aiResults` — a stored
    // plan is hundreds of kilobytes of reasons and evidence, and this needs the
    // name and priority of each row.
    .select(`${ANSWER_FIELDS.join(' ')} createdAt aiResults.recommendations.name aiResults.recommendations.priority`)
    .lean();

  const history = selectHistory(rows, incoming, { now });
  const previous = history[0] || null;
  const delta = symptomDelta(previous, incoming);

  const dayKeys = recentPlanDayKeys(ADHERENCE_DAYS, now, timeZone);
  let adherence = { percent: null, days: 0, taken: 0, total: 0, perSupplement: [] };
  if (dayKeys.length) {
    const records = await IntakeRecord.find({ user: userId, dayKey: { $in: dayKeys } })
      .select('supplementName taken dayKey timeSlot scheduledTime')
      .lean();
    adherence = summariseAdherence(records, { now, timeZone });
  }

  return {
    block: buildHistoryBlock({ previous, history, delta, adherence }),
    previous,
    history,
    delta,
    adherence,
  };
}

/**
 * The deterministic half of adapting: raise what is newly reported, and write
 * down what the plan did.
 *
 * Escalation is the only automatic edit, and it is one-directional — a row
 * triggered by a symptom this member has never reported before is the single
 * most decision-relevant item in the plan, and it must not be sitting in
 * "optional" because a model or a rule felt it was mild. Nothing is ever
 * demoted, reordered by adherence, or dropped: see the header.
 *
 * `adaptation` is recorded on the plan so the member, the history view and the
 * benchmark can all see that the plan changed and why, rather than being handed
 * a different plan and left to diff it themselves.
 *
 * @param {object} plan        a grounded plan (rows already verified)
 * @param {object} member      what `loadMemberHistory` returned
 * @returns {object} the plan, with `adaptation` attached
 */
function applyAdaptation(plan, member = {}) {
  if (!plan || typeof plan !== 'object') return plan;
  const delta = member.delta || symptomDelta(null, {});
  const previousNames = member.previous ? planRows(member.previous).map((r) => norm(r.name)) : [];

  const terms = (label) => norm(label).split(/[^a-z0-9'+-]+/).filter((w) => w.length >= 5);
  const newTerms = [...new Set((delta.newlyReported || []).flatMap(terms))];
  const escalated = [];

  if (Array.isArray(plan.recommendations) && newTerms.length) {
    for (const rec of plan.recommendations) {
      const haystack = `${norm(rec?.triggeredBy)} ${norm(rec?.reason)}`;
      if (String(rec?.priority || '').toLowerCase() === 'high') continue;
      if (!newTerms.some((t) => haystack.includes(t))) continue;
      rec.priority = 'High';
      escalated.push(String(rec.name || '').trim());
    }
  }

  const currentNames = (Array.isArray(plan.recommendations) ? plan.recommendations : []).map((r) => norm(r?.name));
  plan.adaptation = {
    previousAssessmentAt: member.previous?.createdAt
      ? new Date(member.previous.createdAt).toISOString() : null,
    previousPlanSize: previousNames.length,
    itemsCarried: currentNames.filter((n) => previousNames.includes(n)).length,
    itemsNew: currentNames.filter((n) => n && !previousNames.includes(n)).length,
    itemsDropped: previousNames.filter((n) => !currentNames.includes(n)).length,
    adherencePercent: member.adherence?.percent ?? null,
    adherenceDays: member.adherence?.days ?? 0,
    symptomsNew: delta.newlyReported || [],
    symptomsResolved: delta.resolved || [],
    escalated,
  };
  return plan;
}

module.exports = {
  HISTORY_LIMIT,
  RESUBMIT_WINDOW_MS,
  ADHERENCE_DAYS,
  canonicalAnswers,
  planRows,
  selectHistory,
  symptomDelta,
  summariseAdherence,
  buildHistoryBlock,
  loadMemberHistory,
  applyAdaptation,
};
