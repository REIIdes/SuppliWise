/**
 * AI routing + system detection.
 *
 * Run: npm test
 *
 * The split this pins, and why each half matters:
 *
 *   1. ROUTING IS DECIDED IN ONE PLACE. `chat.js` and `polish.js` used to send
 *      `deepseek/deepseek-v4-flash` while `recommend.js`,
 *      `supplement_detail.js` and the admin panel all said
 *      `deepseek/deepseek-v4-flash-0731` for the same key. Nothing compared
 *      them, so the panel was confidently reporting a model two call sites
 *      never sent. The routing table removes the possibility rather than the
 *      instance, so that is asserted structurally here.
 *
 *   2. OPENROUTER IS STILL THE DEFAULT. The four user-facing health features
 *      must not have been moved onto Groq as a side effect of adding a
 *      detection provider.
 *
 *   3. DETECTION SURVIVES THE AI DYING. Every Groq failure — no key, rejected
 *      key, timeout, non-JSON reply, unvalidated reply — must fall back to the
 *      rule-based verdict. A security panel that stops reporting because a
 *      third-party API is down is worse than one that never predicted anything.
 *
 *   4. MODEL OUTPUT IS NEVER TRUSTED. Severity is clamped to a fixed
 *      vocabulary, strings are bounded and stripped, and a reply that fails
 *      validation is discarded whole rather than half-applied.
 *
 * `fetch` is stubbed throughout and node's runner gives each file its own
 * process, so nothing here touches the network and the stubs cannot bleed into
 * another suite.
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  AI_ROUTES,
  DEFAULT_PROVIDER,
  DEFAULT_TIMEOUT_MS,
  PRIMARY_BUDGET_FLOOR_MS,
  routeFor,
  resolveTarget,
  resolveChain,
  splitTimeout,
  completeWithFallback,
  readCompletionText,
  parseJsonObject,
  complete,
  describeRouting,
} = require('../utils/aiRouter.js');

const {
  DETECTION_TTL_MS,
  SEVERITIES,
  CATEGORIES,
  CORE_CATEGORIES,
  clampConfidence,
  safeText,
  safeSeverity,
  safeCategory,
  redact,
  buildSignals,
  ruleBasedVerdict,
  validateVerdict,
  detectSystemThreats,
  clearDetectionCache,
} = require('../utils/systemDetection.js');

const AI_VARS = ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'GROQ_API_KEY', 'ANTHROPIC_API_KEY',
  'OPENROUTER_MODEL', 'OPENAI_MODEL', 'GROQ_MODEL', 'ANTHROPIC_MODEL',
  // Selects which provider serves a purpose that has nothing else configured.
  // Not a credential, but it changes resolution, so a value inherited from a
  // developer's .env would silently re-point the default and make these tests
  // machine-dependent.
  'AI_DEFAULT_PROVIDER'];

/** Replace global fetch with a stub; returns the calls it received. */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const response = await handler(url, options);
    calls.push({ url, options, body: options && options.body ? JSON.parse(options.body) : null });
    return response;
  };
  return calls;
}

/** A 200 carrying an assistant message. */
function completionResponse(content, extra = {}) {
  return {
    status: 200,
    ok: true,
    json: async () => ({ choices: [{ message: { content } }], ...extra }),
  };
}

