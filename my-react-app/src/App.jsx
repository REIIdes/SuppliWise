import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { Component, lazy, Suspense, useEffect, useState } from 'react';

import HomePage from './Pages/HomePage';

// Route-level code splitting — keeps the initial bundle small; each page loads on demand
const DashboardPage = lazy(() => import('./Pages/DashboardPage'));
const RecommendationsPage = lazy(() => import('./Pages/RecommendationsPage'));
const TrackIntakePage = lazy(() => import('./Pages/TrackIntakePage'));
const InsightsPage = lazy(() => import('./Pages/InsightsPage'));
const LogIn = lazy(() => import('./Pages/LogIn'));
const SignIn = lazy(() => import('./Pages/SignIn'));
const AssessmentPage = lazy(() => import('./Pages/AssessmentPage'));
const ResultsPage = lazy(() => import('./Pages/ResultsPage'));
const HistoryPage = lazy(() => import('./Pages/HistoryPage'));
const ProfilePage = lazy(() => import('./Pages/ProfilePage'));
const ChatAssistant = lazy(() => import('./Pages/ChatAssistant'));
const AdminLogin = lazy(() => import('./Pages/AdminLogin'));
const AdminDashboard = lazy(() => import('./Pages/AdminDashboard'));
const AssessmentManagement = lazy(() => import('./Pages/AssessmentManagement'));

// Web3 / blockchain layer (wallet, rewards, marketplace, DAO, verification)
const Web3HubPage = lazy(() => import('./Pages/Web3HubPage'));
const MarketplacePage = lazy(() => import('./Pages/MarketplacePage'));
const GovernancePage = lazy(() => import('./Pages/GovernancePage'));
const Web3PlanGate = lazy(() => import('./Components/Web3PlanGate/Web3PlanGate'));
// Public routes — no session required (QR scan / share links)
const VerifyPage = lazy(() => import('./Pages/VerifyPage'));
const SharePage = lazy(() => import('./Pages/SharePage'));

// Minimal loading fallback for lazy routes
function RouteFallback() {
  return (
    <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280' }}>
      Loading…
    </div>
  );
}

import AdminProtectedRoute from './Components/AdminProtectedRoute';
import SessionRevalidator from './Components/SessionRevalidator';
import useAuth from './hooks/useAuth';
import { useSubscription, resetSubscriptionStore } from './hooks/useSubscription';
import { isAuthTransitionActive, hasAdminSession, hasUserSignedOut } from './auth/authState';
import { getToken, listAccounts, resumeSession } from './api';

