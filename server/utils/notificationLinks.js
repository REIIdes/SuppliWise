/**
 * WHERE A NOTIFICATION SENDS YOU — the server-side answer.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * `link` is written by whichever route raises a bell, and every writer in the
 * system does write one (see scripts/audit-bell-links.js, which fails the build
 * if one ever stops). But rows written BEFORE the field existed are still in
 * the database, and a client that cannot place one used to guess — and the
 * guess is what sent a support reply to the assessment history.
 *
 * So the guess lives HERE, once, on the server, and runs on the way out of
 * every read. A row with no stored link still arrives with a correct one, which
 * means every consumer is fixed at the source rather than one screen at a time.
 *
 * The client keeps its own copy (my-react-app/src/notifications/
 * notificationTargets.js) purely so an older server cannot leave a bell
 * inert. It is a fallback, never the authority.
 *
 * ── Deriving, not storing ────────────────────────────────────────────────────
 *
 * Nothing here is written back to the database. A destination is a pure
 * function of what the notice IS, so recomputing it per read is always correct
 * and can never drift from a stale copy — unlike a migration that stamps rows
 * once and is then wrong the moment the wording changes. The stored `link` is
 * still preferred, because only the raising route knows the parts a title
 * cannot carry: a support thread id, an assessment id.
 */

// ── Member destinations ───────────────────────────────────────────────────
// Ordered: the first match wins, so the EXACT titles come before the broad
// patterns. Exact-first is what makes this reliable — a broad pattern can be
// forgotten ("You're back online" mentions none of the security words), and a
// forgotten pattern is a bell with no redirect button and no symptom beyond
// its absence. Every title below is a title the server itself writes.

