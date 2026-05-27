import { NavLink, useNavigate } from 'react-router-dom';
import './Navbar.css';

function Navbar() {
  const navigate = useNavigate();
  const token = localStorage.getItem('token');
  const userRaw = localStorage.getItem('user');
  const user = userRaw ? JSON.parse(userRaw) : null;

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    sessionStorage.removeItem('pending_assessment'); // clear any pending assessment on logout
    navigate('/login');
  };

  return (
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
        <NavLink to="/" className="navbar-brand">SuppliWise</NavLink>
      </div>
      <div className="navbar-right">
        {token && user ? (
          <>
            <NavLink to="/history" className="navbar-history-link" title="History">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </NavLink>
            <div className="navbar-profile">
              <div className="navbar-avatar">{user.name.charAt(0).toUpperCase()}</div>
              <span className="navbar-username">{user.name}</span>
            </div>
            <button className="navbar-signin-btn" onClick={handleLogout}>
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
  );
}

export default Navbar;
