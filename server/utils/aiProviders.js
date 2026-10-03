/**
 * AI provider health checks for the admin dashboard's "Connected AI
 * providers" panel.
 *
 * WHY THIS EXISTS
 * ---------------
 * The panel used to report `Boolean(process.env.X_API_KEY)` and label it
 * "Configured". That only proves an environment variable exists — it says
 * nothing about whether the key is valid or the provider answers, and it made
 * an OpenAI key that no route in this server even reads look like live AI. Each
 * provider is now asked directly, so a card can say Reachable, Key rejected or
 * Unreachable and quote the latency it actually saw.
 *
 * CACHING
 * -------
 * The dashboard polls `/api/admin/ai` every 10 s. Without a cache each poll
 * would open up to four outbound connections — slow to answer, and a needless
 * way to spend somebody else's rate limit. Results are held for
 * AI_CHECK_TTL_MS, and a check already in flight is shared rather than
 * duplicated, so a burst of concurrent polls produces exactly one outbound
 * request per provider.
 *
 * Nothing here logs or returns key material: only whether a key exists.
 */

const { reloadFromDisk, isEnvStale } = require('./envFile');

/** Freshness window for a completed check. */
const AI_CHECK_TTL_MS = 30 * 1000;

/** Hard ceiling on a single provider probe, so one hung host cannot stall the panel. */
const AI_PROBE_TIMEOUT_MS = 5000;

/**
 * `usedBy` is DERIVED from the routing table rather than written beside the
 * provider. See `providerUsage()` below for why that matters: the old version
 * was a hand-maintained string, and a card that says "no route in this server
 * calls it yet" while routes to that provider exist is worse than no card at
 * all — it sends the operator to edit a file when nothing is wrong.
 *
 * `defaultModel` is the model a provider is actually called with when the env
 * override is absent. It must be a real, currently-served model id — a card
 * that says "No model selected" for a provider that is otherwise healthy is
 * telling the admin nothing useful, and inventing a plausible-looking id that
 * the key cannot use would be worse still.
 *
 * `verifyModel` opts a provider into reading the model list back out of the
 * probe response, so the panel can say whether the resolved model is one the
 * key can actually reach. It is opt-in because the cost is wildly uneven and
 * was measured, not guessed:
 *   - api.openai.com/v1/models  -> ~1 KB, ~0.3-1.3 s  (worth reading)
 *   - api.groq.com + api.anthropic.com -> small       (worth reading)
 *   - openrouter.ai/api/v1/models -> ~752 KB, and a COLD fetch measured 10.7 s
 * OpenRouter is therefore left off: reading a 752 KB body cannot fit inside
 * AI_PROBE_TIMEOUT_MS, so the probe would abort and the card would report
 * "Unreachable" for a provider that is perfectly healthy. Its model is pinned
 * in three call sites anyway, so there is nothing to verify.
 *
 * `chatUrl` / `chatCompatible` / `wire` are what aiRouter.js dispatches
 * completions with. All three are declared EXPLICITLY on every provider rather
 * than inferred or defaulted: the router requires `chatCompatible === true`, so
 * a missing flag reads as "cannot be routed to" and not "can", and `wire` picks
 * the request/response shape. Relying on an implicit `'openai'` default left
 * three providers whose shape was a guess — and Anthropic's Messages API is
 * genuinely different (a top-level `system`, no `role: 'system'` message), so
 * guessing it wrong is a 400 that reads like a payload bug.
 */
