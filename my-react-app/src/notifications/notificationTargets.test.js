/**
 * NOTIFICATION TARGETS — where a bell sends you.
 *
 * Run: npm test
 *
 * Why this file exists: the bell used to decide for itself. UserNotifications
 * asked "is this an account-security notice?" and sent EVERYTHING ELSE to
 * /history, so "Support replied to your message" opened the assessment history.
 * Redirection is now data on the row (`link`), and this module is the one place
 * that reads it.
 *
 * These tests pin the three things that actually broke:
 *   1. a support notice resolves to /support, NOT /history
 *   2. the thread id survives, so the reply opens the right conversation
 *   3. a row with no resolvable target returns null rather than a wrong guess
 *      (the detail window then offers no redirect button at all)
 * plus the safety net for rows written before `link` existed, and the admin
 * console's tab/thread mapping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveUserTarget, resolveAdminTarget, timeAgo, categoryLabel } from './notificationTargets.js';

// ── The bug ────────────────────────────────────────────────────────────────

test('a support reply opens the support conversation, not the assessment history', () => {
  const item = {
    _id: 'n1',
    type: 'info',
    title: 'Support replied to your message',
    detail: '“Where did I pay?” — Try again in a private window.',
    link: '/support?thread=65fabc',
    linkLabel: 'Read the reply',
  };

  const target = resolveUserTarget(item);

  assert.equal(target.path, '/support?thread=65fabc');
  assert.equal(target.path.startsWith('/history'), false);
  assert.equal(target.label, 'Read the reply');
});

test('every support-chat notice carries its own thread id', () => {
  for (const title of ['Support replied to your message', 'Support conversation resolved', 'Support conversation reopened']) {
    const target = resolveUserTarget({
      _id: 'n2',
      type: 'info',
      title,
      detail: '',
      link: '/support?thread=abc123',
    });
    assert.equal(target.path, '/support?thread=abc123', title);
  }
});

// ── The server's answer always wins ────────────────────────────────────────

test('an explicit link beats the title, even when the title looks like another topic', () => {
  const target = resolveUserTarget({
    _id: 'n3',
    type: 'info',
    // "assessment" in the title, but the server routed it to support on purpose.
    title: 'Assessment report question',
    link: '/support?thread=zzz',
    linkLabel: 'Open the conversation',
  });
  assert.equal(target.path, '/support?thread=zzz');
});

test('a blank link falls back rather than producing an empty path', () => {
  const target = resolveUserTarget({ _id: 'n4', type: 'info', title: 'Password changed' });
  assert.equal(target.path, '/profile?section=security');
});

test('a label is always present so the redirect button is never nameless', () => {
  const target = resolveUserTarget({ _id: 'n5', type: 'info', title: 'Support replied to your message' });
  assert.ok(target.label.length > 0);
});

// ── Never route somewhere unsafe ───────────────────────────────────────────

test('a stored link that is not an app path is refused', () => {
  // A notification is data, and data can be stale or hostile. Absolute and
  // protocol-relative values must not become a navigation target.
  for (const link of [
    'https://evil.example/steal',
    '//evil.example/steal',
    '/\\evil.example',
    'javascript:alert(1)',
    '',
  ]) {
    const target = resolveUserTarget({
      _id: 'n6',
      type: 'info',
      title: 'Password changed',
      link,
    });
    // Falls through to the safety net, never to the hostile value.
    assert.notEqual(target?.path, link);
    assert.ok(!String(target?.path || '').includes('evil.example'));
    assert.ok(!String(target?.path || '').toLowerCase().includes('javascript:'));
  }
});

// ── Legacy rows: no link field at all ──────────────────────────────────────

test('a legacy support notice with no link still finds support', () => {
  const target = resolveUserTarget({
    _id: 'n7',
    type: 'info',
    title: 'Support replied to your message',
    detail: '',
  });
  assert.equal(target.path, '/support');
});

test('a legacy severe flag always lands on the assessment history', () => {
  const target = resolveUserTarget({ _id: 'n8', type: 'severe-flag', title: 'Anything at all' });
  assert.equal(target.path, '/history');
});

test('the shapes the server actually writes all resolve somewhere sensible', () => {
  // These are the exact titles the routes emit, so a row written before `link`
  // existed still lands on the right page.
  const cases = [
    ['Support replied to your message', '/support'],
    ['Support conversation resolved', '/support'],
    ['Support conversation reopened', '/support'],
    ['Your account has been restricted', '/support'],
    ['Health review flagged for your assessment', '/history'],
    ['Priority review completed', '/history'],
    ['Too many failed sign-in attempts', '/profile?section=security'],
    ['Password changed', '/profile?section=security'],
    ['A passkey was added to your account', '/profile?section=security'],
    ['A recovery code was used', '/profile?section=security'],
    ['ULTIMATE is now active', '/profile?section=billing'],
    ['PRO cancellation declined', '/profile?section=billing'],
    ['Blockchain record integrity issue', '/web3'],
    ['Blockchain records verified healthy again', '/web3'],
  ];
  for (const [title, path] of cases) {
    const target = resolveUserTarget({ _id: 'legacy', type: 'info', title });
    assert.equal(target?.path, path, title);
  }
});

test('an unrecognised legacy notice resolves to nothing, not to a wrong page', () => {
  // The old bug was exactly this: an unmatched title fell through to /history.
  // A notice we cannot place must offer NO redirect rather than a wrong one.
  const target = resolveUserTarget({
    _id: 'n9',
    type: 'info',
    title: 'Something entirely new',
    detail: '',
  });
  assert.equal(target, null);
});

test('a missing item is handled rather than thrown on', () => {
  assert.equal(resolveUserTarget(null), null);
  assert.equal(resolveUserTarget(undefined), null);
});

// ── The admin console ──────────────────────────────────────────────────────

test('a new support conversation opens Chat management on that thread', () => {
  const target = resolveAdminTarget({
    _id: 'e1',
    type: 'support-chat',
    title: 'New support conversation',
    link: 'chats?thread=thread-9',
    linkLabel: 'Open the conversation',
  });
  assert.equal(target.tab, 'chats');
  assert.equal(target.threadId, 'thread-9');
  assert.equal(target.label, 'Open the conversation');
});

test('each admin event type lands on the tab that can act on it', () => {
  const cases = [
    ['severe-flag', 'assessment-management'],
    ['resolved', 'assessment-management'],
    ['subscription-request', 'subscriptions'],
    ['subscription-cancel-request', 'subscriptions'],
    ['security', 'security'],
    ['new-device-login', 'security'],
    ['account', 'users'],
  ];
  for (const [type, tab] of cases) {
    const target = resolveAdminTarget({ _id: 'e2', type, title: 'Anything' });
    assert.equal(target.tab, tab, type);
  }
});

test('an admin link with no query still resolves to its bare tab', () => {
  const target = resolveAdminTarget({ _id: 'e3', type: 'support-chat', link: 'chats' });
  assert.equal(target.tab, 'chats');
  assert.equal(target.threadId, undefined);
});

test('an unknown admin tab is refused rather than sent somewhere arbitrary', () => {
  const target = resolveAdminTarget({ _id: 'e4', type: 'support-chat', link: 'delete-everything' });
  // Falls back to the type map, which knows where a support chat belongs.
  assert.equal(target.tab, 'chats');
});

test('an admin event nothing can act on resolves to nothing', () => {
  assert.equal(resolveAdminTarget({ _id: 'e5', type: 'made-up-type', link: 'nope' }), null);
  assert.equal(resolveAdminTarget(null), null);
});

// ── Presentation helpers ───────────────────────────────────────────────────

test('timeAgo renders every band without throwing on junk', () => {
  const now = Date.now();
  assert.equal(timeAgo(new Date(now).toISOString()), 'Just now');
  assert.equal(timeAgo(new Date(now - 5 * 60 * 1000).toISOString()), '5m ago');
  assert.equal(timeAgo(new Date(now - 3 * 3600 * 1000).toISOString()), '3h ago');
  assert.equal(timeAgo(new Date(now - 4 * 86400 * 1000).toISOString()), '4d ago');
  assert.equal(timeAgo(''), '');
  assert.equal(timeAgo(null), '');
  assert.equal(timeAgo('not a date'), '');
  assert.equal(timeAgo(undefined), '');
});

test('categoryLabel names the two consoles differently', () => {
  assert.equal(categoryLabel({ type: 'severe-flag' }, 'user'), 'Health review');
  assert.equal(categoryLabel({ type: 'info' }, 'user'), 'Notification');
  assert.equal(categoryLabel({ type: 'support-chat' }, 'admin'), 'Support chat');
  assert.equal(categoryLabel({ type: 'mystery' }, 'admin'), 'System');
  assert.equal(categoryLabel(null, 'user'), '');
});