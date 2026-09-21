import { Navigate, Outlet } from 'react-router-dom';

const AdminProtectedRoute = () => {
  const token = localStorage.getItem('adminToken');

  if (!token) {
    // If no token, redirect to the admin login page
    return <Navigate to="/admin/login" replace />;
  }

  // If token exists, render the nested routes
  return <Outlet />;
};

export default AdminProtectedRoute;