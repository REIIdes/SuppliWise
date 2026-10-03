/**
 * .env loading, with the one capability dotenv alone does not give us:
 * re-reading the file after the process has already started.
 *
 * WHY THIS EXISTS
 * ---------------
 * `dotenv.config()` merges .env into process.env exactly once, at require
 * time, and it deliberately does NOT overwrite a variable the real environment
 * already provided. Both behaviours are correct — but together they produce a
 * failure that looks like a broken credential:
 *
 *   1. An admin pastes a fresh key into server/.env while the server is up.
 *   2. The running process keeps the OLD key in memory.
 *   3. The admin dashboard keeps reporting "Key rejected (HTTP 401)" for the
 *      new, perfectly valid key, and rotating the key again changes nothing.
 *
 * The panel is the one place an admin would reasonably expect "I edited the
 * file, tell me the truth now" to work — that is literally what its "Check now"
 * button is for. So this module makes that possible: `reloadFromDisk()` re-reads
 * .env and applies the values that only ever existed because .env defined them.
 *
 * PRECEDENCE (deliberate, and load-bearing)
 * -----------------------------------------
 * A variable that the real OS environment provided is NEVER overwritten, by
 * dotenv at boot or by reloadFromDisk() later. That is the standard 12-factor
 * precedence (a container/host setting beats a file baked into the image), and
 * it is what makes it safe to call reload on a deployed environment. The set of
 * OS-provided names is captured below at module load, which only works because
 * this module is required BEFORE `dotenv.config()` runs — see server/index.js.
 *
 * No value is ever returned from here. Callers get the NAMES of the variables
 * that changed, which is all the admin panel needs to say "your new key was
 * picked up" without putting key material in an HTTP response.
 *
 * WHAT "STALE" MEANS
 * ------------------
 * Staleness is a disagreement between two things we can both see right now:
 * the file, and the values this process is actually using. It is deliberately
 * NOT a comparison of file timestamps against a recorded process-start time.
 * That version was wrong in a way that made the feature useless:
 *
 *   `isStaleSinceStart()` answered "is the .env mtime newer than the moment
 *   this module was required?" Nothing ever moved that baseline forward —
 *   reloadFromDisk() applied the new values but left the timestamp alone — so
 *   after an admin clicked "Reload and re-check" the POST reported
 *   envStale:false, the banner cleared, and ~10 s later the next dashboard poll
 *   recomputed the same true answer and the banner came straight back. Clicking
 *   the button could never fix anything, which is the opposite of what a button
 *   labelled "Reload and re-check" is for.
 *
 *   Timestamps also lie in ways that have nothing to do with the file's
 *   contents: a .env restored from backup, checked out by git, or unzipped can
 *   carry a future mtime, and a .env written in the same millisecond as the
 *   process booted reads as "not edited" when it was.
 *
 *   So staleness is now computed from values. A variable is stale when the file
 *   disagrees with what this process is using, checked across the union of what
 *   the file defines now and what the file last defined — the union is what
 *   catches a DELETED key, which is exactly as misleading as an edited one and
 *   which a file-only comparison would sail straight past.
 */

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

/** Absolute path to the server's .env. */
const ENV_PATH = path.join(__dirname, '..', '.env');

/**
 * Names present in process.env at module load — i.e. before dotenv has merged
 * anything in. Anything in here came from the real environment (shell, service
 * manager, container) and is off limits to .env, now and always.
 */
const OS_PROVIDED = new Set(Object.keys(process.env));

/**
 * True when THIS process is a server deliberately started for a test run.
 *
 * A test suite spawns a real server (Test File/e2eServer.js) which needs real
 * secrets — JWT_SECRET above all, since refusing to boot without it is a hard
 * guard. That child is NOT a unit test: nothing scrubs its environment, and it
 * must read .env like any other server.
 *
 * Without this distinction the `isTest` guard below matched the child too
 * (it inherits NODE_ENV=test), so .env was never read, JWT_SECRET was absent,
 * and the spawned server died on boot with
 *
 *     Error: JWT_SECRET is missing or still uses the default placeholder value.
 *
 * i.e. the entire end-to-end harness could never start. It went unnoticed
 * because those suites skip unless MONGO_TEST_URI is configured, so the broken
 * child process was never actually booted.
 *
 * The marker is explicit and one-way: a suite sets it on the child it spawns,
 * and it deliberately does not switch off the guard for the suite itself.
 */
