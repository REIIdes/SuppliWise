/**
 * A usable admin account for the end-to-end suites.
 *
 * WHY THIS EXISTS
 * ---------------
 * The e2e scripts all need to act as an administrator, and they used to find one
 * with `AdminAccount.findOne({ enabled: true })` — borrowing the account the
 * server seeds at boot. That worked when the suites ran against the application
 * database, because admin-sync guarantees six accounts are present.
 *
 * It stopped working the moment the suites were moved to a THROWAWAY database
 * (Test File/testDbGuard.js). That database has no seeded admins, the lookup
 * returned null, and all three suites died on `admin._id` before running a single
 * check — a green-looking "skipped" that was really a broken suite.
 *
 * So the account is created HERE, in whatever database the suite is connected to.
 * It is self-contained by construction: the suite brings its own admin instead of
 * assuming the environment was arranged for it.
 */
const AdminAccount = require('../models/AdminAccount');

/** Dummy secrets — nothing ever verifies against them in these suites. */
const TEST_ADMIN = {
  alias: 'e2e-admin',
  passwordHash: 'not-a-real-hash-the-e2e-suites-never-verify-it',
  totpSecret: 'NOTAREALBASE32SECRET000000000000000',
};

/**
 * Return an enabled admin account, creating it if the database has none.
 *
 * `passwordHash` and `totpSecret` are `select: false` on the schema, so they
 * cannot be read back afterwards — hence `+passwordHash` when the caller needs
 * to prove one exists.
 *
 * @returns {Promise<{_id: unknown, alias: string}|null>} null only if the write fails
 */
async function ensureE2eAdmin() {
  // Reuse an existing one when present, so repeat runs do not accumulate aliases.
  const existing = await AdminAccount.findOneAndUpdate(
    { enabled: true },
    { $set: { lastActivityAt: new Date() } },
    { new: true },
  ).lean();
  if (existing) return existing;

  // `upsert` on a unique `alias` is safe to race: two suites starting together
  // cannot both insert, because the second collides on the unique index.
  return AdminAccount.findOneAndUpdate(
    { alias: TEST_ADMIN.alias },
    {
      $setOnInsert: {
        alias: TEST_ADMIN.alias,
        passwordHash: TEST_ADMIN.passwordHash,
        totpSecret: TEST_ADMIN.totpSecret,
        enabled: true,
        lastActivityAt: new Date(),
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  )
    // The upserted document omits `select: false` fields, so add them back for
    // any caller that wants to assert on them.
    .then((doc) => AdminAccount.findById(doc._id).select('+passwordHash +totpSecret'))
    .then((doc) => (doc ? doc.toObject() : null))
    .catch((error) => {
      console.error('[e2e] could not provision an admin account:', error.message);
      return null;
    });
}

module.exports = { ensureE2eAdmin, TEST_ADMIN };
