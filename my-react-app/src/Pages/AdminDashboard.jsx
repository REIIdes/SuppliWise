import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import useSecurityMonitor from '../hooks/useSecurityMonitor';
import { BASE_URL, parseJSON } from '../api';
import { PLAN_LABELS, normalizePlanId } from '../utils/plan';
import {
  OVERVIEW_TREND_DAYS, OVERVIEW_TREND_OPTIONS, normalizeWindow, trendCeiling,
  formatMetricValue, formatCount, shareOf, dayParts,
  buildTrendSeries, axisTicks, initialsOf, displayNameOf, buildPlanMix, donutBackground,
  sparkPath, buildSegments, buildRankedBars, buildFunnel, compareWindows, rateOf,
  signedPercent, dayCountLabel,
} from '../utils/adminOverview';
import { pictureUrl } from '../utils/pictureUrl';
import { securityFactor } from '../utils/securityFactor';
import { formatShortDate, formatDateTime, isRealDate } from '../utils/dates';
import { downloadSecurityReport } from '../utils/securityReport';
import { formatPhoneNumber, formatEmail } from '../utils/formatContactInfo';
import './AdminDashboard.css';
import AssessmentManagement from './AssessmentManagement';
import ConditionProposals from './ConditionProposals';
import SecurityStatus from '../Components/SecurityStatus/SecurityStatus';
import AdminTopbar from '../Components/AdminTopbar/AdminTopbar';
import AdminSubscriptionPanel from '../Components/AdminSubscriptionPanel/AdminSubscriptionPanel';
import AdminSubscriptionRequests from '../Components/AdminSubscriptionRequests/AdminSubscriptionRequests';
import AdminSupportChats from '../Components/AdminSupportChats/AdminSupportChats';
import useSecureChat from '../security/useSecureChat';
import NotificationDetailModal from '../Components/NotificationDetailModal/NotificationDetailModal';
import NotificationGlyph from '../notifications/NotificationGlyph';
import { resolveAdminTarget, visualKind } from '../notifications/notificationTargets';
import '../notifications/notificationAccents.css';
import SessionExpiryModal from '../Components/SessionExpiryModal/SessionExpiryModal';
import ConfirmLogoutModal from '../Components/ConfirmLogoutModal/ConfirmLogoutModal';
import ConfirmModal from '../Components/ConfirmModal/ConfirmModal';

// 'profile' (Settings) is intentionally NOT in this list: it was removed from
// the sidebar and now lives behind the avatar pill menu in the topbar
// (Manage Account / Edit Profile both deep-link into it).
//
// 'subscriptions' is the review queue for plan requests users submitted from the
// pricing page with a proof-of-payment image. Approving one grants the plan.
//
// 'chats' is the member support queue — the human channel for "where did I
// pay", "my plan did not activate" and every other question a bot cannot
// answer. It sits next to 'subscriptions' because the two are the same reviewer
// looking at the same member's money, and a member who paid and then wrote in
// about it is one problem, not two.
const tabs = ['overview', 'users', 'admins', 'subscriptions', 'chats', 'assessment-management', 'proposals', 'ai', 'security'];

// The idle window is DEFINED by the server (server/utils/adminSession.js) and
// applied there. These are the fallbacks used only until the first
// /auth/admin-refresh reply arrives, at which point `sessionPolicy` below takes
// over and the countdown is driven by the real number.
//
// The fallback is not a second source of truth: a test asserts it equals the
// server's constant, so the two cannot drift apart unnoticed. The countdown used
// to be a local 3:30 while the server enforced its own separate copy of the same
// number — three literals for one policy, which is how the panel and the API
// came to disagree about when a session had ended.
const ADMIN_IDLE_LIMIT_SECONDS = 10 * 60;
const ADMIN_WARNING_SECONDS = 60;
const ADMIN_REFRESH_INTERVAL_MS = 10 * 1000;

// The TOKEN's lifetime, which is a different thing from the idle window, and is
// used for a different purpose.
//
// The admin JWT is deliberately short-lived (server/utils/adminSession.js,
// ADMIN_TOKEN_LIFETIME) so a token left on a shared machine dies on its own.
// But it was never re-issued except on mount and from the "Stay signed in"
// button — and that button only appears once the IDLE countdown runs out. An
// administrator working continuously never saw it, so nothing renewed the
// token and at its 15-minute `exp` they were signed out mid-task, with no
// warning at all. That was not an edge case, it was what every admin who
// worked for a quarter of an hour experienced.
//
// Like the idle window above, the server is authoritative: it reports
// `expiresInSeconds` on every /auth/admin-refresh reply and this is only the
// value used until the first one arrives. A test asserts the two agree.
const ADMIN_TOKEN_LIFETIME_SECONDS = 15 * 60;

// Renew once this much of the token's life has elapsed, not at the end. Two
// attempts before expiry means a single failed request — a dropped connection, a
// sleeping laptop, a deploy — costs a retry rather than a logout.
const ADMIN_TOKEN_RENEWAL_RATIO = 0.6;

// How often the keepalive re-checks. A poll rather than one long setTimeout,
// deliberately: browsers throttle timers in background tabs to roughly once a
// minute, so a 15-minute setTimeout can fire long after it was due. A short
// poll cannot be throttled into a stale token — when the tab wakes, the first
// tick sees the real clock and renews if it is behind.
const ADMIN_TOKEN_CHECK_INTERVAL_MS = 15 * 1000;

// How often real user input is reported to the server, so its idle clock and
// the countdown on screen cannot drift apart. Once a minute is often enough to
// keep a ten-minute window honest and rare enough to be free — see the beacon in
// the activity effect for why it exists at all.
const ADMIN_ACTIVITY_BEACON_MS = 60 * 1000;

// ── Subscription status (mirrors server resolveSubscription) ──────────────
// The admin grid used to read the RAW subscriptionActive flag, so a user whose
// subscriptionExpiresAt had already passed still showed "Subscribed ✓" while
// the API was quietly serving them the FREE tier. Every lock that followed
// then looked like a bug. Resolve it at render time exactly like the backend.
//
// `subscriptionPermanent` short-circuits the expiry test: a permanent grant has
// no end date at all, and re-granting or extending it must never read as
// "expired" because some date is in the past.
function isSubscriptionLive(user) {
  if (!user || user.subscriptionActive !== true) return false;
  if (user.subscriptionPlan === 'free') return false;
  if (user.subscriptionPermanent === true) return true;
  if (!user.subscriptionExpiresAt) return true; // null = open-ended
  const end = new Date(user.subscriptionExpiresAt).getTime();
  return !Number.isFinite(end) || end > Date.now();
}

// Short read-out for the collapsed rows: "PERMANENT", "24 days left", or an
// absolute date. Uses the same ceil-day rule as the server so the grid and the
// detail panel never disagree about the same subscription.
function subscriptionExpiryLabel(user) {
  if (!user) return null;
  if (user.subscriptionPermanent === true) return 'Permanent — never expires';
  if (!user.subscriptionExpiresAt) return null;
  const end = new Date(user.subscriptionExpiresAt);
  if (!Number.isFinite(end.getTime())) return null;
  if (end.getTime() <= Date.now()) {
    return `Expired ${end.toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    })}`;
  }
  const days = Math.ceil((end.getTime() - Date.now()) / 86400000);
  return `${days} day${days === 1 ? '' : 's'} left · ${end.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })}`;
}

// ── Idle countdown badge ───────────────────────────────────────────────
// Owns its 1 s ticker so the rest of the dashboard does NOT re-render every
// second (previously the whole page re-rendered 210× per idle session).
// Memoized: only this badge updates as the countdown ticks.

const AdminIdleStatus = memo(function AdminIdleStatus({ deadlineRef, modalShownRef, idleLimitSeconds, warningSeconds, onExpire, onStay }) {
  // Seeded from the SERVER's window when it is known, falling back to the
  // compile-time value until the first refresh reply lands. An admin who sees
  // "9:41 remaining" and is actually killed at 3:30 has been told a lie by the
  // countdown, so the displayed number and the enforced one come from the same
  // place.
  const idleLimit = Number.isFinite(idleLimitSeconds) && idleLimitSeconds > 0
    ? idleLimitSeconds
    : ADMIN_IDLE_LIMIT_SECONDS;
  const warnAt = Number.isFinite(warningSeconds) && warningSeconds > 0
    ? warningSeconds
    : ADMIN_WARNING_SECONDS;
  const [remaining, setRemaining] = useState(idleLimit);
  const [showModal, setShowModal] = useState(false);
  const [expired, setExpired] = useState(false);
  const [notice, setNotice] = useState('');
  const [modalShown, setModalShown] = useState(false); // Track if modal was ever shown
  const onExpireRef = useRef(null);
  const onStayRef = useRef(null);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);
  useEffect(() => {
    onStayRef.current = onStay;
  }, [onStay]);

  // Keep the modal alive after a successful refresh (new deadline pushed out)
  // instead of flashing it away — the admin sees the countdown reset.
  const prevRemainingRef = useRef(remaining);
  useEffect(() => {
    if (showModal && !expired && remaining > prevRemainingRef.current + 5) {
      setShowModal(true);
    }
    prevRemainingRef.current = remaining;
  }, [remaining, showModal, expired]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);

      if (left <= warnAt && left > 0 && !expired) {
        setShowModal(true);
        setModalShown(true); // Mark that modal has been shown
        if (modalShownRef) modalShownRef.current = true; // Update ref for activity handler
      }

      if (left === 0 && !expired) {
        setExpired(true);
        setShowModal(true);
        setNotice('Your admin session has expired due to inactivity.');
        window.clearInterval(timer);
        // Give the admin a beat to read the notice before redirecting.
        window.setTimeout(() => { onExpireRef.current?.(); }, 2500);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [deadlineRef, expired, warnAt]);

  const handleStayLoggedIn = async () => {
    setNotice('');
    try {
      await onStayRef.current?.();
      setExpired(false);
      setRemaining(Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000)));
      // Countdown visibly resets; keep the modal briefly so the
      // "session extended" state is noticeable, not magic.
      setNotice('Session extended — you are still signed in.');
      setModalShown(false); // Reset flag so activity tracking resumes
      if (modalShownRef) modalShownRef.current = false; // Reset ref too
      window.setTimeout(() => { setShowModal(false); setNotice(''); }, 1800);
    } catch {
      setExpired(true);
      setNotice('Could not refresh the session. Signing out…');
      window.setTimeout(() => { onExpireRef.current?.(); }, 1500);
    }
  };

  const handleLogout = () => {
    onExpireRef.current?.();
  };

  if (!showModal) return null;
  return (
    <SessionExpiryModal
      remainingTime={remaining}
      expired={expired}
      notice={notice}
      onStayLoggedIn={handleStayLoggedIn}
      onLogout={handleLogout}
      modalShown={modalShown}
    />
  );
});

/* ── Tab icons ────────────────────────────────────────────────────────── */
const TAB_ICONS = {
  overview: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  users: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  admins: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <polyline points="9 12 11 14 15 10"/>
    </svg>
  ),
  'assessment-management': (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>
  ),
  // Card + check: a plan request that has been paid for and approved.
  subscriptions: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="5" width="20" height="14" rx="2"/>
      <line x1="2" y1="10" x2="22" y2="10"/>
      <polyline points="6 15 9.5 18 15 12"/>
    </svg>
  ),
  // Speech bubble: "a member is waiting on us". Deliberately the same glyph
  // family as the rest of the rail rather than a filled brand mark, so the
  // collapsed 64px rail still reads as one set of icons.
  chats: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
      <path d="M8.5 11h.01M12 11h.01M15.5 11h.01" />
    </svg>
  ),
  ai: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
    </svg>
  ),
  // Logbook: the AI's own gate decisions and citations, recorded automatically.
  proposals: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
    </svg>
  ),
  profile: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  ),
  security: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
};

/* ── Settings → Edit profile: picture picking ─────────────────────────── */
// File size limits for profile pictures - support GIFs and larger images
const AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const BANNER_MAX_BYTES = 10 * 1024 * 1024;

