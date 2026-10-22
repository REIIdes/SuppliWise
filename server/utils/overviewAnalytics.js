'use strict';
/**
 * PURE shaping helpers for the admin Overview's deeper analytics.
 *
 * WHY A SEPARATE MODULE
 * Every function here is total: given any input — `undefined`, a sparse
 * aggregate that returned no document, a `$group` that produced `null`, a
 * projection that produced a string — it returns a renderable value and never
 * throws. That guarantee is the whole reason these live outside routes/admin.js:
 * they can be unit tested against the payloads a real database actually
 * produces, instead of only being exercised when a panel happens to render.
 *
 * It also mirrors the client's own split (my-react-app/src/utils/
 * adminOverview.js): the route composes, the helpers decide what a number means.
 * Nothing here touches the database — the I/O lives in routes/admin.js.
 *
 * The one helper that DOES read money (listValueMonthly) reaches the plan
 * catalogue rather than carrying its own copy of the prices, so the Overview can
 * never quote a figure the pricing page and the checkout would contradict.
 */

const { findEntry, formatAmount } = require('./planCatalogue');

/** Days of daily buckets the trend endpoints return. The client windows this
 *  down to 7 / 14 / 30, so the server sends the widest window ONCE — three
 *  separate aggregations over the same documents would be three chances for the
 *  two charts to disagree. */
const TREND_BUCKET_DAYS = 30;

/** How many entries a ranked "top N" list may carry. Health goals and diet
 *  types are open-ended strings: a member can pick anything the questionnaire
 *  offers, and an unbounded list would grow the payload every time one is
 *  added. */
const RANKED_LIST_LIMIT = 6;

/**
 * Longest symptom or supplement name the learned co-occurrence prior may carry.
 *
 * These are read back out of stored documents into a prompt, so the bound is
 * about what may be SENT, not only about memory. A 10 KB string in a `symptoms`
 * array must not be able to become a bullet in a third-party request.
 */
const MAX_SIGNAL_LENGTH = 64;

/**
 * Coerce an aggregate bucket count to a non-negative integer.
 *
 * `$group` on a sparse collection returns `null` when every matched document was
 * missing the field, and a projection can return a string. Both would otherwise
 * travel on to the client and land in a chart's `style` attribute as `null` or
 * `NaN`, which the browser silently discards — a bar that never draws, with no
 * error to explain why.
 *
 * @param {unknown} value
 * @returns {number} a finite integer >= 0
 */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Rank a `[{ _id, count }]` aggregate into a bounded, client-renderable list.
 *
 * Shape guarantees the Overview panel depends on:
 *   - labels are whitespace-collapsed, blank labels dropped and length-capped,
 *     so a stored value cannot push a 10 KB string into a table cell;
 *   - results are ordered by count DESC then alphabetically, so two buckets
 *     holding the same number never swap places between polls (a list that
 *     reshuffles every 10 s reads as noise);
 *   - the result never exceeds `limit` and never contains a duplicate label.
 *
 * @param {unknown} buckets raw aggregate output
 * @param {{ limit?: number, labelKey?: string, cap?: number }} [options]
 * @returns {{ label: string, count: number }[]}
 */
function rankBuckets(buckets, { limit = RANKED_LIST_LIMIT, labelKey = '_id', cap = 48 } = {}) {
  const max = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : RANKED_LIST_LIMIT;
  const merged = new Map();
  for (const bucket of Array.isArray(buckets) ? buckets : []) {
    const label = String(bucket?.[labelKey] ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
    if (!label) continue;
    const count = toCount(bucket?.count);
    if (!count) continue;
    // Merging rather than overwriting: `$unwind` can emit the same goal twice on
    // one assessment (a duplicated selection), and two half-counts are one
    // whole count, not two rows that look like two members.
    merged.set(label, (merged.get(label) || 0) + count);
  }
  return [...merged.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label))
    .slice(0, max);
}

