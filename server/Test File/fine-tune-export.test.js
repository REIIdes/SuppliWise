/**
 * The fine-tune export stays synthetic, and stays honest about what it is.
 *
 * Run: npm test (from server), or: node --test "Test File/fine-tune-export.test.js"
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * "Use what the AI learns as training data" is a reasonable thing for the product owner to
 * ask for, and `eval/exportFineTune.js` is the answer to it: it writes the JSONL a fine-tune
 * job would consume. Today that file is built from six synthetic profiles and touches no
 * database. That is a property of a script nobody imports, which means nothing enforced it —
 * one `require('../models/Assessment')` in a future edit would start exporting member health
 * prose into a training file, and the only symptom would be a larger JSONL.
 *
 * So: the source is read for the seams that would make that possible, AND the script is
 * actually run offline into a throwaway file so the recorded numbers (6 rows, 0 skipped)
 * are measured rather than asserted from a comment.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../eval/exportFineTune.js');
const src = fs.readFileSync(SCRIPT, 'utf8');

/**
 * Written under the OS temp dir, never `/tmp`.
 *
 * On this development machine Git Bash and Node disagree about what `/tmp` is, which once
 * turned a passing run into a fake CI failure when a script wrote through one and a test
 * read through the other.
 */
function outPath() {
  return path.join(os.tmpdir(), `suppliwise-fine-tune-${process.pid}.jsonl`);
}

test('the export reads no member data source', () => {
  assert.doesNotMatch(src, /require\(['"]\.\.\/models\//,
    'a model require would put real member rows into a training file');
  assert.doesNotMatch(src, /require\(['"]\.\.\/utils\/memberMemory['"]\)/,
    'the per-member memory is retrieval arithmetic inside this app, not a training set');
  assert.doesNotMatch(src, /mongoose|MONGO_URI/,
    'the export is documented as offline; a connection makes it a database read');
  assert.doesNotMatch(src, /completeWithFallback|aiRouter/,
    'the assistant turn is the verified plan, never a model draft');
});

test('the export uploads nothing and says so', () => {
  // It names /v1/fine_tuning/jobs in a console line — that is the manual instruction.
  // What must never appear is a way to act on it.
  assert.doesNotMatch(src, /\bfetch\(|https\.request|axios|new OpenAI|require\(['"]openai/,
    'the script prints an upload target; it must not be able to reach one');
  assert.doesNotMatch(src, /process\.env\.(OPENAI|ANTHROPIC|GROQ|OPENROUTER)_/,
    'a dataset built from synthetic profiles needs no key, and a key in this file means it stopped being offline');
  assert.match(src, /Upload target: OpenAI \/v1\/fine_tuning\/jobs/,
    'the manual step has to stay spelled out, or the file is a mystery artifact');
  assert.match(src, /cannot consume this file/,
    'the header promise that three of the four keys cannot use this file must stay in the output');
});

test('run offline, it writes the number of verified rows the documentation claims', () => {
  const out = outPath();
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, `--out=${out}`], { encoding: 'utf8' });
    const rows = fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

    assert.equal(rows.length, 6, 'the export is six synthetic profiles: four imagined, two from the pharmacy interview');
    assert.equal(/Skipped \(failed the verifier\)/.test(stdout), false,
      'a skipped profile means the shipped plan builder now produces output its own verifier rejects');

    for (const row of rows) {
      const roles = row.messages.map((m) => m.role);
      assert.deepEqual(roles, ['system', 'user', 'assistant'], 'each row is one chat fine-tune example');
      const plan = JSON.parse(row.messages[2].content);
      assert.ok(Array.isArray(plan.recommendations) && plan.recommendations.length >= 4,
        'a row with a thin plan would train the model to under-recommend');
      assert.equal(typeof plan.grounding, 'object', 'the verified plan carries its grounding record');
      for (const rec of plan.recommendations) {
        assert.ok(String(rec.name || '').trim().length > 0, 'a training row must not contain an empty recommendation');
      }
    }
  } finally {
    try { fs.rmSync(out, { force: true }); } catch { /* throwaway */ }
  }
});

test('the profiles are the only input, and neither one is a member record', () => {
  const baseline = require('../eval/baseline-profiles.json');
  const fieldStudy = require('../eval/field-study-profiles.json');
  const ids = [...baseline, ...fieldStudy].map((p) => String(p.id || ''));
  assert.ok(ids.every((id) => id.trim().length > 0), 'every profile is named, so a row is attributable');
  assert.equal(new Set(ids).size, ids.length, 'duplicate profile ids would silently duplicate training rows');
  for (const profile of [...baseline, ...fieldStudy]) {
    // Synthetic profiles have no account behind them. If a real member's row were ever
    // pasted in here, an ObjectId-shaped user would be the giveaway.
    assert.equal(profile.user, undefined, 'a profile carries a member reference — the export would then be member data');
    assert.equal(profile.userId, undefined, 'a profile carries a member reference — the export would then be member data');
  }
});
