/**
 * Support-chat event bus (single-instance deploy — same assumption as
 * utils/subscriptionBus.js and utils/supportPresence.js).
 *
 * Every write to a conversation — a member reply, an admin reply, a resolve,
 * a reopen, a seal — publishes a small INVALIDATION event here, and every open
 * SSE stream that cares receives it immediately. That is what makes the two
 * inboxes synchronise without a refresh: the push says "something changed on
 * thread X", the receiving client refetches THAT thread (or its list) through
 * the normal read endpoints, and the read endpoints stay the single source of
 * truth.
 *
 * The bus is intentionally dumb: it only fans out. Nothing about the event is
 * trusted by the server — it deliberately carries NO message content, so an
 * encrypted thread's words never travel through a channel the crypto boundary
 * does not cover. A missed push is always recoverable from the 12s polls,
 * which remain as the fallback.
 *
 * Two audiences:
 *   • `userId` subscribers — one member's own stream (GET /support-chat/stream).
 *   • `broadcastAdmins` — every open admin console stream
 *     (GET /admin/chats/stream). Operator A's reply reaches operator B this way.
 */

const userListeners = new Map(); // userId -> Set<fn>
const adminListeners = new Set();

const keyOf = (userId) => String(userId || '').trim();

/**
 * fn receives the event and a `audience` string: 'user' (the member whose
 * thread it is) or 'admin' (the shared console channel). The client payload is
 * { kind, thread, by }; see the two routers for the kinds.
 */
function subscribeUser(userId, fn) {
  const key = keyOf(userId);
  if (!key || typeof fn !== 'function') return () => {};
  if (!userListeners.has(key)) userListeners.set(key, new Set());
  userListeners.get(key).add(fn);
  return () => {
    const set = userListeners.get(key);
    if (!set) return;
    set.delete(fn);
    if (set.size === 0) userListeners.delete(key);
  };
}

function subscribeAdmins(fn) {
  if (typeof fn !== 'function') return () => {};
  adminListeners.add(fn);
  return () => adminListeners.delete(fn);
}

function deliver(fn, event, audience) {
  try {
    fn(event, audience);
  } catch (error) {
    // A dead client must never break the publisher — same rule as
    // subscriptionBus's listener failures.
    console.error('[chat-bus] listener failed:', error.message);
  }
}

/**
 * `event` is { kind, thread, by }. `threadUserId` is the member whose
 * conversation it is — the ONLY member who gets the user-audience copy.
 * `opts.skipAdmins` is for events an operator themself produced; and
 * `opts.skipUser` for events the member themself produced — in both cases the
 * producer's own side already knows, and an echo would storm refetches across
 * its open tabs on every send.
 */
function publishChat(event, threadUserId, opts = {}) {
  const key = keyOf(threadUserId);
  if (!event || !event.kind) return;
  // The consoles are told even when the thread's member id is missing or
  // unusable — a queue that stops updating because one document is malformed
  // is worse than a queue that gets an event it cannot act on.
  if (!opts.skipAdmins) {
    for (const fn of [...adminListeners]) deliver(fn, event, 'admin');
  }
  if (opts.skipUser || !key) return;
  const set = userListeners.get(key);
  if (set) {
    for (const fn of [...set]) deliver(fn, event, 'user');
  }
}

module.exports = { subscribeUser, subscribeAdmins, publishChat };
