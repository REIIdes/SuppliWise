/**
 * AI provider health checks — the data behind the admin dashboard's
 * "Connected AI providers" panel.
 *
 * Run: npm test
 *
 * Why this exists: the panel used to render `Boolean(process.env.X_API_KEY)`
 * as "Configured", which only proves an environment variable exists. It showed
 * an OpenAI key that no route in this server even reads as if it were live AI,
 * and it printed the literal string "not configured" into the model line of a
 * card that said "Configured" above it. These tests pin the three things that
 * made the panel lie:
 *
 *   1. a placeholder key must not read as configured;
 *   2. a missing model must be null, never a placeholder sentence;
 *   3. "Reachable" must come from a real request, and must never leak the key
 *      that made it.
 *
 * `fetch` is stubbed throughout — nothing here touches the network, and node's
 * test runner gives each file its own process, so mutating `globalThis.fetch`
 * and `process.env` cannot bleed into other suites.
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_PROVIDERS,
  AI_CHECK_TTL_MS,
  isPlaceholderKey,
  resolveKey,
  resolveModel,
  resolveEndpoints,
  providerUsage,
  readModelIds,
  describeModels,
  checkAiProvider,
  getAiProviders,
  clearAiCheckCache,
  oldestCheck,
} = require('../utils/aiProviders.js');

const byKey = (key) => {
  const provider = AI_PROVIDERS.find((entry) => entry.key === key);
  assert.ok(provider, `expected a provider registered as "${key}"`);
  return provider;
};

/** Replace global fetch with a stub; returns the calls it received. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const response = await handler(url, options);
    calls.push({ url, options });
    return response;
  };
  return calls;
}

/** Run a list of cases with a clean cache and a clean set of provider env vars.
 *
 * `await fn()` matters: without it the `finally` would restore `process.env`
 * the moment `fn()` hands back its promise — i.e. before any `await` inside the
 * body had run — and the assertions would execute against a scrubbed
 * environment. That made two of these tests pass for the wrong reason. */
