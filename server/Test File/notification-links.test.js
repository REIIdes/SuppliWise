/**
 * NOTIFICATION LINKS — the server's answer to "where does this send me?".
 *
 * Run: npm test
 *
 * THE BUG THIS PREVENTS: a notification's destination was decided in the
 * browser by matching its title, and the match list did not include support.
 * "Support replied to your message" therefore fell through to a `/history`
 * default — a support reply opened the assessment history.
 *
 * Every writer stamps `link` (scripts/audit-bell-links.js fails if one stops),
 * so this module only has to answer for rows written before the field existed.
 * That is exactly what it is tested for here: a row with NO stored link must
 * still come out of the API pointing somewhere sensible, and a row whose title
 * means nothing must come out with nowhere to go rather than somewhere wrong.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const {
  memberLinkFor,
  adminLinkFor,
  withLinks,
  ADMIN_TABS,
} = require('../utils/notificationLinks');

const label = (item) => memberLinkFor(item).link;
const adminTab = (item) => adminLinkFor(item).link;

// ── The bug ────────────────────────────────────────────────────────────────

test('a support reply resolves to support, not the assessment history', () => {
  const resolved = memberLinkFor({
    type: 'info',
    title: 'Support replied to your message',
  });
  assert.equal(resolved.link, '/support');
  assert.notEqual(resolved.link, '/history');
  assert.ok(resolved.linkLabel.length > 0);
});

// ── A stored link always wins ──────────────────────────────────────────────

test('a stored link beats the title, even when the title points elsewhere', () => {
  const resolved = memberLinkFor({
    type: 'info',
    title: 'Assessment report question',
    link: '/support?thread=65fabc',
    linkLabel: 'Open the conversation',
  });
  assert.equal(resolved.link, '/support?thread=65fabc');
  assert.equal(resolved.linkLabel, 'Open the conversation');
});

test('a stored link with no label still yields a label', () => {
  const resolved = memberLinkFor({ title: 'Anything', link: '/support' });
  assert.equal(resolved.link, '/support');
  // Empty is legitimate here: the client supplies its own default button text.
  assert.equal(resolved.linkLabel, '');
});

test('a blank stored link falls back to the title', () => {
  assert.equal(label({ type: 'info', title: 'Password changed', link: '   ' }), '/profile?section=security');
});

// ── Every family the server writes ─────────────────────────────────────────

test('every title the server writes resolves somewhere sensible', () => {
  // Each of these is a title a real route emits. If one ever stops resolving,
  // that bell is inert and the only symptom is a button that is not there.
  const cases = [
    // Support
    ['Support replied to your message', '/support'],
    ['Support conversation resolved', '/support'],
    ['Support conversation reopened', '/support'],
    ['Your account has been restricted', '/support'],
    // Assessments
    ['Health review flagged for your assessment', '/history'],
    ['Priority review completed', '/history'],
    ['Priority review reinstated', '/history'],
    ['Your assessment was paused for priority review', '/history'],
    // Security
    ['Too many failed sign-in attempts', '/profile?section=security'],
    ["You're back online", '/profile?section=security'],
    ['Password changed', '/profile?section=security'],
    ['Two-factor authentication enabled', '/profile?section=security'],
    ['Two-factor authentication disabled', '/profile?section=security'],
    ['Two-factor method changed', '/profile?section=security'],
    ['New sign-in to your account', '/profile?section=security'],
    ['Signed out other devices', '/profile?section=security'],
    ['A passkey was added to your account', '/profile?section=security'],
    ['A passkey was removed from your account', '/profile?section=security'],
    ['Recovery codes generated', '/profile?section=security'],
    ['Recovery codes replaced', '/profile?section=security'],
    ['A recovery code was used', '/profile?section=security'],
    ['Backup codes generated', '/profile?section=security'],
    ['Recovery email changed', '/profile?section=security'],
    // Billing
    ['ULTIMATE is now active', '/profile?section=billing'],
    ['PRO cancellation declined', '/profile?section=billing'],
    ['ULTIMATE cancelled', '/profile?section=billing'],
    // Ledger
    ['Blockchain record integrity issue', '/web3'],
    ['Blockchain records verified healthy again', '/web3'],
  ];
  for (const [title, path] of cases) {
    assert.equal(label({ type: 'info', title }), path, title);
  }
});

test('a severe flag lands on the assessment history whatever the title says', () => {
  assert.equal(label({ type: 'severe-flag', title: 'Anything at all' }), '/history');
});

test('an unplaceable notice resolves to nowhere rather than somewhere wrong', () => {
  // THE original defect, in its purest form: an unmatched title used to fall
  // through to /history. Now it produces no link at all, and the client shows
  // no redirect button instead of a wrong one.
  const resolved = memberLinkFor({ type: 'info', title: 'Something entirely new' });
  assert.equal(resolved.link, '');
  assert.equal(resolved.linkLabel, '');
});

test('a missing or junk notification is handled rather than thrown on', () => {
  for (const input of [null, undefined, {}, { title: '' }, { title: null }, 'nope', 42]) {
    assert.doesNotThrow(() => memberLinkFor(input));
    assert.equal(memberLinkFor(input).link, '');
  }
});

// ── The admin bell ─────────────────────────────────────────────────────────

test('every AdminEvent type lands on the tab that can act on it', () => {
  // Read the enum from the MODEL, not from a hand-copied list: a new type added
  // there without a route here is exactly how an admin bell goes inert, and a
  // copied list would never notice.
  const AdminEvent = require('../models/AdminEvent');
  const types = AdminEvent.schema.path('type').enumValues;
  assert.ok(types.length >= 9, `expected the enum to declare every event type, saw ${types.length}`);
  for (const type of types) {
    const tab = adminTab({ type });
    assert.ok(ADMIN_TABS.includes(tab), `type "${type}" resolves to "${tab}", which is not a console tab`);
  }
});

test('a support-chat event resolves to Chat management', () => {
  assert.equal(adminTab({ type: 'support-chat' }), 'chats');
  assert.equal(adminLinkFor({ type: 'support-chat' }).linkLabel, 'Open the conversation');
});

test('a stored admin link keeps its query, so a thread still deep-links', () => {
  const resolved = adminLinkFor({ type: 'support-chat', link: 'chats?thread=abc123' });
  assert.equal(resolved.link, 'chats?thread=abc123');
});

test('a stored admin link naming a tab that no longer exists is discarded', () => {
  // A route can be renamed. A stale link that navigated somewhere meaningless is
  // the same class of bug as the original, so the type map is used instead.
  assert.equal(adminTab({ type: 'support-chat', link: 'delete-everything' }), 'chats');
  assert.equal(adminTab({ type: 'severe-flag', link: 'not-a-tab?x=1' }), 'assessment-management');
});

test('an admin event nothing can act on resolves to nowhere', () => {
  assert.equal(adminTab({ type: 'made-up-type' }), '');
  assert.equal(adminTab(null), '');
});

// ── withLinks: the read-path helper ────────────────────────────────────────

test('withLinks fills gaps and leaves settled rows untouched', () => {
  const stored = { _id: 'a', title: 'Support replied to your message', link: '/support?thread=1', linkLabel: 'Read the reply' };
  const legacy = { _id: 'b', title: 'Password changed' };
  const blank = { _id: 'c', title: 'Mystery notice', link: '' };
  const out = withLinks([stored, legacy, blank], memberLinkFor);

  // Already-correct rows come back as the SAME object, so a caller can compare
  // by identity and know nothing was rewritten.
  assert.equal(out[0], stored);
  assert.equal(out[1].link, '/profile?section=security');
  assert.equal(out[2].link, '', 'an unplaceable row stays unplaceable');
});

test('withLinks never mutates its input', () => {
  const rows = [{ _id: 'a', title: 'Password changed' }];
  const snapshot = JSON.stringify(rows);
  withLinks(rows, memberLinkFor);
  assert.equal(JSON.stringify(rows), snapshot, 'lean() documents must come back untouched');
});

test('withLinks survives a junk array', () => {
  for (const input of [null, undefined, 'nope', 42]) {
    assert.deepEqual(withLinks(input, memberLinkFor), []);
  }
  assert.deepEqual(withLinks([null, undefined], memberLinkFor), [null, undefined]);
});

// ── The client and the server must agree ───────────────────────────────────

test('colour can never disagree with the redirect', () => {
  // The accent family a notification wears is DERIVED from the destination the
  // client resolved, so "a violet support row" and "this opens support" cannot
  // be two independent opinions. This pins that for both consoles.
  const { visualKind } = readClientResolver();

  // A member notice's colour follows where it sends you.
  const cases = [
    ['Support replied to your message', '/support', 'support'],
    ['Password changed', '/profile?section=security', 'security'],
    ['ULTIMATE is now active', '/profile?section=billing', 'billing'],
    ['Blockchain records verified healthy again', '/web3', 'chain'],
  ];
  for (const [title, path, family] of cases) {
    const item = { type: 'info', title, link: path };
    assert.equal(visualKind(item, 'user'), family, title);
  }

  // A severe flag is health in BOTH consoles, whatever else it is about.
  assert.equal(visualKind({ type: 'severe-flag', title: 'anything' }, 'user'), 'health');
  assert.equal(visualKind({ type: 'severe-flag', title: 'anything' }, 'admin'), 'health');
  // …and a `resolved` event is the same story told after the fact.
  assert.equal(visualKind({ type: 'resolved', title: 'Priority auto-resolved' }, 'admin'), 'assessment');

  // An admin notice's colour follows its type.
  assert.equal(visualKind({ type: 'support-chat', title: 'x' }, 'admin'), 'support');
  assert.equal(visualKind({ type: 'subscription-request', title: 'x' }, 'admin'), 'billing');
  assert.equal(visualKind({ type: 'new-device-login', title: 'x' }, 'admin'), 'security');
  assert.equal(visualKind({ type: 'account', title: 'x' }, 'admin'), 'account');

  // An unknown row must fall back to 'info', never to a family that implies a
  // destination it does not have.
  assert.equal(visualKind({ type: 'info', title: 'Something entirely unknown' }, 'user'), 'info');
  assert.equal(visualKind(null, 'user'), 'info');

  // Every family must be one the stylesheet actually defines, or the row falls
  // back to the neutral tokens and looks broken rather than plain. This list is
  // the .nd-kind-* selectors in notifications/notificationAccents.css.
  const KNOWN = new Set([
    'support', 'security', 'health', 'assessment', 'billing', 'chain', 'account', 'info',
  ]);
  const probes = [
    ...cases.map(([title, path]) => ({ type: 'info', title, link: path })),
    { type: 'severe-flag', title: 'x' },
    { type: 'info', title: 'Something entirely unknown' },
    { type: 'support-chat', title: 'x' },
    { type: 'made-up-type', title: 'x' },
    {},
    null,
    undefined,
  ];
  for (const probe of probes) {
    for (const side of ['user', 'admin']) {
      const family = visualKind(probe, side);
      assert.ok(KNOWN.has(family), `${JSON.stringify(probe)} produced unknown family "${family}"`);
    }
  }

  // And the stylesheet really does define every family the resolver can return.
  const css = readFileSync(
    require('path').join(
      __dirname, '..', '..', 'my-react-app', 'src', 'notifications', 'notificationAccents.css',
    ),
    'utf8',
  );
  for (const family of KNOWN) {
    assert.ok(
      css.includes(`.nd-kind-${family}`),
      `notificationAccents.css has no .nd-kind-${family} rule, so that family renders unstyled`,
    );
  }
});

test('the client resolver agrees with this one on every shared case', () => {
  // The client keeps its own copy so an OLD server cannot leave a bell inert.
  // That is only safe if the two never disagree, which is what this pins.
  const client = readClientResolver();

  const titles = [
    'Support replied to your message',
    'Support conversation resolved',
    'Health review flagged for your assessment',
    'Password changed',
    'Two-factor authentication enabled',
    'A passkey was added to your account',
    'A recovery code was used',
    'ULTIMATE is now active',
    'Blockchain records verified healthy again',
  ];
  for (const title of titles) {
    assert.equal(
      client.resolveUserTarget({ type: 'info', title })?.path,
      label({ type: 'info', title }),
      `client and server disagree about "${title}"`,
    );
  }

  // And on the case that started all of this: neither may answer /history for
  // a support notice.
  for (const title of titles.filter((t) => /support/i.test(t))) {
    assert.notEqual(label({ type: 'info', title }), '/history', title);
  }
});

test('every title routed to Profile → Security also appears in the activity feed', () => {
  // Two lists describe the same family from opposite ends of the stack: the
  // server's routes those titles to Profile → Security, and the client's
  // SECURITY_NOTIFICATION_TITLES decides what the Profile page LABELS as
  // security activity. If a title is in the first and not the second, the bell
  // sends somebody to a page that then pretends the event never happened — so
  // that direction is asserted.
  //
  // The REVERSE is deliberately not asserted. The two answer different
  // questions, and they legitimately differ: "Your account has been
  // restricted" belongs in an account-activity feed, but the useful action for
  // it is Contact support, so it routes to /support rather than to the security
  // settings it does not concern.
  const serverTitles = new Set(require('../utils/notificationLinks').SECURITY_TITLES);
  const clientTitles = readClientSecurityTitles();

  const missing = [...serverTitles].filter((t) => !clientTitles.has(t));
  assert.deepEqual(missing, [], 'routed to Profile → Security but absent from the Profile activity feed');
  assert.ok(serverTitles.size >= 17, `expected the security family to be fully enumerated, saw ${serverTitles.size}`);
});

/**
 * Pulls SECURITY_NOTIFICATION_TITLES out of my-react-app/src/api.js.
 *
 * api.js cannot simply be imported here: it is ESM, it pulls in axios and a
 * dozen app modules, and evaluating it would test the import graph rather than
 * the list. Reading the declaration is enough, and a rename makes this fail
 * loudly instead of quietly comparing nothing.
 */
