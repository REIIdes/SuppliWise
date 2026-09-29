import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './SecurityStatus.css';

// ═══════════════════════════════════════════════════════════════════════════
//  SECURITY CENTER — Real-time Security Monitor + Security Audit Record
//  Every 30 s the server re-probes each of the 45 monitors (core platform +
//  the whole on-chain layer) and this panel renders the result.
//
//  Class-name prefixes used below (all plain global CSS, see the stylesheet):
//    .security-*  page container      .rt-*  real-time monitor
//    .aud-*       audit record        .rtl-* monitor toolbar
// ═══════════════════════════════════════════════════════════════════════════

// ── Status pill ───────────────────────────────────────────────────────────
const MONITOR_STATUS_META = {
  healthy:  { label: 'Healthy',   cls: 'pill--healthy'  },
  warning:  { label: 'Warning',   cls: 'pill--warning'  },
  critical: { label: 'Critical',  cls: 'pill--critical' },
  error:    { label: 'Error',     cls: 'pill--error'    },
  loading:  { label: 'Checking…', cls: 'pill--loading'  },
};

// Maps each monitor key → the "Security Implement" column text
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
  // Blockchain layer — every on-chain feature probes as its own row
  bc_ledger:          'Blockchain',
  bc_supply:          'Blockchain',
  bc_certifications:  'Blockchain',
  bc_escrow:          'Blockchain',
  bc_market:          'Blockchain',
  bc_wallet:          'Blockchain',
  bc_health_ledger:   'Blockchain',
  bc_data_consent:    'Blockchain',
  bc_storage:         'Blockchain',
  bc_rewards:         'Blockchain',
  bc_nfts:            'Blockchain',
  bc_staking:         'Blockchain',
  bc_loyalty:         'Blockchain',
  bc_dao:             'Blockchain',
  bc_knowledge:       'Blockchain',
  bc_disputes:        'Blockchain',
  bc_share_links:     'Blockchain',
  bc_ai_proof:        'Blockchain',
  bc_trials:          'Blockchain',
  bc_oracle:          'Blockchain',
  bc_experts:         'Blockchain',
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
  bc_ledger:          'PoW Ledger & Integrity',
  bc_supply:          'Supply Chain Tracking (QR)',
  bc_certifications:  'On-chain Certifications',
  bc_escrow:          'Smart-contract Escrow',
  bc_market:          'Verified P2P Marketplace',
  bc_wallet:          'Wallets / Decentralized ID',
  bc_health_ledger:   'Health Records Anchor',
  bc_data_consent:    'Data Sovereignty Consent',
  bc_storage:         'Encrypted Decentralized Storage',
  bc_rewards:         'WELL Rewards Engine',
  bc_nfts:            'Achievement NFTs',
  bc_staking:         'Token Staking',
  bc_loyalty:         'Loyalty Program',
  bc_dao:             'DAO Governance',
  bc_knowledge:       'Community Knowledge Base',
  bc_disputes:        'Dispute Resolution (jurors)',
  bc_share_links:     'Health Profile Share Links',
  bc_ai_proof:        'Verifiable AI Recommendations',
  bc_trials:          'Clinical Trial Consent',
  bc_oracle:          'Decentralized Oracles',
  bc_experts:         'Professional Bookings',
};

// Implementation path shown below the label
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
  path_traversal:     'attack_probes.js · Android SafeDownloadName',
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
  bc_ledger:          'blockchain/ledger.js · models/Web3.js (SwBlock)',
  bc_supply:          'routes/web3/supply.js (feature 1)',
  bc_certifications:  'routes/web3/supply.js (feature 2)',
  bc_escrow:          'routes/web3/market.js (feature 3)',
  bc_market:          'routes/web3/market.js (feature 4)',
  bc_wallet:          'routes/web3/chain.js · blockchain/engine.js (feature 5)',
  bc_health_ledger:   'routes/web3/data.js (feature 6)',
  bc_data_consent:    'routes/web3/data.js (feature 7)',
  bc_storage:         'routes/web3/data.js (feature 8)',
  bc_rewards:         'routes/web3/rewards.js (feature 9)',
  bc_nfts:            'routes/web3/rewards.js (feature 10)',
  bc_staking:         'routes/web3/rewards.js (feature 11)',
  bc_loyalty:         'routes/web3/rewards.js (feature 12)',
  bc_dao:             'routes/web3/govern.js (feature 13)',
  bc_knowledge:       'routes/web3/govern.js (feature 14)',
  bc_disputes:        'routes/web3/market.js (feature 15)',
  bc_share_links:     'routes/web3/data.js (feature 16)',
  bc_ai_proof:        'routes/web3/data.js (feature 17)',
  bc_trials:          'routes/web3/ecosystem.js (feature 18)',
  bc_oracle:          'routes/web3/ecosystem.js (feature 19)',
  bc_experts:         'routes/web3/ecosystem.js (feature 20)',
};

