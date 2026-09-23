/**
 * Assessment expiry rules.
 * - Standard assessments expire 5 CALENDAR years after creation (expiresAt),
 *   computed by expiryFrom()/expiryFromCreatedAt() — the exact same advance
 *   the frontend renders, so the stored date and the "Expires …" badge agree.
 * - Priority assessments NEVER expire while flagged — they resolve only by
 *   completing all supplements (auto-lift) or an admin decision.
 * - Expired assessments stay in the database (records preserved) but are
 *   retired from active views (dashboard / tracking / insights) and labeled
 *   EXPIRED in history.
 */

const RETENTION_YEARS = 5;

/**
 * Add RETENTION_YEARS CALENDAR years to `from`, keeping the same clock time.
 *
 * This is the ONE retention formula used everywhere. It must stay a calendar
 * advance (setFullYear) and never a fixed millisecond offset: `5 * 365.25 days`
 * drifts by ~6 h against a real 5-year span, which produced "Expires Sep 22,
 * 2031, 01:56 AM" — an expiry that matched neither the creation date nor time.
 * The frontend renders createdAt + 5 calendar years as a fallback, so both
 * sides now agree exactly.
 */
function expiryFrom(from) {
  const base = from instanceof Date ? from : new Date(from);
  if (!Number.isFinite(base.getTime())) return null;
  const result = new Date(base.getTime());
  result.setFullYear(result.getFullYear() + RETENTION_YEARS);
  return result;
}

/** Standard retention for a brand-new record (createdAt === now at insert). */
const expiryDateFromNow = () => expiryFrom(new Date());

/**
 * Standard retention for an EXISTING record — always counted from creation,
 * so resolving a Priority flag (or an auto-lift) can never push an old
 * assessment's expiry years into the future.
 */
function expiryFromCreatedAt(createdAt) {
  return expiryFrom(createdAt) || expiryDateFromNow();
}

function isExpired(doc, now = new Date()) {
  if (!doc) return true;
  if (doc.priority === 'Priority') return false;
  if (!doc.expiresAt) return false;
  return new Date(doc.expiresAt).getTime() <= now.getTime();
}

function notExpiredFilter(now = new Date()) {
  return { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
}

/**
 * Latest assessment still in force for a user (null when none).
 * Never returns expired assessments or assumes — callers treat null as
 * "no active assessment".
 */
async function findActiveAssessment(userId, select) {
  const Assessment = require('../models/Assessment');
  let query = Assessment.find({ user: userId, ...notExpiredFilter() }).sort({ createdAt: -1 });
  if (select) query = query.select(select);
  const docs = await query.limit(1).lean();
  return docs && docs.length > 0 ? docs[0] : null;
}

module.exports = {
  RETENTION_YEARS,
  expiryFrom,
  expiryDateFromNow,
  expiryFromCreatedAt,
  isExpired,
  notExpiredFilter,
  findActiveAssessment,
};
