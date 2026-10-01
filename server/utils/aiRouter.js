/**
 * Purpose-based AI routing.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every AI call site used to hard-code its own provider URL, model id and key:
 * `recommend.js`, `chat.js`, `polish.js` and `supplement_detail.js` each
 * spelled out `https://openrouter.ai/...` and a model string, while
 * `aiProviders.js` told the admin dashboard a *fourth*, different model id. The
 * two already disagreed — `chat.js` and `polish.js` send
 * `deepseek/deepseek-v4-flash` while the panel reported
 * `deepseek/deepseek-v4-flash-0731` — and because OpenRouter's probe sets
 * `verifyModel: false` (its model list is ~752 KB and cannot be read inside the
 * 5 s probe budget), nothing would ever catch it. A typo in a model id is
 * invisible until a real user request fails.
 *
 * So provider choice is decided in ONE place, from the purpose of the call.
 * A call site asks for `chat` and gets whatever provider is configured for
 * `chat`, rather than naming a vendor and a model and hoping they agree.
 *
 * THE SPLIT THIS ENCODES
 * ----------------------
 * Work is SPREAD across providers by the SHAPE of the job, so no single
 * provider — least of all the default — carries every request the product
 * makes:
 *
 *   assessment, supplementDetail -> OpenRouter. The two features that write a
 *     member's health content in long form. Their behaviour must not change, so
 *     they stay on the DEFAULT provider and the cheapest strong model for the
 *     job.
 *   chat, priorityFlagging      -> Anthropic. A conversation, and a short
 *     clinical classification that runs on the submit path.
 *   polish                      -> OpenAI. Every assessment submission rewrites
 *     a free-text description before anything else runs, so this is the
 *     highest-frequency user-facing call in the product — and the shortest. A
 *     nano-class model is the right shape for it, and keeping it off the
 *     default is what stops one provider absorbing all of that traffic.
 *   systemDetection             -> Groq. Detection is short, structured,
 *     latency-sensitive and runs on a timer, which is exactly Groq's shape.
 *
 * Every provider now has at least one REAL purpose, which is also what makes
 * `providerUsage()` in aiProviders.js meaningful: a card can no longer say "no
 * route in this server calls it yet" while routes to it exist.
 *
 * Neither assignment is hard-coded into a route, so an operator who wants a
 * different split changes it here, not in five files.
 *
 * THE DEFAULT, WHEN NOTHING IS CONNECTED
 * --------------------------------------
 * A purpose whose own provider is not configured is served by the DEFAULT
 * provider — OpenRouter unless `AI_DEFAULT_PROVIDER` says otherwise. See
 * `defaultProviderKey` for the rule and, more importantly, for the boundary it
 * draws: this is a CONFIGURATION-time substitution, not a runtime one, and it
 * never redirects a purpose to an arbitrary provider that happens to be
 * connected.
 *
 * The practical effect is the point. Before it, an operator who set the single
 * key the panel labels "Default AI" got four working features out of six, and
 * had to reverse-engineer that the other two were hard-wired to vendors whose
 * keys they had never been asked for. Now one key serves the whole product, and
 * `describeRouting` reports the provider that will really answer, so the panel
 * cannot name an absent provider while OpenRouter is serving.
 *
 * FALLBACK
 * --------
 * `complete()` NEVER throws. A provider that is missing a key, rejecting the
 * key, timing out, or returning something that is not JSON all come back as
 * `{ ok: false, error }` so the caller can degrade to its deterministic
 * engine. Detection must keep working with the AI switched off — a security
 * panel that stops reporting because a third-party API is down is worse than
 * useless.
 *
 * Nothing here returns key material: `resolveTarget` hands the caller the key
 * to use for one request, and the key is never copied into a result object.
 */

/** The provider a purpose uses when nothing more specific is configured. */
const DEFAULT_PROVIDER = 'openrouter';

/**
 * Overrides which provider is the default. Optional; unset means OpenRouter.
 *
 * Present so the default is a deployment decision rather than a code edit, and
 * so the behaviour is testable without a real key in the environment.
 */
const DEFAULT_PROVIDER_ENV = 'AI_DEFAULT_PROVIDER';

const { AI_PROVIDERS, resolveKey, resolveModel, resolveEndpoints } = require('./aiProviders');

