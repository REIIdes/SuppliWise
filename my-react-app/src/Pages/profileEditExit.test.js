/**
 * Leaving Profile edit mode — Cancel and Save Changes both have to END UP on
 * the read-only Profile Information card, and stay there.
 *
 * Run: npm test
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * "Save Changes" used to finish with:
 *
 *     setTimeout(() => { window.location.reload(); }, 2000);
 *
 * A full page reload is invisible in review — it looks like a harmless
 * "refresh the navbar" line — but it re-mounted ProfilePage with `?edit=1`
 * STILL in the URL (nothing had cleared it). On that fresh mount the
 * render-time rule at the top of the component compares the param against a
 * `lastUrlEdit` sentinel seeded to `false`, sees a difference, and calls
 * `setIsEditing(true)`. So saving a profile threw the user straight back into
 * the form they had just submitted, and destroyed the "Profile updated
 * successfully!" banner on the way. That is the reported bug: press Save
 * Changes, get the Profile Information edit screen again.
 *
 * The reload was also unnecessary. `setStoredUser()` already emits
 * AUTH_CHANGED_EVENT, which `useAuth()` subscribes to, so the navbar's name and
 * avatar repaint from the same save without a page load.
 *
 * The fix is `clearTransientParams()` — the same call Cancel makes — which drops
 * `?edit=1` while keeping `?view=`. The rules below pin that, plus the two
 * things that would silently rot again: a reload creeping back in anywhere in
 * the component, and the picture previews drifting from the server-confirmed
 * values (which would make the NEXT Cancel/Save re-upload an already-saved
 * picture).
 *
 * The logic lives inside a .jsx component, so — as with recoveryCodeTidy.test.js
 * — the source is read and asserted directly rather than imported. No bundler,
 * no React, no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, 'ProfilePage.jsx'), 'utf8');

/**
 * Pull `const NAME = (…) => { … }` out of the component body.
 *
 * Brace counting is good enough here because the only brace-bearing literal in
 * this function is a template interpolation (`` `Bearer ${token}` ``), and that
 * pair is balanced — so depth still returns to zero at the real closing brace.
 * The extraction asserts it found something, so a rename or a move fails this
 * file loudly instead of silently passing nothing.
 */
function extractArrow(name) {
  const decl = `const ${name} =`;
  const start = SOURCE.indexOf(decl);
  assert.notEqual(start, -1, `${name} not found in ProfilePage.jsx`);
  const open = SOURCE.indexOf('{', SOURCE.indexOf('=>', start));
  assert.notEqual(open, -1, `no arrow body found for ${name}`);
  let depth = 0;
  for (let i = open; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === '{') depth += 1;
    else if (SOURCE[i] === '}') {
      depth -= 1;
      if (depth === 0) return SOURCE.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/** Source with comments removed, so prose about a reload is not a reload. */
function executableSource() {
  return SOURCE
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // Only whole-line `//` comments, so a `https://` inside a string survives.
    .replace(/^\s*\/\/.*$/gm, ' ');
}

test('Save Changes does not reload the page', () => {
  // The single line that caused the whole bug. Asserted against the WHOLE
  // component (comments stripped) rather than just submitProfileUpdate, because
  // a reload added anywhere else in this file would re-enter edit mode just as
  // effectively.
  assert.equal(
    executableSource().includes('location.reload'),
    false,
    'ProfilePage.jsx must not call location.reload() — a reload with ?edit=1 '
      + 'still in the URL re-enters edit mode and drops the success banner',
  );
});

test('Save Changes drops ?edit=1 so edit mode stays off', () => {
  const submit = extractArrow('submitProfileUpdate');
  assert.match(
    submit,
    /clearTransientParams\(\)/,
    'a successful save must call clearTransientParams(), the same as Cancel, '
      + 'or ?edit=1 survives and edit mode re-engages',
  );
});

test('Save Changes ends edit mode and confirms success in place', () => {
  const submit = extractArrow('submitProfileUpdate');
  assert.match(submit, /setIsEditing\(false\)/, 'save must leave edit mode');
  assert.match(
    submit,
    /setSuccess\('Profile updated successfully!/,
    'save must confirm to the user instead of silently returning',
  );
  // No timer may dismiss the banner afterwards. (The `setSuccess('')` at the
  // TOP of this function is correct and unrelated — it clears any earlier
  // message before the attempt — so the rule is pinned on the scheduling, not
  // on the call.)
  assert.doesNotMatch(
    submit,
    /setTimeout/,
    'save must not schedule a dismissal of its own success banner; it should '
      + 'stay until the user does something else',
  );
});

test('Save Changes resyncs the picture previews with the server values', () => {
  const submit = extractArrow('submitProfileUpdate');
  // handleCancel already treats `preview !== saved` as "unsaved picture here",
  // and so does the next save. Leaving the previews on the locally-read base64
  // after the server has confirmed its own value means the following Cancel or
  // Save tries to re-upload a picture that was already stored.
  assert.match(
    submit,
    /setProfilePicturePreview\(data\.profilePicture \|\| ''\)/,
    'avatar preview must be re-based on the server value after a save',
  );
  assert.match(
    submit,
    /setBannerPicturePreview\(data\.bannerPicture \|\| ''\)/,
    'banner preview must be re-based on the server value after a save',
  );
});

test('Cancel still discards edits and stays on the Profile Information card', () => {
  const cancel = extractArrow('handleCancel');
  assert.match(cancel, /clearTransientParams\(\)/, 'Cancel must drop ?edit=1');
  assert.match(cancel, /setIsEditing\(false\)/, 'Cancel must leave edit mode');
  assert.match(
    cancel,
    /setProfilePicturePreview\(profilePicture\)/,
    'Cancel must restore the last server-confirmed avatar',
  );
  assert.match(
    cancel,
    /setBannerPicturePreview\(bannerPicture\)/,
    'Cancel must restore the last server-confirmed banner',
  );
  // Cancel must NOT navigate: the user asked to stay on this card, and a
  // round trip through the router is what it used to look like.
  assert.doesNotMatch(
    cancel,
    /navigate\(/,
    'Cancel must not navigate away from the Profile Information card',
  );
});

test('re-entering edit mode clears a stale banner from the previous save', () => {
  // `?edit=1` arriving is a fresh edit session. A "Profile updated
  // successfully!" left over from the last save describes THAT save, not the
  // draft now on screen, so it is cleared on the way in.
  const start = SOURCE.indexOf("const urlEdit = searchParams.get('edit')");
  assert.notEqual(start, -1, 'the ?edit=1 render-time rule not found');
  const block = SOURCE.slice(start, SOURCE.indexOf('const startOtpExpiryTimer', start));
  assert.match(block, /setIsEditing\(true\)/, '?edit=1 must engage edit mode');
  assert.match(
    block,
    /setSuccess\(''\)/,
    'entering edit mode must clear the previous save’s success banner',
  );
});
