/**
 * The AI reply-language control on the Profile page.
 *
 * Run: npm test (from my-react-app)
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * The assistant answers in the language of the member's message, and falls back
 * to `User.preferredLanguage` when the message does not say (routes/chat.js
 * `replyLanguage` → `replyLanguagePreference`). That fallback only exists if a
 * member can SET it, and the setting has three ways to break silently:
 *
 * 1. The option list drifting from the server's enum. A code the server refuses
 *    is an error message; a code the server accepts but this list omits is a
 *    language the member cannot choose, and nothing fails.
 * 2. The value not reaching the session cache, so the next chat turn reads the
 *    old language even though the save succeeded.
 * 3. The control ending up inside the edit form, where it only saves when the
 *    member also submits a name/email/picture change.
 *
 * The logic lives inside a .jsx component, so — as with profileEditExit.test.js —
 * the source is read and asserted directly rather than imported. No bundler, no
 * React, no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, 'ProfilePage.jsx'), 'utf8');
const userModel = readFileSync(join(here, '../../../server/models/User.js'), 'utf8');

/** The codes the server will actually store, pulled from the schema literal. */
function serverEnum() {
  const field = userModel.match(/preferredLanguage:\s*\{([\s\S]*?)\n\s{4}\}/);
  assert.ok(field, 'User.preferredLanguage disappeared — the fallback has nothing to read');
  const list = field[1].match(/enum:\s*\[([^\]]*)\]/);
  assert.ok(list, 'User.preferredLanguage has no enum, so any string would be stored');
  return [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function clientOptions() {
  const block = page.match(/const AI_LANGUAGE_OPTIONS = \[([\s\S]*?)\];/);
  assert.ok(block, 'the language dropdown lost its option list');
  return [...block[1].matchAll(/code:\s*'([^']*)'/g)].map((m) => m[1]);
}

test('the dropdown offers exactly the languages the server will store', () => {
  const stored = serverEnum();
  const offered = clientOptions();
  // 'en' is the one code the control folds into the English entry rather than
  // repeating, so it is excused from the option list but must still be storable.
  const folded = offered.filter((code) => code !== 'en');
  assert.deepEqual(folded.sort(), stored.filter((code) => code !== 'en').sort());
  assert.ok(stored.includes(''), 'an empty preference must stay valid — it is what every pre-existing account has');
});

test('choosing a language saves it on its own, not behind the profile form', () => {
  assert.match(page, /fetch\(`\$\{BASE_URL\}\/auth\/language`/, 'the control must post to its own endpoint');
  assert.match(page, /onChange=\{\(e\) => saveLanguagePreference\(e\.target\.value\)\}/);
  // Not `disabled={!isEditing}`: a language change is one field and applies to
  // the assistant's next reply, so it cannot wait for an unrelated profile edit.
  const select = page.match(/<select[^>]*id="preferredLanguage"[\s\S]*?<\/select>/);
  assert.ok(select, 'the preferredLanguage select is not rendered');
  assert.doesNotMatch(select[0], /disabled=\{!isEditing\}/);
});

test('a saved language reaches the session cache the rest of the app reads', () => {
  assert.match(
    page,
    /setStoredUser\(\{ \.\.\.\(getStoredUser\(\) \|\| \{\}\), preferredLanguage: saved \}\)/,
    'without this the next chat turn still reads the previous preference',
  );
  assert.match(page, /preferredLanguage: fresh\.preferredLanguage \|\| ''/);
});

test('an English account never shows a blank dropdown', () => {
  // The server accepts both '' and 'en'; only one of them is in the option list.
  assert.match(page, /function languageCodeForControl\(code\)/);
  assert.match(page, /value=\{preferredLanguage\}/);
  const foldsEn = page.match(/const value = String\(code \|\| ''\);\s*\n\s*return value === 'en' \? '' : value;/);
  assert.ok(foldsEn, "'en' must fold into the English option before it reaches the select");
});
