const {
  Web3Config,
  DEFAULT_PARAMS,
  Trial,
  Expert,
  OracleFeed,
  Listing,
  SupplyBatch,
} = require('../models/Web3');
const ledger = require('./ledger');
const engine = require('./engine');
const { hashPayload, dayKey, sha256Hex } = require('./crypto');

// ═══════════════════════════════════════════════════════════════════════════
// Genesis bootstrap: idempotent reference data for the Web3 layer.
// Everything here only inserts when its collection is empty, so re-boots and
// fresh clones both converge to the same working state.
// ═══════════════════════════════════════════════════════════════════════════

const SEED_TRIALS = [
  {
    title: 'Vitamin D & Sleep Quality Observational Study',
    sponsor: 'Meridian Nutraceuticals Research',
    phase: 'Phase II',
    description:
      'A 12-week observational study correlating daily vitamin D intake with self-reported sleep quality. Participation shares anonymized intake and assessment data only — consent and data usage are recorded on-chain via smart contract and can be withdrawn at any time.',
    rewardWell: 60,
    spots: 250,
  },
  {
    title: 'Magnesium Glycinate Recovery Trial',
    sponsor: 'Kinetic Health Institute',
    phase: 'Phase I',
    description:
      'Evaluate recovery markers in active adults supplementing with magnesium glycinate for 8 weeks. Your consent record, data scope and withdrawal rights are enforced by an immutable on-chain contract.',
    rewardWell: 45,
    spots: 180,
  },
  {
    title: 'Probiotic Strain Tolerance Registry',
    sponsor: 'Biome Labs Collective',
    phase: 'Registry',
    description:
      'A rolling registry tracking tolerance and adherence across multi-strain probiotic regimens. Opt in with a transparent smart-contract consent that logs exactly which data fields researchers may access.',
    rewardWell: 30,
    spots: 500,
  },
];

const SEED_EXPERTS = [
  {
    name: 'Dr. Elena Marsh',
    specialty: 'Clinical Nutrition',
    title: 'PhD, RD',
    credential: 'Registered Dietitian · License #RD-48213',
    bio: 'Fifteen years designing evidence-based supplement protocols for chronic fatigue and metabolic health.',
    rateWell: 120,
  },
  {
    name: 'Dr. Tobias Reyer',
    specialty: 'Functional Medicine',
    title: 'MD, IFMCP',
    credential: 'Institute for Functional Medicine · Board Certified',
    bio: 'Integrates lab work, gut health and targeted supplementation into personalized care plans.',
    rateWell: 150,
  },
  {
    name: 'Amara Okafor',
    specialty: 'Sports Nutrition',
    title: 'MS, CSCS',
    credential: 'Certified Strength & Conditioning Specialist',
    bio: 'Performance supplementation and periodized nutrition for amateur and elite athletes.',
    rateWell: 90,
  },
  {
    name: 'Dr. Priya Nair',
    specialty: 'Micronutrient Research',
    title: 'MD, MPH',
    credential: 'Preventive Medicine · Published researcher',
    bio: 'Translates the latest micronutrient studies into practical, safe supplement strategies.',
    rateWell: 130,
  },
];

const SEED_ORACLE_FEEDS = [
  { key: 'vitamin-d3-price', label: 'Vitamin D3 5000IU (60ct) market price', unit: 'USD', category: 'pricing', base: 8.4 },
  { key: 'magnesium-glycinate-price', label: 'Magnesium Glycinate (90ct) market price', unit: 'USD', category: 'pricing', base: 12.9 },
  { key: 'omega-3-price', label: 'Omega-3 1000mg (120ct) market price', unit: 'USD', category: 'pricing', base: 15.6 },
  { key: 'well-usd-index', label: 'WELL token index (reference)', unit: 'USD', category: 'market', base: 0.12 },
  { key: 'new-studies-7d', label: 'New supplement studies indexed (7d)', unit: 'studies', category: 'research', base: 42 },
  { key: 'batch-verification-rate', label: 'Batch verification pass rate', unit: '%', category: 'market', base: 99.2 },
];

const SEED_LISTINGS = [
  { title: 'Vitamin D3 + K2 (60 softgels)', brand: 'SunWell Nutrition', category: 'Vitamins', priceWell: 45, stock: 40, description: 'Third-party tested 5000IU D3 with MK-7 K2 for calcium metabolism. GMP certified facility, batch QR on every bottle.' },
  { title: 'Magnesium Glycinate Complex (90 caps)', brand: 'CalmSource Labs', category: 'Minerals', priceWell: 60, stock: 35, description: 'Chelated magnesium glycinate with L-theanine for relaxation and sleep support. Lab-verified purity report on-chain.' },
  { title: 'Triple-Strength Omega-3 (120 softgels)', brand: 'BlueCurrent', category: 'Other', priceWell: 75, stock: 25, description: '2000mg EPA/DHA per serving, IFOS 5-star rated, molecularly distilled. Cold-chain tracked from vessel to doorstep.' },
  { title: 'Daily Greens Superblend (30 servings)', brand: 'Verdant Field', category: 'Herbs', priceWell: 55, stock: 50, description: 'Organic spirulina, chlorella and wheatgrass with digestive enzymes. USDA Organic + Non-GMO verified.' },
  { title: 'Creatine Monohydrate (300g)', brand: 'Kinetic Fuel', category: 'Protein', priceWell: 40, stock: 60, description: 'Micronized Creapure® creatine, unflavored and third-party tested for banned substances.' },
  { title: 'Probiotic 50B CFU (30 caps)', brand: 'Biome Labs', category: 'Probiotics', priceWell: 65, stock: 30, description: '10 clinically studied strains with delayed-release capsules. Shelf stable, no refrigeration.' },
];

