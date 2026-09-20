import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const SessionRevalidator = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const token = localStorage.getItem('adminToken');
        if (!token) {
          navigate('/admin/login', { replace: true });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [navigate]);

  return null;
};

export default SessionRevalidator;