#!/usr/bin/env node
/**
 * Fine-tune dataset export — what "train the model we use" means with API keys.
 *
 * READ THIS BEFORE EXPECTING A TRAINING RUN
 * -----------------------------------------
 * An API key can start a fine-tune job on OpenAI's own models and on nothing
 * else in this product's stack. OpenRouter routes to third parties' hosted
 * weights, Groq serves inference on someone else's chips, and Anthropic does
 * not expose a text-completion fine-tune of Haiku through the same endpoint we
 * call. So this file does not pretend to train the assessment model. It produces
 * the dataset, in the exact JSONL shape OpenAI's chat fine-tuning endpoint
 * accepts, from the plans THIS SYSTEM HAS ALREADY VERIFIED.
 *
 * Why that is still the right lever: the hallucination fixes shipped here work
 * by giving the model better input (the citation registry in the prompt) and by
 * repairing bad output (utils/planGrounding.js). The repair log is a stream of
 * (prompt, correct-answer) pairs — the supervision OpenAI would need. Once the
 * route is on a model that can be tuned, the same file feeds the job; the
 * prompt-side and verify-side improvements do not depend on it.
 *
 * Usage:
 *   node eval/exportFineTune.js                 # offline, deterministic
 *   node eval/exportFineTune.js --out=path.jsonl
 */

const fs = require('fs');
const path = require('path');

const { generateClinicalFallback } = require('../routes/recommend');
const { buildAssessmentPrompt, ASSESSMENT_SYSTEM_PROMPT } = require('../utils/assessmentPrompt');
const { enforcePlanConsistency } = require('../utils/planConsistency');
const { groundPlan, groundingViolations } = require('../utils/planGrounding');
const profiles = require('./baseline-profiles.json');
// Field-study profiles are the second half of the set: also synthetic, also scored through
// the same verifier, but shaped by what the project's pharmacy interview actually observed
// (an older, hypertensive, maintenance-medication member asking about branded supplements)
// rather than by what the engine's authors thought to write down. A fine-tune built only
// from the first four profiles teaches the model the four situations someone imagined.
const fieldStudyProfiles = require('./field-study-profiles.json');
const TRAINING_PROFILES = [...profiles, ...fieldStudyProfiles];

const args = process.argv.slice(2);
const OUT = (args.find((a) => a.startsWith('--out=')) || '').split('=')[1]
  || path.join(__dirname, 'fine-tune', 'assessment-grounded.jsonl');

function buildRow(profile) {
  // The assistant turn is the GROUNDED plan, not the model's draft: a fine-tune
  // on unverified output would teach the very behaviour this work removes.
  const raw = enforcePlanConsistency(generateClinicalFallback(profile));
  const grounded = groundPlan(raw, profile, { trustedRecs: raw.recommendations });
  const violations = groundingViolations(grounded, profile);
  if (violations.length > 0) return { error: violations };
  const user = buildAssessmentPrompt(profile);
  return {
    row: {
      messages: [
        { role: 'system', content: ASSESSMENT_SYSTEM_PROMPT },
        { role: 'user', content: user },
        { role: 'assistant', content: JSON.stringify(grounded) },
      ],
    },
    grounded,
  };
}

function main() {
  const rows = [];
  const skipped = [];
  for (const profile of TRAINING_PROFILES) {
    const built = buildRow(profile);
    if (built.error) {
      skipped.push(`${profile.id}: ${built.error.map((v) => `${v.kind}/${v.name}`).join(', ')}`);
      continue;
    }
    rows.push(built.row);
    console.log(`${profile.id}: ${built.grounded.recommendations.length} verified recommendations, ${(built.grounded.grounding.actions || []).length} repair(s)`);
  }
  if (rows.length === 0) {
    console.error('No grounded plan could be built — nothing exported.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  console.log(`\nWrote ${rows.length} example(s) -> ${OUT}`);
  if (skipped.length > 0) console.log(`Skipped (failed the verifier): ${skipped.join(' | ')}`);
  console.log('\nUpload target: OpenAI /v1/fine_tuning/jobs with training_file=<this file>,');
  console.log('and only for an OpenAI model that lists fine_tuning=true. The OpenRouter, Groq');
  console.log('and Anthropic keys in this product cannot consume this file.');
}

main();
