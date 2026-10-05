/**
 * Pre-filling the assessment's "Currently Taking Supplements?" question.
 *
 * Run: node --test src/utils/supplementPrefill.test.js
 *
 * THE FAILURE THIS GUARDS AGAINST
 * A returning user is already tracking a plan built from an earlier assessment.
 * Handing them a blank Yes/No for it means they either retype their whole
 * supplement list or answer from memory — and answering "No" (or listing three
 * of the eight pills) generates recommendations that contradict the plan they
 * are actually following. The question is a data-entry tax with a safety cost.
 *
 * THE RULES, and why each one is load-bearing:
 *
 *   1. ONLY UPGRADE AN UNANSWERED QUESTION TO "Yes". A restored draft that
 *      already says "No" is the user telling us they stopped. Overwriting it
 *      would silently undo their own correction on every page load — the one
 *      way this feature could actively lie to someone.
 *
 *   2. LIST THE SUPPLEMENTS, because "Yes" makes the free-text field REQUIRED.
 *      Auto-selecting "Yes" without filling it just moves the error to the next
 *      submit, which is a worse experience than no pre-fill at all.
 *
 *   3. NEVER INVENT A LIST. If detection found nothing to name, leave the
 *      question blank rather than answer "Yes" over an empty textarea.
 *
 * The decision is a pure function of (current form state, detection result), so
 * it can be pinned here instead of being asserted through a React render.
 */

/** Sentinels for "the question has not been answered yet". */
const UNANSWERED = ['', null, undefined];

/**
 * @param {object} current  The form's current `takingSupplements` value.
 * @param {object} detected The API response ({ takingSupplements, supplements }).
 * @returns {{takingSupplements?: string, currentSupplements?: string}} Fields to
 *   merge, or `{}` when nothing should change.
 */
export function prefillSupplements(current, detected) {
  // Detection failed, found nothing, or has not arrived yet. Do not guess.
  if (!detected?.takingSupplements) return {};

  // The user (or their restored draft) already answered. Never override it —
  // especially never override "No", which means "I have stopped".
  if (!UNANSWERED.includes(current)) return {};

  const list = Array.isArray(detected.supplements)
    ? detected.supplements.map((name) => (typeof name === 'string' ? name.trim() : '')).filter(Boolean)
    : [];

  // Nothing to list: answering "Yes" would force a required field we cannot fill.
  if (list.length === 0) return {};

  // De-duplicate while preserving the server's order, which is plan order.
  // Compared case-insensitively: "Zinc" and "zinc" are the same bottle, and the
  // AI is inconsistent about the casing between a schedule and a recommendation.
  const unique = [];
  const seen = new Set();
  for (const name of list) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(name);
  }

  return {
    takingSupplements: 'Yes',
    currentSupplements: unique.join(', '),
  };
}
