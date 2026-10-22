/**
 * POST /api/chat/feedback: who may rate what, and what a rating is allowed to change.
 *
 * Run: node --test "Test File/chat-feedback-route.test.js"
 *
 * WHY THIS FILE EXISTS
 * This endpoint is the only place where a member's opinion is allowed to influence
 * what every later member sees, because the priors are built from these rows. So two
 * properties are the contract: it must not be possible to rate somebody else's
 * conversation, and it must not be possible to tell the server which documents to
 * promote. Both are asserted against the running route rather than by reading it,
 * because the second one is exactly the kind of thing a future "advanced" client
 * would add as a convenience if a test did not object.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');

const AiChatThread = require('../models/AiChatThread');
const AiChatFeedback = require('../models/AiChatFeedback');
const authMiddleware = require('../middleware/auth');
const entitlements = require('../utils/entitlements');
const { invalidatePriors } = require('../utils/chatLearning');

const USER_ID = '507f1f77bcf86cd799439011';
const OTHER_USER = '507f1f77bcf86cd7994390aa';
const THREAD_ID = '507f1f77bcf86cd7994390bb';

const OWNED_THREAD = {
  _id: THREAD_ID,
  user: USER_ID,
  messages: [
    { role: 'user', text: 'how much magnesium' },
    { role: 'assistant', text: 'This app uses 300-400mg daily.' },
  ],
  turns: [{ i: 1, docs: ['dose:Magnesium', 'nutrient:Magnesium'], repairs: ['statistic-removed'], provider: 'openrouter', clean: false }],
};

/**
 * Boot routes/chat.js against stand-ins.
 *
 * @param {{thread: object|null, onFeedback?: (update: object) => void, onFilter?: (filter: object) => void}} setup
 * @param {(ctx: {post: (body: object) => Promise<Response>}) => Promise<void>} fn
 */
async function withFeedbackRoute(setup, fn) {
  const originals = {
    findOneThread: AiChatThread.findOne,
    findOneAndUpdate: AiChatFeedback.findOneAndUpdate,
    find: AiChatFeedback.find,
    countDocuments: AiChatFeedback.countDocuments,
    protect: authMiddleware.protect,
    requireFeature: entitlements.requireFeature,
  };

  AiChatThread.findOne = (filter) => {
    if (setup.onFilter) setup.onFilter(filter);
    return {
      select() { return this; },
      lean: () => Promise.resolve(setup.thread),
    };
  };
  AiChatFeedback.findOneAndUpdate = (filter, update) => {
    if (setup.onFeedback) setup.onFeedback({ filter, update });
    return Promise.resolve({});
  };
  // Nothing here should be reaching the database for priors; stub it so a
  // forgotten cache invalidation cannot make this suite depend on a live Mongo.
  AiChatFeedback.find = () => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }) }) });
  AiChatFeedback.countDocuments = () => Promise.resolve(0);

  authMiddleware.protect = (req, _res, next) => {
    req.user = { _id: filterUserId(setup), plan: 'Ultimate', role: 'user' };
    next();
  };
  entitlements.requireFeature = () => (_req, _res, next) => next();

  function filterUserId(s) { return s.userId || USER_ID; }

  delete require.cache[require.resolve('../routes/chat')];
  const app = express();
  app.use(express.json());
  app.use('/api/chat', require('../routes/chat'));
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/chat`;

  try {
    await fn({
      post: (body) => fetch(`${base}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } finally {
    server.close();
    Object.assign(AiChatThread, { findOne: originals.findOneThread });
    Object.assign(AiChatFeedback, {
      findOneAndUpdate: originals.findOneAndUpdate,
      find: originals.find,
      countDocuments: originals.countDocuments,
    });
    authMiddleware.protect = originals.protect;
    entitlements.requireFeature = originals.requireFeature;
    delete require.cache[require.resolve('../routes/chat')];
    invalidatePriors();
  }
}

const valid = { threadId: THREAD_ID, messageIndex: 1, vote: 'up' };

test('a helpful rating is stored against the notes that produced that reply', async () => {
  let seen = null;
  await withFeedbackRoute({ thread: OWNED_THREAD, onFeedback: (u) => { seen = u; } }, async ({ post }) => {
    const res = await post(valid);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.docs, 2, 'the reply was grounded on two notes, and that is what the vote is about');
  });

  assert.equal(String(seen.filter.user), USER_ID);
  assert.equal(String(seen.filter.thread), THREAD_ID);
  assert.equal(seen.filter.messageIndex, 1);
  assert.equal(seen.update.$set.vote, 'up');
  assert.deepEqual(seen.update.$set.docIds, ['dose:Magnesium', 'nutrient:Magnesium']);
  assert.deepEqual(seen.update.$set.repairs, ['statistic-removed']);
  assert.equal(seen.update.$set.provider, 'openrouter');
  assert.equal(seen.update.$set.wasRepaired, true);
});

