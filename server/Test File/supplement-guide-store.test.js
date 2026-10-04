/**
 * Supplement guide storage — "Tap for details".
 *
 * Run: npm test
 *
 * The feature this file protects is one button. It writes a long clinical guide
 * through a paid provider, so the properties below are not optimizations:
 *
 *   1. A guide is paid for ONCE. Every read path — memory, disk, and the race
 *      between two simultaneous taps — has to return a stored guide, or the
 *      feature silently costs a generation per tap again.
 *   2. A personalized guide is keyed on the READER. One reader's guide served to
 *      another is a health-privacy failure, not a cache miss, so identity is part
 *      of the key in all three places it can leak: memory, disk, deduplication.
 *   3. The document is BOUNDED. An array that grows until Mongo refuses it turns
 *      a working feature into a 502 for one very popular supplement.
 *   4. Storage never BREAKS the feature. A dead database means tokens get spent,
 *      which is the old behaviour — not a 500.
 *   5. The generation budget must outlast a real generation, or the panel fails
 *      while the provider is perfectly healthy.
 *
 * `fetch` is stubbed throughout and node's runner isolates this file's process,
 * so nothing here touches the network, MongoDB, or another suite.
 */
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const express = require('express');

const {
  GENERATION_TIMEOUT_MS,
  GUIDE_TTL_MS,
  MAX_VARIANTS,
  profileKey,
  memoryKey,
  readStoredGuide,
  normalizeVariants,
  readGuide,
  storeGuide,
} = require('../utils/supplementGuideStore.js');
const cache = require('../utils/cache.js');

/**
 * An in-memory stand-in for the SupplementDetail collection.
 *
 * Faithful about the three behaviours the store actually depends on:
 *   - `findOne().select().lean()` is chainable AND thenable (see stubQuery.js for
 *     why a bare object here breaks the code under test rather than the test);
 *   - `updateOne` applies `$set` / `$unset` — INCLUDING DOTTED FIELD PATHS — and
 *     `upsert` creates the document;
 *   - a lean read yields plain JSON, so `variants` arrives as an object.
 *
 * A permissive double would let the eviction and overwrite assertions pass for
 * the wrong reason, which is the whole thing they exist to catch. Writing that
 * wrongly is not hypothetical: the first version of this file used an array
 * model and `$pull` + `$push`, and "storing the same profile twice replaces it"
 * failed with two copies — the exact defect the Map model removes.
 */
function guideStore() {
  const docs = new Map(); // nameKey -> { nameKey, name, detail, variants }

  const setPath = (doc, path, value) => {
    const parts = String(path).split('.');
    let node = doc;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node[parts[i]] || typeof node[parts[i]] !== 'object') node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  };

  const apply = (filter, update, options) => {
    const key = filter && filter.nameKey;
    let doc = docs.get(key);
    if (!doc && options && options.upsert) {
      // MongoDB seeds an upserted document from the query's equality conditions.
      doc = { nameKey: key, name: key, detail: null, variants: {} };
      docs.set(key, doc);
    }
    if (!doc) return { acknowledged: true, matchedCount: 0 };

    for (const [path, value] of Object.entries(update.$set || {})) setPath(doc, path, value);
    for (const path of Object.keys(update.$unset || {})) {
      const parts = String(path).split('.');
      let node = doc;
      for (let i = 0; i < parts.length - 1 && node; i += 1) node = node[parts[i]];
      if (node) delete node[parts[parts.length - 1]];
    }
    return { acknowledged: true, matchedCount: 1 };
  };

  return {
    docs,
    findOne(filter) {
      const doc = docs.get(filter && filter.nameKey) || null;
      const query = {
        select: () => query,
        lean: async () => (doc ? JSON.parse(JSON.stringify(doc)) : null),
        then: (onOk, onErr) => Promise.resolve(doc).then(onOk, onErr),
      };
      return query;
    },
    updateOne(filter, update, options) {
      return { exec: async () => apply(filter, update, options) };
    },
  };
}

const GUIDE = {
  name: 'Creatine Monohydrate Powder',
  overview: 'The most researched form of creatine.',
  keyBenefits: [{ title: 'Strength', description: 'More power in short efforts.' }],
  howToTake: [{ title: 'Dose', description: '3-5 g daily.' }],
  considerations: ['Drink water.'],
  availability: 'Powder or capsules.',
  disclaimer: 'Ask a clinician.',
};

