/**
 * Presentation helpers for the administrator credential dialogs — the
 * credential-update notice and the one-time hand-off.
 *
 * WHY A SEPARATE MODULE
 * ---------------------
 * Both dialogs answer the same four questions and were answering them twice, in
 * slightly different ways, which is how they drifted:
 *
 *   1. What exactly will be in the message?      → normalizeNoticeDescription
 *   2. Who will the server actually reach?       → noticeRecipients
 *   3. Who exists but has no address on file?    → noticeMissingAliases
 *   4. May the operator press Send yet?          → buildNoticeView
 *
 * Every function here is TOTAL: given any input — `undefined`, a half-filled
 * preview, a `null` entry where a recipient object was promised — it returns
 * something renderable and never throws. That is the contract that lets the
 * dialog render through a failed request instead of vanishing, which is what it
 * used to do.
 *
 * THE COUNT PROBLEM
 * -----------------
 * `visibleCount` (the rows on screen) and `recipients.length` (the list the
 * SERVER will mail) are different populations and the dialog must not blur them:
 *
 *   · the rows come from Mongo, are capped at 100, and are filtered by whatever
 *     the operator has typed in the search box;
 *   · the recipients come from the ADMIN_EMAILS value in .env, are
 *     de-duplicated by address, and ignore the search entirely.
 *
 * The old title read `Email {adminsWithEmail} administrator(s)?` from the visible
 * rows while the list printed underneath came from the server — so a search for
 * one alias produced "Email 1 administrator(s)?" above a list of six. The count
 * is taken from the server's list whenever the preview resolved, and the
 * fallback is only used while it has not (see `countKnown`).
 */

/**
 * Longest description the server will accept or render.
 *
 * Mirrors `String(body.description || '').trim().slice(0, 400)` in
 * server/routes/admin.js and the identical cap in
 * server/utils/adminCredentialNotice.js. Kept here so the textarea's
 * `maxLength`, its character counter and the request body agree — and so a paste
 * that is refused by the field is the same paste the server would have truncated
 * at the wrong place anyway.
 */
export const CREDENTIAL_NOTICE_MAX_LENGTH = 400;

/**
 * Trim and cap an operator-supplied description.
 *
 * TRIMMED, because the server trims too and a description of `"   "` must come
 * back as empty so the caller can show "the standard wording will be sent"
 * rather than mailing a blank notice. CAPPED for the same reason as the server
 * so what the operator counted in the textarea is what the recipients read.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function normalizeNoticeDescription(value, max = CREDENTIAL_NOTICE_MAX_LENGTH) {
  const requested = Number(max);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : CREDENTIAL_NOTICE_MAX_LENGTH;
  return String(value ?? '').trim().slice(0, limit);
}

/**
 * Aliases the server says the message will reach, in the server's own order.
 *
 * Entries are read defensively — a bare string, a missing `alias`, a repeated
 * alias — because this list decides how many people a security mail is about to
 * go to, and a malformed entry must never render as "undefined" in the count or
 * become a second copy of the same notice.
 *
 * @param {unknown} preview `GET /admin/admins/credential-notice/preview`
 * @returns {string[]}
 */
export function noticeRecipients(preview) {
  const rows = Array.isArray(preview?.recipients) ? preview.recipients : [];
  const seen = new Set();
  const aliases = [];
  for (const row of rows) {
    const alias = String((typeof row === 'string' ? row : row?.alias) ?? '').trim();
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias);
  }
  return aliases;
}

/**
 * Aliases that exist as admin accounts but have no address in ADMIN_EMAILS, so
 * the send will skip them.
 *
 * @param {unknown} preview
 * @returns {string[]}
 */
export function noticeMissingAliases(preview) {
  const rows = Array.isArray(preview?.missingEmail) ? preview.missingEmail : [];
  const seen = new Set();
  const aliases = [];
  for (const row of rows) {
    const alias = String(row ?? '').trim();
    if (!alias || seen.has(alias)) continue;
    seen.add(alias);
    aliases.push(alias);
  }
  return aliases;
}

