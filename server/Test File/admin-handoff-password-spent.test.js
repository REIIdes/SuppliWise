'use strict';
/**
 * Regression tests: the hand-off (temporary) password must be SPENT after the
 * owner replaces it.
 *
 * The bug
 * -------
 * A password chosen through the admin UI was written only to MongoDB. server/.env
 * kept the hand-off hash, and index.js's boot seeder inserts any admin account
 * whose document is MISSING ($setOnInsert with upsert) so that a fresh clone
 * self-heals. So the moment the document went away — wiped collection, fresh
 * clone, restored backup, a mistyped alias — the seeder rebuilt the account
 * straight from .env:
 *
 *   • the temporary password worked again, and
 *   • mustChangePassword came back FALSE (the schema default), so the account
 *     was fully usable on the temporary password with no prompt at all.
 *
 * That is precisely the "the old password comes back" report. A restart alone
 * did not trigger it, which is why it looked intermittent: the trigger is the
 * document being absent, not the process restarting.
 *
 * These cover both halves of the fix:
 *   1. persistAdminPasswordToEnv updates the standing copy (both the legacy
 *      ADMIN_PASSWORD_HASH trio and the packed ADMIN_ACCOUNTS list).
 *   2. With the copy updated, a rebuild-from-.env restores the NEW password, so
 *      the temporary one stays dead.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseAdminAccounts } = require('../utils/adminAccounts');
const { hashPassword, verifyPassword } = require('../utils/password');

const ARGON2 = '$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$0Q1wJ8S0Y7bYl6m0Zx3kQ8x1Jq0k4h6l0mQ';
const BCRYPT = '$2a$12$mMRQcVk4IxFpvOeCdVqhqueRm73wg4sO.z1pJmZej4LLf4GbXG8oO';
const SECRET_A = 'AAAAAAAAAABBBBBBBBBBCCCCCCCCCCCC';
const SECRET_B = 'DDDDDDDDDDEEEEEEEEEEFFFFFFFFFFFF';
const NEW_HASH = '$argon2id$v=19$m=19456,t=2,p=1$QU5PV0VTVEFMRVI$5rJ8xQ2vTn4LpZ0aBcDeFgHiJkLmNoPqRsTuVwXyZ0123';

// The writer targets the module-scope ENV_PATH, so every case runs against a
// TEMP COPY with the same content, and the module is re-evaluated with `path`
// redirected at that copy. The real server/.env is only ever read here, and it is
// gitignored — these tests must never write to it.
//
// The module computes ENV_PATH once at load time, so redirecting it honestly
// means loading it again with an intercepted `path`, not mutating an export.
function loadWithEnvPath(envPath) {
  const modulePath = require.resolve('../utils/adminAccounts');
  delete require.cache[modulePath];

  const stubbed = require('module');
  const originalLoad = stubbed._load;
  stubbed._load = function intercepted(request, parent, isMain) {
    const loaded = originalLoad.apply(this, arguments);
    if (request !== 'path' || typeof loaded.join !== 'function') return loaded;
    return new Proxy(loaded, {
      get(target, prop) {
        if (prop === 'join') {
          // utils/adminAccounts.js builds ENV_PATH as join(__dirname,'..','.env')
          return (...parts) => (parts[parts.length - 1] === '.env' ? envPath : target.join(...parts));
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  };
  try {
    return require(modulePath);
  } finally {
    stubbed._load = originalLoad;
  }
}

function withTempEnv(content, fn) {
  const tmp = path.join(os.tmpdir(), `aa-${process.pid}-${Math.random().toString(36).slice(2)}.env`);
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    return fn(loadWithEnvPath(tmp), tmp);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

const SAMPLE_ENV = [
  'PORT=5000',
  'ADMIN_ALIAS=AdminDevs',
  `ADMIN_PASSWORD_HASH=${ARGON2}`,
  `ADMIN_TOTP_SECRET=${SECRET_A}`,
  `ADMIN_ACCOUNTS=AdminPoli|${BCRYPT}|${SECRET_B},AdminJohn|${BCRYPT}|${SECRET_B}`,
  'EMAIL_SERVICE=gmail',
  '',
].join('\n');

test('the legacy ADMIN_PASSWORD_HASH is rewritten for the ADMIN_ALIAS account', () => {
  withTempEnv(SAMPLE_ENV, (m, tmp) => {
    const out = m.persistAdminPasswordToEnv('AdminDevs', NEW_HASH, { ADMIN_ALIAS: 'AdminDevs' });
    assert.strictEqual(out.written, true, 'should write: ' + out.reason);
    assert.strictEqual(out.replaced, 1);

    const after = fs.readFileSync(tmp, 'utf8');
    const line = after.split('\n').find((l) => l.startsWith('ADMIN_PASSWORD_HASH='));
    assert.strictEqual(line, 'ADMIN_PASSWORD_HASH=' + NEW_HASH,
      'the legacy line now holds the new hash, not the hand-off one');
  });
});

test('a packed ADMIN_ACCOUNTS entry is rewritten, and only that one', () => {
  withTempEnv(SAMPLE_ENV, (m, tmp) => {
    const out = m.persistAdminPasswordToEnv('AdminJohn', NEW_HASH, { ADMIN_ALIAS: 'AdminDevs' });
    assert.strictEqual(out.written, true, out.reason);
    assert.strictEqual(out.replaced, 1, 'exactly one entry should change');

    const after = fs.readFileSync(tmp, 'utf8');
    const accounts = m.parseAdminAccounts(after.match(/^ADMIN_ACCOUNTS=(.*)$/m)[1]);
    const byAlias = Object.fromEntries(accounts.map((a) => [a.alias, a]));
    assert.strictEqual(byAlias.AdminJohn.passwordHash, NEW_HASH, 'the changed entry is updated');
    assert.strictEqual(byAlias.AdminPoli.passwordHash, BCRYPT, 'its neighbour is untouched');
    assert.strictEqual(accounts.length, 2, 'and no entry was corrupted or added');
  });
});

test('rewriting one entry leaves real argon2id neighbours byte-identical', () => {
  // The case a hand-written comma split gets wrong. Every shipped admin hash is
  // argon2id, so `list.split(',')` would cut the neighbour's hash at `m=19456`
  // and the rewrite would save a mangled list that still LOOKS written. The
  // writer must therefore use the parser's own comma-aware rule.
  const realArgon = ARGON2;   // $argon2id$v=19$m=19456,t=2,p=1$salt$hash
  assert.ok(realArgon.includes(','), 'precondition: the neighbour hash has a comma');

  withTempEnv([
    'ADMIN_ALIAS=AdminDevs',
    `ADMIN_PASSWORD_HASH=${realArgon}`,
    `ADMIN_TOTP_SECRET=${SECRET_A}`,
    `ADMIN_ACCOUNTS=AdminPoli|${realArgon}|${SECRET_B},AdminJohn|${realArgon}|${SECRET_B},AdminShMa|${realArgon}|${SECRET_B}`,
  ].join('\n'), (m, tmp) => {
    const out = m.persistAdminPasswordToEnv('AdminJohn', NEW_HASH, { ADMIN_ALIAS: 'AdminDevs' });
    assert.strictEqual(out.written, true, out.reason);

    const after = fs.readFileSync(tmp, 'utf8');
    const list = after.match(/^ADMIN_ACCOUNTS=(.*)$/m)[1];
    const accounts = m.parseAdminAccounts(list);
    assert.strictEqual(accounts.length, 3, 'all three entries must survive intact');
    const byAlias = Object.fromEntries(accounts.map((a) => [a.alias, a]));
    assert.strictEqual(byAlias.AdminJohn.passwordHash, NEW_HASH, 'the target was rewritten');
    assert.strictEqual(byAlias.AdminPoli.passwordHash, realArgon, 'the previous entry is untouched');
    assert.strictEqual(byAlias.AdminShMa.passwordHash, realArgon, 'the next entry is untouched');
    assert.strictEqual(byAlias.AdminPoli.totpSecret, SECRET_B, 'secrets are not shifted');
  });
});

test('an argon2id hash survives the rewrite intact (no comma-splitting)', () => {
  withTempEnv(SAMPLE_ENV, (m, tmp) => {
    // NEW_HASH is a real-shaped argon2id value: its parameter block is
    // comma-separated, which is the whole hazard this rewrite has to avoid
    // re-introducing while editing the list.
    assert.ok(NEW_HASH.includes(','), 'precondition: the hash contains a comma');
    const out = m.persistAdminPasswordToEnv('AdminPoli', NEW_HASH, { ADMIN_ALIAS: 'AdminDevs' });
    assert.strictEqual(out.written, true, out.reason);

    const after = fs.readFileSync(tmp, 'utf8');
    const accounts = m.parseAdminAccounts(after.match(/^ADMIN_ACCOUNTS=(.*)$/m)[1]);
    assert.strictEqual(accounts.length, 2, 'the list must still parse into two entries');
    assert.strictEqual(accounts[0].passwordHash, NEW_HASH, 'byte-identical, commas and all');
  });
});

test('an alias absent from .env is reported, not silently ignored', () => {
  withTempEnv(SAMPLE_ENV, (m, tmp) => {
    const out = m.persistAdminPasswordToEnv('AdminNobody', NEW_HASH, { ADMIN_ALIAS: 'AdminDevs' });
    assert.strictEqual(out.written, false, 'nothing to update');
    assert.match(out.reason, /AdminNobody/, 'and the reason names the alias, so the log is actionable');
    assert.strictEqual(fs.readFileSync(tmp, 'utf8'), SAMPLE_ENV, 'the file must be untouched');
  });
});

test('a real hash written back verifies against the real password', async () => {
  const chosen = 'Harbour-Lantern-77!';
  const handoff = 'NFaCRvuJRBeE+S2.=Fgg';
  const chosenHash = await hashPassword(chosen);
  assert.ok(chosenHash.includes(','), 'precondition: a real argon2id hash contains a comma');

  withTempEnv(SAMPLE_ENV, async (m, tmp) => {
    const out = m.persistAdminPasswordToEnv('AdminDevs', chosenHash, { ADMIN_ALIAS: 'AdminDevs' });
    assert.strictEqual(out.written, true, out.reason);

    // Re-read exactly as the boot seeder would, then confirm what it restores.
    const env = fs.readFileSync(tmp, 'utf8');
    const stored = env.match(/^ADMIN_PASSWORD_HASH=(.*)$/m)[1].trim();
    assert.strictEqual(await verifyPassword(chosen, stored), true,
      'a rebuild from .env restores the password the owner CHOSE');
    assert.strictEqual(await verifyPassword(handoff, stored), false,
      'and the hand-off password is still dead');
  });
});

test('a rebuild after a password change restores the CHOSEN password (the bug itself)', async () => {
  // The end-to-end shape of the report, in memory. This is the assertion the
  // original code failed: the seeder's output had to be the NEW password, and
  // the hand-off password had to stay dead.
  const chosen = 'Harbour-Lantern-77!';
  const handoff = 'NFaCRvuJRBeE+S2.=Fgg';
  const handoffHash = await hashPassword(handoff);
  const chosenHash = await hashPassword(chosen);

  withTempEnv([
    'ADMIN_ALIAS=AdminDevs',
    `ADMIN_PASSWORD_HASH=${handoffHash}`,
    `ADMIN_TOTP_SECRET=${SECRET_A}`,
  ].join('\n'), async (m, tmp) => {
    // 1. The owner changes their password; the app updates the hand-off copy.
    const written = m.persistAdminPasswordToEnv('AdminDevs', chosenHash, { ADMIN_ALIAS: 'AdminDevs' });
    assert.strictEqual(written.written, true, written.reason);

    // 2. The document is lost, and the seeder rebuilds it from .env — exactly
    //    what index.js does at boot for a missing account.
    const env = fs.readFileSync(tmp, 'utf8');
    const rebuilt = m.configuredAdminAccounts({
      ADMIN_ALIAS: 'AdminDevs',
      ADMIN_PASSWORD_HASH: env.match(/^ADMIN_PASSWORD_HASH=(.*)$/m)[1].trim(),
      ADMIN_TOTP_SECRET: SECRET_A,
      ADMIN_ACCOUNTS: '',
    });
    assert.strictEqual(rebuilt.length, 1);
    assert.strictEqual(await verifyPassword(chosen, rebuilt[0].passwordHash), true,
      'the rebuilt account uses the password the owner chose');
    assert.strictEqual(await verifyPassword(handoff, rebuilt[0].passwordHash), false,
      'the temporary password does NOT come back');
  });
});

test('parseAdminAccounts is unaffected by the writer (no shared-state leak)', () => {
  // The writer must not leave the parser holding a stale path or mutated state.
  const value = `AdminDevs|${ARGON2}|${SECRET_A},AdminPoli|${BCRYPT}|${SECRET_B}`;
  const accounts = parseAdminAccounts(value);
  assert.deepStrictEqual(accounts.map((a) => a.alias), ['AdminDevs', 'AdminPoli']);
});
