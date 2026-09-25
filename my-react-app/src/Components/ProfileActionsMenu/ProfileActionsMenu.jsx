/**
 * ProfileActionsMenu — the account quick-actions menu for the member profile.
 *
 * Modelled on the admin console's account menu (AdminTopbar), but adapted
 * rather than copied, because the two live in very different contexts:
 *
 *   • The admin menu is dark to match the dark topbar. This one is LIGHT, so
 *     it uses the same emerald/teal/indigo tokens as the rest of the profile
 *     page. Copying the dark palette would drop a near-black panel onto a
 *     white card.
 *   • The AVATAR is the trigger, not a separate "Menu" pill. The identity card
 *     directly above already shows the name, so a labelled button beside it
 *     was pure duplication — and repeating the avatar inside the panel showed
 *     the same picture twice within one glance. The panel now lists actions
 *     only; the trigger is the single place the avatar appears.
 *   • The admin menu closes on outside-click and Escape. This one also takes
 *     full keyboard control (ArrowUp/ArrowDown/Home/End), because a menu with
 *     no roving focus is a dead end for anyone not using a mouse — Tab walks
 *     out of the panel and the menu closes underneath them.
 *   • Escape returns focus to the trigger. Without that, focus is dropped on
 *     <body> and keyboard users lose their place entirely.
 *
 * The menu is rendered inline (not portalled) and anchored to the trigger, so
 * it inherits the page's stacking context and needs no positioning library.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import ProfileAvatarImage from '../ProfileAvatar/ProfileAvatarImage';
import './ProfileActionsMenu.css';

const ICONS = {
  edit: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  ),
  shield: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 11 14 15 10" />
    </svg>
  ),
  person: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </svg>
  ),
  accounts: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9.5" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  signout: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  ),
};

export default function ProfileActionsMenu({
  displayName = 'Your account',
  profilePicture = '',
  initials = '',
  showLabel = false,
  navItems = [],
  onNavigate,
  onEditProfile,
  onOpenView,
  onSignOut,
  editLabel = 'Edit Profile',
  personalLabel = 'Personal Info',
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const itemRefs = useRef([]);
  const menuId = useId();

  // Grouped so the panel reads as three distinct jobs rather than one long
  // undifferentiated list:
  //   Explore  — where you can go in the product
  //   Account  — things you can change about yourself
  //   (destructive sign-out sits alone at the end, always separated)
  //
  // `navItems` comes from the Navbar so the routes and their gating stay owned
  // by the place that already decides what this user may see. Passing bare
  // hrefs here would have duplicated that decision.
  const items = [
    ...navItems.map((n) => ({
      key: n.key,
      label: n.label,
      // A locked item keeps its real destination but advertises the plan it
      // needs, so a sub-tier user can still see the feature exists and route
      // into the upgrade card instead of finding the entry silently missing.
      hint: n.locked ? (n.lockedHint || 'ULTIMATE plan') : n.hint,
      icon: n.icon,
      tone: n.tone,
      locked: n.locked,
      group: n.group || 'Explore',
      onSelect: () => onNavigate?.(n.to),
    })),
    {
      key: 'personal',
      label: personalLabel,
      hint: 'Name, email & date of birth',
      icon: ICONS.person,
      tone: 'personal',
      group: 'Account',
      onSelect: () => onOpenView?.('personal'),
    },
    {
      key: 'edit',
      label: editLabel,
      hint: 'Change picture, banner & details',
      icon: ICONS.edit,
      accent: true,
      group: 'Account',
      onSelect: () => onEditProfile?.(),
    },
    {
      key: 'security',
      label: 'Account Security',
      hint: 'Password, 2FA & recovery codes',
      icon: ICONS.shield,
      tone: 'security',
      group: 'Account',
      onSelect: () => onOpenView?.('security'),
    },
    {
      key: 'accounts',
      label: 'Accounts',
      hint: 'Switch, add or sign out another account',
      icon: ICONS.accounts,
      tone: 'accounts',
      group: 'Account',
      onSelect: () => onOpenView?.('accounts'),
    },
    {
      key: 'signout',
      label: 'Sign out',
      hint: 'End this session',
      icon: ICONS.signout,
      danger: true,
      separated: true,
      group: null,
      onSelect: () => onSignOut?.(),
    },
  ];

  const close = useCallback(({ restoreFocus = false } = {}) => {
    setOpen(false);
    setActiveIndex(-1);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Outside click + Escape. The trigger and the panel are separate nodes, so
  // containment is checked against the wrapper, not the button.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event) => {
      if (!rootRef.current?.contains(event.target)) close();
    };
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close({ restoreFocus: true });
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Move DOM focus with the roving index so screen readers announce the item.
  useEffect(() => {
    if (!open) return;
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.focus();
  }, [open, activeIndex]);

  const openMenu = (startIndex) => {
    setOpen(true);
    setActiveIndex(startIndex);
  };

  // On open, focus moves INTO the panel. Without this, a click-opened menu
  // left focus on the trigger, and because the trigger is not a descendant of
  // the panel the arrow keys never reached the panel's handler — so the menu
  // was mouse-only until the user happened to Tab. Matches the WAI-ARIA menu
  // button pattern: click/ArrowDown enter at the first item, ArrowUp at the last.
  const openAtStart = () => openMenu(0);
  const openAtEnd = () => openMenu(items.length - 1);

  const onMenuKeyDown = (event) => {
    const last = items.length - 1;
    let next = null;
    if (event.key === 'ArrowDown') next = activeIndex >= last ? 0 : activeIndex + 1;
    else if (event.key === 'ArrowUp') next = activeIndex <= 0 ? last : activeIndex - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    else if (event.key === 'Tab') {
      // Tabbing out should dismiss rather than leave an orphaned open panel.
      close();
      return;
    }
    if (next !== null) {
      event.preventDefault();
      setActiveIndex(next);
    }
  };

  // Run an item's action, then dismiss. `restoreFocus` keeps the keyboard
  // context intact for actions that do NOT move focus themselves (the sign-out
  // confirm dialog does; a scroll does not).
  const run = (item, restoreFocus) => {
    close({ restoreFocus });
    item.onSelect?.();
  };

  return (
    <div className={`pam${showLabel ? ' pam--pill' : ''}`} ref={rootRef}>
      {/* Icon-only by default, so it carries an explicit label — there is no
          visible text for a screen reader to announce. With `showLabel` the
          name is rendered, and the accessible name still comes from the label
          so it never duplicates or drifts from what is on screen. */}
      <button
        ref={triggerRef}
        type="button"
        className={`pam-trigger${open ? ' is-open' : ''}`}
        aria-label={`Menu for ${displayName}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close() : openAtStart())}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            if (event.key === 'ArrowDown') openAtStart();
            else openAtEnd();
          }
        }}
      >
        <span className="pam-trigger__avatar" aria-hidden="true">
          <ProfileAvatarImage
            src={profilePicture}
            name={initials || displayName}
            className="pam-trigger__img"
          />
        </span>
        {showLabel && <span className="pam-trigger__label">{displayName}</span>}
        <span className="pam-trigger__chev" aria-hidden="true">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          className="pam-panel"
          id={menuId}
          role="menu"
          aria-label="Menu"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item, index) => {
            // A label whenever the group CHANGES, not on every item — otherwise
            // "Account" would repeat four times down the panel.
            const prevGroup = index > 0 ? items[index - 1].group : undefined;
            const showGroup = item.group && item.group !== prevGroup;
            return (
              // role="presentation" removes the wrapper from the accessibility
              // tree, so each menuitem stays a DIRECT child of role="menu" as the
              // ARIA pattern requires. A plain div in between is legal HTML but it
              // turns the menu into menu > generic > menuitem, which breaks
              // assistive-tech menu navigation and aria-activedescendant.
              <div key={item.key} className="pam-slot" role="presentation">
                {item.separated && <span className="pam-sep" aria-hidden="true" />}
                {showGroup && (
                  <span className="pam-group" aria-hidden="true">{item.group}</span>
                )}
                <button
                  ref={(node) => { itemRefs.current[index] = node; }}
                  type="button"
                  role="menuitem"
                  tabIndex={activeIndex === index ? 0 : -1}
                  className={[
                    'pam-item',
                    item.danger ? 'pam-item--danger' : '',
                    item.accent ? 'pam-item--accent' : '',
                    item.locked ? 'pam-item--locked' : '',
                    item.tone ? `pam-item--${item.tone}` : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => run(item, false)}
                >
                  <span className="pam-item__icon" aria-hidden="true">{item.icon}</span>
                  <span className="pam-item__text">
                    <strong>{item.label}</strong>
                    <em>{item.hint}</em>
                  </span>
                  {item.locked && (
                    <span className="pam-item__lock" aria-label="Requires the DELUXE plan">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <rect x="4" y="10.5" width="16" height="10.5" rx="2" />
                        <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
                      </svg>
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
