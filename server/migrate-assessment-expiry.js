/**
 * One-time data fix: rebuild `Assessment.expiresAt` on the canonical rule
 * "5 CALENDAR years after createdAt" (same clock time).
 *
 * Why: retention used to be written as `Date.now() + 5 * 365.25 days`
 * (1826.25 days). That drifts ~6 h against a real 5-year span, so the stored
 * value matched neither the creation date nor the creation time — the history
 * badge showed things like "Expires Sep 22, 2031, 01:56 AM". Two other paths
 * made it worse: an intake auto-lift stamped `expiresAt = now` (retiring the
 * record the second the user finished a priority review) and an admin
 * Priority→Standard resolve stamped "5 years from NOW" (pushing an old
 * record's expiry years into the future).
 *
 * The code now writes the correct date everywhere (utils/assessments.js
 * expiryFrom / expiryFromCreatedAt). This script fixes records written before
 * that change.
 *
 * Rules applied:
 *   - priority === 'Priority'  -> expiresAt stays null (never expires while
 *     flagged; the flag lifecycle owns it).
 *   - everything else          -> createdAt + 5 calendar years.
 *
 * Dry run by default. Pass --apply to write.
 *
 *   node migrate-assessment-expiry.js           # preview
 *   node migrate-assessment-expiry.js --apply   # write
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Assessment = require('./models/Assessment');
const { expiryFrom } = require('./utils/assessments');

const APPLY = process.argv.includes('--apply');
// Matches docs written by the old formulas (5 * 365.25 days, "now",
// "5 years from now") — anything already exactly on the calendar rule is
// skipped, so the script is idempotent and safe to re-run.
const TOLERANCE_MS = 60 * 1000;

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  try {
    const docs = await Assessment.find({
      $or: [{ priority: { $ne: 'Priority' } }, { expiresAt: { $ne: null } }],
    }).select('priority createdAt expiresAt').lean();

    const updates = [];
    for (const doc of docs) {
      const wanted = doc.priority === 'Priority' ? null : expiryFrom(doc.createdAt);
      const current = doc.expiresAt ? new Date(doc.expiresAt) : null;
      const same = (wanted === null && current === null)
        || (wanted && current && Math.abs(wanted.getTime() - current.getTime()) <= TOLERANCE_MS);
      if (!same) {
        updates.push({
          updateOne: { filter: { _id: doc._id }, update: { $set: { expiresAt: wanted } } },
        });
      }
    }

    console.log(`scanned ${docs.length} assessment(s); ${updates.length} need correction`);
    for (const doc of docs) {
      const wanted = doc.priority === 'Priority' ? null : expiryFrom(doc.createdAt);
      const current = doc.expiresAt ? new Date(doc.expiresAt) : null;
      const same = (wanted === null && current === null)
        || (wanted && current && Math.abs(wanted.getTime() - current.getTime()) <= TOLERANCE_MS);
      if (!same) {
        console.log(`  ${doc._id}  created ${doc.createdAt?.toISOString?.() || doc.createdAt}`
          + `  ${current ? current.toISOString() : 'null'} -> ${wanted ? wanted.toISOString() : 'null'}`);
      }
    }

    if (!APPLY) {
      console.log('\nDRY RUN — re-run with --apply to write these changes.');
    } else if (updates.length) {
      const res = await Assessment.bulkWrite(updates);
      console.log(`\nupdated ${res.modifiedCount} document(s).`);
    } else {
      console.log('\nnothing to change.');
    }
  } finally {
    await mongoose.disconnect();
  }
})().catch((error) => {
  console.error('MIGRATION FAILED', error);
  process.exit(1);
});