async function withCleanProviderEnv(fn) {
  const touched = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY',
    'OPENROUTER_MODEL', 'OPENAI_MODEL', 'GROQ_MODEL', 'ANTHROPIC_MODEL'];
  const saved = touched.map((name) => [name, process.env[name]]);
  for (const name of touched) delete process.env[name];
  clearAiCheckCache();
  try {
    return await fn();
  } finally {
    clearAiCheckCache();
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

after(() => {
  delete globalThis.fetch;
});

/**
 * The routing table (utils/aiRouter.js) dispatches completions using metadata
 * declared here, and it requires `chatCompatible === true`. A missing flag reads
 * as "cannot be routed to", so a provider that forgot to declare one is refused
 * by name and every feature on it silently falls back — the exact failure this
 * repository already hit once, when Groq answered 200 with 11 models while no
 * route in the server called it.
 */
test('a provider is routable only if it declares itself completions-capable', () => {
  for (const provider of AI_PROVIDERS) {
    if (provider.chatCompatible === true) {
      // Declared compatible -> it must supply somewhere to POST to, either
      // statically (a public SaaS) or from configuration (a self-hosted
      // gateway, whose address is not knowable in advance).
      const staticUrl = typeof provider.chatUrl === 'string' && provider.chatUrl.length > 0;
      const configuredUrl = typeof provider.baseUrlEnv === 'string' && provider.baseUrlEnv.length > 0;
      assert.ok(staticUrl || configuredUrl,
        `${provider.key} is routable but has neither a chatUrl nor a baseUrlEnv to build one from`);
      if (staticUrl) {
        assert.ok(provider.chatUrl.startsWith('https://'),
          `${provider.key} is a public provider, so its chatUrl must be https`);
        assert.equal(provider.baseUrlEnv, undefined,
          `${provider.key} has both a static url and a configurable base, so the two can disagree`);
      }
      continue;
    }
    // Anything else must be explicitly excluded, not merely undeclared.
    assert.equal(
      provider.chatCompatible, false,
      `${provider.key} has no chatCompatible flag; an undeclared provider is refused by the router`
    );
  }
});

test('the providers this server actually calls are completions-capable', () => {
  // OpenRouter is the default for the plan/detail features and the chat
  // fallback, Anthropic serves chat and priority flagging, Groq backs system
  // detection, OpenAI serves description polish. If any of these stops being
  // routable, its features degrade to a fallback while the panel still shows the
  // key as "Reachable".
  for (const key of ['openrouter', 'anthropic', 'groq', 'openai']) {
    assert.equal(byKey(key).chatCompatible, true, `${key} must remain routable`);
  }
});

test('every provider a FEATURE is routed to resolves a model to call', () => {
  // Scoped to the routed set on purpose. An unrouted provider with no model is
  // legitimate — the self-hosted gateway is probed for health and nothing is
  // dispatched to it, and inventing a model id a gateway might not serve would
  // be worse than reporting none. What must never happen is a provider that a
  // real feature depends on resolving to no model, because then the router
  // refuses every call to it and the feature silently falls back.
  const { AI_ROUTES } = require('../utils/aiRouter.js');
  for (const route of AI_ROUTES) {
    const provider = AI_PROVIDERS.find((p) => p.key === route.provider);
    assert.ok(provider, `${route.purpose} points at unknown provider "${route.provider}"`);
    assert.notEqual(
      resolveModel(provider), null,
      `${route.purpose} is routed to ${provider.key}, which resolves to no model`
    );
  }
});

test('a self-hosted provider resolves its endpoints from the environment', () => withCleanProviderEnv(() => {
  // There is no public hostname for a LiteLLM/Ollama/vLLM gateway, so the base
  // URL is configuration. Guessing a host would send a real credential to an
  // unverified place on every 10 s poll.
  const llama = byKey('llama');
  assert.equal(llama.baseUrlEnv, 'LLAMA_BASE_URL');
  assert.equal(llama.url, undefined, 'a self-hosted entry must not carry a hard-coded URL');
  assert.equal(llama.chatUrl, undefined);
  assert.equal(llama.wire, 'openai', 'these gateways speak the OpenAI wire format');
  assert.equal(llama.chatCompatible, true);
  assert.equal(llama.defaultModel, null, 'there is no honest default for a gateway we cannot see');
}));

test('every shape of a pasted gateway URL resolves to the same endpoint', () => withCleanProviderEnv(() => {
  const llama = byKey('llama');
  // Operators paste these differently and a trailing slash or a /v1 suffix must
  // not produce /v1/v1/models. A bare host:port is given a scheme.
  const expected = {
    url: 'http://localhost:4000/v1/models',
    chatUrl: 'http://localhost:4000/v1/chat/completions',
  };
  for (const raw of [
    'http://localhost:4000',
    'http://localhost:4000/',
    'http://localhost:4000/v1',
    'http://localhost:4000/v1/',
    '  http://localhost:4000  ',
  ]) {
    const resolved = resolveEndpoints(llama, { LLAMA_BASE_URL: raw });
    assert.equal(resolved.chatUrl, expected.chatUrl, `"${raw}" resolved differently`);
    assert.equal(resolved.url, expected.url, `"${raw}" resolved differently`);
  }
  // A bare host:port is assumed http, which is what a self-hosted box is.
  const bare = resolveEndpoints(llama, { LLAMA_BASE_URL: '10.0.0.5:8080' });
  assert.equal(bare.baseUrl, 'http://10.0.0.5:8080');
  assert.equal(bare.chatUrl, 'http://10.0.0.5:8080/v1/chat/completions');
  // An explicit https scheme is preserved, not downgraded.
  const tls = resolveEndpoints(llama, { LLAMA_BASE_URL: 'https://llm.internal.corp' });
  assert.equal(tls.baseUrl, 'https://llm.internal.corp');
}));

test('a missing gateway address is a nameable error, not a crash', () => withCleanProviderEnv(() => {
  const llama = byKey('llama');
  const missing = resolveEndpoints(llama, {});
  assert.equal(missing.url, null);
  assert.equal(missing.chatUrl, null);
  assert.match(missing.error, /LLAMA_BASE_URL/);

  // A static provider is untouched by the whole mechanism.
  const staticOne = resolveEndpoints(byKey('groq'), {});
  assert.equal(staticOne.url, 'https://api.groq.com/openai/v1/models');
  assert.equal(staticOne.error, null);
  assert.equal(staticOne.baseUrl, null);
}));

test('a gateway with no address reports unconfigured rather than a crash', () =>
  withCleanProviderEnv(async () => {
    process.env.LLAMA_API_KEY = 'LLM_real';
    const calls = stubFetch(() => { throw new Error('must not be called'); });

    const outcome = await checkAiProvider(byKey('llama'));
    assert.equal(outcome.status, 'unconfigured');
    assert.equal(calls.length, 0, 'there is no address to call, so nothing is called');
    assert.match(outcome.detail, /LLAMA_BASE_URL/);
  }));

test('an unreachable gateway names the address it tried', () => withCleanProviderEnv(async () => {
  process.env.LLAMA_API_KEY = 'LLM_real';
  process.env.LLAMA_BASE_URL = 'http://127.0.0.1:59999';
  try {
    stubFetch(async () => { throw new Error('fetch failed'); });
    const outcome = await checkAiProvider(byKey('llama'));
    assert.equal(outcome.status, 'unreachable');
    // The address is the most likely thing to be wrong, so "fetch failed" on
    // its own is not enough to act on.
    assert.match(outcome.detail, /127\.0\.0\.1:59999/);
  } finally {
    delete process.env.LLAMA_BASE_URL;
  }
}));

test('a key without a model is not dispatchable, by design', () => withCleanProviderEnv(() => {
  // The gateway is probed (so the operator learns it is alive) but nothing is
  // routed to it, so no purpose should resolve to it. The card says "No model
  // selected" rather than inventing an id a gateway might not serve.
  const llama = byKey('llama');
  assert.equal(providerUsage(llama), null, 'no feature is routed to the gateway yet');
  assert.equal(llama.verifyModel, true, 'but its model list is still checked');
  assert.equal(resolveModel(llama), null);
  process.env.LLAMA_MODEL = 'llama-3.3-70b-instruct';
  assert.equal(resolveModel(llama), 'llama-3.3-70b-instruct', 'an operator can still choose one');
}));

/**
 * The one invariant that stops this panel lying again.
 *
 * `usedBy` used to be a hand-written string beside each provider, and it drifted:
 * the card described call sites that had been moved months earlier while the real
 * assignments were invisible. Deriving it from the routing table is the fix, and
 * a fix nothing checks decays back into the bug it replaced — so this asserts
 * the two agree in BOTH directions for every provider, on every run.
 */
test('what a card claims is used for is read from the routing table', () => {
  const { AI_ROUTES } = require('../utils/aiRouter.js');

  for (const provider of AI_PROVIDERS) {
    const usage = providerUsage(provider);
    const routed = AI_ROUTES.filter((route) => route.provider === provider.key);
    if (routed.length > 0) {
      assert.ok(usage, `${provider.key} has ${routed.length} routed purpose(s) but its card claims none`);
      for (const route of routed) {
        assert.ok(usage.includes(route.label),
          `${provider.key} is routed to "${route.label}" but its card does not say so`);
      }
    } else {
      assert.equal(usage, null, `${provider.key} has no routed purpose, so it must not claim one`);
    }
  }
});

/**
 * Spreading the work is the point, so it is asserted rather than assumed.
 *
 * One provider carrying every request is the failure this routing change exists
 * to prevent: it concentrates quota, rate limits and outages on a single key.
 * This asserts both halves — that the traffic really is distributed, and that no
 * provider is a dead credential nothing dispatches to (the `usedBy: null` case
 * that produced the red "not wired to any feature" banner).
 */
test('the AI work is spread rather than piled onto the default provider', () => {
  const { AI_ROUTES, DEFAULT_PROVIDER } = require('../utils/aiRouter.js');

  const serving = new Set(AI_ROUTES.map((route) => route.provider));
  assert.ok(serving.size >= 4,
    `only ${serving.size} provider(s) serve every feature — work is not spread`);

  // The default is the fallback, not the whole product: it must carry strictly
  // fewer than half of the purposes, or "spread" is just a rename.
  const onDefault = AI_ROUTES.filter((route) => route.provider === DEFAULT_PROVIDER).length;
  assert.ok(onDefault < AI_ROUTES.length / 2,
    `${onDefault}/${AI_ROUTES.length} purposes still go to the default provider`);

  // Every real provider except the self-hosted gateway has something to do.
  // A spare credential that nothing dispatches to is exactly what the removed
  // red banner was complaining about, and it must not come back.
  for (const provider of AI_PROVIDERS) {
    if (provider.key === 'llama') continue; // self-hosted: opt-in, addressed by config
    assert.ok(serving.has(provider.key), `${provider.key} is probed but no feature dispatches to it`);
  }
});

test('every provider is registered once, under its own key', () => {
  const keys = AI_PROVIDERS.map((provider) => provider.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate provider keys');
  assert.deepEqual([...keys].sort(), ['anthropic', 'groq', 'llama', 'openai', 'openrouter']);
});

test('the .env.example placeholder is not a credential', () => {
  assert.equal(isPlaceholderKey('your_openai_api_key_here'), true);
  assert.equal(isPlaceholderKey('your_openrouter_api_key_here'), true);
  assert.equal(isPlaceholderKey('  your_groq_api_key_here  '), true, 'must survive trimming');
  assert.equal(isPlaceholderKey('sk-live-abc123'), false);
  assert.equal(isPlaceholderKey(''), false);
  assert.equal(isPlaceholderKey(null), false);
  assert.equal(isPlaceholderKey(undefined), false);
});

test('every credential the shipped .env.example declares is recognised as a placeholder', () => {
  // Read the real file rather than trusting this test's own copy of the names.
  // The shipped values used to be `your_openrouter_api_key` with no `_here`
  // suffix, which isPlaceholderKey() does NOT match — so a fresh clone copied
  // straight from the example would have had its admin panel report a
  // placeholder as a live, configured credential.
  const fs = require('fs');
  const path = require('path');
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');

  const declared = example
    .split(/\r?\n/)
    .map((line) => line.match(/^([A-Z0-9_]*_API_KEY)=(.*)$/))
    .filter(Boolean);

  assert.ok(declared.length >= 4, `expected the example to declare every provider key, saw ${declared.length}`);
  for (const [, name, value] of declared) {
    assert.equal(
      isPlaceholderKey(value), true,
      `${name}=${value} is shipped as a placeholder but would read as a live credential`
    );
  }

  // And the model overrides must be documented rather than silently absent —
  // the panel reports the resolved model, so an operator has to be able to set it.
  for (const name of ['OPENROUTER_MODEL', 'GROQ_MODEL', 'OPENAI_MODEL', 'ANTHROPIC_MODEL']) {
    assert.match(example, new RegExp(`^${name}=`, 'm'), `${name} is undocumented in .env.example`);
  }
});

test('resolveKey drops empties and placeholders, keeps real keys', () => withCleanProviderEnv(() => {
  assert.equal(resolveKey('OPENAI_API_KEY'), null, 'absent');
  process.env.OPENAI_API_KEY = '   ';
  assert.equal(resolveKey('OPENAI_API_KEY'), null, 'whitespace only');
  process.env.OPENAI_API_KEY = 'your_openai_api_key_here';
  assert.equal(resolveKey('OPENAI_API_KEY'), null, 'placeholder');
  process.env.OPENAI_API_KEY = 'sk-real-key';
  assert.equal(resolveKey('OPENAI_API_KEY'), 'sk-real-key', 'trimmed real key');
}));

test('a model is never rendered as the literal "not configured"', () => withCleanProviderEnv(() => {
  // The exact bug this replaces: the OpenAI card said "Configured" on top and
  // "not configured" underneath because OPENAI_MODEL was unset AND the provider
  // had no default. The fix is two-sided — a provider that has a real default
  // reports it, and one that genuinely has no model reports null. Neither ever
  // produces a placeholder sentence.
  assert.equal(resolveModel(byKey('openai')), 'gpt-5.4-nano', 'a provider with a default reports it');
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  assert.equal(resolveModel(byKey('openai')), 'gpt-4o-mini', 'env override wins');

  process.env.OPENAI_MODEL = '  ';
  assert.equal(resolveModel(byKey('openai')), 'gpt-5.4-nano', 'whitespace override falls back to the default, not to null');

  // Every provider now carries a real default, because every provider is
  // routed to by at least one purpose. The "No model selected" bucket used to
  // hold Groq (the reason its card read that way beside a perfectly good key)
  // and then Anthropic; both are now backing real features, so a provider with
  // no default would mean a purpose that silently cannot run.
  assert.equal(
    resolveModel(byKey('anthropic')),
    'claude-haiku-4-5-20251001',
    'Anthropic backs priority flagging and must name a model its key can reach'
  );
  assert.equal(
    resolveModel(byKey('groq')),
    'openai/gpt-oss-120b',
    'Groq backs system detection and must name a model its key can reach'
  );
  // The honest-null case still has to WORK when it occurs — it is just that no
  // shipped provider is in it any more.
  const unroutable = { modelEnv: 'SOME_UNUSED_MODEL_ENV', defaultModel: null };
  assert.equal(resolveModel(unroutable), null, 'no default and no override is still null');

  // OpenRouter's call sites resolve through the routing table, so this is the
  // model every health feature actually sends.
  assert.equal(resolveModel(byKey('openrouter')), 'deepseek/deepseek-v4-flash-0731');

  for (const provider of AI_PROVIDERS) {
    assert.notEqual(resolveModel(provider), 'not configured');
  }
}));

test('every default model is a non-empty string, never a placeholder', () => {
  for (const provider of AI_PROVIDERS) {
    const { defaultModel } = provider;
    if (defaultModel === null) continue; // honest "no model chosen"
    assert.equal(typeof defaultModel, 'string');
    assert.ok(defaultModel.trim().length > 0, `${provider.key} has a blank default model`);
    assert.equal(isPlaceholderKey(defaultModel), false, `${provider.key} default is a placeholder`);
    assert.doesNotMatch(defaultModel, /\s/, `${provider.key} default has whitespace: "${defaultModel}"`);
  }
});

test('a key that works but is pointed at a model it cannot reach is its own state', () =>
  withCleanProviderEnv(async () => {
    process.env.OPENAI_API_KEY = 'sk-real-key';
    process.env.OPENAI_MODEL = 'gpt-does-not-exist';
    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => ({ data: [{ id: 'gpt-5.4-nano' }, { id: 'gpt-4o' }] }),
    }));

    const result = await checkAiProvider(byKey('openai'));

    assert.equal(result.status, 'model-unavailable', 'a 401 is not the only way to be broken');
    assert.equal(result.reachable, true, 'the key itself was accepted');
    assert.equal(result.configured, true);
    assert.equal(result.modelAvailable, false);
    assert.equal(result.modelCount, 2);
    assert.match(result.detail, /gpt-does-not-exist/, 'the offending model is named');
    assert.match(result.detail, /OPENAI_MODEL/, 'the fix is nameable');
  }));

