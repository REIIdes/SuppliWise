/**
 * WHERE A NOTIFICATION SENDS YOU — the one place that decides it.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * The bell used to hard-code its destination: `handleItemClick` in
 * UserNotifications.jsx asked "is this an account-security notice?" and sent
 * everything else to `/history`. So a support reply — "Support replied to your
 * message" — opened the assessment history. That is the bug this module exists
 * to make impossible to reintroduce: redirection is DATA, carried on the
 * notification itself (`link` / `linkLabel`, written by whichever route raised
 * the bell), not a guess made from the title string.
 *
 * The server is the authority. The title/type maps below are only a safety net
 * for rows written before those fields existed, and for the live config warnings
 * the admin bell synthesises per request.
 *
 * ── The contract ─────────────────────────────────────────────────────────────
 *
 *   resolveUserTarget(item)  → { path: '/support?thread=…', label: '…' } | null
 *   resolveAdminTarget(item) → { tab: 'chats', threadId?: '…', label: '…' } | null
 *
 * `null` means "nowhere to go". The detail window then shows the message and
 * offers only Mark as read / Delete — never a button that would lie about where
 * it leads.
 */

/* ── Safety net for rows written before `link` existed ───────────────────────
   Only reached when the server sent no explicit link, so these cannot override a
   real destination. Titles, not types: the type field on UserNotification is
   only 'severe-flag' | 'info', which is far too coarse to route on. */

const USER_TITLE_ROUTES = [
  // Support — the bug this file fixes. Matched on the subject-free titles the
  // admin chat routes write.
  [/^support replied to your message$/i, '/support', 'Read the reply'],
  [/^support conversation resolved$/i, '/support', 'View the conversation'],
  [/^support conversation reopened$/i, '/support', 'Reply now'],
  [/^your account has been restricted$/i, '/support', 'Contact support'],
  // Assessments and intake.
  [/priority|assessment|health review/i, '/history', 'View the assessment'],
  // Account security.
  [/sign-in|password|two-factor|passkey|recovery code|backup code|recovery email|device/i, '/profile?section=security', 'Review your account security'],
  // Plans and billing. "…is now active" / "…cancelled" are the shapes the
  // subscription queue writes, and they name a PLAN rather than the word
  // "plan" — so they are matched explicitly.
  [/plan|subscription|payment|billing|upgrade|refund|cancel/i, '/profile?section=billing', 'View your plan'],
  [/is now active/i, '/profile?section=billing', 'View your plan'],
  // The ledger.
  [/blockchain|ledger|chain records/i, '/web3', 'View the blockchain ledger'],
];

const DEFAULT_USER_LABEL = 'Go there';

/**
 * True only for a path the app can actually render. Guards the redirect button
 * against a stored value that is absolute (`https://evil.example`) or points at
 * a route that no longer exists — a notification is data, and data can be stale.
 */
function isSafeInternalPath(path) {
  if (typeof path !== 'string') return false;
  const trimmed = path.trim();
  if (!trimmed.startsWith('/')) return false;
  // `//host` and `/\host` are protocol-relative URLs, not app paths.
  if (trimmed.startsWith('//') || trimmed.startsWith('/\\')) return false;
  return true;
}

/**
 * @param {object} item  A row from GET /api/notifications.
 * @returns {{path: string, label: string} | null}
 */
export function resolveUserTarget(item) {
  if (!item) return null;

  // 1. The server's answer, when it gave one.
  if (isSafeInternalPath(item.link)) {
    return { path: item.link.trim(), label: item.linkLabel || DEFAULT_USER_LABEL };
  }

  // 2. A severe flag is always about an assessment, even with no assessmentId.
  if (item.type === 'severe-flag') {
    return { path: '/history', label: 'View the flagged assessment' };
  }

  // 3. Safety net for legacy rows.
  const title = String(item.title || '');
  for (const [pattern, path, label] of USER_TITLE_ROUTES) {
    if (pattern.test(title)) return { path, label };
  }

  // 4. Nothing known: no redirect button at all, rather than a wrong one.
  return null;
}

/* ── Admin console ──────────────────────────────────────────────────────────
   The admin bell lives on /admin, where "redirection" means switching the tab
   (and optionally opening one conversation). Tab ids are the `tab` values in
   AdminDashboard.jsx; the server writes them into `link`. */

const ADMIN_TABS = [
  'overview', 'users', 'admins', 'subscriptions', 'chats',
  'assessment-management', 'ai', 'profile', 'security',
];

