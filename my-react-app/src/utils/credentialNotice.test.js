/**
 * The credential-notice dialog's view model.
 *
 * Run: npm test
 *
 * Why this file exists: the dialog used to take the count in its title from the
 * rows visible on screen while the recipient list printed underneath came from
 * the server's ADMIN_EMAILS. Those are different populations — the rows are
 * search-filtered and capped at 100, the server list is de-duplicated by address
 * and ignores the search — so a search for one alias rendered "Email 1
 * administrator(s)?" directly above a list of six. The send itself was fine; the
 * approval the operator gave was not.
 *
 * What is pinned here is the rule that fixed it, plus the two states that used
 * to make the dialog disappear (a failed preview, and a preview that has not
 * resolved yet) — both of which must still render, and neither of which may
 * enable Send.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CREDENTIAL_NOTICE_MAX_LENGTH,
  normalizeNoticeDescription,
  noticeRecipients,
  noticeMissingAliases,
  noticeTitle,
  noticeDescriptionHint,
  buildNoticeView,
} from './credentialNotice.js';

/** A preview shaped like GET /admins/credential-notice/preview. */
const PREVIEW = {
  description: "I'll Updated Your Credentials With Upgraded Version of Encryption",
  recipients: [
    { alias: 'AdminDevs', email: 'a@example.com' },
    { alias: 'AdminPoli', email: 'b@example.com' },
  ],
  missingEmail: ['AdminJoma'],
};

test('the description is trimmed, and a cleared field resolves to empty', () => {
  assert.equal(normalizeNoticeDescription('  Keys rotated Tuesday.  '), 'Keys rotated Tuesday.');
  // Whitespace-only is what a select-all-and-delete produces. It must NOT come
  // back as text, or the dialog would offer to send an empty security notice.
  assert.equal(normalizeNoticeDescription('   \n\t '), '');
  assert.equal(normalizeNoticeDescription(undefined), '');
  assert.equal(normalizeNoticeDescription(null), '');
});

test('the description cap matches the server cap', () => {
  assert.equal(CREDENTIAL_NOTICE_MAX_LENGTH, 400, 'server/routes/admin.js slices to 400');
  assert.equal(normalizeNoticeDescription('x'.repeat(5000)).length, 400);
  // A bogus cap falls back to the real one rather than slicing to "".
  assert.equal(normalizeNoticeDescription('hello', 0).length, 5);
  assert.equal(normalizeNoticeDescription('hello', -1).length, 5);
});

test('recipients are the aliases the SERVER will mail, in its order', () => {
  assert.deepEqual(noticeRecipients(PREVIEW), ['AdminDevs', 'AdminPoli']);
  // The search-filtered rows must never leak into this: an alias filtered out
  // of view is still mailed, so it must still be counted.
  assert.deepEqual(noticeRecipients({ recipients: [{ alias: 'AdminHidden' }] }), ['AdminHidden']);
});

test('a malformed recipient row is dropped rather than rendered as undefined', () => {
  const rows = [
    { alias: 'AdminDevs' },
    null,
    { alias: '   ' },
    { email: 'nobody@example.com' },
    { alias: 'AdminDevs' },
    'AdminPoli',
  ];
  // Duplicates collapse (one alias, one notice) and the string form is accepted.
  assert.deepEqual(noticeRecipients({ recipients: rows }), ['AdminDevs', 'AdminPoli']);
  assert.deepEqual(noticeRecipients({}), []);
  assert.deepEqual(noticeRecipients(null), []);
  assert.deepEqual(noticeRecipients({ recipients: 'nope' }), []);
});

test('missing aliases survive the same defensive read', () => {
  assert.deepEqual(noticeMissingAliases(PREVIEW), ['AdminJoma']);
  assert.deepEqual(noticeMissingAliases({ missingEmail: ['A', ' A ', null, ''] }), ['A']);
  assert.deepEqual(noticeMissingAliases({}), []);
});

