/* eslint-disable react-refresh/only-export-components -- shared kit: formatters, a state hook and UI primitives intentionally ship together */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { Link, NavLink } from 'react-router-dom';

// ── Shared building blocks for every Web3 panel ────────────────────────────
export function Spinner() {
  return <div className="w3-spinner" role="status" aria-label="Loading" />;
}

export function Empty({ icon = '📭', title, children, action }) {
  return (
    <div className="w3-empty">
      <div className="w3-empty-icon" aria-hidden="true">{icon}</div>
      {title ? <div className="w3-empty-title">{title}</div> : null}
      {children ? <div className="w3-empty-text">{children}</div> : null}
      {action ? <div className="w3-empty-action">{action}</div> : null}
    </div>
  );
}

// Inline result feedback (success/error/info) — one slot per panel keeps the
// UI honest: exactly one message at a time, cleared on the next action.
//
// The three columns (icon · message · dismiss) are a GRID, not a wrapping row:
// as a flex row a long message pushed the close button onto a second line,
// which read as two unrelated things instead of one notification.
const ALERT_GLYPH = { ok: '✓', err: '!', info: 'i' };

export function Alert({ alert, onClear }) {
  if (!alert) return null;
  const kind = alert.kind === 'error' ? 'err' : alert.kind === 'info' ? 'info' : 'ok';
  return (
    <div className={`w3-alert ${kind}`} role={kind === 'err' ? 'alert' : 'status'}>
      <span className="w3-alert-icon" aria-hidden="true">{ALERT_GLYPH[kind]}</span>
      <span className="w3-alert-msg">{alert.message}</span>
      {onClear ? (
        <button
          type="button"
          className="w3-alert-close"
          onClick={onClear}
          aria-label="Dismiss message"
          title="Dismiss"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}

/**
 * One metric tile.
 *
 * `tone` tints the whole tile — rail, icon chip, number and corner wash all
 * read from the same three custom properties, so they cannot disagree. Pass
 * distinct tones across a row: four identically-green tiles read as one
 * repeated block, four tinted ones read as four different measurements.
 */
export function Stat({ value, label, tone = 'green', icon, unit, hint }) {
  const t = tone && tone !== 'plain' ? tone : 'green';
  return (
    <div className={`w3-stat tone-${t}`}>
      {icon ? <div className="w3-stat-icon" aria-hidden="true">{icon}</div> : null}
      <div className="w3-stat-body">
        <div className="w3-stat-value">
          <span>{value}</span>
          {unit ? <span className="w3-stat-unit">{unit}</span> : null}
        </div>
        <div className="w3-stat-label">{label}</div>
        {hint ? <div className="w3-stat-hint">{hint}</div> : null}
      </div>
    </div>
  );
}

/**
 * Labelled form control.
 *
 * A <label> with no `for` and no nested control labels nothing, so the control
 * is given a generated id unless the caller supplied its own.
 */
export function Field({ label, htmlFor, hint, children }) {
  const autoId = useId();
  const id = htmlFor || autoId;
  const control = isValidElement(children) && !children.props.id
    ? cloneElement(children, { id })
    : children;
  return (
    <div className="w3-field">
      <label className="w3-label" htmlFor={id}>{label}</label>
      {control}
      {hint ? <p className="w3-hint">{hint}</p> : null}
    </div>
  );
}

// ── Page chrome ────────────────────────────────────────────────────────────

/**
 * The banner at the top of a Web3 area.
 *
 * `variant` only re-tints the gradient; the contrast scrim is a fixed first
 * layer in CSS, so no tint can put light-on-light text on the page.
 */
export function Hero({ eyebrow, title, subtitle, mark, variant = '', children }) {
  return (
    <header className={`w3-hero ${variant ? `variant-${variant}` : ''}`}>
      {mark ? <div className="w3-hero-mark" aria-hidden="true">{mark}</div> : null}
      <div className="w3-hero-body">
        {eyebrow ? <span className="w3-hero-eyebrow">{eyebrow}</span> : null}
        <h1 className="w3-title">{title}</h1>
        {subtitle ? <p className="w3-subtitle">{subtitle}</p> : null}
        {children}
      </div>
    </header>
  );
}

// The three blockchain areas. Kept in one place so /web3, /marketplace and
// /governance always offer the same switcher — before this each page listed a
// hand-picked subset, so the set you could reach depended on where you were.
const AREAS = [
  { to: '/web3', icon: '⛓️', label: 'Web3 Hub' },
  { to: '/marketplace', icon: '🛒', label: 'Marketplace' },
  { to: '/governance', icon: '🏛️', label: 'DAO Governance' },
];

/** Cross-area navigation with the current area filled in. */
export function AreaNav() {
  return (
    <div className="w3-navrow">
      <nav className="w3-subnav" aria-label="Blockchain areas">
        {AREAS.map((a) => (
          <NavLink key={a.to} to={a.to} className="w3-area">
            <span className="w3-area-icon" aria-hidden="true">{a.icon}</span>
            {a.label}
          </NavLink>
        ))}
      </nav>
      <Link className="w3-btn ghost small" to="/verify">
        <span aria-hidden="true">🔍</span> Verify a product
      </Link>
    </div>
  );
}

// ── Formatters ─────────────────────────────────────────────────────────────
export function trunc(hash, head = 10, tail = 6) {
  if (!hash) return '—';
  const s = String(hash);
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function fmtTime(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function fmtDay(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtWell(n) {
  const v = Number(n) || 0;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// "2d 4h left" / "38m left" / "ended" — derived from the deadline, so it is a
// snapshot taken at render time rather than a live countdown (which would
// need a timer per row just to move a suffix).
export function timeLeft(ms) {
  if (!ms) return '—';
  const diff = new Date(ms).getTime() - Date.now();
  if (Number.isNaN(diff)) return '—';
  if (diff <= 0) return 'ended';
  const minutes = Math.max(1, Math.floor(diff / 60000));
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h left`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
}

// ── Copy-to-clipboard chip ────────────────────────────────────────────────
export function CopyChip({ value, label = null }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const text = String(value || '');

  // The reset timer is cleared on unmount so a chip removed straight after a
  // copy cannot try to set state on a component that is no longer mounted.
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the value stays visible for manual copy */
    }
  };

  return (
    <button
      type="button"
      className={`w3-hash ${copied ? 'copied' : ''}`}
      onClick={copy}
      title={copied ? 'Copied to clipboard' : `Copy: ${text}`}
      aria-label={copied ? 'Copied to clipboard' : `Copy ${label || 'value'}`}
    >
      <span className="w3-hash-text">{label || trunc(text, 12, 8)}</span>
      <span className="w3-hash-icon" aria-hidden="true">{copied ? '✓' : '⧉'}</span>
    </button>
  );
}

// ── Section tabs ───────────────────────────────────────────────────────────

// Each tab owns a hue so a long strip is scannable by colour as well as by
// label. The SELECTED pill stays on the brand gradient — a rainbow of actives
// would out-shout the content — and borrows its own hue only for the glow.
const TAB_TONES = [
  { a: '#34D399', b: '#059669' }, // emerald
  { a: '#FBBF24', b: '#D97706' }, // amber
  { a: '#22D3EE', b: '#0E7490' }, // cyan
  { a: '#A78BFA', b: '#7C3AED' }, // violet
  { a: '#F472B6', b: '#DB2777' }, // pink
  { a: '#60A5FA', b: '#2563EB' }, // blue
  { a: '#FB923C', b: '#EA580C' }, // orange
  { a: '#4ADE80', b: '#15803D' }, // green
];

const toneFor = (index) => TAB_TONES[index % TAB_TONES.length];

/**
 * Shared tab strip for the hub / marketplace / governance pages.
 *
 * WAI-ARIA tabs pattern: arrow keys move between tabs, Home/End jump, and the
 * selected tab is centred so a strip wider than its container never hides it.
 *
 * The fades are driven from MEASURED scroll position rather than always-on
 * pseudo-element shadows, so they appear only on the side that genuinely has
 * tabs off-screen and disappear entirely when the strip fits.
 */
export function TabBar({ tabs, active, onChange, label }) {
  const listRef = useRef(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const syncEdges = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    const next = { start: el.scrollLeft > 4, end: el.scrollLeft < max - 4 };
    setEdges((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  // Re-measure when the strip is re-rendered with a different tab set, and
  // again on any resize — the container reflows with the viewport, so the
  // number of hidden tabs changes without the tabs themselves changing.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    syncEdges();
    let observer = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(syncEdges);
      observer.observe(el);
    }
    window.addEventListener('resize', syncEdges);
    return () => {
      if (observer) observer.disconnect();
      window.removeEventListener('resize', syncEdges);
    };
  }, [syncEdges, tabs.length]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector('[data-active="true"]');
    if (!selected) return;
    // Centre the active tab so a long strip never hides the selection.
    const target = selected.offsetLeft - (list.clientWidth - selected.offsetWidth) / 2;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    list.scrollTo({ left: Math.max(0, target), behavior: reduced ? 'auto' : 'smooth' });
  }, [active]);

  const onKeyDown = (event) => {
    const current = tabs.findIndex((t) => t.key === active);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % tabs.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next < 0) return;

    event.preventDefault();
    onChange(tabs[next].key);
    // Keep focus on the tab that just became selected.
    window.requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      const buttons = list.querySelectorAll('[role="tab"]');
      if (buttons[next]) buttons[next].focus();
    });
  };

  return (
    <div className="w3-tabs-wrap">
      <div
        className="w3-tabs"
        role="tablist"
        aria-label={label}
        ref={listRef}
        onKeyDown={onKeyDown}
        onScroll={syncEdges}
      >
        {tabs.map((t, i) => {
          const selected = t.key === active;
          const tone = toneFor(i);
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`w3tab-${t.key}`}
              aria-selected={selected}
              aria-controls="w3-tabpanel"
              tabIndex={selected ? 0 : -1}
              data-active={selected ? 'true' : 'false'}
              className={`w3-tab ${selected ? 'active' : ''}`}
              style={{ '--tone-1': tone.a, '--tone-2': tone.b, '--tone-wash': `${tone.a}24` }}
              onClick={() => onChange(t.key)}
            >
              <span className="w3-tab-icon" aria-hidden="true">{t.icon}</span>
              <span className="w3-tab-label">{t.label}</span>
            </button>
          );
        })}
      </div>
      <span className="w3-tabs-fade start" data-on={String(edges.start)} aria-hidden="true" />
      <span className="w3-tabs-fade end" data-on={String(edges.end)} aria-hidden="true" />
    </div>
  );
}

// Panel-level state: loader + one alert slot, so a failed fetch never leaves a
// spinner hanging and never stacks two messages.
export function usePanelState() {
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState(null);
  const ok = (message) => setAlert({ kind: 'ok', message });
  const fail = (err, fallback = 'Something went wrong. Please try again.') =>
    setAlert({ kind: 'error', message: err?.message || fallback });
  const info = (message) => setAlert({ kind: 'info', message });
  const clear = () => setAlert(null);
  return { loading, setLoading, alert, setAlert, ok, fail, info, clear };
}