const AI_PROVIDERS = [
  {
    key: 'openrouter',
    label: 'OpenRouter (DeepSeek V4 Flash)',
    envKey: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'deepseek/deepseek-v4-flash-0731',
    url: 'https://openrouter.ai/api/v1/models',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    chatCompatible: true,
    wire: 'openai',
    auth: 'bearer',
    verifyModel: false,
  },
  {
    key: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    // Pinned against the key's OWN model list, which was read live rather than
    // assumed: it serves 11 models and llama-3.3-70b-versatile — the model this
    // slot was originally specified for — is NOT among them. gpt-oss-120b is the
    // strongest model the key can actually reach, returns clean JSON under
    // `response_format: json_object` (verified, ~1.1 s), and the probe verifies
    // the resolved id on every check, so a future removal surfaces as
    // "Model unavailable" in 30 s instead of failing the first real prediction.
    // The other candidates on this key: openai/gpt-oss-20b, qwen/qwen3.8-27b,
    // and the meta-llama/llama-prompt-guard-2-* pair, which are injection
    // classifiers rather than general reasoners.
    defaultModel: 'openai/gpt-oss-120b',
    url: 'https://api.groq.com/openai/v1/models',
    chatUrl: 'https://api.groq.com/openai/v1/chat/completions',
    chatCompatible: true,
    wire: 'openai',
    auth: 'bearer',
    verifyModel: true,
  },
  {
    key: 'openai',
    label: 'OpenAI',
    envKey: 'OPENAI_API_KEY',
    modelEnv: 'OPENAI_MODEL',
    // Pinned, not guessed: a sensible current general model that this kind of
    // project (latency-sensitive chat + short structured answers) can afford.
    // OPENAI_MODEL overrides it, and the probe verifies the result against the
    // key's own model list, so a bad override is caught in 30 s rather than at
    // the first real completion.
    defaultModel: 'gpt-5.4-nano',
    url: 'https://api.openai.com/v1/models',
    chatUrl: 'https://api.openai.com/v1/chat/completions',
    chatCompatible: true,
    wire: 'openai',
    auth: 'bearer',
    verifyModel: true,
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    // Pinned against the key's OWN model list, read live rather than assumed: it
    // serves 13 models (claude-fable-5, the claude-haiku/sonnet/opus families).
    // Haiku 4.5 is the right tier here — chat is the product's only genuinely
    // conversational feature, and priority flagging is a short classification of
    // a few hundred tokens that runs on every assessment submit and must never be
    // the expensive call in the request path.
    defaultModel: 'claude-haiku-4-5-20251001',
    url: 'https://api.anthropic.com/v1/models',
    chatUrl: 'https://api.anthropic.com/v1/messages',
    chatCompatible: true,
    // NOT OpenAI-shaped. The Messages API takes `system` as a top-level field
    // and has no `role: 'system'` message, so the router builds a different
    // body and reads a different response shape for this provider.
    wire: 'anthropic',
    auth: 'x-api-key',
    verifyModel: true,
  },
  {
    key: 'llama',
    label: 'Llama (self-hosted gateway)',
    envKey: 'LLAMA_API_KEY',
    modelEnv: 'LLAMA_MODEL',
    // A self-hosted gateway has no public hostname to hard-code — it is
    // whatever machine serves it, on whatever port. So the base URL comes from
    // the environment, and both endpoints are derived from it. Guessing a host
    // here would send a real credential somewhere unverified on every poll.
    baseUrlEnv: 'LLAMA_BASE_URL',
    // No default: which model a self-hosted gateway serves is a property of how
    // that deployment was set up, and there is no honest way to guess it. The
    // panel says "No model selected" and the router refuses to dispatch until
    // one is chosen — which is the same rule every other provider follows.
    defaultModel: null,
    auth: 'bearer',
    // LiteLLM, Ollama, vLLM and friends all speak the OpenAI wire format.
    chatCompatible: true,
    wire: 'openai',
    verifyModel: true,
  },
];

