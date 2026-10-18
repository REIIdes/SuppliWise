/**
 * Back up the database and the uploads folder.
 *
 *   npm run backup                  → backups/2026-10-19T02-30-00Z/
 *   npm run backup -- --out D:\sw-bak
 *
 * Written by a person on purpose. An unattended cron job that fills a disk is
 * how a backup scheme gets switched off; this one says what it took, how many
 * documents that is, and where it went, so the next restore has something real
 * to point at. `scripts/backup-drill.js` is what proves it can be read back.
 */
const path = require('node:path');
const fs = require('node:fs');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { exportDatabase, backupRoot } = require('../utils/backupStore');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set — run this from a machine that has server/.env');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Default goes under the folder the Security Center reads (SUPPLIWISE_BACKUP_DIR),
  // so a backup taken here is a backup the monitor can see. Two defaults that
  // disagree is how a dashboard reports "no backups" next to a full disk.
  const outDir = path.resolve(arg('out', path.join(backupRoot(), stamp)));
  // The same override the server uses, so the backup copies the files the server
  // actually writes rather than a folder it stopped using.
  const uploadsDir = process.env.SUPPLIWISE_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');

  fs.mkdirSync(outDir, { recursive: true });
  const manifest = await exportDatabase({ uri, outDir, uploadsDir });

  const lines = manifest.collections.map(c => `    ${c.collection.padEnd(28)} ${String(c.count).padStart(7)} doc(s)`);
  console.log(`Backup of database "${manifest.database}" → ${outDir}`);
  if (lines.length) console.log(lines.join('\n'));
  else console.log('    (no collections — an empty database is not a backup of anything)');
  console.log(`  ${manifest.documentTotal} document(s), ${manifest.uploads.files} upload file(s) (${manifest.uploads.bytes} bytes)`);
  if (manifest.uploads.missing) console.log(`  uploads folder ${uploadsDir} does not exist — nothing copied`);
  if (manifest.collections.length === 0) process.exitCode = 1;
})().catch((err) => {
  console.error('backup failed:', err.message);
  process.exit(1);
});
