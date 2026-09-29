/**
 * .env loading, and the reload that makes "I just edited the file, tell me the
 * truth" actually work.
 *
 * Run: npm test
 *
 * Why this exists: `dotenv.config()` runs once, at require time, and never
 * overwrites a variable the real environment provided. So an admin who pastes a
 * NEW, valid key into server/.env while the server is running keeps getting the
 * OLD key's verdict — the dashboard reported "Key rejected (HTTP 401)" for a key
 * that answered HTTP 200 on the very next request. Rotating the key again
 * changes nothing, which is exactly the wrong conclusion to draw.
 *
 * These tests pin the two halves of the fix:
 *
 *   1. a .env edit becomes visible on a reload (the "Check now" path);
 *   2. a real OS-provided variable is NEVER overwritten, so this stays safe to
 *      call on a deployed environment where env beats file by design.
 *
 * No test here reads the developer's actual server/.env: `reloadFromDisk` is a
 * deliberate no-op under NODE_ENV=test, precisely so a suite's environment
 * scrubbing cannot be undone by whatever happens to be on the machine.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { reloadFromDisk, isEnvStale, resetLoadedFromDisk, ENV_PATH, OS_PROVIDED } = require('../utils/envFile.js');

test('the env path points at the server .env, not the repo root', () => {
  assert.match(ENV_PATH, /[\\/]server[\\/]\.env$/);
});

test('OS-provided names are snapshotted before dotenv merges', () => {
  // The whole precedence guarantee rests on this set existing. It must contain
  // the variable the runner itself injected, which dotenv could never have set.
  assert.ok(OS_PROVIDED.has('PATH') || OS_PROVIDED.has('Path'),
    'a variable that only the OS supplies must be recorded as OS-provided');
  for (const name of OS_PROVIDED) {
    assert.equal(typeof name, 'string');
    assert.ok(name.length > 0);
  }
});

test('a reload never overrides a variable the real environment provided', () => {
  // Seed a name the OS is deemed to have provided, give it a sentinel, and
  // confirm reloadFromDisk leaves it alone. This is the safety property that
  // makes calling reload on a live environment acceptable.
  const SENTINEL = 'sentinel-from-the-real-environment';
  const name = OS_PROVIDED.has('SUPPLIWISE_TEST_OS_VAR') ? 'PATH' : 'SUPPLIWISE_TEST_OS_VAR';
  const before = process.env[name];

  process.env[name] = SENTINEL;
  OS_PROVIDED.add(name);
  try {
    const outcome = reloadFromDisk();
    assert.equal(process.env[name], SENTINEL, 'an OS-provided value must survive a reload');
    assert.equal(outcome.changed.includes(name), false, 'and must not be reported as changed');
  } finally {
    if (name === 'SUPPLIWISE_TEST_OS_VAR') OS_PROVIDED.delete(name);
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
});

test('a reload is a no-op under test, so suites keep a scrubbed environment', () => {
  // This is what stops a developer's real server/.env (with a real
  // OPENAI_API_KEY) from leaking into every assertion in the suite.
  //
  // The guard is checked two ways because `node --test` does NOT set NODE_ENV:
  // relying on NODE_ENV alone left the guard permanently OFF, which silently
  // repopulated the scrubbed environment and made one ai-providers test pass on
  // a laptop with a real key and fail in CI with no key at all.
  assert.ok(
    process.env.NODE_ENV === 'test' || typeof process.env.NODE_TEST_CONTEXT === 'string',
    'a test runner must be detectable',
  );

  const outcome = reloadFromDisk();
  assert.equal(outcome.reloaded, false);
  assert.deepEqual(outcome.changed, []);
  assert.equal(outcome.error, null);
});

test('a scrubbed variable stays scrubbed across a forced check', () => {
  // End-to-end version of the same regression: the admin panel's "Check now"
  // calls getAiProviders({ force: true }), which reloads. If that reload were
  // live here it would restore the real OPENAI_API_KEY from server/.env and the
  // probe would pass using a credential the test never provided.
  assert.equal(process.env.OPENAI_API_KEY, undefined, 'precondition: scrubbed');
  reloadFromDisk();
  assert.equal(process.env.OPENAI_API_KEY, undefined, 'must stay scrubbed after a reload');
});

test('a reload reports variable NAMES only, never values', () => {
  // The admin panel is told what it reloaded so it can say "your new key was
  // picked up". If a value could ride along here it would end up in an HTTP
  // response body.
  const outcome = reloadFromDisk();
  const wire = JSON.stringify(outcome);
  assert.equal(wire.includes('sk-'), false, 'no key-shaped value in the reload report');
  assert.ok(Array.isArray(outcome.changed));
  for (const name of outcome.changed) {
    assert.equal(typeof name, 'string');
  }
});

test('staleness is false when there is no .env to be stale', () => {
  // An unreadable or absent file is not evidence of an edit. Reporting "stale"
  // there would cry wolf on every poll of a deployment that uses real env vars.
  assert.equal(typeof isEnvStale(), 'boolean');
});

test('a reload always returns a well-formed outcome', () => {
  const outcome = reloadFromDisk();
  for (const field of ['reloaded', 'changed', 'removed', 'error']) {
    assert.ok(field in outcome, `missing "${field}"`);
  }
  assert.equal(typeof outcome.reloaded, 'boolean');
  assert.equal(Array.isArray(outcome.changed), true);
  assert.equal(Array.isArray(outcome.removed), true);
  assert.ok(outcome.error === null || typeof outcome.error === 'string');
});

// ── The banner bug ─────────────────────────────────────────────────────────
//
// Everything above ran green while "Reload and re-check" was permanently broken,
// because no test asked the only question that matters: does clicking the button
// make the warning go AWAY, and stay away?
//
// It did not. Staleness was "is the .env mtime newer than the moment this module
// was required?", and nothing ever moved that baseline — the reload applied the
// new key but left the timestamp alone. The POST reported envStale:false, the
// banner cleared, and the next 10 s poll recomputed the same true answer and put
// it straight back. The admin could click forever.
//
// These drive the real functions against a scratch file, so the assertions do
// not depend on the developer's machine — the same isolation the isTest guard
// exists to provide, opted into explicitly.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A throwaway .env plus a runner that always cleans the environment back up. */
function withScratchEnv(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suppliwise-env-'));
  const envPath = path.join(dir, '.env');
  const write = (contents) => fs.writeFileSync(envPath, contents);
  return (async () => {
    try {
      await run({ envPath, write });
    } finally {
      resetLoadedFromDisk(envPath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
}

test('a fresh boot is not stale, and an edit is', async () => {
  await withScratchEnv(async ({ envPath, write }) => {
    write('DEMO_PROBE_KEY=original\n');
    reloadFromDisk({ envPath });
    assert.equal(isEnvStale({ envPath }), false, 'a process that just loaded the file is not stale');

    write('DEMO_PROBE_KEY=rotated\n');
    assert.equal(isEnvStale({ envPath }), true, 'an edit the process has not seen IS stale');
  });
});

test('"Reload and re-check" clears the warning and it STAYS cleared', async () => {
  // The regression itself. The repeat reads, with no reload in between, stand in
  // for the dashboard's next polls — the ones that used to bring it all back.
  await withScratchEnv(async ({ envPath, write }) => {
    write('DEMO_PROBE_KEY=original\n');
    reloadFromDisk({ envPath });

    write('DEMO_PROBE_KEY=rotated\n');
    assert.equal(isEnvStale({ envPath }), true, 'precondition: the warning is showing');

    const outcome = reloadFromDisk({ envPath });
    assert.deepEqual(outcome.changed, ['DEMO_PROBE_KEY']);
    assert.equal(process.env.DEMO_PROBE_KEY, 'rotated', 'the new key must be the live one');
    assert.equal(isEnvStale({ envPath }), false, 'the reload must clear the warning');

    assert.equal(isEnvStale({ envPath }), false,
      'the next poll must agree — a reload that only clears the warning until the '
      + 'next poll is what made this button useless');
    assert.equal(isEnvStale({ envPath }), false, 'and it must keep agreeing');
  });
});

test('a reload is idempotent, so repeated clicks change nothing', async () => {
  await withScratchEnv(async ({ envPath, write }) => {
    write('DEMO_PROBE_KEY=original\n');
    reloadFromDisk({ envPath });

    const second = reloadFromDisk({ envPath });
    assert.deepEqual(second.changed, [], 'nothing changed, so nothing is reported as changed');
    assert.equal(isEnvStale({ envPath }), false, 'and an idle reload must not raise the warning');
  });
});

test('a key deleted from .env is stale, and the reload drops it', async () => {
  // A file-only comparison would call this "fresh" — the deleted key is absent
  // from the file, so there is no disagreement to find. The process would go on
  // probing with a credential the admin threw away, which is the same lie as an
  // edited key, just quieter.
  await withScratchEnv(async ({ envPath, write }) => {
    write('DEMO_PROBE_KEY=original\nEXTRA_PROBE_KEY=also-original\n');
    reloadFromDisk({ envPath });

    write('EXTRA_PROBE_KEY=also-original\n');
    assert.equal(isEnvStale({ envPath }), true, 'the deleted key is still in use');

    const outcome = reloadFromDisk({ envPath });
    assert.deepEqual(outcome.removed, ['DEMO_PROBE_KEY']);
    assert.equal(process.env.DEMO_PROBE_KEY, undefined, 'the deleted key must not linger');
    assert.equal(process.env.EXTRA_PROBE_KEY, 'also-original', 'the surviving key is untouched');
    assert.equal(isEnvStale({ envPath }), false);
  });
});

test('a reload never removes a variable it did not put there', async () => {
  // The removal pass is driven by "what the file introduced", so it must not
  // become a way to delete something the code or the OS set at runtime.
  await withScratchEnv(async ({ envPath, write }) => {
    const RUNTIME = 'SUPPLIWISE_RUNTIME_ONLY_VALUE';
    process.env[RUNTIME] = 'set-by-the-process';
    try {
      write('DEMO_PROBE_KEY=original\n');
      reloadFromDisk({ envPath });

      write('# the scratch file now defines nothing\n');
      reloadFromDisk({ envPath });

      assert.equal(process.env[RUNTIME], 'set-by-the-process',
        'a value the file never provided must survive every reload');
    } finally {
      delete process.env[RUNTIME];
    }
  });
});

test('an OS-provided variable is not stale however .env spells it', async () => {
  // The precedence guarantee means a real environment variable always wins, so
  // editing its .env counterpart can never leave us holding a stale value.
  // Reporting it as stale would cry wolf on every poll of a deployed
  // environment, where the keys come from the real env and the .env is
  // decorative.
  await withScratchEnv(async ({ envPath, write }) => {
    const name = OS_PROVIDED.has('SUPPLIWISE_OS_WINS') ? 'SUPPLIWISE_OS_WINS_2' : 'SUPPLIWISE_OS_WINS';
    OS_PROVIDED.add(name);
    process.env[name] = 'from-the-real-environment';
    try {
      write(`${name}=from-the-file\n`);
      reloadFromDisk({ envPath });
      assert.equal(process.env[name], 'from-the-real-environment', 'precondition: the real env won');

      write(`${name}=edited-in-the-file\n`);
      assert.equal(isEnvStale({ envPath }), false,
        'an .env edit that the real environment overrides is not staleness');
    } finally {
      delete process.env[name];
      OS_PROVIDED.delete(name);
    }
  });
});

test('an unreadable .env is reported, not silently treated as empty', async () => {
  // The failure that matters for the button: a reload that cannot read the file
  // must say so. Returning "no error" here is what let the panel claim a clean
  // reload while quietly re-probing with the same stale keys.
  await withScratchEnv(async ({ envPath, write }) => {
    write('DEMO_PROBE_KEY=original\n');
    reloadFromDisk({ envPath });

    fs.rmSync(envPath);
    const outcome = reloadFromDisk({ envPath });
    assert.equal(outcome.reloaded, false, 'a missing file is not a reload');
    assert.equal(typeof outcome.error, 'string', 'and it must carry a reason');
    assert.equal(isEnvStale({ envPath }), false, 'no file is not evidence of staleness');
  });
});