/** Run with every AI env var scrubbed, then restore. */
async function withCleanEnv(fn) {
  const saved = AI_VARS.map((name) => [name, process.env[name]]);
  for (const name of AI_VARS) delete process.env[name];
  clearDetectionCache();
  try {
    return await fn();
  } finally {
    clearDetectionCache();
    delete globalThis.fetch;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

afterEach(() => {
  delete globalThis.fetch;
});

// ── Routing table ───────────────────────────────────────────────────────────

test('the long-form health content features stay on the default provider', () => {
  // Assessment and supplement detail write the member's plan and their
  // personalised guide. They are unchanged and must not drift onto another
  // provider as a side effect of a routing change.
  //
  // (`polish` is NOT in this list. It moved to OpenAI on purpose — it is the
  // busiest call in the product and the shortest job, so keeping it on the
  // default meant one provider absorbed every submission. Asserted separately
  // below so that move stays deliberate rather than incidental.)
  for (const purpose of ['assessment', 'supplementDetail']) {
    assert.equal(routeFor(purpose).provider, DEFAULT_PROVIDER, `${purpose} left the default provider`);
    assert.equal(routeFor(purpose).provider, 'openrouter');
  }
});

test('description polish runs on OpenAI, keeping it off the default', () => {
  // The spread. Before this, ONE provider took assessment + chat + polish +
  // detail plus every fallback, so all of that traffic shared a single quota
  // and a single point of failure. Polish is the busiest call in the product —
  // every assessment submit polishes a free-text description first — and the
  // shortest one, so a nano-class model on a different provider is both the
  // better fit and the load the default no longer carries.
  assert.equal(routeFor('polish').provider, 'openai');
  // Its own fallback, for the same reason chat has one: a valid key can still be
  // unable to answer (exhausted credit is a 400 the health probe cannot see),
  // and an unpolished description is a degraded product, not a broken feature.
  assert.equal(routeFor('polish').fallback, DEFAULT_PROVIDER);
});

test('chat runs on Anthropic, and keeps a fallback so it cannot go dark', () => {
  assert.equal(routeFor('chat').provider, 'anthropic');
  // The fallback is the property that matters. Anthropic answers an exhausted
  // balance with a 400, and the model-list health probe cannot see that — so
  // without a fallback, moving chat there would put every user on the canned
  // offline reply until the account is funded.
  assert.equal(routeFor('chat').fallback, 'openrouter');
  assert.notEqual(routeFor('chat').fallback, routeFor('chat').provider,
    'a provider cannot be its own fallback');
});

test('system detection is routed to Groq', () => {
  assert.equal(routeFor('systemDetection').provider, 'groq');
});

test('every purpose is unique and named for the panel to render', () => {
  const purposes = AI_ROUTES.map((r) => r.purpose);
  assert.equal(new Set(purposes).size, purposes.length, 'duplicate purpose keys');
  for (const route of AI_ROUTES) {
    for (const field of ['purpose', 'label', 'detail', 'provider']) {
      assert.ok(String(route[field] || '').trim(), `${route.purpose} is missing ${field}`);
    }
  }
});

test('an unknown purpose is a loud error, never a silent default', () => {
  // Falling back to the default provider would let a typo'd purpose send a
  // security request to the health model, so this throws rather than guessing.
  assert.throws(() => routeFor('definitely-not-a-purpose'), /Unknown AI purpose/);
  const target = resolveTarget('definitely-not-a-purpose');
  assert.equal(target.ok, false);
  assert.match(target.error, /Unknown AI purpose/);
});

test('purposes that share a provider share one model, so no call site can drift', () => withCleanEnv(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  process.env.GROQ_API_KEY = 'gsk-real';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
  process.env.OPENAI_API_KEY = 'sk-oai-real';

  // The drift this guards: chat.js and polish.js each hard-coded their own
  // model and two of them disagreed with the panel. The general invariant is
  // that a model is a property of the PROVIDER, so two purposes on one provider
  // can never resolve differently.
  const byProvider = new Map();
  for (const route of AI_ROUTES) {
    const target = resolveTarget(route.purpose);
    assert.equal(target.ok, true, `${route.purpose} did not resolve`);
    if (!byProvider.has(target.provider)) byProvider.set(target.provider, new Set());
    byProvider.get(target.provider).add(target.model);
  }
  for (const [provider, models] of byProvider) {
    assert.equal(models.size, 1, `${provider} resolves ${models.size} different models: ${[...models].join(' vs ')}`);
  }

  // And the two providers that actually serve user content stay on their own
  // models rather than being collapsed onto one.
  assert.notEqual(resolveTarget('chat').model, resolveTarget('assessment').model,
    'chat and the health content features must not be pinned to the same model');
}));

test('a model env override is honoured for whichever provider owns it', () => withCleanEnv(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  process.env.GROQ_API_KEY = 'gsk-real';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
  process.env.OPENAI_API_KEY = 'sk-oai-real';
  process.env.GROQ_MODEL = 'qwen/qwen3.8-27b';
  process.env.OPENROUTER_MODEL = 'some/other-model';
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-5';
  process.env.OPENAI_MODEL = 'gpt-other';

  assert.equal(resolveTarget('systemDetection').model, 'qwen/qwen3.8-27b');
  assert.equal(resolveTarget('assessment').model, 'some/other-model');
  // Chat is on Anthropic now, so OPENROUTER_MODEL must not leak into it.
  assert.equal(resolveTarget('chat').model, 'claude-sonnet-5',
    'an override for one provider must not reach a purpose owned by another');
  // Polish is on OpenAI — the one place a provider-specific override is most
  // likely to be wrong, because OPENROUTER_MODEL is the variable an operator
  // has actually been setting.
  assert.equal(resolveTarget('polish').model, 'gpt-other',
    'OPENAI_MODEL must not be ignored because polish used to live on the default');
}));

test('an unconfigured purpose reports a nameable error and no key', () => withCleanEnv(() => {
  const target = resolveTarget('assessment');
  assert.equal(target.ok, false);
  assert.equal(target.apiKey, null, 'no key may be handed back when the purpose cannot run');
  assert.match(target.error, /OPENROUTER_API_KEY/);
}));

test('a placeholder key does not make a purpose look runnable', () => withCleanEnv(() => {
  process.env.GROQ_API_KEY = 'your_groq_api_key_here';
  const target = resolveTarget('systemDetection');
  assert.equal(target.ok, false);
  assert.equal(target.apiKey, null);
}));

test('a provider that cannot be routed to is refused by name', () => withCleanEnv(() => {
  // Anthropic WAS the non-routable member, and this test asserted so while the
  // Messages API was unimplemented. It is now routable, which leaves the
  // `chatCompatible !== true` guard with no shipped member — and a guard with no
  // example is a guard nobody exercises. So the shape is asserted directly, and
  // the routable state of every real provider is pinned alongside it.
  const { AI_PROVIDERS } = require('../utils/aiProviders.js');
  const anthropic = AI_PROVIDERS.find((p) => p.key === 'anthropic');
  assert.equal(anthropic.chatCompatible, true, 'Anthropic is now routed for priority flagging');
  assert.equal(anthropic.chatUrl, 'https://api.anthropic.com/v1/messages');

  // The refusal condition itself: a provider that never declares the flag is
  // NOT routable, because the router requires an explicit `=== true`. An
  // undeclared provider must never be treated as "probably fine".
  const undeclared = { key: 'x', label: 'X', chatUrl: 'https://example.test/v1' };
  assert.notEqual(undeclared.chatCompatible, true, 'an undeclared provider is refused, not assumed');

  // Every provider the router can reach must be reachable through it. A
  // self-hosted gateway has no static chatUrl — its address is configuration —
  // so "somewhere to POST" is satisfied by either form.
  for (const provider of AI_PROVIDERS) {
    if (provider.chatCompatible !== true) continue;
    const hasSomewhere = provider.chatUrl || provider.baseUrlEnv;
    assert.ok(hasSomewhere, `${provider.key} is routable but has nowhere to POST`);
  }
}));

