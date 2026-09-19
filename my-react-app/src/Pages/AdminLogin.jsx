import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BASE_URL, parseJSON } from '../api';
import './AdminDashboard.css';

function AdminLogin() {
  const navigate = useNavigate();
  const [alias, setAlias] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const submitCredentials = async (event) => {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/admin-login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ alias, password }),
      });
      const data = await parseJSON(response);
      if (!response.ok) throw new Error(data?.message || 'Admin sign in failed.');
      setChallengeId(data.challengeId);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  const submitOtp = async (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(otp)) return setError('Enter the 6-digit authenticator code.');
    setError('');
    setLoading(true);
    try {
      const response = await fetch(`${BASE_URL}/auth/verify-admin-2fa`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeId, otp }),
      });
      const data = await parseJSON(response);
      if (!response.ok) throw new Error(data?.message || 'Admin verification failed.');
      const legacyToken = localStorage.getItem('token');
      try {
        const payload = legacyToken ? JSON.parse(atob(legacyToken.split('.')[1])) : null;
        if (payload?.role === 'admin') localStorage.removeItem('token');
      } catch {
        // Ignore malformed legacy storage; the user session will handle it normally.
      }
      localStorage.setItem('adminToken', data.token);
      localStorage.setItem('admin', JSON.stringify({ role: 'admin', alias: data.alias }));
      navigate('/admin');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="admin-login-page">
      <form className="admin-login-card" onSubmit={challengeId ? submitOtp : submitCredentials}>
        <p className="admin-kicker">SUPPLIWISE CONTROL PANEL</p>
        <h1>Admin access</h1>
        <p className="admin-muted">This area is restricted to authorized administrators.</p>
        {error && <div className="admin-alert danger">{error}</div>}
        {!challengeId ? (
          <>
            <label>Admin alias<input value={alias} onChange={event => setAlias(event.target.value)} autoComplete="username" required /></label>
            <label>Secret password<input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required /></label>
            <button className="admin-primary" disabled={loading}>{loading ? 'Checking credentials...' : 'Continue securely'}</button>
          </>
        ) : (
          <>
            <label>Authenticator code<input inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={otp} onChange={event => setOtp(event.target.value.replace(/\D/g, ''))} autoFocus required /></label>
            <button className="admin-primary" disabled={loading}>{loading ? 'Verifying...' : 'Open dashboard'}</button>
          </>
        )}
        <button type="button" className="admin-link" onClick={() => navigate('/login')}>Return to user login</button>
      </form>
    </main>
  );
}

export default AdminLogin;
