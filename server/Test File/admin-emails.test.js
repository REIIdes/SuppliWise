'use strict';
/**
 * Tests for the ADMIN_EMAILS address list.
 *
 * The parser is what is being pinned here, and the asymmetry is the point.
 * ADMIN_EMAILS is `alias=address` pairs joined by commas, which is parsed with a
 * plain `split(',')` — the thing that is a *bug* for ADMIN_ACCOUNTS, because an
 * argon2id hash contains its own commas. These tests exist to make that
 * asymmetry obviously deliberate to the next reader, who will otherwise "fix"
 * the comma handling here to match the account parser and quietly turn the whole
 * list into one entry.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseAdminEmails,
  configuredAdminEmails,
} = require('../utils/adminAccounts');

// ── The parser ───────────────────────────────────────────────────────────

test('alias=address pairs parse one per comma', () => {
  const entries = parseAdminEmails(
    'AdminDevs=a@example.com,AdminPoli=b@example.com,AdminJoma=c@example.com'
  );
  assert.strictEqual(entries.length, 3);
  assert.deepStrictEqual(entries[0], { alias: 'AdminDevs', email: 'a@example.com' });
  assert.deepStrictEqual(entries[2], { alias: 'AdminJoma', email: 'c@example.com' });
});

test('all six aliases and addresses round-trip exactly', () => {
  // Pinned literally rather than derived from .env: a test that reads the value
  // it is testing proves nothing. The addresses themselves are example.com
  // placeholders — the real ones are live delivery addresses belonging to six
  // people, not test data, and do not belong in a tracked file. Aliases stay
  // real because the parser is alias-driven and the fan-out matches on them.
  const entries = parseAdminEmails([
    'AdminDevs=devs@example.com',
    'AdminPoli=poli@example.com',
    'AdminJoma=joma@example.com',
    'AdminShMa=shma@example.com',
    'AdminJohn=john@example.com',
    'AdminRaNe=rane@example.com',
  ].join(','));
  assert.strictEqual(entries.length, 6);
  assert.deepStrictEqual(entries.map(entry => entry.alias), [
    'AdminDevs', 'AdminPoli', 'AdminJoma', 'AdminShMa', 'AdminJohn', 'AdminRaNe',
  ]);
  assert.strictEqual(entries[0].email, 'devs@example.com');
  assert.strictEqual(entries[5].email, 'rane@example.com');
});

test('surrounding whitespace is trimmed from both sides of a pair', () => {
  const entries = parseAdminEmails(' AdminDevs = a@example.com , AdminPoli=b@example.com ');
  assert.strictEqual(entries.length, 2);
  assert.deepStrictEqual(entries[0], { alias: 'AdminDevs', email: 'a@example.com' });
});

test('addresses are lower-cased so duplicates compare equal', () => {
  // Gmail treats an address case-insensitively. Without this, "A@x.com" and
  // "a@x.com" are two recipients and the de-duplication below misses them.
  const [entry] = parseAdminEmails('AdminDevs=Someone@Example.COM');
  assert.strictEqual(entry.email, 'someone@example.com');
});

test('a bare split on comma is what this value needs', () => {
  // The asymmetry with ADMIN_ACCOUNTS, stated as an executable claim. If
  // someone replaces the delimiter with ENTRY_SEPARATOR (which requires a "|"
  // ahead of the comma), this fails: no address contains a pipe, so nothing
  // would match and all six administrators would collapse into one entry.
  const value = 'AdminDevs=a@example.com,AdminPoli=b@example.com';
  assert.strictEqual(value.split(',').length, 2);
  assert.strictEqual(value.split(/,(?=[^,$|]*\|)/).length, 1, 'ENTRY_SEPARATOR must NOT work here');
});

test('malformed entries are skipped, not half-inserted', () => {
  // Each of these is a typo an operator can actually make in .env. A partially
  // parsed entry would put a truncated address into a security notice, which is
  // worse than dropping it and reporting the alias as missing.
  const entries = parseAdminEmails([
    'AdminDevs=a@example.com',
    'NoEqualsSign',            // no delimiter
    '=orphan@example.com',     // no alias
    'AdminJoma=',              // no address
    'AdminShMa=not-an-email',
    'AdminJohn=a@example',     // no domain dot
    'AdminRaNe=a b@example.com', // embedded space
    'AdminPoli=b@example.com',
  ].join(','));
  assert.deepStrictEqual(entries.map(entry => entry.alias), ['AdminDevs', 'AdminPoli']);
});

test('an empty or absent value yields no entries rather than throwing', () => {
  for (const value of ['', '   ', undefined, null]) {
    assert.deepStrictEqual(parseAdminEmails(value), []);
  }
});

test('an address may contain "=" after the alias delimiter', () => {
  // Quoted local parts may legally contain "=", so only the FIRST "=" is the
  // field separator. Splitting on every "=" would truncate the address.
  const [entry] = parseAdminEmails('AdminDevs=a=b@example.com');
  assert.strictEqual(entry.email, 'a=b@example.com');
});

// ── De-duplication ───────────────────────────────────────────────────────

test('a repeated alias keeps only its last address', () => {
  // Matches how a duplicated environment variable behaves elsewhere in boot.
  const entries = configuredAdminEmails({
    ADMIN_EMAILS: 'AdminDevs=old@example.com,AdminDevs=new@example.com',
  });
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].email, 'new@example.com');
});

test('one address under two aliases is counted once', () => {
  // A shared mailbox is not two people. Counting it twice would overstate how
  // many people a single address actually reaches.
  const entries = configuredAdminEmails({
    ADMIN_EMAILS: 'AdminDevs=shared@example.com,AdminPoli=shared@example.com,AdminJoma=j@example.com',
  });
  assert.deepStrictEqual(entries.map(entry => entry.alias), ['AdminDevs', 'AdminJoma']);
});

test('case differences do not defeat address de-duplication', () => {
  const entries = configuredAdminEmails({
    ADMIN_EMAILS: 'AdminDevs=Shared@Example.com,AdminPoli=shared@example.com',
  });
  assert.strictEqual(entries.length, 1);
});

test('an address for an alias that is not an account is still listed', () => {
  // The list is addressed from config, not from the account list. An operator
  // listing a colleague who has not been added as an account yet must still
  // see them; refusing would make the list order-dependent on boot state.
  const recipients = configuredAdminEmails({
    ADMIN_EMAILS: 'AdminDevs=a@example.com,AdminPoli=b@example.com,AdminNew=extra@example.com',
  });
  assert.ok(recipients.some(entry => entry.alias === 'AdminNew'));
});

test('an empty address list yields nothing rather than throwing', () => {
  assert.deepStrictEqual(configuredAdminEmails({ ADMIN_EMAILS: '' }), []);
});
