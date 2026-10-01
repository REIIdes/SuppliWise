'use strict';
/**
 * Contract + unit check: the admin Overview's deeper analytics.
 *
 *   node Test File/admin-overview-analytics.test.js
 *
 * WHAT THIS GUARDS
 *
 * 1. The aggregation PIPELINES are shaped so the queries can only mean one
 *    thing. The renewal runway in particular is easy to get subtly wrong: a
 *    permanent grant has no end date, so counting it as "expiring" reports a
 *    renewal that cannot happen, and a plain `{resolvedAt: null}` on the flag
 *    backlog matches every assessment ever created rather than the open ones.
 *
 * 2. The shaping helpers are TOTAL. A sparse aggregate returns `null` where a
 *    count was expected, `$count` returns NO document at all when a facet
 *    matches nothing, and `$group` on an optional field yields a `null` bucket.
 *    None of those may reach the client as a null that renders as a blank tile,
 *    or as a `NaN` in a chart's `style` attribute — which the browser silently
 *    discards, leaving a bar that never draws and no error to explain why.
 *
 * 3. The list-value figure is priced from the CATALOGUE, not from a copy of the
 *    prices, so the Overview cannot quote a number the pricing page and the
 *    checkout would contradict.
 *
 * 4. Activation is capped at the member count, because the two are independent
 *    queries and a signup landing between them would otherwise report 108% of
 *    members as activated.
 */
require('dotenv').config();

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const A = require('../utils/overviewAnalytics');
const { findEntry, formatAmount } = require('../utils/planCatalogue');

const ROOT = path.join(__dirname, '..');
const ADMIN_ROUTES = fs.readFileSync(path.join(ROOT, 'routes', 'admin.js'), 'utf8');

// ── 1. toCount ────────────────────────────────────────────────────────────

test('a count is floored to a non-negative integer, whatever it was given', () => {
  assert.equal(A.toCount(5), 5);
  assert.equal(A.toCount(5.9), 5);
  assert.equal(A.toCount('12'), 12);
  // `$group` on an optional field returns null; a projection can return a
  // string. Both must arrive as a number.
  for (const bad of [null, undefined, NaN, -3, 'x', {}, [], Infinity, '']) {
    assert.equal(A.toCount(bad), 0, `input: ${String(bad)}`);
  }
});

// ── 2. rankBuckets ────────────────────────────────────────────────────────

test('a ranked list is ordered by size, then alphabetically, so it cannot reshuffle', () => {
  const ranked = A.rankBuckets([
    { _id: 'Improve Sleep', count: 4 },
    { _id: 'Fat Loss', count: 9 },
    { _id: 'Muscle Gain', count: 4 },
  ]);
  assert.deepEqual(ranked.map(row => row.label), ['Fat Loss', 'Improve Sleep', 'Muscle Gain']);
  assert.equal(ranked[0].count, 9);
});

test('a ranked list merges duplicate labels instead of listing one twice', () => {
  // `$unwind` on `healthGoals` can emit the same goal twice on one assessment.
  // Two half-counts are one whole count, not two rows that look like two members.
  const ranked = A.rankBuckets([{ _id: 'Improve Sleep', count: 2 }, { _id: 'Improve Sleep', count: 3 }]);
  assert.deepEqual(ranked, [{ label: 'Improve Sleep', count: 5 }]);
});

test('a ranked list drops blanks, zeroes and junk, and is bounded', () => {
  const ranked = A.rankBuckets([
    { _id: 'Real', count: 3 },
    { _id: '   ', count: 9 },
    { _id: '', count: 9 },
    { _id: null, count: 9 },
    { _id: 'Zero', count: 0 },
    { _id: 'Negative', count: -4 },
    { count: 9 },
  ], { limit: 5 });
  assert.deepEqual(ranked, [{ label: 'Real', count: 3 }]);
  // An open-ended label set must not grow the payload without limit.
  const many = A.rankBuckets(Array.from({ length: 50 }, (_, i) => ({ _id: `Goal ${i}`, count: i + 1 })));
  assert.equal(many.length, A.RANKED_LIST_LIMIT);
  for (const bad of [undefined, null, [], 'nope', 7, {}]) {
    assert.deepEqual(A.rankBuckets(bad), [], `input: ${JSON.stringify(bad)}`);
  }
});

