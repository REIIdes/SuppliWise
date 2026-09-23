import { useCallback, useEffect, useRef, useState } from 'react';
import './SecurityStatus.css';

// ── Status pill — matches the existing Security Checks pill style ──────────
const MONITOR_STATUS_META = {
  healthy:  { label: 'Healthy',   cls: 'pill--healthy'  },
  warning:  { label: 'Warning',   cls: 'pill--warning'  },
  critical: { label: 'Critical',  cls: 'pill--critical' },
  error:    { label: 'Error',     cls: 'pill--error'    },
  loading:  { label: 'Checking…', cls: 'pill--loading'  },
};

// Maps each monitor key → the "Security Implement" column text (mirrors the
// framework column in the existing Security Checks table)
const MONITOR_FRAMEWORK = {
  login:              'Auth / JWT',
  account_creation:   'Auth / Email',
  email_otp:          'STRIDE',
  totp:               'STRIDE',
  database:           'Infrastructure',
  openrouter:         'AI / API',
  delete_account:     'OWASP',
  input_sanitization: 'OWASP',
  password_hashing:   'OWASP',
  salting:            'OWASP',
  xss_stored:         'OWASP',
  nosql_injection:    'OWASP',
  path_traversal:     'OWASP',
  prototype_pollution: 'OWASP',
  auth_bruteforce:    'STRIDE',
  csrf_stateless:     'OWASP',
  prompt_injection:   'AI / OWASP',
  pii_ai_prompts:     'AI / Privacy',
  ai_quota:           'AI / API',
  jwt_security:       'Auth / JWT',
  headers_security:   'OWASP',
  email_enumeration:  'OWASP',
  sensitive_data:     'OWASP',
  rate_limit_lockout: 'STRIDE',
};

// Full label for the Description column title
const MONITOR_LABEL = {
  login:              'Login System',
  account_creation:   'Account Creation',
  email_otp:          'Email OTP (Login Security)',
  totp:               'Google Authenticator (TOTP)',
  database:           'Database Connectivity',
  openrouter:         'OpenRouter API Connectivity',
  delete_account:     'Account Deletion (Soft-delete)',
  input_sanitization: 'Input Sanitization & Validation',
  password_hashing:   'Password Hashing (bcrypt)',
  salting:            'Password Salting (bcrypt built-in)',
  xss_stored:         'XSS — Stored Markup',
  nosql_injection:    'NoSQL Injection',
  path_traversal:     'Path Traversal',
  prototype_pollution: 'Prototype Pollution',
  auth_bruteforce:    'Auth Brute Force + Replay',
  csrf_stateless:     'CSRF — Stateless Auth',
  prompt_injection:   'Prompt Injection (AI)',
  pii_ai_prompts:     'PII in AI Prompts',
  ai_quota:           'AI Quota Abuse',
  jwt_security:       'JWT Strength & Lifetime',
  headers_security:   'Security Headers (Live)',
  email_enumeration:  'Email Enumeration',
  sensitive_data:     'Sensitive Data Exposure',
  rate_limit_lockout: 'Rate-Limit Lockouts',
};

// Implementation path shown below the label — mirrors existing table
const MONITOR_IMPL = {
  login:              'routes/auth.js · middleware/auth.js',
  account_creation:   'routes/auth.js · utils/email.js',
  email_otp:          'routes/auth.js · utils/email.js',
  totp:               'routes/auth.js · speakeasy',
  database:           'server/index.js · mongoose',
  openrouter:         'routes/recommend.js · openrouter.ai',
  delete_account:     'routes/admin.js · models/User.js',
  input_sanitization: 'utils/sanitize.js · routes/auth.js',
  password_hashing:   'models/User.js · bcryptjs (cost 12)',
  salting:            'models/User.js · bcryptjs (built-in salt)',
  xss_stored:         'utils/sanitize.js · stripTags',
  nosql_injection:    'routes/auth.js · str() coercion',
  path_traversal:     'server/index.js · no static serving',
  prototype_pollution: 'utils/sanitize.js · scrubKeys',
  auth_bruteforce:    'utils/totp.js · rate-limit',
  csrf_stateless:     'middleware/auth.js · JWT header',
  prompt_injection:   'routes/recommend.js · promptSafe',
  pii_ai_prompts:     'routes/recommend.js · no identity fields',
  ai_quota:           'server/index.js · aiLimiter',
  jwt_security:       'routes/auth.js · 12 h JWT',
  headers_security:   'server/index.js · helmet',
  email_enumeration:  'routes/auth.js · generic responses',
  sensitive_data:     'middleware/auth.js · projection',
  rate_limit_lockout: 'utils/lockout.js · 15m→1d ladder',
};

