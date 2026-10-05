/**
 * Storage for AI-written supplement guides.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * "Tap for details" writes a long clinical guide through an AI provider. If it
 * is not stored, the reader pays for the same guide on every tap, on every
 * device, forever — which made the most-tapped button in the product the most
 * expensive one to press, and made its reliability hostage to the provider being
 * fast at that instant.
 *
 * So a guide is written once and read from Mongo afterwards. That is three
 * things with three sharp edges, and none of them belong inline in an Express
 * handler:
 *
 *   1. KEYING. A personalised guide is only valid for the profile it was
 *      written from. Serving one reader's guide to another is a health-privacy
 *      failure, not a cache miss, so the profile is part of the key.
 *   2. BOUNDS. A document that grows without limit is a document that will one
 *      day be refused. The per-supplement variant list is capped and evicted.
 *   3. FAILURE. None of this is load-bearing for correctness. If Mongo is slow,
 *      down or full, the reader still gets a guide — they just pay for it.
 *
 * The module holds no connection of its own; it requires the model lazily so a
 * caller can stub it, and so a unit test never needs a database.
 */

const crypto = require('crypto');

/**
 * How long a stored guide is trusted.
 *
 * 30 days, and it is deliberately the SAME window the browser keeps its copy for
 * (DETAIL_CACHE_TTL_MS in my-react-app/src/Components/SupplementDetail). Guide
 * content does not move in a week, and a reader must not be shown a different
 * guide on their phone than on their laptop because two tiers drifted apart.
 */
const GUIDE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The budget the route hands the provider for one generation.
 *
 * A budget is a three-way agreement and all three parts have to hold:
 *
 *     model     the completion runs until the budget is spent
 *     route     the request stays open until the budget is spent
 *     browser   apiFetch waits at least as long as the route
 *
 * This was 20 s, so a perfectly healthy provider was reported as "timed out"
 * often enough that the panel read as broken. Measured over many runs of the real
 * prompt the latency is 8 s to 50 s with the median near 30 s, and the variable
 * is the upstream provider rather than the prompt — 45 s still lost the tail.
 * 90 s is above every latency actually observed, and the server's own
 * requestTimeout (150 s in index.js) leaves room to send the response. The
 * browser waits 120 s.
 *
 * A long budget is only affordable BECAUSE the guide is stored: this is the cost
 * of the first read of one supplement by one reader, paid once rather than on
 * every tap. See the header comment.
 *
 * It lives beside the TTL rather than inline in the route because the two are one
 * decision — how long a guide costs to make, and how long it costs to keep — and
 * both are asserted directly in supplement-guide-store.test.js.
 */
const GENERATION_TIMEOUT_MS = 90000;

/**
 * Personalised guides kept per supplement.
 *
 * A variant is ~5 kB against a 16 MB document ceiling, so the raw headroom is
 * about three thousand — but an unbounded array is still an unbounded document,
 * and the point of the cap is that the bound is enforced rather than assumed.
 * The practical effect: a popular supplement converges on the profiles its
 * readers actually have instead of accumulating every variant ever requested.
 */
const MAX_VARIANTS = 24;

/** Memory prefix, kept distinct from the other caches in utils/cache.js. */
const MEMORY_PREFIX = 'supplement';

/**
 * The identity a guide is keyed on.
 *
 * Every field the prompt reads, and nothing else. That coupling is the whole
 * subtlety: adding a field to the prompt in routes/supplement_detail.js without
 * adding it here does not produce a wrong guide, it produces a SILENT cache miss
 * — the profile is stored under two keys, so half the readers re-pay for a
 * guide the database already holds. Both sides are canonicalised by this one
 * function so they cannot disagree.
 *
 * The value stored is a digest, never the profile itself. The collection holds
 * health content; the key only has to answer "is this the same reader?".
 *
 * @param {string|null} patientProfile the exact string the prompt is built from
 * @returns {string|null} null for a generic (unpersonalised) guide
 */