test('a ranked label is whitespace-collapsed and length-capped', () => {
  // A stored value must not be able to push a 10 KB string into a table cell.
  const ranked = A.rankBuckets([{ _id: '  Fat\n\tLoss  ', count: 2 }], { cap: 12 });
  assert.equal(ranked[0].label, 'Fat Loss');
  const long = A.rankBuckets([{ _id: 'x'.repeat(500), count: 1 }], { cap: 10 });
  assert.equal(long[0].label.length, 10);
});

// ── 3. facet reads ────────────────────────────────────────────────────────

test('a facet that matched nothing reads as zero, not as missing', () => {
  // `$count` is the ONE stage that produces an empty array instead of a zero
  // when it matches nothing. "0 renew this week" and "the query returned
  // nothing" have to be the same answer, because they are the same fact.
  assert.equal(A.facetCount([]), 0);
  assert.equal(A.facetCount(undefined), 0);
  assert.equal(A.facetCount([{}]), 0);
  assert.equal(A.facetCount([{ _count: 0 }]), 0);
  assert.equal(A.facetCount([{ _count: 6 }]), 6);
  // Tolerates the `n` / `count` spellings too, so a rename cannot silently zero
  // a tile.
  assert.equal(A.facetCount([{ n: 3 }]), 3);
  assert.equal(A.facetCount([{ count: 3 }]), 3);
});

test('a severity facet is a map, so the panel owns the ordering', () => {
  const map = A.facetMap([{ _id: 'High', count: 3 }, { _id: 'Low', count: 9 }, { _id: '', count: 2 }, { _id: null, count: 1 }]);
  assert.deepEqual(map, { High: 3, Low: 9 });
  for (const bad of [undefined, null, [], 'nope', 7]) {
    assert.deepEqual(A.facetMap(bad), {}, `input: ${JSON.stringify(bad)}`);
  }
});

test('a facet map drops zeroes and is bounded, so a legend cannot overstate', () => {
  // "Keto 0%" is a claim the data does not make, and an open-ended label set
  // would otherwise grow the payload every time the questionnaire gained an
  // option.
  assert.deepEqual(A.facetMap([{ _id: 'Keto', count: 0 }, { _id: 'Vegan', count: 4 }]), { Vegan: 4 });
  const many = A.facetMap(Array.from({ length: 40 }, (_, i) => ({ _id: `Label ${i}`, count: i + 1 })));
  assert.equal(Object.keys(many).length, A.RANKED_LIST_LIMIT);
  assert.ok(A.facetMap([], { limit: 2 }) && typeof A.facetMap([], { limit: 2 }) === 'object');
});

test('the three strips are maps and the goal list is a list — the two are not interchangeable', () => {
  // THE BUG THIS GUARDS. `diets` was once emitted as a ranked
  // `[{label, count}]` list while `stress`/`sleep` were maps, and the panel fed
  // all three to one reader. `Object.keys` on a list yields "0", "1", "2",
  // whose values are objects: `Number({})` is NaN, every count floored to zero,
  // and the diet strip rendered as an empty bar labelled "0 answers" with
  // nothing thrown anywhere. The shapes are asserted apart so the two can
  // never be confused again.
  const shaped = A.profileFrom([{
    goals: [{ _id: 'Improve Sleep', count: 4 }],
    diets: [{ _id: 'Omnivore', count: 8 }],
    stress: [{ _id: 'High', count: 2 }],
    sleep: [{ _id: 'Good', count: 6 }],
  }]);
  assert.ok(Array.isArray(shaped.goals), 'goals is a ranked list');
  assert.deepEqual(shaped.goals, [{ label: 'Improve Sleep', count: 4 }]);
  for (const key of ['diets', 'stress', 'sleep']) {
    assert.ok(!(key in Array.prototype) && !Array.isArray(shaped[key]), `${key} must be a map`);
    assert.equal(typeof shaped[key], 'object');
    assert.equal(Object.values(shaped[key]).every(v => Number.isInteger(v) && v > 0), true, key);
  }
  assert.deepEqual(shaped.diets, { Omnivore: 8 });
  assert.deepEqual(shaped.stress, { High: 2 });
  assert.deepEqual(shaped.sleep, { Good: 6 });
});

// ── 4. Pipelines ──────────────────────────────────────────────────────────

const NOW = new Date('2026-10-02T00:00:00Z');
const DAY7 = new Date(NOW.getTime() - 7 * 86400000);
const DAY30 = new Date(NOW.getTime() - 30 * 86400000);

const stageNames = (pipeline) => pipeline.map(stage => Object.keys(stage).join(','));

