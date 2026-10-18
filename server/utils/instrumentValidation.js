/**
 * Content-validity (expert) + statistical validation for the System Health
 * Assessment instrument.
 *
 * Two reviewer questions, two methods:
 *
 *  EXPERTS — Lawshe's Content Validity Ratio (Lawshe 1975, Personnel
 *  Psychology 28:563). Each panelist rates every item 1 (not relevant),
 *  2 (relevant but not essential) or 3 (essential). For an item,
 *      CVR = (Ne - N/2) / (N/2)
 *  where Ne = number rating "essential" and N = panel size. The minimum
 *  significant CVR at p<.05 is the Karpowski-corrected value 1.645/sqrt(N)
 *  (capped at 1.0), which reproduces Lawshe's Table 1 exactly
 *  (N=4 -> .82, N=5 -> .74, N=10 -> .52, N=20 -> .37). Scale-level:
 *  S-CVI/Ave = mean of the item CVRs (Lawshe) and S-CVI/UA = proportion of
 *  items meeting their threshold (Waltz et al. 2005).
 *
 *  STATISTICIANS — internal consistency of the 3-point severity ordinal
 *  scale and item-level behaviour, computed from real Assessment documents:
 *  Cronbach's alpha over the shared symptom matrix (Mild=1, Moderate=2,
 *  Severe=3, unendorsed=0), plus per-item endorsement rates and per-field
 *  completeness. The alpha math itself is the already-tested
 *  surveyStats.cronbachAlpha — these functions only shape the matrix.
 *
 * Pure functions over arrays — no database, no network — so every formula is
 * pinned by unit tests with independently computed values.
 */

const { cronbachAlpha, mean } = require('./surveyStats');
const { SEVERITY_ORDINAL } = require('./healthAssessmentInstrument');

/**
 * Lawshe CVR for one item.
 * @param {number} essentialCount - experts rating the item "essential" (3)
 * @param {number} panelSize - total experts rating the item
 * @returns {number|null} CVR in [-1, 1], or null when panelSize < 2
 */
function lawsheCvr(essentialCount, panelSize) {
  if (!Number.isFinite(essentialCount) || !Number.isFinite(panelSize)) return null;
  if (panelSize < 2) return null;
  if (essentialCount < 0 || essentialCount > panelSize) return null;
  const half = panelSize / 2;
  return (essentialCount - half) / half;
}

/**
 * Minimum significant CVR (p < .05) for a panel of `panelSize` experts.
 * Karpowski correction: 1.645 / sqrt(N), capped at 1.0 (N=2,3 -> 1.00/0.95).
 */
function cvrMinThreshold(panelSize) {
  if (!Number.isFinite(panelSize) || panelSize < 2) return null;
  return Math.min(1, 1.645 / Math.sqrt(panelSize));
}

/**
 * Full content-validity report from expert review rows.
 * @param {Array<{itemId: string, rating: number}>} ratings - flattened
 *   ratings across every review document (rating 1|2|3)
 * @param {string[]} itemIds - the instrument's item ids, in order
 * @returns {{panelSize:number, thresholds:string, items:Array, scviAve:number|null, scviUa:number|null, itemsMissingReview:string[]}}
 */
