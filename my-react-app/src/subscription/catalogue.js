/**
 * Pricing page display copy.
 *
 * WHAT LIVES HERE vs. WHAT COMES FROM THE SERVER
 * ----------------------------------------------
 * Prices, the yearly saving, the currency and the purchasable plan list are all
 * fetched from `GET /api/subscription/plans`, so the numbers on screen are the
 * numbers the purchase endpoint charges — including after a currency conversion,
 * which happens server-side. This module holds only the PRESENTATION layer:
 * marketing labels, taglines and the feature bullets printed on each card, plus
 * the `PLAN_META` map that ties a card to a real plan id and its entitlement
 * keys, so a card can never advertise a feature the backend does not grant.
 *
 * PLAN NAMES
 * ----------
 * Customers see: Free · Deluxe · Premium · Ultimate.
 * The app stores:   free · monthly · annual · custom.
 *
 * Those stored ids are the whole entitlement system's contract (server
 * utils/entitlements.js, mirrored in ./features.js) and are deliberately NOT
 * renamed: the display name lives here and in the server catalogue, while the id
 * travels unchanged from the database through every gate to the UI. Note that
 * "Deluxe" is the display name for the `monthly` id — the old internal label for
 * that tier happened to be DELUXE too, which is why the two can look confusingly
 * similar in logs.
 *
 * `inherits` mirrors the pricing layout: each card lists what it adds on top of
 * the tier below it, and the page renders the "Everything in X, plus" preamble.
 */

// The extension is explicit so this module can also be loaded by Node's ESM
// loader — the pricing-copy test imports it directly to assert on the real
// shipped strings, and an extensionless specifier is a resolution error there.
// Vite accepts it unchanged.
//
// FEATURES is deliberately NOT imported. It was only ever needed by the removed
// `featureChips`, and a page that holds its own copy of the feature registry is
// the drift this file exists to prevent. Bullets come from the server payload.
import { PLAN_LABELS, normalizePlanId } from './features.js';

/**
 * Per-plan presentation, keyed by the canonical plan id.
 *
 * WHAT IS *NOT* HERE, AND WHY
 * ---------------------------
 * The feature bullets a card shows are NOT written in this file. They are derived
 * on the server straight from the entitlement gates (`FEATURES[].minTier`) and
 * arrive with `GET /api/subscription/plans`, so a plan card cannot advertise a
 * capability the backend does not grant.
 *
 * This module used to carry its own `features` arrays, and the two lists drifted:
 * the server's Deluxe card said "Full reading list" while this one said "Extended
 * limits", and the "Everything in Pro, plus:" preamble outlived the rename to
 * Deluxe/Premium. A duplicate list of promises is a promise nobody maintains.
 *
 * `inherits` is kept, because the LAYOUT ("this card lists what it adds on top
 * of the one below") is a design decision — but the tier's NAME in the rendered
 * "Everything in X, plus:" line comes from the server, so that cannot go stale
 * either.
 */
export const PLAN_META = {
  free: {
    id: 'free',
    name: 'Free',
    tagline: 'Try everything essential',
    blurb: 'The core assessment, recommendation and intake tools — no card required.',
    cta: 'Start free',
    highlight: false,
    seat: false,
  },
  monthly: {
    id: 'monthly',
    name: 'Deluxe',
    tagline: 'For regular, everyday work',
    blurb: 'Analytics, report export and the whole on-chain layer.',
    cta: 'Choose Deluxe',
    highlight: false,
    seat: false,
    inherits: 'free',
  },
  annual: {
    id: 'annual',
    name: 'Premium',
    tagline: 'For higher-volume workflows',
    blurb: 'Everything in Deluxe, plus priority review and the full record history.',
    cta: 'Choose Premium',
    highlight: true,
    badge: 'Recommended',
    seat: false,
    inherits: 'monthly',
  },
  custom: {
    id: 'custom',
    name: 'Ultimate',
    tagline: 'For intensive daily use',
    blurb: 'Every feature SuppliWise has, including the AI Chat Assistant.',
    cta: 'Choose Ultimate',
    highlight: false,
    seat: false,
    inherits: 'annual',
  },
};

