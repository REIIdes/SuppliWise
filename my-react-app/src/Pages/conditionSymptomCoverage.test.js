/**
 * Every built-in medical condition must have at least one ALL_SYMPTOMS row.
 *
 * Run: npm test
 *
 * A condition with zero rows renders no "Current Symptoms" block in Step 3,
 * and the "No symptoms for <condition>" escape lives inside that block — so
 * selecting it demands an answer the form never shows. That is exactly how
 * "High Triglycerides" made Step 2/3 un-continuable in the 2026-10 minor-bug
 * round. This test reads the two arrays out of AssessmentPage.jsx itself
 * (node --test cannot import a .jsx file) and fails on any future condition
 * added to conditionGroups without a symptom behind it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./AssessmentPage.jsx', import.meta.url), 'utf8');

// Slice a top-level `const NAME = [ ... ];` by bracket matching and evaluate
// the literal in a sandbox. Symptom/condition names contain parentheses and
// slashes but no square brackets, so counting [ ] is safe.
function readArray(name, sandbox = {}) {
  const start = src.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `${name} not found in AssessmentPage.jsx`);
  const open = src.indexOf('[', start);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '[') depth += 1;
    else if (src[i] === ']') {
      depth -= 1;
      if (depth === 0) {
        const literal = src.slice(open, i + 1);
        return new Function(...Object.keys(sandbox), `return ${literal};`)(...Object.values(sandbox));
      }
    }
  }
  assert.fail(`unterminated array for ${name}`);
}

const ALL_SYMPTOMS = readArray('ALL_SYMPTOMS');
// Both optional gates on so the audited list is the superset a member can see.
const GROUPS = readArray('conditionGroups', { showObesity: true, data: { gender: 'Female' } });

const BUILT_INS = GROUPS.flatMap((g) => g.items);

test('the source scan finds the real lists', () => {
  assert.ok(ALL_SYMPTOMS.length > 40, 'ALL_SYMPTOMS parsed');
  assert.ok(BUILT_INS.includes('High Triglycerides'), 'conditionGroups parsed');
});

test('every built-in condition has at least one symptom row at some gender', () => {
  const covered = new Set(ALL_SYMPTOMS.flatMap((s) => s.conditions));
  const missing = BUILT_INS.filter((c) => !covered.has(c));
  assert.deepEqual(missing, [], `conditions with no Current Symptoms block: ${missing.join(', ')}`);
});

test('High Triglycerides specifically answers with its own symptom block', () => {
  const rows = ALL_SYMPTOMS.filter((s) => s.conditions.includes('High Triglycerides'));
  assert.ok(rows.length >= 3, 'the reported bug: it had zero rows');
  const names = rows.map((s) => s.name);
  assert.ok(names.includes('Fatigue') && names.includes('Abdominal Pain / Cramps'));
  for (const row of rows) {
    assert.deepEqual(
      [...row.genders].sort(),
      ['Female', 'Male', 'Prefer not to say'].sort(),
      `${row.name}: High Triglycerides is not sex-gated, so the block must render for every gender`,
    );
  }
});
