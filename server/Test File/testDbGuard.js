/**
 * Test-database guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Test File/session-idle-window.test.js` used to call `dotenv.config()` with no
 * path, which resolves `.env` from the current working directory. Run from
 * `server/` — as `npm test` does — that loads the application's real `.env`, so
 * the suite connected to the LIVE MongoDB cluster and called `User.create()`.
 * Its cleanup only runs when a run finishes, so any interrupted run left real
 * user documents behind: 129 of them had piled up in the live database.
 *
 * WHY THE OBVIOUS FIX IS NOT ENOUGH
 * ---------------------------------
 * You cannot guard this by checking whether the connected database is "a test
 * database". The application's MONGO_URI carries no database name in its path:
 *
 *   mongodb+srv://…@cluster.mongodb.net/?appName=…
 *                                              ^ no database
 *
 * so it silently resolves to the driver's default database, which is literally
 * named `test` — on the production cluster. A name-based check would wave the
 * live database straight through. The guard therefore keys on a SEPARATE URI,
 * never on the name of whatever MONGO_URI points at.
 *
 * THE RULE
 * --------
 * A test may only ever connect using MONGO_TEST_URI, which must be set
 * explicitly and must not be the application's own URI. Point it at a
 * throwaway database:
 *
 *   MONGO_TEST_URI=mongodb://localhost:27017/suppliwise_test
 *
 * With nothing configured the suite SKIPS (rather than fails), keeping `npm
 * test` green on a machine with no test database while making it impossible to
 * reach real data by accident.
 *
 * TWO ENTRY POINTS, ON PURPOSE
 * ---------------------------
 *   testDbPreflight() — SYNCHRONOUS, no connection. Decides the skip reason.
 *                       node:test reads a test's `skip` option when the test is
 *                       REGISTERED, so a decision made in a `before` hook is
 *                       already too late: the test still runs and then fails
 *                       against a database that was never connected. Callers
 *                       must evaluate this at module load, before any test().
 *   connectTestDb()   — ASYNCHRONOUS. Connects, after the same validation.
 */
const path = require('path');

/** Load the app's .env so we can compare against MONGO_URI. Never used to connect. */
function loadAppEnv() {
  // eslint-disable-next-line global-require
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

/** The database name embedded in a URI, or null when it carries none. */
function databaseNameOf(uri) {
  const match = /mongodb(\+srv)?:\/\/[^/]+\/([^?]*)/.exec(String(uri || ''));
  if (!match) return null;
  return match[2] || null;
}

/**
 * Validate MONGO_TEST_URI without touching the network.
 * @returns {{ok: true, uri: string, name: string|null} | {ok: false, reason: string}}
 */
function validateTestUri() {
  loadAppEnv();
  const testUri = process.env.MONGO_TEST_URI;
  if (!testUri) {
    return {
      ok: false,
      reason: 'MONGO_TEST_URI is not set — refusing to touch the application database. '
        + 'Set MONGO_TEST_URI to a throwaway database (e.g. mongodb://localhost:27017/suppliwise_test) to run this suite.',
    };
  }
  if (testUri === process.env.MONGO_URI) {
    // The exact mistake that caused 129 stray accounts: pointing a test at the
    // application's own URI. Refuse loudly rather than quietly writing.
    return {
      ok: false,
      reason: 'MONGO_TEST_URI is identical to MONGO_URI. That is the application database — '
        + 'tests must never write to it. Give the test suite its own database.',
    };
  }
  // Defence in depth: the database name should still look like a test database.
  // (This cannot be the primary check — see the header — but it catches a
  // hand-typed MONGO_TEST_URI copy-pasted from a production URI.)
  const name = databaseNameOf(testUri);
  if (name && !/test/i.test(name)) {
    return {
      ok: false,
      reason: `MONGO_TEST_URI points at database "${name}", which is not named like a test database. `
        + 'Refusing to run destructive tests against it.',
    };
  }
  return { ok: true, uri: testUri, name: name || null };
}

/**
 * Synchronous skip decision. Evaluate this at module load, BEFORE declaring any
 * test, and pass the result as that test's `skip` option.
 * @returns {{skip: false} | {skip: string}}
 */
function testDbPreflight() {
  const verdict = validateTestUri();
  return verdict.ok ? { skip: false } : { skip: verdict.reason };
}

/**
 * Connect to the dedicated test database.
 * @returns {Promise<{connected: true, uri: string, name: string} | {connected: false, reason: string}>}
 */
async function connectTestDb() {
  const verdict = validateTestUri();
  if (!verdict.ok) return { connected: false, reason: verdict.reason };

  const mongoose = require('mongoose');
  await mongoose.connect(verdict.uri, { serverSelectionTimeoutMS: 8000 });
  return { connected: true, uri: verdict.uri, name: verdict.name || mongoose.connection.name };
}

/** One-line message for a skipped suite, so the reason is never a mystery. */
function skipMessage(result) {
  return `SKIPPED: ${result.reason}`;
}

module.exports = {
  // Exported so a caller can make the SAME decision without connecting —
  // e2eServer.js needs the validated URI to hand the child process, and it must
  // refuse on exactly the same terms connectTestDb would.
  validateTestUri,
  testDbPreflight,
  connectTestDb,
  skipMessage,
  databaseNameOf,
};
