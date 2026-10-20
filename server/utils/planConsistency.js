/**
 * Deterministic plan shaping — the "output consistency" layer.
 *
 * WHY THIS EXISTS
 * ---------------
 * The model decides how many rows to write and the order it writes them in: the
 * same profile can return Omega-3 first, or Magnesium first, or something else
 * entirely on the next submission. Item order is part of the answer's quality,
 * and a research evaluation needs the SAME profile to produce the SAME
 * structure every time.
 *
 * So the order is decided HERE, in code, from a canonical nutrient taxonomy —
 * the same kind of table a clinical dietitian works from. The prompt still
 * asks the model to follow it (a told model writes a better answer than a
 * corrected one), but the guarantee is this module: whatever the model emits,
 * the member sees priority tiers first (High → Medium → Low) and, inside each
 * tier, supplements in canonical order (Omega-3 before Magnesium, Iron before
 * Calcium, and so on). Unknown names keep their relative order at the end.
 *
 * This module never adds, removes or rewrites a recommendation — only the
 * sequence. That keeps it safe to run on every plan, AI or rule-based.
 */

/**
 * Canonical nutrient classes, in the order a plan should present them.
 * First matching pattern wins, so specific forms come before generic ones
 * ("Magnesium Glycinate" must classify as magnesium, not as glycine).
 */
const CANONICAL_CLASSES = [
  { id: 'multivitamin', pattern: /multivitamin|multi-vitamin|prenatal|daily vitamin/i },
  { id: 'vitamin-d', pattern: /vitamin\s*d|cholecalciferol|ergocalciferol|\bd3\b|\bd2\b/i },
  { id: 'omega-3', pattern: /omega|fish\s*oil|\bdha\b|\bepa\b|algae\s*(oil|dha)/i },
  { id: 'magnesium', pattern: /magnesium/i },
  { id: 'iron', pattern: /\biron\b|ferrous|bisglycinate.*iron|iron.*bisglycinate/i },
  { id: 'calcium', pattern: /calcium/i },
  { id: 'zinc', pattern: /\bzinc\b/i },
  { id: 'selenium', pattern: /selenium/i },
  { id: 'iodine', pattern: /iodine|kelp/i },
  { id: 'b-vitamin', pattern: /vitamin\s*b|b\s*complex|b12|methylcobalamin|folate|folic|\bb6\b|\bb1\b|thiamine|riboflavin|biotin|pantothen/i },
  { id: 'vitamin-c', pattern: /vitamin\s*c|ascorbic/i },
  { id: 'vitamin-k', pattern: /vitamin\s*k|\bk2\b|\bk1\b/i },
  { id: 'vitamin-e', pattern: /vitamin\s*e|tocopherol/i },
  { id: 'vitamin-a', pattern: /vitamin\s*a\b|retinol|\bbeta-carotene\b/i },
  { id: 'probiotic', pattern: /probiotic|lactobacillus|bifido/i },
  { id: 'digestive-enzyme', pattern: /enzyme|bromelain|papain/i },
  { id: 'coq10', pattern: /coq10|co\s*enzyme\s*q|ubiquinol|ubiquinone/i },
  { id: 'curcumin', pattern: /curcumin|turmeric/i },
  { id: 'ashwagandha', pattern: /ashwagandha|ksm-66/i },
  { id: 'melatonin', pattern: /melatonin/i },
  { id: 'l-theanine', pattern: /theanine/i },
  { id: '5-htp', pattern: /5-?htp|tryptophan/i },
  { id: 'nac', pattern: /\bnac\b|n-acetyl/i },
  { id: 'ala', pattern: /alpha.?lipoic|\bala\b/i },
  { id: 'berberine', pattern: /berberine/i },
  { id: 'creatine', pattern: /creatine/i },
  { id: 'collagen', pattern: /collagen|gelatin/i },
  { id: 'amino-acid', pattern: /glycine|whey|protein|glutamine|citrulline|arginine|taurine|casein/i },
  { id: 'fiber', pattern: /fiber|fibre|psyllium|inulin/i },
  { id: 'electrolyte', pattern: /electrolyte|potassium|sodium|salt/i },
  { id: 'herbal-other', pattern: /rhodiola|ginseng|chamomile|valerian|peppermint|ginger|milk thistle|saw palmetto|echinacea|passionflower|lemon balm|holy basil/i },
];

