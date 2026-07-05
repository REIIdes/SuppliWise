import { BrowserRouter, Routes, Route, useLocation, Navigate } from 'react-router-dom';
import { Component, useEffect } from 'react';

import HomePage from './Pages/HomePage';
import DashboardPage from './Pages/DashboardPage';
import RecommendationsPage from './Pages/RecommendationsPage';
import TrackIntakePage from './Pages/TrackIntakePage';
import InsightsPage from './Pages/InsightsPage';
import LogIn from './Pages/LogIn';
import SignIn from './Pages/SignIn';
import AssessmentPage from './Pages/AssessmentPage';
import ResultsPage from './Pages/ResultsPage';
import HistoryPage from './Pages/HistoryPage';
import ProfilePage from './Pages/ProfilePage';
import ChatAssistant from './Pages/ChatAssistant';
import PWAInstallPrompt from './components/PWAInstallPrompt';

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
const CHAT_HIDDEN_ROUTES = ['/login', '/signup'];

// Scroll to top component - scrolls to top on route change
function ScrollToTop() {
  const location = useLocation();

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);

  return null;
}

function GlobalChat() {
  const location = useLocation();
  if (CHAT_HIDDEN_ROUTES.includes(location.pathname)) return null;
  return <ChatAssistant />;
}

// Protected Route Component - requires authentication
function ProtectedRoute({ children }) {
  const token = localStorage.getItem('token');
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
          
          {/* Protected routes - require authentication */}
          <Route path="/assessment" element={<ProtectedRoute><AssessmentPage /></ProtectedRoute>} />
          <Route path="/results" element={<ProtectedRoute><ResultsPage /></ProtectedRoute>} />
          <Route path="/history" element={<ProtectedRoute><HistoryPage /></ProtectedRoute>} />
          <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
        </Routes>
        <GlobalChat />
        <PWAInstallPrompt />
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