test('every routable provider declares a wire format the router can build', () => withCleanEnv(() => {
  // `wire` selects the request/response shape. A provider that leaves it unset
  // gets the OpenAI shape, which is right for three of the four and wrong for
  // Anthropic — so it is declared, never inferred from the URL.
  const { AI_PROVIDERS } = require('../utils/aiProviders.js');
  for (const provider of AI_PROVIDERS) {
    if (provider.chatCompatible !== true) continue;
    assert.ok(
      provider.wire === 'openai' || provider.wire === 'anthropic',
      `${provider.key} declares wire "${provider.wire}", which the router cannot build`
    );
  }
  // Exactly one provider is non-OpenAI-shaped, and it is the one that needs it.
  assert.deepEqual(
    AI_PROVIDERS.filter((p) => p.wire === 'anthropic').map((p) => p.key),
    ['anthropic'],
    'the Anthropic Messages API must be declared, or its body shape is silently wrong'
  );
}));

test('describeRouting is renderable and never carries a key', () => withCleanEnv(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  const rows = describeRouting();
  assert.equal(rows.length, AI_ROUTES.length);
  for (const row of rows) {
    assert.ok(row.label && row.providerLabel);
    assert.equal('apiKey' in row, false);
    assert.equal(JSON.stringify(rows).includes('sk-or-real'), false, 'a key leaked into the routing table');
  }
  // The Groq-nominated row is served by the DEFAULT provider, so it must be
  // reported as configured AND name the provider that will actually answer.
  //
  // CHANGED 2026-09-29. This asserted `configured === false` here, which was
  // correct under the old routing: with no Groq key, systemDetection could not
  // run. It now runs on the default provider, so `false` would be a lie — the
  // card would render "Not configured — set GROQ_API_KEY" while every request
  // went to OpenRouter, sending the operator to set a key that changes nothing.
  // The test's real intent (the card is never silently blank, and never carries
  // a key) is kept and the substituted provider is now asserted alongside.
  const detection = rows.find((r) => r.purpose === 'systemDetection');
  assert.equal(detection.configured, true, 'the default provider can serve it, so it is not unconfigured');
  assert.equal(detection.provider, 'openrouter', 'and the card must name the provider that answers');
  assert.equal(detection.declaredProvider, 'groq', 'while still recording what the table nominates');
  assert.equal(detection.usingDefault, true, 'and that this is a substitution rather than the declared route');
  assert.equal(detection.envKey, 'OPENROUTER_API_KEY', 'so the key it names is the one that would be spent');
}));

// ── complete() plumbing ─────────────────────────────────────────────────────

test('a completion reads content, then reasoning, then nothing', () => {
  assert.equal(readCompletionText({ choices: [{ message: { content: 'hi' } }] }), 'hi');
  assert.equal(readCompletionText({ choices: [{ message: { content: null, reasoning: ' r ' } }] }), 'r');
  assert.equal(readCompletionText({ choices: [] }), '');
  assert.equal(readCompletionText(null), '');
  assert.equal(readCompletionText({}), '');
});

test('a JSON reply is parsed out of a fence or a preamble', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonObject('Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  // Anything that is not an object is not a verdict.
  assert.equal(parseJsonObject('[1,2,3]'), null);
  assert.equal(parseJsonObject('"a string"'), null);
  assert.equal(parseJsonObject('no json here'), null);
  assert.equal(parseJsonObject(''), null);
  assert.equal(parseJsonObject('{ broken'), null);
});

test('complete() returns text without asking for JSON', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-real';
  const calls = stubFetch(async () => completionResponse('plain answer'));

  const result = await complete('systemDetection', { user: 'hi', json: false });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'plain answer');
  assert.equal(result.provider, 'groq');
  assert.equal(calls[0].body.response_format, undefined, 'JSON mode must be opt-in');
}));

test('complete() never leaks the key into its result', async () => withCleanEnv(async () => {
  const SECRET = 'gsk-super-secret-do-not-leak';
  process.env.GROQ_API_KEY = SECRET;
  stubFetch(async () => completionResponse('ok'));

  const result = await complete('systemDetection', { user: 'hi' });
  assert.equal(JSON.stringify(result).includes(SECRET), false);
}));

test('a rejected key names the variable to rotate', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-revoked';
  stubFetch(async () => ({ status: 401, ok: false }));

  const result = await complete('systemDetection', { user: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.error, /rotate GROQ_API_KEY/);
}));

test('a timeout is reported, not thrown', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-real';
  stubFetch(async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    throw error;
  });

  const result = await complete('systemDetection', { user: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out/);
}));

test('a 400 under JSON mode is retried once without it', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-real';
  const seen = [];
  const calls = stubFetch(async (url, options) => {
    const body = JSON.parse(options.body);
    seen.push(Boolean(body.response_format));
    return seen.length === 1
      ? { status: 400, ok: false }
      : completionResponse('{"severity":"nominal","summary":"all clear"}');
  });

  const result = await complete('systemDetection', { user: 'hi', json: true });
  assert.equal(result.ok, true);
  assert.deepEqual(seen, [true, false], 'the retry must drop JSON mode, not repeat it');
  assert.equal(calls.length, 2);
}));

