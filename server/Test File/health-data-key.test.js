'use strict';
/**
 * The key that encrypts data at rest is not the key that mints session tokens.
 *
 * THE BUG THIS EXISTS TO STOP
 * --------------------------
 * Member health blobs and wallet signing keys were sealed under
 * `sha256(process.env.JWT_SECRET)` — the same secret that signs every session
 * token. One secret therefore held two unrelated jobs, and the worse one is
 * permanent: rotating JWT_SECRET stops old tokens being forgeable, but
 * ciphertext written under the old value stays readable with it. So the blast
 * radius of the signing secret was silently the whole database — anyone who
 * obtained it could both claim to be any member AND open every stored health
 * record and wallet key, and keep being able to do the second one forever.
 *
 * The property that makes this shippable is the uncomfortable one: setting the
 * better key must not orphan what the worse key already sealed, or the fix IS
 * the data loss. These tests pin both halves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

const dataKey = require('../utils/dataKey');

const SECRET = 'a-secret-of-fixed-length-that-two-deployments-could-share';
const OTHER = 'b-secret-of-fixed-length-that-two-deployments-could-share';

function withEnv(values, run) {
  const names = Object.keys(values);
  const saved = names.map((n) => process.env[n]);
  try {
    names.forEach((n, i) => {
      if (values[n] === undefined) delete process.env[n]; else process.env[n] = values[n];
    });
    return run();
  } finally {
    names.forEach((n, i) => {
      if (saved[i] === undefined) delete process.env[n]; else process.env[n] = saved[i];
    });
  }
}

/** Seal with one candidate, open through the module's own candidate list. */
const sealWith = (key, text) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64url')).join('.');
};
/**
 * `openWith` answers with the key it used as well as the plaintext, because the
 * callers (health blobs, wallet keys) re-seal under the primary key afterwards.
 * Only the plaintext is a secret, so the test helper drops the key.
 */
