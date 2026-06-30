import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { Component } from 'react';

import HomePage from './Pages/HomePage';
import LogIn from './Pages/LogIn';
import SignIn from './Pages/SignIn';
import AssessmentPage from './Pages/AssessmentPage';
import ResultsPage from './Pages/ResultsPage';
import HistoryPage from './Pages/HistoryPage';
import ProfilePage from './Pages/ProfilePage';
import ChatAssistant from './Pages/ChatAssistant';

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

function GlobalChat() {
  const location = useLocation();
  if (CHAT_HIDDEN_ROUTES.includes(location.pathname)) return null;
  return <ChatAssistant />;
}

function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/login" element={<LogIn />} />
          <Route path="/signup" element={<SignIn />} />
          <Route path="/assessment" element={<AssessmentPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/profile" element={<ProfilePage />} />
        </Routes>
        <GlobalChat />
      </BrowserRouter>
    </ErrorBoundary>
  );
}

export default App;
