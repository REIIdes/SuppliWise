import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BASE_URL, parseJSON } from '../api';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import './AdminDashboard.css';
import AssessmentManagement from './AssessmentManagement';
import SecurityStatus from '../Components/SecurityStatus/SecurityStatus';
import AdminTopbar from '../Components/AdminTopbar/AdminTopbar';

const tabs = ['overview', 'users', 'admins', 'assessment-management', 'ai', 'profile', 'security'];
const ADMIN_IDLE_LIMIT_SECONDS = 3 * 60 + 30;
const ADMIN_WARNING_SECONDS = 30;
const ADMIN_REFRESH_INTERVAL_MS = 10 * 1000;

// ── Idle countdown badge ───────────────────────────────────────────────
// Owns its 1 s ticker so the rest of the dashboard does NOT re-render every
// second (previously the whole page re-rendered 210× per idle session).
// Memoized: only this badge updates as the countdown ticks.
import SessionExpiryModal from '../components/SessionExpiryModal/SessionExpiryModal';

const AdminIdleStatus = memo(function AdminIdleStatus({ deadlineRef, onExpire, onActivity }) {
  const [remaining, setRemaining] = useState(ADMIN_IDLE_LIMIT_SECONDS);
  const [showModal, setShowModal] = useState(false);
  const onExpireRef = useRef(null);
  useEffect(() => {
    onExpireRef.current = onExpire;
  }, [onExpire]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((deadlineRef.current - Date.now()) / 1000));
      setRemaining(left);

      if (left <= ADMIN_WARNING_SECONDS && !showModal) {
        setShowModal(true);
      }

      if (left === 0) {
        window.clearInterval(timer);
        onExpireRef.current();
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [deadlineRef, showModal]);

  const handleStayLoggedIn = () => {
    setShowModal(false);
    onActivity();
  };

  const handleLogout = () => {
    onExpireRef.current();
  };

  return (
    showModal && (
      <SessionExpiryModal
        remainingTime={remaining}
        onStayLoggedIn={handleStayLoggedIn}
        onLogout={handleLogout}
      />
    )
  );
});

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
  admins: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <polyline points="9 12 11 14 15 10"/>
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('adminSidebarCollapsed') === 'true'
  );
  const [overview, setOverview] = useState(null);
  const [users, setUsers] = useState([]);
  const [admins, setAdmins] = useState([]);
  // Timestamp of the last admins-list fetch (anchors the lockout countdown,
  // same pattern as usersFetchedAt).
  const [adminsFetchedAt, setAdminsFetchedAt] = useState(() => Date.now());
  // Timestamp (ms) of the last users-list fetch. The lockout countdown ticks
  // locally every second against fetchedAt + remainingSeconds, so the badge
  // stays live between 15 s server polls instead of freezing or vanishing.
  const [usersFetchedAt, setUsersFetchedAt] = useState(() => Date.now());
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
  const [adminSearch, setAdminSearch] = useState('');
  const [error, setError] = useState('');
  const [expandedUser, setExpandedUser] = useState(null);
  const [expandedAdmin, setExpandedAdmin] = useState(null);
  const searchRef = useRef('');
  const adminSearchRef = useRef('');
  const tabRef = useRef(tab);
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // Initialized by the idle effect on mount (avoids impure Date.now() in render)
  const idleDeadlineRef = useRef(0);

  const request = useCallback(async (path, options = {}) => {
    const { background = false, ...fetchOptions } = options;
    const response = await fetch(`${BASE_URL}/admin${path}`, { ...fetchOptions, headers: { Authorization: `Bearer ${localStorage.getItem('adminToken')}`, ...(background ? { 'X-Admin-Background': 'true' } : {}), ...fetchOptions.headers } });
    const data = await parseJSON(response);
    if (response.status === 401 || response.status === 403) { localStorage.removeItem('adminToken'); localStorage.removeItem('admin'); navigate('/admin/login'); throw new Error('Your admin session has expired.'); }
    if (!response.ok) throw new Error(data?.message || 'Unable to load admin data.');
    return data;
  }, [navigate]);

  const loadUsers = useCallback(async () => {
    try {
      const q = (searchRef.current || '').trim();
      const data = await request(`/users?search=${encodeURIComponent(q)}`);
      setUsers(data.users || []);
      setUsersFetchedAt(Date.now());
    } catch (requestError) { setError(requestError.message); }
  }, [request]);

  const loadAdmins = useCallback(async () => {
    try {
      const q = (adminSearchRef.current || '').trim();
      const data = await request(`/admins?search=${encodeURIComponent(q)}`);
      setAdmins(data.admins || []);
      setAdminsFetchedAt(Date.now());
    } catch (requestError) { setError(requestError.message); }
  }, [request]);

  const toggleAdmin = useCallback(async (admin) => {
    try {
      const data = await request(`/admins/${admin._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !admin.enabled }),
      });
      setAdmins(current => current.map(item => item._id === data.admin._id ? { ...item, ...data.admin, lockout: item.lockout } : item));
      setError('');
    } catch (requestError) { setError(requestError.message); }
  }, [request]);

  const unlockAdmin = useCallback(async (admin) => {
    try {
      const data = await request(`/admins/${admin._id}/lockout`, { method: 'DELETE' });
      // Re-fetch authoritative state instead of optimistic "Clear" — same as users.
      await loadAdmins();
      setError('');
      return data;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    }
  }, [request, loadAdmins]);

  const load = useCallback(async (background = false) => {
    try {
      setError('');
      const [overviewData, aiData, securityData, profileData, notificationData] = await Promise.all([request('/overview', { background }), request('/ai', { background }), request('/security', { background }), request('/profile', { background }), request('/notifications', { background })]);
      setOverview(overviewData); setAi(aiData); setSecurity(securityData); setProfile(profileData);
      setNotifications(notificationData.notifications || []); setUnreadCount(notificationData.unreadCount || 0);
      // Users tab needs the authoritative /users list (100 rows + live
      // lockout). recentUsers (8 rows) is only a dashboard preview — using
      // it here used to shrink the table and show stale "Clear" badges.
      if ((searchRef.current || '').trim()) return;
      if (tabRef.current === 'users') {
        const q = (searchRef.current || '').trim();
        try {
          const userData = await request(`/users?search=${encodeURIComponent(q)}`);
          setUsers(userData.users || []);
          setUsersFetchedAt(Date.now());
        } catch {
          setUsers(overviewData.recentUsers || []);
          setUsersFetchedAt(Date.now());
        }
      } else {
        setUsers(overviewData.recentUsers || []);
        setUsersFetchedAt(Date.now());
      }
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

  // Live lists: refresh users/admins state while their tab is open
  // (15 s poll + on tab focus/visibility), never clobbering a search.
  useEffect(() => {
    const maybeRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (tabRef.current === 'users') {
        if ((searchRef.current || '').trim() !== '') return;
        loadUsers();
      } else if (tabRef.current === 'admins') {
        if ((adminSearchRef.current || '').trim() !== '') return;
        loadAdmins();
      }
    };
    const timer = window.setInterval(maybeRefresh, 15000);
    document.addEventListener('visibilitychange', maybeRefresh);
    window.addEventListener('focus', maybeRefresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', maybeRefresh);
      window.removeEventListener('focus', maybeRefresh);
    };
  }, [loadUsers, loadAdmins]);

  const PLAN_LABELS = {
    free: 'Basic Package',
    monthly: 'Deluxe Package',
    annual: 'Premium Package',
    custom: 'Ultimate Package',
  };

  const setSubscriptionPlan = async (user, plan) => {
    if (!['free', 'monthly', 'annual', 'custom'].includes(plan)) return;
    const wasActive = !!user.subscriptionActive;
    try {
      const data = await request(`/users/${user._id}/subscription`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ active: plan !== 'free', plan }) });
      setUsers(current => current.map(item => item._id === data.user._id ? data.user : item));
      const flipped = wasActive !== data.user.subscriptionActive;
      setOverview(current => current ? {
        ...current,
        metrics: {
          ...current.metrics,
          activeSubscriptions: current.metrics.activeSubscriptions + (flipped ? (data.user.subscriptionActive ? 1 : -1) : 0),
          inactiveSubscriptions: current.metrics.inactiveSubscriptions + (flipped ? (data.user.subscriptionActive ? -1 : 1) : 0),
        },
        recentUsers: current.recentUsers.map(item => item._id === data.user._id ? { ...item, ...data.user } : item),
      } : current);
      // NOTE: no load() here — it would replace the managed user list with
      // recentUsers and wipe the just-saved plan from the UI.
    } catch (requestError) { setError(requestError.message); }
  };

  const downloadReport = useCallback(async () => {
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
    const RED    = [185, 28,  28];   // #b91c1c
    const AMBER  = [161, 98,  7];    // #a16207
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

    // ── Helper: truncate at a word boundary so PDF cells never end mid-word ──
    const truncateWords = (text, max) => {
      if (!text || text.length <= max) return text || '';
      const cut = text.slice(0, max);
      const lastSpace = cut.lastIndexOf(' ');
      return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut) + '…';
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
            xss_stored: 'OWASP', nosql_injection: 'OWASP',
            path_traversal: 'OWASP', prototype_pollution: 'OWASP',
            auth_bruteforce: 'STRIDE', csrf_stateless: 'OWASP',
            prompt_injection: 'AI / OWASP', pii_ai_prompts: 'AI / Privacy',
            ai_quota: 'AI / API', jwt_security: 'Auth / JWT',
            headers_security: 'OWASP', email_enumeration: 'OWASP',
            sensitive_data: 'OWASP', rate_limit_lockout: 'STRIDE',
          }[m.key] || '—',
          // Truncate at a word boundary so cells never end mid-word
          truncateWords(m.detail || '', 140),
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
          1: { cellWidth: 36 },
          2: { cellWidth: 24 },
          3: { cellWidth: 'auto', fontSize: 7 },
          4: { cellWidth: 26, halign: 'right' },
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
  }, [overview, security, request]);

  // expose download so SecurityStatus can call it
  const downloadReportRef = useRef(downloadReport);
  useEffect(() => { downloadReportRef.current = downloadReport; }, [downloadReport]);

  const signOut = useCallback(() => { localStorage.removeItem('adminToken'); localStorage.removeItem('admin'); navigate('/admin/login'); }, [navigate]);
  const signOutRef = useRef(signOut);
  useEffect(() => {
    signOutRef.current = signOut;
  }, [signOut]);

  // Stable expire callback for the countdown badge (avoids re-subscribing it)
  const handleIdleExpire = useCallback(() => {
    signOutRef.current();
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('admin') || !localStorage.getItem('adminToken')) {
      navigate('/admin/login');
      return undefined;
    }

    // Activity only pushes the shared deadline — the memoized badge
    // re-renders on its own ticker, not the whole dashboard.
    const resetIdleTimer = () => {
      idleDeadlineRef.current = Date.now() + ADMIN_IDLE_LIMIT_SECONDS * 1000;
    };
    const activityEvents = ['keydown', 'mousedown', 'mousemove', 'scroll', 'touchstart', 'pointerdown', 'focus'];
    const handleActivity = () => resetIdleTimer();
    resetIdleTimer();

    activityEvents.forEach(eventName => window.addEventListener(eventName, handleActivity, { passive: true }));
    return () => {
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

  const unlockUser = async (user) => {
    try {
      const data = await request(`/users/${user._id}/lockout`, { method: 'DELETE' });
      // Re-fetch authoritative state instead of optimistic "Clear" — if a
      // network-level hold remains, the row must keep showing Locked.
      await loadUsers();
      setError('');
      return data;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    }
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

  const markAllAdminRead = async () => {
    try {
      await request('/notifications/read-all', { method: 'POST' });
      setNotifications([]);
      setUnreadCount(0);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const deleteAdminNotification = async (event, notificationId) => {
    event.stopPropagation();
    try {
      await request(`/notifications/${notificationId}`, { method: 'DELETE' });
      setNotifications(current => current.filter(n => n._id !== notificationId));
      setUnreadCount(current => Math.max(0, current - 1));
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleNotificationClick = (notification) => {
    // Severe flags deep-link to Assessment Management (user list pre-fetches there)
    if (notification.type === 'severe-flag') {
      handleTabClick('assessment-management');
    } else if (notification.type === 'security') {
      setTab('security');
    }
    if (notification._id) {
      markAsRead(notification._id);
    }
    setShowNotifications(false);
  };

  const handleTabClick = (item) => {
    setTab(item);
    // Pre-fetch full lists the first time heavy tabs are opened
    if (item === 'assessment-management' && allUsers.length === 0) {
      request('/users?search=').then(data => {
        setAllUsers(data.users || []);
      }).catch(() => {});
    }
    if (item === 'admins' && admins.length === 0) {
      loadAdmins();
    }
  };

  const TAB_LABEL = {
    overview: 'Overview',
    users: 'User management',
    admins: 'Admin management',
    'assessment-management': 'Assessment Management',
    ai: 'AI management',
    profile: 'Profile',
    security: 'Security',
  };

  return (
    <div className={`admin-shell${sidebarCollapsed ? ' admin-shell--collapsed' : ''}`}>

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
              onClick={() => setSidebarCollapsed(v => {
                const next = !v;
                localStorage.setItem('adminSidebarCollapsed', String(next));
                return next;
              })}
            >
              {sidebarCollapsed ? (
                <svg key="menu" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="hamburger-icon">
                  <line x1="3" y1="6"  x2="21" y2="6"/>
                  <line x1="3" y1="12" x2="21" y2="12"/>
                  <line x1="3" y1="18" x2="21" y2="18"/>
                </svg>
              ) : (
                <svg key="back" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="hamburger-icon">
                  <polyline points="15 18 9 12 15 6"/>
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
              <div className="admin-notif-panel__header">
                <h3>System notifications</h3>
                {notifications.length > 0 && (
                  <button
                    type="button"
                    className="admin-notif-panel__action"
                    onClick={markAllAdminRead}
                  >
                    Mark all as read
                  </button>
                )}
              </div>
              {notifications.length
                ? notifications.map((notification, index) => (
                    <div
                      className={`notification${notification.type === 'severe-flag' ? ' notification--flag' : ''}`}
                      key={`${notification.title}-${index}`}
                      onClick={() => handleNotificationClick(notification)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleNotificationClick(notification);
                      }}
                      title={notification.type === 'severe-flag' ? 'Open Assessment Management' : notification.type === 'security' ? 'Open Security tab' : 'Dismiss'}
                    >
                      <strong>{notification.title}</strong>
                      <span>{notification.detail}</span>
                      <button
                        type="button"
                        className="notification__delete"
                        aria-label="Delete notification"
                        onClick={(e) => notification._id && deleteAdminNotification(e, notification._id)}
                      >
                        ×
                      </button>
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
                  : tab === 'admins'           ? 'Admin management'
                  : tab === 'security'         ? 'Security center'
                  : tab === 'profile'          ? 'Administrator profile'
                  : 'Assessment Management'}
              </h1>
            </div>
          </header>

          <AdminIdleStatus deadlineRef={idleDeadlineRef} onExpire={handleIdleExpire} onActivity={handleIdleExpire} />

          {error && <div className="admin-alert danger">{error}</div>}

          {tab === 'overview'               && overview && <div className="admin-tab-panel"><Overview overview={overview} /></div>}
          {tab === 'users'                  && <div className="admin-tab-panel"><Users users={users} usersFetchedAt={usersFetchedAt} search={search} setSearch={value => { searchRef.current = value; setSearch(value); }} loadUsers={loadUsers} setSubscriptionPlan={setSubscriptionPlan} planLabels={PLAN_LABELS} updateAccount={updateAccount} deleteAccount={deleteAccount} unlockUser={unlockUser} expandedUser={expandedUser} setExpandedUser={setExpandedUser} /></div>}
          {tab === 'admins'                 && <div className="admin-tab-panel"><Admins admins={admins} adminsFetchedAt={adminsFetchedAt} search={adminSearch} setSearch={value => { adminSearchRef.current = value; setAdminSearch(value); }} loadAdmins={loadAdmins} toggleAdmin={toggleAdmin} unlockAdmin={unlockAdmin} currentAdminId={profile && profile._id} expandedAdmin={expandedAdmin} setExpandedAdmin={setExpandedAdmin} /></div>}
          {tab === 'assessment-management'  && <div className="admin-tab-panel"><AssessmentManagement users={allUsers} /></div>}
          {tab === 'ai'                     && <div className="admin-tab-panel"><AiPanel ai={ai} /></div>}
          {tab === 'security'               && <div className="admin-tab-panel"><SecurityStatus adminRequest={request} onDownloadReport={() => downloadReportRef.current()} /></div>}
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
  const analytics = overview.analytics || {};
  const trend = Array.isArray(overview.assessmentTrend) ? overview.assessmentTrend : [];
  const trendMax = Math.max(1, ...trend.map(t => t.count || 0));
  const plans = analytics.planBreakdown || {};
  const planTotal = Math.max(1, (plans.free || 0) + (plans.monthly || 0) + (plans.annual || 0) + (plans.custom || 0));
  const planRows = [
    { key: 'free', label: 'Basic', value: plans.free || 0, color: '#9ca3af' },
    { key: 'monthly', label: 'Deluxe', value: plans.monthly || 0, color: '#4f6bed' },
    { key: 'annual', label: 'Premium', value: plans.annual || 0, color: '#0891b2' },
    { key: 'custom', label: 'Ultimate', value: plans.custom || 0, color: '#16a34a' },
  ];
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

      {/* ── Analytics ─────────────────────────────────────────────── */}
      <section className="ov-analytics-grid">

        {/* Assessment activity (14 days) */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <h3>Assessment activity</h3>
            <span className="ov-panel-count">14 days</span>
          </div>
          {trend.length === 0 ? (
            <p className="ov-empty">No assessments yet.</p>
          ) : (
            <div className="ov-bars" role="img" aria-label={`Assessments per day, peak ${trendMax}`}>
              {trend.map(day => (
                <div className="ov-bar-col" key={day._id} title={`${day._id}: ${day.count}`}>
                  <div className="ov-bar-track">
                    <div
                      className="ov-bar-fill"
                      style={{ height: `${Math.max(4, Math.round(((day.count || 0) / trendMax) * 100))}%` }}
                    />
                  </div>
                  <span className="ov-bar-value">{day.count || 0}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Plan mix */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <h3>Plan mix</h3>
            <span className="ov-panel-count">{planTotal} total</span>
          </div>
          <div className="ov-plans">
            {planRows.map(plan => (
              <div className="ov-plan-row" key={plan.key}>
                <span className="ov-plan-label">{plan.label}</span>
                <div className="ov-plan-track">
                  <div
                    className="ov-plan-fill"
                    style={{ width: `${Math.round((plan.value / planTotal) * 100)}%`, background: plan.color }}
                  />
                </div>
                <strong className="ov-plan-value">{plan.value}</strong>
              </div>
            ))}
          </div>
        </div>

        {/* Security & growth */}
        <div className="admin-panel ov-analytics">
          <div className="ov-panel-header">
            <h3>Security &amp; growth</h3>
          </div>
          <div className="ov-stats">
            <div className="ov-stat">
              <strong className="ov-stat__value">{analytics.twoFactorPct ?? 0}%</strong>
              <span className="ov-stat__label">2FA adoption</span>
            </div>
            <div className="ov-stat">
              <strong className="ov-stat__value">{analytics.lockedAccounts ?? 0}</strong>
              <span className="ov-stat__label">Locked now</span>
            </div>
            <div className="ov-stat">
              <strong className="ov-stat__value">{analytics.signups7d ?? 0}</strong>
              <span className="ov-stat__label">New (7d)</span>
            </div>
            <div className="ov-stat">
              <strong className="ov-stat__value">{analytics.signups30d ?? 0}</strong>
              <span className="ov-stat__label">New (30d)</span>
            </div>
          </div>
        </div>

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
                        {user.subscriptionActive ? 'Active' : 'Basic Package'}
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

// Display helper: strip IPv6-mapped IPv4 prefix from stored IPs
function formatIp(raw) {
  if (!raw) return '';
  const ip = String(raw).trim();
  return ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
}

// Deterministic avatar colour from a display name (shared by Users + Admins)
function avatarColorFor(name = '') {
  const palette = ['#4f6bed', '#e85d75', '#2e9e6b', '#d46b35', '#7c4ddb', '#0891b2', '#b45309', '#be185d'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

// Live lockout badge: ticks every second against fetchedAt + remainingSeconds
// so the countdown is realtime between server polls. It never disappears on
// its own — when it hits zero it asks the server for fresh state, and only
// flips to Clear once the server confirms the lock is gone.
function LockoutCountdown({ remainingSeconds, fetchedAt, lockedBy, ips, onExpired }) {
  // expiresAt derives purely from props (fetchedAt is a timestamp number, so
  // no Date.now() in render). `now` starts via lazy initializer and advances
  // on a 1 s subscription — both linter-safe patterns.
  const expiresAt = (Number(fetchedAt) || 0) + Math.max(0, Number(remainingSeconds) || 0) * 1000;
  const [now, setNow] = useState(() => Date.now());
  const expiredRef = useRef(false);
  const onExpiredRef = useRef(onExpired);
  useEffect(() => {
    onExpiredRef.current = onExpired;
  }, [onExpired]);
  useEffect(() => {
    expiredRef.current = false;
  }, [fetchedAt, remainingSeconds]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const leftSec = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  useEffect(() => {
    if (leftSec <= 0 && !expiredRef.current) {
      expiredRef.current = true;
      if (onExpiredRef.current) onExpiredRef.current();
    }
  }, [leftSec]);
  const label = leftSec >= 90
    ? `Locked · ${Math.ceil(leftSec / 60)} min left`
    : leftSec >= 60
      ? 'Locked · 1 min left'
      : `Locked · ${leftSec}s left`;
  return (
    <span
      className="lockout-badge lockout-badge--locked"
      title={(ips && ips.length > 0 ? `IPs: ${ips.join(', ')}` : 'IP logging pending') + (lockedBy === 'network' ? ' — network-level hold' : ' — rotating IPs will not bypass this account lock')}
    >
      {label}
    </span>
  );
}

function Users({ users, usersFetchedAt, search, setSearch, loadUsers, setSubscriptionPlan, planLabels, updateAccount, deleteAccount, unlockUser, expandedUser, setExpandedUser }) {
  const handleUserToggle = (userId) => {
    setExpandedUser(expandedUser === userId ? null : userId);
  };

  // Generate initials avatar colour from name (deterministic, shared helper)
  const avatarColor = avatarColorFor;

  // Netflix-style instant search: fetch as they type (400 ms debounce).
  // Skips the first render (the list already loads with the dashboard).
  const firstRender = useRef(true);
  const debounceTimer = useRef(null);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return undefined; }
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => { loadUsers(); }, 400);
    return () => window.clearTimeout(debounceTimer.current);
  }, [search, loadUsers]);

  // Search button: run immediately instead of waiting for the debounce.
  const flushSearch = () => {
    window.clearTimeout(debounceTimer.current);
    loadUsers();
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
          <button className="admin-secondary" onClick={flushSearch}>Search</button>
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
                      <small>
                        {user.device && user.device !== 'Unknown device'
                          ? user.device
                          : (user.lastLoginIp ? `IP ${formatIp(user.lastLoginIp)}` : 'Unknown device')}
                      </small>
                    </div>
                    <div className="user-detail-item">
                      <strong>Location</strong>
                      <span>{user.lastLoginLocation || 'Unknown'}</span>
                      {(!user.lastLoginLocation || user.lastLoginLocation === 'Unknown location') && user.lastLoginIp && (
                        <small>IP {formatIp(user.lastLoginIp)}</small>
                      )}
                    </div>
                    <div className="user-detail-item">
                      <strong>Subscription</strong>
                      <span className={`subscription-status-badge${user.subscriptionActive ? ' subscription-status-badge--active' : ''}`}>
                        {user.subscriptionActive ? 'Subscribed ✓' : 'Basic Package'}
                      </span>
                      <label className="subscription-plan-label" htmlFor={`plan-${user._id}`}>
                        Plan — select to change
                      </label>
                      <select
                        id={`plan-${user._id}`}
                        className="subscription-plan-select"
                        value={user.subscriptionPlan || 'free'}
                        onChange={event => setSubscriptionPlan(user, event.target.value)}
                      >
                        <option value="free">{planLabels.free}</option>
                        <option value="monthly">{planLabels.monthly}</option>
                        <option value="annual">{planLabels.annual}</option>
                        <option value="custom">{planLabels.custom}</option>
                      </select>
                    </div>
                    <div className="user-detail-item">
                      <strong>Role</strong>
                      <span style={{ textTransform: 'capitalize' }}>{user.accountRole || 'User'}</span>
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
                    <div className="user-detail-item">
                      <strong>Lockout Status</strong>
                      {user.lockout && user.lockout.locked ? (
                        <>
                          <LockoutCountdown
                            remainingSeconds={user.lockout.remainingSeconds || 0}
                            fetchedAt={usersFetchedAt}
                            lockedBy={user.lockout.lockedBy}
                            ips={user.lockout.ips}
                            onExpired={loadUsers}
                          />
                          <button
                            type="button"
                            className="lockout-unlock-btn"
                            onClick={() => unlockUser(user)}
                          >
                            Unlock now
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="lockout-badge lockout-badge--clear">Clear — can sign in</span>
                          <button
                            type="button"
                            className="lockout-reset-btn"
                            title="Clear any accumulated failed-attempt strikes for this account"
                            onClick={() => unlockUser(user)}
                          >
                            Reset attempts
                          </button>
                        </>
                      )}
                    </div>
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

// Same card-box UI as Users, but for administrator accounts. Passwords and
// authenticator secrets are never sent by the server, so they can't display.
function Admins({ admins, adminsFetchedAt, search, setSearch, loadAdmins, toggleAdmin, unlockAdmin, currentAdminId, expandedAdmin, setExpandedAdmin }) {
  const handleAdminToggle = (adminId) => {
    setExpandedAdmin(expandedAdmin === adminId ? null : adminId);
  };

  // Netflix-style instant search: fetch as they type (400 ms debounce).
  // Skips the first render (the list already loads when the tab opens).
  const firstRender = useRef(true);
  const debounceTimer = useRef(null);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return undefined; }
    window.clearTimeout(debounceTimer.current);
    debounceTimer.current = window.setTimeout(() => { loadAdmins(); }, 400);
    return () => window.clearTimeout(debounceTimer.current);
  }, [search, loadAdmins]);

  // Search button: run immediately instead of waiting for the debounce.
  const flushSearch = () => {
    window.clearTimeout(debounceTimer.current);
    loadAdmins();
  };

  return (
    <section className="admin-panel">
      <div className="panel-heading">
        <div>
          <h3>Admins</h3>
          <p className="admin-muted">Manage administrator access. Passwords and authenticator secrets are never displayed.</p>
        </div>
        <div className="search-row">
          <input placeholder="Search admins" value={search} onChange={event => setSearch(event.target.value)} />
          <button className="admin-secondary" onClick={flushSearch}>Search</button>
        </div>
      </div>

      <div className="user-list">
        {admins.length === 0 && (
          <p className="admin-muted" style={{ padding: '20px 0' }}>No administrators found.</p>
        )}
        {admins.map(admin => {
          const name = admin.alias || 'Unknown';
          const initials = name.slice(0, 2).toUpperCase();
          const isOpen = expandedAdmin === admin._id;
          const isSelf = currentAdminId && String(admin._id) === String(currentAdminId);

          return (
            <div key={admin._id} className={`user-item${isOpen ? ' user-item--open' : ''}`}>
              {/* ── Collapsed row ───────────────────────────────────── */}
              <button
                className="user-row"
                onClick={() => handleAdminToggle(admin._id)}
                aria-expanded={isOpen}
              >
                {/* Avatar */}
                <span
                  className="user-avatar user-avatar--initials"
                  style={{ background: avatarColorFor(name), display: 'flex' }}
                  aria-hidden="true"
                >
                  {initials}
                </span>

                {/* Name + joined */}
                <span className="user-row__info">
                  <span className="user-row__name">{name}{isSelf ? ' (you)' : ''}</span>
                  <span className="user-row__sub">Joined: {admin.createdAt ? new Date(admin.createdAt).toLocaleDateString() : '—'}</span>
                </span>

                {/* Status badge */}
                {!admin.enabled && (
                  <span className="user-status-badge user-status-badge--disabled">
                    disabled
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
                      <strong>Alias</strong>
                      <span>{name}</span>
                    </div>
                    <div className="user-detail-item">
                      <strong>Status</strong>
                      <span className={admin.enabled ? 'security-active' : 'security-email'}>
                        {admin.enabled ? 'Enabled — can sign in' : 'Disabled — cannot sign in'}
                      </span>
                    </div>
                    <div className="user-detail-item">
                      <strong>Last Login</strong>
                      <span>{admin.lastLoginAt ? new Date(admin.lastLoginAt).toLocaleString() : 'Never'}</span>
                    </div>
                    <div className="user-detail-item">
                      <strong>Last Activity</strong>
                      <span>{admin.lastActivityAt ? new Date(admin.lastActivityAt).toLocaleString() : 'Never'}</span>
                    </div>
                    <div className="user-detail-item">
                      <strong>Lockout Status</strong>
                      {admin.lockout && admin.lockout.locked ? (
                        <>
                          <LockoutCountdown
                            remainingSeconds={admin.lockout.remainingSeconds || 0}
                            fetchedAt={adminsFetchedAt}
                            lockedBy="account"
                            ips={admin.lockout.ips}
                            onExpired={loadAdmins}
                          />
                          <button
                            type="button"
                            className="lockout-unlock-btn"
                            onClick={() => unlockAdmin(admin)}
                          >
                            Unlock now
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="lockout-badge lockout-badge--clear">Clear — can sign in</span>
                          <button
                            type="button"
                            className="lockout-reset-btn"
                            title="Clear any accumulated failed-attempt strikes for this administrator"
                            onClick={() => unlockAdmin(admin)}
                          >
                            Reset attempts
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {!isSelf && (
                    <div className="user-actions">
                      <button
                        className={admin.enabled ? 'status danger-action' : 'admin-secondary'}
                        onClick={() => toggleAdmin(admin)}
                        title={admin.enabled ? 'Disable this administrator (they will be signed out)' : 'Re-enable this administrator'}
                      >
                        {admin.enabled ? 'Disable admin' : 'Enable admin'}
                      </button>
                    </div>
                  )}
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
function EyeIcon({ open }) {
  return open ? (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

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

  // Eye icon (module scope — creating it inside ProfilePanel resets state on every render)
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