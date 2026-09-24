// ═══════════════════════════════════════════════════════════════════════════
// ADVERSARIAL GLITCH HUNT — SuppliWise BLOCKCHAIN (Web3) layer.
//
// Deliberately attacks the /api/web3 surface of a LIVE server
// (default http://localhost:5000): maxlength overflows, non-finite numerics,
// prototype-chain parameter injection, DAO bounds, IDOR across every sub-route,
// double-settlement races (escrow confirm, dispute resolution, loyalty codes,
// booking refunds), lost-update races (DAO votes, juror votes, upvotes,
// journey events), NFT mint races, zero-value orders, malformed ids, and a
// final stress burst + chain-integrity re-verification.
//
// Usage:  node glitch-hunt-web3.js        (server must be running)
// Exit 0 = every check passed.
//
// Re-run safe: registers throwaway bc-hunt-* accounts; purges previous
// bc-hunt-* AND stale web3-smoke-* accounts plus any orphaned wallets
// (owner deleted) at setup, and purges its own accounts at the end so the
// smoke suite's staked-juror pool stays deterministic.
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const mongoose = require('mongoose');

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:5000/api';
const STAMP = Date.now();

const SUPPLY_ORDER = [
  'raw-sourcing',
  'manufacturing',
  'lab-testing',
  'quality-release',
  'distribution',
  'retail',
  'delivered',
];

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    const line = `${name}${detail ? ` — ${detail}` : ''}`;
    failures.push(line);
    console.log(`  FAIL  ${line}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 66 - title.length))}`);
}

