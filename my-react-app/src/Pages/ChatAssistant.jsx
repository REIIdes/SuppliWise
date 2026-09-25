import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { sendChatMessage } from '../api';
import useAuth from '../hooks/useAuth';
import { PLAN_LABELS } from '../utils/plan';
import { useSubscription } from '../hooks/useSubscription';
import UpgradeModal from '../Components/UpgradeModal/UpgradeModal';
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
  const [connectionState, setConnectionState] = useState('online');
  const [upgradeInfo, setUpgradeInfo] = useState(null);
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
  const fabRef = useRef(null);
  const messagesRef = useRef(messages);
  const loadingRef = useRef(false);
  const conversationVersionRef = useRef(0);
  const followBottomRef = useRef(true);
  const previousOpenRef = useRef(false);

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
        el.scrollTop = 0;
        followBottomRef.current = true;
        setShowScrollButton(el.scrollHeight > el.clientHeight);
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

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [open]);

  // Close chat when clicking outside
  useEffect(() => {
    if (!open) return;

    const handleClickOutside = (e) => {
      if (
        chatWindowRef.current &&
        fabRef.current &&
        !chatWindowRef.current.contains(e.target) &&
        !fabRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTo({
        top: messagesContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
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
    // bubbles are UI state, not assistant advice, and must not poison context.
    const history = messagesRef.current
      .filter((message, index) => index > 0 && message.kind !== 'error')
      .slice(-8);

    try {
      const data = await sendChatMessage(q, history);
      if (version !== conversationVersionRef.current) return;
      const reply = typeof data?.reply === 'string' ? data.reply.trim() : '';
      if (!reply) throw new Error("I couldn't find an answer. Try rephrasing your question.");
      setConnectionState(data.source === 'fallback' ? 'degraded' : 'online');
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: reply,
        ...(data.source === 'fallback' ? { kind: 'error' } : {}),
      }]);
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

  const handleOpen = () => {
    setOpen(o => !o);
  };

  return (
    <>
      <button
        ref={fabRef}
        className="chat-fab"
        onClick={handleOpen}
        aria-label={open ? 'Close chat' : 'Open SuppliWise AI assistant'}
      >
        {open ? (
          <svg className="chat-fab-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        ) : (
          <>
            <svg className="chat-fab-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              <circle cx="9" cy="10" r="1" fill="currentColor" />
              <circle cx="12" cy="10" r="1" fill="currentColor" />
              <circle cx="15" cy="10" r="1" fill="currentColor" />
            </svg>
            <span className="chat-fab-label">Ask AI</span>
          </>
        )}
      </button>

      {open && (
        <div ref={chatWindowRef} className="chat-window" role="dialog" aria-modal="false" aria-label="SuppliWise AI Assistant">
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
            <button className="chat-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

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
            <div className="chat-auth-required">
              <div className="auth-required-content">
                <div className="auth-required-icon" style={{ color: '#16a34a' }}>🔒</div>
                <h3 className="auth-required-title">AI Chat is an {PLAN_LABELS.custom} perk</h3>
                <p className="auth-required-message">
                  The AI Chat Assistant requires the <strong>{PLAN_LABELS.custom} plan</strong>.
                </p>
                <p className="auth-required-description">
                  Your current plan is <strong>{PLAN_LABELS[livePlan.plan] || PLAN_LABELS.free}</strong>. Contact an administrator to upgrade and unlock AI chat.
                </p>
                <div className="auth-required-buttons">
                  <button className="auth-btn auth-btn-primary" onClick={() => { setOpen(false); navigate('/profile'); }}>
                    View my plan
                  </button>
                  <button className="auth-btn auth-btn-secondary" onClick={() => setOpen(false)}>Maybe later</button>
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
                        ? renderMarkdown(msg.text)
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
          onViewPlans={() => { setUpgradeInfo(null); navigate('/profile'); }}
        />
      )}
    </>
  );
}
