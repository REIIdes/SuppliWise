'use strict';

/**
 * Is this failure OUR infrastructure being briefly unavailable, or something
 * the caller did?
 *
 * The symptom this exists for: a request that answered "Something went wrong.
 * Please try again later." because the database socket blipped —
 *
 *     [login] connection 10 to 159.143.174.62:27017 timed out
 *
 * A 500 with generic wording tells the user nothing and invites them to retry
 * blindly into the same transient failure, which then looks like their input
 * was wrong. A 503 with a Retry-After says, in as many words, "this is our side
 * and it will clear".
 *
 * Lives in its own module because two routers need it and it was previously
 * copy-pasted-by-accident waiting to happen: `routes/auth.js` had it inline,
 * and `routes/passwordReset.js` needed the same judgement.
 */
function isTransientInfrastructureError(err) {
  if (!err) return false;

  const name = String(err.name || '');
  if (/^Mongo(Network|ServerSelection|Timeout|NotConnected|TopologyClosed)/.test(name)) return true;
  if (name === 'MongoError' || name === 'MongooseError') {
    // A driver-level failure we did not classify. Treat only the explicitly
    // transient ones; a duplicate-key or validation error is the caller's.
    return /timed out|timeout|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|pool|socket|not connected|topology/i
      .test(String(err.message || ''));
  }
  return /EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up/i.test(String(err.message || ''));
}

module.exports = { isTransientInfrastructureError };
