/**
 * A BACKUP IS ONLY AS GOOD AS ITS RESTORE.
 *
 * The evidence this project already has is the web3 ledger truncation: the chain
 * tip sat at block 0 and the anchored history was simply gone, with no repair
 * path, because the data itself was not there. Nothing in the app can catch that
 * after the fact — only a restore that has actually run can.
 *
 * So `utils/backupStore.js` dumps every collection to canonical EJSON with a
 * sha256 per file, and `scripts/backup-drill.js` restores that dump into a
 * scratch database and compares it field by field. What is pinned here is the
 * part a folder listing cannot show you:
 *
 *   1. FIDELITY     — an ObjectId, a millisecond Date, an Int64 past 2^53, a
 *                     Decimal128 and a Binary must survive the round trip.
 *                     Relaxed EJSON (the library's DEFAULT in both directions)
 *                     silently turns 9007199254740993 into 9007199254740992;
 *                     the dump format exists only to prevent that, so the
 *                     writers and readers are checked to be the same function.
 *   2. TAMPERING    — a truncated or edited dump must fail before it writes,
 *                     not afterwards.
 *   3. THE SCRATCH  — the one operation that can destroy a database refuses any
 *                     target that is neither the dump's own database nor a
 *                     marker-carrying throwaway, and the CLI refuses to write
 *                     anything at all without --yes.
 *   4. NO SECRETS   — a dump folder that also contains the connection string is
 *                     a second leak waiting to happen.
 *   5. THE PROBE    — the Security Center row reports the truth about all of the
 *                     above and fails closed when it cannot see a dump.
 *
 * Everything here runs against MONGO_TEST_URI and a throwaway database derived
 * from it; the application's own MONGO_URI is never read.
 *
 * Run: node --test "Test File/backup-restore.test.js"
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const mongoose = require('mongoose');

const { validateTestUri } = require('./testDbGuard');
const B = mongoose.mongo.BSON;

const {
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
  writeDrillReceipt,
  readDrillReceipt,
  DRILL_RECEIPT,
  dumpLine,
  readLine,
  canonical,
} = require('../utils/backupStore');

const HERE = __dirname;
const SERVER = path.join(HERE, '..');
const preflight = (function () {
  const v = validateTestUri();
  return v.ok ? { skip: false, uri: v.uri } : { skip: v.reason, uri: null };
}());

/** Both test databases carry `test` in the name, on the same terms testDbGuard sets. */
const SRC = 'sw_backup_src_test';
const scratchName = () => `${SCRATCH_MARKER}test${Date.now().toString(36)}`;

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `sw-${label}-`));

/** The awkward document: every type a naive JSON dump would quietly ruin. */
const awkwardDoc = (id) => ({
  _id: new mongoose.Types.ObjectId(id),
  name: 'Ω Unicode ✓ 漢字 — "quote" and \\ backslash',
  at: new Date('2026-10-19T02:30:00.123Z'),
  big: new B.Long('9007199254740993'),
  small: new B.Int32(-7),
  dec: B.Decimal128.fromString('3.14159265358979323846'),
  bin: new B.Binary(Buffer.from([0, 1, 253, 254, 255, 0])),
  dbl: 0.1,
  nested: { deep: { list: [1, 'two', { when: new Date(1) }], nil: null } },
});

/**
 * Tear down only what this suite created.
 *
 * `Test File/test-db-safety.test.js` forbids any auto-run test from calling
 * dropDatabase, because one of them used to wipe the production cluster that
 * way on every `npm test`. The rule is right even though every database here is
 * a throwaway: deleting the two collections this file creates is all the reset a
 * backup test needs, so the guard stays intact.
 */
const OWNED = ['things', 'others'];
const wipe = async (conn) => {
  for (const c of OWNED) await conn.db.collection(c).deleteMany({}).catch(() => {});
};

async function seedSource(uri) {
  const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 }).asPromise();
  await wipe(conn);
  await conn.db.collection('things').insertMany([awkwardDoc('660000000000000000000001'), { _id: new mongoose.Types.ObjectId('660000000000000000000002'), tag: 'plain' }]);
  await conn.db.collection('others').insertOne({ _id: new mongoose.Types.ObjectId(), when: new Date('2026-01-01T00:00:00.001Z') });
  return conn;
}

