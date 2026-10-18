/**
 * WHO A NOTIFICATION IS FOR — the boundary between the two bells.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * Two collections, two audiences, one direction each:
 *
 *   UserNotification — ONE member. Read only by GET /api/notifications, always
 *                      filtered to `user: req.user._id`.
 *   AdminEvent       — shared admin stream. Read only by GET /api/admin/
 *                      notifications.
 *
 * The spec, stated so a future route cannot misread it:
 *
 *   ADMIN sees work they must DO:
 *     · lockouts (somebody is attacking the platform)
 *     · priority assessments flagged for review
 *     · subscription and cancellation requests to approve or decline
 *     · system security: config posture, chain integrity, brute-force attempts
 *
 *   MEMBER sees work about THEIR OWN account:
 *     · account security — password, 2FA, passkeys, recovery codes, sign-ins
 *     · support replies and thread state
 *     · ledger alerts and feature updates
 *     · review and plan outcomes
 *
 * What the admin must NOT see, and the member must not be told about each
 * other: the member's own security events are the member's business. A new
 * device sign-in rings the MEMBER's bell. It is not an admin's work item, so it
 * never enters the admin stream.
 *
 * ── Why enforcement lives here ──────────────────────────────────────────────
 *
 * A boundary stated only in prose is a boundary that erodes the first time
 * somebody adds a route. So the rule is a function, and the read endpoints and
 * the test suite both call it. A new event type is invisible in the admin bell
 * until it is added to ADMIN_BELL_TYPES below — which is exactly the friction
 * that makes the next person ask "who is this for?". Until then the safe
 * default is that nobody outside the intended audience sees it.
 */

/** Event types the admin bell renders. Anything else is audit, not work. */
const ADMIN_BELL_TYPES = new Set([
  'support-chat',
  'subscription',
  'subscription-request',
  'subscription-cancel-request',
  'severe-flag',
  'resolved',
  // Medical review is admin work: an operator must approve it or ask the
  // member for more information, so its bell events live in the same queue
  // as the priority flags they escalate from.
  'medical-review-requested',
  'medical-review-approved',
  'medical-review-needs-info',
  // The system-security family. NOTE what is absent: 'new-device-login'. A
  // member signing in on a new device is that member's security event — they
  // already get it in their own bell — and it is not work for an operator.
  'security',
  'account',
]);

/**
 * Member-bell titles, listed so the boundary is testable from either side.
 * Kept in step with SECURITY_TITLES and MEMBER_ROUTES in
 * server/utils/notificationLinks.js — a test asserts the two agree.
 */
const MEMBER_BELL_TYPES = new Set([
  'info',
  'severe-flag',
  // The member's own copy of the medical-review flow — the same events the
  // operator sees as work, the member sees as their review's progress.
  'medical-review-requested',
  'medical-review-approved',
  'medical-review-needs-info',
]);

/**
 * True when this event belongs in the admin bell.
 *
 * `security` is deliberately the ONLY system-security type an operator acts on:
 * it is raised for platform posture (config warnings, chain integrity, admin
 * lockouts), never for one member's sign-in.
 *
 * @param {{type?: string}} event
 * @returns {boolean}
 */
function isAdminBellEvent(event) {
  if (!event || typeof event !== 'object') return false;
  return ADMIN_BELL_TYPES.has(String(event.type));
}

/**
 * True when this row belongs in a member's bell.
 *
 * Both bells share the `severe-flag` type, so it is allowed on both sides. That
 * is intentional and not a leak: the member's copy says "your assessment was
 * flagged for priority review", while the admin's copy says "a case was
 * flagged" and links to the review queue.
 *
 * @param {{type?: string}} item
 * @returns {boolean}
 */
function isMemberBellEvent(item) {
  if (!item || typeof item !== 'object') return false;
  return MEMBER_BELL_TYPES.has(String(item.type));
}

/**
 * The reason an event was withheld, for logs and for the test suite. Returns
 * null when the event is correctly placed.
 */
function ruledOutReason(event) {
  if (!event) return 'no event';
  const type = String(event.type);
  if (ADMIN_BELL_TYPES.has(type)) return null;
  if (type === 'new-device-login') {
    return "member security event — belongs to the member's bell, not the admin's";
  }
  return `unknown type "${type}" — not declared for either bell`;
}

// A restriction is a support question (an admin removed your access, and the
// thing to do is ask why), so it routes to support — but it is still a
// member-security event and must appear in the Profile security feed. It is
// deliberately in SECURITY_TITLES for ROUTING reasons and in
// MEMBER_SECURITY_FEED_TITLES for FEED reasons; the two lists are not the same
// and neither is wrong.
const MEMBER_SECURITY_ROUTE_TITLES = [
  'Too many failed sign-in attempts',
  "You're back online",
  'Your account is active again',
  'Two-factor authentication enabled',
  'Two-factor authentication disabled',
  'Two-factor method changed',
  'Password changed',
  'New sign-in to your account',
  'Signed out other devices',
  'A passkey was added to your account',
  'A passkey was removed from your account',
  'Recovery codes generated',
  'Recovery codes replaced',
  'A recovery code was used',
  'Backup codes generated',
  'Recovery email changed',
  'Recovery phone changed',
];

/**
 * Titles shown in the Profile "Recent security activity" feed. Exactly the
 * routing list PLUS the restriction notices, which belong to security as an
 * event while still pointing at support as the action.
 */
const MEMBER_SECURITY_FEED_TITLES = [
  ...MEMBER_SECURITY_ROUTE_TITLES,
  'Your account has been restricted',
];

module.exports = {
  ADMIN_BELL_TYPES,
  MEMBER_BELL_TYPES,
  MEMBER_SECURITY_ROUTE_TITLES,
  MEMBER_SECURITY_FEED_TITLES,
  isAdminBellEvent,
  isMemberBellEvent,
  ruledOutReason,
};