function readClientSecurityTitles() {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'my-react-app', 'src', 'api.js'),
    'utf8',
  );
  const start = source.indexOf('SECURITY_NOTIFICATION_TITLES = new Set([');
  assert.notEqual(start, -1, 'SECURITY_NOTIFICATION_TITLES is gone from api.js — update this test');
  const end = source.indexOf(']);', start);
  assert.notEqual(end, -1, 'SECURITY_NOTIFICATION_TITLES is no longer a Set literal — update this test');
  const block = source.slice(start, end);
  // Both quote styles: "You're back online" is double-quoted precisely BECAUSE
  // of the apostrophe, and a single-quote-only pattern would match straight
  // through it and pair up the wrong strings.
  const titles = [...block.matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter((t) => t && !t.includes('_') || t.includes(' '));
  assert.ok(titles.length > 0, 'no titles parsed — update this test');
  return new Set(titles);
}

/**
 * The client module is ESM and this suite is CommonJS, so it is read as text
 * and evaluated rather than imported. That also means the comparison is against
 * the file as it exists on disk — a rename or a broken import shows up here
 * rather than as a silently skipped assertion.
 */
function readClientResolver() {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(
    __dirname, '..', '..', 'my-react-app', 'src', 'notifications', 'notificationTargets.js',
  );
  const source = fs.readFileSync(file, 'utf8');
  const body = source
    .replace(/^\s*import[^;]*;\s*$/gm, '')
    .replace(/^\s*export\s+(function|const)\s+/gm, '$1 ')
    // Re-attach the named exports, which `export` normally does for us.
    + '\nmodule.exports = { resolveUserTarget, resolveAdminTarget, timeAgo, categoryLabel, visualKind, visualKindOf };';
  const module_ = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', body)(module_, module_.exports);
  assert.equal(
    typeof module_.exports.resolveUserTarget, 'function',
    'the client resolver is missing or no longer exported — check the path in this test',
  );
  return module_.exports;
}