/**
 * The purposes a provider actually serves, read from the ROUTING TABLE.
 *
 * WHY THIS IS DERIVED AND NOT DECLARED
 * ------------------------------------
 * `usedBy` used to be a string written by hand next to each provider, and the
 * two halves were free to disagree. They did: `polish` and `assessment` were
 * both dispatched to OpenRouter while its `usedBy` still listed the OLD four
 * call sites, so the card described work that no longer happened while the
 * real assignment was invisible. It is the same class of bug as two call sites
 * disagreeing about a model id — a fact stated in two places that nothing
 * compares — and the fix is the same one aiRouter.js was written for: say it
 * once.
 *
 * So the routing table is the ONLY place an assignment is declared, and this
 * reads it. A card can no longer claim "no route in this server calls it yet"
 * while a route to it exists, and adding a purpose to AI_ROUTES updates every
 * card at once with no second edit to remember.
 *
 * NULL is meaningful and is not softened into a friendly string: a provider
 * nothing routes to really is spendable by no feature, and the panel says so.
 * The self-hosted gateway is the shipped example — probed for health, carrying
 * a valid key, and genuinely called by nothing until an operator both points
 * LLAMA_BASE_URL at their box and picks a model it serves.
 *
 * The require is lazy and guarded because the two modules require each other:
 * aiRouter needs the provider REGISTRY to resolve a route, so this module is
 * fully loaded before aiRouter's is. Deferring the read to call time (rather
 * than module time) is what makes that ordering safe, and the try/catch keeps a
 * circular-require failure from taking the health panel down — it degrades to
 * "no purposes known", which is the old hand-written state, not a crash.
 *
 * @param {{key: string}|string} provider a registry entry, or its key
 * @returns {string|null} the routing labels, or null when nothing routes to it
 */
function providerUsage(provider) {
  const key = typeof provider === 'string' ? provider : (provider && provider.key);
  if (!key) return null;

  let routes;
  try {
    ({ AI_ROUTES: routes } = require('./aiRouter'));
  } catch {
    return null;
  }
  if (!Array.isArray(routes)) return null;

  const labels = routes
    .filter((route) => route && route.provider === key)
    .map((route) => String(route.label || route.purpose || '').trim())
    .filter(Boolean);
  return labels.length ? labels.join(' · ') : null;
}

/**
 * The two endpoints for a provider, resolving a self-hosted base URL when the
 * provider declares one.
 *
 * Split out because the URL is no longer a constant in the registry for every
 * entry, and two very different consumers need it: the health probe (which
 * fetches the model list) and the router (which POSTs completions). If each
 * built its own URL they would drift — the exact class of bug the routing table
 * exists to prevent.
 *
 * A base URL is normalised rather than trusted: trimmed, given a scheme if it
 * was pasted bare, and stripped of a trailing slash, so `http://host:8080`,
 * `http://host:8080/` and `http://host:8080/v1` all behave.
 *
 * @param {object} provider
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{url: string|null, chatUrl: string|null, baseUrl: string|null, error: string|null}}
 */
function resolveEndpoints(provider, env = process.env) {
  if (!provider.baseUrlEnv) {
    return {
      url: provider.url || null,
      chatUrl: provider.chatUrl || null,
      baseUrl: null,
      error: null,
    };
  }

  const raw = String(env[provider.baseUrlEnv] == null ? '' : env[provider.baseUrlEnv]).trim();
  if (!raw) {
    return {
      url: null, chatUrl: null, baseUrl: null,
      error: `No gateway address — set ${provider.baseUrlEnv} to the base URL of your `
        + 'self-hosted gateway (for example http://localhost:4000).',
    };
  }

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const trimmed = withScheme.replace(/\/+$/, '');
  // Tolerate a base that already ends in /v1, which is how most of these
  // gateways document theirs — appending another would give /v1/v1/models.
  const root = /\/v\d+$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;

  return { url: `${root}/models`, chatUrl: `${root}/chat/completions`, baseUrl: trimmed, error: null };
}