// Deterministic daily oracle values — same day, same numbers (auditable).
function seededValue(feed, day) {
  const drift = (parseInt(sha256Hex(`${day}:${feed.key}`).slice(0, 8), 16) % 2000) / 1000; // 0–1.999
  if (feed.unit === '%') return Math.round((feed.base - drift * 0.4) * 10) / 10;
  if (feed.unit === 'studies') return Math.round(feed.base + drift * 6 - 3);
  if (feed.unit === 'USD' && feed.base < 1) return Math.round((feed.base + drift * 0.02) * 1000) / 1000;
  return Math.round((feed.base * (0.96 + drift * 0.03)) * 100) / 10;
}

async function ensureConfig() {
  await Web3Config.findOneAndUpdate(
    { key: 'main' },
    { $setOnInsert: { key: 'main', params: { ...DEFAULT_PARAMS }, updatedBy: 'genesis' } },
    { upsert: true }
  );
}

async function ensureTrials() {
  if ((await Trial.countDocuments()) === 0) await Trial.insertMany(SEED_TRIALS.map((t) => ({ ...t })));
}

async function ensureExperts() {
  if ((await Expert.countDocuments()) === 0) {
    await Expert.insertMany(
      SEED_EXPERTS.map((e) => ({ ...e, address: 'sw_system_expert_pool' }))
    );
  }
}

async function ensureOracleFeeds() {
  const day = dayKey();
  for (const feed of SEED_ORACLE_FEEDS) {
    const existing = await OracleFeed.findOne({ key: feed.key }).lean();
    if (existing) continue;
    const value = seededValue(feed, day);
    const tx = await ledger.append([
      {
        type: 'oracle:publish',
        actor: 'sw:oracle',
        data: { key: feed.key, value, unit: feed.unit, day },
      },
    ]);
    await OracleFeed.create({
      key: feed.key,
      label: feed.label,
      value,
      unit: feed.unit,
      category: feed.category,
      source: 'SuppliWise Oracle Network',
      txHash: tx.txs[0],
      updatedAt: Date.now(),
    });
  }
}

async function ensureListings() {
  if ((await Listing.countDocuments()) === 0) {
    await Listing.insertMany(
      SEED_LISTINGS.map((l) => ({
        ...l,
        seller: engine.SYSTEM_WALLETS.find((w) => w.label.includes('Brands')).address,
        sellerUser: undefined,
        active: true,
        createdAt: Date.now(),
      }))
    );
  }
}

