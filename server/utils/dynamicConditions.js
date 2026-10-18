/**
 * Live read path for AI-published conditions.
 *
 * recommend.js, the assessment options endpoint and the instrument registry
 * all need the same snapshot, so it is cached for 60 seconds — a condition the
 * gate publishes shows up within a minute, and the dashboard cannot make the
 * database do a read per recommendation.
 */
const DynamicCondition = require('../models/DynamicCondition');

const TTL_MS = 60 * 1000;
let cache = { at: 0, docs: [], loading: null };

async function getLiveConditions({ force = false } = {}) {
  const fresh = Date.now() - cache.at < TTL_MS;
  if (!force && fresh) return cache.docs;
  if (cache.loading) return cache.loading;
  cache.loading = DynamicCondition.find({ status: 'live' })
    .lean()
    .then((docs) => {
      cache = { at: Date.now(), docs, loading: null };
      return docs;
    })
    .catch((err) => {
      console.error('[dynamicConditions] live read failed:', err.message);
      cache = { at: Date.now(), docs: cache.docs, loading: null };
      return cache.docs;
    });
  return cache.loading;
}

function invalidateCache() {
  cache = { at: 0, docs: [], loading: null };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Merge the bundles for the conditions THIS member selected. Only exact
 * (normalized) label matches count — the form renders these labels verbatim.
 */
function mergeSelectedBundles(live, selectedLabels, gender) {
  const picked = new Set((selectedLabels || []).map(norm));
  const out = { recs: [], warnings: [], avoidList: [], lifestyleAdvice: [] };
  for (const d of live || []) {
    if (!picked.has(d.normalizedLabel)) continue;
    if (d.sexGate && gender && norm(gender) !== norm(d.sexGate)) continue;
    for (const s of d.supplements || []) {
      out.recs.push({
        name: s.name,
        reason: s.reason,
        dosage: s.dosage,
        timing: s.timing,
        priority: s.priority,
        interactions: s.interactions,
        evidence: s.evidence,
        triggeredBy: `${d.label} reported (AI-published, professionally cited evidence)`,
      });
    }
    out.warnings.push(...(d.warnings || []));
    out.avoidList.push(...(d.avoid || []));
    out.lifestyleAdvice.push(...(d.lifestyle || []));
  }
  return out;
}

/**
 * Prompt block for the AI path: every live condition with its interventions and
 * citations, so the LLM plans from the same professional-source knowledge the
 * rule engine uses — this is the "learnings" the system carries forward.
 */
function kbBlockForPrompt(live) {
  if (!live || live.length === 0) return '';
  const lines = live.map((d) => {
    const supps = (d.supplements || [])
      .map((s) => `  - ${s.name}: ${s.dosage} (${s.priority}) — evidence: ${s.evidence}`)
      .join('\n');
    return `- ${d.label}${d.sexGate ? ` [${d.sexGate} only]` : ''} (AI-published condition)\n${supps}`
      + (d.warnings?.length ? `\n  warnings: ${d.warnings.join(' / ')}` : '')
      + (d.avoid?.length ? `\n  avoid: ${d.avoid.join(' / ')}` : '');
  });
  return `9. LEARNED KNOWLEDGE BASE — conditions the system published from professionally cited evidence. When the patient reports one, its supplements are approved inclusions with the stated evidence:\n${lines.join('\n')}`;
}

module.exports = {
  getLiveConditions,
  invalidateCache,
  mergeSelectedBundles,
  kbBlockForPrompt,
  norm,
};
