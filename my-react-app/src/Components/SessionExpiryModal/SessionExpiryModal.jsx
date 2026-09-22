import React from 'react';
import './SessionExpiryModal.css';

const SessionExpiryModal = ({ remainingTime, onStayLoggedIn, onLogout }) => {
  const formatTime = (seconds) => {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
  };

  return (
    <div className="session-expiry-modal-overlay">
      <div className="session-expiry-modal">
        <h2>Session Expiry Warning</h2>
        <p>Your session is about to expire due to inactivity. You will be logged out in:</p>
        <div className="session-expiry-timer">{formatTime(remainingTime)}</div>
        <div className="session-expiry-actions">
          <button onClick={onStayLoggedIn} className="btn-stay-logged-in">Stay Logged In</button>
          <button onClick={onLogout} className="btn-logout">Log Out</button>
        </div>
      </div>
    </div>
  );
};

export default SessionExpiryModal;