/**
 * Node's own fetch, captured before anything replaces it.
 *
 * `afterEach` cannot simply `delete globalThis.fetch` the way the other suites
 * do: this file needs a working fetch to talk to its own Express server, and
 * deleting the global takes the platform's implementation with it — every test
 * after the first then failed with "originalFetch is not a function".
 */
const NODE_FETCH = globalThis.fetch;

const PROFILE_A = 'Patient: 28-year-old male\nSymptoms: low energy';
const PROFILE_B = 'Patient: 61-year-old female\nConditions: type 2 diabetes';

afterEach(() => {
  cache.clear();
  globalThis.fetch = NODE_FETCH;
});

// ── Keying: identity is part of the key ──────────────────────────────────────

test('profileKey is stable across cosmetic reformatting of the same profile', () => {
  const a = profileKey('Patient: 28-year-old male\nSymptoms: low energy');
  const b = profileKey('  patient:  28-year-old   male \n symptoms: LOW   energy  ');
  assert.equal(a, b, 'case and whitespace must not split one reader into two keys');
});

test('profileKey separates different readers', () => {
  assert.notEqual(profileKey(PROFILE_A), profileKey(PROFILE_B));
});

test('profileKey is null for a generic guide, and never echoes the profile', () => {
  assert.equal(profileKey(null), null);
  assert.equal(profileKey(''), null);
  assert.equal(profileKey('   \n  '), null);

  const key = profileKey(PROFILE_A);
  assert.equal(key.length, 32);
  // The document holds health content; the key must not be a copy of it.
  assert.ok(!String(key).includes('28-year-old'));
  assert.ok(!/^\d+$/.test(String(key)));
});

test('the memory key carries the reader, so two profiles cannot collide', () => {
  assert.notEqual(memoryKey('creatine', profileKey(PROFILE_A)), memoryKey('creatine', profileKey(PROFILE_B)));
  assert.notEqual(memoryKey('creatine', null), memoryKey('creatine', profileKey(PROFILE_A)));
  // Same reader, same key — the property the storage actually depends on.
  assert.equal(memoryKey('creatine', profileKey(PROFILE_A)), memoryKey('creatine', profileKey(PROFILE_A)));
});

// ── Reading: the TTL is enforced, not merely documented ──────────────────────

test('readStoredGuide returns the generic guide for a null profile key', () => {
  assert.deepEqual(readStoredGuide({ detail: GUIDE, variants: [] }, null), GUIDE);
});

test('readStoredGuide returns only the variant belonging to this reader', () => {
  const keyA = profileKey(PROFILE_A);
  const keyB = profileKey(PROFILE_B);
  const doc = {
    detail: GUIDE,
    variants: {
      [keyA]: { detail: { ...GUIDE, overview: 'for A' }, updatedAt: new Date() },
      [keyB]: { detail: { ...GUIDE, overview: 'for B' }, updatedAt: new Date() },
    },
  };
  assert.equal(readStoredGuide(doc, keyA).overview, 'for A');
  assert.equal(readStoredGuide(doc, keyB).overview, 'for B');
});

test('readStoredGuide treats an expired variant as a miss, not a stale answer', () => {
  const key = profileKey(PROFILE_A);
  const doc = {
    detail: GUIDE,
    variants: { [key]: { detail: GUIDE, updatedAt: new Date(Date.now() - GUIDE_TTL_MS - 1000) } },
  };
  assert.equal(readStoredGuide(doc, key), null, 'a guide past its TTL must regenerate');
});

test('readStoredGuide keeps a variant still inside the TTL', () => {
  const key = profileKey(PROFILE_A);
  const doc = {
    detail: GUIDE,
    variants: { [key]: { detail: GUIDE, updatedAt: new Date(Date.now() - GUIDE_TTL_MS + 60_000) } },
  };
  assert.deepEqual(readStoredGuide(doc, key), GUIDE);
});