test('a non-JSON reply is a failure, never a half-parsed verdict', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-real';
  stubFetch(async () => completionResponse('I think everything looks fine actually'));

  const result = await complete('systemDetection', { user: 'hi', json: true });
  assert.equal(result.ok, false);
  assert.equal(result.data, null);
  assert.match(result.error, /not a JSON object/);
}));

test('an empty prompt is refused before any request is made', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-real';
  const calls = stubFetch(() => { throw new Error('must not be called'); });

  const result = await complete('systemDetection', { user: '   ' });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
}));

// ── Detection: redaction ────────────────────────────────────────────────────

test('probe details are stripped of anything that must not leave the process', () => {
  const dirty = 'Admin admin@suppliwise.test from 192.168.1.44; token gsk-abcdefghijklmnop '
    + 'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g '
    + 'hash a3f5c9d1e2b4a7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2';
  const clean = redact(dirty);

  assert.doesNotMatch(clean, /admin@suppliwise\.test/);
  assert.doesNotMatch(clean, /192\.168\.1\.44/);
  assert.doesNotMatch(clean, /gsk-abcdefghijklmnop/);
  assert.doesNotMatch(clean, /eyJhbGciOiJIUzI1NiJ9/);
  assert.doesNotMatch(clean, /a3f5c9d1e2b4a7c8/);
  assert.match(clean, /\[redacted-email\]/);
  assert.match(clean, /\[redacted-ip\]/);
});

test('a healthy system redacts to nothing alarming', () => {
  assert.equal(redact('MongoDB connected and responsive. Ping: 3 ms. Host: localhost.'),
    'MongoDB connected and responsive. Ping: 3 ms. Host: localhost.');
});

test('the signal set is bounded and carries only the fields the model needs', () => {
  const monitors = Array.from({ length: 200 }, (_, i) => ({
    key: `probe${i}`, label: `Probe ${i}`, category: 'other', status: 'healthy',
    detail: 'x'.repeat(5000),
  }));
  const signals = buildSignals(monitors, 'healthy');

  assert.ok(signals.probes.length <= 40, 'the prompt must be bounded');
  for (const probe of signals.probes) {
    assert.ok(probe.detail.length <= 300, 'each detail must be length-capped');
    assert.deepEqual(
      Object.keys(probe).sort(),
      ['category', 'detail', 'incomplete', 'key', 'label', 'status'],
      'the model receives no field it should not'
    );
  }
});

test('buildSignals survives garbage input', () => {
  assert.deepEqual(buildSignals(null, null).probes, []);
  assert.deepEqual(buildSignals(undefined, undefined).probes, []);
  assert.equal(buildSignals([null, 5, 'x'], 'healthy').probes.length, 3, 'rows are counted, not dropped silently');
});

// ── Detection: validation ───────────────────────────────────────────────────

test('coercion helpers clamp rather than trust', () => {
  assert.equal(clampConfidence(55.4), 55);
  assert.equal(clampConfidence(-20), 0);
  assert.equal(clampConfidence(9999), 100);
  assert.equal(clampConfidence('nope'), null);
  assert.equal(clampConfidence(undefined), null);

  assert.equal(safeSeverity('SEVERE'), 'severe');
  assert.equal(safeSeverity('catastrophic', 'watch'), 'watch', 'unknown severity falls back');
  assert.equal(safeSeverity(null, 'watch'), 'watch');

  assert.equal(safeCategory('auth'), 'auth');
  assert.equal(safeCategory('nonsense'), 'other');

  // Control characters are stripped so a model cannot inject line breaks into a card.
  assert.equal(safeText('a\nb\tc'), 'a b c');
  assert.equal(safeText('x'.repeat(500), 10), 'x'.repeat(10));
  assert.equal(safeText(null), '');
});

test('every accepted severity and category is one the UI can render', () => {
  // A model inventing a severity would render as undefined in the panel.
  for (const value of ['nominal', 'watch', 'elevated', 'severe', 'bogus', 42, null]) {
    assert.ok(SEVERITIES.includes(safeSeverity(value, 'watch')), `"${value}" escaped the vocabulary`);
  }
  for (const value of ['auth', 'data', 'ai', 'nope', null]) {
    assert.ok(CATEGORIES.includes(safeCategory(value)), `"${value}" escaped the vocabulary`);
  }
});

test('a well-formed model reply is accepted', () => {
  const verdict = validateVerdict({
    severity: 'elevated',
    confidence: 82,
    summary: 'Database is down and OTP delivery is degraded.',
    predictions: [{ title: 'Login will fail', category: 'auth', rationale: 'OTP depends on the mail path.', confidence: 70 }],
    actions: ['Restart MongoDB'],
  });
  assert.equal(verdict.severity, 'elevated');
  assert.equal(verdict.confidence, 82);
  assert.equal(verdict.predictions.length, 1);
  assert.deepEqual(verdict.actions, ['Restart MongoDB']);
});

test('a malformed reply is discarded whole, not half-applied', () => {
  // Keeping the summary while dropping the analysis would present an unaudited
  // claim as an analysed one.
  for (const bad of [null, undefined, 'a string', 42, [], {}, { summary: '' }, { summary: 123 }]) {
    assert.equal(validateVerdict(bad), null, `${JSON.stringify(bad)} should not validate`);
  }
});