test('a selected model that IS in the list reads as available', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-real-key';
  process.env.OPENAI_MODEL = 'gpt-4o';
  stubFetch(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ data: [{ id: 'gpt-5.4-nano' }, { id: 'gpt-4o' }] }),
  }));

  const result = await checkAiProvider(byKey('openai'));

  assert.equal(result.status, 'ok');
  assert.equal(result.modelAvailable, true);
  assert.equal(result.modelCount, 2);
  assert.match(result.detail, /HTTP 200/);
}));

test('a probe body we cannot parse degrades to "unknown", never to a crash', () =>
  withCleanProviderEnv(async () => {
    process.env.OPENAI_API_KEY = 'sk-real-key';
    process.env.OPENAI_MODEL = 'gpt-4o';
    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => { throw new Error('Unexpected token < in JSON'); },
    }));

    const result = await checkAiProvider(byKey('openai'));

    // An HTML error page from a proxy must not take the admin panel down, and
    // must not be reported as "your model is wrong" either — we learned nothing.
    assert.equal(result.status, 'ok');
    assert.equal(result.modelAvailable, null, 'unknown, not false');
    assert.match(result.detail, /HTTP 200/);
  }));

test('the heavy model list is never read, so OpenRouter cannot time itself out', () =>
  withCleanProviderEnv(async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-real-key';
    let readBody = false;
    stubFetch(async () => ({
      status: 200,
      ok: true,
      json: async () => { readBody = true; return { data: [{ id: 'deepseek/deepseek-v4-flash-0731' }] }; },
    }));

    const result = await checkAiProvider(byKey('openrouter'));

    // openrouter.ai/api/v1/models measured ~752 KB / 10.7 s cold, which cannot
    // fit in AI_PROBE_TIMEOUT_MS. Reading it would make a healthy provider
    // report "Unreachable".
    assert.equal(readBody, false, 'a 752 KB body must not be pulled into a 5 s probe');
    assert.equal(result.status, 'ok');
    assert.equal(result.modelCount, null, 'nothing was read, so nothing is claimed');
  }));

