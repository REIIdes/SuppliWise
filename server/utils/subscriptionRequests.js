/**
 * Shared rules for "proof of payment" subscription requests.
 *
 * Both the user route (create/list) and the admin route (queue/approve/reject)
 * need the SAME answers to four questions, so the answers live here and cannot
 * drift apart:
 *
 *   1. Is this a plan we sell, and for how many months?
 *   2. Is this actually an image, and is it small enough to store?
 *   3. What did it cost — priced by US, from the catalogue, never from the body?
 *   4. What is safe to send in a LIST response? (never the image itself)
 *
 * Storage: the proof is kept as a base64 data URL in Mongo, matching the
 * profile/banner pictures. There is no file host, so there is no path to walk,
 * no static route to guess at and no orphan file to clean up. The cost is
 * payload size, which is why the cap below is enforced on BOTH sides of the
 * wire: the browser refuses the pick, and the server refuses the body.
 */
const { normalizePlanId, subState, PLAN_LABELS } = require('./entitlements');
const {
  findEntry, formatAmount, convertFromPhp, resolvePurchasable,
  CURRENCIES, DEFAULT_CURRENCY,
} = require('./planCatalogue');

/** The individual paid tiers. The Free plan is already the default. */
const REQUESTABLE_PLANS = ['monthly', 'annual', 'custom'];
const REQUEST_STATUSES = ['pending', 'approved', 'rejected'];
const MAX_MONTHS = 12;

/**
 * Proof-image budget.
 *
 * A 2 MB PNG receipt is already generous. base64 inflates bytes by 4/3 plus a
 * short `data:image/png;base64,` header, so the data URL a 2 MB file produces is
 * about 2.7 MB. The data-URL ceiling is DERIVED from the file ceiling rather
 * than typed as a second magic number, so the two can never disagree and reject
 * a picture the picker already accepted.
 */
const MAX_PROOF_IMAGE_BYTES = 2 * 1024 * 1024;                        // the file
const BASE64_OVERHEAD_NUM = 4;                                       // ceil(n/3)*4
const BASE64_OVERHEAD_DEN = 3;
const MAX_PROOF_DATA_URL_BYTES =                                      // the string we store
  Math.ceil((MAX_PROOF_IMAGE_BYTES * BASE64_OVERHEAD_NUM) / BASE64_OVERHEAD_DEN) + 256;

/**
 * Raster formats only. `image/svg+xml` is deliberately absent: an SVG data URL
 * is a script vector, and rendering one from an untrusted upload is a stored-XSS
 * hole. `image/jpg` is not a real MIME type (browsers report `image/jpeg`) and
 * `image/gif` is excluded to keep the set of decoders we hand a blob to small.
 */
const ALLOWED_PROOF_MIME = ['image/png', 'image/jpeg', 'image/webp'];

// A data URL, MIME-restricted, with a strict base64 alphabet. Anchored end to
// end so trailing junk after the payload cannot ride along.
const PROOF_DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

const MAX_REFERENCE_LENGTH = 80;
const MAX_NOTE_LENGTH = 500;

/**
 * Validate a proof-of-payment upload.
 *
 * @param {unknown} value raw string from the request body
 * @returns {{ok: true, dataUrl: string, mime: string, bytes: number}
 *          |{ok: false, status: number, message: string}}
 */
function parseProofImage(value) {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, status: 400, message: 'Attach a photo or screenshot of your payment as proof.' };
  }
  // FileReader output has no line breaks, but a hand-built body can, and a
  // stray newline would fail the alphabet check below for no good reason.
  const compact = value.replace(/\s+/g, '');
  // Size first: the 10 MB body cap still allows a very large string, and there
  // is no reason to run the pattern over megabytes we are about to refuse. The
  // pattern itself has no nested quantifier, so it cannot backtrack — but not
  // scanning is better than not backtracking.
  const bytes = Buffer.byteLength(compact, 'utf8');
  if (bytes > MAX_PROOF_DATA_URL_BYTES) {
    return {
      ok: false,
      status: 413,
      message: 'That image is too large. Please use a smaller screenshot (max 2 MB).',
    };
  }
  // The pattern is anchored at both ends, so trailing junk after the base64
  // payload cannot ride along. JS `$` (without the `m` flag) is end-of-input
  // only — it does not tolerate a trailing newline, and the whitespace strip
  // above removes that concern anyway.
  const match = PROOF_DATA_URL.exec(compact);
  if (!match) {
    return {
      ok: false,
      status: 400,
      message: 'The proof of payment must be a PNG, JPEG or WebP image.',
    };
  }
  return { ok: true, dataUrl: compact, mime: match[1], bytes };
}

