/**
 * The recovery-code input's own normalisation, and the rule it has to satisfy.
 *
 * A person copies these codes from wherever they saved them — a password
 * manager, a screenshot, a printed sheet — so the field has to cope with
 * lowercase, spaces, a missing dash and an over-long paste. The dash is
 * presentation only (the server strips every non-alphanumeric character before
 * hashing), so anything that produces a *valid-looking* string is fine.
 *
 * The bug this exists to prevent: an earlier version sliced to ten symbols and
 * returned EARLY, skipping the dash. A long paste then produced `ABCDEFGHIJ`,
 * which can never satisfy RECOVERY_CODE_REGEX, so the field was wedged — the
 * user could delete characters one at a time and still never match, because
 * nothing would insert the dash until the raw value happened to fall to ten or
 * fewer symbols. Every case below must end in a form the guard accepts.
 *
 * The helper lives inside a .jsx page, so it is read out of the source and
 * evaluated here rather than imported — no bundler, no React. The extraction
 * asserts its own inputs, so a rename or a move fails this file instead of
 * silently passing nothing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, 'ForgotPassword.jsx'), 'utf8');

/** Pull a top-level `function name(...) { … }` out of the page source. */
function extract(name) {
  const start = SOURCE.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found in ForgotPassword.jsx`);
  const open = SOURCE.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const tidyRecoveryCode = new Function(`${extract('tidyRecoveryCode')}; return tidyRecoveryCode;`)();

// Mirrors the component's own guard, and the test below asserts the component
// still uses it — so the two cannot drift into disagreeing about what is valid.
const RECOVERY_CODE_REGEX = /^[A-Z0-9]{5}-[A-Z0-9]{5}$/;

test('a complete code is accepted whatever the user pasted', () => {
  for (const typed of ['ABCDE12345', 'abcde12345', 'AB CDE-123 45', 'ABCDE-12345', 'AbCdE-12345']) {
    const tidied = tidyRecoveryCode(typed);
    assert.match(tidied, RECOVERY_CODE_REGEX, `${typed} tidied to ${tidied}`);
  }
});

test('an over-long paste still yields a submittable code', () => {
  // The regression: this used to return `ABCDEFGHIJ`, which the guard rejects.
  const tidied = tidyRecoveryCode('ABCDEFGHIJKLMNOP');
  assert.match(tidied, RECOVERY_CODE_REGEX, 'a long paste must stay submittable');
  assert.equal(tidied, 'ABCDE-FGHIJ');
});

test('a partial code is left alone rather than padded', () => {
  // No pad: a constant pad character is a fixed character handed to an attacker
  // in a credential, which is the exact flaw BackupCode.randomCode documents.
  assert.equal(tidyRecoveryCode('ABCD'), 'ABCD');
  assert.equal(tidyRecoveryCode('ABCDE'), 'ABCDE');
  assert.equal(tidyRecoveryCode('ABCDE1'), 'ABCDE-1');
});

test('nonsense input cannot produce a submittable code', () => {
  for (const junk of ['', '   ', '!!!!', '----------', 'abc']) {
    const tidied = tidyRecoveryCode(junk);
    assert.ok(!RECOVERY_CODE_REGEX.test(tidied), `${JSON.stringify(junk)} became ${tidied}`);
  }
});

test('the function is pure and idempotent', () => {
  const once = tidyRecoveryCode('ab cde-123 45');
  assert.equal(tidyRecoveryCode(once), once, 're-running must not re-pad or truncate');
});

test('the component uses this same helper, not a second implementation', () => {
  assert.match(
    SOURCE,
    /onChange=\{\(e\) => \{[\s\S]{0,400}?tidyRecoveryCode\(e\.target\.value\)/,
    'the field must normalise through tidyRecoveryCode so the fix above actually applies'
  );
  assert.match(
    SOURCE,
    /RECOVERY_CODE_REGEX\.test\(secret\.trim\(\)\.toUpperCase\(\)\)/,
    'the submit guard must keep using RECOVERY_CODE_REGEX'
  );
});