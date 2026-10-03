import { BASE_URL, getToken, parseJSON } from '../api';

// ═══════════════════════════════════════════════════════════════════════════
// Web3 API client — every call into the SuppliWise blockchain layer.
// Mirrors api.js conventions: auth header from the tab session, hard
// timeouts, server messages surfaced verbatim, session teardowns (401 +
// SESSION_* code) left to api.js's global handling.
// ═══════════════════════════════════════════════════════════════════════════

const w3Fetch = async (path, options = {}, timeoutMs = 30000) => {
  const token = getToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options.headers || {}),
      },
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Please try again.', { cause: err });
    }
    throw new Error('Cannot reach the server. Check your connection and that the backend is running.', { cause: err });
  }
  clearTimeout(timer);
  const data = await parseJSON(res);
  if (!res.ok) {
    const err = new Error((data && data.message) || 'Something went wrong. Please try again.');
    err.status = res.status;
    err.code = data && data.code;
    throw err;
  }
  return data;
};

const body = (payload) => ({ method: 'POST', body: JSON.stringify(payload || {}) });

// ── Wallet, identity & chain explorer ─────────────────────────────────────
export const getWallet = () => w3Fetch('/web3/wallet');
export const exportWalletKey = () => w3Fetch('/web3/wallet/private-key');
export const getChain = (limit = 25, before = null) =>
  w3Fetch(`/web3/chain?limit=${limit}${before != null ? `&before=${before}` : ''}`);
export const verifyChain = () => w3Fetch('/web3/chain/verify');
export const getTx = (hash) => w3Fetch(`/web3/tx/${encodeURIComponent(hash)}`);
export const getWeb3Config = () => w3Fetch('/web3/config');

// ── Supply chain & certifications ─────────────────────────────────────────
export const listBatches = () => w3Fetch('/web3/supply/batches');
export const createBatch = (payload) => w3Fetch('/web3/supply/batches', body(payload));
export const addBatchEvent = (batchId, payload) =>
  w3Fetch(`/web3/supply/batches/${batchId}/events`, body(payload));
export const addBatchCertification = (batchId, payload) =>
  w3Fetch(`/web3/supply/batches/${batchId}/certifications`, body(payload));

// PUBLIC: QR verification of a physical bottle (no session required).
export const verifyBatchCode = async (code) => {
  const res = await fetch(`${BASE_URL}/web3/verify/${encodeURIComponent(code)}`, {
    signal: AbortSignal.timeout(15000),
  });
  const data = await parseJSON(res);
  if (!res.ok) {
    const err = new Error((data && data.message) || 'Verification failed.');
    err.status = res.status;
    throw err;
  }
  return data;
};

export const getBatchQr = async (code) => {
  const res = await fetch(
    `${BASE_URL}/web3/verify/${encodeURIComponent(code)}/qr?base=${encodeURIComponent(window.location.origin)}`,
    { signal: AbortSignal.timeout(15000) }
  );
  const data = await parseJSON(res);
  if (!res.ok) throw new Error((data && data.message) || 'Could not render the QR code.');
  return data;
};

// ── Rewards, NFTs, staking, loyalty ───────────────────────────────────────
export const getRewardsStatus = () => w3Fetch('/web3/rewards/status');
export const claimCheckin = () => w3Fetch('/web3/rewards/checkin', body({}));
export const claimIntakeReward = () => w3Fetch('/web3/rewards/intake', body({}));
export const claimAssessmentReward = (assessmentId) =>
  w3Fetch('/web3/rewards/assessment', body({ assessmentId }));
export const getRewardEvents = (limit = 30) => w3Fetch(`/web3/rewards/events?limit=${limit}`);
export const getNfts = () => w3Fetch('/web3/rewards/nfts');
export const checkAchievements = () => w3Fetch('/web3/rewards/achievements/check', body({}));
export const stakeTokens = (amount) => w3Fetch('/web3/stake', body({ amount }));
export const unstakeTokens = (amount) => w3Fetch('/web3/unstake', body({ amount }));
export const getLoyalty = () => w3Fetch('/web3/loyalty');
export const redeemLoyalty = (amount) => w3Fetch('/web3/loyalty/redeem', body({ amount }));