/**
 * The routing table. `purpose` is the vocabulary call sites speak; the admin
 * panel renders `label`, so it is written for a human.
 *
 * `provider` is a KEY into AI_PROVIDERS, not a URL — the URL, the model and the
 * credential all come from the same registry the health panel reads, which is
 * what makes "the card says Groq, the call went to Groq" structurally true
 * rather than a coincidence.
 */
const AI_ROUTES = [
  {
    purpose: 'assessment',
    label: 'Assessment recommendations',
    detail: 'Generates the personalised supplement plan from a completed assessment.',
    provider: DEFAULT_PROVIDER,
  },
  {
    purpose: 'chat',
    label: 'AI chat assistant',
    detail: 'Answers health and SuppliWise questions in the results-screen assistant.',
    provider: 'anthropic',
    // Chat is the one user-facing feature with a fallback, and it needs one.
    //
    // A provider key can be perfectly valid and still unable to serve a single
    // completion — Anthropic answers an exhausted balance as a 400, and the
    // model-list probe cannot see it. Moving chat to a provider in that state
    // without a fallback would put every user on the canned offline reply until
    // the account is funded, which is a far worse failure than using the second
    // provider for a while. The primary is still Anthropic: the fallback is
    // only reached when the primary genuinely cannot answer.
    //
    // The other four health features keep their existing fallbacks (a rule-based
    // clinical engine / basicClean / offlineFallback) and do NOT need this.
    fallback: DEFAULT_PROVIDER,
  },
  {
    purpose: 'polish',
    label: 'Health-description polish',
    detail: 'Rewrites a patient free-text description into clinical language.',
    // OpenAI, not the default. This is the busiest AI call in the product —
    // every assessment submit polishes a free-text description first — and it
    // is also the shortest job: a few hundred tokens at low temperature. A
    // nano-class model is the right shape for it, and keeping it off the default
    // is the point: before this, one provider absorbed assessment + chat +
    // polish + detail and every background activity, system detection and
    // priority flagging excepted, all of it competing for the same quota.
    provider: 'openai',
    // Its own fallback, for the same reason chat has one: a valid key can still
    // be unable to answer (exhausted credit is a 400 the health probe cannot
    // see), and a description that never gets polished is a degraded product
    // rather than a degraded feature.
    fallback: DEFAULT_PROVIDER,
  },
  {
    purpose: 'supplementDetail',
    label: 'Supplement detail mode',
    detail: 'Writes the personalised guide shown for a single supplement.',
    provider: DEFAULT_PROVIDER,
  },
  {
    purpose: 'systemDetection',
    label: 'System detection & threat prediction',
    detail: 'Reads the Security Center probe results and predicts what is likely to go wrong next.',
    provider: 'groq',
  },
  {
    purpose: 'priorityFlagging',
    label: 'Priority assessment flagging',
    detail: 'Second opinion on a submitted assessment, looking for clinical concern the rule engine missed. It can only escalate a flag, never clear one.',
    provider: 'anthropic',
  },
];

/** purpose -> route */
const ROUTE_BY_PURPOSE = new Map(AI_ROUTES.map((route) => [route.purpose, route]));

/** key -> provider entry */
const PROVIDER_BY_KEY = new Map(AI_PROVIDERS.map((provider) => [provider.key, provider]));

/** Completion calls are bounded; a hung provider must not pin a request handler. */
const DEFAULT_TIMEOUT_MS = 15000;

/**
 * The most a PRIMARY provider may spend when a fallback is waiting, however
 * much budget the caller offered. Below this the fallback is never reached in
 * practice, which makes having one pointless.
 */
const PRIMARY_BUDGET_FLOOR_MS = 5000;

/**
 * The provider registry entry for a key, or null.
 * @param {unknown} key
 * @returns {typeof AI_PROVIDERS[number]|null}
 */
function providerByKey(key) {
  return PROVIDER_BY_KEY.get(String(key || '')) || null;
}

