import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MONITOR_POLL_MS } from '../../hooks/useSecurityMonitor';
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
  groq:               'AI / API',
  anthropic:          'AI / API',
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
  groq:               'Groq (Detection AI)',
  anthropic:          'Anthropic (Priority Flagging AI)',
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
  groq:               'utils/systemDetection.js · api.groq.com',
  anthropic:          'utils/priorityFlagging.js · api.anthropic.com',
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
  'groq',
  'anthropic',
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
// MONITOR_POLL_MS is imported from the shared hook rather than declared here:
// the fetch, the 30 s cadence and the request timeout now live in one place
// (hooks/useSecurityMonitor.js) because the Overview "Threat notifications" card
// reads the same monitor response. Two copies of the cadence would be two
// schedules, and the two surfaces would drift out of step.
//
// The next poll is scheduled from the END of the previous one rather than on a
// fixed period, because polling regardless of how long the previous request took
// is how overlapping checks used to pile up on a slow endpoint.

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
function MonitorRow({ monitor, isOpen, onToggle, now, highlighted, registerNode }) {
  const key    = monitor.key;
  const status = monitor.status || 'loading';
  const label  = monitor.label || MONITOR_LABEL[key] || key;
  const impl   = MONITOR_IMPL[key] || '';
  const fw     = MONITOR_FRAMEWORK[key] || '—';
  const detail = monitor.detail || '';

  return (
    <Fragment>
      <tr
        // Handed to the parent so a deep link can scroll this exact row into
        // view. A callback ref rather than a querySelector because the row is
        // re-created on every poll, and the parent has to be able to re-resolve
        // the node each time rather than hold a detached one.
        ref={registerNode ? node => registerNode(key, node) : undefined}
        id={`rt-row-${key}`}
        className={`rt-row rt-row--${status}${isOpen ? ' rt-row--open' : ''}${highlighted ? ' rt-row--highlighted' : ''}`}
      >
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
//  Threat prediction
//
//  A forecast ABOUT the probes listed in the monitor above, derived from their
//  results — so it lives here rather than on the AI tab, where it used to sit
//  beside the provider cards that merely produced its input.
//
//  Severity is its own vocabulary, deliberately not the monitor's status and
//  deliberately not AI_STATUS on the AI tab: those answer "did the probe
//  return" and "can we reach the provider", this answers "how bad is the
//  system". `watch` exists as a distinct, non-green middle, because a panel
//  that painted "we could not determine this" the same as "all clear" would be
//  worse than showing nothing. An unrecognised severity falls to `watch` for
//  the same reason: never let unknown read as fine.
// ═══════════════════════════════════════════════════════════════════════════
const TP_SEVERITY = {
  nominal:  {
    label: 'Nominal',  cls: 'tp--nominal',
    ink: '#047857', edge: '#6ee7b7', bg: '#ecfdf5', bar: 'linear-gradient(90deg, #34d399, #10b981)',
  },
  watch:    {
    label: 'Watch',    cls: 'tp--watch',
    ink: '#b45309', edge: '#fcd34d', bg: '#fffbeb', bar: 'linear-gradient(90deg, #fbbf24, #f59e0b)',
  },
  elevated: {
    label: 'Elevated', cls: 'tp--elevated',
    ink: '#c2410c', edge: '#fdba74', bg: '#fff7ed', bar: 'linear-gradient(90deg, #fb923c, #f97316)',
  },
  severe:   {
    label: 'Severe',   cls: 'tp--severe',
    ink: '#be123c', edge: '#fda4af', bg: '#fff1f2', bar: 'linear-gradient(90deg, #fb7185, #f43f5e)',
  },
};

const tpMeta = (severity) => TP_SEVERITY[severity] || TP_SEVERITY.watch;

/** Confidence is a model output, so it is clamped rather than trusted. */
function tpConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function TpIcon({ name }) {
  const paths = {
    shield: (
      <>
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <polyline points="9 12 11 14 15 10" />
      </>
    ),
    trend: (
      <>
        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
        <polyline points="17 6 23 6 23 12" />
      </>
    ),
    check: (
      <>
        <circle cx="12" cy="12" r="10" />
        <polyline points="8 12.5 11 15.5 16 9" />
      </>
    ),
    bolt: <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />,
  };
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name] || paths.shield}
    </svg>
  );
}

/** Empty state. Previously a bare sentence, which read as a panel that failed. */
function TpEmpty({ tone, icon, title, hint }) {
  return (
    <div className={`tp-empty ${tone}`}>
      <span className="tp-empty__icon" aria-hidden="true"><TpIcon name={icon} /></span>
      <p className="tp-empty__title">{title}</p>
      <p className="tp-empty__hint">{hint}</p>
    </div>
  );
}

