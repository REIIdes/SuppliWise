import { NavLink, useNavigate } from 'react-router-dom';
import { useState } from 'react';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import './Navbar.css';

function Navbar() {
  const navigate = useNavigate();
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const token = localStorage.getItem('token');
  const userRaw = localStorage.getItem('user');
  const user = userRaw ? JSON.parse(userRaw) : null;

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sessionStorage.removeItem('pending_assessment'); // clear any pending assessment on logout
    navigate('/login');
  };

  const handleLogoutClick = () => {
    setShowLogoutConfirm(true);
  };

  const confirmLogout = () => {
    setShowLogoutConfirm(false);
    handleLogout();
  };

  return (
    <>
      {showLogoutConfirm && (
        <ConfirmModal
          title="Confirm Logout"
          message="Are you sure you want to log out?"
          confirmText="Log Out"
          cancelText="Cancel"
          type="warning"
          onConfirm={confirmLogout}
          onCancel={() => setShowLogoutConfirm(false)}
        />
      )}
      
      <nav className="navbar">
      <div className="navbar-left">
        <div className="navbar-logo-box">
          <svg width="30" height="30" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="100" height="100" rx="22" fill="#3dbf8a"/>
            <g transform="rotate(-40, 50, 50)">
              <rect x="22" y="36" width="56" height="28" rx="14" fill="none" stroke="white" strokeWidth="6"/>
              <line x1="50" y1="36" x2="50" y2="64" stroke="white" strokeWidth="6"/>
            </g>
          </svg>
        </div>
        <NavLink to={token ? "/dashboard" : "/"} className="navbar-brand">SuppliWise</NavLink>
      </div>
      <div className="navbar-right">
        {token && user ? (
          <>
            <NavLink to="/history" className="navbar-nav-link" title="History">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </NavLink>
            <NavLink to="/profile" className="navbar-profile-link" title="Profile Settings">
              <div 
                className="navbar-avatar"
                style={{
                  backgroundImage: user.profilePicture ? `url(${user.profilePicture})` : 'none',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                }}
              >
                {!user.profilePicture && (user.firstName ? user.firstName.charAt(0).toUpperCase() : user.name.charAt(0).toUpperCase())}
              </div>
              <span className="navbar-username">
                {user.firstName && user.lastName 
                  ? `${user.firstName} ${user.lastName}` 
                  : user.name}
              </span>
            </NavLink>
            <button className="navbar-signin-btn" onClick={handleLogoutClick}>
              Log Out
            </button>
          </>
        ) : (
          <NavLink to="/login" className="navbar-signin-btn">
            Sign In
          </NavLink>
        )}
      </div>
    </nav>
    </>
  );
}

export default Navbar;
