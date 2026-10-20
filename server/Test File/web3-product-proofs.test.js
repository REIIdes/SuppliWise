/**
 * Product-event chain proofs (blockchain/proofs.js).
 *
 * The blockchain stopped being a set of opt-in demos when the assessment
 * routes began anchoring automatically: every saved assessment and every saved
 * plan now writes a ledger entry, from code the member never sees. That makes
 * this the highest-leverage place in the chain layer to be wrong, and until now
 * it had no tests at all — `web3.test.js` covers the ledger itself and
 * `web3-plan-gate.test.js` covers the DELUXE gate; neither touches these.
 *
 * Four claims, each with a case below:
 *
 *  1. The commitment is deterministic and covers inputs, outputs AND the engine
 *     version. The anchor button and the automatic save must agree byte for
 *     byte, or a plan anchored by the product fails its own verification.
 *  2. `web3Enabled` fails closed: no chain work for a free account, for an
 *     admin, or for a missing user.
 *  3. A refused append is never reported as a proof. This is the exact bug the
 *     health ledger shipped with: an anchor row saying "proven at block -1", a
 *     paid reward for a block that does not exist, and a receipt the member
 *     could never verify.
 *  4. Anchoring cannot throw into the caller. A member must always be able to
 *     save their assessment, with or without a chain.
 *
 * No database and no network: the model queries and `engine.anchor` are stubbed,
 * so the assertions are about the decisions this module makes, not about Mongo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

// Nothing here should ever wait on a connection that is not coming.
mongoose.set('bufferTimeoutMS', 250);

const engine = require('../blockchain/engine');
const Assessment = require('../models/Assessment');
const IntakeRecord = require('../models/IntakeRecord');
const { HealthAnchor, RecAnchor } = require('../models/Web3');
const proofs = require('../blockchain/proofs');

const {
  jsonSafe,
  recommendationCommitment,
  web3Enabled,
  anchorHealthLedger,
  anchorRecommendation,
  RECOMMENDER_LOGIC_VERSION,
} = proofs;

const USER = { _id: '507f1f77bcf86cd799439011', role: 'user' };
const WALLET = { _id: '507f1f77bcf86cd799439022', address: 'sw1abc', did: 'did:suppliwise:x' };
const ASSESSMENT_ID = new mongoose.Types.ObjectId('507f1f77bcf86cd799439033');

/** A lean()-style thenable query: `.select().sort().lean()` all return itself. */
function chainable(result) {
  const q = {
    select: () => q,
    sort: () => q,
    lean: async () => result,
  };
  return q;
}

// Patched by label, not by target+key: mongoose names every model constructor
// `Model`, so two different models would otherwise share a snapshot slot and the
// first original would be restored over the second.
const originals = new Map();
function patch(label, target, key, value) {
  if (!originals.has(label)) originals.set(label, { target, key, value: target[key] });
  target[key] = value;
}

test.afterEach(() => {
  for (const spec of originals.values()) spec.target[spec.key] = spec.value;
  originals.clear();
});

function fixtureAssessment(overrides = {}) {
  return {
    _id: ASSESSMENT_ID,
    user: USER._id,
    age: 34,
    gender: 'female',
    createdAt: new Date('2026-03-04T05:06:07.000Z'),
    updatedAt: new Date('2026-03-04T05:06:07.000Z'),
    __v: 0,
    aiResults: { supplements: [{ name: 'Vitamin D3', dose: '2000 IU' }] },
    ...overrides,
  };
}

// ── 1. The commitment ──────────────────────────────────────────────────────
test('the same record commits to the same hash every time', () => {
  const a = recommendationCommitment(fixtureAssessment());
  const b = recommendationCommitment(fixtureAssessment());
  assert.equal(a.combinedHash, b.combinedHash);
  assert.equal(a.logicVersion, RECOMMENDER_LOGIC_VERSION);
});

