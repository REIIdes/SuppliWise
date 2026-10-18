/**
 * Statistics for validating the research questionnaires.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Ensure all questionnaires and metrics are standardized or validated by
 * experts and statisticians" is not satisfied by shipping a form — it needs
 * the reliability of each instrument to be COMPUTABLE from the responses the
 * product actually collects. This module provides the statistician's part:
 *
 *   mean / sampleStandardDeviation  — descriptive stats per item
 *   cronbachAlpha                   — internal consistency per instrument
 *     (a-coefficient over item scores; >= 0.70 is the accepted threshold for
 *     research instruments, >= 0.90 excellent)
 *   describeInstrument              — per-item mean, SD, and
 *     alpha-if-item-deleted, so a weak item can be identified and the
 *     instrument refined the way expert validation expects.
 *
 * Pure functions over number arrays — no database, no network — so the
 * formulas are pinned by unit tests with independently computed values.
 */

/** Arithmetic mean. */
function mean(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((s, x) => s + x, 0) / values.length;
}

/** Sample standard deviation (n-1 denominator). */
function sampleStandardDeviation(values) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1));
}

/**
 * Cronbach's alpha for a response matrix.
 *
 * @param {number[][]} responses rows = respondents, columns = items, all on
 *   the same Likert scale. Reverse-scored items must be reversed BEFORE
 *   calling (scoreInstrument() already does that for SUS).
 * @returns {number|null} alpha, or null when there is nothing to compute
 *   (fewer than 2 items or 3 respondents, or zero total variance).
 */
function cronbachAlpha(responses) {
  if (!Array.isArray(responses)) return null;
  const rows = responses.filter((r) => Array.isArray(r) && r.length > 0);
  if (rows.length < 3) return null;
  const k = rows[0].length;
  if (k < 2 || rows.some((r) => r.length !== k)) return null;
  if (rows.some((r) => r.some((v) => !Number.isFinite(v)))) return null;

  const itemVariances = [];
  for (let j = 0; j < k; j += 1) {
    itemVariances.push(variance(rows.map((r) => r[j])));
  }
  const totals = rows.map((r) => r.reduce((s, x) => s + x, 0));
  const totalVariance = variance(totals);
  if (!Number.isFinite(totalVariance) || totalVariance === 0) return null;
  const sumItem = itemVariances.reduce((s, x) => s + x, 0);
  return (k / (k - 1)) * (1 - sumItem / totalVariance);
}

/** Population-corrected (sample, n-1) variance. */
function variance(values) {
  const m = mean(values);
  return values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1);
}

/**
 * Cronbach's alpha computed after dropping each item in turn — the standard
 * diagnostic for finding the item that hurts internal consistency.
 */
function alphaIfItemDeleted(responses) {
  const k = responses[0]?.length || 0;
  const out = [];
  for (let drop = 0; drop < k; drop += 1) {
    const reduced = responses.map((r) => r.filter((_, j) => j !== drop));
    out.push(cronbachAlpha(reduced));
  }
  return out;
}

/**
 * Full descriptive report for one instrument's collected responses.
 * `responses` is the raw matrix (respondents x items).
 */
function describeInstrument(responses) {
  const k = responses[0]?.length || 0;
  return {
    respondents: responses.length,
    items: k,
    alpha: round(cronbachAlpha(responses)),
    perItem: Array.from({ length: k }, (_, j) => ({
      item: j + 1,
      mean: round(mean(responses.map((r) => r[j]))),
      sd: round(sampleStandardDeviation(responses.map((r) => r[j]))),
      alphaIfDeleted: round(alphaIfItemDeleted(responses)[j]),
    })),
  };
}

const round = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);

module.exports = {
  mean,
  sampleStandardDeviation,
  cronbachAlpha,
  alphaIfItemDeleted,
  describeInstrument,
};
