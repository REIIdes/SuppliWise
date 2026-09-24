import { useEffect, useRef, useState } from 'react';
import './AdminTopbar.css';

const MENU_ICONS = {
  account: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <polyline points="9 12 11 14 15 10"/>
    </svg>
  ),
  edit: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9"/>
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>
    </svg>
  ),
  signout: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  ),
};

function AdminAvatar({ profilePicture, initials, className }) {
  if (profilePicture) {
    return <img className={className} src={profilePicture} alt="" aria-hidden="true" />;
  }
  return <span className={className}>{initials}</span>;
}

function AdminTopbar({
  admin,
  profilePicture,
  unreadCount,
  showNotifications,
  onToggleNotifications,
  onManageAccount,
  onEditProfile,
  onSignOut,
  onMenuOpenChange,
  bellRef,
  onBellPointerEnter,
  onBellPointerLeave,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const initials = admin?.alias
    ? admin.alias.charAt(0).toUpperCase()
    : 'A';

  // The menu collapses on outside click and on Escape — the pill itself and
  // the panel are separate nodes, so both are checked for containment.
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const toggleMenu = () => {
    const next = !menuOpen;
    setMenuOpen(next);
    // Only one anchored panel at a time: opening the profile menu closes the
    // notification panel (and the bell's own click handler does the reverse).
    if (next) onMenuOpenChange?.(true);
  };

  const runItem = (action) => {
    setMenuOpen(false);
    action?.();
  };

  return (
    <header className="admin-topbar">
      <span className="admin-topbar__glow" aria-hidden="true" />

      {/* ── Left: logo + brand ─────────────────────── */}
      <div className="admin-topbar__brand">
        <span className="admin-topbar__logo" aria-hidden="true">
          <svg width="26" height="26" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <g transform="rotate(-40, 50, 50)">
              <rect x="22" y="36" width="56" height="28" rx="14" fill="none" stroke="white" strokeWidth="9"/>
              <line x1="50" y1="36" x2="50" y2="64" stroke="white" strokeWidth="9"/>
            </g>
          </svg>
        </span>
        <span className="admin-topbar__name">SuppliWise</span>
        <span className="admin-topbar__divider" aria-hidden="true"/>
        <span className="admin-topbar__panel">Control Panel</span>

        {/* Live system status chip */}
        <span className="admin-topbar__status" title="All monitored systems operational">
          <span className="admin-topbar__status-dot" aria-hidden="true" />
          Operational
        </span>
      </div>

      {/* ── Right: secure badge + bell + profile ───── */}
      <div className="admin-topbar__actions">

        {/* Encrypted-connection reassurance */}
        <span className="admin-topbar__secure" title="Encrypted connection">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <span>Secure</span>
        </span>

        {/* Bell / notifications — opens on hover (mouse/pen) as well as click */}
        <div
          className="admin-topbar__notif-wrap"
          ref={bellRef}
          onPointerEnter={onBellPointerEnter}
          onPointerLeave={onBellPointerLeave}
        >
          <button
            className={`admin-topbar__icon-btn${showNotifications ? ' is-open' : ''}`}
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

        {/* Profile pill — toggles the collapsible account menu */}
        <div className="admin-topbar__menu" ref={menuRef}>
          <button
            className={`admin-topbar__profile${menuOpen ? ' is-open' : ''}`}
            aria-label="Open account menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls="admin-profile-menu"
            onClick={toggleMenu}
          >
            <AdminAvatar
              profilePicture={profilePicture}
              initials={initials}
              className="admin-topbar__avatar"
            />
            <span className="admin-topbar__alias">
              {admin?.alias || 'Administrator'}
            </span>
            <span className={`admin-topbar__chev${menuOpen ? ' is-open' : ''}`} aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="6 9 12 15 18 9"/>
              </svg>
            </span>
          </button>

          {menuOpen && (
            <div className="admin-topbar__dropdown" id="admin-profile-menu" role="menu">
              <div className="admin-topbar__dropdown-head">
                <AdminAvatar
                  profilePicture={profilePicture}
                  initials={initials}
                  className="admin-topbar__dropdown-avatar"
                />
                <span className="admin-topbar__dropdown-id">
                  <strong>{admin?.alias || 'Administrator'}</strong>
                  <em>Administrator</em>
                </span>
              </div>

              <button
                type="button"
                role="menuitem"
                className="admin-topbar__menu-item"
                onClick={() => runItem(onManageAccount)}
              >
                <span className="admin-topbar__menu-icon" aria-hidden="true">{MENU_ICONS.account}</span>
                <span className="admin-topbar__menu-text">
                  <strong>Manage Account</strong>
                  <em>Password, authenticator &amp; account details</em>
                </span>
              </button>

              <button
                type="button"
                role="menuitem"
                className="admin-topbar__menu-item"
                onClick={() => runItem(onEditProfile)}
              >
                <span className="admin-topbar__menu-icon admin-topbar__menu-icon--accent" aria-hidden="true">{MENU_ICONS.edit}</span>
                <span className="admin-topbar__menu-text">
                  <strong>Edit Profile</strong>
                  <em>Change picture, background picture, etc.</em>
                </span>
              </button>

              <span className="admin-topbar__dropdown-sep" aria-hidden="true" />

              <button
                type="button"
                role="menuitem"
                className="admin-topbar__menu-item admin-topbar__menu-item--danger"
                onClick={() => runItem(onSignOut)}
              >
                <span className="admin-topbar__menu-icon" aria-hidden="true">{MENU_ICONS.signout}</span>
                <span className="admin-topbar__menu-text">
                  <strong>Sign out</strong>
                  <em>End this admin session</em>
                </span>
              </button>
            </div>
          )}
        </div>

      </div>
    </header>
  );
}

export default AdminTopbar;
