/**
 * RESTORE A BACKUP.
 *
 *   npm run restore -- --from ../backups/2026-10-19T09-00-00
 *   npm run restore -- --from ../backups/2026-10-19T09-00-00 --into sw_drill_preview --yes
 *
 * This is the only script in the repo that can destroy a database, so it is
 * built to be boring and hard to point at the wrong thing:
 *
 *   1. It refuses to write anything until `--yes` is present. No confirmation
 *      prompt: a restore is run during an incident, by someone who is not
 *      looking for a prompt, and a script that waits on stdin half-works its way
 *      into a broken state.
 *   2. The target must be either the database the dump came from (a genuine
 *      rebuild) or a name carrying the `sw_drill_` marker. A typo'd `--into prod`
 *      is the failure this guard exists for, and it is checked here rather than
 *      trusted to the person under pressure.
 *   3. It prints the target database and the document count it is about to drop
 *      BEFORE doing it, so the operator can stop on the first line.
 *   4. `importDatabase` verifies a sha256 per collection against the manifest
 *      first — a tampered or truncated dump fails before it touches the database.
 *
 * Uploads are copied back additively (files are written, never deleted): a
 * member whose profile picture vanished is looking at a broken app, and a
 * restore that removes files it did not put there is worse than one that skips
 * them.
 */
const path = require('node:path');
const fs = require('node:fs');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const {
  importDatabase,
  readManifest,
  copyDir,
  databaseNameOf,
  withDatabase,
  SCRATCH_MARKER,
} = require('../utils/backupStore');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

const has = (name) => process.argv.includes(`--${name}`);

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set — run this from a machine that has server/.env');

  const from = arg('from', '');
  if (!from) throw new Error('usage: npm run restore -- --from <backup-dir> [--into <database>] --yes');
  const fromDir = path.resolve(process.cwd(), from);
  const manifest = readManifest(fromDir);

  const targetName = arg('into', manifest.database);
  const isSource = targetName === manifest.database;
  const isScratch = targetName.startsWith(SCRATCH_MARKER);
  if (!isSource && !isScratch) {
    throw new Error(`refusing to restore into "${targetName}" — it is neither the "${manifest.database}" `
      + `database this dump came from nor a ${SCRATCH_MARKER}-marked scratch database`);
  }

  const targetUri = isSource ? uri : withDatabase(uri, targetName);
  console.log(`Restoring ${manifest.documentTotal} document(s) from "${manifest.database}" `
    + `(dumped ${manifest.createdAt}) into "${targetName}".`);
  if (isSource) console.log('This drops and rebuilds every collection in that database.');

  if (!has('yes')) {
    console.error('\nRefusing to write anything without --yes. Re-run with --yes once the target above is the one you mean.');
    process.exitCode = 1;
    return;
  }

  const result = await importDatabase({ uri: targetUri, fromDir, collections: arg('collections', '') ? arg('collections', '').split(',') : null });
  console.log(`Restored ${result.restored.length} collection(s) into "${result.database}":`);
  for (const r of result.restored) console.log(`    ${r.collection.padEnd(28)} ${String(r.count).padStart(7)} doc(s)`);

  const uploadsInDump = path.join(fromDir, 'uploads');
  if (manifest.uploads && manifest.uploads.files > 0 && fs.existsSync(uploadsInDump)) {
    const uploadsDir = process.env.SUPPLIWISE_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
    const copied = copyDir(uploadsInDump, uploadsDir);
    console.log(`Uploads: ${copied.files} file(s), ${copied.bytes} byte(s) written into ${uploadsDir}`);
  }
  console.log('\nRestore complete. Run the drill (`npm run backup:drill`) before trusting the next backup.');
})().catch((err) => {
  console.error('restore failed:', err.message);
  process.exit(1);
});
