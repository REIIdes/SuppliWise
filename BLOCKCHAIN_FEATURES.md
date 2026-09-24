# SuppliWise Blockchain Features — Implementation Map

All 20 proposed Web3 features are implemented, wired end‑to‑end, and covered by
automated tests. This document maps **every feature to the code that implements it**
and the checks that prove it works.

- **Backend:** `server/blockchain/*` (chain + state engine), `server/routes/web3/*` (HTTP API)
- **Frontend:** `my-react-app/src/api/web3.js`, `src/Pages/*`, `src/Components/Web3Panels/*`
- **Tests:** `server/Test File/web3.test.js` (68 unit tests), `server/test-web3-flows.js` (81 end‑to‑end HTTP checks), `my-react-app/src/subscription/features.test.js` (9)

---

## 0. The foundation (what makes the 20 features real)

| Concern | Implementation | Notes |
| --- | --- | --- |
| Ledger | `server/blockchain/ledger.js` + `Block` model | Append‑only PoW chain. Each block stores `{index, timestamp, prevHash, nonce, hash, txs}`. Difficulty `3` (override with `CHAIN_DIFFICULTY`). |
| Integrity | `GET /api/web3/chain/verify` | Recomputes every `headerHash` and the `prevHash` linkage. The E2E test asserts `valid === true`. |
| State engine | `server/blockchain/engine.js` | **The only place that mutates Web3 state.** Rule: mutate the DB first (source of truth), then anchor. An anchor failure is logged and never fails the request. |
| Privacy | `blockchain/crypto.js` | Personal payloads are never written on‑chain — only a `sha256` digest over canonical JSON (`stableStringify` + `hashPayload`). |
| Identity | `generateIdentity()` | `ed25519` keypair. DID `did:suppliwise:<userId>`, address `0x` + `sha256("sw:addr:"+publicKey).slice(0,40)`. |
| Key custody | `encrypt()` / `decryptPrivateKey()` | Private key sealed in an AES‑256‑GCM envelope (`iv`/`ct`/`tag`) keyed from `JWT_SECRET`. `GET /wallet/private-key` returns standard **PKCS#8 PEM**. |
| Governance of economics | `DEFAULT_PARAMS` in `server/models/Web3.js` | All reward rates, fees, thresholds and the quorum live in one DAO‑governed config document. |
| System wallets | `sw_system_treasury`, `sw_system_escrow`, `sw_system_brand`, `sw_system_expert_pool` | Hold protocol fees, escrowed funds, seeded‑brand inventory and expert payouts. |
| Reward safety | Unique index `(user, kind, refId)` on `SwRewardEvent` | Database‑level idempotency: a double click or retried request can never mint twice. `grantReward()` creates the event, credits, then backfills `txHash`. |
| Public surface | `server/routes/web3/index.js` | Only `GET /verify/:code`, `GET /verify/:code/qr`, `GET /share/:token` are public. Everything else is behind `protect` + a `userOnly` guard that rejects admin accounts. |
| Rate limiting | `server/index.js` (`userLimiter`) | `/api/web3` uses a non‑escalating bucket (600/min local) so feature traffic never climbs the brute‑force lockout ladder. |

---

## 1. Immutable supply chain tracking (QR verified)

- **Routes:** `server/routes/web3/supply.js`
  - `POST /api/web3/supply/batches` — mints code `SW-XXXXXXXX`, logs the first anchored `raw-sourcing` step.
  - `POST /api/web3/supply/batches/:id/events` — appends a step; **forward‑only** through `SUPPLY_STEPS` (`raw-sourcing → manufacturing → lab-testing → quality-release → distribution → retail → delivered`).
  - `GET /api/web3/verify/:code` — **PUBLIC** scan view: full journey + a proof block that recomputes each anchored tx's block hash.
  - `GET /api/web3/verify/:code/qr?base=https://site` — **PUBLIC** QR data URL pointing scanners at `/verify/<code>`.
