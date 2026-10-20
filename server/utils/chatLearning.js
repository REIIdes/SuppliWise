'use strict';

const AiChatFeedback = require('../models/AiChatFeedback');

/**
 * MAKING RETRIEVAL ADAPT TO WHAT MEMBERS ACTUALLY ACCEPTED.
 *
 * This is the second learning loop the ledger was designed for: not a model
 * training run, but a ranking that changes as its answers get used. Every vote a
 * member casts lands against the reference notes that produced that answer; this file
 * turns those votes into a bounded weight per note, and `ragRetriever.retrieve` uses
 * it as a multiplier on the BM25 score.
 *
 * Three properties are the reason it is shaped like this:
 *
 * - NO PROVIDER CALLS. The condition-learning loop spends paid quota and therefore
 *   needs a lease, a watermark and a minimum interval. This one reads a collection
 *   and does arithmetic, so it can run inside a request, and the only cost of being
 *   wrong is a slightly reordered note list. It is cached in-process anyway because
 *   five thousand members should not each pay for the same aggregation.
 *
 * - BOUNDED, AND UNABLE TO OVERRIDE THE QUESTION. A weight is clamped to
 *   [-0.45, +0.6] and applied as a multiplier, so the most popular note in the app
 *   can never outrank a note that actually matches the words in front of it. A prior
 *   that could dominate retrieval would let last month's votes decide today's answer,
 *   and a member asking about iron would keep getting whatever else happened to be
 *   popular. Feedback tunes which evidence gets handed over; it never writes evidence.
 *
 * - DECAYED, SO A CORRECTION IS POSSIBLE. Half-life 30 days inside a 90-day window:
 *   a note that was wrong and got fixed falls out of the ranking on its own instead
 *   of carrying a 2026 down-vote forever.
 */

const CACHE_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_MS = 60 * 1000;
const WINDOW_DAYS = 90;
const HALF_LIFE_DAYS = 30;
const MAX_ROWS = 5000;
const MIN_VOTES = 2;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Rows -> weights, pure and synchronous so it can be asserted without a database.
 *
 * @param {Array<{docIds: string[], vote: string, createdAt: Date}>} rows
 * @param {Date} [now]
 * @returns {Map<string, number>}
 */
function priorsFromRows(rows, now = new Date()) {
  const tally = new Map();
  for (const row of rows || []) {
    const docs = Array.isArray(row.docIds) ? row.docIds : [];
    if (row.vote !== 'up' && row.vote !== 'down') continue;
    const at = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    if (!Number.isFinite(at.getTime())) continue;
    const ageDays = Math.max(0, (now.getTime() - at.getTime()) / 86400000);
    if (ageDays > WINDOW_DAYS) continue;
    const signed = (row.vote === 'up' ? 1 : -1) * Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    // One note repeated across a member's many turns is one opinion counted
    // repeatedly; the per-row contribution is already decayed, and the cap below is
    // what stops a single heavily-used note from accumulating an unbounded lead.
    for (const id of new Set(docs)) {
      const prev = tally.get(id) || { sum: 0, n: 0 };
      prev.sum += signed;
      prev.n += 1;
      tally.set(id, prev);
    }
  }

  const priors = new Map();
  for (const [id, { sum, n }] of tally) {
    if (n < MIN_VOTES) continue;
    priors.set(id, clamp(sum / (n + 3), -0.45, 0.6));
  }
  return priors;
}

const state = { at: 0, priors: new Map(), failed: false, rows: 0 };

/**
 * The published priors, refreshed at most every five minutes.
 *
 * A throw here would take a chat reply down with it, and an assistant that answers
 * with a slightly stale ranking is strictly better than one that 500s. So the last
 * good map is kept and failures are retried on a shorter clock.
 */
async function priorsForRetrieval({ force = false } = {}) {
  const ttl = state.failed ? NEGATIVE_CACHE_MS : CACHE_MS;
  if (!force && Date.now() - state.at < ttl) return state.priors;
  try {
    const since = new Date(Date.now() - WINDOW_DAYS * 86400000);
    const rows = await AiChatFeedback.find({ createdAt: { $gte: since } })
      .select('docIds vote createdAt')
      .sort({ createdAt: -1 })
      .limit(MAX_ROWS)
      .lean();
    state.priors = priorsFromRows(rows);
    state.rows = rows.length;
    state.at = Date.now();
    state.failed = false;
  } catch (error) {
    state.failed = true;
    state.at = Date.now();
    console.warn('[chat-learning] prior refresh failed, keeping last good ranking:', error.message);
  }
  return state.priors;
}

/** Numbers for the admin monitor: is the loop fed at all, and what does it say? */
async function feedbackStats() {
  const since = new Date(Date.now() - 30 * 86400000);
  const [ups, downs, repairedDowns] = await Promise.all([
    AiChatFeedback.countDocuments({ vote: 'up', createdAt: { $gte: since } }),
    AiChatFeedback.countDocuments({ vote: 'down', createdAt: { $gte: since } }),
    AiChatFeedback.countDocuments({ vote: 'down', wasRepaired: true, createdAt: { $gte: since } }),
  ]);
  const last = await AiChatFeedback.findOne().sort({ createdAt: -1 }).select('createdAt').lean();
  return {
    windowDays: 30,
    ups,
    downs,
    repairedDowns,
    total: ups + downs,
    approvalRate: ups + downs ? Number((ups / (ups + downs)).toFixed(4)) : null,
    activePriors: state.priors.size,
    priorRows: state.rows,
    priorsFailed: state.failed,
    lastFeedbackAt: last && last.createdAt ? last.createdAt.toISOString() : null,
  };
}

/** Drop the cache so the next turn recomputes — a fresh vote should not wait five minutes. */
function invalidatePriors() {
  state.at = 0;
}

/** Test seam: forget the cache so a suite does not inherit another test's state. */
function _resetCache() {
  state.at = 0;
  state.priors = new Map();
  state.failed = false;
  state.rows = 0;
}

module.exports = {
  priorsFromRows,
  priorsForRetrieval,
  feedbackStats,
  invalidatePriors,
  WINDOW_DAYS,
  HALF_LIFE_DAYS,
  MIN_VOTES,
  _resetCache,
};