// Display order — same visual grouping as before but shown as table sections
const MONITOR_ORDER = [
  'login',
  'account_creation',
  'email_otp',
  'totp',
  'database',
  'openrouter',
  'delete_account',
  'input_sanitization',
  'password_hashing',
  'salting',
  'xss_stored',
  'nosql_injection',
  'path_traversal',
  'prototype_pollution',
  'auth_bruteforce',
  'csrf_stateless',
  'prompt_injection',
  'pii_ai_prompts',
  'ai_quota',
  'jwt_security',
  'headers_security',
  'email_enumeration',
  'sensitive_data',
  'rate_limit_lockout',
];

// ── Pill badge (same look as existing .status-label pills) ────────────────
function MonitorPill({ status }) {
  const meta = MONITOR_STATUS_META[status] || MONITOR_STATUS_META.loading;
  return <span className={`rt-pill ${meta.cls}`}>{meta.label}</span>;
}

// ── Sync icon SVG ─────────────────────────────────────────────────────────
function SyncIcon({ spinning }) {
  return (
    <svg
      className={`rt-sync-icon${spinning ? ' rt-sync-icon--spin' : ''}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="1 4 1 10 7 10" />
      <polyline points="23 20 23 14 17 14" />
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10M23 14l-4.64 4.36A9 9 0 0 1 3.51 15" />
    </svg>
  );
}

// ── Expandable detail row ────────────────────────────────────────────────
function MonitorRow({ monitor }) {
  const [open, setOpen] = useState(false);
  const key    = monitor.key;
  const status = monitor.status || 'loading';
  const label  = monitor.label  || MONITOR_LABEL[key]  || key;
  const impl   = MONITOR_IMPL[key] || '';
  const fw     = MONITOR_FRAMEWORK[key] || '—';

  return (
    <>
      <tr
        className={`rt-row rt-row--${status}${open ? ' rt-row--open' : ''}`}
        onClick={() => setOpen(v => !v)}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onKeyDown={e => (e.key === 'Enter' || e.key === ' ') && setOpen(v => !v)}
        title="Click to see details"
      >
        {/* STATUS */}
        <td className="rt-td rt-td--status">
          <MonitorPill status={status} />
        </td>

        {/* SECURITY IMPLEMENT */}
        <td className="rt-td rt-td--fw">{fw}</td>

        {/* DESCRIPTION / IMPLEMENTATION */}
        <td className="rt-td rt-td--desc">
          <div className="rt-desc">
            <strong>{label}</strong>
            <span className="rt-impl">{impl}</span>
          </div>
          {monitor.latencyMs != null && (
            <span className="rt-latency">{monitor.latencyMs} ms</span>
          )}
          <span className="rt-chevron" aria-hidden="true">{open ? '▲' : '▼'}</span>
        </td>
      </tr>

      {open && (
        <tr className="rt-detail-row">
          <td colSpan={3} className="rt-detail-cell">
            <p className="rt-detail-text">{monitor.detail || '—'}</p>
            {monitor.checkedAt && (
              <p className="rt-detail-ts">
                Checked at {new Date(monitor.checkedAt).toLocaleTimeString()}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Overall status banner ─────────────────────────────────────────────────
const BANNER_META = {
  healthy:  { label: 'All Systems Healthy',  color: '#16a34a', bg: '#f0fdf4', dot: 'dot--healthy'  },
  warning:  { label: 'Some Warnings',        color: '#d97706', bg: '#fffbeb', dot: 'dot--warning'  },
  critical: { label: 'Critical Issues',      color: '#dc2626', bg: '#fef2f2', dot: 'dot--critical' },
  error:    { label: 'Probe Error',          color: '#7c3aed', bg: '#faf5ff', dot: 'dot--error'    },
  loading:  { label: 'Checking…',            color: '#6b7280', bg: '#f9fafb', dot: 'dot--loading'  },
};

function OverallBanner({ status, syncedAt, syncing, onSync, onDownload }) {
  const meta = BANNER_META[status] || BANNER_META.loading;
  return (
    <div className="rt-banner" style={{ '--rt-color': meta.color, '--rt-bg': meta.bg }}>
      <div className="rt-banner__left">
        <span className={`rt-dot ${meta.dot}`} aria-hidden="true" />
        <div>
          <p className="rt-banner__eyebrow">Live Monitor Status</p>
          <p className="rt-banner__label">{meta.label}</p>
        </div>
      </div>

      <div className="rt-banner__right">
        {syncedAt && (
          <p className="rt-banner__ts">
            Last synced: <strong>{new Date(syncedAt).toLocaleTimeString()}</strong>
          </p>
        )}
        <button
          className="rt-sync-btn"
          onClick={onSync}
          disabled={syncing}
          aria-label="Sync security monitor"
          title="Refresh all monitors now"
        >
          <SyncIcon spinning={syncing} />
          {syncing ? 'Syncing…' : 'Sync Now'}
        </button>
        {onDownload && (
          <button
            className="rt-download-btn"
            onClick={onDownload}
            aria-label="Download security report PDF"
            title="Download full security report as PDF"
          >
            <svg className="rt-download-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download Report
          </button>
        )}
      </div>
    </div>
  );
}

// ── Severity chip for audit findings ──────────────────────────────────────
const SEVERITY_META = {
  critical:      { label: 'Critical',      cls: 'aud-chip--critical' },
  high:          { label: 'High',          cls: 'aud-chip--high' },
  medium:        { label: 'Medium',        cls: 'aud-chip--medium' },
  low:           { label: 'Low',           cls: 'aud-chip--low' },
  informational: { label: 'Informational', cls: 'aud-chip--info' },
};

function SeverityChip({ severity }) {
  const meta = SEVERITY_META[severity] || SEVERITY_META.informational;
  return <span className={`aud-chip ${meta.cls}`}>{meta.label}</span>;
}

// ── Audit record — the permanent entry for the completed security audit ───
// The probes above answer "is the system healthy right now". This answers
// "what did a human review find, what changed, and what is still open" —
// including the findings that were deliberately left unfixed.
function AuditRecord({ audit }) {
  if (!audit) return null;

  const counts = audit.counts || {};
  const countCards = [
    ['Critical',      counts.critical,      'aud-stat--critical'],
    ['High',          counts.high,          'aud-stat--high'],
    ['Medium',        counts.medium,        'aud-stat--medium'],
    ['Low',           counts.low,           'aud-stat--low'],
    ['Informational', counts.informational, 'aud-stat--info'],
    ['Total',         counts.total,         'aud-stat--total'],
    ['Remediated',    counts.remediatedInCode, 'aud-stat--fixed'],
    ['Open / accepted', counts.openOrAccepted,  'aud-stat--open'],
  ];

  const verification = Object.entries(audit.verification || {});

  return (
    <section className="rt-section aud-section">
      <div className="rt-header">
        <div className="rt-header__title-wrap">
          <svg className="rt-header__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            <polyline points="9 12 11 14 15 10" />
          </svg>
          <h2 className="rt-header__title">Security Audit Record</h2>
        </div>
        <p className="rt-header__sub">
          {audit.title} · <strong>{audit.id}</strong> · conducted {audit.conductedAt}
        </p>
      </div>

      <p className="aud-scope">{audit.scope}</p>

      {/* Severity breakdown */}
      <div className="aud-stats">
        {countCards.map(([label, value, cls]) => (
          <div className={`aud-stat ${cls}`} key={label}>
            <span className="aud-stat__value">{value ?? '—'}</span>
            <span className="aud-stat__label">{label}</span>
          </div>
        ))}
      </div>

      {/* Phases */}
      <details className="aud-block">
        <summary>Method — {audit.phases?.length || 0} phases</summary>
        <ol className="aud-list">
          {(audit.phases || []).map(p => <li key={p}>{p}</li>)}
        </ol>
      </details>

      {/* Headline findings */}
      <details className="aud-block">
        <summary>Key findings — {audit.headlineFindings?.length || 0} reported</summary>
        <ul className="aud-findings">
          {(audit.headlineFindings || []).map(f => (
            <li key={f.id} className="aud-finding">
              <div className="aud-finding__head">
                <SeverityChip severity={f.severity} />
                <code className="aud-finding__id">{f.id}</code>
                <strong>{f.title}</strong>
              </div>
              <p className="aud-finding__detail">{f.detail}</p>
              <p className={`aud-finding__status${/fixed/i.test(f.status || '') ? ' aud-finding__status--fixed' : ''}`}>
                {f.status}
              </p>
            </li>
          ))}
        </ul>
      </details>

      {/* Remediations */}
      <details className="aud-block">
        <summary>Changes applied — {audit.remediations?.length || 0} fixes</summary>
        <ul className="aud-list aud-list--code">
          {(audit.remediations || []).map(r => <li key={r}>{r}</li>)}
        </ul>
      </details>

      {/* Open / accepted */}
      <details className="aud-block" open>
        <summary>Open &amp; accepted items — {audit.openItems?.length || 0}</summary>
        <ul className="aud-findings">
          {(audit.openItems || []).map(f => (
            <li key={f.id} className="aud-finding">
              <div className="aud-finding__head">
                <SeverityChip severity={f.severity} />
                <code className="aud-finding__id">{f.id}</code>
                <strong>{f.title}</strong>
              </div>
              <p className="aud-finding__detail">{f.note}</p>
            </li>
          ))}
        </ul>
      </details>

      {/* Verification */}
      <details className="aud-block" open>
        <summary>Automated verification (Phase 5)</summary>
        <ul className="aud-checks">
          {verification.map(([k, v]) => (
            <li key={k} className={/PASS/i.test(String(v)) ? 'aud-check aud-check--pass' : 'aud-check'}>
              <span className="aud-check__key">{k}</span>
              <span className="aud-check__val">{v}</span>
            </li>
          ))}
        </ul>
      </details>

      {/* Manual actions */}
      <div className="aud-manual">
        <p className="aud-manual__title">
          ⚠ Manual action required — {audit.manualActions?.length || 0} item(s)
        </p>
        <ul className="aud-list">
          {(audit.manualActions || []).map(a => <li key={a}>{a}</li>)}
        </ul>
      </div>

      {/* Disclaimer — never claim the app is fully secure */}
      <p className="aud-disclaimer">{audit.disclaimer}</p>

      {audit.report && (
        <p className="aud-report">
          Full written report: <code>{audit.report}</code>
        </p>
      )}
    </section>
  );
}

// ── Main Component ────────────────────────────────────────────────────────
const SecurityStatus = ({ adminRequest, onDownloadReport }) => {
  const [monitors,             setMonitors]             = useState([]);
  const [overallMonitorStatus, setOverallMonitorStatus] = useState('loading');
  const [syncedAt,             setSyncedAt]             = useState(null);
  const [syncing,              setSyncing]              = useState(false);
  const [monitorError,         setMonitorError]         = useState('');
  const [audit,                setAudit]                = useState(null);
  const intervalRef = useRef(null);

  const fetchMonitor = useCallback(async (force = false) => {
    if (!adminRequest) return;
    setSyncing(true);
    setMonitorError('');
    try {
      const data = await adminRequest(`/security/monitor${force ? '?fresh=1' : ''}`);
      setMonitors(data.monitors || []);
      setOverallMonitorStatus(data.overallMonitorStatus || 'healthy');
      setSyncedAt(data.syncedAt || new Date().toISOString());
      // Static record of the completed audit (rarely changes — only replace
      // when the API actually sent one, so a stale-but-valid record never
      // flashes away between the 30 s polls).
      if (data.audit) setAudit(data.audit);
    } catch (err) {
      setMonitorError(err.message || 'Unable to load monitor data.');
    } finally {
      setSyncing(false);
    }
  }, [adminRequest]);

  // Initial load + auto-refresh every 30 s
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initial data fetch on mount
    fetchMonitor(false);
    intervalRef.current = window.setInterval(() => fetchMonitor(false), 30000);
    return () => window.clearInterval(intervalRef.current);
  }, [fetchMonitor]);

  // (adminRequest-based live monitor is the source of truth)

  // Build ordered rows — include skeleton placeholders while loading
  const orderedMonitors = MONITOR_ORDER.map(key => {
    const found = monitors.find(m => m.key === key);
    return found || { key, label: MONITOR_LABEL[key], status: 'loading', detail: '', latencyMs: null, checkedAt: null };
  });

  return (
    <div className="security-status-container">

      {/* ════════════════════════════════════════════════════════════════
          REAL-TIME MONITOR
      ════════════════════════════════════════════════════════════════ */}
      <section className="rt-section">

        {/* Header row — title + download button side by side */}
        <div className="rt-header">
          <div className="rt-header__title-wrap">
            <svg className="rt-header__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            <h2 className="rt-header__title">Real-time Security Monitor</h2>
          </div>
          <p className="rt-header__sub">Live probe of all critical security functions — auto-refreshes every 30 s. Click any row to see details.</p>
        </div>

        {/* Overall status banner */}
        <OverallBanner
          status={overallMonitorStatus}
          syncedAt={syncedAt}
          syncing={syncing}
          onSync={() => fetchMonitor(true)}
          onDownload={onDownloadReport}
        />

        {/* Error message */}
        {monitorError && (
          <div className="rt-error" role="alert">{monitorError}</div>
        )}

        {/* Monitor table — same column structure as Security Checks */}
        <div className="rt-table-wrap">
          <table className="rt-table">
            <thead>
              <tr>
                <th className="rt-th rt-th--status">Status</th>
                <th className="rt-th rt-th--fw">Security Implement</th>
                <th className="rt-th rt-th--desc">Description / Implementation</th>
              </tr>
            </thead>
            <tbody>
              {orderedMonitors.map(m => (
                <MonitorRow key={m.key} monitor={m} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Permanent record of the completed security audit ────────────── */}
      <AuditRecord audit={audit} />


    </div>
  );
};

export default SecurityStatus;