/**
 * Which provider serves a purpose that has nothing else configured.
 *
 * THE RULE, and the boundary it draws deliberately
 * -------------------------------------------------
 * When a purpose resolves to NO usable provider — every candidate is missing a
 * key, is a placeholder, or cannot be routed to — the request goes to the
 * default provider instead of failing. That is what "OpenRouter is the default
 * AI" means in practice, and it is worth being precise about what it buys:
 *
 *   BEFORE, with only OPENROUTER_API_KEY set, four of the six features worked
 *   and two (systemDetection → Groq, priorityFlagging → Anthropic) failed,
 *   because their providers were hard-wired with no fallback. The operator had
 *   set the key the panel called "Default AI" and half the product was dark.
 *
 *   AFTER, that one key serves everything.
 *
 * The substitution is a CONFIGURATION-time decision, not a runtime one. A
 * provider that has a key and then gets rejected, times out, or returns nothing
 * does NOT reach this: that is the declared `fallback`'s job, and quietly adding
 * a third provider at request time would mask a broken key while the panel kept
 * reporting success. A silent fallback is indistinguishable from a provider that
 * simply worked, and an operator needs to know which of their keys is carrying
 * the load.
 *
 * It is also never a general "use whatever is connected" rule. Only the DEFAULT
 * is substituted, so setting a single key cannot redirect a health feature to an
 * unrelated vendor, and a purpose whose own provider is configured is untouched.
 *
 * A bad override is reported once and ignored — a typo here must not be able to
 * leave the server with no default at all.
 */
function defaultProviderKey(env = process.env) {
  const raw = String(env[DEFAULT_PROVIDER_ENV] || '').trim();
  if (!raw) return DEFAULT_PROVIDER;
  if (!providerByKey(raw)) {
    if (!warnedBadDefault) {
      warnedBadDefault = true;
      console.warn(
        `[aiRouter] ignoring ${DEFAULT_PROVIDER_ENV}="${raw}" — no such provider. `
        + `Known: ${[...PROVIDER_BY_KEY.keys()].join(', ')}. Using "${DEFAULT_PROVIDER}".`,
      );
    }
    return DEFAULT_PROVIDER;
  }
  return raw;
}

let warnedBadDefault = false;

/**
 * The route for a purpose, or null for an unknown one.
 *
 * An unknown purpose is a programming error, not a runtime condition, so it
 * throws: silently falling back to the default provider would let a typo'd
 * `purpose` send a security request to the health model.
 *
 * @param {string} purpose
 * @returns {typeof AI_ROUTES[number]}
 */
function routeFor(purpose) {
  const route = ROUTE_BY_PURPOSE.get(String(purpose || ''));
  if (!route) {
    throw new Error(
      `Unknown AI purpose "${purpose}". Known purposes: ${AI_ROUTES.map((r) => r.purpose).join(', ')}.`
    );
  }
  return route;
}

/**
 * Resolve a purpose into everything needed to make one request.
 *
 * Returns `ok: false` with a nameable `error` rather than throwing, because
 * every caller has a deterministic fallback to run and a thrown error would
 * skip it.
 *
 * @param {string} purpose
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {{ok: boolean, purpose: string, label: string, provider: string,
 *            providerLabel: string, model: string|null, apiKey: string|null,
 *            url: string, auth: string, error: string|null}}
 */
function resolveTarget(purpose, { env = process.env, providerOverride = null } = {}) {
  let route;
  try {
    route = routeFor(purpose);
  } catch (error) {
    return {
      ok: false, purpose: String(purpose || ''), label: '', provider: '', providerLabel: '',
      model: null, apiKey: null, url: '', auth: 'bearer', wire: 'openai', error: error.message,
    };
  }

  // `providerOverride` is how the fallback entry in a chain is resolved. It is
  // only ever set to another key from this same route's `fallback` field, so it
  // cannot be used to send a purpose somewhere the table did not name.
  const wanted = providerOverride || route.provider;
  const provider = providerByKey(wanted);
  if (!provider) {
    return {
      ok: false, purpose: route.purpose, label: route.label, provider: wanted,
      providerLabel: wanted, model: null, apiKey: null, url: '', auth: 'bearer', wire: 'openai',
      error: `Route "${route.purpose}" points at unknown provider "${wanted}".`,
    };
  }

  // A self-hosted provider's endpoint comes from the environment, not the
  // registry, so it is resolved here rather than read off the entry. Both
  // consumers (this and the health probe) go through the same helper, so the
  // URL a request is sent to can never differ from the one that was probed.
  const endpoints = resolveEndpoints(provider, env);

  const base = {
    purpose: route.purpose,
    label: route.label,
    provider: provider.key,
    providerLabel: provider.label,
    model: resolveModel(provider, env),
    url: endpoints.chatUrl,
    auth: provider.auth,
    // Which request/response shape this provider speaks. Defaults to the
    // OpenAI-compatible shape, which every provider here except Anthropic uses.
    wire: provider.wire || 'openai',
    error: null,
  };

  // Anthropic's Messages API is neither OpenAI-shaped nor configured for
  // completions, so refusing it here is honest rather than emitting a request
  // body the endpoint would reject. Nothing routes to it today.
  if (provider.chatCompatible !== true) {
    return { ...base, ok: false, apiKey: null, error: `${provider.label} is not available for AI routing.` };
  }

  const apiKey = resolveKey(provider.envKey, env);
  if (!apiKey) {
    return { ...base, ok: false, apiKey: null, error: `No key set — add ${provider.envKey} to activate this purpose.` };
  }

  if (!base.model) {
    return { ...base, ok: false, apiKey: null, error: `No model selected for ${provider.label}.` };
  }

  if (!base.url) {
    return { ...base, ok: false, apiKey: null, error: endpoints.error || `No endpoint configured for ${provider.label}.` };
  }

  return { ...base, ok: true, apiKey };
}