const isTestServer = process.env.SUPPLIWISE_TEST_SERVER === '1';

/**
 * True when this process is a test runner that scrubs process.env on purpose.
 *
 * The suites scrub process.env deliberately; letting a reload repopulate it from a
 * developer's real .env would make assertions depend on the machine they ran on
 * — and would quietly give a test a working OPENAI_API_KEY, so it passes on the
 * developer's laptop and fails in CI where no .env exists.
 *
 * Two signals, because neither is sufficient on its own: `node --test` does NOT
 * set NODE_ENV, and NODE_TEST_CONTEXT only exists on Node >= 20. Checking both
 * means the guard holds whether the suite is run via `npm test` or by invoking
 * the runner directly.
 *
 * A spawned test SERVER is exempt — see isTestServer above.
 */
const isTest = !isTestServer && (
  process.env.NODE_ENV === 'test'
  || typeof process.env.NODE_TEST_CONTEXT === 'string'
);

/** When this process booted, in epoch ms. */
const startedAt = Date.now();

/**
 * The values this process applied to process.env FROM THE FILE, as of the last
 * time the file was read. This is the "what we are currently running" half of
 * the staleness question, and it is what makes a reload able to clear the flag:
 * once a reload has written the file's values into process.env, the two agree.
 *
 * Keyed by file path, so driving one file can never be mistaken for having read
 * another. There is normally exactly one entry.
 */
const loadedFromFile = new Map();

/** The loaded-values record for a given file, created on first use. */
function stateFor(envPath) {
  let state = loadedFromFile.get(envPath);
  if (!state) {
    state = new Map();
    loadedFromFile.set(envPath, state);
  }
  return state;
}

/**
 * Read + parse a .env without touching process.env.
 *
 * Failures are reported rather than flattened to `{}`, because "the file is
 * absent" and "the file defines nothing" are opposites: the first is not
 * evidence that anything is stale, the second means every key it used to hold
 * is still sitting in this process.
 *
 * @returns {{ok: true, parsed: Record<string,string>} | {ok: false, error: string}}
 */
function readDotEnv(envPath) {
  let raw;
  try {
    if (!fs.existsSync(envPath)) return { ok: false, error: 'server/.env not found.' };
    raw = fs.readFileSync(envPath);
  } catch {
    // An unreadable .env must not take the process down: the already-loaded
    // values in process.env remain perfectly usable.
    return { ok: false, error: 'server/.env could not be read.' };
  }
  try {
    return { ok: true, parsed: dotenv.parse(raw) };
  } catch {
    // Same reasoning: a malformed file is a reason to say so, not to crash and
    // not to pretend the file declared nothing.
    return { ok: false, error: 'server/.env could not be parsed.' };
  }
}

/**
 * Re-read .env and apply every value whose current value came from the file.
 *
 * Safe to call repeatedly; a no-op once the file and the environment agree.
 *
 * @param {{envPath?: string}} [options] `envPath` is a test seam: it lets a
 *   suite drive the real logic against a throwaway file, which is the only way
 *   to prove the staleness contract without depending on whatever the developer
 *   happens to have in their own .env. Naming a file explicitly also lifts the
 *   isTest guard below, because a caller pointing at its own scratch file gains
 *   nothing from reading the real .env — and the guard exists only to stop that
 *   from happening by accident.
 * @returns {{reloaded: boolean, changed: string[], removed: string[], error: string|null}}
 *   `changed` and `removed` hold variable NAMES only, never values.
 */
