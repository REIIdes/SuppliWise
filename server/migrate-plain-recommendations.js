/**
 * One-time data fix: add the two plain-language fields to recommendations that
 * were produced by the RULE ENGINE rather than by the AI.
 *
 * Why: the AI is asked for a `simplifiedReason` and a `simplifiedEvidence`
 * alongside the clinical text, and the reader switches between them with the
 * Simplified / Detailed control. The rule engine — which takes over when the AI
 * is unavailable — filled in the other six derived fields but never these two.
 * So for every plan generated that way the control did almost nothing:
 * Simplified quietly fell back to the clinical text, which reads as a broken
 * control rather than a missing feature.
 *
 * The engine now derives both (utils/recommendationPlainLanguage.js). This
 * script brings the already-stored records in line, so the control works for
 * existing plans too.
 *
 * SAFETY
 *   - Purely ADDITIVE. Nothing existing is read, rewritten or removed; a
 *     recommendation that already has a simplified field keeps it, because the
 *     AI's own wording is better than anything derived.
 *   - The patient profile comes from the assessment itself, so the "why you"
 *     half can only ever quote something they reported.
 *   - Dry run by default. Pass --apply to write.
 *
 *   node migrate-plain-recommendations.js           # preview
 *   node migrate-plain-recommendations.js --apply   # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');
const {
  simplifiedReasonFor,
  simplifiedEvidenceFor,
} = require('./utils/recommendationPlainLanguage');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const docs = await Assessment.find({
      'aiResults.recommendations': { $exists: true, $ne: [] },
    }).select('age gender symptoms healthGoals medicalConditions aiResults.recommendations').lean();

    let assessmentsTouched = 0;
    let recommendationsTouched = 0;
    let alreadyComplete = 0;
    let unrecognised = 0;
    const samples = [];

    for (const doc of docs) {
      const recs = doc.aiResults.recommendations;
      if (!Array.isArray(recs)) continue;

      let changed = false;
      const next = recs.map((rec) => {
        // `aiResults` is Mixed, so an element can be anything at all.
        if (!rec || typeof rec !== 'object') return rec;

        const hasReason = typeof rec.simplifiedReason === 'string' && rec.simplifiedReason.trim();
        const hasEvidence = typeof rec.simplifiedEvidence === 'string' && rec.simplifiedEvidence.trim();
        if (hasReason && hasEvidence) {
          alreadyComplete += 1;
          return rec;
        }

        const context = {
          name: rec.name,
          symptoms: doc.symptoms,
          goals: doc.healthGoals,
          conditions: doc.medicalConditions,
        };
        const simplifiedReason = hasReason ? rec.simplifiedReason : simplifiedReasonFor(context);
        const simplifiedEvidence = hasEvidence ? rec.simplifiedEvidence : simplifiedEvidenceFor(rec.name);

        if (!simplifiedReason && !simplifiedEvidence) {
          // An unrecognised supplement. Left exactly as it is: writing a
          // generic sentence here would attach a claim about a compound
          // nobody checked.
          unrecognised += 1;
          return rec;
        }

        if (samples.length < 5 && !hasReason) {
          samples.push({ name: rec.name, simplifiedReason, simplifiedEvidence });
        }
        changed = true;
        recommendationsTouched += 1;
        return { ...rec, simplifiedReason, simplifiedEvidence };
      });

      if (!changed) continue;
      assessmentsTouched += 1;
      if (APPLY) {
        await Assessment.updateOne({ _id: doc._id }, { $set: { 'aiResults.recommendations': next } });
      }
    }

    console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} — plain-language recommendations`);
    console.log(`  assessments scanned        : ${docs.length}`);
    console.log(`  assessments needing a fix  : ${assessmentsTouched}`);
    console.log(`  recommendations to fill    : ${recommendationsTouched}`);
    console.log(`  already complete (AI)      : ${alreadyComplete}`);
    console.log(`  unrecognised, left alone   : ${unrecognised}`);
    if (samples.length) {
      console.log('\n  examples that would be written:');
      for (const s of samples) {
        console.log(`    * ${s.name}`);
        console.log(`        reason  : ${s.simplifiedReason || '(none)'}`);
        console.log(`        evidence: ${s.simplifiedEvidence || '(none)'}`);
      }
    }
    if (!APPLY) console.log('\n  Re-run with --apply to write these.');
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
