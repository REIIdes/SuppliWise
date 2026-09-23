import { NavLink, useLocation } from 'react-router-dom';
import UserNotifications from '../UserNotifications/UserNotifications';
import useAuth from '../../hooks/useAuth';
import { hasAdminSession } from '../../auth/authState';
import './Navbar.css';

function Navbar() {
  // Reactive session: the navbar flips between signed-in/out the instant
  // the token changes (login, logout, account switch) — no reload needed.
  const { token, user } = useAuth();
  const location = useLocation();
  // The auth pages must never wear the signed-in chip: /login is reachable
  // while signed in only for "add another account" (?add=1), and showing the
  // active account over the Sign In form reads as a glitch. Account
  // management (switch / add / sign out) lives in Profile → Accounts.
  const onAuthPage = location.pathname === '/login' || location.pathname === '/signup';
  const showSession = Boolean(token && user) && !onAuthPage;
  const displayName = user?.firstName && user?.lastName
    ? `${user.firstName} ${user.lastName}`
    : (user?.name || 'Account');
  const avatarInitial = (
    user?.firstName?.charAt(0) ||
    user?.name?.charAt(0) ||
    'A'
  ).toUpperCase();

  return (
    <nav className="navbar">
      <div className="navbar-left">
        <div className="navbar-logo-box">
          <svg width="30" height="30" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" rx="22" fill="#3dbf8a"/>
            <g transform="rotate(-40, 50, 50)">
              <rect x="22" y="36" width="56" height="28" rx="14" fill="none" stroke="white" strokeWidth="6"/>
              <line x1="50" y1="36" x2="50" y2="64" stroke="white" strokeWidth="6"/>
            </g>
          </svg>
        </div>
        <NavLink to={token ? "/dashboard" : "/"} className="navbar-brand">SuppliWise</NavLink>
      </div>
      <div className="navbar-right">
        {showSession ? (
          <>
            <UserNotifications />
            <NavLink to="/history" className="navbar-nav-link" title="History">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </NavLink>
            <NavLink to="/profile" className="navbar-profile-link" title="Profile Settings">
              <div 
                className="navbar-avatar"
                style={{
                  backgroundImage: user.profilePicture ? `url(${user.profilePicture})` : 'none',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              >
                {!user.profilePicture && avatarInitial}
              </div>
              <span className="navbar-username">
                {displayName}
              </span>
            </NavLink>
          </>
        ) : hasAdminSession() ? (
          // Active admin session: point at the admin panel — a user
          // "Sign In" button would just bounce them back there anyway
          // (route guards keep signed-in admins inside /admin).
          <NavLink to="/admin" className="navbar-signin-btn">
            Admin Panel
          </NavLink>
        ) : (
          <NavLink to="/login" className="navbar-signin-btn">
            Sign In
          </NavLink>
        )}
      </div>
    </nav>
  );
}

export default Navbar;