function reloadFromDisk({ envPath = ENV_PATH } = {}) {
  if (isTest && envPath === ENV_PATH) {
    // Tests scrub process.env deliberately. Letting a reload repopulate it from
    // a developer's real .env would silently undo that scrubbing and make
    // assertions pass or fail depending on the machine they ran on.
    return { reloaded: false, changed: [], removed: [], error: null };
  }

  const read = readDotEnv(envPath);
  if (!read.ok) {
    return { reloaded: false, changed: [], removed: [], error: read.error };
  }

  const parsed = read.parsed;
  if (!Object.keys(parsed).length) {
    return { reloaded: false, changed: [], removed: [], error: null };
  }

  const previous = stateFor(envPath);
  const changed = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (OS_PROVIDED.has(name)) continue; // the real environment wins
    if (process.env[name] === value) continue; // already up to date
    process.env[name] = value;
    changed.push(name);
  }

  // A key DELETED from .env is exactly as misleading as one that was edited: the
  // file now says "this provider is not configured" while the process happily
  // keeps probing with the key the admin deleted ten minutes ago. Removing it is
  // safe because `previous` only ever contains names the FILE introduced — an
  // OS-provided variable, or anything else the code set at runtime, is never in
  // here and so can never be deleted by a reload.
  const removed = [];
  for (const name of previous.keys()) {
    if (name in parsed) continue;
    if (OS_PROVIDED.has(name)) continue;
    delete process.env[name];
    removed.push(name);
  }

  previous.clear();
  for (const [name, value] of Object.entries(parsed)) {
    if (!OS_PROVIDED.has(name)) previous.set(name, value);
  }

  return { reloaded: true, changed, removed, error: null };
}

/**
 * Does this process still hold .env values that the file no longer agrees with?
 *
 * This is the honest answer to "why is the panel still showing a stale verdict
 * if the file is right there?". A true here means the running process is using
 * something other than what the file says; press "Check now" (which reloads) or
 * restart the server.
 *
 * Because it compares values rather than timestamps, a reload genuinely clears
 * it and the next poll agrees — which a recorded process-start time could never
 * do, since nothing moved that baseline and the banner came straight back.
 *
 * @param {{envPath?: string}} [options] see reloadFromDisk — the same test seam,
 *   and the same reason it lifts the isTest guard.
 * @returns {boolean} false when the file is missing, unreadable or unparseable
 *   — an unreadable file is not evidence of a stale one, and guessing otherwise
 *   would cry wolf on every poll of a deployment that uses real env vars.
 */
function isEnvStale({ envPath = ENV_PATH } = {}) {
  // Under a test runner process.env is scrubbed on purpose, so comparing it to
  // whatever is in the developer's real .env would report "stale" on machines
  // that happen to have one. The same reasoning that makes reload a no-op in
  // tests applies to the question of whether a reload is still needed.
  if (isTest && envPath === ENV_PATH) return false;

  const read = readDotEnv(envPath);
  if (!read.ok) return false;

  const parsed = read.parsed;

  // What the file says now, versus what we are running.
  for (const [name, value] of Object.entries(parsed)) {
    // The real environment beat the file, and will keep beating it on every
    // future reload too. An edit to one of these can never leave us holding a
    // stale value, so reporting it as stale would be a lie.
    if (OS_PROVIDED.has(name)) continue;
    if (process.env[name] !== value) return true;
  }

  // What the file USED to say, and no longer does. Without this, deleting a key
  // from .env would read as "fresh" while the deleted key carried on being used.
  for (const name of stateFor(envPath).keys()) {
    if (name in parsed) continue;
    if (OS_PROVIDED.has(name)) continue;
    if (process.env[name] !== undefined) return true;
  }

  return false;
}

/**
 * Test seam: forget what was loaded from a file, and drop the environment
 * variables that load introduced. Without the cleanup half, a suite that pokes
 * values into process.env would leak them into every later test in the process.
 */
function resetLoadedFromDisk(envPath = ENV_PATH) {
  for (const name of stateFor(envPath).keys()) {
    if (OS_PROVIDED.has(name)) continue;
    delete process.env[name];
  }
  loadedFromFile.delete(envPath);
}

module.exports = {
  ENV_PATH,
  OS_PROVIDED,
  reloadFromDisk,
  isEnvStale,
  resetLoadedFromDisk,
  // Retained so an existing caller importing the old, misleading name keeps
  // working. It is the same function — the name was the bug, not the intent.
  isStaleSinceStart: isEnvStale,
  startedAt,
};
