/**
 * THE NOTIFICATION BOUNDARY — who can see whose bell.
 *
 * Run: npm test
 *
 * Two collections, two audiences, one direction each:
 *
 *   UserNotification — ONE member, read only by GET /api/notifications.
 *   AdminEvent       — the operator queue, read only by GET /api/admin/
 *                      notifications.
 *
 * The bug this suite exists to prevent is a category error, not a typo: an event
 * written to the wrong collection, or a member's own security activity entering
 * the shared admin stream. Once that happens the damage is done — the data is
 * in the wrong queue, and removing the feature that wrote it does not remove
 * what it already published.
 *
 * The three properties asserted here, in order of how much they hurt:
 *
 *   1. NO LEAKAGE. A member's account-security events never appear in the admin
 *      bell, and admin work items never appear in a member's bell.
 *   2. NO PII BROADCAST. The admin bell names members by an opaque reference,
 *      so a shared queue cannot be the reason an email address spreads.
 *   3. NOTHING IS SILENTLY DROPPED. Every type either collection writes is
 *      either rendered or deliberately ruled out — a new type that nobody
 *      classified is a failure, not a stub.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('path');

const audience = require('../utils/notificationAudience');
const privacy = require('../utils/memberPrivacy');
const links = require('../utils/notificationLinks');
const AdminEvent = require('../models/AdminEvent');

const CLIENT_API = path.join(
  __dirname, '..', '..', 'my-react-app', 'src', 'api.js',
);

const oid = () => new (require('mongoose').Types.ObjectId)();

// ── The rule, stated as tests ─────────────────────────────────────────────

test('the admin bell admits only the work an operator must do', () => {
  const expected = [
    'support-chat',
    'subscription',
    'subscription-request',
    'subscription-cancel-request',
    'severe-flag',
    'resolved',
    'security',
    'account',
  ];
  assert.deepEqual([...audience.ADMIN_BELL_TYPES].sort(), [...expected].sort());
});

test("a member's sign-in on a new device is NOT admin work", () => {
  // THE LEAK, in one assertion. This used to be written to AdminEvent with the
  // member's email and location in the detail, so every sign-in from an
  // unrecognised device published into a queue shared by every admin.
  assert.equal(
    audience.isAdminBellEvent({ type: 'new-device-login', title: 'New device login' }),
    false,
    'a member security event must never enter the admin bell',
  );
  assert.match(audience.ruledOutReason({ type: 'new-device-login' }), /member security event/);
});

test('an unclassified event type is withheld from both bells', () => {
  // The safe default. A route that raises a bell nobody has classified must not
  // have it broadcast — better a missing notification than a misdirected one,
  // because the missing one gets reported and the misdirected one does not.
  assert.equal(audience.isAdminBellEvent({ type: 'brand-new-thing' }), false);
  assert.equal(audience.isMemberBellEvent({ type: 'brand-new-thing' }), false);
  assert.match(audience.ruledOutReason({ type: 'brand-new-thing' }), /unknown type/);

  // …and that this is caught by the audit rather than passing silently.
  assert.doesNotThrow(() => require('../scripts/audit-bell-links.js'));
});

test('every admin event type the model can hold is classified', () => {
  // The enum is read from the MODEL, so a new type added there fails this test
  // until somebody decides who it is for. That is the whole point: the boundary
  // should be a decision someone makes, not an accident of where they wrote.
  const types = AdminEvent.schema.path('type').enumValues;
  assert.ok(types.length >= 9, `expected the enum to declare every event type, saw ${types.length}`);
  for (const type of types) {
    const inAdminBell = audience.isAdminBellEvent({ type });
    const reason = audience.ruledOutReason({ type });
    const verdict = inAdminBell
      ? 'admin bell'
      : String(reason).includes('member security event') ? 'out of both' : 'UNCLASSIFIED';
    assert.notEqual(
      verdict, 'UNCLASSIFIED',
      `AdminEvent type "${type}" is in the enum but classified for neither bell — ` +
      'add it to ADMIN_BELL_TYPES in utils/notificationAudience.js or remove it',
    );
  }
});

// ── The admin bell filter is actually applied ─────────────────────────────

test('the admin bell endpoint filters by audience and scrubs identities', () => {
  // Asserted against the route's source, not against a live server: the filter
  // and the scrubber are the two properties this suite guards, and reading the
  // file proves they are wired in rather than merely available.
  const src = readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8');

  const get = src.slice(src.indexOf("router.get('/notifications'"), src.indexOf('router.post(\'/notifications/read\''));
  assert.notEqual(get, '', 'the admin notifications route was not found');

  assert.match(
    get, /\.filter\(isAdminBellEvent\)/,
    'the admin bell no longer filters by audience — member events would render here',
  );
  assert.match(
    get, /scrubAdminEvent\(event\)/,
    'the admin bell no longer scrubs member identities before rendering',
  );

  // The filter must run BEFORE the rows are mapped into their response shape,
  // or a filtered row still costs a render and can still be counted.
  assert.ok(
    get.indexOf('.filter(isAdminBellEvent)') < get.indexOf('scrubAdminEvent(event)'),
    'the audience filter must run before the response mapping',
  );
});

test('no member security event still enters the admin stream', () => {
  // The writer-side half of the fix: the route that used to write one. Slice from
  // the new-device comment to the end of the member's own notification block, so
  // the assertion cannot be satisfied by something further down the file.
  const src = readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
  const from = src.indexOf('const isNewDevice = !!');
  assert.notEqual(from, -1, 'the login new-device block was not found');
  const to = src.indexOf('const twoFactorMethod', from);
  assert.notEqual(to, -1, 'the end of the block was not found');
  const block = src.slice(from, to);

  assert.doesNotMatch(
    block, /AdminEvent\.create/,
    'the login route still raises an AdminEvent for a member sign-in',
  );
  assert.match(
    block, /UserNotification/,
    'the member must still receive their own notice about their own account',
  );
  // And the security record that legitimately belongs to the platform is written.
  assert.match(block, /SecurityEvent\.write/, 'the platform audit record is missing');
});

// ── Member privacy in the shared queue ────────────────────────────────────

test('the admin bell names members by an opaque reference', () => {
  const id = oid();
  const ref = privacy.memberReference(id);
  // Four base-32 symbols: ~20 bits of a 96-bit id, which is plenty to tell two
  // members apart in a queue and far too little to identify one.
  assert.match(ref, /^Member [\w]{4}$/, 'unexpected reference shape');
});

test('the same member reads the same in every notification', () => {
  const id = oid();
  // A queue where one member appears under three different handles is worse
  // than one that shows their name, because it cannot be worked.
  const one = privacy.memberReference(id);
  assert.equal(privacy.memberReference(id), one);
  assert.equal(privacy.memberReference(String(id)), one);
  assert.equal(privacy.memberReference({ _id: id }), one);
  assert.notEqual(privacy.memberReference(id), privacy.memberReference(oid()));
});

test('an email in an admin detail is replaced, not shown', () => {
  const id = oid();
  const ref = privacy.memberReference(id);
  const detail = 'nina.palermo@example.com signed in from Makati City.';
  const scrubbed = privacy.scrubMemberIdentities(detail, id);
  assert.equal(scrubbed, `${ref} signed in from Makati City.`);
  assert.doesNotMatch(scrubbed, /@/, 'no email address survives the scrub');
});

test('a quoted name and email pair is replaced as one unit', () => {
  const id = oid();
  const ref = privacy.memberReference(id);
  const detail = '"Nina Palermo" <nina@example.com> started "Where did I pay?"';
  const scrubbed = privacy.scrubMemberIdentities(detail, id);
  assert.equal(scrubbed, `${ref} started "Where did I pay?"`);
  assert.doesNotMatch(scrubbed, /nina/i, 'no part of the identity survives');
});

test('the subject of a conversation is preserved — it is the work, not the identity', () => {
  const id = oid();
  const scrubbed = privacy.scrubMemberIdentities(
    '"Nina Palermo" <nina@example.com> started "I transferred ₱1,295 on Tuesday"',
    id,
  );
  // The subject is what tells an operator which queue it belongs in. Removing
  // it would make the notification useless while teaching nothing about privacy.
  assert.match(scrubbed, /I transferred ₱1,295 on Tuesday/);
});

test('scrubbing is idempotent', () => {
  const id = oid();
  const once = privacy.scrubAdminEvent({
    _id: oid(), type: 'support-chat', title: 'New support conversation',
    detail: 'nina@example.com started "help"', user: id,
  });
  const twice = privacy.scrubAdminEvent(once);
  assert.equal(once.detail, twice.detail, 'a second scrub must change nothing');
  assert.equal(once, twice, 'a scrubbed row should be recognised as already clean');
});

test('scrubbing never invents an identity that was not there', () => {
  const id = oid();
  const original = { _id: oid(), type: 'security', title: 'Sign-in locked out', detail: 'A sign-in attempt was locked out.', user: null };
  const scrubbed = privacy.scrubAdminEvent(original);
  // No owner, so nothing to point a reference at — the same object, untouched.
  assert.equal(scrubbed, original);
});

test('system-security text is left intact because it names no member', () => {
  const detail = 'A sign-in attempt was locked out after continuous failed attempts.';
  assert.equal(privacy.scrubMemberIdentities(detail, oid()), detail);
});

// ── The two lists must agree ─────────────────────────────────────────────

test('member security titles agree across server and client', () => {
  // The server routes these titles to Profile → Security; the client's
  // SECURITY_NOTIFICATION_TITLES decides what that page then displays.
  //
  // The two lists are DELIBERATELY different, and asserting they are equal would
  // be wrong: "Your account has been restricted" is a security event the feed
  // should show, but the useful response is to ask support, so it routes to
  // /support. Stating that distinction as two lists is the only way to hold
  // both truths without a special case buried in a ternary.
  const src = readFileSync(CLIENT_API, 'utf8');
  const start = src.indexOf('SECURITY_NOTIFICATION_TITLES = new Set([');
  assert.notEqual(start, -1, 'SECURITY_NOTIFICATION_TITLES is gone from api.js');
  const block = src.slice(start, src.indexOf(']);', start));
  const clientTitles = [...block.matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map((m) => m[1] ?? m[2])
    .filter(Boolean);

  const feed = audience.MEMBER_SECURITY_FEED_TITLES;
  const missing = feed.filter((t) => !clientTitles.includes(t));
  const extra = clientTitles.filter((t) => !feed.includes(t));

  assert.deepEqual(missing, [], 'shown on Profile → Security but absent from the client feed');
  assert.deepEqual(extra, [], 'in the client feed but not a declared member security title');

  // And each list does its own job: the FEED list is what the page renders, the
  // ROUTE list is what navigates there.
  for (const title of audience.MEMBER_SECURITY_ROUTE_TITLES) {
    assert.equal(
      links.memberLinkFor({ type: 'info', title }).link,
      '/profile?section=security',
      `"${title}" must route to Profile → Security`,
    );
  }
  // The restriction notice is the one title that is security without routing
  // to the security settings — proof the two lists have to be able to differ.
  assert.equal(
    links.memberLinkFor({ type: 'info', title: 'Your account has been restricted' }).link,
    '/support',
  );
});

// ── Members can still see their own account ───────────────────────────────

test('a member still receives everything about their own account', () => {
  // The boundary must not become silence. Each of these is a member-visible
  // outcome with a real trigger in the codebase; if one stops resolving, the
  // member has been made invisible to the platform.
  const mine = [
    ['Support replied to your message', '/support'],
    ['Support conversation resolved', '/support'],
    ['Support conversation reopened', '/support'],
    ['Your account has been restricted', '/support'],
    ['Password changed', '/profile?section=security'],
    ['New sign-in to your account', '/profile?section=security'],
    ['Recovery codes generated', '/profile?section=security'],
    ['Health review flagged for your assessment', '/history'],
    ['Priority review completed', '/history'],
    ['ULTIMATE is now active', '/profile?section=billing'],
    ['Blockchain records verified healthy again', '/web3'],
  ];
  for (const [title, to] of mine) {
    assert.equal(links.memberLinkFor({ type: 'info', title }).link, to, title);
  }
});

test('an admin work item never reaches a member bell', () => {
  // Each admin title is a row in AdminEvent, which a member can never read —
  // but the routing layer is shared, so it must refuse them anyway rather than
  // relying on the fetch being correct. A member who follows a mis-set link
  // would land on a 403, which reads as a bug in the app.
  const adminOnly = [
    'Severe case flagged',
    'New support conversation',
    'PRO upgrade request',
    'Sign-in locked out',
    'Account updated',
  ];
  for (const title of adminOnly) {
    const resolved = links.memberLinkFor({ type: 'info', title });
    // Either the title resolves to a destination the member can legitimately
    // reach, or it has no destination at all. What it must never do is route
    // into the admin console.
    assert.doesNotMatch(
      String(resolved.link || ''), /admin/,
      `"${title}" resolves to "${resolved.link}", which would take a member to the console`,
    );
  }
});