function readImageFile(file, maxBytes, tooBigMessage) {
  return new Promise((resolve, reject) => {
    if (!file) { resolve(''); return; }
    if (!file.type || !file.type.startsWith('image/')) {
      reject(new Error('Please select an image file.'));
      return;
    }
    if (file.size > maxBytes) {
      reject(new Error(tooBigMessage));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file. Please try another image.'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsDataURL(file);
  });
}

/**
 * Carry avatars forward when the table is seeded from the overview preview.
 *
 * `GET /admin/overview` deliberately omits `profilePicture` from recentUsers —
 * that table never draws an avatar, yet the field alone accounted for 668 ms
 * of a 783 ms endpoint (large fields cost ~10 ms/KB to read from Atlas). But
 * those same rows are also what seed the `users` table while it is idle, so
 * dropping the field there would blank out avatars the admin can already see
 * until the next authoritative `/users` fetch. Re-attach anything we already
 * hold; rows with no known picture are left untouched so initials still show.
 */
function withKnownAvatars(rows, previous) {
  if (!Array.isArray(rows) || rows.length === 0) return rows || [];
  const known = new Map();
  for (const row of previous || []) {
    if (row && row._id && row.profilePicture) known.set(row._id, row.profilePicture);
  }
  if (known.size === 0) return rows;
  return rows.map((row) => (row && !row.profilePicture && known.has(row._id)
    ? { ...row, profilePicture: known.get(row._id) }
    : row));
}

function AdminDashboard() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('adminSidebarCollapsed') === 'true'
  );
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  // Mirror of `users` readable from inside load()'s async body, where the
  // state closure is still the value from the render that created it.
  const usersRef = useRef(users);
  useEffect(() => { usersRef.current = users; }, [users]);
  const [admins, setAdmins] = useState([]);
  // Timestamp of the last admins-list fetch (anchors the lockout countdown,
  // same pattern as usersFetchedAt).
  const [adminsFetchedAt, setAdminsFetchedAt] = useState(() => Date.now());
  // Timestamp (ms) of the last users-list fetch. The lockout countdown ticks
  // locally every second against fetchedAt + remainingSeconds, so the badge
  // stays live between 15 s server polls instead of freezing or vanishing.
  const [usersFetchedAt, setUsersFetchedAt] = useState(() => Date.now());
  const [allUsers, setAllUsers] = useState([]);
  const [ai, setAi] = useState(null);
  // Drives the AI panel's "Check now" button while a forced probe runs.
  const [checkingAi, setCheckingAi] = useState(false);
  // What the last "Check now" reload actually did, kept OUT of `ai` on purpose.
  // The 10 s poll replaces `ai` wholesale and reports no reload, so reading the
  // outcome from there would erase it a few seconds after every click — and the
  // one that must never be erased is the failure, since that is the message
  // telling the admin why their key still looks wrong. Replaced only by the next
  // reload, so what is on screen always describes the reload these cards came
  // from.
  const [aiReload, setAiReload] = useState(null);
  const [security, setSecurity] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ currentPassword: '', newPassword: '', otp: '' });
  const [profileMessage, setProfileMessage] = useState('');
  // Saved picture/background (from /admin/profile) + whether the Edit profile
  // panel inside Settings starts expanded.
  const [appearance, setAppearance] = useState({ profilePicture: '', bannerPicture: '' });
  const [editProfileOpen, setEditProfileOpen] = useState(true);
  const [rotateOtp, setRotateOtp] = useState('');
  const [rotatedKey, setRotatedKey] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [showNotifications, setShowNotifications] = useState(false);
  // Unread member messages in the support queue — drives the "new" dot on the
  // sidebar's Chat management icon. While the tab is open, AdminSupportChats
  // reports its own count live; from any other tab it is polled quietly.
  const [chatsUnread, setChatsUnread] = useState(0);
  // Derived, never mirrored into its own state: the badge used to drift out of
  // sync with the list every time a row was read, deleted or refreshed.
  const unreadCount = notifications.filter(n => !n.read).length;
  const readCount = notifications.length - unreadCount;
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  // The notification row whose detail window is open. `null` = no window.
  // Rows are NOT navigated to on click any more — the window is where Mark as
  // read / Delete / Go there live. See notifications/notificationTargets.js.
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(null);
  const [detailError, setDetailError] = useState('');
  // A specific support conversation to open when Chat management next mounts —
  // set by a "New support conversation" bell so the admin lands on the thread
  // instead of on a queue they have to scan.
  const [focusThreadId, setFocusThreadId] = useState('');
  // Destructive-action guard: which user is awaiting confirmation, which row
  // is mid-request, and the one-shot success banner shown afterwards.
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null);
  const [deletingUserId, setDeletingUserId] = useState('');
  // Same guard for "Delete all read" — see clearAllReadAdminNotifications.
  const [confirmingClearRead, setConfirmingClearRead] = useState(false);
  const [clearingRead, setClearingRead] = useState(false);
  const [notice, setNotice] = useState('');
  const notifBellRef = useRef(null);
  const sidebarNavRef = useRef(null);
  const notifPanelRef = useRef(null);
  const notifCloseTimerRef = useRef(0);
  const notifHoverSuppressedRef = useRef(false);

  // Grace period between the 10px bell→panel gap: leaving for the gap must
  // not slam the panel shut before the pointer reaches it.
  const cancelNotifClose = () => {
    if (notifCloseTimerRef.current) {
      window.clearTimeout(notifCloseTimerRef.current);
      notifCloseTimerRef.current = 0;
    }
  };

  const scheduleNotifClose = () => {
    cancelNotifClose();
    notifCloseTimerRef.current = window.setTimeout(() => {
      notifCloseTimerRef.current = 0;
      setShowNotifications(false);
    }, 200);
  };

  const handleNotifHoverEnter = (event) => {
    // Touch has no hover — it keeps the click-to-toggle path.
    if (event.pointerType === 'touch') return;
    if (notifHoverSuppressedRef.current) return;
    cancelNotifClose();
    setShowNotifications(true);
  };

  const handleNotifHoverLeave = (event) => {
    if (event.pointerType === 'touch') return;
    notifHoverSuppressedRef.current = false;
    scheduleNotifClose();
  };

  const toggleNotifications = () => {
    cancelNotifClose();
    if (showNotifications) {
      // Latch hover-reopen off only while the pointer is genuinely over
      // the bell (a keyboard toggle elsewhere must not disable hover).
      notifHoverSuppressedRef.current = !!notifBellRef.current?.matches(':hover');
      setShowNotifications(false);
    } else {
      notifHoverSuppressedRef.current = false;
      setShowNotifications(true);
    }
  };

  // Anchor the panel to the bell in viewport coordinates (position: fixed),
  // re-measuring on scroll (capture phase) and resize so it stays pinned
  // beneath the bell while the page scrolls. useLayoutEffect runs before
  // paint: the panel never flashes at a fallback position first.
  useLayoutEffect(() => {
    if (!showNotifications) return undefined;
    const place = () => {
      const anchor = notifBellRef.current;
      const panel = notifPanelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 36);
      const left = Math.min(
        Math.max(rect.right - width, 18),
        Math.max(18, window.innerWidth - width - 18)
      );
      const top = rect.bottom + 10;
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
      panel.style.right = 'auto';
      panel.style.width = `${Math.round(width)}px`;
      const arrowX = Math.min(
        Math.max(rect.left + rect.width / 2 - left, 16),
        width - 16
      );
      panel.style.setProperty('--arrow-x', `${Math.round(arrowX)}px`);
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [showNotifications]);

  // Close on outside click / Escape (bell + panel are separate DOM subtrees,
  // so containment must check both).
  useEffect(() => {
    if (!showNotifications) return undefined;
    const onDown = (event) => {
      const inBell = notifBellRef.current?.contains(event.target);
      const inPanel = notifPanelRef.current?.contains(event.target);
      if (!inBell && !inPanel) setShowNotifications(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setShowNotifications(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [showNotifications]);

  // Clear a pending hover-close timer if the dashboard unmounts mid-transition.
  useEffect(() => () => window.clearTimeout(notifCloseTimerRef.current), []);

  // Success banners (e.g. "account disabled") fade on their own so they can
  // never pile up while the admin keeps working.
  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const [search, setSearch] = useState('');
  const [adminSearch, setAdminSearch] = useState('');
  const [error, setError] = useState('');
  const [expandedUser, setExpandedUser] = useState(null);
  const [expandedAdmin, setExpandedAdmin] = useState(null);
  const searchRef = useRef('');
  const adminSearchRef = useRef('');
  const tabRef = useRef(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // Initialized by the idle effect on mount (avoids impure Date.now() in render)
  const idleDeadlineRef = useRef(0);
  const modalShownRef = useRef(false); // Track if expiry modal has been shown
  // The server's own numbers, learned from the first successful
  // /auth/admin-refresh. Until then the compile-time fallbacks apply; after it,
  // the countdown and the warning threshold are whatever the API actually
  // enforces. One `idlingRef` holds the live window so the activity listeners
  // below never close over a stale value.
  const [idleLimit, setIdleLimit] = useState(ADMIN_IDLE_LIMIT_SECONDS);
  const idlingRef = useRef(ADMIN_IDLE_LIMIT_SECONDS);
  const applyIdleLimit = useCallback((seconds) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    idlingRef.current = seconds;
    setIdleLimit(seconds);
    // Re-anchor the countdown immediately, so adopting a longer window does not
    // leave the badge counting down from the old, shorter one.
    idleDeadlineRef.current = Date.now() + seconds * 1000;
  }, []);

  // When the current token dies, and how long it lives. Seeded to 0 rather than
  // `Date.now() + …` because calling the clock during render is impure, and this
  // component is deliberately strict about that (the idle deadline above is
  // initialised in an effect for the same reason). 0 means "unknown", which the
  // keepalive reads as "renew now" — the right default when the expiry of the
  // token in hand is genuinely not known.
  const tokenExpiresAtRef = useRef(0);
  const tokenLifetimeRef = useRef(ADMIN_TOKEN_LIFETIME_SECONDS);

  const request = useCallback(async (path, options = {}) => {
    const { background = false, ...fetchOptions } = options;
    const response = await fetch(`${BASE_URL}/admin${path}`, { ...fetchOptions, headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}`, ...(background ? { 'X-Admin-Background': 'true' } : {}), ...fetchOptions.headers } });
    const data = await parseJSON(response);
    // PASSWORD_CHANGE_REQUIRED is a 403 that does NOT mean "forbidden": the
    // session is valid, the account is just still on its temporary password.
    // It has to be handled before the generic 401/403 branch below, which
    // would throw away a perfectly good token and send a signed-in admin back to
    // the sign-in page to be asked for the same credentials all over again.
    if (response.status === 403 && data?.code === 'PASSWORD_CHANGE_REQUIRED') {
      try {
        const stored = JSON.parse(localStorage.getItem('admin') || '{}');
        localStorage.setItem('admin', JSON.stringify({ ...stored, mustChangePassword: true }));
      } catch { /* the redirect below is what actually matters */ }
      navigate('/admin/change-password', { replace: true });
      throw new Error(data?.message || 'Choose your own password before continuing.');
    }
    if (response.status === 401 || response.status === 403) { localStorage.removeItem('adminToken'); localStorage.removeItem('admin'); navigate('/admin/login'); throw new Error('Your admin session has expired.'); }
    if (!response.ok) {
      const error = new Error(data?.message || 'Unable to load admin data.');
      error.status = response.status;
      // A refused request can still carry a structured result — the credential
      // delivery reports which mailboxes failed even when the call as a whole
      // did not succeed. Without this the panel sees only the sentence.
      error.data = data;
      throw error;
    }
    return data;
  }, [navigate]);

  // Feed the sidebar dot from any tab except the queue itself, where the queue
  // reports its own count. `limit=1` because only `counts.unread` is wanted —
  // the thread page is fetched in full by the tab when it opens.
  useEffect(() => {
    if (tab === 'chats') return undefined;
    let alive = true;
    const pull = async () => {
      try {
        const data = await request('/chats?limit=1', { background: true });
        if (alive) setChatsUnread(Number(data?.counts?.unread) || 0);
      } catch { /* keep the last known count; the next tick retries */ }
    };
    pull();
    const timer = window.setInterval(pull, 45000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [tab, request]);

  const [adminAccountId, setAdminAccountId] = useState(() => {
    try { return String(JSON.parse(localStorage.getItem('admin') || '{}').id || ''); } catch { return ''; }
  });

  useEffect(() => {
    if (adminAccountId || !localStorage.getItem('adminToken')) return undefined;
    let live = true;
    request('/chats/encryption/me')
      .then((data) => { if (live && data?.accountId) setAdminAccountId(String(data.accountId)); })
      .catch(() => { /* the admin session handler owns authentication errors */ });
    return () => { live = false; };
  }, [adminAccountId, request]);

  const adminSecureChat = useSecureChat({
    role: 'admin',
    accountId: adminAccountId,
    isAuthenticated: Boolean(adminAccountId && localStorage.getItem('adminToken')),
    endpoints: {
      getKey: () => request('/chats/encryption/key'),
      publishKey: (key) => request('/chats/encryption/key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(key),
      }),
      saveRecovery: (recoveryWrapped, hint) => request('/chats/encryption/recovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recoveryWrapped, hint }),
      }),
      getRecovery: () => request('/chats/encryption/recovery'),
      listRecipients: (threadId) => (threadId ? request(`/chats/${threadId}/recipients`) : Promise.resolve({ recipients: [] })),
    },
  });

  // ── Live security monitor (shared) ────────────────────────────────────
  // Owned here, not inside either surface, because the Overview "Threat
  // notifications" card and the Security Center tab answer the same question
  // and used to answer it from two unrelated endpoints — so the card could say
  // "All systems secure" while the tab it links to showed critical monitors.
  // One fetch and one poll for both means they cannot disagree.
  //
  // `active` keeps the 45 probes off the wire while neither surface is on
  // screen: the card only renders on Overview, the table only on Security.
  // Switching between the two then shows the already-warm result instead of
  // flashing 45 "Checking…" rows.
  const monitor = useSecurityMonitor(request, tab === 'overview' || tab === 'security');

  // A specific monitor to reveal when the Security tab opens, set by clicking a
  // row on the Overview card. Cleared once consumed so a later manual visit to
  // the tab starts unfiltered.
  const [focusMonitorKey, setFocusMonitorKey] = useState(null);

  const openSecurityCenter = useCallback((monitorKey = null) => {
    setFocusMonitorKey(monitorKey);
    // Leaving Chat management for any reason discards a deep-linked thread, so
    // coming back to the queue by hand starts on the queue rather than
    // re-opening a conversation from minutes ago. Never called to go TO chats,
    // so there is no case where this would clear a focus being applied.
    setFocusThreadId('');
    setTab('security');
  }, []);

  // Leaving the tab through the sidebar (rather than a deep link) discards any
  // pending focus, so returning to Security later is not silently filtered to
  // one monitor the admin picked minutes ago.
  const clearMonitorFocus = useCallback(() => setFocusMonitorKey(null), []);

  const loadUsers = useCallback(async () => {
    try {
      const q = (searchRef.current || '').trim();
      const data = await request(`/users?search=${encodeURIComponent(q)}`);
      setUsers(data.users || []);
      setUsersFetchedAt(Date.now());
    } catch (requestError) { setError(requestError.message); }
  }, [request]);

  const loadAdmins = useCallback(async () => {
    try {
      const q = (adminSearchRef.current || '').trim();
      const data = await request(`/admins?search=${encodeURIComponent(q)}`);
      setAdmins(data.admins || []);
      setAdminsFetchedAt(Date.now());
    } catch (requestError) { setError(requestError.message); }
  }, [request]);

  const toggleAdmin = useCallback(async (admin) => {
    try {
      const data = await request(`/admins/${admin._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !admin.enabled }),
      });
      setAdmins(current => current.map(item => item._id === data.admin._id ? { ...item, ...data.admin, lockout: item.lockout } : item));
      setError('');
    } catch (requestError) { setError(requestError.message); }
  }, [request]);

  const unlockAdmin = useCallback(async (admin) => {
    try {
      const data = await request(`/admins/${admin._id}/lockout`, { method: 'DELETE' });
      // Re-fetch authoritative state instead of optimistic "Clear" — same as users.
      await loadAdmins();
      setError('');
      return data;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    }
  }, [request, loadAdmins]);

  // "Check now" on the AI panel. This forces a fresh probe server-side — the  // GET path serves a cached check for up to 30 s — so an admin who has just
  // rotated a key sees the verdict now instead of on a later poll.
  const checkAiNow = useCallback(async () => {
    setCheckingAi(true);
    try {
      const data = await request('/ai/check', { method: 'POST' });
      setAi(data);
      // Names only — the server never puts a value in this object.
      setAiReload(data?.reload || null);
      setError('');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setCheckingAi(false);
    }
  }, [request]);

  // ── Admin pictures ────────────────────────────────────────────────────────
  // The pictures are megabytes, and reading a megabyte-sized field back from
  // Atlas costs ~10 ms/KB (measured: a 2.96 MB banner took 30.0 s). They used
  // to ride along inside /profile, which made this console's 10 s refresh take
  // 30 s and let the ticks stack up behind one another. They now live on their
  // own endpoint, are never awaited inside load()'s Promise.all, and are only
  // re-fetched when the server says they actually changed.
  //
  // `undefined` = not fetched yet, `null` = a real version for an account that
  // has never saved a picture. Those two must stay distinct or a brand-new
  // admin would never receive the pictures at all.
  const picturesVersionRef = useRef(undefined);
  const picturesInFlightRef = useRef(false);

  const loadPictures = useCallback(async () => {
    // Coalesce: a 30 s first read would otherwise be started again on every
    // 10 s tick until the first one finally landed.
    if (picturesInFlightRef.current) return;
    picturesInFlightRef.current = true;
    try {
      const data = await request('/profile/pictures', { background: true });
      picturesVersionRef.current = data?.picturesUpdatedAt ?? null;
      // Identity is preserved when nothing changed, so the background refresh
      // never resets the Edit profile draft (ProfilePanel only adopts values
      // it sees as new).
      setAppearance(current => {
        const next = {
          profilePicture: data?.profilePicture || '',
          bannerPicture: data?.bannerPicture || '',
        };
        return current.profilePicture === next.profilePicture && current.bannerPicture === next.bannerPicture
          ? current
          : next;
      });
    } catch {
      // Cosmetic only: leave the version unadvanced so a later tick retries,
      // and never raise a banner error over a missing avatar.
    } finally {
      picturesInFlightRef.current = false;
    }
  }, [request]);

  // Overlap guard. The interval is 10 s but a request can take longer than
  // that (an Atlas stall, a slow tab), and starting another full refresh while
  // one is live is how the old 30 s polls piled up into a permanent backlog.
  const loadInFlightRef = useRef(false);
  // Mirrors loadInFlightRef for the UI only: the Overview's Refresh button
  // spins and disables itself while a poll is live. Refs cannot drive render.
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (background = false) => {
    if (loadInFlightRef.current) return;
    loadInFlightRef.current = true;
    setRefreshing(true);
    // allSettled, NOT all.
    //
    // With Promise.all a single rejection discards the other four successes, so
    // one slow endpoint on a 10 s poll meant the WHOLE dashboard stopped
    // updating — and the only thing shown was the browser's raw "Failed to
    // fetch", which names neither the endpoint nor what to do about it. Each
    // panel now lands independently, and only the parts that actually failed are
    // reported.
    const calls = [
      ['overview', request('/overview', { background })],
      ['AI providers', request('/ai', { background })],
      ['security', request('/security', { background })],
      ['profile', request('/profile', { background })],
      ['notifications', request('/notifications', { background })],
    ];
    const results = await Promise.allSettled(calls.map(([, p]) => p));

    // A 401/403 has already cleared the token and navigated to /admin/login in
    // `request`. Rendering the survivors on the way out would flash stale data
    // behind a redirect, so this is the one case where nothing is applied.
    const expired = results.some((r) => r.status === 'rejected'
      && /session has expired/i.test(String(r.reason?.message || '')));
    if (expired) { loadInFlightRef.current = false; setRefreshing(false); return; }

    const failed = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') return;
      const label = calls[i][0];
      const message = String(r.reason?.message || 'Request failed');
      // The browser's own wording for a network-level failure. It is accurate
      // and completely unactionable, so it is replaced with something a reader
      // can act on.
      failed.push(label, /failed to fetch|networkerror|load failed/i.test(message)
        ? 'could not reach the server'
        : message.toLowerCase());
    });

    const [overviewResult, aiResult, securityResult, profileResult, notificationsResult] = results;
    if (overviewResult.status === 'fulfilled') {
      const overviewData = overviewResult.value;
      setOverview(overviewData);
      // Pictures are no longer part of /profile — fetch them only when the
      // server's version stamp says they changed. Deliberately NOT awaited:
      // the dashboard must render immediately even if that read is slow.
      // The Users tab's authoritative list comes from loadUsers(), which now
      // runs when the tab opens and every 15 s afterwards (see the refresh
      // effect below). Pulling the same rows here as well meant the 47 KB
      // payload was downloaded by two uncoordinated timers — and on a link
      // where a large payload costs ~10 ms/KB, that duplicated transfer was
      // the slowest thing the Users tab did. `recentUsers` still seeds state
      // while another tab is active, so switching has something to render for
      // the few hundred ms before the tab-open fetch lands.
      if (tabRef.current !== 'users') {
        setUsers(withKnownAvatars(overviewData.recentUsers || [], usersRef.current));
        setUsersFetchedAt(Date.now());
      }
    }
    if (aiResult.status === 'fulfilled') setAi(aiResult.value);
    if (securityResult.status === 'fulfilled') setSecurity(securityResult.value);
    if (notificationsResult.status === 'fulfilled') {
      setNotifications(notificationsResult.value?.notifications || []);
    }
    if (profileResult.status === 'fulfilled') {
      const profileData = profileResult.value;
      setProfile(profileData);
      if (picturesVersionRef.current !== (profileData?.picturesUpdatedAt ?? null)) {
        loadPictures();
      }
    }

    setError(failed.length
      ? `Some panels could not refresh: ${failed.join('; ')}.`
      : '');
    loadInFlightRef.current = false;
    setRefreshing(false);
  }, [request, loadPictures]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      if (localStorage.getItem('admin') && localStorage.getItem('adminToken')) loadRef.current();
      else navigate('/admin/login');
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [navigate]);

  // Live lists: refresh users/admins state while their tab is open
  // (15 s poll + on tab focus/visibility), never clobbering a search.
  useEffect(() => {
    const maybeRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (tabRef.current === 'users') {
        if ((searchRef.current || '').trim() !== '') return;
        loadUsers();
      } else if (tabRef.current === 'admins') {
        if ((adminSearchRef.current || '').trim() !== '') return;
        loadAdmins();
      }
    };
    const timer = window.setInterval(maybeRefresh, 15000);
    document.addEventListener('visibilitychange', maybeRefresh);
    window.addEventListener('focus', maybeRefresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', maybeRefresh);
      window.removeEventListener('focus', maybeRefresh);
    };
  }, [loadUsers, loadAdmins]);

  // Fetch the authoritative list the moment its tab opens.
  //
  // `load()` only re-reads /users while that tab is already active, and the
  // 15 s `maybeRefresh` above only runs while it is open — so a first visit
  // rendered whatever happened to be in state (an empty array for Admins, an
  // 8-row overview preview without avatars for Users) until a timer landed.
  // Opening the tab is the natural moment to ask for the real thing.
  useEffect(() => {
    if (tab === 'users') loadUsers();
    else if (tab === 'admins') loadAdmins();
  }, [tab, loadUsers, loadAdmins]);

  /**
   * Keep the overview counters honest after a subscription change made from the
   * control panel.
   *
   * The panel owns the mutation (it calls the same endpoint) and hands the
   * authoritative document back through `onUserUpdated`; this only fixes the
   * derived counters, which live in the parent's state.
   *
   * NOTE: no load() here — it would replace the managed user list with
   * recentUsers and wipe the plan the admin just saved.
   */
  const applySubscriptionUpdate = useCallback((updated) => {
    if (!updated?._id) return;
    // Broadcast the authoritative plan so this tab's own subscription store
    // picks up a change to ITS OWN account (it ignores anyone else's — see the
    // store's admin listener). Delivery to the target user's other devices is
    // the server's SSE push, not this event.
    try {
      window.dispatchEvent(new CustomEvent('suppliwise:subscription-admin', { detail: updated }));
    } catch { /* non-browser safe */ }

    // Metric counters track LIVE subscriptions, so compare the resolved state
    // on both sides: a permanent grant and a window with a future expiry are
    // both live, and a permanent one must not flip the counter on every poll.
    const isNowLive = isSubscriptionLive(updated);
    setOverview((current) => {
      if (!current?.metrics) return current;
      const wasLive = subscriptionLiveRef.current.get(updated._id);
      if (wasLive === undefined || wasLive === isNowLive) return current;
      subscriptionLiveRef.current.set(updated._id, isNowLive);
      const delta = isNowLive ? 1 : -1;
      return {
        ...current,
        metrics: {
          ...current.metrics,
          activeSubscriptions: Math.max(0, current.metrics.activeSubscriptions + delta),
          inactiveSubscriptions: Math.max(0, current.metrics.inactiveSubscriptions - delta),
        },
        recentUsers: current.recentUsers.map((item) => (item._id === updated._id ? { ...item, ...updated } : item)),
      };
    });
  }, []);

  // Remembers each account's last known live-ness so applySubscriptionUpdate can
  // tell an actual flip (a counter change) from a no-op re-save. Cleared whenever
  // the user list is refetched, which re-seeds the baseline.
  const subscriptionLiveRef = useRef(new Map());

  const downloadReport = useCallback(async () => {
    try {
      await downloadSecurityReport({ overview, security, request });
    } catch (error) {
      console.error('Security report export failed:', error);
      setError(error?.message || 'Unable to generate the security report.');
    }
  }, [overview, security, request]);

  // expose download so SecurityStatus can call it
  const downloadReportRef = useRef(downloadReport);
  useEffect(() => { downloadReportRef.current = downloadReport; }, [downloadReport]);

  const signOut = useCallback(() => { localStorage.removeItem('adminToken'); localStorage.removeItem('admin'); navigate('/admin/login'); }, [navigate]);
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  }, [signOut]);

  // Stable expire callback for the countdown badge (avoids re-subscribing it)
  const handleIdleExpire = useCallback(() => {
    signOutRef.current();
  }, []);

  /**
   * The one call to /auth/admin-refresh, shared by all three of its callers:
   * arriving on the dashboard, pressing "Stay signed in", and the automatic
   * keepalive. They previously each had their own `fetch`, which is how the
   * first two learned the server's policy while the third did not exist — so a
   * token could be minted and then thrown away unread.
   *
   * @param {boolean} asActivity  true when the call itself IS the evidence of
   *   activity (arriving, or pressing "Stay signed in"). false for the automatic
   *   keepalive, which must renew the TOKEN without sliding the IDLE window —
   *   otherwise the timer below would hold every admin session open forever and
   *   the ten-minute timeout would stop existing.
   * @returns {Promise<{ok: boolean, data?: object}>} the reply, so the caller
   *   can adopt the server's idle window from it
   */
  const syncAdminSession = useCallback(async (asActivity) => {
    const response = await fetch(`${BASE_URL}/auth/admin-refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('adminToken')}` },
      ...(asActivity ? {} : { body: JSON.stringify({ renew: true }) }),
    });
    const data = await parseJSON(response);
    if (!response.ok) {
      // A 401 is the server saying the session is gone — idle-expired, replaced,
      // or the account disabled. That is a real sign-out and is handled here so
      // the keepalive cannot sit in a loop against a dead session. Anything else
      // (a network blip, a 5xx during a deploy) is deliberately NOT a sign-out:
      // throwing away a working token because one request failed is exactly how
      // an admin ends up logged out during a restart.
      if (response.status === 401) {
        signOutRef.current();
        return { ok: false };
      }
      throw new Error(data?.message || 'Session refresh failed.');
    }
    if (data?.token) {
      localStorage.setItem('adminToken', data.token);
      // Schedule the next renewal off the server's own number, not the
      // compile-time fallback, so a change to the lifetime does not silently
      // leave the client renewing on the old schedule.
      if (Number.isFinite(data.expiresInSeconds) && data.expiresInSeconds > 0) {
        tokenLifetimeRef.current = data.expiresInSeconds;
      }
      tokenExpiresAtRef.current = Date.now() + tokenLifetimeRef.current * 1000;
    }
    return { ok: true, data };
  }, []);

  // "Stay signed in" hits the server first so the expiry is a visible refresh,
  // not silent magic: the countdown resets only after the backend confirms.
  const handleStayActive = useCallback(async () => {
    const { ok, data } = await syncAdminSession(true);
    // Adopt the server's window before re-anchoring, so the countdown is set
    // from the number the API actually enforces.
    if (ok) applyIdleLimit(data?.idleLimitSeconds);
    idleDeadlineRef.current = Date.now() + idlingRef.current * 1000;
  }, [syncAdminSession, applyIdleLimit]);

  useEffect(() => {
    if (!localStorage.getItem('admin') || !localStorage.getItem('adminToken')) {
      navigate('/admin/login');
      return undefined;
    }

    // Learn the enforced window on arrival rather than waiting for the admin to
    // press "stay signed in". The badge is on screen from the first second, so
    // it has to be counting the server's number and not a guess. This is also
    // the first call that tells the keepalive when the current token dies.
    // A failure here is not worth surfacing: the compile-time fallbacks are
    // asserted equal to the server constants, so both the countdown and the
    // renewal schedule are still correct.
    syncAdminSession(true)
      .then(({ ok, data }) => { if (ok) applyIdleLimit(data?.idleLimitSeconds); })
      .catch(() => { /* keep the fallbacks */ });

    // Activity only pushes the shared deadline — the memoized badge
    // re-renders on its own ticker, not the whole dashboard. The window comes
    // from `idlingRef`, so it is the server's number even before the first
    // refresh reply arrives.
    const resetIdleTimer = () => {
      idleDeadlineRef.current = Date.now() + idlingRef.current * 1000;
    };

    // ── Tell the SERVER, not just the badge ────────────────────────────────
    // Resetting the local deadline is not enough, and the gap between the two
    // was a real bug: the dashboard polls every 10s, and those polls are marked
    // `X-Admin-Background` so an unattended tab cannot hold a session open. That
    // is correct, and it means the server only ever learns of activity from a
    // NON-background request. So an admin who read the dashboard, moved the
    // mouse, and clicked nothing would watch a badge count down from ten
    // minutes that never ran out — while the server signed them out at ten.
    //
    // This beacon is the missing signal, and it is driven by exactly the same
    // events, so the two clocks can no longer disagree:
    //
    //   • at most once per ADMIN_ACTIVITY_BEACON_MS, so a person working
    //     continuously costs one request a minute, not one per keystroke;
    //   • only while there is genuine input, so it is silent when idle and
    //     cannot be what keeps a session alive;
    //   • it mints no token and fetches no data, so it is not on the
    //     token-keepalive path and cannot extend anything on its own.
    let lastBeacon = 0;
    let beaconInFlight = false;
    const sendActivityBeacon = () => {
      const now = Date.now();
      if (beaconInFlight || now - lastBeacon < ADMIN_ACTIVITY_BEACON_MS) return;
      lastBeacon = now;
      beaconInFlight = true;
      fetch(`${BASE_URL}/auth/admin-activity`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}` },
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          // Adopt the server's number if it differs, so a client whose clock has
          // drifted cannot show a countdown the API is not enforcing.
          if (data?.idleLimitSeconds) applyIdleLimit(data.idleLimitSeconds);
        })
        .catch(() => { /* the next event retries */ })
        .finally(() => { beaconInFlight = false; });
    };

    const activityEvents = ['keydown', 'mousedown', 'mousemove', 'scroll', 'touchstart', 'pointerdown', 'focus'];
    const handleActivity = () => { 
      // Don't reset timer if expiry modal has been shown
      if (modalShownRef.current) return;
      resetIdleTimer(); 
      sendActivityBeacon(); 
    };
    resetIdleTimer();

    activityEvents.forEach(eventName => window.addEventListener(eventName, handleActivity, { passive: true }));
    return () => {
      activityEvents.forEach(eventName => window.removeEventListener(eventName, handleActivity));
    };
  }, [navigate, applyIdleLimit, syncAdminSession]);

  // ── Token keepalive ────────────────────────────────────────────────────
  // Renews the JWT before it expires, so an administrator who is actually
  // working is never signed out by `exp`. It is the direct fix for the bug
  // described at ADMIN_TOKEN_LIFETIME_SECONDS above.
  //
  // The critical detail is `renew: true`. The request is fully validated on the
  // server — signature, account still enabled, and still inside the idle
  // window — so this cannot be used to keep an IDLE admin alive. It just does
  // not count as activity, which is what stops the timer from silently
  // disabling the ten-minute timeout for everyone.
  useEffect(() => {
    if (!localStorage.getItem('admin') || !localStorage.getItem('adminToken')) return undefined;

    // Seed from the compile-time fallback so the very first tick schedules off a
    // real deadline rather than firing immediately. The mount-time
    // /auth/admin-refresh replaces it with the server's own number a moment
    // later; this only covers the case where that call fails.
    tokenExpiresAtRef.current = Date.now() + tokenLifetimeRef.current * 1000;

    let inFlight = false;
    const renewIfDue = () => {
      // A second tick while a request is outstanding would race two renewals
      // and could store the older token last, shortening the window again.
      if (inFlight) return;
      const renewAt = tokenExpiresAtRef.current - tokenLifetimeRef.current * (1 - ADMIN_TOKEN_RENEWAL_RATIO) * 1000;
      if (Date.now() < renewAt) return;
      inFlight = true;
      syncAdminSession(false)
        .catch(() => { /* a failed attempt just leaves the next tick to retry */ })
        .finally(() => { inFlight = false; });
    };

    const tick = window.setInterval(renewIfDue, ADMIN_TOKEN_CHECK_INTERVAL_MS);
    // Coming back to a tab that was suspended can find the token already dead —
    // a backgrounded laptop that slept past `exp`. Renew immediately on return
    // rather than waiting for the next tick, and before any request is made.
    const onWake = () => { if (document.visibilityState === 'visible') renewIfDue(); };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);

    return () => {
      window.clearInterval(tick);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [syncAdminSession]);

  useEffect(() => {
    const refreshTimer = window.setInterval(() => { loadRef.current(true); }, ADMIN_REFRESH_INTERVAL_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') loadRef.current(true);
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  const changePassword = async (event) => {
    event.preventDefault();
    try {
      const data = await request('/profile/password', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profileForm) });
      setProfileMessage(data.message);
      setProfileForm({ currentPassword: '', newPassword: '', otp: '' });
    } catch (requestError) { setProfileMessage(requestError.message); }
  };

  const rotateAuthenticator = async (event) => {
    event.preventDefault();
    try {
      const data = await request('/profile/authenticator/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ otp: rotateOtp }) });
      setRotatedKey(data); setRotateOtp(''); setProfileMessage(data.message);
    } catch (requestError) { setProfileMessage(requestError.message); }
  };

  // Settings → Edit profile save. Only the keys that actually changed are
  // sent; the server treats a missing key as "leave it alone".
  const saveAppearance = useCallback(async (draft) => {
    const payload = {};
    if (draft.profilePicture !== appearance.profilePicture) payload.profilePicture = draft.profilePicture;
    if (draft.bannerPicture !== appearance.bannerPicture) payload.bannerPicture = draft.bannerPicture;
    if (Object.keys(payload).length === 0) {
      return { ok: false, message: 'No changes to save yet.', appearance };
    }
    try {
      const data = await request('/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      // The server echoes only the keys it actually wrote (it cannot return
      // the untouched picture without reading it back out of Atlas, which is
      // the multi-second cost this change exists to remove) — and the caller
      // already knows exactly what it sent, so merge those over the last known
      // state to build the same full pair the old response used to carry.
      const saved = { ...appearance };
      if (payload.profilePicture !== undefined) saved.profilePicture = payload.profilePicture;
      if (payload.bannerPicture !== undefined) saved.bannerPicture = payload.bannerPicture;
      // The save advanced the server's picture version: record it so the next
      // /profile tick sees "already current" and does not re-download the
      // pictures we are holding right here.
      picturesVersionRef.current = data?.picturesUpdatedAt ?? null;
      setAppearance(saved);
      setProfile(current => (current ? { ...current, ...saved } : current));
      return { ok: true, message: data?.message || 'Profile saved.', appearance: saved };
    } catch (requestError) {
      return { ok: false, message: requestError.message };
    }
  }, [request, appearance]);

  // Overview's cards jump straight to another tab, bypassing the sidebar. They
// are a path out of Chat management too, so they clear the deep-linked thread
// for the same reason handleTabClick does.
  const navigateToTab = useCallback((next) => {
    setFocusThreadId('');
    setTab(next);
  }, []);

  // Avatar-pill menu → jump into the Settings (profile) tab. That tab was
  // removed from the sidebar, so this menu is its only entry point.
  const openSettings = useCallback((section) => {
    // Leaving Chat management discards any deep-linked thread — see
    // openSecurityCenter for why this has to happen on every path out.
    setFocusThreadId('');
    setTab('profile');
    if (section === 'edit') setEditProfileOpen(true);
    const targetId = section === 'edit' ? 'admin-edit-profile' : 'admin-account-card';
    window.setTimeout(() => {
      const target = document.getElementById(targetId);
      if (!target) return;
      const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
    }, 90);
  }, []);

  const updateAccount = async (user, changes) => {
    try {
      const data = await request(`/users/${user._id}/account`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      setUsers(current => current.map(item => item._id === data.user._id ? { ...item, ...data.user } : item));
      setOverview(current => current ? { ...current, recentUsers: current.recentUsers.map(item => item._id === data.user._id ? { ...item, ...data.user } : item) } : current);
    } catch (requestError) { setError(requestError.message); }
  };

  // Destructive account removal. window.confirm() is gone on purpose: the
  // Android/Capacitor webview silently swallows it (the button looked dead),
  // and a native dialog cannot be styled. The row now raises a warning
  // banner + in-app confirmation modal instead.
  const deleteAccount = user => {
    setPendingDeleteUser(user || null);
  };

  const confirmDeleteAccount = async () => {
    const user = pendingDeleteUser;
    setPendingDeleteUser(null);
    if (!user) return;
    setDeletingUserId(user._id);
    try {
      const data = await request(`/users/${user._id}`, { method: 'DELETE' });
      await loadUsers();
      setError('');
      setNotice(data?.message || `${user.email} was deleted.`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setDeletingUserId('');
    }
  };

  const unlockUser = async (user) => {
    try {
      const data = await request(`/users/${user._id}/lockout`, { method: 'DELETE' });
      // Re-fetch authoritative state instead of optimistic "Clear" — if a
      // network-level hold remains, the row must keep showing Locked.
      await loadUsers();
      setError('');
      return data;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    }
  };

  // Marking one row read now happens in the detail window (detailMarkRead) —
  // pressing a row no longer marks it implicitly, because pressing a row is no
  // longer an implicit "I have read this".
  const markAllAdminRead = async () => {
    try {
      await request('/notifications/read-all', { method: 'POST' });
      // Live config warnings are not persisted, so the server keeps reporting
      // them unread. Dimming them here would just flicker back on the next
      // poll — and a failing check is not something an admin can "read" away.
      setNotifications(current => current.map(n => (n.dismissible === false ? n : { ...n, read: true })));
      // Keep an open window in step — otherwise it goes on offering "Mark as
      // read" for a row that is already read.
      setDetail(current => (current && current.dismissible !== false ? { ...current, read: true } : current));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  // Clears the read history. AdminEvent rows are shared across admins, so this
  // drops them for everyone — hence the confirmation, and no count in it: the
  // panel renders the newest 30 while the endpoint clears every read row.
  //
  // This only RAISES the dialog. The work happens in confirmClearReadAdminNotifications
  // below, so the browser's own confirm() is never involved.
  const clearAllReadAdminNotifications = () => {
    setConfirmingClearRead(true);
  };

  const confirmClearReadAdminNotifications = async () => {
    setConfirmingClearRead(false);
    if (clearingRead) return;
    setClearingRead(true);
    try {
      const data = await request('/notifications/delete-read', { method: 'POST' });
      setNotifications(current => current.filter(n => !n.read));
      setError('');
      setNotice(data?.message || 'Read notifications cleared.');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setClearingRead(false);
    }
  };

  const deleteAdminNotification = async (event, notificationId) => {
    event.stopPropagation();
    try {
      await request(`/notifications/${notificationId}`, { method: 'DELETE' });
      setNotifications(current => current.filter(n => n._id !== notificationId));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleNotificationClick = (notification) => {
    // Pressing a row opens the DETAIL WINDOW. It used to navigate straight
    // away, and the destination was picked from the type here in the browser —
    // which is how a support-chat bell ended up somewhere useless. The target
    // now rides on the row (`link`, written by the route that raised it) and is
    // resolved in notifications/notificationTargets.js. See goToAdminTarget.
    setDetailError('');
    setDetailBusy(null);
    setDetail(notification);
    setShowNotifications(false);
    // Same hover latch as the member bell: the pointer is still over the bell,
    // so without this the panel reopens behind the window.
    notifHoverSuppressedRef.current = !!notifBellRef.current?.matches(':hover');
  };

  // Apply a resolved target. Defined AFTER handleTabClick below, because it
  // calls it — hoisting it would be a temporal-dead-zone read at render time.
  // Declared as a plain function, not useCallback: handleTabClick is recreated
  // on every render, so memoising around it would buy nothing.
  const goToAdminTarget = (target) => {
    if (!target) return;
    setDetail(null);
    setShowNotifications(false);
    cancelNotifClose();
    // handleTabClick cancels any pending Security-center focus, so the security
    // branch goes through openSecurityCenter to keep that behaviour intact.
    if (target.tab === 'security') {
      openSecurityCenter();
    } else {
      handleTabClick(target.tab);
    }
    // One-shot: Chat management unmounts on tab change and resets its own
    // guard, so leaving the tab (handleTabClick above) clears this again. The
    // set MUST come after handleTabClick, which clears it for non-chat tabs.
    if (target.threadId) setFocusThreadId(target.threadId);
  };

  const detailMarkRead = useCallback(async () => {
    if (!detail || detail.read || !detail._id) return;
    const id = detail._id;
    try {
      setDetailBusy('read');
      await request('/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationIds: [id] }),
      });
      setNotifications(current => current.map(n => (n._id === id ? { ...n, read: true } : n)));
      setDetail(current => (current && current._id === id ? { ...current, read: true } : current));
      setDetailError('');
    } catch (requestError) {
      setDetailError(requestError.message);
    } finally {
      setDetailBusy(null);
    }
  }, [detail, request]);

  const detailDelete = useCallback(async () => {
    if (!detail || !detail._id) return;
    const id = detail._id;
    try {
      setDetailBusy('delete');
      await request(`/notifications/${id}`, { method: 'DELETE' });
      setNotifications(current => current.filter(n => n._id !== id));
      setDetail(null);
      setDetailError('');
    } catch (requestError) {
      setDetailError(requestError.message);
    } finally {
      setDetailBusy(null);
    }
  }, [detail, request]);

  // ── The detail window ────────────────────────────────────────────────────
  const closeDetail = useCallback(() => {
    setDetail(null);
    setDetailBusy(null);
    setDetailError('');
  }, []);

  const handleTabClick = (item) => {
    setTab(item);
    // A sidebar click is a deliberate move to a whole tab, so it always cancels
    // a pending deep-link focus. Without this, an admin who deep-linked to one
    // monitor, visited Users, then came back via the sidebar would land on a
    // Security Center still filtered to that one monitor with no visible cause.
    clearMonitorFocus();
    // Same rule for a deep-linked support conversation. Chat management
    // unmounts when the tab changes and its one-shot focus guard resets, so
    // leaving the tab without clearing this would re-open the same thread every
    // time the admin came back to the queue by hand.
    if (item !== 'chats') setFocusThreadId('');
    // Pre-fetch full lists the first time heavy tabs are opened
    if (item === 'assessment-management' && allUsers.length === 0) {
      request('/users?search=').then(data => {
        setAllUsers(data.users || []);
      }).catch(() => {});
    }
    if (item === 'admins' && admins.length === 0) {
      loadAdmins();
    }
  };

  /* Below 820px the section nav is a horizontally scrolling strip (see the
     "rail becomes a tab strip" block in AdminDashboard.css), so the active chip
     can start off-screen — a nav that does not show where you are looks broken.
     Centre it on every tab change. `block: 'nearest'` matters: the default
     `start` would scroll the whole page vertically to reveal the chip. */
  useEffect(() => {
    const nav = sidebarNavRef.current;
    if (!nav) return;
    const active = nav.querySelector('button.active');
    if (!active || nav.scrollWidth <= nav.clientWidth + 2) return;
    const target = active.offsetLeft - (nav.clientWidth - active.offsetWidth) / 2;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    nav.scrollTo({ left: Math.max(0, target), behavior: reduced ? 'auto' : 'smooth' });
  }, [tab]);

  const TAB_LABEL = {
    overview: 'Overview',
    users: 'User management',
    admins: 'Admin management',
    subscriptions: 'Subscription management',
    chats: 'Chat management',
    'assessment-management': 'Assessment Management',
    proposals: 'AI Learning Log',
    ai: 'AI management',
    profile: 'Profile',
    security: 'Security',
  };

  return (
    <div className={`admin-shell${sidebarCollapsed ? ' admin-shell--collapsed' : ''}`}>

      {/* ── Topbar: spans full width above sidebar + main ── */}
      <AdminTopbar
        admin={profile}
        profilePicture={appearance.profilePicture}
        unreadCount={unreadCount}
        showNotifications={showNotifications}
        onToggleNotifications={toggleNotifications}
        onManageAccount={() => openSettings('account')}
        onEditProfile={() => openSettings('edit')}
        onSignOut={() => setShowLogoutConfirm(true)}
        onMenuOpenChange={(open) => {
          // One anchored panel at a time — opening the profile menu closes
          // the notification panel (the bell does the reverse on its click).
          if (open) { cancelNotifClose(); setShowNotifications(false); }
        }}
        bellRef={notifBellRef}
        onBellPointerEnter={handleNotifHoverEnter}
        onBellPointerLeave={handleNotifHoverLeave}
      />

      <div className="admin-body">

        {/* ── Sidebar ──────────────────────────────────────── */}
        <aside className={`admin-sidebar${sidebarCollapsed ? ' admin-sidebar--collapsed' : ''}`}>

          {/* Hamburger only — brand text removed */}
          <div className="sidebar-header">
            <button
              className="hamburger-btn"
              aria-label={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed(v => {
                const next = !v;
                localStorage.setItem('adminSidebarCollapsed', String(next));
                return next;
              })}
            >
              {sidebarCollapsed ? (
                <svg key="menu" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="hamburger-icon">
                  <line x1="3" y1="6"  x2="21" y2="6"/>
                  <line x1="3" y1="12" x2="21" y2="12"/>
                  <line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
              ) : (
                <svg key="back" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="hamburger-icon">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
              )}
            </button>
          </div>

          {/* Nav items */}
          <nav ref={sidebarNavRef}>
            {tabs.map(item => (
              <button
                key={item}
                className={tab === item ? 'active' : ''}
                onClick={() => handleTabClick(item)}
                /* Labels are also hidden by the ≤820px media query (not only by
                   the collapsed class), so the tooltip must always be present. */
                title={TAB_LABEL[item]}
                aria-label={item === 'chats' && chatsUnread > 0
                  ? `${TAB_LABEL[item]}, ${chatsUnread} unread message${chatsUnread === 1 ? '' : 's'}`
                  : TAB_LABEL[item]}
                aria-current={tab === item ? 'page' : undefined}
              >
                <span className="sidebar-nav-icon">
                  {TAB_ICONS[item]}
                  {item === 'chats' && chatsUnread > 0 && (
                    <span className="sidebar-nav-dot" aria-hidden="true" />
                  )}
                </span>
                <span className="sidebar-nav-label">{TAB_LABEL[item]}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* Sign-out confirmation — same design as the user Profile page */}
        {showLogoutConfirm && (
          <ConfirmLogoutModal
            message="Your admin session will end and you'll be taken back to the admin sign-in page."
            onConfirm={() => { setShowLogoutConfirm(false); signOut(); }}
            onCancel={() => setShowLogoutConfirm(false)}
          />
        )}

        {/* Delete-account warning + confirmation. Replaces the old
            window.confirm(), which the Android webview blocked (the button
            looked dead) and which cannot be styled. */}
        {pendingDeleteUser && (
          <ConfirmModal
            type="danger"
            title="Delete this account?"
            message={pendingDeleteUser.email + ' will be permanently removed from the database together with all of its data (assessments, sessions and notifications). This cannot be undone.'}
            confirmText="Yes, delete permanently"
            cancelText="Keep account"
            onConfirm={confirmDeleteAccount}
            onCancel={() => setPendingDeleteUser(null)}
          />
        )}

        {/* Delete all read notifications. Same reason as the account dialog
            above: window.confirm() is swallowed by the Android/Capacitor
            webview, so the button looked dead, and a native dialog cannot be
            styled. Read history is shared across admins — clearing it drops
            these rows for everyone signed in to the console. */}
        {confirmingClearRead && (
          <ConfirmModal
            type="danger"
            title="Delete all read notifications?"
            message="This clears the read history for every administrator, not just you. Unread notifications are kept. This cannot be undone."
            confirmText={clearingRead ? 'Deleting…' : 'Delete read notifications'}
            cancelText="Keep them"
            onConfirm={confirmClearReadAdminNotifications}
            onCancel={() => setConfirmingClearRead(false)}
          />
        )}

        {/* ── Main content ─────────────────────────────────── */}
        <main className="admin-main">

          {/* Notification panel: position:fixed + JS-anchored to the bell
              (survives scrolling), opens on hover, arrow points up at the
              bell. Rendered inside main only to keep JSX locality — fixed
              positioning takes it out of this flow. */}
          {showNotifications && (
            <div
              className="notification-panel admin-notif-panel nd-root"
              ref={notifPanelRef}
              onPointerEnter={handleNotifHoverEnter}
              onPointerLeave={handleNotifHoverLeave}
            >
              <div className="admin-notif-panel__header">
                <span className="admin-notif-panel__heading">
                  <h3>System notifications</h3>
                  {/* The count is restated here in words. The bell's badge is
                      covered by the moment the panel opens, which left the
                      header able to say nothing at all about how much is
                      waiting. */}
                  <span className={`admin-notif-panel__count${unreadCount > 0 ? '' : ' admin-notif-panel__count--clear'}`}>
                    {unreadCount > 0 ? `${unreadCount} unread` : 'All clear'}
                  </span>
                </span>
                {/* Both actions share one wrapping group: the title ellipsises
                    first so the two labels never collide with each other. */}
                <div className="admin-notif-panel__actions">
                  {unreadCount > 0 && (
                    <button
                      type="button"
                      className="admin-notif-panel__action"
                      onClick={markAllAdminRead}
                    >
                      Mark all as read
                    </button>
                  )}
                  {readCount > 0 && (
                    <button
                      type="button"
                      className="admin-notif-panel__action admin-notif-panel__action--danger"
                      onClick={clearAllReadAdminNotifications}
                    >
                      Delete all read
                    </button>
                  )}
                </div>
              </div>
              <div className="admin-notif-panel__list">
              {notifications.length
                ? notifications.map((notification, index) => {
                  const kind = visualKind(notification, 'admin');
                  const target = resolveAdminTarget(notification);
                  return (
                    <div
                      className={[
                        'nd-row',
                        `nd-kind-${kind}`,
                        notification.read ? '' : 'nd-row--unread',
                        notification.dismissible === false ? 'nd-row--live' : '',
                      ].filter(Boolean).join(' ')}
                      key={notification._id || `live-${index}`}
                      onClick={() => handleNotificationClick(notification)}
                      role="button"
                      tabIndex={0}
                      aria-label={`${notification.read ? 'Read' : 'Unread'}: ${notification.title}`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleNotificationClick(notification);
                        }
                      }}
                      title={target ? `Details — ${target.label}` : 'Details'}
                    >
                      {/* Title + detail live in their own flex child so the
                          delete button is a sibling, never a float that
                          drifts into the middle of the text. */}
                      <span className="nd-tile">
                        <NotificationGlyph kind={kind} />
                      </span>
                      <span className="nd-body">
                        <span className="nd-title">{notification.title}</span>
                        {notification.detail && <span className="nd-detail">{notification.detail}</span>}
                      </span>
                      <span className={`nd-state${notification.read ? '' : ' nd-state--unread'}`}>
                        {notification.read ? 'Read' : 'New'}
                      </span>
                      {notification.dismissible === false ? (
                        <span className="notification__live">Fix</span>
                      ) : (
                        <button
                          type="button"
                          className="nd-remove"
                          aria-label={`Delete: ${notification.title}`}
                          onClick={(e) => notification._id && deleteAdminNotification(e, notification._id)}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                               strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                            <path d="M18 6L6 18M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                  );
                })
                : (
                  <div className="nd-empty" role="status">
                    <span className="nd-empty__art">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20.5 8.5A8.5 8.5 0 0 0 4 8.5c0 6.5-2.5 8.5-2.5 8.5h21S20.5 15 20.5 8.5" />
                        <path d="M9 20.5a3.2 3.2 0 0 0 6 0" />
                        <path d="M9.5 11.5l1.8 1.8 3.4-3.6" />
                      </svg>
                    </span>
                    <p className="nd-empty__title">All clear</p>
                    <p className="nd-empty__body">
                      New conversations, priority flags and requests will appear here.
                    </p>
                  </div>
                )
              }
              </div>
              {notifications.length > 0 && (
                <p className="admin-notif-panel__hint" aria-hidden="true">
                  Select a notification to see the full message
                </p>
              )}
            </div>
          )}

          {/* The notification detail window. A SIBLING of the panel, not a child:
              rendering it inside would let the panel's own close-on-outside-click
              handler unmount it the moment it opened. */}
          <NotificationDetailModal
            item={detail}
            kind="admin"
            target={detail ? resolveAdminTarget(detail) : null}
            busy={detailBusy}
            canDelete={!!detail?.dismissible}
            error={detailError}
            onClose={closeDetail}
            onMarkRead={detailMarkRead}
            onDelete={detailDelete}
            onGoTo={() => goToAdminTarget(resolveAdminTarget(detail))}
          />

          <header className="admin-header">
            <div>
              <p className="admin-kicker">ADMINISTRATOR / {tab.toUpperCase()}</p>
              <h1>
                {tab === 'overview'             ? 'System overview'
                  : tab === 'ai'               ? 'AI management and control'
                  : tab === 'users'            ? 'User management'
                  : tab === 'admins'           ? 'Admin management'
                  : tab === 'subscriptions'    ? 'Subscription management'
                  : tab === 'chats'            ? 'Chat management'
                  : tab === 'security'         ? 'Security center'
                  : tab === 'profile'          ? 'Administrator profile'
                  : tab === 'proposals'        ? 'AI learning log'
                  : 'Assessment Management'}
              </h1>
            </div>
            {/* Manual reload. The panel polls on its own, but an operator
                watching for a subscription approval or a lockout release should
                not have to wait out the interval to see it land. */}
            <div className="admin-header__actions">
              <button
                type="button"
                className="admin-secondary admin-refresh"
                onClick={() => load(true)}
                disabled={refreshing}
                aria-label="Refresh dashboard data"
              >
                <UserStatIcon name="activity" size={15} />
                <span>{refreshing ? 'Refreshing…' : 'Refresh'}</span>
              </button>
            </div>
          </header>

          <AdminIdleStatus
            deadlineRef={idleDeadlineRef}
            modalShownRef={modalShownRef}
            idleLimitSeconds={idleLimit}
            warningSeconds={ADMIN_WARNING_SECONDS}
            onExpire={handleIdleExpire}
            onStay={handleStayActive}
          />

          {error && <div className="admin-alert danger" role="alert">{error}</div>}
          {notice && <div className="admin-alert success" role="status">{notice}</div>}

          {tab === 'overview'               && <div className="admin-tab-panel"><Overview overview={overview} onNavigate={navigateToTab} monitor={monitor} onOpenSecurity={openSecurityCenter} /></div>}
          {tab === 'users'                  && <div className="admin-tab-panel"><Users users={users} setUsers={setUsers} usersFetchedAt={usersFetchedAt} search={search} setSearch={value => { searchRef.current = value; setSearch(value); }} loadUsers={loadUsers} request={request} onSubscriptionChanged={applySubscriptionUpdate} updateAccount={updateAccount} deleteAccount={deleteAccount} deletingUserId={deletingUserId} unlockUser={unlockUser} expandedUser={expandedUser} setExpandedUser={setExpandedUser} /></div>}
          {tab === 'admins'                 && <div className="admin-tab-panel"><Admins admins={admins} adminsFetchedAt={adminsFetchedAt} search={adminSearch} setSearch={value => { adminSearchRef.current = value; setAdminSearch(value); }} loadAdmins={loadAdmins} toggleAdmin={toggleAdmin} unlockAdmin={unlockAdmin} currentAdmin={profile} expandedAdmin={expandedAdmin} setExpandedAdmin={setExpandedAdmin} request={request} /></div>}
          {tab === 'subscriptions'          && <div className="admin-tab-panel"><AdminSubscriptionRequests request={request} /></div>}
          {tab === 'chats'                   && <div className="admin-tab-panel"><AdminSupportChats request={request} secure={adminSecureChat} adminAccountId={adminAccountId} focusThreadId={focusThreadId} adminProfile={appearance} onUnreadChange={setChatsUnread} /></div>}
          {tab === 'assessment-management'  && <div className="admin-tab-panel"><AssessmentManagement users={allUsers} /></div>}
          {tab === 'proposals'              && <div className="admin-tab-panel"><ConditionProposals /></div>}
          {tab === 'ai'                     && <div className="admin-tab-panel"><AiPanel ai={ai} onCheckNow={checkAiNow} checking={checkingAi} reload={aiReload} /></div>}
          {tab === 'security'               && <div className="admin-tab-panel"><SecurityStatus monitor={monitor} onDownloadReport={() => downloadReportRef.current()} detection={ai?.detection} focusMonitorKey={focusMonitorKey} /></div>}
          {tab === 'profile'                && <div className="admin-tab-panel"><ProfilePanel profile={profile} appearance={appearance} onSaveAppearance={saveAppearance} editOpen={editProfileOpen} onToggleEdit={() => setEditProfileOpen(v => !v)} form={profileForm} setForm={setProfileForm} message={profileMessage} onSubmit={changePassword} rotateOtp={rotateOtp} setRotateOtp={setRotateOtp} rotatedKey={rotatedKey} onRotate={rotateAuthenticator} /></div>}
        </main>
      </div>
    </div>
  );
}

// Metric icon map
const METRIC_ICONS = {
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  assessments: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
    </svg>
  ),
  activeSubscriptions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  inactiveSubscriptions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
  ),
};

const METRIC_LABEL = {
  users:                 'Total Users',
  assessments:           'Assessments',
  activeSubscriptions:   'Active Subscriptions',
  inactiveSubscriptions: 'Inactive Subscriptions',
};

/* Canonical card order. The server sends these four keys in this order, but the
   panel must not depend on object key order for its own layout — a reordered
   JSON payload used to shuffle the row. */
const METRIC_ORDER = ['users', 'assessments', 'activeSubscriptions', 'inactiveSubscriptions'];

/* Vibrant identity per metric. The card paints its own gradient through
   --ov-from / --ov-to, so the top row reads as four distinct facts instead of
   four identical white boxes. `glow` is the matching drop-shadow — a hex
   custom property cannot express alpha, so the rgba is passed in rather than
   left to color-mix(), which older Android webviews do not support. */
const METRIC_STYLE = {
  users:                 { from: '#4f46e5', to: '#8b5cf6', glow: 'rgba(99, 102, 241, .75)' },
  assessments:           { from: '#0891b2', to: '#22d3ee', glow: 'rgba(8, 145, 178, .75)' },
  activeSubscriptions:   { from: '#059669', to: '#34d399', glow: 'rgba(5, 150, 105, .75)' },
  inactiveSubscriptions: { from: '#ea580c', to: '#fbbf24', glow: 'rgba(234, 88, 12, .7)' },
};

/* Severity orders for the health-profile strips. These are the labels the
   assessment questionnaire actually offers (AssessmentPage SLEEP_OPTIONS, the
   diet radio list, and the Low/Moderate/High/Severe stress scale the
   recommendation engine branches on), listed best → worst so a strip always
   reads left-to-right from healthy to concerning.

   A label that is NOT in these lists still renders — buildSegments appends
   unknown labels in count order — so adding an option to the questionnaire
   shows up here rather than silently disappearing. */
const DIET_ORDER = ['DASH', 'Mediterranean', 'Flexitarian', 'Pescatarian', 'Omnivore', 'Vegetarian', 'Paleo', 'Keto', 'Vegan', 'Carnivore'];
const STRESS_ORDER = ['Low', 'Moderate', 'High', 'Severe'];
const SLEEP_ORDER = ['Excellent', 'Good', 'Average', 'Poor', 'Very Poor'];

const METRIC_STYLE_FALLBACK = { from: '#334155', to: '#64748b', glow: 'rgba(51, 65, 85, .6)' };

// Status words for a live monitor row. These mirror the labels the Security
// Center's own status pills use, so a control described here reads identically
// once the admin follows the link.
const THREAT_STATUS_LABEL = {
  critical: 'Critical',
  error: 'Error',
  warning: 'Warning',
};
const statusLabel = status => THREAT_STATUS_LABEL[status] || 'Warning';

// Wall-clock time of the last completed probe run. Deliberately absolute
// rather than relative ("2m ago"): the Overview card has no live clock of its
// own, and a relative label with no clock behind it would sit frozen showing a
// number that is quietly wrong.
function formatMonitorClock(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* `overview` is null until the first GET /admin/overview answers, so every
   branch below has to render from a missing payload rather than assume a shape
   — the skeleton is what a first-time visitor sees during that window. */
function Overview({ overview, onNavigate, monitor, onOpenSecurity }) {
  const metrics = (overview && typeof overview.metrics === 'object' && overview.metrics) || {};
  const analytics = (overview && typeof overview.analytics === 'object' && overview.analytics) || {};
  const recentUsers = Array.isArray(overview?.recentUsers) ? overview.recentUsers : [];

  /* Which window the two trend charts are read over. ONE control drives both, so
     "signups" and "assessments" can never be showing different spans of time
     without the reader noticing — which is the one way two side-by-side charts
     quietly contradict each other. */
  const [rangeDays, setRangeDays] = useState(OVERVIEW_TREND_DAYS);
  // The server ships the widest window once; the toggle may only narrow to it.
  const windowOptions = useMemo(
    () => OVERVIEW_TREND_OPTIONS.filter(days => days <= trendCeiling(overview?.trendDays)),
    [overview?.trendDays],
  );
  // A payload that lands mid-session can report a narrower ceiling than the
  // window already selected. Falling back rather than clamping keeps the label
  // ("last 30 days") and the rendered chart in agreement.
  const activeWindow = normalizeWindow(rangeDays, overview?.trendDays);
  // The card is driven by the SAME live monitor the Security tab renders, not by
  // the static env checks in `overview.notifications`. Those two sets barely
  // overlap, so the card could read "All systems secure" while the Security
  // Center it links to was showing critical monitors.
  const monitorTotal = monitor?.total || 0;
  const monitorCounts = (monitor && typeof monitor.counts === 'object' && monitor.counts) || {};
  const attention = Array.isArray(monitor?.attention) ? monitor.attention : [];
  const monitorPending = Boolean(monitor?.pending);
  const monitorError = monitor?.error || '';
  const monitorSyncedAt = monitor?.syncedAt || null;
  const healthyCount = monitorCounts.healthy || 0;
  const warningCount = monitorCounts.warning || 0;
  const criticalCount = (monitorCounts.critical || 0) + (monitorCounts.error || 0);
  // How many live probes the card is allowed to list before deferring the rest
  // to the Security tab. The panel is one column of a dashboard grid; a full 45
  // rows would push every other panel below the fold.
  const THREAT_PREVIEW = 4;
  const shownThreats = attention.slice(0, THREAT_PREVIEW);
  const hiddenThreats = attention.length - shownThreats.length;

  const totalUsers = Math.max(0, Number(metrics.users) || 0);
  const paidMembers = Math.max(0, Number(metrics.activeSubscriptions) || 0);
  const freeMembers = Math.max(0, Number(metrics.inactiveSubscriptions) || 0);

  /* ── Activity window ────────────────────────────────────────────── */
  const series = buildTrendSeries(overview?.assessmentTrend, activeWindow);
  const windowTotal = series.reduce((sum, day) => sum + day.count, 0);
  const windowMax = series.reduce((max, day) => Math.max(max, day.count), 0);
  const windowDays = series.length;
  const windowAvg = windowDays ? windowTotal / windowDays : 0;
  const peak = series.reduce((best, day) => (day.count > (best?.count ?? -1) ? day : best), null);
  // The axis and its gridlines are built from one list, so the labels can never
  // drift out of step with the lines they label.
  const ticks = axisTicks(windowMax);
  const firstDay = dayParts(series[0]?.key);
  const lastDay = dayParts(series[windowDays - 1]?.key);
  const windowLabel = windowDays
    ? `${firstDay.month} ${firstDay.number} – ${lastDay.month} ${lastDay.number}`
    : `Last ${activeWindow} days`;
  // The badge is the total ASSESSMENTS IN THE WINDOW, never "all time" — the
  // two used to be conflated, which made a quiet fortnight look like a
  // collapsing product when the lifetime total was unchanged.
  const windowShare = windowTotal > 0
    ? `${Math.min(100, Math.round((windowTotal / (Number(metrics.assessments) || windowTotal)) * 100))}% of all time`
    : 'None in this window';

  /* ── Metric cards ───────────────────────────────────────────────── */
  const metricNotes = {
    users: `${formatCount(paidMembers)} paying · ${formatCount(freeMembers)} free`,
    assessments: windowTotal > 0
      ? `${formatCount(windowTotal)} in the last ${windowDays || activeWindow} days`
      : 'None in this window',
    activeSubscriptions: shareOf(paidMembers, totalUsers),
    inactiveSubscriptions: shareOf(freeMembers, totalUsers),
  };
  const metricKeys = [
    ...METRIC_ORDER.filter(key => metrics[key] !== undefined),
    ...Object.keys(metrics).filter(key => !METRIC_ORDER.includes(key)),
  ];

  /* ── Plan mix ───────────────────────────────────────────────────── */
  // Derives the free tier from the member count (the server's breakdown only
  // ever holds live paid plans) and guarantees the four rows sum to the donut.
  const { rows: planRows, total: planTotal } = buildPlanMix(
    analytics.planBreakdown, totalUsers, PLAN_LABELS,
  );
  const donutStyle = donutBackground(planRows, planTotal);

  /* ── Security & growth ──────────────────────────────────────────── */
  const lockedNow = Math.max(0, Number(analytics.lockedAccounts) || 0);
  const twoFactorOn = Math.max(0, Number(analytics.twoFactorEnabled) || 0);
  const twoFactorPct = Math.max(0, Math.min(100, Number(analytics.twoFactorPct) || 0));
  const signups7d = Math.max(0, Number(analytics.signups7d) || 0);
  const signups30d = Math.max(0, Number(analytics.signups30d) || 0);
  const securityTiles = [
    {
      id: '2fa', icon: 'shield', tone: 'indigo', value: `${twoFactorPct}%`, label: '2FA adoption',
      note: `${formatCount(twoFactorOn)} of ${formatCount(totalUsers)} members`,
      progress: twoFactorPct,
    },
    {
      id: 'locked', icon: 'lock', tone: lockedNow > 0 ? 'rose' : 'emerald', value: formatCount(lockedNow),
      label: 'Locked now', note: lockedNow > 0 ? 'Waiting to be unlocked' : 'No lockouts active',
    },
    {
      id: 'new7', icon: 'user', tone: 'violet', value: formatCount(signups7d),
      label: 'New · 7 days', note: shareOf(signups7d, totalUsers),
    },
    {
      id: 'new30', icon: 'calendar', tone: 'cyan', value: formatCount(signups30d),
      label: 'New · 30 days', note: shareOf(signups30d, totalUsers),
    },
  ];

  /* ── Acquisition: signups over the selected window ───────────────── */
  // The series is read at the FULL ceiling, not at the selected window, because
  // the ± comparison underneath needs a real 7-day baseline behind the recent 7.
  // Narrowing the source to 7 days would make that baseline 7 days of zeros and
  // print "−100%" against a week that never existed.
  const signupSeries = buildTrendSeries(overview?.signupTrend, trendCeiling(overview?.trendDays));
  // The PLOT is then cut back to the selected window, unconditionally. The
  // comparison keeps the full series; the chart must not, or the two panels
  // under one shared range control would quietly be showing different spans of
  // time — the one way two side-by-side charts contradict each other.
  const signupWindow = signupSeries.slice(Math.max(0, signupSeries.length - activeWindow));
  const signupTotal = signupWindow.reduce((sum, day) => sum + day.count, 0);
  const signupMax = signupWindow.reduce((max, day) => Math.max(max, day.count), 0);
  // Always a 7-vs-7 comparison, whatever the chart is showing, and labelled as
  // such — a reader who has the window on 30 days must not assume the delta
  // covers 30 days.
  const signupCompare = compareWindows(signupSeries, { recent: 7, previous: 7 });
  const signupSpark = sparkPath(signupWindow, { width: 320, height: 96 });
  const signupFirst = dayParts(signupWindow[0]?.key);
  const signupLast = dayParts(signupWindow[signupWindow.length - 1]?.key);
  const signupRangeLabel = signupWindow.length
    ? `${signupFirst.month} ${signupFirst.number} – ${signupLast.month} ${signupLast.number}`
    : `Last ${activeWindow} days`;
  // Peak day, as a date. Without it the sparkline shows a shape with no way to
  // ask "which day was that?".
  const signupPeak = signupWindow.reduce((best, day) => (day.count > (best?.count ?? -1) ? day : best), null);
  const signupPeakLabel = signupPeak?.count > 0 ? dayParts(signupPeak.key) : null;

  /* ── Activation funnel ──────────────────────────────────────────── */
  // Registered is the denominator for the WHOLE funnel, so the three rows are
  // always comparable: the share column answers "of everyone who ever joined,
  // how far did they get", which is the only question the rows can answer
  // against each other.
  const activatedMembers = Math.min(totalUsers, Math.max(0, Number(analytics.activatedMembers) || 0));
  const funnelRows = buildFunnel([
    { key: 'registered', label: 'Registered', hint: 'Accounts created', value: totalUsers },
    { key: 'assessed', label: 'Took an assessment', hint: 'Reached the questionnaire', value: activatedMembers },
    { key: 'subscribed', label: 'Subscribed', hint: 'On a live paid plan', value: paidMembers },
  ]);
  const funnelTop = funnelRows[0]?.value || 0;
  // One number is not a conversion, so the panel says so rather than printing
  // a confident 100% for a single-member install.
  const funnelVerdict = funnelTop > 1 ? null : 'Not enough members to read a conversion rate yet.';

  /* ── Engagement depth ───────────────────────────────────────────── */
  const active7d = Math.max(0, Number(analytics.activeAssessors7d) || 0);
  const active30d = Math.max(0, Number(analytics.activeAssessors30d) || 0);
  const repeatAssessors = Math.max(0, Number(analytics.repeatAssessors) || 0);
  const oneOffAssessors = Math.max(0, Number(analytics.oneOffAssessors) || 0);
  const repeatPct = Math.max(0, Math.min(100, Number(analytics.repeatPct) || 0));
  const totalAssessments = Math.max(0, Number(metrics.assessments) || 0);
  const engagementTiles = [
    {
      id: 'activation', icon: 'flag', tone: 'indigo', value: formatCount(activatedMembers),
      label: 'Ever assessed', note: activatedMembers > 0 ? shareOf(activatedMembers, totalUsers) : 'Nobody has submitted one yet',
      progress: totalUsers > 0 ? Math.round((activatedMembers / totalUsers) * 100) : 0,
    },
    {
      id: 'returning', icon: 'repeat', tone: 'emerald', value: `${repeatPct}%`, label: 'Returned members',
      note: `${formatCount(repeatAssessors)} of ${formatCount(activatedMembers)} came back`,
      progress: repeatPct,
    },
    {
      id: 'active7', icon: 'pulse', tone: 'violet', value: formatCount(active7d),
      label: 'Active · 7 days', note: active30d > 0 ? `${formatCount(active30d)} in 30 days` : 'No 30-day activity yet',
    },
    {
      id: 'depth', icon: 'layers', tone: 'cyan', value: rateOf(totalAssessments, activatedMembers),
      label: 'Per assessor', note: `${formatCount(oneOffAssessors)} took exactly one`,
    },
  ];

  /* ── Renewal runway ─────────────────────────────────────────────── */
  const runway = (analytics.runway && typeof analytics.runway === 'object' && analytics.runway) || {};
  const expiring7d = Math.max(0, Number(runway.expiring7d) || 0);
  const expiring30d = Math.max(0, Number(runway.expiring30d) || 0);
  const permanentGrants = Math.max(0, Number(runway.permanent) || 0);
  const lapsed30d = Math.max(0, Number(runway.lapsed30d) || 0);
  // The server prices this from the catalogue the checkout charges from, so the
  // figure cannot drift from the pricing page. It is LIST value, and is
  // labelled as such — plans are granted by hand, so nothing here has been
  // reconciled against a bank statement.
  const listValue = (analytics.listValueMonthly && typeof analytics.listValueMonthly === 'object'
    ? analytics.listValueMonthly : {}) || {};
  const listValueText = typeof listValue.formatted === 'string' && listValue.formatted.trim()
    ? listValue.formatted : '—';
  // expiring30d already includes expiring7d, so the "next 7-30 days" band is
  // the difference — adding them would double-count every imminent renewal.
  const expiringLater = Math.max(0, expiring30d - expiring7d);
  const runwayTiles = [
    {
      id: 'renew7', icon: 'refresh', tone: expiring7d > 0 ? 'amber' : 'emerald', value: formatCount(expiring7d),
      label: 'Renews · 7 days', note: expiring7d > 0 ? 'Follow up before the window closes' : 'Nothing due this week',
    },
    {
      id: 'renew30', icon: 'calendar', tone: 'cyan', value: formatCount(expiringLater),
      label: 'Renews · 7–30 days', note: `${formatCount(expiring30d)} inside 30 days`,
    },
    {
      id: 'permanent', icon: 'shield', tone: 'indigo', value: formatCount(permanentGrants),
      label: 'Permanent grants', note: `${formatCount(Math.max(0, Number(runway.live) || 0))} live in total`,
    },
    {
      id: 'lapsed', icon: 'flag', tone: lapsed30d > 0 ? 'rose' : 'emerald', value: formatCount(lapsed30d),
      label: 'Lapsed · 30 days', note: lapsed30d > 0 ? 'Windows that closed' : 'No recent lapses',
    },
  ];

  /* ── Member health profile ──────────────────────────────────────── */
  const profile = (analytics.profile && typeof analytics.profile === 'object' && analytics.profile) || {};
  // Fixed severity orders. The questionnaire is the source of these labels, and
  // a payload in a different order still renders worst-last.
  const dietSegments = buildSegments(profile.diets, DIET_ORDER);
  const stressSegments = buildSegments(profile.stress, STRESS_ORDER);
  const sleepSegments = buildSegments(profile.sleep, SLEEP_ORDER);
  const goalBars = buildRankedBars(
    (Array.isArray(profile.goals) ? profile.goals : []).map(goal => ({ label: goal?.label, value: goal?.count })),
    { limit: 5 },
  );
  const segmentTotal = segments => segments.reduce((sum, part) => sum + part.value, 0);

  /* ── Review backlog ─────────────────────────────────────────────── */
  const review = (analytics.review && typeof analytics.review === 'object' && analytics.review) || {};
  const priorityQueued = Math.max(0, Number(review.priority) || 0);
  const openFlags = Math.max(0, Number(review.openFlags) || 0);
  const backlogTotal = priorityQueued + openFlags;
  const reviewTiles = [
    {
      id: 'priority', icon: 'flag', tone: priorityQueued > 0 ? 'amber' : 'emerald', value: formatCount(priorityQueued),
      label: 'Priority queue', note: 'Flagged Priority by an admin',
    },
    {
      id: 'flags', icon: 'alert', tone: openFlags > 0 ? 'rose' : 'emerald', value: formatCount(openFlags),
      label: 'Open flags', note: 'Auto-detected, not yet resolved',
    },
    {
      id: 'clear', icon: 'check', tone: backlogTotal > 0 ? 'indigo' : 'emerald',
      value: backlogTotal > 0 ? formatCount(backlogTotal) : 'Clear', label: 'Awaiting review',
      note: backlogTotal > 0 ? 'Items in assessment management' : 'Nothing needs your attention',
    },
  ];


  return (
    <>
      {/* ── Metric cards ────────────────────────────────────────────────
          No metrics means the payload has not landed (or arrived without
          them), so the row holds the shape of four cards rather than
          collapsing to nothing and reflowing the page when data arrives. */}
      {metricKeys.length === 0 ? (
        <div className="ov-metric-grid" aria-hidden="true">
          {METRIC_ORDER.map(key => <div className="ov-skeleton__card" key={key} />)}
        </div>
      ) : (
        <section className="ov-metric-grid">
          {metricKeys.map((key) => {
            const icon = METRIC_ICONS[key];
            const label = METRIC_LABEL[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
            const palette = METRIC_STYLE[key] || METRIC_STYLE_FALLBACK;
            return (
              <article
                className="ov-metric"
                key={key}
                style={{ '--ov-from': palette.from, '--ov-to': palette.to, '--ov-glow': palette.glow }}
              >
                {icon && <span className="ov-metric__icon">{icon}</span>}
                <div className="ov-metric__body">
                  <span className="ov-metric__label">{label}</span>
                  <strong className="ov-metric__value">{formatMetricValue(metrics[key])}</strong>
                  <span className="ov-metric__note">{metricNotes[key] || ''}</span>
                </div>
              </article>
            );
          })}
        </section>
      )}

      {/* ── Analytics ───────────────────────────────────────────────── */}
      <section className="ov-analytics-grid">

        {/* Assessment activity */}
        <div className="admin-panel ov-analytics ov-activity-chart">
          <div className="ov-panel-header">
            <div>
              <h3>Assessment activity</h3>
              <p className="ov-panel-sub">{windowLabel}</p>
            </div>
            <div className="ov-panel-badges">
              <span className="ov-panel-count">{formatCount(windowTotal)} total</span>
              <span className="ov-panel-count">{windowAvg.toFixed(1)} / day</span>
            </div>
          </div>

          {/* One range control for BOTH trend charts. The server sends the widest
              window once, so switching costs a re-slice rather than a request —
              and because the control is shared, the two charts can never be
              showing different spans of time. */}
          <div className="ov-range" role="group" aria-label="Analytics time range">
            {windowOptions.map(days => (
              <button
                type="button"
                key={days}
                className={`ov-range__btn${days === activeWindow ? ' is-active' : ''}`}
                aria-pressed={days === activeWindow}
                onClick={() => setRangeDays(days)}
              >
                {days}d
              </button>
            ))}
            <span className="ov-range__hint">{windowShare}</span>
          </div>

          {windowTotal === 0 ? (
            <div className="ov-empty-state">
              <span className="ov-empty-state__icon"><UserStatIcon name="activity" size={26} /></span>
              <strong>No assessments in this window</strong>
              <p>New assessments will chart here the moment members start submitting them.</p>
            </div>
          ) : (
            <div
              className="ov-chart"
              role="img"
              aria-label={`Assessments per day over ${windowDays} days: ${windowTotal} in total, peak ${windowMax}.`}
            >
              <div className="ov-chart__axis" aria-hidden="true">
                {ticks.map(tick => <span key={tick}>{tick}</span>)}
              </div>
              <div className="ov-chart__plot">
                <div className="ov-chart__grid" aria-hidden="true">
                  {ticks.map(tick => <i key={tick} />)}
                </div>
                <div className="ov-bars">
                  {series.map((day, index) => {
                    const parts = dayParts(day.key);
                    const empty = day.count === 0;
                    const isPeak = Boolean(peak) && day.count > 0 && day.key === peak.key;
                    const heightPct = windowMax > 0 ? (day.count / windowMax) * 100 : 0;
                    return (
                      <div
                        className={`ov-bar-col${isPeak ? ' ov-bar-col--peak' : ''}`}
                        key={day.key}
                        title={`${parts.full}: ${day.count} assessment${day.count === 1 ? '' : 's'}`}
                      >
                        <div className="ov-bar-track">
                          <div
                            className={`ov-bar-fill${empty ? ' ov-bar-fill--empty' : ''}`}
                            style={{ height: `${empty ? 3 : Math.max(6, Math.round(heightPct))}%` }}
                          >
                            <span className="ov-bar-tip" aria-hidden="true">{day.count}</span>
                          </div>
                        </div>
                        <span className="ov-bar-label">{index === 0 ? parts.month : parts.number}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Plan mix */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <div>
              <h3>Plan mix</h3>
              <p className="ov-panel-sub">Live subscriptions</p>
            </div>
          </div>
          {planTotal === 0 ? (
            <div className="ov-empty-state">
              <span className="ov-empty-state__icon"><UserStatIcon name="users" size={26} /></span>
              <strong>No members yet</strong>
              <p>Plans will be split here as soon as the first account registers.</p>
            </div>
          ) : (
            <div className="ov-plan-body">
              <div className="ov-donut" style={{ backgroundImage: donutStyle }}>
                <div className="ov-donut__hole">
                  <strong>{formatCount(planTotal)}</strong>
                  <span>{planTotal === 1 ? 'member' : 'members'}</span>
                </div>
              </div>
              <ul className="ov-plan-list">
                {planRows.map(row => {
                  const pct = planTotal > 0 ? Math.round((row.value / planTotal) * 100) : 0;
                  return (
                    <li className="ov-plan-row" key={row.key}>
                      <span className="ov-plan-dot" style={{ background: row.color }} aria-hidden="true" />
                      <span className="ov-plan-text">
                        <span className="ov-plan-label">{row.label}</span>
                        <span className="ov-plan-hint">{row.hint}</span>
                      </span>
                      <span className="ov-plan-track" aria-hidden="true">
                        <span
                          className="ov-plan-fill"
                          style={{ width: `${pct}%`, background: row.color }}
                        />
                      </span>
                      <span className="ov-plan-nums">
                        <strong>{formatCount(row.value)}</strong>
                        <small>{pct}%</small>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>

        {/* Security & growth */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <div>
              <h3>Security &amp; growth</h3>
              <p className="ov-panel-sub">Posture at a glance</p>
            </div>
          </div>
          <div className="ov-stats">
            {securityTiles.map(tile => (
              <div className={`ov-stat ov-stat--${tile.tone}`} key={tile.id}>
                <span className="ov-stat__icon"><UserStatIcon name={tile.icon} size={17} /></span>
                <strong className="ov-stat__value">{tile.value}</strong>
                <span className="ov-stat__label">{tile.label}</span>
                <span className="ov-stat__note">{tile.note}</span>
                {tile.progress !== undefined && (
                  /* The meter is decoration — the number above it is the fact,
                     and it is already in the accessible name. */
                  <span className="ov-stat__meter" aria-hidden="true">
                    <i style={{ width: `${tile.progress}%` }} />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>

      </section>

      {/* ── Analytics, second tier ─────────────────────────────────────
          Acquisition, activation, engagement depth, renewal runway, the health
          profile members submit, and the review backlog. Each row is
          self-contained: an empty payload renders an empty state or a zeroed
          tile, never a blank box and never a NaN in a style attribute. */}
      <section className="ov-analytics-grid ov-analytics-grid--even">

        {/* Signup momentum — the top of the funnel, over time. */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <div>
              <h3>Signup momentum</h3>
              <p className="ov-panel-sub">{signupRangeLabel}</p>
            </div>
            <div className="ov-panel-badges">
              <span className="ov-panel-count">{formatCount(signupTotal)} new</span>
              <span className="ov-panel-count">
                {signupCompare.pct === null
                  ? `${formatCount(signupCompare.recent)} in 7 days`
                  : `${signedPercent(signupCompare.pct)} vs prev 7d`}
              </span>
            </div>
          </div>

          {signupTotal === 0 ? (
            <div className="ov-empty-state">
              <span className="ov-empty-state__icon"><UserStatIcon name="user" size={26} /></span>
              <strong>No new accounts in this window</strong>
              <p>The line starts drawing here the moment someone registers.</p>
            </div>
          ) : (
            <>
              <div
                className="ov-spark"
                role="img"
                aria-label={`New accounts per day over ${signupWindow.length} days: ${signupTotal} in total, peak ${signupMax} on ${signupPeakLabel ? signupPeakLabel.full : 'no single day'}.`}
              >
                <svg viewBox="0 0 320 96" preserveAspectRatio="none" focusable="false">
                  <defs>
                    <linearGradient id="ov-spark-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6366f1" stopOpacity="0.34" />
                      <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
                    </linearGradient>
                  </defs>
                  <path className="ov-spark__area" d={signupSpark.area} fill="url(#ov-spark-fill)" />
                  <path className="ov-spark__line" d={signupSpark.line} />
                </svg>
              </div>
              <p className="ov-spark__foot">
                {signupPeakLabel
                  ? <>Peak {signupPeakLabel.full} · <strong>{signupPeak.count}</strong> {signupPeak.count === 1 ? 'account' : 'accounts'}</>
                  : `${formatCount(signupMax)} at the busiest`}
                <span className="ov-spark__delta">
                  {signupCompare.direction === 'up' ? '▲' : signupCompare.direction === 'down' ? '▼' : '■'}{' '}
                  {formatCount(Math.abs(signupCompare.delta))} vs previous 7 days
                </span>
              </p>
            </>
          )}
        </div>

        {/* Member journey — registered → assessed → subscribed. */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <div>
              <h3>Member journey</h3>
              <p className="ov-panel-sub">Share of everyone who joined</p>
            </div>
          </div>
          {funnelRows.length === 0 || totalUsers === 0 ? (
            <div className="ov-empty-state">
              <span className="ov-empty-state__icon"><UserStatIcon name="users" size={26} /></span>
              <strong>No members yet</strong>
              <p>The funnel builds itself from the first account to register.</p>
            </div>
          ) : (
            <>
              <ul className="ov-funnel">
                {funnelRows.map((row, index) => (
                  <li className="ov-funnel__row" key={row.key}>
                    <div className="ov-funnel__head">
                      <span className="ov-funnel__label">{row.label}</span>
                      <span className="ov-funnel__nums">
                        <strong>{formatCount(row.value)}</strong>
                        <small>{row.sharePct}%</small>
                      </span>
                    </div>
                    <span className="ov-funnel__track" aria-hidden="true">
                      <i
                        style={{ width: `${row.widthPct}%` }}
                        data-step={index}
                      />
                    </span>
                    <span className="ov-funnel__meta">
                      {row.hint}
                      {row.dropPct !== null && row.dropPct > 0 && (
                        <> · <b>−{row.dropPct}%</b> from the step above</>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {funnelVerdict && <p className="ov-funnel__note">{funnelVerdict}</p>}
            </>
          )}
        </div>

        {/* Engagement depth — did they come back? */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <div>
              <h3>Engagement depth</h3>
              <p className="ov-panel-sub">Beyond the first assessment</p>
            </div>
          </div>
          {activatedMembers === 0 ? (
            <div className="ov-empty-state">
              <span className="ov-empty-state__icon"><UserStatIcon name="activity" size={26} /></span>
              <strong>No assessments yet</strong>
              <p>Retention appears here once members start submitting them.</p>
            </div>
          ) : (
            <div className="ov-stats">
              {engagementTiles.map(tile => (
                <div className={`ov-stat ov-stat--${tile.tone}`} key={tile.id}>
                  <span className="ov-stat__icon"><UserStatIcon name={tile.icon} size={17} /></span>
                  <strong className="ov-stat__value">{tile.value}</strong>
                  <span className="ov-stat__label">{tile.label}</span>
                  <span className="ov-stat__note">{tile.note}</span>
                  {tile.progress !== undefined && (
                    <span className="ov-stat__meter" aria-hidden="true">
                      <i style={{ width: `${tile.progress}%` }} />
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

      </section>

      <section className="ov-analytics-grid ov-analytics-grid--even">

        {/* Renewal runway — what needs following up before it lapses. */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <div>
              <h3>Renewal runway</h3>
              <p className="ov-panel-sub">Paid windows closing soon</p>
            </div>
            <div className="ov-panel-badges">
              <span className="ov-panel-count ov-panel-count--accent" title="Paid base priced at the published catalogue rates. Plans are granted by hand, so this is list value rather than recognised revenue.">
                {listValueText} / mo list
              </span>
            </div>
          </div>
          <div className="ov-stats">
            {runwayTiles.map(tile => (
              <div className={`ov-stat ov-stat--${tile.tone}`} key={tile.id}>
                <span className="ov-stat__icon"><UserStatIcon name={tile.icon} size={17} /></span>
                <strong className="ov-stat__value">{tile.value}</strong>
                <span className="ov-stat__label">{tile.label}</span>
                <span className="ov-stat__note">{tile.note}</span>
              </div>
            ))}
          </div>
          <p className="ov-runway__foot">
            {dayCountLabel(expiring30d, 'window', 'windows')} inside 30 days · {formatCount(paidMembers)} live
            {' · '}{formatCount(paidMembers)} of {formatCount(totalUsers)} members on a plan
          </p>
        </div>

        {/* Health profile — what members say about themselves. */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <div>
              <h3>Health profile</h3>
              <p className="ov-panel-sub">What members report</p>
            </div>
          </div>
          {dietSegments.length === 0 && stressSegments.length === 0 && sleepSegments.length === 0 ? (
            <div className="ov-empty-state">
              <span className="ov-empty-state__icon"><UserStatIcon name="users" size={26} /></span>
              <strong>No profile answers yet</strong>
              <p>Diet, stress and sleep break down as soon as assessments arrive.</p>
            </div>
          ) : (
            <div className="ov-profile">
              {[
                { key: 'diet', title: 'Diet', segments: dietSegments },
                { key: 'stress', title: 'Stress level', segments: stressSegments },
                { key: 'sleep', title: 'Sleep quality', segments: sleepSegments },
              ].map(group => (
                <div className="ov-profile__group" key={group.key}>
                  <div className="ov-profile__head">
                    <span>{group.title}</span>
                    <small>{formatCount(segmentTotal(group.segments))} answers</small>
                  </div>
                  {group.segments.length === 0 ? (
                    <p className="ov-profile__none">No answers recorded</p>
                  ) : (
                    <>
                      <div className="ov-strip" role="img" aria-label={`${group.title}: ${group.segments.map(part => `${part.label} ${part.pct}%`).join(', ')}.`}>
                        {group.segments.map(part => (
                          <i
                            key={part.label}
                            style={{ flexGrow: part.value, background: part.color }}
                            title={`${part.label}: ${formatCount(part.value)} (${part.pct}%)`}
                          />
                        ))}
                      </div>
                      <ul className="ov-profile__legend">
                        {group.segments.map(part => (
                          <li key={part.label}>
                            <span className="ov-profile__dot" style={{ background: part.color }} aria-hidden="true" />
                            <span className="ov-profile__name">{part.label}</span>
                            <span className="ov-profile__pct">{part.pct}%</span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Review backlog + top health goals. */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <div>
              <h3>Review backlog</h3>
              <p className="ov-panel-sub">Waiting on an administrator</p>
            </div>
            {onNavigate && (
              <button type="button" className="ov-ghost-btn" onClick={() => onNavigate('assessment-management')}>
                Open queue
              </button>
            )}
          </div>
          <div className="ov-stats ov-stats--three">
            {reviewTiles.map(tile => (
              <div className={`ov-stat ov-stat--${tile.tone}`} key={tile.id}>
                <span className="ov-stat__icon"><UserStatIcon name={tile.icon} size={17} /></span>
                <strong className="ov-stat__value">{tile.value}</strong>
                <span className="ov-stat__label">{tile.label}</span>
                <span className="ov-stat__note">{tile.note}</span>
              </div>
            ))}
          </div>
          <div className="ov-goals">
            <div className="ov-profile__head">
              <span>Top health goals</span>
              <small>{goalBars.length ? `Top ${goalBars.length}` : 'None'}</small>
            </div>
            {goalBars.length === 0 ? (
              <p className="ov-profile__none">No goals selected yet</p>
            ) : (
              <ul className="ov-goal-list">
                {goalBars.map(goal => (
                  <li className="ov-goal" key={goal.label}>
                    <span className="ov-goal__text">
                      <span className="ov-goal__label">{goal.label}</span>
                      <span className="ov-goal__nums">
                        <strong>{formatCount(goal.value)}</strong>
                        <small>{goal.sharePct}%</small>
                      </span>
                    </span>
                    <span className="ov-goal__track" aria-hidden="true">
                      <i style={{ width: `${goal.pct}%`, background: goal.color }} />
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

      </section>

      {/* ── Bottom grid: activity + notifications ──────────────────── */}
      <section className="ov-grid">

        {/* Recent account activity */}
        <div className="admin-panel ov-activity">
          <div className="ov-panel-header">
            <div>
              <h3>Recent account activity</h3>
              <p className="ov-panel-sub">Latest accounts to register</p>
            </div>
            {onNavigate && (
              <button type="button" className="ov-ghost-btn" onClick={() => onNavigate('users')}>
                Manage users
              </button>
            )}
          </div>

          {recentUsers.length === 0 ? (
            <div className="ov-empty-state">
              <span className="ov-empty-state__icon"><UserStatIcon name="users" size={26} /></span>
              <strong>No accounts yet</strong>
              <p>New registrations will appear here the moment they arrive.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="ov-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Joined</th>
                    <th>Subscription</th>
                    <th>2FA method</th>
                  </tr>
                </thead>
                <tbody>
                  {recentUsers.map(user => {
                    const name = displayNameOf(user);
                    const live = isSubscriptionLive(user);
                    const planKey = live ? (normalizePlanId(user.subscriptionPlan) || 'custom') : 'free';
                    return (
                      <tr className="ov-row" key={user._id}>
                        <td>
                          <span className="ov-user">
                            <span className="ov-user__avatar" style={{ '--ov-tint': avatarColorFor(name) }} aria-hidden="true">
                              {initialsOf(name)}
                            </span>
                            <span className="ov-user__text">
                              <span className="ov-user-name">{name}</span>
                              <small className="ov-user-email">{formatEmail(user.email) || '—'}</small>
                            </span>
                          </span>
                        </td>
                        <td className="ov-nowrap">{formatShortDate(user.createdAt, 'Unknown')}</td>
                        <td>
                          <span className={`ov-sub-badge ov-sub-badge--${planKey}`}>
                            {live ? PLAN_LABELS[planKey] || planKey : PLAN_LABELS.free}
                          </span>
                        </td>
                        <td>
                          {/* Base .ov-sec-badge is the amber/email-OTP look;
                              only the stronger authenticator method needs an
                              override, so there is deliberately no --otp rule. */}
                          <span className={`ov-sec-badge${user.twoFactorEnabled ? ' ov-sec-badge--totp' : ''}`}>
                            <UserStatIcon name={user.twoFactorEnabled ? 'key' : 'mail'} size={12} />
                            {user.twoFactorEnabled ? 'Authenticator' : 'Email OTP'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Threat notifications — the Security tab's live verdict, summarised.
            Every branch below carries a way into the Security Center: the card
            used to render "All systems secure" as a dead end, because the only
            button lived in the failures branch that this state never reached. */}
        <div className="admin-panel ov-threats">
          <div className="ov-panel-header">
            <div>
              <h3>Threat notifications</h3>
              <p className="ov-panel-sub">
                {monitorPending
                  ? 'Running security checks…'
                  : monitorError
                    ? 'Security checks unavailable'
                    : attention.length === 0
                      ? 'Live security controls'
                      : `${attention.length} ${attention.length === 1 ? 'control needs' : 'controls need'} attention`}
              </p>
            </div>
            {!monitorPending && !monitorError && attention.length > 0 && (
              <span className="ov-threat-count">{attention.length}</span>
            )}
          </div>

          {/* Failure to reach the monitor is NOT an all-clear. The earlier
              version collapsed an empty result to "All systems secure", so a
              dropped poll reported the platform as safe — the most dangerous
              thing this panel can claim. */}
          {monitorError ? (
            <>
              <div className="ov-all-clear ov-all-clear--error">
                <span className="ov-all-clear__icon"><UserStatIcon name="shield" size={22} /></span>
                <div>
                  <strong>Security checks could not run</strong>
                  <p>{monitorError}</p>
                </div>
              </div>
              {onOpenSecurity && (
                <button type="button" className="ov-ghost-btn ov-ghost-btn--wide" onClick={() => onOpenSecurity()}>
                  Open security center
                </button>
              )}
            </>
          ) : monitorPending ? (
            <div className="ov-all-clear ov-all-clear--pending">
              <span className="ov-all-clear__icon"><UserStatIcon name="shield" size={22} /></span>
              <div>
                <strong>Checking security controls…</strong>
                <p>Probes have not reported yet, so no verdict is available.</p>
              </div>
            </div>
          ) : attention.length === 0 ? (
            <>
              <div className="ov-all-clear">
                <span className="ov-all-clear__icon"><UserStatIcon name="shield" size={22} /></span>
                <div>
                  <strong>All systems secure</strong>
                  <p>
                    All {monitorTotal} live {monitorTotal === 1 ? 'probe is' : 'probes are'} passing.
                    Nothing needs your attention.
                  </p>
                </div>
              </div>
              {/* Counts make the claim checkable — "All systems secure" over an
                  empty monitor list is indistinguishable from a broken feed. */}
              {monitorTotal > 0 && (
                <ul className="ov-threat-tally">
                  <li className="ov-threat-tally__item ov-threat-tally__item--healthy">
                    <strong>{healthyCount}</strong> healthy
                  </li>
                  <li className={`ov-threat-tally__item ov-threat-tally__item--${warningCount ? 'warning' : 'muted'}`}>
                    <strong>{warningCount}</strong> warnings
                  </li>
                  <li className={`ov-threat-tally__item ov-threat-tally__item--${criticalCount ? 'critical' : 'muted'}`}>
                    <strong>{criticalCount}</strong> critical
                  </li>
                </ul>
              )}
              {monitorSyncedAt && (
                <p className="ov-threat-sync">Last checked {formatMonitorClock(monitorSyncedAt)}</p>
              )}
              {onOpenSecurity && (
                <button type="button" className="ov-ghost-btn ov-ghost-btn--wide" onClick={() => onOpenSecurity()}>
                  Open security center
                </button>
              )}
            </>
          ) : (
            <>
              <ul className="ov-threat-list">
                {shownThreats.map(note => {
                  const status = note?.status || 'warning';
                  const label = note?.label || 'Security check';
                  return (
                    <li className="ov-threat" key={note?.key || label}>
                      {/* Each row links to the monitor it describes. A non-clickable
                          row is the reason the card could not be acted on before. */}
                      {onOpenSecurity ? (
                        <button
                          type="button"
                          className={`ov-threat__link ov-threat--${status}`}
                          onClick={() => onOpenSecurity(note?.key || null)}
                          title={`Open ${label} in the security center`}
                        >
                          <span className="ov-threat__icon" aria-hidden="true">!</span>
                          <span className="ov-threat__body">
                            <strong className="ov-threat__title">{label}</strong>
                            <span className="ov-threat__status">{statusLabel(status)}</span>
                            {note?.detail && <p className="ov-threat__detail">{note.detail}</p>}
                          </span>
                          <span className="ov-threat__go" aria-hidden="true">›</span>
                        </button>
                      ) : (
                        <>
                          <span className="ov-threat__icon" aria-hidden="true">!</span>
                          <div>
                            <strong className="ov-threat__title">{label}</strong>
                            <span className="ov-threat__status">{statusLabel(status)}</span>
                            {note?.detail && <p className="ov-threat__detail">{note.detail}</p>}
                          </div>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
              {hiddenThreats > 0 && (
                <p className="ov-threat-more">
                  {hiddenThreats} more {hiddenThreats === 1 ? 'control needs' : 'controls need'} attention.
                </p>
              )}
              {monitorSyncedAt && (
                <p className="ov-threat-sync">Last checked {formatMonitorClock(monitorSyncedAt)}</p>
              )}
              {onOpenSecurity && (
                <button type="button" className="ov-ghost-btn ov-ghost-btn--wide" onClick={() => onOpenSecurity()}>
                  {hiddenThreats > 0 ? `Open all ${attention.length} in security center` : 'Open security center'}
                </button>
              )}
            </>
          )}
        </div>

      </section>
    </>
  );
}


// Display helper: strip IPv6-mapped IPv4 prefix from stored IPs
function formatIp(raw) {
  if (!raw) return '';
  const ip = String(raw).trim();
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

// Deterministic avatar colour from a display name (shared by Users + Admins)
// Line icons for the Users and Admins panels: stat cards, row flags, detail
// rows and empty states. One component rather than inline SVG at each call
// site, so a card, a row and an empty state can never drift apart in stroke
// weight or size. `size` is overridable because the Admins hero needs a larger
// mark than a 12px status dot does.
function UserStatIcon({ name, size = 19 }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
  };
  const paths = {
    users: (
      <>
        <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
        <circle cx="9" cy="7" r="3.4" />
        <path d="M17 11a3 3 0 1 0-1.2-5.7" />
        <path d="M22 20v-1.5a4 4 0 0 0-3-3.85" />
      </>
    ),
    check: <polyline points="4 12.5 9.5 18 20 6.5" />,
    lock: (
      <>
        <rect x="4" y="10.5" width="16" height="10" rx="2.4" />
        <path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" />
      </>
    ),
    ban: (
      <>
        <circle cx="12" cy="12" r="8.4" />
        <path d="M6.2 6.2l11.6 11.6" />
      </>
    ),
    shield: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <polyline points="9 12 11 14 15 10" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.4-3.4" />
      </>
    ),
    filter: (
      <>
        <path d="M3 5h18l-7 8v6l-4 2v-8z" />
      </>
    ),
    /* ── Admins queue ───────────────────────────────────────────────
       The Admins panel reads differently from Users: an operator is not
       triaging customers here, they are deciding who holds the keys. So it
       needs marks for the things THAT panel talks about — an alias to sign
       in with, a key that is deliberately never shown, a last-seen moment —
       rather than more people-icons. */
    at: (
      <>
        <circle cx="12" cy="12" r="3.6" />
        <path d="M15.6 8.4v4.9a2.6 2.6 0 0 0 5.2 0V12a8.8 8.8 0 1 0-3.5 7" />
      </>
    ),
    key: (
      <>
        <circle cx="7.6" cy="16.4" r="3.6" />
        <path d="M10.2 14L20 4.2M17.2 7l2.6 2.6M14.6 9.6l2.6 2.6" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5.4" width="18" height="13.2" rx="2.4" />
        <path d="M3.7 7.2l8.3 5.9 8.3-5.9" />
      </>
    ),
    clock: (
      <>
        <circle cx="12" cy="12" r="8.6" />
        <path d="M12 7.2V12l3.1 1.9" />
      </>
    ),
    activity: <path d="M3 12.4h4l2.6 6.6L14 5.6l2.6 6.8H21" />,
    calendar: (
      <>
        <rect x="3.6" y="5.2" width="16.8" height="15.2" rx="2.4" />
        <path d="M3.6 9.8h16.8M8.4 3.4v3.4M15.6 3.4v3.4" />
      </>
    ),
    user: (
      <>
        <circle cx="12" cy="8.4" r="3.6" />
        <path d="M5 20.2V19a4.3 4.3 0 0 1 4.3-4.3h5.4A4.3 4.3 0 0 1 19 19v1.2" />
      </>
    ),
    chevron: <path d="M6.5 9.2l5.5 5.6 5.5-5.6" />,
    /* ── Overview analytics ──────────────────────────────────────────
       The deeper analytics panels talk about acquisition, retention, renewal
       and the review queue, so they need marks for THOSE ideas rather than more
       people-icons. Each is deliberately distinguishable from the existing
       `activity` pulse at a 17px tile size: `pulse` is the heartbeat of today,
       `layers` the depth of one member's history, `repeat` the fact that they
       came back at all. */
    pulse: (
      <>
        <path d="M2.6 12.2h3.2l1.9 4.6L11 6.4l2.1 5.8h3" />
        <path d="M19.4 6.6a5.4 5.4 0 0 1 0 6.4" />
        <path d="M21.8 4.2a8.8 8.8 0 0 1 0 11" />
      </>
    ),
    layers: (
      <>
        <path d="M12 3.2l8.4 4.2-8.4 4.2-8.4-4.2z" />
        <path d="M3.6 12.2l8.4 4.2 8.4-4.2" />
        <path d="M3.6 16.6l8.4 4.2 8.4-4.2" />
      </>
    ),
    repeat: (
      <>
        <path d="M3.6 11.2A8.4 8.4 0 0 1 18.4 6.6" />
        <polyline points="14.4 3.4 18.6 6.6 14.4 9.8" />
        <path d="M20.4 12.8a8.4 8.4 0 0 1-14.8 4.6" />
        <polyline points="9.6 20.6 5.4 17.4 9.6 14.2" />
      </>
    ),
    refresh: (
      <>
        <path d="M20.6 5.4v5.2h-5.2" />
        <path d="M3.4 18.6v-5.2h5.2" />
        <path d="M5.6 9.8a7 7 0 0 1 11.4-2.7l3.6 3.3" />
        <path d="M18.4 14.2a7 7 0 0 1-11.4 2.7L3.4 13.6" />
      </>
    ),
    flag: (
      <>
        <path d="M5 21V4.2" />
        <path d="M5 4.8h11.4l-2.2 4 2.2 4H5" />
      </>
    ),
    alert: (
      <>
        <path d="M12 3.6L21.4 19.4a1.2 1.2 0 0 1-1 1.9H3.6a1.2 1.2 0 0 1-1-1.9z" />
        <path d="M12 9.4v4.4" />
        <path d="M12 17.2h.01" />
      </>
    ),
  };
  return <svg {...common}>{paths[name] || paths.users}</svg>;
}

function avatarColorFor(name = '') {
  const palette = ['#4f6bed', '#e85d75', '#2e9e6b', '#d46b35', '#7c4ddb', '#0891b2', '#b45309', '#be185d'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

// Live lockout badge: ticks every second against fetchedAt + remainingSeconds
// so the countdown is realtime between server polls. It never disappears on
// its own — when it hits zero it asks the server for fresh state, and only
// flips to Clear once the server confirms the lock is gone.
function LockoutCountdown({ remainingSeconds, fetchedAt, lockedBy, ips, onExpired }) {
  // expiresAt derives purely from props (fetchedAt is a timestamp number, so
  // no Date.now() in render). `now` starts via lazy initializer and advances
  // on a 1 s subscription — both linter-safe patterns.
  const expiresAt = (Number(fetchedAt) || 0) + Math.max(0, Number(remainingSeconds) || 0) * 1000;
  const [now, setNow] = useState(() => Date.now());
  const expiredRef = useRef(false);
  const onExpiredRef = useRef(onExpired);
  useEffect(() => {
    onExpiredRef.current = onExpired;
  }, [onExpired]);
  useEffect(() => {
    expiredRef.current = false;
  }, [fetchedAt, remainingSeconds]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const leftSec = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  useEffect(() => {
    if (leftSec <= 0 && !expiredRef.current) {
      expiredRef.current = true;
      if (onExpiredRef.current) onExpiredRef.current();
    }
  }, [leftSec]);
  const label = leftSec >= 90
    ? `Locked · ${Math.ceil(leftSec / 60)} min left`
    : leftSec >= 60
      ? 'Locked · 1 min left'
      : `Locked · ${leftSec}s left`;
  return (
    <span
      className="lockout-badge lockout-badge--locked"
      title={(ips && ips.length > 0 ? `IPs: ${ips.join(', ')}` : 'IP logging pending') + (lockedBy === 'network' ? ' — network-level hold' : ' — rotating IPs will not bypass this account lock')}
    >
      {label}
    </span>
  );
}

function Users({ users, setUsers, usersFetchedAt, search, setSearch, loadUsers, request, onSubscriptionChanged, updateAccount, deleteAccount, deletingUserId, unlockUser, expandedUser, setExpandedUser }) {
  // Which user's subscription controls are open. Held here rather than in the
  // panel so collapsing the row also collapses its controls, and so only one
  // account's detail request is ever in flight.
  const [expandedSubscription, setExpandedSubscription] = useState(null);

  // Opening one row closes any other, and collapsing a row collapses its
  // controls. Done in the toggle handler rather than an effect: an effect that
  // calls setState on every row change is exactly the cascading render this
  // avoids, and reopening a row must never land on a stale open panel.
  const handleUserToggle = (userId) => {
    const opening = expandedUser !== userId;
    setExpandedUser(opening ? userId : null);
    setExpandedSubscription(null);
  };

  // The panel posts an action and hands back the authoritative user document.
  // Patch it into the list in place: re-running loadUsers() here would race the
  // background refresh and could repaint a plan the admin just changed.
  const handleSubscriptionUserUpdate = useCallback((updated) => {
    if (!updated?._id) return;
    setUsers((current) => current.map((item) => (item._id === updated._id ? { ...item, ...updated } : item)));
    // The overview counters live in this component, so the panel reports the
    // change upward rather than duplicating that logic here.
    if (onSubscriptionChanged) onSubscriptionChanged(updated);
  }, [setUsers, onSubscriptionChanged]);

  // Generate initials avatar colour from name (deterministic, shared helper)
  const avatarColor = avatarColorFor;

  // Netflix-style instant search: fetch as they type (400 ms debounce).
  // Skips the first render (the list already loads with the dashboard).
  const firstRender = useRef(true);
  const debounceTimer = useRef(null);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return undefined; }
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => { loadUsers(); }, 400);
    return () => window.clearTimeout(debounceTimer.current);
  }, [search, loadUsers]);

  // Search button: run immediately instead of waiting for the debounce.
  const flushSearch = () => {
    window.clearTimeout(debounceTimer.current);
    loadUsers();
  };

  // ── The four account states an admin actually triages on ──────────────
  // Classified ONCE here and reused by the cards, the filter and the row
  // pills, so a card can never disagree with the row it is counting.
  //   ok   → can sign in right now
  //   down → locked out, needs an admin to clear it
  //   idle → banned, a deliberate decision, not a fault to fix
  const statusOf = useCallback((user) => {
    if (!user) return 'ok';
    if (user.lockout?.locked) return 'down';
    if (user.accountStatus && user.accountStatus !== 'active') return 'idle';
    return 'ok';
  }, []);

  // Counts come from the SEARCH RESULT SET, not the whole table. The server
  // caps the list at 100 rows, so a card reading "412 users" here would be a
  // number the admin cannot reconcile with the list underneath it. The hint on
  // each card says so, rather than leaving the admin to work it out.
  const counts = useMemo(() => {
    const base = { all: users.length, ok: 0, down: 0, idle: 0, paid: 0 };
    for (const user of users) {
      base[statusOf(user)] += 1;
      if (isSubscriptionLive(user)) base.paid += 1;
    }
    return base;
  }, [users, statusOf]);

  // Stat cards double as the filter, matching the other three queues. Derived
  // from the fetched list rather than a second request: the counts would
  // otherwise be for a different query than the rows below them.
  const FILTERS = [
    { id: 'all', tone: 'all', label: 'All users', icon: 'users', hint: 'Every account in this search' },
    { id: 'ok', tone: 'ok', label: 'Active', icon: 'check', hint: 'Can sign in right now' },
    { id: 'down', tone: 'down', label: 'Locked out', icon: 'lock', hint: 'Sign-in blocked right now' },
    { id: 'idle', tone: 'idle', label: 'Banned', icon: 'ban', hint: 'Access revoked by an admin' },
  ];
  const [filter, setFilter] = useState('all');
  const visibleUsers = useMemo(
    () => (filter === 'all' ? users : users.filter(user => statusOf(user) === filter)),
    [users, filter, statusOf]
  );

  // A filter that suddenly matches nothing is a dead end: say what happened and
  // offer the way out, rather than rendering a bare "No users found."
  const searching = String(search || '').trim().length > 0;
  const emptyState = searching
    ? { icon: 'search', title: 'No users match this search', body: `Nothing in the list matches “${search}”. Search covers first name, last name and email.` }
    : filter === 'all'
      ? { icon: 'users', title: 'No users yet', body: 'Accounts appear here as soon as they register.' }
      : { icon: 'filter', title: `No ${FILTERS.find(f => f.id === filter)?.label.toLowerCase()} accounts`, body: 'Switch back to All users to see the rest of the list.' };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div>
          <h3>Users</h3>
          <p className="admin-muted">Manage access, roles, subscriptions, and security status. Passwords are never displayed.</p>
        </div>
        <div className="search-row usr-searchbar">
          <span className="usr-searchbar__icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.4-3.4" />
            </svg>
          </span>
          <input
            placeholder="Search name or email"
            aria-label="Search users by name or email"
            value={search}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') flushSearch(); }}
          />
          {search && (
            <button
              type="button"
              className="usr-searchbar__clear"
              onClick={() => setSearch('')}
              aria-label="Clear search"
              title="Clear search"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Stat cards are the filter. Four tones, same system as the other
          queues: emerald ok, rose down, slate administratively off,
          indigo everything. */}
      <div className="usr-stats" role="group" aria-label="Filter users by account state">
        {FILTERS.map(card => {
          const on = filter === card.id;
          return (
            <button
              key={card.id}
              type="button"
              className={`usr-stat usr-stat--${card.tone}${on ? ' usr-stat--on' : ''}`}
              aria-pressed={on}
              onClick={() => setFilter(card.id)}
            >
              <span className="usr-stat__icon" aria-hidden="true"><UserStatIcon name={card.icon} /></span>
              <span className="usr-stat__body">
                <span className="usr-stat__value">{counts[card.id]}</span>
                <span className="usr-stat__label">{card.label}</span>
                <span className="usr-stat__hint">{card.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="usr-listbar">
        <p className="usr-listbar__count">
          {filter === 'all'
            ? `${visibleUsers.length} account${visibleUsers.length === 1 ? '' : 's'}`
            : `${visibleUsers.length} of ${users.length} shown`}
        </p>
        {filter !== 'all' && (
          <button type="button" className="usr-listbar__reset" onClick={() => setFilter('all')}>
            Show all
          </button>
        )}
      </div>

      <div className="user-list">
        {visibleUsers.length === 0 && (
          <div className="usr-empty">
            <span className="usr-empty__icon" aria-hidden="true"><UserStatIcon name={emptyState.icon} /></span>
            <strong>{emptyState.title}</strong>
            <p>{emptyState.body}</p>
            {search && (
              <button type="button" className="admin-secondary" onClick={() => setSearch('')}>Clear search</button>
            )}
          </div>
        )}
        {visibleUsers.map(user => {
          const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown';
          const initials = fullName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
          // Resolved once per row. The strongest factor is a property of the
          // account, not of the cell, and computing it inline three times in
          // the JSX below is how this column ended up disagreeing with itself.
          const security = securityFactor(user);
          const isOpen = expandedUser === user._id;
          const color = avatarColor(fullName);
          const state = statusOf(user);
          const live = isSubscriptionLive(user);
          const photo = pictureUrl(user.profilePicture);

          return (
            <div key={user._id} className={`user-item user-item--${state}${isOpen ? ' user-item--open' : ''}`}>
              {/* ── Collapsed row ───────────────────────────────────── */}
              <button
                className="user-row"
                onClick={() => handleUserToggle(user._id)}
                aria-expanded={isOpen}
              >
                {/* Avatar. The initials are ALWAYS in the DOM underneath the
                    photo and the photo is layered on top, so a failed or slow
                    image needs no error handler and no reliance on sibling
                    order — the old nextSibling trick broke the moment a node
                    was inserted between them. */}
                <span className="usr-avatar" aria-hidden="true">
                  <span className="usr-avatar__initials" style={{ background: color }}>{initials}</span>
                  {photo && <img className="usr-avatar__photo" src={photo} alt="" loading="lazy" />}
                </span>

                {/* Name + email + joined */}
                <span className="user-row__info">
                  <span className="user-row__name">{fullName}</span>
                  <span className="user-row__sub">{formatEmail(user.email)}</span>
                </span>

                {/* Plan + joined + last seen. The collapsed row used to show
                    only "Joined: <date>", which forced an admin to open every
                    single account to answer the two questions they actually
                    open one for: are they paying, and have they been here. */}
                <span className="usr-row__meta">
                  <span className={`usr-plan${live ? ' usr-plan--live' : ''}`}>
                    {live ? (PLAN_LABELS[user.subscriptionPlan] || user.subscriptionPlan) : PLAN_LABELS.free}
                  </span>
                  <span className="usr-row__when">
                    <span title={user.createdAt ? new Date(user.createdAt).toLocaleString() : 'No join date recorded'}>
                      Joined {formatShortDate(user.createdAt)}
                    </span>
                    <i aria-hidden="true" />
                    <span className={user.lastLoginAt ? '' : 'usr-row__when--never'}>
                      {isRealDate(user.lastLoginAt)
                        ? `Seen ${formatShortDate(user.lastLoginAt)}`
                        : 'Never signed in'}
                    </span>
                  </span>
                </span>

                {/* Why this row needs you. Tone follows `state`, so the pill
                    and the stat card counting it cannot disagree. */}
                {state === 'down' && (
                  <span className="usr-flag usr-flag--down">
                    <UserStatIcon name="lock" />
                    Locked
                  </span>
                )}
                {state === 'idle' && (
                  <span className="usr-flag usr-flag--idle">{user.accountStatus || 'banned'}</span>
                )}
                {state === 'ok' && user.twoFactorEnabled && (
                  <span className="usr-flag usr-flag--ok" title="Two-factor authentication enabled">
                    <UserStatIcon name="shield" />
                    2FA
                  </span>
                )}

                {/* Chevron */}
                <span className={`user-row__chevron${isOpen ? ' user-row__chevron--open' : ''}`} aria-hidden="true">▼</span>
              </button>

              {/* ── Expanded details ─────────────────────────────── */}
              {isOpen && (
                <div className="user-details">
                  <div className="user-details__grid">
                    <div className="user-detail-item">
                      <strong>Email</strong>
                      <span>{formatEmail(user.email)}</span>
                    </div>
                    {user.phoneNumber && (
                      <div className="user-detail-item">
                        <strong>Phone Number</strong>
                        <span>{formatPhoneNumber(user.phoneNumber)}</span>
                      </div>
                    )}
                    <div className="user-detail-item">
                      <strong>Last Login</strong>
                      <span>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</span>
                      <small>
                        {user.device && user.device !== 'Unknown device'
                          ? user.device
                          : (user.lastLoginIp ? `IP ${formatIp(user.lastLoginIp)}` : 'Unknown device')}
                      </small>
                    </div>
                    <div className="user-detail-item">
                      <strong>Location</strong>
                      <span>{user.lastLoginLocation || 'Unknown'}</span>
                      {(!user.lastLoginLocation || user.lastLoginLocation === 'Unknown location') && user.lastLoginIp && (
                        <small>IP {formatIp(user.lastLoginIp)}</small>
                      )}
                    </div>
                    <div className="user-detail-item user-detail-item--wide">
                      <strong>Subscription</strong>
                      <span className={`subscription-status-badge${isSubscriptionLive(user) ? ' subscription-status-badge--active' : ''}`}>
                        {isSubscriptionLive(user) ? 'Subscribed ✓' : PLAN_LABELS.free}
                      </span>
                      {subscriptionExpiryLabel(user) && (
                        <small className={`subscription-expiry-note${isSubscriptionLive(user) ? '' : ' subscription-expiry-note--expired'}`}>
                          {subscriptionExpiryLabel(user)}
                        </small>
                      )}
                      {/* Full control lives in the panel: grant, remove, add/deduct
                          days, extend, make permanent, change plan, and — the
                          part that matters most — restore the user's ORIGINAL
                          paid state without losing it in the meantime. */}
                      <button
                        type="button"
                        className="subscription-manage-btn"
                        onClick={() => setExpandedSubscription(expandedSubscription === user._id ? null : user._id)}
                        aria-expanded={expandedSubscription === user._id}
                      >
                        {expandedSubscription === user._id ? 'Close subscription controls' : 'Manage subscription'}
                      </button>
                    </div>
                    <div className="user-detail-item">
                      <strong>Role</strong>
                      <span style={{ textTransform: 'capitalize' }}>{user.accountRole || 'User'}</span>
                    </div>
                    <div className="user-detail-item">
                      <strong>Account status</strong>
                      <select
                        value={user.accountStatus || 'active'}
                        onChange={event => updateAccount(user, { status: event.target.value })}
                      >
                        <option value="active">Active</option>
                        <option value="banned">Banned</option>
                      </select>
                    </div>
                    <div className="user-detail-item">
                      <strong>2FA / Security</strong>
                      <span className={`security-badge security-badge--${security.method}`}>
                        {security.label}
                      </span>
                      {/* The supporting line is what makes this column honest:
                          it names the factor's actual strength, so an admin
                          reading "Email OTP active" is not left thinking this
                          account is as protected as one with a passkey. */}
                      <small>{security.note}</small>
                    </div>
                    <div className="user-detail-item">
                      <strong>Lockout Status</strong>
                      {user.lockout && user.lockout.locked ? (
                        <>
                          <LockoutCountdown
                            remainingSeconds={user.lockout.remainingSeconds || 0}
                            fetchedAt={usersFetchedAt}
                            lockedBy={user.lockout.lockedBy}
                            ips={user.lockout.ips}
                            onExpired={loadUsers}
                          />
                          <button
                            type="button"
                            className="lockout-unlock-btn"
                            onClick={() => unlockUser(user)}
                          >
                            Unlock now
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="lockout-badge lockout-badge--clear">Clear — can sign in</span>
                          <button
                            type="button"
                            className="lockout-reset-btn"
                            title="Clear any accumulated failed-attempt strikes for this account"
                            onClick={() => unlockUser(user)}
                          >
                            Reset attempts
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {expandedSubscription === user._id && (
                    <div className="user-subscription-panel">
                      <AdminSubscriptionPanel
                        user={user}
                        request={request}
                        onUserUpdated={handleSubscriptionUserUpdate}
                      />
                    </div>
                  )}
                  <div className="user-actions user-actions--stacked">
                    <p className="user-warning" role="note">
                      <span className="user-warning__icon" aria-hidden="true">!</span>
                      Deleting an account permanently removes it and all of its data from the database. This cannot be undone.
                    </p>
                    <button
                      type="button"
                      className="status danger-action"
                      onClick={() => deleteAccount(user)}
                      disabled={deletingUserId === user._id}
                    >
                      {deletingUserId === user._id ? 'Deleting...' : 'Delete account'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Is this list row the account the operator is signed in as?
 *
 * Matched on ALIAS, not on `_id`. GET /admin/profile returns only
 * alias/createdAt/lastLoginAt/picturesUpdatedAt — it sends no `_id` — so the
 * panel used to compare `admin._id` against `profile._id`, never match, and
 * leave the "you" marker and the self-disable guard permanently dead. The
 * visible symptom was a "Disable admin" button on your OWN row that the server
 * then refused with a 400 ("You cannot disable your own account"), so the
 * guard was not a nicety: it was the only thing between an operator and a
 * guaranteed-failing action. `alias` is `unique: true` on the schema, so it
 * identifies the account just as precisely, and `_id` is still checked first
 * for any caller that does have it.
 *
 * @param {object|null} row    one entry from the /admins list
 * @param {object|null} current the signed-in admin's /profile document
 * @returns {boolean}
 */
function isSameAdmin(row, current) {
  if (!row || !current) return false;
  if (current._id && String(row._id) === String(current._id)) return true;
  return Boolean(current.alias) && String(row.alias || '') === String(current.alias);
}

// ════════════════════════════════════════════════════════════════════════════
// ADMINS QUEUE
//
// Same card-box language as the Users queue, but with its own hero and its own
// vibrant palette, because this is the one panel where an operator is deciding
// WHO HOLDS THE KEYS to the whole console. It is not a customer list and should
// not look like one.
//
// SECURITY: password hashes and TOTP secrets are never selected by the server
// (see the `select` on GET /admins in server/routes/admin.js), so this panel
// physically cannot render one. That promise is made ONCE — in the hero's
// security strip — instead of on every row, which is where the old version put
// it and where it read as noise repeated twelve times over.
//
// Every class here is namespaced `adm-`, so none of it can leak into — or be
// moved by — the Users queue, the profile panel or the rest of the console.
// ════════════════════════════════════════════════════════════════════════════
function Admins({ admins, adminsFetchedAt, search, setSearch, loadAdmins, toggleAdmin, unlockAdmin, currentAdmin, expandedAdmin, setExpandedAdmin, request }) {
  const handleAdminToggle = (adminId) => {
    setExpandedAdmin(expandedAdmin === adminId ? null : adminId);
  };

  // Netflix-style instant search: fetch as they type (400 ms debounce).
  // Skips the first render (the list already loads when the tab opens).
  const firstRender = useRef(true);
  const debounceTimer = useRef(null);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return undefined; }
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => { loadAdmins(); }, 400);
    return () => window.clearTimeout(debounceTimer.current);
  }, [search, loadAdmins]);

  // Enter, or the field's search button: run now instead of waiting out the
  // debounce. The old panel had a trailing "Search" button; it is gone because
  // the field already searches itself, and a redundant button next to a live
  // search is one more thing to read past.
  const flushSearch = () => {
    window.clearTimeout(debounceTimer.current);
    loadAdmins();
  };

  // ── The three states an operator actually triages on ─────────────────────
  // Classified ONCE here and reused by the stat cards, the filter and the row
  // pill, so a card can never disagree with the row it is counting.
  //   ok   → enabled, can sign in right now
  //   off  → disabled on purpose. A deliberate decision rather than a fault to
  //          fix, so it is amber: worth noticing, nothing is broken.
  //   down → locked out by the sign-in guard. The only state that interrupts.
  const statusOf = useCallback((admin) => {
    if (!admin) return 'ok';
    if (admin.lockout?.locked) return 'down';
    if (admin.enabled === false) return 'off';
    return 'ok';
  }, []);

  // One vocabulary for the pill, its tooltip and the empty-state wording, so
  // the three can never call the same account different things.
  const STATE = {
    ok:   { label: 'Enabled',    hint: 'Can sign in to the console' },
    off:  { label: 'Disabled',   hint: 'Blocked from signing in' },
    down: { label: 'Locked out', hint: 'Too many failed sign-in attempts' },
  };

  // Counts come from the FETCHED LIST, not from a second request. The server
  // caps this list at 100 rows, so a count taken elsewhere would describe
  // accounts that are not on screen and could not be reconciled with them.
  const counts = useMemo(() => {
    const base = { all: admins.length, ok: 0, off: 0, down: 0 };
    for (const admin of admins) base[statusOf(admin)] += 1;
    return base;
  }, [admins, statusOf]);

  // The stat cards ARE the filter — same idea as the Users queue, and the
  // reason the numbers are worth the vertical space: tapping "Locked out" both
  // answers "how bad is it" and narrows to exactly those rows.
  const FILTERS = [
    { id: 'all',  tone: 'all',  label: 'All admins', icon: 'shield', hint: 'Every administrator in this search' },
    { id: 'ok',   tone: 'ok',   label: 'Enabled',    icon: 'check',  hint: STATE.ok.hint },
    { id: 'off',  tone: 'off',  label: 'Disabled',   icon: 'ban',    hint: STATE.off.hint },
    { id: 'down', tone: 'down', label: 'Locked out', icon: 'lock',   hint: STATE.down.hint },
  ];
  const [filter, setFilter] = useState('all');
  const visibleAdmins = useMemo(
    () => (filter === 'all' ? admins : admins.filter(admin => statusOf(admin) === filter)),
    [admins, filter, statusOf]
  );

  // An empty list reached by searching or filtering is a dead end. Say which of
  // the two got you here and hand back the way out, instead of the old bare
  // "No administrators found."
  const searching = String(search || '').trim().length > 0;
  const emptyState = searching
    ? {
        icon: 'search',
        title: 'No administrators match',
        body: `Nothing in the list matches “${search}”. Search covers the administrator alias — that is the only identity an admin account has.`,
      }
    : filter === 'all'
      ? { icon: 'shield', title: 'No administrators yet', body: 'Admin accounts appear here as soon as they are created.' }
      : { icon: 'filter', title: `Nothing is ${FILTERS.find(f => f.id === filter)?.label.toLowerCase()}`, body: 'Switch back to All admins to see the rest of the list.' };

  return (
    <section className="admin-panel adm-panel">
      {/* ── Hero ───────────────────────────────────────────────────────────
          Replaces the old "Admins / Manage administrator access… / search" row.
          The gradient is this panel's identity: the Users queue is green-white
          and the console chrome is ink-and-orange, so the one screen that hands
          out console access gets its own unmistakable colour. */}
      <div className="adm-hero">
        <span className="adm-hero__mark" aria-hidden="true">
          <UserStatIcon name="shield" size={26} />
        </span>

        <div className="adm-hero__text">
          <span className="adm-hero__kicker">Console access</span>
          <h3 className="adm-hero__title">Admins</h3>
          <p className="adm-hero__sub">
            Grant, review and revoke administrator access. Disabling an account signs
            it out immediately; unlocking one only clears its failed-attempt strikes.
          </p>
        </div>

        {/* Search. `type="search"` would hand the field a native clear button
            that sits on top of ours, so it stays a text input and the clear
            control is ours. */}
        <div className="adm-searchbar">
          <span className="adm-searchbar__icon" aria-hidden="true">
            <UserStatIcon name="search" size={16} />
          </span>
          <input
            type="text"
            placeholder="Search by alias"
            aria-label="Search administrators by alias"
            value={search}
            onChange={event => setSearch(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') flushSearch(); }}
          />
          {search ? (
            <button
              type="button"
              className="adm-searchbar__clear"
              onClick={() => { setSearch(''); flushSearch(); }}
              aria-label="Clear search"
              title="Clear search"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          ) : (
            <span className="adm-searchbar__kbd" aria-hidden="true">Enter</span>
          )}
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="adm-body">
        {/* The security promise, stated once, as a strip rather than as
            repeated sub-text on twelve rows. */}
        <p className="adm-note">
          <span className="adm-note__icon" aria-hidden="true"><UserStatIcon name="key" size={15} /></span>
          <span>
            <strong>Secrets stay on the server.</strong> Password hashes and authenticator
            codes are never sent to this page, so they cannot be displayed here.
          </span>
        </p>

        <CredentialDelivery request={request} admins={admins} />

        {/* Stat cards are the filter. Four tones: indigo everything, emerald
            enabled, amber administratively off, rose locked out. */}
        <div className="adm-stats" role="group" aria-label="Filter administrators by account state">
          {FILTERS.map(card => {
            const on = filter === card.id;
            return (
              <button
                key={card.id}
                type="button"
                className={`adm-stat adm-stat--${card.tone}${on ? ' adm-stat--on' : ''}`}
                aria-pressed={on}
                onClick={() => setFilter(card.id)}
              >
                <span className="adm-stat__icon" aria-hidden="true"><UserStatIcon name={card.icon} /></span>
                <span className="adm-stat__body">
                  <span className="adm-stat__value">{counts[card.id]}</span>
                  <span className="adm-stat__label">{card.label}</span>
                  <span className="adm-stat__hint">{card.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="adm-listbar">
          <p className="adm-listbar__count">
            {filter === 'all'
              ? `${visibleAdmins.length} administrator${visibleAdmins.length === 1 ? '' : 's'}`
              : `${visibleAdmins.length} of ${admins.length} shown`}
          </p>
          {filter !== 'all' && (
            <button type="button" className="adm-listbar__reset" onClick={() => setFilter('all')}>
              Show all
            </button>
          )}
        </div>

        {/* ── List ─────────────────────────────────────────────────────── */}
        <div className="adm-list">
          {visibleAdmins.length === 0 && (
            <div className="adm-empty">
              <span className="adm-empty__icon" aria-hidden="true"><UserStatIcon name={emptyState.icon} size={24} /></span>
              <strong>{emptyState.title}</strong>
              <p>{emptyState.body}</p>
              {search ? (
                <button type="button" className="adm-btn adm-btn--ghost" onClick={() => { setSearch(''); flushSearch(); }}>
                  Clear search
                </button>
              ) : filter !== 'all' ? (
                <button type="button" className="adm-btn adm-btn--ghost" onClick={() => setFilter('all')}>
                  Show all administrators
                </button>
              ) : null}
            </div>
          )}

          {visibleAdmins.map(admin => {
            const name = admin.alias || 'Unknown';
            const initials = name.slice(0, 2).toUpperCase();
            const isOpen = expandedAdmin === admin._id;
            const isSelf = isSameAdmin(admin, currentAdmin);
            const state = statusOf(admin);
            const seenAt = isRealDate(admin.lastActivityAt) ? admin.lastActivityAt : null;
            // Two dim lines under one name, so they must not say the same thing.
            // The meta column already carries the last-seen moment, which is the
            // question an operator actually opens this list to answer — so the
            // sub-line carries WHEN THE ACCOUNT ARRIVED instead, which is
            // different information and does not repeat down the list.
            //
            // The email is not part of an admin's identity: the alias is, and
            // GET /admins does not even select an email column, so the old
            // version printed "No email on file" under all twelve rows. It is
            // stated once, in the expanded panel's Email row.
            const sub = admin.email
              || (isRealDate(admin.createdAt) ? `Added ${formatShortDate(admin.createdAt)}` : 'No email on file');

            return (
              <article
                key={admin._id}
                className={`adm-card adm-card--${state}${isOpen ? ' adm-card--open' : ''}`}
              >
                {/* ── Collapsed row ─────────────────────────────────────
                    A <button>, not a div with onClick: the whole row is the
                    disclosure control, and it has to be reachable and
                    operable from the keyboard without a tab stop per field. */}
                <button
                  type="button"
                  className="adm-row"
                  onClick={() => handleAdminToggle(admin._id)}
                  aria-expanded={isOpen}
                >
                  {/* Avatar. Two layers, so the gradient rim survives: an
                      inline `background` on this element used to override the
                      `background` shorthand and strip the ring. */}
                  <span className="adm-avatar" style={{ '--adm-tint': avatarColorFor(name) }} aria-hidden="true">
                    <span className="adm-avatar__initials">{initials}</span>
                    <span className="adm-avatar__ring" />
                  </span>

                  <span className="adm-row__info">
                    {/* The alias sits in its own element so it can ellipsize
                        on its own: as a bare text node in this flex row it was
                        the first *element* child only when the "You" chip was
                        present, so the ellipsis landed on the chip instead. */}
                    <span className="adm-row__name">
                      <span className="adm-row__alias">{name}</span>
                      {isSelf && <span className="adm-tag adm-tag--you">You</span>}
                    </span>
                    <span className="adm-row__sub">{sub}</span>
                  </span>

                  <span className="adm-row__meta">
                    <span className={`adm-pill adm-pill--${state}`} title={STATE[state].hint}>
                      <i className="adm-pill__dot" aria-hidden="true" />
                      {STATE[state].label}
                    </span>
                    <span className={`adm-row__when${seenAt ? '' : ' adm-row__when--never'}`}>
                      {seenAt ? `Seen ${formatShortDate(seenAt)}` : 'Never active'}
                    </span>
                  </span>

                  <span className={`adm-chevron${isOpen ? ' adm-chevron--open' : ''}`} aria-hidden="true">
                    <UserStatIcon name="chevron" size={15} />
                  </span>
                </button>

                {/* ── Expanded details ───────────────────────────────────── */}
                {isOpen && (
                  <div className="adm-details">
                    <div className="adm-details__grid">
                      <div className="adm-detail">
                        <span className="adm-detail__label" aria-hidden="true"><UserStatIcon name="at" size={13} /> Alias</span>
                        <span className="adm-detail__value">{name}</span>
                        <small className="adm-detail__hint">The sign-in identity. Admins have no separate email login.</small>
                      </div>

                      <div className="adm-detail">
                        <span className="adm-detail__label" aria-hidden="true"><UserStatIcon name="mail" size={13} /> Email</span>
                        <span className="adm-detail__value">{admin.email || 'No email on file'}</span>
                      </div>

                      {/* A boolean, never the seed. This is the field that tells an
                          operator why an administrator cannot get past the sign-in
                          code — a stored value that is not a valid base32 seed can
                          still verify on the server (it decodes to the first legal
                          run) while producing a code no app will ever show. */}
                      {admin.hasAuthenticator !== undefined && (
                        <div className="adm-detail">
                          <span className="adm-detail__label" aria-hidden="true"><UserStatIcon name="key" size={13} /> Authenticator</span>
                          <span className="adm-detail__value">
                            {admin.hasAuthenticator ? 'Key on file — usable' : 'Key on file is not usable'}
                          </span>
                          {!admin.hasAuthenticator && (
                            <small className="adm-detail__hint">
                              The stored seed is malformed, so this account cannot pass its sign-in
                              code and its key is not emailed. Rotate it to mint a fresh one.
                            </small>
                          )}
                        </div>
                      )}

                      <div className="adm-detail">
                        <span className="adm-detail__label" aria-hidden="true"><UserStatIcon name="user" size={13} /> Status</span>
                        <span className="adm-detail__value">
                          <span className={`adm-state adm-state--${state}`}>
                            <i className="adm-pill__dot" aria-hidden="true" />
                            {admin.enabled ? 'Enabled — can sign in' : 'Disabled — cannot sign in'}
                          </span>
                        </span>
                        <small className="adm-detail__hint">{STATE[state].hint}</small>
                      </div>

                      <div className="adm-detail">
                        <span className="adm-detail__label" aria-hidden="true"><UserStatIcon name="clock" size={13} /> Last login</span>
                        <span className="adm-detail__value">
                          {isRealDate(admin.lastLoginAt) ? formatDateTime(admin.lastLoginAt) : 'Never'}
                        </span>
                      </div>

                      <div className="adm-detail">
                        <span className="adm-detail__label" aria-hidden="true"><UserStatIcon name="activity" size={13} /> Last activity</span>
                        <span className="adm-detail__value">
                          {isRealDate(admin.lastActivityAt) ? formatDateTime(admin.lastActivityAt) : 'Never'}
                        </span>
                      </div>

                      <div className="adm-detail">
                        <span className="adm-detail__label" aria-hidden="true"><UserStatIcon name="calendar" size={13} /> Added</span>
                        <span className="adm-detail__value">
                          {isRealDate(admin.createdAt) ? formatDateTime(admin.createdAt) : 'Unknown'}
                        </span>
                      </div>

                      <div className="adm-detail adm-detail--wide">
                        <span className="adm-detail__label" aria-hidden="true"><UserStatIcon name="lock" size={13} /> Lockout status</span>
                        {admin.lockout && admin.lockout.locked ? (
                          <div className="adm-detail__row">
                            <LockoutCountdown
                              remainingSeconds={admin.lockout.remainingSeconds || 0}
                              fetchedAt={adminsFetchedAt}
                              lockedBy="account"
                              ips={admin.lockout.ips}
                              onExpired={loadAdmins}
                            />
                            <button
                              type="button"
                              className="lockout-unlock-btn"
                              onClick={() => unlockAdmin(admin)}
                            >
                              Unlock now
                            </button>
                          </div>
                        ) : (
                          <div className="adm-detail__row">
                            <span className="lockout-badge lockout-badge--clear">Clear — can sign in</span>
                            <button
                              type="button"
                              className="lockout-reset-btn"
                              title="Clear any accumulated failed-attempt strikes for this administrator"
                              onClick={() => unlockAdmin(admin)}
                            >
                              Reset attempts
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions. Disabling yourself is not offered at all — the
                        server refuses it as well, and a button that always
                        fails is worse than an explained absence. */}
                    <div className="adm-actions">
                      {isSelf ? (
                        <p className="adm-actions__note">
                          <span className="adm-actions__note-icon" aria-hidden="true">i</span>
                          This is your own account. Another administrator has to change your access.
                        </p>
                      ) : (
                        <>
                          <p className="adm-actions__note adm-actions__note--muted">
                            {admin.enabled
                              ? 'Disabling signs this administrator out immediately and blocks new sign-ins.'
                              : 'Re-enabling lets this administrator sign in again straight away.'}
                          </p>
                          <button
                            type="button"
                            className={`adm-btn ${admin.enabled ? 'adm-btn--danger' : 'adm-btn--enable'}`}
                            onClick={() => toggleAdmin(admin)}
                            title={admin.enabled
                              ? 'Disable this administrator (they will be signed out)'
                              : 'Re-enable this administrator'}
                          >
                            {admin.enabled ? 'Disable admin' : 'Enable admin'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}

/**
 * The one place an administrator's authenticator key leaves the server.
 *
 * It sits in the Admins panel because that is the screen that already answers
 * "who holds console access", and it is deliberately a two-step action: pressing
 * the button only opens the code field, and the send happens on the second press
 * with a fresh authenticator code. A click that immediately mailed six mailboxes
 * is not a UI, it is an accident waiting for a stray finger.
 *
 * WHAT THE MAIL CANNOT CONTAIN
 * ----------------------------
 * A password. The server stores only a one-way hash, so there is no plaintext to
 * retrieve — the panel says this in the same words as the email, because an
 * operator who expects a password and gets an email without one will keep looking
 * for a bug that does not exist.
 */
function CredentialDelivery({ request, admins }) {
  const [open, setOpen] = useState(false);
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  // `hasAuthenticator` is absent on a server that predates this field, so an
  // unknown counts as deliverable and the server's own report has the last word.
  const reachable = useMemo(
    () => (admins || []).filter(admin => admin.email && admin.hasAuthenticator !== false).length,
    [admins]
  );

  const send = async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const data = await request('/admins/credential-delivery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ otp }),
      });
      setResult({ ok: true, message: data.message, ...data });
      setOtp('');
      setOpen(false);
    } catch (error) {
      // A refused delivery still carries the per-recipient report, so the honest
      // outcome ("3 failed, here is which") survives even though this is a 4xx/5xx.
      const data = error.data || {};
      setResult({ ok: false, message: error.message, ...data });
      setOtp('');
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const totals = result?.totals;

  return (
    <section className="adm-cd">
      <div className="adm-cd__head">
        <span className="adm-cd__mark" aria-hidden="true"><UserStatIcon name="mail" size={18} /></span>
        <div className="adm-cd__text">
          <strong>Credential delivery</strong>
          <p>
            Email every administrator their own sign-in alias and authenticator key, to the
            address configured for them in <code>ADMIN_EMAILS</code>. Passwords are one-way
            hashes, so they are never part of this — the recipient keeps the password they set.
          </p>
        </div>
        {!open && (
          <button type="button" className="adm-btn adm-btn--deliver" onClick={() => { setOpen(true); setResult(null); }}>
            Email credentials
          </button>
        )}
      </div>

      {open && (
        <form className="adm-cd__form" onSubmit={send}>
          <div className="adm-cd__field">
            <label htmlFor="cdOtp">Your authenticator code</label>
            <input
              id="cdOtp"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength="6"
              placeholder="6-digit code"
              value={otp}
              onChange={event => setOtp(event.target.value.replace(/\D/g, ''))}
              autoComplete="one-time-code"
              required
            />
          </div>
          <p className="adm-cd__warn">
            <span className="adm-cd__warn-icon" aria-hidden="true">i</span>
            <span>
              Sends one email to each of the {reachable} administrator{reachable === 1 ? '' : 's'} with an
              address on this list. The mail carries a live authenticator key — send it deliberately.
            </span>
          </p>
          <div className="adm-cd__buttons">
            <button type="submit" className="adm-btn adm-btn--deliver" disabled={busy || otp.length !== 6}>
              {busy ? 'Sending…' : 'Send now'}
            </button>
            <button type="button" className="adm-btn adm-btn--ghost" disabled={busy} onClick={() => { setOpen(false); setOtp(''); }}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {result && (
        <div className={`adm-cd__result adm-cd__result--${result.ok ? 'ok' : 'down'}`}>
          <strong>{result.message}</strong>
          {totals && (
            <ul className="adm-cd__stats">
              <li><span>{totals.delivered}</span> delivered</li>
              <li><span>{totals.failed}</span> failed</li>
              <li><span>{totals.missingEmail}</span> no email configured</li>
              <li><span>{totals.missingKey}</span> no authenticator key</li>
              {totals.unusableKey > 0 && <li><span>{totals.unusableKey}</span> key not usable</li>}
              {totals.unknownEmail > 0 && <li><span>{totals.unknownEmail}</span> address without an account</li>}
            </ul>
          )}
          {Array.isArray(result.report?.delivered) && result.report.delivered.length > 0 && (
            <p className="adm-cd__line">
              <strong>Delivered:</strong> {result.report.delivered.map(entry => entry.alias).join(', ')}
            </p>
          )}
          {Array.isArray(result.report?.failed) && result.report.failed.length > 0 && (
            <p className="adm-cd__line">
              <strong>Failed:</strong> {result.report.failed.map(entry => `${entry.alias} (${entry.reason})`).join('; ')}
            </p>
          )}
          {result.missingEmail?.length > 0 && (
            <p className="adm-cd__line">
              <strong>No address in .env for:</strong> {result.missingEmail.join(', ')}
            </p>
          )}
          {result.unusableKey?.length > 0 && (
            <p className="adm-cd__line">
              <strong>Key is not a usable authenticator seed, so it was not sent:</strong>{' '}
              {result.unusableKey.join(', ')} — rotate each one from that administrator's profile
              to mint a fresh key.
            </p>
          )}
          {result.unknownEmail?.length > 0 && (
            <p className="adm-cd__line">
              <strong>Addresses naming no admin account:</strong> {result.unknownEmail.join(', ')}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * "12 s ago" for a check timestamp. Returns 'not yet' for anything unparseable
 * so a malformed date renders as an absence rather than "NaN s ago".
 * @param {string} iso
 */
function relativeTime(iso) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return 'not yet';
  const seconds = Math.round((Date.now() - at) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/**
 * Status vocabulary for the provider cards.
 *
 * `tone` — not a class name — is what the cards read, because a global class
 * cannot be recoloured for one panel without dragging the Security Center's
 * `.healthy`/`.attention` along with it. Three tones, and the split is the
 * design's whole point:
 *
 *   ok    → emerald. It answered.
 *   down  → rose. Configured, and its live check failed. This is the only state
 *           worth interrupting somebody for.
 *   idle  → slate. No key. Running without one is a normal way to operate
 *           SuppliWise, so it must NOT be painted like a failure — the previous
 *           version gave `unconfigured` the same amber as a rejected key, which
 *           is the advice you least want to hand an admin ("your key is bad")
 *           to a provider that simply has no key.
 *
 * `AI_FAILURES` is DERIVED from this map rather than listed beside it, so a new
 * status cannot be added to one and forgotten in the other.
 */
const AI_STATUS = {
  ok: { label: 'Reachable', tone: 'ok' },
  rejected: { label: 'Key rejected', tone: 'down' },
  error: { label: 'Provider error', tone: 'down' },
  unreachable: { label: 'Unreachable', tone: 'down' },
  // The key is fine but the model it would be called with is not served to it.
  // Worth its own label: "add a key" is the wrong advice here, and "Reachable"
  // would hide a completion that is guaranteed to fail.
  'model-unavailable': { label: 'Model unavailable', tone: 'down' },
  unconfigured: { label: 'Not configured', tone: 'idle' },
};

/** A provider that IS configured but failed its live check. */
const AI_FAILURES = new Set(
  Object.entries(AI_STATUS).filter(([, v]) => v.tone === 'down').map(([k]) => k)
);

/** A provider that IS configured but failed its check is the only state worth alarming
 * the whole grid about — but the set itself now comes from AI_STATUS, and the cap
 * colour is a tone, so "broken" and "painted red" cannot fall out of step.
 */
function providerMonogram(label) {
  const text = String(label || '').trim();
  return text ? text.slice(0, 1).toUpperCase() : '?';
}

/** "724 ms" — omitted entirely when the probe never got far enough to measure. */
function formatLatency(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`;
}

/**
 * "A", "A and B", "A, B and C" — for the reload receipt.
 *
 * The server sends variable NAMES only, so there is nothing secret to print
 * here; the guard is just so a malformed payload cannot render "undefined" into
 * the panel, or blow up on a non-array.
 */
function listNames(names) {
  const items = (Array.isArray(names) ? names : []).filter(Boolean).map(String);
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * The model line under a card's status.
 *
 * Three distinct cases, which the old single ternary flattened into one:
 * a real model the key can reach, a real model it cannot, and no model at all.
 * `modelAvailable === null` means the server could not determine it (no key, or
 * verification disabled) and must not be drawn as a failure.
 *
 * The value, not the word "Model" — the row it sits in now carries a `Model`
 * label, and "Model — Model: gpt-5.4-nano" is the sort of doubled label that
 * makes a card look like it was assembled from two templates.
 */
function providerModelLine(provider) {
  if (!provider.model) return 'No model selected';
  const model = provider.model;
  if (provider.modelAvailable === false) return `${model} — not available to this key`;
  if (provider.modelCount) return `${model} (${provider.modelCount} available)`;
  return model;
}

/**
 * System detection & threat prediction used to live here, inside the AI tab.
 *
 * It is a forecast ABOUT the Security Center probes, drawn from their results,
 * so it belonged under the probes rather than beside the provider cards that
 * merely produced its input. It now renders inside SecurityStatus, and the
 * severity vocabulary moved with it — deliberately: AI_STATUS answers "can we
 * reach this provider", and borrowing its green/rose for a verdict about the
 * whole system would let a healthy provider card sit on top of a severe one.
 *
 * See SecurityStatus.jsx → ThreatPrediction.
 */

/**
 * Accent colour for a routing card, chosen by PROVIDER rather than by position.
 *
 * The old table reused `.provider__rows`, the provider cards' grid, whose first
 * column is a hard 62px — sized for labels like "Check" and "Model". A routing
 * label is a two-word uppercase string with no break opportunity inside either
 * word, so it overflowed that column and printed itself across the description
 * it was meant to label. Giving each route a whole card removes the shared
 * narrow axis entirely, and keying the colour off the provider means every route
 * bound to the same model reads as the same colour — which is the one grouping
 * an admin actually wants from this table.
 *
 * The accents deliberately skip emerald/rose/amber/slate: those already mean
 * reachable/broken/watch/idle elsewhere in this panel, and reusing them here
 * would make "this route goes to Groq" look like a health verdict.
 */
const ROUTE_TONES = {
  openrouter: 'violet',
  groq: 'ember',
  anthropic: 'fuchsia',
  openai: 'cyan',
};

/** A provider added on the server later still lands on a defined accent. */
const ROUTE_TONE_CYCLE = ['azure', 'cyan', 'indigo', 'violet', 'fuchsia', 'ember'];

function routeTone(route, index) {
  const key = String(route?.provider || '').trim().toLowerCase();
  if (ROUTE_TONES[key]) return ROUTE_TONES[key];
  return ROUTE_TONE_CYCLE[index % ROUTE_TONE_CYCLE.length];
}

/**
 * The routing table, as cards.
 *
 * Everything below renders defensively. The payload is the one place in this
 * panel that is generated from a hand-maintained list on the server, so a route
 * added without a label or a detail must still produce a readable card rather
 * than "undefined" painted in the middle of the admin console.
 */
function RoutingTable({ routing }) {
  const rows = (Array.isArray(routing) ? routing : []).filter(Boolean);
  if (rows.length === 0) return null;

  const providers = new Set(
    rows.map((route) => String(route.providerLabel || route.provider || '').trim()).filter(Boolean)
  );
  const unset = rows.filter((route) => !route.configured).length;

  return (
    <section className="admin-panel aip-routing" aria-labelledby="aip-routing-title">
      <header className="route-head">
        <div className="route-head__text">
          <h3 id="aip-routing-title">
            <span className="route-head__glyph" aria-hidden="true">
              <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="16 3 21 8 16 13" />
                <path d="M21 8H9a4 4 0 0 0-4 4v1" />
                <polyline points="8 21 3 16 8 11" />
                <path d="M3 16h12a4 4 0 0 0 4-4v-1" />
              </svg>
            </span>
            Where each feature is sent
          </h3>
          <p className="admin-muted">
            Every AI feature is dispatched through this one table, so a provider card above
            and the request that actually goes out can never disagree. Work is spread across
            providers rather than piled on one: the features that write a member’s plan and
            supplement guide use the default provider, the chat assistant and priority
            flagging go to Anthropic, description polish goes to OpenAI, and system detection
            goes to Groq. Add a key to <code>server/.env</code> and its purpose moves across
            on its own — nothing here needs a restart.
          </p>
        </div>

        {/* Triage before detail: an admin opening this panel wants to know how
            many features are affected by a missing key, not read six cards. */}
        <ul className="route-tally">
          <li><b>{rows.length}</b> features</li>
          <li><b>{providers.size}</b> {providers.size === 1 ? 'provider' : 'providers'}</li>
          <li className={unset ? 'route-tally--warn' : 'route-tally--ok'}>
            <b>{unset}</b> missing {unset === 1 ? 'key' : 'keys'}
          </li>
        </ul>
      </header>

      <ul className="route-grid">
        {rows.map((route, index) => {
          const tone = routeTone(route, index);
          const name = String(route.label || route.purpose || 'Unnamed feature');
          const provider = String(route.providerLabel || route.provider || 'Unknown provider');
          return (
            <li
              className={`route-card route-card--${tone}${route.configured ? '' : ' route-card--unset'}`}
              key={route.purpose || `${tone}-${index}`}
            >
              <span className="route-card__rail" aria-hidden="true" />

              <header className="route-card__head">
                <span className="route-card__mark" aria-hidden="true">
                  {providerMonogram(provider)}
                </span>
                <h4>{name}</h4>
              </header>

              {route.detail && <p className="route-card__detail">{route.detail}</p>}

              {/* The warning sits ABOVE the dispatch line, not below it. The strip
                  carries `margin-top: auto`, so anything placed after it would hang
                  lower on cards that have a warning and leave the dispatch lines of
                  one row ragged — and the dispatch line is the whole point of the
                  card. Placed here it also reads in the right order: the problem,
                  then where the request goes. */}
              {!route.configured && (
                <p className="route-card__warn">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                    <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                  </svg>
                  <span>
                    Not configured — set{' '}
                    <code>{route.envKey || 'this provider’s key'}</code> in server/.env
                  </span>
                </p>
              )}

              <p className="route-card__to">
                <span className="route-card__arrow" aria-hidden="true">→</span>
                <span className="route-card__provider">{provider}</span>
              </p>

              <p className="route-card__model">
                {route.model
                  ? <code>{route.model}</code>
                  : <span className="route-card__modelNone">No model pinned</span>}
              </p>

              {/* A fallback is part of where a request goes. Naming it here stops
                  an operator assuming the primary is the only thing that can
                  answer — and, on chat, that an unfunded Anthropic key is
                  about to take the assistant offline. */}
              {route.fallbackLabel && (
                <p className="route-card__fallback">
                  <span aria-hidden="true">↳</span> falls back to {route.fallbackLabel}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * What the priority-flagging provider actually did.
 *
 * This card exists because the provider card above CANNOT answer the question.
 * The health probe requests the model list, which a valid Anthropic key serves
 * happily — so an account with a working key and no credit probes "Reachable"
 * while every completion fails and the feature silently never runs. The card
 * would be telling the truth about the key and a lie about the feature.
 *
 * So this reads the LAST REAL CALL instead, and says plainly when there has not
 * been one yet.
 */
function PriorityFlaggingCard({ outcome }) {
  if (!outcome) {
    return (
      <p className="admin-muted aip-flagging">
        <strong>Priority flagging AI has not been called yet.</strong> It is exercised when a
        member submits an assessment the rule engine does not flag on its own. Until then the
        rule engine (<code>utils/severity.js</code>) is doing the whole job, which is a complete
        and supported way to run.
      </p>
    );
  }

  const ok = outcome.ok;
  return (
    <p className={`provider-env-reload provider-env-reload--${ok ? 'ok' : 'bad'} aip-flagging`}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {ok
          ? <><polyline points="20 6 9 17 4 12" /></>
          : <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>}
      </svg>
      <span>
        <strong>
          {ok
            ? `Priority flagging AI answered${outcome.escalated ? ' and escalated a flag' : ''}.`
            : 'Priority flagging AI did not answer.'}
        </strong>{' '}
        {outcome.model ? `${outcome.model} · ` : ''}
        {outcome.latencyMs != null ? `${outcome.latencyMs} ms · ` : ''}
        {relativeTime(outcome.at)}.
        {outcome.confidence != null && <> Confidence {outcome.confidence}%.</>}
        {outcome.error ? <> {outcome.error}</> : null}
        {ok && !outcome.escalated && (
          <> It did not consider this submission worth escalating, so the rule verdict stands.</>
        )}{' '}
        Either way the rule engine is authoritative — this layer can escalate a Priority
        review, never clear one.
      </span>
    </p>
  );
}

/**
 * Credentials that are set but cannot be spent on anything — REMOVED, and
 * deliberately so.
 *
 * This used to be a red banner listing every credential in server/.env that no
 * feature dispatches to. It was accurate, and it made an entirely normal
 * deployment look broken: "OpenAI is probed for health, but no feature is
 * routed to it" is a true sentence about a perfectly healthy configuration,
 * painted in the same alarm colour as a rejected key. An operator who sees red
 * on a panel that is working learns to ignore red — which is precisely when a
 * real one arrives.
 *
 * Both halves of that problem are fixed at the source instead:
 *
 *   - The AI work is now SPREAD across the providers that have keys, so there is
 *     no spare credential sitting idle while one provider takes every request.
 *   - "Is anything routed to this provider?" is read from the ROUTING TABLE
 *     rather than a string written beside the provider, so the claim cannot go
 *     stale the way the hand-maintained one did.
 *
 * A provider with no usable key now renders NO CARD at all (see `AiPanel`), so
 * "not configured" is expressed by absence rather than by an alarm. The routing
 * table below still names every feature, the provider that will serve it, and
 * the exact variable to set when it cannot.
 *
 * `utils/envUsage.js` still exists and still answers "which credentials are
 * unreadable" for scripts and diagnostics — it is simply no longer rendered as
 * an alarm in the middle of a working panel.
 */

function AiPanel({ ai, onCheckNow, checking, reload }) {
  // EVERY provider this server knows about, including the ones with no key.
  // Used for the totals, and for naming what could be added.
  const known = Array.isArray(ai?.providers) ? ai.providers : [];

  // ONLY the providers a usable credential is bound for in server/.env.
  //
  // This is the card policy, and it is what makes "add a key and the card
  // appears" work without any button press: the server reloads .env when the
  // file and the running process disagree (see routes/admin.js → aiPayload), so
  // a pasted key lands on the next poll and this filter reveals its card. A
  // provider nobody configured is not a fault and not news — it is simply not
  // part of this deployment — and it was previously spending a third of the
  // grid to say so.
  const providers = known.filter((provider) => provider && provider.configured);

  // One-second tick keeps "last checked 12 s ago" truthful. It is scoped to
  // this component, which only mounts while the AI tab is on screen.
  const [, setAgeTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setAgeTick((tick) => tick + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Triage numbers first. The question an admin opens this tab to answer is
  // "is anything broken", and making them read six cards to find out is the
  // thing the strip above them exists to remove. Counts are derived from the
  // same AI_STATUS tone map the cards use, and over the SAME list the grid
  // renders, so a card and the number above it can never disagree — in either
  // direction, which is what changed when unconfigured providers stopped
  // getting a card.
  const counts = providers.reduce(
    (acc, provider) => {
      const status = AI_STATUS[provider.status]
        || (provider.configured ? AI_STATUS.ok : AI_STATUS.unconfigured);
      acc[status.tone] += 1;
      return acc;
    },
    { ok: 0, down: 0, idle: 0 }
  );

  const statCards = [
    { tone: 'ok', label: 'Reachable', value: counts.ok, hint: 'Answered a live probe' },
    { tone: 'down', label: 'Needs attention', value: counts.down, hint: 'Configured, but failing' },
    { tone: 'all', label: 'Connected', value: providers.length, hint: 'Have a key in server/.env' },
    { tone: 'idle', label: 'Supported', value: known.length, hint: 'Providers this server knows' },
  ];

  return (
    <section className="admin-panel aip">
      <header className="aip-intro">
        <h3>AI Management and Control</h3>
        <p className="admin-muted">
          Live reachability of every AI provider SuppliWise can talk to. Each card is
          probed with a real request rather than read from an environment variable — a
          key can exist and still be revoked, unreachable, or never called. Database
          and API connectivity are monitored in the <strong>Security Center</strong> tab.
          The routing table below records which provider each feature is actually
          dispatched to, so a card and the request that goes out cannot disagree.
        </p>
      </header>

      <div className="aip-stats" role="group" aria-label="AI provider status summary">
        {statCards.map((card) => (
          <div className={`aip-stat aip-stat--${card.tone}`} key={card.tone}>
            <span className="aip-stat__value">{card.value}</span>
            <span className="aip-stat__label">{card.label}</span>
            <span className="aip-stat__hint">{card.hint}</span>
          </div>
        ))}
      </div>

      <div className="ai-panel-bar">
        <h3>Connected AI providers</h3>
        <div className="ai-panel-actions">
          <span className="admin-muted">
            {ai?.checkedAt ? `Last checked ${relativeTime(ai.checkedAt)}` : 'Not checked yet'}
          </span>
          <button
            type="button"
            className={`admin-secondary${checking ? ' is-checking' : ''}`}
            onClick={onCheckNow}
            disabled={checking || !onCheckNow}
          >
            <svg
              width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              className="aip-spin"
            >
              <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
            </svg>
            {checking ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>

      {/* A cached poll cannot see a .env edit: the server read the file once at
          boot, so an edited key keeps being judged by its old value. Saying so
          beats showing a confident but stale verdict. */}
      {ai?.envStale && (
        <p className="provider-env-stale">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            <strong>server/.env changed since the server started.</strong> The results below
            may describe the previous key.
          </span>
          <button type="button" className="admin-secondary" onClick={onCheckNow} disabled={checking}>
            {checking ? 'Reloading…' : 'Reload and re-check'}
          </button>
        </p>
      )}

      {/* What the last "Check now" actually did. Without this the button was a
          dead end: the server discarded the reload's own result, so a reload
          that could not read the file came back looking identical to a clean
          one — same cards, same "rejected" verdict — and the only thing left to
          conclude was that the new key was bad. Only NAMES ever arrive here;
          the server reports which variables moved, never their values. */}
      {reload && !reload.ok && (
        <p className="provider-env-reload provider-env-reload--bad">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>
            <strong>Reload failed</strong> — {reload.error || 'server/.env could not be read.'}{' '}
            The cards below are unchanged from the values already loaded in the server,
            so they say nothing about the file on disk. Check the file, then try again
            or restart the server.
          </span>
        </p>
      )}

      {reload?.ok && (reload.changed.length > 0 || reload.removed.length > 0) && (
        <p className="provider-env-reload provider-env-reload--ok">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          <span>
            <strong>Reloaded server/.env.</strong>{' '}
            {reload.changed.length > 0 && <>Applied {listNames(reload.changed)}. </>}
            {reload.removed.length > 0 && <>Removed {listNames(reload.removed)}.</>}
          </span>
        </p>
      )}

      {/* The grid shows ONLY providers with a key bound. So the two "nothing
          here" states need telling apart, which the old single "No provider data
          available." could not do: "the request came back empty" is a fault and
          needs saying, while "no provider is configured yet" is the normal
          starting point and must not read like one. */}
      <div className="provider-grid">
        {ai && known.length === 0 && (
          <p className="provider-empty provider-empty--down">
            The server returned no provider data. Check that it is running and that this
            administrator session is still valid, then use <strong>Check now</strong>.
          </p>
        )}

        {!ai && (
          <p className="provider-empty">Loading the providers this server can reach…</p>
        )}

        {ai && known.length > 0 && providers.length === 0 && (
          <div className="provider-empty">
            <strong>No provider keys are set.</strong>
            <span>
              A card appears here for each provider with a key in <code>server/.env</code>,
              and disappears again if you remove one — there is nothing to press and
              nothing to restart. OpenRouter is the default: that one key alone makes
              every AI feature work.
            </span>
            <ul>
              {known.map((provider) => (
                <li key={provider.key}>
                  <code>{provider.envKey || `${String(provider.key).toUpperCase()}_API_KEY`}</code>
                  {' — '}
                  {provider.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        {providers.map((provider) => {
          const status = AI_STATUS[provider.status]
            || (provider.configured ? AI_STATUS.ok : AI_STATUS.unconfigured);
          const failed = AI_FAILURES.has(provider.status);
          const latency = formatLatency(provider.latencyMs);
          return (
            <article
              className={`provider provider--${status.tone}${failed ? ' provider--down' : ''}`}
              key={provider.key}
            >
              <div className="provider__head">
                <span className="provider__mark" aria-hidden="true">{providerMonogram(provider.label)}</span>
                <span className="provider__title">
                  <strong>{provider.label}</strong>
                  <em>{provider.key}</em>
                </span>
                <span className="provider__status">
                  <i className="provider__statusDot" aria-hidden="true" />
                  {status.label}
                </span>
              </div>

              {latency && (
                <p className="provider__metric">
                  <span>Round trip</span>
                  <b>{latency}</b>
                </p>
              )}

              <dl className="provider__rows">
                <div className="provider__row">
                  <dt>Check</dt>
                  <dd>{provider.detail || 'No check has run for this provider yet.'}</dd>
                </div>
                <div className="provider__row">
                  <dt>Model</dt>
                  <dd>{providerModelLine(provider)}</dd>
                </div>
                {/* A self-hosted provider's address is the single most likely
                    thing to be wrong, so it is named on the card rather than
                    left for the operator to recall. */}
                {provider.baseUrl && (
                  <div className="provider__row">
                    <dt>Gateway</dt>
                    <dd><code className="provider__host">{provider.baseUrl}</code></dd>
                  </div>
                )}
                <div className="provider__row">
                  <dt>Used for</dt>
                  {/* Read from the routing table by the server, so this can only
                      be empty when NOTHING dispatches here — which is now a real
                      statement about a configured provider (the self-hosted
                      gateway) rather than a stale copy of an old assignment. */}
                  <dd className={provider.usedBy ? undefined : 'provider-usage--idle'}>
                    {provider.usedBy || 'Connected, but no feature dispatches to it yet'}
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>

      <RoutingTable routing={ai?.routing} />

      <PriorityFlaggingCard outcome={ai?.priorityFlagging} />

      <p className="aip-footnote admin-muted">
        Token usage and accuracy should be connected to provider usage APIs before being
        shown as billing or quality truth. This panel reports live reachability and
        configuration state only.
      </p>
    </section>
  );
}
function EyeIcon({ open }) {
  return open ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

function ProfilePanel({ profile, appearance, onSaveAppearance, editOpen, onToggleEdit, form, setForm, message, onSubmit, rotateOtp, setRotateOtp, rotatedKey, onRotate }) {
  const [showCurrent,  setShowCurrent]  = useState(false);
  const [showNew,      setShowNew]      = useState(false);
  const [pwLoading,    setPwLoading]    = useState(false);
  const [rotLoading,   setRotLoading]   = useState(false);

  /* ── Edit profile: picture + background picture ─────────────────────── */
  const savedAppearance = {
    profilePicture: appearance?.profilePicture || '',
    bannerPicture: appearance?.bannerPicture || '',
  };
  // Unsaved picture picks are held in `draft`; while there are none, the
  // server values (re-read from /profile every 10 s) render directly. Deriving
  // beats syncing in an effect: fresh values flow through immediately, there is
  // no cascading render, and a pick that has not been saved yet can never be
  // overwritten by a background refresh.
  const [draft, setDraft] = useState(null);
  const draftState = draft || savedAppearance;
  const [appearanceNote, setAppearanceNote] = useState(null); // { ok, text }
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const avatarInputRef = useRef(null);
  const bannerInputRef = useRef(null);

  const hasAppearanceChanges = draftState.profilePicture !== savedAppearance.profilePicture
    || draftState.bannerPicture !== savedAppearance.bannerPicture;

  // Saved pictures are root-relative `/pictures/…` paths; an unsaved pick is
  // still a data: URL. Only the render target is resolved — the values
  // themselves stay in their stored form so the change detection above and the
  // payload sent to PATCH /admin/profile both keep comparing like for like.
  const draftAvatarUrl = pictureUrl(draftState.profilePicture);
  const draftBannerUrl = pictureUrl(draftState.bannerPicture);

  const handlePicturePick = async (event, key, maxBytes, tooBigMessage) => {
    const file = event.target.files && event.target.files[0];
    // Reset first so picking the same file twice still fires a change event.
    event.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await readImageFile(file, maxBytes, tooBigMessage);
      if (!dataUrl) return;
      setDraft(current => ({ ...(current || savedAppearance), [key]: dataUrl }));
      setAppearanceNote(null);
    } catch (pickError) {
      setAppearanceNote({ ok: false, text: pickError.message });
    }
  };

  const clearPicture = (key) => {
    setDraft(current => ({ ...(current || savedAppearance), [key]: '' }));
    setAppearanceNote(null);
  };

  const handleAppearanceSave = async () => {
    if (!onSaveAppearance || appearanceSaving) return;
    setAppearanceSaving(true);
    try {
      const result = await onSaveAppearance(draftState);
      setAppearanceNote({ ok: Boolean(result && result.ok), text: (result && result.message) || '' });
      // Saved — drop the local draft so the now-current server values render.
      if (result && result.ok) setDraft(null);
    } catch (saveError) {
      setAppearanceNote({ ok: false, text: saveError.message || 'Unable to save the profile.' });
    } finally {
      setAppearanceSaving(false);
    }
  };

  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));

  const isSuccess = message && !message.toLowerCase().includes('invalid') &&
    !message.toLowerCase().includes('incorrect') &&
    !message.toLowerCase().includes('error') &&
    !message.toLowerCase().includes('failed') &&
    !message.toLowerCase().includes('required');

  const handlePasswordSubmit = async (event) => {
    setPwLoading(true);
    await onSubmit(event);
    setPwLoading(false);
  };

  const handleRotateSubmit = async (event) => {
    setRotLoading(true);
    await onRotate(event);
    setRotLoading(false);
  };

  // Eye icon (module scope — creating it inside ProfilePanel resets state on every render)
  return (
    <div className="profile-page">

      {/* ── Account card ─────────────────────────────────────────────── */}
      <div
        className="profile-card"
        id="admin-account-card"
        style={draftBannerUrl ? {
          backgroundImage: `url(${draftBannerUrl})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        } : undefined}
      >
        <span className="profile-card__glow profile-card__glow--a" aria-hidden="true" />
        <span className="profile-card__glow profile-card__glow--b" aria-hidden="true" />
        <span className="profile-card__glow profile-card__glow--c" aria-hidden="true" />
        <span className="profile-card__mesh" aria-hidden="true" />
        {draftState.bannerPicture && (
          <span className="profile-card__banner-shade" aria-hidden="true" />
        )}

        <div className="profile-card__avatar">
          {draftAvatarUrl
            ? <img className="profile-card__avatar-img" src={draftAvatarUrl} alt="" aria-hidden="true" />
            : (profile?.alias || 'A')[0].toUpperCase()}
          <span className="profile-card__avatar-ring" aria-hidden="true" />
        </div>

        <div className="profile-card__info">
          <p className="profile-card__eyebrow">
            <span className="profile-card__pulse" aria-hidden="true" />
            Signed in · full access
          </p>
          <div className="profile-card__title">
            <h2 className="profile-card__name">{profile?.alias || 'administrator'}</h2>
            <span className="profile-card__badge">Administrator</span>
          </div>
          <p className="profile-card__meta">Full administrative access to SuppliWise</p>

          <div className="profile-card__stats">
            <span className="profile-card__stat">
              <span className="profile-card__stat-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15.5 14" />
                </svg>
              </span>
              <span className="profile-card__stat-body">
                <em>Last login</em>
                <strong>{profile?.lastLoginAt ? new Date(profile.lastLoginAt).toLocaleString() : '—'}</strong>
              </span>
            </span>
            <span className="profile-card__stat">
              <span className="profile-card__stat-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" />
                </svg>
              </span>
              <span className="profile-card__stat-body">
                <em>Member since</em>
                <strong>{profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString() : '—'}</strong>
              </span>
            </span>
          </div>
        </div>
      </div>

      {/* ── Feedback message ─────────────────────────────────────────── */}
      {message && (
        <div className={`profile-alert ${isSuccess ? 'profile-alert--success' : 'profile-alert--error'}`} role="alert">
          <span>{isSuccess ? '✓' : '✕'}</span>
          {message}
        </div>
      )}

      <div className="profile-layout">

      {/* ── Edit profile: picture + background picture (collapsible) ──── */}
      <section className="admin-panel profile-panel profile-panel--rose" id="admin-edit-profile">
        <div className="profile-section-header">
          <span className="profile-section-icon profile-section-icon--rose" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
          </span>
          <h3 className="profile-section-title">
            <button
              type="button"
              className="profile-collapse"
              aria-expanded={Boolean(editOpen)}
              aria-controls={editOpen ? 'admin-edit-profile-body' : undefined}
              onClick={onToggleEdit}
            >
              <span>Edit profile</span>
              <span className={`profile-collapse__chev${editOpen ? ' is-open' : ''}`} aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9"/>
                </svg>
              </span>
            </button>
          </h3>
        </div>

        {editOpen && (
          <div className="profile-edit-body" id="admin-edit-profile-body">
            <p className="admin-muted profile-section-desc">Change your picture, your background picture, and the other details shown across the admin panel.</p>

            <div className="pf-look__grid">
            {/* Profile picture */}
            <div className="pf-look__row">
              <div className="pf-look__preview pf-look__preview--avatar">
                {draftAvatarUrl
                  ? <img src={draftAvatarUrl} alt="Profile picture preview" />
                  : <span aria-hidden="true">{(profile?.alias || 'A')[0].toUpperCase()}</span>}
              </div>
              <div className="pf-look__info">
                <strong>Profile picture</strong>
                <span className="admin-muted">Shown in the topbar and on this card · JPG, PNG or GIF · max 10 MB</span>
                <div className="pf-look__actions">
                  <button type="button" className="admin-secondary" onClick={() => avatarInputRef.current?.click()}>
                    Change picture
                  </button>
                  {draftState.profilePicture && (
                    <button type="button" className="admin-secondary pf-look__remove" onClick={() => clearPicture('profilePicture')}>
                      Remove
                    </button>
                  )}
                </div>
                <input
                  ref={avatarInputRef}
                  className="pf-look__file"
                  type="file"
                  accept="image/*"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => handlePicturePick(event, 'profilePicture', AVATAR_MAX_BYTES, 'Profile picture must be less than 10MB.')}
                />
              </div>
            </div>

            {/* Background picture */}
            <div className="pf-look__row">
              <div
                className="pf-look__preview pf-look__preview--banner"
                style={draftBannerUrl ? { backgroundImage: `url(${draftBannerUrl})` } : undefined}
              >
                {!draftBannerUrl && <span aria-hidden="true">No background</span>}
              </div>
              <div className="pf-look__info">
                <strong>Background picture</strong>
                <span className="admin-muted">Banner behind the account card · JPG, PNG or GIF · max 10 MB</span>
                <div className="pf-look__actions">
                  <button type="button" className="admin-secondary" onClick={() => bannerInputRef.current?.click()}>
                    Change background
                  </button>
                  {draftState.bannerPicture && (
                    <button type="button" className="admin-secondary pf-look__remove" onClick={() => clearPicture('bannerPicture')}>
                      Remove
                    </button>
                  )}
                </div>
                <input
                  ref={bannerInputRef}
                  className="pf-look__file"
                  type="file"
                  accept="image/*"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => handlePicturePick(event, 'bannerPicture', BANNER_MAX_BYTES, 'Background picture must be less than 10MB.')}
                />
              </div>
            </div>
            </div>

            {appearanceNote && (
              <div className={`profile-alert ${appearanceNote.ok ? 'profile-alert--success' : 'profile-alert--error'}`} role="alert">
                <span>{appearanceNote.ok ? '✓' : '✕'}</span>
                {appearanceNote.text}
              </div>
            )}

            <button
              type="button"
              className="admin-primary profile-submit"
              onClick={handleAppearanceSave}
              disabled={appearanceSaving || !hasAppearanceChanges}
            >
              {appearanceSaving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        )}
      </section>

      <div className="profile-layout__side">
        <div className="profile-layout__main">

        {/* ── Change password ────────────────────────────────────────── */}
        <section className="admin-panel profile-panel profile-panel--violet">
          <div className="profile-section-header">
            <span className="profile-section-icon profile-section-icon--violet" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </span>
            <h3>Change password</h3>
          </div>
          <p className="admin-muted profile-section-desc">Enter your current password and a new one. Your Google Authenticator code is required to confirm.</p>

          <form className="profile-form" onSubmit={handlePasswordSubmit} autoComplete="off">
            <div className="profile-field">
              <label htmlFor="currentPassword">Current password</label>
              <div className="profile-input-wrap">
                <input
                  id="currentPassword"
                  name="currentPassword"
                  type={showCurrent ? 'text' : 'password'}
                  value={form.currentPassword}
                  onChange={update}
                  autoComplete="current-password"
                  required
                />
                <button type="button" className="profile-eye" onClick={() => setShowCurrent(v => !v)} aria-label={showCurrent ? 'Hide password' : 'Show password'}>
                  <EyeIcon open={showCurrent} />
                </button>
              </div>
            </div>

            <div className="profile-field">
              <label htmlFor="newPassword">New password</label>
              <div className="profile-input-wrap">
                <input
                  id="newPassword"
                  name="newPassword"
                  type={showNew ? 'text' : 'password'}
                  value={form.newPassword}
                  onChange={update}
                  minLength="8"
                  autoComplete="new-password"
                  required
                />
                <button type="button" className="profile-eye" onClick={() => setShowNew(v => !v)} aria-label={showNew ? 'Hide password' : 'Show password'}>
                  <EyeIcon open={showNew} />
                </button>
              </div>
              <span className="profile-hint">Min. 8 characters, one uppercase letter, one number.</span>
            </div>

            <div className="profile-field">
              <label htmlFor="pwOtp">Google Authenticator code</label>
              <input
                id="pwOtp"
                name="otp"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength="6"
                placeholder="6-digit code"
                value={form.otp}
                onChange={event => setForm(current => ({ ...current, otp: event.target.value.replace(/\D/g, '') }))}
                autoComplete="one-time-code"
                required
              />
            </div>

            <button className="admin-primary profile-submit" disabled={pwLoading}>
              {pwLoading ? 'Changing…' : 'Change password'}
            </button>
          </form>
        </section>

        {/* ── Rotate authenticator key ──────────────────────────────── */}
        <section className="admin-panel profile-panel profile-panel--amber">
          <div className="profile-section-header">
            <span className="profile-section-icon profile-section-icon--amber" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
              </svg>
            </span>
            <h3>Rotate authenticator key</h3>
          </div>
          <p className="admin-muted profile-section-desc">Generate a new Google Authenticator secret. The old key stops working immediately — scan the new QR code before signing out.</p>

          <form className="profile-form" onSubmit={handleRotateSubmit}>
            <div className="profile-field">
              <label htmlFor="rotOtp">Current authenticator code</label>
              <input
                id="rotOtp"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength="6"
                placeholder="6-digit code"
                value={rotateOtp}
                onChange={event => setRotateOtp(event.target.value.replace(/\D/g, ''))}
                autoComplete="one-time-code"
                required
              />
            </div>

            <button className="admin-secondary profile-submit" disabled={rotLoading}>
              {rotLoading ? 'Generating…' : 'Generate new key'}
            </button>
          </form>

          {rotatedKey && (
            <div className="profile-qr">
              <p className="profile-qr__label">Scan this QR code in your authenticator app:</p>
              <img src={rotatedKey.qrCode} alt="New Google Authenticator QR code" className="profile-qr__img" />
              <div className="profile-qr__secret">
                <span className="profile-qr__secret-label">Manual entry key</span>
                <code className="profile-qr__secret-value">{rotatedKey.secret}</code>
              </div>
            </div>
          )}
        </section>

        </div>
      </div>
      </div>
    </div>
  );
}

export default AdminDashboard;
