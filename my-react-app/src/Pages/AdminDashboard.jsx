import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BASE_URL, parseJSON } from '../api';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import './AdminDashboard.css';
import AssessmentManagement from './AssessmentManagement';
import SecurityStatus from '../Components/SecurityStatus/SecurityStatus';

const tabs = ['overview', 'users', 'assessment-management', 'ai', 'profile', 'security'];
const ADMIN_IDLE_LIMIT_SECONDS = 3 * 60 + 30;
const ADMIN_WARNING_SECONDS = 30;
const ADMIN_REFRESH_INTERVAL_MS = 10 * 1000;

function AdminDashboard() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [ai, setAi] = useState(null);
  const [security, setSecurity] = useState(null);
  const [profile, setProfile] = useState(null);
  const [profileForm, setProfileForm] = useState({ currentPassword: '', newPassword: '', otp: '' });
  const [profileMessage, setProfileMessage] = useState('');
  const [rotateOtp, setRotateOtp] = useState('');
  const [rotatedKey, setRotatedKey] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const [expandedUser, setExpandedUser] = useState(null);
  const searchRef = useRef('');
  const [idleSeconds, setIdleSeconds] = useState(ADMIN_IDLE_LIMIT_SECONDS);
  const idleDeadlineRef = useRef(0);

  const request = useCallback(async (path, options = {}) => {
    const { background = false, ...fetchOptions } = options;
    const response = await fetch(`${BASE_URL}/admin${path}`, { ...fetchOptions, headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}`, ...(background ? { 'X-Admin-Background': 'true' } : {}), ...fetchOptions.headers } });
    const data = await parseJSON(response);
    if (response.status === 401 || response.status === 403) { localStorage.removeItem('adminToken'); localStorage.removeItem('admin'); navigate('/admin/login'); throw new Error('Your admin session has expired.'); }
    if (!response.ok) throw new Error(data?.message || 'Unable to load admin data.');
    return data;
  }, [navigate]);

  const load = useCallback(async (background = false) => {
    try {
      setError('');
      const [overviewData, aiData, securityData, profileData, notificationData] = await Promise.all([request('/overview', { background }), request('/ai', { background }), request('/security', { background }), request('/profile', { background }), request('/notifications', { background })]);
      setOverview(overviewData); setAi(aiData); setSecurity(securityData); setProfile(profileData);
      setNotifications(notificationData.notifications || []); setUnreadCount(notificationData.unreadCount || 0);
      if (!searchRef.current.trim()) setUsers(overviewData.recentUsers || []);
    } catch (requestError) { setError(requestError.message); }
  }, [request]);

  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      if (localStorage.getItem('admin') && localStorage.getItem('adminToken')) loadRef.current();
      else navigate('/admin/login');
    }, 0);
    return () => window.clearTimeout(initialLoad);
  }, [navigate]);

  const loadUsers = async () => {
    try { searchRef.current = search; const data = await request(`/users?search=${encodeURIComponent(search)}`); setUsers(data.users || []); } catch (requestError) { setError(requestError.message); }
  };

  const toggleSubscription = async (user) => {
    try {
      const data = await request(`/users/${user._id}/subscription`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: !user.subscriptionActive, plan: user.subscriptionActive ? 'free' : 'custom' }) });
      setUsers(current => current.map(item => item._id === data.user._id ? data.user : item));
      setOverview(current => current ? {
        ...current,
        metrics: {
          ...current.metrics,
          activeSubscriptions: current.metrics.activeSubscriptions + (data.user.subscriptionActive ? 1 : -1),
          inactiveSubscriptions: current.metrics.inactiveSubscriptions + (data.user.subscriptionActive ? -1 : 1),
        },
        recentUsers: current.recentUsers.map(item => item._id === data.user._id ? { ...item, ...data.user } : item),
      } : current);
      load(true);
    } catch (requestError) { setError(requestError.message); }
  };

  const downloadReport = () => {
    const doc = new jsPDF();
    doc.setFontSize(18); doc.text('SuppliWise Security Report', 14, 18);
    doc.setFontSize(10); doc.text(`Generated ${new Date().toLocaleString()} | STRIDE + OWASP review`, 14, 26);
    autoTable(doc, { startY: 34, head: [['Control', 'Status', 'Recommended action']], body: (security?.checks || []).map(check => [check.label, check.status, check.status === 'healthy' ? 'No action required' : check.fix]) });
    const startY = doc.lastAutoTable.finalY + 12;
    doc.setFontSize(13); doc.text('System overview', 14, startY);
    autoTable(doc, { startY: startY + 5, head: [['Metric', 'Value']], body: Object.entries(overview?.metrics || {}).map(([key, value]) => [key, String(value)]) });
    doc.save('suppliwise-security-report.pdf');
  };

  const signOut = useCallback(() => { localStorage.removeItem('adminToken'); localStorage.removeItem('admin'); localStorage.removeItem('token'); navigate('/admin/login'); }, [navigate]);
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  }, [signOut]);

  useEffect(() => {
    if (!localStorage.getItem('admin') || !localStorage.getItem('adminToken')) {
      navigate('/admin/login');
      return undefined;
    }

    const resetIdleTimer = () => {
      idleDeadlineRef.current = Date.now() + ADMIN_IDLE_LIMIT_SECONDS * 1000;
      setIdleSeconds(ADMIN_IDLE_LIMIT_SECONDS);
    };
    const activityEvents = ['keydown', 'mousedown', 'mousemove', 'scroll', 'touchstart', 'pointerdown', 'focus'];
    const handleActivity = () => resetIdleTimer();
    resetIdleTimer();
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((idleDeadlineRef.current - Date.now()) / 1000));
      setIdleSeconds(remaining);
      if (remaining === 0) {
        window.clearInterval(timer);
        signOutRef.current();
      }
    }, 1000);

    activityEvents.forEach(eventName => window.addEventListener(eventName, handleActivity, { passive: true }));
    return () => {
      window.clearInterval(timer);
      activityEvents.forEach(eventName => window.removeEventListener(eventName, handleActivity));
    };
  }, [navigate]);

  useEffect(() => {
    const refreshTimer = window.setInterval(() => { loadRef.current(true); }, ADMIN_REFRESH_INTERVAL_MS);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') loadRef.current(true);
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(refreshTimer);
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, []);

  const changePassword = async (event) => {
    event.preventDefault();
    try {
      const data = await request('/profile/password', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profileForm) });
      setProfileMessage(data.message);
      setProfileForm({ currentPassword: '', newPassword: '', otp: '' });
    } catch (requestError) { setProfileMessage(requestError.message); }
  };

  const rotateAuthenticator = async (event) => {
    event.preventDefault();
    try {
      const data = await request('/profile/authenticator/rotate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ otp: rotateOtp }) });
      setRotatedKey(data); setRotateOtp(''); setProfileMessage(data.message);
    } catch (requestError) { setProfileMessage(requestError.message); }
  };

  const updateAccount = async (user, changes) => {
    try {
      const data = await request(`/users/${user._id}/account`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      setUsers(current => current.map(item => item._id === data.user._id ? { ...item, ...data.user } : item));
      setOverview(current => current ? { ...current, recentUsers: current.recentUsers.map(item => item._id === data.user._id ? { ...item, ...data.user } : item) } : current);
    } catch (requestError) { setError(requestError.message); }
  };

  const deleteAccount = async user => {
    if (!window.confirm(`Disable ${user.email}?`)) return;
    try { await request(`/users/${user._id}`, { method: 'DELETE' }); await loadUsers(); } catch (requestError) { setError(requestError.message); }
  };

  const markAsRead = async (notificationId) => {
    try {
      await request('/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationIds: [notificationId] }),
      });
      setNotifications(current => current.filter(n => n._id !== notificationId));
      setUnreadCount(current => Math.max(0, current - 1));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleNotificationClick = (notification) => {
    if (notification.type === 'security') {
      setTab('security');
    }
    if (notification._id) {
      markAsRead(notification._id);
    }
    setShowNotifications(false);
  };

  const formatIdleTime = () => `${Math.floor(idleSeconds / 60)}:${String(idleSeconds % 60).padStart(2, '0')}`;

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <div><p className="admin-kicker">SUPPLIWISE</p><h2>Control Panel</h2></div>
        <nav>{tabs.map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item === 'ai' ? 'AI management' : item === 'users' ? 'User management' : item === 'assessment-management' ? 'Assessment Management' : item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
        <button className="admin-link sidebar-signout" onClick={signOut}>Sign out</button>
      </aside>
      <main className="admin-main">
        <header className="admin-header"><div><p className="admin-kicker">ADMINISTRATOR / {tab.toUpperCase()}</p><h1>{tab === 'overview' ? 'System overview' : tab === 'ai' ? 'AI management and control' : tab === 'users' ? 'User management' : tab === 'security' ? 'Security center' : 'Assessment Management'}</h1></div><div className="admin-header-actions"><div className="notification-wrap"><button className="notification-button" aria-label="Open notifications" onClick={() => { setShowNotifications(current => !current); }}><span aria-hidden="true">&#128276;</span>{unreadCount > 0 && <b>{unreadCount > 9 ? '9+' : unreadCount}</b>}</button>{showNotifications && <div className="notification-panel"><h3>System notifications</h3>{notifications.length ? notifications.map((notification, index) => <div className="notification" key={`${notification.title}-${index}`} onClick={() => handleNotificationClick(notification)}><strong>{notification.title}</strong><span>{notification.detail}</span></div>) : <p className="admin-muted">No new notifications.</p>}</div>}</div><button className="admin-secondary" onClick={downloadReport}>Download security report</button></div></header>
        <div className={`admin-session-status${idleSeconds <= ADMIN_WARNING_SECONDS ? ' warning' : ''}`}>{idleSeconds <= ADMIN_WARNING_SECONDS ? <><strong>Session expiry warning:</strong> signing out in <strong>{formatIdleTime()}</strong> due to inactivity.</> : <>Admin session expires after 3 minutes of inactivity, followed by a 30-second warning. <strong>{formatIdleTime()}</strong></>}</div>
        {idleSeconds <= ADMIN_WARNING_SECONDS && <div className="admin-session-warning" role="alert" aria-live="assertive">Your admin session is about to expire. Move or focus on this page to stay signed in. Automatic logout in <strong>{formatIdleTime()}</strong>.</div>}
        {error && <div className="admin-alert danger">{error}</div>}
        {tab === 'overview' && overview && <Overview overview={overview} />}
        {tab === 'users' && <Users users={users} search={search} setSearch={value => { searchRef.current = value; setSearch(value); }} loadUsers={loadUsers} toggleSubscription={toggleSubscription} updateAccount={updateAccount} deleteAccount={deleteAccount} expandedUser={expandedUser} setExpandedUser={setExpandedUser} />}
        {tab === 'assessment-management' && <AssessmentManagement />}
        {tab === 'ai' && <AiPanel ai={ai} />}
        {tab === 'security' && <SecurityStatus securityData={security} adminRequest={request} />}
        {tab === 'profile' && <ProfilePanel profile={profile} form={profileForm} setForm={setProfileForm} message={profileMessage} onSubmit={changePassword} rotateOtp={rotateOtp} setRotateOtp={setRotateOtp} rotatedKey={rotatedKey} onRotate={rotateAuthenticator} />}
      </main>
    </div>
  );
}

function Overview({ overview }) {
  return <>
    <section className="metric-grid">{Object.entries(overview.metrics).map(([key, value]) => <div className="metric" key={key}><span>{key.replace(/([A-Z])/g, ' $1')}</span><strong>{value}</strong></div>)}</section>
    <section className="admin-grid"><div className="admin-panel"><h3>Recent account activity</h3><div className="table-wrap"><table><thead><tr><th>User</th><th>Created</th><th>Subscription</th><th>Security status</th></tr></thead><tbody>{overview.recentUsers.map(user => <tr key={user._id}><td>{user.firstName} {user.lastName}<small>{user.email}</small></td><td>{new Date(user.createdAt).toLocaleDateString()}</td><td>{user.subscriptionActive ? 'Active' : 'Free'}</td><td>{user.twoFactorEnabled ? 'Google Authenticator active' : 'Email OTP active'}</td></tr>)}</tbody></table></div></div><div className="admin-panel"><h3>Threat notifications</h3>{overview.notifications.length ? overview.notifications.map(note => <div className="notification" key={note.title}><strong>{note.title}</strong><span>{note.detail}</span></div>) : <p className="admin-muted">No active security notifications.</p>}</div></section>
  </>;
}

function Users({ users, search, setSearch, loadUsers, toggleSubscription, updateAccount, deleteAccount, expandedUser, setExpandedUser }) {
  const handleUserToggle = (userId) => {
    setExpandedUser(expandedUser === userId ? null : userId);
  };

  // Generate initials avatar colour from name (deterministic)
  const avatarColor = (name = '') => {
    const palette = ['#4f6bed','#e85d75','#2e9e6b','#d46b35','#7c4ddb','#0891b2','#b45309','#be185d'];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
    return palette[Math.abs(hash) % palette.length];
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div>
          <h3>Users</h3>
          <p className="admin-muted">Manage access, roles, subscriptions, and security status. Passwords are never displayed.</p>
        </div>
        <div className="search-row">
          <input placeholder="Search users" value={search} onChange={event => setSearch(event.target.value)} />
          <button className="admin-secondary" onClick={loadUsers}>Search</button>
        </div>
      </div>

      <div className="user-list">
        {users.length === 0 && (
          <p className="admin-muted" style={{ padding: '20px 0' }}>No users found.</p>
        )}
        {users.map(user => {
          const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Unknown';
          const initials = fullName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
          const isOpen = expandedUser === user._id;
          const color = avatarColor(fullName);

          return (
            <div key={user._id} className={`user-item${isOpen ? ' user-item--open' : ''}`}>
              {/* ── Collapsed row ───────────────────────────────────── */}
              <button
                className="user-row"
                onClick={() => handleUserToggle(user._id)}
                aria-expanded={isOpen}
              >
                {/* Avatar */}
                {user.profilePicture ? (
                  <img
                    className="user-avatar"
                    src={user.profilePicture}
                    alt={fullName}
                    onError={e => { e.target.style.display = 'none'; e.target.nextSibling.style.display = 'flex'; }}
                  />
                ) : null}
                <span
                  className="user-avatar user-avatar--initials"
                  style={{ background: color, display: user.profilePicture ? 'none' : 'flex' }}
                  aria-hidden="true"
                >
                  {initials}
                </span>

                {/* Name + joined */}
                <span className="user-row__info">
                  <span className="user-row__name">{fullName}</span>
                  <span className="user-row__sub">Joined: {new Date(user.createdAt).toLocaleDateString()}</span>
                </span>

                {/* Status badge */}
                {user.accountStatus && user.accountStatus !== 'active' && (
                  <span className={`user-status-badge user-status-badge--${user.accountStatus}`}>
                    {user.accountStatus}
                  </span>
                )}

                {/* Assessments pill */}
                {user.assessmentCount != null && (
                  <span className="user-count-pill">
                    {user.assessmentCount} {user.assessmentCount === 1 ? 'assessment' : 'assessments'}
                  </span>
                )}

                {/* Chevron */}
                <span className={`user-row__chevron${isOpen ? ' user-row__chevron--open' : ''}`} aria-hidden="true">▼</span>
              </button>

              {/* ── Expanded details ─────────────────────────────── */}
              {isOpen && (
                <div className="user-details">
                  <div className="user-details__grid">
                    <div className="user-detail-item">
                      <strong>Email</strong>
                      <span>{user.email}</span>
                    </div>
                    <div className="user-detail-item">
                      <strong>Last Login</strong>
                      <span>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</span>
                      <small>{user.device || 'Unknown device'}</small>
                    </div>
                    <div className="user-detail-item">
                      <strong>Location</strong>
                      <span>{user.lastLoginLocation || 'Unknown'}</span>
                    </div>
                    <div className="user-detail-item">
                      <strong>Subscription</strong>
                      <button
                        className={`subscription-toggle-button${user.subscriptionActive ? ' subscribed' : ''}`}
                        onClick={() => toggleSubscription(user)}
                      >
                        {user.subscriptionActive ? 'Subscribed ✓' : 'Free — click to activate'}
                      </button>
                    </div>
                    <div className="user-detail-item">
                      <strong>Role</strong>
                      <span>{user.accountRole || 'user'}</span>
                    </div>
                    <div className="user-detail-item">
                      <strong>Account status</strong>
                      <select
                        value={user.accountStatus || 'active'}
                        onChange={event => updateAccount(user, { status: event.target.value })}
                      >
                        <option value="active">Active</option>
                        <option value="banned">Banned</option>
                      </select>
                    </div>
                    <div className="user-detail-item">
                      <strong>2FA / Security</strong>
                      <span className={user.twoFactorEnabled ? 'security-active' : 'security-email'}>
                        {user.twoFactorEnabled ? 'Google Authenticator active' : 'Email OTP active'}
                      </span>
                    </div>
                    {user.assessmentCount != null && (
                      <div className="user-detail-item">
                        <strong>Assessments</strong>
                        <span>{user.assessmentCount}</span>
                      </div>
                    )}
                  </div>
                  <div className="user-actions">
                    <button className="status danger-action" onClick={() => deleteAccount(user)}>
                      Delete account
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function AiPanel({ ai }) {
  const providers = ai?.providers || [];

  return (
    <section className="admin-panel">
      <h3>AI Management and Control</h3>
      <p className="admin-muted">
        Configuration state of all AI providers used by SuppliWise. Database and API
        connectivity are monitored live in the <strong>Security Center</strong> tab.
      </p>

      <h3 style={{ marginTop: '1.5rem' }}>Connected AI providers</h3>
      <div className="provider-grid">
        {providers.length === 0 && (
          <p className="admin-muted">No provider data available.</p>
        )}
        {providers.map(provider => (
          <div className="provider" key={provider.key}>
            <strong>{provider.label}</strong>
            <span className={provider.configured ? 'healthy' : 'attention'}>
              {provider.configured ? 'Configured' : 'Not configured'}
            </span>
            <small>{provider.model}</small>
          </div>
        ))}
      </div>

      <p className="admin-muted">
        Token usage and accuracy should be connected to provider usage APIs before being
        shown as billing or quality truth. This dashboard currently reports configuration
        state only.
      </p>
    </section>
  );
}
function SecurityPanel({ security }) { return <section className="admin-panel"><h3>STRIDE and OWASP controls</h3>{(security?.checks || []).map(check => <div className="security-row" key={check.key}><span className={check.status}>{check.status}</span><div><strong>{check.label}</strong><small>{check.status === 'healthy' ? 'Control is configured.' : check.fix}</small></div></div>)}</section>; }
function ProfilePanel({ profile, form, setForm, message, onSubmit, rotateOtp, setRotateOtp, rotatedKey, onRotate }) {
  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  return <section className="admin-panel"><h3>Administrator profile</h3><p className="admin-muted">Signed in as <strong>{profile?.alias || 'administrator'}</strong>. Change the password or rotate the authenticator key with the current Google Authenticator code.</p><form className="admin-profile-form" onSubmit={onSubmit}><label>Current password<input name="currentPassword" type="password" value={form.currentPassword} onChange={update} required /></label><label>New password<input name="newPassword" type="password" value={form.newPassword} onChange={update} minLength="8" required /></label><label>Google Authenticator code<input name="otp" inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={form.otp} onChange={event => setForm(current => ({ ...current, otp: event.target.value.replace(/\D/g, '') }))} required /></label>{message && <div className="admin-alert">{message}</div>}<button className="admin-primary">Change password</button></form><hr className="profile-divider" /><h3>Generate new authenticator key</h3><p className="admin-muted">Enter the current code. The old key stops working immediately.</p><form className="admin-profile-form" onSubmit={onRotate}><label>Current Google Authenticator code<input inputMode="numeric" pattern="[0-9]{6}" maxLength="6" value={rotateOtp} onChange={event => setRotateOtp(event.target.value.replace(/\D/g, ''))} required /></label><button className="admin-secondary">Generate new key</button></form>{rotatedKey && <div className="rotated-key"><img src={rotatedKey.qrCode} alt="New Google Authenticator QR code" /><small>Secret: {rotatedKey.secret}</small></div>}</section>;
}

export default AdminDashboard;