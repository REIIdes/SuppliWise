/**
 * A backup that has never been restored is a hypothesis.
 *
 * This project already has one piece of evidence about what happens when that
 * sentence is ignored: the web3 ledger truncation, where the tip of the chain
 * sat at block 0 and the anchored history was simply gone — recoverable by no
 * repair path, because the data itself was not there. Anything that cannot be
 * read back is not a backup, and "we have Atlas snapshots" is only true on the
 * instance tiers that offer them.
 *
 * So this module does the whole loop, and `scripts/backup-drill.js` runs it
 * against a scratch database on a schedule so the claim stays tested rather than
 * remembered:
 *
 *   EXPORT   every collection of the connected database, one EJSON file each.
 *            EJSON (not JSON, not CSV) because a Mongo document is not a JSON
 *            document: an ObjectId, a Date at millisecond precision, an Int64
 *            and a binary buffer all survive the round trip here and none of
 *            them survive a naive `JSON.stringify`.
 *   VERIFY   the manifest records a count and a sha256 per file. A restore that
 *            does not reproduce both is an error, not a warning — a truncated
 *            or edited dump must fail loudly.
 *   IMPORT   drop-then-insert into a target database, in batches.
 *   UPLOADS  the files on disk (`server/uploads`) are part of the data: a member
 *            whose profile picture vanished is looking at a broken app. Copied
 *            with sizes and counts into the manifest.
 *
 * Deliberately NOT here: any credentials. The URI comes from the environment the
 * caller already has, and never lands in a manifest — a backup folder that
 * doubles as a secrets folder is how a leak of `dump/` becomes a leak of the
 * cluster.
 *
 * ONE MEASURED LIMITATION, stated rather than discovered later by someone
 * restoring a database: an integral BSON double and an int32 are
 * indistinguishable once the driver has read them (both arrive as the JS Number
 * 5), so a dump taken this way cannot tell them apart and a restore writes the
 * int32. Values are identical and mongoose casts them back on read, so no query
 * in this app changes behaviour — but `mongodump`'s binary format is what to
 * reach for if the byte-level type ever has to survive. Everything else the
 * dump can lose (ObjectId, millisecond Date, Int64 precision, Decimal128,
 * Binary) is preserved and the drill compares it field by field.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const mongoose = require('mongoose');

const BATCH = 500;
const MANIFEST = 'manifest.json';
const SKIP_COLLECTIONS = /^system\./;

// Reached through mongoose rather than `require('bson')` directly: bson is the
// driver's dependency, not this project's, and a tool that imports a transitive
// package breaks the day the driver swaps it. mongoose.mongo.BSON is the same
// implementation the driver used to write these documents in the first place,
// which is exactly the fidelity a backup needs.
//
// CANONICAL, both directions, and this is not a style choice. Measured on this
// runtime: `EJSON.stringify(doc)` in its default relaxed mode writes a Long as a
// bare JS number, so 9007199254740993 becomes 9007199254740992 — the backup and
// the restore agree with each other and both disagree with the database. `parse`
// is the same trap in reverse: relaxed parsing turns `{"$numberLong":"…"}` back
// into a Number. A dump that loses the low bit of an id, a token or a satoshi
// count restores a database that looks complete and is wrong, which is worse
// than a backup that fails loudly. `relaxed: false` on write AND on read is what
// keeps ObjectId, millisecond Date, Int64, Double, Decimal128 and Binary intact.
const EJSON_OPTIONS = { relaxed: false };
const ejson = () => mongoose.mongo.BSON.EJSON;

// Exported so a caller that reads a dump itself (the drill, a test) cannot drift
// from the fidelity the writer promised. Two implementations of "read a backup"
// is how one of them quietly starts parsing in relaxed mode.
const dumpLine = (doc) => `${ejson().stringify(doc, EJSON_OPTIONS)}\n`;
const readLine = (line) => ejson().parse(line, EJSON_OPTIONS);

/**
 * A value as the dump stores it — the only equality that means anything when
 * one side came from the driver and the other from the dump.
 *
 * The driver hands back int32 and an integral double as a plain JS Number, while
 * canonical EJSON parses them to `Int32`/`Double` wrappers, so a raw object
 * comparison fails on documents that are identical in the database. Comparing
 * the canonical form instead keeps every distinction a backup must not lose (a
 * Date against a string, an ObjectId against hex, an Int64 against a Number) and
 * ignores the wrapper-vs-primitive difference the driver itself creates.
 */
const canonical = (value) => ejson().stringify(value, EJSON_OPTIONS);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('data', (chunk) => hash.update(chunk));
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** The database behind a URI: its explicit path name, or the driver's default. */
function databaseNameOf(uri) {
  const match = /mongodb(\+srv)?:\/\/[^/]*\/([^?]*)/.exec(String(uri || ''));
  const name = match && match[2] ? match[2] : '';
  return name || 'test';
}

