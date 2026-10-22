/**
 * History round-trip wiring — three 2026-10 minor-bug regressions, pinned by
 * scanning the page sources (node --test cannot import a .jsx file).
 *
 * Run: npm test
 *
 *  1. Every HistoryPage action that leaves the page must carry
 *     from: 'history', and the destination pages must honour it — the
 *     reviewer's "back button goes to homepage instead of History Page".
 *  2. Update mode step-1 Back goes to /history, not '/'.
 *  3. The server persists only pregnancyStatus, so hydration must derive the
 *     isPregnant/isBreastfeeding radios back from it — otherwise Assessment
 *     History shows every Step 4 answer except the female-specific ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const history = read('../Pages/HistoryPage.jsx');
const assessment = read('../Pages/AssessmentPage.jsx');
const results = read('../Pages/ResultsPage.jsx');

test('the three History views navigate with a history marker', () => {
  assert.match(history, /readOnly: true, from: 'history'/);
  assert.match(history, /assessment: item, from: 'history'/);
  assert.match(history, /assessmentData: item, from: 'history'/);
});

test('Assessment step-1 Back returns to History when update mode or from History', () => {
  assert.match(assessment, /navigate\(isUpdateMode \|\| routeState\.from === 'history' \? '\/history' : '\/'\)/);
});

test('Results back button follows its arrival marker, label included', () => {
  assert.match(results, /, from, recommendationProof = null \} = location\.state/);
  assert.match(results, /navigate\(from === 'history' \? '\/history' : '\/'\)/);
  assert.match(results, /from === 'history' \? 'Back to History' : 'Back to Home'/);
});

test('hydration derives the female Step 4 radios from persisted pregnancyStatus', () => {
  assert.match(assessment, /reconstructed\.isPregnant = assessment\.pregnancyStatus === 'Pregnant' \? 'Yes' : 'No'/);
  assert.match(assessment, /reconstructed\.isBreastfeeding = assessment\.pregnancyStatus === 'Breastfeeding' \? 'Yes' : 'No'/);
});