/**
 * The timeout one provider in a chain gets.
 *
 * The rule: a primary must not be able to spend the WHOLE budget when a
 * fallback is standing by — that is the entire point of having one. Measured
 * against a real account, a call that was going to fail took the caller's full
 * budget and the fallback was never reached.
 *
 * So the budget is split evenly across the providers that are left, with a
 * floor so the primary always gets a real chance (below it, the fallback is
 * unreachable in practice, which makes declaring one pointless). The LAST
 * provider keeps whatever is left rather than being squeezed to nothing — if it
 * has already failed, the caller's real budget is what it deserves.
 *
 * Exported as a pure function so the arithmetic is asserted directly rather
 * than inferred from a test that has to wait out a real timeout.
 *
 * @param {number} remaining providers still to try, including this one
 * @param {number} totalMs the caller's budget
 * @returns {number}
 */
function splitTimeout(remaining, totalMs) {
  const total = Number.isFinite(totalMs) && totalMs > 0 ? totalMs : DEFAULT_TIMEOUT_MS;
  if (remaining <= 1) return total;
  return Math.max(PRIMARY_BUDGET_FLOOR_MS, Math.floor(total / remaining));
}

/**
 * The ordered providers for a purpose: primary first, then any fallback, then
 * the default provider if the purpose has nothing usable of its own.
 *
 * Unresolvable entries are dropped rather than returned as failures, so a
 * caller can simply walk the chain and stop at the first that works. An empty
 * chain means nothing is configured for this purpose ANYWHERE — including the
 * default — which is the one case a caller must handle explicitly, and which
 * `completeWithFallback` reports by naming every key that is missing.
 *
 * @param {string} purpose
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {ReturnType<typeof resolveTarget>[]}
 */
function resolveChain(purpose, { env = process.env } = {}) {
  let route;
  try {
    route = routeFor(purpose);
  } catch {
    return [];
  }
  const chain = [resolveTarget(purpose, { env })];
  if (route.fallback && route.fallback !== route.provider) {
    // Resolved through the same path, so a fallback cannot be a different kind
    // of target than a primary (same validation, same model resolution).
    const fallback = resolveTarget(purpose, { env, providerOverride: route.fallback });
    if (fallback.ok) chain.push(fallback);
  }

  const usable = chain.filter((target) => target.ok);
  if (usable.length) return usable;

  // Nothing usable for this purpose. Rather than give up while the DEFAULT
  // provider is sitting there configured, serve the request from it — this is
  // what makes "OpenRouter is the default AI" true for every feature, not only
  // the four that name it directly.
  //
  // Resolved through `resolveTarget` like everything else, so the default is
  // held to the same standard: a missing key or an unselected model is not
  // usable, and the chain stays empty so the error names the real problem.
  const fallbackKey = defaultProviderKey(env);
  if (fallbackKey === route.provider) return [];   // already tried above
  const target = resolveTarget(purpose, { env, providerOverride: fallbackKey });
  // Tagged, and deliberately NOT inferred downstream by comparing provider
  // names. `chat` nominates Anthropic and falls back to OpenRouter, so it also
  // arrives here carrying `openrouter` — but it did so through its DECLARED
  // fallback, which is a different mechanism from the default standing in. A
  // caller that cannot tell them apart will describe an ordinary fallback as a
  // substitution, and the panel then reports a redirect that never happened.
  return target.ok ? [{ ...target, viaDefault: true }] : [];
}

