/**
 * System detection and threat prediction.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Security Center runs ~40 rule-based probes and reports a flat
 * healthy/warning/critical verdict per probe plus an overall roll-up. That
 * answers "what is broken right now" and nothing else. An operator still has to
 * work out what is ABOUT to break, which is the question the data cannot answer
 * on its own: a critical that has been stable for a week is a different event
 * from one that appeared seconds ago, and a set of individually-benign warnings
 * in adjacent subsystems is often one fault upstream of all of them.
 *
 * That reading — correlation, severity trend, and what to do next — is what
 * this module asks Groq for. Groq rather than OpenRouter because the job is
 * short, structured, latency-sensitive and runs on a timer, which is exactly
 * the shape Groq is fast and cheap at. OpenRouter stays the default for the
 * four user-facing health features (see aiRouter.js).
 *
 * THE AI IS AN ADVISORY LAYER, NEVER THE DETECTOR
 * ----------------------------------------------
 * Two properties matter more than the prediction itself:
 *
 *   1. It cannot break detection. Every Groq failure path — no key, rejected
 *      key, timeout, non-JSON reply, or a reply that fails validation — falls
 *      back to `ruleBasedVerdict`, which is computed from the same probe
 *      results and is always available. A security panel that goes dark when a
 *      third-party API is down would be strictly worse than one that never had
 *      a prediction at all.
 *
 *   2. Model output is never trusted. The verdict is clamped to a fixed
 *      vocabulary, every string is length-bounded and stripped, and any
 *      unexpected shape is discarded. A model that hallucinates a severity, or
 *      returns prose where JSON was required, degrades to the rule-based
 *      answer instead of reaching the admin as fact.
 *
 * PRIVACY
 * -------
 * Probe details are the input, and some of them embed values that must not
 * leave the process (a JWT secret length, an admin email, an internal host).
 * `buildSignals` therefore sends ONLY the probe's key, category, status and a
 * length-capped detail with emails, IPs, long tokens and JWTs redacted. The
 * model never receives user data, and never receives a credential.
 */

const { completeWithFallback } = require('./aiRouter');

/** How long a completed prediction may be reused before it is recomputed. */
const DETECTION_TTL_MS = 5 * 60 * 1000;

/** A detection call gets its own, tighter budget than a chat completion. */
const DETECTION_TIMEOUT_MS = 12000;

/** The only severities the UI knows how to render. */
const SEVERITIES = ['nominal', 'watch', 'elevated', 'severe'];

/** The only categories the UI knows how to render. */
const CATEGORIES = [
  'auth', 'data', 'ai', 'network', 'blockchain', 'infrastructure', 'other',
];

/** Hard caps so a runaway model reply cannot bloat a cached payload. */
const MAX_PREDICTIONS = 5;
const MAX_TEXT = 240;
const MAX_ACTIONS = 5;
const MAX_CATALOGUE = 40;

/**
 * Probe categories whose failure is core-system rather than cosmetic, and which
 * therefore escalates a verdict to "severe" on its own.
 *
 * These are the strings the Security Center probes ACTUALLY emit — verified
 * against the probe list in routes/admin.js, not a guess. Matching only on
 * 'auth'/'data' would have missed every one of them: there is no probe tagged
 * `auth`, and the database probe is tagged `database`. A rule that silently
 * never fires is worse than no rule, so the vocabulary is spelled out and
 * exported for the tests to pin.
 */
const CORE_CATEGORIES = new Set([
  'auth', 'jwt', 'login', 'account_creation', 'account', 'security', 'mfa',
  'totp', 'email_otp', 'bruteforce', 'csrf',
  'database', 'data', 'privacy', 'pii',
]);

