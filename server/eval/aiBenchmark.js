/**
 * AI accuracy benchmark.
 *
 * WHAT THIS MEASURES
 * ------------------
 * The LLM's plan output against the rule-based clinical engine's output (the
 * BASELINE — hand-authored clinical logic that never varies), using the
 * numerical metrics in utils/planEvaluation.js:
 *
 *   schemaValidity / orderCompliance / catalogAdherence   (structure, 50%)
 *   dietCompliance / allergenCompliance                   (safety, 30%)
 *   citationValidity / personalization / severityCarry    (quality, 20%)
 *   itemOverlap (Jaccard) + orderAgreement (Kendall tau)  (vs baseline)
 *
 * MODES
 * -----
 *   node eval/aiBenchmark.js            OFFLINE — scores the baseline plans
 *       themselves. No keys, no network, deterministic. This is what CI runs
 *       and what produces the reference numbers every live run is compared to.
 *   node eval/aiBenchmark.js --live     LIVE — sends each baseline profile
 *       through the real assessment prompt + provider chain (same call the
 *       product makes), scores each reply, and compares it to the baseline.
 *       --runs=N repeats each profile (default 2) so run-to-run CONSISTENCY
 *       (plan overlap and order agreement between repeats) is measured too.
 *
 * Exit code is non-zero when the numbers fall below the thresholds, so this
 * is a gate, not just a report.
 */

require('../utils/envFile').reloadFromDisk();

const { generateClinicalFallback } = require('../routes/recommend');
const { buildAssessmentPrompt, ASSESSMENT_SYSTEM_PROMPT } = require('../utils/assessmentPrompt');
const { enforcePlanConsistency } = require('../utils/planConsistency');
const { scorePlan, comparePlans, priorityDistribution } = require('../utils/planEvaluation');
const { completeWithFallback } = require('../utils/aiRouter');
const { groundPlan, groundingViolations } = require('../utils/planGrounding');
// The hand-written profiles, plus the ones shaped by the project's pharmacy interview
// (an older member on maintenance antihypertensives, asking about branded supplements).
// Both are synthetic and both go through the same gates — the second set exists because
// an accuracy number measured only on situations the authors imagined is a number about
// the authors. See eval/field-study-profiles.json for the provenance of each.
const profiles = [...require('./baseline-profiles.json'), ...require('./field-study-profiles.json')];

const args = process.argv.slice(2);
const LIVE = args.includes('--live');
const RUNS = Math.max(1, Number((args.find((a) => a.startsWith('--runs=')) || '').split('=')[1]) || 2);

// Thresholds a submission must clear for the run to pass. Structure is
// non-negotiable (the consistency gate makes order 100% by construction);
// safety must never regress; overlap with the clinical baseline is the
// accuracy signal.
const THRESHOLDS = {
  schemaValidity: 0.95,
  orderCompliance: 1,
  catalogAdherence: 0.8,
  dietCompliance: 0.95,
  allergenCompliance: 1,
  // Post-gate grounding. These are what the member is actually shown, so a
  // breach here means the verifier leaked — not that the model behaved.
  citationGroundingRate: 1,
  dosageSafetyRate: 1,
  patientFactGroundingRate: 0.95,
  overall: 70,
};

const pct = (v) => `${(v * 100).toFixed(1)}%`;
const METRIC_KEYS = [
  'schemaValidity', 'orderCompliance', 'catalogAdherence', 'dietCompliance',
  'allergenCompliance', 'citationValidity', 'personalizationRate', 'severityCarryRate',
  'citationGroundingRate', 'patientFactGroundingRate', 'dosageSafetyRate',
];
const metricValue = (score, key) => score.metrics[key].value;

function printRow(label, score, comparison) {
  const cells = METRIC_KEYS.map((k) => pct(metricValue(score, k)));
  const cmp = comparison
    ? `overlap=${comparison.itemOverlap} tau=${comparison.orderAgreement}`
    : '';
  console.log(
    `  ${label.padEnd(34)} ${cells.join(' ')} overall=${String(score.overall).padStart(5)} ${cmp}`,
  );
}

function printHeader() {
  console.log(`  ${'profile'.padEnd(34)} ${METRIC_KEYS.map((k) => k.slice(0, 9).padEnd(10)).join(' ')} overall`);
}

async function runBaseline() {
  console.log('\n=== BASELINE (rule-based clinical engine, offline, deterministic) ===\n');
  printHeader();
  const rows = [];
  for (const profile of profiles) {
    // Scored through the same gates the route applies, so "baseline" means the
    // deployed answer, not the engine's raw output.
    const plan = groundPlan(enforcePlanConsistency(generateClinicalFallback(profile)), profile);
    const score = scorePlan(plan, profile);
    rows.push({ profile, plan, score });
    printRow(`${profile.id} [baseline]`, score, null);
    console.log(`      priorities: ${JSON.stringify(priorityDistribution(plan))}`);
  }
  return rows;
}

