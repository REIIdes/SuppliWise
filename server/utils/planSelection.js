/**
 * Deterministic supplement SELECTION — the layer that decides WHICH items a
 * plan contains, as opposed to how they are described.
 *
 * WHY THIS EXISTS
 * ---------------
 * The assess route asks a language model for the plan, and until now the model
 * chose the item set: the same answers submitted twice could return a plan with
 * Omega-3 and Ashwagandha in one run and Omega-3 and Berberine in the next,
 * because nothing outside the prompt decided membership. Prompt wording and a
 * low temperature reduce that; they cannot remove it, and claiming otherwise
 * would be false. So membership is decided here, in code.
 *
 * The decision rule is not a fixed list — a single set of supplements for every
 * member would be clinically wrong. It is the app's own rule engine
 * (`generateClinicalFallback` in routes/recommend.js), which is a pure function
 * of this member's answers: reported symptoms and their severity, conditions,
 * goals, diet, BMI, age band, pregnancy status, medications and allergens. Run
 * twice on the same answers it returns the same rows, in the same canonical
 * order. That output is the SPINE.
 *
 * The model's job is then the part a model is good at: writing the personalised
 * explanation for each row. `alignPlanToSpine` keeps the model's prose and
 * substitutes the spine's identity (name + priority tier) for every row,
 * matching model rows to spine rows first by the exact normalised name and then
 * by canonical nutrient class ("Magnesium Glycinate" ↔ "Magnesium Citrate" are
 * the same magnesium slot). A model row that maps to no slot is dropped — the
 * plan never grows items the rules did not justify — and a slot the model
 * skipped is filled from the spine's own curated copy.
 *
 * Net effect: identical answers produce an identical set of supplements, at
 * identical priority tiers, in identical order, every time, on any provider.
 * The wording of the descriptions can still vary run to run; what a member is
 * told to TAKE cannot.
 */

const { classifySupplement } = require('./planConsistency');
const crypto = require('crypto');

/** Normalised lookup key for a supplement name (form-insensitive, punctuation-free). */
function selectionKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9+]+/g, ' ')
    .trim();
}

/**
 * Rebuild a model plan so its membership is the rule engine's, not the model's.
 *
 * @param {object} plan   the parsed model reply (untouched; a new object is returned)
 * @param {Array}  spine  the rule engine's recommendations for the same answers
 * @returns {{ plan: object, audit: object }}
 */
function alignPlanToSpine(plan, spine) {
  const rows = Array.isArray(plan?.recommendations) ? plan.recommendations : [];
  const slots = (Array.isArray(spine) ? spine : []).filter((r) => r && typeof r.name === 'string' && r.name.trim());

  // Without a spine there is nothing to be deterministic against — say so in the
  // audit rather than silently claiming the plan was aligned.
  if (slots.length === 0) {
    return { plan, audit: { mode: 'unconstrained', slots: 0, modelRows: rows.length, exact: 0, byClass: 0, backfilled: 0, dropped: [] } };
  }

  // Model rows are consumed at most once, so two model rows can never collapse
  // into one slot (which would read as a duplicated supplement).
  const byExactKey = new Map();
  const byClass = new Map();
  for (const rec of rows) {
    const key = selectionKey(rec?.name);
    if (!key) continue;
    if (!byExactKey.has(key)) byExactKey.set(key, []);
    byExactKey.get(key).push(rec);
    const classId = classifySupplement(rec.name);
    if (classId) {
      if (!byClass.has(classId)) byClass.set(classId, []);
      byClass.get(classId).push(rec);
    }
  }
  const take = (bucket) => (bucket && bucket.length ? bucket.shift() : null);

  const usedKeys = new Set();
  const out = [];
  let exact = 0;
  let byClassMatch = 0;
  let backfilled = 0;

  for (const slot of slots) {
    const slotKey = selectionKey(slot.name);
    let fromModel = take(byExactKey.get(slotKey)) || take(byClass.get(classifySupplement(slot.name)));
    // A class match whose exact name was already taken is still a distinct
    // product (e.g. two magnesium rows); if that exact name is still free, use
    // it rather than spending the class row on the wrong slot.
    if (fromModel && usedKeys.has(selectionKey(fromModel.name))) fromModel = null;
    if (!fromModel) {
      out.push({ ...slot, selectionBackfilled: true });
      backfilled += 1;
      usedKeys.add(slotKey);
      continue;
    }
    const kind = selectionKey(fromModel.name) === slotKey ? 'exact' : 'class';
    if (kind === 'exact') exact += 1; else byClassMatch += 1;
    usedKeys.add(selectionKey(fromModel.name));
    // The spine owns the identity and the tier; the model owns everything the
    // member reads about it. `dosage` stays with the model and is clamped
    // against this name by planGrounding's dose check afterwards.
    out.push({
      ...fromModel,
      name: slot.name,
      priority: slot.priority || fromModel.priority,
      selectionSource: kind === 'exact' ? 'model+spine' : 'spine-class',
    });
  }

  const spineKeys = new Set(slots.map((s) => selectionKey(s.name)));
  const spineClasses = new Set(slots.map((s) => classifySupplement(s.name)).filter(Boolean));
  const dropped = rows
    .filter((r) => r && typeof r.name === 'string' && !spineKeys.has(selectionKey(r.name)) && !spineClasses.has(classifySupplement(r.name)))
    .map((r) => String(r.name).slice(0, 80));

  return {
    plan: { ...plan, recommendations: out },
    audit: { mode: 'spine', slots: slots.length, modelRows: rows.length, exact, byClass: byClassMatch, backfilled, dropped },
  };
}

