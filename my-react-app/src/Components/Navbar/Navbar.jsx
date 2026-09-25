import { useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import UserNotifications from '../UserNotifications/UserNotifications';
import ProfileActionsMenu from '../ProfileActionsMenu/ProfileActionsMenu';
import ConfirmLogoutModal from '../ConfirmLogoutModal/ConfirmLogoutModal';
import useAuth from '../../hooks/useAuth';
import useSubscription from '../../hooks/useSubscription';
import { PLAN_LABELS } from '../../subscription/features';
import { signOutCurrentAccount } from '../../api';
import './Navbar.css';

// Product destinations rendered inside the account menu. Module scope so the
// array identity is stable — rebuilding it each render would hand the menu a
// new `navItems` prop on every parent render for no reason.
//
// Icons are inline SVG rather than the emoji the top bar used: emoji render
// differently per platform, so the same menu looked inconsistent across
// Windows/macOS/Android.
const NAV_ITEMS = [
  {
    key: 'web3',
    label: 'Web3',
    hint: 'Wallet, supply chain & proofs',
    to: '/web3',
    tone: 'web3',
    // Entitlement key for this entry (ULTIMATE). Read by the gate below.
    feature: 'web3',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <path d="M14 17.5h7M17.5 14v7" />
      </svg>
    ),
  },
  {
    key: 'market',
    label: 'Market',
    hint: 'Buy & sell with WELL',
    to: '/marketplace',
    tone: 'market',
    feature: 'market',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="9" cy="20" r="1.4" />
        <circle cx="18" cy="20" r="1.4" />
        <path d="M2 3h2.2l2.4 12.2a1.6 1.6 0 0 0 1.6 1.3h9.1a1.6 1.6 0 0 0 1.6-1.3L21 7H5.4" />
      </svg>
    ),
  },
  {
    key: 'dao',
    label: 'DAO',
    hint: 'Proposals, votes & treasury',
    to: '/governance',
    tone: 'dao',
    feature: 'dao',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 21h18" />
        <path d="M5 21V10l7-5 7 5v11" />
        <path d="M9 21v-6h6v6" />
      </svg>
    ),
  },
];

function Navbar() {
  // Reactive session: the navbar flips between signed-in/out the instant
  // the token changes (login, logout, account switch) — no reload needed.
  const { token, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
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

  // DELUXE gate for the blockchain layer. Read here, in the one place that
  // already owns these routes, and passed down as `locked` — the menu stays a
  // generic renderer and the routes stay declared in one place.
  //
  // This is presentation only. The real enforcement is requireFeature on the
  // server (routes/web3/guards.js), which re-checks on every request, so a
  // stale menu cannot grant access.
  const { canAccess } = useSubscription();
  const navItems = NAV_ITEMS.map((n) => {
    if (!n.feature) return n;
    const unlocked = canAccess(n.feature);
    return unlocked
      ? n
      : { ...n, locked: true, lockedHint: `${PLAN_LABELS.monthly} plan` };
  });

  // The account menu drives the profile page through the URL rather than
  // through shared component state. The Navbar and ProfilePage are siblings
  // with no common owner, so a query param is the one channel that works
  // without lifting state or publishing a global event — and it survives a
  // reload, so the deep link is shareable and the back button behaves.
  const goToProfile = (params) => {
    const query = new URLSearchParams(params).toString();
    navigate(`/profile${query ? `?${query}` : ''}`);
  };

  // Sign-out confirmation lives HERE, in the navbar, rather than being reached
  // by navigating to /profile?action=signout and raising a dialog there.
  //
  // That round trip was wrong: picking "Sign out" dragged the user to the
  // profile page just to show a prompt, so the page visibly changed underneath
  // them and cancelling left them somewhere they never asked to go. Signing out
  // is not a navigation, so it must not navigate — the prompt appears in place
  // and only a confirmed sign-out leaves the page.
  const [signOutPending, setSignOutPending] = useState(false);

  const confirmSignOut = async () => {
    setSignOutPending(false);
    // Revoke this account's token server-side and forget it here. This is the
    // same path the profile page used, so behaviour (including the cross-tab
    // "this session is dead" broadcast) is unchanged.
    await signOutCurrentAccount();
    // `replace` so Back cannot return to a page that now needs a session.
    navigate('/login', { replace: true });
  };

  return (
    <nav className="navbar">
      <div className="navbar-left">
        <div className="navbar-logo-box">
          <svg width="30" height="30" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <linearGradient id="nav-logo-grad" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
                <stop stopColor="#34d399"/>
                <stop offset="1" stopColor="#06b6d4"/>
              </linearGradient>
            </defs>
            <rect width="100" height="100" rx="22" fill="url(#nav-logo-grad)"/>
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
            {/* Product navigation lives in the account menu now. It used to be
                three more items in the top bar, which crowded the row on
                phones and left no breathing room around the account pill. The
                routes and icons are still owned here, so the menu stays a
                generic component that renders whatever it is handed. */}
            <ProfileActionsMenu
              displayName={displayName}
              profilePicture={user.profilePicture || ''}
              initials={avatarInitial}
              showLabel
              navItems={navItems}
              onNavigate={(to) => navigate(to)}
              onEditProfile={() => goToProfile({ view: 'personal', edit: '1' })}
              onOpenView={(view) => goToProfile({ view })}
              onSignOut={() => setSignOutPending(true)}
            />
          </>
        ) : (
          // Strictly user-facing: this navbar never offers admin entry —
          // admin and user sessions stay separate, and the admin panel is
          // reached only via its own /admin routes. Route guards still send
          // an admin-holder who opens a protected user route back to /admin.
          <NavLink to="/login" className="navbar-signin-btn">
            Sign In
          </NavLink>
        )}
      </div>

      {/* Rendered as a SIBLING of the menu, not inside its panel: choosing
          "Sign out" closes the panel, and a dialog nested inside the thing
          that just unmounted would disappear with it. */}
      {signOutPending && (
        <ConfirmLogoutModal
          title="Sign out?"
          message="You'll be returned to the sign-in page. Other accounts on this browser stay signed in."
          confirmText="Sign out"
          cancelText="Cancel"
          onConfirm={confirmSignOut}
          onCancel={() => setSignOutPending(false)}
        />
      )}
    </nav>
  );
}

export default Navbar;