test('prediction and action lists are bounded and scrubbed', () => {
  const verdict = validateVerdict({
    severity: 'watch',
    summary: 'ok',
    predictions: Array.from({ length: 40 }, () => ({
      title: 'T', category: 'auth', rationale: 'R', confidence: 50,
    })),
    actions: Array.from({ length: 40 }, () => 'A'),
  });
  assert.ok(verdict.predictions.length <= 5, 'predictions must be capped');
  assert.ok(verdict.actions.length <= 5, 'actions must be capped');
});

test('a prediction missing its rationale is dropped, not shown empty', () => {
  const verdict = validateVerdict({
    severity: 'watch', summary: 'ok',
    predictions: [
      { title: 'Has both', rationale: 'Because.', confidence: 50 },
      { title: 'No rationale', confidence: 50 },
      { rationale: 'No title', confidence: 50 },
    ],
  });
  assert.equal(verdict.predictions.length, 1);
});

// ── Detection: end to end ───────────────────────────────────────────────────

const MONITORS = [
  { key: 'login', label: 'Login System', category: 'login', status: 'healthy', detail: 'JWT + OTP pipeline healthy.' },
  { key: 'database', label: 'Database Connectivity', category: 'database', status: 'critical', detail: 'MongoDB is Disconnected (readyState=0).' },
  { key: 'email_otp', label: 'Email OTP', category: 'security', status: 'warning', detail: 'Not configured.' },
];

test('detection uses Groq and returns its prediction', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-real';
  const calls = stubFetch(async () => completionResponse(JSON.stringify({
    severity: 'severe',
    confidence: 88,
    summary: 'Database is disconnected, which will cascade into login.',
    predictions: [{ title: 'Logins will fail', category: 'auth', rationale: 'Login reads the database.', confidence: 90 }],
    actions: ['Restart MongoDB'],
  })));

  const result = await detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' });

  assert.equal(result.aiAvailable, true);
  assert.equal(result.severity, 'severe');
  assert.equal(result.provider, 'groq');
  assert.equal(result.source, 'ai', 'a consumer must be able to tell the two paths apart');
  assert.equal(result.aiError, null);
  assert.match(result.summary, /cascade/);
  assert.equal(calls[0].url, 'https://api.groq.com/openai/v1/chat/completions');
  // The prompt must carry the probe results, and must not carry a key.
  assert.match(calls[0].body.messages[1].content, /Database Connectivity/);
  assert.equal(calls[0].body.messages[1].content.includes('gsk-real'), false);
}));

test('detection falls back to rules when Groq has no key', async () => withCleanEnv(async () => {
  const calls = stubFetch(() => { throw new Error('must not be called'); });

  const result = await detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' });

  assert.equal(result.aiAvailable, false);
  assert.equal(result.source, 'rules');
  assert.equal(result.severity, 'severe', 'a critical in a core area is severe');
  assert.match(result.note, /Rule-based verdict/);
  assert.equal(calls.length, 0, 'no key means nothing to send');
  // The fallback is still a usable verdict, not an empty shell.
  assert.ok(result.predictions.length > 0);
  assert.ok(result.actions.length > 0);
}));

test('a failure in a CORE category escalates on its own', () => {
  // The vocabulary the Security Center probes actually emit. This test exists
  // because the rule was first written against 'auth'/'data' — and NO probe
  // carries either tag, so the escalation silently never fired. Pinning the
  // real strings stops that class of bug returning.
  const coreCategories = ['login', 'account_creation', 'security', 'totp',
    'email_otp', 'bruteforce', 'csrf', 'database', 'auth', 'data', 'privacy'];
  for (const category of coreCategories) {
    const verdict = ruleBasedVerdict(buildSignals([
      { key: 'a', label: 'A', category: 'blockchain', status: 'healthy', detail: '' },
      { key: 'b', label: 'B', category, status: 'critical', detail: 'broken' },
    ], 'critical'));
    assert.equal(verdict.severity, 'severe', `"${category}" must escalate on its own`);
  }

  // A non-core failure of the same single kind must NOT claim severe.
  const cosmetic = ruleBasedVerdict(buildSignals([
    { key: 'a', label: 'A', category: 'blockchain', status: 'healthy', detail: '' },
    { key: 'b', label: 'B', category: 'blockchain', status: 'critical', detail: 'broken' },
  ], 'critical'));
  assert.equal(cosmetic.severity, 'elevated');
  assert.equal(CORE_CATEGORIES.has('blockchain'), false);
});

test('detection falls back to rules when the provider fails', async () => withCleanEnv(async () => {
  for (const failure of [
    async () => ({ status: 401, ok: false }),
    async () => ({ status: 503, ok: false }),
    async () => { throw new Error('ECONNREFUSED'); },
    async () => completionResponse('I am unable to help with that request.'),
    async () => completionResponse(''),
  ]) {
    process.env.GROQ_API_KEY = 'gsk-real';
    clearDetectionCache();
    stubFetch(failure);

    const result = await detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' });
    assert.equal(result.aiAvailable, false, 'a bad provider must not be reported as a prediction');
    assert.equal(result.source, 'rules');
    assert.ok(result.severity, 'a verdict is always produced');
  }
}));

test('an unvalidated reply degrades to rules rather than reaching the admin', async () => {
  await withCleanEnv(async () => {
    process.env.GROQ_API_KEY = 'gsk-real';
    stubFetch(async () => completionResponse('{"severity":"totally-fine","summary":123}'));

    const result = await detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' });
    assert.equal(result.aiAvailable, false);
    assert.equal(result.source, 'rules');
    assert.match(result.aiError, /failed validation/);
  });
});

