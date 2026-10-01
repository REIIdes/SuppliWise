/**
 * Detecting credentials this server cannot use.
 *
 * Run: npm test
 *
 * The failure this replaces, from a real screenshot: the reload banner read
 * "Reloaded server/.env. Applied LLAMA_API_KEY." — true, and useless. It
 * reported what reached `process.env`, not what the application can do with it,
 * so a key no route reads got the same confirmation as one wired to a feature.
 *
 * The two things pinned here:
 *
 *   1. It must find a genuinely dead key, and must NOT report a live one as
 *      dead. The first version of the scan matched only literal
 *      `process.env.NAME` accesses and consequently reported GROQ_API_KEY,
 *      OPENAI_API_KEY and ANTHROPIC_API_KEY as unreadable — because the
 *      registry reads them DYNAMICALLY through `env[provider.envKey]`. That is
 *      the opposite failure and just as misleading, so both directions are
 *      tested against this repo's real source.
 *
 *   2. `unrouted` is a different problem from `unknown`, and an operator's next
 *      action differs: one key does nothing at all, the other is a working
 *      credential that is merely pointed at nothing.
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  CREDENTIAL_PATTERN,
  scanEnvUsage,
  claimedCredentialNames,
  findUnusableKeys,
  clearUsageCache,
} = require('../utils/envUsage.js');

const { AI_PROVIDERS, providerUsage } = require('../utils/aiProviders.js');

beforeEach(() => {
  clearUsageCache();
});

test('the scan finds the env vars this server actually reads', () => {
  const used = scanEnvUsage({ force: true });
  // Read through the registry, not literally — but genuinely read at runtime.
  for (const name of claimedCredentialNames()) {
    assert.ok(used.has(name) || AI_PROVIDERS.some((p) => p.envKey === name),
      `${name} should be recognised as read`);
  }
  // Read literally, and a name no test could invent.
  assert.ok(used.has('JWT_SECRET'), 'JWT_SECRET is read as process.env.JWT_SECRET');
  assert.ok(used.has('MONGO_URI'), 'MONGO_URI is read as process.env.MONGO_URI');
  assert.ok(used.has('PORT'), 'PORT is read as process.env.PORT');
  assert.ok(used.size > 20, `expected a real scan, saw ${used.size} names`);
});

test('no live provider key is ever reported as unusable', () => {
  // The regression this pins: a literal-only scan called all three of these
  // dead, which is the exact lie this module exists to stop.
  const env = {};
  for (const provider of AI_PROVIDERS) env[provider.envKey] = 'a-real-looking-key';
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  try {
    const dead = findUnusableKeys({ env, force: true });
    const names = dead.map((d) => d.name);
    for (const provider of AI_PROVIDERS) {
      // A provider WITH a routed purpose is never reported at all.
      const usage = providerUsage(provider);
      if (usage) {
        assert.equal(names.includes(provider.envKey), false,
          `${provider.envKey} is routed to "${usage}" but was called dead`);
      }
    }
    // …and none of them may be reported as `unknown`, which would mean the scan
    // failed to recognise a provider the registry plainly declares.
    for (const item of dead) {
      assert.notEqual(item.state, 'unknown', `${item.name} is a registered provider, not an unknown key`);
    }
  } finally {
    delete process.env.OPENROUTER_API_KEY;
  }
});

test('a key nothing uses is reported as unknown', () => {
  const dead = findUnusableKeys({
    env: { SOME_VENDOR_API_KEY: 'sk_something', JWT_SECRET: 'x', PORT: '5000' },
    force: true,
  });
  const item = dead.find((d) => d.name === 'SOME_VENDOR_API_KEY');
  assert.ok(item, 'a key no provider claims must be found');
  assert.equal(item.state, 'unknown');
  assert.match(item.reason, /nothing in the source reads it/i);
});

test('the self-hosted gateway key is recognised, and reported as unrouted', () => {
  // LLAMA_API_KEY is what the reload banner reported as "applied" while doing
  // nothing. It is now a registered provider, so it moves from `unknown` to
  // `unrouted` — a real credential, probed for health, pointed at no feature.
  // It is the one shipped provider with no purpose, which is correct: it is
  // self-hosted, so it has no address and no model until an operator supplies
  // both, and inventing a purpose for it would dispatch health content to a
  // machine that may not exist.
  const llama = AI_PROVIDERS.find((p) => p.key === 'llama');
  assert.ok(llama, 'the gateway is a registered provider');
  assert.equal(providerUsage(llama), null, 'but no feature is routed to it yet');

  const dead = findUnusableKeys({ env: { LLAMA_API_KEY: 'LLM_real' }, force: true });
  const item = dead.find((d) => d.name === 'LLAMA_API_KEY');
  assert.ok(item, 'an unrouted key is still surfaced');
  assert.equal(item.state, 'unrouted', 'it is a known provider, not an unknown key');
  assert.match(item.reason, /no feature is routed to it/i);
});

test('a provider a feature is routed to is never reported as unrouted', () => {
  // This is the bug the whole notice existed to describe, now asserted as its
  // opposite: OpenAI used to be probed for health with nothing dispatching to it,
  // which produced a red "1 credential not wired to any feature" banner on a
  // completely healthy deployment. Polish is routed there now, so the claim is
  // false and the key must not be reported.
  //
  // The claim is read from the routing table rather than a string written beside
  // the provider, so it cannot drift back — this test fails if it ever does.
  const openai = AI_PROVIDERS.find((p) => p.key === 'openai');
  assert.ok(providerUsage(openai), 'OpenAI now serves a real purpose');

  const dead = findUnusableKeys({ env: { [openai.envKey]: 'sk-real' }, force: true });
  assert.equal(
    dead.some((d) => d.name === openai.envKey), false,
    'a key the product actually spends was reported as doing nothing',
  );
});

test('only credential-shaped variables are considered', () => {
  // Configuration is not a credential, and burying the one line an admin needs
  // under PORT and MONGO_URI would make the notice useless.
  assert.equal(CREDENTIAL_PATTERN.test('LLAMA_API_KEY'), true);
  assert.equal(CREDENTIAL_PATTERN.test('ANTHROPIC_API_KEY'), true);
  assert.equal(CREDENTIAL_PATTERN.test('API_KEY'), true, 'a bare API_KEY is still a credential');
  assert.equal(CREDENTIAL_PATTERN.test('PORT'), false);
  assert.equal(CREDENTIAL_PATTERN.test('MONGO_URI'), false);
  assert.equal(CREDENTIAL_PATTERN.test('JWT_SECRET'), false);
  assert.equal(CREDENTIAL_PATTERN.test('SOME_DEAD_KEY'), false, 'a generic key is not a credential');
  assert.equal(CREDENTIAL_PATTERN.test('lowercase_api_key'), false);
  assert.equal(CREDENTIAL_PATTERN.test(''), false);

  const dead = findUnusableKeys({
    env: {
      PORT: '5000', MONGO_URI: 'mongodb://x', JWT_SECRET: 'y',
      SOME_DEAD_KEY: 'z',              // a generic key, not a credential
      SOME_DEAD_API_KEY: 'z2',         // genuinely credential-shaped and unused
    },
    force: true,
  });
  assert.deepEqual(dead.map((d) => d.name), ['SOME_DEAD_API_KEY'],
    'only credential-shaped names should ever be reported');
});

test('an empty environment reports nothing', () => {
  assert.deepEqual(findUnusableKeys({ env: {}, force: true }), []);
});

test('results are sorted and carry no values', () => {
  const dead = findUnusableKeys({
    env: { ZZZ_API_KEY: 'secret-z', AAA_API_KEY: 'secret-a', JWT_SECRET: 'secret-j' },
    force: true,
  });
  assert.deepEqual(dead.map((d) => d.name), ['AAA_API_KEY', 'ZZZ_API_KEY']);
  // A value must never travel with the name — this payload is rendered to an
  // admin panel and logged on reload.
  const wire = JSON.stringify(dead);
  assert.equal(wire.includes('secret-a'), false);
  assert.equal(wire.includes('secret-z'), false);
  assert.equal(wire.includes('secret-j'), false);
});

test('the scan is cached, and a forced scan re-reads', () => {
  const first = scanEnvUsage();
  assert.equal(scanEnvUsage(), first, 'an unforced scan must reuse the cache');
  const forced = scanEnvUsage({ force: true });
  assert.notEqual(forced, first, 'a forced scan must produce a fresh set');
});

test('the scan finds this server\'s own routed provider variables', () => {
  // End-to-end against the REAL .env on this machine: whatever is actually
  // configured, nothing routed may be flagged, and the result is reported by
  // name only.
  const dead = findUnusableKeys({ force: true });
  const routed = AI_PROVIDERS.filter((p) => providerUsage(p)).map((p) => p.envKey);
  for (const name of routed) {
    assert.equal(dead.some((d) => d.name === name), false,
      `${name} is routed to "${providerUsage(name)}" yet was flagged`);
  }
  // And every finding must be a dead key, not a live one.
  for (const item of dead) {
    assert.ok(CREDENTIAL_PATTERN.test(item.name));
    assert.ok(item.reason && item.reason.length > 20, 'a finding must explain itself');
  }
});