// Demo supply chain: three fully journeyed batches so the QR verification
// page is meaningful on a fresh database.
async function ensureSupplyBatches() {
  if ((await SupplyBatch.countDocuments()) > 0) return;
  const now = Date.now();
  const HOUR = 3600000;
  const mk = async (i, batch) => {
    const code = `SW-${sha256Hex(`batch:${i}`).slice(0, 8).toUpperCase()}`;
    const events = [];
    let cursor = now - batch.ago;
    let prevTx = '';
    for (const step of batch.steps) {
      const tx = await ledger.append([
        {
          type: 'supply:step',
          actor: 'sw:system',
          data: { code, step: step.step, at: cursor, prev: prevTx || undefined },
        },
      ]);
      prevTx = tx.txs[0];
      events.push({
        step: step.step,
        location: step.location,
        note: step.note,
        actorName: step.actor,
        txHash: tx.txs[0],
        blockIndex: tx.index,
        at: cursor,
      });
      cursor += step.gap * HOUR;
    }
    const certs = [];
    for (const cert of batch.certs) {
      const dataHash = hashPayload({ code, ...cert });
      const tx = await ledger.append([
        { type: 'cert:anchor', actor: 'sw:system', data: { code, name: cert.name, issuer: cert.issuer, dataHash } },
      ]);
      certs.push({
        ...cert,
        resultHash: dataHash,
        txHash: tx.txs[0],
        blockIndex: tx.index,
        at: now - batch.ago + HOUR,
      });
    }
    await SupplyBatch.create({
      code,
      productName: batch.productName,
      brand: batch.brand,
      notes: batch.notes,
      events,
      certifications: certs,
      createdAt: now - batch.ago,
    });
  };

  await mk(1, {
    ago: 96 * HOUR,
    productName: 'Vitamin D3 + K2 (60 softgels)',
    brand: 'SunWell Nutrition',
    notes: 'Demo batch — full journey from raw material sourcing to delivery.',
    steps: [
      { step: 'raw-sourcing', location: 'Chandler, AZ, USA', note: 'Lanolin-derived D3 raw material received with supplier COA.', actor: 'SunWell Nutrition', gap: 12 },
      { step: 'manufacturing', location: 'Phoenix, AZ, USA', note: 'Softgels encapsulated and bottle-filled under GMP.', actor: 'SunWell Nutrition', gap: 18 },
      { step: 'lab-testing', location: 'Eurofins Labs, Portland', note: 'Potency assay: 102.4% of label claim. Heavy metals below ICH limits.', actor: 'Eurofins', gap: 20 },
      { step: 'quality-release', location: 'Phoenix, AZ, USA', note: 'QA released after reviewing lab report.', actor: 'SunWell QA', gap: 10 },
      { step: 'distribution', location: 'Memphis, TN, USA', note: 'Palletized shipment scanned onto outbound carrier.', actor: 'SwiftLogix', gap: 24 },
      { step: 'retail', location: 'Austin, TX, USA', note: 'Store receiving scan — seal intact, count verified.', actor: 'Hill Country Market', gap: 16 },
      { step: 'delivered', location: 'Austin, TX, USA', note: 'Consumer delivery confirmed.', actor: 'Carrier', gap: 6 },
    ],
    certs: [
      { type: 'lab-report', name: 'USP Potency & Purity Assay', issuer: 'Eurofins Labs' },
      { type: 'non-gmo', name: 'Non-GMO Project Verified', issuer: 'Non-GMO Project' },
    ],
  });

  await mk(2, {
    ago: 60 * HOUR,
    productName: 'Magnesium Glycinate Complex (90 caps)',
    brand: 'CalmSource Labs',
    notes: 'Demo batch — mid-journey, currently in distribution.',
    steps: [
      { step: 'raw-sourcing', location: 'Tarrytown, NY, USA', note: 'Magnesium glycinate chelate received from amino acid supplier.', actor: 'CalmSource Labs', gap: 10 },
      { step: 'manufacturing', location: 'Edison, NJ, USA', note: 'Capsules bottled with induction seals.', actor: 'CalmSource Labs', gap: 16 },
      { step: 'lab-testing', location: 'Covance, NC, USA', note: 'Identity confirmed by ICP-OES; microbiology pass.', actor: 'Covance', gap: 18 },
      { step: 'quality-release', location: 'Edison, NJ, USA', note: 'Released for sale.', actor: 'CalmSource QA', gap: 8 },
      { step: 'distribution', location: 'Columbus, OH, USA', note: 'In transit to regional DC.', actor: 'Northline Freight', gap: 14 },
    ],
    certs: [{ type: 'third-party', name: 'Informed Sport Certification', issuer: 'Informed Sport' }],
  });

  await mk(3, {
    ago: 30 * HOUR,
    productName: 'Daily Greens Superblend (30 servings)',
    brand: 'Verdant Field',
    notes: 'Demo batch — recently quality-released.',
    steps: [
      { step: 'raw-sourcing', location: 'Salinas, CA, USA', note: 'Organic wheatgrass harvest lot received.', actor: 'Verdant Field', gap: 8 },
      { step: 'manufacturing', location: 'Sacramento, CA, USA', note: 'Spray-dried greens blended and sachet-filled.', actor: 'Verdant Field', gap: 12 },
      { step: 'lab-testing', location: 'Merieux NutriSciences, CA', note: 'Pesticide screen: none detected above LOQ.', actor: 'Merieux', gap: 14 },
      { step: 'quality-release', location: 'Sacramento, CA, USA', note: 'QA approved release.', actor: 'Verdant QA', gap: 6 },
    ],
    certs: [
      { type: 'organic', name: 'USDA Organic Certified', issuer: 'USDA' },
      { type: 'non-gmo', name: 'Non-GMO Project Verified', issuer: 'Non-GMO Project' },
    ],
  });
}

// Boot hook: ledger genesis + reference data. Safe to call repeatedly; never
// throws (a seed hiccup must not block the API from starting).
let bootstrapPromise = null;
function bootstrap() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    await ledger.init();
    await ensureConfig();
    await engine.ensureSystemWallets();
    await Promise.all([ensureTrials(), ensureExperts(), ensureListings()]);
    await ensureOracleFeeds();
    await ensureSupplyBatches();
    console.log(`[web3] chain ready at height ${ledger.height} (difficulty ${ledger.difficulty})`);
  })().catch((err) => {
    console.error('[web3] bootstrap failed:', err.message);
    bootstrapPromise = null;
    throw err;
  });
  return bootstrapPromise;
}

module.exports = {
  bootstrap,
  ensureConfig,
  ensureTrials,
  ensureExperts,
  ensureOracleFeeds,
  ensureListings,
  ensureSupplyBatches,
  seededValue,
  SEED_ORACLE_FEEDS,
};
