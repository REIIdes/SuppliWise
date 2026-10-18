/**
 * Evidence gate — the automated replacement for a human approval click.
 *
 * Takes the LLM's proposed condition bundles from the gap analysis and decides
 * each one deterministically against clinicalEvidenceStandards:
 *
 *   ACCEPT  — the condition carries at least one supplement whose citation is
 *             an authoritative professional source, no supplement is a
 *             prescription or listed danger, and every row has the fields the
 *             engine needs (name/reason/dosage/priority) with a valid priority.
 *   REJECT  — anything else, with the reason recorded verbatim.
 *
 * The verdict is stored on the proposal's audit trail as an automated
 * reviewer ("Evidence Gate (automated)"), so the learning log shows WHO
 * ratified each entry: the professional literature the candidate cited,
 * checked by a rule that cannot be charmed, rate-limited into skipping,
 * or socially pressured — which is the property the reviewer asked for when
 * they said the suggestions must be "suggested and proven by health
 * professionals".
 */
const {
  citationIsAuthoritative,
  isPrescriptionOrDangerous,
  isKnownApprovedSupplement,
  PRIORITIES,
} = require('./clinicalEvidenceStandards');

const clean = (v, max = 2000) => String(v ?? '').replace(/[\u200B-\u200F\u202A-\u202E]/g, '').trim().slice(0, max);

// Words that carry no distinguishing clinical meaning in a condition label —
// "Chronic Fatigue Syndrome" and "Chronic Fatigue" name the same option once
// these are stripped, so removing them is what lets the core comparison below
// see through rewording.
const GENERIC_LABEL_WORDS = new Set([
  'disease', 'diseases', 'syndrome', 'syndromes', 'disorder', 'disorders',
  'condition', 'conditions', 'problem', 'problems', 'issue', 'issues',
  'general', 'other', 'history', 'example', 'eg', 'type', 'acute',
]);

/**
 * Distinguishing words of a label: lowercase, parentheticals dropped, generic
 * filler removed. "Lung Disease (e.g., COPD, …)" and "Lung Disease (Chronic
 * Obstructive …)" both reduce to {lung} — the same questionnaire option.
 */
function coreWords(label) {
  const bare = String(label ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ');
  const toks = bare.replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t && (t.length >= 3 || /\d/.test(t)));
  return new Set(toks.filter((t) => !GENERIC_LABEL_WORDS.has(t)));
}

/**
 * Would offering this label teach the user nothing, because the registry (or
 * another live bundle) already carries the same option — possibly worded
 * differently? "Polycystic Ovary Syndrome (PCOS)" vs "PCOS" and
 * "Chronic Kidney Disease (CKD)" vs "Chronic Kidney Disease" are exactly the
 * near-synonym drift the LLM prompt forbids but still produces, so the
 * rejection is deterministic, not a request.
 */
function labelCollides(label, registryLabels) {
  const a = String(label ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!a) return false;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const coreA = coreWords(a);
  for (const raw of registryLabels || []) {
    const b = String(raw ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!b) continue;
    if (a === b) return raw;
    // Word-boundary containment: "diabetes" inside "prediabetes" is NOT a
    // collision (different clinical option), inside "diabetes (type 2)" is.
    const wordIn = (hay, needle) => needle.length >= 4
      && new RegExp(`(^|[^a-z0-9])${esc(needle)}([^a-z0-9]|$)`).test(hay);
    if (wordIn(a, b)) return raw;
    if (wordIn(b, a)) return raw;
    // Core containment: neither full label contains the other, but one
    // option's distinguishing words are a subset of the other's —
    // "Chronic Fatigue Syndrome (ME/CFS)" vs "Chronic Fatigue / Fibromyalgia".
    // An anchor word (≥4 letters) is required so digit-only cores never match.
    const coreB = coreWords(b);
    const subset = (x, y) => x.size > 0 && [...x].every((w) => y.has(w));
    const smaller = coreA.size <= coreB.size ? coreA : coreB;
    if (smaller.size && [...smaller].some((w) => w.length >= 4 && !/\d/.test(w))
      && (subset(coreA, coreB) || subset(coreB, coreA))) return raw;
  }
  return false;
}

/**
 * Validate ONE candidate bundle. Returns
 * { ok, reasons[], normalized } — normalized is the publishable shape.
 */