// Display order — core platform first, then the whole blockchain layer
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
  // ── Blockchain layer — the ledger anchor + all 20 Web3 features ──────────
  'bc_ledger',
  'bc_supply',
  'bc_certifications',
  'bc_escrow',
  'bc_market',
  'bc_wallet',
  'bc_health_ledger',
  'bc_data_consent',
  'bc_storage',
  'bc_rewards',
  'bc_nfts',
  'bc_staking',
  'bc_loyalty',
  'bc_dao',
  'bc_knowledge',
  'bc_disputes',
  'bc_share_links',
  'bc_ai_proof',
  'bc_trials',
  'bc_oracle',
  'bc_experts',
];

// ── Table section grouping ────────────────────────────────────────────────
// The on-chain rows are a different beast from the core platform rows, so
// they get their own labelled band instead of one flat 45-row table.
const GROUP_META = {
  core: {
    label: 'Core platform protections',
    hint: 'Identity · transport · data · AI',
    accent: 'core',
  },
  chain: {
    label: 'Blockchain layer',
    hint: 'Ledger + every Web3 feature, probed live',
    accent: 'chain',
  },
};
const groupOf = (key) => (String(key).startsWith('bc_') ? 'chain' : 'core');

// Framework → coloured chip variant used in the "Security Implement" column
const FW_TONE = {
  'Auth / JWT':     'fw--indigo',
  'Auth / Email':   'fw--violet',
  'STRIDE':         'fw--amber',
  'Infrastructure': 'fw--cyan',
  'AI / API':       'fw--pink',
  'AI / OWASP':     'fw--pink',
  'AI / Privacy':   'fw--rose',
  'OWASP':          'fw--emerald',
  'Blockchain':     'fw--chain',
};
const fwTone = (fw) => FW_TONE[fw] || 'fw--slate';

// Every distinct framework present in MONITOR_FRAMEWORK, for the filter select
const FRAMEWORK_FILTERS = Object.keys(FW_TONE).filter(
  fw => Object.values(MONITOR_FRAMEWORK).includes(fw),
);

// ── Polling cadence ───────────────────────────────────────────────────────
// Polling on a fixed period regardless of how long the previous request took
// is how overlapping checks used to pile up on a slow endpoint. The next poll
// is scheduled from the end of the previous one instead.
const MONITOR_POLL_MS = 30000;

// Longest a single check may occupy the panel. `adminRequest` has no timeout
// of its own, so without this a stalled connection could leave the Sync button
// disabled and the panel frozen on stale numbers indefinitely.
const MONITOR_REQUEST_TIMEOUT_MS = 20000;

// ═══════════════════════════════════════════════════════════════════════════
//  Small helpers
// ═══════════════════════════════════════════════════════════════════════════

