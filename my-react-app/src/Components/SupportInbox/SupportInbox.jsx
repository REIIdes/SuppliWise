import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getMySupportThreads,
  getSupportThread,
  startSupportThread,
  replyToSupportThread,
} from '../../api';
import './SupportInbox.css';

/**
 * SUPPORT INBOX — the member's side of the conversation with the admin team.
 *
 * This is the destination behind the pricing page's "Talk to support" button
 * and the Support entry in the account menu. It is a two-pane layout on a
 * desktop and collapses to one pane at a time on a phone.
 *
 * ── Behaviour that is load-bearing, not cosmetic ────────────────────────────
 *
 *  • The list is polled, not pushed. There is no socket layer in this app, and
 *    a support inbox that only updates when you re-click Refresh reads as
 *    broken while you wait for an answer. The poll is paused while the tab is
 *    hidden and while a send is in flight, and a response for a thread the
 *    member has since left is discarded.
 *
 *  • `loaded` is tracked separately from `loading`. The first load no longer
 *    sets state synchronously (see the note on `load` below), so "still
 *    loading" cannot be derived from the spinner or every refresh would blank
 *    the list.
 *
 *  • "Reopen" is NOT offered to the member. Resolving and reopening are both
 *    administrator actions, on the server, in routes/adminSupportChats.js — so
 *    this inbox has no button that could even try. A resolved thread is
 *    read-only here and offers a way to start a NEW conversation instead, which
 *    keeps the old transcript intact and puts the question back in the queue
 *    where an administrator can see it. Offering a "reopen" that the API would
 *    reject with a 409 would be worse than offering nothing.
 *
 *  • The composer is a form, so Enter sends and Shift+Enter makes a new line.
 *    Without that, sending a two-line question costs three extra taps.
 *
 * ── The visual redesign ────────────────────────────────────────────────────
 *
 * The old page was four grey-white boxes on a flat mint page: a plain heading,
 * a dark-green button, unlabelled chips and one flat empty state. It read as an
 * admin form rather than a conversation, and the list gave no way to narrow
 * twenty mixed-status threads.
 *
 * What changed, and why it is not just decoration:
 *
 *  • ONE accent per topic, ONE per status. A category picks an accent hue that
 *    is then used for its icon, its card, the chip on the thread header and
 *    the row in the list — so a conversation about a payment is recognisably a
 *    payment at every size, without reading a single word. Same for status:
 *    amber = we owe you, indigo = you owe us, emerald = done. That is the
 *    fastest signal in the whole page and it is now carried by colour.
 *
 *  • Status filters. Threads arrive mixed; before, finding the one waiting on
 *    you meant reading every row. Four chips (All / With support / Your turn /
 *    Resolved) with live counts turn that into one tap. Purely client-side —
 *    the server still returns the same list — so the poll cannot contradict it.
 *
 *  • The composer is an app panel, not a form. Fixed-height panes with an
 *    internally scrolling transcript, so the reply box is always on screen
 *    without the page scrolling. Previously a long conversation pushed the
 *    reply box below the fold, which is a support inbox nobody replies from.
 *
 *  • Both empty states now offer the action that fills them. A dead end that
 *    says "you have no conversations" is a dead end; one that says it and
 *    offers the button is a starting point.
 *
 *  • A skeleton, not a text spinner, for the first load — and it is
 *    `aria-hidden` with a real `role="status"` message beside it, so it never
 *    reads three skeleton bars to a screen reader.
 */

/* ── Icons ────────────────────────────────────────────────────────────────
   Inline, sized in `em` and coloured by `currentColor`, so every icon in the
   page inherits the accent of whatever it sits in. There is no icon library
   dependency in this feature. */

const icon = (children) => function Icon(props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
};

