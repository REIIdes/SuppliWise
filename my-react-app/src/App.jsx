import { BrowserRouter, Routes, Route, useLocation, useNavigate, Navigate } from 'react-router-dom';
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
const USER_IDLE_LIMIT_SECONDS = 5 * 60;
const USER_IDLE_WARNING_SECONDS = 60;
const USER_ACTIVITY_KEY = 'suppliwise_user_last_activity';

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
  if (CHAT_HIDDEN_ROUTES.includes(location.pathname)) return null;
  return (
    <Suspense fallback={null}>
      <ChatAssistant />
    </Suspense>
  );
}

function UserSessionGuard() {
  const navigate = useNavigate();
  const location = useLocation();
  const [remainingSeconds, setRemainingSeconds] = useState(null);

  useEffect(() => {
    const token = localStorage.getItem('token');
    const isAuthRoute = location.pathname === '/login' || location.pathname === '/signup' || location.pathname.startsWith('/admin');
    if (!token || isAdminJwt(token) || isAuthRoute) {
      return undefined;
    }

    const writeActivity = () => {
      localStorage.setItem(USER_ACTIVITY_KEY, String(Date.now()));
    };
    const activityEvents = ['keydown', 'mousedown', 'mousemove', 'scroll', 'touchstart', 'pointerdown', 'focus'];
    const handleActivity = () => writeActivity();
    const storedActivity = Number(localStorage.getItem(USER_ACTIVITY_KEY));
    if (!Number.isFinite(storedActivity) || storedActivity <= 0) writeActivity();
    const initialStateTimer = window.setTimeout(() => setRemainingSeconds(USER_IDLE_LIMIT_SECONDS), 0);

    const timer = window.setInterval(() => {
      const lastActivity = Number(localStorage.getItem(USER_ACTIVITY_KEY));
      const remaining = Math.max(0, Math.ceil((lastActivity + USER_IDLE_LIMIT_SECONDS * 1000 - Date.now()) / 1000));
      setRemainingSeconds(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem(USER_ACTIVITY_KEY);
        navigate('/login', { replace: true, state: { sessionExpired: true } });
      }
    }, 1000);

    activityEvents.forEach(eventName => window.addEventListener(eventName, handleActivity, { passive: true }));
    return () => {
      window.clearTimeout(initialStateTimer);
      window.clearInterval(timer);
      activityEvents.forEach(eventName => window.removeEventListener(eventName, handleActivity));
    };
  }, [location.pathname, navigate]);

  const currentToken = localStorage.getItem('token');
  const sessionIsVisible = currentToken && !isAdminJwt(currentToken) && !location.pathname.startsWith('/admin') && location.pathname !== '/login' && location.pathname !== '/signup';
  if (!sessionIsVisible || remainingSeconds === null || remainingSeconds > USER_IDLE_WARNING_SECONDS) return null;
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = String(remainingSeconds % 60).padStart(2, '0');
  return <div className="user-session-warning" role="status" aria-live="polite">Your session will expire in {minutes}:{seconds} due to inactivity. Move or focus on the page to stay signed in.</div>;
}

// Protected Route Component - requires authentication
function ProtectedRoute({ children }) {
  const token = localStorage.getItem('token');
  if (isAdminJwt(token)) return <Navigate to="/admin/login" replace />;
  return token ? children : <Navigate to="/login" replace />;
}

// Landing Route Component - shows HomePage for non-logged users, Dashboard for logged users
function LandingRoute() {
  const token = localStorage.getItem('token');
  return token ? <Navigate to="/dashboard" replace /> : <HomePage />;
}

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <ScrollToTop />
        <DocumentTitle />
        <UserSessionGuard />
        <SessionRevalidator />
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
          
          {/* Auth routes */}
          <Route path="/login" element={<LogIn />} />
          <Route path="/signup" element={<SignIn />} />
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
        </Routes>
        </Suspense>
        <GlobalChat />
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;