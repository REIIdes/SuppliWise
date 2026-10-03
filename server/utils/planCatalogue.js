/**
 * PLAN CATALOGUE — the commercial face of the subscription system.
 *
 * The pricing page, the checkout sheet and the server's own purchase endpoint
 * all read their prices and copy from HERE, so a price shown to a user can
 * never disagree with the price the server charges for.
 *
 * Plan ids and feature tiers are NOT defined here: those live in
 * utils/entitlements.js (mirrored for the UI by my-react-app/src/subscription/
 * features.js) and are re-exported so this file cannot invent a fifth plan.
 *
 * WHAT A PLAN CARD IS ALLOWED TO SAY
 * -----------------------------------
 * A card's bullets are DERIVED from the entitlement gates, never hand-written.
 * `featuresForTier` returns exactly the features whose `minTier` is that tier,
 * and `limitsForTier` returns the same numbers the gates enforce. So a card
 * cannot advertise something the product does not grant, and the two cannot
 * drift apart without a test failing.
 *
 * This replaced a set of hand-typed marketing bullets, several of which
 * described capabilities that do not exist in the code at all — most visibly
 * "3× more usage than Deluxe" and "10× more usage than Deluxe", when no
 * tier-aware usage quota is implemented anywhere. A usage claim on a pricing
 * page is a billing promise; a promise the code cannot honour is a defect, not
 * a slogan. If a usage quota is ever implemented, add it to `FEATURES` /
 * `limitsForRank` and the cards will start saying it automatically.
 *
 * A purchase is normally ONE MONTH (30 days) — see STANDARD_PERIOD_DAYS in
 * utils/subscriptionState.js. `months` here is only used to show the yearly
 * price, which is billed as twelve months up front.
 */

const {
  STANDARD_PERIOD_DAYS, STANDARD_PERIOD_MONTHS, normalizePlanId,
} = require('./subscriptionState');

// entitlements.js only requires subscriptionState.js, so this direction is
// acyclic: the catalogue may read the gates, never the reverse.
const { FEATURES, limitsForRank } = require('./entitlements');
const { toPayload: paymentPayload } = require('./paymentInstructions');

// Cache the heavy, genuinely static half of the catalogue payload. `payment` is
// read fresh on every call and is deliberately excluded — see the cache write in
// cataloguePayload().
const { get, set } = require('./cache');
const CATALOGUE_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

const round2 = (value) => Math.round(value * 100) / 100;

// ══════════════════════════════════════════════════════════════════════════
// CURRENCY
//
// The base price list is in PHP (₱) — SuppliWise's home market. The site also
// sells in other currencies, so every price is defined ONCE here in PHP and
// CONVERTED for display through the table below.
//
// `yearlySavingPct` is declared per plan instead of being derived from a single
// flat discount, because these are real published prices, not "monthly × 12 ×
// (1 − d)": a plan can be discounted, priced at a round annual figure, or both.
// Deriving the badge from a formula would then show a percentage that does not
// match the invoice.
// ══════════════════════════════════════════════════════════════════════════

/** Fallback when a country has no explicit currency. */
const DEFAULT_CURRENCY = 'PHP';

/**
 * Supported currencies. `rate` is how many PHP one unit is worth, so a price is
 * always `phpAmount / rate`.
 */
const CURRENCIES = {
  PHP: { code: 'PHP', symbol: '₱', rate: 1, locale: 'en-PH', decimals: 0, name: 'Philippine Peso' },
  USD: { code: 'USD', symbol: '$', rate: 58.5, locale: 'en-US', decimals: 2, name: 'US Dollar' },
  EUR: { code: 'EUR', symbol: '€', rate: 57.0, locale: 'en-IE', decimals: 2, name: 'Euro' },
  GBP: { code: 'GBP', symbol: '£', rate: 75.0, locale: 'en-GB', decimals: 2, name: 'British Pound' },
  JPY: { code: 'JPY', symbol: '¥', rate: 0.40, locale: 'ja-JP', decimals: 0, name: 'Japanese Yen' },
  AUD: { code: 'AUD', symbol: 'A$', rate: 38.0, locale: 'en-AU', decimals: 2, name: 'Australian Dollar' },
  CAD: { code: 'CAD', symbol: 'C$', rate: 41.0, locale: 'en-CA', decimals: 2, name: 'Canadian Dollar' },
  SGD: { code: 'SGD', symbol: 'S$', rate: 44.0, locale: 'en-SG', decimals: 2, name: 'Singapore Dollar' },
  HKD: { code: 'HKD', symbol: 'HK$', rate: 7.5, locale: 'en-HK', decimals: 2, name: 'Hong Kong Dollar' },
  INR: { code: 'INR', symbol: '₹', rate: 0.70, locale: 'en-IN', decimals: 0, name: 'Indian Rupee' },
};