test('an unchanged system reuses its verdict instead of re-spending quota', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-real';
  const calls = stubFetch(async () => completionResponse(JSON.stringify({
    severity: 'watch', confidence: 50, summary: 'Stable', predictions: [], actions: [],
  })));

  const first = await detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' });
  const afterFirst = calls.length;
  assert.ok(afterFirst > 0);

  const second = await detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' });
  assert.equal(calls.length, afterFirst, 'an identical system must not be re-analysed');
  assert.equal(second.cached, true);
  assert.equal(second.severity, first.severity);

  // A changed system MUST be re-analysed — caching must not hide a new failure.
  const changed = [...MONITORS, { key: 'jwt', label: 'JWT', category: 'auth', status: 'critical', detail: 'weak secret' }];
  const third = await detectSystemThreats({ monitors: changed, overallStatus: 'critical' });
  assert.ok(calls.length > afterFirst, 'a new failure must trigger a fresh prediction');
  assert.equal(third.cached, false);
  assert.ok(DETECTION_TTL_MS > 0);
}));

test('force bypasses the cache, so "Check now" really re-analyses', async () => withCleanEnv(async () => {
  process.env.GROQ_API_KEY = 'gsk-real';
  const calls = stubFetch(async () => completionResponse(JSON.stringify({
    severity: 'nominal', confidence: 60, summary: 'Fine', predictions: [], actions: [],
  })));

  await detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' });
  const afterFirst = calls.length;
  await detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical', force: true });
  assert.ok(calls.length > afterFirst);
}));

test('concurrent callers share one prediction and all get a real verdict', async () =>
  withCleanEnv(async () => {
    process.env.GROQ_API_KEY = 'gsk-real';
    let inFlight = 0;
    let peak = 0;
    const calls = stubFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 30));
      inFlight -= 1;
      return completionResponse(JSON.stringify({
        severity: 'elevated', confidence: 70, summary: 'Shared verdict', predictions: [], actions: [],
      }));
    });

    // Three overlapping calls, exactly as three overlapping dashboard polls
    // would arrive. The bug this pins: while a call is in flight the cache entry
    // holds `verdict: null` with `at` already set, so a TTL check alone passed
    // and the second caller received `{ ...null, cached: true }` — an object
    // with nothing in it, which renders as an empty, falsely-calm card.
    const results = await Promise.all([
      detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' }),
      detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' }),
      detectSystemThreats({ monitors: MONITORS, overallStatus: 'critical' }),
    ]);

    assert.equal(calls.length, 1, 'overlapping callers must share one request, not multiply quota');
    assert.equal(peak, 1);
    for (const result of results) {
      assert.equal(result.severity, 'elevated', 'a joined caller must not receive an empty verdict');
      assert.equal(result.summary, 'Shared verdict');
      assert.ok(result.checkedAt);
    }
  }));

test('detection never throws, whatever the input looks like', async () => {
  await withCleanEnv(async () => {
    for (const input of [{}, { monitors: null }, { monitors: 'nope' }, { monitors: [null, 7] }]) {
      const result = await detectSystemThreats(input);
      assert.ok(result.severity, 'a verdict is always produced');
      assert.ok(result.checkedAt, 'a verdict is always timestamped');
      assert.equal(typeof result.probeCount, 'number');
    }
  });
});

test('a healthy system is reported as nominal, not as elevated', async () => withCleanEnv(async () => {
  const healthy = MONITORS.map((m) => ({ ...m, status: 'healthy' }));
  const signals = buildSignals(healthy, 'healthy');
  const verdict = ruleBasedVerdict(signals);

  assert.equal(verdict.severity, 'nominal');
  assert.equal(verdict.predictions.length, 0, 'nothing to predict when nothing is wrong');
  assert.match(verdict.summary, /no anomalies/i);
}));

test('a single critical is elevated, not severe', () => {
  // A model that calls one failing probe "severe" is crying wolf; the rule-based
  // floor keeps the scale honest so the AI cannot inflate it unchecked.
  const one = ruleBasedVerdict(buildSignals(
    [...MONITORS.filter((m) => m.status !== 'critical'),
      { key: 'x', label: 'One Thing', category: 'other', status: 'critical', detail: 'broken' }],
    'critical',
  ));
  assert.equal(one.severity, 'elevated');
});

// ── The chat provider chain ─────────────────────────────────────────────────

test('chat tries Anthropic first and only then its fallback', () => withCleanEnv(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
  process.env.OPENROUTER_API_KEY = 'sk-or-real';

  const chain = resolveChain('chat');
  assert.equal(chain.length, 2, 'a funded-key failure must still leave a second provider');
  assert.equal(chain[0].provider, 'anthropic', 'the primary must be tried first');
  assert.equal(chain[1].provider, 'openrouter');
  // Both entries are fully resolved — a chain must never hand back a target
  // that would fail on a missing key, or the walk wastes a round trip.
  for (const target of chain) {
    assert.equal(target.ok, true);
    assert.ok(target.model);
    assert.ok(target.apiKey);
  }
}));

test('the chain shrinks to one when only one provider is configured', () => withCleanEnv(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  const chain = resolveChain('chat');
  assert.equal(chain.length, 1);
  assert.equal(chain[0].provider, 'openrouter', 'the unconfigured primary is dropped, not left to fail');
}));

