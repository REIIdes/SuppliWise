import './AdminTopbar.css';

function AdminTopbar({
  admin,
  unreadCount,
  showNotifications,
  onToggleNotifications,
  onGoProfile,
  bellRef,
  onBellPointerEnter,
  onBellPointerLeave,
}) {
  const initials = admin?.alias
    ? admin.alias.charAt(0).toUpperCase()
    : 'A';

  return (
    <header className="admin-topbar">
      {/* ── Left: logo + brand ─────────────────────── */}
      <div className="admin-topbar__brand">
        <span className="admin-topbar__logo" aria-hidden="true">
          <svg width="28" height="28" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" rx="22" fill="#d46b35"/>
            <g transform="rotate(-40, 50, 50)">
              <rect x="22" y="36" width="56" height="28" rx="14" fill="none" stroke="white" strokeWidth="6"/>
              <line x1="50" y1="36" x2="50" y2="64" stroke="white" strokeWidth="6"/>
            </g>
          </svg>
        </span>
        <span className="admin-topbar__name">SuppliWise</span>
        <span className="admin-topbar__divider" aria-hidden="true"/>
        <span className="admin-topbar__panel">Control Panel</span>
      </div>

      {/* ── Right: bell + profile ──────────────────── */}
      <div className="admin-topbar__actions">

        {/* Bell / notifications — opens on hover (mouse/pen) as well as click */}
        <div
          className="admin-topbar__notif-wrap"
          ref={bellRef}
          onPointerEnter={onBellPointerEnter}
          onPointerLeave={onBellPointerLeave}
        >
          <button
            className="admin-topbar__icon-btn"
            aria-label="Open notifications"
            aria-expanded={showNotifications}
            onClick={onToggleNotifications}
          >
            {/* Bell SVG */}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
              <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
            {unreadCount > 0 && (
              <span className="admin-topbar__badge">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
        </div>

        {/* Profile avatar + name */}
        <button
          className="admin-topbar__profile"
          aria-label="Go to administrator profile"
          onClick={onGoProfile}
        >
          <span className="admin-topbar__avatar" aria-hidden="true">
            {initials}
          </span>
          <span className="admin-topbar__alias">
            {admin?.alias || 'Administrator'}
          </span>
        </button>

      </div>
    </header>
  );
}

export default AdminTopbar;
