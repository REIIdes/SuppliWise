/**
 * Health pledges, the leaderboard and the storage vault — the rules the routes
 * are built on, plus the wiring checks that a missing piece would otherwise
 * break silently (an unmounted router is a 404, a param route registered
 * before its literal sibling swallows it, an unchecked `anchor()` result is a
 * fake receipt).
 *
 * No database: these are the pure helpers from blockchain/rules.js and source
 * scans of the routers that use them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { sanitizePledge, maskName, PLEDGE_MIN, PLEDGE_MAX } = require('../blockchain/rules');
const { DEFAULT_PARAMS } = require('../models/Web3');

const ROUTES = path.join(__dirname, '..', 'routes', 'web3');
/** Route source with line comments removed, so a comment cannot satisfy a check. */
function code(...parts) {
  return fs.readFileSync(path.join(ROUTES, ...parts), 'utf8')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('a pledge is normalised instead of rejected for ordinary typing', () => {
  const r = sanitizePledge('  I   will take\nmy vitamin D  every morning\t');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'I will take my vitamin D every morning');
});

test('a pledge cannot smuggle control or zero-width characters', () => {
  const r = sanitizePledge('run\u0000daily\u200bwalk\ufeff');
  assert.equal(r.ok, true);
  assert.doesNotMatch(r.text, /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/);
  // The stored text is what the wall renders, so a raw escape sequence there
  // would be a stored-XSS / terminal-escape vector. They are replaced by a
  // space, then collapsed, so the words survive but the escape does not.
  assert.equal(r.text, 'run daily walk');
});

test('a pledge has to say something, and has to fit the card', () => {
  assert.equal(sanitizePledge('').ok, false);
  assert.equal(sanitizePledge('ab').ok, false, `${PLEDGE_MIN} characters is the floor`);
  assert.equal(sanitizePledge('   ').ok, false, 'whitespace is not a pledge');
  assert.equal(sanitizePledge('x'.repeat(PLEDGE_MAX)).ok, true);
  assert.equal(sanitizePledge('x'.repeat(PLEDGE_MAX + 1)).ok, false);
});

test('the pledge reward is a real governed parameter', () => {
  assert.equal(typeof DEFAULT_PARAMS.pledgeReward, 'number');
  assert.ok(DEFAULT_PARAMS.pledgeReward > 0);
});

test('wall names are masked to first name plus initial', () => {
  assert.equal(maskName({ firstName: 'Juan', lastName: 'delo cruz' }), 'Juan D.');
  assert.equal(maskName({ firstName: 'Juan' }), 'Juan');
  assert.equal(maskName({ name: 'Amara Okafor' }), 'Amara');
  // An empty identity still renders something, rather than "undefined".
  assert.equal(maskName({}), 'Member');
});

test('the pledge router is mounted and gated like every other sub-router', () => {
  const index = code('index.js');
  assert.match(index, /require\('\.\/pledge'\)/, 'pledge.js must be required by index.js');
  assert.match(index, /router\.use\('\/', pledgeRouter\)/, 'and mounted');

  const src = code('pledge.js');
  assert.match(src, /router\.use\(userOnly, requireFeature\('web3'\)\)/);
  assert.match(src, /router\.get\('\/pledges'/);
  assert.match(src, /router\.post\('\/pledges'/);
});

test('a pledge never reports a block that the ledger did not write', () => {
  const src = code('pledge.js');
  // engine.anchor() never throws and answers `anchored: false` with an empty
  // tx list. Writing txs[0] regardless is what produced "anchored at block -1".
  assert.match(src, /if \(chain\.anchored\) \{[\s\S]*?\$set: \{ txHash: chain\.txs\[0\]/,
    'the receipt write must be inside an anchored check');
  assert.match(src, /anchored: !!chain\.anchored/, 'and the response must tell the truth about it');
  // The lazy repair path has the same obligation.
  assert.match(src, /if \(!chain\.anchored\) return/, 'reAnchorPending must bail without a block');
});

test('the leaderboard masks identities and counts the caller outside the top 20', () => {
  const src = code('rewards.js');
  assert.match(src, /router\.get\('\/rewards\/leaderboard'/);
  assert.match(src, /name: maskName\(/, 'no full names on a public ranking');
  assert.match(src, /\$limit: 20/, 'a bounded list');
  // Rank must come from the same grouped totals as the visible list.
  assert.match(src, /const \[top, all\] = await Promise\.all\(/);
  assert.match(src, /rank: mineRow \? better \+ 1 : null/);
});

test('the reward status carries the streak calendar and unpaid assessments', () => {
  const src = code('rewards.js');
  assert.match(src, /checkinHistory: stats\.checkinRows\.map\(\(r\) => r\.day\)/,
    'the heatmap needs the day keys, not only a count');
  assert.match(src, /claimableAssessments,/);
  // Claimable must mean "this POST will pay", so the filter has to mirror the
  // claim guard: owned + has aiResults.
  assert.match(src, /aiResults: \{ \$ne: null \}/);
});

test('the storage vault lists objects before the content-id route can eat them', () => {
  const src = code('data.js');
  const list = src.indexOf("router.get('/storage'");
  const byCid = src.indexOf("router.get('/storage/:cid'");
  assert.ok(list > -1 && byCid > -1, 'both routes must exist');
  assert.ok(list < byCid, 'GET /storage must be registered before GET /storage/:cid');
});

test('a pin anchors its CID on-chain and only claims a receipt it has', () => {
  const src = code('data.js');
  const pin = src.slice(src.indexOf("router.post('/storage/pin'"), src.indexOf("router.get('/storage'"));
  assert.match(pin, /engine\.anchor\('storage:pin'/);
  assert.match(pin, /if \(chain\.anchored\)/);
  assert.match(pin, /txHash: '', anchored: false/, 'an unanchored pin says so');
  const backup = src.slice(src.indexOf("router.post('/health/backup'"));
  assert.match(backup.slice(0, 2600), /const txHash = chain\.anchored \? chain\.txs\[0\] \|\| '' : ''/);
});