/**
 * Country → currency, for the countries this app is likely to be opened from.
 * An unmapped country is not a failure: the request falls back to the browser's
 * own region tag and then to PHP, and the visitor can always switch.
 *
 * ISO-3166 alpha-2, lower-cased. Kept as a flat object so a lookup is one hash
 * hit and cannot throw on an unexpected code.
 */
const COUNTRY_CURRENCY = {
  ph: 'PHP',
  us: 'USD', ca: 'CAD', mx: 'USD',
  gb: 'GBP',
  ie: 'EUR', de: 'EUR', fr: 'EUR', es: 'EUR', it: 'EUR', nl: 'EUR', be: 'EUR',
  at: 'EUR', pt: 'EUR', fi: 'EUR', gr: 'EUR', sk: 'EUR', si: 'EUR', lu: 'EUR',
  au: 'AUD', nz: 'AUD',
  jp: 'JPY',
  sg: 'SGD', my: 'SGD', hk: 'HKD',
  in: 'INR',
  br: 'USD', ar: 'USD', cl: 'USD', co: 'USD', pe: 'USD', ve: 'USD',
  za: 'USD', ng: 'USD', ke: 'USD', eg: 'USD',
  ae: 'USD', sa: 'USD', qa: 'USD', kw: 'USD', il: 'USD',
  // Southeast Asia beyond the Philippines — the likely growth markets, priced
  // in PHP until a real per-country price list exists.
  id: 'PHP', th: 'PHP', vn: 'PHP', tw: 'PHP', kh: 'PHP', la: 'PHP', mm: 'PHP',
};