test('the model list never leaks key material into the payload', () => withCleanProviderEnv(async () => {
  const SECRET = 'sk-super-secret-value-do-not-leak';
  process.env.OPENAI_API_KEY = SECRET;
  stubFetch(async () => ({
    status: 200,
    ok: true,
    json: async () => ({ data: [{ id: 'gpt-5.4-nano' }] }),
  }));

  const wire = JSON.stringify(await checkAiProvider(byKey('openai')));
  assert.equal(wire.includes(SECRET), false);
}));

test('describeModels separates "unknown" from "not there"', () => {
  const OPENAI_MODEL = 'OPENAI_MODEL';

  // No list read -> we learned nothing, so nothing may be claimed.
  assert.deepEqual(describeModels('gpt-4o', null, OPENAI_MODEL),
    { modelAvailable: null, modelCount: null, note: '' });

  // A list but no model chosen -> the count is still useful; availability is
  // not something we can answer.
  const noModel = describeModels(null, ['a', 'b'], OPENAI_MODEL);
  assert.equal(noModel.modelAvailable, null);
  assert.equal(noModel.modelCount, 2);
  assert.match(noModel.note, /2 models available/);

  const present = describeModels('a', ['a', 'b'], OPENAI_MODEL);
  assert.equal(present.modelAvailable, true);
  assert.equal(present.modelCount, 2);
  assert.doesNotMatch(present.note, /but/, 'a working model gets no warning');

  const missing = describeModels('zzz', ['a', 'b'], OPENAI_MODEL);
  assert.equal(missing.modelAvailable, false);
  assert.match(missing.note, /"zzz"/, 'names the bad model');
  assert.match(missing.note, /OPENAI_MODEL/, 'names the var to fix');
});