test('a purpose with no fallback has a single-entry chain', () => withCleanEnv(() => {
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
  process.env.GROQ_API_KEY = 'gsk-real';
  process.env.OPENAI_API_KEY = 'sk-oai-real';
  // (`polish` is excluded deliberately — it DOES declare a fallback. The two
  // user-facing features that most need one, chat and polish, are the two that
  // have it; the rest degrade to their deterministic engines, which is a
  // complete and supported way to run.)
  for (const purpose of ['assessment', 'supplementDetail', 'systemDetection', 'priorityFlagging']) {
    assert.equal(resolveChain(purpose).length, 1, `${purpose} should not have a fallback`);
  }
}));

test('polish tries OpenAI first and only then the default', () => withCleanEnv(() => {
  process.env.OPENAI_API_KEY = 'sk-oai-real';
  process.env.OPENROUTER_API_KEY = 'sk-or-real';

  const chain = resolveChain('polish');
  assert.equal(chain.length, 2, 'an unfunded OpenAI key must still leave a second provider');
  assert.equal(chain[0].provider, 'openai', 'the primary must be tried first');
  assert.equal(chain[1].provider, 'openrouter');
  // Both entries fully resolved — a chain must never hand back a target that
  // would fail on a missing key, or the walk wastes a round trip.
  for (const target of chain) {
    assert.equal(target.ok, true);
    assert.ok(target.model);
    assert.ok(target.apiKey);
  }
}));

test('polish survives an OpenAI key that cannot answer', () => withCleanEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-oai-real';
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  const calls = stubFetch(async (url) => (String(url).includes('api.openai.com')
    ? { status: 429, ok: false, text: async () => '{"error":{"message":"rate limit"}}' }
    : { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'polished' } }] }) }));

  const result = await completeWithFallback('polish', { user: 'hi' });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'openrouter', 'the reply must be attributed to the provider that made it');
  assert.equal(calls.length, 2);
}));

/**
 * Gateway tuning must reach the gateway and nothing else.
 *
 * `reasoning.effort` is an OpenRouter-only request field. It used to be applied
 * to "anything that isn't Anthropic" — correct while only OpenRouter spoke the
 * OpenAI wire, and a 400 on every provider added since. OpenAI is the live proof:
 * polish is routed there now, so an unscoped field is a real failure, not a
 * hypothetical one.
 */
test('gateway-only request tuning is scoped by provider, not by wire shape', () => withCleanEnv(async () => {
  process.env.OPENAI_API_KEY = 'sk-oai-real';
  const calls = stubFetch(async () => completionResponse('polished'));

  await completeWithFallback('polish', {
    user: 'hi',
    extraBody: (target) => (target.provider === 'openrouter'
      ? { reasoning: { effort: 'none' } }
      : null),
  });

  assert.equal(calls[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal('reasoning' in calls[0].body, false,
    'an OpenRouter-gateway field leaked to OpenAI, which answers 400 for an unknown key');

  // …and it still reaches the gateway when that IS the provider being called.
  delete process.env.OPENAI_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  const gatewayCalls = stubFetch(async () => completionResponse('polished'));

  await completeWithFallback('polish', {
    user: 'hi',
    extraBody: (target) => (target.provider === 'openrouter'
      ? { reasoning: { effort: 'none' } }
      : null),
  });

  assert.deepEqual(gatewayCalls[0].body.reasoning, { effort: 'none' },
    'scoping must not stop the field reaching the gateway it is meant for');
}));

test('a broken extraBody selector degrades to no tuning, never to a failed call', () =>
  withCleanEnv(async () => {
    process.env.GROQ_API_KEY = 'gsk-real';
    const calls = stubFetch(async () => completionResponse('fine'));

    const result = await complete('systemDetection', {
      user: 'hi',
      extraBody: () => { throw new Error('selector bug'); },
    });

    assert.equal(result.ok, true, 'a selector that throws must not take the completion with it');
    assert.equal(calls.length, 1);
  }));

test('a working primary is used and the fallback is never called', () => withCleanEnv(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  const calls = stubFetch(async (url) => (String(url).includes('anthropic')
    ? { status: 200, ok: true, json: async () => ({ content: [{ type: 'text', text: 'from anthropic' }] }) }
    : { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'from openrouter' } }] }) }));

  const result = await completeWithFallback('chat', { messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.ok, true);
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.text, 'from anthropic');
  assert.equal(calls.length, 1, 'a working primary must not also spend the fallback');
}));

test('an unfunded primary falls through and the source names the real provider', () =>
  withCleanEnv(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    process.env.OPENROUTER_API_KEY = 'sk-or-real';
    const calls = stubFetch(async (url) => (String(url).includes('anthropic')
      ? { status: 400, ok: false, text: async () => '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}' }
      : { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'answer' } }] }) }));

    const result = await completeWithFallback('chat', { messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(result.ok, true);
    // This is the whole point: a client must never be told "anthropic" by a
    // reply OpenRouter produced.
    assert.equal(result.provider, 'openrouter');
    assert.equal(calls.length, 2);
    assert.equal(result.attempts.length, 2);
    assert.equal(result.attempts[0].ok, false);
    assert.match(result.attempts[0].error, /no credit/i, 'the fallback reason must name the real cause');
    assert.equal(result.attempts[1].ok, true);
  }));

