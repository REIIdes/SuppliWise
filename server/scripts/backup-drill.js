/**
 * PROVE THE BACKUP WORKS.
 *
 *   npm run backup:drill
 *
 * A backup folder is not evidence. Evidence is a restore that ran, into a
 * database nobody uses, whose contents were then compared against the original —
 * which is the only way to learn that a collection was skipped, that a date came
 * back as a string, or that the dump was truncated, none of which a folder
 * listing can show you.
 *
 * Safety, in the order the checks run:
 *   1. The scratch database is derived from the connected URI by REPLACING the
 *      database name. If the URI names none, the driver's default is `test`, so
 *      the scratch name is still explicitly set — a drill that restored into
 *      whatever the default turns out to be is a drill that restores into
 *      production.
 *   2. The scratch name must differ from the source, must be non-empty, and must
 *      carry this script's marker. Anything else and it refuses.
 *   3. It drops the scratch database when it finishes, including on failure.
 *
 * It writes nothing to the source database, and it never reads document bodies
 * from the live database — comparison happens inside the scratch copy against
 * what the dump produced.
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

process.chdir(path.join(__dirname, '..'));
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const {
  exportDatabase,
  importDatabase,
  databaseNameOf,
  withDatabase,
  assertScratch,
  SCRATCH_MARKER,
  backupRoot,
  writeDrillReceipt,
  DRILL_RECEIPT,
  readLine,
  canonical,
} = require('../utils/backupStore');

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error('MONGO_URI is not set — run this from a machine that has server/.env');
  const source = databaseNameOf(uri);
  const scratchName = `${SCRATCH_MARKER}${Date.now().toString(36)}`;
  const scratchUri = withDatabase(uri, scratchName);
  const scratch = assertScratch(scratchUri, source);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-drill-'));
  const uploads = process.env.SUPPLIWISE_UPLOADS_DIR || path.join(__dirname, '..', 'uploads');
  const root = backupRoot();
  let failed = null;
  let manifest = null;
  const conn = await mongoose.createConnection(scratchUri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  try {
    console.log(`1/4  exporting "${source}" (and ${uploads}) → ${workDir}`);
    manifest = await exportDatabase({ uri, outDir: workDir, uploadsDir: uploads });
    if (manifest.collections.length === 0) throw new Error('the export produced no collections — nothing to verify');

    console.log(`2/4  restoring into scratch database "${scratch}"`);
    const restored = await importDatabase({ uri: scratchUri, fromDir: workDir });
    if (restored.database !== scratch) throw new Error(`restored into "${restored.database}", not the scratch database — aborting before it is read`);

    console.log('3/4  comparing every collection document for document');
    const problems = [];
    const lines = [];
    for (const entry of manifest.collections) {
      const expected = fs.readFileSync(path.join(workDir, 'data', `${entry.collection}.ejson`), 'utf8')
        .split('\n').filter(Boolean)
        .map(readLine);
      const actual = await conn.db.collection(entry.collection).find({}).toArray();
      if (actual.length !== entry.count) {
        problems.push(`${entry.collection}: ${actual.length} document(s) restored, dump held ${entry.count}`);
        continue;
      }
      // Matched on `_id`, so a different insertion sequence cannot look like a
      // difference. Compared field-by-field in canonical form — the only
      // equality that survives one side coming from the driver and the other
      // from the dump (see `canonical` in utils/backupStore.js). This is what
      // catches the quiet corruption: a Date that came back as a string, an
      // ObjectId as hex, an Int64 that lost its low bit. No values are printed:
      // a drill runs against a database of real members and its console output
      // must not become a data dump.
      const key = (d) => String(d._id);
      const byId = new Map(actual.map(d => [key(d), d]));
      let bad = 0;
      for (const doc of expected) {
        const found = byId.get(key(doc));
        if (!found) { problems.push(`${entry.collection}: document ${key(doc)} is missing`); bad += 1; break; }
        const fields = new Set([...Object.keys(doc), ...Object.keys(found)]);
        const differs = [...fields].filter(f => canonical(doc[f]) !== canonical(found[f]));
        if (differs.length > 0) {
          problems.push(`${entry.collection}: document ${key(doc)} differs in field(s) ${differs.join(', ')}`);
          bad += 1;
          break;
        }
      }
      if (bad === 0) lines.push(`    ${entry.collection.padEnd(28)} ${String(entry.count).padStart(7)} doc(s) identical`);
    }
    if (lines.length) console.log(lines.join('\n'));
    if (problems.length) throw new Error(problems.join('; '));

    console.log(`4/4  uploads: ${manifest.uploads.files} file(s), ${manifest.uploads.bytes} byte(s) copied`);
    writeDrillReceipt(root, {
      passed: true,
      database: source,
      documentTotal: manifest.documentTotal,
      collections: manifest.collections.length,
      uploads: manifest.uploads.files,
      scratch,
    });
    console.log(`\nDRILL PASSED — ${manifest.documentTotal} document(s) from "${source}" restored and compared in "${scratch}".`);
    console.log(`The dump was temporary (${workDir}); a real backup is \`npm run backup\`.`);
    console.log(`Receipt: ${path.join(root, DRILL_RECEIPT)}`);
  } catch (err) {
    failed = err;
  } finally {
    await conn.db.dropDatabase().catch(() => {});
    await conn.close().catch(() => {});
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  if (failed) {
    try {
      writeDrillReceipt(root, { passed: false, database: source, error: failed.message, scratch });
    } catch { /* a receipt that cannot be written must not hide the failure above */ }
    console.error(`\nDRILL FAILED: ${failed.message}`);
    console.error('The scratch database and the temporary dump were removed; the source database was never written to.');
    process.exit(1);
  }
})().catch((err) => {
  console.error('backup drill failed:', err.message);
  process.exit(1);
});