test('the commitment covers the inputs, the AI output and the engine version', () => {
  const base = recommendationCommitment(fixtureAssessment());
  assert.notEqual(
    recommendationCommitment(fixtureAssessment({ age: 55 })).combinedHash,
    base.combinedHash,
    'a changed answer must not commit to the same hash'
  );
  assert.notEqual(
    recommendationCommitment(fixtureAssessment({
      aiResults: { supplements: [{ name: 'Magnesium', dose: '400 mg' }] },
    })).combinedHash,
    base.combinedHash,
    'a different plan must not commit to the same hash'
  );
  assert.notEqual(
    recommendationCommitment(fixtureAssessment(), 'suppliwise-rec-engine@2').combinedHash,
    base.combinedHash,
    'a different engine version must not commit to the same hash'
  );
  // The two halves are kept apart so each can be verified on its own.
  assert.notEqual(base.inputHash, base.outputHash);
});

test('jsonSafe makes a re-read of the same document hash identically', () => {
  // The anchor is taken from a lean read and verified from another one much
  // later, so Dates must become ISO and ObjectIds hex at any depth — otherwise
  // an untouched plan fails its own check because the driver handed back a
  // different JavaScript type.
  const asLean = fixtureAssessment();
  const asPlain = {
    _id: ASSESSMENT_ID.toHexString(),
    user: USER._id,
    age: 34,
    gender: 'female',
    createdAt: '2026-03-04T05:06:07.000Z',
    updatedAt: '2026-03-04T05:06:07.000Z',
    __v: 0,
    aiResults: { supplements: [{ name: 'Vitamin D3', dose: '2000 IU' }] },
  };
  assert.deepEqual(jsonSafe(asLean), jsonSafe(asPlain));
  assert.equal(
    recommendationCommitment(asLean).combinedHash,
    recommendationCommitment(asPlain).combinedHash
  );
  assert.deepEqual(
    jsonSafe([new Date('2026-01-01T00:00:00.000Z'), null, undefined]),
    ['2026-01-01T00:00:00.000Z', null, undefined]
  );
});

// ── 2. Entitlement gate ─────────────────────────────────────────────────────
test('chain work is only paid for by accounts that include it', () => {
  assert.equal(web3Enabled(null), false, 'no user, no anchor');
  assert.equal(
    web3Enabled({ ...USER, subscriptionPlan: 'free', subscriptionActive: true }),
    false,
    'a free account must not mint blocks'
  );
  assert.equal(
    web3Enabled({ ...USER, role: 'admin', subscriptionPlan: 'monthly', subscriptionActive: true }),
    false,
    'admins are excluded from the member chain, the same way the web3 routes exclude them'
  );
  assert.equal(web3Enabled({ ...USER, subscriptionPlan: 'monthly', subscriptionActive: true }), true);
});

// ── 3+4. The append decision ────────────────────────────────────────────────
function stubHealthReads() {
  patch(
    'Assessment.find',
    Assessment,
    'find',
    () => chainable([{ _id: ASSESSMENT_ID, createdAt: new Date('2026-03-04T05:06:07.000Z'), updatedAt: new Date('2026-03-04T05:06:07.000Z'), priority: 'Standard' }])
  );
  patch('IntakeRecord.countDocuments', IntakeRecord, 'countDocuments', async () => 2);
  patch('IntakeRecord.findOne', IntakeRecord, 'findOne', () => chainable({ date: new Date('2026-03-01T00:00:00.000Z') }));
  patch('engine.getWalletDoc.h', engine, 'getWalletDoc', async () => WALLET);
}

test('a refused append stores no anchor row and pays no reward', async () => {
  stubHealthReads();
  patch('engine.anchor.h', engine, 'anchor', async () => ({ index: -1, hash: '', txs: [''], anchored: false, error: 'ledger busy' }));
  const created = [];
  const rewards = [];
  patch('HealthAnchor.create', HealthAnchor, 'create', async (doc) => { created.push(doc); return doc; });
  patch('engine.grantReward.h', engine, 'grantReward', async (spec) => { rewards.push(spec); return { amount: 5, alreadyClaimed: false }; });

  const out = await anchorHealthLedger(USER, { reward: true });
  assert.equal(out.anchored, false);
  assert.equal(out.code, 'append_failed');
  assert.equal(out.error, 'ledger busy');
  assert.deepEqual(created, [], 'no row may claim a block that does not exist');
  assert.deepEqual(rewards, [], 'no reward may be paid for a block that does not exist');
});