function profileKey(patientProfile) {
  if (!patientProfile) return null;
  const canonical = String(patientProfile)
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (!canonical) return null;
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

/**
 * The in-memory key for one guide.
 *
 * The profile key is part of it. A key of just the supplement name is what let
 * the memory cache — and, before this module, the request deduplicator — hand
 * one reader the guide written for another.
 *
 * @param {string} nameKey
 * @param {string|null} key
 * @returns {string}
 */
function memoryKey(nameKey, key) {
  return `${MEMORY_PREFIX}:${nameKey}${key ? `:p:${key}` : ''}`;
}

/**
 * Both stored shapes, normalised to one.
 *
 * `variants` is currently a MAP — `profileKey -> { detail, updatedAt }` — but it
 * used to be an ARRAY of `{ profileKey, detail, updatedAt }`, and every guide
 * written before the change is still on disk in that shape. Reading only the map
 * would silently discard all of them, so every read after a deployment would
 * regenerate guides the database already holds: the exact cost this module
 * exists to remove, arriving the day it is fixed.
 *
 * This is also what lets `storeGuide` migrate a legacy array in place, so the
 * conversion is self-healing and needs no migration script and no deploy step:
 * the next write for that supplement performs it.
 *
 * @param {unknown} raw whatever the document actually holds
 * @returns {Record<string, {detail: object, updatedAt?: Date|string}>}
 */
function normalizeVariants(raw) {
  const out = {};
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry && typeof entry.profileKey === 'string' && entry.detail) {
        out[entry.profileKey] = { detail: entry.detail, updatedAt: entry.updatedAt };
      }
    }
    return out;
  }
  if (raw && typeof raw === 'object') {
    for (const [key, entry] of Object.entries(raw)) {
      if (entry && entry.detail) out[key] = { detail: entry.detail, updatedAt: entry.updatedAt };
    }
  }
  return out;
}

/** One map entry, whatever shape it came back in. */
const entryOf = (value) => (value && typeof value === 'object' ? value : null);

/**
 * The guide stored for a profile, or null.
 *
 * Applies the TTL that the model cannot: a variant old enough to be untrustworthy
 * is a MISS, not a stale answer. Without this a 31-day-old guide is served exactly
 * as confidently as a fresh one, and the TTL would only ever be documentation.
 *
 * @param {{detail?: object|null, variants?: unknown}|null} doc
 * @param {string|null} key null reads the generic guide
 * @returns {object|null}
 */
function readStoredGuide(doc, key) {
  if (!doc) return null;

  if (!key) return doc.detail || null;

  const found = normalizeVariants(doc.variants)[key];
  if (!found || !found.detail) return null;

  const stamp = new Date(found.updatedAt || 0).getTime();
  if (!Number.isFinite(stamp) || Date.now() - stamp > GUIDE_TTL_MS) return null;

  return found.detail;
}

/**
 * Write one guide, replacing any variant it supersedes and evicting what the cap
 * says must go.
 *
 * Replacement is inherent: the write is one `$set` of one field path, so a
 * reader re-opening their guide can never leave a second copy behind. Eviction
 * is `$unset` of the sibling paths — disjoint from the one being written, so the
 * order MongoDB applies update operators in does not matter here. Both in ONE
 * update, so two readers writing the same supplement at the same moment cannot
 * lose each other's entries, which is the symptom of getting this wrong: a guide
 * that regenerates forever, i.e. exactly the cost this module exists to remove.
 *
 * A legacy ARRAY of variants is the one exception, and it needs whole-field
 * `$set`: a dotted `$set` cannot change a field's BSON type, so writing
 * `variants.<digest>` onto a document whose `variants` is an array leaves the
 * array in place — the guide lands under index `0` instead of under its digest,
 * and the next read cannot find it. Converting the field is therefore the write.
 * One document, once, on its next write; there is no migration to run.
 *
 * @param {object} args
 * @param {string} args.nameKey
 * @param {string} args.supplementName used only if the model named nothing
 * @param {object} args.detail the guide as returned by the provider
 * @param {string|null} args.profileKey null stores the generic guide
 * @param {object} [deps] injection seam for tests: `{ model, cache }`
 * @returns {Promise<string[]>} the profile keys evicted, so a caller can drop
 *          their now-orphaned memory entries
 */