test('readStoredGuide is null-safe for a missing document or empty map', () => {
  assert.equal(readStoredGuide(null, null), null);
  assert.equal(readStoredGuide(null, profileKey(PROFILE_A)), null);
  assert.equal(readStoredGuide({ variants: {} }, profileKey(PROFILE_A)), null);
  assert.equal(readStoredGuide({ detail: null, variants: null }, null), null);
  // A document written before the map shape existed carries no `variants` at all.
  assert.equal(readStoredGuide({ detail: null }, profileKey(PROFILE_A)), null);
});

// ── The shape this module used to write ──────────────────────────────────────

test('a guide stored under the OLD array shape is still found, not regenerated', () => {
  // Every guide already on disk was written as an ARRAY of
  // `{ profileKey, detail, updatedAt }`. A reader that only understood the new
  // map would miss all of them, and every deployment would regenerate guides the
  // database already holds — the exact cost this module exists to remove,
  // arriving on the day it is fixed.
  const key = profileKey(PROFILE_A);
  const legacy = {
    detail: null,
    variants: [
      { profileKey: key, detail: { ...GUIDE, overview: 'from the old shape' }, updatedAt: new Date() },
      { profileKey: profileKey(PROFILE_B), detail: GUIDE, updatedAt: new Date() },
    ],
  };
  assert.equal(readStoredGuide(legacy, key).overview, 'from the old shape');
  assert.deepEqual(readStoredGuide(legacy, profileKey(PROFILE_B)), GUIDE);
  // Still one reader's guide: the array must not become "any match wins".
  assert.equal(readStoredGuide(legacy, profileKey('Patient: 99-year-old other')), null);
});

test('an EXPIRED entry in the old shape is still a miss', () => {
  const key = profileKey(PROFILE_A);
  const legacy = {
    variants: [{ profileKey: key, detail: GUIDE, updatedAt: new Date(Date.now() - GUIDE_TTL_MS - 1000) }],
  };
  assert.equal(readStoredGuide(legacy, key), null);
});

test('normalizeVariants folds the old array shape into the new map shape', () => {
  const keyA = profileKey(PROFILE_A);
  const keyB = profileKey(PROFILE_B);
  const normalized = normalizeVariants([
    { profileKey: keyA, detail: GUIDE, updatedAt: '2026-01-01T00:00:00.000Z' },
    { profileKey: keyB, detail: GUIDE, updatedAt: '2026-01-02T00:00:00.000Z' },
  ]);
  assert.deepEqual(Object.keys(normalized).sort(), [keyA, keyB].sort());
  assert.deepEqual(normalized[keyA], { detail: GUIDE, updatedAt: '2026-01-01T00:00:00.000Z' });
});

test('normalizeVariants drops a malformed entry rather than indexing by it', () => {
  assert.deepEqual(normalizeVariants([null, {}, { profileKey: 'k' }, { detail: GUIDE }]), {});
  assert.deepEqual(normalizeVariants(null), {});
  assert.deepEqual(normalizeVariants(undefined), {});
  // A map entry with no guide is not a guide.
  assert.deepEqual(normalizeVariants({ k: {}, j: null }), {});
});

test('writing to a document in the OLD shape converts it, and keeps what was there', async () => {
  const model = guideStore();
  const oldKey = profileKey(PROFILE_B);
  const newKey = profileKey(PROFILE_A);

  // Exactly what the previous version of this code left on disk.
  model.docs.set('creatine', {
    nameKey: 'creatine',
    name: 'Creatine',
    detail: null,
    variants: [{ profileKey: oldKey, detail: GUIDE, updatedAt: new Date() }],
  });

  await storeGuide(
    { nameKey: 'creatine', supplementName: 'Creatine', detail: { ...GUIDE, overview: 'fresh' }, profileKey: newKey },
    { model },
  );

  const doc = await model.findOne({ nameKey: 'creatine' }).lean();
  assert.ok(!Array.isArray(doc.variants), 'the field must stop being an array, or the next read cannot find it');
  assert.deepEqual(Object.keys(doc.variants).sort(), [oldKey, newKey].sort());
  assert.equal(readStoredGuide(doc, newKey).overview, 'fresh');
  assert.deepEqual(readStoredGuide(doc, oldKey), GUIDE);
});

// ── Writing: stored once, read back ──────────────────────────────────────────