async function call(method, path, { token, body, raw, timeout = 15000 } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    return { status: 0, data: { message: `transport error: ${err.message}` } };
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

const solveCaptcha = async () => {
  const { data } = await call('GET', '/auth/captcha');
  const [left, right] = data.question.replace('= ?', '').trim().split(/\s*[+−×]\s*/);
  const op = data.question.includes('×') ? '*' : data.question.includes('−') ? '-' : '+';
  const answer = op === '*' ? Number(left) * Number(right)
    : op === '-' ? Number(left) - Number(right)
      : Number(left) + Number(right);
  return { id: data.id, answer: String(answer) };
};

async function register(tag) {
  const captcha = await solveCaptcha();
  const res = await call('POST', '/auth/register', {
    body: {
      firstName: 'BcHunt',
      lastName: tag,
      email: `bc-hunt-${tag.toLowerCase()}-${STAMP}@example.com`,
      password: 'BcHuntTest123!',
      dateOfBirth: '1994-04-04',
      gender: 'Male',
      captchaId: captcha.id,
      captchaAnswer: captcha.answer,
    },
  });
  if (res.status !== 201) throw new Error(`register ${tag} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { id: res.data._id, token: res.data.token };
}

const walletOf = async (token) => (await call('GET', '/web3/wallet', { token })).data.wallet;
const balanceOf = async (token) => (await walletOf(token)).balance;

// Remove earlier hunt/smoke accounts (and their Web3 records) plus any
// orphaned wallet whose owner no longer exists.
async function purgeProbeData() {
  const User = require('./models/User');
  const W = require('./models/Web3');
  const Assessment = require('./models/Assessment');
  const users = await User.find({ email: /^(bc-hunt-|web3-smoke-)/ }).select('_id').lean();
  const ids = users.map((u) => u._id);
  if (ids.length) {
    const inIds = { $in: ids };
    await Promise.all([
      W.Wallet.deleteMany({ user: inIds }),
      W.Listing.deleteMany({ sellerUser: inIds }),
      W.Order.deleteMany({ $or: [{ buyer: inIds }, { sellerUser: inIds }] }),
      W.Dispute.deleteMany({ opener: inIds }),
      W.Proposal.deleteMany({ proposer: inIds }),
      W.KnowledgePost.deleteMany({ author: inIds }),
      W.RewardEvent.deleteMany({ user: inIds }),
      W.Nft.deleteMany({ owner: inIds }),
      W.LoyaltyCode.deleteMany({ owner: inIds }),
      W.DataShare.deleteMany({ user: inIds }),
      W.StorageObject.deleteMany({ owner: inIds }),
      W.HealthAnchor.deleteMany({ user: inIds }),
      W.ShareLink.deleteMany({ user: inIds }),
      W.RecAnchor.deleteMany({ user: inIds }),
      W.TrialConsent.deleteMany({ user: inIds }),
      W.Booking.deleteMany({ user: inIds }),
      W.SupplyBatch.deleteMany({ createdBy: inIds }),
      Assessment.deleteMany({ user: inIds }),
      User.deleteMany({ _id: inIds }),
    ]);
  }
  const allUsers = await User.find({}).select('_id').lean();
  const live = new Set(allUsers.map((u) => String(u._id)));
  const wallets = await W.Wallet.find({ isSystem: { $ne: true } }).select('_id user').lean();
  const orphans = wallets.filter((w) => !w.user || !live.has(String(w.user))).map((w) => w._id);
  if (orphans.length) await W.Wallet.deleteMany({ _id: { $in: orphans } });
  return { purged: ids.length, orphans: orphans.length };
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const W = require('./models/Web3');
  const Assessment = require('./models/Assessment');

  // ── Setup ────────────────────────────────────────────────────────────────
  section('Setup — purge debris, register hunter accounts');
  const purge = await purgeProbeData();
  check('stale probe accounts + orphan wallets purged', purge.orphans >= 0, JSON.stringify(purge));

  const HN = await register('Main');   // buyer / proposer / author / supplier
  const HS = await register('Seller'); // seller / listing creator
  const HJ1 = await register('JurorA');// staked juror 1
  const HJ2 = await register('JurorB');// staked juror 2
  const HW = await register('Wallet'); // fresh wallet + checkin race + 2nd booking
  const HB = await register('Booker'); // booking double-cancel target
  check('six hunter accounts registered', !!(HN.token && HS.token && HJ1.token && HJ2.token && HW.token && HB.token));

  const wHN = await walletOf(HN.token);
  const wHS = await walletOf(HS.token);
  const wHJ1 = await walletOf(HJ1.token);
  const wHJ2 = await walletOf(HJ2.token);
  const wHB = await walletOf(HB.token);
  check('hunter wallets created with welcome airdrop',
    [wHN, wHS, wHJ1, wHJ2, wHB].every((w) => w.balance === 100),
    JSON.stringify([wHN, wHS, wHJ1, wHJ2, wHB].map((w) => w.balance)));

  const st1 = await call('POST', '/web3/stake', { token: HJ1.token, body: { amount: 5 } });
  const st2 = await call('POST', '/web3/stake', { token: HJ2.token, body: { amount: 5 } });
  check('jurors staked → deterministic staked-juror pool', st1.status === 200 && st2.status === 200,
    JSON.stringify([st1.status, st2.status]));

  const hnAssessment = await new Assessment({
    user: HN.id,
    healthGoals: ['More energy'],
    symptoms: ['Afternoon fatigue'],
    medicalConditions: 'None known',
    currentMedications: 'None',
    allergies: 'None',
    aiResults: {
      priority: 'Priority',
      plan: [{ supplement: 'Vitamin D3', dose: '2000 IU', timing: 'morning' }],
      engineVersion: 'suppliwise-rec-engine@1',
    },
  }).save({ validateBeforeSave: false });
  check('attacker-owned assessment seeded', !!hnAssessment._id);

  const trials = await call('GET', '/web3/trials', { token: HN.token });
  const optin = await call('POST', `/web3/trials/${trials.data.trials[0]._id}/optin`, { token: HN.token, body: {} });
  check('trial consent recorded (achievement eligibility)', optin.status === 201, `status ${optin.status}`);

  const mkListing = (l) => call('POST', '/web3/market/listings', { token: HS.token, body: l });
  const L1 = await mkListing({ title: 'Hunt Target 10', brand: 'HuntCo', category: 'Other', priceWell: 10, stock: 5, description: 'double-confirm race listing' });
  const L2 = await mkListing({ title: 'Hunt Ballast 12', brand: 'HuntCo', category: 'Other', priceWell: 12, stock: 5, description: 'escrow ballast + dispute listing' });
  const L3 = await mkListing({ title: 'Hunt Loyalty 20', brand: 'HuntCo', category: 'Other', priceWell: 20, stock: 5, description: 'loyalty double-spend listing' });
  const L4 = await mkListing({ title: 'Hunt Zero 5', brand: 'HuntCo', category: 'Other', priceWell: 5, stock: 1, description: 'zero-total order listing' });
  const L5 = await mkListing({ title: 'Hunt Stock 5', brand: 'HuntCo', category: 'Other', priceWell: 5, stock: 2, description: 'stock race listing' });
  const L6 = await mkListing({ title: 'Hunt Qty 7', brand: 'HuntCo', category: 'Other', priceWell: 7, stock: 3, description: 'qty validation listing' });
  check('six race listings created', [L1, L2, L3, L4, L5, L6].every((r) => r.status === 201),
    JSON.stringify([L1, L2, L3, L4, L5, L6].map((r) => r.status)));
  const listingId = (r) => r.data.listing._id;

  const pinHN = await call('POST', '/web3/storage/pin', { token: HN.token, body: { kind: 'note', data: { hello: 'hunt', n: 1 } } });
  const dsHN = await call('POST', '/web3/data/shares', { token: HN.token, body: { recipient: 'Hunt IDOR Institute', scope: 'nutrition-outcomes' } });
  const psHN = await call('POST', '/web3/profile-shares', { token: HN.token, body: { ttlHours: 24 } });
  const psList = await call('GET', '/web3/profile-shares', { token: HN.token });
  const psId = (psList.data.links || []).find((l) => l.token === psHN.data?.link?.token)?._id;
  const batchHN = await call('POST', '/web3/supply/batches', { token: HN.token, body: { productName: 'Hunt D3 60ct', brand: 'HuntLab', notes: 'glitch-hunt batch' } });
  check('attacker-owned assets created', pinHN.status === 201 && dsHN.status === 201 && psHN.status === 201 && !!psId && batchHN.status === 201,
    JSON.stringify({ pin: pinHN.status, ds: dsHN.status, ps: psHN.status, psId: !!psId, batch: batchHN.status }));

  const oBallast = await call('POST', '/web3/market/orders', { token: HN.token, body: { listingId: listingId(L2), qty: 1 } });
  const oTarget = await call('POST', '/web3/market/orders', { token: HN.token, body: { listingId: listingId(L1), qty: 1 } });
  check('escrow ballast + race-target orders funded',
    oBallast.status === 201 && oBallast.data.order.status === 'escrow'
      && oTarget.status === 201 && oTarget.data.order.status === 'escrow',
    JSON.stringify([oBallast.status, oTarget.status]));

  // ── 1. Auth boundary ─────────────────────────────────────────────────────
  section('Auth boundary (401 everywhere except the 3 public endpoints)');
  check('GET /web3/wallet without token → 401', (await call('GET', '/web3/wallet')).status === 401);
  check('POST /web3/market/listings without token → 401', (await call('POST', '/web3/market/listings', { body: {} })).status === 401);
  check('GET /web3/chain without token → 401', (await call('GET', '/web3/chain')).status === 401);
  check('garbage bearer token → 401', (await call('GET', '/web3/wallet', { token: 'not.a.jwt' })).status === 401);
  const pubV = await call('GET', '/web3/verify/SW0000000');
  check('public QR verify reachable without account', pubV.status !== 401 && pubV.status > 0 && pubV.status < 500, `status ${pubV.status}`);
  const pubS = await call('GET', '/web3/share/zzz');
  check('public share link reachable without account', pubS.status !== 401 && pubS.status > 0 && pubS.status < 500, `status ${pubS.status}`);

  // ── 2. IDOR / cross-account access ──────────────────────────────────────
  section('IDOR — foreign accounts must be denied on every sub-route');
  const idor = [
    ['foreign storage CID read', (await call('GET', `/web3/storage/${pinHN.data.cid}`, { token: HS.token })).status],
    ['foreign data-share revoke', (await call('DELETE', `/web3/data/shares/${dsHN.data.share._id}`, { token: HS.token })).status],
    ['foreign profile-share revoke', (await call('DELETE', `/web3/profile-shares/${psId}`, { token: HS.token })).status],
    ['foreign supply event append', (await call('POST', `/web3/supply/batches/${batchHN.data.batch._id}/events`, { token: HS.token, body: { step: 'manufacturing' } })).status],
    ['foreign escrow confirm', (await call('POST', `/web3/market/orders/${oBallast.data.order._id}/confirm`, { token: HS.token, body: {} })).status],
    ['foreign assessment reward claim', (await call('POST', '/web3/rewards/assessment', { token: HS.token, body: { assessmentId: String(hnAssessment._id) } })).status],
    ['foreign recommendation anchor', (await call('POST', '/web3/recommendations/anchor', { token: HS.token, body: { assessmentId: String(hnAssessment._id) } })).status],
    ['foreign recommendation read', (await call('GET', `/web3/recommendations/anchor/${hnAssessment._id}`, { token: HS.token })).status],
  ];
  for (const [name, status] of idor) {
    check(`${name} denied (4xx, no 500)`, status >= 400 && status < 500, `status ${status}`);
  }

  // ── 3. Malformed ids must never 500 ─────────────────────────────────────
  section('Malformed ObjectIds — handled with 4xx, never a crash');
  const bad = [
    ['supply event', 'POST', '/web3/supply/batches/badid/events', { step: 'manufacturing' }],
    ['trial optin', 'POST', '/web3/trials/badid/optin', {}],
    ['expert booking', 'POST', '/web3/experts/badid/book', { hours: 1 }],
    ['knowledge upvote', 'POST', '/web3/knowledge/badid/upvote', {}],
    ['DAO vote', 'POST', '/web3/dao/proposals/badid/vote', { choice: 'for' }],
    ['dispute vote', 'POST', '/web3/market/disputes/badid/vote', { choice: 'buyer' }],
    ['data-share delete', 'DELETE', '/web3/data/shares/badid', undefined],
    ['profile-share delete', 'DELETE', '/web3/profile-shares/badid', undefined],
    ['order confirm', 'POST', '/web3/market/orders/badid/confirm', {}],
    ['order dispute', 'POST', '/web3/market/orders/badid/dispute', { reason: 'malformed id probe reason' }],
    ['booking cancel', 'POST', '/web3/bookings/badid/cancel', {}],
    ['assessment reward bad id', 'POST', '/web3/rewards/assessment', { assessmentId: 'badid' }],
    ['storage cid', 'GET', '/web3/storage/bad!cid', undefined],
    ['tx hash', 'GET', '/web3/tx/notahash', undefined],
    ['recommendation read', 'GET', '/web3/recommendations/anchor/badid', undefined],
  ];
  for (const [name, method, path, body] of bad) {
    const r = await call(method, path, { token: HN.token, body });
    check(`${name}: malformed id handled`, r.status !== 500 && r.status !== 0, `status ${r.status}`);
  }

  // ── 4. Public endpoints (unknown-but-well-formed) ───────────────────────
  section('Public endpoints — unknown codes/tokens are 4xx, never 500');
  const pubUnknown = [
    ['unknown verify code', (await call('GET', '/web3/verify/SWDEADBEEF')).status],
    ['unknown share token', (await call('GET', `/web3/share/${'a'.repeat(32)}`)).status],
    ['verify code bad format', (await call('GET', '/web3/verify/x')).status],
    ['share token bad format', (await call('GET', '/web3/share/short')).status],
    ['qr without base', (await call('GET', '/web3/verify/SWDEADBEEF/qr')).status],
  ];
  for (const [name, status] of pubUnknown) {
    check(`${name} → 4xx`, status >= 400 && status < 500, `status ${status}`);
  }

  // ── 5. Maxlength overflows (schema ValidationError used to → 500) ──────
  section('Maxlength overflows — truncate or reject, never 500');
  const ovListing = await mkListing({ title: 'X'.repeat(300), brand: 'B', category: 'Other', priceWell: 5, stock: 1, description: 'overlong title probe' });
  check('listing title ×300 handled (≤120 or 4xx)',
    ovListing.status !== 500 && ovListing.status !== 0
      && (ovListing.status !== 201 || (typeof ovListing.data?.listing?.title === 'string' ? ovListing.data.listing.title.length <= 120 : true)),
    `status ${ovListing.status} len ${ovListing.data?.listing?.title?.length}`);

  const ovProp = await call('POST', '/web3/dao/proposals', {
    token: HN.token,
    body: { title: 'P'.repeat(300), description: 'Overlong proposal title overflow probe body text.', param: '', value: null },
  });
  check('proposal title ×300 handled (≤140 or 4xx)',
    ovProp.status !== 500 && ovProp.status !== 0
      && (ovProp.status !== 201 || (typeof ovProp.data?.proposal?.title === 'string' ? ovProp.data.proposal.title.length <= 140 : true)),
    `status ${ovProp.status} len ${ovProp.data?.proposal?.title?.length}`);

  const ovKn = await call('POST', '/web3/knowledge', {
    token: HN.token,
    body: { type: 'review', title: 'K'.repeat(300), body: 'B'.repeat(5000) },
  });
  check('knowledge title×300 + body×5000 handled (≤schema max or 4xx)',
    ovKn.status !== 500 && ovKn.status !== 0, `status ${ovKn.status}`);
  if (ovKn.status === 201) {
    const knList0 = await call('GET', '/web3/knowledge', { token: HN.token });
    const stored = (knList0.data.posts || []).find((p) => String(p._id) === String(ovKn.data.post._id));
    check('stored knowledge post within schema limits',
      stored && stored.title.length <= 140 && stored.body.length <= 4000,
      `title ${stored?.title?.length} body ${stored?.body?.length}`);
  }

  const ovShare = await call('POST', '/web3/data/shares', { token: HN.token, body: { recipient: 'R'.repeat(500), scope: 'nutrition-outcomes' } });
  check('data-share recipient ×500 handled (≤120 or 4xx)',
    ovShare.status !== 500 && ovShare.status !== 0
      && (ovShare.status !== 201 || (typeof ovShare.data?.share?.recipient === 'string' ? ovShare.data.share.recipient.length <= 120 : true)),
    `status ${ovShare.status} len ${ovShare.data?.share?.recipient?.length}`);

  const ovBatch = await call('POST', '/web3/supply/batches', { token: HN.token, body: { productName: 'N'.repeat(300), brand: 'Z'.repeat(200), notes: 'overlong supply fields' } });
  check('supply productName ×300 handled (≤120 or 4xx)',
    ovBatch.status !== 500 && ovBatch.status !== 0
      && (ovBatch.status !== 201 || (typeof ovBatch.data?.batch?.productName === 'string' ? ovBatch.data.batch.productName.length <= 120 : true)),
    `status ${ovBatch.status} len ${ovBatch.data?.batch?.productName?.length}`);

  // ── 6. Non-finite / hostile numerics ────────────────────────────────────
  section('Non-finite numerics (Infinity/NaN/negatives) rejected with 400');
  const infList = await call('POST', '/web3/market/listings', {
    token: HS.token,
    raw: '{"title":"Infinity price probe","brand":"X","category":"Other","priceWell":1e999,"stock":1,"description":"raw Infinity literal"}',
  });
  check('listing priceWell 1e999 (raw Infinity literal) → 400', infList.status === 400, `status ${infList.status}`);
  const negStock = await mkListing({ title: 'Negative stock probe', brand: 'X', category: 'Other', priceWell: 5, stock: -5, description: 'negative inventory' });
  check('listing stock −5 → 400', negStock.status === 400, `status ${negStock.status}`);
  const nanPrice = await mkListing({ title: 'NaN price probe', brand: 'X', category: 'Other', priceWell: 'abc', stock: 1, description: 'not a number' });
  check('listing priceWell "abc" → 400', nanPrice.status === 400, `status ${nanPrice.status}`);

  const stakeBad = [
    ['stake raw 1e999', 'POST', '/web3/stake', undefined, '{"amount":1e999}'],
    ['stake "abc"', 'POST', '/web3/stake', { amount: 'abc' }, undefined],
    ['stake −5', 'POST', '/web3/stake', { amount: -5 }, undefined],
    ['unstake raw 1e999', 'POST', '/web3/unstake', undefined, '{"amount":1e999}'],
    ['unstake 99999', 'POST', '/web3/unstake', { amount: 99999 }, undefined],
    ['redeem raw 1e999', 'POST', '/web3/loyalty/redeem', undefined, '{"amount":1e999}'],
    ['redeem −10', 'POST', '/web3/loyalty/redeem', { amount: -10 }, undefined],
    ['redeem 0', 'POST', '/web3/loyalty/redeem', { amount: 0 }, undefined],
  ];
  for (const [name, method, path, b, r] of stakeBad) {
    const res = await call(method, path, { token: HS.token, body: b, raw: r });
    check(`${name} → 400`, res.status === 400, `status ${res.status}`);
  }

  const qtyBads = [0, -1, 1.5, 'abc'];
  for (const q of qtyBads) {
    const r = await call('POST', '/web3/market/orders', { token: HN.token, body: { listingId: listingId(L6), qty: q } });
    check(`order qty ${JSON.stringify(q)} → 400`, r.status === 400, `status ${r.status}`);
  }
  const l6After = (await call('GET', '/web3/market/listings', { token: HN.token })).data.listings.find((l) => String(l._id) === String(listingId(L6)));
  check('stock untouched by rejected qty probes (still 3)', l6After?.stock === 3, `stock ${l6After?.stock}`);

  // ── 7. Prototype-chain + DAO parameter bounds ───────────────────────────
  section('Prototype-chain injection + DAO parameter bounds');
  for (const p of ['toString', 'constructor', '__proto__']) {
    const r = await call('POST', '/web3/dao/proposals', {
      token: HN.token,
      body: { title: `Proto ${p} probe`, description: 'Prototype-chain parameter injection probe body.', param: p, value: 1 },
    });
    check(`prototype param '${p}' rejected → 400`, r.status === 400, `status ${r.status}`);
  }
  const badParams = [
    ['bogus param', { param: 'notAParam', value: 1 }],
    ['negative reward value', { param: 'rewardCheckin', value: -5 }],
    ['null value', { param: 'rewardCheckin', value: null }],
    ['absurd value 1e12', { param: 'rewardCheckin', value: 1e12 }],
    ['zero voting days', { param: 'daoVotingDays', value: 0 }],
    ['absurd voting days 1e6', { param: 'daoVotingDays', value: 1e6 }],
  ];
  for (const [name, extra] of badParams) {
    const r = await call('POST', '/web3/dao/proposals', {
      token: HN.token,
      body: { title: `Bounds ${name}`, description: 'DAO parameter bounds probe body text.', ...extra },
    });
    check(`DAO bounds: ${name} → 400`, r.status === 400, `status ${r.status}`);
  }

  const lateProp = await new W.Proposal({
    title: 'Expired hunt proposal',
    description: 'Ends in the past — voting must be rejected.',
    param: 'rewardCheckin',
    value: 9,
    proposer: HN.id,
    proposerAddress: wHN.address,
    status: 'active',
    votes: [],
    endsAt: Date.now() - 60000,
  }).save({ validateBeforeSave: false });
  const lateVote = await call('POST', `/web3/dao/proposals/${lateProp._id}/vote`, { token: HS.token, body: { choice: 'for' } });
  check('vote on already-expired proposal → 400', lateVote.status === 400, `status ${lateVote.status}`);

  // ── 8. Wallet-creation + check-in races (fresh account) ─────────────────
  section('Races — concurrent first wallet access + daily check-in');
  const firstWallets = await Promise.all(Array.from({ length: 5 }, () => call('GET', '/web3/wallet', { token: HW.token })));
  const addrs = new Set(firstWallets.map((r) => r.data?.wallet?.address));
  check('5 concurrent first wallet reads: all 200, single identity',
    firstWallets.every((r) => r.status === 200) && addrs.size === 1,
    JSON.stringify({ statuses: firstWallets.map((r) => r.status), ids: addrs.size }));
  const hwFinal = await walletOf(HW.token);
  check('welcome airdrop credited exactly once (balance 100, not 500)', hwFinal.balance === 100, `balance ${hwFinal.balance}`);

  const checks = await Promise.all(Array.from({ length: 6 }, () => call('POST', '/web3/rewards/checkin', { token: HW.token, body: {} })));
  const claimedOnes = checks.filter((r) => r.data?.claimed === true);
  const hwAfterCheckin = await balanceOf(HW.token);
  check('6 concurrent check-ins: no 500s', checks.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(checks.map((r) => r.status)));
  check('check-in minted exactly once', claimedOnes.length === 1, `claimed ${claimedOnes.length}`);
  const claimedSum = claimedOnes.reduce((s, r) => s + (Number(r.data.amount) || 0), 0);
  check('balance increased by exactly the single claim amount', hwAfterCheckin === 100 + claimedSum,
    `${hwAfterCheckin} vs ${100 + claimedSum}`);

  // ── 9. Escrow double-confirm race ───────────────────────────────────────
  section('Race — concurrent delivery confirmation must pay the seller once');
  const sellerBefore = await balanceOf(HS.token);
  const confs = await Promise.all([
    call('POST', `/web3/market/orders/${oTarget.data.order._id}/confirm`, { token: HN.token, body: {} }),
    call('POST', `/web3/market/orders/${oTarget.data.order._id}/confirm`, { token: HN.token, body: {} }),
  ]);
  const confOk = confs.filter((r) => r.status === 200).length;
  const sellerAfter = await balanceOf(HS.token);
  check('double-confirm: no 500s', confs.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(confs.map((r) => r.status)));
  check('exactly one confirmation succeeds', confOk === 1, `successes ${confOk}`);
  check('seller paid exactly once (+9.7, never +19.4)', sellerAfter === sellerBefore + 9.7,
    `${sellerAfter} vs ${sellerBefore + 9.7}`);
  const targetAfter = (await call('GET', '/web3/market/orders', { token: HN.token })).data.bought.find((o) => String(o._id) === String(oTarget.data.order._id));
  check('target order settled released', targetAfter?.status === 'released', `status ${targetAfter?.status}`);

  // ── 10. Loyalty double-spend race ───────────────────────────────────────
  section('Race — one loyalty code can never discount two orders');
  const lo1 = await call('POST', '/web3/loyalty/redeem', { token: HN.token, body: { amount: 10 } });
  check('loyalty code issued', lo1.status === 201, `status ${lo1.status}`);
  const code = lo1.data?.code?.code;
  const balBeforeLoyalty = await balanceOf(HN.token);
  const loOrders = await Promise.all([
    call('POST', '/web3/market/orders', { token: HN.token, body: { listingId: listingId(L3), qty: 1, discountCode: code } }),
    call('POST', '/web3/market/orders', { token: HN.token, body: { listingId: listingId(L3), qty: 1, discountCode: code } }),
  ]);
  const loOk = loOrders.filter((r) => r.status === 201).length;
  const balAfterLoyalty = await balanceOf(HN.token);
  const l3After = (await call('GET', '/web3/market/listings', { token: HN.token })).data.listings.find((l) => String(l._id) === String(listingId(L3)));
  check('loyalty race: no 500s', loOrders.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(loOrders.map((r) => r.status)));
  check('code discounted exactly one order', loOk === 1, `successes ${loOk}`);
  check('buyer paid the discounted total exactly once (−10)', balBeforeLoyalty - balAfterLoyalty === 10,
    `delta ${balBeforeLoyalty - balAfterLoyalty}`);
  check('loyalty stock decremented once (5 → 4)', l3After?.stock === 4, `stock ${l3After?.stock}`);

  // ── 11. Zero-total order (discount ≥ subtotal) ──────────────────────────
  section('Zero-total order — fully discounted checkout must not crash');
  const lo2 = await call('POST', '/web3/loyalty/redeem', { token: HN.token, body: { amount: 10 } });
  check('second loyalty code issued', lo2.status === 201, `status ${lo2.status}`);
  const oZero = await call('POST', '/web3/market/orders', { token: HN.token, body: { listingId: listingId(L4), qty: 1, discountCode: lo2.data?.code?.code } });
  check('zero-total order created (201, total 0)', oZero.status === 201 && oZero.data?.order?.total === 0,
    `status ${oZero.status} total ${oZero.data?.order?.total}`);
  if (oZero.status === 201) {
    const confZero = await call('POST', `/web3/market/orders/${oZero.data.order._id}/confirm`, { token: HN.token, body: {} });
    check('zero-total order settles (released, no BAD_AMOUNT)', confZero.status === 200 && confZero.data?.order?.status === 'released',
      `status ${confZero.status}`);
  }

  // ── 12. Stock reservation race ──────────────────────────────────────────
  section('Race — 6 concurrent orders vs stock 2');
  const stockOrders = await Promise.all(Array.from({ length: 6 }, () =>
    call('POST', '/web3/market/orders', { token: HN.token, body: { listingId: listingId(L5), qty: 1 } })));
  const stockOk = stockOrders.filter((r) => r.status === 201).length;
  const l5After = (await call('GET', '/web3/market/listings', { token: HN.token })).data.listings.find((l) => String(l._id) === String(listingId(L5)));
  check('stock race: no 500s', stockOrders.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(stockOrders.map((r) => r.status)));
  check('exactly 2 of 6 concurrent orders succeed', stockOk === 2, `successes ${stockOk}`);
  check('stock ends at 0 (never negative)', l5After?.stock === 0, `stock ${l5After?.stock}`);

  // ── 13. Dispute lifecycle under concurrency ─────────────────────────────
  section('Race — dispute: overflow reason, confirm-block, juror votes, single refund');
  const oDisp = await call('POST', '/web3/market/orders', { token: HN.token, body: { listingId: listingId(L2), qty: 1 } });
  check('dispute order escrowed', oDisp.status === 201 && oDisp.data.order.status === 'escrow', `status ${oDisp.status}`);

  const strangerDisp = await call('POST', `/web3/market/orders/${oDisp.data.order._id}/dispute`, { token: HJ1.token, body: { reason: 'Not my order at all.' } });
  check('non-party cannot open dispute (4xx)', strangerDisp.status >= 400 && strangerDisp.status < 500, `status ${strangerDisp.status}`);

  const disp = await call('POST', `/web3/market/orders/${oDisp.data.order._id}/dispute`, {
    token: HN.token,
    body: { reason: 'R'.repeat(1500) },
  });
  check('overlong dispute reason handled (≤1000 or 4xx, no 500)',
    disp.status !== 500 && disp.status !== 0
      && (disp.status !== 201 || (typeof disp.data?.dispute?.reason === 'string' ? disp.data.dispute.reason.length <= 1000 : true)),
    `status ${disp.status} len ${disp.data?.dispute?.reason?.length}`);

  if (disp.status === 201) {
    const jurSet = new Set(disp.data.dispute.jurors || []);
    check('jurors = exactly the two staked hunters (no foreign/random jurors)',
      jurSet.size === 2 && jurSet.has(wHJ1.address) && jurSet.has(wHJ2.address),
      JSON.stringify(disp.data.dispute.jurors));

    const confWhileDisp = await call('POST', `/web3/market/orders/${oDisp.data.order._id}/confirm`, { token: HN.token, body: {} });
    check('confirmation blocked while dispute open → 400', confWhileDisp.status === 400, `status ${confWhileDisp.status}`);

    const balBeforeVotes = await balanceOf(HN.token);
    const voteBurst = await Promise.all([
      call('POST', `/web3/market/disputes/${disp.data.dispute._id}/vote`, { token: HJ1.token, body: { choice: 'buyer' } }),
      call('POST', `/web3/market/disputes/${disp.data.dispute._id}/vote`, { token: HJ2.token, body: { choice: 'buyer' } }),
      call('GET', '/web3/market/disputes', { token: HN.token }),
      call('GET', '/web3/market/disputes', { token: HS.token }),
    ]);
    check('concurrent juror votes + lazy resolution: no 500s',
      voteBurst.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(voteBurst.map((r) => r.status)));

    await new Promise((r) => setTimeout(r, 400)); // let any trailing resolution settle
    const dispOrder = (await call('GET', '/web3/market/orders', { token: HN.token })).data.bought.find((o) => String(o._id) === String(oDisp.data.order._id));
    const balAfterVotes = await balanceOf(HN.token);
    check('dispute resolved under concurrency (order refunded)', dispOrder?.status === 'refunded', `status ${dispOrder?.status}`);
    check('buyer refunded exactly once (+12, never +24)', balAfterVotes === balBeforeVotes + 12,
      `${balAfterVotes} vs ${balBeforeVotes + 12}`);
    const jEvents = await call('GET', '/web3/rewards/events', { token: HJ1.token });
    check('juror paid for the verdict', (jEvents.data.events || []).some((e) => String(e.kind).includes('juror')),
      JSON.stringify((jEvents.data.events || []).map((e) => e.kind)));
  }

  // ── 14. Supply journey races ────────────────────────────────────────────
  section('Race — concurrent journey steps (no lost updates, no double steps)');
  const rb = await call('POST', '/web3/supply/batches', { token: HN.token, body: { productName: 'Hunt Race Batch', brand: 'HuntLab', notes: 'journey race' } });
  const rbId = rb.data?.batch?._id;
  const rbCode = rb.data?.batch?.code;
  const initLen = rb.data?.batch?.events?.length ?? -1;
  check('race batch created with initial step', rb.status === 201 && initLen >= 1, `status ${rb.status} events ${initLen}`);

  const journeyOf = async () => {
    const list = await call('GET', '/web3/supply/batches', { token: HN.token });
    return (list.data?.batches || []).find((b) => String(b._id) === String(rbId))?.events || [];
  };

  const fwdPair = await Promise.all([
    call('POST', `/web3/supply/batches/${rbId}/events`, { token: HN.token, body: { step: 'manufacturing', location: 'Race Lab', note: 'concurrent A' } }),
    call('POST', `/web3/supply/batches/${rbId}/events`, { token: HN.token, body: { step: 'lab-testing', location: 'Race Lab', note: 'concurrent B' } }),
  ]);
  const fwdOk = fwdPair.filter((r) => r.status < 400).length;
  const eventsAfterFwd = await journeyOf();
  const idxOf = (s) => SUPPLY_ORDER.indexOf(s);
  const strictlyForward = eventsAfterFwd.every((e, i) => i === 0 || idxOf(e.step) > idxOf(eventsAfterFwd[i - 1].step));
  check('forward journey race: no 500s', fwdPair.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(fwdPair.map((r) => r.status)));
  check('no lost updates (stored events = initial + successes)', eventsAfterFwd.length === initLen + fwdOk,
    `stored ${eventsAfterFwd.length} vs ${initLen} + ${fwdOk}`);
  check('journey remains strictly forward-ordered', strictlyForward, JSON.stringify(eventsAfterFwd.map((e) => e.step)));

  const lenBeforeDup = eventsAfterFwd.length;
  const dupPair = await Promise.all([
    call('POST', `/web3/supply/batches/${rbId}/events`, { token: HN.token, body: { step: 'quality-release', location: 'Race Lab' } }),
    call('POST', `/web3/supply/batches/${rbId}/events`, { token: HN.token, body: { step: 'quality-release', location: 'Race Lab' } }),
  ]);
  const dupOk = dupPair.filter((r) => r.status < 400).length;
  const eventsAfterDup = await journeyOf();
  const dupCount = eventsAfterDup.filter((e) => e.step === 'quality-release').length;
  check('duplicate journey race: no 500s', dupPair.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(dupPair.map((r) => r.status)));
  check('duplicate concurrent step applied exactly once', dupOk === 1 && dupCount === 1,
    `successes ${dupOk} stored ${dupCount}`);
  check('journey length grew by exactly one', eventsAfterDup.length === lenBeforeDup + 1,
    `${lenBeforeDup} → ${eventsAfterDup.length}`);

  // ── 15. Concurrent DAO votes ────────────────────────────────────────────
  section('Race — concurrent DAO votes (no lost updates)');
  const propReal = await call('POST', '/web3/dao/proposals', {
    token: HN.token,
    body: { title: 'Hunt: raise check-in reward', description: 'Concurrent voting race probe proposal body.', param: 'rewardCheckin', value: 7 },
  });
  check('race proposal opened', propReal.status === 201, `status ${propReal.status}`);
  const daoVotes = await Promise.all([
    call('POST', `/web3/dao/proposals/${propReal.data?.proposal?._id}/vote`, { token: HS.token, body: { choice: 'for' } }),
    call('POST', `/web3/dao/proposals/${propReal.data?.proposal?._id}/vote`, { token: HJ1.token, body: { choice: 'against' } }),
    call('POST', `/web3/dao/proposals/${propReal.data?.proposal?._id}/vote`, { token: HJ2.token, body: { choice: 'for' } }),
  ]);
  check('concurrent DAO votes: no 500s', daoVotes.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(daoVotes.map((r) => r.status)));
  const propsList = await call('GET', '/web3/dao/proposals', { token: HN.token });
  const raceProp = (propsList.data.proposals || []).find((p) => String(p._id) === String(propReal.data?.proposal?._id));
  check('every concurrent vote persisted (voterCount = 4)', raceProp?.tally?.voterCount === 4,
    `voterCount ${raceProp?.tally?.voterCount}`);

  // ── 16. Concurrent knowledge upvotes ────────────────────────────────────
  section('Race — concurrent knowledge upvotes (no lost updates)');
  const kn = await call('POST', '/web3/knowledge', {
    token: HN.token,
    body: { type: 'review', title: 'Hunt knowledge post', body: 'A sufficiently long body for the concurrent-upvote glitch probe.' },
  });
  check('knowledge post created', kn.status === 201, `status ${kn.status}`);
  const ownUp = await call('POST', `/web3/knowledge/${kn.data?.post?._id}/upvote`, { token: HN.token, body: {} });
  check('author cannot upvote own post → 400', ownUp.status === 400, `status ${ownUp.status}`);
  const ups = await Promise.all([HS, HJ1, HJ2, HW].map((u) =>
    call('POST', `/web3/knowledge/${kn.data?.post?._id}/upvote`, { token: u.token, body: {} })));
  check('concurrent upvotes: no 500s', ups.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(ups.map((r) => r.status)));
  const knList = await call('GET', '/web3/knowledge', { token: HN.token });
  const knPost = (knList.data.posts || []).find((p) => String(p._id) === String(kn.data?.post?._id));
  check('every concurrent upvote persisted (upvotes = 4)', knPost?.upvotes === 4, `upvotes ${knPost?.upvotes}`);

  // ── 17. Concurrent achievement NFT mints ────────────────────────────────
  section('Race — concurrent achievement NFT mints (no 11000 crashes, no dupes)');
  const mints = await Promise.all(Array.from({ length: 5 }, () =>
    call('POST', '/web3/rewards/achievements/check', { token: HN.token, body: {} })));
  check('5 concurrent mint checks all succeed (no E11000 → 500)', mints.every((r) => r.status === 200),
    JSON.stringify(mints.map((r) => r.status)));
  const nfts = await call('GET', '/web3/rewards/nfts', { token: HN.token });
  const kinds = (nfts.data.nfts || []).map((n) => n.kind);
  check('minted NFT kinds unique (soulbound, once per milestone)', new Set(kinds).size === kinds.length,
    kinds.join(','));
  const mintAgain0 = await call('POST', '/web3/rewards/achievements/check', { token: HN.token, body: {} });
  check('re-check after race mints nothing new', mintAgain0.data?.count === 0, `count ${mintAgain0.data?.count}`);

  // ── 18. Booking double-cancel (money-printing) race ─────────────────────
  section('Race — concurrent booking cancellations must refund exactly once');
  const experts = await call('GET', '/web3/experts', { token: HB.token });
  const cheap = experts.data.experts[0];
  const bk1 = await call('POST', `/web3/experts/${cheap._id}/book`, { token: HB.token, body: { hours: 1 } });
  const bk2 = await call('POST', `/web3/experts/${cheap._id}/book`, { token: HW.token, body: { hours: 1 } });
  check('two bookings created (funds the professional pool)', bk1.status === 201 && bk2.status === 201,
    JSON.stringify([bk1.status, bk2.status]));
  const foreignCancel = await call('POST', `/web3/bookings/${bk2.data?.booking?._id}/cancel`, { token: HN.token, body: {} });
  check('foreign booking cancel denied (4xx)', foreignCancel.status >= 400 && foreignCancel.status < 500, `status ${foreignCancel.status}`);

  const hbBefore = await balanceOf(HB.token);
  const cancels = await Promise.all([
    call('POST', `/web3/bookings/${bk1.data.booking._id}/cancel`, { token: HB.token, body: {} }),
    call('POST', `/web3/bookings/${bk1.data.booking._id}/cancel`, { token: HB.token, body: {} }),
  ]);
  const hbAfter = await balanceOf(HB.token);
  check('double-cancel: no 500s', cancels.every((r) => r.status < 500 && r.status !== 0), JSON.stringify(cancels.map((r) => r.status)));
  check('refund paid exactly once (balance restored to pre-booking, never printed)',
    hbAfter === hbBefore + cheap.rateWell, `${hbAfter} vs ${hbBefore + cheap.rateWell}`);

  // ── 19. Concurrent oracle refresh ───────────────────────────────────────
  section('Race — concurrent oracle refreshes');
  const orcs = await Promise.all(Array.from({ length: 4 }, () => call('POST', '/web3/oracle/refresh', { token: HS.token, body: {} })));
  check('4 concurrent oracle refreshes all handled', orcs.every((r) => r.status === 200),
    JSON.stringify(orcs.map((r) => r.status)));

  // ── 20. Oversize storage pin ────────────────────────────────────────────
  section('Oversize privacy-storage pin — bounded, never 500');
  const bigPin = await call('POST', '/web3/storage/pin', { token: HN.token, body: { kind: 'note', data: { blob: 'x'.repeat(901000) } } });
  check('901KB pin rejected cleanly (4xx, not 500)', bigPin.status >= 400 && bigPin.status < 500, `status ${bigPin.status}`);

  // ── 21. Stress burst + integrity sweep ──────────────────────────────────
  section('Stress — 30 parallel reads, finite-value sweep, chain integrity');
  const stressPaths = [
    '/web3/wallet', '/web3/chain?limit=5', '/web3/market/listings', '/web3/rewards/status',
    '/web3/dao/config', '/web3/knowledge', '/web3/trials', '/web3/experts',
    '/web3/oracle/feeds', '/web3/loyalty', '/web3/rewards/nfts', '/web3/health/ledger',
    '/web3/data/shares', '/web3/profile-shares', '/web3/market/orders', '/web3/supply/batches',
  ];
  const burst = await Promise.all(Array.from({ length: 30 }, (_, i) =>
    call('GET', stressPaths[i % stressPaths.length], { token: i % 2 ? HN.token : HS.token })));
  const burstBad = burst.filter((r) => !(r.status > 0 && r.status < 500));
  check('30 mixed parallel reads all healthy', burstBad.length === 0,
    JSON.stringify(burstBad.map((r) => r.status)));

  const sweepListings = (await call('GET', '/web3/market/listings', { token: HN.token })).data.listings;
  const badPrices = sweepListings.filter((l) => !Number.isFinite(l.priceWell));
  check('every listing priceWell is a finite number (no Infinity/NaN stored)', badPrices.length === 0,
    JSON.stringify(badPrices.map((l) => ({ t: l.title, p: l.priceWell }))));

  const sweepW = await walletOf(HN.token);
  check('wallet balances finite after all attacks', Number.isFinite(sweepW.balance) && Number.isFinite(sweepW.staked),
    JSON.stringify({ b: sweepW.balance, s: sweepW.staked }));

  const cv = await call('GET', '/web3/chain/verify', { token: HN.token });
  check('chain still fully verifiable after every race (valid PoW, unbroken hashes)',
    cv.status === 200 && cv.data.valid === true, JSON.stringify(cv.data).slice(0, 160));

  // ── Cleanup ─────────────────────────────────────────────────────────────
  section('Cleanup — remove this run’s accounts, leave real users untouched');
  const cleaned = await purgeProbeData();
  const W2 = require('./models/Web3');
  const leftover = await W2.Wallet.countDocuments({ isSystem: { $ne: true } });
  check('own accounts + orphan wallets purged', cleaned.purged >= 6 && cleaned.orphans >= 0, JSON.stringify(cleaned));
  console.log(`  info  non-system wallets remaining (real users only): ${leftover}`);
}

main()
  .then(async () => {
    await mongoose.disconnect();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`WEB3 GLITCH HUNT RESULT: ${passed} passed, ${failures.length} failed`);
    if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f}`));
    console.log('═'.repeat(70));
    process.exit(failures.length ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('\nWEB3 GLITCH HUNT SCRIPT ERROR:', err.message);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
  });