const openWith = (envelope) => {
  const opened = dataKey.openWith(envelope, (key) => {
    const [iv, tag, ct] = envelope.split('.').map((part) => Buffer.from(part, 'base64url'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  });
  return opened ? opened.plaintext : null;
};

test('a declared HEALTH_DATA_KEY is the one new data is sealed under', () =>
  withEnv({ JWT_SECRET: SECRET, HEALTH_DATA_KEY: crypto.randomBytes(32).toString('base64') }, () => {
    const d = dataKey.describe();
    assert.equal(d.configured, true);
    assert.equal(d.source, 'HEALTH_DATA_KEY');
    assert.equal(d.available, true);
    assert.match(d.activeKeyId, /^[A-Za-z0-9_-]{8,}$/, 'a key id is reported, not the key');
  }));

test('setting HEALTH_DATA_KEY does not orphan data sealed under JWT_SECRET', () => {
  // The regression this exists to prevent: the deployment does what index.js
  // tells it to and sets the proper key — and every health blob written before
  // that day becomes unreadable, with a GCM tag failure as the only symptom.
  // Refusing to boot would be worse; the answer is to keep every historical key
  // in the decrypt list, which is what `previous` counts.
  const sealed = [];
  withEnv({ JWT_SECRET: SECRET, HEALTH_DATA_KEY: undefined }, () => {
    const legacy = crypto.createHash('sha256').update(SECRET, 'utf8').digest();
    assert.equal(dataKey.candidates().some((c) => c.equals(legacy)), true,
      'precondition: the pre-separation key is the one that sealed the old rows');
    sealed.push([sealWith(legacy, 'haemoglobin 11.2'), 'haemoglobin 11.2']);
    sealed.push([sealWith(
      Buffer.from(crypto.hkdfSync('sha256', Buffer.from(SECRET), Buffer.alloc(0), Buffer.from(dataKey.HKDF_INFO, 'utf8'), 32)),
      'vitamin D 14 ng/mL',
    ), 'vitamin D 14 ng/mL']);
  });

  withEnv({ JWT_SECRET: SECRET, HEALTH_DATA_KEY: crypto.randomBytes(32).toString('base64') }, () => {
    assert.equal(dataKey.describe().configured, true, 'and the new key IS in use for writes');
    assert.equal(openWith(sealed[0][0]), sealed[0][1],
      'ciphertext sealed under sha256(JWT_SECRET) still opens');
    assert.equal(openWith(sealed[1][0]), sealed[1][1],
      'and so does anything sealed under the derived key');
  });
});

test('a declared predecessor key is honoured, with or without a kid= label', () => {
  // Standard base64 of 32 bytes ENDS in '=' padding, so "split on the first ="
  // turns a pasted key into the empty string and the rotation silently does
  // nothing. The documented `k0=<key>` form has to keep working as well.
  const old = crypto.randomBytes(32).toString('base64');
  const envelope = sealWith(Buffer.from(old, 'base64'), 'wallet seed');
  for (const form of [old, `k0=${old}`, `${old},k9=${old}`]) {
    withEnv({ JWT_SECRET: SECRET, HEALTH_DATA_KEY: crypto.randomBytes(32).toString('base64'), HEALTH_DATA_KEY_PREVIOUS: form }, () => {
      assert.equal(openWith(envelope), 'wallet seed', `must parse: ${form.slice(0, 6)}…`);
    });
  }
});

test('a mistyped key is refused, never quietly weakened', () => {
  // Buffer.from(base64) drops characters it does not understand, so a
  // transposed key can decode to 30 bytes — a shorter, different, still-usable
  // buffer. AES-256 needs 32 or the answer is no key at all.
  withEnv({ JWT_SECRET: SECRET, HEALTH_DATA_KEY: crypto.randomBytes(30).toString('base64') }, () => {
    assert.equal(dataKey.describe().source, 'derived-from-JWT_SECRET',
      'a wrong-length HEALTH_DATA_KEY must not be adopted');
  });
  assert.equal(dataKey.parseKeyMaterial(''.padEnd(64, 'z')), null, 'not even a hex-shaped non-hex string');
  assert.equal(dataKey.parseKeyMaterial(crypto.randomBytes(32).toString('hex')).length, 32, 'hex is accepted');
});

test('no secret material appears in what the dashboard may read', () => {
  const key = crypto.randomBytes(32);
  withEnv({ JWT_SECRET: SECRET, HEALTH_DATA_KEY: key.toString('base64') }, () => {
    const reported = JSON.stringify(dataKey.describe());
    assert.ok(!reported.includes(key.toString('base64')), 'describe() must not echo a key');
    assert.ok(!reported.includes(SECRET), 'nor the signing secret it replaced');
  });
});

test('the key fingerprint is a hash of the key, not of its length', () => {
  // Two 32-byte keys always print as the same length; a fingerprint that reused
  // that would make `previous` dedup collide and hide a rotation that had just
  // orphaned everything.
  const a = crypto.randomBytes(32);
  const b = Buffer.alloc(32, 7);
  assert.notEqual(dataKey.fingerprint(a), dataKey.fingerprint(b));
  assert.equal(dataKey.fingerprint(a), dataKey.fingerprint(Buffer.from(a)), 'stable for the same key');
});

test('with no secret at all there is no key, and nothing pretends otherwise', () => {
  // An empty candidate list means encryption cannot happen; the module reports
  // that instead of throwing at the first health write, and index.js warns at
  // boot. A probe that read `available: true` here would be the bug.
  withEnv({ JWT_SECRET: undefined, HEALTH_DATA_KEY: undefined, HEALTH_DATA_KEY_PREVIOUS: undefined }, () => {
    const d = dataKey.describe();
    assert.equal(d.available, false);
    assert.equal(d.source, 'none');
    assert.equal(d.candidates, 0);
    assert.equal(dataKey.primary(), null);
    assert.equal(dataKey.openWith('whatever', () => 'should never run'), null);
  });
});

test('the data-at-rest helpers take no secret argument, so JWT_SECRET cannot be reached for again', () => {
  // `encrypt(JSON.stringify(x), process.env.JWT_SECRET)` was the call site, and
  // a caller can only make that mistake if the API offers it. sealData/openData
  // read the key themselves, and an envelope written the OLD way still opens.
  const crypto2 = require('../blockchain/crypto');
  const sealed = crypto2.sealData('haemoglobin 11.2');
  assert.equal(crypto2.openData(sealed), 'haemoglobin 11.2');
  assert.notEqual(sealed.iv, crypto2.sealData('haemoglobin 11.2').iv, 'a fresh nonce every seal');

  withEnv({ JWT_SECRET: SECRET, HEALTH_DATA_KEY: undefined }, () => {
    const legacy = crypto2.encrypt('my wallet signing key', SECRET);
    assert.equal(crypto2.openData(legacy), 'my wallet signing key',
      'a blob sealed under the signing secret before the separation still opens');
  });

  const src = fs.readFileSync(path.resolve(__dirname, '../blockchain/crypto.js'), 'utf8');
  const body = src.slice(src.indexOf('function sealData'), src.indexOf('function openData'));
  assert.doesNotMatch(body, /process\.env\.JWT_SECRET/, 'the write path never reads the signing secret (its error text may name it as advice)');
  assert.equal(crypto2.sealData.length, 1, 'and it accepts no secret parameter at all');
});

test('the boot path warns instead of refusing, and says why in code', () => {
  // Structural, because the decision is the interesting part: refusing to boot
  // over a shared secret would turn a key-hygiene gap into an outage of a system
  // whose ciphertext predates the separation. So index.js warns, and the row in
  // the Security Center says the same thing.
  const src = fs.readFileSync(path.resolve(__dirname, '../index.js'), 'utf8');
  assert.match(src, /if \(!dataKeyInfo\.configured\) \{\s*\n\s*console\.warn/,
    'the gap is announced, not fatal');
  assert.match(src, /HEALTH_DATA_KEY is not set/);
  assert.doesNotMatch(src, /throw new Error\([^)]*HEALTH_DATA_KEY/, 'no boot refusal on the data key');
  assert.match(src, /CHAIN_SEAL_KEY/, 'and the ledger seal key is separated the same way');
});