- **Model:** `SupplyBatch` (`events[]` with `txHash` + `blockIndex`).
- **UI:** `Web3Panels/SupplyPanel.jsx`, public page `src/Pages/VerifyPage.jsx`.
- **Proof:** `test-web3-flows.js` — “PUBLIC scan verifies batch with recomputed chain proofs”, “out-of-sequence step rejected”.

## 2. Verifiable certifications

- **Route:** `POST /api/web3/supply/batches/:id/certifications` — types `lab-report | organic | non-gmo | third-party | gmp | other`; stores a `resultHash` (supplied sha256 **or** a digest derived from batch+type+issuer) and anchors `cert:anchor`.
- **UI:** same panel; the public verify page renders certifications with their block index.
- **Proof:** “certification digest anchored on-chain”, and the seeded demo batch shows 2 certifications verified publicly.

## 3. Smart‑contract escrow commerce

- **Routes:** `server/routes/web3/market.js`
  - `POST /api/web3/market/orders` — atomically reserves stock, transfers buyer → `sw_system_escrow`, creates the order.
  - `POST /api/web3/market/orders/:id/confirm` — executes the contract: `escrowSplit()` pays the seller and routes the DAO fee to the treasury.
- **Rules:** `escrowSplit(total, feePct)` in `blockchain/rules.js` (pure, unit‑tested).
- **Proof:** “order locks buyer funds in escrow”, “delivery confirmation executes the contract (seller paid − 3% fee)”.

## 4. Verified P2P marketplace

- **Routes:** `POST/GET /api/web3/market/listings`, `GET /api/web3/market/orders` (bought + sold).
- **Model:** `Listing` (seller is a wallet address, `sellerUser` for ownership queries), `Order`.
- **UI:** `src/Pages/MarketplacePage.jsx` + `Web3Panels/MarketPanel.jsx`; listings also surface oracle pricing feeds.
- **Proof:** “three listings created + anchored”, “browse returns listings + fee + oracle feeds”.

## 5. Decentralized identity (DID)

- **Routes:** `GET /api/web3/wallet` (creates on first access with the welcome airdrop), `GET /api/web3/wallet/private-key` (owner‑only, PEM).
- **Model:** `Wallet` (`did`, `address`, `publicKey`, `privateKeyEnc`, `welcomeBonusAt`).
- **UI:** `Web3Panels/WalletPanel.jsx` (DID, address, key export with a warning).
- **Proof:** “DID issued”, “ed25519 public key present”, “owner-only private key export decrypts PKCS#8 key”.

## 6. User‑owned health ledger

- **Routes:** `server/routes/web3/data.js`
  - `GET /api/web3/health/ledger` — rolling digest over the user's real assessments + intake volume.
  - `POST /api/web3/health/ledger/anchor` — anchors a snapshot and pays `healthAnchorReward`.
  - `GET /api/web3/health/export` — **signed portable credential** (ed25519 signature over canonical JSON) anyone can verify against the published public key.
  - `POST /api/web3/health/backup` — encrypts + content‑addresses the record for later retrieval.
- **Privacy:** only `digest` + counts go on‑chain.
- **Proof:** “ledger digest computed over real records (no raw data stored)”, “signed portable credential exported (ed25519)”.

## 7. Data sovereignty rewards

- **Route:** `POST /api/web3/data/shares` — builds a **coarse, anonymised** dataset server‑side (age band, gender, volume bands — no ids, dates or free text), encrypts it, content‑addresses it, anchors the consent, and pays `dataShareReward`.
- **Revocation:** `DELETE /api/web3/data/shares/:id` anchors `consent:revoke` **and destroys the stored payload**.
- **Proof:** “anonymized coarse dataset shared with on-chain consent + reward”, “shared dataset carries no direct identifiers”, “research dataset no longer retrievable after revoke”.

## 8. Decentralized encrypted storage

- **Routes:** `POST /api/web3/storage/pin`, `GET /api/web3/storage/:cid`.
- **Mechanics:** AES‑256‑GCM at rest; CID is `bafy…` derived from the ciphertext bytes, so the identifier itself is tamper‑evident. Fetch recomputes the CID and returns `integrityOk`.
- **Proof:** “payload encrypted + content-addressed (bafy… CID)”, “fetch + decrypt with CID integrity check”.