const SYSTEM_PROMPT = `You are the detection engine for SuppliWise, a MERN health application.

You receive the current results of the server's own security probes. Each probe
reports a status: healthy (passing), warning (degraded but not failing),
critical (failing or misconfigured), or error (the probe itself could not
complete).

Respond with ONLY a JSON object, no prose and no code fence, with exactly:
{
  "severity": "nominal" | "watch" | "elevated" | "severe",
  "confidence": <integer 0-100>,
  "summary": "<one sentence, under 160 characters>",
  "predictions": [
    {
      "title": "<short label, under 80 characters>",
      "category": "auth" | "data" | "ai" | "network" | "blockchain" | "infrastructure" | "other",
      "rationale": "<why, grounded in the probe results, under 200 characters>",
      "confidence": <integer 0-100>
    }
  ],
  "actions": ["<concrete operator step, under 200 characters>"]
}

Rules:
- Ground every claim in the probe results you were given. Do not invent probes,
  findings, or incidents that are not present.
- A single critical out of many healthy probes is "elevated" at most, not
  "severe". Reserve "severe" for multiple criticals or a critical in auth/data.
- With everything healthy, answer "nominal", an empty predictions array, and
  suggest routine monitoring as the only action.
- "predictions" is what is likely to happen NEXT, not a restatement of what is
  already broken. If nothing is at risk, return an empty array.
- Never output credentials, tokens, emails or IP addresses.`;

/** Clamp a number into 0-100, treating anything non-numeric as absent. */
function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Coerce to a bounded, single-line, control-character-free string. */
function safeText(value, max = MAX_TEXT) {
  if (value == null) return '';
  return String(value)
    // Control characters would let a model smuggle newlines into a card.
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** Coerce to the severity vocabulary, defaulting rather than trusting the model. */
function safeSeverity(value, fallback) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return SEVERITIES.includes(text) ? text : fallback;
}

/** Coerce to the category vocabulary. */
function safeCategory(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  return CATEGORIES.includes(text) ? text : 'other';
}

/** The plural "X critical, Y warning" tally, used in both verdict paths. */
function tally(results) {
  const counts = { healthy: 0, warning: 0, critical: 0, error: 0, other: 0 };
  for (const row of results) {
    const status = String((row && row.status) || '').toLowerCase();
    if (status in counts) counts[status] += 1;
    else counts.other += 1;
  }
  return counts;
}

/**
 * Strip anything from a probe detail that must not reach a third-party API.
 *
 * Probe details are written for an admin and do contain values worth keeping in
 * the process: `jwt_security` reports a secret's LENGTH, `login`/`account_creation`
 * can include an address, and host names appear in the database probe. Lengths
 * and statuses carry the detection signal; the raw values do not.
 *
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted-ip]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '[redacted-jwt]')
    .replace(/\b(?:sk|pk|gsk|xai)-[A-Za-z0-9_-]{12,}/g, '[redacted-key]')
    .replace(/\b[0-9a-f]{24,}\b/gi, '[redacted-hash]')
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[redacted-secret]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn probe results into the minimal, redacted signal set the model sees.
 *
 * Only the bounded catalogue is used: the Security Center has grown past 40
 * probes and an unbounded prompt would be both expensive and a place for a
 * single huge detail string to dominate.
 *
 * @param {Array<{key?: string, label?: string, category?: string,
 *                 status?: string, detail?: string, incomplete?: boolean}>} monitors
 * @param {string} overallStatus
 * @returns {{overall: string, counts: object, probes: object[]}}
 */
function buildSignals(monitors, overallStatus) {
  const rows = Array.isArray(monitors) ? monitors.slice(0, MAX_CATALOGUE) : [];
  return {
    overall: safeText(overallStatus, 40) || 'unknown',
    counts: tally(rows),
    probes: rows.map((row) => ({
      key: safeText(row && row.key, 60),
      label: safeText(row && row.label, 80),
      category: safeText(row && row.category, 40),
      status: safeText(row && row.status, 20).toLowerCase() || 'unknown',
      // Capped hard: a probe detail can run to several hundred characters and
      // the tail is boilerplate, not signal.
      detail: redact(row && row.detail).slice(0, 300),
      // A probe that timed out describes the checker's patience, not the system.
      // Flagged so the model does not read it as a finding.
      incomplete: Boolean(row && row.incomplete),
    })),
  };
}

/**
 * The deterministic verdict — the always-available floor.
 *
 * This is the answer when the AI is unavailable AND the answer when the AI is
 * available but its reply fails validation, so the two can never disagree about
 * severity in a way that depends on whether a third-party API was up.
 *
 * @param {{counts: object, probes: object[]}} signals
 * @returns {{severity: string, confidence: number, source: string,
 *            summary: string, predictions: object[], actions: string[],
 *            note: string}}
 */