/**
 * The [PLAN SPINE] block for the prompt. Telling the model the list is worth
 * more than correcting it afterwards — an aligned answer keeps its own reasoning
 * attached to the right item instead of having it re-hosted onto another row.
 * Names only: they are this app's own vocabulary, so nothing member-specific
 * leaves the server here.
 */
function spinePromptBlock(spine) {
  const slots = (Array.isArray(spine) ? spine : []).filter((r) => r && typeof r.name === 'string' && r.name.trim());
  if (!slots.length) return '';
  const lines = slots.map((r, i) => `${i + 1}. ${r.name}${r.priority ? ` — ${r.priority}` : ''}`);
  return `[PLAN SPINE — SELECTED BY THIS APP'S CLINICAL RULES FOR THIS PATIENT]
These ${slots.length} items and only these are the plan the app has selected from this patient's
reported answers. Write one recommendation for each, in exactly this order and with exactly these
names. Do not add, drop, rename or substitute an item: a name outside this list is deleted before
the patient sees the plan, and a missing item is replaced by the app's own text for it, which
loses the personalisation you were able to provide.
${lines.join('\n')}`;
}

/**
 * The shape the selection + grounding + ordering rules take as input. Anything
 * not listed here cannot change a plan, so it must not change the signature
 * either — an `assessmentId` or a timestamp in the payload would otherwise make
 * every resubmission look like new information.
 */
const VOLATILE_FIELDS = new Set([
  '_id', 'id', 'assessmentId', 'createdAt', 'updatedAt', '__v', 'aiResults',
  'result', 'results', 'plan', 'pdfUrl', 'shareId', 'token',
  'updatedFrom',  // Update Health Assessment tracking - doesn't affect clinical recommendations
]);

/** Version of the deterministic rules. Bump it to invalidate stored plans. */
const SELECTION_RULES_VERSION = 'spine-2-sorted';

/**
 * A stable digest of "the same health information", so a plan that was already
 * finalised for it can be reused instead of regenerated.
 *
 * Equivalent answers have to digest alike, which is what the reviewer's second
 * test case is about: trailing spaces, "fatigue" versus "Fatigue", and the order
 * ticks were clicked in are not new clinical information. So strings are
 * trimmed, case-folded and inner whitespace collapsed, and lists are sorted
 * before hashing.
 *
 * The hash is of the DIGEST only — never stored alongside the answers, and never
 * logged with any field value — so this cannot leak health data into a log.
 */
function answerSignature(payload, extras = {}) {
  const normalise = (value) => {
    if (Array.isArray(value)) return value.map(normalise).sort().join('|');
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      return Object.keys(value).sort().map((k) => `${k}=${normalise(value[k])}`).join(';');
    }
    return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
  };

  const fields = Object.keys(payload || {})
    .filter((k) => !VOLATILE_FIELDS.has(k))
    .sort()
    .map((k) => `${k}=${normalise(payload[k])}`);

  // An AI-published condition changes what the rules select, so the learned
  // catalogue is part of the identity of a plan: publishing one must invalidate
  // the stored answers that were generated before it existed.
  const learned = (Array.isArray(extras.liveDynamic) ? extras.liveDynamic : [])
    .map((d) => normalise(d?.name))
    .filter(Boolean)
    .sort()
    .join('|');

  return crypto
    .createHash('sha256')
    .update([SELECTION_RULES_VERSION, `learned=${learned}`, fields.join('&')].join('\n'))
    .digest('hex')
    .slice(0, 24);
}

/**
 * Shape check on the model's reply — the second half of "handle malformed or
 * incomplete AI responses". `routes/recommend.js` used to accept any object that
 * merely had a `recommendations` key, so a reply of `{recommendations: "n/a"}`,
 * a single nameless row, or a plan with no summary reached the member.
 *
 * Returns the rows that are usable (an object with a non-empty `name` string)
 * and lists what had to be repaired or taken from the rule engine. `ok` is false
 * only when nothing usable remains, which is the one case where the AI reply is
 * discarded entirely and the engine plan answers instead.
 */
function validateModelPlan(data) {
  const issues = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, usable: [], issues: ['reply was not a JSON object'] };
  }
  if (!Array.isArray(data.recommendations)) {
    return { ok: false, usable: [], issues: ['recommendations was not a list'] };
  }
  if (data.recommendations.length === 0) {
    return { ok: false, usable: [], issues: ['recommendations was empty'] };
  }
  const usable = data.recommendations.filter(
    (r) => r && typeof r === 'object' && typeof r.name === 'string' && r.name.trim().length > 1,
  );
  if (usable.length === 0) {
    return { ok: false, usable: [], issues: ['no row named a supplement'] };
  }
  if (usable.length < data.recommendations.length) {
    issues.push(`${data.recommendations.length - usable.length} row(s) without a usable supplement name were dropped`);
  }
  for (const field of ['summary', 'simplifiedSummary', 'wellnessBaseline', 'consultDoctor']) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      issues.push(`missing ${field}`);
    }
  }
  return { ok: true, usable, issues };
}

module.exports = {
  SELECTION_RULES_VERSION,
  selectionKey,
  answerSignature,
  alignPlanToSpine,
  spinePromptBlock,
  validateModelPlan,
};
