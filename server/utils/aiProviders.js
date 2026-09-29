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
 * `usedBy` is null for a provider no route in this server consumes. Saying so
 * is the honest half of "Configured": a key can be present and do nothing.
 * The OpenRouter entry mirrors the model each of its call sites hard-codes.
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
 */
const AI_PROVIDERS = [
  {
    key: 'openrouter',
    label: 'OpenRouter (DeepSeek V4 Flash)',
    envKey: 'OPENROUTER_API_KEY',
    modelEnv: 'OPENROUTER_MODEL',
    defaultModel: 'deepseek/deepseek-v4-flash-0731',
    url: 'https://openrouter.ai/api/v1/models',
    auth: 'bearer',
    usedBy: 'Assessment results, AI chat, detail mode, text polish',
    verifyModel: false,
  },
  {
    key: 'groq',
    label: 'Groq',
    envKey: 'GROQ_API_KEY',
    modelEnv: 'GROQ_MODEL',
    defaultModel: null,
    url: 'https://api.groq.com/openai/v1/models',
    auth: 'bearer',
    usedBy: null,
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
    auth: 'bearer',
    usedBy: null,
    verifyModel: true,
  },
  {
    key: 'anthropic',
    label: 'Anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    modelEnv: 'ANTHROPIC_MODEL',
    defaultModel: null,
    url: 'https://api.anthropic.com/v1/models',
    auth: 'x-api-key',
    usedBy: null,
    verifyModel: true,
  },
];

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
    usedBy: provider.usedBy || null,
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

  if (!key) {
    return result(provider, {
      model,
      status: 'unconfigured',
      detail: `No key set — add ${provider.envKey} to activate this provider.`,
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

    const response = await fetch(provider.url, {
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
      detail: `Unreachable — ${reason}.`,
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
  readModelIds,
  describeModels,
  checkAiProvider,
  cachedAiCheck,
  getAiProviders,
  clearAiCheckCache,
  isEnvStale,
  oldestCheck,
};