function contentValidityReport(ratings, itemIds) {
  const perItem = new Map();
  for (const id of itemIds) perItem.set(id, { essential: 0, total: 0 });

  // One rating per (reviewer, item) — a reviewer who submits twice only
  // counts once (latest wins), matching "one observation per participant".
  const seen = new Set();
  const reviewers = new Set();
  for (const r of ratings || []) {
    if (!perItem.has(r.itemId)) continue;
    const key = `${r.reviewer}|${r.itemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    reviewers.add(r.reviewer);
    const bucket = perItem.get(r.itemId);
    bucket.total += 1;
    if (Number(r.rating) === 3) bucket.essential += 1;
  }

  const N = reviewers.size;
  const threshold = N >= 2 ? cvrMinThreshold(N) : null;
  const items = [];
  for (const id of itemIds) {
    const b = perItem.get(id);
    const cvr = b.total > 0 ? lawsheCvr(b.essential, b.total) : null;
    items.push({
      itemId: id,
      reviewers: b.total,
      essentialCount: b.essential,
      icvi: b.total > 0 ? Math.round((b.essential / b.total) * 1000) / 1000 : null,
      cvr: cvr === null ? null : Math.round(cvr * 1000) / 1000,
      meetsThreshold: cvr !== null && threshold !== null ? cvr >= threshold : null,
    });
  }

  const computed = items.filter((i) => i.cvr !== null);
  const scviAve = computed.length
    ? Math.round(mean(computed.map((i) => i.cvr)) * 1000) / 1000
    : null;
  const scviUa = computed.length
    ? Math.round((computed.filter((i) => i.meetsThreshold).length / computed.length) * 1000) / 1000
    : null;

  return {
    panelSize: N,
    threshold: threshold === null ? null : Math.round(threshold * 1000) / 1000,
    thresholdNote: 'Lawshe CVR; minimum significant value at p<.05 is 1.645/sqrt(N).',
    items,
    scviAve,
    scviUa,
    itemsMissingReview: items.filter((i) => i.reviewers === 0).map((i) => i.itemId),
  };
}

/**
 * Severity ordinal matrix from real assessment documents.
 *
 * Columns = the `symptomOrder` symptoms (pass the most-rated ones). Rows =
 * assessments; each cell is Mild=1, Moderate=2, Severe=3 when that symptom
 * was endorsed with a severity, and 0 when it was not. Documented
 * convention: unendorsed means "absent at the lowest anchor", which keeps
 * the matrix rectangular without dropping respondents; it makes alpha a
 * measure of how coherently the severity construct loads across symptom
 * items.
 *
 * @param {Array<object>} docs - lean Assessment docs with symptomSeverity
 * @param {string[]} symptomOrder - column order (bare symptom names)
 */
function severityMatrix(docs, symptomOrder) {
  const rows = [];
  for (const d of docs || []) {
    const sev = d && d.symptomSeverity;
    if (!sev || typeof sev !== 'object' || Array.isArray(sev)) continue;
    const row = symptomOrder.map((name) => {
      let value = 0;
      for (const [key, severity] of Object.entries(sev)) {
        // Symptom keys may carry a "Category::" prefix; the bare name is the
        // part that identifies the symptom item.
        const bare = key.includes('::') ? key.slice(key.lastIndexOf('::') + 2) : key;
        if (bare !== name) continue;
        const ord = SEVERITY_ORDINAL[String(severity)];
        if (Number.isFinite(ord)) { value = ord; break; }
      }
      return value;
    });
    // Drop rows with nothing rated — an all-zero row is a non-response, not
    // a low-severity profile, and would bias alpha downward.
    if (row.some((v) => v > 0)) rows.push(row);
  }
  return rows;
}

/** Count severity ratings per bare symptom name across docs. */
function symptomRatingCounts(docs) {
  const counts = new Map();
  for (const d of docs || []) {
    const sev = d && d.symptomSeverity;
    if (!sev || typeof sev !== 'object' || Array.isArray(sev)) continue;
    for (const key of Object.keys(sev)) {
      const bare = key.includes('::') ? key.slice(key.lastIndexOf('::') + 2) : key;
      counts.set(bare, (counts.get(bare) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Statistical validation from real Assessment data.
 * @param {Array<object>} docs - lean Assessment docs
 * @param {object} spec - { fields: Array<{id,label,extract(doc):any}> } fields
 *   to measure completeness for
 * @param {{maxSymptoms?: number}} [opts]
 */
function statisticalValidationReport(docs, spec = {}, opts = {}) {
  const maxSymptoms = opts.maxSymptoms || 8;
  const list = docs || [];
  const counts = symptomRatingCounts(list);
  const symptomOrder = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSymptoms)
    .map(([name]) => name);

  const matrix = severityMatrix(list, symptomOrder);
  const alpha = cronbachAlpha(matrix);

  // Severity distribution across all rated cells (endorsement behaviour).
  const dist = { Mild: 0, Moderate: 0, Severe: 0 };
  let ratedCells = 0;
  for (const row of matrix) {
    for (const v of row) {
      if (v === 1) { dist.Mild += 1; ratedCells += 1; }
      else if (v === 2) { dist.Moderate += 1; ratedCells += 1; }
      else if (v === 3) { dist.Severe += 1; ratedCells += 1; }
    }
  }

  const completeness = (spec.fields || []).map((f) => {
    let answered = 0;
    for (const d of list) {
      const v = f.extract(d);
      const empty =
        v === null || v === undefined || v === '' ||
        (Array.isArray(v) && v.length === 0) ||
        (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0);
      if (!empty) answered += 1;
    }
    return {
      field: f.id,
      label: f.label,
      assessments: list.length,
      answered,
      completeness: list.length ? Math.round((answered / list.length) * 1000) / 1000 : null,
    };
  });

  return {
    assessments: list.length,
    severitySubscale: {
      symptoms: symptomOrder,
      symptomRatings: Object.fromEntries(symptomOrder.map((s) => [s, counts.get(s) || 0])),
      respondentsWithSeverity: matrix.length,
      alpha: Number.isFinite(alpha) ? Math.round(alpha * 1000) / 1000 : null,
      alphaNote: matrix.length >= 3 && symptomOrder.length >= 2
        ? 'Cronbach alpha over the shared severity matrix (Mild=1, Moderate=2, Severe=3, unendorsed=0). >= 0.70 accepted.'
        : 'Need at least 3 assessments rating at least 2 shared symptoms to compute alpha.',
      severityDistribution: dist,
      ratedCells,
    },
    completeness,
  };
}

module.exports = {
  lawsheCvr,
  cvrMinThreshold,
  contentValidityReport,
  severityMatrix,
  symptomRatingCounts,
  statisticalValidationReport,
};
