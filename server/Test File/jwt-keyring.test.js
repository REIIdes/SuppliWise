/**
 * The JWT verification keyring — the mechanism that makes the audit's oldest
 * URGENT manual action ("rotate JWT_SECRET") actually performable.
 *
 * A keyring has two failure modes worth more than the feature itself:
 *
 *   1. it quietly accepts a token nobody should accept, or
 *   2. the cleanup step after a rotation is unverifiable, so the burned key
 *      stays valid forever and the rotation was cosmetic.
 *
 * So these assert both directions: a token under a retained key DOES verify
 * while the operator says so, and DOES NOT after; the algorithm stays pinned no
 * matter how many keys are in play; and nothing that reaches the monitor can be
 * turned into a signing key.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const keyring = require('../utils/jwtKeyring');

const SERVER = path.resolve(__dirname, '..');
const CURRENT = 'a-current-secret-value-that-is-long-enough-for-this-project';
const RETIRED = 'a-retired-secret-value-from-git-history-that-is-long-enough';
const THIRD = 'another-retired-key-value-which-is-also-long-enough-for-hs256';

function withEnv(values, run) {
  const saved = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    return run();
  } finally {
    for (const key of Object.keys(values)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('a token signed with the current key verifies', () => {
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: '' }, () => {
    const token = jwt.sign({ id: 'user-1' }, CURRENT, { algorithm: 'HS256' });
    assert.equal(keyring.verify(token).id, 'user-1');
  });
});

test('a token signed with a retained key verifies only while it is listed', () => {
  const token = jwt.sign({ id: 'user-2' }, RETIRED, { algorithm: 'HS256' });

  // The overlap window: mid-rotation, a browser still holding the OLD token must
  // not be cut off, or nobody dares rotate a burned secret.
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: RETIRED }, () => {
    assert.equal(keyring.verify(token).id, 'user-2');
  });

  // The step that makes the rotation mean anything: once the retired key is no
  // longer declared, that same token is worthless. A keyring that kept accepting
  // it from a cache would turn "rotated" into a lie.
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: '' }, () => {
    assert.throws(() => keyring.verify(token), /signature/i);
  });
});

test('the deprecated list is read from the environment on every call', () => {
  // envFile can reload the environment while the server runs, and a keyring that
  // froze its candidate list at require time would keep honouring a key the
  // operator has just deleted — the one state that must never persist.
  const token = jwt.sign({ id: 'user-3' }, THIRD, { algorithm: 'HS256' });
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: THIRD }, () => {
    assert.ok(keyring.verify(token));
    process.env.JWT_SECRET_PREVIOUS_KEYS = '';
    assert.throws(() => keyring.verify(token), /signature/i);
  });
});

test('listing several keys never widens the accepted algorithms', () => {
  // This is the trap in a keyring: the loop tries N secrets, and if `algorithms`
  // came from the caller the surface grows from "one secret, HS256" to "N
  // secrets, whatever the token claims". Finding L1 pinned HS256; pinning it per
  // candidate is what keeps that true.
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: `${RETIRED},${THIRD}` }, () => {
    for (const secret of [CURRENT, RETIRED, THIRD]) {
      const hs512 = jwt.sign({ id: 'x' }, secret, { algorithm: 'HS512' });
      assert.throws(() => keyring.verify(hs512), /algorithm/i, 'HS512 must never verify');
    }
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.`
      + `${Buffer.from(JSON.stringify({ id: 'x' })).toString('base64url')}.`;
    assert.throws(() => keyring.verify(unsigned), 'an alg:none token must be refused, not floored through the list');
    // A caller cannot pass a wider list either.
    const callerWidened = jwt.sign({ id: 'x' }, CURRENT, { algorithm: 'HS512' });
    assert.throws(() => keyring.verify(callerWidened, { algorithms: ['HS512', 'HS256'] }), /algorithm/i);
  });
});

test('an expired token still reports expiry, not the last candidate error', () => {
  // middleware/auth.js branches on TokenExpiredError to say "your session
  // expired" instead of "not authorized". With several candidates, the naive
  // implementation reports whichever error came LAST — so this pins the order.
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: RETIRED }, () => {
    const expired = jwt.sign({ id: 'user-4' }, CURRENT, { algorithm: 'HS256', expiresIn: '-1h' });
    assert.throws(() => keyring.verify(expired), (error) => error.name === 'TokenExpiredError');
  });
});

test('a garbage list of previous keys yields no extra trust', () => {
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: ' , ,,   ' }, () => {
    assert.deepEqual(keyring.deprecatedKeys(), []);
    const token = jwt.sign({ id: 'user-5' }, CURRENT, { algorithm: 'HS256' });
    assert.equal(keyring.verify(token).id, 'user-5');
  });
});

test('the current key listed as previous is not counted as a rotation window', () => {
  // An operator pasting the new secret into both variables is a certainty, not a
  // hypothesis. If it counted, the monitor would report "sessions are still
  // riding on a deprecated key" forever and the row would be ignored.
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: `${CURRENT},${RETIRED}` }, () => {
    assert.deepEqual(keyring.deprecatedKeys(), [RETIRED]);
    const fresh = jwt.sign({ id: 'user-6' }, CURRENT, { algorithm: 'HS256' });
    keyring.verify(fresh);
    const riding = keyring.rotationState().acceptances.find((row) => row.accepted > 0);
    assert.ok(!riding || riding.keyId !== keyring.keyId(CURRENT));
  });
});

test('what the monitor can read identifies keys without rebuilding them', () => {
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: RETIRED }, () => {
    const token = jwt.sign({ id: 'user-7' }, RETIRED, { algorithm: 'HS256' });
    keyring.verify(token);
    const state = keyring.rotationState();
    const rendered = JSON.stringify(state);
    assert.ok(state.acceptances.some((row) => row.keyId === keyring.keyId(RETIRED) && row.accepted >= 1),
      'a token accepted under a retained key must be countable, or the cleanup step is invisible');
    for (const secret of [CURRENT, RETIRED]) {
      assert.ok(!rendered.includes(secret), 'the snapshot must carry fingerprints, not key material');
    }
    assert.match(state.currentKeyId, /^[A-Za-z0-9_-]{8}$/, 'short, comparable, unforgable');
  });
});

test('signing never uses a retained key', () => {
  withEnv({ JWT_SECRET: CURRENT, JWT_SECRET_PREVIOUS_KEYS: RETIRED }, () => {
    const minted = keyring.sign({ id: 'user-8' });
    // Proof it came from the current key: the retired key alone must reject it.
    assert.throws(() => jwt.verify(minted, RETIRED, { algorithms: ['HS256'] }), /signature/i);
    assert.equal(keyring.verify(minted).id, 'user-8');
  });
});

test('a rotation is not called safe while data keys hide inside the signing secret', () => {
  // utils/dataKey.js and utils/secretBox.js both fall back to a key derived from
  // JWT_SECRET. Rotating the secret then re-derives the encryption key and every
  // stored health value and sealed authenticator seed stops opening — silent,
  // permanent data loss, which is the failure mode this project has already paid
  // for once. So the safety read must say NO until the previous derived key is
  // declared.
  const derived = keyring.rotationSafety({ dataKeySource: 'derived-from-JWT_SECRET', sealKeySource: 'JWT_SECRET fallback' });
  assert.equal(derived.losesData, true);
  assert.equal(derived.blockers.length, 2, 'both derived sources named');
  assert.match(derived.blockers[0], /HEALTH_DATA_KEY_PREVIOUS/);
  assert.match(derived.blockers[1], /TOTP_ENCRYPTION_KEY_PREVIOUS/);

  const separated = keyring.rotationSafety({ dataKeySource: 'HEALTH_DATA_KEY', sealKeySource: 'TOTP_ENCRYPTION_KEY' });
  assert.equal(separated.losesData, false, 'explicit keys are not tied to the secret being replaced');
});

test('the rotation monitor measures the keyring instead of asserting about it', () => {
  // A row that only restates "secrets should be rotated" is how manualActions[0]
  // stayed urgent for 26 days while the dashboard stayed green.
  const probesSrc = fs.readFileSync(path.join(SERVER, 'utils', 'attack_probes.js'), 'utf8');
  const start = probesSrc.indexOf('jwt_secret_rotation: async ()');
  assert.notEqual(start, -1, 'the probe must exist');
  const body = probesSrc.slice(start, probesSrc.indexOf('jwt_security:', start));
  assert.match(body, /keyring\.rotationState\(\)/, 'reads the live counts');
  assert.match(body, /keyring\.rotationSafety\(/, 'reads whether a rotation would lose data');
  assert.match(body, /status: 'critical'/, 'has a red state');
  assert.match(body, /status: 'warning'/, 'and an amber one');
  // Declared-but-unused overlap keys are the state that turns "rotated" into a
  // false claim, so the probe must not be able to render that as healthy.
  assert.doesNotMatch(body, /deprecatedKeyIds\.length[\s\S]{0,400}status: 'healthy'/,
    'a retained key still in the environment is not a finished rotation');
  assert.match(body, /sourceOf\(/, 'reads the encryption-key sources rather than assuming they are separate');
});

test('every verifier in the server goes through the keyring', () => {
  // The keyring is only a rotation story if there is exactly one door. A route
  // that calls jwt.verify(secret) directly keeps the single-key behaviour — and
  // keeps the outage that stops people rotating in the first place.
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'uploads', '.git'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(js|cjs)$/.test(entry.name)) continue;
      if (/jwtKeyring\.js$/.test(full)) continue;
      if (entry.name.endsWith('.test.js') || entry.name.startsWith('test-')) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/jwt\.verify\s*\(/.test(source)) offenders.push(path.relative(SERVER, full));
    }
  };
  for (const dir of ['middleware', 'routes', 'utils', 'scripts', 'models']) {
    if (fs.existsSync(path.join(SERVER, dir))) walk(path.join(SERVER, dir));
  }
  assert.deepEqual(offenders, [], 'no runtime file may verify a JWT outside utils/jwtKeyring.js');
});