/**
 * Read one `{ _count: n }` out of a `$facet` stage.
 *
 * `$count` is the one aggregation stage that produces an EMPTY array rather
 * than a zero when it matches nothing, so every read has to tolerate a missing
 * entry. Without this, "0 people renew this week" and "the query returned
 * nothing" would be indistinguishable — and the second has to read as the first,
 * because it is the same answer.
 *
 * @param {unknown} facet
 * @returns {number}
 */
function facetCount(facet) {
  const first = Array.isArray(facet) ? facet[0] : null;
  if (!first) return 0;
  return toCount(first._count ?? first.n ?? first.count);
}

/**
 * Flatten one `$facet` stage into `{ [label]: count }`, blanks dropped.
 *
 * Returned as a MAP, not a list, because the caller renders these as a fixed
 * severity strip (diet, stress level, sleep quality) whose order comes from the
 * questionnaire, not from the database. Letting `$group`'s hash order decide it
 * would shuffle the colours between polls.
 *
 * `limit` bounds how many labels can come back. These fields are open-ended
 * strings, so an unbounded map would grow the payload every time the
 * questionnaire gained an option — the same reason RANKED_LIST_LIMIT exists for
 * the ranked lists. The three strips all take one, so their payload cannot
 * become larger than any of them.
 *
 * @param {unknown} facet
 * @param {{ cap?: number, limit?: number }} [options]
 * @returns {Record<string, number>}
 */
