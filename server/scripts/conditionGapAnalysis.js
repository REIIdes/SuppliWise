/**
 * Condition gap analysis — the manual door onto the learning loop.
 *
 * The pipeline itself lives in `utils/conditionLearning.js` and now runs on its
 * own: `index.js` arms a boot check plus an hourly tick, gated by the durable
 * `AiLearningRun` thresholds (25 assessments nobody has learned from yet AND 24 h
 * since the last cycle), so learning no longer depends on an operator
 * remembering this file exists.
 *
 * WHAT THIS STILL DOES THAT THE TIMER DOES NOT
 * --------------------------------------------
 * It writes its work to disk. `condition-gap-report.json` (the aggregates),
 * `condition-gap-ranked.json` (what the model proposed) and
 * `condition-gap-raw-reply.txt` (what it actually said when that failed to
 * parse) exist so a human can read the reasoning behind a publication instead
 * of trusting a log line — which is precisely what a scheduled job inside a
 * container must NOT do, since its filesystem may be read-only and nobody is
 * watching. Nothing here duplicates the decision logic: the same
 * `decideAndPublish()` the timer calls is the only thing that can make a
 * candidate live, and the same evidence gate rejects an unproven one.
 *
 *   node scripts/conditionGapAnalysis.js            # aggregates + ranking + gate
 *   node scripts/conditionGapAnalysis.js --dry-run  # aggregates only, no spend
 *   node scripts/conditionGapAnalysis.js --import   # queue the existing
 *                                                   # ranked file, no spend
 *   node scripts/conditionGapAnalysis.js --force    # ignore the 25/24 h rules
 *
 * The ranked candidates are DECIDED AUTONOMOUSLY by the evidence gate
 * (utils/evidenceGate.js): a candidate publishes itself into the live
 * questionnaire (DynamicCondition) only when every supplement suggestion
 * carries a citation to an authoritative health-professional source
 * (guideline bodies, Cochrane, meta-analyses, RCTs with a well-formed PMID);
 * anything else is auto-rejected with the missing-proof reason recorded. The
 * ConditionProposal collection keeps every verdict as a learning log — no
 * admin click is required or possible for publication.
 *
 * PRIVACY
 * -------
 * No document-level record leaves this process. Raw narratives are reduced to
 * neutralized keyword tallies BEFORE anything is assembled, and only counts,
 * canonical option labels, and the top aggregate terms go to the model. The
 * neutralized-then-fenced block still carries the standing GUARDRAIL_CLAUSE:
 * some of those aggregate terms originate from user text that once passed
 * through an injection probe, and the guardrail does not grade inputs.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Assessment = require('../models/Assessment');
const {
  SCAN_LIMIT,
  aggregateGaps,
  decideAndPublish,
  rankCandidates,
  runCycle,
} = require('../utils/conditionLearning');

const REPORT_FILE = path.join(__dirname, 'condition-gap-report.json');
const RANKED_FILE = path.join(__dirname, 'condition-gap-ranked.json');
const RAW_REPLY_FILE = path.join(__dirname, 'condition-gap-raw-reply.txt');

async function main() {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set — run this from the server .env.');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  console.log('[gap] connected.');

  // ── The whole cycle through the library door ─────────────────────────
  // One flag for the operator who just wants today's answer with no
  // intermediate files: the ledger, the lease, the gate and the publish are the
  // scheduled path's, so a manual run can never disagree with an automatic one.
  if (process.argv.includes('--cycle')) {
    const outcome = await runCycle({ trigger: 'cli', force: process.argv.includes('--force') });
    console.log(`[gap] ${JSON.stringify({ ran: outcome.ran, ok: outcome.ok, reason: outcome.reason, error: outcome.error, published: outcome.published, refreshed: outcome.refreshed, accepted: outcome.accepted && outcome.accepted.length, rejected: outcome.rejected && outcome.rejected.length })}`);
    await mongoose.disconnect();
    if (outcome.ran && !outcome.ok) process.exitCode = 1;
    return;
  }

  // ── Import-only mode: decide a previous run's ranked file ───────────────
  // Same gate, same writes, minus the read and the provider spend.
  if (process.argv.includes('--import')) {
    const ranked = JSON.parse(fs.readFileSync(RANKED_FILE, 'utf8'));
    let scanned = 0;
    try {
      scanned = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')).assessmentsScanned || 0;
    } catch { /* report absent — evidence count stays 0 */ }
    const { accepted, rejected, pub } = await decideAndPublish(ranked, {
      script: 'conditionGapAnalysis --import',
      runAt: new Date(),
      assessmentsScanned: scanned,
    });
    summarise(accepted, rejected, pub);
    await mongoose.disconnect();
    return;
  }

  // ── 1. Aggregate over real submitted assessments ──────────────────────
  const recent = await Assessment.find({})
    .select('createdAt symptoms medicalConditions feelingDescription lifestyleHabits')
    .sort({ createdAt: -1 })
    .limit(SCAN_LIMIT)
    .lean();
  console.log(`[gap] ${recent.length} recent assessments.`);

  const report = { generatedAt: new Date().toISOString(), ...aggregateGaps(recent) };
  fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
  console.log(`[gap] aggregate report written to ${REPORT_FILE}`);
  console.log(JSON.stringify(report.freeTextConditionHints, null, 2));

  if (process.argv.includes('--dry-run')) {
    console.log('[gap] --dry-run: skipping the LLM ranking (no provider spend).');
    await mongoose.disconnect();
    return;
  }

  // ── 2. Ask the routed model to rank candidate additions ───────────────
  // The aggregates are neutralised and fenced inside the library before they
  // cross the wire — hint labels and symptom tallies derive from member-written
  // text, so they get the same treatment as any other untrusted channel.
  const ranking = await rankCandidates(report);
  if (!ranking.ok) {
    console.error('[gap] no provider answered:', JSON.stringify(ranking.attempts || []));
    console.error('[gap] aggregate report still available at', REPORT_FILE);
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }
  if (!ranking.parsed) {
    fs.writeFileSync(RAW_REPLY_FILE, ranking.raw);
    console.error(`[gap] provider reply contained no parseable JSON object; raw text saved to ${RAW_REPLY_FILE}`);
    await mongoose.disconnect();
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(RANKED_FILE, JSON.stringify(ranking.parsed, null, 2));
  console.log(`[gap] LLM ranking written to ${RANKED_FILE}:`);
  console.log(JSON.stringify(ranking.parsed, null, 2));

  // ── 3. Evidence gate: publish proven, reject unproven ─────────────────
  const { accepted, rejected, pub } = await decideAndPublish(ranking.parsed, {
    script: 'conditionGapAnalysis',
    runAt: new Date(),
    assessmentsScanned: report.assessmentsScanned,
  });
  summarise(accepted, rejected, pub);
  await mongoose.disconnect();
}

function summarise(accepted, rejected, pub) {
  console.log(`[gap] evidence gate: ${accepted.length} AUTO-APPROVED (${pub.published} published, ${pub.refreshed} refreshed), ${rejected.length} auto-rejected.`);
  for (const c of accepted) console.log(`[gap]   live: ${c.label} — ${(c.supplements || []).length} evidence-cited supplement(s)`);
  for (const r of rejected) console.log(`[gap]   refused: ${r.candidate && r.candidate.label} — ${r.reasons.join('; ')}`.slice(0, 400));
}

main().catch(async (err) => {
  console.error('[gap] failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exitCode = 1;
});