test('the client cannot name documents to promote — they are read off the turn record', async () => {
  let seen = null;
  await withFeedbackRoute({ thread: OWNED_THREAD, onFeedback: (u) => { seen = u; } }, async ({ post }) => {
    const res = await post({
      ...valid,
      docIds: ['nutrient:Iron', 'nutrient:Ashwagandha'],
      votes: 99,
      user: OTHER_USER,
    });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(seen.update.$set.docIds, ['dose:Magnesium', 'nutrient:Magnesium'], 'injected docIds must be ignored');
  assert.equal(String(seen.filter.user), USER_ID, 'the session decides whose rating this is');
  assert.equal(seen.update.$set.votes, undefined);
});

test('a vote aimed at another member conversation is not found', async () => {
  let filter = null;
  await withFeedbackRoute({
    thread: null,
    onFilter: (f) => { filter = f; },
  }, async ({ post }) => {
    const res = await post(valid);
    assert.equal(res.status, 404);
  });
  // Ownership is a query constraint, not a check after the fact.
  assert.equal(String(filter.user), USER_ID);
  assert.equal(String(filter._id), THREAD_ID);
});

test('a user message, an out-of-range index and a non-answer are all refused', async () => {
  await withFeedbackRoute({ thread: OWNED_THREAD }, async ({ post }) => {
    assert.equal((await post({ ...valid, messageIndex: 0 })).status, 400);
    assert.equal((await post({ ...valid, messageIndex: 99 })).status, 400);
    assert.equal((await post({ ...valid, messageIndex: '1' })).status, 400);
    assert.equal((await post({ ...valid, messageIndex: 1.5 })).status, 400);
    assert.equal((await post({ ...valid, vote: 'sideways' })).status, 400);
    assert.equal((await post({ ...valid, threadId: 'not-an-id' })).status, 400);
    assert.equal((await post({ ...valid, threadId: { $ne: null } })).status, 400);
    assert.equal((await post({ ...valid, threadId: ['a', 'b'] })).status, 400);
  });
});

test('changing a rating updates the same row instead of adding a second opinion', async () => {
  const calls = [];
  await withFeedbackRoute({ thread: OWNED_THREAD, onFeedback: (u) => calls.push(u) }, async ({ post }) => {
    assert.equal((await post({ ...valid, vote: 'up' })).status, 200);
    assert.equal((await post({ ...valid, vote: 'down' })).status, 200);
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(Object.keys(call.filter).sort(), ['messageIndex', 'thread', 'user']);
    assert.equal(call.update.$setOnInsert.messageIndex, 1);
  }
  assert.equal(calls[1].update.$set.vote, 'down');
});

test('a reply generated before turn records existed still accepts a vote', async () => {
  let seen = null;
  const legacy = { _id: THREAD_ID, user: USER_ID, messages: [{ role: 'assistant', text: 'older reply' }], turns: [] };
  await withFeedbackRoute({ thread: legacy, onFeedback: (u) => { seen = u; } }, async ({ post }) => {
    assert.equal((await post({ ...valid, messageIndex: 0 })).status, 200);
  });
  assert.deepEqual(seen.update.$set.docIds, [], 'no turn record means no notes claimed, not a guess');
  assert.equal(seen.update.$set.wasRepaired, false);
});

test('the learned ranking reaches retrieval as a map, not as the promise that makes it', async () => {
  // `priors: priorsForRetrieval()` used to sit in the chat route. A Promise is not a
  // Map and has no own enumerable keys, so `retrieve` fell through to an empty prior
  // set: every vote in the database, every published weight, applied to nothing — and
  // the assistant still answered, so nothing anywhere reported it.
  const { retrieve } = require('../utils/ragRetriever');
  const src = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../routes/chat.js'), 'utf8');
  assert.match(src, /priors: mergePriors\(await priorsForRetrieval\(\), memory\)/,
    'the route must await the map — and merge the member\'s own votes over it, not instead of it');

  const q = 'can magnesium help with sleep';
  const base = retrieve(q);
  const learnable = base.candidates[1].id;
  const scoreOf = (r, k) => r.candidates.find((c) => c.id === k).score;
  assert.ok(scoreOf(retrieve(q, { priors: new Map([[learnable, 0.6]]) }), learnable) > scoreOf(base, learnable),
    'a published prior raises the note it points at');
  assert.equal(scoreOf(retrieve(q, { priors: Promise.resolve(new Map([[learnable, 0.6]])) }), learnable), scoreOf(base, learnable),
    'and handing over the un-awaited promise changes nothing at all');
});