test('the daily trend sends the widest window once, newest buckets first', () => {
  const pipeline = A.dailyBucketPipeline();
  assert.deepEqual(stageNames(pipeline), [
    '$group', '$sort', '$limit', '$sort',
  ]);
  // The $limit MUST come after the descending sort, or it keeps whichever end
  // of the ordering Mongo happens to be holding and the window is the OLDEST 30
  // days rather than the newest.
  assert.deepEqual(pipeline[1].$sort, { _id: -1 });
  assert.equal(pipeline[2].$limit, A.TREND_BUCKET_DAYS);
  // ...and before the ascending re-sort, or the chart receives 30 days in
  // descending order and buildTrendSeries walks the window backwards.
  assert.deepEqual(pipeline[3].$sort, { _id: 1 });
  // UTC, matching the client's dayParts() parser: a chart must not shift a
  // column by one for half the planet.
  assert.deepEqual(Object.keys(pipeline[0].$group._id.$dateToString), ['format', 'date']);
  assert.equal(pipeline[0].$group._id.$dateToString.format, '%Y-%m-%d');
  assert.equal(Object.prototype.hasOwnProperty.call(pipeline[0].$group._id.$dateToString, 'timezone'), false);
});

test('both trends bucket identically, from the same helper', () => {
  // Registrations and assessments are compared day-for-day on the same chart, so
  // they cannot be bucketed by two different expressions.
  assert.deepEqual(A.dailyBucketPipeline(), A.dailyBucketPipeline());
  const used = ADMIN_ROUTES.match(/aggregate\(dailyBucketPipeline\(\)\)/g) || [];
  assert.equal(used.length, 2, 'expected both trends to use the shared bucket pipeline');
});

test('engagement rolls up per member, then folds — one pass, not two', () => {
  const pipeline = A.engagementPipeline(DAY7, DAY30);
  assert.equal(pipeline.length, 2);
  assert.deepEqual(Object.keys(pipeline[0].$group).sort(), ['_id', 'last', 'recent', 'total']);
  const fold = pipeline[1].$group;
  assert.deepEqual(Object.keys(fold).sort(), ['_id', 'active30d', 'active7d', 'assessors', 'repeat', 'singletons']);
  // `assessors` counts rows in the folded stage, so it is 1 per distinct member.
  assert.equal(fold.assessors.$sum, 1);
  // The 7-day cut is made ONCE, in the per-member stage, so the fold is only
  // testing a counter it already computed. Getting the two windows the wrong way
  // round here is what would make "active in 7 days" silently mean 30.
  assert.deepEqual(pipeline[0].$group.recent.$sum.$cond[0].$gte, ['$createdAt', DAY7]);
  assert.deepEqual(fold.active7d.$sum.$cond[0].$gt, ['$recent', 0]);
  // `last >= day30` is a DIFFERENT question — "was this member here at any
  // point in the last 30 days" — and needs the max timestamp to test it.
  assert.deepEqual(fold.active30d.$sum.$cond[0].$gte, ['$last', DAY30]);
  // Repeat means strictly more than one, so a single submission is not a return.
  assert.deepEqual(fold.repeat.$sum.$cond[0].$gt, ['$total', 1]);
  assert.deepEqual(fold.singletons.$sum.$cond[0].$eq, ['$total', 1]);
  // Reading only `user` + `createdAt` is what keeps the ~500 KB aiResults blob
  // out of this query entirely.
  assert.deepEqual(pipeline[0].$group._id, '$user');
  assert.deepEqual(pipeline[0].$group.last, { $max: '$createdAt' });
});

test('engagement reads an empty rollup as all zeroes', () => {
  // No assessments at all: the pipeline returns an empty array, and the panel
  // must render zeros rather than reading `undefined`.
  assert.deepEqual(A.engagementFrom([]), {
    assessors: 0, active7d: 0, active30d: 0, repeat: 0, singletons: 0,
  });
  for (const bad of [undefined, null, [{}], 'nope', 7]) {
    assert.equal(A.engagementFrom(bad).assessors, 0, `input: ${String(bad)}`);
  }
  assert.deepEqual(A.engagementFrom([{
    assessors: 10, active7d: 4, active30d: 8, repeat: 3, singletons: 7,
  }]), { assessors: 10, active7d: 4, active30d: 8, repeat: 3, singletons: 7 });
});