/**
 * The shipped .env.example fills every key with `your_..._api_key_here`.
 * A literal placeholder is not a credential and must never read as configured.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlaceholderKey(value) {
  return /^your_[a-z0-9_]*_here$/i.test(String(value == null ? '' : value).trim());
}

/**
 * The usable credential for an env var, or null when there is none worth
 * sending. Trims, treats an empty string as absent, and discards the
 * .env.example placeholder.
 * @param {string} envKey
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function resolveKey(envKey, env = process.env) {
  const raw = String(env[envKey] == null ? '' : env[envKey]).trim();
  if (!raw || isPlaceholderKey(raw)) return null;
  return raw;
}

/**
 * The model this provider would actually be called with: an explicit override
 * if set, else the provider's real default, else null — a provider with no
 * model chosen must say so rather than print a placeholder string.
 * @param {{modelEnv: string, defaultModel: string|null}} provider
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function resolveModel(provider, env = process.env) {
  const override = String(env[provider.modelEnv] == null ? '' : env[provider.modelEnv]).trim();
  return override || provider.defaultModel || null;
}

/** Response shape shared by every exit path, so the client never branches on a missing field. */
function result(provider, fields) {
  return {
    key: provider.key,
    label: provider.label,
    // The NAME of the variable this provider is configured with. Not a
    // credential — the value never leaves the process — but the panel needs it
    // so the "no keys are set" state can tell the operator exactly which line to
    // add instead of saying "configure something".
    envKey: provider.envKey,
    // Derived from the routing table rather than declared here — see
    // `providerUsage()`. Resolved on every exit path so a card cannot describe
    // work that no longer happens, or hide work that does.
    usedBy: providerUsage(provider),
    model: null,
    // null = "not determined" (no key, no model, verification off, or a body we
    // could not parse). Only true/false ever asserts something about the key.
    modelAvailable: null,
    modelCount: null,
    configured: false,
    status: 'unconfigured',
    reachable: false,
    latencyMs: null,
    detail: '',
    // The address a self-hosted provider is dialled at, or null for a public
    // SaaS. Resolved HERE rather than in each caller so every exit path carries
    // it — an operator debugging a local gateway needs to see the host, not
    // infer it, and "Unreachable" without the address sends them looking at the
    // network instead of at one .env value.
    baseUrl: resolveEndpoints(provider).baseUrl,
    checkedAt: new Date().toISOString(),
    ...fields,
  };
}

/**
 * Pull the model ids out of a provider's model-list body.
 *
 * OpenAI, OpenRouter, Groq and Anthropic all return `{ data: [{ id }] }`, so
 * one reader serves all four. Anything else — an HTML error page from a proxy,
 * a truncated body, a stub without `json()` — yields null rather than throwing,
 * because a panel must never die because a response was shaped unexpectedly.
 *
 * @param {Response|{json?: Function}} response
 * @returns {string[]|null}
 */
