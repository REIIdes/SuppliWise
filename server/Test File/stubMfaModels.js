'use strict';
/**
 * Stub the models the second step of sign-in touches, for unit tests that drive
 * `/api/auth/login` with a hand-built User and no database.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * `/login` now mints an MFA TRANSACTION and, for accounts with a second
 * factor, counts the account's passkeys and unused recovery codes. Each of
 * those is a real database round-trip, and a unit test that stubs only `User`
 * leaves them to buffer against a connection that does not exist — so the query
 * sits for Mongoose's 10-second buffer timeout and the route answers 500. The
 * failure looks like a broken login route rather than a stale double, which is
 * the same class of problem `stubQuery.js` was written to stop.
 *
 * Stated here once so the three suites that drive `/login` cannot drift.
 */
const Passkey = require('../models/Passkey');
const BackupCode = require('../models/BackupCode');
const MfaTransaction = require('../models/MfaTransaction');

/**
 * A Mongoose-shaped query that resolves to null.
 *
 * Chainable AND thenable, because the production code does both: the routes
 * call `.findOne(...).select(...).sort(...).lean()` and sometimes reorder those.
 * A stub that only supports one ordering fails with "select is not a function"
 * the moment a route is refactored — which is the trap stubQuery.js documents.
 */
function nullQuery() {
  const query = {
    select: () => query,
    sort: () => query,
    lean: async () => null,
    then: (onFulfilled, onRejected) => Promise.resolve(null).then(onFulfilled, onRejected),
    catch: (onRejected) => Promise.resolve(null).catch(onRejected),
  };
  return query;
}

/**
 * Replace the three models' query methods with in-memory doubles.
 *
 * @param {object} [options]
 * @param {number} [options.passkeys]     what `Passkey.countDocuments` reports
 * @param {number} [options.backupCodes]  what `BackupCode.countDocuments` reports
 * @param {object|null} [options.transaction] a live transaction to resolve, or
 *   null (the default) to say "this account is not mid-sign-in"
 * @returns {() => void} restore function
 */
function stubMfaModels({ passkeys = 0, backupCodes = 0, transaction = null } = {}) {
  const originals = {
    passkeyCount: Passkey.countDocuments,
    backupCount: BackupCode.countDocuments,
    transactionUpdateMany: MfaTransaction.updateMany,
    transactionCreate: MfaTransaction.create,
    transactionFindOne: MfaTransaction.findOne,
    transactionFindOneAndUpdate: MfaTransaction.findOneAndUpdate,
  };

  Passkey.countDocuments = async () => passkeys;
  BackupCode.countDocuments = async () => backupCodes;
  MfaTransaction.updateMany = async () => ({ modifiedCount: 0 });
  MfaTransaction.create = async (doc) => doc;
  MfaTransaction.findOne = () => {
    const query = nullQuery();
    query.lean = async () => (transaction ? { ...transaction } : null);
    return query;
  };
  // Spending a transaction is what a successful second factor does, so the
  // double has to answer it too. A route that verified a code and then hit an
  // unstubbed findOneAndUpdate would buffer for Mongoose's 10s timeout and
  // answer 503, which reads as "the database is down" rather than "this
  // double is stale".
  MfaTransaction.findOneAndUpdate = () => {
    const query = nullQuery();
    query.lean = async () => (transaction ? { ...transaction, consumedAt: new Date() } : null);
    return query;
  };

  return function restore() {
    Passkey.countDocuments = originals.passkeyCount;
    BackupCode.countDocuments = originals.backupCount;
    MfaTransaction.updateMany = originals.transactionUpdateMany;
    MfaTransaction.create = originals.transactionCreate;
    MfaTransaction.findOne = originals.transactionFindOne;
    MfaTransaction.findOneAndUpdate = originals.transactionFindOneAndUpdate;
  };
}

module.exports = { stubMfaModels, nullQuery };