async function storeGuide({ nameKey, supplementName, detail, profileKey }, deps = {}) {
  const SupplementDetail = deps.model || require('../models/SupplementDetail');
  const cache = deps.cache || require('./cache');

  const now = new Date();
  const name = String(detail.name || supplementName).slice(0, 200);

  // The generic guide lives in its own field, so writing it can never disturb a
  // personalized variant and needs no eviction bookkeeping.
  if (!profileKey) {
    await SupplementDetail.updateOne(
      { nameKey },
      { $set: { name, detail } },
      { upsert: true },
    ).exec();
    return [];
  }

  const existing = await SupplementDetail.findOne({ nameKey }).select('variants').lean();
  const legacyShape = Array.isArray(existing?.variants);
  const variants = normalizeVariants(existing?.variants);
  const cutoff = now.getTime() - GUIDE_TTL_MS;

  // Expired entries go first: `readStoredGuide` already treats them as a miss, so
  // keeping one only costs document size. Then the least recently written make
  // room — `updatedAt` is what a re-read refreshes, so recency-of-use is
  // recency-of-write by construction. The key being written is excluded, or a
  // rewrite would evict one slot too many and then delete the entry it just
  // wrote.
  //
  // OLDEST FIRST, and the newest `room` are kept. The direction is not cosmetic:
  // `Date` has millisecond resolution, so a burst of taps lands many entries on
  // the same timestamp. Sorting descending and taking a prefix then keeps the
  // OLDEST of a tied group — the exact opposite of intent — and evicts the guide
  // that was just written. Sorting ascending and taking a suffix makes ties
  // resolve by map order, which is write order: MongoDB preserves field order,
  // and so does a JS object. `slice` is stable, so the two agree.
  const room = Math.max(0, MAX_VARIANTS - 1);
  const ranked = Object.entries(variants)
    .filter(([key]) => key !== profileKey)
    .filter(([, entry]) => new Date(entryOf(entry)?.updatedAt || 0).getTime() > cutoff)
    .sort((a, b) => new Date(entryOf(a[1])?.updatedAt || 0) - new Date(entryOf(b[1])?.updatedAt || 0));

  const survivors = room === 0 ? [] : ranked.slice(-Math.min(room, ranked.length)).map(([key]) => key);

  const evicted = Object.keys(variants)
    .filter((key) => key !== profileKey && !survivors.includes(key));

  const written = { detail, updatedAt: now };
  let update;
  if (legacyShape) {
    // Whole-field `$set`, because a dotted `$set` cannot change the field's BSON
    // type. See the note above the function: writing `variations.<digest>` onto a
    // legacy array leaves the array in place and the guide lands at index 0.
    update = {
      $set: {
        name,
        variants: Object.fromEntries([
          ...survivors.map((key) => [key, variants[key]]),
          [profileKey, written],
        ]),
      },
    };
  } else {
    update = { $set: { name, [`variants.${profileKey}`]: written } };
    if (evicted.length) {
      // `[key, value]` — an ARRAY literal, so the separator is a comma. This
      // shipped as `[...]: ''` (a stray colon), which is a SyntaxError: the whole
      // backend refused to boot, so every route 404'd at the socket and the
      // browser reported the resulting failures as CORS/network errors.
      update.$unset = Object.fromEntries(evicted.map((key) => [`variants.${key}`, '']));
    }
  }

  await SupplementDetail.updateOne({ nameKey }, update, { upsert: true }).exec();

  // A variant dropped from the document must leave memory too, or the copy in
  // the map keeps serving a guide that is no longer on disk — and keeps doing
  // so for the rest of the process's life.
  for (const key of evicted) cache.del(memoryKey(nameKey, key));

  return evicted;
}

/**
 * Read a guide: memory first, then Mongo.
 *
 * Memory first because it costs nothing and Mongo is a network round-trip;
 * Mongo second because it is the copy that survives a restart, and the copy
 * that actually saves the tokens. A read failure is swallowed on purpose — a
 * cache that cannot be read must not stop the request being answered, it just
 * means the tokens get spent.
 *
 * @param {object} args
 * @param {string} args.nameKey
 * @param {string|null} args.profileKey
 * @param {object} [deps] `{ model, cache }`
 * @returns {Promise<object|null>}
 */
async function readGuide({ nameKey, profileKey }, deps = {}) {
  const SupplementDetail = deps.model || require('../models/SupplementDetail');
  const cache = deps.cache || require('./cache');

  const key = memoryKey(nameKey, profileKey);
  const hot = cache.get(key);
  if (hot) return hot;

  try {
    const doc = await SupplementDetail.findOne({ nameKey }).select('detail variants').lean();
    const guide = readStoredGuide(doc, profileKey);
    if (guide) cache.set(key, guide);
    return guide;
  } catch (error) {
    console.error('[supplementGuideStore] cache read failed:', error.message);
    return null;
  }
}

module.exports = {
  GENERATION_TIMEOUT_MS,
  GUIDE_TTL_MS,
  MAX_VARIANTS,
  MEMORY_PREFIX,
  profileKey,
  memoryKey,
  normalizeVariants,
  readStoredGuide,
  readGuide,
  storeGuide,
};