function ThreatPrediction({ detection, now }) {
  if (!detection) return null;

  const meta = tpMeta(detection.severity);
  // Highest confidence first: the ranking IS the forecast, so sorting is what
  // turns a list of equally-weighted sentences into a priority order.
  const predictions = (Array.isArray(detection.predictions) ? detection.predictions : [])
    .filter((p) => p && (p.title || p.rationale))
    .map((p) => ({ ...p, confidence: tpConfidence(p.confidence) }))
    .sort((a, b) => (b.confidence ?? -1) - (a.confidence ?? -1));
  const actions = (Array.isArray(detection.actions) ? detection.actions : [])
    .map((a) => String(a || '').trim())
    .filter(Boolean);

  const overall = tpConfidence(detection.confidence);
  const fromRules = detection.source === 'rules';

  return (
    <section className={`rt-section tp-section ${meta.cls}`} aria-labelledby="tp-title">
      <div className="rt-header">
        <div className="rt-header__title-wrap">
          <span className="rt-header__icon rt-header__icon--tp" aria-hidden="true">
            <TpIcon name="trend" />
          </span>
          <div>
            <h2 className="rt-header__title" id="tp-title">Threat prediction</h2>
            <p className="rt-header__kicker">
              {detection.probeCount != null
                ? `${detection.probeCount} probe results analysed`
                : 'Derived from the live probe results'}
              {detection.checkedAt && (
                <>
                  <span className="rt-sep" aria-hidden="true">·</span>
                  {formatAgo(detection.checkedAt, now)}
                </>
              )}
            </p>
          </div>
        </div>

        <div className="tp-verdict">
          <span className="tp-verdict__pill" role="status">
            <i className="tp-verdict__dot" aria-hidden="true" />
            {meta.label}
          </span>
          {overall != null && (
            <span className="tp-verdict__conf">
              <b>{overall}%</b> confidence
            </span>
          )}
        </div>
      </div>

      {detection.summary && <p className="tp-summary">{detection.summary}</p>}

      {/* Provenance. The forecast is model output, so where it came from and
          how long it took is part of the claim, not decoration. */}
      <ul className="tp-provenance">
        <li className={`tp-provenance__item${fromRules ? ' tp-provenance__item--rules' : ''}`}>
          <TpIcon name={fromRules ? 'bolt' : 'shield'} />
          {fromRules ? 'Rule engine' : 'AI analysis'}
        </li>
        {detection.provider && <li className="tp-provenance__item">{detection.provider}</li>}
        {detection.model && <li className="tp-provenance__item tp-provenance__item--model">{detection.model}</li>}
        {detection.latencyMs != null && (
          <li className="tp-provenance__item">
            {detection.latencyMs >= 1000
              ? `${(detection.latencyMs / 1000).toFixed(1)}s`
              : `${detection.latencyMs}ms`}
          </li>
        )}
      </ul>

      {/* The advisory layer is allowed to be unavailable — detection keeps
          working without it. Saying so is the difference between "no anomalies"
          and "we could not look", which look identical otherwise. */}
      {detection.aiAvailable === false && (
        <p className="tp-notice" role="status">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1"
            strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>
            <strong>AI prediction unavailable</strong> —{' '}
            {detection.aiError || 'the provider did not answer.'}{' '}
            Everything below is the rule-based verdict, which keeps working without the AI.
          </span>
        </p>
      )}

      <div className="tp-grid">
        <div className="tp-col">
          <h3 className="tp-col__title">
            <span className="tp-col__title-icon" aria-hidden="true"><TpIcon name="trend" /></span>
            Predicted next
            {predictions.length > 0 && <span className="tp-col__count">{predictions.length}</span>}
          </h3>
          {predictions.length === 0 ? (
            <TpEmpty
              tone={meta.cls}
              icon="check"
              title="No predicted risks"
              hint="Nothing in the current probe results points to a failure that has not happened yet. This panel updates as soon as a probe changes."
            />
          ) : (
            <ul className="tp-preds">
              {predictions.map((item, i) => (
                <li className="tp-pred" key={`${item.title}-${i}`}>
                  <div className="tp-pred__head">
                    <strong className="tp-pred__title">{item.title}</strong>
                    {item.confidence != null && (
                      <span className="tp-pred__conf" title={`${item.confidence}% confidence`}>
                        {item.confidence}%
                      </span>
                    )}
                  </div>
                  {item.confidence != null && (
                    <div className="tp-meter" role="presentation" aria-hidden="true">
                      <span className="tp-meter__fill" style={{ width: `${item.confidence}%` }} />
                    </div>
                  )}
                  {item.rationale && <p className="tp-pred__why">{item.rationale}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="tp-col">
          <h3 className="tp-col__title">
            <span className="tp-col__title-icon" aria-hidden="true"><TpIcon name="shield" /></span>
            Recommended actions
            {actions.length > 0 && <span className="tp-col__count">{actions.length}</span>}
          </h3>
          {actions.length === 0 ? (
            <TpEmpty
              tone={meta.cls}
              icon="check"
              title="No actions required"
              hint="Nothing needs a human right now. Keep the monitor running."
            />
          ) : (
            <ol className="tp-actions">
              {actions.map((action, i) => (
                <li className="tp-action" key={i}>
                  <span className="tp-action__step" aria-hidden="true">{i + 1}</span>
                  <span className="tp-action__text">{action}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main component
// ═══════════════════════════════════════════════════════════════════════════
// Stand-in for a missing `monitor` prop. Every field is falsy/empty and the
// status is 'loading' — deliberately NOT 'healthy', so a caller that forgets to
// pass the prop gets an honest "still checking" panel rather than one that
// confidently reports an all-clear it never received.
const EMPTY_MONITOR = {
  monitors: [],
  status: 'loading',
  syncedAt: null,
  audit: null,
  error: '',
  syncing: false,
  checking: false,
  sync: async () => {},
};

const SecurityStatus = ({ monitor, onDownloadReport, detection, focusMonitorKey }) => {
  // The live probe state is owned by the caller: one fetch, one poll, shared
  // with the Overview "Threat notifications" card (see hooks/useSecurityMonitor).
  //
  // This component deliberately holds NO fetch of its own. React cannot skip a
  // hook call, so keeping a local fallback here would run the 45 probes a second
  // time on every dashboard render — the exact duplicate traffic the shared
  // hook exists to remove. A missing prop is therefore an explicit empty state,
  // not a reason to quietly start polling.
  const {
    monitors, status: overallMonitorStatus, syncedAt, audit,
    syncing, checking, error: monitorError, sync: syncMonitor,
  } = monitor || EMPTY_MONITOR;

  const [downloading,          setDownloading]          = useState(false);
  const [downloadError,        setDownloadError]        = useState('');
  // Toolbar state
  const [query,                setQuery]                = useState('');
  const [statusFilter,         setStatusFilter]         = useState('all');
  const [frameworkFilter,      setFrameworkFilter]      = useState('all');
  const [openKeys,             setOpenKeys]             = useState(() => new Set());
  // The deep-link key whose reveal has already been applied. Adjusting state
  // during render (React's documented pattern for "a prop changed") rather than
  // in an effect, which would cascade an extra render on every arrival.
  const [appliedFocusKey,      setAppliedFocusKey]      = useState(null);

  const searchRef    = useRef(null);
  const rowNodesRef  = useRef(new Map());

  const registerNode = useCallback((key, node) => {
    if (node) rowNodesRef.current.set(key, node);
    else rowNodesRef.current.delete(key);
  }, []);

  const fetchMonitor = useCallback(
    (force = false) => syncMonitor(force),
    [syncMonitor],
  );

  // ── Deep link from another surface ─────────────────────────────────────
  // The Overview card links a specific failing monitor straight to its row.
  // Applied at render time so the row is already expanded and unfiltered on the
  // first paint that shows it — an effect would paint the un-revealed row first
  // and then correct itself, which reads as a flicker on every click.
  if (focusMonitorKey && appliedFocusKey !== focusMonitorKey) {
    setAppliedFocusKey(focusMonitorKey);
    // Open it, so the probe detail is visible without a second click, and drop
    // the filters that could otherwise be hiding it.
    setOpenKeys(prev => (prev.has(focusMonitorKey) ? prev : new Set(prev).add(focusMonitorKey)));
    setQuery('');
    setStatusFilter('all');
    setFrameworkFilter('all');
  }

  // Scrolling waits for the node: the target row does not exist on the very
  // first render if the opening poll is still in flight, and scrollIntoView
  // against a missing node is a silent no-op that never retries.
  useLayoutEffect(() => {
    if (!focusMonitorKey) return;
    const node = rowNodesRef.current.get(focusMonitorKey);
    if (!node || typeof node.scrollIntoView !== 'function') return;
    // 'nearest' so a row already on screen is not yanked, and the admin keeps
    // their place in a 45-row table.
    node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [focusMonitorKey, monitors, appliedFocusKey]);

  // Live "Xs ago" clock — only running while something on screen shows a
  // relative time, so an idle tab settles down to zero timers. The threat
  // prediction carries its own timestamp, so it counts as a reason to tick too.
  const now = useNow(Boolean(syncedAt) || Boolean(detection && detection.checkedAt));

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
    setDownloadError('');
    try {
      await onDownloadReport();
    } catch (error) {
      setDownloadError(error?.message || 'Unable to generate the security report.');
    } finally {
      setDownloading(false);
    }
  };

  // A failed PDF export is NOT a failed security probe. They used to share one
  // string, so a broken report could blank out a healthy monitor panel's error
  // line and vice versa. Kept separate, rendered together.
  const visibleError = downloadError || monitorError;

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
        {visibleError && <div className="rt-error" role="alert">{visibleError}</div>}

        {/* ── Forecast, placed directly under the live verdict ───────────────
            It reads the probe results below it, so it goes above them: the
            operator gets "all clear → and here is what breaks next" before
            being made to scroll a 40-row table to reach the answer. */}
        <ThreatPrediction detection={detection} now={now} />

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
                          highlighted={focusMonitorKey === m.key}
                          registerNode={registerNode}
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