// Account security, listed exactly. Keep in step with SECURITY_NOTIFICATION_
// TITLES in my-react-app/src/api.js, which labels the same rows for the
// Profile page's security feed — and with MEMBER_SECURITY_TITLES in
// utils/notificationAudience.js. Tests assert all three agree.
const SECURITY_TITLES = [
  'Too many failed sign-in attempts',
  "You're back online",
  'Your account is active again',
  'Password changed',
  'Two-factor authentication enabled',
  'Two-factor authentication disabled',
  'Two-factor method changed',
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

const MEMBER_ROUTES = [
  // Support. The bug this whole change exists to fix.
  { match: /^support replied to your message$/i, path: '/support', label: 'Read the reply' },
  { match: /^support conversation resolved$/i, path: '/support', label: 'View the conversation' },
  { match: /^support conversation reopened$/i, path: '/support', label: 'Reply now' },
  { match: /^your account has been restricted$/i, path: '/support', label: 'Contact support' },

  // Account security — exact, then a broad sweep for any wording added later.
  ...SECURITY_TITLES.map((title) => ({
    match: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
    path: '/profile?section=security',
    label: 'Review your account security',
  })),
  {
    match: /sign-in|password|two-factor|authenticator|passkey|recovery code|backup code|recovery email|recovery phone|new device|device|session|locked out/i,
    path: '/profile?section=security',
    label: 'Review your account security',
  },

  // The ledger.
  { match: /blockchain|ledger|chain record/i, path: '/web3', label: 'View the blockchain ledger' },

  // Assessments and intake.
  { match: /priority|assessment|health review|intake/i, path: '/history', label: 'View the assessment' },

  // Plans and billing.
  { match: /plan|subscription|payment|billing|upgrade|refund|cancel/i, path: '/profile?section=billing', label: 'View your plan' },
  { match: /is now active/i, path: '/profile?section=billing', label: 'View your plan' },
];

/**
 * The destination for one member notification.
 *
 * A stored `link` always wins — only the route that raised the bell knows the
 * ids inside it. Otherwise the title decides, and an unrecognised title returns
 * an EMPTY link, which the client renders as "nowhere to go" rather than
 * sending the member somewhere wrong.
 *
 * @param {{type?: string, title?: string, link?: string, linkLabel?: string}} item
 * @returns {{link: string, linkLabel: string}}
 */
function memberLinkFor(item) {
  const stored = typeof item?.link === 'string' ? item.link.trim() : '';
  if (stored) {
    return { link: stored, linkLabel: item.linkLabel || '' };
  }

  // A severe flag is always about an assessment, whatever the title says.
  if (item?.type === 'severe-flag') {
    return { link: '/history', linkLabel: 'View the flagged assessment' };
  }

  const title = String(item?.title || '');
  for (const route of MEMBER_ROUTES) {
    if (route.match.test(title)) return { link: route.path, linkLabel: route.label };
  }
  return { link: '', linkLabel: '' };
}

// ── Admin destinations ───────────────────────────────────────────────────
// Tab ids are the `tab` values in my-react-app/src/Pages/AdminDashboard.jsx.
// Mirrors the AdminEvent type enum in server/models/AdminEvent.js — a new type
// must be added here or its bell becomes inert.

const ADMIN_ROUTES = {
  'support-chat': { tab: 'chats', label: 'Open the conversation' },
  'subscription-request': { tab: 'subscriptions', label: 'Review the request' },
  'subscription-cancel-request': { tab: 'subscriptions', label: 'Open Subscription management' },
  subscription: { tab: 'subscriptions', label: 'Open Subscription management' },
  'severe-flag': { tab: 'assessment-management', label: 'Open Assessment Management' },
  resolved: { tab: 'assessment-management', label: 'Open Assessment Management' },
  'new-device-login': { tab: 'security', label: 'Open the Security center' },
  security: { tab: 'security', label: 'Open the Security center' },
  account: { tab: 'users', label: 'Open User management' },
};

const ADMIN_TABS = [
  'overview', 'users', 'admins', 'subscriptions', 'chats',
  'assessment-management', 'ai', 'profile', 'security',
];

/**
 * The destination for one admin event.
 *
 * A stored `link` wins and may carry a query (`chats?thread=…`) naming one
 * specific conversation. A stored value naming a tab that no longer exists is
 * DISCARDED rather than obeyed — a route can be renamed, and a stale link that
 * navigated somewhere meaningless is the same class of bug as the original.
 *
 * @param {{type?: string, link?: string, linkLabel?: string}} event
 * @returns {{link: string, linkLabel: string}}
 */
function adminLinkFor(event) {
  const stored = typeof event?.link === 'string' ? event.link.trim() : '';
  if (stored) {
    const tab = stored.split('?')[0].trim();
    if (ADMIN_TABS.includes(tab)) {
      return { link: stored, linkLabel: event.linkLabel || '' };
    }
  }
  const route = ADMIN_ROUTES[event?.type];
  if (route) return { link: route.tab, linkLabel: event.linkLabel || route.label };
  return { link: '', linkLabel: '' };
}

/**
 * Fill in a destination on a list of rows without mutating them.
 *
 * Deliberately pure: these are `.lean()` documents read straight from Mongo,
 * and writing to them here would mean the caller cannot tell what came from the
 * database and what came from this function.
 *
 * @param {Array<object>} rows
 * @param {(item: object) => {link: string, linkLabel: string}} resolve
 * @returns {Array<object>}
 */
function withLinks(rows, resolve) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    if (!row || typeof row !== 'object') return row;
    const { link, linkLabel } = resolve(row);
    // Never overwrite a stored value with a blank one — a row that had a link
    // keeps it, and only genuinely undirected rows come back with ''.
    if (row.link && !link) return row;
    if (row.link === link && row.linkLabel === linkLabel) return row;
    return { ...row, link, linkLabel: linkLabel || row.linkLabel || '' };
  });
}

module.exports = {
  memberLinkFor,
  adminLinkFor,
  withLinks,
  MEMBER_ROUTES,
  ADMIN_ROUTES,
  ADMIN_TABS,
  SECURITY_TITLES,
};