// ── Marketplace, escrow & disputes ────────────────────────────────────────
export const getListings = (mine = false) => w3Fetch(`/web3/market/listings${mine ? '?mine=1' : ''}`);
export const createListing = (payload) => w3Fetch('/web3/market/listings', body(payload));
export const placeOrder = (payload) => w3Fetch('/web3/market/orders', body(payload));
export const getOrders = () => w3Fetch('/web3/market/orders');
export const confirmDelivery = (orderId) => w3Fetch(`/web3/market/orders/${orderId}/confirm`, body({}));
export const openDispute = (orderId, reason) =>
  w3Fetch(`/web3/market/orders/${orderId}/dispute`, body({ reason }));
export const getDisputes = () => w3Fetch('/web3/market/disputes');
export const voteDispute = (disputeId, choice) =>
  w3Fetch(`/web3/market/disputes/${disputeId}/vote`, body({ choice }));

// ── Governance & knowledge base ───────────────────────────────────────────
export const getDaoConfig = () => w3Fetch('/web3/dao/config');
export const getProposals = () => w3Fetch('/web3/dao/proposals');
export const createProposal = (payload) => w3Fetch('/web3/dao/proposals', body(payload));
export const voteProposal = (proposalId, choice) =>
  w3Fetch(`/web3/dao/proposals/${proposalId}/vote`, body({ choice }));
export const getKnowledge = () => w3Fetch('/web3/knowledge');
export const createKnowledgePost = (payload) => w3Fetch('/web3/knowledge', body(payload));
export const upvoteKnowledge = (postId) => w3Fetch(`/web3/knowledge/${postId}/upvote`, body({}));

// ── Health ledger, privacy storage & AI transparency ──────────────────────
export const getHealthLedger = () => w3Fetch('/web3/health/ledger');
export const anchorHealthLedger = () => w3Fetch('/web3/health/ledger/anchor', body({}));
export const exportHealthCredential = () => w3Fetch('/web3/health/export');
export const backupHealthRecord = () => w3Fetch('/web3/health/backup', body({}));
export const pinStorage = (data, kind) => w3Fetch('/web3/storage/pin', body({ data, kind }));
export const getStorage = (cid) => w3Fetch(`/web3/storage/${encodeURIComponent(cid)}`);
export const getDataShares = () => w3Fetch('/web3/data/shares');
export const createDataShare = (payload) => w3Fetch('/web3/data/shares', body(payload));
export const revokeDataShare = (shareId) =>
  w3Fetch(`/web3/data/shares/${shareId}`, { method: 'DELETE' });
export const anchorRecommendations = (assessmentId) =>
  w3Fetch('/web3/recommendations/anchor', body({ assessmentId }));
export const getRecommendationAnchor = (assessmentId) =>
  w3Fetch(`/web3/recommendations/anchor/${assessmentId}`);
export const getProfileShares = () => w3Fetch('/web3/profile-shares');
export const createProfileShare = (ttlHours) => w3Fetch('/web3/profile-shares', body({ ttlHours }));
export const revokeProfileShare = (id) =>
  w3Fetch(`/web3/profile-shares/${id}`, { method: 'DELETE' });

// PUBLIC: shared health profile (doctor/nutritionist view).
export const getSharedProfile = async (token) => {
  const res = await fetch(`${BASE_URL}/web3/share/${encodeURIComponent(token)}`, {
    signal: AbortSignal.timeout(15000),
  });
  const data = await parseJSON(res);
  if (!res.ok) throw new Error((data && data.message) || 'This share link is no longer valid.');
  return data;
};

// ── Trials, oracles & professionals ───────────────────────────────────────
export const getTrials = () => w3Fetch('/web3/trials');
export const optInTrial = (trialId) => w3Fetch(`/web3/trials/${trialId}/optin`, body({}));
export const withdrawTrial = (trialId) => w3Fetch(`/web3/trials/${trialId}/withdraw`, body({}));
export const getOracleFeeds = () => w3Fetch('/web3/oracle/feeds');
export const refreshOracle = () => w3Fetch('/web3/oracle/refresh', body({}));
export const getExperts = () => w3Fetch('/web3/experts');
export const bookExpert = (expertId, hours) =>
  w3Fetch(`/web3/experts/${expertId}/book`, body({ hours }));
export const getBookings = () => w3Fetch('/web3/bookings');
export const cancelBooking = (bookingId) =>
  w3Fetch(`/web3/bookings/${bookingId}/cancel`, body({}));