/**
 * Pull the assistant text out of a response, per wire format.
 *
 * OpenAI-shaped gateways return `{ choices: [{ message: { content } }] }`;
 * Anthropic's Messages API returns `{ content: [{ type: 'text', text }] }`.
 * Both are supported because the two request bodies also differ, and a router
 * that only spoke one of them would have to fake the other — sending a body the
 * endpoint rejects and reporting it as a provider error.
 *
 * Both tolerate a missing body, and OpenAI also tolerates the reasoning-style
 * field some gateways populate instead of `content`.
 *
 * @param {unknown} data
 * @param {'openai'|'anthropic'} [wire]
 * @returns {string}
 */
function readCompletionText(data, wire = 'openai') {
  if (wire === 'anthropic') {
    const blocks = data && Array.isArray(data.content) ? data.content : [];
    return blocks
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim();
  }
  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  if (!message) return '';
  const content = typeof message.content === 'string' ? message.content : '';
  const reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
  return (content || reasoning || '').trim();
}

/**
 * Recognise "the key is fine, the account has no money" and say so.
 *
 * Anthropic answers a valid key with an exhausted balance as HTTP 400
 * `invalid_request_error` with "credit balance is too low" in the message. Left
 * unrecognised that reads as a bad request, and the advice an admin gets is the
 * wrong one — rotate a working key, or debug a payload that was never the
 * problem. The advice has to be "add credit", so it is detected by name.
 *
 * @param {number} status
 * @param {string} bodyText
 * @returns {string|null} a caller-facing message, or null if this is not it
 */
function detectCreditExhausted(status, bodyText) {
  const text = String(bodyText || '').toLowerCase();
  if (!text.includes('credit balance is too low')
    && !text.includes('insufficient credit')
    && !text.includes('insufficient_credit')) return null;
  return 'The key is accepted but the account has no credit — add credit in Plans & Billing. '
    + `Every call fails until you do (HTTP ${status}).`;
}

/**
 * Parse a JSON object out of a model reply.
 *
 * A model asked for bare JSON routinely wraps it in a ```json fence or adds a
 * sentence of preamble, and failing the whole prediction over that would make
 * the AI layer look broken when its answer is sitting right there. The first
 * balanced `{...}` span is taken, then the result is confirmed to be a plain
 * object — an array or a bare string is not a verdict.
 *
 * @param {string} text
 * @returns {Record<string, unknown>|null}
 */
function parseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && fenced[1]) candidates.push(fenced[1].trim());

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/**
 * Make one completion call against a RESOLVED target. Never throws.
 *
 * Split out from `complete` so a caller walking a fallback chain can reuse every
 * bit of the wire-format and error handling without resolving the purpose again
 * (which would hand back the primary a second time).
 *
 * @param {string} purpose
 * @param {ReturnType<typeof resolveTarget>} target
 * @param {object} options see `complete`
 */