async function runLive(baselineRows) {
  console.log(`\n=== LIVE (assessment prompt via provider chain, ${RUNS} run(s) per profile) ===\n`);
  printHeader();
  const failures = [];
  const liveScores = [];

  for (const row of baselineRows) {
    const prompt = buildAssessmentPrompt(row.profile);
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) {
      const started = Date.now();
      const result = await completeWithFallback('assessment', {
        system: ASSESSMENT_SYSTEM_PROMPT,
        user: prompt,
        maxTokens: 16000,
        temperature: 0.2, // same as the product route — the benchmark must
        timeoutMs: 180000, // measure the system as deployed, not as configured
        json: true,
        extraBody: (target) => (target.provider === 'openrouter'
          ? { reasoning: { effort: 'none' } }
          : null),
      });
      const latencyMs = Date.now() - started;
      if (!result.ok || !result.data || !Array.isArray(result.data.recommendations)) {
        console.log(`  ${row.profile.id} run${i + 1}: NO USABLE REPLY (${result.error || 'empty'}) via ${result.provider}`);
        failures.push(`${row.profile.id} run${i + 1}: provider failure`);
        continue;
      }
      const raw = enforcePlanConsistency(result.data);
      // BEFORE/AFTER the gate, on the same reply: the raw score is how often the
      // model hallucinated, the scored plan is what the member would be shown.
      const violations = groundingViolations(raw, row.profile);
      const plan = enforcePlanConsistency(groundPlan(raw, row.profile, { trustedRecs: row.plan.recommendations }));
      const score = scorePlan(plan, row.profile);
      const rawScore = scorePlan(raw, row.profile);
      const comparison = comparePlans(plan, row.plan);
      runs.push({ plan, score, comparison });
      printRow(`${row.profile.id} run${i + 1} [${result.provider}]`, score, comparison);
      console.log(`      latency=${latencyMs}ms recs=${raw.recommendations.length}->${plan.recommendations.length}`);
      console.log(`      BEFORE gate: overall=${rawScore.overall} citations=${pct(rawScore.metrics.citationGroundingRate.value)} facts=${pct(rawScore.metrics.patientFactGroundingRate.value)} doses=${pct(rawScore.metrics.dosageSafetyRate.value)} | violations=${violations.length} ${JSON.stringify(plan.grounding.counts || {})}`);
      for (const v of violations.slice(0, 4)) console.log(`        - ${v.kind}: ${v.name} — ${v.reason}`);
    }

    if (runs.length >= 2) {
      // Run-to-run consistency: the same profile answered twice must agree on
      // items and order, or "output consistency" is still just a hope.
      let overlapSum = 0;
      let tauSum = 0;
      let pairs = 0;
      for (let a = 0; a < runs.length; a += 1) {
        for (let b = a + 1; b < runs.length; b += 1) {
          const cmp = comparePlans(runs[a].plan, runs[b].plan);
          overlapSum += cmp.itemOverlap;
          tauSum += cmp.orderAgreement;
          pairs += 1;
        }
      }
      console.log(`  ${row.profile.id}: run-to-run consistency overlap=${(overlapSum / pairs).toFixed(3)} orderTau=${(tauSum / pairs).toFixed(3)} (pairs=${pairs})`);
    }
    liveScores.push(...runs.map((r) => r.score));
  }

  if (liveScores.length > 0) {
    const avg = {};
    for (const key of METRIC_KEYS) {
      avg[key] = liveScores.reduce((s, s2) => s + metricValue(s2, key), 0) / liveScores.length;
    }
    avg.overall = liveScores.reduce((s, s2) => s + s2.overall, 0) / liveScores.length;
    console.log('\n  LIVE AVERAGES:', Object.entries(avg).map(([k, v]) => `${k}=${k === 'overall' ? v.toFixed(1) : pct(v)}`).join(' '));
    for (const [key, limit] of Object.entries(THRESHOLDS)) {
      if (avg[key] !== undefined && avg[key] < limit) failures.push(`${key}=${key === 'overall' ? avg[key].toFixed(1) : pct(avg[key])} < ${limit}`);
    }
  } else {
    failures.push('no live run produced a usable plan');
  }
  return failures;
}

function checkThresholds(score, label, failures) {
  for (const [key, limit] of Object.entries(THRESHOLDS)) {
    const v = key === 'overall' ? score.overall : metricValue(score, key);
    if (v < limit) failures.push(`${label} ${key}=${key === 'overall' ? v : pct(v)} < ${limit}`);
  }
}

(async () => {
  const baselineRows = await runBaseline();
  const failures = [];
  for (const row of baselineRows) checkThresholds(row.score, `baseline ${row.profile.id}`, failures);

  if (LIVE) {
    failures.push(...await runLive(baselineRows));
  } else {
    console.log('\n  (offline mode: pass --live to benchmark the LLM against this baseline; --runs=N to repeat)');
  }

  console.log('');
  if (failures.length) {
    console.error(`BENCHMARK FAILED (${failures.length} threshold breach(es)):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`BENCHMARK PASSED — ${baselineRows.length} profiles (baseline + field-study)${LIVE ? ` x ${RUNS} live run(s)` : ''}, all thresholds met.`);
})().catch((err) => {
  console.error('Benchmark crashed:', err);
  process.exit(1);
});