test('storeGuide then readGuide round-trips a personalized guide from disk', async () => {
  const model = guideStore();
  const key = profileKey(PROFILE_A);

  await storeGuide({ nameKey: 'creatine', supplementName: 'Creatine', detail: GUIDE, profileKey: key }, { model });

  // A cleared memory cache: the guide must come off the DISK, or a server restart
  // would put the reader straight back on the pay-per-tap path.
  cache.clear();
  assert.deepEqual(await readGuide({ nameKey: 'creatine', profileKey: key }, { model }), GUIDE);
});

test('storeGuide writes the generic guide to its own field, leaving variants intact', async () => {
  const model = guideStore();
  const key = profileKey(PROFILE_A);

  await storeGuide({ nameKey: 'creatine', supplementName: 'Creatine', detail: GUIDE, profileKey: key }, { model });
  await storeGuide(
    { nameKey: 'creatine', supplementName: 'Creatine', detail: { ...GUIDE, overview: 'generic' }, profileKey: null },
    { model },
  );

  const doc = await model.findOne({ nameKey: 'creatine' }).lean();
  assert.equal(doc.detail.overview, 'generic');
  assert.deepEqual(Object.keys(doc.variants), [key], 'writing the generic guide must not disturb a variant');
  assert.equal(readStoredGuide(doc, key).overview, GUIDE.overview);
});

test('storing the same profile twice replaces it rather than duplicating it', async () => {
  const model = guideStore();
  const key = profileKey(PROFILE_A);

  await storeGuide({ nameKey: 'creatine', supplementName: 'Creatine', detail: GUIDE, profileKey: key }, { model });
  await storeGuide(
    { nameKey: 'creatine', supplementName: 'Creatine', detail: { ...GUIDE, overview: 'v2' }, profileKey: key },
    { model },
  );

  const doc = await model.findOne({ nameKey: 'creatine' }).lean();
  assert.deepEqual(Object.keys(doc.variants), [key], 'a rewrite must not leave a second copy behind');
  assert.equal(readStoredGuide(doc, key).overview, 'v2');
});

// ── Bounding: the document cannot grow forever ───────────────────────────────

test('the variant map stays within its cap, evicting the oldest first', async () => {
  const model = guideStore();
  const keys = [];
  // MAX_VARIANTS + 6 writes, so the cap is definitely crossed.
  for (let i = 0; i < MAX_VARIANTS + 6; i += 1) {
    const key = profileKey(`Patient: ${i}-year-old male`);
    keys.push(key);
    await storeGuide(
      { nameKey: 'creatine', supplementName: 'Creatine', detail: { ...GUIDE, overview: `v${i}` }, profileKey: key },
      { model },
    );
  }

  const doc = await model.findOne({ nameKey: 'creatine' }).lean();
  const present = Object.keys(doc.variants);
  assert.equal(present.length, MAX_VARIANTS, 'an unbounded map is a 502 waiting for a popular supplement');

  // The newest survives; the oldest is the one that goes.
  assert.ok(present.includes(keys[keys.length - 1]), 'the guide just written must survive its own write');
  assert.ok(!present.includes(keys[0]), 'the least recently written must be the one evicted');
  assert.ok(!present.includes(keys[2]));
});

test('an expired variant is evicted ahead of a live one', async () => {
  const model = guideStore();
  const staleKey = profileKey(PROFILE_A);
  const liveKey = profileKey(PROFILE_B);

  // One entry already past the TTL, exactly as time passing would leave it, then
  // enough live entries to fill the cap so the next write has to evict something.
  const staleAt = Date.now() - GUIDE_TTL_MS - 60_000;
  const variants = { [staleKey]: { detail: GUIDE, updatedAt: new Date(staleAt) } };
  for (let i = 0; i < MAX_VARIANTS - 1; i += 1) {
    variants[profileKey(`Filler ${i}`)] = {
      detail: GUIDE,
      updatedAt: new Date(staleAt + (i + 1) * 1000),
    };
  }
  model.docs.set('creatine', { nameKey: 'creatine', name: 'Creatine', detail: null, variants });

  await storeGuide({ nameKey: 'creatine', supplementName: 'Creatine', detail: GUIDE, profileKey: liveKey }, { model });

  const doc = await model.findOne({ nameKey: 'creatine' }).lean();
  const present = Object.keys(doc.variants);
  assert.ok(!present.includes(staleKey), 'an entry a reader would never be shown is dead weight');
  assert.ok(present.includes(liveKey));
});