test('an exhausted chain reports every provider it tried, and why', () =>
  withCleanEnv(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    process.env.OPENROUTER_API_KEY = 'sk-or-real';
    stubFetch(async () => ({ status: 500, ok: false, text: async () => 'boom' }));

    const result = await completeWithFallback('chat', { messages: [{ role: 'user', content: 'hi' }] });

    assert.equal(result.ok, false);
    assert.deepEqual(result.attempts.map((a) => a.provider), ['anthropic', 'openrouter']);
  }));

test('an entirely unconfigured chain names every key that is missing', () =>
  withCleanEnv(async () => {
    // Naming only the primary would send an operator to fix one key and hit the
    // identical wall on the next one.
    const result = await completeWithFallback('chat', { messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.ok, false);
    assert.match(result.error, /ANTHROPIC_API_KEY/);
    assert.match(result.error, /OPENROUTER_API_KEY/);
    assert.equal(result.attempts.length, 2);
  }));

test('an Anthropic chat body lifts system out and merges same-role turns', () =>
  withCleanEnv(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    const calls = stubFetch(() => ({ status: 400, ok: false, text: async () => '{"error":{"message":"credit"}}' }));

    await completeWithFallback('chat', {
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'assistant', content: 'stray leading turn' },
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'three' },
      ],
    });

    const body = calls[0].body;
    assert.equal(body.system, 'be helpful', 'system must be top-level for the Messages API');
    assert.ok(!body.messages.some((m) => m.role === 'system'), 'a system role in messages is a 400');
    // Adjacent same-role turns are rejected by this API, so they must be
    // merged; and a conversation must not open on an assistant turn.
    assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.equal(body.messages[0].content, 'one\n\ntwo');
  }));

test('provider-specific tuning is not sent to a provider that would reject it', () =>
  withCleanEnv(async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    process.env.OPENROUTER_API_KEY = 'sk-or-real';
    const calls = stubFetch(async (url) => (String(url).includes('anthropic')
      ? { status: 400, ok: false, text: async () => '{"error":{"message":"credit"}}' }
      : { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }));

    await completeWithFallback('chat', {
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }],
      extraBody: { reasoning: { effort: 'none' } },
    });

    // `reasoning` is an OpenRouter-gateway field; Anthropic answers an unknown
    // top-level key with a 400. It must reach only the wire that understands it.
    assert.equal('reasoning' in calls[0].body, false, 'leaked gateway tuning to Anthropic');
    assert.deepEqual(calls[1].body.reasoning, { effort: 'none' });
    // …and the OpenRouter body keeps its system message rather than the
    // Anthropic lifted form.
    assert.equal(calls[1].body.messages[0].role, 'system');
  }));

test('latency measures the whole call, not just the response headers', () => withCleanEnv(async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  // A generation can hold the connection open long after headers arrive. Timing
  // at headers reported an 810 ms call that really took ~14 s, and that number
  // is what the admin panel shows as "round trip".
  stubFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: 'slow but complete' } }] }) };
  });

  // `assessment` rather than `polish`: polish's primary is OpenAI, and this
  // test measures latency on the OpenAI wire with only the default key set.
  const result = await complete('assessment', { user: 'hi' });
  assert.equal(result.ok, true);
  assert.ok(result.latencyMs >= 55, `latency ${result.latencyMs} ms ignored the body read`);
}));

test('a primary cannot spend the whole budget when a fallback is waiting', () => {
  // Asserted as arithmetic rather than by waiting out a real timeout: the rule
  // is what matters, and a 5 s sleep per case would be a slow suite.
  // Chat asks for 15 s.
  const primary = splitTimeout(2, 15000);
  assert.ok(primary < 15000, 'the primary must not get the whole budget');
  assert.ok(primary >= PRIMARY_BUDGET_FLOOR_MS, 'the primary still gets a real chance');

  // The last provider in the chain keeps whatever is left.
  assert.equal(splitTimeout(1, 15000), 15000);

  // A long chain never starves an early provider below the floor.
  for (const remaining of [2, 3, 5, 10]) {
    assert.ok(splitTimeout(remaining, 15000) >= PRIMARY_BUDGET_FLOOR_MS,
      `${remaining} providers starved the primary below the floor`);
  }

  // A tiny caller budget is floored, not divided into nothing — a 200 ms share
  // would abort before a request could leave, making the fallback unreachable.
  assert.equal(splitTimeout(2, 200), PRIMARY_BUDGET_FLOOR_MS);

  // Nonsense in, sensible out. "No budget given" means USE THE DEFAULT — and
  // the default is then split like any other budget, not waved through whole.
  assert.equal(splitTimeout(0, 15000), 15000, 'a spent chain keeps the caller budget');
  assert.equal(splitTimeout(1, 0), DEFAULT_TIMEOUT_MS, 'a lone provider gets the whole default');
  assert.equal(splitTimeout(2, 0), Math.floor(DEFAULT_TIMEOUT_MS / 2), 'a chain still splits the default');
  assert.equal(splitTimeout(2, -5), splitTimeout(2, 0), 'a negative budget is treated as absent');
  assert.equal(splitTimeout(2, NaN), splitTimeout(2, 0), 'a non-numeric budget is treated as absent');
});

test('an empty conversation never reaches a provider', () => withCleanEnv(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
  process.env.OPENROUTER_API_KEY = 'sk-or-real';
  const calls = stubFetch(() => { throw new Error('must not be called'); });

  const result = await completeWithFallback('chat', { messages: [] });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
}));