const IconCard = icon(<>
  <rect x="2" y="5" width="20" height="14" rx="2.5" />
  <path d="M2 10h20" />
  <path d="M6 15h4" />
</>);
const IconDoc = icon(<>
  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
  <path d="M14 3v5h5" />
  <path d="M9 13h6M9 17h4" />
</>);
const IconUser = icon(<>
  <circle cx="12" cy="8" r="4" />
  <path d="M4 21a8 8 0 0 1 16 0" />
</>);
const IconTool = icon(<>
  <path d="M14.7 6.3a4 4 0 0 1-5.1 5.1L4 17.2V20h2.8l5.6-5.6a4 4 0 0 0 5.1-5.1l-2.5 2.5-2.5-.6-.6-2.5z" />
</>);
const IconSpark = icon(<>
  <path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7z" />
  <path d="M18.5 16l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
</>);
const IconPlus = icon(<>
  <path d="M12 5v14M5 12h14" />
</>);
const IconSend = icon(<>
  <path d="M21.5 2.5L11 13" />
  <path d="M21.5 2.5l-6.7 19-3.8-8.5-8.5-3.8z" />
</>);
const IconBack = icon(<>
  <path d="M15 18l-6-6 6-6" />
</>);
const IconHeadset = icon(<>
  <path d="M3.5 17v-5a8.5 8.5 0 0 1 17 0v5" />
  <path d="M20.5 18a2.5 2.5 0 0 1-2.5 2.5H17a1.5 1.5 0 0 1-1.5-1.5v-3A1.5 1.5 0 0 1 17 14.5h3.5z" />
  <path d="M3.5 18a2.5 2.5 0 0 0 2.5 2.5H7a1.5 1.5 0 0 0 1.5-1.5v-3A1.5 1.5 0 0 0 7 14.5H3.5z" />
</>);
const IconCheck = icon(<>
  <path d="M20 6.5L9.5 17 4 11.5" />
</>);
const IconClose = icon(<>
  <path d="M18 6L6 18M6 6l12 12" />
</>);
const IconAlert = icon(<>
  <circle cx="12" cy="12" r="9" />
  <path d="M12 7.5v5.5" />
  <path d="M12 16.4v.2" />
</>);
const IconInbox = icon(<>
  <path d="M21 12.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.9-.9L3 21.5l1.8-4.7A8.5 8.5 0 0 1 12.5 4 8.5 8.5 0 0 1 21 12.5z" />
</>);
const IconRefresh = icon(<>
  <path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1" />
  <path d="M20.5 4.5V10h-5.5" />
</>);

/* ── Topics ─────────────────────────────────────────────────────────────── */

const CATEGORIES = [
  { id: 'payment', label: 'Payment', hint: 'Where I paid, transfer not showing, receipt', Icon: IconCard },
  { id: 'billing', label: 'Billing & plans', hint: 'Charges, renewals, refunds, invoices', Icon: IconDoc },
  { id: 'account', label: 'My account', hint: 'Sign-in, email, two-factor, data', Icon: IconUser },
  { id: 'technical', label: 'Technical', hint: 'Something not working, an error', Icon: IconTool },
  { id: 'other', label: 'Something else', hint: 'Anything that does not fit above', Icon: IconSpark },
];

const CATEGORY_BY_ID = CATEGORIES.reduce((acc, c) => { acc[c.id] = c; return acc; }, {});

/**
 * The server is authoritative and may hand back a category this build has no
 * card for. Unknown ids fall back to "other" rather than rendering a blank row.
 * The class suffix is what the stylesheet keys its accent hues off.
 */
const categoryOf = (id) => CATEGORY_BY_ID[id] || CATEGORY_BY_ID.other;
const accentOf = (id) => `sci-acc--${CATEGORY_BY_ID[id] ? id : 'other'}`;

/** The topic's icon, resolved through the same fallback the label uses. */
function TopicIcon({ id, ...rest }) {
  const Glyph = categoryOf(id).Icon;
  return <Glyph {...rest} />;
}

/* Mirrors server/utils/supportChat.js. The server is authoritative; these are
   only the labels and the order they appear in. `short` is for the 300px list
   column, where the full sentence wraps to two lines; `label` is for the
   thread header, where there is room. */