function ruleBasedVerdict(signals) {
  const { counts, probes } = signals;
  const failed = probes.filter((p) => p.status === 'critical' || p.status === 'error');
  const warned = probes.filter((p) => p.status === 'warning');

  let severity = 'nominal';
  if (failed.length > 0) severity = 'elevated';
  if (failed.length >= 3) severity = 'severe';
  if (failed.some((p) => CORE_CATEGORIES.has(String(p.category || '').toLowerCase()))) severity = 'severe';

  const summary = failed.length === 0 && warned.length === 0
    ? `All ${probes.length} probes passing; no anomalies detected.`
    : `${failed.length} failing and ${warned.length} degraded across ${probes.length} probes.`;

  // Restating what is broken is not a prediction, so this path only names
  // follow-up risk — and only where a real failure exists to follow up from.
  const predictions = failed.slice(0, 3).map((p) => ({
    title: `${p.label || p.key} may cascade`,
    category: p.category || 'other',
    rationale: `Rule-based: "${p.label || p.key}" is failing (${p.status}); adjacent auth and data paths depend on it.`,
    confidence: 60,
  }));

  const actions = failed.slice(0, MAX_ACTIONS).map((p) =>
    `Investigate ${p.label || p.key} (${p.status}).`);

  return {
    severity,
    confidence: 70,
    source: 'rules',
    summary,
    predictions,
    actions,
    note: 'Rule-based verdict: the AI detection layer is unavailable, so these are computed from the probe results alone.',
  };
}

/**
 * Validate a model reply into a verdict, or null if it cannot be trusted.
 *
 * Returning null (rather than a partly-filled object) is deliberate: a model
 * that produced a malformed prediction has produced no prediction, and
 * quietly keeping its summary while discarding the rest would present an
 * unaudited claim as an analysed one.
 *
 * @param {Record<string, unknown>} data
 * @returns {object|null}
 */
function validateVerdict(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  // The summary must be a real string. `safeText` would happily coerce a number
  // to '123' and an object to '[object Object]', and rendering either as the
  // system's verdict is worse than falling back to the rule-based one — so the
  // type is checked before the content, not after.
  if (typeof data.summary !== 'string') return null;

  const summary = safeText(data.summary, 200);
  if (!summary) return null;

  const rawPredictions = Array.isArray(data.predictions) ? data.predictions.slice(0, MAX_PREDICTIONS) : [];
  const predictions = rawPredictions
    .filter((p) => p && typeof p === 'object' && !Array.isArray(p))
    .map((p) => {
      const title = safeText(p.title, 80);
      const rationale = safeText(p.rationale, MAX_TEXT);
      if (!title || !rationale) return null;
      return {
        title,
        category: safeCategory(p.category),
        rationale,
        confidence: clampConfidence(p.confidence),
      };
    })
    .filter(Boolean);

  const actions = (Array.isArray(data.actions) ? data.actions : [])
    .map((a) => safeText(a, MAX_TEXT))
    .filter(Boolean)
    .slice(0, MAX_ACTIONS);

  return {
    // The model may only ever choose a severity from the fixed vocabulary, and
    // `watch` is the floor so a timid model cannot talk a critical incident
    // down into the benign band.
    severity: safeSeverity(data.severity, 'watch'),
    confidence: clampConfidence(data.confidence),
    summary,
    predictions,
    actions,
  };
}

/**
 * Detect and predict from the current probe results.
 *
 * Never throws, and never spends more than DETECTION_TIMEOUT_MS.
 *
 * @param {{monitors?: object[], overallStatus?: string, force?: boolean,
 *          env?: NodeJS.ProcessEnv}} input
 * @returns {Promise<object>}
 */
