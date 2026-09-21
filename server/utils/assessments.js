/**
 * Assessment expiry rules.
 * - Standard assessments expire 5 years after creation (expiresAt).
 * - Priority assessments NEVER expire while flagged — they resolve only by
 *   completing all supplements (auto-lift) or an admin decision.
 * - Expired assessments stay in the database (records preserved) but are
 *   retired from active views (dashboard / tracking / insights) and labeled
 *   EXPIRED in history.
 */

const FIVE_YEARS_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

const expiryDateFromNow = () => new Date(Date.now() + FIVE_YEARS_MS);

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
  FIVE_YEARS_MS,
  expiryDateFromNow,
  isExpired,
  notExpiredFilter,
  findActiveAssessment,
};