## 9. WELL token rewards

- **Routes:** `server/routes/web3/rewards.js`
  - `POST /api/web3/rewards/checkin` — streak‑scaled daily mint (`rewardCheckin` + step per consecutive day, 10‑step cap).
  - `POST /api/web3/rewards/intake` — only pays when a real `IntakeRecord` exists for today.
  - `POST /api/web3/rewards/assessment` — only pays for an owned assessment that has `aiResults`.
  - `GET /api/web3/rewards/status` / `/events` — dashboard + on‑chain history.
- **Welcome bonus** is itself a `RewardEvent` (`welcome_bonus`, refId `-`) with a `txHash`, so history is complete from the first block.
- **Proof:** “daily check-in mints WELL with streak”, “check-in is idempotent per day (no double mint)”, “intake reward refuses without a real intake record”.

## 10. Achievement NFTs

- **Route:** `POST /api/web3/rewards/achievements/check` — eligibility is computed **server‑side** from real activity (`blockchain/rules.js` → `ACHIEVEMENTS`, `eligibleAchievements`), then each NFT is anchored (`nft:mint`) and stored soulbound.
- **Concurrency safe:** a lost mint race (duplicate `tokenId`) is treated as “already owned”, not a 500.
- **UI:** `Web3Panels/RewardsPanel.jsx` gallery.
- **Proof:** “milestone NFTs minted from real activity”, “minted NFTs carry tokenId + serial + anchor tx”, “re-check mints nothing new”.

## 11. Staking for premium access

- **Routes:** `POST /api/web3/stake`, `POST /api/web3/unstake`.
- **Yield:** `accrueStake()` pays `computeStakeReward(staked, stakeApyPct, elapsed)` on activity, using a conditional update on the last‑accrual timestamp so a double claim can never pay twice.
- **Unlocks:** `stakingUnlocks()` against the DAO threshold (`stakePremiumThreshold`).
- **Proof:** “stake moves balance → staked with unlock progress”, “partial unstake returns funds”; unit tests for APY pro‑rating and thresholds.

## 12. Blockchain loyalty program

- **Route:** `POST /api/web3/loyalty/redeem` — burns WELL to the treasury (`loyalty:burn` tx) and issues a one‑time `LOY-…` code; the code discounts a marketplace order and is consumed on use.
- **Proof:** “WELL burned → one-time loyalty code issued”, “loyalty code discounts checkout (30 − 10 = 20 locked)”, “used loyalty code rejected on reuse”, “loyalty burn ledger readable”.

## 13. DAO governance

- **Routes:** `server/routes/web3/govern.js` — `GET /dao/config`, `GET/POST /dao/proposals`, `POST /dao/proposals/:id/vote`.
- **Voting weight:** `balance + staked`, snapshotted at vote time; one vote per wallet.
- **Execution:** `finalizeExpired()` lazily tallies on read and, when a proposal passes, **actually applies the parameter** (`setParam`) and anchors `dao:execute`.
- **Rules:** `tallyProposal()` — quorum (`daoQuorumWeight`) + strict FOR majority; unit‑tested (quorum, ties, duplicate wallets).
- **UI:** `src/Pages/GovernancePage.jsx`.
- **Proof:** “proposal opened with proposer vote auto-cast + anchored”, “stake-weighted opposing vote recorded on-chain”, “second vote from same wallet rejected”.

## 14. Community knowledge base

- **Routes:** `GET/POST /api/web3/knowledge`, `POST /api/web3/knowledge/:id/upvote`.
- **Economics:** publishing pays `knowledgeReward`; each upvote pays the author `knowledgeUpvoteReward` up to `knowledgeUpvoteCap` and the curator `curatorReward`; self‑upvotes and double upvotes are rejected.
- **UI:** Governance page → Knowledge tab.
- **Proof:** “post published, rewarded and anchored”, “upvote pays curator + capped author reward”, “double upvote rejected”.