const STATUS = {
  open: { label: 'Waiting for support', short: 'With support', tone: 'open' },
  pending: { label: 'Replied — waiting on you', short: 'Your turn', tone: 'pending' },
  resolved: { label: 'Resolved', short: 'Resolved', tone: 'resolved' },
};
const statusOf = (status) => STATUS[status] || STATUS.open;

const FILTERS = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'open', label: 'With support', test: (t) => (t.status || 'open') === 'open' },
  { id: 'pending', label: 'Your turn', test: (t) => t.status === 'pending' },
  { id: 'resolved', label: 'Resolved', test: (t) => t.status === 'resolved' },
];

const MAX_MESSAGE = 2000; // server/utils/supportChat.js MAX_MESSAGE_LENGTH

function formatStamp(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** "just now" / "12 min ago" / a date — the freshness is the whole question. */
function ago(value) {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatStamp(value);
}

/** Local calendar day, so "same day" means the member's day and not UTC's. */
function dayKey(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(value) {
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86400000);
  if (dayKey(d) === dayKey(today)) return 'Today';
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function SupportInbox({ initialCategory = 'other', startComposing = false }) {
  const [threads, setThreads] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [activeId, setActiveId] = useState(null);
  const [active, setActive] = useState(null);   // { thread, messages[] }
  const [loaded, setLoaded] = useState(false);
  // `loaded` already distinguishes "has never finished a load" from "refreshing",
  // and the first load does not set state synchronously — so a second
  // `loadingList` flag would be a second, subtly different answer to the same
  // question, and nothing was reading it. One source for "is the list ready".
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // Which slice of the list is on screen. Client-side only: the server returns
  // the same threads either way, so a poll landing mid-filter cannot contradict
  // what the member chose — it just re-renders the same slice.
  const [filter, setFilter] = useState('all');

  // The new-conversation form. `startComposing` opens it on mount — that is
  // what the pricing page's "Talk to support" button asks for, so somebody
  // cancelling a plan over a transfer lands on a ready-to-type form instead of
  // an empty list they have to work out how to use. Seeding it as state (not
  // toggling it in an effect) is deliberate: an effect that flipped a flag on
  // mount is exactly the "setState in effect" pattern that re-runs loops.
  const [composing, setComposing] = useState(startComposing);
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState(
    CATEGORIES.some((c) => c.id === initialCategory) ? initialCategory : 'other'
  );
  const [draft, setDraft] = useState('');

  const [sending, setSending] = useState(false);

  const noticeTimer = useRef(null);
  // Monotonic tokens. A response for a thread/filter the member has since
  // changed must never paint over what they are looking at now.
  const listToken = useRef(0);
  const threadToken = useRef(0);
  // A mirror of `threads` that callbacks with a stable identity can read.
  // Needed because `openThread` must not depend on `threads` (that would give
  // it a new identity on every poll and re-run the effect that depends on it),
  // and reading the flag out of a setState updater is not allowed — updaters
  // must stay pure because React may call them more than once.
  const threadsRef = useRef([]);
  useEffect(() => { threadsRef.current = threads; }, [threads]);

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

  // ── The list ────────────────────────────────────────────────────────────
  const loadList = useCallback(async () => {
    const token = ++listToken.current;
    // NO setState before the first await: this is called from an effect, and a
    // synchronous setState here would make the effect's own output a render
    // input, which spins until React throws "Maximum update depth exceeded".
    try {
      const data = await getMySupportThreads(20);
      if (token !== listToken.current) return;
      setThreads(Array.isArray(data.threads) ? data.threads : []);
      setUnreadCount(Number(data.unreadCount) || 0);
      setError('');
      setLoaded(true);
    } catch (loadError) {
      if (token !== listToken.current) return;
      setError(loadError.message);
      setLoaded(true);
    } finally {
      // Nothing to do: `loaded` is set on both paths above, and the stale-reply
      // guards have already returned by this point.
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async load populates state from the server
  useEffect(() => { loadList(); }, [loadList]);

  // Poll while the tab is visible, and never while a send is in flight — a poll
  // landing mid-send can repaint a message the member has not seen acknowledged
  // yet, which reads as the send being dropped.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.hidden || sending) return;
      loadList();
    }, 12000);
    const onVisible = () => { if (!document.hidden) loadList(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadList, sending]);

  // ── One thread ──────────────────────────────────────────────────────────
  const openThread = useCallback(async (id) => {
    const token = ++threadToken.current;
    setActiveId(id);
    setLoadingThread(true);
    setError('');
    try {
      const data = await getSupportThread(id);
      if (token !== threadToken.current) return;
      setActive({ thread: data.thread, messages: Array.isArray(data.messages) ? data.messages : [] });
      // Opening it marks it read server-side, so the local badge is cleared
      // rather than waiting for the next poll to agree. The decrement is driven
      // by what the thread ACTUALLY had (read from the ref, not from inside a
      // state updater) — an unconditional `n - 1` would drive the counter
      // negative every time a thread with no unread reply was opened.
      const wasUnread = (threadsRef.current.find((t) => t._id === id)?.unreadByUser || 0) > 0;
      setThreads((list) => list.map((t) => (t._id === id ? { ...t, unreadByUser: 0 } : t)));
      if (wasUnread) setUnreadCount((n) => Math.max(0, n - 1));
    } catch (loadError) {
      if (token !== threadToken.current) return;
      setError(loadError.message);
      setActive(null);
    } finally {
      if (token === threadToken.current) setLoadingThread(false);
    }
  }, []);

  // Keep the transcript pinned to the newest message.
  //
  // It scrolls the transcript's OWN scroll container rather than calling
  // scrollIntoView(). scrollIntoView() walks up and scrolls every scrollable
  // ancestor it finds, page included, so opening a conversation on a phone
  // yanked the whole document down past the navbar. Scoping the scroll to the
  // box it is already inside does the same job and touches nothing else.
  const endRef = useRef(null);
  useEffect(() => {
    if (!active) return;
    const box = endRef.current?.closest('.sci-messages');
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }, [active]);

  // ── Sends ───────────────────────────────────────────────────────────────
  const trimmed = draft.trim();

  const sendNew = useCallback(async (event) => {
    event?.preventDefault?.();
    if (sending) return;
    if (!trimmed) { setError('Please type a message before sending.'); return; }
    if (trimmed.length > MAX_MESSAGE) {
      setError(`Messages are limited to ${MAX_MESSAGE} characters.`);
      return;
    }
    setSending(true);
    setError('');
    try {
      const data = await startSupportThread({ subject, category, body: trimmed });
      setDraft('');
      setSubject('');
      setComposing(false);
      // A brand-new conversation belongs at the top of "All" no matter which
      // slice the member was looking at — otherwise the thread they just sent
      // is not in the list they are looking at, which reads as a failed send.
      setFilter('all');
      showNotice(data.message || 'Your message was sent.');
      await loadList();
      // Open it straight away: after pressing Send, landing on an empty list
      // makes it look as though the message did not register.
      if (data.thread?._id) await openThread(data.thread._id);
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setSending(false);
    }
  }, [sending, trimmed, subject, category, showNotice, loadList, openThread]);

  const sendReply = useCallback(async (event) => {
    event?.preventDefault?.();
    if (sending || !active) return;
    if (!trimmed) { setError('Please type a message before sending.'); return; }
    if (trimmed.length > MAX_MESSAGE) {
      setError(`Messages are limited to ${MAX_MESSAGE} characters.`);
      return;
    }
    const id = active.thread._id;
    setSending(true);
    setError('');
    try {
      const data = await replyToSupportThread(id, trimmed);
      setDraft('');
      // Append locally rather than refetching: the reply is already known, and
      // a refetch here would race the poll and can land before the write is
      // visible to a read, making the member's own message blink out.
      setActive((current) => (current && current.thread._id === id
        ? {
          thread: {
            ...current.thread,
            status: 'open',
            lastMessageBy: 'user',
            lastMessagePreview: data.message_record?.body || trimmed,
            lastMessageAt: data.message_record?.createdAt || new Date().toISOString(),
          },
          messages: [...current.messages, data.message_record].filter(Boolean),
        }
        : current));
      showNotice(data.message || 'Reply sent.');
      loadList();
    } catch (sendError) {
      setError(sendError.message);
    } finally {
      setSending(false);
    }
  }, [sending, trimmed, active, showNotice, loadList]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const activeStatus = active ? statusOf(active.thread.status) : null;
  // Resolved is read-only. The composer is replaced outright rather than
  // disabled, so the reason is visible instead of a dead input box: a member
  // who cannot reply is owed the explanation, not a silent failure.
  const activeResolved = active?.thread?.status === 'resolved';
  const remaining = MAX_MESSAGE - draft.length;
  const canSend = trimmed.length > 0 && trimmed.length <= MAX_MESSAGE && !sending;

  // The reply box grows with the message instead of scrolling inside a fixed
  // 3-row textarea. Capped so a long reply cannot push the transcript off the
  // screen, and it is the box that scrolls once it hits the cap.
  const replyRef = useRef(null);
  useEffect(() => {
    const el = replyRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 190)}px`;
  }, [draft, activeId, active]);

  // Counts for the filter chips, and the slice itself. One pass over the list.
  // Every filter is counted on every row, NOT just the first match: "all"
  // matches every thread, so breaking on the first hit would have left every
  // other chip reading zero.
  const { counts, visible } = useMemo(() => {
    const next = {};
    FILTERS.forEach((f) => { next[f.id] = 0; });
    const chosen = FILTERS.find((f) => f.id === filter) || FILTERS[0];
    const rows = [];
    threads.forEach((t) => {
      FILTERS.forEach((f) => { if (f.test(t)) next[f.id] += 1; });
      if (chosen.test(t)) rows.push(t);
    });
    return { counts: next, visible: rows };
  }, [threads, filter]);

  const activeCount = visible.length;
  // NOT named `startComposing` — that is the prop, and a second binding of the
  // same name in this scope is a redeclaration, not a shadow.
  const openComposer = useCallback(() => {
    setComposing(true);
    setError('');
  }, []);

  return (
    <div className="sci">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="sci-hero">
        <div className="sci-hero__main">
          <span className="sci-hero__mark" aria-hidden="true">
            <IconHeadset />
          </span>
          <div className="sci-hero__text">
            <h1 className="sci-title">Support</h1>
            <p className="sci-sub">
              Ask us anything about your account, your plan or a payment. An
              administrator replies here, and you will get a notification when
              they do.
            </p>
          </div>
        </div>

        <div className="sci-hero__side">
          {/* At-a-glance state of the queue. The counts are the same ones the
              filter chips below use, so the header and the list can never
              disagree about how many of each there are. */}
          <ul className="sci-stats">
            <li className="sci-stat sci-stat--all">
              <span className="sci-stat__n">{threads.length}</span>
              <span className="sci-stat__l">Total</span>
            </li>
            <li className="sci-stat sci-stat--open">
              <span className="sci-stat__n">{counts.open}</span>
              <span className="sci-stat__l">With support</span>
            </li>
            <li className="sci-stat sci-stat--pending">
              <span className="sci-stat__n">{counts.pending}</span>
              <span className="sci-stat__l">Your turn</span>
              {unreadCount > 0 && (
                <span className="sci-stat__flag" role="status">
                  {unreadCount} new
                </span>
              )}
            </li>
            <li className="sci-stat sci-stat--resolved">
              <span className="sci-stat__n">{counts.resolved}</span>
              <span className="sci-stat__l">Resolved</span>
            </li>
          </ul>

          {!composing && (
            <button
              type="button"
              className="sci-btn sci-btn--primary sci-btn--lg"
              onClick={openComposer}
            >
              <IconPlus />
              New conversation
            </button>
          )}
        </div>
      </header>

      {error && (
        <p className="sci-alert sci-alert--error" role="alert">
          <IconAlert className="sci-alert__icon" />
          <span>{error}</span>
        </p>
      )}
      {notice && (
        <p className="sci-alert sci-alert--ok" role="status">
          <IconCheck className="sci-alert__icon" />
          <span>{notice}</span>
        </p>
      )}

      {/* ── The new-conversation form ───────────────────────────────────── */}
      {composing && (
        <form className="sci-compose" onSubmit={sendNew}>
          <div className="sci-compose__head">
            <h2 className="sci-compose__title">Start a conversation</h2>
            <p className="sci-compose__lede">
              Tell us what happened and we will reply in this thread. Pick the
              closest topic so it reaches the right person first time.
            </p>
          </div>

          <fieldset className="sci-field">
            <legend>What is this about?</legend>
            <div className="sci-cats" role="radiogroup" aria-label="Conversation topic">
              {CATEGORIES.map((c) => {
                const on = category === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`sci-cat ${accentOf(c.id)}${on ? ' sci-cat--on' : ''}`}
                    onClick={() => setCategory(c.id)}
                  >
                    <span className="sci-cat__icon" aria-hidden="true"><c.Icon /></span>
                    <span className="sci-cat__text">
                      <span className="sci-cat__label">{c.label}</span>
                      <span className="sci-cat__hint">{c.hint}</span>
                    </span>
                    <span className="sci-cat__tick" aria-hidden="true"><IconCheck /></span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="sci-field">
            <label htmlFor="sci-subject">
              Subject <em>optional</em>
            </label>
            <input
              id="sci-subject"
              type="text"
              maxLength={160}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. I transferred ₱1,295 on Tuesday"
            />
            <small className="sci-hint">
              No subject? We will use the first line of your message.
            </small>
          </div>

          <div className="sci-field">
            <label htmlFor="sci-body">Message</label>
            <textarea
              id="sci-body"
              rows={5}
              maxLength={MAX_MESSAGE}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Tell us what happened, and include any reference number from your receipt if you have one."
            />
            <small className={`sci-count${remaining < 200 ? ' sci-count--near' : ''}`}>
              {remaining < 200 ? `${remaining} characters left` : 'Shift+Enter for a new line'}
            </small>
          </div>

          <div className="sci-compose__actions">
            <button
              type="button"
              className="sci-btn sci-btn--ghost"
              onClick={() => { setComposing(false); setDraft(''); setError(''); }}
              disabled={sending}
            >
              Cancel
            </button>
            <button type="submit" className="sci-btn sci-btn--primary" disabled={!canSend}>
              {sending ? <><span className="sci-spinner" aria-hidden="true" />Sending…</> : <><IconSend />Send message</>}
            </button>
          </div>
        </form>
      )}

      {/* ── Two panes ───────────────────────────────────────────────────── */}
      <div className={`sci-body${activeId ? ' sci-body--reading' : ''}`}>

        {/* List */}
        <section className="sci-list" aria-label="Your conversations">
          <div className="sci-list__head">
            <div className="sci-list__titlerow">
              <h2>Conversations</h2>
              <span className="sci-tally">{threads.length}</span>
            </div>

            {/* Four slices of the same list. `aria-pressed` rather than
                role="tab": there is no second panel for these to point at, and
                a tablist without tabpanels is a lie to a screen reader. */}
            <div className="sci-filters" role="group" aria-label="Filter conversations by status">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  className={`sci-filter sci-filter--${f.id}${filter === f.id ? ' sci-filter--on' : ''}`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  <span className="sci-filter__n">{counts[f.id]}</span>
                </button>
              ))}
            </div>
          </div>

          {!loaded ? (
            <>
              <p className="sci-sr" role="status">Loading your conversations…</p>
              <ul className="sci-threads" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <li className="sci-skel" key={i}>
                    <span className="sci-skel__icon" />
                    <span className="sci-skel__lines">
                      <span className="sci-skel__line sci-skel__line--title" />
                      <span className="sci-skel__line" />
                      <span className="sci-skel__line sci-skel__line--short" />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : threads.length === 0 ? (
            <div className="sci-empty">
              <span className="sci-empty__art" aria-hidden="true">
                <IconInbox />
              </span>
              <p className="sci-empty__title">No conversations yet</p>
              <p className="sci-empty__body">
                {composing
                  ? 'Pick a topic above and send your first message — it lands straight in the support queue.'
                  : 'Ask us anything about your account, your plan or a payment and an administrator will reply here.'}
              </p>
              {!composing && (
                <button type="button" className="sci-btn sci-btn--primary" onClick={openComposer}>
                  <IconPlus />
                  Start your first conversation
                </button>
              )}
            </div>
          ) : activeCount === 0 ? (
            <div className="sci-empty">
              <span className="sci-empty__art" aria-hidden="true">
                <IconCheck />
              </span>
              <p className="sci-empty__title">Nothing here</p>
              <p className="sci-empty__body">
                You have no conversations marked “{FILTERS.find((f) => f.id === filter)?.label}”.
              </p>
              <button type="button" className="sci-btn sci-btn--ghost" onClick={() => setFilter('all')}>
                <IconRefresh />
                Show all {threads.length}
              </button>
            </div>
          ) : (
            <ul className="sci-threads">
              {visible.map((t) => {
                const copy = statusOf(t.status);
                const isActive = activeId === t._id;
                return (
                  <li key={t._id}>
                    <button
                      type="button"
                      className={`sci-thread sci-thread--${copy.tone}${isActive ? ' sci-thread--on' : ''}`}
                      onClick={() => openThread(t._id)}
                      aria-current={isActive ? 'true' : undefined}
                    >
                      <span className={`sci-thread__icon ${accentOf(t.category)}`} aria-hidden="true">
                        <TopicIcon id={t.category} />
                      </span>

                      <span className="sci-thread__col">
                        <span className="sci-thread__top">
                          <strong>{t.subject}</strong>
                          {t.unreadByUser > 0 && (
                            <span className="sci-unread">{t.unreadByUser}</span>
                          )}
                        </span>
                        <span className="sci-thread__preview">{t.lastMessagePreview || '—'}</span>
                        <span className="sci-thread__foot">
                          <span className={`sci-status sci-status--${copy.tone}`}>
                            <span className="sci-status__dot" aria-hidden="true" />
                            {copy.short}
                          </span>
                          <span className="sci-thread__time">{ago(t.lastMessageAt)}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Thread */}
        <section className="sci-view" aria-label="Conversation">
          {!activeId ? (
            <div className="sci-placeholder">
              <span className="sci-placeholder__art" aria-hidden="true">
                <IconHeadset />
              </span>
              <p className="sci-placeholder__title">Nothing open</p>
              <p className="sci-placeholder__body">
                Pick a conversation on the left to read it, or start a new one
                and an administrator will get back to you here.
              </p>
              {!composing && (
                <button type="button" className="sci-btn sci-btn--primary" onClick={openComposer}>
                  <IconPlus />
                  New conversation
                </button>
              )}
            </div>
          ) : loadingThread && !active ? (
            <div className="sci-placeholder">
              <span className="sci-spinner sci-spinner--lg" aria-hidden="true" />
              <p className="sci-placeholder__body">Loading the conversation…</p>
            </div>
          ) : !active ? (
            <div className="sci-placeholder">
              <span className="sci-empty__art" aria-hidden="true"><IconClose /></span>
              <p className="sci-placeholder__title">Not available</p>
              <p className="sci-placeholder__body">
                That conversation is no longer available.
              </p>
            </div>
          ) : (
            <>
              <header className={`sci-view__head sci-view__head--${activeStatus.tone}`}>
                <div className="sci-view__bar" aria-hidden="true" />
                <button
                  type="button"
                  className="sci-back"
                  onClick={() => { threadToken.current += 1; setActiveId(null); setActive(null); setDraft(''); setError(''); }}
                >
                  <IconBack />
                  All conversations
                </button>

                <div className="sci-view__titlerow">
                  <h2 className="sci-view__subject">{active.thread.subject}</h2>
                  {active.thread.unreadByUser > 0 && (
                    <span className="sci-unread">{active.thread.unreadByUser}</span>
                  )}
                </div>

                <div className="sci-view__tags">
                  <span className={`sci-chip sci-chip--${activeStatus.tone}`}>
                    <span className="sci-status__dot" aria-hidden="true" />
                    {activeStatus.label}
                  </span>
                  <span className={`sci-topic ${accentOf(active.thread.category)}`}>
                    <span className="sci-topic__icon" aria-hidden="true">
                      <TopicIcon id={active.thread.category} />
                    </span>
                    {categoryOf(active.thread.category).label}
                  </span>
                </div>

                <p className="sci-view__meta">
                  Started {formatStamp(active.thread.createdAt)}
                  {active.thread.messageCount > 0 && ` · ${active.thread.messageCount} message${active.thread.messageCount === 1 ? '' : 's'}`}
                  {active.thread.resolved?.at && ` · resolved ${formatStamp(active.thread.resolved.at)}`}
                </p>
              </header>

              <div className="sci-view__body">
                <div className="sci-messages">
                  {active.messages.length === 0 ? (
                    <p className="sci-empty">No messages yet.</p>
                  ) : active.messages.map((m, i) => {
                    const mine = m.author === 'user';
                    const prev = active.messages[i - 1];
                    const sameDay = prev ? dayKey(prev.createdAt) === dayKey(m.createdAt) : false;
                    const showDay = !sameDay;
                    // Author + timestamp repeat on every message of a long
                    // back-and-forth, which turns a transcript into a wall of
                    // identical labels. Show them only on the first message of
                    // a run from the same person on the same day.
                    const showMeta = !prev || !sameDay || prev.author !== m.author;
                    return (
                      <Fragment key={m._id}>
                        {showDay && (
                          <div className="sci-day">
                            <span>{dayLabel(m.createdAt)}</span>
                          </div>
                        )}
                        <div className={`sci-msg sci-msg--${mine ? 'mine' : 'theirs'}`}>
                          {!mine && (
                            <span className="sci-msg__avatar" aria-hidden="true">
                              <IconHeadset />
                            </span>
                          )}
                          <div className="sci-msg__col">
                            {showMeta && (
                              <div className="sci-msg__head">
                                <span className="sci-msg__who">{mine ? 'You' : (m.authorName || 'Support team')}</span>
                                <span className="sci-msg__time">{formatStamp(m.createdAt)}</span>
                              </div>
                            )}
                            <div className="sci-msg__body">{m.body}</div>
                          </div>
                        </div>
                      </Fragment>
                    );
                  })}
                  <div ref={endRef} />
                </div>

                {activeResolved ? (
                  <div className="sci-closed">
                    <div className="sci-closed__icon" aria-hidden="true">
                      <IconCheck />
                    </div>
                    <div className="sci-closed__text">
                      <p className="sci-closed__title">This conversation is closed</p>
                      <p>
                        Support marked this as resolved, so it is read-only for
                        both of us. If you still need help, start a new
                        conversation and we will pick it up — this one stays
                        here as a record.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="sci-btn sci-btn--primary"
                      onClick={() => {
                        setComposing(true);
                        setCategory(active.thread.category || 'other');
                        setDraft('');
                        setError('');
                      }}
                    >
                      <IconPlus />
                      Start a new conversation
                    </button>
                  </div>
                ) : (
                  <form className="sci-reply" onSubmit={sendReply}>
                    <div className="sci-reply__box">
                      <textarea
                        ref={replyRef}
                        rows={1}
                        maxLength={MAX_MESSAGE}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          // Enter sends; Shift+Enter is a newline. The converse (the
                          // default) makes every multi-line question a three-tap affair.
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendReply(e);
                          }
                        }}
                        placeholder="Write a reply…"
                        aria-label="Reply to this conversation"
                      />
                    </div>
                    <div className="sci-reply__foot">
                      <span className="sci-reply__hint">Enter to send · Shift+Enter for a new line</span>
                      <button type="submit" className="sci-btn sci-btn--primary" disabled={!canSend}>
                        {sending ? <><span className="sci-spinner" aria-hidden="true" />Sending…</> : <><IconSend />Send reply</>}
                      </button>
                    </div>
                  </form>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