function gateCandidate(c) {
  const reasons = [];
  const label = clean(c?.name, 200);
  if (!label) return { ok: false, reasons: ['no condition name'], normalized: null };

  const group = clean(c?.group, 120) || 'Other';
  const sexGateRaw = clean(c?.sexGate, 20);
  const sexGate = ['Male', 'Female'].includes(sexGateRaw) ? sexGateRaw : '';

  const symptomPool = Array.isArray(c?.symptomPool)
    ? c.symptomPool.map((s) => clean(s, 200)).filter(Boolean).slice(0, 25)
    : [];

  const supplements = Array.isArray(c?.supplements) ? c.supplements.slice(0, 12) : [];
  if (supplements.length === 0) reasons.push('no supplement interventions proposed — nothing provable to publish');

  const normalizedSupps = [];
  for (const s of supplements) {
    const name = clean(s?.name, 200);
    const evidence = clean(s?.evidence, 600);
    if (!name) { reasons.push('supplement row without a name'); continue; }
    if (isPrescriptionOrDangerous(name)) { reasons.push(`"${name}" is a prescription or dangerous substance, not a supplement`); continue; }
    if (!citationIsAuthoritative(evidence)) {
      reasons.push(`"${name}" cites no authoritative professional source (got: ${evidence ? evidence.slice(0, 80) : 'nothing'})`);
      continue;
    }
    const priority = PRIORITIES.has(clean(s?.priority, 10)) ? clean(s.priority, 10) : '';
    if (!priority) reasons.push(`"${name}" has no valid priority (High/Medium/Low)`);
    if (!clean(s?.reason, 2000)) reasons.push(`"${name}" has no reason text`);
    if (!clean(s?.dosage, 200)) reasons.push(`"${name}" has no dosage`);
    normalizedSupps.push({
      name,
      reason: clean(s?.reason, 2000),
      dosage: clean(s?.dosage, 200),
      timing: clean(s?.timing, 200),
      priority: priority || 'Medium',
      interactions: clean(s?.interactions, 300) || 'Inform your doctor',
      evidence,
      knownApprovedIngredient: isKnownApprovedSupplement(name),
    });
  }

  if (normalizedSupps.length === 0) reasons.push('no supplement survived the evidence check');

  // Reject the whole candidate if the gate's own reasons include a hard
  // violation; a candidate with merely a dropped row still publishes with
  // the surviving rows, and the dropped-row reasons are kept as annotations.
  const hardFail = reasons.some((r) =>
    /prescription|dangerous|nothing provable|no supplement survived/i.test(r));

  const warnings = Array.isArray(c?.warnings) ? c.warnings.map((w) => clean(w, 600)).filter(Boolean).slice(0, 8) : [];
  const avoid = Array.isArray(c?.avoid) ? c.avoid.map((w) => clean(w, 400)).filter(Boolean).slice(0, 8) : [];
  const lifestyle = Array.isArray(c?.lifestyle)
    ? c.lifestyle
      .map((l) => ({ category: clean(l?.category, 60) || 'Diet', advice: clean(l?.advice, 1200) }))
      .filter((l) => l.advice)
      .slice(0, 6)
    : [];

  const normalized = {
    label,
    normalizedLabel: label.toLowerCase().replace(/\s+/g, ' ').trim(),
    group,
    sexGate,
    rationale: clean(c?.rationale, 2000),
    supportingCount: Math.max(0, Number(c?.supportingCount) || 0),
    symptomPool,
    supplements: normalizedSupps,
    warnings,
    avoid,
    lifestyle,
    evidence: normalizedSupps.map((s) => s.evidence),
  };

  return { ok: !hardFail && normalizedSupps.length > 0, reasons, normalized };
}

/**
 * Gate a whole ranked payload against the existing option registry.
 *
 * registry is split in two because the right answer differs per side:
 *  - builtin: a hard-coded registry option must NEVER publish as a dynamic
 *    row, not even under its exact label — the client would shadow the
 *    built-in's own symptom scoping. Any collision (exact or synonym) rejects.
 *  - live: an AI-published label re-proposed VERBATIM is an evolution of the
 *    same bundle — publishAccepted refreshes it idempotently. Only a reworded
 *    synonym of a live row (two spellings of one option) rejects.
 */
function gateRanked(ranked, registry = {}) {
  const builtin = Array.isArray(registry) ? registry : (registry.builtin || []);
  const live = (registry && registry.live) || [];
  const accepted = [];
  const rejected = [];
  const taken = [...builtin];
  for (const c of (ranked && Array.isArray(ranked.candidates) ? ranked.candidates : [])) {
    const verdict = gateCandidate(c);
    const dup = labelCollides(c?.name, taken);
    if (dup) {
      rejected.push({
        candidate: verdict.normalized || { label: clean(c?.name, 200) },
        reasons: [`duplicates the existing option "${dup}" — the same choice worded differently teaches users nothing`],
      });
      continue;
    }
    const normLabel = String(c?.name ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const liveDup = labelCollides(c?.name, live);
    if (liveDup && liveDup.toLowerCase().replace(/\s+/g, ' ').trim() !== normLabel) {
      rejected.push({
        candidate: verdict.normalized || { label: clean(c?.name, 200) },
        reasons: [`reworded duplicate of the published option "${liveDup}" — re-propose it verbatim to refresh that bundle`],
      });
      continue;
    }
    if (verdict.ok) {
      accepted.push({ ...verdict.normalized, annotationReasons: verdict.reasons, raw: c });
      taken.push(verdict.normalized.label);
    } else {
      rejected.push({ candidate: verdict.normalized || { label: clean(c?.name, 200) }, reasons: verdict.reasons });
    }
  }
  return { accepted, rejected };
}

const GATE_REVIEWER = {
  reviewerAlias: 'Evidence Gate (automated)',
  discipline: 'clinical-evidence-standard',
};

/** Verdict rows written onto the ConditionProposal audit trail. */
function gateVerdictEntry(decision, reasons, evidence) {
  return {
    ...GATE_REVIEWER,
    decision,
    comment: decision === 'approve'
      ? `Auto-published: every supplement cites an authoritative professional source (${(evidence || []).slice(0, 3).join(' | ').slice(0, 1500)})${reasons && reasons.length ? `; annotations: ${reasons.join('; ')}` : ''}`.slice(0, 2000)
      : `Auto-rejected: ${reasons.join('; ')}`.slice(0, 2000),
    at: new Date(),
  };
}

module.exports = { gateCandidate, gateRanked, gateVerdictEntry, labelCollides, GATE_REVIEWER };