test('a successful append records the block it actually landed in', async () => {
  stubHealthReads();
  patch('engine.anchor.ok', engine, 'anchor', async () => ({ index: 77, hash: 'h77', txs: ['tx77'], anchored: true }));
  patch('engine.getConfig', engine, 'getConfig', async () => ({ params: { healthAnchorReward: 5 } }));
  patch('engine.grantReward.ok', engine, 'grantReward', async () => ({ amount: 5, alreadyClaimed: false }));
  const created = [];
  patch('HealthAnchor.create', HealthAnchor, 'create', async (doc) => { created.push(doc); return doc; });

  const out = await anchorHealthLedger(USER, { reward: true });
  assert.equal(out.anchored, true);
  assert.equal(out.blockIndex, 77);
  assert.equal(out.txHash, 'tx77');
  assert.equal(created.length, 1);
  assert.equal(created[0].blockIndex, 77);
  assert.equal(created[0].txHash, 'tx77');
  assert.equal(String(created[0].digest).length, 64, 'the row stores a digest, never the record');
  assert.equal(out.reward, 5);
});

test('an automatic anchor pays nothing — the daily reward stays with the button', async () => {
  stubHealthReads();
  patch('engine.anchor.auto', engine, 'anchor', async () => ({ index: 5, hash: 'h5', txs: ['tx5'], anchored: true }));
  patch('HealthAnchor.create', HealthAnchor, 'create', async (doc) => doc);
  let rewarded = 0;
  patch('engine.grantReward.count', engine, 'grantReward', async () => { rewarded += 1; return { amount: 5, alreadyClaimed: false }; });

  const out = await anchorHealthLedger(USER);
  assert.equal(out.anchored, true);
  assert.equal(rewarded, 0);
  assert.equal(out.reward, undefined);
});

test('an append that throws cannot fail the member’s assessment save', async () => {
  stubHealthReads();
  patch('engine.anchor.throw', engine, 'anchor', async () => { throw new Error('mining exploded'); });
  patch('HealthAnchor.create', HealthAnchor, 'create', async (doc) => doc);
  const out = await anchorHealthLedger(USER);
  assert.equal(out.anchored, false);
  assert.match(out.error, /mining exploded/);
});

test('the anchored health digest carries no record content', async () => {
  stubHealthReads();
  const snapshot = await proofs.buildHealthDigest(USER._id);
  assert.equal(snapshot.digest, (await proofs.buildHealthDigest(USER._id)).digest);
  assert.equal(snapshot.assessmentCount, 1);
  assert.equal(snapshot.intakeCount, 2);
  // Ids, timestamps and counts only. The member's answers stay in the database.
  const text = JSON.stringify(snapshot.payload).toLowerCase();
  assert.ok(!text.includes('female'), 'gender must not reach the chain');
  assert.ok(!text.includes('vitamin'), 'plan text must not reach the chain');
});

// ── The recommendation anchor ───────────────────────────────────────────────
function stubRecReads(assessment) {
  patch('Assessment.findOne', Assessment, 'findOne', () => chainable(assessment));
  patch('engine.getWalletDoc.r', engine, 'getWalletDoc', async () => WALLET);
}

test('a plan with no AI results yet is not anchored', async () => {
  stubRecReads({ ...fixtureAssessment(), aiResults: null });
  patch('RecAnchor.findOneAndUpdate.nores', RecAnchor, 'findOneAndUpdate', async () => {
    throw new Error('must not upsert an unprovable record');
  });
  patch('engine.anchor.nores', engine, 'anchor', async () => ({ index: 1, hash: 'h', txs: ['t'], anchored: true }));
  const out = await anchorRecommendation(USER, ASSESSMENT_ID);
  assert.equal(out.anchored, false);
  assert.equal(out.code, 'no_results');
});

test('an assessment that is not this member’s is not anchored', async () => {
  // findOne filters on `user`, so someone else's id reads as not found.
  patch('Assessment.findOne', Assessment, 'findOne', (filter) => {
    assert.equal(filter.user, USER._id, 'the anchor must stay scoped to the owner');
    return chainable(null);
  });
  patch('engine.getWalletDoc.r', engine, 'getWalletDoc', async () => WALLET);
  const out = await anchorRecommendation(USER, '507f1f77bcf86cd799439099');
  assert.equal(out.anchored, false);
  assert.equal(out.code, 'not_found');
});