// ── Global Error Boundary — prevents white screens ─────────────────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // Log internally — never shown to the user
    console.error('[ErrorBoundary] Uncaught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          background: '#f0faf0', padding: '24px', textAlign: 'center',
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
          <h2 style={{ color: '#111827', marginBottom: '8px' }}>Something went wrong</h2>
          <p style={{ color: '#6b7280', marginBottom: '24px', maxWidth: '400px' }}>
            An unexpected error occurred. Please refresh the page or go back to the home page.
          </p>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={() => window.location.reload()}
              style={{ padding: '10px 20px', background: '#22c55e', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}
            >
              Refresh Page
            </button>
            <button
              onClick={() => { this.setState({ hasError: false }); window.location.href = '/'; }}
              style={{ padding: '10px 20px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}
            >
              Go to Home
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// Routes where the chat assistant should NOT appear
const CHAT_HIDDEN_ROUTES = ['/login', '/signup', '/admin/login', '/admin'];

function isAdminJwt(token) {
  try {
    return token ? JSON.parse(atob(token.split('.')[1])).role === 'admin' : false;
  } catch {
    return false;
  }
}

// Scroll to top component - scrolls to top on route change
function ScrollToTop() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return null;
}

function DocumentTitle() {
  const location = useLocation();

  useEffect(() => {
    if (location.pathname === '/admin/login') {
      document.title = 'SuppliWise Admin';
    } else if (location.pathname === '/admin') {
      document.title = 'SuppliWise Control Panel';
    } else {
      document.title = 'SuppliWise';
    }
  }, [location.pathname]);

  return null;
}

function GlobalChat() {
  const location = useLocation();
  // The assistant is a USER-app feature: never on auth pages and never
  // anywhere in the admin area — the pill must not leak onto /admin/*
  // subpages (the exact-match list below used to let them slip past).
  if (location.pathname.startsWith('/admin') || CHAT_HIDDEN_ROUTES.includes(location.pathname)) return null;
  return (
    <Suspense fallback={null}>
      <ChatAssistant />
    </Suspense>
  );
}

// ── Subscription store lifecycle ─────────────────────────────────────────
// Keeps the reactive entitlement store (SSE push, expiry watch, focus refresh,
// cross-tab relay) alive for EVERY signed-in user session.
//
// This used to be an accident of GlobalChat: ChatAssistant is `lazy()` inside
// <Suspense fallback={null}>, so until that chunk landed — and on any route
// that hides the chat (/login, /signup, /admin) — the store had NO subscriber.
// With no subscriber there was no EventSource, no expiry timer, no polling and
// no window listener, so an admin upgrade/downgrade simply never reached the
// UI until something remounted a gated page. Entitlement sync must not depend
// on an unrelated widget being mounted, so it is anchored here instead.
function SubscriptionSync() {
  const { token } = useAuth();
  const userSession = !!token && !isAdminJwt(token);

  useEffect(() => {
    // Sign-out / account switch: drop the previous session's cached plan,
    // timers and SSE stream. Without this, the next sign-in mounted with the
    // OLD account's plan (still inside the 30s refresh throttle) and the dead
    // stream kept listening for an account that was no longer signed in.
    if (!userSession) resetSubscriptionStore();
  }, [userSession]);

  // Admin sessions are rejected by /auth/me and /subscription/stream (403), so
  // the store never mounts for one — otherwise every poll and reconnect would
  // be a guaranteed-failing request.
  if (!userSession) return null;
  // KEYED BY TOKEN, not by a boolean: an in-place account switch changes the
  // token without changing `userSession`. Without the key the store instance
  // survived the switch, its `[]` mount effect never re-ran, and the new
  // account kept the previous account's plan, SSE stream and refresh throttle.
  return <SubscriptionStoreMount key={token} />;
}

// Separate child so useSubscription() is called unconditionally inside a
// component that only renders while a user session exists (hooks may not be
// skipped by an early return in the parent).
function SubscriptionStoreMount() {
  useSubscription();

  // Registered AFTER useSubscription() so React runs this cleanup last: on
  // sign-out or an account switch the subscriber is detached first, then the
  // store is torn down. Because the element is keyed by token, React runs this
  // old instance's cleanup BEFORE the next session's instance mounts — so one
  // account's state can never be handed to the next.
  useEffect(() => () => resetSubscriptionStore(), []);

  return null;
}

// User session expiry was retired on purpose: user tokens no longer carry an
// idle timer or an `exp`, so a signed-in user is never kicked out for
// inactivity. Sessions now end only by signing out or by a newer sign-in
// revoking the old token (see server/middleware/auth.js sessionVersion).
// The admin area keeps its own idle countdown — that is untouched.

// Protected Route Component - requires authentication
function ProtectedRoute({ children }) {
  // Reactive: re-renders when the session appears/disappears without a reload.
  const { token } = useAuth();
  if (isAdminJwt(token)) return <Navigate to="/admin/login" replace />;
  if (token) return children;
  // No USER token in this tab — two SEPARATE logics decide the destination:
  //   1. This tab just ended a user session (sign-out / revoked / 401):
  //      stay in the USER flow — always back to the Sign In form, even when
  //      an admin session exists in the browser ("after logged out, never
  //      redirect to the admin session"; also keeps Back from bouncing to
  //      /admin).
  //   2. No user history here and an active ADMIN session: the admin panel —
  //      an admin browsing user routes must never see the user login (the
  //      original "logged in as admin, the session goes to User login" fix,
  //      still fully working for admin-only tabs).
  if (!hasUserSignedOut() && hasAdminSession()) return <Navigate to="/admin" replace />;
  return <Navigate to="/login" replace />;
}

// Public-only Route - logged-in users never see login/signup forms again.
// This fixes the bug where /login rendered the Sign In card while the
// navbar already showed a logged-in user.
// Exception: /login?add=1 — "Add another account" from Profile → Accounts
// must reach the form even while an account is already active.
//
// Deliberately does NOT consult the admin session: arriving at /login is an
// explicit intent (a user just signed out, a session ended, or the URL was
// typed), and hijacking it to /admin broke sign-out — "I pressed sign out and
// the admin session took over, Back went to admin too". Admins are kept off
// this screen on the way IN (ProtectedRoute routes admin-only browsers to
// /admin) and the user navbar staying strictly user-facing — it always shows
// "Sign In", never an admin shortcut — never by a bounce FROM the form itself.
function PublicOnlyRoute({ children }) {
  const location = useLocation();
  const addingAccount = new URLSearchParams(location.search).get('add') === '1';
  const { token } = useAuth();
  if (isAdminJwt(token)) return <Navigate to="/admin" replace />;
  // While a sign-in is still completing (token written, destination pending)
  // stay on the form — the login/signup flow navigates itself when ready.
  if (isAuthTransitionActive()) return children;
  if (token && !addingAccount) return <Navigate to="/dashboard" replace />;
  return children;
}

// Landing Route Component - shows HomePage for non-logged users, Dashboard for logged users
function LandingRoute() {
  const { token } = useAuth();
  if (isAdminJwt(token)) return <Navigate to="/admin" replace />;
  return token ? <Navigate to="/dashboard" replace /> : <HomePage />;
}

function App() {
  // ── Session bootstrap gate ───────────────────────────────────────────────
  // A brand-new tab starts with no sessionStorage of its own. Before any
  // route guard renders (and possibly bounces to /login), give open tabs a
  // brief window to hand this tab a session via BroadcastChannel resume.
  // First-time visitors (no known accounts) skip the wait entirely.
  const [sessionReady, setSessionReady] = useState(() => !!getToken() || listAccounts().length === 0);

  useEffect(() => {
    if (sessionReady) return undefined;
    let cancelled = false;
    resumeSession().finally(() => {
      if (!cancelled) setSessionReady(true);
    });
    return () => { cancelled = true; };
  }, [sessionReady]);

  // ── Password-field hardening ─────────────────────────────
  // Password values must never be selectable, copyable, cuttable,
  // pasteable or draggable, and any selection is collapsed the
  // moment the field receives focus. Otherwise a clipboard
  // snapshot or a shoulder-surfing pass can recover a credential.
  useEffect(() => {
    const isPasswordInput = (el) =>
      el instanceof HTMLInputElement && el.type === 'password';
    const block = (e) => {
      if (isPasswordInput(e.target)) e.preventDefault();
    };
    ['copy', 'cut', 'paste', 'contextmenu', 'dragstart', 'select'].forEach(
      (event) => document.addEventListener(event, block, true)
    );
    return () => {
      ['copy', 'cut', 'paste', 'contextmenu', 'dragstart', 'select'].forEach(
        (event) => document.removeEventListener(event, block, true)
      );
    };
  }, []);

  if (!sessionReady) return <RouteFallback />;

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ScrollToTop />
        <DocumentTitle />
        <SessionRevalidator />
        <SubscriptionSync />
        <Suspense fallback={<RouteFallback />}>
        <Routes>
          {/* Landing route - shows HomePage for guests, redirects to Dashboard for logged-in users */}
          <Route path="/" element={<LandingRoute />} />
          
          {/* Dashboard - only accessible to logged-in users */}
          <Route path="/dashboard" element={<ProtectedRoute><DashboardPage /></ProtectedRoute>} />
          
          {/* Recommendations - only accessible to logged-in users */}
          <Route path="/recommendations" element={<ProtectedRoute><RecommendationsPage /></ProtectedRoute>} />
          
          {/* Track Intake - only accessible to logged-in users */}
          <Route path="/track-intake" element={<ProtectedRoute><TrackIntakePage /></ProtectedRoute>} />
          
          {/* Insights - only accessible to logged-in users */}
          <Route path="/insights" element={<ProtectedRoute><InsightsPage /></ProtectedRoute>} />
          
          {/* Auth routes - logged-in users are sent to the dashboard instead */}
          <Route path="/login" element={<PublicOnlyRoute><LogIn /></PublicOnlyRoute>} />
          <Route path="/signup" element={<PublicOnlyRoute><SignIn /></PublicOnlyRoute>} />
          <Route path="/admin/login" element={<AdminLogin />} />
          
          {/* Admin routes - protected */}
          <Route element={<AdminProtectedRoute />}>
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/admin/assessment-management" element={<AssessmentManagement />} />
          </Route>
          
          {/* Protected routes - require authentication */}
          <Route path="/assessment" element={<ProtectedRoute><AssessmentPage /></ProtectedRoute>} />
          <Route path="/results" element={<ProtectedRoute><ResultsPage /></ProtectedRoute>} />
          <Route path="/history" element={<ProtectedRoute><HistoryPage /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />

          {/* Web3 layer - requires a user session AND the ULTIMATE plan.
              The gate renders instead of the page (not over it), so a
              sub-tier user never triggers the panels' mount-time fetches.
              /verify and /share stay public below: a consumer scanning a
              bottle has no account and no plan. */}
          <Route path="/web3" element={<ProtectedRoute><Web3PlanGate area="web3"><Web3HubPage /></Web3PlanGate></ProtectedRoute>} />
          <Route path="/marketplace" element={<ProtectedRoute><Web3PlanGate area="market"><MarketplacePage /></Web3PlanGate></ProtectedRoute>} />
          <Route path="/governance" element={<ProtectedRoute><Web3PlanGate area="dao"><GovernancePage /></Web3PlanGate></ProtectedRoute>} />

          {/* Public verification & sharing - deliberately OUTSIDE ProtectedRoute:
              a consumer scanning a bottle QR or a clinician opening a share
              link must never be bounced to /login. */}
          <Route path="/verify" element={<VerifyPage />} />
          <Route path="/verify/:code" element={<VerifyPage />} />
          <Route path="/share/:token" element={<SharePage />} />
        </Routes>
        </Suspense>
        <GlobalChat />
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;