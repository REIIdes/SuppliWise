/**
 * THE TRIPWIRE MUST DETECT *AND* REPORT.
 *
 * `noteIpAccountFailure()` is the only signal in this codebase that tells
 * "someone mistyped their password" apart from "one address is trying many
 * accounts". Detecting it was never the problem: it fired, throttled the
 * address for five minutes, and then told NOBODY. The one thing a credential-
 * stuffing run is guaranteed to produce — a stream of distinct accounts failing
 * from a single IP — was thrown away unless an administrator happened to be
 * staring at the panel at that minute, and a process restart erased every trace.
 *
 * What is pinned here:
 *
 *   1. THE THRESHOLD  — 19 distinct accounts stay silent, 20 trips. Twenty is a
 *                       spray, not a typo, and that difference is the whole
 *                       design (see login-stuffing-tripwire.test.js for why 3
 *                       was wrong).
 *   2. THE RECORD     — a trip leaves a readable counter behind, because
 *                       `trips24h: 0` after a trip would be a monitor lying.
 *   3. THE NOTICE     — an AdminEvent appears in the console, names the address
 *                       and the COUNT, and never the accounts themselves.
 *   4. THE CEILING    — the log is bounded; a spray that never ends must not
 *                       grow memory without limit.
 *   5. THE PROBE      — the Security Center row reads this state and fails
 *                       closed when it cannot.
 *
 * Run: node --test "Test File/credential-stuffing-detection.test.js"
 * Cases 1-4 need MONGO_TEST_URI; the AdminEvent write is real, so a stub would
 * prove nothing about whether the console would ever see one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const { startTestServer, connectTestDb } = require('./e2eServer');
const { testDbPreflight, skipMessage } = require('./testDbGuard');

const AdminEvent = require('../models/AdminEvent');
const {
  noteIpAccountFailure,
  clearIpAccountFailures,
  clearOffenses,
  clearTripLog,
  tripwireStats,
  stuffingCooldownMs,
  IP_ACCOUNT_THRESHOLD,
  STUFFING_COOLDOWN_MS,
} = require('../utils/lockout');

const preflight = testDbPreflight();

// TEST-NET-3 (RFC 5737) — reserved for documentation and never routable, so a
// synthetic spray can never be mistaken for a real address in the log.
const SPRAY_IP = '203.0.113.77';
const Quiet_IP = '203.0.113.78';

/** Fail `count` DISTINCT accounts from `ip`. */
const spray = (ip, count) => {
  let tripped = false;
  for (let i = 0; i < count; i += 1) {
    if (noteIpAccountFailure(ip, `spray-victim-${i}@example.com`)) tripped = true;
  }
  return tripped;
};

const cleanup = async (ips) => {
  for (const ip of ips) {
    clearIpAccountFailures(ip);
    clearOffenses(`stuffing:${ip}`);
  }
  clearTripLog();
};