test('the health profile is one $facet, and every optional field is type-guarded', () => {
  const pipeline = A.profilePipeline();
  assert.equal(pipeline.length, 1);
  const facet = pipeline[0].$facet;
  assert.deepEqual(Object.keys(facet).sort(), ['diets', 'goals', 'sleep', 'stress']);
  // `dietType`, `stressLevel` and `sleepQuality` are all OPTIONAL on the schema.
  // Without a $type guard, grouping them mixes a null bucket in with the real
  // ones and the legend grows an entry called "null".
  const guards = { diets: 'dietType', stress: 'stressLevel', sleep: 'sleepQuality' };
  for (const [stage, field] of Object.entries(guards)) {
    assert.deepEqual(facet[stage][0].$match[field], { $type: 'string' }, field);
  }
  assert.deepEqual(facet.goals[1].$match.healthGoals, { $type: 'string' });
  // Every stage is $limit-ed INSIDE the facet, which is what keeps the combined
  // output under the 16 MB facet ceiling even though healthGoals is an unbounded
  // array per document.
  for (const key of ['goals', 'diets']) {
    const last = facet[key][facet[key].length - 1];
    assert.equal(last.$limit, A.RANKED_LIST_LIMIT * 2, key);
  }
  assert.deepEqual(A.profileFrom([]), { goals: [], diets: {}, stress: {}, sleep: {} });
  assert.deepEqual(A.profileFrom(undefined), { goals: [], diets: {}, stress: {}, sleep: {} });
});

test('the runway excludes permanent grants from the expiring buckets', () => {
  // A permanent grant has no end date. Counting it as "expiring" would report a
  // renewal that cannot happen — the exact kind of confident, wrong number this
  // panel exists to avoid.
  const facet = A.runwayPipeline(NOW, DAY7, DAY30)[1].$facet;
  for (const key of ['expiring7d', 'expiring30d']) {
    assert.deepEqual(
      facet[key][0].$match.subscriptionPermanent,
      { $ne: true },
      `${key} must exclude permanent grants`,
    );
  }
  // The window is bounded on BOTH sides: > now (already lapsed is not a renewal)
  // and <= the horizon.
  assert.deepEqual(Object.keys(facet.expiring7d[0].$match.subscriptionExpiresAt), ['$gt', '$lte']);
  assert.deepEqual(facet.expiring7d[0].$match.subscriptionExpiresAt.$gt, NOW);
  assert.deepEqual(facet.expiring7d[0].$match.subscriptionExpiresAt.$lte, DAY7);
  assert.deepEqual(facet.expiring30d[0].$match.subscriptionExpiresAt.$lte, DAY30);
  // `permanent` is a separate facet, and `live` is the same set of windows the
  // activeSubscriptions metric above counts.
  assert.deepEqual(facet.permanent[0].$match, { subscriptionPermanent: true });
  assert.equal(facet.live.length, 2);
});

test('the runway is one pass over live subscriptions, not five collection scans', () => {
  const pipeline = A.runwayPipeline(NOW, DAY7, DAY30);
  assert.equal(pipeline[0].$match.subscriptionActive, true);
  assert.deepEqual(pipeline[0].$match.subscriptionPlan, { $ne: 'free' });
  assert.deepEqual(
    Object.keys(pipeline[1].$facet).sort(),
    ['expiring30d', 'expiring7d', 'lapsed30d', 'live', 'permanent'],
  );
  // A window that closed inside the last 30 days, with the flag still set.
  assert.deepEqual(Object.keys(pipeline[1].$facet.lapsed30d[0].$match.subscriptionExpiresAt), ['$lte', '$gte']);
  assert.deepEqual(A.runwayFrom([]), {
    live: 0, expiring7d: 0, expiring30d: 0, permanent: 0, lapsed30d: 0,
  });
  assert.equal(A.runwayFrom(undefined).live, 0);
});

test('the open-flag backlog requires an actual flag, not just a null resolution', () => {
  const facet = A.reviewPipeline()[0].$facet;
  assert.deepEqual(facet.openFlags[0].$match, { flaggedAt: { $ne: null }, resolvedAt: null });
  // `{ flaggedAt: null }` would match every assessment EVER CREATED, and the
  // panel would report the entire assessment history as an open backlog.
  // `$ne: null` is Mongo's existence test, so an unflagged row is excluded.
  assert.notDeepEqual(facet.openFlags[0].$match, { flaggedAt: null });
  assert.deepEqual(facet.priority[0].$match, { priority: 'Priority' });
  assert.deepEqual(A.reviewFrom([]), { priority: 0, openFlags: 0 });
  assert.deepEqual(A.reviewFrom(undefined), { priority: 0, openFlags: 0 });
});

// ── 5. Money ──────────────────────────────────────────────────────────────