test('readModelIds tolerates every shape a bad response can take', async () => {
  // A panel must never die because a proxy returned HTML or a stub has no body.
  assert.equal(await readModelIds(null), null);
  assert.equal(await readModelIds({ status: 200, ok: true }), null, 'no json() -> unknown');
  assert.equal(await readModelIds({ json: async () => null }), null);
  assert.equal(await readModelIds({ json: async () => ({}) }), null, 'no data array');
  assert.equal(await readModelIds({ json: async () => ({ data: 'nope' }) }), null, 'data not an array');
  assert.equal(await readModelIds({ json: async () => { throw new Error('bad json'); } }), null);

  // Real payload, including the ragged rows a provider can return.
  const ids = await readModelIds({
    json: async () => ({ data: [{ id: 'gpt-4o' }, { id: '  gpt-5.4-nano  ' }, null, { name: 'no id' }, { id: 7 }] }),
  });
  assert.deepEqual(ids, ['gpt-4o', 'gpt-5.4-nano'], 'trimmed, blanks dropped, ragged rows skipped');
});

test('an absent key reports unconfigured without making a request', () => withCleanProviderEnv(async () => {
  const calls = stubFetch(() => { throw new Error('must not be called'); });

  const result = await checkAiProvider(byKey('groq'));

  assert.equal(result.status, 'unconfigured');
  assert.equal(result.configured, false);
  assert.equal(result.reachable, false);
  assert.equal(result.latencyMs, null);
  assert.match(result.detail, /GROQ_API_KEY/, 'the fix should name the env var to set');
  assert.equal(calls.length, 0, 'no key means nothing to send');
  assert.ok(result.checkedAt, 'a check must always carry a timestamp');
}));

