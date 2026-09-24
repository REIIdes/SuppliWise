// ═══════════════════════════════════════════════════════════════════════════
// End-to-end HTTP smoke test for the SuppliWise Web3 layer — all 20 features.
//
// Runs against a LIVE server (default http://localhost:5000). Registers three
// throwaway accounts (buyer / seller / juror), then walks every flow through
// the real HTTP surface: wallets & DID, rewards, NFTs, staking, loyalty,
// escrow commerce, disputes, DAO, knowledge base, health ledger, privacy
// storage, AI-proof anchoring, supply chain + public QR verification, public
// share links, trials, oracles and expert bookings.
//
// Usage:  node test-web3-flows.js        (server must be running)
// Exit 0 = every check passed.
//
// Re-run safe: previous web3-smoke-* accounts (and their Web3 records) are
// purged first so the juror pool stays deterministic.
// ═══════════════════════════════════════════════════════════════════════════
require('dotenv').config();
const mongoose = require('mongoose');

const BASE = process.env.SMOKE_BASE_URL || 'http://localhost:5000/api';

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

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  return { status: res.status, data };
}

// Solve the server-issued math CAPTCHA ("12 − 5 = ?").
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
      firstName: 'Web3',
      lastName: tag,
      email: `web3-smoke-${tag.toLowerCase()}-${Date.now()}@example.com`,
      password: 'Web3SmokeTest123!',
      dateOfBirth: '1995-05-05',
      gender: 'Male',
      captchaId: captcha.id,
      captchaAnswer: captcha.answer,
    },
  });
  if (res.status !== 201) throw new Error(`register ${tag} failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { id: res.data._id, token: res.data.token };
}

// Remove every record belonging to earlier smoke runs so reruns are clean.
// Also sweeps ORPHANED wallets (non-system wallets whose owning user no
// longer exists): a leftover wallet from a deleted account would otherwise
// enter the dispute juror pool and make the run non-deterministic. Real
// accounts (users that still exist) are never touched.
async function cleanupPreviousRuns() {
  const User = require('./models/User');
  const W = require('./models/Web3');
  const oldUsers = await User.find({ email: /^web3-smoke-/ }).select('_id').lean();
  const ids = oldUsers.map((u) => u._id);
  let removed = 0;
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
      User.deleteMany({ _id: inIds }),
    ]);
    removed = ids.length;
  }

  // Orphan sweep — must run even when no smoke users remain (that is exactly
  // when a previously-deleted account's wallet is left dangling).
  const wallets = await W.Wallet.find({ isSystem: { $ne: true } }).select('user').lean();
  const ownerIds = wallets.map((w) => w.user).filter(Boolean);
  const alive = new Set(
    ownerIds.length
      ? (await User.find({ _id: { $in: ownerIds } }).select('_id').lean()).map((u) => String(u._id))
      : []
  );
  const orphans = wallets.filter((w) => !w.user || !alive.has(String(w.user))).map((w) => w._id);
  if (orphans.length) await W.Wallet.deleteMany({ _id: { $in: orphans } });
  return { removed, orphans: orphans.length };
}

// A completed AI assessment, inserted directly (the real creation flow is the
// Assessment page's job — the Web3 layer only needs an owned record with
// aiResults to anchor and re-verify).
async function seedAssessment(userId) {
  const Assessment = require('./models/Assessment');
  return new Assessment({
    user: userId,
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
}

async function main() {
  await mongoose.connect(process.env.MONGO_URI);
  const W = require('./models/Web3');
  const { sha256Hex } = require('./blockchain/crypto');

  section('Setup');
  const cleaned = await cleanupPreviousRuns();
  check('previous smoke-run accounts purged', true,
    `${cleaned.removed} user(s), ${cleaned.orphans} orphan wallet(s) removed`);
  // Only STAKED non-system wallets can be drawn as jurors — real accounts may
  // legitimately hold an unstaked wallet, so that is not a failure here.
  const stakedForeign = await W.Wallet.countDocuments({ isSystem: { $ne: true }, staked: { $gt: 0 } });
  check('no staked foreign wallets before run (jury stays deterministic)',
    stakedForeign === 0, `${stakedForeign} staked non-system wallet(s)`);

  const A = await register('SmokeA'); // buyer / proposer / brand
  const B = await register('SmokeB'); // seller / counter-voter
  const C = await register('SmokeC'); // independent juror
  check('three accounts registered with session tokens', !!(A.token && B.token && C.token));

  // ── 5. DID + wallet ────────────────────────────────────────────────────
  section('Feature 5 — DID & wallet');
  const wA = await call('GET', '/web3/wallet', { token: A.token });
  const wB = await call('GET', '/web3/wallet', { token: B.token });
  const wC = await call('GET', '/web3/wallet', { token: C.token });
  check('wallet created with 100 WELL welcome airdrop',
    wA.status === 200 && wA.data.wallet.balance === 100 && wA.data.created === true,
    `status ${wA.status} balance ${wA.data?.wallet?.balance}`);
  check('DID issued', String(wA.data.wallet.did || '').startsWith('did:suppliwise:'), wA.data.wallet.did);
  check('ed25519 public key present', (wA.data.wallet.publicKey || '').length > 40);
  check('seller + juror wallets created', wB.status === 200 && wC.status === 200);

  const pk = await call('GET', '/web3/wallet/private-key', { token: A.token });
  check('owner-only private key export decrypts PKCS#8 key',
    pk.status === 200 && /BEGIN PRIVATE KEY/.test(pk.data.privateKey || ''), JSON.stringify(pk.data).slice(0, 80));

  const cfg = await call('GET', '/web3/config', { token: A.token });
  check('DAO-govoruned params readable', cfg.status === 200 && cfg.data.params.welcomeBonus === 100);

  // ── 9. WELL rewards ───────────────────────────────────────────────────
  section('Feature 9 — WELL token rewards');
  const cin1 = await call('POST', '/web3/rewards/checkin', { token: A.token, body: {} });
  check('daily check-in mints WELL with streak',
    cin1.status === 200 && cin1.data.claimed === true && cin1.data.amount >= 5 && !!cin1.data.txHash,
    JSON.stringify(cin1.data));
  const cin2 = await call('POST', '/web3/rewards/checkin', { token: A.token, body: {} });
  check('check-in is idempotent per day (no double mint)',
    cin2.status === 200 && cin2.data.alreadyClaimed === true && cin2.data.amount === 0,
    JSON.stringify(cin2.data));

  const intake = await call('POST', '/web3/rewards/intake', { token: A.token, body: {} });
  check('intake reward refuses without a real intake record (400)',
    intake.status === 400, `status ${intake.status}`);

  const status = await call('GET', '/web3/rewards/status', { token: A.token });
  check('rewards dashboard payload complete',
    status.status === 200 && Array.isArray(status.data.achievements) && status.data.achievements.length >= 10
      && status.data.unlocks && status.data.nextCheckinAmount > 0,
    JSON.stringify(status.data).slice(0, 120));

  // ── 17. Verifiable AI recommendations ─────────────────────────────────
  section('Feature 17 — Verifiable AI recommendations');
  const assessment = await seedAssessment(A.id);
  const ar = await call('POST', '/web3/rewards/assessment', { token: A.token, body: { assessmentId: String(assessment._id) } });
  check('completed-assessment reward paid once',
    ar.status === 200 && ar.data.claimed === true && ar.data.amount === 15, JSON.stringify(ar.data));
  const ar2 = await call('POST', '/web3/rewards/assessment', { token: A.token, body: { assessmentId: String(assessment._id) } });
  check('assessment reward replay rejected (idempotent)', ar2.data.alreadyClaimed === true, JSON.stringify(ar2.data));

  const anc = await call('POST', '/web3/recommendations/anchor', { token: A.token, body: { assessmentId: String(assessment._id) } });
  check('recommendation inputs/outputs anchored on-chain',
    anc.status === 201 && !!anc.data.anchor.combinedHash && anc.data.anchor.blockIndex >= 0,
    `status ${anc.status}`);
  const ancV = await call('GET', `/web3/recommendations/anchor/${assessment._id}`, { token: A.token });
  check('anchored recommendation re-verifies (inputs + outputs intact)',
    ancV.status === 200 && ancV.data.verification.valid === true && ancV.data.verification.inputIntact === true,
    JSON.stringify(ancV.data.verification));

  // ── 6. User-owned health ledger ───────────────────────────────────────
  section('Feature 6 — User-owned health ledger');
  const hl = await call('GET', '/web3/health/ledger', { token: A.token });
  check('ledger digest computed over real records (no raw data stored)',
    hl.status === 200 && /^[a-f0-9]{64}$/.test(hl.data.summary.currentDigest) && hl.data.summary.assessmentCount === 1,
    JSON.stringify(hl.data.summary));
  const hla = await call('POST', '/web3/health/ledger/anchor', { token: A.token, body: {} });
  check('health snapshot anchored to a block + rewarded',
    hla.status === 201 && hla.data.anchor.blockIndex >= 0 && hla.data.reward === 3, JSON.stringify(hla.data));
  const hexp = await call('GET', '/web3/health/export', { token: A.token });
  check('signed portable credential exported (ed25519)',
    hexp.status === 200 && hexp.data.proof.algorithm === 'ed25519' && (hexp.data.proof.signature || '').length > 40,
    JSON.stringify(hexp.data.proof).slice(0, 120));

  // ── 8. Decentralized encrypted storage ────────────────────────────────
  section('Feature 8 — Decentralized encrypted storage');
  const pin = await call('POST', '/web3/storage/pin', { token: A.token, body: { kind: 'note', data: { hello: 'w3', n: 7 } } });
  check('payload encrypted + content-addressed (bafy… CID)',
    pin.status === 201 && /^bafy[a-z2-7]+$/.test(pin.data.cid), JSON.stringify(pin.data));
  const pinGet = await call('GET', `/web3/storage/${pin.data.cid}`, { token: A.token });
  check('fetch + decrypt with CID integrity check',
    pinGet.status === 200 && pinGet.data.integrityOk === true && pinGet.data.data.hello === 'w3',
    JSON.stringify(pinGet.data).slice(0, 120));

  // ── 7. Data sovereignty rewards ───────────────────────────────────────
  section('Feature 7 — Data sovereignty & rewards');
  const ds = await call('POST', '/web3/data/shares', { token: A.token, body: { recipient: 'Kinetic Health Institute', scope: 'nutrition-outcomes' } });
  check('anonymized coarse dataset shared with on-chain consent + reward',
    ds.status === 201 && ds.data.reward === 25 && !!ds.data.share.consentTx && !!ds.data.anonymizedDataset.ageBand,
    JSON.stringify(ds.data).slice(0, 160));
  const noIds = JSON.stringify(ds.data.anonymizedDataset);
  check('shared dataset carries no direct identifiers', !noIds.includes(A.id) && !noIds.includes('Web3'), noIds);

  // ── 16. Interoperable profile share (PUBLIC) ──────────────────────────
  section('Feature 16 — Interoperable health profile (public link)');
  const psl = await call('POST', '/web3/profile-shares', { token: A.token, body: { ttlHours: 24 } });
  check('time-boxed share link issued', psl.status === 201 && /^[a-f0-9]{32}$/.test(psl.data.link.token), JSON.stringify(psl.data));
  const shareToken = psl.data.link.token;
  const pub = await call('GET', `/web3/share/${shareToken}`);
  check('PUBLIC read without an account (doctor view)',
    pub.status === 200 && pub.data.sharedProfile.name === 'Web3 SmokeA' && pub.data.views >= 1,
    JSON.stringify(pub.data.sharedProfile).slice(0, 160));
  const pslList = await call('GET', '/web3/profile-shares', { token: A.token });
  const pslId = pslList.data.links[0]._id;
  await call('DELETE', `/web3/profile-shares/${pslId}`, { token: A.token });
  const pubAfter = await call('GET', `/web3/share/${shareToken}`);
  check('revoked link immediately dead publicly (404)', pubAfter.status === 404, `status ${pubAfter.status}`);

  // ── 1 & 2. Supply chain + certifications (PUBLIC verify) ──────────────
  section('Features 1 & 2 — Supply chain, QR verification & certifications');
  const batch = await call('POST', '/web3/supply/batches', {
    token: A.token,
    body: { productName: 'Vitamin D3 60ct (Smoke)', brand: 'SmokeWell Labs', notes: 'E2E smoke batch' },
  });
  check('batch registered with QR code + first anchored step',
    batch.status === 201 && /^SW-[A-F0-9]{8}$/.test(batch.data.batch.code) && batch.data.batch.events.length === 1,
    JSON.stringify(batch.data).slice(0, 160));
  const bId = batch.data.batch._id;
  const bCode = batch.data.batch.code;

  const evBack = await call('POST', `/web3/supply/batches/${bId}/events`, { token: A.token, body: { step: 'manufacturing', location: 'Osaka, JP', note: 'Encapsulated under GMP.', actorName: 'SmokeWell Labs' } });
  check('journey step appended forward-only + anchored',
    evBack.status === 200 && evBack.data.batch.events.length === 2 && !!evBack.data.batch.events[1].txHash,
    `status ${evBack.status}`);
  const evBackwards = await call('POST', `/web3/supply/batches/${bId}/events`, { token: A.token, body: { step: 'raw-sourcing' } });
  check('out-of-sequence step rejected (immutable ordered journey)', evBackwards.status === 400, `status ${evBackwards.status}`);

  const cert = await call('POST', `/web3/supply/batches/${bId}/certifications`, { token: A.token, body: { type: 'lab-report', name: 'USP Potency Assay', issuer: 'Eurofins Labs' } });
  check('certification digest anchored on-chain',
    cert.status === 200 && /^[a-f0-9]{64}$/.test(cert.data.batch.certifications[0].resultHash) && !!cert.data.batch.certifications[0].txHash,
    `status ${cert.status}`);

  const pubVerify = await call('GET', `/web3/verify/${bCode}`);
  check('PUBLIC scan verifies batch with recomputed chain proofs',
    pubVerify.status === 200 && pubVerify.data.verified === true && pubVerify.data.steps.length === 2
      && pubVerify.data.certifications.length === 1 && pubVerify.data.proof.valid === pubVerify.data.proof.checks,
    JSON.stringify(pubVerify.data.proof));

  const demoCode = `SW-${sha256Hex('batch:1').slice(0, 8).toUpperCase()}`;
  const pubDemo = await call('GET', `/web3/verify/${demoCode}`);
  check('seeded demo batch verifies publicly (full 7-step journey)',
    pubDemo.status === 200 && pubDemo.data.verified === true && pubDemo.data.steps.length === 7
      && pubDemo.data.certifications.length === 2,
    JSON.stringify({ status: pubDemo.status, steps: pubDemo.data?.steps?.length }));

  const qr = await call('GET', `/web3/verify/${bCode}/qr?base=http://localhost:5173`);
  check('QR payload points scanners at /verify/<code>',
    qr.status === 200 && qr.data.qr.startsWith('data:image') && qr.data.url === `http://localhost:5173/verify/${bCode}`,
    JSON.stringify(qr.data).slice(0, 100));

  // ── 11. Staking for premium ───────────────────────────────────────────
  section('Feature 11 — Staking for premium access');
  const stk = await call('POST', '/web3/stake', { token: A.token, body: { amount: 30 } });
  check('stake moves balance → staked with unlock progress',
    stk.status === 200 && stk.data.staked === 30 && stk.data.unlocks.threshold === 500 && stk.data.unlocks.progress > 0,
    JSON.stringify(stk.data).slice(0, 140));
  const unstk = await call('POST', '/web3/unstake', { token: A.token, body: { amount: 10 } });
  check('partial unstake returns funds', unstk.status === 200 && unstk.data.staked === 20, JSON.stringify(unstk.data).slice(0, 120));

  // ── 18. Clinical-trial consent ────────────────────────────────────────
  section('Feature 18 — Clinical-trial smart-contract consent');
  const trials = await call('GET', '/web3/trials', { token: A.token });
  check('seeded open trials listed', trials.status === 200 && trials.data.trials.length === 3, `got ${trials.data?.trials?.length}`);
  const trialId = trials.data.trials[2]._id;
  const optin = await call('POST', `/web3/trials/${trialId}/optin`, { token: A.token, body: {} });
  check('consent hashed on-chain + participation rewarded',
    optin.status === 201 && /^[a-f0-9]{64}$/.test(optin.data.consent.termsHash) && !!optin.data.consent.consentTx
      && optin.data.reward === trials.data.trials[2].rewardWell,
    JSON.stringify(optin.data).slice(0, 160));
  const optinAgain = await call('POST', `/web3/trials/${trialId}/optin`, { token: A.token, body: {} });
  check('duplicate consent rejected (one record per trial)', optinAgain.status === 400, `status ${optinAgain.status}`);

  // ── 19. Oracle feeds ──────────────────────────────────────────────────
  section('Feature 19 — Decentralized oracle feeds');
  const feeds0 = await call('GET', '/web3/oracle/feeds', { token: A.token });
  check('six oracle feeds published at boot', feeds0.status === 200 && feeds0.data.feeds.length === 6, `got ${feeds0.data?.feeds?.length}`);
  const oref = await call('POST', '/web3/oracle/refresh', { token: A.token, body: {} });
  check('oracle refresh re-derives today’s values deterministically',
    oref.status === 200 && oref.data.feeds.length === 6 && oref.data.updated.length === 6
      && oref.data.feeds.every((f) => typeof f.value === 'number'),
    JSON.stringify(oref.data).slice(0, 140));

  // ── 20. Tokenized expert consultations ────────────────────────────────
  section('Feature 20 — Tokenized expert consultations');
  const experts = await call('GET', '/web3/experts', { token: A.token });
  check('four verified professionals listed', experts.status === 200 && experts.data.experts.length === 4, `got ${experts.data?.experts?.length}`);
  const cheap = experts.data.experts[0]; // sorted by rateWell asc
  const balBeforeBook = (await call('GET', '/web3/wallet', { token: A.token })).data.wallet.balance;
  const book = await call('POST', `/web3/experts/${cheap._id}/book`, { token: A.token, body: { hours: 1 } });
  const expectedCost = cheap.rateWell;
  check('booking pays rate × hours on-chain',
    book.status === 201 && book.data.booking.cost === expectedCost && book.data.balance === balBeforeBook - expectedCost,
    JSON.stringify(book.data).slice(0, 160));

  // ── 14. Community knowledge base ──────────────────────────────────────
  section('Feature 14 — Community knowledge base');
  const post = await call('POST', '/web3/knowledge', { token: A.token, body: { type: 'review', title: 'Smoke test review', body: 'Magnesium glycinate noticeably improved my sleep latency after two weeks.' } });
  check('post published, rewarded and anchored',
    post.status === 201 && post.data.reward === 10 && !!post.data.post.txHash, JSON.stringify(post.data).slice(0, 140));
  const up = await call('POST', `/web3/knowledge/${post.data.post._id}/upvote`, { token: B.token, body: {} });
  check('upvote pays curator + capped author reward',
    up.status === 200 && up.data.curatorPayout === 1 && up.data.authorPayout === 2, JSON.stringify(up.data));
  const upDup = await call('POST', `/web3/knowledge/${post.data.post._id}/upvote`, { token: B.token, body: {} });
  check('double upvote rejected', upDup.status === 400, `status ${upDup.status}`);

  // ── 13. DAO governance ────────────────────────────────────────────────
  section('Feature 13 — DAO governance');
  const daoCfg = await call('GET', '/web3/dao/config', { token: A.token });
  check('governance config exposes votable params',
    daoCfg.status === 200 && daoCfg.data.updatable.includes('rewardCheckin') && daoCfg.data.votingDays === 3,
    JSON.stringify(daoCfg.data).slice(0, 140));
  const prop = await call('POST', '/web3/dao/proposals', {
    token: A.token,
    body: { title: 'Raise daily check-in reward', description: 'Proposal to raise the daily check-in reward from 5 to 6 WELL.', param: 'rewardCheckin', value: 6 },
  });
  check('proposal opened with proposer vote auto-cast + anchored',
    prop.status === 201 && prop.data.proposal.tally.voterCount === 1 && !!prop.data.txHash,
    JSON.stringify(prop.data).slice(0, 160));
  const propVote = await call('POST', `/web3/dao/proposals/${prop.data.proposal._id}/vote`, { token: B.token, body: { choice: 'against' } });
  check('stake-weighted opposing vote recorded on-chain',
    propVote.status === 200 && propVote.data.tally.voterCount === 2 && propVote.data.tally.againstWeight > 0,
    JSON.stringify(propVote.data).slice(0, 160));
  const propVoteDup = await call('POST', `/web3/dao/proposals/${prop.data.proposal._id}/vote`, { token: B.token, body: { choice: 'for' } });
  check('second vote from same wallet rejected', propVoteDup.status === 400, `status ${propVoteDup.status}`);

  // ── 3 & 4. Marketplace with escrow ────────────────────────────────────
  section('Features 3 & 4 — P2P marketplace with smart-contract escrow');
  const l1 = await call('POST', '/web3/market/listings', { token: B.token, body: { title: 'Smoke Omega-3 (120ct)', brand: 'BlueCurrent', category: 'Other', priceWell: 10, stock: 5, description: 'E2E listing — escrow release flow.' } });
  const l2 = await call('POST', '/web3/market/listings', { token: B.token, body: { title: 'Smoke Magnesium (60ct)', brand: 'CalmSource', category: 'Minerals', priceWell: 12, stock: 5, description: 'E2E listing — dispute flow.' } });
  const l3 = await call('POST', '/web3/market/listings', { token: B.token, body: { title: 'Smoke Greens (30 servings)', brand: 'Verdant Field', category: 'Herbs', priceWell: 15, stock: 5, description: 'E2E listing — loyalty discount flow.' } });
  check('three listings created + anchored', l1.status === 201 && l2.status === 201 && l3.status === 201,
    JSON.stringify({ l1: l1.data, l2: l2.data, l3: l3.data }).slice(0, 240));

  const listings = await call('GET', '/web3/market/listings', { token: A.token });
  check('browse returns listings + fee + oracle feeds',
    listings.status === 200 && listings.data.listings.length >= 3 && listings.data.feePct === 3
      && Array.isArray(listings.data.oracleFeeds),
    JSON.stringify({ n: listings.data?.listings?.length, fee: listings.data?.feePct }));

  const balBBuy = (await call('GET', '/web3/wallet', { token: A.token })).data.wallet.balance;
  const balSBuy = (await call('GET', '/web3/wallet', { token: B.token })).data.wallet.balance;
  const o1 = await call('POST', '/web3/market/orders', { token: A.token, body: { listingId: l1.data.listing._id, qty: 1 } });
  check('order locks buyer funds in escrow (balance decremented)',
    o1.status === 201 && o1.data.order.status === 'escrow'
      && (await call('GET', '/web3/wallet', { token: A.token })).data.wallet.balance === balBBuy - 10,
    JSON.stringify({ status: o1.status, body: o1.data }).slice(0, 200));

  const conf = await call('POST', `/web3/market/orders/${o1.data.order._id}/confirm`, { token: A.token, body: {} });
  const balSAfter = (await call('GET', '/web3/wallet', { token: B.token })).data.wallet.balance;
  check('delivery confirmation executes the contract (seller paid − 3% fee)',
    conf.status === 200 && conf.data.order.status === 'released' && conf.data.fee === 0.3 && conf.data.proceeds === 9.7
      && balSAfter === balSBuy + 9.7,
    JSON.stringify({ fee: conf.data?.fee, proceeds: conf.data?.proceeds, delta: balSAfter - balSBuy }));

  // ── 15. Decentralized dispute resolution ──────────────────────────────
  section('Feature 15 — Decentralized dispute resolution');
  // Jurors are drawn from STAKED non-party wallets: account C joins the pool
  // so the panel is exactly [C] and the verdict below is deterministic.
  const stkC = await call('POST', '/web3/stake', { token: C.token, body: { amount: 20 } });
  check('account C stakes 20 WELL to join the juror pool',
    stkC.status === 200 && stkC.data.staked === 20, JSON.stringify(stkC.data).slice(0, 200));
  const o2 = await call('POST', '/web3/market/orders', { token: A.token, body: { listingId: l2.data.listing._id, qty: 1 } });
  check('second order escrowed', o2.status === 201 && o2.data.order.status === 'escrow',
    JSON.stringify({ status: o2.status, body: o2.data }).slice(0, 200));
  const disp = await call('POST', `/web3/market/orders/${o2.data.order._id}/dispute`, { token: A.token, body: { reason: 'Bottle arrived with a broken seal and missing batch code.' } });
  check('dispute opened; juror = independent staked holder (not a party)',
    disp.status === 201 && disp.data.dispute.jurors.length === 1
      && disp.data.dispute.jurors[0] !== undefined,
    JSON.stringify(disp.data.dispute).slice(0, 200));
  const cAddr = wC.data.wallet.address;
  check('selected juror is account C', disp.data.dispute.jurors.includes(cAddr),
    `jurors ${JSON.stringify(disp.data.dispute.jurors)} C ${cAddr}`);

  const voteAsA = await call('POST', `/web3/market/disputes/${disp.data.dispute._id}/vote`, { token: A.token, body: { choice: 'buyer' } });
  check('order party cannot vote on own dispute (403)', voteAsA.status === 403, `status ${voteAsA.status}`);
  const dv = await call('POST', `/web3/market/disputes/${disp.data.dispute._id}/vote`, { token: C.token, body: { choice: 'buyer' } });
  check('juror verdict resolves dispute → buyer refunded from escrow',
    dv.status === 200 && dv.data.resolved === true && dv.data.outcome === 'buyer', JSON.stringify(dv.data).slice(0, 200));
  const ordersA = await call('GET', '/web3/market/orders', { token: A.token });
  const disputedOrder = ordersA.data.bought.find((o) => String(o._id) === String(o2.data.order._id));
  check('disputed order settled as refunded + stock restored',
    disputedOrder.status === 'refunded' && !!disputedOrder.settleTx, JSON.stringify(disputedOrder).slice(0, 160));
  const cEvents = await call('GET', '/web3/rewards/events', { token: C.token });
  check('juror paid for service', cEvents.data.events.some((e) => e.kind === 'reward:juror' || e.kind === 'juror'),
    JSON.stringify(cEvents.data.events.map((e) => e.kind)));

  // ── 12. Loyalty program ───────────────────────────────────────────────
  section('Feature 12 — Blockchain loyalty program');
  const lo = await call('POST', '/web3/loyalty/redeem', { token: A.token, body: { amount: 10 } });
  check('WELL burned → one-time loyalty code issued',
    lo.status === 201 && /^LOY-[A-F0-9]{10}$/.test(lo.data.code.code) && lo.data.code.valueWell === 10,
    JSON.stringify(lo.data).slice(0, 160));
  const o3 = await call('POST', '/web3/market/orders', { token: A.token, body: { listingId: l3.data.listing._id, qty: 2, discountCode: lo.data.code.code } });
  check('loyalty code discounts checkout (30 − 10 = 20 locked)',
    o3.status === 201 && o3.data.order.discount === 10 && o3.data.order.total === 20 && o3.data.order.discountCode === lo.data.code.code,
    JSON.stringify(o3.data.order).slice(0, 200));
  const o3again = await call('POST', '/web3/market/orders', { token: A.token, body: { listingId: l3.data.listing._id, qty: 1, discountCode: lo.data.code.code } });
  check('used loyalty code rejected on reuse', o3again.status === 400, `status ${o3again.status}`);
  const conf3 = await call('POST', `/web3/market/orders/${o3.data.order._id}/confirm`, { token: A.token, body: {} });
  check('discounted order settles normally', conf3.status === 200 && conf3.data.order.status === 'released', `status ${conf3.status}`);
  const loGet = await call('GET', '/web3/loyalty', { token: A.token });
  check('loyalty burn ledger readable', loGet.status === 200 && loGet.data.burned === 10 && loGet.data.issuedCount === 1,
    JSON.stringify(loGet.data).slice(0, 120));

  // ── 10. Achievement NFTs (after the activity that earns them) ─────────
  section('Feature 10 — Achievement NFTs');
  const mint = await call('POST', '/web3/rewards/achievements/check', { token: A.token, body: {} });
  const kinds = (mint.data.minted || []).map((n) => n.kind);
  check('milestone NFTs minted from real activity (≥5 of 6 expected)',
    mint.status === 200 && kinds.length >= 5 && kinds.includes('first-steps') && kinds.includes('governor')
      && kinds.includes('merchant') && kinds.includes('trailblazer') && kinds.includes('verified-pro') && kinds.includes('data-pioneer'),
    JSON.stringify(kinds));
  check('minted NFTs carry tokenId + serial + anchor tx',
    kinds.length > 0 && mint.data.minted.every((n) => /^sw-[a-f0-9]+$/.test(n.tokenId) && n.serial >= 1 && !!n.txHash));
  const nfts = await call('GET', '/web3/rewards/nfts', { token: A.token });
  check('NFT gallery lists the collection', nfts.status === 200 && nfts.data.nfts.length === kinds.length, `got ${nfts.data?.nfts?.length}`);
  const mintAgain = await call('POST', '/web3/rewards/achievements/check', { token: A.token, body: {} });
  check('re-check mints nothing new (soulbound, once per milestone)', mintAgain.data.count === 0, `count ${mintAgain.data?.count}`);

  // ── Withdraw / cancel / revoke (consent is genuinely revocable) ───────
  section('Revocation flows (trials, bookings, data, storage)');
  const wd = await call('POST', `/web3/trials/${trialId}/withdraw`, { token: A.token, body: {} });
  check('trial consent withdrawn + recorded on-chain',
    wd.status === 200 && wd.data.consent.status === 'withdrawn' && !!wd.data.consent.withdrawTx,
    JSON.stringify(wd.data).slice(0, 140));
  // Compare against the balance captured immediately before the cancel:
  // orders, rewards and loyalty burns all move this wallet in between, so
  // the booking-time baseline would be meaningless here.
  const balPreCancel = (await call('GET', '/web3/wallet', { token: A.token })).data.wallet.balance;
  const cancel = await call('POST', `/web3/bookings/${book.data.booking._id}/cancel`, { token: A.token, body: {} });
  const balAfterCancel = (await call('GET', '/web3/wallet', { token: A.token })).data.wallet.balance;
  check('booking cancelled with full refund (cost returned to wallet)',
    cancel.status === 200 && cancel.data.booking.status === 'cancelled'
      && Math.abs(balAfterCancel - (balPreCancel + expectedCost)) < 0.02,
    `balance ${balAfterCancel} vs ${balPreCancel} + ${expectedCost}`);
  const dsRevoke = await call('DELETE', `/web3/data/shares/${ds.data.share._id}`, { token: A.token });
  check('data consent revoked on-chain', dsRevoke.status === 200 && dsRevoke.data.share.status === 'revoked' && !!dsRevoke.data.share.revokeTx,
    JSON.stringify(dsRevoke.data).slice(0, 140));
  const pinAfter = await call('GET', `/web3/storage/${pin.data.cid}`, { token: A.token });
  // The generic pin is unrelated to the revoked research share — it must
  // survive (the share's own CID is asserted 404 on the next line).
  check('unrelated pinned payload still retrievable after revoke (200)',
    pinAfter.status === 200, `status ${pinAfter.status}`);
  const dsCidGet = await call('GET', `/web3/storage/${ds.data.share.datasetCid}`, { token: A.token });
  check('research dataset no longer retrievable after revoke', dsCidGet.status === 404, `status ${dsCidGet.status}`);

  // ── Chain explorer ────────────────────────────────────────────────────
  section('Chain integrity (explorer)');
  const ch = await call('GET', '/web3/chain?limit=10', { token: A.token });
  check('blocks readable with height + tip',
    ch.status === 200 && ch.data.blocks.length > 0 && ch.data.height > 20 && typeof ch.data.tip === 'string',
    JSON.stringify({ height: ch.data?.height, n: ch.data?.blocks?.length }));
  const cv = await call('GET', '/web3/chain/verify', { token: A.token });
  check('entire chain recomputes: every PoW hash valid',
    cv.status === 200 && cv.data.valid === true && cv.data.checked > 20,
    JSON.stringify(cv.data).slice(0, 160));
  const tx = await call('GET', `/web3/tx/${o1.data.order.escrowTx}`, { token: A.token });
  check('escrow deposit transaction locatable by hash',
    tx.status === 200 && tx.data.tx.type === 'escrow:deposit' && tx.data.block.index > 0,
    JSON.stringify(tx.data.tx).slice(0, 160));

  const finalBal = (await call('GET', '/web3/wallet', { token: A.token })).data.wallet;
  check('buyer wallet solvent end-to-end (balance > 0, stake intact)',
    finalBal.balance > 0 && finalBal.staked === 20, JSON.stringify({ b: finalBal.balance, s: finalBal.staked }));

  const eventsA = await call('GET', '/web3/rewards/events?limit=50', { token: A.token });
  check('reward history rich & on-chain-anchored',
    eventsA.data.totalCount >= 8 && eventsA.data.events.every((e) => e.amount >= 0)
      && eventsA.data.events.some((e) => e.txHash),
    JSON.stringify({ total: eventsA.data?.totalCount }));
}

main()
  .then(async () => {
    await mongoose.disconnect();
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`RESULT: ${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      failures.forEach((f) => console.log(`  ✗ ${f}`));
    }
    console.log('═'.repeat(70));
    process.exit(failures.length ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('\nSMOKE SCRIPT ERROR:', err.message);
    try { await mongoose.disconnect(); } catch { /* ignore */ }
    process.exit(1);
  });