/** Rank used for names the taxonomy does not recognise — pushed to the end. */
const UNKNOWN_RANK = CANONICAL_CLASSES.length;

/** Map a supplement name to its canonical class id, or null. */
function classifySupplement(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  for (const entry of CANONICAL_CLASSES) {
    if (entry.pattern.test(name)) return entry.id;
  }
  return null;
}

/** Canonical rank of a name (lower = earlier in a plan). */
function canonicalRank(name) {
  const id = classifySupplement(name);
  if (!id) return UNKNOWN_RANK;
  return CANONICAL_CLASSES.findIndex((entry) => entry.id === id);
}

const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };

/** Priority tier of a recommendation; anything unrecognised sits after Low. */
function priorityRank(rec) {
  const p = typeof rec?.priority === 'string' ? rec.priority.trim().toLowerCase() : '';
  const normalised = p === 'high' ? 'High' : p === 'medium' ? 'Medium' : p === 'low' ? 'Low' : null;
  return normalised ? PRIORITY_RANK[normalised] : 3;
}

/**
 * Order recommendations: priority tier first, then canonical nutrient class,
 * then the model's own order (Array#sort is stable, so unknowns and ties keep
 * their relative sequence).
 */
function orderRecommendations(recommendations) {
  if (!Array.isArray(recommendations)) return recommendations;
  return recommendations
    .map((rec, index) => ({ rec, index }))
    .sort((a, b) => (
      priorityRank(a.rec) - priorityRank(b.rec)
      || canonicalRank(a.rec?.name) - canonicalRank(b.rec?.name)
      || a.index - b.index
    ))
    .map(({ rec }) => rec);
}

const SCHEDULE_TIME_RANK = { morning: 0, 'with lunch': 1, lunch: 1, evening: 2, 'before bed': 3, night: 3 };

/**
 * Reorder a daily schedule: time blocks in day order, and the supplements
 * inside each block in canonical order. Same guarantee as the recommendation
 * list — a member on two plans sees the same schedule structure.
 */
function orderDailySchedule(dailySchedule) {
  if (!Array.isArray(dailySchedule)) return dailySchedule;
  return dailySchedule
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => (
      (SCHEDULE_TIME_RANK[String(a.slot?.time).toLowerCase()] ?? 9)
        - (SCHEDULE_TIME_RANK[String(b.slot?.time).toLowerCase()] ?? 9)
        || a.index - b.index
    ))
    .map(({ slot }) => (
      Array.isArray(slot?.supplements)
        ? { ...slot, supplements: [...slot.supplements].sort((x, y) => canonicalRank(x) - canonicalRank(y)) }
        : slot
    ));
}

/**
 * Apply every ordering rule to a plan in one pass. Returns a NEW plan object;
 * never mutates the caller's. Safe on partial plans (missing sections are
 * passed through untouched).
 */
function enforcePlanConsistency(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const out = { ...plan };
  if (Array.isArray(out.recommendations)) out.recommendations = orderRecommendations(out.recommendations);
  if (Array.isArray(out.dailySchedule)) out.dailySchedule = orderDailySchedule(out.dailySchedule);
  return out;
}

/**
 * True when the list already respects the canonical order. Used by the
 * benchmark to score how often the model obeys the rule it is told.
 */
function isCanonicalOrder(recommendations) {
  if (!Array.isArray(recommendations)) return true;
  let prevTier = -1;
  let prevRank = -1;
  for (const rec of recommendations) {
    const tier = priorityRank(rec);
    const rank = canonicalRank(rec?.name);
    if (tier < prevTier || (tier === prevTier && rank < prevRank)) return false;
    prevTier = tier;
    prevRank = rank;
  }
  return true;
}

/** One-line rendering of the taxonomy for the prompt's knowledge-base block. */
function canonicalOrderPromptLine() {
  return CANONICAL_CLASSES.map((entry) => entry.id.replace(/-/g, ' ')).join(' > ');
}

module.exports = {
  CANONICAL_CLASSES,
  classifySupplement,
  canonicalRank,
  priorityRank,
  orderRecommendations,
  orderDailySchedule,
  enforcePlanConsistency,
  isCanonicalOrder,
  canonicalOrderPromptLine,
};