test('a placeholder key is treated as unconfigured, not as a live credential', () => withCleanProviderEnv(async () => {
  process.env.ANTHROPIC_API_KEY = 'your_anthropic_api_key_here';
  stubFetch(() => { throw new Error('must not be called'); });

  const result = await checkAiProvider(byKey('anthropic'));

  assert.equal(result.status, 'unconfigured');
  assert.equal(result.configured, false);
}));

test('a 200 answers Reachable with the latency it saw', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-real-key';
  stubFetch(async () => ({ status: 200, ok: true }));

  const result = await checkAiProvider(byKey('openai'));

  assert.equal(result.status, 'ok');
  assert.equal(result.configured, true);
  assert.equal(result.reachable, true);
  assert.equal(typeof result.latencyMs, 'number');
  assert.match(result.detail, /HTTP 200/);
}));

test('a rejected key is its own state, not a generic error', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-revoked';
  stubFetch(async () => ({ status: 401, ok: false }));

  const result = await checkAiProvider(byKey('openai'));

  assert.equal(result.status, 'rejected');
  assert.equal(result.reachable, true, 'the host answered — the key did not');
  assert.match(result.detail, /rotate OPENAI_API_KEY/);
}));

test('a 403 is also a rejection (permission, not reachability)', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-no-scope';
  stubFetch(async () => ({ status: 403, ok: false }));

  const result = await checkAiProvider(byKey('openai'));
  assert.equal(result.status, 'rejected');
}));

