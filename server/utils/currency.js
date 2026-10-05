/**
 * CURRENCY RESOLUTION — which currency to show, and why.
 *
 * The pricing page must show a price the visitor recognises without being wrong
 * about it. The rules, in order:
 *
 *   1. An explicit choice  — `?currency=USD`, or the value the browser persisted
 *      from a previous visit. A deliberate choice always wins; we never
 *      second-guess it.
 *   2. The browser's own region — `Accept-Language` (e.g. `en-PH,en;q=0.9`).
 *      Free, instant, and accurate for most visitors.
 *   3. The visitor's country, from their IP — for an anonymous browser that
 *      sends no useful language tag. This is a real network call, so it is
 *      OPTIONAL: the caller decides how long it is willing to wait.
 *   4. PHP — SuppliWise's home market, and the only answer that is never wrong
 *      for a mis-detected visitor, because they can still switch.
 *
 * Every step is a lookup that can simply miss, and every miss falls through to
 * the next, so this function cannot throw and cannot fail: worst case it returns
 * PHP, which is correct and switchable.
 */

const { resolveCurrency, normalizeCountry, normalizeCurrency, DEFAULT_CURRENCY } = require('./planCatalogue');
const { lookupCountryCode, ipKind } = require('./geo');

/** Never spend more than this on the IP lookup before falling back. */
const GEO_BUDGET_MS = 700;

/**
 * Resolve the currency for a request.
 *
 * @param {object} req        Express request (for headers + IP)
 * @param {object} [options]
 * @param {string} [options.requested]  explicit `?currency=`
 * @param {boolean} [options.useGeo=true] allow the IP lookup (turn off for
 *        high-traffic caching layers that must never make an outbound call)
 * @returns {Promise<{code,source,symbol,detectedCountry,currencies}>}
 */
async function resolveCurrencyForRequest(req, options = {}) {
  const { requested, useGeo = true } = options || {};

  // Steps 1 and 2 are synchronous and free.
  const fast = resolveCurrency({
    requested,
    acceptLanguage: req?.headers?.['accept-language'],
  });
  if (fast.source === 'request' || fast.source === 'accept-language') {
    return shape(fast.code, fast.source, null);
  }

  // Step 3: the IP. Only for a public address — a dev machine or a LAN peer has
  // no country, and guessing would show a developer the wrong price.
  const ip = req?.ip;
  if (useGeo && ip && ipKind(ip) === 'public') {
    const country = await withTimeout(lookupCountryCode(ip), GEO_BUDGET_MS);
    const alpha2 = normalizeCountry(country);
    if (alpha2) {
      // resolveCurrency maps the country, but only after the explicit/header
      // paths have already been ruled out — which is true here by construction.
      const fromGeo = resolveCurrency({ country: alpha2 });
      if (fromGeo.source === 'geo') return shape(fromGeo.code, 'geo', alpha2);
    }
  }

  // Step 4.
  return shape(fast.code || DEFAULT_CURRENCY, 'default', null);
}

function shape(code, source, detectedCountry) {
  const safe = normalizeCurrency(code) || DEFAULT_CURRENCY;
  return {
    code: safe,
    source,
    symbol: require('./planCatalogue').CURRENCIES[safe].symbol,
    detectedCountry: detectedCountry || null,
  };
}

/** Resolve a promise, or give up and return null. Never rejects. */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    const timer = setTimeout(() => finish(null), ms);
    // The lookup itself is already internally guarded; this only bounds how
    // long the REQUEST waits for it.
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); finish(value); },
      () => { clearTimeout(timer); finish(null); },
    );
  });
}

module.exports = { resolveCurrencyForRequest, GEO_BUDGET_MS };
