/**
 * The chain receipt on the plan the member actually reads.
 *
 * Run: npm test (from my-react-app)
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The ledger used to prove things only when a member went to the Web3 hub and
 * pressed a button, so the plan sitting in front of them said nothing about
 * being provable. Now the server anchors each plan as it saves it and hands the
 * receipt back with the response (`recommendationProof` on
 * PATCH /api/assessment/:id/results, `chainProof` on POST /api/assessment), and
 * the results screen prints the block number.
 *
 * Three ways that breaks silently, all of them invisible to a type check:
 *
 * 1. The response field is read under a different name than the server sends.
 *    The chip then never renders, and nothing fails — it looks like the feature
 *    was never asked for.
 * 2. The receipt is shown for a plan that has none. A block number from a stale
 *    `location.state` would claim a proof the ledger does not hold.
 * 3. The panel copy still telling the member anchoring only happens when they
 *    press a button, which is now false and reads as a broken feature when the
 *    rows appear on their own.
 *
 * The logic lives inside .jsx components, so — as with profileEditExit.test.js —
 * the source is read and asserted directly rather than imported. No bundler, no
 * React, no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');

const results = read('ResultsPage.jsx');
const assessment = read('AssessmentPage.jsx');
const ledgerPanel = read('../Components/Web3Panels/LedgerPanel.jsx');
const aiPanel = read('../Components/Web3Panels/AiProofPanel.jsx');

test('the plan screen reads the receipt under the name the server sends', () => {
  assert.match(assessment, /saveAssessmentResults\(assessmentId, recommendations\)/);
  assert.match(assessment, /recommendationProof = resultsSave\?\.recommendationProof \|\| null/);
  assert.match(assessment, /recommendationProof,/g, 'and passes it into the results route');
  assert.match(results, /recommendationProof = null \} = location\.state/);
  // The health-ledger snapshot the same events anchor is not carried here: the
  // hub's anchor history already lists it, and threading a receipt no screen
  // prints is dead state.
  assert.doesNotMatch(assessment, /healthProof/);
});

test('the chip only renders when a receipt exists', () => {
  // The block number is printed from the receipt, not from a counter or the
  // wallet — an invented block is worse than no chip at all.
  assert.match(results, /\{recommendationProof && \(/);
  assert.match(results, /recommendationProof\.blockIndex/);
  assert.match(results, /recommendationProof\.combinedHash/, 'and the commit it belongs to');
  assert.match(results, /Anchored on the SuppliWise ledger at block/);
});

test('the receipt links to something that can check it', () => {
  assert.match(results, /<Link to="\/web3">/);
  // The hub panel that verifies this exact commitment must exist and be wired.
  assert.match(aiPanel, /getRecommendationAnchor/);
});

test('the web3 panels describe anchoring as automatic', () => {
  assert.match(ledgerPanel, /written automatically each time you save an assessment/);
  assert.match(aiPanel, /Every plan is anchored as it/);
  assert.match(aiPanel, /Plans anchor automatically when they save/);
});