/** Display order on the pricing grid. */
export const PLAN_CARD_ORDER = ['free', 'monthly', 'annual', 'custom'];
// There is no "Team" band.
//
// It used to sit under these four cards, priced per seat, where a seat granted
// exactly what Premium grants. It is gone from the server catalogue, so it is
// gone from here too. Nothing could ever consume a second seat -- there was no
// invitation, no membership and no way to attach another person to the count --
// so the number only ever multiplied a price. The removed exports were
// `TEAM_META`, `canChooseSeats`, `seatBounds`, `clampSeats` and `orderKey`,
// along with the seat-picker that used the last four.


/**
 * The three explanatory columns under the grid.
 *
 * `links` point at sections that actually exist, so none of them can dead-end
 * on a URL this app does not serve.
 *
 * The columns are a FUNCTION of the catalogue because two of them quote real
 * numbers. They are read from the same server payload the cards render, so a
 * limit quoted in prose cannot disagree with the limit the gate enforces.
 *
 * THE OTHER TWO COLUMNS WERE ALSO FICTION, and are the reason this is a function
 * rather than a constant. They claimed a local/cloud execution sandbox (no such
 * mode exists in any form), a per-plan usage allowance drawn from a
 * pre-purchased block (no allowance system exists), and a user-facing cancel
 * that stops renewal (there is no cancel endpoint, no renewal, and no refund
 * system — every "refund" in the codebase is Web3 marketplace escrow, a
 * different product entirely).
 *
 * They are replaced with the period model, which is the part of this product
 * that genuinely surprises people and is genuinely implemented:
 *   - a purchase is exactly STANDARD_PERIOD_DAYS, and nothing renews on its own;
 *   - buying the SAME plan again EXTENDS the window rather than restarting it,
 *     so no paid day is ever discarded on a renewal;
 *   - buying a DIFFERENT plan REPLACES it — a fresh term from today, with the days
 *     left on the old plan forfeited. Stating this is not optional: the two rules
 *     have opposite consequences, and a page that only explained the friendly one
 *     would let a member lose a year of paid days by clicking the wrong card.
 *   - a plan change applies immediately, with no sign-out.
 *
 * `standardPeriodDays` is read off the server payload for the same reason the
 * limits are: the number printed here must be the number the engine grants.
 */
export function buildInfoColumns(plans = [], standardPeriodDays = 30) {
  const limitFor = (id) => {
    const entry = plans.find((p) => p.id === id);
    const raw = entry?.limits?.[0] || '';
    const match = /^(\d+)\s+/.exec(raw);
    return match ? Number(match[1]) : null;
  };
  const freeHistory = limitFor('free');
  const deluxeHistory = limitFor('monthly');
  const premiumHistory = limitFor('annual');

  const history = [freeHistory, deluxeHistory, premiumHistory];
  const historySentence = history.every((n) => Number.isFinite(n))
    ? `History shows ${freeHistory} assessments per page on Free, ${deluxeHistory} on Deluxe and ${premiumHistory} on Premium and above.`
    : 'History pages get deeper on paid plans.';

  const days = Number.isFinite(standardPeriodDays) && standardPeriodDays > 0
    ? Math.round(standardPeriodDays)
    : 30;

  return [
    {
      id: 'limits',
      icon: 'gauge',
      title: 'What each plan unlocks',
      body: `Every feature listed on a card above is switched on by that plan and nothing else. ${historySentence}`,
      action: { label: 'See your current plan', to: '/profile?view=billing' },
    },
    {
      id: 'period',
      icon: 'refresh',
      title: `${days} days, and it never renews on its own`,
      body: `A purchase is ${days} days of access. Nothing renews automatically and nothing is `
        + 'charged unless you choose it. When those days run out your account goes back '
        + 'to Free — your assessments and history are kept, not deleted.',
      action: { label: 'Manage your plan', to: '/profile?view=billing' },
    },
    {
      id: 'renewal',
      icon: 'shield',
      title: 'Renewing keeps your days. Changing plan replaces it.',
      body: 'Buying the SAME plan again adds to the days you have left instead of '
        + 'restarting the clock, so the time you have already paid for is never taken '
        + 'away. Buying a DIFFERENT plan replaces it: a fresh term from today, and the '
        + 'days left on your old plan are forfeited. The checkout tells you which one '
        + 'applies before you pay.',
      action: { label: 'Change plan', to: '/pricing' },
    },
  ];
}

/** Kept for callers that render before the catalogue has loaded. */
export const INFO_COLUMNS = buildInfoColumns([]);

