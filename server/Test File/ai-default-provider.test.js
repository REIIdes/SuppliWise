/**
 * The default AI provider — what happens when nothing else is configured.
 *
 * ── The requirement ────────────────────────────────────────────────────────
 *
 * OpenRouter is the default AI. A feature whose own provider is not connected
 * is served by the default rather than failing, so setting the single key the
 * admin panel labels "Default AI" makes the WHOLE product work.
 *
 * ── Why this needed a test rather than a config line ────────────────────────
 *
 * The bug it fixes is silent and partial. With only `OPENROUTER_API_KEY` set,
 * four of six features worked and two did not — `systemDetection` (nominated
 * Groq) and `priorityFlagging` (nominated Anthropic) — because their providers
 * were hard-wired with no fallback. Nothing reported an error: each feature
 * simply degraded to its deterministic engine, which is exactly what those
 * engines are for, so the product looked healthy and was quietly serving less
 * than it appeared to.
 *
 * The boundary the rule draws matters as much as the rule, and is asserted
 * here: the substitution is a CONFIGURATION-time decision. A provider that has
 * a key and then fails at request time does not reach the default — that is the
 * declared `fallback`'s job, and adding a third provider there would mask a
 * broken key while the panel kept reporting success.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_ROUTES,
  DEFAULT_PROVIDER,
  DEFAULT_PROVIDER_ENV,
  defaultProviderKey,
  resolveChain,
  resolveTarget,
  completeWithFallback,
  describeRouting,
} = require('../utils/aiRouter.js');

const PURPOSES = AI_ROUTES.map((route) => route.purpose);

/** Run with a given env and the real one restored afterwards. */
async function withEnv(env, fn) {
  const saved = new Map();
  const names = [
    'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY',
    'LLAMA_API_KEY', 'OPENROUTER_MODEL', 'AI_DEFAULT_PROVIDER',
  ];
  for (const name of names) {
    saved.set(name, process.env[name]);
    if (!(name in env)) delete process.env[name];
  }
  for (const [name, value] of Object.entries(env)) process.env[name] = value;
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * With only the default key set, inspect the whole table.
 *
 * EVERYTHING happens inside `withEnv`. `resolveChain` and `describeRouting`
 * default to `process.env`, so calling either after the scope closes measures
 * the developer's real environment instead of the one under test — which is how
 * this helper's first version reported "no usable provider" for every purpose
 * and looked like a product bug.
 */
const real = () => withEnv({ OPENROUTER_API_KEY: 'sk-or-real' }, () => {
  const rows = describeRouting();
  const chains = new Map(rows.map((row) => [row.purpose, resolveChain(row.purpose)]));
  return { rows, chains };
});

// ══════════════════════════════════════════════════════════════════════════
// 1. The default itself
// ══════════════════════════════════════════════════════════════════════════

test('OpenRouter is the default', async () => {
  await withEnv({}, () => {
    assert.equal(DEFAULT_PROVIDER, 'openrouter');
    assert.equal(defaultProviderKey(), 'openrouter');
  });
});

test('the default can be overridden by configuration', async () => {
  await withEnv({ AI_DEFAULT_PROVIDER: 'groq' }, () => {
    assert.equal(defaultProviderKey(), 'groq');
  });
  // Overridable in one direction only: a bad value must not be able to leave
  // the server with no default at all.
  await withEnv({ AI_DEFAULT_PROVIDER: 'not-a-provider' }, () => {
    assert.equal(defaultProviderKey(), 'openrouter', 'a typo falls back rather than disabling the default');
  });
  await withEnv({ AI_DEFAULT_PROVIDER: '   ' }, () => {
    assert.equal(defaultProviderKey(), 'openrouter', 'blank is unset, not a request for nothing');
  });
});

test('the variable is named in the module header and exported', () => {
  assert.equal(DEFAULT_PROVIDER_ENV, 'AI_DEFAULT_PROVIDER');
});

// ══════════════════════════════════════════════════════════════════════════
// 2. The rule: nothing connected -> the default serves
// ══════════════════════════════════════════════════════════════════════════

test('one default key makes EVERY feature runnable', async () => {
  // The regression this whole change exists for. Before it, this assertion
  // failed on systemDetection and priorityFlagging with no error anywhere.
  const { rows, chains } = await real();
  for (const row of rows) {
    assert.equal(row.provider, 'openrouter', `${row.purpose} should be served by the default`);
    assert.equal(row.model, 'deepseek/deepseek-v4-flash-0731', `${row.purpose} should carry the default model`);
    assert.equal(row.configured, true, `${row.purpose} is not actually unconfigured`);
    assert.equal(row.envKey, 'OPENROUTER_API_KEY', `${row.purpose} should name the key that is spent`);

    const chain = chains.get(row.purpose);
    assert.equal(chain.length, 1, `${row.purpose} should have a usable provider`);
    assert.equal(chain[0].provider, 'openrouter', `${row.purpose} should use the default`);
    assert.equal(chain[0].ok, true, `${row.purpose} should be fully resolved, not a stub`);
    assert.ok(chain[0].apiKey, `${row.purpose} should carry a key it can actually spend`);
  }
});

test('features nominated for another provider are the ones that needed it', async () => {
  // Pin WHICH features this actually changes, so a future edit to the table is
  // visible here rather than discovered as "the fallback stopped working".
  //
  // With only the default key set, every purpose whose own provider has no key
  // lands on OpenRouter. `polish` joined that list when its primary moved to
  // OpenAI — it reaches the default through its own declared fallback, like
  // chat does, so it is NOT counted as a substitution.
  const { rows } = await real();
  const substituted = rows.filter((r) => r.usingDefault).map((r) => r.purpose).sort();
  assert.deepEqual(
    substituted,
    ['priorityFlagging', 'systemDetection'],
    'exactly the two features nominated for a provider with no key and no fallback',
  );
});

test('a feature that reached the default by its OWN fallback is not a substitution', async () => {
  // `chat` nominates Anthropic and declares OpenRouter as its fallback, so it
  // is served by OpenRouter here — through a different mechanism. Reporting
  // that as a default substitution would tell the operator Groq's absence
  // changed something it did not.
  const { rows } = await real();
  const chat = rows.find((r) => r.purpose === 'chat');
  assert.equal(chat.provider, 'openrouter', 'it is served by OpenRouter');
  assert.equal(chat.usingDefault, false, 'but by its declared fallback, not by the default rule');
  assert.equal(chat.declaredProvider, 'anthropic', 'and it still records what it nominates');
  assert.equal(chat.fallback, 'openrouter', 'which is exactly the declared fallback');
});

test('a configured provider is never displaced by the default', async () => {
  // The rule must not become "always OpenRouter" — that would silently move
  // detection off Groq for an operator who configured it on purpose.
  await withEnv({ OPENROUTER_API_KEY: 'sk-or-real', GROQ_API_KEY: 'gsk-real' }, () => {
    const chain = resolveChain('systemDetection');
    assert.equal(chain.length, 1);
    assert.equal(chain[0].provider, 'groq', 'Groq is connected, so it serves');

    const row = describeRouting().find((r) => r.purpose === 'systemDetection');
    assert.equal(row.provider, 'groq');
    assert.equal(row.usingDefault, false, 'and the panel does not claim a substitution happened');
  });
});

test('a placeholder key does not count as connected', async () => {
  // The registry already refuses placeholder keys, so an operator who pasted the
  // example value has connected nothing — and must reach the default's error
  // rather than a request that is guaranteed to be rejected.
  await withEnv({ GROQ_API_KEY: 'your_groq_api_key_here' }, () => {
    assert.equal(resolveTarget('systemDetection', { env: process.env }).ok, false);
    assert.equal(resolveChain('systemDetection').length, 0, 'a placeholder is not a provider');
  });
});

test('the default is held to the same standard as any provider', async () => {
  // If the default resolved loosely, an unroutable or model-less default would
  // be dispatched to. It must fail exactly as a primary does.
  await withEnv({ AI_DEFAULT_PROVIDER: 'llama' }, () => {
    // llama is a self-hosted gateway with no default model, so it is not usable
    // until one is chosen — and a purpose that has nothing else must NOT be
    // sent there.
    const chain = resolveChain('systemDetection');
    assert.equal(chain.length, 0, 'an unusable default is not a usable default');
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. The boundary: this is configuration-time, not runtime
// ══════════════════════════════════════════════════════════════════════════

test('a provider that fails at request time does NOT reach the default', async () => {
  // The deliberate boundary. Detection has no declared `fallback`, so a
  // rejected Groq key degrades to the rule engine. Silently retrying on
  // OpenRouter would hide a broken credential from the operator while the panel
  // kept reporting a healthy run.
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    status: 500, ok: false, text: async () => 'boom', json: async () => ({}),
  });
  try {
    await withEnv({ OPENROUTER_API_KEY: 'sk-or-real', GROQ_API_KEY: 'gsk-real' }, async () => {
      const result = await completeWithFallback('systemDetection', { user: 'hi' });
      assert.equal(result.ok, false, 'the request genuinely failed');
      assert.deepEqual(
        result.attempts.map((a) => a.provider),
        ['groq'],
        'and only Groq was spent — the default is not a silent runtime rescue',
      );
    });
  } finally {
    if (savedFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = savedFetch;
  }
});

// ══════════════════════════════════════════════════════════════════════════
// 4. With nothing connected at all, the error names the default
// ══════════════════════════════════════════════════════════════════════════

test('an unconfigured deployment is told to set the default key', async () => {
  // The zero-key case is the user's actual starting point. The message has to
  // name the one key that would make it work, not the whole provider list.
  await withEnv({}, async () => {
    const savedFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      status: 500, ok: false, text: async () => '', json: async () => ({}),
    });
    try {
      const result = await completeWithFallback('systemDetection', { user: 'hi' });
      assert.equal(result.ok, false);
      assert.match(result.error, /GROQ_API_KEY/, 'the nominated provider is named');
      assert.match(result.error, /OPENROUTER_API_KEY/, 'and so is the default that would serve it');
    } finally {
      if (savedFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = savedFetch;
    }
  });
});

test('nothing connected means every purpose is unusable, not quietly re-pointed', async () => {
  // With no key anywhere the default is not usable either, so the chain stays
  // empty and the caller degrades to its deterministic engine. Substituting an
  // unconfigured default would be a request guaranteed to be rejected.
  await withEnv({}, () => {
    for (const purpose of PURPOSES) {
      assert.equal(resolveChain(purpose).length, 0, `${purpose} should have nothing to call`);
    }
    for (const row of describeRouting()) {
      assert.equal(row.configured, false, `${row.purpose} must not claim to be configured`);
      assert.equal(row.usingDefault, false, 'and must not claim a substitution that cannot happen');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. The panel must tell the truth
// ══════════════════════════════════════════════════════════════════════════

test('the panel names the provider that will actually answer', async () => {
  const { rows } = await real();
  for (const row of rows) {
    assert.ok(row.providerLabel, `${row.purpose} must name a provider`);
    assert.equal('apiKey' in row, false, 'no key may be handed to the browser');
    assert.equal(JSON.stringify(rows).includes('sk-or-real'), false, 'and no key may appear anywhere in it');
  }
});

test('intent is still recorded next to the substitution', async () => {
  // A substitution that is not visible is a surprise. The card keeps both the
  // nominated provider and the one that answers, so an operator can see that
  // Groq is not being used and why.
  await withEnv({ OPENROUTER_API_KEY: 'sk-or-real' }, () => {
    const row = describeRouting().find((r) => r.purpose === 'systemDetection');
    assert.equal(row.declaredProvider, 'groq');
    assert.equal(row.declaredLabel, 'Groq');
    assert.equal(row.provider, 'openrouter');
    assert.equal(row.providerLabel, 'OpenRouter (DeepSeek V4 Flash)');
    assert.equal(row.usingDefault, true);
  });
});

test('the overridden default is what the panel reports', async () => {
  await withEnv({ AI_DEFAULT_PROVIDER: 'openai', OPENAI_API_KEY: 'sk-oai-real' }, () => {
    const row = describeRouting().find((r) => r.purpose === 'systemDetection');
    assert.equal(row.provider, 'openai', 'the configured default is the one that serves');
    assert.equal(row.model, 'gpt-5.4-nano', 'with that provider\'s own model');
  });
});