/**
 * Validate the proof field, which is OPTIONAL when the deployment has nowhere to
 * send a payment.
 *
 * This is the fix for the checkout dead end. The old contract was "a receipt is
 * required", unconditionally — and it was enforced in two places, both of which
 * had to be believed at once:
 *
 *   the UI  marked "Proof of payment **required**" and left the submit button
 *           disabled until an image was attached, and
 *   the API  called parseProofImage(), which returned 400 for an absent proof.
 *
 * With no payment destination configured (the state this repository ships in),
 * that pair produced a flow nobody could finish: step 1 says "there is nothing to
 * transfer to, send an administrator a request", step 2 makes a receipt
 * mandatory, and the member is blocked from sending the request the product just
 * asked for. Both branches were individually reasonable; together they were
 * unusable.
 *
 * The rule now depends on whether a transfer is even possible (see
 * paymentInstructions.receiptRequired, which owns that decision):
 *
 *   receipt required  → an absent proof is still a 400, exactly as before.
 *   receipt optional  → an absent proof is accepted, and `provided: false` says
 *                       so, so the admin queue can tell "no receipt because
 *                       there was nowhere to pay" apart from "receipt failed to
 *                       upload".
 *
 * A PRESENT proof is validated identically in both modes. Loosening what is
 * accepted must not loosen how it is checked: a hand-built body that claims no
 * receipt because there was nowhere to pay cannot smuggle in a 40 MB string, a
 * `text/html` payload or a truncated base64 blob under the optional path.
 *
 * @param {unknown} value     raw string from the request body
 * @param {object}  [opts]
 * @param {boolean} [opts.optional] accept an absent proof (no destination)
 * @returns {{ok: true, dataUrl: string, mime: string, bytes: number, provided: boolean}
 *          |{ok: false, status: number, message: string}}
 */
function parseProofUpload(value, { optional = false } = {}) {
  const isBlank = value === undefined || value === null
    || (typeof value === 'string' && value.replace(/\s+/g, '').length === 0);

  if (isBlank) {
    if (!optional) return parseProofImage(value);
    return { ok: true, dataUrl: '', mime: '', bytes: 0, provided: false };
  }

  const parsed = parseProofImage(value);
  // Tag a supplied receipt so callers never have to infer "was one attached?"
  // from the emptiness of a string.
  return parsed.ok ? { ...parsed, provided: true } : parsed;
}

/**
 * Normalise what is being requested.
 *
 * Aliases ("deluxe", "premium", "ultimate") resolve to their canonical ids, so
 * the queue can never contain a plan id the subscription engine does not know.
 * `free` is rejected with its own message: it is a real plan, just not a
 * requestable one, and "Choose a paid plan" beats "Invalid plan".
 *
 * There is no seat count here and no `isTeam`: a request is one account on one
 * plan, and `plan: 'team'` now fails as the unknown id it is.
 *
 * @returns {{ok: true, plan: string}
 *          |{ok: false, status: number, message: string}}
 */
function resolveRequestedPlan(raw) {
  const purchasable = resolvePurchasable(raw);
  if (!purchasable) return { ok: false, status: 400, message: 'Choose a valid plan.' };
  const { tier } = purchasable;
  if (!REQUESTABLE_PLANS.includes(tier)) {
    return { ok: false, status: 400, message: 'The Free plan needs no purchase — it is already yours.' };
  }
  return { ok: true, plan: tier };
}

/** Clamp the requested term to whole months inside [1, 12]. */
function clampMonths(raw) {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return subState.STANDARD_PERIOD_MONTHS;
  return Math.min(MAX_MONTHS, Math.max(1, Math.round(parsed)));
}