async function readModelIds(response) {
  if (!response || typeof response.json !== 'function') return null;
  try {
    const body = await response.json();
    const rows = body && Array.isArray(body.data) ? body.data : null;
    if (!rows) return null;
    return rows
      .map((row) => (row && typeof row.id === 'string' ? row.id.trim() : ''))
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The model-related half of a card's detail line.
 *
 * The point is to catch the failure that is otherwise invisible until a real
 * user request fails: a model that is spelled correctly but is not served to
 * THIS key (a project-scoped key sees a short list — 7 models on the OpenAI
 * key this repo ships, not the full public catalogue).
 *
 * @param {string|null} model
 * @param {string[]|null} ids
 * @param {string|null} modelEnv the override var, so the fix is nameable
 * @returns {{modelAvailable: boolean|null, modelCount: number|null, note: string}}
 */
function describeModels(model, ids, modelEnv) {
  if (!ids) return { modelAvailable: null, modelCount: null, note: '' };
  const modelCount = ids.length;
  if (!model) {
    return { modelAvailable: null, modelCount, note: `${modelCount} models available.` };
  }
  const available = ids.includes(model);
  const note = available
    ? `${modelCount} models available.`
    : `${modelCount} models available, but "${model}" is not among them — set ${modelEnv} to one this key can reach.`;
  return { modelAvailable: available, modelCount, note };
}

/**
 * Probe one provider with a real request.
 *
 * Never throws: an unreachable host is a result, not an exception, so one
 * failing provider cannot take the whole panel down with it.
 *
 * @param {typeof AI_PROVIDERS[number]} provider
 * @returns {Promise<ReturnType<typeof result>>}
 */
async function checkAiProvider(provider) {
  const key = resolveKey(provider.envKey);
  const model = resolveModel(provider);
  // Resolved up front so the address can be reported on every exit path below,
  // including the ones that never make a request.
  const endpoints = resolveEndpoints(provider);

  if (!key) {
    return result(provider, {
      model,
      status: 'unconfigured',
      detail: `No key set — add ${provider.envKey} to activate this provider.`,
    });
  }

  // A self-hosted provider has no URL in the registry; it comes from the
  // environment. Checked AFTER the key, so "no key" stays the first thing an
  // operator is told — that is the thing they have to fix first.
  if (!endpoints.url) {
    return result(provider, {
      model,
      configured: true,
      status: 'unconfigured',
      detail: endpoints.error,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_PROBE_TIMEOUT_MS);
  const started = Date.now();

  try {
    // Anthropic authenticates with a dedicated header and requires a version
    // pin; every other provider here speaks the OpenAI-style Bearer scheme.
    const headers = provider.auth === 'x-api-key'
      ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

    const response = await fetch(endpoints.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;

    if (response.status === 401 || response.status === 403) {
      return result(provider, {
        model, configured: true, status: 'rejected', reachable: true, latencyMs,
        detail: `Key rejected (HTTP ${response.status}) after ${latencyMs} ms — rotate ${provider.envKey}.`,
      });
    }
    if (!response.ok) {
      return result(provider, {
        model, configured: true, status: 'error', reachable: true, latencyMs,
        detail: `Provider answered HTTP ${response.status} after ${latencyMs} ms.`,
      });
    }

    // Only read the body where it is cheap (see AI_PROVIDERS.verifyModel);
    // elsewhere `ids` stays null and the card simply omits the model note.
    const ids = provider.verifyModel ? await readModelIds(response) : null;
    const models = describeModels(model, ids, provider.modelEnv);

    // A key that works but is pointed at a model it cannot reach is not
    // "Reachable" in any useful sense — the next real completion will 404. It
    // gets its own state so the admin sees a distinct, named problem.
    if (models.modelAvailable === false) {
      return result(provider, {
        model, configured: true, status: 'model-unavailable', reachable: true, latencyMs,
        modelAvailable: false, modelCount: models.modelCount,
        detail: `Key accepted (HTTP ${response.status}) but ${models.note}`,
      });
    }

    return result(provider, {
      model, configured: true, status: 'ok', reachable: true, latencyMs,
      modelAvailable: models.modelAvailable, modelCount: models.modelCount,
      detail: models.note
        ? `Reachable — HTTP ${response.status} after ${latencyMs} ms. ${models.note}`
        : `Reachable — HTTP ${response.status} after ${latencyMs} ms.`,
    });
  } catch (error) {
    const latencyMs = Date.now() - started;
    const reason = error && error.name === 'AbortError'
      ? `timed out after ${AI_PROBE_TIMEOUT_MS / 1000} s`
      : ((error && error.message) || 'network error');
    return result(provider, {
      model, configured: true, status: 'unreachable', reachable: false, latencyMs,
      // For a self-hosted provider the ADDRESS is the most likely thing to be
      // wrong, so it is named. "fetch failed" on its own sends an operator
      // looking at the network, when the fix is one character in a .env value.
      // A public provider has no such knob, so it is left unsaid.
      detail: `Unreachable — ${reason}.${endpoints.baseUrl ? ` (tried ${endpoints.baseUrl})` : ''}`,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** key -> { inFlight, settledAt, promise } */
const cache = new Map();

/**
 * Check a provider, reusing a shared result where that is safe:
 *  - an in-flight check is always reused (no stampede);
 *  - a settled one is reused while it is younger than AI_CHECK_TTL_MS;
 *  - `force` discards a settled result but still joins an in-flight check.
 *
 * @param {typeof AI_PROVIDERS[number]} provider
 * @param {{force?: boolean}} [options]
 * @returns {Promise<ReturnType<typeof result>>}
 */
function cachedAiCheck(provider, { force = false } = {}) {
  const hit = cache.get(provider.key);
  if (hit) {
    if (hit.inFlight) return hit.promise;
    if (!force && Date.now() - hit.settledAt < AI_CHECK_TTL_MS) return hit.promise;
  }

  const entry = { inFlight: true, settledAt: Date.now(), promise: null };
  // `.catch` is the backstop for anything `checkAiProvider` did not already
  // turn into a result. It must not lose what it already knows: a key WAS
  // resolved and the request WAS attempted, so the card must keep reading as
  // configured/reachable. Dropping them here (as this used to) made a crash in
  // the probe render as "Not configured" — telling the admin to add a key they
  // had already added.
  entry.promise = checkAiProvider(provider)
    .catch((error) => result(provider, {
      configured: true,
      status: 'error',
      reachable: true,
      model: resolveModel(provider),
      detail: `Check failed — ${error && error.message ? error.message : 'unknown error'}`,
    }))
    .finally(() => {
      entry.inFlight = false;
      entry.settledAt = Date.now();
    });

  cache.set(provider.key, entry);
  return entry.promise;
}

/**
 * Check every provider concurrently.
 *
 * `force` — the admin panel's "Check now" — re-reads server/.env first. That is
 * the whole point of the button: an admin who has just pasted a new key into
 * the file must see the verdict for THAT key, and without the reload they would
 * see the old one still sitting in process.env and conclude the new key is
 * broken. It reports which variable NAMES changed so the caller can say so
 * (values never leave this module).
 *
 * `reload` exists so the ROUTE can own the reload and see its outcome. It used
 * to be fired and forgotten in here, which meant a reload that failed — a
 * missing or unparseable server/.env — was indistinguishable from one that
 * worked: the panel reported a clean reload while quietly re-probing every
 * provider with the exact same pre-edit keys, and re-showed the same "rejected"
 * verdict for a key that was fine. The caller that has to tell the admin whether
 * the reload worked therefore has to be the one that performs it.
 *
 * The 10 s poll deliberately does not reload: a half-typed .env being read
 * every 10 s would make the panel flap, and staleness is reported honestly
 * instead (see isEnvStale in the route).
 *
 * @param {{force?: boolean, reload?: boolean}} [options]
 * @returns {Promise<ReturnType<typeof result>[]>}
 */
async function getAiProviders({ force = false, reload = force } = {}) {
  if (reload) reloadFromDisk();
  return Promise.all(AI_PROVIDERS.map((provider) => cachedAiCheck(provider, { force })));
}

/** Test seam: drop cached results so a later check runs for real. */
function clearAiCheckCache() {
  cache.clear();
}

/**
 * The panel-level timestamp: the OLDEST probe in the batch, so the header can
 * never claim the whole panel was just checked while one card is stale.
 *
 * ISO-8601 UTC strings compare chronologically as plain strings, so a `<` is
 * enough — but the seed MUST be null, not '': every non-empty string is
 * GREATER than the empty string, so seeding with '' makes nothing ever win and
 * the caller falls through to `new Date()` (i.e. "checked just now"), which is
 * precisely the dishonest answer this value exists to prevent.
 *
 * @param {{checkedAt?: string}[]|null|undefined} providers
 * @returns {string|null} the earliest timestamp, or null if none was recorded
 */
function oldestCheck(providers) {
  let earliest = null;
  for (const provider of providers || []) {
    const at = provider && provider.checkedAt;
    if (!at) continue;
    if (!earliest || at < earliest) earliest = at;
  }
  return earliest;
}

module.exports = {
  AI_PROVIDERS,
  AI_CHECK_TTL_MS,
  AI_PROBE_TIMEOUT_MS,
  isPlaceholderKey,
  resolveKey,
  resolveModel,
  resolveEndpoints,
  providerUsage,
  readModelIds,
  describeModels,
  checkAiProvider,
  cachedAiCheck,
  getAiProviders,
  clearAiCheckCache,
  isEnvStale,
  oldestCheck,
};
