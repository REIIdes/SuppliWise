/**
 * One-off migration: move inline base64 profile/banner images out of MongoDB
 * and onto disk, replacing each with the URL of the file written.
 *
 * WHY
 * ---
 * `users.profilePicture` / `users.bannerPicture` (and the admin equivalents)
 * used to hold a raw `data:image/...;base64,...` string. A single account was
 * measured carrying a 2,962,602-character banner, making its document ~3 MB.
 * Every sign-in read that document and then wrote it back, ~30.5 s each way
 * over the project's Atlas link, which is why the login button reported
 * "We could not reach our servers just now." Images now live on disk
 * (utils/pictures.js) and the field holds a URL.
 *
 * Safe to run repeatedly: a value that is already a stored path or an absolute
 * URL is left alone, and files are content-addressed so re-running costs one
 * small projection per document instead of re-reading any megabytes.
 *
 * Usage:  node scripts/migrate-pictures-to-disk.js [--dry-run]
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { storePicture, isDataUrl, safePictureValue } = require('../utils/pictures');

const DRY_RUN = process.argv.includes('--dry-run');

const FIELDS = [
  { key: 'profilePicture', kind: 'profile', maxBytes: 2 * 1024 * 1024 },
  { key: 'bannerPicture', kind: 'banner', maxBytes: 3 * 1024 * 1024 },
];

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

/** Migrate one document's picture fields. Returns the $set to apply, if any. */
async function migrateDoc(collection, filter, label) {
  // Only the picture fields are projected, so an un-migrated multi-megabyte
  // document is still read in one go (there is no way around that — the bytes
  // have to be read to be written) but nothing else is pulled along.
  const doc = await collection.findOne(filter, { projection: { profilePicture: 1, bannerPicture: 1 } });
  if (!doc) return null;

  const set = {};
  const notes = [];
  for (const field of FIELDS) {
    const value = doc[field.key];
    if (typeof value !== 'string' || !value.trim()) continue;
    // Already migrated (or never a data URL) — nothing to do.
    if (!isDataUrl(value)) continue;

    notes.push(`${field.key} ${kb(value.length)}`);

    if (DRY_RUN) {
      set[field.key] = '<would-write-file>';
      continue;
    }
    try {
      set[field.key] = storePicture({
        ownerId: doc._id,
        kind: field.kind,
        value,
        maxBytes: field.maxBytes,
      });
    } catch (err) {
      // Leave the original in place rather than losing the image; report it.
      console.error(`  ! ${label} ${field.key}: ${err.message} (left unchanged)`);
    }
  }

  if (Object.keys(set).length === 0) return null;

  if (!DRY_RUN) {
    await collection.updateOne({ _id: doc._id }, { $set: set });
  }
  return { id: doc._id, notes, set };
}

(async () => {
  console.log(DRY_RUN ? 'DRY RUN — nothing will be written\n' : 'Migrating inline pictures to disk...\n');
  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  console.log('Connected to MongoDB.');

  let migrated = 0;
  let examined = 0;

  for (const name of ['users', 'adminaccounts']) {
    const collection = mongoose.connection.db.collection(name);
    const count = await collection.countDocuments({});
    console.log(`\n[${name}] ${count} document(s)`);
    if (count === 0) continue;

    for (const doc of await collection.find({}, { projection: { _id: 1 } }).toArray()) {
      examined += 1;
      const result = await migrateDoc(collection, { _id: doc._id }, `${name}:${doc._id}`);
      if (result) {
        migrated += 1;
        console.log(`  ${name}:${doc._id} -> ${result.notes.join(', ')}`);
        for (const [k, v] of Object.entries(result.set)) {
          console.log(`      ${k} = ${v}`);
        }
      }
    }
  }

  // Report the resulting document sizes so the improvement is visible.
  console.log('\n--- collection stats after migration ---');
  for (const name of ['users', 'adminaccounts']) {
    const stats = await mongoose.connection.db.command({ collStats: name });
    console.log(
      `  ${name}: count=${stats.count} avgObjSize=${stats.avgObjSize} bytes`
    );
  }

  console.log(`\nExamined ${examined} document(s); ${migrated} needed migrating.`);
  if (DRY_RUN) console.log('Dry run — no changes written.');
  else console.log('Done.');

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('FATAL:', err.name, err.message);
  try { await mongoose.disconnect(); } catch { /* already closed */ }
  process.exit(1);
});
