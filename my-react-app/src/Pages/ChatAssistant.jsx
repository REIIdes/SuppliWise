import { useState, useRef, useEffect } from 'react';
import { sendChatMessage } from '../api';
import './ChatAssistant.css';

// ── Markdown renderer (no external deps) ──────────────────────────────────
function renderMarkdown(text) {
  const lines = text.split('\n');
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

// ── Quick prompts ──────────────────────────────────────────────────────────
const QUICK_PROMPTS = [
  'How do I start an assessment?',
  'What does the % score mean?',
  'What is vitamin D?',
  'Can I mix supplements?',
  'How do I view my history?',
  'What does High priority mean?',
];

// ── Main component ─────────────────────────────────────────────────────────
export default function ChatAssistant({ recommendations }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([{
    role: 'assistant',
    text: "Hi! I'm **SuppliWise AI** — your health and wellness assistant.\n\nI can help with:\n- Your supplement recommendations and results\n- Supplements, nutrition, vitamins, and wellness questions\n- How to use any feature on SuppliWise\n- Symptoms, diet, sleep, and lifestyle advice\n\nWhat would you like to know?",
  }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const messagesContainerRef = useRef(null);

  const getRecs = () => {
    if (recommendations && recommendations.length) return recommendations;
    try {
      const s = sessionStorage.getItem('latest_recommendations');
      return s ? JSON.parse(s) : [];
    } catch { return []; }
  };

  useEffect(() => {
    if (recommendations && recommendations.length) {
      try { sessionStorage.setItem('latest_recommendations', JSON.stringify(recommendations)); } catch {}
    }
  }, [recommendations]);

  // Scroll to top when chat opens
  useEffect(() => {
    if (open && messagesContainerRef.current) {
      // Use setTimeout to ensure DOM is fully rendered
      setTimeout(() => {
        if (messagesContainerRef.current) {
          messagesContainerRef.current.scrollTop = 0;
          setShowScrollButton(false);
        }
      }, 0);
    }
  }, [open]);

  // Detect if user has scrolled up
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 50; // Within 50px of bottom
      setShowScrollButton(!isAtBottom && scrollHeight > clientHeight);
    };

    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, [open]);

  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTo({
        top: messagesContainerRef.current.scrollHeight,
        behavior: 'smooth'
      });
    }
  };

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [messages, open]);

  const send = async (text) => {
    const q = (text || input).trim();
    if (!q || loading) return;
    setInput('');

    const newUserMsg = { role: 'user', text: q };
    setMessages(prev => [...prev, newUserMsg]);
    setLoading(true);

    const recs = getRecs();

    // Build history for context (exclude the welcome message)
    const history = messages
      .filter((_, i) => i > 0) // skip welcome
      .slice(-8); // last 4 exchanges

    try {
      const data = await sendChatMessage(q, recs.slice(0, 5), history);
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: data.reply || "I couldn't find an answer. Try rephrasing your question.",
      }]);
    } catch {
      setMessages(prev => [...prev, {
        role: 'assistant',
        text: "I'm having trouble connecting right now. Please try again in a moment.",
      }]);
    } finally {
      setLoading(false);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  const handleOpen = () => {
    setOpen(o => !o);
  };

  return (
    <>
      <button
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
        <div className="chat-window" role="dialog" aria-label="SuppliWise AI Assistant">
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
                <div className="chat-header-status">
                  <span className="status-dot" />
                  Online
                </div>
              </div>
            </div>
            <button className="chat-close" onClick={() => setOpen(false)} aria-label="Close">✕</button>
          </div>

          <div className="chat-disclaimer-banner">
            ⚕️ Educational only — not medical advice. Consult a healthcare provider.
          </div>

          <div className="chat-messages" ref={messagesContainerRef}>
            {messages.map((msg, i) => (
              <div key={i} className={`chat-bubble ${msg.role}`}>
                {msg.role === 'assistant'
                  ? renderMarkdown(msg.text)
                  : <p className="md-p">{msg.text}</p>
                }
              </div>
            ))}
            {loading && (
              <div className="chat-bubble assistant chat-typing">
                <span className="typing-dot" />
                <span className="typing-dot" />
                <span className="typing-dot" />
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Scroll to bottom button */}
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
        </div>
      )}
    </>
  );
}