/**
 * The same connection string, with a different database in it.
 *
 * Rebuilding the path segment rather than string-appending matters: Atlas SRV
 * URIs put `?appName=` and TLS options exactly where a naive `+/name` would land
 * them, and a URI the driver cannot parse is a restore that silently tests
 * nothing.
 */
function withDatabase(uri, name) {
  const scheme = uri.slice(0, uri.indexOf('://') + 3);
  const tail = uri.slice(uri.indexOf('://') + 3);
  const slash = tail.indexOf('/');
  const authority = slash === -1 ? tail : tail.slice(0, slash);
  const after = slash === -1 ? '' : tail.slice(slash + 1);
  const queryIndex = after.indexOf('?');
  const query = queryIndex === -1 ? '' : after.slice(queryIndex);
  return `${scheme}${authority}/${name}${query}`;
}

// Marker every throwaway target this tooling writes must carry. A restore is the
// one operation in this file that can destroy a database, so the name is
// checked rather than trusted, and the check lives here so both the drill and
// the CLI restore go through it.
const SCRATCH_MARKER = 'sw_drill_';

function assertScratch(targetUri, sourceName) {
  const name = databaseNameOf(targetUri);
  if (!name.startsWith(SCRATCH_MARKER)) {
    throw new Error(`refusing to write into "${name}" — a throwaway target must start with ${SCRATCH_MARKER}`);
  }
  if (name === sourceName) throw new Error(`refusing to restore over the source database "${sourceName}"`);
  return name;
}

/**
 * Copy the uploads tree into the backup, returning what it held.
 *
 * Follows nothing but the directory the server writes into. A symlink is refused
 * rather than followed: an uploads folder is the one place in this app where an
 * attacker-supplied filename lands on disk, and a backup tool that happily walks
 * a link someone created there turns a data export into an export of /etc.
 */
function copyDir(src, dest) {
  let files = 0;
  let bytes = 0;
  if (!fs.existsSync(src)) return { files, bytes, missing: true };
  const stack = [{ from: src, to: dest }];
  while (stack.length) {
    const { from, to } = stack.pop();
    ensureDir(to);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const full = path.join(from, entry.name);
      const out = path.join(to, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        stack.push({ from: full, to: out });
        continue;
      }
      if (!entry.isFile()) continue;
      fs.copyFileSync(full, out);
      files += 1;
      bytes += fs.statSync(out).size;
    }
  }
  return { files, bytes };
}

/**
 * Export the connected database into `outDir`.
 *
 * Streaming one document at a time rather than `find().toArray()`: the point of
 * a backup is to run when the database is at its largest, which is exactly when
 * loading a collection into memory is the worst idea in the room.
 */
