import { memo, useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  sendChatMessage,
  listChatThreads,
  getChatThread,
  deleteChatThread,
  togglePinChatThread,
} from '../api';
import useAuth from '../hooks/useAuth';
import { PLAN_LABELS } from '../utils/plan';
import { subscribeOverlays } from '../utils/overlayRegistry';
import { useSubscription } from '../hooks/useSubscription';
import UpgradeModal from '../Components/UpgradeModal/UpgradeModal';
import ConfirmModal from '../Components/ConfirmModal/ConfirmModal';
import './ChatAssistant.css';

// ── Markdown renderer (no external deps) ──────────────────────────────────
function renderMarkdown(text) {
  const source = typeof text === 'string' ? text : String(text || '');
  const lines = source.split('\n');
  const elements = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // H3
    if (line.startsWith('### ')) {
      elements.push(<h3 key={i} className="md-h3">{inlineFormat(line.slice(4))}</h3>);
      i++; continue;
    }
    // H2
    if (line.startsWith('## ')) {
      elements.push(<h2 key={i} className="md-h2">{inlineFormat(line.slice(3))}</h2>);
      i++; continue;
    }
    // H1
    if (line.startsWith('# ')) {
      elements.push(<h2 key={i} className="md-h2">{inlineFormat(line.slice(2))}</h2>);
      i++; continue;
    }

    // Table (simple)
    if (line.startsWith('|')) {
      const tableLines = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(<MdTable key={`table-${i}`} lines={tableLines} />);
      continue;
    }

    // Bullet list
    if (/^[-*•]\s/.test(line)) {
      const listItems = [];
      while (i < lines.length && /^[-*•]\s/.test(lines[i])) {
        listItems.push(<li key={i}>{inlineFormat(lines[i].replace(/^[-*•]\s/, ''))}</li>);
        i++;
      }
      elements.push(<ul key={`ul-${i}`} className="md-ul">{listItems}</ul>);
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(line)) {
      const listItems = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        listItems.push(<li key={i}>{inlineFormat(lines[i].replace(/^\d+\.\s/, ''))}</li>);
        i++;
      }
      elements.push(<ol key={`ol-${i}`} className="md-ol">{listItems}</ol>);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={i} className="md-hr" />);
      i++; continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++; continue;
    }

    // Regular paragraph
    elements.push(<p key={i} className="md-p">{inlineFormat(line)}</p>);
    i++;
  }

  return elements;
}

// The renderer is pure in `text`, so memoising it means a long transcript is
// parsed exactly once per message instead of on every render of the widget.
// The widget re-renders far more often than messages change — scroll-button
// flips, `useSubscription()` notifies and `useAuth()` reads all land here —
// and each render used to re-run the splitter plus a regex per line for every
// assistant message already on screen.
const Markdown = memo(function Markdown({ text }) {
  return renderMarkdown(text);
});

