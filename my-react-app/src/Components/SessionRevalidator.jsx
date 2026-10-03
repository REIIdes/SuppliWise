import { useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

const SessionRevalidator = () => {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;

      // Only enforce the admin session check when the user is already
      // inside the admin area (/admin/*). Regular user pages must never
      // be affected by the presence or absence of an adminToken.
      if (!location.pathname.startsWith('/admin')) return;

      // Skip the check on the login page itself — it handles its own redirect.
      if (location.pathname === '/admin/login') return;

      const token = localStorage.getItem('adminToken');
      if (!token) {
        navigate('/admin/login', { replace: true });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [navigate, location.pathname]);

  return null;
};

export default SessionRevalidator;