/** Human label for a stored plan id (Free / Deluxe / Premium / Ultimate). */
export const planDisplayName = (planId) => PLAN_META[planId]?.name || PLAN_LABELS[planId] || 'Free';

/**
 * Resolve a plan id from whatever the caller has — a plan id, a display name or
 * a tier key. Returns null when it names no real plan, so callers fail closed
 * instead of rendering a card for something that cannot be bought.
 */
export function resolvePlanId(value) {
  const key = String(value == null ? '' : value).trim().toLowerCase();
  if (!key) return null;
  if (PLAN_CARD_ORDER.includes(key)) return key;
  for (const id of PLAN_CARD_ORDER) {
    if (PLAN_META[id].name.toLowerCase() === key) return id;
  }
  // Fall back to the shared alias table (deluxe -> monthly, premium -> annual…).
  const normalized = normalizePlanId(key);
  return normalized && PLAN_CARD_ORDER.includes(normalized) ? normalized : null;
}

// NOTE: there used to be a `featureChips(planId)` export here that derived a
// tier's features from FEATURES. Nothing imported it — the pricing page reads
// them off the server payload instead — and an unused export is a second place
// for the truth to be restated and drift. It is gone on purpose; if a surface
// needs the chips, read `plan.features` from the catalogue rather than
// recomputing them.

// ══════════════════════════════════════════════════════════════════════════
// Currency preference
//
// The PRICE is always computed by the server (base prices live in PHP and are
// converted there), so this module never does arithmetic on money. All it owns
// is the visitor's remembered CHOICE, persisted per browser and sent back as
// `?currency=`, which the server treats as an explicit override that outranks
// location detection.
// ══════════════════════════════════════════════════════════════════════════

const CURRENCY_KEY = 'suppliwise:currency';

/**
 * Read the saved currency choice.
 *
 * Wrapped in try/catch because localStorage throws outright in Safari private
 * mode and wherever storage is blocked by policy — a preference is never worth
 * breaking the page over.
 */
export function readCurrencyPreference() {
  try {
    const value = window.localStorage.getItem(CURRENCY_KEY);
    return typeof value === 'string' && value.length === 3 ? value.toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Persist the choice. Silently no-ops when storage is unavailable. */
export function writeCurrencyPreference(code) {
  const normalized = String(code || '').trim().toUpperCase();
  if (normalized.length !== 3) return;
  try {
    window.localStorage.setItem(CURRENCY_KEY, normalized);
  } catch {
    /* storage blocked — the choice still applies for this page view */
  }
}

/**
 * Forget the saved choice, handing the decision back to location detection.
 *
 * This is what the "Auto" option in the picker calls. It must clear rather than
 * write a default: storing "PHP" would be indistinguishable from the visitor
 * having deliberately chosen PHP, and would silently stop following their
 * location on the next visit.
 */
export function clearCurrencyPreference() {
  try {
    window.localStorage.removeItem(CURRENCY_KEY);
  } catch {
    /* storage blocked — nothing to clear */
  }
}

/**
 * Pick the currency to REQUEST.
 *
 * The saved choice wins, because an explicit pick is an explicit pick — a
 * Filipino living in Dubai who picked USD must stay on USD. With no saved
 * choice, `?currency=` in the URL is honoured so a shared link carries the
 * currency it was written with. Otherwise null, and the server detects.
 */
export function requestedCurrency(search) {
  const saved = readCurrencyPreference();
  if (saved) return saved;
  try {
    const fromQuery = new URLSearchParams(search || '').get('currency');
    const normalized = String(fromQuery || '').trim().toUpperCase();
    return normalized.length === 3 ? normalized : null;
  } catch {
    return null;
  }
}

/**
 * A short, honest sentence explaining where the number came from.
 *
 * Showing a converted price without saying so is how a pricing page loses
 * trust, so the source is always stated: what the visitor chose, what we
 * detected, or that it is the base price.
 */
export function currencySourceNote({ currency, source, country } = {}) {
  const code = String(currency || '').toUpperCase();
  switch (source) {
    case 'request':
      return `Prices in ${code}, your chosen currency.`;
    case 'accept-language':
      return `Prices in ${code}, matched to your browser's region.`;
    case 'geo':
      return `Prices in ${code}, based on your location${country ? ` (${country.toUpperCase()})` : ''}.`;
    default:
      return 'Prices in Philippine Peso (₱). Change the currency any time.';
  }
}