function MdTable({ lines }) {
  const rows = lines
    .filter(l => !l.match(/^\|[-| :]+\|$/)) // skip separator rows
    .map(l => l.split('|').filter((_, idx, arr) => idx > 0 && idx < arr.length - 1).map(c => c.trim()));

  if (rows.length === 0) return null;
  const [header, ...body] = rows;

  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>{header.map((cell, i) => <th key={i}>{inlineFormat(cell)}</th>)}</tr>
        </thead>
        <tbody>
          {body.map((row, i) => (
            <tr key={i}>{row.map((cell, j) => <td key={j}>{inlineFormat(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function inlineFormat(text) {
  // Split on bold/italic/code markers and render
  const parts = [];
  const regex = /(\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let last = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[2]) parts.push(<strong key={match.index}><em>{match[2]}</em></strong>);
    else if (match[3]) parts.push(<strong key={match.index}>{match[3]}</strong>);
    else if (match[4]) parts.push(<em key={match.index}>{match[4]}</em>);
    else if (match[5]) parts.push(<code key={match.index} className="md-code">{match[5]}</code>);
    last = match.index + match[0].length;
  }

  if (last < text.length) parts.push(text.slice(last));
  return parts.length > 0 ? parts : text;
}

const WELCOME_MESSAGE = {
  role: 'assistant',
  text: "Hi! I'm **SuppliWise AI** — your health and wellness assistant.\n\nI can help with:\n- Your supplement recommendations and results\n- Supplements, nutrition, vitamins, and wellness questions\n- How to use any feature on SuppliWise\n- Symptoms, diet, sleep, and lifestyle advice\n\nWhat would you like to know?",
};

// Compact relative stamp for the history menu: "just now",
// "5m ago", "2h ago", "3d ago", then a plain date.
const formatThreadTime = (value) => {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return '';
  const seconds = Math.max(0, (Date.now() - when.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return when.toLocaleDateString();
};

// ── Quick prompts ──────────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  'How do I start an assessment?',
  'What does the confidence score mean?',
  'What is vitamin D?',
  'Can I mix supplements?',
  'How do I view my history?',
  'What does High priority mean?',
];

// ── Main component ─────────────────────────────────────────────────────────
export default function ChatAssistant() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  // Reactive: GlobalChat stays mounted across navigation, so a mount-time
  // snapshot would keep showing the logged-out screen after signing in.
  const { token, user } = useAuth();
  const isLoggedIn = !!token;
  const userId = user?._id || user?.id || token || null;
  const [messages, setMessages] = useState([WELCOME_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [showQuickPrompts, setShowQuickPrompts] = useState(true);
  const [connectionState, setConnectionState] = useState('online');
  const [upgradeInfo, setUpgradeInfo] = useState(null);
  // Stored conversations: the server keeps the transcripts,
  // the panel only tracks which one is open and the list the
  // history menu shows.
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [threads, setThreads] = useState([]);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const [threadsLoading, setThreadsLoading] = useState(false);
  // The conversation a delete press is waiting on: the
  // menu's trash button only arms this; the modal's
  // confirm button performs the removal.
  const [deleteTarget, setDeleteTarget] = useState(null);
  // Reactive plan object { active, plan, rank } — subscribing re-renders this
  // component the instant the subscription changes, so the gates below always
  // read fresh state. (Destructuring `plan` here would give the tier string,
  // not the object, and every gate would read rank 0 and stay locked.)
  const livePlan = useSubscription();

  // A stale upgrade modal clears itself the instant the plan qualifies —
  // upgrade lands via SSE/refresh with no manual action.
  useEffect(() => {
    if (upgradeInfo && livePlan.canAccess('chat')) setUpgradeInfo(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePlan.active, livePlan.plan, livePlan.rank, upgradeInfo]);
  const inputRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const chatWindowRef = useRef(null);
  const edgeRef = useRef(null);
  const messagesRef = useRef(messages);
  const loadingRef = useRef(false);
  const conversationVersionRef = useRef(0);
  const followBottomRef = useRef(true);
  const previousOpenRef = useRef(false);
  const threadMenuRef = useRef(null);
  const threadsButtonRef = useRef(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // A global chat stays mounted while the account changes. Resetting only the
  // visible branch is not enough: the old transcript would reappear for the
  // next account. The version guard also makes an in-flight reply from the old
  // account harmless after the switch.
  useEffect(() => {
    conversationVersionRef.current += 1;
    loadingRef.current = false;
    setMessages([WELCOME_MESSAGE]);
    setInput('');
    setLoading(false);
    setShowScrollButton(false);
    setConnectionState('online');
    setUpgradeInfo(null);
    setOpen(false);
    // A stored conversation belongs to the account that wrote
    // it. Switching accounts starts from scratch; the history
    // list itself is fetched per account, on demand.
    setActiveThreadId(null);
    setThreads([]);
    setThreadsOpen(false);
    setThreadsLoading(false);
    setDeleteTarget(null);
  }, [userId]);

  // Follow new content only while the reader is already at the bottom. If a
  // user scrolls up to read an older answer, a late reply must not yank them
  // away; the explicit jump-to-bottom button remains available.
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!open || !el) {
      previousOpenRef.current = false;
      return;
    }

    const reopened = !previousOpenRef.current;
    const shouldFollow = followBottomRef.current;
    previousOpenRef.current = true;
    const timer = setTimeout(() => {
      if (reopened) {
        // A stored conversation reopens at the newest
        // exchange — where the reader left off — instead
        // of the top of the transcript.
        el.scrollTop = el.scrollHeight;
        followBottomRef.current = true;
        setShowScrollButton(false);
      } else if (shouldFollow) {
        el.scrollTop = el.scrollHeight;
        setShowScrollButton(false);
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [open, messages.length, loading]);

  // Detect if user has scrolled up
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50; // Within 50px of bottom
      followBottomRef.current = isAtBottom;
      setShowScrollButton(!isAtBottom && scrollHeight > clientHeight);
    };

    // Passive: this listener only reads layout and flips a boolean, so it must
    // never be able to block scrolling while the browser waits on it (same
    // contract as useScrolledPast).
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [open]);

  // The messages box can change size without any scroll event firing —
  // collapsing the quick-prompt chips grows it, and a grown box can turn
  // a scrollable transcript into one that fits, leaving scrollTop
  // already sitting at the bottom. No scroll event fires in that case,
  // so the "jump to newest" button used to stay visible pointing at a
  // bottom the reader was already looking at, and clicking it scrolled
  // nowhere. Re-running the same at-bottom check on every box resize
  // keeps the button honest. ResizeObserver fires on box size, not
  // content size, so incoming messages — which only grow the content —
  // never reach this; the follow effect above owns those.
  useEffect(() => {
    if (!open) return;
    const container = messagesContainerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;

    const check = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
      followBottomRef.current = isAtBottom;
      setShowScrollButton(!isAtBottom && scrollHeight > clientHeight);
    };

    const observer = new ResizeObserver(check);
    observer.observe(container);
    return () => observer.disconnect();
  }, [open]);

  // Close chat when clicking outside
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e) => {
      const target = e.target;
      // The edge handle is part of the assistant's chrome, so pressing it must
      // not count as "outside" — the button's own handler decides show vs hide.
      if (chatWindowRef.current?.contains(target)) return;
      if (edgeRef.current?.contains(target)) return;
      // Root-level modals (the delete confirmation, the upgrade
      // prompt) render outside the window, so their presses would
      // otherwise read as "outside" and close the panel the modal
      // belongs to. While one is up, it owns every press.
      if (deleteTarget || upgradeInfo) return;
      setOpen(false);
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, deleteTarget, upgradeInfo]);

  // Close the history menu when a press lands outside it (and
  // outside its toggle, whose own handler decides show vs hide).
  // Skip when the delete-confirm modal is open — the modal is outside
  // the menu ref, so every click inside it would otherwise close the panel.
  useEffect(() => {
    if (!threadsOpen) return;
    const handleMenuClickOutside = (event) => {
      if (deleteTarget) return;
      if (threadMenuRef.current?.contains(event.target)) return;
      if (threadsButtonRef.current?.contains(event.target)) return;
      setThreadsOpen(false);
    };
    document.addEventListener('mousedown', handleMenuClickOutside);
    return () => document.removeEventListener('mousedown', handleMenuClickOutside);
  }, [threadsOpen, deleteTarget]);

  const scrollToBottom = () => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // Already looking at the newest message? Clear the button
    // instead of scrolling to the position we are already at.
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (isAtBottom) {
      setShowScrollButton(false);
      return;
    }
    el.scrollTo({
      top: el.scrollHeight,
      behavior: 'smooth'
    });
  };

  // ── Stored conversations ──────────────────────────────────────
  // Threads are account-scoped on the server; every list, load
  // and delete goes through the session, so an in-flight
  // request from a previous account is discarded by the
  // version guard — the same trick the message sends use.
  const refreshThreads = async () => {
    const version = conversationVersionRef.current;
    setThreadsLoading(true);
    try {
      const data = await listChatThreads();
      if (version !== conversationVersionRef.current) return;
      setThreads(Array.isArray(data?.threads) ? data.threads : []);
    } catch (err) {
      // History is a convenience: a failed load must never
      // break the chat itself, so the menu just stays empty.
      if (version !== conversationVersionRef.current) return;
      setThreads([]);
    } finally {
      if (version === conversationVersionRef.current) setThreadsLoading(false);
    }
  };

  const startNewConversation = () => {
    setActiveThreadId(null);
    setMessages([WELCOME_MESSAGE]);
    setThreadsOpen(false);
    followBottomRef.current = true;
  };

  const openThread = async (thread) => {
    setThreadsOpen(false);
    if (String(thread?._id) === String(activeThreadId)) return;
    const version = conversationVersionRef.current;
    // The typing indicator doubles as the load state: the old
    // transcript stays visible beneath it until the stored one
    // lands, and stays put if the load fails.
    setLoading(true);
    try {
      const data = await getChatThread(thread._id);
      if (version !== conversationVersionRef.current) return;
      setActiveThreadId(data?._id ?? null);
      setMessages((Array.isArray(data?.messages) ? data.messages : [])
        .map((m) => ({ role: m.role, text: m.text })));
      followBottomRef.current = true;
    } catch (err) {
      if (version !== conversationVersionRef.current) return;
      console.error('[chat] thread load failed:', err.message);
    } finally {
      if (version === conversationVersionRef.current) setLoading(false);
    }
  };

  const deleteThread = async (threadId) => {
    const version = conversationVersionRef.current;
    try {
      await deleteChatThread(threadId);
      if (version !== conversationVersionRef.current) return;
      setThreads((prev) => prev.filter((t) => String(t._id) !== String(threadId)));
      // Deleting the conversation being viewed returns the
      // panel to a fresh conversation instead of an empty
      // transcript.
      if (String(activeThreadId) === String(threadId)) {
        startNewConversation();
      }
    } catch (err) {
      if (version !== conversationVersionRef.current) return;
      console.error('[chat] thread delete failed:', err.message);
    }
  };

  const togglePinThread = async (threadId) => {
    const version = conversationVersionRef.current;
    try {
      const data = await togglePinChatThread(threadId);
      if (version !== conversationVersionRef.current) return;
      // Update the thread's pinned status in the local list
      setThreads((prev) => {
        const updated = prev.map((t) =>
          String(t._id) === String(threadId) ? { ...t, pinned: data.pinned } : t
        );
        // Re-sort: pinned first, then by updatedAt
        return updated.sort((a, b) => {
          if (a.pinned === b.pinned) {
            return new Date(b.updatedAt) - new Date(a.updatedAt);
          }
          return b.pinned ? 1 : -1;
        });
      });
    } catch (err) {
      if (version !== conversationVersionRef.current) return;
      console.error('[chat] thread pin failed:', err.message);
    }
  };

  // The modal's confirm button performs the
  // removal the trash icon only armed.
  const confirmDeleteThread = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (target) await deleteThread(target._id);
  };

  // Focus the composer when the panel opens and whenever a reply lands, so
  // typing can resume without clicking back into the box after each answer.
  useEffect(() => {
    if (!open || (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches)) return;
    const t = setTimeout(() => inputRef.current?.focus(), 100);
    return () => clearTimeout(t);
  }, [open, loading]);

  const send = async (text) => {
    const q = String(text || input).trim();
    if (!q || loadingRef.current) return;
    if (q.length > 1000) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        kind: 'error',
        text: 'Please keep messages under 1000 characters.',
      }]);
      return;
    }
    // Client-side ULTIMATE gate — prevents wasted request for under-tier users
    // (the backend re-verifies via requireFeature('chat') regardless).
    if (!livePlan.canAccess('chat')) {
      setUpgradeInfo({ requiresPlan: 'custom', currentPlan: livePlan.plan });
      return;
    }

    const version = conversationVersionRef.current;
    loadingRef.current = true;
    followBottomRef.current = true;
    setInput('');

    const newUserMsg = { role: 'user', text: q };
    setMessages(prev => [...prev, newUserMsg]);
    setLoading(true);
    setConnectionState('connecting');

    // Only successful conversation turns are sent back to the model. Error
    // bubbles are UI state, not assistant advice, and must not poison
    // context. The welcome message is the conversation seed, not a
    // turn — and a stored transcript has no welcome at all, so the
    // filter matches the welcome text instead of assuming it sits
    // at index 0.
    const history = messagesRef.current
      .filter((message) => message.text !== WELCOME_MESSAGE.text && message.kind !== 'error')
      .slice(-8);

    try {
      // A stored conversation appends to the server-side
      // transcript; a fresh one asks the server to seed a
      // thread from this turn.
      const threadPayload = activeThreadId
        ? { threadId: activeThreadId }
        : { newThread: true };
      const data = await sendChatMessage(q, history, threadPayload);
      if (version !== conversationVersionRef.current) return;
      const reply = typeof data?.reply === 'string' ? data.reply.trim() : '';
      if (!reply) throw new Error("I couldn't find an answer. Try rephrasing your question.");
      setConnectionState(data.source === 'fallback' ? 'degraded' : 'online');
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: reply,
        ...(data.source === 'fallback' ? { kind: 'error' } : {}),
      }]);
      // Adopt the stored conversation so every later turn
      // appends to it. When the server could not persist
      // (no threadId), the conversation simply stays in
      // memory, exactly like before.
      if (data?.threadId && String(data.threadId) !== String(activeThreadId)) {
        setActiveThreadId(data.threadId);
      }
    } catch (err) {
      if (version !== conversationVersionRef.current) return;
      setConnectionState(err.status === 429 ? 'busy' : 'offline');
      if (err.requiresPlan) {
        setUpgradeInfo({ requiresPlan: err.requiresPlan, currentPlan: err.currentPlan || livePlan.plan });
        // Remove the optimistic user message if blocked (so chat doesn't look sent)
        setMessages(prev => prev.slice(0, -1));
        return;
      }
      setMessages(prev => [...prev, {
        role: 'assistant',
        kind: 'error',
        text: err.message || "I'm having trouble connecting right now. Please try again in a moment.",
      }]);
    } finally {
      if (version === conversationVersionRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  };

  const handleKey = (e) => {
    // Enter commits an IME candidate on some mobile keyboards. Sending here
    // would submit a partial word; wait for compositionend instead.
    if (e.nativeEvent?.isComposing || e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  // Edge handle — the assistant's ONLY control: it shows the panel and hides
  // it again. (The old floating pill duplicated this and was removed.)
  const handleEdgeShow = () => {
    setOpen(true);
  };

  const handleEdgeHide = () => {
    setOpen(false);
  };

  // Stand the edge tab down while another overlay owns the right edge (the
  // account menu). See the note on the button below for why an OPEN chat window
  // keeps its tab.
  const [overlayOpen, setOverlayOpenState] = useState(false);
  useEffect(() => subscribeOverlays((openSet) => {
    setOverlayOpenState(openSet.size > 0);
  }), []);
  const standDown = overlayOpen && !open;

  return (
    <>
      {/* Edge handle — the assistant's hide/show control. Pointing right while
          the panel is closed ("show the contents"), left while it is open. */}
      <button
        type="button"
        ref={edgeRef}
        className={`chat-edge-toggle${open ? ' is-open' : ''}`}
        onClick={open ? handleEdgeHide : handleEdgeShow}
        aria-label={open ? 'Hide the AI assistant' : 'Show the AI assistant'}
        aria-expanded={open}
        aria-controls="suppliwise-chat-window"
        title={open ? 'Hide the AI assistant' : 'Show the AI assistant'}
        /* The tab is `position: fixed` at z-index 1000, parked at the right edge
           exactly where the account menu drops. The menu lives inside the
           Navbar's stacking context (100 on desktop; forced to 1000 on phones,
           which only ties the tab and still loses on DOM order), so no
           z-index of its own can lift it over the tab. The tab stands down
           instead.

           It stays visible while the chat window is OPEN: the panel is anchored
           to the bottom-right and the menu to the top-right, so they never
           actually collide, and that tab is the only way to put the chat away
           again — hiding it there would strand the panel open.

           `visibility` rather than `display` so the transition still runs, and
           `pointer-events: none` takes it out of the hit-test, so it cannot
           swallow clicks meant for the menu. (Deliberately NOT the `hidden`
           attribute: `.chat-edge-toggle { display: flex }` is an author rule and
           beats the UA's `[hidden] { display: none }`, so `hidden` would change
           nothing visually while still telling assistive tech the control is
           gone — the worst of both.) */
        data-stand-down={standDown ? 'true' : undefined}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          {open ? (
            <polyline points="15 6 9 12 15 18" />
          ) : (
            <polyline points="9 6 15 12 9 18" />
          )}
        </svg>
      </button>

      {open && (
        <div id="suppliwise-chat-window" ref={chatWindowRef} className="chat-window" role="dialog" aria-modal="false" aria-label="SuppliWise AI Assistant">
          <div className="chat-header">
            <div className="chat-header-info">
              <div className="chat-header-avatar">
                <svg width="28" height="28" viewBox="0 0 100 110" fill="none" xmlns="http://www.w3.org/2000/svg">
                  {/* Antenna stem */}
                  <rect x="47" y="6" width="6" height="14" rx="2" fill="#b0b0b8" stroke="#1a1a2e" strokeWidth="3"/>
                  {/* Antenna ball */}
                  <circle cx="50" cy="5" r="8" fill="#7c7ce8" stroke="#1a1a2e" strokeWidth="3"/>
                  {/* Ear left */}
                  <rect x="8" y="28" width="10" height="22" rx="3" fill="#7c7ce8" stroke="#1a1a2e" strokeWidth="3"/>
                  {/* Ear right */}
                  <rect x="82" y="28" width="10" height="22" rx="3" fill="#7c7ce8" stroke="#1a1a2e" strokeWidth="3"/>
                  {/* Head */}
                  <rect x="18" y="20" width="64" height="46" rx="10" fill="#f0f0f8" stroke="#1a1a2e" strokeWidth="3.5"/>
                  {/* Eye left outer */}
                  <circle cx="36" cy="42" r="9" fill="#1a1a2e"/>
                  {/* Eye left inner */}
                  <circle cx="36" cy="42" r="6" fill="#d0d0dc"/>
                  {/* Eye right outer */}
                  <circle cx="64" cy="42" r="9" fill="#1a1a2e"/>
                  {/* Eye right inner */}
                  <circle cx="64" cy="42" r="6" fill="#d0d0dc"/>
                  {/* Mouth */}
                  <rect x="38" y="56" width="24" height="4" rx="2" fill="#1a1a2e"/>
                  {/* Neck */}
                  <rect x="43" y="66" width="14" height="8" rx="2" fill="#b0b0b8" stroke="#1a1a2e" strokeWidth="2.5"/>
                  {/* Body */}
                  <rect x="14" y="74" width="72" height="32" rx="10" fill="#f0f0f8" stroke="#1a1a2e" strokeWidth="3.5"/>
                  {/* Body bolt left */}
                  <circle cx="24" cy="82" r="4" fill="#1a1a2e"/>
                  {/* Body bolt right */}
                  <circle cx="76" cy="82" r="4" fill="#1a1a2e"/>
                  {/* Chest panel */}
                  <rect x="30" y="88" width="40" height="12" rx="4" fill="#7c7ce8" stroke="#1a1a2e" strokeWidth="2"/>
                </svg>
              </div>
              <div>
                <div className="chat-header-name">SuppliWise AI</div>
                <div className={`chat-header-status ${connectionState}`}>
                  {connectionState === 'online' && 'Online'}
                  {connectionState === 'connecting' && 'Connecting…'}
                  {connectionState === 'degraded' && 'Reconnecting'}
                  {connectionState === 'busy' && 'Busy'}
                  {connectionState === 'offline' && 'Unavailable'}
                </div>
              </div>
            </div>
            {/* Conversation controls — same gate as the
                transcript itself: signed in AND entitled. */}
            {isLoggedIn && livePlan.canAccess('chat') && (
            <div className="chat-header-actions">
              <button
                type="button"
                className="chat-header-icon-btn"
                onClick={startNewConversation}
                aria-label="Start a new conversation"
                title="Start a new conversation"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                type="button"
                ref={threadsButtonRef}
                className={`chat-header-icon-btn${threadsOpen ? ' active' : ''}`}
                onClick={() => {
                  setThreadsOpen((v) => !v);
                  if (!threadsOpen) refreshThreads();
                }}
                aria-label="Chat history"
                aria-expanded={threadsOpen}
                title="Chat history"
              >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <polyline points="12 7 12 12 15.5 13.5" />
                </svg>
              </button>
            </div>
            )}
            <button className="chat-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          {/* History menu — anchored under the header, inside the
              window. Same entitlement gate as its toggle. */}
          {threadsOpen && isLoggedIn && livePlan.canAccess('chat') && (
            <div className="chat-thread-menu" ref={threadMenuRef} role="menu" aria-label="Past conversations">
              <div className="chat-thread-menu-head">Conversations</div>
              {threadsLoading ? (
                <div className="chat-thread-empty">Loading…</div>
              ) : threads.length === 0 ? (
                <div className="chat-thread-empty">No past conversations yet</div>
              ) : (
                <div className="chat-thread-list">
                  {threads.map((t) => (
                    <div
                      key={t._id}
                      role="menuitem"
                      className={`chat-thread-item${String(t._id) === String(activeThreadId) ? ' active' : ''}`}
                      onClick={() => openThread(t)}
                    >
                      <div className="chat-thread-item-main">
                        <div className="chat-thread-item-title">
                          {t.pinned && (
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="currentColor"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              style={{ marginRight: '6px', verticalAlign: 'middle', color: '#7c7ce8' }}
                              aria-hidden="true"
                            >
                              <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                            </svg>
                          )}
                          {t.title || 'New conversation'}
                        </div>
                        <div className="chat-thread-item-meta">
                          {formatThreadTime(t.updatedAt)}
                          {t.lastText ? ` · ${t.lastText}` : ''}
                        </div>
                      </div>
                      <div className="chat-thread-actions">
                        <button
                          type="button"
                          className="chat-thread-pin"
                          aria-label={t.pinned ? "Unpin conversation" : "Pin conversation"}
                          title={t.pinned ? "Unpin conversation" : "Pin conversation"}
                          onClick={(e) => { e.stopPropagation(); togglePinThread(t._id); }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill={t.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                          </svg>
                        </button>
                        <button
                          type="button"
                          className="chat-thread-delete"
                          aria-label="Delete conversation"
                          title="Delete conversation"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(t); }}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                            <line x1="10" y1="11" x2="10" y2="17" />
                            <line x1="14" y1="11" x2="14" y2="17" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!isLoggedIn ? (
            // Auth Required Screen
            <div className="chat-auth-required">
              <div className="auth-required-content">
                <div className="auth-required-icon">
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </div>
                <h3 className="auth-required-title">Welcome to the SuppliWise AI Assistant! 🤖</h3>
                <p className="auth-required-message">
                  Please <strong>log in</strong> or <strong>create an account</strong> to access the AI Assistant.
                </p>
                <p className="auth-required-description">
                  This helps us provide a secure experience and gives you access to all SuppliWise features, including assessments, recommendations, history, and AI assistance.
                </p>
                <div className="auth-required-buttons">
                  <a href="/login" className="auth-btn auth-btn-primary">
                    Log In
                  </a>
                  <a href="/signup" className="auth-btn auth-btn-secondary">
                    Create Account
                  </a>
                </div>
              </div>
            </div>
          ) : !livePlan.canAccess('chat') ? (
            // Subscription gate — ULTIMATE only
            <div className="chat-auth-required chat-auth-required--paywall">
              <div className="auth-required-content paywall">
                <div className="paywall__hero" aria-hidden="true">
                  <span className="paywall__ring">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="10.5" width="16" height="10" rx="3" />
                      <path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" />
                      <circle cx="12" cy="15.4" r="1.5" fill="currentColor" stroke="none" />
                    </svg>
                  </span>
                  <span className="paywall__tier">{PLAN_LABELS.custom}</span>
                </div>
                <p className="paywall__eyebrow">Premium feature</p>
                <h3 className="auth-required-title paywall__title">AI Chat is included with {PLAN_LABELS.custom}</h3>
                <p className="auth-required-message paywall__body">
                  Supplement answers, results guidance and plan help — all inside the <strong>{PLAN_LABELS.custom} plan</strong>.
                </p>
                <p className="auth-required-description paywall__note">
                  <svg className="paywall__note-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8h.01M11 12h1v4h1" />
                  </svg>
                  <span>
                    You&rsquo;re on <strong>{PLAN_LABELS[livePlan.plan] || PLAN_LABELS.free}</strong>. Ask an administrator to upgrade
                    and it switches on instantly, no re-login needed.
                  </span>
                </p>
                <div className="auth-required-buttons paywall__actions">
                  {/* Both actions just close the panel: the edge handle is the
                      only assistant control now, and re-opening would land
                      straight back on this paywall. */}
                  <button
                    className="auth-btn auth-btn-primary"
                    onClick={() => { setOpen(false); navigate('/pricing'); }}
                  >
                    View plans
                    <svg className="paywall__cta-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M5 12h14M13 6l6 6-6 6" />
                    </svg>
                  </button>
                  <button
                    className="auth-btn auth-btn-secondary"
                    onClick={() => setOpen(false)}
                  >
                    Maybe later
                  </button>
                </div>
              </div>
            </div>
          ) : (
            // Normal Chat Interface
            <>
              <div className="chat-disclaimer-banner">
                ⚕️ Educational only — not medical advice. Consult a healthcare provider.
              </div>

              <div className="chat-messages-region">
                <div
                  className="chat-messages"
                  ref={messagesContainerRef}
                  role="log"
                  aria-live="polite"
                  aria-relevant="additions"
                  aria-busy={loading}
                >
                  {messages.map((msg, i) => (
                    <div key={i} className={`chat-bubble ${msg.role}${msg.kind === 'error' ? ' chat-error' : ''}`}>
                      {msg.role === 'assistant'
                        ? <Markdown text={msg.text} />
                        : <p className="md-p">{msg.text}</p>
                      }
                    </div>
                  ))}
                  {loading && (
                    <div className="chat-bubble assistant chat-typing" aria-label="SuppliWise AI is typing">
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                      <span className="typing-dot" />
                    </div>
                  )}
                </div>

                {/* Scroll to bottom button — lives inside the scroll region so
                    it stays glued above the prompt chips at any chip-row count. */}
                {showScrollButton && (
                  <button
                    className="chat-scroll-to-bottom"
                    onClick={scrollToBottom}
                    aria-label="Scroll to bottom"
                  >
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>
                )}
              </div>

              {showQuickPrompts && (
                <div className="chat-quick-prompts-wrap">
                  <div className="chat-quick-prompts">
                    {QUICK_PROMPTS.map(p => (
                      <button
                        key={p}
                        className="quick-prompt"
                        onClick={() => send(p)}
                        disabled={loading}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button
                type="button"
                className="chat-quick-prompts-toggle"
                onClick={() => setShowQuickPrompts(v => !v)}
                aria-expanded={showQuickPrompts}
                aria-label={showQuickPrompts ? 'Hide quick questions' : 'Show quick questions'}
                title={showQuickPrompts ? 'Hide quick questions' : 'Show quick questions'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: showQuickPrompts ? 'rotate(180deg)' : undefined, transition: 'transform 0.15s' }}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              <div className="chat-input-row">
                <input
                  ref={inputRef}
                  className="chat-input"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={handleKey}
                  placeholder="Ask about supplements, nutrition, wellness..."
                  aria-label="Chat input"
                  maxLength={1000}
                  enterKeyHint="send"
                  disabled={loading}
                />
                <button
                  className="chat-send"
                  onClick={() => send()}
                  disabled={!input.trim() || loading}
                  aria-label="Send message"
                >
                  {loading ? (
                    <span className="send-spinner" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="22" y1="2" x2="11" y2="13" />
                      <polygon points="22 2 15 22 11 13 2 9 22 2" />
                    </svg>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {upgradeInfo && (
        <UpgradeModal
          feature="AI Chat Assistant"
          requiredPlan={upgradeInfo.requiresPlan}
          currentPlan={upgradeInfo.currentPlan}
          onClose={() => setUpgradeInfo(null)}
          onViewPlans={() => { setUpgradeInfo(null); navigate('/pricing'); }}
        />
      )}
      {deleteTarget && (
        <ConfirmModal
          type="danger"
          title="Delete this conversation?"
          message={`"${deleteTarget.title || 'New conversation'}" and its entire transcript will be permanently removed. This cannot be undone.`}
          confirmText="Yes, delete"
          cancelText="Keep conversation"
          onConfirm={confirmDeleteThread}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
