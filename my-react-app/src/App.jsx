import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';

import HomePage from './Pages/HomePage';
import LogIn from './Pages/LogIn';
import SignIn from './Pages/SignIn';
import AssessmentPage from './Pages/AssessmentPage';
import ResultsPage from './Pages/ResultsPage';
import HistoryPage from './Pages/HistoryPage';
import ChatAssistant from './Pages/ChatAssistant';

// Routes where the chat assistant should NOT appear
const CHAT_HIDDEN_ROUTES = ['/login', '/signup'];

function GlobalChat() {
  const location = useLocation();
  if (CHAT_HIDDEN_ROUTES.includes(location.pathname)) return null;
  return <ChatAssistant />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/login" element={<LogIn />} />
        <Route path="/signup" element={<SignIn />} />
        <Route path="/assessment" element={<AssessmentPage />} />
        <Route path="/results" element={<ResultsPage />} />
        <Route path="/history" element={<HistoryPage />} />
      </Routes>
      <GlobalChat />
    </BrowserRouter>
  );
}

export default App;
