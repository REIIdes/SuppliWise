/**
 * RATE LIMIT CEILINGS — one place to read them, one place to change them.
 *
 * Why this module exists
 * ----------------------
 * Every limiter in the application used to carry a bare literal (`max: 60`).
 * Two things follow from a literal, and both are bad:
 *
 *   1. It cannot be tuned without a code change and a redeploy. A security
 *      ceiling is also a capacity number — a school deploying this behind a
 *      shared NAT has every student behind ONE public address, and a
 *      per-IP ceiling tuned for a home connection locks the whole cohort out.
 *      The number is a business decision as much as a security one, so it
 *      belongs in configuration.
 *
 *   2. The end-to-end suites drive the REAL server (see Test File/e2eServer.js)
 *      and deliberately exceed any human rate — the whole point of several
 *      cases is to make many attempts in quick succession. Against a literal
 *      they fail with 429 and the assertions underneath are never reached, so
 *      the suite reports a product failure that is really a fixture problem.
 *
 * What is deliberately NOT done here
 * ---------------------------------
 * The production default is unchanged. An unset variable, an empty variable, a
 * negative number, a decimal, or anything unparseable all fall back to the
 * built-in default. A typo in a deployment's environment must not silently
 * remove rate limiting — that is the failure mode that turns a config feature
 * into a vulnerability, so a bad value is reported loudly and then ignored.
 *
 * A test run opts in explicitly (NODE_ENV=test, set by e2eServer.js), and even
 * then the raised ceiling is a bound, not "unlimited": `TEST_MULTIPLIER` is
 * applied to the real number rather than replacing it with something huge, so
 * the limiter is still a limiter during the suite.
 */

/** Raise-by-this-much during `NODE_ENV=test`. See the note above. */
const TEST_MULTIPLIER = Number(process.env.RATE_LIMIT_TEST_MULTIPLIER) > 0
  ? Number(process.env.RATE_LIMIT_TEST_MULTIPLIER)
  : 50;

const isTest = process.env.NODE_ENV === 'test';

/**
 * Read one ceiling.
 *
 * @param {string} name       env var name, e.g. `AUTH_RATE_LIMIT_MAX`
 * @param {number} fallback   the production default; also the hard floor
 * @returns {number}
 */
function limit(name, fallback) {
  const effectiveFallback = isTest ? fallback * TEST_MULTIPLIER : fallback;
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return effectiveFallback;
  }
  const parsed = Number(String(raw).trim());
  // A non-integer, negative, or zero value is refused. Zero would disable the
  // limiter outright, which is never something a typo should be able to do.
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) {
    console.warn(
      `[rateLimits] ignoring ${name}="${raw}" — expected a positive integer. `
      + `Using ${effectiveFallback}.`,
    );
    return effectiveFallback;
  }
  return parsed;
}

/**
 * Summarise the ceilings that are in force, for the boot log.
 * Values only — never anything that could carry a secret.
 */
function describe() {
  return {
    auth: limit('AUTH_RATE_LIMIT_MAX', 20),
    authLocal: limit('AUTH_RATE_LIMIT_MAX_LOCAL', 200),
    security: limit('SECURITY_RATE_LIMIT_MAX', 60),
    test: isTest,
  };
}

module.exports = { limit, describe, TEST_MULTIPLIER };