test('evicting a variant also drops its memory copy', async () => {
  const model = guideStore();
  const keys = [];
  for (let i = 0; i < MAX_VARIANTS + 4; i += 1) {
    const key = profileKey(`Patient: ${i}-year-old male`);
    keys.push(key);
    await storeGuide(
      { nameKey: 'creatine', supplementName: 'Creatine', detail: GUIDE, profileKey: key },
      { model, cache },
    );
    cache.set(memoryKey('creatine', key), GUIDE);
  }

  // keys[0] was evicted on the last write; its memory entry must be gone too, or
  // the process keeps serving a guide the database can no longer reproduce after
  // a restart.
  assert.equal(cache.get(memoryKey('creatine', keys[0])), null);
  assert.ok(cache.get(memoryKey('creatine', keys[keys.length - 1])), 'the live entry stays warm');
});

// ── Resilience: storage is never load-bearing ───────────────────────────────

test('readGuide returns null when the database is unreachable, rather than throwing', async () => {
  const model = {
    findOne() {
      return {
        select() { return this; },
        lean: async () => { throw new Error('connection timed out'); },
        then: (onOk, onErr) => Promise.reject(new Error('connection timed out')).then(onOk, onErr),
      };
    },
  };
  assert.equal(await readGuide({ nameKey: 'creatine', profileKey: null }, { model }), null);
});

test('a storage write failure is reported to the caller, not swallowed', async () => {
  const model = {
    findOne() {
      const query = {
        select: () => query,
        lean: async () => null,
        then: (onOk, onErr) => Promise.resolve(null).then(onOk, onErr),
      };
      return query;
    },
    updateOne() {
      return { exec: async () => { throw new Error('document too large'); } };
    },
  };
  await assert.rejects(
    () => storeGuide({ nameKey: 'creatine', supplementName: 'Creatine', detail: GUIDE, profileKey: null }, { model }),
    /document too large/,
  );
});

// ── The budget: it must outlast a real generation ────────────────────────────

test('the generation budget sits above the measured tail and below the server ceiling', () => {
  // Measured against the real prompt over many runs, latency ran 8 s to 50 s with
  // the median near 30 s, and the variable is the upstream provider rather than
  // the prompt. The old budget was 20 s, so a healthy provider was reported as
  // "timed out" often enough that the panel read as broken; 45 s still lost the
  // tail. The floor here is the worst latency actually observed.
  assert.ok(
    GENERATION_TIMEOUT_MS > 50_000,
    `budget of ${GENERATION_TIMEOUT_MS} ms is inside the tail; a healthy provider will be reported as timing out`,
  );

  // …and it must leave the server room to actually SEND the response. Read from
  // index.js rather than restated here, because this is the exact pair of numbers
  // that failed: a budget above the server's own requestTimeout means the socket
  // is dropped mid-generation and the browser sees a network error, not a timeout.
  const source = readFileSync(require.resolve('../index.js'), 'utf8');
  const match = /server\.requestTimeout\s*=\s*(\d+)\s*\*\s*(\d+)/.exec(source);
  assert.ok(match, 'could not read server.requestTimeout out of index.js — the guard below would pass silently');
  const serverCeilingMs = Number(match[1]) * Number(match[2]);

  assert.ok(
    GENERATION_TIMEOUT_MS < serverCeilingMs,
    `generation budget ${GENERATION_TIMEOUT_MS} ms exceeds the server's ${serverCeilingMs} ms requestTimeout`,
  );
  // With real headroom, not a hair's breadth: the route still has to format and
  // write the response after the abort.
  assert.ok(
    serverCeilingMs - GENERATION_TIMEOUT_MS >= 10_000,
    `only ${serverCeilingMs - GENERATION_TIMEOUT_MS} ms of headroom between the budget and the server ceiling`,
  );
});

// ── The route: one generation, then free ────────────────────────────────────

