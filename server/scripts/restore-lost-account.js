/**
 * Restore the account lost to the destructive test-suite bug.
 *
 * WHAT HAPPENED
 * -------------
 * `Test File/password-reset-db.test.js` connected to `process.env.MONGO_URI`
 * and called `dropDatabase()` in its `after` hook, so `npm test` deleted the
 * entire production database. (Its MONGO_URI carries no database name, so it
 * resolved to the driver's default database — literally named `test` — on the
 * live cluster.) The test now goes through testDbGuard and tears down only its
 * own rows.
 *
 * The admin accounts came back automatically: the server re-seeds them from
 * ADMIN_ACCOUNTS in .env on every boot. Member accounts do not, so this puts
 * the known one back.
 *
 * WHAT IS RESTORED vs WHAT IS GONE
 * --------------------------------
 *   Restored: the account's identity (its ORIGINAL _id, so the image files
 *             already on disk — whose names embed that id — stay valid), its
 *             email, a working password, and its avatar + banner.
 *   GONE:     the password HASH (a new password is set below), every profile
 *             field that was not visible here, and all of the account's
 *             assessments, intake records and dashboard history. None of that
 *             can be reconstructed.
 *
 * The old password hash is unrecoverable, so the account is given the password
 * from the sign-in screenshot. The user should change it.
 *
 * Usage: node scripts/restore-lost-account.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const { PICTURE_DIR } = require('../utils/pictures');

// ── What is known about the lost account ────────────────────────────────────
const ACCOUNT = {
  // The original ObjectId, read from the picture filenames and the login
  // response. Reusing it keeps those files reachable and preserves any
  // external references to the account.
  _id: new mongoose.Types.ObjectId('6aae6cd348edbf13c730dc8a'),
  email: 'verbojanrich20@gmail.com',
  // From the sign-in screenshot. The original hash is gone.
  password: 'Janrich@101.com',
  firstName: 'Janrich',
  lastName: 'User',
  dateOfBirth: new Date('1990-01-01'),
  gender: 'Male',
};

/** The picture files on disk that belong to this account. */
function picturesFor(id) {
  const prefix = `${id}-`;
  let names = [];
  try {
    names = fs.readdirSync(PICTURE_DIR);
  } catch {
    return { profilePicture: '', bannerPicture: '' };
  }
  const pick = (kind) => {
    const match = names.find((n) => n.startsWith(prefix) && n.includes(`-${kind}-`));
    return match ? `/pictures/${match}` : '';
  };
  return { profilePicture: pick('profile'), bannerPicture: pick('banner') };
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  const User = require('../models/User');

  const existing = await User.findById(ACCOUNT._id);
  if (existing) {
    console.log(`Account ${ACCOUNT._id} already exists — nothing to do.`);
    await mongoose.disconnect();
    return;
  }
  if (await User.findOne({ email: ACCOUNT.email })) {
    console.log(`A different account already holds ${ACCOUNT.email} — leaving it alone.`);
    await mongoose.disconnect();
    return;
  }

  const pictures = picturesFor(ACCOUNT._id);
  console.log('Pictures recovered from disk:');
  console.log('  profilePicture:', pictures.profilePicture || '(none found)');
  console.log('  bannerPicture :', pictures.bannerPicture || '(none found)');

  const created = await User.create({
    _id: ACCOUNT._id,
    email: ACCOUNT.email,
    password: ACCOUNT.password,
    firstName: ACCOUNT.firstName,
    lastName: ACCOUNT.lastName,
    dateOfBirth: ACCOUNT.dateOfBirth,
    gender: ACCOUNT.gender,
    ...pictures,
    // 2FA is deliberately left OFF. The lost document had
    // `twoFactorEnabled: true` with NO secret, which made it demand an
    // authenticator code that could never be produced — an unbreakable
    // lockout. routes/auth.js now refuses to issue such a challenge, and the
    // account is re-created without the impossible flag so the holder can set
    // 2FA up properly.
  });

  const check = await User.findById(ACCOUNT._id);
  const ok = await check.matchPassword(ACCOUNT.password);

  console.log('\nRestored:');
  console.log('  _id           :', String(created._id));
  console.log('  email         :', created.email);
  console.log('  name          :', created.fullName);
  console.log('  password works:', ok === true);
  console.log('  2FA enabled   :', created.twoFactorEnabled);
  console.log('  profilePicture:', created.profilePicture);
  console.log('  bannerPicture :', created.bannerPicture);

  const stats = await mongoose.connection.db.command({ collStats: 'users' });
  console.log('\nusers collection: count =', stats.count, '| avgObjSize =', stats.avgObjSize, 'bytes');

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('FATAL:', e.name, e.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