async function detectSystemThreats({ monitors = [], overallStatus = 'unknown', force = false, env = process.env } = {}) {
  const signals = buildSignals(monitors, overallStatus);
  const fingerprint = fingerprintOf(signals);

  // ORDER MATTERS: an in-flight entry is checked FIRST.
  //
  // While a call is running, `cache` holds { verdict: null, inFlight: promise }
  // with `at` set to now — so a TTL test alone passes and the settled branch
  // below would hand back `{ ...null, cached: true }`, i.e. `{ cached: true }`
  // and nothing else. The caller would render an empty detection card and read
  // it as "no anomalies". Joining the in-flight promise is both correct and
  // cheaper. (This is the same ordering aiProviders.cachedAiCheck uses.)
  if (!force && cache && cache.inFlight && cache.fingerprint === fingerprint) {
    return cache.inFlight;
  }

  // A verdict describing a system state changes only when the probes do, and
  // the probes are already cached upstream — recomputing this on every request
  // would spend Groq quota to re-derive an unchanged answer.
  if (!force && cache && cache.verdict
      && Date.now() - cache.at < DETECTION_TTL_MS
      && cache.fingerprint === fingerprint) {
    return { ...cache.verdict, cached: true };
  }

  const promise = (async () => {
    const started = Date.now();
    // Walks the routing table's chain rather than resolving one target. This
    // used to call `complete()`, which resolves the DECLARED provider only — so
    // with no Groq key the panel reported "served by OpenRouter, via the
    // default" while detection silently degraded to the rule engine instead.
    // Panel and call site now agree by construction, which is the whole point of
    // having one routing table.
    const result = await completeWithFallback('systemDetection', {
      system: SYSTEM_PROMPT,
      user: `Current probe results:\n${JSON.stringify(signals, null, 2)}`,
      maxTokens: 900,
      temperature: 0.2,
      timeoutMs: DETECTION_TIMEOUT_MS,
      json: true,
      env,
    });

    const base = {
      checkedAt: new Date().toISOString(),
      // The provider that ACTUALLY answered, from the result — including on the
      // failure path, where this used to hard-code 'groq' and so named a vendor
      // that was never called.
      provider: result.provider || 'groq',
      model: result.model,
      latencyMs: result.latencyMs != null ? result.latencyMs : Date.now() - started,
      probeCount: signals.probes.length,
      counts: signals.counts,
      cached: false,
    };

    if (!result.ok) {
      return {
        ...base,
        ...ruleBasedVerdict(signals),
        aiError: result.error,
        aiAvailable: false,
      };
    }

    const verdict = validateVerdict(result.data);
    if (!verdict) {
      return {
        ...base,
        ...ruleBasedVerdict(signals),
        aiError: 'The model reply failed validation; used the rule-based verdict instead.',
        aiAvailable: false,
      };
    }

    return {
      ...base,
      ...verdict,
      provider: result.provider,
      // Always present, on both paths: a consumer must be able to tell an
      // AI verdict from a rule-based one without inferring it from a field
      // that only one of them sets.
      source: 'ai',
      aiError: null,
      aiAvailable: true,
      note: '',
    };
  })();

  cache = { at: Date.now(), fingerprint, verdict: null, inFlight: promise };
  const settled = await promise;
  // Only cache a settled verdict; an `inFlight` placeholder must not outlive it.
  // The identity check means a `force` call that landed in between is not
  // clobbered by this older call's result.
  if (cache && cache.inFlight === promise) {
    cache = { at: Date.now(), fingerprint, verdict: settled, inFlight: null };
  }
  return settled;
}

/** A cheap identity for a signal set, so an unchanged system skips the call. */
function fingerprintOf(signals) {
  return `${signals.overall}|${signals.probes.map((p) => `${p.key}:${p.status}`).join(',')}`;
}

/** { at, fingerprint, verdict, inFlight } */
let cache = null;

/** Test seam: drop the cached verdict so the next call really runs. */
function clearDetectionCache() {
  cache = null;
}

module.exports = {
  DETECTION_TTL_MS,
  DETECTION_TIMEOUT_MS,
  SEVERITIES,
  CATEGORIES,
  CORE_CATEGORIES,
  clampConfidence,
  safeText,
  safeSeverity,
  safeCategory,
  tally,
  redact,
  buildSignals,
  ruleBasedVerdict,
  validateVerdict,
  detectSystemThreats,
  clearDetectionCache,
};
