import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BASE_URL, parseJSON } from '../api';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import './AdminDashboard.css';
import AssessmentManagement from './AssessmentManagement';
import SecurityStatus from '../Components/SecurityStatus/SecurityStatus';
import AdminTopbar from '../Components/AdminTopbar/AdminTopbar';

const tabs = ['overview', 'users', 'assessment-management', 'ai', 'profile', 'security'];
const ADMIN_IDLE_LIMIT_SECONDS = 3 * 60 + 30;
const ADMIN_WARNING_SECONDS = 30;
const ADMIN_REFRESH_INTERVAL_MS = 10 * 1000;

/* ── Tab icons ────────────────────────────────────────────────────────── */
const TAB_ICONS = {
  overview: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
      <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
    </svg>
  ),
  users: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
      <circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
      <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  'assessment-management': (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>
  ),
  ai: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"/>
    </svg>
  ),
  profile: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  ),
  security: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
};

const SIGNOUT_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </svg>
);

function AdminDashboard() {
  const navigate = useNavigate();
  const [tab, setTab] = useState('overview');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [allUsers, setAllUsers] = useState([]);
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

  const downloadReport = async () => {
    const doc = new jsPDF({ unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const now = new Date();
    const generated = now.toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    // ── Colour palette ──────────────────────────────────────────────────
    const GREEN  = [22,  101, 52];   // #166534
    const GREEN2 = [34,  197, 94];   // #22c55e
    const RED    = [185, 28,  28];   // #b91c1c
    const AMBER  = [161, 98,  7];    // #a16207
    const PURPLE = [109, 40,  217];  // #6d28d9
    const INK    = [17,  24,  39];   // #111827
    const MUTED  = [107, 114, 128];  // #6b7280
    const LINE   = [229, 231, 235];  // #e5e7eb
    const WHITE  = [255, 255, 255];

    // ── Header banner ───────────────────────────────────────────────────
    doc.setFillColor(...GREEN);
    doc.rect(0, 0, W, 38, 'F');

    // Logo / title
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(22);
    doc.setTextColor(...WHITE);
    doc.text('SuppliWise', 14, 16);

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(10);
    doc.setTextColor(187, 247, 208); // light green
    doc.text('Security Report  ·  STRIDE + OWASP Framework', 14, 24);

    doc.setFontSize(9);
    doc.setTextColor(187, 247, 208);
    doc.text(`Generated: ${generated}`, 14, 32);

    // Confidential badge (top-right)
    doc.setFillColor(220, 38, 38);
    doc.roundedRect(W - 46, 8, 38, 10, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...WHITE);
    doc.text('CONFIDENTIAL', W - 27, 14.5, { align: 'center' });

    let y = 48;

    // ── Helper: section heading ─────────────────────────────────────────
    const sectionHeading = (label) => {
      if (y > H - 30) { doc.addPage(); y = 20; }
      doc.setFillColor(...GREEN);
      doc.rect(14, y, 3, 6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      doc.setTextColor(...GREEN);
      doc.text(label, 20, y + 5);
      y += 12;
    };

    // ── Helper: small label + value row ────────────────────────────────
    const kv = (label, value, valueColor = INK) => {
      if (y > H - 16) { doc.addPage(); y = 20; }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(...MUTED);
      doc.text(label.toUpperCase(), 14, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...valueColor);
      doc.text(String(value), 60, y);
      y += 7;
    };

    // ── 1. Executive Summary ────────────────────────────────────────────
    sectionHeading('Executive Summary');

    const checks   = security?.checks        || [];
    const recs     = security?.recommendations || [];
    const metrics  = overview?.metrics        || {};
    const monData  = await request('/security/monitor').catch(() => null);
    const monitors = monData?.monitors || [];

    const totalChecks    = checks.length;
    const secureCount    = checks.filter(c => c.status === 'Secure').length;
    const criticalCount  = checks.filter(c => c.status === 'Critical').length;
    const vulnerableCount = checks.filter(c => c.status === 'Vulnerable').length;

    const mHealthy  = monitors.filter(m => m.status === 'healthy').length;
    const mWarning  = monitors.filter(m => m.status === 'warning').length;
    const mCritical = monitors.filter(m => m.status === 'critical' || m.status === 'error').length;

    // Overall status pill
    const overallStatus = security?.overallStatus || 'Unknown';
    const overallColor  = overallStatus === 'Secure' ? GREEN : overallStatus === 'Vulnerable' ? AMBER : RED;
    doc.setFillColor(...overallColor);
    doc.roundedRect(14, y, 50, 11, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(...WHITE);
    doc.text(`Overall: ${overallStatus}`, 39, y + 7.5, { align: 'center' });
    y += 17;

    kv('Report date',       generated);
    kv('Framework',         'STRIDE + OWASP Top 10');
    kv('Controls checked',  `${totalChecks}  (${secureCount} secure, ${vulnerableCount} vulnerable, ${criticalCount} critical)`);
    kv('Live monitors',     `${monitors.length}  (${mHealthy} healthy, ${mWarning} warning, ${mCritical} critical/error)`);
    kv('Total users',       String(metrics.users ?? '—'));
    kv('Active subs',       String(metrics.activeSubscriptions ?? '—'));
    kv('Last scanned',      security?.lastScanned ? new Date(security.lastScanned).toLocaleString() : '—');
    y += 4;

    // ── 2. STRIDE / OWASP Checks ───────────────────────────────────────
    sectionHeading('STRIDE + OWASP Security Checks');

    const statusColor = (s) => {
      if (s === 'Secure')     return [22, 163, 74];
      if (s === 'Vulnerable') return [161, 98, 7];
      if (s === 'Critical')   return [185, 28, 28];
      return MUTED;
    };

    autoTable(doc, {
      startY: y,
      margin: { left: 14, right: 14 },
      head: [['Status', 'Framework', 'Control', 'Recommended Action']],
      body: checks.map(c => [
        c.status,
        c.framework || '—',
        c.label,
        c.status === 'Secure' ? 'No action required' : (c.fix || '—'),
      ]),
      headStyles: {
        fillColor: GREEN,
        textColor: WHITE,
        fontSize: 8,
        fontStyle: 'bold',
        halign: 'left',
      },
      columnStyles: {
        0: { cellWidth: 22, fontStyle: 'bold' },
        1: { cellWidth: 22 },
        2: { cellWidth: 68 },
        3: { cellWidth: 'auto' },
      },
      bodyStyles: { fontSize: 8, textColor: INK },
      alternateRowStyles: { fillColor: [249, 250, 251] },
      didParseCell: (data) => {
        if (data.section === 'body' && data.column.index === 0) {
          const s = data.cell.raw;
          data.cell.styles.textColor = statusColor(s);
        }
      },
      theme: 'grid',
    });
    y = doc.lastAutoTable.finalY + 10;

    // ── 3. Real-time Monitor Results ───────────────────────────────────
    if (monitors.length > 0) {
      sectionHeading('Real-time Security Monitor');

      const mStatusColor = (s) => {
        if (s === 'healthy')  return [22, 163, 74];
        if (s === 'warning')  return [161, 98, 7];
        if (s === 'critical') return [185, 28, 28];
        if (s === 'error')    return [109, 40, 217];
        return MUTED;
      };

      autoTable(doc, {
        startY: y,
        margin: { left: 14, right: 14 },
        head: [['Status', 'Monitor', 'Framework', 'Detail', 'Latency']],
        body: monitors.map(m => [
          m.status.toUpperCase(),
          m.label,
          {
            login: 'Auth / JWT', account_creation: 'Auth / Email',
            email_otp: 'STRIDE', totp: 'STRIDE',
            database: 'Infrastructure', openrouter: 'AI / API',
            delete_account: 'OWASP', input_sanitization: 'OWASP',
            password_hashing: 'OWASP', salting: 'OWASP',
          }[m.key] || '—',
          (m.detail || '').slice(0, 90) + ((m.detail || '').length > 90 ? '…' : ''),
          m.latencyMs != null ? `${m.latencyMs} ms` : '—',
        ]),
        headStyles: {
          fillColor: GREEN,
          textColor: WHITE,
          fontSize: 8,
          fontStyle: 'bold',
        },
        columnStyles: {
          0: { cellWidth: 20, fontStyle: 'bold' },
          1: { cellWidth: 40 },
          2: { cellWidth: 24 },
          3: { cellWidth: 'auto', fontSize: 7 },
          4: { cellWidth: 18, halign: 'right' },
        },
        bodyStyles: { fontSize: 7.5, textColor: INK },
        alternateRowStyles: { fillColor: [249, 250, 251] },
        didParseCell: (data) => {
          if (data.section === 'body' && data.column.index === 0) {
            const raw = String(data.cell.raw).toLowerCase();
            data.cell.styles.textColor = mStatusColor(raw);
          }
        },
        theme: 'grid',
      });
      y = doc.lastAutoTable.finalY + 10;
    }

    // ── 4. Recommendations ─────────────────────────────────────────────
    if (recs.length > 0) {
      sectionHeading('Recommendations');

      recs.forEach((rec, i) => {
        if (y > H - 30) { doc.addPage(); y = 20; }
        const isHigh = (rec.priority || '').toLowerCase() === 'critical';
        doc.setFillColor(...(isHigh ? [254, 242, 242] : [255, 251, 235]));
        doc.roundedRect(14, y, W - 28, 16, 2, 2, 'F');
        doc.setFillColor(...(isHigh ? RED : AMBER));
        doc.rect(14, y, 2, 16, 'F');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(...(isHigh ? RED : AMBER));
        doc.text(`${i + 1}. ${rec.title}`, 20, y + 6);

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
        doc.setTextColor(...INK);
        const lines = doc.splitTextToSize(rec.description || '', W - 44);
        doc.text(lines[0] || '', 20, y + 12);
        y += 20;
      });
      y += 4;
    }

    // ── Footer on every page ────────────────────────────────────────────
    const totalPages = doc.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
      doc.setPage(p);
      doc.setFillColor(...LINE);
      doc.rect(0, H - 12, W, 12, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...MUTED);
      doc.text('SuppliWise — Confidential Security Report. For authorized personnel only.', 14, H - 5);
      doc.text(`Page ${p} of ${totalPages}`, W - 14, H - 5, { align: 'right' });
    }

    const dateStr = now.toISOString().slice(0, 10);
    doc.save(`suppliwise-security-report-${dateStr}.pdf`);
  };

  // expose download so SecurityStatus can call it
  const downloadReportRef = useRef(downloadReport);
  useEffect(() => { downloadReportRef.current = downloadReport; }, [downloadReport]);

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

  const handleTabClick = (item) => {
    setTab(item);
    // Pre-fetch full user list the first time Assessment Management is opened
    if (item === 'assessment-management' && allUsers.length === 0) {
      request('/users?search=').then(data => {
        setAllUsers(data.users || []);
      }).catch(() => {});
    }
  };

  const TAB_LABEL = {
    overview: 'Overview',
    users: 'User management',
    'assessment-management': 'Assessment Management',
    ai: 'AI management',
    profile: 'Profile',
    security: 'Security',
  };

  return (
    <div className="admin-shell">

      {/* ── Topbar: spans full width above sidebar + main ── */}
      <AdminTopbar
        admin={profile}
        unreadCount={unreadCount}
        showNotifications={showNotifications}
        onToggleNotifications={() => setShowNotifications(v => !v)}
        onGoProfile={() => setTab('profile')}
      />

      <div className="admin-body">

        {/* ── Sidebar ──────────────────────────────────────── */}
        <aside className={`admin-sidebar${sidebarCollapsed ? ' admin-sidebar--collapsed' : ''}`}>

          {/* Hamburger only — brand text removed */}
          <div className="sidebar-header">
            <button
              className="hamburger-btn"
              aria-label={sidebarCollapsed ? 'Expand menu' : 'Collapse menu'}
              aria-expanded={!sidebarCollapsed}
              onClick={() => setSidebarCollapsed(v => !v)}
            >
              {sidebarCollapsed ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="9 18 15 12 9 6"/>
                </svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="3" y1="6"  x2="21" y2="6"/>
                  <line x1="3" y1="12" x2="21" y2="12"/>
                  <line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
              )}
            </button>
          </div>

          {/* Nav items */}
          <nav>
            {tabs.map(item => (
              <button
                key={item}
                className={tab === item ? 'active' : ''}
                onClick={() => handleTabClick(item)}
                title={sidebarCollapsed ? TAB_LABEL[item] : undefined}
              >
                <span className="sidebar-nav-icon">{TAB_ICONS[item]}</span>
                <span className="sidebar-nav-label">{TAB_LABEL[item]}</span>
              </button>
            ))}
          </nav>

          {/* Sign out */}
          <button
            className="admin-link sidebar-signout"
            onClick={signOut}
            title={sidebarCollapsed ? 'Sign out' : undefined}
          >
            <span className="sidebar-nav-icon">{SIGNOUT_ICON}</span>
            <span className="sidebar-nav-label">Sign out</span>
          </button>
        </aside>

        {/* ── Main content ─────────────────────────────────── */}
        <main className="admin-main">

          {/* Notification panel (rendered here so it overlays main, not topbar) */}
          {showNotifications && (
            <div className="notification-panel admin-notif-panel">
              <h3>System notifications</h3>
              {notifications.length
                ? notifications.map((notification, index) => (
                    <div
                      className="notification"
                      key={`${notification.title}-${index}`}
                      onClick={() => handleNotificationClick(notification)}
                    >
                      <strong>{notification.title}</strong>
                      <span>{notification.detail}</span>
                    </div>
                  ))
                : <p className="admin-muted">No new notifications.</p>
              }
            </div>
          )}

          <header className="admin-header">
            <div>
              <p className="admin-kicker">ADMINISTRATOR / {tab.toUpperCase()}</p>
              <h1>
                {tab === 'overview'             ? 'System overview'
                  : tab === 'ai'               ? 'AI management and control'
                  : tab === 'users'            ? 'User management'
                  : tab === 'security'         ? 'Security center'
                  : tab === 'profile'          ? 'Administrator profile'
                  : 'Assessment Management'}
              </h1>
            </div>
          </header>

          <div className={`admin-session-status${idleSeconds <= ADMIN_WARNING_SECONDS ? ' warning' : ''}`}>
            {idleSeconds <= ADMIN_WARNING_SECONDS
              ? <><strong>Session expiry warning:</strong> signing out in <strong>{formatIdleTime()}</strong> due to inactivity.</>
              : <>Admin session expires after 3 minutes of inactivity, followed by a 30-second warning. <strong>{formatIdleTime()}</strong></>}
          </div>

          {idleSeconds <= ADMIN_WARNING_SECONDS && (
            <div className="admin-session-warning" role="alert" aria-live="assertive">
              Your admin session is about to expire. Move or focus on this page to stay signed in. Automatic logout in <strong>{formatIdleTime()}</strong>.
            </div>
          )}

          {error && <div className="admin-alert danger">{error}</div>}

          {tab === 'overview'               && overview && <div className="admin-tab-panel"><Overview overview={overview} /></div>}
          {tab === 'users'                  && <div className="admin-tab-panel"><Users users={users} search={search} setSearch={value => { searchRef.current = value; setSearch(value); }} loadUsers={loadUsers} toggleSubscription={toggleSubscription} updateAccount={updateAccount} deleteAccount={deleteAccount} expandedUser={expandedUser} setExpandedUser={setExpandedUser} /></div>}
          {tab === 'assessment-management'  && <div className="admin-tab-panel"><AssessmentManagement users={allUsers} adminRequest={request} /></div>}
          {tab === 'ai'                     && <div className="admin-tab-panel"><AiPanel ai={ai} /></div>}
          {tab === 'security'               && <div className="admin-tab-panel"><SecurityStatus securityData={security} adminRequest={request} onDownloadReport={() => downloadReportRef.current()} /></div>}
          {tab === 'profile'                && <div className="admin-tab-panel"><ProfilePanel profile={profile} form={profileForm} setForm={setProfileForm} message={profileMessage} onSubmit={changePassword} rotateOtp={rotateOtp} setRotateOtp={setRotateOtp} rotatedKey={rotatedKey} onRotate={rotateAuthenticator} /></div>}
        </main>
      </div>
    </div>
  );
}

// Metric icon map
const METRIC_ICONS = {
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
      <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
    </svg>
  ),
  assessments: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
    </svg>
  ),
  activeSubscriptions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  ),
  inactiveSubscriptions: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/>
      <line x1="9" y1="9" x2="15" y2="15"/>
    </svg>
  ),
};

