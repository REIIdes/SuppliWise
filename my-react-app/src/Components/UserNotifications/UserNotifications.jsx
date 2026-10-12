import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  deleteAllReadNotifications,
  getToken,
} from '../../api';
import { resolveUserTarget, timeAgo, visualKind } from '../../notifications/notificationTargets';
import NotificationGlyph from '../../notifications/NotificationGlyph';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import NotificationDetailModal from '../NotificationDetailModal/NotificationDetailModal';
import '../../notifications/notificationAccents.css';
import './UserNotifications.css';

export default function UserNotifications() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState(null);
  // Destructive-action guard for "Delete all read" — see handleClearRead.
  const [confirmingClearRead, setConfirmingClearRead] = useState(false);
  // The row whose detail window is open, and which of its buttons is in flight.
  // `null` means no window.
  const [detail, setDetail] = useState(null);
  const [detailBusy, setDetailBusy] = useState(null);
  const [detailError, setDetailError] = useState('');
  const readCount = items.filter(n => n.read).length;
  // The header count is the only unread number on screen once the panel covers
  // the bell's badge, so it is derived rather than mirrored — it used to drift
  // every time a row was read or deleted.
  const unreadInView = items.filter(n => !n.read).length;
  const wrapRef = useRef(null);
  const panelRef = useRef(null);
  const closeTimerRef = useRef(0);
  const hoverSuppressedRef = useRef(false);
  const lastRefreshRef = useRef(0);
  // Mirror of `items` so the read/delete handlers can ask what a row's CURRENT
  // state is without depending on `items` (which would give every one of them a
  // new identity on each poll).
  const itemsRef = useRef([]);
  useEffect(() => { itemsRef.current = items; }, [items]);

  const refresh = useCallback(async (silent = true) => {
    if (!getToken()) return;
    if (!silent) setLoading(true);
    try {
      const data = await getNotifications(20);
      setItems(data.notifications || []);
      setUnread(data.unreadCount || 0);
    } catch {
      // Bell stays usable with cached state; errors are non-blocking
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    lastRefreshRef.current = Date.now();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initial inbox load + 60s poll
    refresh(true);
    const timer = window.setInterval(() => refresh(true), 60000);
    // Sync the moment the user returns to the tab (covers "doesn't sync" gaps)
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = 0;
    }
  }, []);

  // Grace period: bell and panel are one DOM tree separated by a 10px visual
  // gap — leaving for the gap must not slam the panel shut before the pointer
  // reaches it.
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = 0;
      setOpen(false);
    }, 200);
  }, [cancelClose]);

  // Refresh when the panel opens, at most once every 4s so rapid hover
  // in/out or repeated clicks can't hammer the notifications endpoint.
  const openRefresh = (showLoading) => {
    const now = Date.now();
    if (now - lastRefreshRef.current < 4000) return;
    lastRefreshRef.current = now;
    refresh(showLoading);
  };

  const handleHoverEnter = (event) => {
    // Touch has no hover — it keeps the click-to-toggle path below.
    if (event.pointerType === 'touch') return;
    if (hoverSuppressedRef.current) return;
    cancelClose();
    if (!open) {
      setOpen(true);
      openRefresh(false);
    }
  };

  const handleHoverLeave = (event) => {
    if (event.pointerType === 'touch') return;
    hoverSuppressedRef.current = false;
    scheduleClose();
  };

  const openPanel = () => {
    cancelClose();
    if (open) {
      setOpen(false);
      // Latch hover-reopen only while the pointer is genuinely over the bell
      // (a keyboard toggle elsewhere must not disable hover for good).
      hoverSuppressedRef.current = !!wrapRef.current?.matches(':hover');
    } else {
      hoverSuppressedRef.current = false;
      setOpen(true);
      openRefresh(true);
    }
  };

  // Anchor the panel to the bell in viewport coordinates (position: fixed),
  // re-measuring on scroll (capture phase — covers any scrollable ancestor)
  // and resize so it stays pinned beneath the bell while the page scrolls.
  // useLayoutEffect applies the coordinates before paint: no first-frame jump.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const anchor = wrapRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 32);
      const left = Math.min(
        Math.max(rect.right - width, 12),
        Math.max(12, window.innerWidth - width - 12)
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
  }, [open]);

  // Clear a pending hover-close timer if the navbar unmounts mid-transition.
  useEffect(() => () => window.clearTimeout(closeTimerRef.current), []);

  // ── The detail window ────────────────────────────────────────────────────
  //
  // Pressing a row OPENS THE WINDOW; it no longer navigates. That is the whole
  // fix: navigation used to be decided here from the title, so a support reply
  // ("Support replied to your message") fell through to the /history default and
  // dumped somebody on their assessment history instead of the conversation.
  // The destination now travels with the row — see notificationTargets.js.

  const markReadLocally = useCallback((id) => {
    setItems(prev => prev.map(n => (n._id === id ? { ...n, read: true } : n)));
    // The row's CURRENT read state, read through a mirror rather than from the
    // caller's closure (which can be stale — "Mark all as read" may have run
    // while the window was open) and never from inside a state updater, which
    // React is free to call more than once.
    const wasUnread = itemsRef.current.some(n => n._id === id && !n.read);
    if (wasUnread) setUnread(prev => Math.max(0, prev - 1));
  }, []);

  const openDetail = useCallback((item) => {
    setDetailError('');
    setDetailBusy(null);
    setDetail(item);
    setOpen(false);
    // Latch hover-reopen off while the pointer is still over the bell, or the
    // panel pops straight back up behind the window.
    hoverSuppressedRef.current = !!wrapRef.current?.matches(':hover');
  }, []);

  const closeDetail = useCallback(() => {
    setDetail(null);
    setDetailBusy(null);
    setDetailError('');
  }, []);

  const detailMarkRead = useCallback(async () => {
    if (!detail || detail.read) return;
    const id = detail._id;
    try {
      setDetailBusy('read');
      await markNotificationRead(id);
      markReadLocally(id);
      setDetail((current) => (current && current._id === id ? { ...current, read: true } : current));
      setDetailError('');
    } catch (error) {
      setDetailError(error.message || 'Could not mark this notification as read.');
    } finally {
      setDetailBusy(null);
    }
  }, [detail, markReadLocally]);

  const detailDelete = useCallback(async () => {
    if (!detail) return;
    const id = detail._id;
    try {
      setDetailBusy('delete');
      await deleteNotification(id);
      const wasUnread = !detail.read;
      setItems(prev => prev.filter(n => n._id !== id));
      if (wasUnread) setUnread(prev => Math.max(0, prev - 1));
      setDetail(null);
      setDetailError('');
    } catch (error) {
      setDetailError(error.message || 'Could not delete this notification.');
    } finally {
      setDetailBusy(null);
    }
  }, [detail]);

  const detailGoTo = useCallback(async () => {
    if (!detail) return;
    const target = resolveUserTarget(detail);
    if (!target) return;
    // Opening the notice counts as reading it, so this marks read first and
    // proceeds regardless — a failed receipt must not strand the user on the
    // panel they just left.
    if (!detail.read) {
      try {
        await markNotificationRead(detail._id);
        markReadLocally(detail._id);
      } catch {
        // Non-blocking.
      }
    }
    setDetail(null);
    setOpen(false);
    navigate(target.path);
  }, [detail, markReadLocally, navigate]);

  const handleMarkAll = async () => {
    try {
      setActionId('all');
      await markAllNotificationsRead();
      setItems(prev => prev.map(n => ({ ...n, read: true })));
      // Keep an open window in step — otherwise it goes on offering "Mark as
      // read" for a row that is already read.
      setDetail(current => (current ? { ...current, read: true } : current));
      setUnread(0);
    } catch {
      // Non-blocking
    } finally {
      setActionId(null);
    }
  };

  // Clears the read history in one shot. Guarded because it is the only
  // destructive action in the panel and there is no undo. No count in the
  // prompt: the panel only renders a page of the inbox, while the endpoint
  // clears every read row, so any number here would understate it.
  //
  // This only RAISES the dialog — window.confirm() is silently swallowed by the
  // Android/Capacitor webview (the button looked dead) and a native dialog
  // cannot be styled. See confirmClearRead below for the actual work.
  const handleClearRead = () => {
    setConfirmingClearRead(true);
  };

  const confirmClearRead = async () => {
    setConfirmingClearRead(false);
    if (actionId) return;
    try {
      setActionId('clear');
      await deleteAllReadNotifications();
      setItems(prev => prev.filter(n => !n.read));
    } catch {
      // Non-blocking
    } finally {
      setActionId(null);
    }
  };

  const handleDelete = async (e, item) => {
    e.stopPropagation();
    try {
      setActionId(item._id);
      await deleteNotification(item._id);
      setItems(prev => prev.filter(n => n._id !== item._id));
      if (!item.read) setUnread(prev => Math.max(0, prev - 1));
      // Deleting the row that is open behind the window would leave the window
      // describing something that no longer exists.
      setDetail((current) => (current && current._id === item._id ? null : current));
    } catch {
      // Non-blocking
    } finally {
      setActionId(null);
    }
  };

  return (
    <div
      className="user-notif"
      ref={wrapRef}
      onPointerEnter={handleHoverEnter}
      onPointerLeave={handleHoverLeave}
    >
      <button
        type="button"
        className="user-notif__bell"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={openPanel}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="user-notif__badge">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <div
          className="user-notif__panel nd-root"
          ref={panelRef}
          role="dialog"
          aria-label="Notifications"
        >
          <div className="user-notif__header">
            <span className="user-notif__heading">
              <strong>Notifications</strong>
              {/* In words as well as digits. The number beside a bell was
                  readable as a badge and as nothing at all once the panel
                  covered it. */}
              <span className={`user-notif__count${unread > 0 ? '' : ' user-notif__count--clear'}`}>
                {unread > 0 ? `${unread} unread` : 'All caught up'}
              </span>
            </span>
            {/* Both actions wrap onto their own row on narrow panels instead
                of squeezing the title — the title is the first thing to lose
                space, not the labels. */}
            <div className="user-notif__actions">
              {unread > 0 && (
                <button
                  type="button"
                  className="user-notif__action"
                  onClick={handleMarkAll}
                  disabled={actionId !== null}
                >
                  {actionId === 'all' ? 'Marking…' : 'Mark all as read'}
                </button>
              )}
              {readCount > 0 && (
                <button
                  type="button"
                  className="user-notif__action user-notif__action--danger"
                  onClick={handleClearRead}
                  disabled={actionId !== null}
                >
                  {actionId === 'clear' ? 'Clearing…' : 'Delete all read'}
                </button>
              )}
            </div>
          </div>
          <div className="user-notif__list">
            {/* A skeleton matching the real row shape, so the panel does not
                resize when the first page lands. The old "Loading…" line was a
                different height from three rows and made the box jump. */}
            {loading && items.length === 0 && (
              <div aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div className="user-notif__skeleton" key={i}>
                    <span className="user-notif__skel-tile" />
                    <span className="user-notif__skel-lines">
                      <span className="user-notif__skel-line user-notif__skel-line--title" />
                      <span className="user-notif__skel-line" />
                      <span className="user-notif__skel-line user-notif__skel-line--short" />
                    </span>
                  </div>
                ))}
              </div>
            )}
            {!loading && items.length === 0 && (
              <div className="nd-empty" role="status">
                <span className="nd-empty__art">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20.5 8.5A8.5 8.5 0 0 0 4 8.5c0 6.5-2.5 8.5-2.5 8.5h21S20.5 15 20.5 8.5" />
                    <path d="M9 20.5a3.2 3.2 0 0 0 6 0" />
                    <path d="M9.5 11.5l1.8 1.8 3.4-3.6" />
                  </svg>
                </span>
                <p className="nd-empty__title">You&apos;re all caught up</p>
                <p className="nd-empty__body">
                  Support replies, security notices and plan updates will land here.
                </p>
              </div>
            )}
            {items.map(item => {
              const kind = visualKind(item, 'user');
              return (
                <div
                  key={item._id}
                  className={[
                    'nd-row',
                    `nd-kind-${kind}`,
                    item.read ? '' : 'nd-row--unread',
                  ].filter(Boolean).join(' ')}
                  onClick={() => openDetail(item)}
                  role="button"
                  tabIndex={0}
                  aria-label={`${item.read ? 'Read' : 'Unread'}: ${item.title}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      openDetail(item);
                    }
                  }}
                >
                  {/* One glyph per family, so a full panel is scannable by
                      silhouette. The ⚑ this replaced could only say "urgent",
                      which made twenty ordinary notices look like one alarm. */}
                  <span className="nd-tile">
                    <NotificationGlyph kind={kind} />
                  </span>
                  <span className="nd-body">
                    <span className="nd-title">{item.title}</span>
                    {item.detail && <span className="nd-detail">{item.detail}</span>}
                    <span className="nd-time">{timeAgo(item.createdAt)}</span>
                  </span>
                  <span className={`nd-state${item.read ? '' : ' nd-state--unread'}`}>
                    {item.read ? 'Read' : 'New'}
                  </span>
                  <button
                    type="button"
                    className="nd-remove"
                    aria-label={`Delete: ${item.title}`}
                    disabled={actionId === item._id}
                    onClick={(e) => handleDelete(e, item)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                         strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
          {unreadInView > 0 && items.length > 0 && (
            <p className="user-notif__hint" aria-hidden="true">
              Select a notification to see the full message
            </p>
          )}
        </div>
      )}

      {/* Also a SIBLING of the dropdown, and for the same reason: the panel's
          close-on-outside-click handler must not tear out the row the window
          was raised from. The panel is closed explicitly in openDetail instead,
          so the two layers never stack. */}
      <NotificationDetailModal
        item={detail}
        kind="user"
        target={detail ? resolveUserTarget(detail) : null}
        busy={detailBusy}
        canDelete
        error={detailError}
        onClose={closeDetail}
        onMarkRead={detailMarkRead}
        onDelete={detailDelete}
        onGoTo={detailGoTo}
      />

      {/* Rendered as a SIBLING of the dropdown, not inside it: opening the
          dialog must not unmount the panel that raised it, or the panel's own
          close-on-outside-click handler tears the button out from under the
          confirmation. */}
      {confirmingClearRead && (
        <ConfirmModal
          type="danger"
          title="Delete all read notifications?"
          message="This clears your read history. Unread notifications are kept. This cannot be undone."
          confirmText="Delete read notifications"
          cancelText="Keep them"
          onConfirm={confirmClearRead}
          onCancel={() => setConfirmingClearRead(false)}
        />
      )}
    </div>
  );
}