test('a 5xx is an error but the host was still reached', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-real-key';
  stubFetch(async () => ({ status: 503, ok: false }));

  const result = await checkAiProvider(byKey('openai'));

  assert.equal(result.status, 'error');
  assert.equal(result.reachable, true);
  assert.match(result.detail, /HTTP 503/);
}));

test('an aborted probe reports a timeout rather than throwing', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-real-key';
  stubFetch(async () => {
    const error = new Error('The operation was aborted');
    error.name = 'AbortError';
    throw error;
  });

  const result = await checkAiProvider(byKey('openai'));

  assert.equal(result.status, 'unreachable');
  assert.equal(result.reachable, false);
  assert.match(result.detail, /timed out/);
}));

test('a network failure reports unreachable rather than rejecting the route', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-real-key';
  stubFetch(async () => { throw new Error('ECONNREFUSED'); });

  const result = await checkAiProvider(byKey('openai'));

  assert.equal(result.status, 'unreachable');
  assert.match(result.detail, /ECONNREFUSED/);
}));

test('the secret is never returned to the client', () => withCleanProviderEnv(async () => {
  const SECRET = 'sk-super-secret-value-do-not-leak';
  process.env.OPENAI_API_KEY = SECRET;
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  stubFetch(async () => ({ status: 200, ok: true }));

  const result = await checkAiProvider(byKey('openai'));
  const wire = JSON.stringify(result);

  assert.equal(wire.includes(SECRET), false, 'the key leaked into the payload');
  assert.equal(result.key, 'openai', 'result.key is the provider id, not a credential');
  assert.equal('apiKey' in result, false);
  assert.equal('authorization' in result, false);
}));