/**
 * Mount the real router with `protect` neutered and the provider stubbed, so the
 * assertions are about the ROUTE'S behaviour — how many times it reaches for the
 * provider, and which reader it serves — rather than about storage in isolation.
 *
 * `generationMs` is the provider's latency. It exists so the concurrency tests
 * are deterministic rather than lucky: three HTTP requests arriving in the same
 * millisecond must reliably overlap, and a provider that answered inside a
 * microtask would let the first generation finish before the second request had
 * even read the cache.
 */
async function withRoute(run, { generationMs = 40 } = {}) {
  // The real fetch has to be captured BEFORE the provider stub replaces it, or
  // the calls to the test server itself would be answered by the fake provider.
  const realFetch = NODE_FETCH;

  const authPath = require.resolve('../middleware/auth');
  require(authPath);
  const realProtect = require(authPath).protect;
  require.cache[authPath].exports.protect = (req, res, next) => {
    req.user = { _id: 'u1', email: 'reader@example.test' };
    next();
  };

  // The store requires the real model at CALL time, so it is swapped in the
  // module cache rather than injected.
  const modelPath = require.resolve('../models/SupplementDetail');
  require(modelPath);
  const realModel = require(modelPath);
  const model = guideStore();
  require.cache[modelPath].exports = { ...realModel, ...model };

  const calls = [];
  const stubProvider = (handler) => {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      return handler(url, options);
    };
  };
  stubProvider(async () => {
    const content = JSON.stringify({ ...GUIDE, overview: `generated ${calls.length}` });
    return {
      status: 200, ok: true, headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
      json: async () => ({ choices: [{ message: { content } }] }),
    };
  });

  process.env.OPENROUTER_API_KEY = 'sk-or-test';

  const routePath = require.resolve('../routes/supplement_detail');
  delete require.cache[routePath];
  const app = express();
  app.use(express.json());
  app.use('/api/supplement-detail', require(routePath));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const post = async (body) => {
    const res = await realFetch(`${base}/api/supplement-detail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const ctx = {
    post,
    calls,
    model,
    setProvider(handler) { stubProvider(handler); },
  };

  if (generationMs > 0) {
    // Wrapped rather than baked into the default handler so `setProvider` still
    // controls the RESPONSE and this only controls the LATENCY.
    const fastFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      await new Promise((resolve) => setTimeout(resolve, generationMs));
      return fastFetch(url, options);
    };
  }

  try {
    return await run(ctx);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    require.cache[authPath].exports.protect = realProtect;
    require.cache[modelPath].exports = realModel;
    delete require.cache[routePath];
    delete process.env.OPENROUTER_API_KEY;
    globalThis.fetch = NODE_FETCH;
    cache.clear();
  }
}

const CTX_A = { age: 28, gender: 'male', symptoms: ['low energy'], goals: ['build muscle'] };
const CTX_B = { age: 61, gender: 'female', conditions: ['type 2 diabetes'] };

test('the route generates once and serves every later tap from storage', () => withRoute(async ({ post, calls, model }) => {
  const first = await post({ supplementName: 'Creatine Monohydrate', context: CTX_A });
  assert.equal(first.status, 200);
  assert.ok(first.body.overview, 'a stored guide must still read as a guide');
  assert.notEqual(first.body.cached, true, 'the first tap is the one that costs tokens');

  cache.clear(); // the request after a restart: disk, not memory
  const second = await post({ supplementName: 'Creatine Monohydrate', context: CTX_A });
  assert.equal(second.status, 200);
  assert.equal(second.body.cached, true);
  assert.equal(calls.length, 1, 'a second tap must not spend a second generation');
  assert.equal(second.body.overview, first.body.overview);

  // The generic guide is stored on the same document, and the personalized write
  // did not invent one.
  const doc = await model.findOne({ nameKey: 'creatine monohydrate' }).lean();
  assert.equal(Object.keys(doc.variants).length, 1);
  assert.equal(doc.detail, null);
}));

test('the route never serves one reader a guide written for another', () => withRoute(async ({ post, calls }) => {
  const a = await post({ supplementName: 'Magnesium Glycinate', context: CTX_A });
  const b = await post({ supplementName: 'Magnesium Glycinate', context: CTX_B });

  assert.equal(calls.length, 2, 'two different readers are two different generations');
  assert.equal(a.body.overview, 'generated 1');
  assert.equal(b.body.overview, 'generated 2');

  cache.clear();
  const aAgain = await post({ supplementName: 'Magnesium Glycinate', context: CTX_A });
  assert.equal(aAgain.body.cached, true);
  assert.equal(aAgain.body.overview, 'generated 1', "reader A must not be shown reader B's guide");
}));

test('concurrent taps by the same reader cost exactly one generation', () => withRoute(async ({ post, calls }) => {
  // Fired together, so all three miss storage before any of them has written —
  // the exact race the re-read inside the deduplicated call exists for.
  const results = await Promise.all([
    post({ supplementName: 'Omega-3', context: CTX_A }),
    post({ supplementName: 'Omega-3', context: CTX_A }),
    post({ supplementName: 'Omega-3', context: CTX_A }),
  ]);
  assert.equal(calls.length, 1, 'three simultaneous taps must not pay three times');
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.body.overview, 'generated 1');
  }
}));

test('concurrent taps by DIFFERENT readers each get their own guide', () => withRoute(async ({ post, calls }) => {
  const [a, b] = await Promise.all([
    post({ supplementName: 'Omega-3', context: CTX_A }),
    post({ supplementName: 'Omega-3', context: CTX_B }),
  ]);
  assert.equal(calls.length, 2);
  assert.notEqual(a.body.overview, b.body.overview,
    'deduplication must not collapse two readers onto one guide');
}));

test('an unpersonalized request stores the generic guide and reuses it', () => withRoute(async ({ post, calls, model }) => {
  const first = await post({ supplementName: 'Vitamin D3' });
  assert.equal(first.status, 200);

  cache.clear();
  const second = await post({ supplementName: 'Vitamin D3' });
  assert.equal(second.body.cached, true);
  assert.equal(calls.length, 1);

  const doc = await model.findOne({ nameKey: 'vitamin d3' }).lean();
  assert.ok(doc.detail, 'the generic guide belongs in its own field');
  assert.deepEqual(Object.keys(doc.variants), []);
}));

test('a provider failure answers 502 with a retryable message, not a stack trace', () => withRoute(async ({ post, setProvider }) => {
  setProvider(async () => ({ status: 500, ok: false, headers: { get: () => '' }, text: async () => 'upstream exploded' }));
  const res = await post({ supplementName: 'Creatine Monohydrate', context: CTX_A });
  assert.equal(res.status, 502);
  assert.equal(res.body.retryable, true);
  assert.ok(res.body.message && !/Error:| at /.test(res.body.message),
    'the reader gets a sentence, not a stack trace');
}));

test('a provider that ran out of time says so, not "AI service error"', () =>
  withRoute(async ({ post, setProvider }) => {
    // The router never throws, so a timeout reaches the route as a message
    // rather than an AbortError. Reporting it under the catch-all told the
    // reader the service was broken when the truth was "that took too long" —
    // advice they can act on, and advice they cannot, are not the same thing.
    setProvider(async (_url, options) => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw Object.assign(err, { seen: Boolean(options.signal) });
    });

    const res = await post({ supplementName: 'Creatine Monohydrate', context: CTX_A });
    assert.equal(res.status, 502);
    assert.equal(res.body.retryable, true);
    assert.match(res.body.message, /timed out/i);
    assert.ok(!/AI service error/i.test(res.body.message),
      'a slow provider must not be reported as a broken service');
  }));

test('a bad supplement name is refused before anything is stored or generated', () => withRoute(async ({ post, calls, model }) => {
  const res = await post({ supplementName: '', context: CTX_A });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
  assert.equal(model.docs.size, 0);
}));

test('a slow provider is waited out, not reported as a failure', () => withRoute(async ({ post, setProvider }) => {
  setProvider(async () => ({
    status: 200, ok: true, headers: { get: () => 'application/json' },
    text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(GUIDE) } }] }),
    json: async () => ({ choices: [{ message: { content: JSON.stringify(GUIDE) } }] }),
  }));
  const res = await post({ supplementName: 'Creatine Monohydrate', context: CTX_A });
  assert.equal(res.status, 200);
  assert.ok(res.body.overview);
}, { generationMs: 300 }));