// "just now" · "14s ago" · "4m ago" · "2h ago" · "3d ago"
function formatAgo(iso, now) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '—';
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatClock(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// A 1 Hz clock, but only while something actually needs a live "Xs ago".
// Pausing it when nothing is on screen keeps an idle admin tab from burning a
// timer (and re-rendering) forever.
// `useState` is the clock's source of truth: the interval callback is what
// feeds it, never the effect body itself, so enabling the clock does not
// trigger a cascading re-render on the same commit.
function useNow(active) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Presentational pieces
// ═══════════════════════════════════════════════════════════════════════════

function MonitorPill({ status }) {
  const meta = MONITOR_STATUS_META[status] || MONITOR_STATUS_META.loading;
  return <span className={`rt-pill ${meta.cls}`}>{meta.label}</span>;
}

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

function DownloadIcon() {
  return (
    <svg className="rt-download-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg className="rtl-search__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="20" y1="20" x2="16.65" y2="16.65" />
    </svg>
  );
}

const STAT_ICONS = {
  grid: <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>,
  check: <>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </>,
  warn: <>
    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </>,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
};

function StatIcon({ name }) {
  return (
    <svg className="rt-stat__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {STAT_ICONS[name] || STAT_ICONS.grid}
    </svg>
  );
}

function Chevron() {
  return (
    <svg className="rt-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Expandable monitor row
//  Expansion state is owned by the parent so "Expand all / Collapse all" can
//  drive it, but it is keyed by monitor key — so a row stays open across polls
//  even though the row element itself is re-created on every refresh.
// ═══════════════════════════════════════════════════════════════════════════
function MonitorRow({ monitor, isOpen, onToggle, now }) {
  const key    = monitor.key;
  const status = monitor.status || 'loading';
  const label  = monitor.label || MONITOR_LABEL[key] || key;
  const impl   = MONITOR_IMPL[key] || '';
  const fw     = MONITOR_FRAMEWORK[key] || '—';
  const detail = monitor.detail || '';

  return (
    <Fragment>
      <tr className={`rt-row rt-row--${status}${isOpen ? ' rt-row--open' : ''}`}>
        {/* The whole row is clickable for mouse users; the only focusable
            control is the chevron button, which is the accessible path to the
            same action. */}
        <td className="rt-td rt-td--status" onClick={onToggle}>
          <MonitorPill status={status} />
        </td>

        <td className="rt-td rt-td--fw" onClick={onToggle}>
          <span className={`rt-fw ${fwTone(fw)}`}>{fw}</span>
        </td>

        <td className="rt-td rt-td--desc" onClick={onToggle}>
          <div className="rt-desc-row">
            <div className="rt-desc">
              <strong>{label}</strong>
              <span className="rt-impl">{impl}</span>
            </div>
            {monitor.latencyMs != null && (
              <span className="rt-latency" title="Probe round-trip time">{monitor.latencyMs} ms</span>
            )}
            <button
              type="button"
              className="rt-expand"
              onClick={e => {
                // The row above also handles clicks; without this the detail
                // panel would open and immediately close again.
                e.stopPropagation();
                onToggle();
              }}
              aria-expanded={isOpen}
              aria-controls={`rt-detail-${key}`}
              aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${label}`}
              title={isOpen ? 'Hide probe details' : 'Show probe details'}
            >
              <Chevron />
            </button>
          </div>
        </td>
      </tr>

      {isOpen && (
        <tr className="rt-detail-row" id={`rt-detail-${key}`}>
          <td colSpan={3} className="rt-detail-cell">
            <p className="rt-detail-text">{detail || 'No detail reported for this monitor.'}</p>
            <p className="rt-detail-meta">
              {monitor.checkedAt && <span>Checked {formatAgo(monitor.checkedAt, now)} · {formatClock(monitor.checkedAt)}</span>}
              {monitor.latencyMs != null && <span>Round trip {monitor.latencyMs} ms</span>}
              <span className="rt-detail-meta__key">{key}</span>
            </p>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Overall status banner
// ═══════════════════════════════════════════════════════════════════════════
// Every colour the banner needs is resolved in JS rather than mixed in CSS:
// the status accent drives the border, the left rail, the glow and the label
// colour from one place, and nothing depends on `color-mix()` support.
const BANNER_META = {
  healthy:  { label: 'All systems healthy',  color: '#047857', edge: '#6ee7b7', bg: '#ecfdf5', glow: '#10b981' },
  warning:  { label: 'Some checks warning',  color: '#b45309', edge: '#fcd34d', bg: '#fffbeb', glow: '#f59e0b' },
  critical: { label: 'Critical issues found', color: '#be123c', edge: '#fda4af', bg: '#fff1f2', glow: '#f43f5e' },
  error:    { label: 'Probe error',          color: '#6d28d9', edge: '#c4b5fd', bg: '#f5f3ff', glow: '#8b5cf6' },
  loading:  { label: 'Running first check…', color: '#4338ca', edge: '#a5b4fc', bg: '#eef2ff', glow: '#6366f1' },
};

function OverallBanner({
  status, syncedAt, syncing, checking, now, pollMs, onSync, onDownload, downloading = false,
}) {
  const meta = BANNER_META[status] || BANNER_META.loading;

  // How far we are through the 30 s window between automatic polls. Frozen
  // (and marked indeterminate) while a check is actually on the wire.
  const elapsed = syncedAt ? now - new Date(syncedAt).getTime() : 0;
  const progress = Math.max(0, Math.min(1, elapsed / pollMs));
  const showProgress = Boolean(syncedAt) && !syncing;

  return (
    <div
      className="rt-banner"
      style={{
        '--rt-color': meta.color,
        '--rt-edge': meta.edge,
        '--rt-glow': meta.glow,
        '--rt-bg': meta.bg,
      }}
    >
      <div className="rt-banner__left">
        <span className="rt-dot" aria-hidden="true" />
        <div className="rt-banner__text">
          <p className="rt-banner__eyebrow">Live monitor status</p>
          <p className="rt-banner__label" role="status" aria-live="polite">{meta.label}</p>
          {syncedAt && (
            <p className="rt-banner__ts">
              Updated {formatAgo(syncedAt, now)}
              <span className="rt-banner__ts-sep" aria-hidden="true">·</span>
              <span className="rt-banner__clock">{formatClock(syncedAt)}</span>
            </p>
          )}
        </div>
      </div>

      <div className="rt-banner__right">
        <button
          className="rt-sync-btn"
          onClick={onSync}
          disabled={checking}
          aria-busy={syncing}
          title={checking ? 'A check is already running' : 'Re-probe every monitor right now'}
        >
          <SyncIcon spinning={syncing} />
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
        {onDownload && (
          <button
            className="rt-download-btn"
            onClick={onDownload}
            aria-label={downloading ? 'Preparing security report PDF' : 'Download security report PDF'}
            aria-busy={downloading}
            disabled={downloading}
            title="Download the full security report as a PDF"
          >
            <DownloadIcon />
            {downloading ? 'Preparing…' : 'Download report'}
          </button>
        )}
      </div>

      {showProgress && (
        <div
          className={`rt-progress${checking ? ' rt-progress--busy' : ''}`}
          role="presentation"
          aria-hidden="true"
        >
          <span className="rt-progress__bar" style={{ '--rt-progress': `${progress * 100}%` }} />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Toolbar — search + status chips + framework select + expand all
// ═══════════════════════════════════════════════════════════════════════════
function MonitorToolbar({
  query, onQueryChange, statusFilter, onStatusFilterChange, statusChips,
  frameworkFilter, onFrameworkFilterChange, visibleCount, totalCount,
  allExpanded, onToggleExpandAll, searchRef,
}) {
  const filtersActive = Boolean(query.trim()) || statusFilter !== 'all' || frameworkFilter !== 'all';

  const clearFilters = () => {
    onQueryChange('');
    onStatusFilterChange('all');
    onFrameworkFilterChange('all');
  };

  return (
    <div className="rtl">
      <div className="rtl__row">
        {/* Search */}
        <div className="rtl-search">
          <SearchIcon />
          <input
            ref={searchRef}
            type="search"
            className="rtl-search__input"
            value={query}
            onChange={e => onQueryChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                onQueryChange('');
              }
            }}
            placeholder="Search monitors, frameworks or implementation files…"
            aria-label="Search security monitors"
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button
              type="button"
              className="rtl-search__clear"
              onClick={() => onQueryChange('')}
              aria-label="Clear search"
            >
              ×
            </button>
          )}
        </div>

        {/* Framework select */}
        <div className="rtl-select">
          <select
            className="rtl-select__input"
            value={frameworkFilter}
            onChange={e => onFrameworkFilterChange(e.target.value)}
            aria-label="Filter by security framework"
          >
            <option value="all">All frameworks</option>
            {FRAMEWORK_FILTERS.map(fw => <option key={fw} value={fw}>{fw}</option>)}
          </select>
          <span className="rtl-select__arrow" aria-hidden="true">▾</span>
        </div>

        {/* Expand / collapse all */}
        <button
          type="button"
          className="rtl-expand-all"
          onClick={onToggleExpandAll}
          disabled={visibleCount === 0}
          aria-pressed={allExpanded}
        >
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {/* Status chips */}
      <div className="rtl__row rtl__row--chips">
        <div className="rtl-chips" role="group" aria-label="Filter monitors by status">
          {statusChips.map(chip => (
            <button
              type="button"
              key={chip.id}
              className={`rtl-chip rtl-chip--${chip.id}${statusFilter === chip.id ? ' is-active' : ''}`}
              onClick={() => onStatusFilterChange(chip.id)}
              aria-pressed={statusFilter === chip.id}
            >
              {chip.label}
              <span className="rtl-chip__count">{chip.count}</span>
            </button>
          ))}
        </div>

        <p className="rtl-readout" role="status" aria-live="polite">
          Showing <strong>{visibleCount}</strong> of {totalCount} monitors
        </p>

        {filtersActive && (
          <button type="button" className="rtl-clear" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Audit record — the permanent entry for the completed security audit.
//  The live monitor above answers "is the system healthy right now". This
//  answers "what did a human review find, what changed, and what is still
//  open" — including the findings that were deliberately left unfixed.
// ═══════════════════════════════════════════════════════════════════════════
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

function AuditFinding({ finding, showStatus }) {
  if (!finding) return null;
  return (
    <li className="aud-finding">
      <div className="aud-finding__head">
        <SeverityChip severity={finding.severity} />
        <code className="aud-finding__id">{finding.id}</code>
        <strong>{finding.title}</strong>
      </div>
      <p className="aud-finding__detail">{finding.detail || finding.note}</p>
      {showStatus && finding.status && (
        <p className={`aud-finding__status${/fixed|resolved|remediated/i.test(finding.status) ? ' aud-finding__status--fixed' : ''}`}>
          {finding.status}
        </p>
      )}
    </li>
  );
}

function AuditRecord({ audit }) {
  if (!audit) return null;

  const counts = audit.counts || {};
  const countCards = [
    ['Critical',        counts.critical,          'aud-stat--critical'],
    ['High',            counts.high,              'aud-stat--high'],
    ['Medium',          counts.medium,            'aud-stat--medium'],
    ['Low',             counts.low,               'aud-stat--low'],
    ['Informational',   counts.informational,     'aud-stat--info'],
    ['Total',           counts.total,             'aud-stat--total'],
    ['Remediated',      counts.remediatedInCode,  'aud-stat--fixed'],
    ['Open / accepted', counts.openOrAccepted,    'aud-stat--open'],
  ];
  const verification = Object.entries(audit.verification || {});

  return (
    <section className="rt-section aud-section">
      <div className="rt-header">
        <div className="rt-header__title-wrap">
          <span className="rt-header__icon rt-header__icon--audit" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <polyline points="9 12 11 14 15 10" />
            </svg>
          </span>
          <div>
            <h2 className="rt-header__title">Security audit record</h2>
            <p className="rt-header__kicker">
              {audit.title} · <strong>{audit.id}</strong>
            </p>
          </div>
        </div>
        <p className="rt-header__sub">{audit.scope}</p>
      </div>

      {/* Severity breakdown */}
      <div className="aud-stats">
        {countCards.map(([label, value, cls]) => (
          <div className={`aud-stat ${cls}`} key={label}>
            <span className="aud-stat__value">{value ?? '—'}</span>
            <span className="aud-stat__label">{label}</span>
          </div>
        ))}
      </div>

      <details className="aud-block">
        <summary>Method — {audit.phases?.length || 0} phases</summary>
        <ol className="aud-list">
          {(audit.phases || []).map(p => <li key={p}>{p}</li>)}
        </ol>
      </details>

      <details className="aud-block">
        <summary>Key findings — {audit.headlineFindings?.length || 0} reported</summary>
        <ul className="aud-findings">
          {(audit.headlineFindings || []).map(f => <AuditFinding key={f.id} finding={f} showStatus />)}
        </ul>
      </details>

      <details className="aud-block">
        <summary>Changes applied — {audit.remediations?.length || 0} fixes</summary>
        <ul className="aud-list aud-list--code">
          {(audit.remediations || []).map(r => <li key={r}>{r}</li>)}
        </ul>
      </details>

      <details className="aud-block" open>
        <summary>Open &amp; accepted items — {audit.openItems?.length || 0}</summary>
        <ul className="aud-findings">
          {(audit.openItems || []).map(f => <AuditFinding key={f.id} finding={f} />)}
        </ul>
      </details>

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

      {/* Manual actions — intentionally loud */}
      <div className="aud-manual">
        <p className="aud-manual__title">
          <span aria-hidden="true">⚠</span> Manual action required — {audit.manualActions?.length || 0} item(s)
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

// ═══════════════════════════════════════════════════════════════════════════
//  Main component
// ═══════════════════════════════════════════════════════════════════════════
const SecurityStatus = ({ adminRequest, onDownloadReport }) => {
  const [monitors,             setMonitors]             = useState([]);
  const [overallMonitorStatus, setOverallMonitorStatus] = useState('loading');
  const [syncedAt,             setSyncedAt]             = useState(null);
  const [syncing,              setSyncing]              = useState(false);
  const [checking,             setChecking]             = useState(false);
  const [monitorError,         setMonitorError]         = useState('');
  const [audit,                setAudit]                = useState(null);
  const [downloading,          setDownloading]          = useState(false);
  // Toolbar state
  const [query,                setQuery]                = useState('');
  const [statusFilter,         setStatusFilter]         = useState('all');
  const [frameworkFilter,      setFrameworkFilter]      = useState('all');
  const [openKeys,             setOpenKeys]             = useState(() => new Set());

  const intervalRef  = useRef(null);
  const searchRef    = useRef(null);
  // Set while a request is on the wire, and bumped on every request so a slow
  // response can never overwrite a newer one.
  const inFlightRef  = useRef(false);
  const requestSeqRef = useRef(0);

  const fetchMonitor = useCallback(async (force = false) => {
    if (!adminRequest) return;
    // Never stack requests: a poll that outlives its own period would queue
    // behind the previous one and the panel would fall further and further
    // behind the state it is meant to be showing.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const seq = ++requestSeqRef.current;
    setChecking(true);
    // Only a user-initiated Sync drives the button label and spinner. Background
    // polls used to flip it to "Syncing…" and disable it every 30 s, which read
    // as a permanently stuck control and blocked the one action an admin
    // actually wants to take. `checking` still disables it so a click can never
    // queue a second request behind the one already running.
    if (force) setSyncing(true);
    setMonitorError('');
    // Abort the request if it outlives its budget, so the panel always returns
    // to an interactive state and never sits on a spinner with stale numbers.
    const controller = new AbortController();
    const abortTimer = window.setTimeout(() => controller.abort(), MONITOR_REQUEST_TIMEOUT_MS);
    try {
      const data = await adminRequest(`/security/monitor${force ? '?fresh=1' : ''}`, { signal: controller.signal });
      if (seq !== requestSeqRef.current) return; // superseded by a newer request
      setMonitors(data.monitors || []);
      setOverallMonitorStatus(data.overallMonitorStatus || 'healthy');
      setSyncedAt(data.syncedAt || new Date().toISOString());
      // Static record of the completed audit (rarely changes — only replace
      // when the API actually sent one, so a stale-but-valid record never
      // flashes away between the polls).
      if (data.audit) setAudit(data.audit);
    } catch (err) {
      if (seq !== requestSeqRef.current) return;
      setMonitorError(
        err?.name === 'AbortError'
          ? 'The security check did not respond in time. It will retry automatically.'
          : err.message || 'Unable to load monitor data.',
      );
    } finally {
      window.clearTimeout(abortTimer);
      inFlightRef.current = false;
      if (seq === requestSeqRef.current) {
        setChecking(false);
        if (force) setSyncing(false);
      }
    }
  }, [adminRequest]);

  // Initial load + auto-refresh. The timer restarts after every completed poll
  // so a slow check delays the next one instead of racing it.
  useEffect(() => {
    if (!adminRequest) return undefined;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await fetchMonitor(false);
      if (!cancelled) intervalRef.current = window.setTimeout(tick, MONITOR_POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
      window.clearTimeout(intervalRef.current);
    };
  }, [fetchMonitor, adminRequest]);

  // Live "Xs ago" clock — only running while something on screen shows a
  // relative time, so an idle tab settles down to zero timers.
  const now = useNow(Boolean(syncedAt));

  // ── Derived monitor list ───────────────────────────────────────────────
  // Every key in MONITOR_ORDER always gets a row, so the table keeps a stable
  // shape (and its scroll position) while the first checks are still running.
  const orderedMonitors = useMemo(() => MONITOR_ORDER.map(key => {
    const found = monitors.find(m => m.key === key);
    return found || { key, label: MONITOR_LABEL[key], status: 'loading', detail: '', latencyMs: null, checkedAt: null };
  }), [monitors]);

  // Counts always describe the whole system, never the filtered view — the
  // summary cards have to stay an honest picture of reality.
  const counts = useMemo(() => orderedMonitors.reduce((acc, m) => {
    acc[m.status] = (acc[m.status] || 0) + 1;
    return acc;
  }, {}), [orderedMonitors]);

  const totalCount = orderedMonitors.length;
  const problems = (counts.critical || 0) + (counts.error || 0);
  const healthPct = totalCount
    ? Math.round(((totalCount - problems - (counts.warning || 0)) / totalCount) * 100)
    : 0;

  const summaryCards = useMemo(() => ([
    { label: 'Monitors',  value: totalCount,                              cls: 'rt-stat--total',    icon: 'grid',   foot: `${FRAMEWORK_FILTERS.length} frameworks` },
    { label: 'Healthy',   value: counts.healthy || 0,                     cls: 'rt-stat--healthy',  icon: 'check',  foot: `${healthPct}% of all checks` },
    { label: 'Warnings',  value: counts.warning || 0,                     cls: 'rt-stat--warning',  icon: 'warn',   foot: 'needs review' },
    { label: 'Critical',  value: problems,                                cls: 'rt-stat--critical', icon: 'shield', foot: problems ? 'act now' : 'all clear' },
  ]), [totalCount, counts.healthy, counts.warning, problems, healthPct]);

  // ── Filtering + grouping ───────────────────────────────────────────────
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();

    // 1. group the ordered list
    const groups = [];
    orderedMonitors.forEach(m => {
      const id = groupOf(m.key);
      let group = groups.length ? groups[groups.length - 1] : null;
      if (!group || group.id !== id) {
        group = { id, items: [] };
        groups.push(group);
      }
      group.items.push(m);
    });

    // 2. drop anything that fails a filter, and any group left empty
    return groups.map(g => ({ ...g, items: g.items.filter(m => {
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (frameworkFilter !== 'all' && (MONITOR_FRAMEWORK[m.key] || '—') !== frameworkFilter) return false;
      if (!q) return true;
      return [
        m.label,
        MONITOR_LABEL[m.key],
        m.key,
        MONITOR_IMPL[m.key],
        MONITOR_FRAMEWORK[m.key],
        m.detail,
      ].filter(Boolean).some(value => String(value).toLowerCase().includes(q));
    }) })).filter(g => g.items.length > 0);
  }, [orderedMonitors, query, statusFilter, frameworkFilter]);

  const visibleKeys = useMemo(
    () => visibleGroups.reduce((acc, g) => acc.concat(g.items.map(m => m.key)), []),
    [visibleGroups],
  );
  const visibleCount = visibleKeys.length;
  const allExpanded = visibleCount > 0 && visibleKeys.every(k => openKeys.has(k));

  const statusChips = useMemo(() => {
    const chips = [
      { id: 'all',      label: 'All',      count: totalCount },
      { id: 'healthy',  label: 'Healthy',  count: counts.healthy  || 0 },
      { id: 'warning',  label: 'Warnings', count: counts.warning  || 0 },
      { id: 'critical', label: 'Critical', count: counts.critical || 0 },
      { id: 'error',    label: 'Errors',   count: counts.error    || 0 },
    ];
    // "Checking" only means something while rows are still in their skeleton
    // state, so the chip appears and disappears with the work it describes.
    if (counts.loading) chips.push({ id: 'loading', label: 'Checking', count: counts.loading });
    return chips;
  }, [totalCount, counts]);

  // ── Row expansion ──────────────────────────────────────────────────────
  const toggleRow = useCallback((key) => {
    setOpenKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleExpandAll = useCallback(() => {
    setOpenKeys(prev => {
      if (visibleKeys.length && visibleKeys.every(k => prev.has(k))) return new Set();
      const next = new Set(prev);
      visibleKeys.forEach(k => next.add(k));
      return next;
    });
  }, [visibleKeys]);

  const handleDownload = async () => {
    if (!onDownloadReport || downloading) return;
    setDownloading(true);
    setMonitorError('');
    try {
      await onDownloadReport();
    } catch (error) {
      setMonitorError(error?.message || 'Unable to generate the security report.');
    } finally {
      setDownloading(false);
    }
  };

  const filtersActive = Boolean(query.trim()) || statusFilter !== 'all' || frameworkFilter !== 'all';

  return (
    <div className="security-status-container">

      {/* ══════════════════════════════════════════════════════════════════
          REAL-TIME MONITOR
      ══════════════════════════════════════════════════════════════════ */}
      <section className="rt-section">

        {/* Header */}
        <div className="rt-header">
          <div className="rt-header__title-wrap">
            <span className="rt-header__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
            <div>
              <h2 className="rt-header__title">Real-time security monitor</h2>
              <p className="rt-header__kicker">{totalCount} live probes · auto-refresh every {MONITOR_POLL_MS / 1000}s</p>
            </div>
          </div>
          <p className="rt-header__sub">
            Every critical security function and the whole blockchain layer — ledger, wallet,
            marketplace, DAO, rewards, privacy and AI proofs — is re-probed on a live connection.
            Select any row to read the exact probe result.
          </p>
        </div>

        {/* Overall status banner */}
        <OverallBanner
          status={overallMonitorStatus}
          syncedAt={syncedAt}
          syncing={syncing}
          checking={checking}
          now={now}
          pollMs={MONITOR_POLL_MS}
          onSync={() => fetchMonitor(true)}
          onDownload={handleDownload}
          downloading={downloading}
        />

        {/* Error message */}
        {monitorError && <div className="rt-error" role="alert">{monitorError}</div>}

        {/* Quick-glance summary tiles */}
        <div className="rt-stats">
          {summaryCards.map(card => (
            <div className={`rt-stat ${card.cls}`} key={card.label}>
              <span className="rt-stat__icon-wrap"><StatIcon name={card.icon} /></span>
              <span className="rt-stat__value">{card.value}</span>
              <span className="rt-stat__label">{card.label}</span>
              <span className="rt-stat__foot">{card.foot}</span>
            </div>
          ))}
        </div>

        {/* Toolbar */}
        <MonitorToolbar
          query={query}
          onQueryChange={setQuery}
          searchRef={searchRef}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          statusChips={statusChips}
          frameworkFilter={frameworkFilter}
          onFrameworkFilterChange={setFrameworkFilter}
          visibleCount={visibleCount}
          totalCount={totalCount}
          allExpanded={allExpanded}
          onToggleExpandAll={toggleExpandAll}
        />

        {/* Monitor table */}
        {visibleCount === 0 ? (
          <div className="rt-empty">
            <span className="rt-empty__icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="20" y1="20" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <p className="rt-empty__title">No monitors match these filters</p>
            <p className="rt-empty__sub">
              {totalCount} probes are running. Widen the search or clear the filters to see them all.
            </p>
            {filtersActive && (
              <button
                type="button"
                className="rt-empty__btn"
                onClick={() => { setQuery(''); setStatusFilter('all'); setFrameworkFilter('all'); }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="rt-table-wrap">
            <table className="rt-table" aria-label="Live security monitor results">
              <thead>
                <tr>
                  <th className="rt-th rt-th--status" scope="col">Status</th>
                  <th className="rt-th rt-th--fw" scope="col">Security implement</th>
                  <th className="rt-th rt-th--desc" scope="col">Description / implementation</th>
                </tr>
              </thead>
              <tbody>
                {visibleGroups.map(group => {
                  const meta = GROUP_META[group.id] || GROUP_META.core;
                  return (
                    <Fragment key={group.id}>
                      <tr className={`rt-group-row rt-group-row--${meta.accent}`}>
                        <td colSpan={3} className="rt-group-cell">
                          <span className="rt-group__label">
                            {group.id === 'chain' && <span className="rt-group__icon" aria-hidden="true">⛓</span>}
                            {meta.label}
                          </span>
                          <span className="rt-group__hint">{meta.hint}</span>
                          <span className="rt-group__count">{group.items.length}</span>
                        </td>
                      </tr>
                      {group.items.map(m => (
                        <MonitorRow
                          key={m.key}
                          monitor={m}
                          isOpen={openKeys.has(m.key)}
                          onToggle={() => toggleRow(m.key)}
                          now={now}
                        />
                      ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Permanent record of the completed security audit ────────────── */}
      <AuditRecord audit={audit} />
    </div>
  );
};

export default SecurityStatus;