test('the count comes from the server list, not from the rows on screen', () => {
  const view = buildNoticeView({ preview: PREVIEW, description: 'Hi', visibleCount: 1 });
  assert.equal(view.count, 2, 'two configured addresses, whatever the rows say');
  assert.equal(view.countKnown, true);
  assert.equal(view.title, 'Email 2 administrators?');

  // And the reverse: aliases present in the rows but not in ADMIN_EMAILS are
  // neither counted nor mailed.
  const wider = buildNoticeView({
    preview: { recipients: [{ alias: 'AdminDevs' }] },
    visibleCount: 6,
  });
  assert.equal(wider.count, 1);
  assert.equal(wider.title, 'Email 1 administrator?');
});

test('the title states no number until the real list is known', () => {
  assert.equal(noticeTitle(0, false), 'Email the credential-update notice?');
  assert.equal(noticeTitle(6, false), 'Email the credential-update notice?');
  assert.equal(noticeTitle(6, true), 'Email 6 administrators?');
  assert.equal(noticeTitle(1, true), 'Email 1 administrator?');
  assert.equal(noticeTitle(0, true), 'Email the credential-update notice?');
  assert.equal(noticeTitle(-4, true), 'Email the credential-update notice?');
});

test('a preview that has not resolved blocks the send without hiding the dialog', () => {
  const view = buildNoticeView({ preview: null, loading: true, visibleCount: 6 });
  assert.equal(view.status, 'loading');
  assert.equal(view.canSend, false);
  assert.match(view.blockedReason, /address list/i);
  // The rows are a placeholder for the title only, and are labelled as unknown.
  assert.equal(view.countKnown, false);
  assert.equal(view.title, 'Email the credential-update notice?');
});

test('a FAILED preview is its own state, not "no recipients"', () => {
  const view = buildNoticeView({ preview: null, loading: false, visibleCount: 6 });
  assert.equal(view.status, 'failed');
  assert.equal(view.canSend, false, 'never approve a list that could not be read');
  assert.match(view.blockedReason, /could not be loaded/i);
  assert.notEqual(view.status, 'empty', 'the two need different wording and different fixes');
});

test('a resolved preview with nobody configured is "empty", not "failed"', () => {
  const view = buildNoticeView({ preview: { recipients: [], missingEmail: ['AdminJoma'] } });
  assert.equal(view.status, 'empty');
  assert.equal(view.canSend, false);
  assert.equal(view.count, 0);
  assert.match(view.blockedReason, /no administrator has an address/i);
});

test('the send is available exactly when there is somebody to send it to', () => {
  assert.equal(buildNoticeView({ preview: PREVIEW }).canSend, true);
  // …and not while it is already running, or the operator's second click becomes
  // a duplicate notice to everybody.
  assert.equal(buildNoticeView({ preview: PREVIEW, sending: true }).canSend, false);
  assert.equal(buildNoticeView({ preview: PREVIEW, sending: true }).blockedReason, 'Sending the notice…');
});

test('the wording the operator typed is passed on, trimmed and capped', () => {
  const view = buildNoticeView({ preview: PREVIEW, description: '  Rotated on Tuesday.  ' });
  assert.equal(view.description, 'Rotated on Tuesday.');
  assert.equal(view.usingDefault, false);
});

test('a cleared field is stated as "the standard wording goes out", not as an empty mail', () => {
  const view = buildNoticeView({ preview: PREVIEW, description: '  ' });
  assert.equal(view.description, '');
  assert.equal(view.usingDefault, true);
  // Still sendable: the server owns a default and will use it.
  assert.equal(view.canSend, true);
  assert.match(noticeDescriptionHint(true), /standard wording/i);
  assert.match(noticeDescriptionHint(false), /no password or key/i);
});

test('a missing view-model input is renderable rather than fatal', () => {
  // The dialog is a security confirmation: a throw here would leave the operator
  // with no way to send and no explanation.
  const view = buildNoticeView();
  assert.equal(view.status, 'failed');
  assert.equal(view.canSend, false);
  assert.deepEqual(view.recipients, []);
  assert.deepEqual(view.missing, []);
  assert.equal(view.title, 'Email the credential-update notice?');
});