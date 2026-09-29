import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ConfirmModal from '../ConfirmModal/ConfirmModal';
import './AdminSupportChats.css';

/**
 * CHAT MANAGEMENT
 *
 * The admin "Chat management" sidebar tab: the queue of member support
 * conversations, and the place an administrator actually reads and answers them.
 *
 * This is a TWO-PANE inbox, not the expand-a-row queue used by Subscription
 * management, and the difference is deliberate. A subscription request is a
 * single artefact you glance at and decide on. A conversation is a dialogue —
 * answering it means reading the last three messages to know what to say, and
 * the reviewer needs the member's identity and plan context at the same time.
 * Expanding one row at a time would hide the rest of the queue behind the very
 * conversation being worked on.
 *
 * Notes that matter in review:
 *  • `request` is the dashboard's own fetch helper, so the admin bearer token
 *    and the 401→/admin/login redirect are inherited rather than reimplemented.
 *  • Deliberately NOT sent with `background: true`. That header exists so the
 *    dashboard's 10 s auto-refresh does not count as activity and keep an idle
 *    admin session alive forever. An administrator reading and answering member
 *    messages is unambiguously still there, so the heartbeat must run.
 *  • Polling is on, because the queue is the one admin screen that goes stale in
 *    a way that matters: a new conversation is somebody waiting.
 *
 * ── Layout ──────────────────────────────────────────────────────────────────
 * The queue is driven from the top by four stat cards rather than a row of flat
 * filter pills. The same four states exist either way, but a queue is triaged by
 * COUNT first — "is anything waiting on us?" — and a pill that happens to sit
 * 40px from the left edge does not read as a number. The cards are the filters.
 * Everything below them is unchanged behaviour wearing better clothes.
 */

const FILTERS = [
  { id: 'open', label: 'Waiting on us' },
  { id: 'pending', label: 'Waiting on member' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'all', label: 'All' },
];

const STATUS = {
  open: { label: 'Waiting on us', tone: 'open' },
  pending: { label: 'Waiting on member', tone: 'pending' },
  resolved: { label: 'Resolved', tone: 'resolved' },
};

const CATEGORIES = [
  { id: 'all', label: 'All topics' },
  { id: 'payment', label: 'Payment' },
  { id: 'billing', label: 'Billing' },
  { id: 'account', label: 'Account' },
  { id: 'technical', label: 'Technical' },
  { id: 'other', label: 'Other' },
];

/* The four stat cards. `tone` drives the whole card: the gradient wash, the
   icon tile, the count and the active ring all read from it, so a new queue
   state only has to be described in one place. */
const CARDS = [
  { id: 'open', tone: 'open', label: 'Waiting on us', hint: 'A member is waiting for a reply', icon: 'bell' },
  { id: 'pending', tone: 'pending', label: 'Waiting on member', hint: 'Answered — their move', icon: 'clock' },
  { id: 'resolved', tone: 'resolved', label: 'Resolved', hint: 'No reply expected', icon: 'check' },
  { id: 'all', tone: 'all', label: 'All chats', hint: 'Everything on record', icon: 'layers' },
];

const MAX_MESSAGE = 2000; // server/utils/supportChat.js MAX_MESSAGE_LENGTH
const POLL_MS = 12000;

/* Avatar gradients. A stable hue per member means the same face keeps the same
   colour everywhere in the tab, which is what makes a list scannable — a queue
   where every avatar is the same brown is a queue you read one row at a time.
   Hues are spaced 45° apart so no two neighbours collide. */
const AVATAR_GRADIENTS = [
  'linear-gradient(135deg, #f97316 0%, #e11d48 100%)',
  'linear-gradient(135deg, #4f6bed 0%, #7c3aed 100%)',
  'linear-gradient(135deg, #10b981 0%, #0d9488 100%)',
  'linear-gradient(135deg, #8b5cf6 0%, #d946ef 100%)',
  'linear-gradient(135deg, #f43f5e 0%, #f59e0b 100%)',
  'linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%)',
];

function formatStamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "12 min ago" — how stale a queue entry is IS the triage signal. */
function ago(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatStamp(value);
}

function initials(user) {
  const first = String(user?.firstName || '').trim();
  const last = String(user?.lastName || '').trim();
  if (!first && !last) return '?';
  if (!last) return first.slice(0, 2).toUpperCase();
  return (first[0] + last[0]).toUpperCase();
}

