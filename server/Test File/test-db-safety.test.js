/**
 * THE TEST SUITE MUST NEVER BE ABLE TO TOUCH THE APPLICATION DATABASE.
 *
 * THE BUG THIS LOCKS DOWN
 * -----------------------
 * `Test File/password-reset-db.test.js` connected straight to
 * `process.env.MONGO_URI` and called `mongoose.connection.dropDatabase()` in its
 * `after` hook. `npm test` therefore DELETED THE ENTIRE PRODUCTION DATABASE —
 * every user, admin, assessment and subscription row — silently, on every run.
 * It was not theoretical: running the suite wiped a live cluster.
 *
 * The trap that made it so easy to write
 * -------------------------------------
 * The application's MONGO_URI carries no database name:
 *
 *     mongodb+srv://…@cluster.mongodb.net/?appName=…
 *
 * which resolves to the driver's DEFAULT database — literally named `test` — on
 * the LIVE cluster. So "the production database is called `test`" was true, and
 * any guard that only asked "does this database look like a test database?"
 * would have waved the real one through. `testDbGuard.js` exists precisely to
 * avoid that by keying on a separate URI, and one suite had simply been missed.
 *
 * WHAT IS ASSERTED
 * ----------------
 * A static check, because the failure mode is a source-level mistake and there
 * is no runtime that can catch it before the drop happens:
 *   1. No file under Test File/ may call dropDatabase / dropCollection.
 *   2. No file under Test File/ may connect using process.env.MONGO_URI.
 * A file that legitimately needs the app's models may still require the model
 * modules — that is what the guard is for.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;

/**
 * Every file `npm test` actually executes.
 *
 * The script is `node --test "Test File/*.test.js"`, so ONLY `*.test.js` runs
 * automatically. That is the set that matters here, because that is what can
 * destroy data without anyone choosing to.
 *
 * The directory also holds deliberate manual tools — `make-session-token.js`,
 * `make-admin-token.js`, `make-support-demo-user.js` and `support-chat.e2e.js`
 * are all SUPPOSED to reach the application database, since minting a real
 * session against the real app is their entire purpose, and none of them is
 * picked up by the test glob. Folding them into this check would be wrong: it
 * would push someone toward "fixing" a helper that is working as designed.
 */
function autoRunTestFiles() {
  return fs.readdirSync(TEST_DIR)
    .filter((n) => n.endsWith('.test.js'))
    .map((n) => path.join(TEST_DIR, n));
}

/** Strip comment lines so prose about a forbidden call is not a violation. */
function codeOnly(src) {
  return src.split('\n')
    .filter((line) => !/^\s*(\*|\/\/)/.test(line))
    .join('\n');
}

test('no automatically-run test can drop the database', () => {
  const offenders = [];
  for (const file of autoRunTestFiles()) {
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    if (/\.\s*dropDatabase\s*\(/.test(code) || /\.\s*dropCollection\s*\(/.test(code)) {
      offenders.push(path.basename(file));
    }
  }
  assert.deepEqual(
    offenders, [],
    'these files run under `npm test` and can delete real data — tear down only '
    + 'the rows the test created'
  );
});

test('no automatically-run test connects to the application database', () => {
  const offenders = [];
  for (const file of autoRunTestFiles()) {
    const code = codeOnly(fs.readFileSync(file, 'utf8'));
    // Anything that reads MONGO_URI and hands it to a driver is the bug. A
    // file may still *compare* the two URIs — that is the guard's own check.
    if (/mongoose\s*\.\s*connect\s*\(\s*process\.env\.MONGO_URI/.test(code)
      || /new\s+(?:MongoClient|ConnectionString)\s*\(\s*process\.env\.MONGO_URI/.test(code)) {
      offenders.push(path.basename(file));
    }
  }
  assert.deepEqual(
    offenders, [],
    'these files run under `npm test` and connect to process.env.MONGO_URI — tests '
    + 'must use connectTestDb() from testDbGuard so they can only reach MONGO_TEST_URI'
  );
});

test('the guard still refuses a test URI that is the application URI', () => {
  const { validateTestUri } = require('./testDbGuard');
  // Sanity-check the guard the rest of the suite leans on, since a regression
  // here is what made the drop possible in the first place.
  const savedTest = process.env.MONGO_TEST_URI;
  const savedApp = process.env.MONGO_URI;
  try {
    process.env.MONGO_URI = 'mongodb+srv://u:p@cluster.mongodb.net/?appName=App';
    process.env.MONGO_TEST_URI = 'mongodb+srv://u:p@cluster.mongodb.net/?appName=App';
    const same = validateTestUri();
    assert.equal(same.ok, false, 'a test URI identical to the app URI must be refused');

    process.env.MONGO_TEST_URI = 'mongodb://localhost:27017/suppliwise_test';
    const good = validateTestUri();
    assert.equal(good.ok, true, 'a dedicated local test database must be accepted');
  } finally {
    if (savedTest === undefined) delete process.env.MONGO_TEST_URI;
    else process.env.MONGO_TEST_URI = savedTest;
    if (savedApp === undefined) delete process.env.MONGO_URI;
    else process.env.MONGO_URI = savedApp;
  }
});
