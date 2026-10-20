'use strict';
/**
 * Repair the administrator authenticator seeds that are not valid base32, and
 * email each owner the replacement key.
 *
 * WHY THIS EXISTS
 * ---------------
 * `ADMIN_ACCOUNTS` in .env is `alias|passwordHash|totpSecret` entries joined by
 * commas, and an argon2id hash contains its own commas (`m=19456,t=2,p=1`). An
 * older copy of this config was split on every comma and rejoined, which glued a
 * hash's parameter block onto the neighbouring seed:
 *
 *     LMQVI5D5GUXGMSSQKJRDSTTCPJJFA3C3,t=2,p=1$sEv0l9enNLLqSB77DFjMfQ$i7pYWE…
 *
 * speakeasy does not reject that — it decodes the whole string, and the key it
 * lands on is NOT the key of the clean 32-character seed in front of it. A code
 * from the prefix fails against the stored value and vice versa, so the account
 * reads as "2FA configured" and cannot be signed into. That is the state five of
 * the six aliases are in, none of which has a `lastLoginAt`.
 *
 * Truncating back to the prefix was considered and rejected: it would restore a
 * seed nobody can prove was ever handed out (provisioning read the already
 * corrupted value), whereas a freshly generated key is the same value the server
 * checks and the value the owner types into their app.
 *
 * WHY BOTH STORES MUST MOVE
 * -------------------------
 * .env is not a cache, it is the boot seeder's fallback: index.js inserts any
 * account whose document is MISSING. Repairing only the database would leave the
 * corrupted value in .env to resurrect itself the next time a document goes away.
 * The same rule is why `persistAdminTotpSecretToEnv` exists, and why the rotate
 * route calls it.
 *
 * WHAT IS NOT TOUCHED
 * -------------------
 * Passwords. Their hashes are the thing the comma bug cut, and they parse
 * correctly today — a seed repair must not rewrite a working credential. The
 * legacy trio (`ADMIN_ALIAS` = AdminDevs) holds a valid 32-character seed and is
 * left alone, so whoever holds that authenticator keeps working.
 *
 *   node scripts/repair-admin-totp-seeds.js --dry-run   # report only, writes nothing
 *   node scripts/repair-admin-totp-seeds.js             # rotate + mail the new keys
 */

const path = require('path');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  const mongoose = require('mongoose');
  const totpRfc = require('../utils/totpRfc');
  const adminTotp = require('../utils/adminTotp');
  const { isUsableBase32 } = require('../utils/adminCredentialDelivery');

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
  const AdminAccount = require('../models/AdminAccount');

  const rows = await AdminAccount.find().sort({ createdAt: 1 })
    .select(`alias enabled ${adminTotp.SECRET_FIELDS}`).lean();
  // readSeed, not the raw column: on this branch a rotated key is sealed in
  // `totpSecretEnc`, so a healthy account reads as base32 here even though its
  // legacy plaintext column is empty. Judging that column instead would call
  // every repaired account broken and rotate a working key for no reason.
  const broken = rows.filter((row) => !isUsableBase32(adminTotp.readSeed(row)));
  const healthy = rows.filter((row) => isUsableBase32(adminTotp.readSeed(row)));

  console.log(`${rows.length} administrator account(s): ${healthy.length} usable seed(s), ${broken.length} broken.`);
  for (const row of broken) {
    console.log(`  BROKEN  ${row.alias} — stored value is ${String(adminTotp.readSeed(row) || '').length} characters and is not base32`);
  }
  for (const row of healthy) {
    console.log(`  ok      ${row.alias}`);
  }

  if (broken.length === 0) {
    console.log('\nNothing to repair.');
    await mongoose.disconnect();
    process.exit(0);
  }
  if (DRY_RUN) {
    console.log('\n--dry-run: no seed was changed and no mail was sent.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const { persistAdminTotpSecretToEnv } = require('../utils/adminAccounts');
  const rotated = [];
  for (const row of broken) {
    const secret = totpRfc.generateSecret({ name: `SuppliWise Admin (${row.alias})`, issuer: 'SuppliWise' });
    // writeSeed seals the new key and clears the legacy column, matching what
    // Admins → rotate authenticator does. A bare `$set: { totpSecret }` here would
    // land next to an existing envelope, and readSeed prefers the envelope — the
    // repair would appear to do nothing.
    const account = await AdminAccount.findById(row._id).select(adminTotp.SECRET_FIELDS);
    adminTotp.writeSeed(account, secret.base32);
    await account.save();
    const persisted = persistAdminTotpSecretToEnv(row.alias, secret.base32);
    if (!persisted.written) {
      // Loud, not fatal: the document is repaired and the owner can sign in. It
      // is the resurrect-on-recreate path that is still open, and the operator
      // has to know that.
      console.warn(`  WARN ${row.alias}: .env not updated (${persisted.reason}).`);
    }
    rotated.push({ alias: row.alias, totpSecret: secret.base32 });
    console.log(`  rotated ${row.alias}`);
  }

  // Repairing a seed without telling its owner is a lock-out with extra steps.
  const { buildCredentialRecipients, deliverAdminCredentials } = require('../utils/adminCredentialDelivery');
  const { configuredAdminEmails } = require('../utils/adminAccounts');
  const { recipients, missingEmail, unusableKey } = buildCredentialRecipients(
    rotated.map((entry) => ({ alias: entry.alias, totpSecret: entry.totpSecret })),
    configuredAdminEmails()
  );

  if (recipients.length === 0) {
    console.warn('\nNo rotated key could be mailed (no configured address). Add them to ADMIN_EMAILS and run the');
    console.warn('Admins → Email credentials button, or hand the keys over another way.');
  } else {
    const report = await deliverAdminCredentials({ recipients });
    console.log(`\nMailed new keys to ${report.delivered.length} of ${report.total}: `
      + report.delivered.map((entry) => entry.alias).join(', '));
    for (const failure of report.failed) console.log(`  FAILED  ${failure.alias} — ${failure.reason}`);
  }
  if (missingEmail.length) console.log('  no address in .env for: ' + missingEmail.join(', '));
  if (unusableKey.length) console.log('  still unusable: ' + unusableKey.join(', '));

  console.log('\nEach recipient must add the emailed key to Google Authenticator (Enter setup key, time-based, SHA1)');
  console.log('before their next sign-in. Passwords were not sent — they are one-way hashes.');
  console.log(`Not mailed: ${healthy.map((row) => row.alias).join(', ')} (already usable; press`);
  console.log('Admins → Email credentials in the console whenever you want those delivered).');

  await mongoose.disconnect();
  process.exit(0);
})().catch((error) => {
  console.error('repair-admin-totp-seeds failed:', error.message);
  process.exit(1);
});