/**
 * "Email 6 administrators?" / "Email 1 administrator?" — and a count-free title
 * while the real list is unknown, because a title that states a number nobody
 * can vouch for is worse than one that states none.
 *
 * @param {number} count
 * @param {boolean} known whether `count` came from the server's list
 * @returns {string}
 */
export function noticeTitle(count, known) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!known || n === 0) return 'Email the credential-update notice?';
  return `Email ${n} administrator${n === 1 ? '' : 's'}?`;
}

/**
 * Everything the credential-update notice dialog renders, derived in one place.
 *
 * `status` is the single decision the dialog branches on, and the four values
 * are mutually exclusive and all reachable:
 *
 *   'loading' the preview request is in flight
 *   'failed'  it could not be fetched — the reason is in the error banner, and
 *             the dialog says so rather than pretending there is nobody to mail
 *   'empty'   it resolved, and NO administrator has an address on file
 *   'ready'   it resolved with at least one recipient
 *
 * `usingDefault` is the counterpart to the textarea: a CLEARED field is not an
 * empty notice, it is the server's standard sentence, and the dialog has to say
 * that out loud — otherwise an operator who selects-all and deletes a sentence
 * approves a mail that will arrive carrying words they never wrote.
 *
 * @param {object} [input]
 * @param {object|null} [input.preview] the resolved preview, or null while it has not loaded
 * @param {string} [input.description] raw textarea value
 * @param {boolean} [input.loading]
 * @param {boolean} [input.sending]
 * @param {number} [input.visibleCount] rows on screen, used only before the preview resolves
 * @returns {{
 *   status: 'loading'|'failed'|'empty'|'ready',
 *   loading: boolean, sending: boolean,
 *   recipients: string[], missing: string[],
 *   count: number, countKnown: boolean, title: string,
 *   description: string, usingDefault: boolean,
 *   canSend: boolean, blockedReason: string,
 * }}
 */
export function buildNoticeView({
  preview = null,
  description = '',
  loading = false,
  sending = false,
  visibleCount = 0,
} = {}) {
  const recipients = noticeRecipients(preview);
  const missing = noticeMissingAliases(preview);
  const text = normalizeNoticeDescription(description);
  const loaded = Boolean(preview);
  const status = loading
    ? 'loading'
    : !loaded
      ? 'failed'
      : recipients.length > 0 ? 'ready' : 'empty';

  // The server's list is the only thing that knows who will be reached. The
  // visible rows are a stand-in for the title until that arrives, and are never
  // used to decide whether the send may go ahead.
  const countKnown = loaded;
  const count = countKnown
    ? recipients.length
    : Math.max(0, Math.floor(Number(visibleCount) || 0));

  const canSend = status === 'ready' && !sending;

  return {
    status,
    loading: Boolean(loading),
    sending: Boolean(sending),
    recipients,
    missing,
    count,
    countKnown,
    title: noticeTitle(count, countKnown),
    description: text,
    usingDefault: text === '',
    canSend,
    // Why the button is dead. A disabled control with no reason reads as a bug;
    // this is what the operator's cursor should be able to find out instead.
    blockedReason: sending
      ? 'Sending the notice…'
      : status === 'loading'
        ? 'Reading the administrator address list…'
        : status === 'failed'
          ? 'The administrator address list could not be loaded, so there is nobody confirmed to send to.'
          : status === 'empty'
            ? 'No administrator has an address on file, so this would send nothing.'
            : '',
  };
}

/**
 * The line under the description field, in the operator's terms.
 *
 * Split on `usingDefault` because those two states need opposite advice: one is
 * "your words replace the standard sentence", the other is "the standard
 * sentence is going out instead".
 *
 * @param {boolean} usingDefault
 * @returns {string}
 */
export function noticeDescriptionHint(usingDefault) {
  return usingDefault
    ? 'Empty, so the standard wording below is sent instead.'
    : 'Replaces the standard sentence in every message. No password or key can be added here.';
}