async function exportDatabase({ uri, outDir, uploadsDir, collections = null }) {
  const dataDir = ensureDir(path.join(outDir, 'data'));
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  const stats = [];
  try {
    const db = conn.db;
    const name = db.databaseName;
    const existing = (await db.listCollections().toArray()).map(c => c.name)
      .filter(n => !SKIP_COLLECTIONS.test(n))
      .filter(n => (collections ? collections.includes(n) : true));

    for (const coll of existing) {
      const file = path.join(dataDir, `${coll}.ejson`);
      const out = fs.createWriteStream(file);
      let count = 0;
      for await (const doc of db.collection(coll).find({}, { noCursorTimeout: false })) {
        out.write(dumpLine(doc));
        count += 1;
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      stats.push({ collection: coll, file: `data/${path.basename(file)}`, count, checksum: await sha256(file), bytes: fs.statSync(file).size });
    }

    const uploads = uploadsDir
      ? { ...copyDir(uploadsDir, path.join(outDir, 'uploads')), root: 'uploads' }
      : { files: 0, bytes: 0, skipped: true };

    const manifest = {
      kind: 'suppliwise-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      database: name,
      collections: stats,
      documentTotal: stats.reduce((n, s) => n + s.count, 0),
      uploads,
    };
    fs.writeFileSync(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2));
    return manifest;
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Restore a dump into `targetUri`.
 *
 * `targetUri` defaults to the SAME database name the dump came from; passing a
 * different one is what a drill does, and it is why the target is always echoed
 * into the result — a restore that reported success against a database nobody
 * named is how an operator ends up believing production was rebuilt when a
 * scratch copy was.
 *
 * `dropFirst` is true by default: a restore into a collection that still holds
 * live rows would interleave two eras of data and produce a database that looks
 * healthy and is neither.
 */
async function importDatabase({ uri, fromDir, dropFirst = true, collections = null }) {
  const manifest = readManifest(fromDir);
  const dataDir = path.join(fromDir, 'data');
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  const result = { database: conn.db.databaseName, sourceDatabase: manifest.database, restored: [], mismatches: [] };
  try {
    for (const entry of manifest.collections) {
      if (collections && !collections.includes(entry.collection)) continue;
      const file = path.join(dataDir, path.basename(entry.file));
      if (!fs.existsSync(file)) throw new Error(`backup is missing ${entry.file}`);
      const checksum = await sha256(file);
      if (checksum !== entry.checksum) {
        throw new Error(`${entry.collection}: checksum does not match the manifest — the dump was truncated or edited (expected ${entry.checksum}, got ${checksum})`);
      }
      const docs = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(readLine);
      const coll = conn.db.collection(entry.collection);
      if (dropFirst) await coll.deleteMany({});
      for (let i = 0; i < docs.length; i += BATCH) {
        await coll.insertMany(docs.slice(i, i + BATCH), { ordered: true });
      }
      const count = await coll.countDocuments({});
      if (count !== entry.count) {
        result.mismatches.push(`${entry.collection}: restored ${count} of ${entry.count}`);
      }
      result.restored.push({ collection: entry.collection, count });
    }
    if (result.mismatches.length > 0) {
      throw new Error(`restore did not reproduce the dump — ${result.mismatches.join('; ')}`);
    }
    return result;
  } finally {
    await conn.close().catch(() => {});
  }
}

function readManifest(fromDir) {
  const file = path.join(fromDir, MANIFEST);
  if (!fs.existsSync(file)) throw new Error(`${file} is not a backup (no ${MANIFEST})`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.kind !== 'suppliwise-backup') throw new Error(`${file} is not a SuppliWise backup (kind: ${manifest.kind})`);
  if (!Array.isArray(manifest.collections)) throw new Error(`${file} has no collection list`);
  return manifest;
}

/**
 * Does this dump match the database it claims to be from?
 *
 * Counts only, and only on the CURRENT database — no writes, no reads of
 * document bodies. This is what a monitor can ask every few minutes without
 * touching anyone's data.
 */
async function verifyAgainstLive({ uri, fromDir }) {
  const manifest = readManifest(fromDir);
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000 }).asPromise();
  const report = { database: conn.db.databaseName, stale: [], missing: [], ok: [] };
  try {
    const existing = new Set((await conn.db.listCollections().toArray()).map(c => c.name));
    for (const entry of manifest.collections) {
      if (!existing.has(entry.collection)) report.missing.push(entry.collection);
      else {
        const count = await conn.db.collection(entry.collection).countDocuments({});
        if (count > entry.count) report.stale.push(`${entry.collection} (+${count - entry.count} since the dump)`);
        else report.ok.push(entry.collection);
      }
    }
    return report;
  } finally {
    await conn.close().catch(() => {});
  }
}

/**
 * Where dumps live, and where the drill leaves its receipt.
 *
 * One folder rather than two defaults, because the Security Center has to read
 * exactly what `npm run backup` writes — a probe pointed at a different path
 * would report "no backups" forever and look like a working control.
 */
function backupRoot() {
  return path.resolve(process.env.SUPPLIWISE_BACKUP_DIR || path.join(__dirname, '..', '..', 'backups'));
}

// The drill runs in a temporary folder it deletes afterwards, so the only thing
// that survives a drill is this receipt. That matters: "we can restore this" is
// a claim about the last time the restore actually ran, and a monitor that
// cannot see it is reporting a hypothesis as a control.
const DRILL_RECEIPT = 'drill.json';

function writeDrillReceipt(rootDir, result) {
  ensureDir(rootDir);
  const file = path.join(rootDir, DRILL_RECEIPT);
  fs.writeFileSync(file, JSON.stringify({ ...result, at: new Date().toISOString() }, null, 2));
  return file;
}

function readDrillReceipt(rootDir) {
  const file = path.join(rootDir, DRILL_RECEIPT);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** A one-line summary of the newest dump in a folder, for the Security Center. */
function newestBackup(rootDir) {
  if (!fs.existsSync(rootDir)) return null;
  const dirs = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(rootDir, d.name))
    .filter(d => fs.existsSync(path.join(d, MANIFEST)))
    .map(d => {
      try {
        return { dir: d, manifest: JSON.parse(fs.readFileSync(path.join(d, MANIFEST), 'utf8')) };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.manifest.createdAt).localeCompare(String(a.manifest.createdAt)));
  return dirs[0] || null;
}

module.exports = {
  exportDatabase,
  importDatabase,
  verifyAgainstLive,
  readManifest,
  newestBackup,
  copyDir,
  databaseNameOf,
  withDatabase,
  assertScratch,
  SCRATCH_MARKER,
  backupRoot,
  dumpLine,
  readLine,
  canonical,
  writeDrillReceipt,
  readDrillReceipt,
  MANIFEST,
  DRILL_RECEIPT,
};
