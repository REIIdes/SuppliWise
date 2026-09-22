import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
  isSecurityNotification,
} from '../../api';
import './UserNotifications.css';

function timeAgo(iso) {
  if (!iso) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function UserNotifications() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [actionId, setActionId] = useState(null);
  const wrapRef = useRef(null);

  const refresh = useCallback(async (silent = true) => {
    if (!localStorage.getItem('token')) return;
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

  const openPanel = () => {
    setOpen(v => !v);
    refresh(false);
  };

  const handleItemClick = async (item) => {
    if (!item.read) {
      try {
        await markNotificationRead(item._id);
        setItems(prev => prev.map(n => (n._id === item._id ? { ...n, read: true } : n)));
        setUnread(prev => Math.max(0, prev - 1));
      } catch {
        // Navigation still proceeds even if the read-receipt fails
      }
    }
    setOpen(false);
    // Deep link: security notices open Profile → Account Security so users
    // land where they can act (password/2FA); flagged assessments open History.
    if (isSecurityNotification(item)) {
      navigate('/profile?section=security');
    } else {
      navigate('/history');
    }
  };

  const handleMarkAll = async () => {
    try {
      setActionId('all');
      await markAllNotificationsRead();
      setItems(prev => prev.map(n => ({ ...n, read: true })));
      setUnread(0);
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
    } catch {
      // Non-blocking
    } finally {
      setActionId(null);
    }
  };

  return (
    <div className="user-notif" ref={wrapRef}>
      <button
        type="button"
        className="user-notif__bell"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        onClick={openPanel}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unread > 0 && (
          <span className="user-notif__badge">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>

      {open && (
        <div className="user-notif__panel" role="dialog" aria-label="Notifications">
          <div className="user-notif__header">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button
                type="button"
                className="user-notif__action"
                onClick={handleMarkAll}
                disabled={actionId === 'all'}
              >
                {actionId === 'all' ? 'Marking…' : 'Mark all as read'}
              </button>
            )}
          </div>
          <div className="user-notif__list">
            {loading && items.length === 0 && (
              <p className="user-notif__empty">Loading…</p>
            )}
            {!loading && items.length === 0 && (
              <p className="user-notif__empty">You're all caught up. 🎉</p>
            )}
            {items.map(item => (
              <div
                key={item._id}
                className={`user-notif__item${item.read ? '' : ' user-notif__item--unread'}`}
                onClick={() => handleItemClick(item)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleItemClick(item);
                }}
              >
                {item.type === 'severe-flag' && (
                  <span className="user-notif__flag" title="Flagged for review">⚑</span>
                )}
                <div className="user-notif__body">
                  <span className="user-notif__title">{item.title}</span>
                  {item.detail && <span className="user-notif__detail">{item.detail}</span>}
                  <span className="user-notif__time">{timeAgo(item.createdAt)}</span>
                </div>
                {!item.read && <span className="user-notif__dot" aria-hidden="true" />}
                <button
                  type="button"
                  className="user-notif__delete"
                  aria-label="Delete notification"
                  disabled={actionId === item._id}
                  onClick={(e) => handleDelete(e, item)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