## 15. Decentralised dispute resolution

- **Route:** `POST /api/web3/market/orders/:id/dispute` — jurors are drawn from **staked non‑party wallets** (up to 5); with nobody staked it falls back to an open jury. Order parties can never vote (403).
- **Verdict:** `disputeOutcome()` — majority of the appointed panel; a tie pays nobody.
- **Settlement:** buyer verdict → full refund + stock restored; seller verdict → release with fee. Jurors are paid `jurorReward` as a `RewardEvent` (`kind: 'juror'`).
- **Proof:** “dispute opened; juror = independent staked holder”, “order party cannot vote on own dispute (403)”, “juror verdict resolves dispute → buyer refunded from escrow”, “juror paid for service”.

## 16. Interoperable health profile

- **Routes:** `POST/GET/DELETE /api/web3/profile-shares` and the **PUBLIC** `GET /api/web3/share/:token`.
- **Mechanics:** 32‑hex token, TTL (1–720 h), revocable, view counter, medical disclaimer.
- **Proof:** “time-boxed share link issued”, “PUBLIC read without an account (doctor view)”, “revoked link immediately dead publicly (404)”.

## 17. Verifiable AI recommendations

- **Routes:** `POST /api/web3/recommendations/anchor`, `GET /api/web3/recommendations/anchor/:assessmentId`.
- **Mechanics:** hashes the recommender's **input**, **output** and **logic version** separately, anchors the combined hash, and later recomputes all three — any drift fails verification.
- **Proof:** “recommendation inputs/outputs anchored on-chain”, “anchored recommendation re-verifies (inputs + outputs intact)”.

## 18. Clinical trial consent (smart contract)

- **Routes:** `GET /api/web3/trials`, `POST /api/web3/trials/:id/optin`, `POST /api/web3/trials/:id/withdraw`.
- **Mechanics:** the exact terms (trial, sponsor, data scope, revocability, reward) are hashed into `termsHash` and anchored; withdrawal is anchored too. One consent per trial per user.
- **Proof:** “seeded open trials listed”, “consent hashed on-chain + participation rewarded”, “duplicate consent rejected”, “trial consent withdrawn + recorded on-chain”.

## 19. Oracle feeds

- **Routes:** `GET /api/web3/oracle/feeds`, `POST /api/web3/oracle/refresh`.
- **Mechanics:** six feeds (supplement pricing, WELL index, research) re‑derived deterministically per day and anchored on change; the same routine seeds them at boot, so feeds are never empty. Prices also surface in the marketplace.
- **Proof:** “six oracle feeds published at boot”, “oracle refresh re-derives today's values deterministically”.

## 20. Tokenized expert consultations

- **Routes:** `GET /api/web3/experts`, `POST /api/web3/experts/:id/book`, `GET /api/web3/bookings`, `POST /api/web3/bookings/:id/cancel`.
- **Mechanics:** booking pays `rateWell × hours` into `sw_system_expert_pool` on‑chain; cancelling refunds in full.
- **Proof:** “four verified professionals listed”, “booking pays rate × hours on-chain”, “booking cancelled with full refund (cost returned to wallet)”.

---

## Verification status

| Check | Command | Result |
| --- | --- | --- |
| Server unit tests | `cd server && npm test` | **68 passed, 0 failed** |
| Frontend tests | `cd my-react-app && npm test` | **9 passed, 0 failed** |
| End‑to‑end HTTP smoke (all 20 features) | `cd server && node test-web3-flows.js` | **81 passed, 0 failed** |
| Lint | `cd my-react-app && npm run lint` | **0 errors** (4 pre‑existing warnings) |
| Production build | `cd my-react-app && npm run build` | **success** |

The smoke test registers three throwaway accounts (buyer / seller / juror), purges prior `web3-smoke-*` accounts and any orphaned wallets first, then exercises every feature through the real HTTP surface — including the public, unauthenticated verification and share endpoints.