const memberName = (user) => {
  if (!user) return 'Unknown account';
  const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
  return name || user.email || 'Unknown account';
};

/** Stable per-member hue. Falls back to a fixed slot when there is no id yet. */
function avatarStyle(user) {
  const seed = String(user?._id || user?.email || user?.firstName || 'x');
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) % 100000;
  return { backgroundImage: AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length] };
}

const ICONS = {
  bell: (
    <>
      <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15.5 14" />
    </>
  ),
  check: (
    <>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
      <polyline points="9 11.5 11.2 13.7 15.5 9.4" />
    </>
  ),
  layers: (
    <>
      <polygon points="12 2.5 22 7.5 12 12.5 2 7.5" />
      <polyline points="2 16.5 12 21.5 22 16.5" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
};

function StatIcon({ name }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

export default function AdminSupportChats({ request }) {
  const [status, setStatus] = useState('open');
  const [category, setCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [activeSearch, setActiveSearch] = useState('');

  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ open: 0, pending: 0, resolved: 0, all: 0, unread: 0 });
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [activeId, setActiveId] = useState(null);
  const [active, setActive] = useState(null);   // { thread, messages[] }
  const [loadingThread, setLoadingThread] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const noticeTimer = useRef(null);
  // Monotonic tokens — a response for a filter, or for a conversation that has
  // since been closed, must never paint over what the admin is reading now.
  const listToken = useRef(0);
  const threadToken = useRef(0);

  const showNotice = useCallback((message) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(''), 6000);
  }, []);

  useEffect(() => () => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    listToken.current += 1;
    threadToken.current += 1;
  }, []);

  // ── Load the queue ──────────────────────────────────────────────────────
  const load = useCallback(async (nextStatus, nextSearch, nextCategory) => {
    const token = ++listToken.current;
    // NO setState before the first await — see the note in SupportInbox. A
    // synchronous setState in an effect's async body makes the effect's own
    // output a render input, and an unmemoized `request` prop then spins the
    // dashboard until React throws "Maximum update depth exceeded".
    try {
      const params = new URLSearchParams({ status: nextStatus, category: nextCategory, limit: '50' });
      if (nextSearch) params.set('search', nextSearch);
      const data = await request(`/chats?${params.toString()}`);
      if (token !== listToken.current) return;
      setError('');
      setRows(Array.isArray(data.threads) ? data.threads : []);
      setCounts(data.counts || { open: 0, pending: 0, resolved: 0, all: 0, unread: 0 });
      setLoaded(true);
    } catch (loadError) {
      if (token !== listToken.current) return;
      setError(loadError.message);
      setLoaded(true);
    } finally {
      if (token === listToken.current) setLoading(false);
    }
  }, [request]);

  // `load` is read through a ref so the effect depends only on what is MEANT to
  // trigger a reload. Depending on `load` directly would re-run on every render
  // if the parent ever hands down an unmemoized `request`.
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    loadRef.current(status, activeSearch, category);
  }, [status, activeSearch, category]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setActiveSearch((current) => (search.trim() === current ? current : search.trim()));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [search]);

  // Poll the queue so a new conversation is not invisible while an admin reads
  // one. Paused while hidden and while a send is in flight.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || sending) return;
      loadRef.current(status, activeSearch, category);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [status, activeSearch, category, sending]);

  // ── Open one conversation ───────────────────────────────────────────────
  const openThread = useCallback(async (id) => {
    const token = ++threadToken.current;
    setActiveId(id);
    setLoadingThread(true);
    setError('');
    try {
      const data = await request(`/chats/${id}`);
      if (token !== threadToken.current) return;
      setActive({ thread: data.thread, messages: Array.isArray(data.messages) ? data.messages : [] });
      // Opening clears the queue badge locally; the server already zeroed it.
      setRows((list) => list.map((t) => (t._id === id ? { ...t, unreadByAdmin: 0 } : t)));
      setCounts((c) => ({ ...c, unread: Math.max(0, c.unread - 1) }));
    } catch (loadError) {
      if (token !== threadToken.current) return;
      setError(loadError.message);
      setActive(null);
    } finally {
      if (token === threadToken.current) setLoadingThread(false);
    }
  }, [request]);

  // ── Transcript scroll ───────────────────────────────────────────────────
  // Scrolling the transcript element itself, not scrollIntoView: the panel is a
  // fixed-height scroller inside a scrolling page, and scrollIntoView drags the
  // whole admin shell sideways to reveal a message that is already visible.
  const scrollerRef = useRef(null);
  const [pinned, setPinned] = useState(true);
  const seenRef = useRef({ id: null, count: 0 });

  const handleTranscriptScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 120);
  }, []);

  const jumpToLatest = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    setPinned(true);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!active || !el) return;
    const isNewThread = seenRef.current.id !== active.thread._id;
    const count = active.messages.length;
    seenRef.current = { id: active.thread._id, count };
    // Follow the conversation when it is opened and when the admin is already at
    // the bottom. If they scrolled up to re-read something, leave them there and
    // offer the jump pill — yanking them back down is how you lose a message.
    if (isNewThread || pinned) el.scrollTop = el.scrollHeight;
  }, [active, pinned]);

  const closeThread = useCallback(() => {
    threadToken.current += 1;
    setActiveId(null);
    setActive(null);
    setDraft('');
    setError('');
    setPinned(true);
  }, []);

  // ── Reply ───────────────────────────────────────────────────────────────
  const trimmed = draft.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= MAX_MESSAGE && !sending;
  const remaining = MAX_MESSAGE - draft.length;

  const sendReply = useCallback(async (event) => {
    event?.preventDefault?.();
    if (sending || !active) return;
    if (!trimmed) { setError('Please type a reply before sending.'); return; }
    if (trimmed.length > MAX_MESSAGE) {
      setError(`Replies are limited to ${MAX_MESSAGE} characters.`);
      return;
    }
    const id = active.thread._id;
    setSending(true);
    setError('');
    try {
      const data = await request(`/chats/${id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: trimmed }),
      });
      setDraft('');
      // Append locally. A refetch here races the poll and can return before the
      // write is visible to a read, which makes the admin's own reply blink out.
      setActive((current) => (current && current.thread._id === id
        ? {
          thread: {
            ...current.thread,
            status: 'pending',
            lastMessageBy: 'admin',
            lastMessagePreview: data.message_record?.body || trimmed,
            lastMessageAt: data.message_record?.createdAt || new Date().toISOString(),
          },
          messages: [...current.messages, data.message_record].filter(Boolean),
        }
        : current));
      showNotice(data.message || 'Reply sent.');
      loadRef.current(status, activeSearch, category);
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setSending(false);
    }
  }, [sending, trimmed, active, request, showNotice, status, activeSearch, category]);

  // ── Resolve / reopen ────────────────────────────────────────────────────
  const applyState = useCallback(async (path, fallback) => {
    if (!active || busy) return;
    const id = active.thread._id;
    setBusy(true);
    setError('');
    try {
      const data = await request(`/chats/${id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      setActive((current) => (current && current.thread._id === id
        ? { ...current, thread: data.thread || current.thread }
        : current));
      showNotice(data.message || fallback);
      // The row leaves the current filter (or re-enters it), and the counts
      // moved — refetch rather than patching the row locally.
      await loadRef.current(status, activeSearch, category);
    } catch (stateError) {
      setError(stateError.message);
    } finally {
      setBusy(false);
    }
  }, [active, busy, request, showNotice, status, activeSearch, category]);

  const runDelete = useCallback(async () => {
    if (!confirmDelete || busy) return;
    const id = confirmDelete._id;
    setConfirmDelete(null);
    setBusy(true);
    setError('');
    try {
      await request(`/chats/${id}`, { method: 'DELETE' });
      if (activeId === id) closeThread();
      showNotice('Conversation deleted.');
      await loadRef.current(status, activeSearch, category);
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setBusy(false);
    }
  }, [confirmDelete, busy, request, showNotice, closeThread, activeId, status, activeSearch, category]);

  // ── Keyboard triage ─────────────────────────────────────────────────────
  // Working a queue is walking a list. Up/Down move the selection, Escape goes
  // back to the queue — the three keys that turn "read 30 conversations" from
  // 300 clicks into 60. Suppressed while typing so it cannot eat a message.
  const moveSelection = useCallback((delta) => {
    if (!rows.length) return;
    const index = rows.findIndex((r) => r._id === activeId);
    const start = index < 0 ? 0 : index;
    const next = Math.min(rows.length - 1, Math.max(0, start + delta));
    const target = rows[next];
    if (target) openThread(target._id);
  }, [rows, activeId, openThread]);

  useEffect(() => {
    const onKey = (event) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const el = event.target;
      const typing = Boolean(el) && (
        el.tagName === 'INPUT'
        || el.tagName === 'TEXTAREA'
        || el.tagName === 'SELECT'
        || el.isContentEditable
      );
      if (typing || confirmDelete) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Escape' && activeId) {
        closeThread();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId, confirmDelete, moveSelection, closeThread]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const filterCounts = useMemo(() => ({
    open: counts.open || 0,
    pending: counts.pending || 0,
    resolved: counts.resolved || 0,
    all: counts.all || 0,
  }), [counts]);

  const activeStatus = active ? (STATUS[active.thread.status] || STATUS.open) : null;
  const isResolved = active?.thread?.status === 'resolved';
  const user = active?.thread?.user || null;
  const banned = Boolean(user?.accountStatus && user.accountStatus !== 'active');
  const unread = counts.unread || 0;

  const emptyMessage = activeSearch
    ? 'No conversations match that search.'
    : status === 'all'
      ? 'No support conversations yet.'
      : `No conversations ${(FILTERS.find((f) => f.id === status)?.label || '').toLowerCase()}.`;

  return (
    <div className="asc">
      {/* ── Stat cards — these are the filters ──────────────────────────── */}
      <div className="asc-stats" role="group" aria-label="Filter conversations by status">
        {CARDS.map((card) => {
          const on = status === card.id;
          return (
            <button
              key={card.id}
              type="button"
              className={`asc-stat asc-stat--${card.tone}${on ? ' asc-stat--on' : ''}`}
              aria-pressed={on}
              onClick={() => setStatus(card.id)}
            >
              <span className="asc-stat__icon" aria-hidden="true"><StatIcon name={card.icon} /></span>
              <span className="asc-stat__body">
                <span className="asc-stat__value">{filterCounts[card.id]}</span>
                <span className="asc-stat__label">{card.label}</span>
                <span className="asc-stat__hint">{card.hint}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <div className="asc-toolbar">
        <div className="asc-toolbar__left">
          <span className="asc-toolbar__caption">
            {activeSearch
              ? <>Showing results for <strong>{activeSearch}</strong></>
              : <>Showing <strong>{(FILTERS.find((f) => f.id === status)?.label || 'all').toLowerCase()}</strong> conversations</>}
          </span>
        </div>

        <div className="asc-toolbar__right">
          <div className="asc-field">
            <label className="asc-visually-hidden" htmlFor="asc-category">Topic</label>
            <select
              id="asc-category"
              className="asc-select"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>

          <div className="asc-field asc-field--search">
            <svg className="asc-field__icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" />
            </svg>
            <input
              type="search"
              className="asc-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, email or subject…"
              aria-label="Search conversations by member, email or subject"
            />
          </div>

          <button
            type="button"
            className={`asc-refresh${loading ? ' asc-refresh--busy' : ''}`}
            onClick={() => load(status, activeSearch, category)}
            disabled={loading}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" /><polyline points="21 3 21 9 15 9" />
            </svg>
            <span>{loading ? 'Loading…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* ── Banners ─────────────────────────────────────────────────────── */}
      {unread > 0 && (
        <p className="asc-hint" role="status">
          <span className="asc-hint__dot" aria-hidden="true" />
          <span>
            <strong>{unread} unread message{unread === 1 ? '' : 's'}</strong> waiting on you.
            Opening a conversation marks it read.
          </span>
        </p>
      )}

      {error && <p className="asc-error" role="alert">{error}</p>}
      {notice && <p className="asc-notice" role="status">{notice}</p>}

      {/* ── Two panes ───────────────────────────────────────────────────── */}
      <div className={`asc-body${activeId ? ' asc-body--reading' : ''}`}>

        {/* Queue */}
        <section className="asc-list" aria-label="Support queue">
          <div className="asc-list__head">
            <span className="asc-list__title">Queue</span>
            <span className="asc-list__count">{rows.length}</span>
          </div>

          {!loaded ? (
            <div className="asc-skeletons" aria-hidden="true">
              {[0, 1, 2, 3].map((n) => (
                <div className="asc-skeleton" key={n}>
                  <span className="asc-skeleton__avatar" />
                  <span className="asc-skeleton__lines">
                    <span className="asc-skeleton__line asc-skeleton__line--sm" />
                    <span className="asc-skeleton__line" />
                    <span className="asc-skeleton__line asc-skeleton__line--xs" />
                  </span>
                </div>
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="asc-empty">
              <span className="asc-empty__icon" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
                </svg>
              </span>
              <p className="asc-empty__title">Nothing here</p>
              <p className="asc-empty__text">{emptyMessage}</p>
            </div>
          ) : (
            <ul className="asc-threads">
              {rows.map((row) => {
                const copy = STATUS[row.status] || STATUS.open;
                const isActive = activeId === row._id;
                const hasUnread = row.unreadByAdmin > 0;
                return (
                  <li key={row._id}>
                    <button
                      type="button"
                      className={`asc-thread asc-thread--${copy.tone}${isActive ? ' asc-thread--on' : ''}${hasUnread ? ' asc-thread--unread' : ''}`}
                      onClick={() => openThread(row._id)}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <span className="asc-thread__top">
                        <span className="asc-avatar" style={avatarStyle(row.user)} aria-hidden="true">
                          {initials(row.user)}
                        </span>
                        <span className="asc-thread__who">
                          <strong>{memberName(row.user)}</strong>
                          <em>{row.user?.email || '—'}</em>
                        </span>
                        {hasUnread && (
                          <span className="asc-dot" aria-label="Unread messages">{row.unreadByAdmin}</span>
                        )}
                      </span>
                      <span className="asc-thread__subject">{row.subject}</span>
                      <span className="asc-thread__preview">{row.lastMessagePreview || '—'}</span>
                      <span className="asc-thread__foot">
                        <span className={`asc-status asc-status--${copy.tone}`}>
                          <i className="asc-status__dot" aria-hidden="true" />
                          {copy.label}
                        </span>
                        <span className="asc-chip">{row.categoryLabel || row.category}</span>
                        <span className="asc-thread__time">{ago(row.lastMessageAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Conversation */}
        <section className="asc-view" aria-label="Conversation">
          {!activeId ? (
            <div className="asc-placeholder">
              <span className="asc-placeholder__art" aria-hidden="true">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z" />
                </svg>
              </span>
              <p className="asc-placeholder__title">No conversation selected</p>
              <p className="asc-placeholder__text">
                Pick a thread on the left to read the history and answer it.
              </p>
              <p className="asc-placeholder__keys">
                <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> send · <kbd>Esc</kbd> back
              </p>
            </div>
          ) : loadingThread && !active ? (
            <div className="asc-loading" aria-hidden="true">
              <div className="asc-loading__bubble asc-loading__bubble--theirs" />
              <div className="asc-loading__bubble asc-loading__bubble--mine" />
              <div className="asc-loading__bubble asc-loading__bubble--theirs asc-loading__bubble--short" />
            </div>
          ) : !active ? (
            <div className="asc-empty">
              <span className="asc-empty__icon" aria-hidden="true">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" /><path d="M12 8v5" /><path d="M12 16h.01" />
                </svg>
              </span>
              <p className="asc-empty__title">Conversation unavailable</p>
              <p className="asc-empty__text">It may have been deleted. Go back to the queue and pick another.</p>
            </div>
          ) : (
            <>
              <header className="asc-view__head">
                <button type="button" className="asc-back" onClick={closeThread}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  Back to the queue
                </button>

                <div className="asc-view__title">
                  <h3 className="asc-view__subject">{active.thread.subject}</h3>
                  <div className="asc-view__tags">
                    <span className={`asc-status asc-status--${activeStatus.tone}`}>
                      <i className="asc-status__dot" aria-hidden="true" />
                      {activeStatus.label}
                    </span>
                    <span className="asc-chip">{active.thread.categoryLabel || active.thread.category}</span>
                    {active.thread.assignedTo && (
                      <span className="asc-chip asc-chip--assignee">Assigned to {active.thread.assignedTo}</span>
                    )}
                    {banned && <span className="asc-flag">{String(user.accountStatus).toUpperCase()}</span>}
                  </div>
                </div>

                <div className="asc-view__member">
                  <span className="asc-avatar asc-avatar--lg" style={avatarStyle(user)} aria-hidden="true">
                    {initials(user)}
                  </span>
                  <span className="asc-view__memberText">
                    <strong>{memberName(user)}</strong>
                    <em>{user?.email || '—'}</em>
                  </span>
                  <button
                    type="button"
                    className={`asc-stateBtn asc-stateBtn--${isResolved ? 'reopen' : 'resolve'}`}
                    onClick={() => applyState(isResolved ? 'reopen' : 'resolve', isResolved ? 'Conversation reopened.' : 'Conversation resolved.')}
                    disabled={busy}
                  >
                    {busy ? 'Working…' : isResolved ? 'Reopen chat' : 'Mark resolved'}
                  </button>
                </div>

                <div className="asc-view__meta">
                  <span>Opened {formatStamp(active.thread.createdAt)}</span>
                  {active.thread.messageCount > 0 && (
                    <span>{active.thread.messageCount} message{active.thread.messageCount === 1 ? '' : 's'}</span>
                  )}
                  {active.thread.resolved?.at && (
                    <span className="asc-view__metaOk">
                      Resolved {formatStamp(active.thread.resolved.at)} by {active.thread.resolved.by || '—'}
                    </span>
                  )}
                </div>
              </header>

              <div className="asc-transcript">
                {isResolved && (
                  <p className="asc-resolved" role="status">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Resolved — this thread is read-only for both sides. Use “Reopen chat” in the header above to continue the conversation.
                  </p>
                )}

                <div className="asc-messages" ref={scrollerRef} onScroll={handleTranscriptScroll}>
                  {active.messages.length === 0 ? (
                    <p className="asc-empty">No messages yet.</p>
                  ) : active.messages.map((m) => {
                    const mine = m.author === 'admin';
                    return (
                      <div key={m._id} className={`asc-msg${mine ? ' asc-msg--mine' : ' asc-msg--theirs'}`}>
                        <div className="asc-msg__head">
                          <span className="asc-msg__who">
                            {mine ? (m.authorName || 'You') : memberName(user)}
                          </span>
                          <span className="asc-msg__time">{formatStamp(m.createdAt)}</span>
                        </div>
                        <div className="asc-msg__body">{m.body}</div>
                      </div>
                    );
                  })}
                </div>

                {!pinned && (
                  <button type="button" className="asc-jump" onClick={jumpToLatest}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 5v14M5 12l7 7 7-7" />
                    </svg>
                    Latest message
                  </button>
                )}
              </div>

              {isResolved ? (
                /* The composer is REPLACED, not disabled. A greyed-out input box
                   invites typing into it; saying what is true is faster. There is
                   deliberately NO reopen button here: the header's state toggle is
                   the single control for this, it sits above the transcript so it
                   stays visible while you scroll, and two identical buttons on one
                   screen is how the wrong one gets pressed. The server refuses a
                   reply on a resolved thread with 409 regardless — this is the UI
                   agreeing with a rule, not inventing one. */
                <div className="asc-reply asc-reply--locked">
                  <div className="asc-locked">
                    <span className="asc-locked__icon" aria-hidden="true">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="4" y="10.5" width="16" height="10" rx="2.5" />
                        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
                      </svg>
                    </span>
                    <div className="asc-locked__text">
                      <strong>Conversation resolved</strong>
                      <span>
                        This thread is read-only for you and for the member. Use
                        “Reopen chat” above to continue the conversation.
                      </span>
                    </div>
                    <button
                      type="button"
                      className="asc-btn asc-btn--danger"
                      onClick={() => setConfirmDelete(active.thread)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ) : (
                <form className="asc-reply" onSubmit={sendReply}>
                  <textarea
                    rows={3}
                    maxLength={MAX_MESSAGE}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendReply(e);
                      }
                    }}
                    placeholder={`Reply to ${memberName(user)}…`}
                    aria-label="Reply to this conversation"
                  />
                  <div className="asc-reply__foot">
                    <div className="asc-reply__left">
                      <span className="asc-reply__hint">
                        <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
                      </span>
                      {remaining < 200 && <span className="asc-reply__count">{remaining} left</span>}
                    </div>
                    <div className="asc-reply__actions">
                      <button
                        type="button"
                        className="asc-btn asc-btn--danger"
                        onClick={() => setConfirmDelete(active.thread)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                      <button type="submit" className="asc-btn asc-btn--primary" disabled={!canSend}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M22 2 11 13" /><path d="M22 2l-7 20-4-9-9-4 20-7z" />
                        </svg>
                        {sending ? 'Sending…' : 'Send reply'}
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </>
          )}
        </section>
      </div>

      {confirmDelete && (
        <ConfirmModal
          type="danger"
          title="Delete this conversation?"
          message={`“${confirmDelete.subject}” from ${memberName(confirmDelete.user)} and its entire transcript will be permanently removed. Use this for spam or abuse — resolving keeps the record.`}
          confirmText="Delete permanently"
          cancelText="Keep it"
          onConfirm={runDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