async function completeWithTarget(target, {
  system = '',
  user = '',
  messages = null,
  maxTokens = 700,
  temperature = 0.3,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  json = false,
  extraBody = null,
} = {}) {
  const failure = (error, latencyMs = null) => ({
    ok: false, data: null, text: '', provider: target.provider,
    model: target.model, latencyMs, error,
  });

  if (!target.ok) return failure(target.error);
  // Either a `user` prompt or a non-empty `messages` array is required; without
  // either there is nothing to ask about and the call would be wasted.
  const hasPrompt = (typeof user === 'string' && user.trim().length > 0)
    || (Array.isArray(messages) && messages.length > 0);
  if (!hasPrompt) {
    return failure('Nothing to send: the prompt was empty.');
  }

  const headers = target.auth === 'x-api-key'
    ? { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json' };

  // Two request shapes. Anthropic takes `system` as a TOP-LEVEL field and has
  // no `role: 'system'` message; OpenAI-compatible gateways are the reverse.
  // Sending the OpenAI shape to Anthropic returns a 400 that reads like a
  // payload bug, and sending the Anthropic shape to OpenRouter returns a 400
  // for `max_tokens` being ignored as an unknown role — so the wire format is
  // built per provider rather than adapted afterwards.
  //
  // `messages` (a full multi-turn conversation) is the chat case. Both wires
  // accept it, but Anthropic needs two extra things a chat history does not
  // naturally satisfy: `system` must be lifted out of the array, and consecutive
  // same-role turns must be merged, because it rejects them with a 400.
  const conversation = Array.isArray(messages) && messages.length > 0
    ? messages.filter((m) => m && typeof m.content === 'string' && m.content)
    : [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ];

  const liftSystem = (list) => {
    const found = list.filter((m) => m.role === 'system').map((m) => m.content);
    const rest = list.filter((m) => m.role !== 'system');
    // Merge adjacent same-role turns, and drop a leading assistant turn.
    const merged = [];
    for (const m of rest) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`;
      else merged.push({ ...m });
    }
    while (merged.length && merged[0].role !== 'user') merged.shift();
    return { systemText: found.join('\n\n'), turns: merged };
  };

  const buildBody = ({ withJsonMode }) => {
    if (target.wire === 'anthropic') {
      const { systemText, turns } = liftSystem(conversation);
      return {
        model: target.model,
        max_tokens: maxTokens, // required by this API, not optional
        temperature,
        ...(systemText ? { system: systemText } : {}),
        messages: turns.length ? turns : [{ role: 'user', content: user || '' }],
        stream: false,
      };
    }

    // `extraBody` carries provider-specific request tuning that has no
    // cross-provider equivalent — OpenRouter's `reasoning.effort`, say. It is
    // applied ONLY to the OpenAI-shaped wire, because Anthropic answers an
    // unknown top-level field with a 400 — so a call site can tune the
    // gateway it is talking to without having to know which one that is.
    //
    // It may be a plain object, or a FUNCTION of the resolved target. The
    // function form exists because "OpenAI-shaped" is a wire, not a vendor: once
    // work is spread across several OpenAI-shaped providers, a gateway-only
    // field sent to a different OpenAI-shaped provider is still an unknown
    // top-level key, and the answer is a 400 that reads like a payload bug.
    // Scoping by provider KEY is what makes the difference expressible.
    let tuning = null;
    if (typeof extraBody === 'function') {
      try {
        tuning = extraBody(target);
      } catch {
        tuning = null; // a broken selector must never take the call down
      }
    } else if (extraBody && typeof extraBody === 'object') {
      tuning = extraBody;
    }

    return {
      model: target.model,
      messages: conversation,
      max_tokens: maxTokens,
      temperature,
      stream: false,
      ...(tuning && typeof tuning === 'object' ? tuning : {}),
      ...(withJsonMode && json ? { response_format: { type: 'json_object' } } : {}),
    };
  };

  const send = async (payload) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const response = await fetch(target.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        return {
          error: `Key rejected (HTTP ${response.status}) — rotate ${providerByKey(target.provider).envKey}.`,
          latencyMs: Date.now() - started,
        };
      }
      if (!response.ok) {
        // Read the body before reporting: a 400 from a healthy key usually
        // means "no credit", and the advice differs completely from a malformed
        // request. The body is capped because a proxy can return anything.
        let bodyText = '';
        try {
          bodyText = (await response.text()).slice(0, 600);
        } catch { /* body unreadable; fall through to the generic message */ }
        const credit = detectCreditExhausted(response.status, bodyText);
        return { error: credit || `Provider answered HTTP ${response.status}.`, latencyMs: Date.now() - started };
      }

      const data = await response.json();
      // Timed AFTER the body is read, not at headers. A generation can hold the
      // connection open for many seconds after the last byte of the reply
      // starts arriving: measured, OpenRouter returned headers in 810 ms and
      // finished the body ~14 s later. Measuring at headers reported an 810 ms
      // call that actually took fourteen seconds, and that number is shown to an
      // admin as "round trip" and recorded as the last real call's latency.
      return { data, text: readCompletionText(data, target.wire), latencyMs: Date.now() - started, error: null };
    } catch (error) {
      const latencyMs = Date.now() - started;
      const reason = error && error.name === 'AbortError'
        ? `timed out after ${timeoutMs} ms`
        : ((error && error.message) || 'network error');
      return { error: `Request failed — ${reason}.`, latencyMs };
    } finally {
      // Kept alive through the body read: clearing on `fetch` resolution alone
      // lets a stalled response body hang past the timeout.
      clearTimeout(timer);
    }
  };

  let outcome = await send(buildBody({ withJsonMode: true }));
  // JSON mode is a request-level nicety, not a requirement, and only the
  // OpenAI-shaped wire has one. One retry without it turns a hard 400 into a
  // successful, still-parseable answer.
  if (outcome.error && json && target.wire !== 'anthropic' && /HTTP 400/.test(outcome.error)) {
    outcome = await send(buildBody({ withJsonMode: false }));
  }

  if (outcome.error) return failure(outcome.error, outcome.latencyMs);

  const text = outcome.text || '';
  if (!text) return failure('Provider returned an empty completion.', outcome.latencyMs);

  if (!json) {
    return {
      ok: true, data: null, text, provider: target.provider, model: target.model,
      latencyMs: outcome.latencyMs, error: null,
    };
  }

  const data = parseJsonObject(text);
  if (!data) {
    return failure('Provider reply was not a JSON object.', outcome.latencyMs);
  }
  return {
    ok: true, data, text, provider: target.provider, model: target.model,
    latencyMs: outcome.latencyMs, error: null,
  };
}

/**
 * Make one completion call for a purpose. Never throws.
 *
 * `json: true` asks the provider for a JSON object and parses it; otherwise the
 * raw text is returned. A provider that rejects the JSON mode is retried once
 * without it rather than failing the call, because the retry is cheap and the
 * parse fallback above already handles prose-wrapped JSON.
 *
 * Pass `messages` (a full multi-turn conversation) for chat-style calls; it
 * supersedes `system`/`user`, which are then only the single-turn shorthand.
 *
 * @param {string} purpose
 * @param {{system?: string, user?: string, messages?: Array<{role: string, content: string}>,
 *          maxTokens?: number, temperature?: number, timeoutMs?: number,
 *          json?: boolean, extraBody?: object, env?: NodeJS.ProcessEnv}} options
 * @returns {Promise<{ok: boolean, data: Record<string, unknown>|null, text: string,
 *                    provider: string, model: string|null, latencyMs: number|null,
 *                    error: string|null}>}
 */
async function complete(purpose, options = {}) {
  const { env = process.env } = options;
  const target = resolveTarget(purpose, { env });
  return completeWithTarget(target, options);
}

/**
 * Walk a purpose's provider chain until one answers.
 *
 * The fallback is only reached when the primary genuinely cannot answer — no
 * key, rejected, exhausted, timed out, or an empty reply. `attempts` records
 * every provider tried and why each one after the first failed, because a
 * silent fallback is indistinguishable from a provider that simply worked, and
 * an operator needs to know which of their keys is carrying the load.
 *
 * @param {string} purpose
 * @param {object} options see `complete`
 * @returns {Promise<{ok: boolean, data: object|null, text: string, provider: string,
 *                    model: string|null, latencyMs: number|null, error: string|null,
 *                    attempts: Array<{provider: string, ok: boolean, error: string|null}>}>}
 */
async function completeWithFallback(purpose, options = {}) {
  const { env = process.env } = options;
  const chain = resolveChain(purpose, { env });
  const attempts = [];

  if (chain.length === 0) {
    // Name EVERY candidate and why each is unusable. Reporting only the
    // primary sends an operator to fix one key and hit the identical wall on
    // the next one — the error names a fix that does not actually fix it.
    const reasons = [resolveTarget(purpose, { env })];
    let declaredFallback = null;
    try {
      declaredFallback = routeFor(purpose).fallback || null;
    } catch { /* unknown purpose; the primary reason already says so */ }
    if (declaredFallback && declaredFallback !== reasons[0].provider) {
      reasons.push(resolveTarget(purpose, { env, providerOverride: declaredFallback }));
    }
    // The default provider is also what would serve this request if it were
    // configured, so its key is part of the fix and belongs in the message.
    // Deduplicated against the two above, because for the health features the
    // default IS the primary and naming it twice would read as a second
    // provider being tried.
    const fallbackKey = defaultProviderKey(env);
    if (fallbackKey !== reasons[0].provider && fallbackKey !== declaredFallback) {
      reasons.push(resolveTarget(purpose, { env, providerOverride: fallbackKey }));
    }
    return {
      ok: false, data: null, text: '', provider: reasons[0].provider,
      model: reasons[0].model, latencyMs: null,
      error: reasons.map((t) => t.error).filter(Boolean).join(' | '),
      attempts: reasons.map((t) => ({ provider: t.provider, ok: false, error: t.error })),
    };
  }

  let last = null;
  for (let index = 0; index < chain.length; index += 1) {
    const target = chain[index];
    const remaining = chain.length - index;
    const result = await completeWithTarget(target, {
      ...options,
      timeoutMs: splitTimeout(remaining, options.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    if (result.ok) {
      return {
        ...result,
        attempts: [...attempts, { provider: target.provider, ok: true, error: null, latencyMs: result.latencyMs }],
      };
    }
    last = result;
    attempts.push({ provider: target.provider, ok: false, error: result.error, latencyMs: result.latencyMs });
  }

  return { ...last, attempts };
}

/**
 * The routing table in a shape the admin panel can render directly, with the
 * key resolved per provider so the panel can say "not configured" without
 * re-deriving the same rules the router uses.
 *
 * EVERY field describes the provider that will ACTUALLY serve the request, not
 * the one the table nominally names. That distinction is the whole point: the
 * header comment's "the card says Groq, the call went to Groq" invariant is
 * only structural if the card is derived from the same resolution the router
 * performs. Before this, a feature whose own provider had no key but whose
 * default did would render a card naming the absent provider with a "Not
 * configured — set GROQ_API_KEY" warning, while every request went to
 * OpenRouter: the panel would send the operator to set a key that changes
 * nothing.
 *
 * `declaredProvider` / `usingDefault` are kept alongside so the panel can still
 * show intent, and so a substitution is visible rather than silent.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 */
function describeRouting({ env = process.env } = {}) {
  return AI_ROUTES.map((route) => {
    const provider = providerByKey(route.provider);
    const fallback = route.fallback ? providerByKey(route.fallback) : null;

    // The chain is the router's own resolution, so this cannot drift from it.
    // `viaDefault` is set by `resolveChain` itself — see the note there on why it
    // is a flag and not a provider-name comparison.
    const effective = resolveChain(route.purpose, { env })[0] || null;
    const effectiveKey = effective ? effective.provider : route.provider;
    const usingDefault = Boolean(effective) && effective.viaDefault === true;
    const effectiveProvider = providerByKey(effectiveKey) || provider;

    return {
      purpose: route.purpose,
      label: route.label,
      detail: route.detail,
      // The provider that will serve this request.
      provider: effectiveProvider ? effectiveProvider.key : effectiveKey,
      providerLabel: effectiveProvider ? effectiveProvider.label : effectiveKey,
      model: effective ? effective.model : (effectiveProvider ? resolveModel(effectiveProvider, env) : null),
      // True when the default provider is standing in for one this feature
      // nominally belongs to. A configured default is a working state, not a
      // fault, so this is reported separately from `configured`.
      configured: Boolean(effective) || (effectiveProvider ? Boolean(resolveKey(effectiveProvider.envKey, env)) : false),
      usingDefault,
      // What the table declares, so the panel can say "Groq, but OpenRouter is
      // answering" rather than silently contradicting itself.
      declaredProvider: provider ? provider.key : route.provider,
      declaredLabel: provider ? provider.label : route.provider,
      envKey: effectiveProvider ? effectiveProvider.envKey : null,
      // The address actually dialled, so a self-hosted gateway shows its own
      // host rather than a blank card. A URL is not a secret and naming it is
      // the difference between "unreachable" and "unreachable, at this address".
      baseUrl: effectiveProvider ? resolveEndpoints(effectiveProvider, env).baseUrl : null,
      // Surfaced so the panel can name the fallback rather than letting an
      // operator assume the primary is the only thing that can answer.
      fallback: fallback ? fallback.key : null,
      fallbackLabel: fallback ? fallback.label : null,
    };
  });
}

module.exports = {
  DEFAULT_PROVIDER,
  DEFAULT_PROVIDER_ENV,
  defaultProviderKey,
  AI_ROUTES,
  DEFAULT_TIMEOUT_MS,
  PRIMARY_BUDGET_FLOOR_MS,
  providerByKey,
  routeFor,
  resolveTarget,
  resolveChain,
  splitTimeout,
  readCompletionText,
  parseJsonObject,
  detectCreditExhausted,
  complete,
  completeWithTarget,
  completeWithFallback,
  describeRouting,
};
