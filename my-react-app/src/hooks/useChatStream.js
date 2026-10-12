// useChatStream — one EventSource against a support-chat push channel.
//
// The server streams INVALIDATION signals (`event: chat`) whenever a
// conversation changes: which side changed and which thread, never message
// content. The consumer refetches through the normal read endpoints, so those
// stay the single source of truth and end-to-end ciphertext never rides this
// channel. A `presence` event carries the support console's active flag.
//
// Why it is needed: both inboxes poll every 12s, and while a thread is OPEN
// nothing refetches its transcript — an admin reply landing while the member
// reads the conversation (or the member's next message arriving while an
// operator reads it) was invisible until someone clicked back into it. The
// stream closes that gap in milliseconds.
//
// Kept deliberately small and self-healing:
//   • The polls stay as the fallback. If the stream cannot connect (proxy
//     buffering, offline, a server without the endpoint), nothing breaks —
//     the app behaves exactly as it did before.
//   • Reconnects with backoff, and re-reads the token on each attempt, so a
//     server-initiated close at token expiry comes back on the fresh one.
//   • Handlers are read through refs: a state update in the parent must never
//     tear the connection down and re-open it.
import { useEffect, useRef } from 'react';
import { BASE_URL } from '../api';

const RETRY_STEPS_MS = [3000, 8000, 20000, 60000];

// Stable per-tab id, sent as ?clientId= so the server can name the connection
// a write came from. (Writes go over fetch, not this connection, so today the
// suppression of self-echoes is done client-side by the consumers; the id is
// here for the server's bookkeeping and stays one per tab.)
function tabClientId() {
  const KEY = 'sw_chat_client_id';
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    sessionStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return `anon-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/**
 * @param path       stream path appended to BASE_URL, e.g. '/support-chat/stream'
 * @param readToken  () => access token for the query parameter
 * @param onEvent    ({ kind, thread, by }) => void, chat invalidation
 * @param onPresence (active: boolean) => void, support console presence
 * @param enabled    when false no connection is opened (and any open one closes)
 */
export default function useChatStream({ path, readToken, onEvent, onPresence, enabled = true }) {
  const handlerRef = useRef({ onEvent, onPresence });
  useEffect(() => {
    handlerRef.current = { onEvent, onPresence };
  }, [onEvent, onPresence]);

  useEffect(() => {
    if (!enabled) return undefined;
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return undefined;
    if (!path || typeof readToken !== 'function') return undefined;

    let es = null;
    let timer = null;
    let disposed = false;
    let step = 0;

    const connect = () => {
      if (disposed) return;
      const token = readToken();
      if (!token) {
        // Signed out here: retry only when something changes the token.
        timer = window.setTimeout(connect, RETRY_STEPS_MS[Math.min(step, RETRY_STEPS_MS.length - 1)]);
        step += 1;
        return;
      }
      try {
        // Exactly the URL shape useSubscription.js already opens against the
        // same server: BASE_URL carries the /api prefix and the port.
        const url = `${BASE_URL}${path}`;
        const sep = url.includes('?') ? '&' : '?';
        es = new EventSource(`${url}${sep}token=${encodeURIComponent(token)}&clientId=${encodeURIComponent(tabClientId())}`);
      } catch {
        es = null;
      }
      if (!es) return;

      es.addEventListener('chat', (evt) => {
        step = 0;
        try {
          const payload = JSON.parse(evt.data);
          if (payload && payload.kind) handlerRef.current.onEvent?.(payload);
        } catch { /* malformed frame — the polls still converge */ }
      });
      es.addEventListener('presence', (evt) => {
        try {
          const payload = JSON.parse(evt.data);
          if (payload && typeof payload.supportActive === 'boolean') {
            handlerRef.current.onPresence?.(payload.supportActive);
          }
        } catch { /* ignore */ }
      });
      es.onerror = () => {
        // EventSource retries transient failures by itself. A hard CLOSED
        // (server restart, 401 after a token expiry, a proxy that gave up)
        // needs a NEW connection with a re-read token.
        if (es && es.readyState === EventSource.CLOSED) {
          try { es.close(); } catch { /* already closed */ }
          es = null;
          if (disposed || timer) return;
          const wait = RETRY_STEPS_MS[Math.min(step, RETRY_STEPS_MS.length - 1)];
          step += 1;
          timer = window.setTimeout(() => { timer = null; connect(); }, wait);
        }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      if (es) {
        try { es.close(); } catch { /* already closed */ }
      }
    };
    // `readToken` is excluded on purpose: it is a stable module-level helper
    // in every consumer, and re-running on identity churn would tear down a
    // live connection on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, path]);
}