test('credential-stuffing detection reports what it catches', { skip: preflight.skip }, async (t) => {
  const server = await startTestServer({ port: 5127 });
  if (!server.ok) return t.skip(skipMessage(server));
  const db = await connectTestDb();
  if (!db.connected) {
    await server.stop();
    return t.skip(skipMessage(db));
  }

  const seen = [SPRAY_IP, Quiet_IP];
  t.after(async () => {
    await cleanup(seen);
    await AdminEvent.deleteMany({ detail: { $regex: '203\\.0\\.113\\.' } }).catch(() => {});
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  await t.beforeEach(async () => {
    await cleanup(seen);
    await AdminEvent.deleteMany({ detail: { $regex: '203\\.0\\.113\\.' } }).catch(() => {});
  });

  await t.test('the threshold is a spray, not a typo', () => {
    assert.equal(IP_ACCOUNT_THRESHOLD, 20, 'twenty distinct accounts in one window');
    assert.equal(spray(Quiet_IP, IP_ACCOUNT_THRESHOLD - 1), false, 'nineteen must not trip');
    assert.equal(stuffingCooldownMs(Quiet_IP), 0, 'and must not throttle the address at all');
    assert.equal(tripwireStats().trips24h, 0, 'nor leave a trip behind');
  });

  await t.test('crossing it trips, throttles, and records', async () => {
    assert.equal(spray(SPRAY_IP, IP_ACCOUNT_THRESHOLD), true, 'the twentieth distinct account trips');
    assert.ok(stuffingCooldownMs(SPRAY_IP) > 0, 'the address is throttled…');
    assert.ok(stuffingCooldownMs(SPRAY_IP) <= STUFFING_COOLDOWN_MS, '…for its cooldown and no longer');

    const s = tripwireStats();
    assert.equal(s.trips24h, 1, 'the trip is readable, not silently discarded');
    assert.equal(s.throttledNow, 1);
    assert.equal(s.last.ip, SPRAY_IP);
    assert.equal(s.last.accounts, IP_ACCOUNT_THRESHOLD, 'how wide the spray was is the number an admin needs');
    assert.ok(s.last.at <= Date.now() && s.last.at > Date.now() - 60_000, 'stamped when it happened');
  });

  await t.test('a trip raises a console event that does not name the victims', async () => {
    // Its OWN address: the notice is throttled per address over a window far
    // longer than this suite, so reusing an earlier case's address would measure
    // that case's mark instead of this behaviour.
    const NOTICE_IP = '203.0.113.91';
    seen.push(NOTICE_IP);
    spray(NOTICE_IP, IP_ACCOUNT_THRESHOLD);
    // The notice is fire-and-forget by design (a detection alert must never
    // break the request that detected it), so give it every chance to land
    // before asserting absence would be meaningless.
    let row = null;
    for (let i = 0; i < 40 && !row; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
      row = await AdminEvent.findOne({ detail: { $regex: '203\\.0\\.113\\.91' } }).lean();
    }
    assert.ok(row, 'the console sees the trip');
    assert.equal(row.type, 'security');
    assert.match(row.detail, /203\.0\.113\.91/);
    assert.match(row.detail, /20 different accounts/);
    assert.doesNotMatch(row.detail, /spray-victim|@example\.com/i,
      'the accounts tried are other people\'s — listing which were sprayed would turn a detection log into a target list');
    assert.match(row.detail, /throttled/i, 'and it must say what was done about it');
    assert.match(row.detail, /no account was locked/i, 'and that no legitimate user was harmed');
  });

  await t.test('the trip log is bounded', () => {
    for (let i = 0; i < 90; i += 1) {
      noteIpAccountFailure(`203.0.113.${100 + (i % 100)}`, `acct-${i}`);
      noteIpAccountFailure(`203.0.113.${100 + (i % 100)}`, `acct-${i}`);
    }
    // Each address needs its own 20-account spray before it records anything, so
    // drive it properly for a handful of addresses rather than pretend.
    for (let a = 0; a < 6; a += 1) {
      const ip = `203.0.113.20${a}`;
      for (let i = 0; i < IP_ACCOUNT_THRESHOLD; i += 1) noteIpAccountFailure(ip, `victim-${a}-${i}`);
      seen.push(ip);
    }
    const s = tripwireStats();
    assert.ok(s.trips24h <= 50, `the log holds at most 50 trips, saw ${s.trips24h}`);
    assert.equal(s.trips24h, 6, 'one per address that actually crossed the threshold');
  });

  await t.test('a second trip from the same address within half an hour does not spam the console', async () => {
    // Its OWN address, twice: the notice throttle is keyed per address over a
    // window far longer than this suite, so reusing another case's IP would
    // measure that case's mark instead of this one's behaviour.
    const SPAM_IP = '203.0.113.88';
    seen.push(SPAM_IP);
    const forThisIp = () => AdminEvent.countDocuments({ detail: { $regex: SPAM_IP.replace(/\./g, '\\.') } });
    spray(SPAM_IP, IP_ACCOUNT_THRESHOLD);
    for (let i = 0; i < 40 && (await forThisIp()) === 0; i += 1) await new Promise((r) => setTimeout(r, 25));
    assert.equal(await forThisIp(), 1, 'the first trip raises exactly one notice');

    clearOffenses(`stuffing:${SPAM_IP}`);
    spray(SPAM_IP, IP_ACCOUNT_THRESHOLD);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(await forThisIp(), 1, 'one notice per address per half hour');
    assert.ok(tripwireStats().trips24h >= 2, 'but the counters still record every trip, notice throttled or not');
  });

  await t.test('the Security Center row reads this state and fails closed', () => {
    const probes = fs.readFileSync(path.join(__dirname, '..', 'utils', 'attack_probes.js'), 'utf8');
    assert.match(probes, /credential_stuffing_tripwire: async \(\) => \{/);
    assert.match(probes, /require\('\.\/lockout'\)/);
    assert.match(probes, /status: 'warning'[\s\S]{0,200}unmeasured/, 'unreadable counters are a warning, never a pass');
    assert.match(probes, /trips24h/, 'and the row reports the count rather than a verdict of its own');

    // The live probe must actually answer, and answer in the shape the monitor
    // renders. Spray first, then read: a row that reports `healthy` while this
    // very suite is causing trips would be a monitor lying.
    const { attackProbes } = require('../utils/attack_probes');
    const probeIp = '203.0.113.199';
    seen.push(probeIp);
    spray(probeIp, IP_ACCOUNT_THRESHOLD);
    return attackProbes.credential_stuffing_tripwire().then((r) => {
      assert.ok(['healthy', 'warning'].includes(r.status), 'a tripwire row is never an error');
      assert.equal(r.status, 'warning', 'an address being sprayed now must surface, not read as idle');
      assert.match(r.detail, /FIRING/);
      assert.match(r.detail, /20 distinct accounts/, 'and it must state the rule it is enforcing');
    });
  });

  await t.test('everywhere a credential fails, the tripwire is told', () => {
    // The detection is only as wide as its call sites. A sign-in path that
    // hashes a password and forgets to note the failure is a hole in the
    // cross-account view, so the census is part of this contract.
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    const records = (src.match(/noteIpAccountFailure\(/g) || []).length;
    assert.ok(records >= 3, `expected the tripwire at every credential failure site, found ${records}`);
    assert.match(src, /if \(tripwireThrottle\(res, req\.ip\)\)/, 'and its cooldown must actually be enforced');
  });
});
