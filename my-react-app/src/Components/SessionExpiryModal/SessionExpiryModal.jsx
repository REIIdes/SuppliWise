import './SessionExpiryModal.css';

const SessionExpiryModal = ({ remainingTime, expired = false, notice = '', onStayLoggedIn, onLogout }) => {
  const formatTime = (seconds) => {
    const safe = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(safe / 60);
    const secs = safe % 60;
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div className="session-expiry-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="session-expiry-title">
      <div className="session-expiry-modal">
        <div className="session-expiry-icon" aria-hidden="true">⏳</div>
        <h2 id="session-expiry-title">{expired ? 'Session Expired' : 'Session Expiry Warning'}</h2>
        <p>
          {expired
            ? 'Your admin session ended after 3 minutes 30 seconds of inactivity. Redirecting you to sign in…'
            : 'You have been idle. For security your admin session ends after 3:30 of inactivity. Stay signed in to keep working:'}
        </p>
        {!expired && <div className="session-expiry-timer" aria-live="polite">{formatTime(remainingTime)}</div>}
        <div className="session-expiry-progress" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, (remainingTime / 210) * 100))}%` }} />
        </div>
        {notice && <p className="session-expiry-notice" role="status">{notice}</p>}
        <div className="session-expiry-actions">
          {!expired && <button type="button" onClick={onStayLoggedIn} className="btn-stay-logged-in">Stay Signed In</button>}
          <button type="button" onClick={onLogout} className="btn-logout">{expired ? 'Sign In Again' : 'Log Out'}</button>
        </div>
      </div>
    </div>
  );
};

export default SessionExpiryModal;