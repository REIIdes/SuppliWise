/**
 * Shared rules for the support-chat feature.
 *
 * Everything that BOTH the member routes and the admin routes have to agree on
 * lives here, so the two sides cannot drift: the length caps, the category list,
 * the "who is waiting" state machine, and the preview builder.
 *
 * The state machine is the important part. `status` is what both inboxes filter
 * and sort by, so it has exactly one writer and one definition of its
 * transitions. A second hand-rolled `status = 'open'` in a route handler is how
 * a thread ends up sitting in "waiting on you" days after the admin replied.
 */

const CHAT_CATEGORIES = ['payment', 'account', 'technical', 'billing', 'other'];
const CHAT_STATUSES = ['open', 'pending', 'resolved'];

const MAX_SUBJECT_LENGTH = 160;
const MAX_MESSAGE_LENGTH = 2000;
// A thread is a conversation, not a log file. Past this the send is refused
// rather than silently trimmed — dropping somebody's question because the
// thread is long is exactly the wrong way to fail.
const MAX_MESSAGES_PER_THREAD = 500;

const CATEGORY_LABELS = {
  payment: 'Payment',
  account: 'Account',
  technical: 'Technical',
  billing: 'Billing',
  other: 'Other',
};

class ChatInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatInputError';
    this.status = 400;
  }
}

/**
 * 409 — the request was well-formed but the thread is not in a state that allows
 * it. Distinct from ChatInputError (400) so a client can tell "you typed
 * something wrong" apart from "this conversation is closed" and show the right
 * thing. The current 409 is the resolved lock, below.
 */
class ChatStateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChatStateError';
    this.status = 409;
  }
}

/** Collapse runs of whitespace so a pasted subject cannot be 40 lines tall. */
function collapse(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

/**
 * A subject is REQUIRED — a thread with no title is unidentifiable in the
 * admin queue, which lists dozens of them by subject alone. Rather than reject
 * an otherwise-fine message because the user left the title blank, an empty
 * subject falls back to a short excerpt of the message itself.
 */
function normalizeSubject(value, fallbackBody) {
  const subject = collapse(value).slice(0, MAX_SUBJECT_LENGTH);
  if (subject) return subject;
  const excerpt = collapse(fallbackBody).slice(0, 60);
  return excerpt || 'Support request';
}

/** Unknown categories fall back to 'other' rather than 400-ing the send. */
function normalizeCategory(value) {
  const category = String(value == null ? '' : value).trim().toLowerCase();
  return CHAT_CATEGORIES.includes(category) ? category : 'other';
}

function normalizeStatus(value) {
  const status = String(value == null ? '' : value).trim().toLowerCase();
  return CHAT_STATUSES.includes(status) ? status : 'open';
}

// ══════════════════════════════════════════════════════════════════════════
// THE RESOLVED LOCK
//
// A resolved conversation is FROZEN. Not "quiet", not "archived" — frozen:
// neither the member nor an administrator can add a message to it. The only way
// out is an administrator reopening it.
//
// Three properties follow, and they are the whole point:
//
//   1. Resolving is an ADMIN decision. A member marking their own question
//      answered closes a channel that only the operator can verify is finished,
//      and lets a member silence a thread that support had not finished with.
//   2. Nobody writes to a resolved thread. A message cannot revive it. This is
//      the change that makes "resolved" mean something: previously any reply
//      silently un-resolved the thread, so the state was decorative.
//   3. Reopening is also admin-only, for the same reason. If the member could
//      reopen, they could communicate again, which contradicts (2).
//
// The lock lives here, not in a route, because BOTH sides have to agree on it
// and a lock enforced in only one of the two files is not a lock.
// ══════════════════════════════════════════════════════════════════════════

/** One string for both sides, so the member and the admin are told the same thing. */
const RESOLVED_LOCK_MESSAGE = 'This conversation is resolved and is now read-only. '
  + 'An administrator can reopen it if there is more to discuss.';

/** True when the thread is resolved, and therefore frozen. */
function isThreadResolved(thread) {
  return normalizeStatus(thread?.status) === 'resolved';
}

/**
 * The ONE gate on writing to a thread. Call this before appending a message.
 *
 * @throws {ChatStateError} 409 when the thread is resolved.
 */
function assertThreadWritable(thread) {
  if (isThreadResolved(thread)) throw new ChatStateError(RESOLVED_LOCK_MESSAGE);
}

/**
 * A message body. Whitespace-only is rejected: it would render as an empty
 * bubble and still bump `messageCount`, `lastMessageAt` and the unread counter.
 */
function normalizeBody(value) {
  const body = String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
  if (!body) throw new ChatInputError('Please type a message before sending.');
  if (body.length > MAX_MESSAGE_LENGTH) {
    throw new ChatInputError(`Messages are limited to ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return body;
}

/**
 * The single definition of "who is waiting on whom", given who just spoke.
 *
 * Only reachable on a thread that is NOT resolved — assertThreadWritable() runs
 * first, so this never has to un-resolve anything. That is the point: a message
 * used to be a back door out of the resolved state, which made the state
 * meaningless.
 */
function statusAfterMessage(author) {
  return author === 'admin' ? 'pending' : 'open';
}

/**
 * Reopening is the one transition INTO a writable thread, so it points the ball
 * at the person who has to speak next.
 *
 * Only an administrator reopens, and the administrator is reopening precisely
 * because they have more to say — so this is 'open' ("waiting on us"), putting
 * the thread straight back into the working queue. It used to be 'pending',
 * which asserted the member owed us a reply at the exact moment the member had
 * not been told anything: a queue built on a lie.
 */
function statusAfterReopen() {
  return 'open';
}

/** One line for the inbox list. Newlines would break the single-line row. */
function buildPreview(body, max = 200) {
  const flat = String(body || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function categoryLabel(category) {
  return CATEGORY_LABELS[category] || CATEGORY_LABELS.other;
}

module.exports = {
  CHAT_CATEGORIES,
  CHAT_STATUSES,
  MAX_SUBJECT_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_MESSAGES_PER_THREAD,
  CATEGORY_LABELS,
  RESOLVED_LOCK_MESSAGE,
  ChatInputError,
  ChatStateError,
  collapse,
  normalizeSubject,
  normalizeCategory,
  normalizeStatus,
  normalizeBody,
  isThreadResolved,
  assertThreadWritable,
  statusAfterMessage,
  statusAfterReopen,
  buildPreview,
  categoryLabel,
};