const ADMIN_TYPE_ROUTES = {
  'support-chat': ['chats', 'Open the conversation'],
  'subscription-request': ['subscriptions', 'Review the request'],
  'subscription-cancel-request': ['subscriptions', 'Open Subscription management'],
  'subscription': ['subscriptions', 'Open Subscription management'],
  'severe-flag': ['assessment-management', 'Open Assessment Management'],
  resolved: ['assessment-management', 'Open Assessment Management'],
  'new-device-login': ['security', 'Open the Security center'],
  security: ['security', 'Open the Security center'],
  account: ['users', 'Open User management'],
};

const DEFAULT_ADMIN_LABEL = 'Go there';

/**
 * Splits a stored `link` like `chats?thread=65f…` into its tab and the
 * conversation it points at. Anything unrecognised falls back to the type map,
 * then to null.
 *
 * @param {object} item  A row from GET /api/admin/notifications.
 * @returns {{tab: string, threadId?: string, label: string} | null}
 */
export function resolveAdminTarget(item) {
  if (!item) return null;

  const stored = typeof item.link === 'string' ? item.link.trim() : '';
  if (stored) {
    const [rawTab, rawQuery = ''] = stored.split('?');
    const tab = rawTab.trim();
    if (ADMIN_TABS.includes(tab)) {
      const threadId = new URLSearchParams(rawQuery).get('thread') || undefined;
      return {
        tab,
        ...(threadId ? { threadId } : {}),
        label: item.linkLabel || DEFAULT_ADMIN_LABEL,
      };
    }
  }

  const [tab, label] = ADMIN_TYPE_ROUTES[item.type] || [];
  if (tab && ADMIN_TABS.includes(tab)) {
    return {
      tab,
      // A support conversation is the one admin bell that can address a
    // specific record; the thread id rides on `link`, so nothing is inferred.
      ...(typeof item.threadId === 'string' && item.threadId ? { threadId: item.threadId } : {}),
      label: item.linkLabel || label,
    };
  }

  return null;
}

/* ── Presentation helpers shared by both bells ────────────────────────────── */

/** "just now" / "12m ago" / "3h ago" / "4d ago" / a date. */
export function timeAgo(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Full timestamp for the detail window — "12 Aug 2026, 14:03". */
export function fullStamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * A short, human badge for what KIND of thing this is. Purely for the detail
 * window's eyebrow line; never used for routing.
 */
export function categoryLabel(item, kind) {
  if (!item) return '';
  if (kind === 'admin') {
    switch (item.type) {
      case 'severe-flag': return 'Priority review';
      case 'resolved': return 'Priority review';
      case 'support-chat': return 'Support chat';
      case 'subscription-request': return 'Upgrade request';
      case 'subscription-cancel-request': return 'Cancellation request';
      case 'subscription': return 'Subscription';
      case 'new-device-login': return 'Sign-in';
      case 'security': return 'Security';
      case 'account': return 'Account';
      default: return 'System';
    }
  }
  if (item.type === 'severe-flag') return 'Health review';
  return 'Notification';
}

/**
 * Which of the accent families a notification wears.
 *
 * This exists so colour is DERIVED rather than declared twice. A bell row used
 * to be coloured by its type in the stylesheet while its destination was decided
 * elsewhere — two independent opinions about the same row, free to disagree.
 * Here, a member notice is classified by where it actually sends you, which is
 * the answer `resolveUserTarget` already gave. Colour and routing therefore
 * cannot drift apart: if the redirect changes, the accent changes with it.
 *
 * The returned value is a KEY into the stylesheet's accent tokens, not a colour.
 * Keeping hue out of JS is what lets the same key work in both consoles and in
 * light and dark.
 *
 * @param {object} item
 * @param {'user'|'admin'} kind
 * @returns {'support'|'security'|'health'|'assessment'|'billing'|'chain'|'account'|'info'}
 */
export function visualKind(item, kind = 'user') {
  if (!item) return 'info';

  // A severe flag is a health matter in both consoles, whatever else it says.
  if (item.type === 'severe-flag') return 'health';

  if (kind === 'admin') {
    switch (item.type) {
      case 'support-chat': return 'support';
      case 'subscription':
      case 'subscription-request':
      case 'subscription-cancel-request': return 'billing';
      case 'security':
      case 'new-device-login': return 'security';
      case 'account': return 'account';
      case 'resolved': return 'assessment';
      default: return 'info';
    }
  }

  const path = resolveUserTarget(item)?.path || '';
  if (path.startsWith('/support')) return 'support';
  if (path.includes('section=security')) return 'security';
  if (path.includes('section=billing')) return 'billing';
  if (path.startsWith('/web3')) return 'chain';
  if (path.startsWith('/history')) return 'assessment';
  return 'info';
}

/**
 * The accent family a notification belongs to, for both consoles at once.
 * Convenience for callers that hold a row of unknown provenance.
 */
export function visualKindOf(item) {
  return visualKind(item, item?.dismissible === undefined ? 'user' : 'admin');
}