test('every status returns the complete shape the panel reads', () => withCleanProviderEnv(async () => {
  const REQUIRED = ['key', 'label', 'usedBy', 'model', 'modelAvailable', 'modelCount',
    'configured', 'status', 'reachable', 'latencyMs', 'detail', 'checkedAt'];

  process.env.OPENAI_API_KEY = 'sk-real-key';
  const stubs = [
    async () => ({ status: 200, ok: true }),
    async () => ({ status: 401, ok: false }),
    async () => { throw new Error('down'); },
  ];
  const seen = [];
  for (const handler of stubs) {
    stubFetch(handler);
    seen.push(await checkAiProvider(byKey('openai')));
  }
  delete process.env.OPENAI_API_KEY;
  clearAiCheckCache();
  seen.push(await checkAiProvider(byKey('groq')));

  assert.equal(seen.length, 4, 'expected ok, rejected, unreachable and unconfigured');
  for (const outcome of seen) {
    for (const field of REQUIRED) {
      assert.ok(field in outcome, `${outcome.status} is missing "${field}"`);
    }
  }
}));

test('a completed check is served from cache until it expires', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-real-key';
  const calls = stubFetch(async () => ({ status: 200, ok: true }));

  const first = await getAiProviders();
  const afterFirst = calls.length;
  assert.ok(afterFirst > 0, 'the first call must probe');
  assert.equal(first.find((p) => p.key === 'openai').status, 'ok');

  const second = await getAiProviders();
  assert.equal(calls.length, afterFirst, 'a second poll inside the TTL must not re-probe');
  // Asserting the answer is still "ok" — not "unconfigured" — is what proves it
  // came from the cache rather than being recomputed against a scrubbed env.
  const openai = second.find((p) => p.key === 'openai');
  assert.equal(openai.status, 'ok', 'the cached result must be the live one');
  assert.equal(openai.configured, true);

  assert.ok(AI_CHECK_TTL_MS >= 5000, 'the TTL should comfortably outlive one dashboard poll');
}));

test('a forced check re-probes instead of trusting the cache', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-real-key';
  const calls = stubFetch(async () => ({ status: 200, ok: true }));

  await getAiProviders();
  const afterFirst = calls.length;

  await getAiProviders({ force: true });
  assert.ok(calls.length > afterFirst, '"Check now" must bypass the cache');
}));

test('concurrent polls share one in-flight probe per provider', () => withCleanProviderEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-real-key';
  let concurrent = 0;
  let peak = 0;
  stubFetch(async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    concurrent -= 1;
    return { status: 200, ok: true };
  });

  // The dashboard polls every 10 s; overlapping requests must not multiply.
  await Promise.all([getAiProviders(), getAiProviders(), getAiProviders()]);

  assert.equal(peak, 1, 'in-flight checks are shared, never duplicated');
}));

test('the panel timestamp is the OLDEST probe, never a fresh-looking one', () => {
  // Regression: seeding the reduce with '' makes every real date compare
  // GREATER than the seed, so nothing ever won and the caller fell back to
  // `new Date()` — reporting a 30-second-old cached result as "just now".
  assert.equal(oldestCheck([
    { checkedAt: '2026-09-28T03:52:27.210Z' },
    { checkedAt: '2026-09-28T03:52:26.760Z' },
    { checkedAt: '2026-09-28T03:52:26.999Z' },
  ]), '2026-09-28T03:52:26.760Z', 'the stalest card sets the panel age');

  assert.equal(
    oldestCheck([{ checkedAt: '2026-09-28T03:52:27.210Z' }]),
    '2026-09-28T03:52:27.210Z',
    'a lone result must still be used, not discarded',
  );

  assert.equal(oldestCheck([]), null, 'empty -> caller falls back to now');
  assert.equal(oldestCheck(null), null, 'null -> caller falls back to now');
  assert.equal(oldestCheck([{ checkedAt: null }, {}]), null, 'missing stamps are skipped, not stringified');
});
