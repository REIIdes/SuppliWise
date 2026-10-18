/**
 * Live AI-published conditions — client merge layer for the assessment form.
 *
 * The server's evidence gate publishes conditions into DynamicCondition and
 * GET /api/instrument/live-extensions hands members the curated view
 * { label, group, sexGate, rationale, symptomPool, evidence[{name,citation}] }.
 * This module folds those into the form's hard-coded structures WITHOUT
 * touching them: if the fetch fails the form is exactly the built-in
 * questionnaire, and every merge here is a pure additive layer.
 */

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

const byLabel = (live, condition) =>
  (live || []).find((d) => norm(d.label) === norm(condition)) || null;

/**
 * Add published labels to the hard-coded condition groups.
 * - labels already present anywhere (case/whitespace-insensitive) are skipped;
 * - sexGate 'Male'/'Female' only shows for a matching gender answer ('' shows always);
 * - a published group the form does not have yet is appended as its own
 *   section, so the AI's grouping survives instead of dumping into Other.
 */
export function mergeConditionGroups(groups, live, gender) {
  if (!Array.isArray(live) || live.length === 0) return groups;
  const out = (groups || []).map((g) => ({ ...g, items: [...(g.items || [])] }));
  const byGroup = new Map(out.map((g) => [g.group, g]));
  const seen = new Set(out.flatMap((g) => g.items).map(norm));
  for (const d of live) {
    if (!d || !d.label) continue;
    if (d.sexGate && gender && d.sexGate !== gender) continue;
    if (seen.has(norm(d.label))) continue;
    let target = byGroup.get(d.group);
    if (!target) {
      target = { group: d.group || 'Other', items: [] };
      out.push(target);
      byGroup.set(target.group, target);
    }
    target.items.push(d.label);
    seen.add(norm(d.label));
  }
  return out;
}

/**
 * Symptom rows for a selected condition: the live bundle's own pool when the
 * condition is AI-published, null when it is not (caller keeps the
 * hard-coded ALL_SYMPTOMS path). Returned shape matches ALL_SYMPTOMS rows so
 * the renderer is unchanged.
 */
export function dynamicSymptomsFor(live, condition) {
  const d = byLabel(live, condition);
  return d ? (d.symptomPool || []).map((name) => ({ name })) : null;
}

/** Tooltip text for an AI-published condition; null for built-ins. */
export function dynamicTooltip(live, condition) {
  const d = byLabel(live, condition);
  if (!d) return null;
  const cites = (d.evidence || [])
    .filter((e) => e && e.name)
    .map((e) => `${e.name}: ${e.citation || 'professionally cited source'}`)
    .join(' · ');
  return `${d.rationale || ''}${cites ? ` Proven by health-professional sources — ${cites}.` : ' AI-published on professionally cited evidence.'}`.trim();
}

/**
 * Update-mode repair: symptoms saved before the live bundle arrived may still
 * be plain names that belong to a selected AI-published condition's pool.
 * Prefix them (and move their severity keys) to the `${condition}::${name}`
 * form the form uses. Pure + idempotent — already-prefixed rows are untouched.
 */
export function prefixDynamicSymptoms(formData, live) {
  if (!live || live.length === 0 || !formData) return formData;
  const conditions = (formData.medicalConditions || []).filter((c) => c !== 'None');
  const symptoms = formData.symptoms || [];
  const severity = formData.symptomSeverity || {};
  const next = [];
  const nextSeverity = { ...severity };
  let changed = false;
  for (const s of symptoms) {
    if (s.includes('::') || s === 'No current symptoms') { next.push(s); continue; }
    const owner = conditions.find((c) => {
      const d = byLabel(live, c);
      return d && (d.symptomPool || []).some((p) => norm(p) === norm(s));
    });
    if (!owner) { next.push(s); continue; }
    const fullKey = `${owner}::${s}`;
    if (!next.includes(fullKey)) {
      next.push(fullKey);
      if (severity[s] && !severity[fullKey]) {
        nextSeverity[fullKey] = severity[s];
        delete nextSeverity[s];
      }
      changed = true;
    }
  }
  if (!changed) return formData;
  return { ...formData, symptoms: next, symptomSeverity: nextSeverity };
}