test('list value is priced from the catalogue, never from a local copy', () => {
  // A hand-copied price is a number the pricing page can contradict the moment
  // a plan is repriced, and nothing would fail.
  const expected = findEntry('monthly').monthly * 2 + findEntry('annual').monthly;
  const out = A.listValueMonthly({ monthly: 2, annual: 1 });
  assert.equal(out.php, expected);
  assert.equal(out.formatted, formatAmount(expected, 'PHP'));
});

test('a free member contributes nothing, and an unknown plan is not priced', () => {
  assert.equal(A.listValueMonthly({ free: 40 }).php, 0);
  assert.equal(A.listValueMonthly({ notAPlan: 5 }).php, 0);
  // A zero is a fact ("nobody is on a plan"), so it is reported rather than
  // omitted — an absent field would be indistinguishable from a failed lookup.
  assert.equal(A.listValueMonthly({}).formatted, formatAmount(0, 'PHP'));
  for (const bad of [undefined, null, 'nope', 7, [1, 2]]) {
    assert.equal(A.listValueMonthly(bad).php, 0, `input: ${String(bad)}`);
  }
});

// ── 6. Activation ─────────────────────────────────────────────────────────

test('activation cannot exceed 100%, whatever the two counts race to', () => {
  // `assessors` and `users` are independent queries. A signup landing between
  // them would otherwise report 108% of members as activated, which reads as a
  // growth spurt rather than the bug it is.
  assert.deepEqual(A.activationOf(108, 100), { members: 100, pct: 100 });
  assert.deepEqual(A.activationOf(25, 100), { members: 25, pct: 25 });
  assert.deepEqual(A.activationOf(0, 0), { members: 0, pct: 0 });
  assert.deepEqual(A.activationOf(5, 0), { members: 0, pct: 0 });
  for (const bad of [undefined, null, NaN, -4, 'x', {}]) {
    const out = A.activationOf(bad, bad);
    assert.ok(Number.isFinite(out.members) && out.members >= 0, String(bad));
    assert.ok(Number.isFinite(out.pct) && out.pct >= 0 && out.pct <= 100, String(bad));
  }
});

// ── 7. Route wiring ───────────────────────────────────────────────────────

test('the overview route sends every key the panel reads', () => {
  const handler = ADMIN_ROUTES.indexOf("router.get('/overview'");
  assert.ok(handler > -1, 'could not find the GET /overview route');
  const end = ADMIN_ROUTES.indexOf('\nrouter.', handler + 10);
  const body = ADMIN_ROUTES.slice(handler, end > -1 ? end : ADMIN_ROUTES.length);
  for (const key of [
    'signups7d', 'signups30d', 'planBreakdown', 'twoFactorEnabled', 'lockedAccounts', 'twoFactorPct',
    'activatedMembers', 'activationPct', 'activeAssessors7d', 'activeAssessors30d',
    'repeatAssessors', 'oneOffAssessors', 'repeatPct', 'profile', 'runway', 'review',
    'listValueMonthly',
  ]) {
    assert.ok(body.includes(key), `GET /overview no longer sends analytics.${key}`);
  }
  // The window and both trend arrays travel together, or the client densifies to
  // a span the server never sent.
  for (const key of ['trendDays', 'signupTrend', 'assessmentTrend']) {
    assert.ok(body.includes(key), `GET /overview no longer sends ${key}`);
  }
});

test('every second-tier query runs inside the one Promise.all', () => {
  // Sequential awaits would add five round trips to an endpoint the dashboard
  // polls every 10 seconds, on every tab.
  const handler = ADMIN_ROUTES.indexOf("router.get('/overview'");
  const end = ADMIN_ROUTES.indexOf('\nrouter.', handler + 10);
  const body = ADMIN_ROUTES.slice(handler, end > -1 ? end : ADMIN_ROUTES.length);
  assert.equal((body.match(/await Promise\.all\(\[/g) || []).length, 1);
  for (const call of [
    'dailyBucketPipeline()', 'engagementPipeline(', 'profilePipeline()',
    'runwayPipeline(', 'reviewPipeline()',
  ]) {
    assert.ok(body.includes(call), `${call} is not in the overview's Promise.all`);
  }
  // No stray `await` on a model inside the handler: anything sequential is a
  // round trip the endpoint does not need to make.
  const strayAwaits = (body.match(/^\s*const\s+\w+\s*=\s*await\s+(?!Promise)/gm) || []);
  assert.deepEqual(strayAwaits, [], 'the overview awaits a query outside the Promise.all');
});
