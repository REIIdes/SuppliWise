/**
 * TICKET IDS — the short, human-quotable reference for a support conversation.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A ChatThread is identified by a Mongo ObjectId. That id is fine for a URL and
 * useless over the phone: nobody can read "65f1c2a4b9d33e0012ab77de" aloud to
 * an administrator without either reading it wrong or reaching for the screen.
 * Support conversations are exactly the thing people quote to each other — "my
 * ticket is SW-4KQ7M2XB" — so the reference has to be something a person can
 * dictate, copy out of an email, or find in a search box.
 *
 * ── The format ──────────────────────────────────────────────────────────────
 * `SW-XXXXXXXX` — an 8-character Crockford-style base32 code behind a 2-letter
 * product prefix. 32^8 ≈ 1.1e12 possibilities, so a collision is not a thing
 * anyone will meet in production, but the writer below still retries on one
 * because "astronomically unlikely" is not "impossible" and the unique index
 * would turn the difference into a 500 on somebody's first message of the day.
 *
 * The alphabet omits I, L, O and U. Those are the characters people mistype
 * when reading a code out, and a support agent who types SW-4KQ7MZLB instead of
 * SW-4KQ7M2XB should get a search result rather than a support ticket about the
 * support ticket.
 *
 * ── Where it is assigned ────────────────────────────────────────────────────
 * On creation, and — because the field did not exist before this — lazily, on
 * read, for threads created earlier. Lazy assignment is idempotent and
 * conditional (`$or: [{ ticketId: { $exists: false } }]`), so two concurrent
 * readers cannot stamp two different codes onto the same thread; the loser
 * re-reads and takes the winner's value. Backfilling on read rather than in a
 * migration script means a deployment never has to finish a migration before
 * the feature works, and a thread nobody has opened in a year gets its code the
 * day somebody finally looks at it.
 */

const crypto = require('crypto');
const ChatThread = require('../models/ChatThread');

/**
 * Crockford base32 minus I, L, O and U. `byte % 32` over 8 random bytes is
 * uniform because 256 is a whole multiple of 32 — no modulo bias, so no need
 * for rejection sampling here.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const PREFIX = 'SW';
const MAX_ATTEMPTS = 6;

const TICKET_PATTERN = new RegExp(`^${PREFIX}-[${ALPHABET}]{${CODE_LENGTH}}$`);

/** One code. Caller-supplied collision handling is the caller's business. */
function generateTicketId() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return `${PREFIX}-${code}`;
}

/** Strict: exactly the shape generateTicketId() produces. */
function isTicketId(value) {
  return TICKET_PATTERN.test(String(value || ''));
}

/**
 * Normalise something a human typed into the admin search box.
 *
 * Returns '' for anything that cannot be a code, and the upper-cased, spaced and
 * hyphen-stripped form otherwise — so `sw 4kq7m2xb`, `SW-4KQ7M2XB` and
 * `sw4k7m2xb` all become the same query. Strict enough to avoid turning an
 * ordinary search term into a regex it was never meant to be.
 */
function normalizeTicketSearch(value) {
  const raw = String(value == null ? '' : value).toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (!raw.startsWith(PREFIX)) return '';
  const code = raw.slice(PREFIX.length);
  if (code.length !== CODE_LENGTH) return '';
  const candidate = `${PREFIX}-${code}`;
  return isTicketId(candidate) ? candidate : '';
}

// ══════════════════════════════════════════════════════════════════════════
// ASSIGNMENT — the half that needs the model.
//
// Everything above this line is a pure function of its input. Everything below
// touches ChatThread, and is kept here rather than in the two routers so the
// member side and the admin side cannot drift on when a ticket id is stamped.
// ══════════════════════════════════════════════════════════════════════════

/**
 * Create a thread with a ticket id already on it.
 *
 * The unique index is the only thing standing between two simultaneous
 * creations and a duplicate code, so a duplicate-key error is retried with a
 * fresh code rather than surfaced. Any other error is real and propagates.
 */
async function createThread(doc) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ChatThread.create({ ...doc, ticketId: generateTicketId() });
    } catch (error) {
      if (error && error.code === 11000) continue;
      throw error;
    }
  }
  // Six 1-in-a-trillion collisions in a row is not a collision, it is a broken
  // index or a full disk. Say so instead of silently creating an un-ticketed
  // thread that would break every assumption downstream.
  throw new Error('Could not allocate a unique ticket id.');
}

/**
 * Stamp a ticket id onto one legacy thread, or return the id it already has.
 *
 * The write is conditional on the field being absent, so concurrent callers
 * race harmlessly: exactly one wins the `findOneAndUpdate` and the rest fall
 * through to the re-read and report the same value. Assigning twice would not
 * be catastrophic, but it would make a ticket id change after a member had
 * already quoted it, which is worse than a duplicate.
 *
 * @returns {Promise<string|null>} the thread's ticket id, or null if it has none.
 */
async function assignTicketId(threadId) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const candidate = generateTicketId();
    try {
      const claimed = await ChatThread.findOneAndUpdate(
        { _id: threadId, $or: [{ ticketId: { $exists: false } }, { ticketId: null }] },
        { $set: { ticketId: candidate } },
        { new: true, projection: { ticketId: 1 } }
      ).lean();
      if (claimed && isTicketId(claimed.ticketId)) return claimed.ticketId;

      // Somebody beat us to it, or the filter did not match. Either way the
      // authoritative answer is what is on the document now.
      const current = await ChatThread.findById(threadId).select('ticketId').lean();
      return isTicketId(current?.ticketId) ? current.ticketId : null;
    } catch (error) {
      if (error && error.code === 11000) continue;
      throw error;
    }
  }
  return null;
}

/**
 * Give every thread in a list a ticket id, in place.
 *
 * Called by the list endpoints. Threads created before this feature existed
 * have no code; the UI renders a code for all of them from the moment the
 * feature is deployed, with no migration to run and no window where a member
 * can see a conversation without a reference to quote.
 *
 * A failure here is deliberately swallowed: a ticket id is a convenience, and
 * a database hiccup while backfilling one must not take the whole inbox down.
 * The row still renders, minus its code.
 */
async function withTicketIds(threads) {
  if (!Array.isArray(threads) || threads.length === 0) return threads;
  // Sequential, not parallel. This only ever touches threads created before
  // the field existed — a one-off pass over the backlog — and 50 conditional
  // updates fired at once buys nothing but a thundering herd on a shared
  // mongod.
  for (const thread of threads) {
    if (isTicketId(thread.ticketId)) continue;
    try {
      const assigned = await assignTicketId(thread._id);
      if (assigned) thread.ticketId = assigned;
    } catch (error) {
      console.error('[ticketId] backfill failed', error.message);
    }
  }
  return threads;
}

module.exports = {
  ALPHABET,
  CODE_LENGTH,
  PREFIX,
  generateTicketId,
  isTicketId,
  normalizeTicketSearch,
  createThread,
  assignTicketId,
  withTicketIds,
};