const METRIC_LABEL = {
  users:                 'Total Users',
  assessments:           'Assessments',
  activeSubscriptions:   'Active Subscriptions',
  inactiveSubscriptions: 'Inactive Subscriptions',
};

const METRIC_COLOR = {
  users:                 { icon: '#4f6bed', bg: '#eef0fd' },
  assessments:           { icon: '#0891b2', bg: '#e0f2fe' },
  activeSubscriptions:   { icon: '#16a34a', bg: '#dcfce7' },
  inactiveSubscriptions: { icon: '#9ca3af', bg: '#f3f4f6' },
};

function Overview({ overview }) {
  const secureCount   = (overview.security || []).filter(c => c.status === 'Secure').length;
  const totalChecks   = (overview.security || []).length;
  const allSecure     = totalChecks > 0 && secureCount === totalChecks;

  return (
    <>
      {/* ── Metric cards ──────────────────────────────────────────── */}
      <section className="ov-metric-grid">
        {Object.entries(overview.metrics).map(([key, value]) => {
          const icon  = METRIC_ICONS[key];
          const label = METRIC_LABEL[key] || key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase());
          const col   = METRIC_COLOR[key] || { icon: '#6b7280', bg: '#f3f4f6' };
          return (
            <div className="ov-metric" key={key}>
              {icon && (
                <span className="ov-metric__icon" style={{ background: col.bg, color: col.icon }}>
                  {icon}
                </span>
              )}
              <div className="ov-metric__body">
                <span className="ov-metric__label">{label}</span>
                <strong className="ov-metric__value">{value}</strong>
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Bottom grid: activity + notifications ─────────────────── */}
      <section className="ov-grid">

        {/* Recent account activity */}
        <div className="admin-panel ov-activity">
          <div className="ov-panel-header">
            <h3>Recent account activity</h3>
            <span className="ov-panel-count">{overview.recentUsers.length} users</span>
          </div>
          <div className="table-wrap">
            <table className="ov-table">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Created</th>
                  <th>Subscription</th>
                  <th>Security</th>
                </tr>
              </thead>
              <tbody>
                {overview.recentUsers.length === 0 && (
                  <tr><td colSpan="4" className="ov-empty">No recent users.</td></tr>
                )}
                {overview.recentUsers.map(user => (
                  <tr key={user._id} className="ov-row">
                    <td>
                      <span className="ov-user-name">{user.firstName} {user.lastName}</span>
                      <small className="ov-user-email">{user.email}</small>
                    </td>
                    <td className="ov-nowrap">{new Date(user.createdAt).toLocaleDateString()}</td>
                    <td>
                      <span className={`ov-sub-badge${user.subscriptionActive ? ' ov-sub-badge--active' : ''}`}>
                        {user.subscriptionActive ? 'Active' : 'Free'}
                      </span>
                    </td>
                    <td>
                      <span className={`ov-sec-badge${user.twoFactorEnabled ? ' ov-sec-badge--totp' : ' ov-sec-badge--otp'}`}>
                        {user.twoFactorEnabled ? '🔐 Authenticator' : '✉ Email OTP'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Threat notifications */}
        <div className="admin-panel ov-threats">
          <div className="ov-panel-header">
            <h3>Threat notifications</h3>
            {overview.notifications.length > 0 && (
              <span className="ov-threat-count">{overview.notifications.length}</span>
            )}
          </div>

          {overview.notifications.length === 0 ? (
            <div className="ov-all-clear">
              <span className="ov-all-clear__icon" aria-hidden="true">✓</span>
              <p>All security controls are passing. No active threats.</p>
            </div>
          ) : (
            <div className="ov-threat-list">
              {overview.notifications.map((note, i) => (
                <div className="ov-threat" key={`${note.title}-${i}`}>
                  <span className="ov-threat__dot" aria-hidden="true" />
                  <div>
                    <strong className="ov-threat__title">{note.title}</strong>
                    <p className="ov-threat__detail">{note.detail}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </section>
    </>
  );
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
                      <span>{user.accountRole || 'User'}</span>
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
  const [showCurrent,  setShowCurrent]  = useState(false);
  const [showNew,      setShowNew]      = useState(false);
  const [pwLoading,    setPwLoading]    = useState(false);
  const [rotLoading,   setRotLoading]   = useState(false);

  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));

  const isSuccess = message && !message.toLowerCase().includes('invalid') &&
    !message.toLowerCase().includes('incorrect') &&
    !message.toLowerCase().includes('error') &&
    !message.toLowerCase().includes('failed') &&
    !message.toLowerCase().includes('required');

  const handlePasswordSubmit = async (event) => {
    setPwLoading(true);
    await onSubmit(event);
    setPwLoading(false);
  };

  const handleRotateSubmit = async (event) => {
    setRotLoading(true);
    await onRotate(event);
    setRotLoading(false);
  };

  // Eye icon
  const EyeIcon = ({ open }) => open ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
      <line x1="1" y1="1" x2="23" y2="23"/>
    </svg>
  );

  return (
    <div className="profile-page">

      {/* ── Account card ─────────────────────────────────────────────── */}
      <div className="profile-card">
        <div className="profile-card__avatar">
          {(profile?.alias || 'A')[0].toUpperCase()}
        </div>
        <div className="profile-card__info">
          <p className="profile-card__name">{profile?.alias || 'administrator'}</p>
          <p className="profile-card__meta">Administrator account</p>
          {profile?.lastLoginAt && (
            <p className="profile-card__meta">
              Last login: {new Date(profile.lastLoginAt).toLocaleString()}
            </p>
          )}
          {profile?.createdAt && (
            <p className="profile-card__meta">
              Account created: {new Date(profile.createdAt).toLocaleDateString()}
            </p>
          )}
        </div>
      </div>

      {/* ── Feedback message ─────────────────────────────────────────── */}
      {message && (
        <div className={`profile-alert ${isSuccess ? 'profile-alert--success' : 'profile-alert--error'}`} role="alert">
          <span>{isSuccess ? '✓' : '✕'}</span>
          {message}
        </div>
      )}

      <div className="profile-grid">

        {/* ── Change password ────────────────────────────────────────── */}
        <section className="admin-panel profile-panel">
          <div className="profile-section-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
            </svg>
            <h3>Change password</h3>
          </div>
          <p className="admin-muted">Enter your current password and a new one. Your Google Authenticator code is required to confirm.</p>

          <form className="profile-form" onSubmit={handlePasswordSubmit} autoComplete="off">
            <div className="profile-field">
              <label htmlFor="currentPassword">Current password</label>
              <div className="profile-input-wrap">
                <input
                  id="currentPassword"
                  name="currentPassword"
                  type={showCurrent ? 'text' : 'password'}
                  value={form.currentPassword}
                  onChange={update}
                  autoComplete="current-password"
                  required
                />
                <button type="button" className="profile-eye" onClick={() => setShowCurrent(v => !v)} aria-label={showCurrent ? 'Hide password' : 'Show password'}>
                  <EyeIcon open={showCurrent} />
                </button>
              </div>
            </div>

            <div className="profile-field">
              <label htmlFor="newPassword">New password</label>
              <div className="profile-input-wrap">
                <input
                  id="newPassword"
                  name="newPassword"
                  type={showNew ? 'text' : 'password'}
                  value={form.newPassword}
                  onChange={update}
                  minLength="8"
                  autoComplete="new-password"
                  required
                />
                <button type="button" className="profile-eye" onClick={() => setShowNew(v => !v)} aria-label={showNew ? 'Hide password' : 'Show password'}>
                  <EyeIcon open={showNew} />
                </button>
              </div>
              <span className="profile-hint">Min. 8 characters, one uppercase letter, one number.</span>
            </div>

            <div className="profile-field">
              <label htmlFor="pwOtp">Google Authenticator code</label>
              <input
                id="pwOtp"
                name="otp"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength="6"
                placeholder="6-digit code"
                value={form.otp}
                onChange={event => setForm(current => ({ ...current, otp: event.target.value.replace(/\D/g, '') }))}
                autoComplete="one-time-code"
                required
              />
            </div>

            <button className="admin-primary profile-submit" disabled={pwLoading}>
              {pwLoading ? 'Changing…' : 'Change password'}
            </button>
          </form>
        </section>

        {/* ── Rotate authenticator key ──────────────────────────────── */}
        <section className="admin-panel profile-panel">
          <div className="profile-section-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            <h3>Rotate authenticator key</h3>
          </div>
          <p className="admin-muted">Generate a new Google Authenticator secret. The old key stops working immediately — scan the new QR code before signing out.</p>

          <form className="profile-form" onSubmit={handleRotateSubmit}>
            <div className="profile-field">
              <label htmlFor="rotOtp">Current authenticator code</label>
              <input
                id="rotOtp"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength="6"
                placeholder="6-digit code"
                value={rotateOtp}
                onChange={event => setRotateOtp(event.target.value.replace(/\D/g, ''))}
                autoComplete="one-time-code"
                required
              />
            </div>

            <button className="admin-secondary profile-submit" disabled={rotLoading}>
              {rotLoading ? 'Generating…' : 'Generate new key'}
            </button>
          </form>

          {rotatedKey && (
            <div className="profile-qr">
              <p className="profile-qr__label">Scan this QR code in your authenticator app:</p>
              <img src={rotatedKey.qrCode} alt="New Google Authenticator QR code" className="profile-qr__img" />
              <div className="profile-qr__secret">
                <span className="profile-qr__secret-label">Manual entry key</span>
                <code className="profile-qr__secret-value">{rotatedKey.secret}</code>
              </div>
            </div>
          )}
        </section>

      </div>
    </div>
  );
}

export default AdminDashboard;