/** Every currency the UI may offer, in a stable display order. */
const CURRENCY_ORDER = ['PHP', 'USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'SGD', 'HKD', 'INR'];

// Normalize a user-supplied country code without ever throwing.
function normalizeCountry(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  // Accept "PH", "ph", "PHp"? No — strictly the alpha-2 code, optionally with
  // a region suffix ("en-PH" / "PH-PH" are common in Accept-Language headers).
  const alpha2 = key.includes('-') ? key.split('-').pop() : key;
  return /^[a-z]{2}$/.test(alpha2) ? alpha2 : '';
}

function normalizeCurrency(value) {
  const key = String(value == null ? '' : value).trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(CURRENCIES, key) ? key : null;
}

/**
 * Resolve which currency to charge in.
 *
 * Precedence — an explicit request beats everything, then a region-tagged
 * language header, then the server's own geo lookup, then PHP:
 *
 *   1. `?currency=USD`  — the user's own saved choice. It must win outright,
 *                          even over their location: someone who lives abroad
 *                          may well be billing a relative.
 *   2. `Accept-Language` — e.g. "en-PH,en;q=0.9". Only a tag that NAMES A
 *                          REGION counts; a bare "en" is a language preference,
 *                          not a location, and guessing from it would show a
 *                          Filipino abroad in pesos they cannot spend.
 *   3. Country from the request IP (utils/currency.js → utils/geo.js) — the real
 *                          answer when the browser is anonymous.
 *   4. `DEFAULT_CURRENCY` — PHP, and never a 500: every step above is a lookup
 *                          that can simply miss.
 */
function resolveCurrency({ requested, acceptLanguage, country } = {}) {
  const explicit = normalizeCurrency(requested);
  if (explicit) return { code: explicit, source: 'request' };

  const fromHeader = currencyFromAcceptLanguage(acceptLanguage);
  if (fromHeader) return { code: fromHeader, source: 'accept-language' };

  const geo = normalizeCountry(country);
  if (geo && Object.prototype.hasOwnProperty.call(COUNTRY_CURRENCY, geo)) {
    return { code: COUNTRY_CURRENCY[geo], source: 'geo' };
  }
  return { code: DEFAULT_CURRENCY, source: 'default' };
}

/**
 * First currency-backed region in an Accept-Language header wins.
 *
 * Requires an explicit region subtag: "en-PH" resolves, bare "en" does not.
 * Without that rule the single most common header in the world (bare "en")
 * would pin every visitor to one currency.
 *
 * The region subtag is a COUNTRY code, not a currency code, so it goes through
 * COUNTRY_CURRENCY — "en-PH" means the Philippines (PHP), not "PH" the
 * currency, which does not exist. Handing it to normalizeCurrency() instead
 * matched nothing at all and silently fell through to the default.
 */
function currencyFromAcceptLanguage(header) {
  const raw = String(header == null ? '' : header);
  if (!raw.trim()) return null;
  for (const part of raw.split(',')) {
    // "en-PH;q=0.9" -> ["en-PH", "q=0.9"]. A q=0 entry is an explicit refusal
    // of that language, so skip it rather than honour it.
    const [tagRaw, ...params] = part.trim().split(';');
    if (params.some((p) => /^\s*q=0(\.0+)?\s*$/i.test(p))) continue;
    const tag = String(tagRaw || '').trim().toLowerCase();
    // A tag with no region says how someone likes to READ, not where they are,
    // so it is not a location signal ("en" is not evidence of anywhere).
    if (!tag.includes('-')) continue;
    const regionRaw = tag.split('-').pop();
    const region = normalizeCountry(regionRaw);
    if (!region) continue;
    // With a region in hand the language is irrelevant — "de-DE" is Germany and
    // "tl-PH" is the Philippines regardless of which language came first.
    if (Object.prototype.hasOwnProperty.call(COUNTRY_CURRENCY, region)) {
      return COUNTRY_CURRENCY[region];
    }
    // A region we do not map may still BE a currency the visitor asked for, so
    // an exact currency-code match is a reasonable last try.
    const asCurrency = normalizeCurrency(regionRaw);
    if (asCurrency) return asCurrency;
  }
  return null;
}

/**
 * Convert a PHP amount into the target currency, rounded the way that currency
 * is normally quoted (no cents for pesos/yen/rupees, cents for the rest).
 */
function convertFromPhp(amountPhp, currencyCode) {
  const currency = CURRENCIES[currencyCode] || CURRENCIES[DEFAULT_CURRENCY];
  const value = (Number(amountPhp) || 0) / currency.rate;
  const factor = 10 ** currency.decimals;
  return Math.round(value * factor) / factor;
}

/** Format a converted amount for display: "$25.00", "₱499", "¥1,234". */
function formatAmount(amountPhp, currencyCode) {
  const currency = CURRENCIES[currencyCode] || CURRENCIES[DEFAULT_CURRENCY];
  const value = convertFromPhp(amountPhp, currency.code);
  // Nothing is free of money, and "$0.00" on a pricing card reads like a
  // rounding error rather than a free plan. Zero always prints without minor
  // units, in every currency.
  const decimals = value === 0 ? 0 : currency.decimals;
  const formatted = value.toLocaleString(currency.locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${currency.symbol}${formatted}`;
}

/**
 * The features a tier introduces, read straight off the entitlement gates.
 *
 * A card shows what THIS tier adds on top of the one below it, so the list is
 * the features whose `minTier` is exactly this plan — the same set the gate in
 * `entitlementsFor` will actually grant. Adding a gated feature to a plan is
 * therefore a one-line change in FEATURES and both the gate and the card move
 * together; there is no second list to forget to update.
 *
 * Each entry keeps the canonical entitlement KEY alongside the display text, so
 * a card bullet can be traced to the exact thing that unlocks it.
 */
function featuresForTier(planId) {
  return Object.entries(FEATURES)
    .filter(([, def]) => def.minTier === planId)
    .map(([key, def]) => ({ key, label: def.label, description: def.description }));
}

/** The entitlement keys a tier introduces — the machine-readable form. */
function featureKeysForTier(planId) {
  return featuresForTier(planId).map((feature) => feature.key);
}

/**
 * The limits a tier actually enforces, phrased for a card.
 *
 * The numbers come from `limitsForRank`, the very function the runtime gate
 * calls, so a card cannot quote 20 while the product serves 10. Only limits that
 * are genuinely implemented get a line here; a limit that does not exist is not
 * advertised at all.
 */
function limitsForTier(planId) {
  const rank = { free: 0, monthly: 1, annual: 2, custom: 3 }[planId] ?? 0;
  const limits = limitsForRank(rank);
  return [
    `${limits.historyPageSize} assessments per page in History`,
  ];
}

/**
 * One entry per stored plan id, in display order.
 *
 * `features` and `featureKeys` are NOT written here — see featuresForTier. What
 * IS written here is only what is genuinely a commercial decision: the price,
 * the tagline, and which card is recommended.
 */
const PLAN_CATALOGUE = [
  {
    id: 'free',
    label: 'Free',
    tagline: 'Try everything essential',
    monthly: 0,
    yearly: 0,
    // Free is genuinely free, so there is no annual saving to advertise.
    yearlySavingPct: 0,
    priceNote: 'No payment method required',
    cta: 'Start free',
    highlight: false,
    seat: false,
  },
  {
    id: 'monthly',
    label: 'Deluxe',
    tagline: 'For everyday supplement planning',
    monthly: 499,
    yearly: 1600,
    // 499 × 12 = ₱5,988 → ₱1,600 is 73% off. That is the published price; the
    // badge reports it rather than restating it as a formula.
    yearlySavingPct: 73,
    priceNote: 'Billed monthly',
    cta: 'Choose Deluxe',
    highlight: false,
    seat: false,
    // Everything in Free, plus…
    inherits: 'free',
  },
  {
    id: 'annual',
    label: 'Premium',
    tagline: 'For high-volume workflows',
    monthly: 699,
    yearly: 1700,
    // 699 × 12 = ₱8,388 → ₱1,700 is 80% off.
    yearlySavingPct: 80,
    priceNote: 'Billed monthly',
    cta: 'Choose Premium',
    highlight: true, // the "Recommended" card
    badge: 'Recommended',
    seat: false,
    inherits: 'monthly',
  },
  {
    id: 'custom',
    label: 'Ultimate',
    tagline: 'For intensive daily use',
    monthly: 899,
    yearly: 1800,
    // 899 × 12 = ₱10,788 → ₱1,800 is 83% off.
    yearlySavingPct: 83,
    priceNote: 'Billed monthly',
    cta: 'Choose Ultimate',
    highlight: false,
    seat: false,
    inherits: 'annual',
  },
];

/**
 * The "Team" band under the individual cards.
 *
 * Team is NOT a fifth tier — it is the Premium tier with a seat count. A seat
 * grants exactly what Premium grants, shared across N people, so there is no
 * `team` plan id and every entitlement gate is untouched by the count. Making it
 * a real tier instead would have meant changing the rank order and every feature
 * and limit mapping in the app, for something that unlocks nothing extra.
 *
 * `tier` is what a seat actually buys, and it is what the purchase writes to the
 * paid layer. `perSeat` prices are per seat, so a N-seat subscription costs
 * N × perSeat — computed on the SERVER, because a client-computed total is a
 * total the invoice will not match.
 */

/** The tier a Team seat grants. Named once so the band and the engine agree. */
const TEAM_TIER = 'annual';

const TEAM_PLAN = {
  id: 'team',
  label: 'Team',
  tagline: 'Everything in Premium for every seat, plus shared billing and seat management for a group of practitioners.',
  // The stored plan id a seat grants.
  tier: 'annual',  perSeatMonthly: 699,
  perSeatYearly: 1700,
  yearlySavingPct: 80,
  minSeats: 2,
  maxSeats: 500,
  cta: 'Choose Team',
  // A seat grants exactly the Premium tier, so the band's bullets are the real
  // Premium additions — read from the same gates the cards use, not retyped.
  // "2× more usage than Deluxe" was here for the same reason it was on the
  // Premium card: no tier-aware usage quota exists to be twice anything.
  features: [
    ...featuresForTier(TEAM_TIER).map((feature) => feature.label),
    'One shared billing account',
    'A seat for each practitioner',
  ],
  featureKeys: [],
};

/** Seat counts the checkout pre-computes a total for. Any count is purchasable;
 *  these are just the ones shown without a round-trip. */
const TEAM_TOTAL_SEATS = [2, 3, 5, 10, 20, 50];

/**
 * Compute both billing prices for a catalogue entry.
 *
 * `savedPct` is the plan's DECLARED annual saving, not a derived one — see the
 * note above YEARLY_DISCOUNT_PCT's replacement.
 */
function pricingFor(entry, currencyCode = DEFAULT_CURRENCY) {
  const currency = CURRENCIES[currencyCode] ? currencyCode : DEFAULT_CURRENCY;
  // Read `monthly`/`yearly`, falling back to the `perSeat*` names the Team band
  // uses. Without that fallback the Team band silently priced at ZERO — the
  // figure was right there under a different key, and `Number(undefined) || 0`
  // turned a key mismatch into a free seat rather than a visible error.
  const monthlyPhp = Number.isFinite(entry.monthly) ? entry.monthly
    : (Number.isFinite(entry.perSeatMonthly) ? entry.perSeatMonthly : 0);
  const yearlyPhp = Number.isFinite(entry.yearly) ? entry.yearly
    : (Number.isFinite(entry.perSeatYearly) ? entry.perSeatYearly : 0);
  const format = (php) => formatAmount(php, currency);
  return {
    currency,
    monthly: convertFromPhp(monthlyPhp, currency),
    yearly: convertFromPhp(yearlyPhp, currency),
    monthlyEquivalent: round2(convertFromPhp(yearlyPhp, currency) / 12),
    savedPct: Number(entry.yearlySavingPct) > 0 ? Number(entry.yearlySavingPct) : 0,
    formatted: {
      monthly: format(monthlyPhp),
      yearly: format(yearlyPhp),
      monthlyEquivalent: format(round2(yearlyPhp / 12)),
    },
  };
}

/** Everything a client needs to offer the currency picker, minus the rates. */
function currenciesPayload() {
  return CURRENCY_ORDER
    .filter((code) => CURRENCIES[code])
    .map((code) => ({
      code,
      symbol: CURRENCIES[code].symbol,
      name: CURRENCIES[code].name,
      decimals: CURRENCIES[code].decimals,
    }));
}

/**
 * The whole catalogue, ready to serve in one currency. Prices are
 * server-computed, so a client cannot invent its own.
 *
 * `pricing.php` carries the base amounts too: the purchase endpoint records what
 * was actually charged in PHP, and an admin needs the base figure to reconcile
 * an invoice, not a converted one.
 */
function cataloguePayload(currencyCode = DEFAULT_CURRENCY) {
  const currency = CURRENCIES[currencyCode] ? currencyCode : DEFAULT_CURRENCY;

  // The cached half is the part that genuinely never changes: the price list,
  // the currency table, the feature matrix. `payment` is the exception, and it
  // is recomputed on EVERY call — see the note at the cache write below for why
  // caching it is not merely wasteful but unsafe.
  const cacheKey = `catalogue:${currency}`;
  const cached = get(cacheKey);
  if (cached) return { ...cached, payment: paymentPayload() };

  const payload = {
    currency,
    symbol: CURRENCIES[currency].symbol,
    currencies: currenciesPayload(),
    // Where to send money, if anywhere. Travels WITH the plan list on purpose:
    // the checkout has to know whether a transfer route even exists before it
    // can offer one, and a second round-trip would let the button and the
    // instructions disagree. See utils/paymentInstructions.js.
    payment: paymentPayload(),
    // A purchase is one month of access — stated once, and every purchase
    // writes exactly this many days.
    standardPeriodDays: STANDARD_PERIOD_DAYS,
    standardPeriodMonths: STANDARD_PERIOD_MONTHS,
    team: {
      ...TEAM_PLAN,
      pricing: {
        ...pricingFor(TEAM_PLAN, currency),
        php: { monthly: TEAM_PLAN.perSeatMonthly, yearly: TEAM_PLAN.perSeatYearly },
        // Pre-computed totals for the common seat counts, so the checkout sheet
        // can show a real total the moment a seat count is chosen without
        // waiting on a round-trip. The server recomputes it on purchase.
        seatTotals: TEAM_TOTAL_SEATS.map((seats) => ({
          seats,
          monthly: formatAmount(TEAM_PLAN.perSeatMonthly * seats, currency),
          yearly: formatAmount(TEAM_PLAN.perSeatYearly * seats, currency),
        })),
      },
    },
    plans: PLAN_CATALOGUE.map((entry) => ({
      ...entry,
      // Derived, never hand-written: these are the features this tier's card is
      // allowed to claim, read off the gates that decide what it unlocks.
      features: featuresForTier(entry.id),
      featureKeys: featureKeysForTier(entry.id),
      // …and the limits it actually enforces, as real numbers.
      limits: limitsForTier(entry.id),
      pricing: { ...pricingFor(entry, currency), php: { monthly: entry.monthly, yearly: entry.yearly } },
    })),
  };

  // Cache for 10 minutes — but NEVER the payment destination.
  //
  // `payment` is the one field here that can change without a deploy (an admin
  // edits .env and calls envFile.reloadFromDisk) and the one field whose
  // staleness costs real money: a deployment that removes or corrects its
  // account number would keep telling members to transfer to the old one for
  // ten minutes, and a member who acts on it has paid an address nobody is
  // collecting at. utils/paymentInstructions.js is explicit that a deployment
  // with no destination must report `available: false` so the checkout withholds
  // the transfer route; a cache that outlives the config change quietly undoes
  // that guarantee. It is one env read, so recomputing it costs nothing.
  const { payment, ...cacheable } = payload;
  set(cacheKey, cacheable, CATALOGUE_CACHE_TTL);
  return payload;
}

/**
 * Resolve a purchasable entry from whatever the client sent.
 *
 * Unlike the individual plans, Team is NOT a stored plan id, so it cannot go
 * through normalizePlanId() (which would have to invent a fifth tier). It is
 * matched by its own id here and mapped to the tier a seat grants.
 */
function resolvePurchasable(plan) {
  const raw = String(plan == null ? '' : plan).trim().toLowerCase();
  if (raw === 'team') return { entry: TEAM_PLAN, isTeam: true, tier: TEAM_PLAN.tier };
  const id = normalizePlanId(raw);
  if (!id) return null;
  const entry = PLAN_CATALOGUE.find((p) => p.id === id);
  return entry ? { entry, isTeam: false, tier: entry.id } : null;
}

/** Server-side seat total. The only place a Team price is ever computed. */
function teamTotal(amountPhp, seats) {
  const n = Math.max(1, Math.round(Number(seats) || 1));
  return amountPhp * n;
}

const findEntry = (planId) => PLAN_CATALOGUE.find((entry) => entry.id === planId) || null;

/** Server-side seat total. The only place a Team price is ever computed. */
function teamTotal(amountPhp, seats) {
  const n = Math.max(1, Math.round(Number(seats) || 1));
  return amountPhp * n;
}

/**
 * Is self-serve purchasing enabled for this deployment?
 *
 * SuppliWise has no card processor wired up, so a purchase here is recorded
 * against the account's PAID subscription layer without charging anything. That
 * is the right behaviour for a demo/portfolio deployment and the wrong one for a
 * real one, so it is a switch rather than an assumption:
 *
 *   SUBSCRIPTION_SELF_SERVE_PURCHASE=true    → enabled, with a visible notice
 *   (unset / false / 0 / no / off)            → DISABLED (fails closed)
 *
 * Fails CLOSED deliberately. This used to default to enabled, which meant every
 * deployment that had not heard of the flag shipped with a full entitlement
 * bypass: any authenticated FREE user could POST /api/subscription/purchase,
 * name the top tier and any duration up to 12 months, and the call EXTENDED the
 * existing window — so a few scripted requests bought years of the highest plan,
 * unlocking every premium entitlement including the whole Web3 layer. A security
 * control that is off unless you remember to turn it on is not a control.
 *
 * Turning it off does not touch existing subscriptions: only NEW purchases are
 * refused, and admins keep full control through /api/admin/users/:id/subscription.
 */
function selfServeEnabled() {
  const raw = process.env.SUBSCRIPTION_SELF_SERVE_PURCHASE;
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  return ['true', '1', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

module.exports = {
  PLAN_CATALOGUE,
  TEAM_PLAN,
  CURRENCIES,
  COUNTRY_CURRENCY,
  CURRENCY_ORDER,
  DEFAULT_CURRENCY,
  normalizeCountry,
  normalizeCurrency,
  // Re-exported so a caller can prove a name is NOT a tier without reaching into
  // another module (notably: 'team' is purchasable but is not a plan id).
  normalizePlanId,
  resolveCurrency,
  currencyFromAcceptLanguage,
  convertFromPhp,
  formatAmount,
  currenciesPayload,
  pricingFor,
  cataloguePayload,
  findEntry,
  featuresForTier,
  featureKeysForTier,
  limitsForTier,
  resolvePurchasable,
  teamTotal,
  TEAM_TOTAL_SEATS,
  TEAM_TIER,
  selfServeEnabled,
};
