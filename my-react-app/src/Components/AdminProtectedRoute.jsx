import { Navigate, Outlet, useLocation } from 'react-router-dom';

const CHANGE_PASSWORD_PATH = '/admin/change-password';

const AdminProtectedRoute = () => {
  const token = localStorage.getItem('adminToken');
  const location = useLocation();

  if (!token) {
    // If no token, redirect to the admin login page
    return <Navigate to="/admin/login" replace />;
  }

  // An account still on its temporary password is sent to the change screen
  // before it can reach anything else. `replace` so the dashboard is not left
  // in history — going "back" would otherwise bounce straight forward again.
  //
  // This reads the flag cached at sign-in, so it is a fast client-side redirect
  // rather than a network call. The authoritative check is server-side
  // (middleware/auth.js answers PASSWORD_CHANGE_REQUIRED), which is what makes
  // it hold for a stale tab or a token copied into another browser — the
  // dashboard's fetch wrapper turns that 403 into the same redirect.
  let mustChangePassword = false;
  try {
    mustChangePassword = !!JSON.parse(localStorage.getItem('admin') || '{}').mustChangePassword;
  } catch { /* unreadable storage: fall through to the server's decision */ }

  if (mustChangePassword && location.pathname !== CHANGE_PASSWORD_PATH) {
    return <Navigate to={CHANGE_PASSWORD_PATH} replace />;
  }

  // If token exists, render the nested routes
  return <Outlet />;
};

export default AdminProtectedRoute;