test('a refused plan append leaves the anchor row with no block claim', async () => {
  stubRecReads(fixtureAssessment());
  const row = { _id: 'r1', saves: 0, save: async () => { row.saves += 1; } };
  patch('RecAnchor.findOneAndUpdate', RecAnchor, 'findOneAndUpdate', async () => row);
  patch('engine.anchor.fail', engine, 'anchor', async () => ({ index: -1, hash: '', txs: [''], anchored: false, error: 'quota' }));

  const out = await anchorRecommendation(USER, ASSESSMENT_ID);
  assert.equal(out.anchored, false);
  assert.equal(out.code, 'append_failed');
  assert.equal(row.saves, 0, 'the row must not be stamped with a block that does not exist');
  assert.equal(row.blockIndex, undefined);
});

test('an anchored plan stores the commitment the verifier re-derives', async () => {
  const assessment = fixtureAssessment();
  stubRecReads(assessment);
  const expected = recommendationCommitment(assessment);
  const row = { _id: 'r1', saved: false, save: async () => { row.saved = true; } };
  patch('RecAnchor.findOneAndUpdate', RecAnchor, 'findOneAndUpdate', async (filter, update) => {
    // What the row is set to must be this same commitment, or verifying an
    // automatically anchored plan grades it against a different promise.
    assert.equal(filter.user, USER._id);
    assert.equal(update.$set.combinedHash, expected.combinedHash);
    assert.equal(update.$set.inputHash, expected.inputHash);
    assert.equal(update.$set.outputHash, expected.outputHash);
    assert.equal(update.$set.logicVersion, RECOMMENDER_LOGIC_VERSION);
    return row;
  });
  patch('engine.anchor.ok2', engine, 'anchor', async (type, actor, data) => {
    assert.equal(type, 'rec:anchor');
    assert.equal(actor, WALLET.address);
    assert.equal(data.public.combinedHash, expected.combinedHash);
    assert.equal(data.public.assessment, ASSESSMENT_ID.toHexString());
    return { index: 12, hash: 'h12', txs: ['tx12'], anchored: true };
  });

  const out = await anchorRecommendation(USER, ASSESSMENT_ID);
  assert.equal(out.anchored, true);
  assert.equal(out.blockIndex, 12);
  assert.equal(out.txHash, 'tx12');
  assert.equal(out.combinedHash, expected.combinedHash);
  assert.equal(row.blockIndex, 12);
  assert.equal(row.txHash, 'tx12');
  assert.equal(row.saved, true);
});

test('a plan append that throws cannot fail the results save', async () => {
  stubRecReads(fixtureAssessment());
  patch('RecAnchor.findOneAndUpdate', RecAnchor, 'findOneAndUpdate', async () => ({ _id: 'r1', save: async () => {} }));
  patch('engine.anchor.throw2', engine, 'anchor', async () => { throw new Error('disk full'); });
  const out = await anchorRecommendation(USER, ASSESSMENT_ID);
  assert.equal(out.anchored, false);
  assert.match(out.error, /disk full/);
});

// ── The routes that call these ─────────────────────────────────────────────
// The wiring is the other half of the claim: an anchor nobody calls is a
// feature that exists in a file. Asserted against the source because the
// product event and the chain write only ever happen in one request.
test('the assessment routes anchor the events they produce', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'assessment.js'), 'utf8');
  assert.match(src, /anchorHealthLedger\(req\.user\)/, 'saving an assessment anchors the health ledger');
  assert.match(src, /anchorRecommendation\(req\.user, assessment\._id\)/, 'saving AI results anchors the plan');
  assert.match(src, /if \(web3Enabled\(req\.user\)\)/, 'and both only for accounts that include the chain');
  assert.match(src, /chainProof/, 'the receipt travels back to the client');
  assert.match(src, /recommendationProof/, 'so does the plan receipt');
});

test('the manual web3 routes share the one derivation', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'web3', 'data.js'), 'utf8');
  assert.ok(!/function buildHealthDigest/.test(src), 'the digest must not have a second implementation');
  assert.ok(!/RECOMMENDER_LOGIC_VERSION =/.test(src), 'the logic version must not have a second definition');
  assert.match(src, /recommendationCommitment\(assessment, anchorDoc\.logicVersion\)/, 'verification re-derives through the helper');
  assert.match(src, /recommendationCommitment\(assessment, onChain\.logicVersion\)/, 'including against the chain copy');
});
