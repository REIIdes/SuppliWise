import { useEffect, useReducer } from 'react';
import { AUTH_CHANGED_EVENT, readAuthSnapshot } from '../auth/authState';

// Reactive view of THIS TAB's session (token + user profile).
//
// Freshly reads the tab-scoped storage on every render (so direct profile
// writes by profile/plan edits are picked up whenever anything re-renders),
// and force-re-renders when any code calls emitAuthChanged() — login,
// logout, account switch, resume handoff, 401 teardown (all in api.js /
// auth flows).
//
// Deliberately does NOT listen to cross-tab `storage` events: sessions are
// per-tab by design (Tab 1 = Account A, Tab 2 = Account B), so another tab
// signing in, switching or out must never repaint this tab's auth state.
//
// Route guards and the navbar must use this instead of reading storage
// without subscriptions, otherwise they show stale auth state after
// sign-in/out without a full page reload — which is exactly how the login
// page ended up rendering the Sign In form under a logged-in navbar.
export default function useAuth() {
  const [, forceRender] = useReducer((n) => n + 1, 0);

  useEffect(() => {
    const onAuthChanged = () => forceRender();
    window.addEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
    return () => window.removeEventListener(AUTH_CHANGED_EVENT, onAuthChanged);
  }, []);

  return readAuthSnapshot();
}
