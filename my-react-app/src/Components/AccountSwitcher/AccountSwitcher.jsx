import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import { listAccounts, getActiveAccountId, switchAccount, signOutAccount } from '../../api';
import { AUTH_CHANGED_EVENT, DIRECTORY_KEY } from '../../auth/authState';
import './AccountSwitcher.css';

// Full navigation with history REPLACE: every call here runs right after a
// session change (switch / sign-out), so the page it replaces must not stay
// in history — otherwise Back re-opens that dead session's page, the guards
// see no user token, and an admin-holder gets bounced straight back to
// /admin (the "sign out → admin, Back → admin" trap).
const goTo = (path) => {
  window.location.replace(path);
};

// Short label for an account: real name when known, otherwise its email.
const displayNameOf = (account) => {
  // The active account ships its full profile; the other accounts are
  // directory metadata only (their profile lives with the tab holding them).
  const profile = account.profile || {};
  const full = profile.firstName && profile.lastName
    ? `${profile.firstName} ${profile.lastName}`
    : (profile.name || account.name);
  return (full || account.email || 'Account').trim();
};

const initialOf = (account) => {
  const profile = account.profile || {};
  return (profile.firstName?.charAt(0) || profile.name?.charAt(0) || account.name?.charAt(0) || account.email?.charAt(0) || 'A').toUpperCase();
};

const avatarStyle = (profile) => (profile?.profilePicture
  ? { backgroundImage: `url(${profile.profilePicture})`, backgroundSize: 'cover', backgroundPosition: 'center' }
  : {});

// Account management for one browser: shows every account signed in here and
// flips between them instantly — each account owns its own session, so
// switching never overwrites (or logs out) the others.
//
// Rendered INLINE inside the Profile page's "Accounts" section (it used to be
// a navbar dropdown; that placement put an openable menu right over the Sign
// In form and is now Profile-only). A flat list has no popup positioning,
// clipping or z-index bugs — rows simply flow in the page.
function AccountSwitcher() {
  const [accounts, setAccounts] = useState(() => listAccounts());
  const [busyId, setBusyId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  // Stay live: in-tab session changes (emitAuthChanged) and another tab
  // adding/forgetting an account (the shared directory's storage event) both
  // re-read the list — so the panel can never show an account that is already
  // gone, or miss one that just signed in from a sibling tab.
  useEffect(() => {
    const refresh = () => setAccounts(listAccounts());
    const onStorage = (event) => {
      if (!event.key || event.key === DIRECTORY_KEY) refresh();
    };
    window.addEventListener(AUTH_CHANGED_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(AUTH_CHANGED_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const activeId = getActiveAccountId();
  const busy = busyId !== null;

  const handleSwitch = async (account) => {
    if (busy || account.id === activeId) return;
    setConfirmId(null);
    setBusyId(account.id);
    try {
      // The session is handed over by whichever open tab still holds it
      // (BroadcastChannel) — never read from shared storage. When no open tab
      // can hand one over, fall back to a fresh sign-in for exactly that
      // account, with its email prefilled so the form opens on the right
      // identity instead of a blank one.
      if (await switchAccount(account.id)) {
        // Full navigation: nothing from this tab's previous account survives.
        goTo('/dashboard');
      } else {
        const emailParam = account.email ? `&email=${encodeURIComponent(account.email)}` : '';
        goTo(`/login?add=1${emailParam}`);
      }
    } catch {
      // Unexpected failure: re-enable the row so the user can simply retry.
    } finally {
      setBusyId(null);
    }
  };

  const handleSignOut = async (account) => {
    // Captured at click time: signOutAccount clears the tab session, so
    // re-reading the active id AFTER the await would always look like
    // "not current" and strand the user without a destination.
    const wasCurrent = account.id === activeId;
    setBusyId(account.id);
    try {
      // Revokes ONLY this account's session server-side (other accounts and
      // other tabs keep theirs) and forgets it in the directory.
      await signOutAccount(account.id);
      const remaining = listAccounts();
      setAccounts(remaining);
      if (wasCurrent) {
        // The active account just signed out — adopt another stored account
        // (handed over by the tab that holds it) when possible, otherwise
        // land on the login screen. Route guards agree with these targets,
        // so unmounting mid-handler can't strand the user.
        const resumed = remaining.length ? await switchAccount(remaining[0].id) : false;
        goTo(resumed ? '/dashboard' : '/login');
      }
    } catch {
      setAccounts(listAccounts()); // resync whatever actually landed
    } finally {
      setBusyId(null);
    }
  };

  // Two-step sign-out: the first click arms the row ("Confirm?"), the second
  // executes. Signing out ends that account's session everywhere, so it must
  // never fire from one mis-click — the Profile page's own logout is confirmed
  // the same way.
  const onSignOutClick = (event, account) => {
    event.stopPropagation();
    if (busy) return;
    if (confirmId !== account.id) {
      setConfirmId(account.id);
      return;
    }
    setConfirmId(null);
    handleSignOut(account);
  };

  // Row-level activation (mouse + keyboard). Inner buttons must keep their
  // own keys: the guard makes Space/Enter on "Switch"/"Sign out" fall through
  // to the button's native click instead of being hijacked by the row.
  const activateRow = (account) => {
    if (confirmId) {
      setConfirmId(null); // clicking away disarms a pending confirm
      return;
    }
    if (!busy && account.id !== activeId) handleSwitch(account);
  };

  if (!accounts.length) return null;

  return (
    <div className="acct-panel" aria-busy={busy ? 'true' : undefined}>
      <div className="acct-switcher__title">Signed-in accounts</div>

      {accounts.map((account) => {
        const isCurrent = account.id === activeId;
        const isBusyRow = busyId === account.id;
        const locked = busy && !isBusyRow;
        const isArmed = confirmId === account.id;
        const name = displayNameOf(account);
        return (
          <div
            key={account.id}
            className={`acct-row${isCurrent ? ' is-active' : ''}${locked ? ' is-locked' : ''}`}
            role="button"
            tabIndex={0}
            aria-label={isCurrent ? `${name} (current)` : `Switch to ${name}`}
            aria-current={isCurrent ? 'true' : undefined}
            onClick={() => activateRow(account)}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return; // buttons own their keys
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                activateRow(account);
              }
            }}
          >
            <span className="acct-avatar acct-avatar--row" style={avatarStyle(account.profile)}>
              {!account.profile?.profilePicture && initialOf(account)}
            </span>
            <span className="acct-row__text">
              <span className="acct-row__name">
                {name}
                {isCurrent && <span className="acct-row__badge">Current</span>}
              </span>
              <span className="acct-row__email">{account.email || 'Signed in'}</span>
            </span>
            <span className="acct-row__actions">
              {!isCurrent && (
                <button
                  type="button"
                  className="acct-row__switch"
                  title={`Switch to ${name}`}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    handleSwitch(account);
                  }}
                >
                  {isBusyRow ? '…' : 'Switch'}
                </button>
              )}
              <button
                type="button"
                className={`acct-row__signout${isArmed ? ' is-confirm' : ''}`}
                title={isArmed ? `Click again to sign out of ${name}` : `Sign out of ${name}`}
                disabled={busy}
                onClick={(event) => onSignOutClick(event, account)}
              >
                {isBusyRow ? '…' : (isArmed ? 'Confirm?' : 'Sign out')}
              </button>
            </span>
          </div>
        );
      })}

      <NavLink to="/login?add=1" className="acct-switcher__add">
        + Add another account
      </NavLink>
    </div>
  );
}

export default AccountSwitcher;