/**
 * Price a request from the catalogue.
 *
 * `months > 1` is billed up front at the yearly price — exactly as
 * POST /subscription/purchase computes it, so the figure an admin checks against
 * a bank transfer is the figure the receipt says, and neither is ever read from
 * the request body.
 *
 * Returns `null` for an unknown plan, so a caller that skipped validation cannot
 * quietly store a ₱0 request: the route turns that into a 400.
 */
function priceRequest(plan, months, currencyCode) {
  const code = CURRENCIES[currencyCode] ? currencyCode : DEFAULT_CURRENCY;
  const entry = findEntry(plan);
  if (!entry) return null;
  // The Free plan IS in the catalogue, so `findEntry` finds it — at ₱0. A ₱0
  // request is the one thing that must never reach the admin queue, where it
  // would sit looking like a real purchase that happens to cost nothing, so it
  // is refused here rather than relying on every caller having validated first.
  if (!(entry.monthly > 0)) return null;
  const amountPhp = months > 1 ? entry.yearly : entry.monthly;
  return {
    currency: code,
    symbol: CURRENCIES[code].symbol,
    amountPhp,
    amount: convertFromPhp(amountPhp, code),
    formattedAmount: formatAmount(amountPhp, code),
  };
}

/** Trim + cap a free-text field, returning '' for anything unusable. */
function cleanText(raw, max) {
  if (typeof raw !== 'string') return '';
  // Collapse newlines/tabs to single spaces: these fields are rendered inline in
  // the admin queue, and a raw multi-line note would break the row layout.
  return raw.replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The safe shape of a request for a LIST response.
 *
 * The proof is a multi-megabyte string and a queue page may hold 50 rows —
 * shipping it here would be tens of megabytes per poll. The image is fetched
 * once, on demand, from the single-request detail endpoint.
 */
function toSummary(doc) {
  if (!doc) return null;
  const { proof, ...rest } = doc;
  // `hasProof` must NOT be derived from `proof` itself. The list query already
  // projects LIST_FIELDS, which excludes the image — so by the time a row
  // reaches here `proof` is always undefined and the flag was permanently
  // false, telling every admin that a request had no receipt attached. The
  // stored metadata is the honest source, and it survives the projection.
  const hasProof = typeof proof === 'string' && proof.length > 0
    ? true
    : Number(rest.proofBytes) > 0 && !!rest.proofMime;
  return { ...rest, hasProof };
}

/** Projection for list queries — the same reason as toSummary. */
const LIST_FIELDS = [
  '_id', 'user', 'plan', 'months', 'currency', 'symbol',
  'amountPhp', 'amount', 'formattedAmount',
  'reference', 'note', 'proofMime', 'proofBytes', 'status',
  'paymentRequired', 'review', 'grantedPlan', 'grantedDays', 'createdAt', 'updatedAt',
].join(' ');

/**
 * Human label for what was requested.
 *
 * Lives here, not in a route, because the admin queue, the member's own request
 * list, the audit trail and the bell notification all print it. One definition
 * means those four can never disagree about what a request was for.
 *
 * It used to rebuild "5× Team" from `isTeam` + `seats`; with Team gone this is
 * just the tier's name, which is all a request can be.
 */
function planLabelFor(row) {
  const record = row && typeof row === 'object' ? row : { plan: row };
  return PLAN_LABELS[record.plan] || String(record.plan || '—');
}

/** "3 Apr 2026, 14:05" — used in the admin audit trail and notification copy. */
function formatStamp(value) {
  if (!value) return '';
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

module.exports = {
  REQUESTABLE_PLANS,
  REQUEST_STATUSES,
  MAX_MONTHS,
  MAX_REFERENCE_LENGTH,
  MAX_NOTE_LENGTH,
  MAX_PROOF_IMAGE_BYTES,
  MAX_PROOF_DATA_URL_BYTES,
  ALLOWED_PROOF_MIME,
  LIST_FIELDS,
  parseProofImage,
  parseProofUpload,
  resolveRequestedPlan,
  clampMonths,
  priceRequest,
  cleanText,
  toSummary,
  planLabelFor,
  formatStamp,
};
