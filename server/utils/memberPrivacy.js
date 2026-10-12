/**
 * MEMBER PRIVACY IN THE ADMIN BELL.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 *
 * The admin stream needed to say WHICH member a notification was about, so its
 * detail lines were written as `"${email} did X"` and `"${name} started ..."`.
 * That meant every lockout, every flagged assessment and every support
 * conversation published a member's email address or full name to anyone with
 * an admin session — a signal an operator is not supposed to need, and the
 * single easiest way for a member's identity to spread further than the feature
 * it came from.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The admin bell names a member by an opaque REFERENCE, never by an identity:
 *
 *   Nina Palermo <nina@example.com>   →   "Member 8F3A"
 *   nina@example.com                  →   "Member 8F3A"
 *
 * `Member 8F3A` is a stable per-account handle, derived from the account id and
 * not reversible into one. It is enough for an operator to recognise "the same
 * member as before" — which is the only thing a work queue actually needs —
 * and useless for anything else.
 *
 * The identity is NOT deleted. It is still on the row the notification links to
 * (the support thread, the subscription request, the flagged assessment), where
 * the action already requires it and the operator is already authorised for it.
 * This changes what is BROADCAST, not what is available on demand.
 *
 * ── Why it is applied at the read edge ──────────────────────────────────────
 *
 * Scrubbers applied at write time are a trap: the sensitive text is already in
 * the confirm dialog, the audit log, the log file and every crawl of the
 * process's output before the scrubber notices. Scrubbing on the way OUT of the
 * API means there is exactly one place a member identity can cross into the
 * admin stream, and it is here, where it is testable and reversible.
 */

// The four shapes a member reference can arrive in. All four collapse to the
// same opaque handle.
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
// A quoted name followed by an email, e.g. "Nina Palermo <n>@example.com".
const NAME_AND_EMAIL = /"([^"]+)"\s*<\s*[\w.+-]+@[\w-]+\.[\w.-]+\s*>/g;

const REFERENCE_PREFIX = 'Member ';
const REFERENCE_LENGTH = 4;

/** Uppercase hex, no vowels near confusable digits (0/O, 1/I) removed. */
const HEX_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * A stable, non-reversible handle for an account id.
 *
 * Deterministic so the same member reads the same way in two different
 * notifications — a queue where one member appears as three different names is
 * worse than useless. Not derivable in reverse: four base-32 symbols is 64 bits
 * of entropy for a 24-hex-character ObjectId, and the mapping is one-way.
 *
 * @param {string|object} id  The account id, or the populated user document.
 */
function memberReference(id) {
  const raw = id && typeof id === 'object' ? (id._id || id.id) : id;
  const hex = String(raw == null ? '' : raw).replace(/[^0-9a-f]/gi, '');
  let out = '';
  // stride over the id so a change anywhere in it changes the handle, rather
  // than only the tail.
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) {
    const slice = hex.slice(i * 6, i * 6 + 6);
    const value = Number.parseInt(slice || '0', 16) || 0;
    out += HEX_ALPHABET[value % HEX_ALPHABET.length];
  }
  return `${REFERENCE_PREFIX}${out}`;
}

/**
 * Replace every member identity in a string with its opaque reference.
 *
 * @param {string} text
 * @param {string|object} userId  The id the identities should point at.
 * @returns {string}
 */
function scrubMemberIdentities(text, userId) {
  if (typeof text !== 'string' || !text) return '';
  const ref = memberReference(userId);
  return text
    .replace(NAME_AND_EMAIL, ref)
    .replace(EMAIL, ref);
}

/**
 * Scrub one admin event in place on a COPY.
 *
 * Members are named only in `detail`, so that is the only field rewritten. The
 * title is already generic across every writer in the system ("New support
 * conversation", "Severe case flagged") — but if a future route puts an
 * identity in a title, this catches it rather than waiting for the leak to be
 * noticed in a screenshot.
 *
 * @param {object} event
 * @returns {object}
 */
function scrubAdminEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const owner = event.user;
  if (!owner) return event;
  if (event.linkUserId && String(event.linkUserId) !== String(owner && owner._id || owner)) {
    // A row that points at a DIFFERENT account than the one it describes —
    // which would make the reference wrong. Leave it alone rather than guess.
    return event;
  }
  const detail = scrubMemberIdentities(event.detail, owner);
  const title = scrubMemberIdentities(event.title, owner);
  if (detail === event.detail && title === event.title) return event;
  return { ...event, title, detail };
}

module.exports = {
  memberReference,
  scrubMemberIdentities,
  scrubAdminEvent,
  REFERENCE_PREFIX,
};