test('backup and restore', { skip: preflight.skip }, async (t) => {
  if (!preflight.uri) return;
  const srcUri = withDatabase(preflight.uri, SRC);
  let dirs = [];
  let scratch = null;

  const closeScratch = async () => {
    if (!scratch) return;
    const conn = await mongoose.createConnection(scratch.uri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    await wipe(conn);
    await conn.close().catch(() => {});
    scratch = null;
  };

  t.after(async () => {
    await closeScratch();
    const conn = await mongoose.createConnection(srcUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    await wipe(conn);
    await conn.close().catch(() => {});
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  const freshDir = (label) => { const d = tmp(label); dirs.push(d); return d; };

  // Seeded once for every subtest below — each of them exports this database,
  // and a dump taken from an empty source would prove nothing about fidelity.
  {
    const seeded = await seedSource(srcUri);
    await seeded.close();
  }

  // ── 1. FIDELITY ─────────────────────────────────────────────────────────
  await t.test('the dump format is the only thing keeping an Int64 intact', () => {
    const doc = awkwardDoc('660000000000000000000009');
    const line = dumpLine(doc).trim();
    assert.match(line, /"\$oid"/, 'an ObjectId is written as an ObjectId');
    assert.match(line, /"\$numberLong":"9007199254740993"/, 'an Int64 keeps every digit');
    assert.match(line, /"\$numberDecimal"/, 'a Decimal128 keeps every digit');
    assert.match(line, /"\$binary"/, 'a buffer keeps its bytes');

    const back = readLine(line);
    assert.equal(canonical(back), line, 'the same document round-trips byte for byte');
    assert.ok(back.at instanceof Date, 'a Date does not come back as a string');
    assert.equal(back.at.getTime(), doc.at.getTime(), 'to the millisecond');
    assert.equal(String(back.big), '9007199254740993', 'past 2^53, where a JS number cannot follow');
    assert.deepEqual([...back.bin.value()], [0, 1, 253, 254, 255, 0], 'binary survives');

    // The trap this exists for, stated as a test rather than a comment: the
    // library's DEFAULT parse turns that Int64 into a lossy Number.
    const relaxed = B.EJSON.parse(line);
    assert.equal(typeof relaxed.big, 'number', 'relaxed parsing produces a plain number');
    assert.equal(String(relaxed.big), '9007199254740992', 'and that number is wrong by one');
  });

  await t.test('the exporter and the restorer use one writer and one reader', () => {
    // Comments are stripped first. This file's own header quotes the lossy
    // `EJSON.stringify(doc)` call to explain why it is wrong, and a guard that
    // reads prose as code fails on the explanation rather than on the bug.
    const src = fs.readFileSync(path.join(SERVER, 'utils', 'backupStore.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(src, /out\.write\(dumpLine\(doc\)\)/, 'the export writes through dumpLine');
    assert.match(src, /\.map\(readLine\)/, 'the import reads through readLine');
    assert.match(src, /const EJSON_OPTIONS = \{ relaxed: false \}/, 'canonical is set once, at the top');
    assert.doesNotMatch(src, /stringify\([^,)]*\)/, 'no stringify call anywhere takes no options');
    assert.doesNotMatch(src, /parse\([^,)]*\)/, 'and no parse call defaults to relaxed');
  });

  await t.test('a real export restores into a scratch database identical field for field', async () => {
    const seeded = await seedSource(srcUri);
    await seeded.close();

    const outDir = freshDir('dump');
    const uploads = freshDir('uploads');
    fs.writeFileSync(path.join(uploads, 'a.txt'), 'aaaa');
    fs.mkdirSync(path.join(uploads, 'pictures'), { recursive: true });
    fs.writeFileSync(path.join(uploads, 'pictures', 'b.txt'), 'bbbbbb');

    const manifest = await exportDatabase({ uri: srcUri, outDir, uploadsDir: uploads });
    assert.equal(manifest.database, SRC, 'the dump names the database it came from');
    assert.deepEqual(manifest.collections.map(c => c.collection).sort(), ['others', 'things']);
    assert.equal(manifest.documentTotal, 3);
    assert.equal(manifest.uploads.files, 2, 'the files on disk are part of the data');
    assert.equal(manifest.uploads.bytes, 10);

    scratch = { name: scratchName(), uri: withDatabase(preflight.uri, scratchName()) };
    assert.ok(scratch.name.includes('test'), 'the throwaway is named like a test database');
    const result = await importDatabase({ uri: scratch.uri, fromDir: outDir });
    assert.equal(result.database, scratch.name, 'the restore says where it actually wrote');
    assert.equal(result.sourceDatabase, SRC);

    const conn = await mongoose.createConnection(scratch.uri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    try {
      for (const entry of manifest.collections) {
        const expected = fs.readFileSync(path.join(outDir, 'data', `${entry.collection}.ejson`), 'utf8')
          .split('\n').filter(Boolean).map(readLine);
        const actual = await conn.db.collection(entry.collection).find({}).toArray();
        assert.equal(actual.length, entry.count, `${entry.collection}: count reproduced`);
        const byId = new Map(actual.map(d => [String(d._id), d]));
        for (const doc of expected) {
          const found = byId.get(String(doc._id));
          assert.ok(found, `document ${doc._id} came back`);
          for (const field of Object.keys(doc)) {
            assert.equal(canonical(found[field]), canonical(doc[field]),
              `${entry.collection}.${field} of ${doc._id} is identical after a restore`);
          }
        }
      }
      const things = await conn.db.collection('things').findOne({ _id: new mongoose.Types.ObjectId('660000000000000000000001') });
      assert.equal(String(things.big), '9007199254740993', 'the Int64 is still exact inside the restored database');
      assert.ok(things.at instanceof Date, 'and the Date is still a date');
    } finally {
      await conn.close();
    }
  });

  // ── 2. TAMPERING ────────────────────────────────────────────────────────
  await t.test('an edited or truncated dump refuses to restore', async () => {
    const outDir = freshDir('tamper');
    await exportDatabase({ uri: srcUri, outDir });
    const file = path.join(outDir, 'data', 'things.ejson');
    const manifest = readManifest(outDir);
    const entry = manifest.collections.find(c => c.collection === 'things');

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Unicode', 'UNICODE'));
    await assert.rejects(() => importDatabase({ uri: withDatabase(preflight.uri, scratchName()), fromDir: outDir }),
      /checksum does not match the manifest — the dump was truncated or edited/,
      'a one-word edit is caught before anything is written');

    fs.rmSync(file);
    await assert.rejects(() => importDatabase({ uri: withDatabase(preflight.uri, scratchName()), fromDir: outDir }),
      /backup is missing data\/things\.ejson/, 'and so is a deleted file');
  });

  await t.test('a folder that is not a backup is not a backup', () => {
    const dir = freshDir('notbackup');
    assert.throws(() => readManifest(dir), /is not a backup/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ kind: 'something-else' }));
    assert.throws(() => readManifest(dir), /is not a SuppliWise backup/);
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ kind: 'suppliwise-backup' }));
    assert.throws(() => readManifest(dir), /has no collection list/);
  });

  // ── 3. THE SCRATCH ──────────────────────────────────────────────────────
  await t.test('a restore overwrites a collection rather than interleaving it', async () => {
    const name = scratchName();
    const uri = withDatabase(preflight.uri, name);
    const conn = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    await conn.db.collection('things').insertOne({ _id: new mongoose.Types.ObjectId('670000000000000000000009'), ghost: 'a row from a previous era' });
    await conn.close();

    const outDir = freshDir('dropfirst');
    const manifest = await exportDatabase({ uri: srcUri, outDir });
    await importDatabase({ uri, fromDir: outDir });

    const check = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    try {
      const things = await check.db.collection('things').find({}).toArray();
      assert.equal(things.length, manifest.collections.find(c => c.collection === 'things').count,
        'the dump count, not the dump count plus whatever was already there');
      assert.equal(things.some(d => d.ghost), false, 'a stray live row is gone, not merged');
    } finally {
      await wipe(check);
      await check.close();
    }
  });

  await t.test('the scratch guard refuses every target it was not given', () => {
    assert.equal(assertScratch(withDatabase(preflight.uri, `${SCRATCH_MARKER}test1`), SRC), `${SCRATCH_MARKER}test1`);
    assert.throws(() => assertScratch(withDatabase(preflight.uri, 'myapp'), SRC), /must start with sw_drill_/);
    assert.throws(() => assertScratch(withDatabase(preflight.uri, 'test'), SRC), /must start with sw_drill_/);
    assert.throws(() => assertScratch(withDatabase(preflight.uri, `${SCRATCH_MARKER}x`), `${SCRATCH_MARKER}x`),
      /refusing to restore over the source database/);
    assert.throws(() => assertScratch(withDatabase(preflight.uri, ''), SRC), /must start with sw_drill_/,
      'and a URI with no database at all — which resolves to `test` — is not a scratch database either');
  });

  await t.test('database names and rebuilt URIs behave on an Atlas-style string', () => {
    const atlas = 'mongodb+srv://user:hunter2@cluster0.abc.mongodb.net/?appName=sw';
    assert.equal(databaseNameOf(atlas), 'test', 'no path segment means the driver default — which is production');
    assert.equal(databaseNameOf('mongodb://127.0.0.1:27017/myapp'), 'myapp');
    assert.equal(databaseNameOf('mongodb://127.0.0.1:27017/myapp?directConnection=true'), 'myapp');

    const rebuilt = withDatabase('mongodb+srv://user:hunter2@cluster0.abc.mongodb.net/?appName=sw', 'sw_drill_test9');
    assert.equal(rebuilt, 'mongodb+srv://user:hunter2@cluster0.abc.mongodb.net/sw_drill_test9?appName=sw',
      'the name goes where the empty path was, and the query survives after it');
    assert.equal(databaseNameOf(rebuilt), 'sw_drill_test9');
    assert.equal(databaseNameOf(withDatabase('mongodb://h:1/?a=1', 'x')), 'x');
  });

  await t.test('the CLI will not write to a database it was not told to', async () => {
    const outDir = freshDir('cli');
    const manifest = await exportDatabase({ uri: srcUri, outDir });
    const name = scratchName();
    const env = { ...process.env, MONGO_URI: srcUri, SUPPLIWISE_BACKUP_DIR: outDir };
    const run = (args) => {
      try {
        return { ok: true, out: execFileSync(process.execPath, ['scripts/restore.js', ...args], { cwd: SERVER, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
      } catch (err) {
        return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
      }
    };

    const dry = run(['--from', outDir]);
    assert.equal(dry.ok, false, 'no --yes means nothing is written');
    assert.match(dry.out, new RegExp(manifest.database));
    assert.match(dry.out, /Refusing to write anything without --yes/);

    const wrong = run(['--from', outDir, '--into', 'some_other_database', '--yes']);
    assert.equal(wrong.ok, false, 'a target that is neither the source nor a scratch is refused');
    assert.match(wrong.out, /neither the .* database this dump came from nor a sw_drill_-marked scratch/);

    const good = run(['--from', outDir, '--into', name, '--yes']);
    assert.equal(good.ok, true, `a marker-carrying scratch target works: ${good.out}`);
    assert.match(good.out, /Restore complete/);
    assert.match(good.out, /things\s+2 doc\(s\)/);

    const conn = await mongoose.createConnection(withDatabase(preflight.uri, name), { serverSelectionTimeoutMS: 8000 }).asPromise();
    try {
      assert.equal(await conn.db.collection('things').countDocuments({}), 2, 'the CLI really wrote it');
    } finally {
      await wipe(conn);
      await conn.close();
    }
  });

  await t.test('the drill imports the guard instead of keeping its own copy', () => {
    const drill = fs.readFileSync(path.join(SERVER, 'scripts', 'backup-drill.js'), 'utf8');
    const restore = fs.readFileSync(path.join(SERVER, 'scripts', 'restore.js'), 'utf8');
    assert.doesNotMatch(drill, /function assertScratch/, 'one implementation of the rule that stops a restore destroying a database');
    assert.doesNotMatch(restore, /function assertScratch/);
    assert.match(drill, /assertScratch,\n\s*SCRATCH_MARKER/, 'and the drill does import it');
    assert.match(restore, /SCRATCH_MARKER/, 'as does the CLI');
  });

  // ── 4. NO SECRETS ───────────────────────────────────────────────────────
  await t.test('a dump folder holds data and nothing else', async () => {
    const outDir = freshDir('nosecret');
    const uploads = freshDir('nosecret-up');
    fs.writeFileSync(path.join(uploads, 'a.txt'), 'aaa');
    await exportDatabase({ uri: srcUri, outDir, uploadsDir: uploads });
    const manifestText = fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8');
    assert.ok(!manifestText.includes('@'), 'no host, no user');
    assert.doesNotMatch(manifestText, /mongodb(\+srv)?:\/\//i, 'no connection string of any kind');
    const files = fs.readdirSync(outDir);
    assert.deepEqual(files.sort(), ['data', 'manifest.json', 'uploads'], 'only the data, the uploads and the manifest');
  });

  await t.test('copyDir counts the tree and never follows a link out of it', () => {
    const src = tmp('linksrc'); const dest = tmp('linkdest');
    fs.mkdirSync(path.join(src, 'pictures'), { recursive: true });
    fs.writeFileSync(path.join(src, 'pictures', 'a.bin'), '12345');
    const secret = path.join(src, 'outside.txt');
    fs.writeFileSync(secret, 'DO NOT COPY');
    let linked = false;
    try {
      fs.symlinkSync(secret, path.join(src, 'pictures', 'link.txt'), 'file');
      linked = true;
    } catch { /* this account may not be allowed to create symlinks */ }
    if (!linked) t.diagnostic('no symlink could be created here — the skip is asserted from a folder copy only');

    const copied = copyDir(src, dest);
    assert.equal(copied.files, 2, 'the two real files are copied');
    assert.ok(fs.existsSync(path.join(dest, 'pictures', 'a.bin')));
    assert.equal(fs.existsSync(path.join(dest, 'pictures', 'link.txt')), false,
      'the symlink is skipped, not followed — an uploads folder is where an attacker-supplied name lands');
    const missing = copyDir(path.join(src, 'no-such-dir'), dest);
    assert.deepEqual(missing, { files: 0, bytes: 0, missing: true }, 'a folder that is not there is reported, not thrown');
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(dest, { recursive: true, force: true });
  });

  // ── 5. THE PROBE ────────────────────────────────────────────────────────
  await t.test('the monitor reads counts, not document bodies, to say whether live data moved', async () => {
    const outDir = freshDir('currency');
    await exportDatabase({ uri: srcUri, outDir });
    const before = await verifyAgainstLive({ uri: srcUri, fromDir: outDir });
    assert.deepEqual(before.missing, [], 'every dumped collection still exists');
    assert.equal(before.stale.length, 0, 'and the counts still match');

    const conn = await mongoose.createConnection(srcUri, { serverSelectionTimeoutMS: 8000 }).asPromise();
    await conn.db.collection('things').insertOne({ _id: new mongoose.Types.ObjectId(), late: true });
    await conn.close();
    const after = await verifyAgainstLive({ uri: srcUri, fromDir: outDir });
    assert.equal(after.stale.length, 1, 'a row written after the dump makes the dump stale');
    assert.match(after.stale[0], /things \(\+1 since the dump\)/, 'and it says by how much');
  });

  await t.test('the backup row fails closed rather than claiming a control that is not there', async () => {
    const probe = require('../utils/attack_probes').attackProbes.backup_currency;
    const root = freshDir('root');
    process.env.SUPPLIWISE_BACKUP_DIR = root;

    const none = await probe();
    assert.equal(none.status, 'warning', 'no dump on disk is not a healthy backup');
    assert.match(none.detail, /No backup dump exists/);
    assert.match(none.detail, /npm run backup/, 'and it says what to run');

    await exportDatabase({ uri: srcUri, outDir: path.join(root, '2026-10-19T00-00-00-000Z') });
    const undrilled = await probe();
    assert.equal(undrilled.status, 'warning', 'a dump nobody has restored is a hypothesis');
    assert.match(undrilled.detail, /has never been restored/);

    writeDrillReceipt(root, { passed: false, error: 'checksum does not match', scratch: 'sw_drill_test0' });
    const failed = await probe();
    assert.equal(failed.status, 'critical', 'a drill that failed must not be reported as a backup');
    assert.match(failed.detail, /last restore drill FAILED/);

    const stamp = path.join(root, '2026-10-19T00-00-00-000Z');
    writeDrillReceipt(root, { passed: true, database: SRC, documentTotal: 3, collections: 2, uploads: 0, scratch: 'sw_drill_test0' });
    // Backdate the dump 200 h: past the 168 h default, inside a 720 h one.
    fs.writeFileSync(path.join(stamp, 'manifest.json'), JSON.stringify({
      ...readManifest(stamp),
      createdAt: new Date(Date.now() - 200 * 3600000).toISOString(),
    }));
    const stale = await probe();
    assert.equal(stale.status, 'warning', 'a dump older than the limit is a warning even after a passed drill');
    assert.match(stale.detail, /past the 168 h limit/);

    process.env.SUPPLIWISE_BACKUP_MAX_AGE_HOURS = '1';
    const tight = await probe();
    assert.match(tight.detail, /past the 1 h limit/, 'the limit is read at call time, not baked in');

    process.env.SUPPLIWISE_BACKUP_MAX_AGE_HOURS = '720';
    const ok = await probe();
    delete process.env.SUPPLIWISE_BACKUP_MAX_AGE_HOURS;
    assert.equal(ok.status, 'healthy', 'with the age limit raised, a drilled dump reads healthy');
    assert.match(ok.detail, /restored it since, document for document/);
    assert.match(ok.detail, /sw_drill_test0/, 'and it names the scratch database the proof ran in');

    // Backups are being taken, but the last proof restored an older dump.
    fs.writeFileSync(path.join(stamp, 'manifest.json'), JSON.stringify({
      ...readManifest(stamp),
      createdAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(root, DRILL_RECEIPT), JSON.stringify({
      passed: true, scratch: 'sw_drill_test0', at: new Date(Date.now() - 10 * 86400000).toISOString(),
    }));
    const olderProof = await probe();
    assert.equal(olderProof.status, 'warning', 'a passed drill only proves the dump it ran against');
    assert.match(olderProof.detail, /the drill proved an older one/);

    assert.equal(newestBackup(root).dir, stamp, 'the newest dump is the one the probe reads');
    assert.equal(readDrillReceipt(root).passed, true);
    assert.equal(path.basename(path.join(root, DRILL_RECEIPT)), 'drill.json');
    assert.equal(newestBackup(path.join(root, 'nothing-here')), null);
    assert.equal(backupRoot(), path.resolve(root), 'the CLI and the probe resolve the same folder');
    delete process.env.SUPPLIWISE_BACKUP_DIR;
  });

  await t.test('the row is registered everywhere a monitor has to be', () => {
    const admin = fs.readFileSync(path.join(SERVER, 'routes', 'admin.js'), 'utf8');
    assert.match(admin, /backup_currency:\s*\['Backup Currency \+ Restore Drill', 'backup'\]/,
      'a monitor with no label renders as its raw snake_case key');
    const client = fs.readFileSync(path.join(SERVER, '..', 'my-react-app', 'src', 'Components', 'SecurityStatus', 'SecurityStatus.jsx'), 'utf8');
    for (const name of ['MONITOR_FRAMEWORK', 'MONITOR_LABEL', 'MONITOR_IMPL']) {
      assert.ok(new RegExp(`backup_currency\\s*:`, 'm').test(client), `${name} has no backup_currency entry`);
    }
    assert.match(client, /^\s*'backup_currency',$/m, 'and MONITOR_ORDER has its row');
  });

  await t.test('the npm entry points exist so this is runnable, not just readable', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(SERVER, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts.backup, 'node scripts/backup.js');
    assert.equal(pkg.scripts['backup:drill'], 'node scripts/backup-drill.js');
    assert.equal(pkg.scripts.restore, 'node scripts/restore.js');
  });

  await t.test('a backup folder is un-committable, because it holds every member', () => {
    const root = path.join(SERVER, '..');
    const check = (p) => spawnSync('git', ['check-ignore', '-q', p], { cwd: root, encoding: 'utf8' }).status;
    assert.equal(check('backups/2026-10-19T00-00-00-000Z/data/users.ejson'), 0, 'a database dump is ignored');
    assert.equal(check('backups/2026-10-19T00-00-00-000Z/manifest.json'), 0, 'so is its manifest');
    assert.equal(check('server/backups/whatever/data/x.ejson'), 0, 'at any depth, by shape');
    assert.notEqual(check('utils/backupStore.js'), 0, 'and the rule is not so wide it ignores the source');
    assert.match(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), /^backups\/$/m);
  });
});