function facetMap(facet, { cap = 32, limit = RANKED_LIST_LIMIT } = {}) {
  const out = {};
  for (const bucket of Array.isArray(facet) ? facet : []) {
    if (Object.keys(out).length >= limit) break;
    const label = String(bucket?._id ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
    if (!label) continue;
    out[label] = toCount(bucket?.count);
  }
  // A zero-valued label is not an answer, so it is not reported: a legend entry
  // reading "Keto 0%" is a claim the data does not make.
  for (const [label, count] of Object.entries(out)) {
    if (!count) delete out[label];
  }
  return out;
}

/**
 * The daily-bucket stage shared by the assessment and signup trends.
 *
 * `$dateToString` with no `timezone` formats in UTC, which is exactly the frame
 * the client's `dayParts()` parses back — the two cannot disagree about which
 * day a bucket belongs to, and a chart cannot shift a column by one.
 *
 * The `$limit` runs BEFORE the ascending re-sort on purpose: it has to be
 * applied to the newest buckets, not to whichever end of the sort Mongo happens
 * to be holding.
 *
 * @returns {object[]} a Mongo aggregation pipeline
 */
function dailyBucketPipeline() {
  return [
    { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
    { $sort: { _id: -1 } },
    { $limit: TREND_BUCKET_DAYS },
    { $sort: { _id: 1 } },
  ];
}

/**
 * Engagement depth, from ONE pass over the assessments.
 *
 * `assessors` (distinct members who have ever submitted) and `repeat`
 * (those with 2+) are the two halves of the activation question, and both need a
 * per-user rollup — so they share a single `$group` pass rather than costing two
 * collection scans. The second `$group` folds those per-user rows into the
 * dashboard numbers, which is why the first stage carries `total`, `last` and
 * `recent` rather than the final counts.
 *
 * Reads only `user` and `createdAt` — both covered by the {user, createdAt}
 * index, so the ~500 KB `aiResults` blob on each assessment is never touched.
 *
 * @param {Date} day7
 * @param {Date} day30
 * @returns {object[]} a Mongo aggregation pipeline
 */
function engagementPipeline(day7, day30) {
  return [
    {
      $group: {
        _id: '$user',
        total: { $sum: 1 },
        last: { $max: '$createdAt' },
        recent: { $sum: { $cond: [{ $gte: ['$createdAt', day7] }, 1, 0] } },
      },
    },
    {
      $group: {
        _id: null,
        assessors: { $sum: 1 },
        active7d: { $sum: { $cond: [{ $gt: ['$recent', 0] }, 1, 0] } },
        active30d: { $sum: { $cond: [{ $gte: ['$last', day30] }, 1, 0] } },
        repeat: { $sum: { $cond: [{ $gt: ['$total', 1] }, 1, 0] } },
        singletons: { $sum: { $cond: [{ $eq: ['$total', 1] }, 1, 0] } },
      },
    },
  ];
}

/**
 * Read the single rolled-up row an engagement pipeline produces.
 *
 * @param {unknown} rows
 * @returns {{ assessors: number, active7d: number, active30d: number, repeat: number, singletons: number }}
 */
function engagementFrom(rows) {
  const row = Array.isArray(rows) ? rows[0] : null;
  return {
    assessors: toCount(row?.assessors),
    active7d: toCount(row?.active7d),
    active30d: toCount(row?.active30d),
    repeat: toCount(row?.repeat),
    singletons: toCount(row?.singletons),
  };
}

/**
 * The health profile members actually submit: diet type, the goals they came
 * for, and how stressed / rested they said they were.
 *
 * ONE `$facet` rather than four round trips — the same documents are examined
 * once and four small results come back. Every stage is `$limit`ed INSIDE the
 * facet, which is what keeps the combined output far under the 16 MB facet
 * ceiling even though `healthGoals` is an unbounded array per document.
 *
 * The `$type: 'string'` guards are not defensive noise: `dietType` and friends
 * are OPTIONAL on the schema, and grouping a field that is missing on some
 * documents mixes `null` buckets in with the real ones — a legend entry called
 * "null" sitting next to "Vegan".
 *
 * @returns {object[]} a Mongo aggregation pipeline
 */
function profilePipeline() {
  // A factory, not a shared literal: the aggregation stages are handed to the
  // driver, and four stages pointing at one object is one accidental mutation
  // away from three of them silently losing their guard.
  const text = () => ({ $type: 'string' });
  return [
    {
      $facet: {
        goals: [
          { $unwind: '$healthGoals' },
          { $match: { healthGoals: text() } },
          { $group: { _id: '$healthGoals', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          // Over-fetched on purpose: rankBuckets merges duplicate labels, and a
          // duplicated goal must not crowd out a distinct one further down.
          { $limit: RANKED_LIST_LIMIT * 2 },
        ],
        diets: [
          { $match: { dietType: text() } },
          { $group: { _id: '$dietType', count: { $sum: 1 } } },
          // Deliberately NOT sorted: this is a STRIP whose order is the
          // questionnaire's, so there is no "top N" to take. facetMap bounds it
          // instead, so an open label set cannot grow the payload.
          { $limit: RANKED_LIST_LIMIT * 2 },
        ],
        stress: [
          { $match: { stressLevel: text() } },
          { $group: { _id: '$stressLevel', count: { $sum: 1 } } },
        ],
        sleep: [
          { $match: { sleepQuality: text() } },
          { $group: { _id: '$sleepQuality', count: { $sum: 1 } } },
        ],
      },
    },
  ];
}

/**
 * Read the single faceted row a profile pipeline produces.
 *
 * `goals` is a RANKED LIST because the panel draws it as a top-N bar chart;
 * `diets` / `stress` / `sleep` are MAPS because the panel draws them as strips
 * whose order is the questionnaire's severity order. The two shapes are not
 * interchangeable, and a strip fed a list renders as an empty bar with no error
 * — which is why they are named apart here rather than at the call site.
 *
 * @param {unknown} rows
 * @returns {{ goals: {label:string,count:number}[], diets: Record<string,number>, stress: Record<string,number>, sleep: Record<string,number> }}
 */
function profileFrom(rows) {
  const block = (Array.isArray(rows) ? rows[0] : null) || {};
  return {
    goals: rankBuckets(block.goals),
    diets: facetMap(block.diets),
    stress: facetMap(block.stress),
    sleep: facetMap(block.sleep),
  };
}

/**
 * Renewal runway, from ONE pass over subscriptions.
 *
 * The four numbers an operator actually plans renewals from, plus the lapsed
 * count that says how many windows closed in the last month while the bare
 * `subscriptionActive` flag was still set. `permanent` grants are excluded from
 * the expiring buckets deliberately: they have no end date, so counting them
 * would report a renewal that cannot happen.
 *
 * One `$facet` rather than five `countDocuments` calls: the subscription flags
 * are not indexed together, so five counts would be five collection scans where
 * one is enough.
 *
 * @param {Date} now
 * @param {Date} day7
 * @param {Date} day30
 * @returns {object[]} a Mongo aggregation pipeline
 */
function runwayPipeline(now, day7, day30) {
  return [
    { $match: { subscriptionActive: true, subscriptionPlan: { $ne: 'free' } } },
    {
      $facet: {
        live: [
          {
            $match: {
              $or: [
                { subscriptionPermanent: true },
                { subscriptionExpiresAt: null },
                { subscriptionExpiresAt: { $gt: now } },
              ],
            },
          },
          { $count: 'n' },
        ],
        expiring7d: [
          { $match: { subscriptionPermanent: { $ne: true }, subscriptionExpiresAt: { $gt: now, $lte: day7 } } },
          { $count: 'n' },
        ],
        expiring30d: [
          { $match: { subscriptionPermanent: { $ne: true }, subscriptionExpiresAt: { $gt: now, $lte: day30 } } },
          { $count: 'n' },
        ],
        permanent: [{ $match: { subscriptionPermanent: true } }, { $count: 'n' }],
        lapsed30d: [{ $match: { subscriptionExpiresAt: { $lte: now, $gte: day30 } } }, { $count: 'n' }],
      },
    },
  ];
}

/**
 * Read the single faceted row a runway pipeline produces.
 *
 * @param {unknown} rows
 * @returns {{ live: number, expiring7d: number, expiring30d: number, permanent: number, lapsed30d: number }}
 */
function runwayFrom(rows) {
  const block = (Array.isArray(rows) ? rows[0] : null) || {};
  return {
    live: facetCount(block.live),
    expiring7d: facetCount(block.expiring7d),
    expiring30d: facetCount(block.expiring30d),
    permanent: facetCount(block.permanent),
    lapsed30d: facetCount(block.lapsed30d),
  };
}

/**
 * What is waiting for a human on the assessment-management tab.
 *
 * Both counts sit on the admin's own triage path, so they belong beside the
 * other Overview numbers: `priority` is the queue depth an admin set by hand,
 * and `openFlags` is the automatic priority-flagging backlog (flagged, not yet
 * resolved) that the same tab has to clear.
 *
 * @returns {object[]} a Mongo aggregation pipeline
 */
function reviewPipeline() {
  return [
    {
      $facet: {
        priority: [{ $match: { priority: 'Priority' } }, { $count: 'n' }],
        // `$ne: null` is an EXISTENCE test in Mongo, so an assessment that was
        // never flagged (flaggedAt absent) is correctly excluded. A plain
        // `{ resolvedAt: null }` would match every row ever created, and the
        // panel would report the whole assessment history as "open flags".
        openFlags: [{ $match: { flaggedAt: { $ne: null }, resolvedAt: null } }, { $count: 'n' }],
      },
    },
  ];
}

/**
 * Read the single faceted row a review pipeline produces.
 *
 * @param {unknown} rows
 * @returns {{ priority: number, openFlags: number }}
 */
function reviewFrom(rows) {
  const block = (Array.isArray(rows) ? rows[0] : null) || {};
  return { priority: facetCount(block.priority), openFlags: facetCount(block.openFlags) };
}

/**
 * What the paid base is worth per month at PUBLISHED LIST PRICE.
 *
 * The figure is read from the same catalogue the pricing page and the purchase
 * endpoint charge from — never from a copy of the prices here — so the Overview
 * can never quote a number the checkout would contradict, and a price change
 * moves all three together.
 *
 * It is deliberately reported as LIST value, not revenue: plans are granted by
 * hand, so nothing here has been reconciled against a payment. The UI says so
 * next to the number.
 *
 * Zero is returned as a genuine zero rather than omitted, so the panel can
 * distinguish "nobody is on a plan" from "the price lookup failed" — the first
 * is a fact, the second would be a bug worth seeing.
 *
 * @param {Record<string, unknown>} planBreakdown live counts per stored plan id
 * @returns {{ php: number, formatted: string }}
 */
function listValueMonthly(planBreakdown) {
  const plans = (planBreakdown && typeof planBreakdown === 'object' && !Array.isArray(planBreakdown))
    ? planBreakdown
    : {};
  const php = Object.keys(plans).reduce((sum, planId) => {
    const entry = findEntry(planId);
    const price = Number(entry?.monthly);
    const count = toCount(plans[planId]);
    return count > 0 && Number.isFinite(price) && price > 0 ? sum + price * count : sum;
  }, 0);
  return { php, formatted: formatAmount(php, 'PHP') };
}

/**
 * Is the AI second opinion earning the review-queue space it takes?
 *
 * `priorityFlagging.js` runs a model on the clinical submit path so it can catch
 * concern the keyword lists miss — and until the flag's ORIGIN was recorded
 * (`Assessment.flagSource`), a rules flag and a rules+AI flag were the same
 * document, so there was no way to tell afterwards which ones the model caused.
 * That made the layer permanently unfalsifiable: its whole justification is "it
 * catches what the rules miss", and nothing could ever confirm or refute that.
 *
 * This is the measurement. Of the flags the model alone raised, how many did an
 * admin go on to release? A flag is counted as UPHELD when an admin cleared the
 * Priority back to Standard; released-without-a-resolution-reason is treated as
 * "no admin verdict recorded" and excluded rather than assumed either way, so
 * the figure cannot be inflated by rows nobody actually looked at.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------
 * It does not move `ESCALATION_MIN_CONFIDENCE`, or any other threshold. A safety
 * gate that silently retunes itself on live clinical outcomes, with no test and
 * no human in the loop, is the exact failure mode that layer's own header warns
 * about — and a precision figure computed from a few dozen rows is not evidence
 * enough to justify it. The number is for a human to read and then act on.
 *
 * @param {Date} since
 * @returns {object[]} a Mongo aggregation pipeline
 */
function calibrationPipeline(since) {
  const floor = since instanceof Date && !Number.isNaN(since.getTime()) ? since : new Date(0);
  return [
    // Only rows whose provenance is actually recorded. A pre-field assessment
    // would otherwise land in `rules` and quietly improve the precision of the
    // model's own record.
    { $match: { flagSource: { $in: ['rules', 'rules+ai'] }, flaggedAt: { $gte: floor } } },
    {
      $facet: {
        // Flags the model ALONE raised. The denominator of the whole question.
        aiEscalations: [
          { $match: { flagSource: 'rules+ai' } },
          { $count: 'n' },
        ],
        // …of those, ones an admin released instead of confirming.
        aiReleased: [
          {
            $match: {
              flagSource: 'rules+ai',
              resolvedAt: { $ne: null },
              priority: 'Standard',
            },
          },
          { $count: 'n' },
        ],
        // Excluded from both: the AI escalated but nobody has resolved the flag
        // yet. Surfaced so the panel can say "9 of 20 still open" rather than
        // quietly reporting precision over the 11 that are decided.
        aiOpen: [
          { $match: { flagSource: 'rules+ai', resolvedAt: null } },
          { $count: 'n' },
        ],
        // The rules-only baseline, so the AI's precision can be read against the
        // rate at which the deterministic engine's own flags are released. A
        // model that flags at 90% precision when the rules run at 99% is adding
        // load, not coverage.
        rulesEscalations: [
          { $match: { flagSource: 'rules' } },
          { $count: 'n' },
        ],
        rulesReleased: [
          {
            $match: { flagSource: 'rules', resolvedAt: { $ne: null }, priority: 'Standard' },
          },
          { $count: 'n' },
        ],
      },
    },
  ];
}

/**
 * Read the single faceted row a calibration pipeline produces.
 *
 * `precisionPct` is deliberately `null` rather than 0 or 100 when nothing has
 * been decided yet. "No AI escalations recorded" is a fact about a young
 * deployment, not a score of zero, and a panel that renders 0% would be
 * reporting a failing model that has never run.
 *
 * @param {unknown} rows
 * @returns {{aiEscalations: number, aiReleased: number, aiOpen: number,
 *            aiPrecisionPct: number|null, rulesEscalations: number,
 *            rulesReleased: number, rulesPrecisionPct: number|null}}
 */
function calibrationFrom(rows) {
  const block = (Array.isArray(rows) ? rows[0] : null) || {};
  const aiEscalations = facetCount(block.aiEscalations);
  const aiReleased = facetCount(block.aiReleased);
  const rulesEscalations = facetCount(block.rulesEscalations);
  const rulesReleased = facetCount(block.rulesReleased);
  const decided = aiEscalations - facetCount(block.aiOpen);
  return {
    aiEscalations,
    aiReleased,
    aiOpen: facetCount(block.aiOpen),
    aiDecided: Math.max(0, decided),
    // Precision over DECIDED escalations only — an open flag is not a failure, and
    // counting it as one would understate the model for being early rather than
    // wrong.
    aiPrecisionPct: decided > 0 ? Math.round(((decided - aiReleased) / decided) * 100) : null,
    rulesEscalations,
    rulesReleased,
    rulesPrecisionPct: rulesEscalations > 0
      ? Math.round(((rulesEscalations - rulesReleased) / rulesEscalations) * 100)
      : null,
  };
}

/**
 * Activation: how many members have EVER produced an assessment, as a share of
 * the member count.
 *
 * Capped at `totalUsers` on purpose. `assessors` and `users` come from two
 * separate queries, and a signup landing between them would otherwise push the
 * rate over 100% — a dashboard that reports it activated 108% of its members is
 * a bug, not a growth spurt.
 *
 * @param {unknown} assessors
 * @param {unknown} totalUsers
 * @returns {{ members: number, pct: number }}
 */
function activationOf(assessors, totalUsers) {
  const users = Math.max(0, toCount(totalUsers));
  const members = Math.min(users, toCount(assessors));
  return { members, pct: users > 0 ? Math.round((members / users) * 100) : 0 };
}

/**
 * The learned symptom→supplement co-occurrence prior, from the real corpus.
 *
 * WHAT THIS IS
 * ------------
 * A COUNT, not a model. For every assessment that actually carries a generated
 * plan, tally which supplements appeared alongside which symptoms, then smooth.
 * Over time this becomes the one signal in the retrieval layer that reflects what
 * THIS population presents rather than what a hand-written table assumes.
 *
 * WHY COUNTING AND NOT TRAINING
 * -----------------------------
 * A supplement recommendation is a clinical judgement. There is no label set in
 * this repository to train on, and self-training on a model's own output about
 * health is how a system comes to hold a wrong belief confidently and at scale.
 * A count is auditable — you can read it, question it, and recompute it — and it
 * is used only to ORDER a vetted shortlist, never to introduce an item that is
 * not already in the catalog.
 *
 * The smoothing divisor is the strongest co-occurrence in the same document, not
 * a global constant: a member who selected nine symptoms would otherwise
 * contribute nine times the evidence of a member who selected one, purely
 * because the form is longer. Normalising within a document keeps the prior a
 * statement about CO-OCCURRENCE ("these travel together") rather than about
 * popularity ("somebody once reported these").
 *
 * @param {Date} since
 * @returns {object[]} a Mongo aggregation pipeline
 */
function cooccurrencePipeline(since) {
  const floor = since instanceof Date && !Number.isNaN(since.getTime()) ? since : new Date(0);
  return [
    { $match: { createdAt: { $gte: floor } } },
    { $unwind: '$symptoms' },
    {
      // Symptoms live in a free-text-ish array, so documents with none, or with a
      // non-string entry, would otherwise produce `_id: null` buckets that look
      // like a symptom named "null" in the retrieved prompt.
      $match: { symptoms: { $type: 'string' } },
    },
    { $unwind: '$aiResults.recommendations' },
    {
      $group: {
        _id: '$symptoms',
        pairs: { $push: '$aiResults.recommendations.name' },
      },
    },
    { $unwind: '$pairs' },
    {
      $group: {
        _id: { symptom: '$_id', supplement: '$pairs' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ];
}

/**
 * Fold the raw pairs into the shape the retrieval layer consumes.
 *
 * Two keys, because the symptoms are known one at a time at request time and the
 * supplement list is known one at a time when scoring. `bySymptom` is the direct
 * lookup; `bySupplement` is the mirror image, and is what makes a supplement
 * that is usually paired with a symptom the member did NOT tick still reachable
 * once it appears anywhere in their profile.
 *
 * Bounded on both sides, so one dominant symptom cannot produce an unbounded map.
 *
 * @param {unknown} rows raw `cooccurrencePipeline` output
 * @param {{limit?: number}} [options]
 * @returns {{bySymptom: Record<string, number>, bySupplement: Record<string, number>,
 *            pairs: number, symptoms: number}}
 */
function cooccurrenceFrom(rows, { limit = 200 } = {}) {
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.floor(Number(limit)) : 200;
  const list = Array.isArray(rows) ? rows.slice(0, cap) : [];

  const bySymptom = {};
  const bySupplement = {};
  // Pairs that survived the blank-name and zero-count filters. This used to report
  // the number of rows READ, which made `pairs` a count of garbage whenever the
  // pipeline produced any — and it is the number the admin panel shows as evidence
  // that the prior is learning something, so it has to mean what it says.
  let pairs = 0;

  for (const row of list) {
    const symptom = String(row?._id?.symptom ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNAL_LENGTH);
    const supplement = String(row?._id?.supplement ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SIGNAL_LENGTH);
    const count = toCount(row?.count);
    if (!symptom || !supplement || !count) continue;
    pairs += 1;
    bySymptom[symptom] = (bySymptom[symptom] || 0) + count;
    bySupplement[supplement] = (bySupplement[supplement] || 0) + count;
  }

  // Normalise INSIDE the document, and by each map's own maximum rather than by
  // the strongest single pair.
  //
  // Two things were wrong before. Aggregating first and scaling by the largest
  // single PAIR let a symptom with two strong partners exceed 1 (Fatigue with
  // Iron=40 and B12=20 sums to 60, and 60/40 = 1.5) — and a prior that reports
  // 1.5 is a prior whose magnitude no longer means anything. Scaling each map by
  // its own maximum makes both maps comparable and both bounded in [0, 1], which
  // is what "relative strength" has to mean for `applyPrior` to use it.
  const scale = (map) => {
    let max = 0;
    for (const value of Object.values(map)) max = Math.max(max, value);
    if (max <= 0) return;
    for (const key of Object.keys(map)) {
      map[key] = Math.round((map[key] / max) * 1000) / 1000;
    }
  };
  scale(bySymptom);
  scale(bySupplement);

  return {
    bySymptom,
    bySupplement,
    pairs,
    symptoms: Object.keys(bySymptom).length,
  };
}

/**
 * Merge both directions into the single flat map the retrieval layer reads.
 *
 * A union rather than a choice, because both directions are real evidence: the
 * symptom→supplement direction answers "what usually goes with what they
 * reported", and the supplement→symptom direction answers "is this supplement
 * worth considering given they reported this at all".
 *
 * @param {{bySymptom?: object, bySupplement?: object}} cooccurrence
 * @returns {Record<string, number>}
 */
function priorFrom(cooccurrence) {
  if (!cooccurrence || typeof cooccurrence !== 'object') return {};
  const merged = {};
  for (const source of [cooccurrence.bySymptom, cooccurrence.bySupplement]) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source)) {
      if (!Number.isFinite(Number(value))) continue;
      merged[key] = Math.max(merged[key] || 0, Number(value));
    }
  }
  return merged;
}

module.exports = {
  TREND_BUCKET_DAYS,
  RANKED_LIST_LIMIT,
  MAX_SIGNAL_LENGTH,
  toCount,
  rankBuckets,
  facetCount,
  facetMap,
  dailyBucketPipeline,
  engagementPipeline,
  engagementFrom,
  profilePipeline,
  profileFrom,
  runwayPipeline,
  runwayFrom,
  reviewPipeline,
  reviewFrom,
  calibrationPipeline,
  calibrationFrom,
  cooccurrencePipeline,
  cooccurrenceFrom,
  priorFrom,
  listValueMonthly,
  activationOf,
};
