/* eslint-disable react-refresh/only-export-components -- shared kit: formatters, a state hook and UI primitives intentionally ship together */
import { useEffect, useRef, useState } from 'react';

// ── Shared building blocks for every Web3 panel ────────────────────────────
export function Spinner() {
  return <div className="w3-spinner" role="status" aria-label="Loading" />;
}

export function Empty({ icon = '📭', children }) {
  return (
    <div className="w3-empty">
      <div className="w3-empty-icon">{icon}</div>
      {children}
    </div>
  );
}

// Inline result feedback (success/error) — one slot per panel keeps the UI
// honest: exactly one message at a time, cleared on the next action.
export function Alert({ alert, onClear }) {
  if (!alert) return null;
  return (
    <div className={`w3-alert ${alert.kind === 'error' ? 'err' : alert.kind === 'info' ? 'info' : 'ok'}`}>
      <div className="w3-row between">
        <span>{alert.message}</span>
        {onClear && (
          <button type="button" className="w3-btn ghost small" onClick={onClear} aria-label="Dismiss">
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

export function Stat({ value, label, tone = '' }) {
  return (
    <div className="w3-stat">
      <div className={`w3-stat-value ${tone}`}>{value}</div>
      <div className="w3-stat-label">{label}</div>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="w3-field">
      <label className="w3-label">{label}</label>
      {children}
    </div>
  );
}

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

// Click-to-copy chip for hashes/addresses/tokens.
export function CopyChip({ value, label = null }) {
  const [copied, setCopied] = useState(false);
  const text = String(value || '');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the value stays visible for manual copy */
    }
  };
  return (
    <button type="button" className="w3-hash" onClick={copy} title={text}>
      {label || trunc(text, 12, 8)} {copied ? '✓' : '⧉'}
    </button>
  );
}

// Shared tab strip for the hub / marketplace / governance pages.
//
// Before this each page hand-rolled `role="tablist"` buttons that were
// unreachable by keyboard: no arrow-key movement, no roving tabindex, and
// the selected tab could sit scrolled off-screen with no affordance.
// This version implements the WAI-ARIA tabs pattern and centres the active
// tab whenever the selection changes.
export function TabBar({ tabs, active, onChange, label }) {
  const listRef = useRef(null);

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
    <div className="w3-tabs" role="tablist" aria-label={label} ref={listRef} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const selected = t.key === active;
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
            onClick={() => onChange(t.key)}
          >
            <span aria-hidden="true">{t.icon}</span>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

// Panel-level error wrapper: loader + alert + safe error capture so a failed
// fetch never leaves a spinner hanging.
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
